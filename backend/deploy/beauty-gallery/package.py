#!/usr/bin/env python3
"""Build the standalone gallery from one freshly verified origin/main commit.

This command packages only; it never installs, deploys, or changes the checkout.
The standard-library validators are also usable by offline release tests.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile


ROOT_NAME = "q-beauty-release"
TARGET = "x86_64-unknown-linux-gnu"
BUILD_TARGET = f"{TARGET}.2.36"
PUBLIC_BASE = "https://q.kaicloudpay.com/plugins/beauty/"
PHOTO_COUNT = 300
MAX_PHOTO_BYTES = 768 * 1024
DEPLOY_FILES = (
    "q-beauty.service",
    "q-beauty-health.service",
    "q-beauty-health.timer",
    "health-check.py",
    "nginx-location.conf",
    "journald@q-beauty.conf",
)
DATA_FILES = ("manifest.json", "README.md", "verification.json")
RELEASE_KEYS = {
    "schema_version", "source_commit", "target", "public_base",
    "photo_count", "manifest_sha256",
}
RELEASE_DIRS = {"bin", "data", "data/photos", "deploy"}
EXECUTABLE_FILES = {"bin/beauty_mcp", "deploy/health-check.py"}
SHA256_RE = re.compile(r"[0-9a-f]{64}")
COMMIT_RE = re.compile(r"[0-9a-f]{40}")
PHOTO_PATH_RE = re.compile(r"photos/[A-Za-z0-9][A-Za-z0-9._-]{0,99}")


class ReleaseError(ValueError):
    """A release failed an integrity or provenance requirement."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReleaseError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def regular_file(root: Path, relative: str) -> Path:
    """Resolve a canonical relative path without traversing any symlink."""
    parts = PurePosixPath(relative).parts
    require(
        bool(parts) and relative == "/".join(parts)
        and all(part not in ("", ".", "..") for part in parts)
        and not relative.startswith("/") and "\\" not in relative,
        "noncanonical relative file path",
    )
    current = root
    require(stat.S_ISDIR(current.lstat().st_mode), "source root is not a real directory")
    for part in parts[:-1]:
        current /= part
        require(stat.S_ISDIR(current.lstat().st_mode), "file parent is not a real directory")
    path = current / parts[-1]
    require(stat.S_ISREG(path.lstat().st_mode), f"not a regular file: {relative}")
    return path


def _json_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _json_constant(value: str) -> None:
    raise ReleaseError(f"non-finite JSON value: {value}")


def read_json(path: Path, limit: int = 4 * 1024 * 1024) -> dict:
    require(path.stat().st_size <= limit, f"JSON exceeds size budget: {path.name}")
    value = json.loads(
        path.read_text(encoding="utf-8"),
        object_pairs_hook=_json_object,
        parse_constant=_json_constant,
    )
    require(isinstance(value, dict), f"JSON object required: {path.name}")
    return value


