"""Pure local release checks: temporary repos/configs only, never SSH or Nginx."""

import io
import json
import os
from pathlib import Path
import subprocess
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import deploy_tools as deploy


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.git('init', '--quiet')
        (self.repo / '.gitignore').write_text('dist/\n')
        (self.repo / 'source.txt').write_text('fixture\n')
        self.git('add', '.')
        self.git('-c', 'user.name=Q Release Test', '-c', 'user.email=release-test@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'local fixture')
        self.sha = self.git('rev-parse', 'HEAD')
        self.dist = self.repo / 'dist'
        (self.dist / 'assets').mkdir(parents=True)
        (self.dist / 'index.html').write_text('<script src="/q-admin/assets/index-abc123.js"></script>')
        (self.dist / 'assets/index-abc123.js').write_text('console.log("demo")')
        self.version = {'sha': self.sha, 'mode': 'demo', 'sourceDirty': False,
                        'builtAt': '2026-10-19T12:00:00Z', 'pipelineId': '123'}
        self.write_version()
        self.archive = self.root / 'release.tar.gz'

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True).strip()

    def write_version(self):
        (self.dist / 'version.json').write_text(json.dumps(self.version))

    def package(self):
        deploy.package(self.repo, self.dist, self.sha, '123', self.archive)

    def server_fixture(self):
        config_dir = self.root / 'nginx'
        config_dir.mkdir()
        configs = {protocol: config_dir / f'{protocol}.conf' for protocol in ('https', 'http')}
        configs['https'].write_text('server {\n listen 443 ssl;\n server_name 8.163.108.216;\n location / { return 200; }\n}\n')
        configs['http'].write_text('server {\n listen 80;\n server_name 8.163.108.216;\n location / { return 302 /other; }\n}\nserver { listen 80; server_name other.example; location / { return 200; } }\n')
        self.original = {path: path.read_bytes() for path in configs.values()}
        for name, value in [('BASE', self.root / 'releases-root'),
                            ('SNIPPETS', config_dir / 'q-admin-demo'), ('CONFIGS', configs)]:
            mock = patch.object(deploy, name, value)
            mock.start()
            self.addCleanup(mock.stop)

    def prepare(self, suffix='1'):
        self.package()
        self.server_fixture()
        self.transaction = f'20261019T120000Z-{self.sha}-{suffix}'
        deploy.prepare(self.root, self.sha, deploy.digest(self.archive.read_bytes()),
                       '123', self.transaction)

    def test_valid_package_roundtrip(self):
        self.package()
        files = deploy.inspect_archive(self.archive, self.sha, '123')
        self.assertEqual(files['public/q-admin/index.html'], (self.dist / 'index.html').read_bytes())

    def test_validate_only_entrypoint_does_not_use_ssh(self):
        scripts = self.repo / 'web/deploy'
        scripts.mkdir(parents=True)
        for name in ('deploy.sh', 'remote.sh', 'deploy_tools.py'):
            shutil.copyfile(Path(__file__).parent / name, scripts / name)
        self.git('add', 'web')
        self.git('-c', 'user.name=Q Release Test', '-c', 'user.email=release-test@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'release tools fixture')
        self.sha = self.git('rev-parse', 'HEAD')
        self.version['sha'] = self.sha
        self.write_version()
        stubs = self.root / 'bin'
        stubs.mkdir()
        (stubs / 'ssh').write_text('#!/bin/sh\necho Unexpected SSH invocation >&2\nexit 99\n')
        (stubs / 'ssh').chmod(0o755)
        env = dict(os.environ, PATH=str(stubs) + os.pathsep + os.environ['PATH'])
        result = subprocess.run(['bash', str(scripts / 'deploy.sh'), '--sha', self.sha,
                                 '--pipeline-id', '123', '--dist', str(self.dist), '--validate-only'],
                                check=True, capture_output=True, text=True, env=env)
        self.assertIn('Local validation passed', result.stdout)

    def test_dirty_build_rejected_even_after_worktree_clean(self):
        self.version['sourceDirty'] = True
        self.write_version()
        with self.assertRaisesRegex(ValueError, 'sourceDirty'):
            self.package()

    def test_dirty_worktree_rejected(self):
        (self.repo / 'source.txt').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'clean'):
            self.package()

    def test_wrong_sha_and_pipeline_rejected(self):
        self.version['sha'] = '0' * 40
        self.write_version()
        with self.assertRaisesRegex(ValueError, 'SHA mismatch'):
            self.package()
        self.version['sha'] = self.sha
        self.version['pipelineId'] = '999'
        self.write_version()
        with self.assertRaisesRegex(ValueError, 'pipeline'):
            self.package()

    def test_symlink_and_hidden_file_rejected(self):
        link = self.dist / 'leak.txt'
        link.symlink_to(self.repo / 'source.txt')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.package()
        link.unlink()
        (self.dist / '.env').write_text('not a real secret')
        with self.assertRaises(ValueError):
            self.package()

    def test_archive_traversal_and_link_rejected(self):
        for name, kind in [('public/q-admin/../../outside.txt', tarfile.REGTYPE),
                           ('public/q-admin/link.txt', tarfile.SYMTYPE)]:
            with self.subTest(name=name):
                with tarfile.open(self.archive, 'w:gz') as archive:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.size = 1 if kind == tarfile.REGTYPE else 0
                    member.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
                    archive.addfile(member, io.BytesIO(b'x'))
                with self.assertRaises(ValueError):
                    deploy.inspect_archive(self.archive, self.sha, '123')

    def test_archive_manifest_hash_rejected(self):
        self.package()
        files = deploy.inspect_archive(self.archive, self.sha, '123')
        files['public/q-admin/index.html'] = b'modified'
        with tarfile.open(self.archive, 'w:gz') as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        with self.assertRaisesRegex(ValueError, 'hashes'):
            deploy.inspect_archive(self.archive, self.sha, '123')

    def test_server_selection_preserves_other_servers(self):
        text = '# server { ignored }\nserver { listen 80; server_name 8.163.108.216; location / { return 200 "}"; } }\nserver { listen 443 ssl; server_name preview.example; }\n'
        result = deploy.insert_include(text, 'http')
        marker = f'\n    include {deploy.SNIPPETS}/http.conf; # Q static demo only\n'
        self.assertEqual(result.replace(marker, ''), text)
        self.assertEqual(deploy.insert_include(result, 'http'), result)
        with self.assertRaises(ValueError):
            deploy.insert_include(text, 'https')

    def test_first_release_restores_original_configuration(self):
        self.prepare()
        deploy.activate(self.transaction)
        self.assertEqual(deploy.current_target(), str(deploy.BASE / 'releases' / self.sha))
        deploy.restore(self.transaction)
        self.assertIsNone(deploy.current_target())
        for path, data in self.original.items():
            self.assertEqual(path.read_bytes(), data)
        self.assertFalse((deploy.SNIPPETS / 'http.conf').exists())

    def test_later_release_restores_previous_target(self):
        self.prepare()
        old_sha = '1' * 40
        old = deploy.BASE / 'releases' / old_sha
        old.mkdir()
        state_file = deploy.state_path(self.transaction)
        state = json.loads(state_file.read_text())
        state['previous'] = str(old)
        state_file.write_text(json.dumps(state))
        deploy.switch_current(str(old))
        deploy.activate(self.transaction)
        deploy.restore(self.transaction)
        self.assertEqual(deploy.current_target(), str(old))

    def test_restore_preserves_concurrent_configuration_edit(self):
        self.prepare()
        deploy.activate(self.transaction)
        config = deploy.CONFIGS['http']
        config.write_text(config.read_text() + '# another operator\n')
        with self.assertRaisesRegex(ValueError, 'Concurrent'):
            deploy.restore(self.transaction)
        self.assertEqual(deploy.current_target(), str(deploy.BASE / 'releases' / self.sha))
        self.assertIn('# another operator', config.read_text())

    def test_partial_activation_is_recoverable(self):
        self.prepare()
        original_write = deploy.atomic_write
        calls = 0

        def fail_after_first(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('injected local failure')
            original_write(*args, **kwargs)

        with patch.object(deploy, 'atomic_write', fail_after_first):
            with self.assertRaises(OSError):
                deploy.activate(self.transaction)
        deploy.restore(self.transaction)
        for path, data in self.original.items():
            self.assertEqual(path.read_bytes(), data)


if __name__ == '__main__':
    unittest.main()
