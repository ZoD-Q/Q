import hashlib
import importlib.util
import io
import os
import fcntl
import subprocess
import threading
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent

def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

exporter, client, verifier = (load(n) for n in ['exporter', 'pull', 'verify'])
STAMP = '20261022T010203Z'

class BackupTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.base = Path(self.work.name)
        (self.base / 'secrets').mkdir()
        self.lock = self.base / 'backup.lock'
        (self.base / f'q-db-{STAMP}.dump').write_bytes(b'PGDMP-example')
        (self.base / f'q-db-{STAMP}.sha256').write_text(hashlib.sha256(b'PGDMP-example').hexdigest() + '\n')
        (self.base / 'secrets' / f'q-secrets-{STAMP}.env').write_text('PRIVATE_TEST_VALUE=do-not-log\n')
        for path in self.base.rglob('*'):
            if path.is_file(): path.chmod(0o600)

    def tearDown(self):
        self.work.cleanup()

    def archive(self):
        output = io.BytesIO()
        exporter.export(STAMP, output, self.base, self.lock, os.getuid())
        return output.getvalue()

    def test_fixed_complete_archive_and_checksum(self):
        verifier.verify(io.BytesIO(self.archive()))
        with tarfile.open(fileobj=io.BytesIO(self.archive())) as archive:
            self.assertEqual(archive.getnames(), ['database.dump', 'database.sha256', 'deploy.env'])
            self.assertTrue(all(m.mode == 0o600 for m in archive))

    def test_reject_path_symlink_missing_tamper(self):
        for stamp in ['../../etc/passwd', STAMP + ';cat /etc/q/deploy.env', '20261022T010203Z\n']:
            with self.assertRaises((ValueError, OSError)):
                exporter.files(stamp, self.base, self.lock, os.getuid())
        secret = self.base / 'secrets' / f'q-secrets-{STAMP}.env'
        secret.unlink()
        with self.assertRaises((ValueError, OSError)):
            self.archive()
        secret.symlink_to('/etc/passwd')
        with self.assertRaises((ValueError, OSError)):
            self.archive()
        secret.unlink()
        secret.write_text('example')
        (self.base / f'q-db-{STAMP}.dump').write_bytes(b'tampered')
        with self.assertRaises((ValueError, OSError)):
            self.archive()

    def test_verify_reject_incomplete_traversal_and_hash(self):
        for name, data in [('database.dump', b'bad'), ('../deploy.env', b'bad')]:
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w') as archive:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            with self.assertRaises((ValueError, OSError)):
                verifier.verify(io.BytesIO(output.getvalue()))

    def test_atomic_publish_dedupe_and_tamper(self):
        destination = self.base / f'q-offsite-{STAMP}.tar.age'
        temporary = self.base / '.temporary'
        temporary.write_bytes(b'encrypted')
        client.publish(temporary, destination)
        self.assertTrue(client.valid_existing(destination))
        with patch.object(client.subprocess, 'Popen', side_effect=AssertionError('dedupe must not transfer')):
            client.pull(STAMP, [], 'age', Path('public'), Path('private'), self.base)
        destination.write_bytes(b'corrupt')
        self.assertFalse(client.valid_existing(destination))
        destination.with_suffix('.age.sha256').unlink()
        self.assertFalse(client.valid_existing(destination))

    def test_partial_transfer_never_published_or_logged(self):
        class Source:
            stdout = io.BytesIO(b'partial secret payload')
            def wait(self, timeout=None): return 1
            def poll(self): return 1
        class Result:
            returncode = 0
        def encrypt(command, **kwargs):
            kwargs['stdout'].write(b'partial ciphertext')
            return Result()
        with patch.object(client.subprocess, 'Popen', return_value=Source()) as source, patch.object(client.subprocess, 'run', side_effect=encrypt):
            with self.assertRaisesRegex(ValueError, '^Backup transfer or encryption failed$'):
                client.pull(STAMP, ['ssh'], 'age', Path('public'), Path('private'), self.base)
            self.assertEqual(source.call_args.kwargs['stderr'], client.subprocess.DEVNULL)
        self.assertFalse((self.base / f'q-offsite-{STAMP}.tar.age').exists())
        self.assertEqual(list(self.base.glob('.q-offsite-*')), [])

    def test_stalled_export_releases_lock_and_survives_prune(self):
        entered, resume = threading.Event(), threading.Event()
        class SlowOutput(io.BytesIO):
            def write(self, block):
                entered.set()
                if not resume.wait(5): raise RuntimeError('test timeout')
                return super().write(block)
        output = SlowOutput()
        errors = []
        def run():
            try: exporter.export(STAMP, output, self.base, self.lock, os.getuid())
            except Exception as error: errors.append(error)
        worker = threading.Thread(target=run)
        worker.start()
        self.assertTrue(entered.wait(5))
        try:
            with self.lock.open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                for path in self.base.rglob('*'):
                    if path.is_file() and path != self.lock: path.unlink()
        finally:
            resume.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertFalse(errors)
        verifier.verify(io.BytesIO(output.getvalue()))

    def test_reject_bad_permission_and_owner(self):
        path = self.base / f'q-db-{STAMP}.dump'
        path.chmod(0o644)
        with self.assertRaises(ValueError): self.archive()
        path.chmod(0o600)
        with self.assertRaises(ValueError):
            exporter.files(STAMP, self.base, self.lock, os.getuid() + 1)

    @unittest.skipUnless(os.environ.get('Q_AGE_BIN'), 'set Q_AGE_BIN for real age crypto test')
    def test_real_age_decrypt_verify_and_tamper(self):
        age = Path(os.environ['Q_AGE_BIN'])
        key = self.base / 'test-age-identity'
        subprocess.run([str(age.with_name('age-keygen')), '-o', str(key)], check=True, capture_output=True)
        public = subprocess.run([str(age.with_name('age-keygen')), '-y', str(key)], check=True, capture_output=True).stdout.decode().strip()
        encrypted = self.base / 'encrypted.age'
        encrypted.write_bytes(subprocess.run([str(age), '-r', public], input=self.archive(), check=True, capture_output=True).stdout)
        command = [__import__('sys').executable, str(HERE / 'verify.py'), '--age', str(age), '--identity', str(key), str(encrypted)]
        result = subprocess.run(command, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(b'PRIVATE_TEST_VALUE', result.stdout + result.stderr)
        data = bytearray(encrypted.read_bytes())
        data[-1] ^= 1
        encrypted.write_bytes(data)
        result = subprocess.run(command, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(b'PRIVATE_TEST_VALUE', result.stdout + result.stderr)

    def test_failed_historic_set_does_not_starve_newer_sets(self):
        newest = '20261024T010203Z'
        middle = '20261023T010203Z'
        calls = []
        def transfer(stamp, *args):
            calls.append(stamp)
            if stamp == middle: raise ValueError('SECRET failure detail must not log')
        errors = io.StringIO()
        from contextlib import redirect_stderr
        with patch.object(client, 'pull', side_effect=transfer), redirect_stderr(errors):
            failed = client.transfer_sets([STAMP, newest, middle], [], 'age', Path('public'), Path('private'), self.base)
        self.assertEqual(calls, [newest, middle, STAMP])
        self.assertEqual(failed, 1)
        self.assertNotIn('SECRET', errors.getvalue())

    def test_publish_interruption_not_considered_valid(self):
        temporary = self.base / '.temporary'
        temporary.write_bytes(b'encrypted')
        destination = self.base / f'q-offsite-{STAMP}.tar.age'
        original = client.os.replace
        def replace(source, target):
            if str(target).endswith('.sha256'):
                raise OSError('interruption')
            original(source, target)
        with patch.object(client.os, 'replace', side_effect=replace):
            with self.assertRaises(OSError):
                client.publish(temporary, destination)
        self.assertFalse(client.valid_existing(destination))

if __name__ == '__main__':
    unittest.main()
