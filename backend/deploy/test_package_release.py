"""Exercise release packaging against temporary local Git history and a fake compiler."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('package-release.sh')
LINUX_TARGET = 'x86_64-unknown-linux-gnu.2.36'


def elf_fixture(machine=62, elf_type=3, interpreter=b'/lib64/ld-linux-x86-64.so.2\0',
                with_sections=False):
    """Small ELF fixture with program headers, a GNU loader and x86-64 exit code."""
    phoff, phentsize, phnum = 64, 56, 2
    interp_offset = phoff + phentsize * phnum
    code_offset = (interp_offset + len(interpreter) + 15) // 16 * 16
    code = b'\xb8\x3c\x00\x00\x00\x31\xff\x0f\x05'  # exit(0); never executed by tests.
    load_size = code_offset + len(code)
    shoff = (load_size + 7) // 8 * 8 if with_sections else 0
    base = 0x400000 if elf_type == 2 else 0
    data = bytearray(shoff + 2 * 64 if with_sections else load_size)
    ident = b'\x7fELF\x02\x01\x01' + b'\0' * 9
    struct.pack_into('<16sHHIQQQIHHHHHH', data, 0, ident, elf_type, machine, 1,
                     base + code_offset, phoff, shoff, 0, 64, phentsize, phnum,
                     64 if with_sections else 0, 2 if with_sections else 0, 0)
    struct.pack_into('<IIQQQQQQ', data, phoff, 3, 4, interp_offset,
                     base + interp_offset, base + interp_offset, len(interpreter), len(interpreter), 1)
    struct.pack_into('<IIQQQQQQ', data, phoff + phentsize, 1, 5, 0, base, base,
                     load_size, load_size, 4096)
    data[interp_offset:interp_offset + len(interpreter)] = interpreter
    data[code_offset:code_offset + len(code)] = code
    if with_sections:
        struct.pack_into('<IIQQQQIIQQ', data, shoff + 64, 0, 1, 6, base + code_offset,
                         code_offset, len(code), 0, 0, 1, 0)
    return bytes(data)


def changed(data, offset, value):
    altered = bytearray(data)
    altered[offset:offset + len(value)] = value
    return bytes(altered)


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
        compiler.write_text('''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
Path(os.environ['FAKE_CARGO_LOG']).write_text(json.dumps(args))
output = Path(os.environ['CARGO_TARGET_DIR'])
if '--target' in args:
    output /= args[args.index('--target') + 1].split('.')[0]
output /= 'release'
output.mkdir(parents=True)
binary = output / 'xiaoq-backend'
binary.write_bytes(Path(os.environ['FAKE_CARGO_FIXTURE']).read_bytes())
binary.chmod(0o755)
''')
        compiler.chmod(0o755)
        self.compiler_log = self.base / 'compiler-arguments.json'
        self.binary_fixture = self.base / 'compiler-output.elf'
        self.binary_fixture.write_bytes(elf_fixture())
        self.env = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG', 'TMPDIR') if key in os.environ}
        self.env['PATH'] = str(tools) + os.pathsep + self.env['PATH']
        self.env.update(FAKE_CARGO_LOG=str(self.compiler_log),
                        FAKE_CARGO_FIXTURE=str(self.binary_fixture))

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
        self.assertEqual(set(files), {'q-release/' + name for name in (*names, 'SHA256SUMS')})
        self.assertEqual(files['q-release/xiaoq-backend'], elf_fixture())
        arguments = json.loads(self.compiler_log.read_text())
        self.assertEqual(arguments[0], 'zigbuild')
        self.assertIn('--locked', arguments)
        self.assertIn('--release', arguments)
        self.assertEqual(arguments[arguments.index('--target') + 1], LINUX_TARGET)
        self.assertEqual(arguments[arguments.index('--bin') + 1], 'xiaoq-backend')
        self.assertNotIn('--features', arguments)
        self.assertNotIn('--all-features', arguments)
        self.assertNotIn('--no-default-features', arguments)
        manifest = Path(arguments[arguments.index('--manifest-path') + 1])
        self.assertEqual(manifest.parts[-3:], ('source', 'backend', 'Cargo.toml'))
        self.assertFalse(list((self.repo / 'backend/.local/release').glob('.build-*')))

    def test_linux_executable_and_pie_with_section_headers_are_accepted(self):
        for elf_type in (2, 3):
            with self.subTest(elf_type=elf_type):
                fixture = elf_fixture(elf_type=elf_type, with_sections=True)
                self.binary_fixture.write_bytes(fixture)
                result = self.run_package(self.protected())
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(self.read_release(self.first)['q-release/xiaoq-backend'], fixture)

    def assert_binary_refused(self, binary):
        self.binary_fixture.write_bytes(binary)
        result = self.run_package(self.protected())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Release refused:', result.stderr)
        self.assertFalse(list((self.repo / 'backend/.local/release').glob('*.tar.gz')))
        self.assertFalse(list((self.repo / 'backend/.local/release').glob('.build-*')))

    def test_wrong_architecture_format_type_or_loader_is_rejected(self):
        valid = elf_fixture()
        cases = {
            'arm64': elf_fixture(machine=183),
            'mach-o': b'\xcf\xfa\xed\xfe' + b'\0' * 300,
            'script': b'#!/bin/sh\nexit 0\n',
            'elf32': changed(valid, 4, b'\x01'),
            'big-endian': changed(valid, 5, b'\x02'),
            'non-linux-abi': changed(valid, 7, b'\x09'),
            'relocatable': elf_fixture(elf_type=1),
            'shared-object-without-entry': changed(valid, 24, struct.pack('<Q', 0)),
            'non-executable-entry': changed(valid, 120 + 4, struct.pack('<I', 4)),
            'wrong-loader': elf_fixture(interpreter=b'/lib/ld-linux-aarch64.so.1\0'),
            'unterminated-loader': elf_fixture(interpreter=b'/lib64/ld-linux-x86-64.so.2'),
            'missing-interpreter': changed(valid, 64, struct.pack('<I', 0)),
        }
        for name, fixture in cases.items():
            with self.subTest(name=name):
                self.assert_binary_refused(fixture)

    def test_truncated_elf_headers_segments_and_sections_are_rejected(self):
        valid = elf_fixture()
        sections = elf_fixture(with_sections=True)
        shoff = struct.unpack_from('<Q', sections, 40)[0]
        cases = {
            'empty': b'',
            'magic-only': b'\x7fELF',
            'short-header': valid[:63],
            'short-program-table': valid[:120],
            'short-load-segment': valid[:-1],
            'program-table-outside-file': changed(valid, 32, struct.pack('<Q', len(valid))),
            'interpreter-outside-file': changed(valid, 64 + 8, struct.pack('<Q', len(valid))),
            'short-section-table': sections[:-1],
            'section-data-outside-file': changed(sections, shoff + 64 + 24,
                                                 struct.pack('<Q', len(sections))),
        }
        for name, fixture in cases.items():
            with self.subTest(name=name):
                self.assert_binary_refused(fixture)

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
                self.assertFalse(self.compiler_log.exists(), 'invalid pipeline identity must fail before compilation')
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
                self.assertFalse(self.compiler_log.exists(), 'invalid migrations must fail before compilation')
                self.assertFalse(list((self.repo / 'backend/.local/release').glob('*.tar.gz')))
                self.assertFalse(list((self.repo / 'backend/.local/release').glob('.build-*')))
            path.unlink()
            self.commit()


if __name__ == '__main__':
    unittest.main()