def validate_gallery(directory: Path) -> tuple[list[str], str]:
    """Validate exact manifest references; do not decode or re-review photographs."""
    manifest_path = regular_file(directory, "manifest.json")
    manifest = read_json(manifest_path)
    require(type(manifest.get("version")) is int and manifest["version"] == 1,
            "unsupported gallery manifest version")
    photos = manifest.get("photos")
    require(isinstance(photos, list) and len(photos) == PHOTO_COUNT,
            "gallery must contain exactly 300 photos")
    filenames: set[str] = set()
    identifiers: set[str] = set()
    digests: set[str] = set()
    total_bytes = 0
    for photo in photos:
        require(isinstance(photo, dict), "photo record must be an object")
        filename = photo.get("filename")
        require(isinstance(filename, str) and PHOTO_PATH_RE.fullmatch(filename) is not None,
                "photo filename must be a safe, single basename inside photos/")
        require(filename not in filenames, "duplicate photo filename")
        photo_id = photo.get("id")
        require(isinstance(photo_id, str) and 0 < len(photo_id) <= 100
                and photo_id not in identifiers, "missing or duplicate photo identifier")
        path = regular_file(directory, filename)
        size = path.stat().st_size
        require(0 < size <= MAX_PHOTO_BYTES, "photo exceeds 768 KiB or is empty")
        digest = sha256(path)
        if "sha256" in photo:
            require(isinstance(photo["sha256"], str)
                    and SHA256_RE.fullmatch(photo["sha256"]) is not None
                    and photo["sha256"] == digest, f"photo hash mismatch: {filename}")
        if "bytes" in photo:
            require(type(photo["bytes"]) is int and photo["bytes"] == size,
                    f"photo size mismatch: {filename}")
        filenames.add(filename)
        identifiers.add(photo_id)
        digests.add(digest)
        total_bytes += size
    manifest_digest = sha256(manifest_path)
    verification = read_json(regular_file(directory, "verification.json"))
    require(type(verification.get("photo_count")) is int
            and verification["photo_count"] == PHOTO_COUNT,
            "verification photo count mismatch")
    require(verification.get("manifest_sha256") == manifest_digest,
            "verification manifest hash mismatch")
    for key, actual in (("total_image_bytes", total_bytes), ("unique_sha256_count", len(digests))):
        if key in verification:
            require(type(verification[key]) is int and verification[key] == actual,
                    f"verification {key} mismatch")
    regular_file(directory, "README.md")
    return sorted(filenames), manifest_digest


def verify_elf(path: Path) -> None:
    """Validate Linux amd64 GNU/glibc program bytes without executing them."""
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and bool(info.st_mode & 0o111),
            "binary must be a regular executable file")
    size = info.st_size
    with path.open("rb") as binary:
        def read_at(offset: int, length: int) -> bytes:
            require(0 <= offset <= size and 0 <= length <= size - offset,
                    "truncated ELF structure or segment")
            binary.seek(offset)
            data = binary.read(length)
            require(len(data) == length, "truncated ELF data")
            return data

        header = struct.unpack("<16sHHIQQQIHHHHHH", read_at(0, 64))
        (ident, elf_type, machine, version, entry, phoff, shoff, _flags,
         ehsize, phentsize, phnum, shentsize, shnum, shstrndx) = header
        require(ident[:7] == b"\x7fELF\x02\x01\x01" and ident[7] in (0, 3),
                "binary must be ELF64 little-endian for Linux")
        require(machine == 62 and elf_type in (2, 3) and version == 1 and ehsize == 64,
                "binary must be an x86-64 executable or PIE")
        require(entry != 0 and phoff >= ehsize and phentsize == 56 and 0 < phnum < 0xffff,
                "invalid ELF entry point or program-header layout")
        require(phoff <= size and phnum * phentsize <= size - phoff,
                "truncated ELF program-header table")
        interpreters = []
        executable_entry = False
        for index in range(phnum):
            (kind, flags, offset, vaddr, _paddr, filesz, memsz, align) = struct.unpack(
                "<IIQQQQQQ", read_at(phoff + index * phentsize, phentsize))
            require(offset <= size and filesz <= size - offset,
                    "truncated ELF program segment")
            if kind == 1:  # PT_LOAD
                require(filesz <= memsz and vaddr + memsz < 2 ** 64,
                        "invalid ELF load segment size")
                require(align in (0, 1) or (
                    align & (align - 1) == 0 and vaddr % align == offset % align),
                    "invalid ELF load segment alignment")
                if flags & 1 and vaddr <= entry < vaddr + filesz:
                    executable_entry = True
            elif kind == 3:  # PT_INTERP
                require(1 < filesz <= 4096, "invalid ELF interpreter size")
                interpreters.append(read_at(offset, filesz))
        require(executable_entry, "ELF entry point is not in a file-backed executable segment")
        require(interpreters == [b"/lib64/ld-linux-x86-64.so.2\0"],
                "binary must use the Linux x86-64 glibc loader")
        if shoff == 0:
            require(shnum == 0 and shstrndx == 0 and shentsize in (0, 64),
                    "invalid ELF section-header layout")
        else:
            require(shoff >= ehsize and shentsize == 64 and 0 < shnum < 0xff00
                    and shstrndx < shnum and shoff <= size
                    and shnum * shentsize <= size - shoff,
                    "invalid or truncated ELF section-header table")
            for index in range(shnum):
                section = struct.unpack(
                    "<IIQQQQIIQQ", read_at(shoff + index * shentsize, shentsize))
                kind, offset, length = section[1], section[4], section[5]
                if kind != 8:  # SHT_NOBITS occupies memory, not file bytes.
                    require(offset <= size and length <= size - offset,
                            "truncated ELF section data")


