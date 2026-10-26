#!/usr/bin/env python3
"""Bounded external Q health checks; SMTP is used only by the protected scheduled job."""

from __future__ import annotations

import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import smtplib
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from email.message import EmailMessage
from email import policy
from email.utils import formatdate
from typing import Callable


ORIGIN = "https://q.kaicloudpay.com"
MAILBOX = "xzy070212@qq.com"
SMTP_HOST = "smtp.qq.com"
SMTP_PORT = 465
HTTP_TIMEOUT = 8
HTTP_WALL_TIMEOUT = 12
SMTP_TIMEOUT = 10
BODY_LIMIT = 4096
STATE_LIMIT = 32768
STATE_MAX_AGE = 20 * 60
FAILURE_THRESHOLD = 2
MAX_DELIVERY_ATTEMPTS = 3
DELIVERY_RETRY_COOLDOWN = 30 * 60
INCIDENT_HISTORY_LIMIT = 4
BOOTSTRAP_CONFIRM_DELAY = 2
STATE_RELATIVE = Path("backend/.local/monitor-state/state.json")
REPORT_RELATIVE = Path("backend/.local/monitor-report/result.json")
REASONS = frozenset({"ok", "http_error", "redirect", "timeout", "network", "tls", "invalid_health"})


class ConfigurationError(Exception):
    """Only fixed, non-sensitive error codes may escape to the job log."""


class DeliveryFailure(Exception):
    """A fixed outcome classification, never the provider's error or response text."""

    def __init__(self, outcome: str):
        if outcome not in {"not_delivered", "unknown"}:
            raise ValueError("invalid_delivery_outcome")
        super().__init__("smtp_" + outcome)
        self.outcome = outcome


@dataclass(frozen=True)
class Endpoint:
    key: str
    label: str
    url: str


ENDPOINTS = (
    Endpoint("api", "Q API", ORIGIN + "/health"),
    Endpoint("beauty", "图库", ORIGIN + "/plugins/beauty/health"),
)


@dataclass(frozen=True)
class Observation:
    healthy: bool
    reason: str
    status: int | None = None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect", headers, fp)


def public_opener():
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        NoRedirect(),
    )


def probe(endpoint: Endpoint, opener=None) -> Observation:
    """Never follow redirects, use proxies, send credentials, or include response text in output."""
    request = urllib.request.Request(endpoint.url, headers={"Accept": "application/json", "User-Agent": "Q-External-Monitor/1"})
    try:
        with (opener or public_opener()).open(request, timeout=HTTP_TIMEOUT) as response:
            status = response.status
            if status != 200:
                return Observation(False, "http_error", status)
            if response.geturl() != endpoint.url:
                return Observation(False, "redirect", status)
            raw = response.read(BODY_LIMIT + 1)
        if len(raw) > BODY_LIMIT:
            return Observation(False, "invalid_health", status)
        value = json.loads(raw)
        valid = isinstance(value, dict) and value.get("status") == "ok"
        if endpoint.key == "beauty":
            valid = valid and value.get("service") == "beauty-mcp" and type(value.get("photo_count")) is int and value["photo_count"] == 300 \
                and value.get("public_base") == ORIGIN + "/plugins/beauty/" \
                and isinstance(value.get("source_commit"), str) \
                and re.fullmatch(r"[0-9a-f]{40}", value["source_commit"]) is not None
        return Observation(valid, "ok" if valid else "invalid_health", status)
    except urllib.error.HTTPError as error:
        error.close()
        return Observation(False, "redirect" if 300 <= error.code < 400 else "http_error", error.code)
    except (TimeoutError, socket.timeout):
        return Observation(False, "timeout")
    except ssl.SSLError:
        return Observation(False, "tls")
    except urllib.error.URLError as error:
        reason = "tls" if isinstance(error.reason, ssl.SSLError) else "timeout" if isinstance(error.reason, (TimeoutError, socket.timeout)) else "network"
        return Observation(False, reason)
    except (UnicodeError, ValueError, TypeError, RecursionError):
        return Observation(False, "invalid_health")
    except (OSError, http.client.HTTPException):
        return Observation(False, "network")


