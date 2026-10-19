"""Exercise release packaging against temporary local Git history and a fake compiler."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('package-release.sh')


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Package Test')
        self.git('config', 'user.email', 'test@example.invalid')
        (self.repo / 'backend/deploy').mkdir(parents=True)
        shutil.copyfile(SCRIPT, self.repo / 'backend/deploy/package-release.sh')
        (self.repo / 'backend/migrations').mkdir()
        self.sql = b'-- Keep CRLF, UTF-8 and trailing whitespace exactly.\r\nSELECT 1;  \r\n'
        (self.repo / 'backend/migrations/0001_initial.sql').write_bytes(self.sql)
        (self.repo / 'backend/migrations/0010_next.sql').write_bytes(b'SELECT 10;\n')
        (self.repo / 'backend/Cargo.toml').write_text('# fake compiler fixture\n')
        self.first = self.commit()
        self.remote = self.base / 'remote.git'
        subprocess.run(['git', 'clone', '--bare', str(self.repo), str(self.remote)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.git('remote', 'add', 'origin', str(self.remote))
        tools = self.base / 'bin'
        tools.mkdir()
        compiler = tools / 'cargo'
        compiler.write_text('#!/bin/sh\nmkdir -p "$CARGO_TARGET_DIR/release"\n'
                            'printf "\\177ELFfixture" > "$CARGO_TARGET_DIR/release/xiaoq-backend"\n')
        compiler.chmod(0o755)
        self.env = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG', 'TMPDIR') if key in os.environ}
        self.env['PATH'] = str(tools) + os.pathsep + self.env['PATH']

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args],
                                       stderr=subprocess.DEVNULL, text=True).strip()

    def commit(self):
        self.git('add', 'backend')
        self.git('commit', '-m', 'Fixture')
        return self.git('rev-parse', 'HEAD')

    def run_package(self, extra=None):
        return subprocess.run(['bash', str(self.repo / 'backend/deploy/package-release.sh')],
                              env={**self.env, **(extra or {})}, capture_output=True)

    def protected(self, sha=None):
        return {'CI_COMMIT_BRANCH': 'main', 'CI_DEFAULT_BRANCH': 'main',
                'CI_COMMIT_REF_PROTECTED': 'true', 'CI_COMMIT_SHA': sha or self.first}

    def read_release(self, sha):
        path = self.repo / 'backend/.local/release' / ('q-release-' + sha + '.tar.gz')
        with tarfile.open(path) as archive:
            return {item.name: archive.extractfile(item).read() for item in archive if item.isfile()}

    def test_manifest_raw_bytes_numeric_order_hashes_and_clean_up(self):
        # A dirty local SQL edit must not enter the archived release.
        (self.repo / 'backend/migrations/0001_initial.sql').write_text('uncommitted change\n')
        result = self.run_package(self.protected())
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        files = self.read_release(self.first)
        expected = ('1 ' + hashlib.sha384(self.sql).hexdigest() + '\n10 '
                    + hashlib.sha384(b'SELECT 10;\n').hexdigest() + '\n').encode()
        self.assertEqual(files['q-release/MIGRATIONS'], expected)
        self.assertEqual(files['q-release/SOURCE_COMMIT'], (self.first + '\n').encode())
        names = ('xiaoq-backend', 'SOURCE_COMMIT', 'MIGRATIONS')
        hashes = ''.join(hashlib.sha256(files['q-release/' + name]).hexdigest() + '  ' + name + '\n'
                         for name in names).encode()
        self.assertEqual(files['q-release/SHA256SUMS'], hashes)
        self.assertFalse(list((self.repo / 'backend/.local/release').glob('.build-*')))

    def test_protected_pipeline_is_pinned_even_if_main_advances(self):
        (self.repo / 'backend/migrations/0011_later.sql').write_text('SELECT 11;\n')
        latest = self.commit()
        self.git('push', 'origin', 'main')
        self.git('checkout', '--detach', self.first)
        result = self.run_package(self.protected())
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertNotIn(b'11 ', self.read_release(self.first)['q-release/MIGRATIONS'])
        self.assertFalse((self.repo / 'backend/.local/release' / ('q-release-' + latest + '.tar.gz')).exists())

    def test_protected_pipeline_ref_override_and_checkout_mismatch_rejected(self):
        for extra in ({'Q_RELEASE_REF': 'origin/main'}, {'CI_COMMIT_SHA': 'a' * 40},
                      {'CI_COMMIT_SHA': 'bad'}, {'CI_DEFAULT_BRANCH': 'other'}):
            with self.subTest(extra=extra):
                result = self.run_package({**self.protected(), **extra})
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.repo / 'backend/.local/release').exists())

    def test_other_branch_can_package_reviewed_history_only(self):
        self.git('checkout', '-b', 'Mandow')
        (self.repo / 'backend/migrations/0011_feature.sql').write_text('SELECT 11;\n')
        feature = self.commit()
        result = self.run_package({'CI_COMMIT_BRANCH': 'Mandow', 'Q_RELEASE_REF': self.first})
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertTrue(self.read_release(self.first))
        result = self.run_package({'CI_COMMIT_BRANCH': 'Mandow', 'Q_RELEASE_REF': feature})
        self.assertNotEqual(result.returncode, 0)

    def test_invalid_migration_versions_and_types_rejected_before_build(self):
        for name in ('1_duplicate.sql', '0_zero.sql', '9223372036854775808_overflow.sql',
                     '0002_reversible.up.sql', 'invalid.sql'):
            path = self.repo / 'backend/migrations' / name
            path.write_text('SELECT 2;\n')
            revision = self.commit()
            self.git('push', 'origin', 'main')
            result = self.run_package(self.protected(revision))
            with self.subTest(name=name):
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(list((self.repo / 'backend/.local/release').glob('*.tar.gz')))
                self.assertFalse(list((self.repo / 'backend/.local/release').glob('.build-*')))
            path.unlink()
            self.commit()


if __name__ == '__main__':
    unittest.main()
