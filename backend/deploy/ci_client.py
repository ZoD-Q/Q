#!/usr/bin/env python3
"""Send one bounded, authenticated deployment request to the fixed Q receiver."""
import argparse
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import struct
import subprocess
import sys
import tarfile
import tempfile
import time

MAX_ARCHIVE = 64 * 1024 * 1024
MAX_RESPONSE = 16 * 1024
TIMEOUT = 20 * 60
SHA = re.compile(r'[0-9a-f]{40}')
UNKNOWN = ('Deployment outcome is unknown; inspect the server and this GitLab job before '
           'any manual retry. No request was retried.')


class ClientError(Exception):
    """Messages are fixed public descriptions, never subprocess output or credentials."""


def require(condition, message):
    if not condition:
        raise ClientError(message)


def context(component, env):
    required = {'CI_PROJECT_ID': '197', 'CI_DEFAULT_BRANCH': 'main',
                'CI_COMMIT_BRANCH': 'main', 'CI_COMMIT_REF_PROTECTED': 'true',
                'CI_JOB_NAME': 'deploy-staging-' + component,
                'CI_ENVIRONMENT_NAME': 'staging/' + component}
    require(component in ('api', 'admin'), 'Unsupported component')
    require(all(env.get(key) == value for key, value in required.items()),
            'Deployment requires the protected main job in Q project 197')
    require(SHA.fullmatch(env.get('CI_COMMIT_SHA', '')) is not None, 'Invalid source SHA')
    ids = []
    for key in ('CI_PIPELINE_ID', 'CI_JOB_ID'):
        value = env.get(key, '')
        require(re.fullmatch(r'[1-9][0-9]{0,18}', value) is not None, 'Invalid CI identity')
        ids.append(int(value))
    token = env.get('CI_JOB_TOKEN', '')
    require(isinstance(token, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,4096}', token)
            is not None, 'Missing or invalid CI job token')
    return {'source_sha': env['CI_COMMIT_SHA'], 'pipeline_id': ids[0], 'job_id': ids[1],
            'component': component, 'job_token': token}


def decode_key(value):
    require(isinstance(value, str) and 0 < len(value) <= 32768, 'Missing or invalid deployment key')
    try:
        key = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ClientError('Invalid deployment key encoding') from None
    require(0 < len(key) <= 16384 and key.startswith(b'-----BEGIN OPENSSH PRIVATE KEY-----\n')
            and key.rstrip().endswith(b'-----END OPENSSH PRIVATE KEY-----'),
            'Invalid deployment key format')
    return key


def regular_bytes(path, limit):
    require(path.is_file() and not path.is_symlink(), 'Release must be an ordinary file')
    require(0 < path.stat().st_size <= limit, 'Release exceeds size budget')
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    require(0 < len(data) <= limit, 'Release exceeds size budget')
    return data


def validate_linux_amd64(binary):
    require(len(binary) >= 64 and binary[:7] == b'\x7fELF\x02\x01\x01'
            and binary[7] in (0, 3), 'Release must be ELF64 little-endian for Linux')
    elf_type, machine, version = struct.unpack_from('<HHI', binary, 16)
    require(elf_type in (2, 3) and machine == 62 and version == 1
            and struct.unpack_from('<H', binary, 52)[0] == 64,
            'Release must be a Linux x86-64 executable or PIE')


def validate_api(path, sha):
    regular_bytes(path, MAX_ARCHIVE)
    files = {}
    total = 0
    required = {'q-release/xiaoq-backend', 'q-release/SOURCE_COMMIT', 'q-release/SHA256SUMS',
                'q-release/MIGRATIONS'}
    allowed = required | {'q-release/account-admin'}
    seen = set()
    try:
        with tarfile.open(path, 'r:gz') as archive:
            for member in archive:
                require(member.name not in seen and len(seen) < len(allowed) + 1, 'Invalid release members')
                seen.add(member.name)
                if member.name == 'q-release' and member.isdir():
                    continue
                require(member.name in allowed and not member.pax_headers
                        and member.type in (tarfile.REGTYPE, tarfile.AREGTYPE), 'Unsafe release member')
                limit = (MAX_ARCHIVE if member.name in ('q-release/xiaoq-backend', 'q-release/account-admin') else
                         1024 * 1024 if member.name.endswith('/MIGRATIONS') else 4096)
                require(0 <= member.size <= limit, 'Release member exceeds size budget')
                total += member.size
                require(total <= MAX_ARCHIVE, 'Unpacked release exceeds size budget')
                stream = archive.extractfile(member)
                require(stream is not None, 'Unreadable release member')
                data = stream.read(member.size + 1)
                require(len(data) == member.size, 'Invalid release member length')
                files[member.name] = data
    except (tarfile.TarError, EOFError, OSError):
        raise ClientError('Invalid release archive') from None
    require(required <= set(files) <= allowed, 'Incomplete release archive')
    require(files['q-release/SOURCE_COMMIT'] == (sha + '\n').encode(), 'Release source SHA mismatch')
    validate_linux_amd64(files['q-release/xiaoq-backend'])
    if 'q-release/account-admin' in files:
        validate_linux_amd64(files['q-release/account-admin'])
    migrations = files['q-release/MIGRATIONS']
    require(re.fullmatch(rb'(?:[1-9][0-9]{0,18} [0-9a-f]{96}\n)+', migrations) is not None,
            'Invalid migration manifest')
    versions = [int(line.split(b' ', 1)[0]) for line in migrations.splitlines()]
    require(versions == sorted(set(versions)) and all(version < 2 ** 63 for version in versions),
            'Migration versions must be unique, ordered and within signed 64-bit range')
    names = ['xiaoq-backend', 'SOURCE_COMMIT', 'MIGRATIONS']
    if 'q-release/account-admin' in files:
        names.append('account-admin')
    expected = ''.join(hashlib.sha256(files['q-release/' + name]).hexdigest() + '  ' + name + '\n'
                       for name in names).encode()
    require(files['q-release/SHA256SUMS'] == expected, 'Release checksum mismatch')


