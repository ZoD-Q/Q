#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
compose=(docker compose --env-file /etc/q/deploy.env -f /opt/q/current/deploy/compose.yaml -p q)
failed=0
for service in db api gateway; do
  id=$("${compose[@]}" ps -q "$service")
  if [[ -z "$id" ]]; then
    printf 'Q service missing: %s\n' "$service" >&2
    failed=1
    continue
  fi
  status=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$id")
  if [[ "$status" != 'running healthy' ]]; then
    printf 'Q service unhealthy: %s (%s)\n' "$service" "$status" >&2
    failed=1
  fi
done
if ! curl --fail --silent --show-error --connect-timeout 3 --max-time 8 http://127.0.0.1:18787/health > /dev/null; then
  echo 'Q gateway health failed' >&2
  failed=1
fi
for path in /var/lib/q /var/backups/q; do
  used=$(df -P "$path" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
  if [[ ! "$used" =~ ^[0-9]+$ ]] || (( used >= 85 )); then
    printf 'Q disk check failed: %s (%s%%)\n' "$path" "$used" >&2
    failed=1
  fi
done
(( failed == 0 )) || exit 1
echo 'Q services and disk healthy'
