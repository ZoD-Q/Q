#!/usr/bin/env python3
"""Pure receiver boundary tests; no Docker, network, credentials or server writes."""
import hashlib
import io
import json
import tarfile
import unittest
import tempfile
from pathlib import Path
from contextlib import ExitStack
from types import SimpleNamespace
import stat
import sys
from unittest.mock import patch
import ci_receiver as receiver
from test_package_release import elf_fixture

SHA = 'a' * 40


def request(action='deploy', component='api', archive=b'x'):
    return dict(version=1, action=action, component=component, source_sha=SHA,
                pipeline_id=12, job_id=34, job_token='synthetic-job-token',
                archive_size=len(archive) if action == 'deploy' else 0,
                archive_sha256=hashlib.sha256(archive).hexdigest() if action == 'deploy' else '')


def job(component='api'):
    return dict(id=34, pipeline=dict(id=12, project_id=197, ref='main', sha=SHA),
                ref='main', tag=False, commit=dict(id=SHA), status='running',
                name='deploy-staging-' + component)


def archive(entries):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w:gz', format=tarfile.USTAR_FORMAT) as stream:
        for name, data, kind in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            if kind == tarfile.REGTYPE:
                member.size = len(data)
                stream.addfile(member, io.BytesIO(data))
            else:
                member.linkname = '/etc/shadow' if kind == tarfile.SYMTYPE else ''
                stream.addfile(member)
    return out.getvalue()


def api_entries(companion=None, provenance=None):
    contents = {'xiaoq-backend': elf_fixture(), 'SOURCE_COMMIT': (SHA + '\n').encode(),
                'MIGRATIONS': ('1 ' + 'b' * 96 + '\n').encode()}
    if companion is not None:
        contents['account-admin'] = companion
    if provenance is not None:
        contents['BUILD_PROVENANCE'] = provenance
    manifest = ''.join(hashlib.sha256(content).hexdigest() + '  ' + name + '\n'
                       for name, content in contents.items()).encode()
    contents['SHA256SUMS'] = manifest
    return [('q-release', b'', tarfile.DIRTYPE)] + [
        ('q-release/' + name, data, tarfile.REGTYPE) for name, data in contents.items()]


class RequestTests(unittest.TestCase):
    def test_valid_exact_stream(self):
        r = request()
        result, data = receiver.read_request(io.BytesIO(json.dumps(r).encode() + b'\nx'))
        self.assertEqual(result, r)
        self.assertEqual(data, b'x')

    def test_check_requires_empty_body(self):
        receiver.validate_request(request('check'))
        r = request('check'); r['archive_size'] = 1
        with self.assertRaises(receiver.Refused):
            receiver.validate_request(r)

    def test_invalid_shapes(self):
        cases = [('version', True), ('pipeline_id', True), ('job_id', -1),
                 ('archive_size', receiver.MAX_ARCHIVE + 1), ('archive_size', True),
                 ('source_sha', '../evil'), ('archive_sha256', 'A' * 64),
                 ('job_token', 'secret\r\nInjected: true'), ('component', 'db')]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                r = request(); r[key] = value
                with self.assertRaises(receiver.Refused): receiver.validate_request(r)
        r = request(); r['path'] = '/etc/shadow'
        with self.assertRaises(receiver.Refused): receiver.validate_request(r)

    def test_duplicate_json_keys(self):
        with self.assertRaises(receiver.Refused): receiver.json_load('{"version":1,"version":1}')

    def test_stream_budgets_and_digest(self):
        header = json.dumps(request()).encode() + b'\n'
        for stream in (header, header + b'xx', header + b'y', b'x' * 16385):
            with self.assertRaises((receiver.Refused, ValueError)):
                receiver.read_request(io.BytesIO(stream))