def child_environment(env):
    # An allowlist avoids forwarding any GitLab variables, agent socket or credentials.
    return {key: env[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ') if key in env}


def exchange(command, payload, env, timeout=TIMEOUT):
    """Concurrent bounded pipe I/O; close stdin after exactly one framed payload."""
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=env)
    response = bytearray()
    received = 0
    offset = 0
    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    try:
        for stream, event in ((process.stdin, selectors.EVENT_WRITE),
                              (process.stdout, selectors.EVENT_READ),
                              (process.stderr, selectors.EVENT_READ)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, event)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            require(remaining > 0, UNKNOWN)
            for key, event in selector.select(min(remaining, 1)):
                stream = key.fileobj
                if event == selectors.EVENT_WRITE:
                    try:
                        offset += os.write(stream.fileno(), payload[offset:offset + 65536])
                    except BrokenPipeError:
                        raise ClientError(UNKNOWN) from None
                    if offset == len(payload):
                        selector.unregister(stream)
                        stream.close()
                else:
                    block = os.read(stream.fileno(), 4096)
                    if not block:
                        selector.unregister(stream)
                        stream.close()
                        continue
                    received += len(block)
                    require(received <= MAX_RESPONSE, UNKNOWN)
                    if stream is process.stdout:
                        response.extend(block)
        remaining = deadline - time.monotonic()
        require(remaining > 0, UNKNOWN)
        require(process.wait(timeout=remaining) == 0, UNKNOWN)
        return bytes(response)
    except (OSError, subprocess.TimeoutExpired):
        raise ClientError(UNKNOWN) from None
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        process.wait()
        for stream in (process.stdin, process.stdout, process.stderr):
            if not stream.closed:
                stream.close()


def receipt(response, identity, check):
    try:
        require(len(response) <= MAX_RESPONSE, UNKNOWN)
        data = json.loads(response)
    except (ValueError, UnicodeError):
        raise ClientError(UNKNOWN) from None
    require(isinstance(data, dict) and data.get('status') == 'success', UNKNOWN)
    public = {'status': 'success'}
    for key in ('component', 'source_sha', 'pipeline_id', 'job_id'):
        require(type(data.get(key)) is type(identity[key]) and data.get(key) == identity[key], UNKNOWN)
        public[key] = identity[key]
    if check:
        require(data.get('readiness_verified') is True and data.get('deployment_performed') is False, UNKNOWN)
        public.update(readiness_verified=True, deployment_performed=False)
    else:
        require(data.get('health_verified') is True and data.get('version_verified') is True, UNKNOWN)
        public.update(health_verified=True, version_verified=True, deployment_performed=True)
    return public


def run(component, check, repo, env):
    identity = context(component, env)
    key = decode_key(env.get('Q_STAGING_SSH_KEY_B64', ''))
    known_hosts = repo / 'backend/deploy/ci_known_hosts'
    regular_bytes(known_hosts, 16384)
    output = repo / 'backend/.local/ci-deploy' / (component + '-receipt.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix='q-deploy-') as temporary:
        temp = Path(temporary)
        key_path = temp / 'identity'
        descriptor = os.open(key_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(key)
        archive = b''
        if not check:
            if component == 'api':
                path = repo / 'backend/.local/release' / ('q-release-' + identity['source_sha'] + '.tar.gz')
                validate_api(path, identity['source_sha'])
            else:
                path = temp / 'release.tar.gz'
                try:
                    subprocess.run([sys.executable, str(repo / 'web/deploy/deploy_tools.py'), 'package',
                                    '--repo', str(repo), '--dist', str(repo / 'web/dist'),
                                    '--sha', identity['source_sha'], '--pipeline-id', str(identity['pipeline_id']),
                                    '--output', str(path)], check=True, timeout=120,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   env=child_environment(env))
                except (OSError, subprocess.SubprocessError):
                    raise ClientError('Admin release packaging failed') from None
            archive = regular_bytes(path, MAX_ARCHIVE)
        header = {'version': 1, 'action': 'check' if check else 'deploy', **identity,
                  'archive_size': len(archive),
                  'archive_sha256': hashlib.sha256(archive).hexdigest() if archive else ''}
        line = json.dumps(header, separators=(',', ':')).encode() + b'\n'
        require(len(line) <= MAX_RESPONSE, 'Request header exceeds size budget')
        command = ['ssh', '-F', '/dev/null', '-T', '-i', str(key_path),
                   '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                   '-o', 'UserKnownHostsFile=' + str(known_hosts), '-o', 'IdentitiesOnly=yes',
                   '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=15',
                   '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
                   'qdeploy@8.163.108.216']
        try:
            response = exchange(command, line + archive, child_environment(env))
        except OSError:
            raise ClientError(UNKNOWN) from None
        result = receipt(response, identity, check)
        output.write_text(json.dumps(result, indent=2) + '\n')
    print('Receiver readiness verified; no deployment performed.' if check
          else 'Deployment health and source version verified.')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--component', choices=('api', 'admin'), required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        run(args.component, args.check, Path(__file__).resolve().parents[2], os.environ)
    except ClientError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError):
        print('Deployment client stopped; inspect job configuration and server state before retrying.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
