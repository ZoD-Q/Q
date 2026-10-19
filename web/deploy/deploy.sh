#!/usr/bin/env bash
# Explicit, one-shot static deployment. Never called automatically by CI.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bash web/deploy/deploy.sh --sha <40hex> --pipeline-id <id> [--dist <dir>] --validate-only
  bash web/deploy/deploy.sh --sha <40hex> --pipeline-id <id> [--dist <dir>] --identity <private-key-path>
  bash web/deploy/deploy.sh --rollback <transaction-id> --identity <private-key-path>

Deploys only the static demo at https://8.163.108.216/q-admin/.
Before deployment, independently verify that all required GitLab jobs passed for this SHA.
--validate-only packages and checks the local build without SSH or server changes.
USAGE
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(git -C "$script_dir" rev-parse --show-toplevel)
dist_dir="$repo_dir/web/dist"
sha=''
pipeline_id=''
identity=''
rollback_id=''
validate_only=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha|--pipeline-id|--dist|--identity|--rollback)
      [[ $# -ge 2 && -n "$2" ]] || { usage >&2; exit 2; }
      case "$1" in
        --sha) sha=$2 ;;
        --pipeline-id) pipeline_id=$2 ;;
        --dist) dist_dir=$2 ;;
        --identity) identity=$2 ;;
        --rollback) rollback_id=$2 ;;
      esac
      shift 2 ;;
    --validate-only) validate_only=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

task_tmp=$(mktemp -d "${TMPDIR:-/tmp}/q-admin-demo.local.XXXXXXXX")
remote_tmp=''
ssh_args=()
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$remote_tmp" ]]; then
    ssh "${ssh_args[@]}" ecs-user@8.163.108.216 "rm -rf -- '$remote_tmp'" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$task_tmp"
  exit "$status"
}
trap cleanup EXIT

if [[ -n "$rollback_id" ]]; then
  [[ "$rollback_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}-[0-9]+$ && -z "$sha" && -z "$pipeline_id" && "$validate_only" == 0 ]] || { usage >&2; exit 2; }
  action=rollback
else
  [[ "$sha" =~ ^[0-9a-f]{40}$ && "$pipeline_id" =~ ^[1-9][0-9]*$ ]] || { usage >&2; exit 2; }
  action=deploy
  python3 "$script_dir/deploy_tools.py" package --repo "$repo_dir" --dist "$dist_dir" --sha "$sha" --pipeline-id "$pipeline_id" --output "$task_tmp/release.tar.gz"
  archive_hash=$(python3 "$script_dir/deploy_tools.py" checksum "$task_tmp/release.tar.gz")
  if [[ "$validate_only" == 1 ]]; then
    printf 'Local validation passed: sha=%s pipeline=%s archive_sha256=%s\n' "$sha" "$pipeline_id" "$archive_hash"
    exit 0
  fi
fi

[[ -n "$identity" && -f "$identity" ]] || { echo 'Supply an existing SSH identity with --identity.' >&2; exit 2; }
ssh_args=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o IdentitiesOnly=yes -i "$identity")
# A fresh mode-0700 temporary directory belongs to the authorized SSH user.
remote_candidate=$(ssh "${ssh_args[@]}" ecs-user@8.163.108.216 'umask 077; mktemp -d /tmp/q-admin-demo.upload.XXXXXXXX')
[[ "$remote_candidate" =~ ^/tmp/q-admin-demo\.upload\.[A-Za-z0-9]{8}$ ]] || { echo 'Unexpected remote temporary path.' >&2; exit 1; }
remote_tmp=$remote_candidate
scp "${ssh_args[@]}" "$script_dir/remote.sh" "$script_dir/deploy_tools.py" "ecs-user@8.163.108.216:$remote_tmp/"
if [[ "$action" == deploy ]]; then
  scp "${ssh_args[@]}" "$task_tmp/release.tar.gz" "ecs-user@8.163.108.216:$remote_tmp/release.tar.gz"
  ssh "${ssh_args[@]}" ecs-user@8.163.108.216 "sudo -n bash '$remote_tmp/remote.sh' deploy '$sha' '$archive_hash' '$pipeline_id' '$remote_tmp'"
else
  ssh "${ssh_args[@]}" ecs-user@8.163.108.216 "sudo -n bash '$remote_tmp/remote.sh' rollback '$rollback_id' '$remote_tmp'"
fi
