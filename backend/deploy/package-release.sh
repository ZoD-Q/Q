#!/usr/bin/env bash
# Build a reviewed default-branch revision without changing the caller's checkout.
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
default_branch="${CI_DEFAULT_BRANCH:-main}"
git -C "$repo_root" check-ref-format "refs/heads/$default_branch"
git -C "$repo_root" fetch --no-tags origin \
  "refs/heads/$default_branch:refs/remotes/origin/$default_branch"
reviewed_ref="refs/remotes/origin/$default_branch"
requested_ref="${Q_RELEASE_REF:-$reviewed_ref}"
# A deployment pipeline must build its own reviewed commit even if main advances.
if [[ "${CI_COMMIT_BRANCH:-}" == main && "${CI_COMMIT_REF_PROTECTED:-}" == true ]]; then
  if [[ "$default_branch" != main || ! "${CI_COMMIT_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Release refused: invalid protected main pipeline identity.\n' >&2
    exit 1
  fi
  if [[ -n "${Q_RELEASE_REF:-}" && "$Q_RELEASE_REF" != "$CI_COMMIT_SHA" ]]; then
    printf 'Release refused: protected main may only package its exact pipeline commit.\n' >&2
    exit 1
  fi
  requested_ref="$CI_COMMIT_SHA"
  if [[ "$(git -C "$repo_root" rev-parse HEAD)" != "$CI_COMMIT_SHA" ]]; then
    printf 'Release refused: checkout does not match the protected pipeline commit.\n' >&2
    exit 1
  fi
fi
source_commit="$(git -C "$repo_root" rev-parse --verify --end-of-options "${requested_ref}^{commit}")"
if ! git -C "$repo_root" merge-base --is-ancestor "$source_commit" "$reviewed_ref"; then
  printf 'Release refused: requested commit is not in reviewed %s history.\n' "$default_branch" >&2
  exit 1
fi

output_dir="$repo_root/backend/.local/release"
mkdir -p "$output_dir"
build_dir="$(mktemp -d "$output_dir/.build-XXXXXXXX")"
trap 'rm -rf -- "$build_dir"' EXIT
mkdir -p "$build_dir/source" "$build_dir/q-release"
git -C "$repo_root" archive "$source_commit" backend | tar -xf - -C "$build_dir/source"
# SQLx uses SHA-384 of the unmodified SQL bytes. Derive this from the same
# immutable archive as the binary, never from a developer's working directory.
python3 - "$build_dir/source/backend/migrations" "$build_dir/q-release/MIGRATIONS" <<'PYTHON'
import hashlib
from pathlib import Path
import re
import sys

source, output = map(Path, sys.argv[1:])
rows = {}
for path in sorted(source.iterdir()):
    if path.suffix != '.sql':
        continue
    match = re.fullmatch(r'([0-9]+)_.+\.sql', path.name)
    if (not match or path.is_symlink() or not path.is_file()
            or path.name.endswith(('.up.sql', '.down.sql'))):
        raise SystemExit('Release refused: unsupported migration filename or file type.')
    version = int(match.group(1))
    if not 0 < version < 2 ** 63 or version in rows:
        raise SystemExit('Release refused: migration versions must be unique positive signed 64-bit integers.')
    rows[version] = hashlib.sha384(path.read_bytes()).hexdigest()
if not rows:
    raise SystemExit('Release refused: missing SQL migrations.')
manifest = ''.join(f'{version} {rows[version]}\n' for version in sorted(rows))
if len(manifest.encode('ascii')) > 1024 * 1024:
    raise SystemExit('Release refused: migration manifest exceeds size budget.')
output.write_text(manifest, encoding='ascii')
PYTHON
CARGO_TARGET_DIR="$build_dir/target" cargo build \
  --manifest-path "$build_dir/source/backend/Cargo.toml" \
  --locked --release --bin xiaoq-backend
cp "$build_dir/target/release/xiaoq-backend" "$build_dir/q-release/xiaoq-backend"
printf '%s\n' "$source_commit" > "$build_dir/q-release/SOURCE_COMMIT"
(
  cd "$build_dir/q-release"
  sha256sum xiaoq-backend SOURCE_COMMIT MIGRATIONS > SHA256SUMS
)
archive_name="q-release-${source_commit}.tar.gz"
tar -czf "$build_dir/$archive_name" -C "$build_dir" q-release
mv "$build_dir/$archive_name" "$output_dir/$archive_name"
printf 'Release package: %s/%s\nSource commit: %s\n' "$output_dir" "$archive_name" "$source_commit"