def bounded_probe(endpoint: Endpoint, run=subprocess.run) -> Observation:
    """A subprocess bounds DNS and slow response bodies as well as individual socket operations."""
    if endpoint not in ENDPOINTS:
        raise ConfigurationError("invalid_probe_target")
    try:
        result = run([sys.executable, "-I", str(Path(__file__).resolve()), "--probe", endpoint.key],
                     capture_output=True, timeout=HTTP_WALL_TIMEOUT, check=False,
                     env={"PATH": os.defpath, "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"})
        if result.returncode != 0 or len(result.stdout) > 1024:
            return Observation(False, "network")
        value = json.loads(result.stdout)
        if not isinstance(value, dict) or set(value) != {"healthy", "reason", "status"} \
            or type(value["healthy"]) is not bool or value["reason"] not in REASONS \
            or (value["status"] is not None and (type(value["status"]) is not int or not 100 <= value["status"] <= 599)) \
            or value["healthy"] != (value["reason"] == "ok"):
            return Observation(False, "network")
        return Observation(**value)
    except subprocess.TimeoutExpired:
        return Observation(False, "timeout")
    except (OSError, ValueError, TypeError):
        return Observation(False, "network")


def ci_context(env: dict[str, str]) -> dict[str, str]:
    expected = {
        "CI": "true", "CI_PROJECT_ID": "197", "CI_DEFAULT_BRANCH": "main",
        "CI_COMMIT_BRANCH": "main", "CI_COMMIT_REF_PROTECTED": "true",
        "CI_PIPELINE_SOURCE": "schedule", "CI_JOB_NAME": "q-external-monitor",
        "Q_MONITOR_SCHEDULE": "1",
    }
    if any(env.get(key) != value for key, value in expected.items()):
        raise ConfigurationError("protected_monitor_schedule_required")
    if env.get("CI_DEBUG_TRACE", "false").lower() == "true":
        raise ConfigurationError("debug_trace_forbidden")
    if not re.fullmatch(r"[0-9a-f]{40}", env.get("CI_COMMIT_SHA", "")):
        raise ConfigurationError("invalid_source_identity")
    if any(not re.fullmatch(r"[1-9][0-9]{0,18}", env.get(key, "")) for key in ("CI_JOB_ID", "CI_PIPELINE_ID")):
        raise ConfigurationError("invalid_job_identity")
    test_id = env.get("Q_MONITOR_TEST_ID", "")
    if test_id and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", test_id):
        raise ConfigurationError("invalid_test_id")
    return {"job_id": env["CI_JOB_ID"], "pipeline_id": env["CI_PIPELINE_ID"], "source_sha": env["CI_COMMIT_SHA"], "test_id": test_id}


def empty_state(now: int) -> dict:
    return {"version": 2, "updated_at": now, "services": {
        item.key: {"failures": 0, "first_failure_at": None, "incident": None, "previous_incidents": []} for item in ENDPOINTS
    }, "test_notification": None}


def new_delivery() -> dict:
    return {"status": "pending", "attempts": 0, "last_attempt_at": None}


def valid_time(value, now: int) -> bool:
    return type(value) is int and 0 <= value <= now + 60


def valid_legacy_state(value, now: int) -> bool:
    if not isinstance(value, dict) or set(value) != {"version", "updated_at", "services", "test_sent_id"} \
        or type(value["version"]) is not int or value["version"] != 1 or not valid_time(value["updated_at"], now) \
        or not isinstance(value["test_sent_id"], str) or re.fullmatch(r"[A-Za-z0-9_-]{0,64}", value["test_sent_id"]) is None:
        return False
    services = value["services"]
    if not isinstance(services, dict) or set(services) != {item.key for item in ENDPOINTS}:
        return False
    for entry in services.values():
        if not isinstance(entry, dict) or set(entry) != {"failures", "first_failure_at", "incident"} \
            or type(entry["failures"]) is not int or not 0 <= entry["failures"] <= FAILURE_THRESHOLD:
            return False
        first = entry["first_failure_at"]
        if (entry["failures"] == 0 and first is not None) or (entry["failures"] > 0 and not valid_time(first, now)):
            return False
        incident = entry["incident"]
        if incident is not None and (not isinstance(incident, dict) or set(incident) != {"id", "since", "alert_sent"}
            or not isinstance(incident["id"], str) or re.fullmatch(r"[0-9a-f]{32}", incident["id"]) is None
            or not valid_time(incident["since"], now) or type(incident["alert_sent"]) is not bool):
            return False
        if entry["failures"] == FAILURE_THRESHOLD and incident is None:
            return False
    return True


