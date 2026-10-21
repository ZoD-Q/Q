import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("beauty_install", HERE / "install.py")
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)
SHA = "a" * 40
ORIGINAL = (
    "geo $realip_remote_addr $q_internal_http_peer {\n default 0;\n 127.0.0.1 1;\n}\n"
    "server {\n listen 80;\n server_name q.kaicloudpay.com;\n"
    " location / {\n  " + INSTALL.PEER_GUARD + "\n  proxy_pass http://127.0.0.1:18787;\n }\n}\n"
    "server {\n listen 443 ssl;\n server_name q.kaicloudpay.com;\n"
    " ssl_certificate /public/certificate.pem;\n"
    " location / { proxy_pass http://127.0.0.1:18787; }\n}\n"
)


def files_fixture(commit=SHA):
    photos = []
    files = {}
    for number in range(300):
        filename = f"photos/photo-{number}.jpg"
        data = f"photo {number}".encode()
        files["data/" + filename] = data
        photos.append({
            "id": f"photo-{number}", "filename": filename, "sha256": INSTALL.sha256(data),
            "bytes": len(data), "source_url": "https://example.org/source",
            "license_url": "https://example.org/license", "license": "CC0 1.0",
            "author": "Author", "adult_basis": "Documented adult",
        })
    files["data/manifest.json"] = json.dumps({"version": 1, "photos": photos}).encode()
    manifest_hash = INSTALL.sha256(files["data/manifest.json"])
    files["data/README.md"] = b"Attribution accompanying the gallery\n"
    files["data/verification.json"] = json.dumps({
        "photo_count": 300, "manifest_sha256": manifest_hash,
    }).encode()
    files["SOURCE_COMMIT"] = (commit + "\n").encode()
    files["RELEASE.json"] = json.dumps({
        "schema_version": 1, "source_commit": commit, "target": "x86_64-unknown-linux-gnu",
        "public_base": INSTALL.BASE, "photo_count": 300, "manifest_sha256": manifest_hash,
    }).encode()
    header = bytearray(64)
    header[:7] = b"\x7fELF\x02\x01\x01"
    header[16:18] = (3).to_bytes(2, "little")
    header[18:20] = (62).to_bytes(2, "little")
    files["bin/beauty_mcp"] = bytes(header)
    for name in INSTALL.DEPLOY_FILES:
        files["deploy/" + name] = (HERE / name).read_bytes()
    refresh_checksums(files)
    return files


def refresh_checksums(files):
    files["SHA256SUMS"] = "".join(
        f"{INSTALL.sha256(data)}  {name}\n" for name, data in sorted(files.items())
        if name != "SHA256SUMS"
    ).encode()


