#!/usr/bin/env python3
"""Read only local health/version check; optional recovery targets this service only."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

BASE = "https://q.kaicloudpay.com/plugins/beauty/"
HEALTH_URL = "http://127.0.0.1:18796/health"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        raise ValueError("Health endpoint must not redirect")


def check(expected_commit, opener=None):
    if not re.fullmatch(r"[0-9a-f]{40}", expected_commit):
        raise ValueError("Health check requires a full source commit")
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(HEALTH_URL, timeout=5) as response:
        if response.status != 200 or response.geturl() != HEALTH_URL:
            raise ValueError("Unexpected health response")
        body = response.read(4097)
    if len(body) > 4096:
        raise ValueError("Oversized health response")
    value = json.loads(body)
    expected = {
        "status": "ok",
        "service": "beauty-mcp",
        "source_commit": expected_commit,
        "photo_count": 300,
        "public_base": BASE,
    }
    if value != expected:
        raise ValueError("Gallery health/version mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recover", action="store_true")
    args = parser.parse_args()
    # The file belongs to the immutable, root-owned current release.
    commit = Path("/opt/q-beauty/current/SOURCE_COMMIT").read_text().strip()
    try:
        check(commit)
    except Exception:
        if not args.recover:
            raise
        # try-restart never starts a deliberately stopped service.
        active = subprocess.run(
            ["systemctl", "is-active", "--quiet", "q-beauty.service"], check=False
        )
        if active.returncode != 0:
            raise RuntimeError("Gallery is not active; left stopped") from None
        subprocess.run(["systemctl", "try-restart", "q-beauty.service"], check=True, timeout=25)
        for attempt in range(5):
            time.sleep(1)
            try:
                check(commit)
                break
            except Exception:
                if attempt == 4:
                    raise
        print("Q Beauty gallery recovered; version verified.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Q Beauty health failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