def valid_delivery(value, now: int) -> bool:
    if not isinstance(value, dict) or set(value) != {"status", "attempts", "last_attempt_at"} \
        or not isinstance(value["status"], str) or value["status"] not in {"pending", "in_flight", "accepted", "not_delivered", "unknown", "exhausted"} \
        or type(value["attempts"]) is not int or not 0 <= value["attempts"] <= MAX_DELIVERY_ATTEMPTS:
        return False
    if value["status"] == "pending":
        return value["attempts"] == 0 and value["last_attempt_at"] is None
    if value["attempts"] == 0 or not valid_time(value["last_attempt_at"], now):
        return False
    return (value["status"] != "exhausted" or value["attempts"] == MAX_DELIVERY_ATTEMPTS) \
        and (value["status"] != "not_delivered" or value["attempts"] < MAX_DELIVERY_ATTEMPTS)


def valid_incident(value, now: int) -> bool:
    return isinstance(value, dict) and set(value) == {"id", "since", "recovered_at", "alert", "recovery"} \
        and isinstance(value["id"], str) and re.fullmatch(r"[0-9a-f]{32}", value["id"]) is not None \
        and valid_time(value["since"], now) \
        and (value["recovered_at"] is None or (valid_time(value["recovered_at"], now) and value["recovered_at"] >= value["since"])) \
        and valid_delivery(value["alert"], now) and valid_delivery(value["recovery"], now) \
        and (value["recovered_at"] is not None or value["recovery"]["status"] == "pending")


