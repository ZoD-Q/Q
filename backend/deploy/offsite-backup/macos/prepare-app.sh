#!/bin/bash
# Build only: never installs, launches, changes launchd or grants permissions.
set -euo pipefail
umask 077
[[ $# -eq 0 ]] || { echo 'No arguments accepted' >&2; exit 64; }
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(cd -- "$source_dir/../../../.." && pwd)
output="$repo/.local/offsite-backup-macos"
app="$output/Q Offsite Backup.app"
[[ ! -L "$output" && ! -L "$app" ]] || { echo 'Unsafe build output' >&2; exit 1; }
mkdir -p "$app/Contents/MacOS" "$output/module-cache"
/usr/bin/swiftc -O -module-cache-path "$output/module-cache" -framework AppKit \
  "$source_dir/BackupLauncher.swift" -o "$app/Contents/MacOS/QBackupLauncher"
/bin/cp "$source_dir/Info.plist" "$app/Contents/Info.plist"
/usr/bin/plutil -lint "$app/Contents/Info.plist"
/usr/bin/codesign --force --sign - --identifier com.kaicloud.q.offsite-backup "$app"
/usr/bin/codesign --verify --strict "$app"
echo "Prepared application: $app"
echo 'Review before installation. First GUI launch must request Desktop access from the user.'
