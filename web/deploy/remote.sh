#!/usr/bin/env bash
# Invoked only by deploy.sh, through explicit SSH + sudo. No application runtime.
set -Eeuo pipefail
umask 022
[[ $(id -u) == 0 ]] || { echo 'This script requires the authorized sudo invocation.' >&2; exit 1; }
[[ $# -ge 1 ]] || exit 2
action=$1
case "$action" in
  deploy)
    [[ $# == 5 && "$2" =~ ^[0-9a-f]{40}$ && "$3" =~ ^[0-9a-f]{64}$ && "$4" =~ ^[1-9][0-9]*$ ]] || exit 2
    sha=$2; archive_hash=$3; pipeline_id=$4; upload=$5 ;;
  rollback)
    [[ $# == 3 && "$2" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}-[0-9]+$ ]] || exit 2
    transaction=$2; upload=$3 ;;
  *) exit 2 ;;
esac
[[ "$upload" =~ ^/tmp/q-admin-demo\.upload\.[A-Za-z0-9]{8}$ && -d "$upload" && ! -L "$upload" ]] || exit 2
helper="$upload/deploy_tools.py"
exec 9>/var/lock/q-admin-demo.lock
flock -n 9 || { echo 'Another Q static release is running.' >&2; exit 1; }

if [[ "$action" == rollback ]]; then
  python3 "$helper" restore --transaction "$transaction"
  nginx -t
  systemctl reload nginx
  printf 'Rollback complete: transaction=%s\n' "$transaction"
  exit 0
fi

nginx -t
transaction="$(date -u +%Y%m%dT%H%M%SZ)-$sha-$$"
prepared=0
completed=0
on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$prepared" == 1 && "$completed" == 0 ]]; then
    echo "Release failed; restoring transaction $transaction." >&2
    if python3 "$helper" restore --transaction "$transaction" && nginx -t && systemctl reload nginx; then
      echo 'Previous configuration and static target restored.' >&2
    else
      echo "Automatic restoration could not finish. Inspect /var/www/q-admin-demo/backups/$transaction before any further changes." >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$helper" prepare --upload "$upload" --sha "$sha" --checksum "$archive_hash" --pipeline-id "$pipeline_id" --transaction "$transaction"
prepared=1
python3 "$helper" activate --transaction "$transaction"
nginx -t
systemctl reload nginx
# Check this Nginx instance with normal certificate verification; no insecure TLS bypass.
python3 "$helper" smoke --sha "$sha"
python3 "$helper" complete --transaction "$transaction"
completed=1
printf 'Deployment complete: sha=%s pipeline=%s archive_sha256=%s transaction=%s url=https://8.163.108.216/q-admin/\n' "$sha" "$pipeline_id" "$archive_hash" "$transaction"
printf 'Public browser acceptance is still required. To undo, use --rollback %s.\n' "$transaction"