def valid_state(value, now: int) -> bool:
    if not isinstance(value, dict) or set(value) != {"version", "updated_at", "services", "test_notification"} \
        or type(value["version"]) is not int or value["version"] != 2 or not valid_time(value["updated_at"], now):
        return False
    services = value["services"]
    if not isinstance(services, dict) or set(services) != {item.key for item in ENDPOINTS}:
        return False
    for entry in services.values():
        if not isinstance(entry, dict) or set(entry) != {"failures", "first_failure_at", "incident", "previous_incidents"} \
            or type(entry["failures"]) is not int or not 0 <= entry["failures"] <= FAILURE_THRESHOLD:
            return False
        first = entry["first_failure_at"]
        if (entry["failures"] == 0 and first is not None) or (entry["failures"] > 0 and not valid_time(first, now)):
            return False
        incident = entry["incident"]
        if incident is not None and not valid_incident(incident, now):
            return False
        if entry["failures"] == FAILURE_THRESHOLD and (incident is None or incident["recovered_at"] is not None):
            return False
        previous = entry["previous_incidents"]
        if not isinstance(previous, list) or len(previous) > INCIDENT_HISTORY_LIMIT \
            or any(not valid_incident(item, now) or item["recovered_at"] is None for item in previous):
            return False
    test = value["test_notification"]
    return test is None or (isinstance(test, dict) and set(test) == {"id", "delivery"}
        and isinstance(test["id"], str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", test["id"]) is not None
        and valid_delivery(test["delivery"], now))


def upgrade_legacy_state(value: dict) -> dict:
    state = empty_state(value["updated_at"])
    for key, old in value["services"].items():
        entry = state["services"][key]
        entry.update(failures=old["failures"], first_failure_at=old["first_failure_at"])
        if old["incident"]:
            incident = old["incident"]
            # v1 did not distinguish failure from an unacknowledged delivery. Do not replay it.
            attempted = {"status": "unknown", "attempts": 1, "last_attempt_at": value["updated_at"]}
            entry["incident"] = {"id": incident["id"], "since": incident["since"],
                "recovered_at": max(incident["since"], value["updated_at"]) if old["failures"] == 0 else None,
                "alert": {**attempted, "status": "accepted" if incident["alert_sent"] else "unknown"},
                "recovery": attempted.copy() if old["failures"] == 0 else new_delivery()}
    if value["test_sent_id"]:
        state["test_notification"] = {"id": value["test_sent_id"],
            "delivery": {"status": "accepted", "attempts": 1, "last_attempt_at": value["updated_at"]}}
    return state


def stop_interrupted_deliveries(state: dict):
    deliveries = []
    for entry in state["services"].values():
        for incident in [entry["incident"], *entry["previous_incidents"]]:
            if incident:
                deliveries.extend([incident["alert"], incident["recovery"]])
    if state["test_notification"]:
        deliveries.append(state["test_notification"]["delivery"])
    for delivery in deliveries:
        if delivery["status"] == "in_flight":
            delivery["status"] = "unknown"


def load_state(path: Path, now: int) -> tuple[dict, str]:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("not_regular")
            raw = stream.read(STATE_LIMIT + 1)
        if len(raw) > STATE_LIMIT:
            raise ValueError("oversized")
        value = json.loads(raw)
        status = "restored"
        if valid_legacy_state(value, now):
            value = upgrade_legacy_state(value)
            status = "migrated"
        elif not valid_state(value, now):
            raise ValueError("invalid")
        stop_interrupted_deliveries(value)
        if now - value["updated_at"] > STATE_MAX_AGE:
            # Observations expire; delivery outcomes never expire into permission to resend.
            for entry in value["services"].values():
                entry.update(failures=0, first_failure_at=None)
            status = "stale"
        return value, status
    except FileNotFoundError:
        return empty_state(now), "missing"
    except (OSError, ValueError, TypeError):
        return empty_state(now), "invalid"


def atomic_json(path: Path, value: dict):
    # Cache and artifacts contain only this bounded, schema-validated non-sensitive state.
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.is_symlink() or (path.exists() and (path.is_symlink() or not path.is_file())):
        raise OSError("untrusted_output_path")
    descriptor, name = tempfile.mkstemp(prefix=".monitor-", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def event_for(endpoint: Endpoint, entry: dict, observation: Observation, now: int, new_id: Callable[[], str]) -> dict | None:
    if observation.healthy:
        entry["failures"] = 0
        entry["first_failure_at"] = None
        if entry["incident"]:
            incident = entry["incident"]
            if incident["recovered_at"] is None:
                incident["recovered_at"] = max(now, incident["since"])
            return {"kind": "recovery", "service": endpoint.key, "id": incident["id"], "since": incident["since"],
                    "alert_accepted": incident["alert"]["status"] == "accepted", "delivery": incident["recovery"]}
        return None
    if entry["failures"] == 0:
        entry["first_failure_at"] = now
    entry["failures"] = min(FAILURE_THRESHOLD, entry["failures"] + 1)
    if entry["failures"] == FAILURE_THRESHOLD:
        if entry["incident"] is None or entry["incident"]["recovered_at"] is not None:
            if entry["incident"]:
                entry["previous_incidents"] = [*entry["previous_incidents"], copy.deepcopy(entry["incident"])][-INCIDENT_HISTORY_LIMIT:]
            entry["incident"] = {"id": new_id(), "since": entry["first_failure_at"], "recovered_at": None,
                                 "alert": new_delivery(), "recovery": new_delivery()}
        incident = entry["incident"]
        return {"kind": "alert", "service": endpoint.key, "id": incident["id"], "since": incident["since"],
                "delivery": incident["alert"]}
    return None


def delivery_due(delivery: dict, now: int) -> bool:
    return delivery["status"] == "pending" or (delivery["status"] == "not_delivered"
        and delivery["attempts"] < MAX_DELIVERY_ATTEMPTS
        and now - delivery["last_attempt_at"] >= DELIVERY_RETRY_COOLDOWN)


def mail_message(events: list[dict], observations: dict[str, Observation], context: dict[str, str], now: int) -> EmailMessage:
    kinds = {item["kind"] for item in events}
    category = "测试" if kinds == {"test"} else "故障" if kinds == {"alert"} else "恢复" if kinds == {"recovery"} else "状态变化"
    message = EmailMessage()
    message["From"] = MAILBOX
    message["To"] = MAILBOX
    message["Subject"] = f"[小Q监测] {category}"
    message["Date"] = formatdate(now, usegmt=True)
    identity = json.dumps([(item["kind"], item.get("service"), item["id"]) for item in events], separators=(",", ":"))
    message["Message-ID"] = "<q-monitor-" + hashlib.sha256(identity.encode()).hexdigest()[:32] + "@qq.com>"
    lines = ["小Q外部可用性监测", time.strftime("检查时间：%Y-%m-%d %H:%M:%S UTC", time.gmtime(now)), ""]
    for event in events:
        if event["kind"] == "test":
            lines.append("这是已授权的投递测试邮件，不表示服务发生故障。")
            continue
        endpoint = next(item for item in ENDPOINTS if item.key == event["service"])
        result = observations[endpoint.key]
        lines.extend([f"{endpoint.label}：{'连续两次检查失败' if event['kind'] == 'alert' else '检查已恢复'}", endpoint.url,
                      f"事件编号：{event['id']}", time.strftime("首次异常：%Y-%m-%d %H:%M:%S UTC", time.gmtime(event["since"])),
                      f"本次结果：{result.reason}" + (f"，HTTP {result.status}" if result.status is not None else "")])
        if event["kind"] == "recovery" and not event["alert_accepted"]:
            lines.append("此前故障邮件未获得投递确认，本次通知检查已恢复。")
        lines.append("")
    lines.extend([f"GitLab pipeline {context['pipeline_id']} / job {context['job_id']}",
                  "仅检查固定公开健康接口；此邮件不证明所有业务、第三方服务或数据恢复均正常。"])
    message.set_content("\n".join(lines), cte="base64")
    return message


def validate_auth_code(auth_code: str):
    if not 8 <= len(auth_code) <= 256 or any(not 33 <= ord(char) <= 126 for char in auth_code):
        raise ConfigurationError("smtp_auth_code_invalid")


def send_mail(message: EmailMessage, auth_code: str, factory=smtplib.SMTP_SSL):
    validate_auth_code(auth_code)
    client = None
    data_started = False
    accepted = False
    try:
        client = factory(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT, context=ssl.create_default_context())
        client.login(MAILBOX, auth_code)
        # Keep envelope steps separate so disconnects before DATA are known not delivered.
        if client.mail(MAILBOX)[0] != 250 or client.rcpt(MAILBOX)[0] not in {250, 251}:
            raise DeliveryFailure("not_delivered")
        data_started = True
        code, _reply = client.data(message.as_bytes(policy=policy.SMTP))
        if code != 250:
            raise DeliveryFailure("not_delivered" if 400 <= code <= 599 else "unknown")
        accepted = True
    except DeliveryFailure:
        raise
    except Exception as error:
        rejected = isinstance(error, smtplib.SMTPDataError) and 400 <= error.smtp_code <= 599
        raise DeliveryFailure("not_delivered" if not data_started or rejected else "unknown") from None
    finally:
        if client is not None:
            # A QUIT error after DATA returned 250 must not turn acceptance into a retry.
            if accepted:
                try:
                    client.quit()
                except (OSError, smtplib.SMTPException):
                    try:
                        client.close()
                    except (OSError, smtplib.SMTPException):
                        pass
            else:
                # Do not write another SMTP command after an uncertain DATA exchange.
                try:
                    client.close()
                except (OSError, smtplib.SMTPException):
                    pass


def monitor(state: dict, state_status: str, context: dict[str, str], now: int, *,
            probe_fn=probe, mailer: Callable[[EmailMessage], None], persist: Callable[[dict], None],
            sleep=time.sleep, new_id=lambda: secrets.token_hex(16)) -> tuple[dict, int]:
    stop_interrupted_deliveries(state)
    observations = {endpoint.key: probe_fn(endpoint) for endpoint in ENDPOINTS}
    # A lost/invalid cache must not reset the counter forever and silently suppress outages.
    # Confirm a failed bootstrap check with a second independent GET in the same job.
    if state_status != "restored" and any(not item.healthy for item in observations.values()):
        sleep(BOOTSTRAP_CONFIRM_DELAY)
        for endpoint in ENDPOINTS:
            if not observations[endpoint.key].healthy:
                first = observations[endpoint.key]
                event_for(endpoint, state["services"][endpoint.key], first, now, new_id)
                observations[endpoint.key] = probe_fn(endpoint)
    events = []
    for endpoint in ENDPOINTS:
        event = event_for(endpoint, state["services"][endpoint.key], observations[endpoint.key], now, new_id)
        if event:
            events.append(event)
    if context["test_id"]:
        if state["test_notification"] is None or context["test_id"] != state["test_notification"]["id"]:
            state["test_notification"] = {"id": context["test_id"], "delivery": new_delivery()}
        events.append({"kind": "test", **state["test_notification"]})
    state["updated_at"] = now
    due = [event for event in events if delivery_due(event["delivery"], now)]
    original_deliveries = [(event["delivery"], event["delivery"].copy()) for event in due]
    for delivery, _original in original_deliveries:
        delivery.update(status="in_flight", attempts=delivery["attempts"] + 1, last_attempt_at=now)
    persistence_ok = True
    try:
        persist(state)
    except OSError:
        persistence_ok = False
        for delivery, original in original_deliveries:
            delivery.update(original)
    delivery = "not_needed"
    if due and not persistence_ok:
        delivery = "blocked_state_write"
    elif due:
        try:
            mailer(mail_message(due, observations, context, now))
            delivery = "smtp_accepted"
            for event in due:
                event["delivery"]["status"] = "accepted"
        except DeliveryFailure as error:
            delivery = "known_not_delivered" if error.outcome == "not_delivered" else "unknown_stopped"
            for event in due:
                item = event["delivery"]
                item["status"] = "unknown" if error.outcome == "unknown" else "exhausted" if item["attempts"] >= MAX_DELIVERY_ATTEMPTS else "not_delivered"
        except Exception:
            # An unclassified exception might happen after acceptance. Never guess that resending is safe.
            delivery = "unknown_stopped"
            for event in due:
                event["delivery"]["status"] = "unknown"
        try:
            persist(state)
        except OSError:
            persistence_ok = False
    elif any(event["delivery"]["status"] == "unknown" for event in events):
        delivery = "unknown_stopped"
    elif any(event["delivery"]["status"] == "exhausted" for event in events):
        delivery = "retry_exhausted"
    elif any(event["delivery"]["status"] == "not_delivered" for event in events):
        delivery = "retry_cooldown"
    attention = not persistence_ok or any(event["delivery"]["status"] in {"unknown", "exhausted"} for event in events)
    report = {"checked_at": now, "state": state_status, "state_persisted": persistence_ok,
              "delivery": delivery, "job_id": context["job_id"], "pipeline_id": context["pipeline_id"],
              "manual_attention": attention,
              "notifications": [{"kind": event["kind"], "id": event["id"], "service": event.get("service"), **event["delivery"]} for event in events],
              "test_notification": state["test_notification"],
              "recent_incidents": {key: {"current": entry["incident"], "previous": entry["previous_incidents"]} for key, entry in state["services"].items()},
              "services": {key: {"healthy": value.healthy, "reason": value.reason, "http_status": value.status,
                                   "failure_count": state["services"][key]["failures"]} for key, value in observations.items()}}
    waiting_delivery = any(event["delivery"]["status"] != "accepted" for event in events)
    code = 2 if not persistence_ok or waiting_delivery else 1 if any(not item.healthy for item in observations.values()) else 0
    return report, code


def main(env=None) -> int:
    env = os.environ if env is None else env
    try:
        context = ci_context(env)
        validate_auth_code(env.get("Q_MONITOR_SMTP_AUTH_CODE", ""))
        root = Path(env["CI_PROJECT_DIR"])
        if not root.is_absolute() or not (root / ".gitlab-ci.yml").is_file():
            raise ConfigurationError("invalid_project_directory")
        now = int(time.time())
        state_path = root / STATE_RELATIVE
        state, state_status = load_state(state_path, now)
        report, code = monitor(state, state_status, context, now, probe_fn=bounded_probe,
            mailer=lambda message: send_mail(message, env.get("Q_MONITOR_SMTP_AUTH_CODE", "")),
            persist=lambda value: atomic_json(state_path, value))
        try:
            atomic_json(root / REPORT_RELATIVE, report)
        except OSError:
            code = 2
            report["report_persisted"] = False
        print(json.dumps(report, sort_keys=True))
        return code
    except ConfigurationError as error:
        print(json.dumps({"monitor_error": str(error)}))
        return 2
    except Exception:
        print(json.dumps({"monitor_error": "monitor_internal_error"}))
        return 2


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--probe":
        target = next((item for item in ENDPOINTS if item.key == sys.argv[2]), None)
        if target is None:
            sys.exit(2)
        print(json.dumps(asdict(probe(target))))
        sys.exit(0)
    if len(sys.argv) != 1:
        sys.exit(2)
    sys.exit(main())