def write_archive(path, files, additional=None):
    with tarfile.open(path, "w:gz") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo("q-beauty-release/" + name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        if additional is not None:
            archive.addfile(additional, io.BytesIO(b"x") if additional.isfile() else None)
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ArchiveTests(unittest.TestCase):
    def test_accepts_exact_checksums_and_expected_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "release.tgz"
            files = files_fixture()
            digest = write_archive(path, files)
            self.assertEqual(INSTALL.verify_archive(path, SHA, digest), files)
            with self.assertRaisesRegex(ValueError, "Source commit"):
                INSTALL.verify_archive(path, "b" * 40, digest)
            with self.assertRaisesRegex(ValueError, "Archive checksum"):
                INSTALL.verify_archive(path, SHA, "0" * 64)

    def test_rejects_traversal_symlinks_duplicates_and_extra_files(self):
        for name, kind in [
            ("q-beauty-release/../../escape", tarfile.REGTYPE),
            ("q-beauty-release/data/photos/linked.jpg", tarfile.SYMTYPE),
            ("q-beauty-release/SOURCE_COMMIT", tarfile.REGTYPE),
            ("q-beauty-release/unknown.txt", tarfile.REGTYPE),
        ]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.size = 1 if kind == tarfile.REGTYPE else 0
                member.linkname = "/etc/q/deploy.env" if kind == tarfile.SYMTYPE else ""
                path = Path(temporary) / "release.tgz"
                digest = write_archive(path, files_fixture(), member)
                with self.assertRaises(ValueError):
                    INSTALL.verify_archive(path, SHA, digest)

    def test_rejects_corrupted_image_even_when_archive_checksum_is_updated(self):
        with tempfile.TemporaryDirectory() as temporary:
            files = files_fixture()
            files["data/photos/photo-0.jpg"] = b"corrupt"
            refresh_checksums(files)
            path = Path(temporary) / "release.tgz"
            digest = write_archive(path, files)
            with self.assertRaisesRegex(ValueError, "Photo checksum"):
                INSTALL.verify_archive(path, SHA, digest)

    def test_rejects_wrong_release_base_and_binary_architecture(self):
        for name, data, message in [
            ("RELEASE.json", b"{}", "Release metadata"),
            ("bin/beauty_mcp", b"not a Linux executable", "Linux x86-64"),
        ]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                files = files_fixture()
                files[name] = data
                refresh_checksums(files)
                path = Path(temporary) / "release.tgz"
                digest = write_archive(path, files)
                with self.assertRaisesRegex(ValueError, message):
                    INSTALL.verify_archive(path, SHA, digest)


class NginxTests(unittest.TestCase):
    def test_prefix_change_is_idempotent_and_preserves_api_and_http_guard(self):
        template = (HERE / "nginx-location.conf").read_text()
        result = INSTALL.render_nginx(ORIGINAL, template)
        self.assertEqual(INSTALL.render_nginx(result, template), result)
        self.assertEqual(result.count("proxy_pass http://127.0.0.1:18787;"), 2)
        self.assertEqual(result.count("proxy_pass http://127.0.0.1:18796/;"), 2)
        self.assertEqual(result.count(INSTALL.PEER_GUARD), 3)
        self.assertEqual(result.count("limit_req_zone"), 1)
        self.assertIn("ssl_certificate /public/certificate.pem;", result)
        self.assertEqual(result.count("server_name q.kaicloudpay.com;"), 2)
        self.assertNotIn("__HTTP_PEER_GUARD__", result)

    def test_refuses_unmanaged_route_other_domain_and_missing_peer_guard(self):
        template = (HERE / "nginx-location.conf").read_text()
        for original in [
            ORIGINAL.replace("location / {", "location /plugins/beauty {", 1),
            ORIGINAL.replace("q.kaicloudpay.com;", "other.example;", 1),
            ORIGINAL.replace(INSTALL.PEER_GUARD, ""),
            ORIGINAL + "# BEGIN Q BEAUTY GALLERY\n",
        ]:
            with self.subTest(original=original), self.assertRaises(ValueError):
                INSTALL.render_nginx(original, template)

    def test_parser_ignores_braces_in_comments_and_quoted_strings(self):
        text = ORIGINAL.replace(
            "ssl_certificate", '# A misleading { comment }\n add_header X-Test "}";\n ssl_certificate'
        )
        self.assertEqual(len(INSTALL.nginx_servers(text)), 2)
        self.assertIn('add_header X-Test "}";', INSTALL.render_nginx(
            text, (HERE / "nginx-location.conf").read_text()
        ))


@contextlib.contextmanager
def installation_fixture(*, real_health=False):
    with tempfile.TemporaryDirectory() as temporary, contextlib.ExitStack() as stack:
        root = Path(temporary).resolve()
        managed = {
            name: root / "etc" / name for name in INSTALL.MANAGED_FILES
        }
        managed["q-api-domain.conf"].parent.mkdir()
        managed["q-api-domain.conf"].write_text(ORIGINAL)
        api = root / "api"
        api.mkdir()
        api_current = root / "api-current"
        api_current.symlink_to(api)
        for key, value in {
            "ROOT": root / "gallery", "BACKUPS": root / "backups",
            "NGINX": managed["q-api-domain.conf"], "MANAGED_FILES": managed,
            "API_CURRENT": api_current,
        }.items():
            stack.enter_context(patch.object(INSTALL, key, value))
        methods = ["preflight", "api_health", "route_health"]
        if not real_health:
            methods.append("expected_health")
        for method in methods:
            stack.enter_context(patch.object(INSTALL, method))
        stack.enter_context(patch.object(INSTALL.socket, "socket"))
        stack.enter_context(patch.object(INSTALL.pwd, "getpwnam", return_value=SimpleNamespace(
            pw_uid=100, pw_gid=100, pw_shell="/usr/sbin/nologin",
        )))
        stack.enter_context(patch.object(INSTALL.grp, "getgrnam", return_value=SimpleNamespace(gr_gid=100)))
        stack.enter_context(patch.object(INSTALL.os, "getgrouplist", return_value=[100]))
        original_stat = Path.stat

        def root_owned(path, *args, **kwargs):
            stat = original_stat(path, *args, **kwargs)
            values = list(stat)
            values[4] = 0
            return os.stat_result(values)

        stack.enter_context(patch.object(Path, "stat", root_owned))
        yield root, managed


class TransactionTests(unittest.TestCase):
    def test_install_preserves_nginx_changed_while_waiting_for_gallery_health(self):
        with installation_fixture():
            calls = []

            def command(*arguments, **kwargs):
                calls.append(arguments)
                return SimpleNamespace(stdout="disabled\n")

            def concurrent_edit(*arguments):
                INSTALL.NGINX.write_text(ORIGINAL + "# concurrent operator during startup\n")

            with patch.object(INSTALL, "command", side_effect=command), \
                    patch.object(INSTALL, "expected_health", side_effect=concurrent_edit):
                with self.assertRaisesRegex(ValueError, "Configuration changed"):
                    INSTALL.install(files_fixture(), SHA)
            self.assertEqual(
                INSTALL.NGINX.read_text(), ORIGINAL + "# concurrent operator during startup\n"
            )
            backup = next(INSTALL.BACKUPS.glob("*/q-api-domain.conf"))
            self.assertEqual(backup.read_text(), ORIGINAL)
            self.assertNotIn(("systemctl", "reload", "nginx"), calls)

    def test_backup_refuses_a_different_nginx_revision_from_the_render_input(self):
        with installation_fixture():
            render = INSTALL.render_nginx

            def concurrent_edit(original, template):
                result = render(original, template)
                INSTALL.NGINX.write_text(ORIGINAL + "# concurrent operator before backup\n")
                return result

            with patch.object(INSTALL, "command", return_value=SimpleNamespace(stdout="disabled\n")) as command, \
                    patch.object(INSTALL, "render_nginx", side_effect=concurrent_edit):
                with self.assertRaisesRegex(ValueError, "Configuration changed"):
                    INSTALL.install(files_fixture(), SHA)
            self.assertEqual(
                INSTALL.NGINX.read_text(), ORIGINAL + "# concurrent operator before backup\n"
            )
            self.assertFalse(list(INSTALL.BACKUPS.glob("*/q-api-domain.conf")))
            self.assertNotIn(
                ("systemctl", "restart", "q-beauty.service"),
                [call.args for call in command.call_args_list],
            )

    def test_failed_nginx_validation_restores_files_current_link_and_service_state(self):
        with installation_fixture() as (root, managed):
            calls = []

            def command(*arguments, **kwargs):
                calls.append(arguments)
                if arguments == ("nginx", "-t") and "# BEGIN Q BEAUTY" in INSTALL.NGINX.read_text():
                    raise subprocess.CalledProcessError(1, arguments)
                return SimpleNamespace(stdout="disabled\n")

            with patch.object(INSTALL, "command", side_effect=command):
                with self.assertRaises(subprocess.CalledProcessError):
                    INSTALL.install(files_fixture(), SHA)
            self.assertEqual(INSTALL.NGINX.read_text(), ORIGINAL)
            self.assertFalse((INSTALL.ROOT / "current").exists())
            self.assertTrue((INSTALL.ROOT / "releases" / SHA).is_dir())
            self.assertEqual(INSTALL.API_CURRENT.resolve(), root / "api")
            for name in (*INSTALL.UNITS, INSTALL.JOURNAL):
                self.assertFalse(managed[name].exists())
            self.assertIn(("systemctl", "disable", "q-beauty.service", "q-beauty-health.timer"), calls)
            self.assertIn(("systemctl", "reload", "nginx"), calls)
            self.assertEqual(len(list(INSTALL.BACKUPS.glob("*/state.json"))), 1)

    def test_rollback_refuses_to_overwrite_configuration_changed_after_install(self):
        with installation_fixture():
            with patch.object(INSTALL, "command", return_value=SimpleNamespace(stdout="disabled\n")):
                INSTALL.install(files_fixture(), SHA)
            state_path = next(INSTALL.BACKUPS.glob("*/state.json"))
            state = json.loads(state_path.read_text())
            INSTALL.NGINX.write_text(INSTALL.NGINX.read_text() + "# another operator changed this\n")
            with patch.object(INSTALL, "command") as command:
                with self.assertRaisesRegex(ValueError, "Configuration changed"):
                    INSTALL.restore(state_path.parent, state)
                command.assert_not_called()
            self.assertIn("# another operator", INSTALL.NGINX.read_text())

    def test_rollback_preserves_nginx_changed_while_stopping_gallery_service(self):
        with installation_fixture():
            with patch.object(INSTALL, "command", return_value=SimpleNamespace(stdout="disabled\n")):
                INSTALL.install(files_fixture(), SHA)
            state_path = next(INSTALL.BACKUPS.glob("*/state.json"))
            installed = INSTALL.NGINX.read_text()
            calls = []

            def command(*arguments, **kwargs):
                calls.append(arguments)
                if arguments == ("systemctl", "stop", "q-beauty.service"):
                    INSTALL.NGINX.write_text(installed + "# concurrent operator during stop\n")
                return SimpleNamespace(stdout="disabled\n")

            with patch.object(INSTALL, "command", side_effect=command):
                with self.assertRaisesRegex(ValueError, "Configuration changed"):
                    INSTALL.restore(state_path.parent, json.loads(state_path.read_text()))
            self.assertEqual(
                INSTALL.NGINX.read_text(), installed + "# concurrent operator during stop\n"
            )
            self.assertEqual(INSTALL.previous_target(), str(INSTALL.ROOT / "releases" / SHA))
            self.assertNotIn(("systemctl", "reload", "nginx"), calls)

    def test_real_health_module_keeps_inventory_clean_for_same_commit_reinstall(self):
        class Response(io.BytesIO):
            status = 200

            def geturl(self):
                return "http://127.0.0.1:18796/health"

        class Opener:
            calls = 0

            def open(self, url, timeout):
                self.calls += 1
                return Response(json.dumps({
                    "status": "ok", "service": "beauty-mcp", "source_commit": SHA,
                    "photo_count": 300, "public_base": INSTALL.BASE,
                }).encode())

        with installation_fixture(real_health=True) as (root, _managed):
            files = files_fixture()
            archive = root / "gallery.tgz"
            digest = write_archive(archive, files)
            opener = Opener()
            with patch.object(INSTALL, "command", return_value=SimpleNamespace(stdout="disabled\n")), \
                    patch.object(INSTALL.urllib.request, "build_opener", return_value=opener), \
                    patch.object(INSTALL.sys, "dont_write_bytecode", False):
                for _ in range(2):
                    verified = INSTALL.verify_archive(archive, SHA, digest)
                    INSTALL.install(verified, SHA)
                    release = INSTALL.ROOT / "releases" / SHA
                    self.assertFalse(list(release.rglob("__pycache__")))
                    self.assertEqual(
                        {str(path.relative_to(release)) for path in release.rglob("*") if path.is_file()},
                        files.keys(),
                    )
            self.assertEqual(opener.calls, 2)
            self.assertEqual(len(list(INSTALL.BACKUPS.glob("*/state.json"))), 2)

    def test_explicit_rollback_keeps_release_data_and_restores_previous_config(self):
        with installation_fixture():
            with patch.object(INSTALL, "command", return_value=SimpleNamespace(stdout="disabled\n")):
                INSTALL.install(files_fixture(), SHA)
                state_path = next(INSTALL.BACKUPS.glob("*/state.json"))
                INSTALL.restore(state_path.parent, json.loads(state_path.read_text()))
            self.assertEqual(INSTALL.NGINX.read_text(), ORIGINAL)
            self.assertFalse((INSTALL.ROOT / "current").is_symlink())
            self.assertTrue((INSTALL.ROOT / "releases" / SHA / "data/manifest.json").exists())

    def test_rollback_verifies_the_previous_active_gallery_through_nginx(self):
        old_commit = "b" * 40
        with installation_fixture():
            with patch.object(INSTALL, "command", return_value=SimpleNamespace(stdout="disabled\n")):
                INSTALL.install(files_fixture(old_commit), old_commit)
                with patch.object(INSTALL, "service_state", return_value={"active": True, "enabled": True}):
                    INSTALL.install(files_fixture(), SHA)
                state_path = next(INSTALL.BACKUPS.glob(f"*-{SHA[:12]}-*/state.json"))
                INSTALL.route_health.reset_mock()
                INSTALL.restore(state_path.parent, json.loads(state_path.read_text()))
            self.assertEqual(INSTALL.previous_target(), str(INSTALL.ROOT / "releases" / old_commit))
            INSTALL.route_health.assert_called_once_with(old_commit)


class FileMutationTests(unittest.TestCase):
    def test_replace_checks_expected_contents_after_preparing_the_temporary_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "nginx.conf"
            path.write_bytes(b"original")
            with patch.object(INSTALL.os, "fsync", side_effect=lambda _fd: path.write_bytes(b"operator edit")):
                with self.assertRaisesRegex(ValueError, "Configuration changed"):
                    INSTALL.write_atomic(path, b"gallery edit", expected_hash=INSTALL.sha256(b"original"))
            self.assertEqual(path.read_bytes(), b"operator edit")

    def test_delete_refuses_to_remove_an_operators_replacement_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "q-beauty.service"
            path.write_bytes(b"operator edit")
            with self.assertRaisesRegex(ValueError, "Configuration changed"):
                INSTALL.unlink_checked(path, INSTALL.sha256(b"installed unit"))
            self.assertEqual(path.read_bytes(), b"operator edit")


class LockTests(unittest.TestCase):
    def test_respects_existing_ci_and_admin_locks_and_releases_partial_acquisitions(self):
        for occupied in (0, 1):
            with self.subTest(occupied=occupied), tempfile.TemporaryDirectory() as temporary:
                paths = [Path(temporary) / name for name in ("ci.lock", "admin.lock", "gallery.lock")]
                locks = tuple((path, index != 1) for index, path in enumerate(paths))
                descriptor = os.open(paths[occupied], os.O_CREAT | os.O_RDWR, 0o600)
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                real_fstat = os.fstat

                def root_owned(fd):
                    values = list(real_fstat(fd))
                    values[4] = 0
                    return os.stat_result(values)

                try:
                    with patch.object(INSTALL, "DEPLOY_LOCKS", locks), \
                            patch.object(INSTALL.os, "fstat", side_effect=root_owned):
                        with self.assertRaises(BlockingIOError):
                            with INSTALL.installation_lock():
                                self.fail("A cooperating Q deployment is already running")
                finally:
                    os.close(descriptor)
                # A failed acquisition must not retain earlier locks.
                for path in paths:
                    if path.exists():
                        with path.open("r") as released:
                            fcntl.flock(released.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


if __name__ == "__main__":
    unittest.main()
