"""Deployment client validation; no network or real credentials are used."""
import base64
import hashlib
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ci_client', Path(__file__).with_name('ci_client.py'))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
SHA = 'a' * 40
KEY = b'-----BEGIN OPENSSH PRIVATE KEY-----\nTEST-ONLY-NOT-A-KEY\n-----END OPENSSH PRIVATE KEY-----\n'


def environment():
    return {'CI_PROJECT_ID': '197', 'CI_DEFAULT_BRANCH': 'main', 'CI_COMMIT_BRANCH': 'main',
            'CI_COMMIT_REF_PROTECTED': 'true', 'CI_JOB_NAME': 'deploy-staging-api',
            'CI_ENVIRONMENT_NAME': 'staging/api', 'CI_COMMIT_SHA': SHA,
            'CI_PIPELINE_ID': '42', 'CI_JOB_ID': '99', 'CI_JOB_TOKEN': 'secret-job-token',
            'Q_STAGING_SSH_KEY_B64': base64.b64encode(KEY).decode(), 'PATH': os.environ['PATH'],
            'SSH_AUTH_SOCK': '/secret/socket', 'OTHER_SECRET': 'never-forward'}


def response(identity, check=False):
    public = {key: identity[key] for key in ('component', 'source_sha', 'pipeline_id', 'job_id')}
    public.update(status='success', readiness_verified=True, deployment_performed=not check,
                  health_verified=True, version_verified=True)
    return json.dumps(public).encode()