class AuthTests(unittest.TestCase):
    def authorize(self, j, branch=None):
        branch = branch or dict(name='main', protected=True, commit=dict(id=SHA))
        responses = iter([j, [branch]])
        return receiver.authorize(request(), lambda url, token: next(responses))

    def test_valid(self): self.authorize(job())

    def test_reject_job_substitutions(self):
        for key, value in [('id', 35), ('ref', 'Mandow'), ('tag', True),
                           ('status', 'success'), ('name', 'deploy-staging-admin')]:
            j = job(); j[key] = value
            with self.subTest(key=key), self.assertRaises(receiver.Refused): self.authorize(j)
        for key, value in [('id', 13), ('project_id', 198), ('sha', 'b' * 40), ('ref', 'hera')]:
            j = job(); j['pipeline'][key] = value
            with self.subTest(key=key), self.assertRaises(receiver.Refused): self.authorize(j)

    def test_main_must_be_current_and_protected(self):
        for branch in [dict(name='main', protected=False, commit=dict(id=SHA)),
                       dict(name='main', protected=True, commit=dict(id='b' * 40))]:
            with self.assertRaises(receiver.Refused): self.authorize(job(), branch)

    def test_redirect_rejected(self):
        with self.assertRaises(receiver.Refused):
            receiver.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid')


class ArtifactTests(unittest.TestCase):
    def test_valid_api(self):
        files = receiver.unpack(archive(api_entries()), 'api', SHA)
        self.assertEqual(files['q-release/SOURCE_COMMIT'].decode().strip(), SHA)

    def test_optional_admin_and_existing_provenance_are_exactly_manifested(self):
        companion = elf_fixture(with_sections=True)
        files = receiver.unpack(archive(api_entries(companion, b'{"source":"reviewed"}\n')), 'api', SHA)
        self.assertEqual(files['q-release/account-admin'], companion)
        self.assertIn('q-release/BUILD_PROVENANCE', files)
        self.assertEqual(len(files), 6)

    def test_admin_missing_checksum_tamper_or_missing_payload_is_rejected(self):
        entries = api_entries(elf_fixture())
        for mode in ('missing-hash', 'tampered', 'missing-payload'):
            modified = []
            for name, data, kind in entries:
                if mode == 'missing-payload' and name == 'q-release/account-admin':
                    continue
                if mode == 'tampered' and name == 'q-release/account-admin':
                    data += b'tampered'
                if mode == 'missing-hash' and name == 'q-release/SHA256SUMS':
                    data = b''.join(line + b'\n' for line in data.splitlines() if not line.endswith(b'  account-admin'))
                modified.append((name, data, kind))
            with self.subTest(mode=mode), self.assertRaises(receiver.Refused):
                receiver.unpack(archive(modified), 'api', SHA)

    def test_admin_wrong_architecture_or_format_is_rejected_even_with_valid_hash(self):
        for payload in (elf_fixture(machine=183), b'\x7fELF', b'#!/bin/sh\nexit 0\n'):
            with self.subTest(size=len(payload)), self.assertRaisesRegex(receiver.Refused, 'invalid_linux_amd64_binary'):
                receiver.unpack(archive(api_entries(payload)), 'api', SHA)

    def test_admin_does_not_allow_additional_helpers_links_or_duplicates(self):
        entries = api_entries(elf_fixture())
        for entry in (
                ('q-release/account-admin-helper', b'bad', tarfile.REGTYPE),
                ('q-release/account-admin', b'', tarfile.SYMTYPE),
                ('q-release/account-admin', elf_fixture(), tarfile.REGTYPE),
        ):
            with self.subTest(name=entry[0], kind=entry[2]), self.assertRaises(receiver.Refused):
                receiver.unpack(archive(entries + [entry]), 'api', SHA)

    def test_executable_payload_not_allowed(self):
        entries = api_entries() + [('q-release/install.sh', b'root-code', tarfile.REGTYPE)]
        with self.assertRaises(receiver.Refused): receiver.unpack(archive(entries), 'api', SHA)

    def test_symlinks_traversal_duplicates(self):
        for entry in [('q-release/evil', b'', tarfile.SYMTYPE),
                      ('../escape', b'x', tarfile.REGTYPE),
                      ('/etc/shadow', b'x', tarfile.REGTYPE),
                      ('q-release//bad', b'x', tarfile.REGTYPE), api_entries()[1]]:
            with self.subTest(name=entry[0]), self.assertRaises(receiver.Refused):
                receiver.unpack(archive(api_entries() + [entry]), 'api', SHA)

    def test_hash_and_source_binding(self):
        entries = api_entries(); entries[1] = (entries[1][0], b'wrong binary', tarfile.REGTYPE)
        with self.assertRaises(receiver.Refused): receiver.unpack(archive(entries), 'api', SHA)
        with self.assertRaises(receiver.Refused): receiver.unpack(archive(api_entries()), 'api', 'b' * 40)

    def test_expansion_budget(self):
        with patch.object(receiver, 'MAX_EXPANDED', 1024), self.assertRaises(receiver.Refused):
            receiver.unpack(archive(api_entries()), 'api', SHA)

    def test_environment_preserved(self):
        original = b'Q_RELEASE=old\nQ_DB_PASSWORD=secret\n# operator config\nCUSTOM=value\n'
        replaced = receiver.set_image(original, 'ci-test')
        self.assertEqual(replaced, original.replace(b'Q_RELEASE=old', b'Q_RELEASE=ci-test'))
        with self.assertRaises(receiver.Refused): receiver.set_image(original + b'Q_RELEASE=twice\n', 'new')


