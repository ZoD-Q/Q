#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
exec 9>/run/lock/q-backup.lock
flock -n 9 || exit 0
config=/etc/q/deploy.env
compose=/opt/q/current/deploy/compose.yaml
backup=/var/backups/q
install -d -m 0700 "$backup" "$backup/secrets"
[[ -f "$config" && ! -L "$config" ]] || { echo 'Missing regular deployment configuration' >&2; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d "$backup/.q-backup-XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
command=(docker compose --env-file "$config" -f "$compose" -p q)
"${command[@]}" exec -T db pg_dump --username q_admin --dbname q --format=custom > "$work/database.dump"
[[ -s "$work/database.dump" ]]
"${command[@]}" exec -T db pg_restore --list < "$work/database.dump" > /dev/null
install -m 0600 "$config" "$work/deploy.env"
sha256sum "$work/database.dump" | cut -d ' ' -f 1 > "$work/database.sha256"
mv "$work/deploy.env" "$backup/secrets/q-secrets-$stamp.env"
mv "$work/database.sha256" "$backup/q-db-$stamp.sha256"
mv "$work/database.dump" "$backup/q-db-$stamp.dump"
# Only Q-generated, timestamped files; never traverse other backup directories.
find "$backup" -maxdepth 1 -type f \( -name 'q-db-????????T??????Z.dump' -o -name 'q-db-????????T??????Z.sha256' \) -mtime +14 -delete
find "$backup/secrets" -maxdepth 1 -type f -name 'q-secrets-????????T??????Z.env' -mtime +14 -delete
printf 'Q local backup completed: %s (off-host copy not configured)\n' "$stamp"