def release_inventory(directory: Path) -> set[str]:
    """Reject links, special entries, unknown directories and noncanonical modes."""
    require(stat.S_ISDIR(directory.lstat().st_mode), "release root is not a real directory")
    require(stat.S_IMODE(directory.stat().st_mode) == 0o755, "invalid release root mode")
    files: set[str] = set()
    dirs: set[str] = set()
    for parent, children, leaves in os.walk(directory, followlinks=False):
        for name in children + leaves:
            path = Path(parent) / name
            relative = path.relative_to(directory).as_posix()
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode):
                require(relative in RELEASE_DIRS, f"unexpected release directory: {relative}")
                require(stat.S_IMODE(mode) == 0o755, "invalid release directory mode")
                dirs.add(relative)
            else:
                require(stat.S_ISREG(mode), f"nonregular release entry: {relative}")
                expected_mode = 0o755 if relative in EXECUTABLE_FILES else 0o644
                require(stat.S_IMODE(mode) == expected_mode, f"invalid file mode: {relative}")
                files.add(relative)
    require(dirs == RELEASE_DIRS, "missing release directory")
    return files


def checksum_text(directory: Path, files: set[str]) -> str:
    return "".join(
        f"{sha256(regular_file(directory, name))}  {name}\n"
        for name in sorted(files - {"SHA256SUMS"})
    )


def verify_release(directory: Path) -> dict:
    files = release_inventory(directory)
    photos, manifest_digest = validate_gallery(directory / "data")
    expected = {
        "SOURCE_COMMIT", "RELEASE.json", "SHA256SUMS", "bin/beauty_mcp",
        *(f"data/{name}" for name in (*DATA_FILES, *photos)),
        *(f"deploy/{name}" for name in DEPLOY_FILES),
    }
    require(files == expected, "release inventory differs from the exact allowlist")
    source = regular_file(directory, "SOURCE_COMMIT").read_text(encoding="ascii")
    require(re.fullmatch(r"[0-9a-f]{40}\n", source) is not None, "invalid SOURCE_COMMIT")
    metadata = read_json(regular_file(directory, "RELEASE.json"), 16 * 1024)
    require(set(metadata) == RELEASE_KEYS, "unexpected release metadata keys")
    require(type(metadata.get("schema_version")) is int and metadata["schema_version"] == 1
            and metadata.get("source_commit") == source.strip()
            and metadata.get("target") == TARGET and metadata.get("public_base") == PUBLIC_BASE
            and type(metadata.get("photo_count")) is int
            and metadata["photo_count"] == PHOTO_COUNT
            and metadata.get("manifest_sha256") == manifest_digest,
            "release metadata mismatch")
    require(regular_file(directory, "SHA256SUMS").read_text(encoding="ascii")
            == checksum_text(directory, files), "release checksums mismatch")
    verify_elf(directory / "bin/beauty_mcp")
    return metadata


