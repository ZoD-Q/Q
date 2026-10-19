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
CARGO_TARGET_DIR="$build_dir/target" cargo build \
  --manifest-path "$build_dir/source/backend/Cargo.toml" \
  --locked --release --bin xiaoq-backend
cp "$build_dir/target/release/xiaoq-backend" "$build_dir/q-release/xiaoq-backend"
printf '%s\n' "$source_commit" > "$build_dir/q-release/SOURCE_COMMIT"
(
  cd "$build_dir/q-release"
  sha256sum xiaoq-backend SOURCE_COMMIT > SHA256SUMS
)
archive_name="q-release-${source_commit}.tar.gz"
tar -czf "$build_dir/$archive_name" -C "$build_dir" q-release
mv "$build_dir/$archive_name" "$output_dir/$archive_name"
printf 'Release package: %s/%s\nSource commit: %s\n' "$output_dir" "$archive_name" "$source_commit"