def archive(path, sha=SHA, override=None):
    files = {'xiaoq-backend': b'\x7fELFtest binary', 'SOURCE_COMMIT': (sha + '\n').encode(),
             'MIGRATIONS': b'1 ' + b'a' * 96 + b'\n'}
    files['SHA256SUMS'] = ''.join(hashlib.sha256(files[name]).hexdigest() + '  ' + name + '\n'
                                for name in ('xiaoq-backend', 'SOURCE_COMMIT', 'MIGRATIONS')).encode()
    if override:
        files.update(override)
    with tarfile.open(path, 'w:gz') as stream:
        for name, data in files.items():
            item = tarfile.TarInfo('q-release/' + name)
            item.size = len(data)
            stream.addfile(item, io.BytesIO(data))


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        (self.repo / 'backend/deploy').mkdir(parents=True)
        (self.repo / 'backend/deploy/ci_known_hosts').write_text('pinned-host-key\n')
        self.release = self.repo / 'backend/.local/release' / ('q-release-' + SHA + '.tar.gz')
        self.release.parent.mkdir(parents=True)
        archive(self.release)
        self.env = environment()

    def test_rejects_wrong_ci_context(self):
        for key, value in [('CI_PROJECT_ID', '198'), ('CI_DEFAULT_BRANCH', 'Mandow'),
                           ('CI_COMMIT_BRANCH', 'Mandow'), ('CI_COMMIT_REF_PROTECTED', 'false'),
                           ('CI_JOB_NAME', 'other'), ('CI_ENVIRONMENT_NAME', 'production'),
                           ('CI_COMMIT_SHA', '../evil'), ('CI_PIPELINE_ID', '-1'),
                           ('CI_JOB_ID', '0'), ('CI_JOB_TOKEN', 'bad\ncredential')]:
            with self.subTest(key=key), self.assertRaises(client.ClientError):
                client.context('api', {**self.env, key: value})

    def test_api_source_and_hash_validation(self):
        client.validate_api(self.release, SHA)
        for changes in ({'sha': 'b' * 40}, {'override': {'xiaoq-backend': b'changed'}},
                        {'override': {'../../outside': b'bad'}}):
            archive(self.release, **changes)
            with self.subTest(changes=changes), self.assertRaises(client.ClientError):
                client.validate_api(self.release, SHA)

    def test_api_rejects_links_duplicates_and_oversized_members(self):
        for mode in ('link', 'duplicate', 'oversize'):
            item = tarfile.TarInfo('q-release/xiaoq-backend')
            if mode == 'oversize':
                # An adversarial header advertises a huge member without supplying
                # its body. Python 3.13+ correctly refuses to create this through
                # TarFile.addfile, so construct the malformed input explicitly.
                item.size = client.MAX_ARCHIVE + 1
                with gzip.open(self.release, 'wb') as stream:
                    stream.write(item.tobuf(format=tarfile.USTAR_FORMAT))
                    stream.write(b'\0' * 1024)
            else:
                with tarfile.open(self.release, 'w:gz') as stream:
                    if mode == 'link':
                        item.type = tarfile.SYMTYPE
                        item.linkname = '/etc/passwd'
                    stream.addfile(item)
                    if mode == 'duplicate':
                        stream.addfile(item)
            with self.subTest(mode=mode), self.assertRaises(client.ClientError):
                client.validate_api(self.release, SHA)

    def test_api_rejects_invalid_migrations(self):
        for value in (b'', b'1 invalid\n', b'1 ' + b'a' * 96,
                      (b'1 ' + b'a' * 96 + b'\n') * 2,
                      b'2 ' + b'a' * 96 + b'\n1 ' + b'a' * 96 + b'\n'):
            archive(self.release, override={'MIGRATIONS': value})
            with self.subTest(value=value), self.assertRaisesRegex(client.ClientError, '[Mm]igration'):
                client.validate_api(self.release, SHA)

    def test_invalid_key_does_not_leak_or_connect(self):
        for value in ('secret?not-base64', base64.b64encode(b'secret malformed key').decode()):
            with patch.object(client, 'exchange') as exchange:
                with self.assertRaises(client.ClientError) as raised:
                    client.run('api', False, self.repo, {**self.env, 'Q_STAGING_SSH_KEY_B64': value})
                self.assertNotIn(value, str(raised.exception))
                self.assertNotIn('secret', str(raised.exception))
                exchange.assert_not_called()

    def test_success_frame_credentials_and_cleanup(self):
        observed_key = []
        def exchange(command, payload, env):
            self.assertEqual(command[-1], 'qdeploy@8.163.108.216')
            self.assertIn('StrictHostKeyChecking=yes', command)
            self.assertIn('ForwardAgent=no', command)
            self.assertNotIn('CI_JOB_TOKEN', env)
            self.assertNotIn('Q_STAGING_SSH_KEY_B64', env)
            self.assertNotIn('SSH_AUTH_SOCK', env)
            self.assertNotIn('OTHER_SECRET', env)
            key = Path(command[command.index('-i') + 1])
            observed_key.append(key)
            self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
            self.assertEqual(key.read_bytes(), KEY)
            header, body = payload.split(b'\n', 1)
            identity = json.loads(header)
            self.assertEqual(set(identity), {'version', 'action', 'component', 'source_sha',
                                             'pipeline_id', 'job_id', 'job_token', 'archive_size',
                                             'archive_sha256'})
            self.assertEqual(identity['archive_size'], len(body))
            self.assertEqual(identity['archive_sha256'], hashlib.sha256(body).hexdigest())
            self.assertEqual(body, self.release.read_bytes())
            reply = json.loads(response(identity))
            reply['unexpected_secret'] = 'never-store'
            return json.dumps(reply).encode()
        with patch.object(client, 'exchange', side_effect=exchange) as mocked:
            client.run('api', False, self.repo, self.env)
            mocked.assert_called_once()
        self.assertFalse(observed_key[0].exists())
        saved = (self.repo / 'backend/.local/ci-deploy/api-receipt.json').read_text()
        self.assertNotIn('secret', saved)
        self.assertNotIn('never-store', saved)
        self.assertTrue(json.loads(saved)['version_verified'])

    def test_failure_unknown_state_no_retry_and_cleanup(self):
        keys = []
        def fail(command, payload, env):
            keys.append(Path(command[command.index('-i') + 1]))
            raise client.ClientError(client.UNKNOWN)
        with patch.object(client, 'exchange', side_effect=fail) as mocked:
            with self.assertRaisesRegex(client.ClientError, 'unknown'):
                client.run('api', False, self.repo, self.env)
            mocked.assert_called_once()
        self.assertFalse(keys[0].exists())
        self.assertFalse((self.repo / 'backend/.local/ci-deploy/api-receipt.json').exists())

    def test_receipt_mismatched_version_and_other_identities(self):
        identity = client.context('api', self.env)
        for key, value in [('source_sha', 'b' * 40), ('component', 'admin'), ('pipeline_id', 43),
                           ('job_id', '99'), ('health_verified', False), ('version_verified', False),
                           ('status', 'failed')]:
            reply = json.loads(response(identity))
            reply[key] = value
            with self.subTest(key=key), self.assertRaises(client.ClientError):
                client.receipt(json.dumps(reply).encode(), identity, False)

    def test_check_has_no_archive_or_deployment(self):
        self.release.unlink()
        def check(command, payload, env):
            line, body = payload.split(b'\n', 1)
            header = json.loads(line)
            self.assertEqual(header['action'], 'check')
            self.assertEqual(header['archive_size'], 0)
            self.assertEqual(header['archive_sha256'], '')
            self.assertEqual(body, b'')
            return response(header, check=True)
        with patch.object(client, 'exchange', side_effect=check):
            result = client.run('api', True, self.repo, self.env)
        self.assertFalse(result['deployment_performed'])
        self.assertNotIn('health_verified', result)

    def test_admin_uses_packager(self):
        env = {**self.env, 'CI_JOB_NAME': 'deploy-staging-admin', 'CI_ENVIRONMENT_NAME': 'staging/admin'}
        def package(command, **kwargs):
            self.assertIn(str(self.repo / 'web/deploy/deploy_tools.py'), command)
            self.assertEqual(command[command.index('--pipeline-id') + 1], '42')
            self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
            self.assertNotIn('CI_JOB_TOKEN', kwargs['env'])
            Path(command[command.index('--output') + 1]).write_bytes(b'packaged-admin')
        def exchange(command, payload, env):
            line, body = payload.split(b'\n', 1)
            self.assertEqual(body, b'packaged-admin')
            return response(json.loads(line))
        with patch.object(client.subprocess, 'run', side_effect=package) as mocked, \
                patch.object(client, 'exchange', side_effect=exchange):
            client.run('admin', False, self.repo, env)
            mocked.assert_called_once()

    def test_exchange_eof_and_bounded_io(self):
        # A local child reads to EOF, exercising the same framing lifecycle as SSH.
        body = b'header\n' + b'x' * (128 * 1024)
        program = 'import sys; data=sys.stdin.buffer.read(); print(len(data))'
        actual = client.exchange([sys.executable, '-c', program], body, client.child_environment(self.env), 5)
        self.assertEqual(int(actual), len(body))
        for program in ('import sys; sys.stdout.write("x" * 32768)',
                        'import sys; sys.stderr.write("secret"); sys.exit(1)',
                        'import time; time.sleep(5)'):
            with self.subTest(program=program), self.assertRaisesRegex(client.ClientError, 'unknown'):
                client.exchange([sys.executable, '-c', program], b'{}\n', {}, .2)


if __name__ == '__main__':
    unittest.main()