def build_release(backend: Path, binary: Path, commit: str, destination: Path) -> None:
    """Stage a release from an already-extracted immutable backend archive."""
    require(COMMIT_RE.fullmatch(commit) is not None, "invalid source commit")
    require(not destination.exists() and not destination.is_symlink(),
            "release staging destination already exists")
    verify_elf(binary)
    data = backend / "examples/beauty-gallery-data"
    photos, manifest_digest = validate_gallery(data)
    destination.mkdir(mode=0o755)
    destination.chmod(0o755)
    for name in sorted(RELEASE_DIRS):
        path = destination / name
        path.mkdir(mode=0o755)
        path.chmod(0o755)
    sources = {
        "bin/beauty_mcp": binary,
        **{f"data/{name}": regular_file(data, name) for name in (*DATA_FILES, *photos)},
        **{
            f"deploy/{name}": regular_file(backend / "deploy/beauty-gallery", name)
            for name in DEPLOY_FILES
        },
    }
    for name, source in sorted(sources.items()):
        shutil.copyfile(source, destination / name)
        (destination / name).chmod(0o755 if name in EXECUTABLE_FILES else 0o644)
    metadata = {
        "schema_version": 1, "source_commit": commit, "target": TARGET,
        "public_base": PUBLIC_BASE, "photo_count": PHOTO_COUNT,
        "manifest_sha256": manifest_digest,
    }
    (destination / "SOURCE_COMMIT").write_text(commit + "\n", encoding="ascii")
    (destination / "RELEASE.json").write_text(
        json.dumps(metadata, sort_keys=True, indent=2) + "\n", encoding="ascii")
    for name in ("SOURCE_COMMIT", "RELEASE.json"):
        (destination / name).chmod(0o644)
    files = set(sources) | {"SOURCE_COMMIT", "RELEASE.json"}
    (destination / "SHA256SUMS").write_text(checksum_text(destination, files), encoding="ascii")
    (destination / "SHA256SUMS").chmod(0o644)
    verify_release(destination)


