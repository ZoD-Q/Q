#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
nginx_bin="${Q_NGINX_BIN:-nginx}"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/q-nginx-check-XXXXXXXX")"
trap 'rm -rf -- "$temp_dir"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -keyout "$temp_dir/tls.key" -out "$temp_dir/tls.crt" >/dev/null 2>&1
python3 - "$repo_root" "$temp_dir" <<'PYTHON'
import base64
import hashlib
from pathlib import Path
import re
import sys

root, temp = map(Path, sys.argv[1:])
page = (root / 'web/public/privacy.html').read_text()
scripts = re.findall(r'<script>(.*?)</script>', page, re.S)
if len(scripts) != 1:
    raise SystemExit('Expected exactly one inline privacy-page script.')
digest = base64.b64encode(hashlib.sha256(scripts[0].encode()).digest()).decode()
config = (root / 'backend/deploy/nginx-q-domain.conf').read_text()
if config.count("'sha256-" + digest + "'") != 2:
    raise SystemExit('Privacy-page script does not match both ingress CSP hashes.')
config = config.replace('/etc/nginx/ssl/fullchain.pem', str(temp / 'tls.crt'))
config = config.replace('/etc/nginx/ssl/privkey.pem', str(temp / 'tls.key'))
config = config.replace('/var/log/nginx/q-api-domain-error.log', 'stderr')
(temp / 'q-domain.conf').write_text(config)
(temp / 'nginx.conf').write_text(
    f'pid "{temp}/nginx.pid";\nerror_log stderr warn;\nevents {{}}\n'
    f'http {{ include "{temp}/q-domain.conf"; }}\n'
)
PYTHON
"$nginx_bin" -t -p "$temp_dir/" -c "$repo_root/backend/deploy/nginx.conf"
"$nginx_bin" -t -p "$temp_dir/" -c "$temp_dir/nginx.conf"