class LifecycleTests(unittest.TestCase):
    def fixture(self, root, stack):
        state = Path(root)
        stack.enter_context(patch.object(receiver, 'STATE', state))
        stack.enter_context(patch.object(receiver, 'LOCK', state / 'lock'))
        stack.enter_context(patch.object(receiver, 'trusted', side_effect=lambda p, **kw: Path(p)))
        stack.enter_context(patch.object(receiver.os, 'fstat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600)))
        auth = stack.enter_context(patch.object(receiver, 'authorize'))
        stack.enter_context(patch.object(receiver, 'readiness'))
        stack.enter_context(patch.object(receiver, 'unpack', return_value={}))
        return auth

    def test_pending_receipt_precedes_side_effects_and_blocks_retry(self):
        with tempfile.TemporaryDirectory() as root, ExitStack() as stack:
            auth = self.fixture(root, stack)
            r = request()
            def fail(r, files, receipt, path):
                self.assertEqual(json.loads(path.read_text())['status'], 'pending_requires_operator')
                self.assertNotIn('job_token', path.read_text())
                raise receiver.Refused('synthetic_failure')
            mutate = stack.enter_context(patch.object(receiver, 'perform_api', side_effect=fail))
            with self.assertRaises(receiver.Refused): receiver.execute(r, b'x')
            with self.assertRaisesRegex(receiver.Refused, 'operator_reconciliation_required'):
                receiver.execute(r, b'x')
            self.assertEqual(mutate.call_count, 1)
            self.assertGreaterEqual(auth.call_count, 4)

    def test_success_duplicate_revalidates_without_reapply(self):
        with tempfile.TemporaryDirectory() as root, ExitStack() as stack:
            self.fixture(root, stack)
            def deploy(r, files, receipt, path):
                receipt.update(release='/synthetic/release', image_tag='test', binary_sha256='f' * 64)
            mutate = stack.enter_context(patch.object(receiver, 'perform_api', side_effect=deploy))
            verify = stack.enter_context(patch.object(receiver, 'verify_api'))
            r = request()
            result = receiver.execute(r, b'x')
            self.assertTrue(result['health_verified'])
            result = receiver.execute(r, b'x')
            self.assertTrue(result['duplicate'])
            self.assertEqual(mutate.call_count, 1)
            verify.assert_called_once()
            r['archive_sha256'] = 'e' * 64
            with self.assertRaisesRegex(receiver.Refused, 'duplicate_artifact_mismatch'):
                receiver.execute(r, b'x')

    def test_main_rejects_auth_before_reading_body(self):
        with patch.object(receiver.os, 'geteuid', return_value=0), \
             patch.object(receiver.os, 'umask'), \
             patch.dict(receiver.os.environ, {}), \
             patch.object(receiver.sys, 'argv', ['receiver']), \
             patch.object(receiver.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO())), \
             patch.object(receiver.sys, 'stdout', io.StringIO()), \
             patch.object(receiver.signal, 'signal'), patch.object(receiver.signal, 'alarm'), \
             patch.object(receiver, 'read_header', return_value=request()), \
             patch.object(receiver, 'authorize', side_effect=receiver.Refused('job_mismatch')), \
             patch.object(receiver, 'read_archive') as body:
            self.assertEqual(receiver.main(), 1)
            body.assert_not_called()

    def test_check_no_receipt_or_mutations(self):
        with patch.object(receiver, 'authorize'), patch.object(receiver, 'readiness'), \
             patch.object(receiver, 'perform_api') as mutate:
            result = receiver.execute(request('check'), b'')
            self.assertFalse(result['deployment_performed'])
            self.assertTrue(result['readiness_verified'])
            mutate.assert_not_called()


class StagingTests(unittest.TestCase):
    def test_companion_is_only_staged_readonly_and_never_inherited_from_old_release(self):
        for companion in (None, elf_fixture(with_sections=True)):
            with self.subTest(companion=companion is not None), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                old, new, runtime = root / 'old', root / 'new', root / 'runtime'
                (old / 'deploy/artifact').mkdir(parents=True)
                (old / 'deploy/artifact/account-admin').write_bytes(b'stale companion')
                (old / 'deploy/artifact/xiaoq-backend').write_bytes(b'stale API')
                (old / 'deploy/Dockerfile').write_text('trusted unchanged Dockerfile\n')
                (old / 'deploy/compose.yaml').write_text('trusted unchanged compose\n')
                runtime.mkdir()
                for name in ('backup.sh', 'backup-policy.sh', 'health-check.sh'):
                    (runtime / name).write_text('#!/bin/sh\n# trusted helper\n')
                files = receiver.unpack(archive(api_entries(companion)), 'api', SHA)
                with patch.object(receiver, 'RUNTIME', runtime), patch.object(receiver, 'run') as run:
                    receiver.stage_api_release(old, new, files)
                    run.assert_not_called()
                artifact = new / 'deploy/artifact'
                expected = {'xiaoq-backend'} | ({'account-admin'} if companion is not None else set())
                self.assertEqual({path.name for path in artifact.iterdir()}, expected)
                self.assertEqual((artifact / 'xiaoq-backend').read_bytes(), elf_fixture())
                self.assertEqual(stat.S_IMODE((artifact / 'xiaoq-backend').stat().st_mode), 0o555)
                if companion is not None:
                    self.assertEqual((artifact / 'account-admin').read_bytes(), companion)
                    self.assertEqual(stat.S_IMODE((artifact / 'account-admin').stat().st_mode), 0o555)
                self.assertEqual((old / 'deploy/artifact/account-admin').read_bytes(), b'stale companion')
                self.assertEqual((new / 'deploy/Dockerfile').read_bytes(), (old / 'deploy/Dockerfile').read_bytes())
                self.assertFalse((new / 'q-release/account-admin').exists())
                self.assertEqual((new / 'q-release/SHA256SUMS').read_bytes(), files['q-release/SHA256SUMS'])
                with self.assertRaisesRegex(receiver.Refused, 'release_already_exists'):
                    receiver.stage_api_release(old, new, files)


class ActivationTests(unittest.TestCase):
    def simulate(self, migration_after=b'unchanged', concurrent=None, initial_edit=False, partial=False, schema_upgrade=False):
        old, new = Path('/synthetic/old'), Path('/synthetic/new')
        original = b'Q_RELEASE=old\nSECRET=preserve\n'
        state = {'release': old, 'env': original}
        if initial_edit:
            state[concurrent] = b'operator-edit' if concurrent == 'env' else Path('/operator/release')
        writes, commands, receipts = [], [], []
        def compare(release, config):
            receiver.require(state['release'] == release and state['env'] == config, 'operator_state_changed')
        def write(path, data):
            writes.append(('env', data)); state['env'] = data
        def link(release):
            if partial and release == new:
                raise receiver.Refused('synthetic_link_failure')
            writes.append(('release', release)); state['release'] = release
        def verify(*args):
            if concurrent:
                state[concurrent] = b'operator-edit' if concurrent == 'env' else Path('/operator/release')
            raise receiver.Refused('synthetic_health_failure')
        def migration():
            if isinstance(migration_after, Exception): raise migration_after
            return migration_after
        with patch.object(receiver, 'authorize'), \
             patch.object(receiver, 'assert_active_state', side_effect=compare), \
             patch.object(receiver, 'atomic_write', side_effect=write), \
             patch.object(receiver, 'set_current', side_effect=link), \
             patch.object(receiver, 'run', side_effect=lambda args, **kw: commands.append(args)), \
             patch.object(receiver, 'verify_api', side_effect=verify), \
             patch.object(receiver, 'migrations', side_effect=migration), \
             patch.object(receiver, 'save_receipt', side_effect=lambda p, r: receipts.append(dict(r))):
            with self.assertRaises(receiver.Refused):
                receiver.activate_api(request(), old, new, original, 'candidate', b'unchanged',
                                      {'binary_sha256': 'a' * 64, 'schema_upgrade': schema_upgrade}, Path('/receipt'))
        return state, writes, commands, receipts

    def test_unchanged_migrations_roll_back_application(self):
        state, writes, commands, receipts = self.simulate()
        self.assertEqual(state['release'], Path('/synthetic/old'))
        self.assertEqual(state['env'], b'Q_RELEASE=old\nSECRET=preserve\n')
        self.assertEqual(receipts[-1]['status'], 'rolled_back_requires_operator')
        self.assertFalse(any('pg_restore' in str(c) for c in commands))
        self.assertEqual(len(writes), 4)

    def test_changed_or_unknown_migrations_never_rollback(self):
        for migration in (b'new-schema', receiver.Refused('db_unreadable')):
            with self.subTest(migration=str(migration)):
                state, writes, commands, receipts = self.simulate(migration)
                self.assertEqual(state['release'], Path('/synthetic/new'))
                self.assertEqual(len(writes), 2)
                self.assertEqual(receipts, [])
                self.assertEqual(len(commands), 1)

    def test_operator_edits_refuse_activation(self):
        for field in ('env', 'release'):
            state, writes, commands, receipts = self.simulate(concurrent=field, initial_edit=True)
            self.assertEqual(writes, [])
            self.assertEqual(commands, [])
            self.assertEqual(receipts, [])

    def test_operator_edits_after_activation_prevent_rollback(self):
        for field in ('env', 'release'):
            state, writes, commands, receipts = self.simulate(concurrent=field)
            self.assertEqual(len(writes), 2)
            self.assertEqual(receipts, [])
            self.assertEqual(len(commands), 1)

    def test_pending_migration_never_rolls_back_even_if_history_unchanged(self):
        state, writes, commands, receipts = self.simulate(schema_upgrade=True)
        self.assertEqual(state['release'], Path('/synthetic/new'))
        self.assertEqual(len(writes), 2)
        self.assertEqual(receipts, [])

    def test_partial_env_switch_is_recovered(self):
        state, writes, commands, receipts = self.simulate(partial=True)
        self.assertEqual(state['release'], Path('/synthetic/old'))
        self.assertEqual(state['env'], b'Q_RELEASE=old\nSECRET=preserve\n')
        self.assertEqual(len(writes), 2)
        self.assertEqual(receipts[-1]['status'], 'rolled_back_requires_operator')


class MigrationTests(unittest.TestCase):
    def test_matching_current_schema(self):
        self.assertFalse(receiver.migration_upgrade(('1 ' + 'a' * 96 + '\n').encode(),
                                                   ('1:' + 'a' * 96 + ':true\n').encode()))

    def test_pending_schema_upgrade(self):
        manifest = ('1 ' + 'a' * 96 + '\n2 ' + 'b' * 96 + '\n').encode()
        self.assertTrue(receiver.migration_upgrade(manifest, ('1:' + 'a' * 96 + ':t\n').encode()))

    def test_downgrade_and_checksum_drift(self):
        manifest = ('1 ' + 'a' * 96 + '\n').encode()
        for state in ('2:' + 'b' * 96 + ':true\n', '1:' + 'b' * 96 + ':true\n',
                      '1:' + 'a' * 96 + ':false\n'):
            with self.assertRaises(receiver.Refused): receiver.migration_upgrade(manifest, state.encode())

    def test_duplicate_or_unsorted_manifest(self):
        for manifest in ('1 ' + 'a' * 96 + '\n1 ' + 'a' * 96 + '\n',
                         '2 ' + 'b' * 96 + '\n1 ' + 'a' * 96 + '\n', ''):
            with self.assertRaises(receiver.Refused): receiver.migration_upgrade(manifest.encode(), b'')


class ProcessTests(unittest.TestCase):
    def test_bounded_stdout(self):
        with self.assertRaisesRegex(receiver.Refused, 'command_output_too_large'):
            receiver.run([sys.executable, '-c', 'import os; data=b"x"*65536; [os.write(1,data) for _ in range(100)]'])

    def test_timeout(self):
        with self.assertRaisesRegex(receiver.Refused, 'server_command_timeout'):
            receiver.run([sys.executable, '-c', 'import time; time.sleep(10)'], timeout=0.05)

    def test_command_output_and_failure(self):
        self.assertEqual(receiver.run([sys.executable, '-c', 'print("ok")']), b'ok\n')
        with self.assertRaisesRegex(receiver.Refused, 'server_command_failed'):
            receiver.run([sys.executable, '-c', 'raise SystemExit(1)'])


if __name__ == '__main__':
    unittest.main()
