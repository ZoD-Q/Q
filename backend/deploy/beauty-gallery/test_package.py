"""Offline tests for the gallery release format and reviewed-source build path."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("beauty_package", Path(__file__).with_name("package.py"))
assert SPEC is not None and SPEC.loader is not None
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)
COMMIT = "a" * 40


def elf_bytes() -> bytes:
    result = bytearray(512)
    ident = b"\x7fELF\x02\x01\x01" + b"\x00" * 9
    struct.pack_into("<16sHHIQQQIHHHHHH", result, 0,
                     ident, 3, 62, 1, 0x400100, 64, 0, 0, 64, 56, 2, 0, 0, 0)
    struct.pack_into("<IIQQQQQQ", result, 64, 1, 5, 0, 0x400000, 0, 512, 512, 4096)
    loader = b"/lib64/ld-linux-x86-64.so.2\0"
    struct.pack_into("<IIQQQQQQ", result, 120, 3, 4, 176, 0, 0, len(loader), len(loader), 1)
    result[176:176 + len(loader)] = loader
    return bytes(result)


def write_binary(path: Path, contents: bytes | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(elf_bytes() if contents is None else contents)
    path.chmod(0o755)
    return path


def save_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def fixture_source(backend: Path) -> Path:
    data = backend / "examples/beauty-gallery-data"
    (data / "photos").mkdir(parents=True)
    records = []
    total_bytes = 0
    for index in range(1, package.PHOTO_COUNT + 1):
        name = f"photo-{index:03}.jpg"
        contents = f"offline fixture photograph {index}".encode("ascii")
        (data / "photos" / name).write_bytes(contents)
        total_bytes += len(contents)
        records.append({
            "id": f"photo-{index:03}", "filename": f"photos/{name}",
            "sha256": hashlib.sha256(contents).hexdigest(), "bytes": len(contents),
        })
    save_json(data / "manifest.json", {"version": 1, "photos": records})
    save_json(data / "verification.json", {
        "photo_count": package.PHOTO_COUNT,
        "manifest_sha256": package.sha256(data / "manifest.json"),
        "unique_sha256_count": package.PHOTO_COUNT,
        "total_image_bytes": total_bytes,
    })
    (data / "README.md").write_text("Offline fixture attribution.\n", encoding="ascii")
    deploy = backend / "deploy/beauty-gallery"
    deploy.mkdir(parents=True)
    for name in package.DEPLOY_FILES:
        (deploy / name).write_text(f"Fixture deployment file: {name}\n", encoding="ascii")
    (backend / "Cargo.toml").write_text('name = "reviewed-fixture"\n', encoding="ascii")
    (backend / "Cargo.lock").write_text("# Fixture lock\n", encoding="ascii")
    (backend / "examples/beauty_mcp.rs").write_text("reviewed source\n", encoding="ascii")
    return data


class FixtureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)


class ElfTests(FixtureTest):
    def test_accepts_linux_amd64_pie_and_executable(self) -> None:
        for elf_type in (2, 3):
            with self.subTest(elf_type=elf_type):
                data = bytearray(elf_bytes())
                struct.pack_into("<H", data, 16, elf_type)
                package.verify_elf(write_binary(self.root / "binary", data))

    def test_rejects_foreign_format_and_architecture(self) -> None:
        for offset, value in ((0, 0), (4, 1), (5, 2), (7, 9), (18, 183), (16, 1)):
            with self.subTest(offset=offset, value=value):
                data = bytearray(elf_bytes())
                data[offset] = value
                with self.assertRaises(package.ReleaseError):
                    package.verify_elf(write_binary(self.root / "binary", data))

    def test_rejects_nonexecutable_and_symlink(self) -> None:
        binary = write_binary(self.root / "binary")
        binary.chmod(0o644)
        with self.assertRaisesRegex(package.ReleaseError, "regular executable"):
            package.verify_elf(binary)
        binary.chmod(0o755)
        link = self.root / "link"
        link.symlink_to(binary)
        with self.assertRaises(package.ReleaseError):
            package.verify_elf(link)

    def test_rejects_truncated_or_non_file_backed_entry(self) -> None:
        cases = [elf_bytes()[:63], elf_bytes()[:130]]
        for offset, value in ((24, 0), (24, 0x500000), (32, 500), (96, 700), (104, 400)):
            data = bytearray(elf_bytes())
            struct.pack_into("<Q", data, offset, value)
            cases.append(data)
        data = bytearray(elf_bytes())
        struct.pack_into("<I", data, 68, 4)  # Nonexecutable load segment.
        cases.append(data)
        for index, data in enumerate(cases):
            with self.subTest(index=index), self.assertRaises(package.ReleaseError):
                package.verify_elf(write_binary(self.root / "binary", data))

    def test_rejects_wrong_loader_and_invalid_alignment(self) -> None:
        cases = []
        data = bytearray(elf_bytes())
        data[177] = ord("x")
        cases.append(data)
        data = bytearray(elf_bytes())
        struct.pack_into("<I", data, 120, 0)  # No PT_INTERP.
        cases.append(data)
        data = bytearray(elf_bytes())
        struct.pack_into("<Q", data, 112, 3)
        cases.append(data)
        data = bytearray(elf_bytes())
        struct.pack_into("<Q", data, 40, 500)  # Truncated section table.
        struct.pack_into("<HHH", data, 58, 64, 1, 0)
        cases.append(data)
        for index, data in enumerate(cases):
            with self.subTest(index=index), self.assertRaises(package.ReleaseError):
                package.verify_elf(write_binary(self.root / "binary", data))


class GalleryTests(FixtureTest):
    def setUp(self) -> None:
        super().setUp()
        self.data = fixture_source(self.root / "backend")

    def manifest(self) -> dict:
        return json.loads((self.data / "manifest.json").read_text())

    def update_manifest(self, value: dict) -> None:
        save_json(self.data / "manifest.json", value)
        verification = json.loads((self.data / "verification.json").read_text())
        verification["manifest_sha256"] = package.sha256(self.data / "manifest.json")
        save_json(self.data / "verification.json", verification)

    def test_manifest_only_references_and_optional_hashes(self) -> None:
        (self.data / "photos/unreferenced.jpg").write_bytes(b"extra")
        manifest = self.manifest()
        manifest["photos"][0].pop("sha256")
        self.update_manifest(manifest)
        names, digest = package.validate_gallery(self.data)
        self.assertEqual(len(names), 300)
        self.assertNotIn("photos/unreferenced.jpg", names)
        self.assertEqual(digest, package.sha256(self.data / "manifest.json"))

    def test_rejects_wrong_count_version_and_duplicate_ids_or_files(self) -> None:
        original = self.manifest()
        for change in ("count", "version", "id", "filename"):
            manifest = json.loads(json.dumps(original))
            if change == "count":
                manifest["photos"].pop()
            elif change == "version":
                manifest["version"] = True
            else:
                manifest["photos"][1][change] = manifest["photos"][0][change]
            self.update_manifest(manifest)
            with self.subTest(change=change), self.assertRaises(package.ReleaseError):
                package.validate_gallery(self.data)

    def test_rejects_path_escape_and_noncanonical_names(self) -> None:
        manifest = self.manifest()
        for name in (
            "../photo.jpg", "/tmp/photo.jpg", "photos/../photo.jpg",
            "photos//photo.jpg", "photos/sub/photo.jpg", "photos\\photo.jpg",
            "photos/.", "photos/..", "photos/photo\n.jpg", "photos/" + "a" * 101,
        ):
            manifest["photos"][0]["filename"] = name
            self.update_manifest(manifest)
            with self.subTest(name=name), self.assertRaises(package.ReleaseError):
                package.validate_gallery(self.data)

    def test_rejects_symlink_file_and_parent(self) -> None:
        photo = self.data / "photos/photo-001.jpg"
        real = self.root / "real.jpg"
        photo.rename(real)
        photo.symlink_to(real)
        with self.assertRaises(package.ReleaseError):
            package.validate_gallery(self.data)
        photo.unlink()
        real.rename(photo)
        (self.data / "photos").rename(self.root / "photos")
        (self.data / "photos").symlink_to(self.root / "photos")
        with self.assertRaises(package.ReleaseError):
            package.validate_gallery(self.data)

    def test_rejects_hash_size_empty_and_oversized_photo(self) -> None:
        photo = self.data / "photos/photo-001.jpg"
        original = photo.read_bytes()
        for contents in (b"tampered", b"", b"x" * (package.MAX_PHOTO_BYTES + 1)):
            photo.write_bytes(contents)
            with self.subTest(size=len(contents)), self.assertRaises(package.ReleaseError):
                package.validate_gallery(self.data)
        photo.write_bytes(original)
        manifest = self.manifest()
        manifest["photos"][0]["bytes"] += 1
        self.update_manifest(manifest)
        with self.assertRaisesRegex(package.ReleaseError, "size mismatch"):
            package.validate_gallery(self.data)

    def test_rejects_verification_hash_count_and_totals(self) -> None:
        original = json.loads((self.data / "verification.json").read_text())
        for key, value in (
            ("manifest_sha256", "0" * 64), ("photo_count", 299),
            ("photo_count", "300"), ("total_image_bytes", 1), ("unique_sha256_count", 1),
        ):
            verification = {**original, key: value}
            save_json(self.data / "verification.json", verification)
            with self.subTest(key=key, value=value), self.assertRaises(package.ReleaseError):
                package.validate_gallery(self.data)

    def test_rejects_duplicate_json_fields(self) -> None:
        (self.data / "verification.json").write_text('{"photo_count":300,"photo_count":299}')
        with self.assertRaisesRegex(package.ReleaseError, "duplicate JSON"):
            package.validate_gallery(self.data)


class ReleaseTests(FixtureTest):
    def setUp(self) -> None:
        super().setUp()
        self.backend = self.root / "backend"
        self.data = fixture_source(self.backend)
        self.binary = write_binary(self.root / "binary")
        self.release = self.root / package.ROOT_NAME

    def build(self) -> None:
        package.build_release(self.backend, self.binary, COMMIT, self.release)

    def resign(self) -> None:
        files = package.release_inventory(self.release)
        (self.release / "SHA256SUMS").write_text(package.checksum_text(self.release, files))

    def test_exact_inventory_excludes_collector_and_unreferenced_data(self) -> None:
        for name in ("collect.py", "exclusions.json", "photos/extra.jpg"):
            (self.data / name).write_text("excluded")
        (self.data / ".cache").mkdir()
        (self.data / ".cache/secret").write_text("excluded")
        self.build()
        files = package.release_inventory(self.release)
        self.assertEqual(len(files), 313)
        self.assertNotIn("data/collect.py", files)
        self.assertNotIn("data/photos/extra.jpg", files)
        metadata = package.verify_release(self.release)
        self.assertEqual(set(metadata), package.RELEASE_KEYS)
        self.assertEqual(metadata["source_commit"], COMMIT)
        checksum_lines = (self.release / "SHA256SUMS").read_text().splitlines()
        self.assertEqual(len(checksum_lines), 312)
        self.assertEqual([line[66:] for line in checksum_lines], sorted(files - {"SHA256SUMS"}))

    def test_deployment_source_cannot_be_symlink(self) -> None:
        template = self.backend / "deploy/beauty-gallery/q-beauty.service"
        template.unlink()
        template.symlink_to(self.data / "README.md")
        with self.assertRaises(package.ReleaseError):
            self.build()

    def test_rejects_checksum_mutation(self) -> None:
        self.build()
        (self.release / "deploy/q-beauty.service").write_text("changed")
        with self.assertRaisesRegex(package.ReleaseError, "checksums"):
            package.verify_release(self.release)

    def test_rejects_extra_file_even_when_resigned(self) -> None:
        self.build()
        (self.release / "data/collect.py").write_text("unexpected")
        (self.release / "data/collect.py").chmod(0o644)
        self.resign()
        with self.assertRaisesRegex(package.ReleaseError, "allowlist"):
            package.verify_release(self.release)

    def test_rejects_link_directory_and_file_modes(self) -> None:
        self.build()
        target = self.release / "deploy/q-beauty.service"
        original = target.read_bytes()
        target.unlink()
        target.symlink_to(self.data / "README.md")
        with self.assertRaisesRegex(package.ReleaseError, "nonregular"):
            package.verify_release(self.release)
        target.unlink()
        target.write_bytes(original)
        target.chmod(0o600)
        with self.assertRaisesRegex(package.ReleaseError, "mode"):
            package.verify_release(self.release)
        target.chmod(0o644)
        (self.release / "unknown").mkdir()
        with self.assertRaisesRegex(package.ReleaseError, "unexpected release directory"):
            package.verify_release(self.release)

    def test_rejects_metadata_mismatch_even_when_resigned(self) -> None:
        self.build()
        path = self.release / "RELEASE.json"
        original = json.loads(path.read_text())
        for change in (
            {"source_commit": "b" * 40}, {"target": "aarch64-unknown-linux-gnu"},
            {"public_base": "https://example.test/"}, {"photo_count": "300"},
            {"manifest_sha256": "0" * 64}, {"extra": "unrecognized"},
        ):
            save_json(path, {**original, **change})
            self.resign()
            with self.subTest(change=change), self.assertRaises(package.ReleaseError):
                package.verify_release(self.release)

    def test_archives_are_deterministic_and_only_regular_files_or_directories(self) -> None:
        self.build()
        first, second = self.root / "one.tar.gz", self.root / "two.tar.gz"
        package.write_archive(self.release, first)
        for path in self.release.rglob("*"):
            os.utime(path, (123456789, 987654321))
        package.write_archive(self.release, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(first.read_bytes()[4:8], b"\0" * 4)  # No gzip timestamp.
        with tarfile.open(first) as tar:
            members = tar.getmembers()
            self.assertEqual(len(members), 318)
            self.assertEqual(members[0].name, package.ROOT_NAME)
            for member in members:
                self.assertTrue(member.isfile() or member.isdir())
                self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 0))
                self.assertEqual((member.uname, member.gname), ("", ""))
                self.assertFalse(member.pax_headers)
                self.assertTrue(member.name == package.ROOT_NAME
                                or member.name.startswith(package.ROOT_NAME + "/"))

    def test_existing_different_output_is_not_replaced(self) -> None:
        archive, output = self.root / "archive", self.root / "output"
        archive.write_bytes(b"new")
        output.write_bytes(b"existing")
        with self.assertRaisesRegex(package.ReleaseError, "different package"):
            package.publish_archive(archive, output)
        self.assertEqual(output.read_bytes(), b"existing")
        output.write_bytes(b"new")
        package.publish_archive(archive, output)
        output.unlink()
        output.symlink_to(archive)
        with self.assertRaisesRegex(package.ReleaseError, "not a regular"):
            package.publish_archive(archive, output)


class SourceArchiveTests(FixtureTest):
    def archive(self, entries: list[tuple[str, bytes]]) -> Path:
        path = self.root / "source.tar"
        with tarfile.open(path, "w") as tar:
            for name, kind in entries:
                info = tarfile.TarInfo(name)
                info.type = kind
                info.size = 1 if kind == tarfile.REGTYPE else 0
                info.linkname = "/tmp/outside" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
                tar.addfile(info, io.BytesIO(b"x") if info.size else None)
        return path

    def test_valid_regular_source_is_extracted(self) -> None:
        archive = self.archive([("backend", tarfile.DIRTYPE), ("backend/Cargo.toml", tarfile.REGTYPE)])
        package.extract_source(archive, self.root / "source")
        self.assertEqual((self.root / "source/backend/Cargo.toml").read_bytes(), b"x")

    def test_unsafe_names_links_special_and_duplicates_are_rejected(self) -> None:
        cases = [
            [(name, tarfile.REGTYPE)] for name in (
                "../escape", "/tmp/escape", "backend/../escape", "backend//file",
                "backend/./file", "elsewhere/file", "backend\\file", "backend/file\n",
            )
        ]
        cases += [[("backend/link", kind)] for kind in (
            tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE,
        )]
        cases.append([("backend/file", tarfile.REGTYPE), ("backend/file", tarfile.REGTYPE)])
        for index, entries in enumerate(cases):
            archive = self.archive([("backend", tarfile.DIRTYPE)] + entries)
            with self.subTest(entries=entries), self.assertRaises(package.ReleaseError):
                package.extract_source(archive, self.root / f"source-{index}")


@unittest.skipUnless(shutil.which("git"), "git is required for local provenance fixtures")
class RepositoryTests(FixtureTest):
    """Use a local bare Git remote and a noncompiling Cargo fixture: no network."""

    def git(self, *arguments: str, cwd: Path | None = None) -> str:
        result = subprocess.run(
            ["git", *arguments], cwd=cwd, check=True,
            env=package.git_environment(), capture_output=True, text=True,
        )
        return result.stdout.strip()

    def setUp(self) -> None:
        super().setUp()
        self.seed, self.remote, self.repo = (self.root / name for name in ("seed", "remote.git", "repo"))
        self.git("init", "--initial-branch=main", str(self.seed))
        self.git("config", "user.name", "Offline Fixture", cwd=self.seed)
        self.git("config", "user.email", "fixture@example.invalid", cwd=self.seed)
        fixture_source(self.seed / "backend")
        self.git("add", "backend", cwd=self.seed)
        self.git("commit", "-m", "reviewed fixture", cwd=self.seed)
        self.commit = self.git("rev-parse", "HEAD", cwd=self.seed)
        self.git("clone", "--bare", str(self.seed), str(self.remote))
        self.git("clone", str(self.remote), str(self.repo))
        self.git("config", "user.name", "Offline Fixture", cwd=self.repo)
        self.git("config", "user.email", "fixture@example.invalid", cwd=self.repo)
        self.tool_bin = self.root / "tools"
        self.tool_bin.mkdir()
        self.build_log = self.root / "build.json"
        cargo = self.tool_bin / "cargo"
        cargo.write_text(
            f"#!{sys.executable}\n"
            "import json, os, pathlib, sys\n"
            "target = pathlib.Path(os.environ['CARGO_TARGET_DIR'])\n"
            f"binary = target / {package.TARGET!r} / 'release/examples/beauty_mcp'\n"
            "binary.parent.mkdir(parents=True)\n"
            f"binary.write_bytes(bytes.fromhex({elf_bytes().hex()!r}))\n"
            "binary.chmod(0o755)\n"
            "log = {'arguments': sys.argv[1:],\n"
            "       'commit': os.environ['BEAUTY_MCP_BUILD_COMMIT'],\n"
            "       'source': pathlib.Path('examples/beauty_mcp.rs').read_text(),\n"
            "       'target_dir': str(target),\n"
            "       'rustflags': os.environ['CARGO_ENCODED_RUSTFLAGS']}\n"
            f"pathlib.Path({str(self.build_log)!r}).write_text(json.dumps(log))\n",
            encoding="utf-8",
        )
        cargo.chmod(0o755)

    def test_build_uses_exact_reviewed_archive_despite_dirty_checkout(self) -> None:
        (self.repo / "backend/examples/beauty_mcp.rs").write_text("uncommitted source")
        (self.repo / "backend/examples/beauty-gallery-data/photos/photo-001.jpg").write_text("dirty")
        output = package.package_repository(self.repo, tool_bin=self.tool_bin)
        self.assertEqual(output.name, f"q-beauty-{self.commit}.tar.gz")
        log = json.loads(self.build_log.read_text())
        self.assertEqual(log["commit"], self.commit)
        self.assertEqual(log["source"], "reviewed source\n")
        self.assertEqual(log["arguments"][0], "zigbuild")
        self.assertEqual(log["arguments"][-6:], [
            "--locked", "--release", "--target", package.BUILD_TARGET, "--example", "beauty_mcp",
        ])
        with tarfile.open(output) as tar:
            source = tar.extractfile(f"{package.ROOT_NAME}/SOURCE_COMMIT")
            assert source is not None
            self.assertEqual(source.read(), (self.commit + "\n").encode("ascii"))
        self.assertFalse(list(output.parent.glob(".q-beauty-build-*")))
        self.assertEqual((self.repo / "backend/examples/beauty_mcp.rs").read_text(), "uncommitted source")

    def test_unreviewed_commit_fails_before_cargo(self) -> None:
        (self.repo / "backend/examples/beauty_mcp.rs").write_text("unreviewed")
        self.git("add", "backend", cwd=self.repo)
        self.git("commit", "-m", "not on remote main", cwd=self.repo)
        with self.assertRaisesRegex(package.ReleaseError, "origin/main"):
            package.package_repository(self.repo, reference="HEAD", tool_bin=self.tool_bin)
        self.assertFalse(self.build_log.exists())

    def test_failed_fetch_does_not_use_stale_origin_main(self) -> None:
        self.git("remote", "set-url", "origin", str(self.root / "missing.git"), cwd=self.repo)
        with self.assertRaises(subprocess.CalledProcessError):
            package.package_repository(self.repo, tool_bin=self.tool_bin)
        self.assertFalse(self.build_log.exists())

    def test_fresh_fetch_selects_new_main_and_allows_reviewed_ancestor(self) -> None:
        (self.seed / "backend/examples/beauty_mcp.rs").write_text("new reviewed source\n")
        self.git("add", "backend", cwd=self.seed)
        self.git("commit", "-m", "new main", cwd=self.seed)
        new_commit = self.git("rev-parse", "HEAD", cwd=self.seed)
        self.git("push", str(self.remote), "main", cwd=self.seed)
        # A locally created tag with this ambiguous short name cannot shadow
        # the default's fully qualified, freshly fetched remote branch.
        self.git("tag", "origin/main", self.commit, cwd=self.repo)
        package.package_repository(self.repo, tool_bin=self.tool_bin)
        self.assertEqual(json.loads(self.build_log.read_text())["commit"], new_commit)
        self.assertEqual(json.loads(self.build_log.read_text())["source"], "new reviewed source\n")
        package.package_repository(self.repo, reference=self.commit, tool_bin=self.tool_bin)
        self.assertEqual(json.loads(self.build_log.read_text())["source"], "reviewed source\n")

    def test_git_replacements_cannot_substitute_reviewed_source(self) -> None:
        (self.repo / "backend/examples/beauty_mcp.rs").write_text("replacement source\n")
        self.git("add", "backend", cwd=self.repo)
        self.git("commit", "-m", "unreviewed replacement", cwd=self.repo)
        replacement = self.git("rev-parse", "HEAD", cwd=self.repo)
        self.git("replace", self.commit, replacement, cwd=self.repo)
        package.package_repository(self.repo, reference=self.commit, tool_bin=self.tool_bin)
        self.assertEqual(json.loads(self.build_log.read_text())["source"], "reviewed source\n")

    def test_reviewed_symlink_is_rejected_before_cargo(self) -> None:
        (self.seed / "backend/link").symlink_to("/tmp/outside")
        self.git("add", "backend/link", cwd=self.seed)
        self.git("commit", "-m", "source link fixture", cwd=self.seed)
        self.git("push", str(self.remote), "main", cwd=self.seed)
        with self.assertRaisesRegex(package.ReleaseError, "links"):
            package.package_repository(self.repo, tool_bin=self.tool_bin)
        self.assertFalse(self.build_log.exists())

    def test_ref_option_is_not_interpreted_as_a_git_flag(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError):
            package.package_repository(self.repo, reference="--help", tool_bin=self.tool_bin)
        self.assertFalse(self.build_log.exists())


class CommandTests(unittest.TestCase):
    def test_cli_has_no_unreviewed_bypass(self) -> None:
        with mock.patch.object(package, "package_repository") as build:
            with self.assertRaises(SystemExit) as error:
                package.main(["--allow-unreviewed"])
            self.assertEqual(error.exception.code, 2)
            build.assert_not_called()


if __name__ == "__main__":
    unittest.main()
