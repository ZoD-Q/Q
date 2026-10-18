#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cargo_bin="${Q_CARGO_BIN:-$HOME/.cargo/bin/cargo}"
if [[ ! -x "$cargo_bin" ]]; then
  echo "Rust is not installed at $cargo_bin. Install Rust with rustup, or set Q_CARGO_BIN." >&2
  exit 1
fi

exec node "$project_root/scripts/run-backend.mjs" "$cargo_bin" "$@"