def write_archive(directory: Path, output: Path) -> None:
    """Write reproducible gzip/USTAR bytes; metadata never depends on the host."""
    verify_release(directory)
    names = [""] + sorted(RELEASE_DIRS | release_inventory(directory))
    with output.open("xb") as archive:
        with gzip.GzipFile(filename="", mode="wb", fileobj=archive, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                for name in names:
                    path = directory / name
                    info = tarfile.TarInfo(ROOT_NAME + (f"/{name}" if name else ""))
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    info.mtime = 0
                    if path.is_dir():
                        info.type = tarfile.DIRTYPE
                        info.mode = 0o755
                        tar.addfile(info)
                    else:
                        info.mode = 0o755 if name in EXECUTABLE_FILES else 0o644
                        info.size = path.stat().st_size
                        with path.open("rb") as source:
                            tar.addfile(info, source)


def extract_source(archive: Path, destination: Path) -> None:
    """Extract only canonical backend paths, never using tar's link handling."""
    require(not destination.exists() and not destination.is_symlink(),
            "source extraction destination already exists")
    destination.mkdir(mode=0o700)
    seen: set[str] = set()
    with tarfile.open(archive, mode="r:") as tar:
        for member in tar:
            name = member.name
            parts = PurePosixPath(name).parts
            require(bool(parts) and parts[0] == "backend"
                    and name == "/".join(parts)
                    and all(part not in ("", ".", "..") for part in parts)
                    and "\\" not in name and "\x00" not in name
                    and all(ord(char) >= 32 and ord(char) != 127 for char in name),
                    "unsafe path in source archive")
            require(name not in seen, "duplicate source archive entry")
            require(member.isdir() or member.isfile(), "links and special source entries are forbidden")
            seen.add(name)
            path = destination.joinpath(*parts)
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if member.isdir():
                path.mkdir(mode=0o700, exist_ok=True)
            else:
                source = tar.extractfile(member)
                require(source is not None, "source archive member has no bytes")
                with source, path.open("xb") as target:
                    shutil.copyfileobj(source, target)
                path.chmod(0o755 if member.mode & 0o111 else 0o644)
    require("backend" in seen, "source archive is missing backend/")


def git_environment() -> dict[str, str]:
    environment = os.environ.copy()
    # Replacement objects and inherited alternate repository locations must not
    # change what a reviewed commit's object ID refers to.
    for name in (
        "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_REPLACE_REF_BASE",
    ):
        environment.pop(name, None)
    environment["GIT_NO_REPLACE_OBJECTS"] = "1"
    return environment


def reviewed_commit(repo: Path, reference: str) -> str:
    environment = git_environment()
    base = ["git", "-C", str(repo)]
    subprocess.run(base + [
        "fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main",
    ], env=environment, check=True)
    result = subprocess.run(base + [
        "rev-parse", "--verify", "--end-of-options", reference + "^{commit}",
    ], env=environment, check=True, capture_output=True, text=True)
    commit = result.stdout.strip()
    require(COMMIT_RE.fullmatch(commit) is not None, "git returned an invalid commit")
    result = subprocess.run(base + [
        "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main",
    ], env=environment, check=False)
    require(result.returncode == 0, "requested commit is not in freshly fetched origin/main history")
    return commit


def publish_archive(archive: Path, output: Path) -> None:
    """Use an exclusive filesystem link: never replace an existing package."""
    try:
        os.link(archive, output)
    except FileExistsError:
        require(stat.S_ISREG(output.lstat().st_mode), "output exists and is not a regular file")
        require(sha256(archive) == sha256(output), "output exists with different package bytes")


def package_repository(
    repo: Path, reference: str = "refs/remotes/origin/main", tool_bin: Path | None = None,
    output: Path | None = None,
) -> Path:
    commit = reviewed_commit(repo, reference)
    if output is None:
        output = repo / "backend/.local/beauty-release" / f"q-beauty-{commit}.tar.gz"
    output = output.absolute()
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".q-beauty-build-", dir=output.parent) as temporary:
        work = Path(temporary)
        source_archive = work / "source.tar"
        subprocess.run([
            "git", "-C", str(repo), "archive", "--format=tar",
            f"--output={source_archive}", commit, "backend",
        ], env=git_environment(), check=True)
        source = work / "source"
        extract_source(source_archive, source)
        environment = os.environ.copy()
        paths = [str(Path.home() / ".cargo/bin"), environment.get("PATH", os.defpath)]
        if tool_bin is not None:
            tool_bin = tool_bin.expanduser().resolve(strict=True)
            require(tool_bin.is_dir(), "--tool-bin must name a directory")
            paths.insert(0, str(tool_bin))
        environment["PATH"] = os.pathsep.join(paths)
        environment["CARGO_TARGET_DIR"] = str(work / "target")
        environment["BEAUTY_MCP_BUILD_COMMIT"] = commit
        # Private build-directory names must not enter the resulting binary.
        environment.pop("RUSTFLAGS", None)
        environment["CARGO_ENCODED_RUSTFLAGS"] = f"--remap-path-prefix={work}=/q-beauty-build"
        subprocess.run([
            "cargo", "zigbuild", "--manifest-path", str(source / "backend/Cargo.toml"),
            "--locked", "--release", "--target", BUILD_TARGET, "--example", "beauty_mcp",
        ], cwd=source / "backend", env=environment, check=True)
        binary = work / "target" / TARGET / "release/examples/beauty_mcp"
        release = work / ROOT_NAME
        build_release(source / "backend", binary, commit, release)
        archive = work / "release.tar.gz"
        write_archive(release, archive)
        publish_archive(archive, output)
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="refs/remotes/origin/main",
                        help="commit or ref already included in freshly fetched origin/main")
    parser.add_argument("--tool-bin", type=Path, help="directory with cargo-zigbuild and Zig tools")
    parser.add_argument("--output", type=Path, help="archive path (existing different bytes are refused)")
    args = parser.parse_args(argv)
    try:
        output = package_repository(
            Path(__file__).resolve().parents[3], args.ref, args.tool_bin, args.output)
    except (
        ReleaseError, OSError, json.JSONDecodeError, UnicodeError,
        tarfile.TarError, subprocess.CalledProcessError,
    ) as error:
        print(f"Release refused: {error}", file=sys.stderr)
        return 1
    print(f"Release package: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
