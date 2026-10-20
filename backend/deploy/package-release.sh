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
CARGO_TARGET_DIR="$build_dir/target" cargo zigbuild \
  --manifest-path "$build_dir/source/backend/Cargo.toml" \
  --locked --release --target x86_64-unknown-linux-gnu.2.36 --bin xiaoq-backend
compiled_binary="$build_dir/target/x86_64-unknown-linux-gnu/release/xiaoq-backend"
if [[ ! -f "$compiled_binary" || -L "$compiled_binary" ]]; then
  printf 'Release refused: compiler did not produce a regular Linux target binary.\n' >&2
  exit 1
fi
cp "$compiled_binary" "$build_dir/q-release/xiaoq-backend"
# Verify the copied artifact, not uname or the runner/image architecture. This
# parser is host-independent and never executes the candidate executable.
python3 - "$build_dir/q-release/xiaoq-backend" <<'PYTHON'
from pathlib import Path
import stat
import struct
import sys

path = Path(sys.argv[1])


def require(condition, message):
    if not condition:
        raise SystemExit('Release refused: ' + message)


require(not path.is_symlink() and path.is_file(), 'binary must be a regular file.')
with path.open('rb') as binary:
    info = path.stat()
    size = info.st_size
    require(stat.S_ISREG(info.st_mode) and info.st_mode & 0o111, 'binary is not executable.')

    def read_at(offset, length):
        require(0 <= offset <= size and 0 <= length <= size - offset,
                'truncated ELF structure or segment.')
        binary.seek(offset)
        data = binary.read(length)
        require(len(data) == length, 'truncated ELF data.')
        return data

    header = struct.unpack('<16sHHIQQQIHHHHHH', read_at(0, 64))
    (ident, elf_type, machine, version, entry, phoff, shoff, _flags,
     ehsize, phentsize, phnum, shentsize, shnum, shstrndx) = header
    require(ident[:7] == b'\x7fELF\x02\x01\x01' and ident[7] in (0, 3),
            'binary must be ELF64 little-endian for Linux.')
    require(machine == 62 and elf_type in (2, 3) and version == 1 and ehsize == 64,
            'binary must be an x86-64 executable or PIE.')
    require(entry != 0 and phoff >= ehsize and phentsize == 56 and 0 < phnum < 0xffff,
            'invalid ELF entry point or program-header layout.')
    require(phoff <= size and phnum * phentsize <= size - phoff,
            'truncated ELF program-header table.')

    interpreters = []
    executable_entry = False
    for index in range(phnum):
        (kind, flags, offset, vaddr, _paddr, filesz, memsz, align) = struct.unpack(
            '<IIQQQQQQ', read_at(phoff + index * phentsize, phentsize))
        require(offset <= size and filesz <= size - offset,
                'truncated ELF program segment.')
        if kind == 1:  # PT_LOAD
            require(filesz <= memsz and vaddr + memsz < 2 ** 64,
                    'invalid ELF load segment size.')
            require(align in (0, 1) or (align & (align - 1) == 0 and vaddr % align == offset % align),
                    'invalid ELF load segment alignment.')
            if flags & 1 and vaddr <= entry < vaddr + filesz:
                executable_entry = True
        elif kind == 3:  # PT_INTERP
            require(1 < filesz <= 4096, 'invalid ELF interpreter size.')
            interpreters.append(read_at(offset, filesz))
    require(executable_entry, 'ELF entry point is not in a file-backed executable segment.')
    # The selected GNU/glibc target uses this loader; a shared object, another
    # architecture's loader or a different libc target is not this release.
    require(interpreters == [b'/lib64/ld-linux-x86-64.so.2\0'],
            'binary must use the Linux x86-64 glibc loader.')

    if shoff == 0:
        require(shnum == 0 and shstrndx == 0 and shentsize in (0, 64),
                'invalid ELF section-header layout.')
    else:
        require(shoff >= ehsize and shentsize == 64 and 0 < shnum < 0xff00
                and shstrndx < shnum and shoff <= size and shnum * shentsize <= size - shoff,
                'invalid or truncated ELF section-header table.')
        for index in range(shnum):
            section = struct.unpack('<IIQQQQIIQQ', read_at(shoff + index * shentsize, shentsize))
            kind, offset, length = section[1], section[4], section[5]
            if kind != 8:  # SHT_NOBITS occupies memory, not file bytes.
                require(offset <= size and length <= size - offset,
                        'truncated ELF section data.')
print('Verified Linux x86-64 GNU/glibc executable.')
PYTHON
printf '%s\n' "$source_commit" > "$build_dir/q-release/SOURCE_COMMIT"
(
  cd "$build_dir/q-release"
  sha256sum xiaoq-backend SOURCE_COMMIT MIGRATIONS > SHA256SUMS
)
archive_name="q-release-${source_commit}.tar.gz"
# macOS cross-builds must not add AppleDouble metadata rejected by the receiver.
COPYFILE_DISABLE=1 tar -czf "$build_dir/$archive_name" -C "$build_dir" q-release
mv "$build_dir/$archive_name" "$output_dir/$archive_name"
printf 'Release package: %s/%s\nSource commit: %s\n' "$output_dir" "$archive_name" "$source_commit"
