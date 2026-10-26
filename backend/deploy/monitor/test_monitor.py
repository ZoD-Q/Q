"""Local-only fixtures. No production requests, SMTP connections, or real credentials."""
import copy
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import smtplib
import ssl
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error

import monitor


NOW = 1_800_000_000
CONTEXT = {"job_id": "42", "pipeline_id": "12", "source_sha": "a" * 40, "test_id": ""}
HEALTHY = monitor.Observation(True, "ok", 200)
FAILED = monitor.Observation(False, "http_error", 503)


def ci_env(root="/synthetic"):
    return {
        "CI": "true", "CI_PROJECT_ID": "197", "CI_DEFAULT_BRANCH": "main", "CI_COMMIT_BRANCH": "main",
        "CI_COMMIT_REF_PROTECTED": "true", "CI_PIPELINE_SOURCE": "schedule", "CI_JOB_NAME": "q-external-monitor",
        "Q_MONITOR_SCHEDULE": "1", "CI_COMMIT_SHA": "a" * 40, "CI_JOB_ID": "42", "CI_PIPELINE_ID": "12",
        "CI_PROJECT_DIR": root, "Q_MONITOR_SMTP_AUTH_CODE": "synthetic-test-only",
    }


class Flow:
    def __init__(self, state_path=None):
        self.state = monitor.empty_state(NOW)
        self.state_path = state_path
        self.messages = []
        self.delivery_times = []
        self.saved = []
        self.probes = []
        self.sleeps = []
        self.delivery_failure = None
        self.storage_failure = False
        self.failed_saves = set()
        self.save_count = 0
        self.counter = 0

    def new_id(self):
        self.counter += 1
        return f"{self.counter:032x}"

    def save(self, state):
        self.save_count += 1
        if self.storage_failure or self.save_count in self.failed_saves:
            raise OSError("PRIVATE_STORAGE_DETAIL")
        if self.state_path:
            monitor.atomic_json(self.state_path, state)
        self.saved.append(copy.deepcopy(state))

    def mail(self, message):
        self.messages.append(message)
        self.delivery_times.append(self.now)
        if self.delivery_failure:
            raise monitor.DeliveryFailure(self.delivery_failure)

    def run(self, api=HEALTHY, beauty=HEALTHY, *, status="restored", test_id="", now=NOW):
        self.now = now
        queue = {"api": list(api) if isinstance(api, list) else [api], "beauty": list(beauty) if isinstance(beauty, list) else [beauty]}

        def probe(endpoint):
            self.probes.append(endpoint.key)
            values = queue[endpoint.key]
            return values.pop(0) if len(values) > 1 else values[0]

        return monitor.monitor(self.state, status, {**CONTEXT, "test_id": test_id}, now,
            probe_fn=probe, mailer=self.mail, persist=self.save, sleep=self.sleeps.append, new_id=self.new_id)

    def reload(self, now):
        self.state, status = monitor.load_state(self.state_path, now)
        return status


