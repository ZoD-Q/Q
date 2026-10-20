import importlib.util
import io
import json
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "beauty_health", Path(__file__).with_name("health-check.py")
)
HEALTH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HEALTH)
SHA = "a" * 40


class Response(io.BytesIO):
    status = 200

    def geturl(self):
        return HEALTH.HEALTH_URL


class Opener:
    def __init__(self, value):
        self.value = value

    def open(self, url, timeout):
        assert url == HEALTH.HEALTH_URL and timeout == 5
        return Response(json.dumps(self.value).encode())


class HealthTests(unittest.TestCase):
    def value(self):
        return {
            "status": "ok", "service": "beauty-mcp", "source_commit": SHA,
            "photo_count": 300, "public_base": HEALTH.BASE,
        }

    def test_accepts_exact_release_health(self):
        HEALTH.check(SHA, Opener(self.value()))

    def test_rejects_wrong_commit_photo_count_and_public_base(self):
        for field, value in [
            ("source_commit", "b" * 40), ("photo_count", 299),
            ("public_base", "https://other.example/"),
        ]:
            result = self.value()
            result[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                HEALTH.check(SHA, Opener(result))

    def test_development_build_is_not_a_deployable_health_result(self):
        with self.assertRaises(ValueError):
            HEALTH.check("development", Opener(self.value()))

    def test_rejects_redirect_before_following_it(self):
        with self.assertRaises(ValueError):
            HEALTH.NoRedirect().redirect_request(
                None, None, 302, "Found", {}, "http://127.0.0.1:18787/other"
            )

    def test_recovery_does_not_start_a_stopped_service(self):
        with patch.object(HEALTH.sys, "argv", ["health-check.py", "--recover"]), \
                patch.object(Path, "read_text", return_value=SHA), \
                patch.object(HEALTH, "check", side_effect=ValueError("unreachable")), \
                patch.object(HEALTH.subprocess, "run", return_value=SimpleNamespace(returncode=3)) as run:
            with self.assertRaisesRegex(RuntimeError, "left stopped"):
                HEALTH.main()
        self.assertEqual(run.call_args_list[0].args[0], [
            "systemctl", "is-active", "--quiet", "q-beauty.service"
        ])
        self.assertEqual(run.call_count, 1)

    def test_recovery_restarts_only_the_active_gallery_then_checks_its_version(self):
        with patch.object(HEALTH.sys, "argv", ["health-check.py", "--recover"]), \
                patch.object(Path, "read_text", return_value=SHA), \
                patch.object(HEALTH, "check", side_effect=[ValueError("unresponsive"), None]) as check, \
                patch.object(HEALTH.time, "sleep"), \
                patch.object(HEALTH.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            HEALTH.main()
        self.assertEqual(run.call_args_list[1].args[0], [
            "systemctl", "try-restart", "q-beauty.service"
        ])
        self.assertEqual(check.call_count, 2)


if __name__ == "__main__":
    unittest.main()