class StateFlowTests(unittest.TestCase):
    def test_two_failures_one_alert_suppression_recovery_and_new_incident(self):
        f = Flow()
        self.assertEqual(f.run(FAILED)[1], 1)
        self.assertEqual(f.messages, [])
        self.assertEqual(f.state["services"]["api"]["failures"], 1)
        self.assertEqual(f.run(FAILED, now=NOW + 300)[1], 1)
        self.assertEqual(len(f.messages), 1)
        original_id = f.messages[-1]["Message-ID"]
        self.assertIn("连续两次检查失败", f.messages[-1].get_content())
        self.assertEqual(f.saved[-2]["services"]["api"]["incident"]["alert"]["status"], "in_flight")
        self.assertEqual(f.saved[-1]["services"]["api"]["incident"]["alert"]["status"], "accepted")
        f.run(FAILED, now=NOW + 600)
        self.assertEqual(len(f.messages), 1)
        self.assertEqual(f.run(now=NOW + 900)[1], 0)
        self.assertEqual(len(f.messages), 2)
        self.assertIn("检查已恢复", f.messages[-1].get_content())
        self.assertEqual(f.state["services"]["api"]["incident"]["recovery"]["status"], "accepted")
        f.run(now=NOW + 1200)
        self.assertEqual(len(f.messages), 2)
        f.run(FAILED, now=NOW + 1500)
        f.run(FAILED, now=NOW + 1800)
        self.assertEqual(len(f.messages), 3)
        self.assertNotEqual(f.messages[-1]["Message-ID"], original_id)
        self.assertEqual(len(f.state["services"]["api"]["previous_incidents"]), 1)

    def test_a_single_failure_then_success_never_sends_a_recovery(self):
        f = Flow()
        f.run(FAILED)
        f.run()
        self.assertEqual(f.messages, [])
        self.assertEqual(f.state["services"]["api"]["failures"], 0)

    def test_two_targets_share_one_mail_and_keep_independent_incidents(self):
        f = Flow()
        f.run(FAILED, FAILED)
        f.run(FAILED, FAILED, now=NOW + 300)
        self.assertEqual(len(f.messages), 1)
        self.assertIn("Q API", f.messages[0].get_content())
        self.assertIn("图库", f.messages[0].get_content())
        f.run(HEALTHY, FAILED, now=NOW + 600)
        self.assertEqual(len(f.messages), 2)
        self.assertEqual(f.state["services"]["api"]["incident"]["recovery"]["status"], "accepted")
        self.assertEqual(f.state["services"]["beauty"]["incident"]["alert"]["status"], "accepted")

    def test_missing_invalid_and_stale_cache_confirm_twice_without_permanent_suppression(self):
        for status in ("missing", "invalid", "stale"):
            with self.subTest(status=status):
                f = Flow()
                report, code = f.run(FAILED, status=status)
                self.assertEqual(code, 1)
                self.assertEqual(f.probes.count("api"), 2)
                self.assertEqual(f.probes.count("beauty"), 1)
                self.assertEqual(f.sleeps, [monitor.BOOTSTRAP_CONFIRM_DELAY])
                self.assertEqual(len(f.messages), 1)
                self.assertEqual(report["state"], status)
                self.assertEqual(report["delivery"], "smtp_accepted")
                self.assertEqual(f.state["services"]["api"]["failures"], 2)

    def test_bootstrap_confirmation_can_disprove_a_transient_failure(self):
        f = Flow()
        report, code = f.run([FAILED, HEALTHY], status="missing")
        self.assertEqual(code, 0)
        self.assertTrue(report["services"]["api"]["healthy"])
        self.assertEqual(f.messages, [])
        self.assertEqual(f.state["services"]["api"]["failures"], 0)

    def test_known_non_delivery_waits_for_cooldown_before_retry(self):
        f = Flow()
        f.run(FAILED)
        f.delivery_failure = "not_delivered"
        report, code = f.run(FAILED, now=NOW + 300)
        self.assertEqual(code, 2)
        self.assertEqual(report["delivery"], "known_not_delivered")
        self.assertNotIn("PRIVATE", json.dumps(report) + json.dumps(f.saved))
        self.assertEqual(f.state["services"]["api"]["incident"]["alert"]["status"], "not_delivered")
        failed_id = f.messages[-1]["Message-ID"]
        f.delivery_failure = None
        report, _ = f.run(FAILED, now=NOW + 600)
        self.assertEqual(report["delivery"], "retry_cooldown")
        self.assertEqual(len(f.messages), 1)
        f.run(FAILED, now=NOW + 300 + monitor.DELIVERY_RETRY_COOLDOWN)
        self.assertEqual(len(f.messages), 2)
        self.assertEqual(f.messages[-1]["Message-ID"], failed_id)
        self.assertEqual(f.state["services"]["api"]["incident"]["alert"]["status"], "accepted")

    def test_recovery_is_sent_even_when_prior_alert_delivery_was_unknown(self):
        f = Flow()
        f.run(FAILED)
        f.delivery_failure = "unknown"
        f.run(FAILED, now=NOW + 300)
        f.delivery_failure = None
        f.run(now=NOW + 600)
        self.assertIn("此前故障邮件未获得投递确认", f.messages[-1].get_content())
        self.assertEqual(f.state["services"]["api"]["incident"]["alert"]["status"], "unknown")
        self.assertEqual(f.state["services"]["api"]["incident"]["recovery"]["status"], "accepted")

    def test_failed_recovery_is_retried_without_repeating_the_outage_mail(self):
        f = Flow()
        f.run(FAILED)
        f.run(FAILED, now=NOW + 300)
        f.delivery_failure = "not_delivered"
        self.assertEqual(f.run(now=NOW + 600)[1], 2)
        recovery_id = f.messages[-1]["Message-ID"]
        self.assertEqual(f.state["services"]["api"]["incident"]["alert"]["status"], "accepted")
        f.delivery_failure = None
        f.run(now=NOW + 600 + monitor.DELIVERY_RETRY_COOLDOWN)
        self.assertEqual(f.messages[-1]["Message-ID"], recovery_id)
        self.assertEqual(f.state["services"]["api"]["incident"]["recovery"]["status"], "accepted")

    def test_failed_pre_send_checkpoint_blocks_unrecorded_delivery(self):
        f = Flow()
        f.run(FAILED)
        f.storage_failure = True
        report, code = f.run(FAILED, now=NOW + 300)
        self.assertEqual(code, 2)
        self.assertFalse(report["state_persisted"])
        self.assertEqual(report["delivery"], "blocked_state_write")
        self.assertTrue(report["manual_attention"])
        self.assertEqual(len(f.messages), 0)
        self.assertEqual(f.state["services"]["api"]["incident"]["alert"]["attempts"], 0)

    def test_test_mail_requires_an_explicit_id_and_is_suppressed_when_state_is_retained(self):
        f = Flow()
        f.run()
        self.assertEqual(f.messages, [])
        f.run(test_id="acceptance-1")
        f.run(test_id="acceptance-1")
        self.assertEqual(len(f.messages), 1)
        self.assertIn("不表示服务发生故障", f.messages[0].get_content())
        f.run(test_id="acceptance-2")
        self.assertEqual(len(f.messages), 2)

    def test_unknown_alert_and_recovery_each_send_once_across_100_fresh_process_rounds(self):
        with tempfile.TemporaryDirectory() as temp:
            f = Flow(Path(temp) / "state.json")
            f.delivery_failure = "unknown"
            f.run()
            for turn in range(1, 101):
                now = NOW + turn * 300
                report, _ = f.run(FAILED, now=now, status=f.reload(now))
            self.assertEqual(len(f.messages), 1)
            self.assertEqual(report["delivery"], "unknown_stopped")
            self.assertTrue(report["manual_attention"])
            self.assertEqual(f.state["services"]["api"]["incident"]["alert"]["attempts"], 1)
            for turn in range(101, 201):
                now = NOW + turn * 300
                report, _ = f.run(now=now, status=f.reload(now))
            self.assertEqual(len(f.messages), 2, "recovery is a separate event, not a replay of the alert")
            self.assertNotEqual(f.messages[0]["Message-ID"], f.messages[1]["Message-ID"])
            incident = f.state["services"]["api"]["incident"]
            self.assertEqual(incident["alert"]["status"], "unknown")
            self.assertEqual(incident["recovery"]["status"], "unknown")
            self.assertEqual(incident["recovery"]["attempts"], 1)
            self.assertEqual(report["delivery"], "unknown_stopped")

    def test_known_non_delivery_has_three_attempts_and_cooldown_per_event_over_100_rounds(self):
        with tempfile.TemporaryDirectory() as temp:
            f = Flow(Path(temp) / "state.json")
            f.delivery_failure = "not_delivered"
            f.run()
            for turn in range(1, 101):
                now = NOW + turn * 300
                report, _ = f.run(FAILED, now=now, status=f.reload(now))
            self.assertEqual(len(f.messages), monitor.MAX_DELIVERY_ATTEMPTS)
            self.assertTrue(all(b - a >= monitor.DELIVERY_RETRY_COOLDOWN for a, b in zip(f.delivery_times, f.delivery_times[1:])))
            self.assertEqual(report["delivery"], "retry_exhausted")
            self.assertTrue(report["manual_attention"])
            first_recovery = len(f.messages)
            for turn in range(101, 201):
                now = NOW + turn * 300
                report, _ = f.run(now=now, status=f.reload(now))
            self.assertEqual(len(f.messages), monitor.MAX_DELIVERY_ATTEMPTS * 2)
            times = f.delivery_times[first_recovery:]
            self.assertTrue(all(b - a >= monitor.DELIVERY_RETRY_COOLDOWN for a, b in zip(times, times[1:])))
            self.assertEqual(report["delivery"], "retry_exhausted")
            self.assertEqual(f.state["services"]["api"]["incident"]["recovery"]["attempts"], 3)

    def test_unknown_after_a_known_failure_stops_the_remaining_retry_budget(self):
        f = Flow()
        f.run(FAILED)
        f.delivery_failure = "not_delivered"
        f.run(FAILED, now=NOW + 300)
        f.delivery_failure = "unknown"
        f.run(FAILED, now=NOW + 300 + monitor.DELIVERY_RETRY_COOLDOWN)
        for turn in range(100):
            f.run(FAILED, now=NOW + 600 + monitor.DELIVERY_RETRY_COOLDOWN + turn * 300)
        self.assertEqual(len(f.messages), 2)
        self.assertEqual(f.state["services"]["api"]["incident"]["alert"]["status"], "unknown")
        self.assertEqual(f.state["services"]["api"]["incident"]["alert"]["attempts"], 2)

    def test_test_email_unknown_is_not_replayed_for_100_schedules(self):
        with tempfile.TemporaryDirectory() as temp:
            f = Flow(Path(temp) / "state.json")
            f.delivery_failure = "unknown"
            f.run(test_id="acceptance")
            for turn in range(1, 101):
                now = NOW + turn * 300
                report, _ = f.run(test_id="acceptance", now=now, status=f.reload(now))
            self.assertEqual(len(f.messages), 1)
            self.assertEqual(report["test_notification"]["delivery"]["status"], "unknown")

    def test_sent_but_ack_checkpoint_failed_reloads_in_flight_as_unknown_and_never_resends(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            f = Flow(path)
            f.run(FAILED)
            f.failed_saves = {3}  # Send-start checkpoint succeeds; only the post-DATA checkpoint fails.
            report, code = f.run(FAILED, now=NOW + 300)
            self.assertEqual(code, 2)
            self.assertEqual(report["delivery"], "smtp_accepted")
            self.assertEqual(len(f.messages), 1)
            disk = json.loads(path.read_text())
            self.assertEqual(disk["services"]["api"]["incident"]["alert"]["status"], "in_flight")
            for turn in range(2, 102):
                now = NOW + turn * 300
                f.run(FAILED, now=now, status=f.reload(now))
            self.assertEqual(len(f.messages), 1)
            self.assertEqual(f.state["services"]["api"]["incident"]["alert"]["status"], "unknown")

    def test_stale_cache_preserves_unknown_delivery_and_allows_a_different_incident(self):
        with tempfile.TemporaryDirectory() as temp:
            f = Flow(Path(temp) / "state.json")
            f.delivery_failure = "unknown"
            f.run(FAILED, status="missing")
            first = f.state["services"]["api"]["incident"]["id"]
            now = NOW + monitor.STATE_MAX_AGE + 1
            status = f.reload(now)
            self.assertEqual(status, "stale")
            f.run(FAILED, now=now, status=status)
            self.assertEqual(len(f.messages), 1)
            f.delivery_failure = None
            f.run(now=now + 300)
            f.run(FAILED, now=now + 600)
            f.run(FAILED, now=now + 900)
            self.assertEqual(len(f.messages), 3)
            self.assertNotEqual(f.state["services"]["api"]["incident"]["id"], first)
            self.assertEqual(f.state["services"]["api"]["previous_incidents"][0]["alert"]["status"], "unknown")

    def test_100_distinct_incidents_keep_bounded_history_below_the_cache_limit(self):
        f = Flow()
        for incident in range(100):
            start = NOW + incident * 900
            f.run(FAILED, now=start)
            f.run(FAILED, now=start + 300)
            f.run(now=start + 600)
        self.assertEqual(len(f.messages), 200)
        self.assertEqual(len(f.state["services"]["api"]["previous_incidents"]), monitor.INCIDENT_HISTORY_LIMIT)
        self.assertLess(len(json.dumps(f.state).encode()), monitor.STATE_LIMIT)
        self.assertTrue(monitor.valid_state(f.state, NOW + 100 * 900))

    def test_unknown_or_exhausted_recovery_does_not_suppress_a_new_health_incident(self):
        for outcome in ("unknown", "not_delivered"):
            with self.subTest(outcome=outcome):
                f = Flow()
                f.run(FAILED)
                f.run(FAILED, now=NOW + 300)
                first = f.state["services"]["api"]["incident"]["id"]
                f.delivery_failure = outcome
                for turn in range(100):
                    f.run(now=NOW + 600 + turn * 300)
                previous_status = "unknown" if outcome == "unknown" else "exhausted"
                self.assertEqual(f.state["services"]["api"]["incident"]["recovery"]["status"], previous_status)
                before = len(f.messages)
                f.delivery_failure = None
                f.run(FAILED, now=NOW + 31000)
                f.run(FAILED, now=NOW + 31300)
                self.assertEqual(len(f.messages), before + 1)
                current = f.state["services"]["api"]["incident"]
                self.assertNotEqual(current["id"], first)
                self.assertEqual(current["alert"]["attempts"], 1)
                self.assertEqual(f.state["services"]["api"]["previous_incidents"][-1]["recovery"]["status"], previous_status)


class PersistenceTests(unittest.TestCase):
    def test_atomic_round_trip_has_only_non_sensitive_schema_and_mode_0600(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "cache/state.json"
            value = monitor.empty_state(NOW)
            monitor.atomic_json(path, value)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(monitor.load_state(path, NOW), (value, "restored"))
            self.assertEqual(list(path.parent.glob(".monitor-*")), [])

    def test_missing_stale_oversized_and_malformed_states_rebuild_without_logging_contents(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            self.assertEqual(monitor.load_state(path, NOW)[1], "missing")
            old = monitor.empty_state(NOW - monitor.STATE_MAX_AGE - 1)
            monitor.atomic_json(path, old)
            self.assertEqual(monitor.load_state(path, NOW)[1], "stale")
            invalid = [b"PRIVATE_NOT_JSON", b"x" * (monitor.STATE_LIMIT + 1), b"{}", b"[]",
                       json.dumps({**monitor.empty_state(NOW), "extra": "PRIVATE"}).encode()]
            for raw in invalid:
                path.write_bytes(raw)
                self.assertEqual(monitor.load_state(path, NOW), (monitor.empty_state(NOW), "invalid"))

    def test_symlink_state_is_never_read_or_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            target, path = Path(temp) / "private", Path(temp) / "state.json"
            target.write_text("DO_NOT_READ")
            path.symlink_to(target)
            self.assertEqual(monitor.load_state(path, NOW)[1], "invalid")
            with self.assertRaises(OSError):
                monitor.atomic_json(path, monitor.empty_state(NOW))
            self.assertEqual(target.read_text(), "DO_NOT_READ")

    def test_invalid_counters_timestamps_and_incident_claims_are_rejected(self):
        for change in [lambda s: s.update(version=True), lambda s: s.update(updated_at=NOW + 1000),
                       lambda s: s["services"]["api"].update(failures=True),
                       lambda s: s["services"]["api"].update(failures=2, first_failure_at=NOW),
                       lambda s: s["services"]["api"].update(incident={"id": "PRIVATE", "since": NOW, "alert_sent": True})]:
            state = monitor.empty_state(NOW)
            change(state)
            self.assertFalse(monitor.valid_state(state, NOW))

    def test_legacy_ambiguous_delivery_is_migrated_to_unknown_not_replayed(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            for recovered in (False, True):
                state = {"version": 1, "updated_at": NOW, "test_sent_id": "old-acceptance", "services": {
                    "api": {"failures": 0 if recovered else 2, "first_failure_at": None if recovered else NOW,
                            "incident": {"id": "a" * 32, "since": NOW, "alert_sent": False}},
                    "beauty": {"failures": 0, "first_failure_at": None, "incident": None}}}
                monitor.atomic_json(path, state)
                migrated, status = monitor.load_state(path, NOW + 300)
                self.assertEqual(status, "migrated")
                self.assertTrue(monitor.valid_state(migrated, NOW + 300))
                self.assertEqual(migrated["services"]["api"]["incident"]["alert"]["status"], "unknown")
                f = Flow(path)
                f.state = migrated
                f.run(HEALTHY if recovered else FAILED, now=NOW + 300, status=status)
                self.assertEqual(f.messages, [])
                self.assertEqual(f.state["test_notification"]["delivery"]["status"], "accepted")

    def test_unfinished_send_checkpoint_is_not_permission_to_retry_after_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            f = Flow(path)
            f.run(FAILED)

            def interrupted(_message):
                raise SystemExit("simulated process termination")

            with self.assertRaises(SystemExit):
                monitor.monitor(f.state, "restored", CONTEXT, NOW + 300,
                    probe_fn=lambda endpoint: FAILED if endpoint.key == "api" else HEALTHY,
                    mailer=interrupted, persist=f.save, sleep=lambda _seconds: None, new_id=f.new_id)
            self.assertEqual(json.loads(path.read_text())["services"]["api"]["incident"]["alert"]["status"], "in_flight")
            report, _ = f.run(FAILED, now=NOW + 600, status=f.reload(NOW + 600))
            self.assertEqual(f.messages, [])
            self.assertEqual(report["delivery"], "unknown_stopped")


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                cls.received.append((self.path, dict(self.headers)))
                self.send_response(cls.status)
                self.send_header("Content-Type", "application/json")
                if cls.status == 302:
                    self.send_header("Location", "/must-not-follow")
                self.send_header("Content-Length", str(len(cls.body)))
                self.end_headers()
                self.wfile.write(cls.body)

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        type(self).status = 200
        type(self).body = b'{"status":"ok","mode":"demo"}'
        type(self).received = []
        self.endpoint = monitor.Endpoint("api", "fixture", f"http://127.0.0.1:{self.server.server_port}/health")

    def test_local_health_fixture_sends_no_credentials_and_never_uses_environment_proxy(self):
        with patch.dict(monitor.os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1"}):
            self.assertEqual(monitor.probe(self.endpoint), HEALTHY)
        self.assertNotIn("Authorization", self.received[0][1])
        self.assertNotIn("Cookie", self.received[0][1])

    def test_redirect_and_non_json_or_oversized_bodies_do_not_look_healthy(self):
        for status, body, reason in [(302, b"PRIVATE", "redirect"), (503, b"PRIVATE", "http_error"),
                                     (200, b"PRIVATE_HTML", "invalid_health"), (200, b"[]", "invalid_health"),
                                     (200, b"x" * (monitor.BODY_LIMIT + 1), "invalid_health")]:
            type(self).status, type(self).body = status, body
            result = monitor.probe(self.endpoint)
            self.assertFalse(result.healthy)
            self.assertEqual(result.reason, reason)
            self.assertNotIn("PRIVATE", repr(result))
        self.assertFalse(any(path == "/must-not-follow" for path, _ in self.received))

    def test_gallery_health_checks_service_count_origin_and_a_real_commit_shape(self):
        endpoint = monitor.Endpoint("beauty", "fixture", self.endpoint.url)
        value = {"status": "ok", "service": "beauty-mcp", "photo_count": 300,
                 "public_base": monitor.ORIGIN + "/plugins/beauty/", "source_commit": "a" * 40}
        type(self).body = json.dumps(value).encode()
        self.assertEqual(monitor.probe(endpoint), HEALTHY)
        for field, replacement in [("service", "other"), ("photo_count", 0), ("photo_count", 300.0),
                                   ("public_base", "http://private/"), ("source_commit", "fake")]:
            type(self).body = json.dumps({**value, field: replacement}).encode()
            self.assertEqual(monitor.probe(endpoint).reason, "invalid_health")

    def test_timeout_tls_dns_and_broken_stream_errors_are_sanitized(self):
        class Broken:
            def __init__(self, error):
                self.error = error

            def open(self, request, timeout):
                self.timeout = timeout
                raise self.error

        for error, reason in [(TimeoutError("PRIVATE"), "timeout"), (ssl.SSLCertVerificationError("PRIVATE"), "tls"),
                              (urllib.error.URLError("PRIVATE_DNS"), "network"),
                              (urllib.error.URLError(TimeoutError("PRIVATE")), "timeout")]:
            opener = Broken(error)
            result = monitor.probe(self.endpoint, opener)
            self.assertEqual(result.reason, reason)
            self.assertEqual(opener.timeout, monitor.HTTP_TIMEOUT)
            self.assertNotIn("PRIVATE", repr(result))


class SmtpTests(unittest.TestCase):
    def test_fixed_sender_recipient_ssl_verification_and_timeout_without_real_delivery(self):
        seen = {}

        class Client:
            def login(self, username, password):
                seen["login"] = (username, password)

            def mail(self, sender):
                seen["sender"] = sender
                return 250, b"OK"

            def rcpt(self, recipient):
                seen["recipient"] = recipient
                return 250, b"OK"

            def data(self, wire):
                seen["wire"] = wire
                return 250, b"Accepted"

            def quit(self):
                seen["quit"] = True

        def factory(host, port, timeout, context):
            seen.update(host=host, port=port, timeout=timeout, context=context)
            return Client()

        message = monitor.mail_message([{"kind": "test", "id": "setup"}], {}, CONTEXT, NOW)
        monitor.send_mail(message, "synthetic-test-only", factory)
        self.assertEqual((seen["host"], seen["port"], seen["timeout"]), ("smtp.qq.com", 465, monitor.SMTP_TIMEOUT))
        self.assertTrue(seen["context"].check_hostname)
        self.assertEqual(seen["context"].verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(seen["login"], (monitor.MAILBOX, "synthetic-test-only"))
        self.assertEqual((seen["sender"], seen["recipient"]), (monitor.MAILBOX, monitor.MAILBOX))
        seen["wire"].decode("ascii")  # MIME-encoded Chinese is safe without negotiating SMTPUTF8.
        self.assertNotIn("synthetic-test-only", message.as_string())
        self.assertTrue(seen["quit"])

    def test_quit_failure_after_acceptance_does_not_request_duplicate_delivery(self):
        class Client:
            def login(self, *_args):
                pass

            def mail(self, _sender):
                return 250, b"OK"

            def rcpt(self, _recipient):
                return 250, b"OK"

            def data(self, _wire):
                return 250, b"Accepted"

            def quit(self):
                raise smtplib.SMTPServerDisconnected("PRIVATE")

            def close(self):
                raise OSError("PRIVATE")

        monitor.send_mail(monitor.mail_message([{"kind": "test", "id": "setup"}], {}, CONTEXT, NOW),
                          "synthetic-test-only", lambda *_args, **_kwargs: Client())

    def test_data_boundary_distinguishes_definite_rejection_from_ambiguous_delivery(self):
        cases = [
            ("connect", ssl.SSLCertVerificationError("PRIVATE"), "not_delivered"),
            ("login", smtplib.SMTPAuthenticationError(535, b"PRIVATE"), "not_delivered"),
            ("mail", TimeoutError("PRIVATE"), "not_delivered"),
            ("mail", (550, b"PRIVATE"), "not_delivered"),
            ("rcpt", smtplib.SMTPServerDisconnected("PRIVATE"), "not_delivered"),
            ("rcpt", (550, b"PRIVATE"), "not_delivered"),
            ("data", TimeoutError("PRIVATE"), "unknown"),
            ("data", smtplib.SMTPServerDisconnected("PRIVATE"), "unknown"),
            ("data", smtplib.SMTPDataError(451, b"PRIVATE"), "not_delivered"),
            ("data", (554, b"PRIVATE"), "not_delivered"),
            ("data", (354, b"PRIVATE"), "unknown"),
        ]
        message = monitor.mail_message([{"kind": "test", "id": "setup"}], {}, CONTEXT, NOW)
        for stage, result, expected in cases:
            with self.subTest(stage=stage, result=type(result).__name__):
                called = []

                def step(name):
                    called.append(name)
                    if name == stage:
                        if isinstance(result, BaseException):
                            raise result
                        return result
                    return 250, b"OK"

                class Client:
                    def login(self, *_args):
                        return step("login")

                    def mail(self, *_args):
                        return step("mail")

                    def rcpt(self, *_args):
                        return step("rcpt")

                    def data(self, *_args):
                        return step("data")

                    def quit(self):
                        raise AssertionError("do not send QUIT after an uncertain or failed exchange")

                    def close(self):
                        called.append("close")

                def factory(*_args, **_kwargs):
                    step("connect")
                    return Client()

                with self.assertRaises(monitor.DeliveryFailure) as failure:
                    monitor.send_mail(message, "synthetic-test-only", factory)
                self.assertEqual(failure.exception.outcome, expected)
                self.assertNotIn("PRIVATE", str(failure.exception))
                if stage not in ("connect", "data"):
                    self.assertNotIn("data", called)


class BoundedProbeTests(unittest.TestCase):
    def test_child_has_a_hard_deadline_fixed_target_and_no_smtp_or_job_credentials(self):
        def run(command, **options):
            self.assertEqual(command[-2:], ["--probe", "api"])
            self.assertEqual(options["timeout"], monitor.HTTP_WALL_TIMEOUT)
            self.assertEqual(set(options["env"]), {"PATH", "LANG", "PYTHONDONTWRITEBYTECODE"})
            self.assertNotIn("PRIVATE", json.dumps(options))
            return subprocess.CompletedProcess(command, 0, b'{"healthy":true,"reason":"ok","status":200}', b"")

        with patch.dict(monitor.os.environ, {"Q_MONITOR_SMTP_AUTH_CODE": "PRIVATE", "CI_JOB_TOKEN": "PRIVATE"}):
            self.assertEqual(monitor.bounded_probe(monitor.ENDPOINTS[0], run), HEALTHY)

    def test_unresponsive_child_is_killed_by_the_subprocess_timeout_and_classified(self):
        def run(command, **options):
            raise subprocess.TimeoutExpired(command, options["timeout"], output=b"PRIVATE_DETAIL")

        self.assertEqual(monitor.bounded_probe(monitor.ENDPOINTS[0], run), monitor.Observation(False, "timeout"))

    def test_invalid_child_output_or_non_allowlisted_targets_cannot_look_healthy(self):
        for result in [subprocess.CompletedProcess([], 1, b"PRIVATE", b"PRIVATE"),
                       subprocess.CompletedProcess([], 0, b"PRIVATE", b""),
                       subprocess.CompletedProcess([], 0, b'{"healthy":true,"reason":"network","status":200}', b""),
                       subprocess.CompletedProcess([], 0, b"x" * 1025, b"")]:
            self.assertEqual(monitor.bounded_probe(monitor.ENDPOINTS[0], lambda *_args, **_kwargs: result), monitor.Observation(False, "network"))
        with self.assertRaises(monitor.ConfigurationError):
            monitor.bounded_probe(monitor.Endpoint("api", "Q API", "http://127.0.0.1/private"))


class EntryGateTests(unittest.TestCase):
    def test_only_protected_main_monitor_schedule_is_accepted(self):
        self.assertEqual(monitor.ci_context(ci_env()), CONTEXT)
        for field, value in [("CI", "false"), ("CI_PROJECT_ID", "other"), ("CI_DEFAULT_BRANCH", "other"),
                             ("CI_COMMIT_BRANCH", "Mandow"), ("CI_COMMIT_REF_PROTECTED", "false"),
                             ("CI_PIPELINE_SOURCE", "push"), ("CI_PIPELINE_SOURCE", "merge_request_event"),
                             ("CI_PIPELINE_SOURCE", "web"), ("CI_JOB_NAME", "deploy-staging-api"),
                             ("Q_MONITOR_SCHEDULE", "0"), ("CI_DEBUG_TRACE", "true"),
                             ("Q_MONITOR_TEST_ID", "bad\nPRIVATE"), ("CI_COMMIT_SHA", "fake"), ("CI_JOB_ID", "0")]:
            with self.subTest(field=field, value=value), self.assertRaises(monitor.ConfigurationError):
                monitor.ci_context({**ci_env(), field: value})

    def test_invalid_context_or_missing_secret_stops_before_probing(self):
        for env in [{}, {**ci_env(), "Q_MONITOR_SMTP_AUTH_CODE": ""}]:
            output = io.StringIO()
            with patch.object(monitor, "monitor", side_effect=AssertionError("must not probe")), redirect_stdout(output):
                self.assertEqual(monitor.main(env), 2)
            self.assertNotIn("synthetic", output.getvalue())

    def test_main_keeps_auth_out_of_output_cache_and_report(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / ".gitlab-ci.yml").write_text("fixture")
            env = {**ci_env(temp), "Q_MONITOR_TEST_ID": "acceptance"}
            original = monitor.monitor

            def local_run(*args, **kwargs):
                kwargs["probe_fn"] = lambda _endpoint: HEALTHY
                return original(*args, **kwargs, sleep=lambda _seconds: None)

            output = io.StringIO()
            with patch.object(monitor, "monitor", side_effect=local_run), patch.object(monitor, "send_mail") as mail, redirect_stdout(output):
                self.assertEqual(monitor.main(env), 0)
                self.assertEqual(mail.call_count, 1)
                self.assertEqual(monitor.main(env), 0)
                self.assertEqual(mail.call_count, 1)
            public = output.getvalue() + (root / monitor.STATE_RELATIVE).read_text() + (root / monitor.REPORT_RELATIVE).read_text()
            self.assertNotIn(env["Q_MONITOR_SMTP_AUTH_CODE"], public)
            self.assertNotIn("Q_MONITOR_SMTP_AUTH_CODE", public)
            self.assertIn('"smtp_accepted"', public)


if __name__ == "__main__":
    unittest.main()
