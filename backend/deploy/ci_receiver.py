#!/usr/bin/python3 -I
"""Root-owned forced-command receiver. Install with Python isolated mode (-I).

No caller paths, shell commands, config, or runtime helpers are accepted. A crash
leaves a pending receipt: an operator must reconcile it before another deploy.
"""
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import selectors
import time
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

API = 'https://gitlab.kai.com/api/v4'
CONFIG = Path('/etc/q/deploy.env')
CURRENT = Path('/opt/q/current')
RELEASES = Path('/opt/q/releases')
STATE = Path('/var/lib/q/ci-deploy')
LOCK = Path('/run/lock/q-ci-deploy.lock')
RUNTIME = Path('/usr/local/lib/q-ci/runtime')
WEB = Path('/usr/local/lib/q-ci/web')
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
FIELDS = {'version', 'action', 'component', 'source_sha', 'pipeline_id', 'job_id',
          'job_token', 'archive_size', 'archive_sha256'}
CHILD_ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
             'HOME': '/root', 'LANG': 'C.UTF-8'}


class Refused(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refused(code)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate_json_key')
        result[key] = value
    return result


def json_load(data):
    return json.loads(data, object_pairs_hook=unique_object)


def validate_request(r):
    require(isinstance(r, dict) and set(r) == FIELDS, 'invalid_fields')
    require(type(r['version']) is int and r['version'] == 1, 'invalid_version')
    require(r['action'] in ('deploy', 'check'), 'invalid_action')
    require(r['component'] in ('api', 'admin'), 'invalid_component')
    require(isinstance(r['source_sha'], str) and re.fullmatch('[0-9a-f]{40}', r['source_sha']), 'invalid_sha')
    for name in ('pipeline_id', 'job_id'):
        require(type(r[name]) is int and 0 < r[name] < 2**63, 'invalid_id')
    token = r['job_token']
    require(isinstance(token, str) and 1 <= len(token) <= 4096 and
            all(33 <= ord(c) <= 126 for c in token), 'invalid_token')
    require(type(r['archive_size']) is int, 'invalid_size')
    if r['action'] == 'check':
        require(r['archive_size'] == 0 and r['archive_sha256'] == '', 'invalid_check_payload')
    else:
        require(0 < r['archive_size'] <= MAX_ARCHIVE, 'invalid_size')
        require(isinstance(r['archive_sha256'], str) and re.fullmatch('[0-9a-f]{64}', r['archive_sha256']), 'invalid_digest')
    return r


def read_header(stream):
    line = stream.readline(16385)
    require(len(line) <= 16384 and line.endswith(b'\n'), 'invalid_header')
    return validate_request(json_load(line))


def read_archive(stream, r):
    remaining = r['archive_size']
    chunks = []
    while remaining:
        block = stream.read(min(remaining, 1024 * 1024))
        require(bool(block), 'truncated_archive')
        chunks.append(block)
        remaining -= len(block)
    require(stream.read(1) == b'', 'trailing_input')
    archive = b''.join(chunks)
    if r['action'] == 'deploy':
        require(hashlib.sha256(archive).hexdigest() == r['archive_sha256'], 'archive_digest_mismatch')
    return archive


def read_request(stream):
    r = read_header(stream)
    return r, read_archive(stream, r)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Refused('redirect_refused')


def fetch_json(url, token=None):
    headers = {'Accept': 'application/json'}
    if token is not None:
        headers['JOB-TOKEN'] = token
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(urllib.request.Request(url, headers=headers), timeout=15) as response:
        require(response.status == 200, 'unexpected_http_status')
        data = response.read(1024 * 1024 + 1)
        require(len(data) <= 1024 * 1024, 'response_too_large')
    return json_load(data)


def authorize(r, fetch=fetch_json):
    job = fetch(API + '/job', r['job_token'])
    pipeline = job.get('pipeline', {})
    require(job.get('id') == r['job_id'] and pipeline.get('id') == r['pipeline_id'], 'job_mismatch')
    require(pipeline.get('project_id') == 197, 'project_mismatch')
    require(job.get('ref') == pipeline.get('ref') == 'main' and job.get('tag') is False, 'ref_mismatch')
    require(job.get('commit', {}).get('id') == pipeline.get('sha') == r['source_sha'], 'commit_mismatch')
    require(job.get('status') == 'running', 'job_not_running')
    require(job.get('name') == 'deploy-staging-' + r['component'], 'job_name_mismatch')
    branches = fetch(API + '/projects/197/repository/branches?search=%5Emain%24', r['job_token'])
    require(isinstance(branches, list) and len(branches) == 1, 'branch_unavailable')
    branch = branches[0]
    require(branch.get('name') == 'main' and branch.get('protected') is True and
            branch.get('commit', {}).get('id') == r['source_sha'], 'main_advanced_or_unprotected')


def validate_linux_amd64(binary):
    require(len(binary) >= 64 and binary[:7] == b'\x7fELF\x02\x01\x01'
            and binary[7] in (0, 3), 'invalid_linux_amd64_binary')
    elf_type, machine, version = struct.unpack_from('<HHI', binary, 16)
    require(elf_type in (2, 3) and machine == 62 and version == 1
            and struct.unpack_from('<H', binary, 52)[0] == 64, 'invalid_linux_amd64_binary')


def unpack(archive, component, sha):
    with gzip.GzipFile(fileobj=io.BytesIO(archive)) as compressed:
        expanded = compressed.read(MAX_EXPANDED + 1)
    require(len(expanded) <= MAX_EXPANDED, 'expanded_archive_too_large')
    files = {}
    seen = set()
    total = 0
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as tar:
        for member in tar:
            name = member.name.rstrip('/') if member.isdir() else member.name
            path = PurePosixPath(name)
            require(name and not path.is_absolute() and str(path) == name and
                    all(part not in ('.', '..') for part in path.parts) and
                    re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_./-]*', name), 'unsafe_archive_path')
            require(name not in seen and len(seen) < (7 if component == 'api' else 2000),
                    'duplicate_or_many_members')
            seen.add(name)
            require(not member.pax_headers and (member.isfile() or member.isdir()), 'unsafe_archive_type')
            if member.isdir():
                require(component == 'api' and name == 'q-release', 'unexpected_directory')
                continue
            require(0 <= member.size <= MAX_EXPANDED, 'invalid_member_size')
            total += member.size
            require(total <= MAX_EXPANDED, 'expanded_archive_too_large')
            files[name] = tar.extractfile(member).read()
    if component == 'api':
        allowed = {'q-release/xiaoq-backend', 'q-release/SOURCE_COMMIT',
                   'q-release/SHA256SUMS', 'q-release/MIGRATIONS', 'q-release/BUILD_PROVENANCE',
                   'q-release/account-admin'}
        required = allowed - {'q-release/BUILD_PROVENANCE', 'q-release/account-admin'}
        require(required <= set(files) <= allowed, 'unexpected_api_files')
        require(files['q-release/SOURCE_COMMIT'].decode().strip() == sha, 'source_mismatch')
        hashes = {}
        for line in files['q-release/SHA256SUMS'].decode('ascii').splitlines():
            match = re.fullmatch(r'([0-9a-f]{64}) [ *](xiaoq-backend|account-admin|SOURCE_COMMIT|MIGRATIONS|BUILD_PROVENANCE)', line)
            require(match is not None and match[2] not in hashes, 'invalid_inner_manifest')
            hashes[match[2]] = match[1]
        require(set(hashes) == {n.removeprefix('q-release/') for n in files if not n.endswith('/SHA256SUMS')}, 'incomplete_inner_manifest')
        for name, digest in hashes.items():
            require(hashlib.sha256(files['q-release/' + name]).hexdigest() == digest, 'inner_digest_mismatch')
        migration_upgrade(files['q-release/MIGRATIONS'], b'')
        validate_linux_amd64(files['q-release/xiaoq-backend'])
        if 'q-release/account-admin' in files:
            validate_linux_amd64(files['q-release/account-admin'])
    return files


def trusted(path, directory=False, private=False):
    path = Path(path)
    st = path.lstat()
    require(not stat.S_ISLNK(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022,
            'untrusted_server_path')
    require(stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode), 'invalid_server_path')
    if private:
        require(not st.st_mode & 0o077, 'nonprivate_server_path')
    for parent in path.parents:
        pst = parent.lstat()
        require(stat.S_ISDIR(pst.st_mode) and pst.st_uid == 0 and not pst.st_mode & 0o022,
                'untrusted_parent')
    return path


def run(args, timeout=180):
    # Drain stdout incrementally: neither memory nor a log file can grow without bound.
    process = subprocess.Popen([str(a) for a in args], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env=CHILD_ENV, start_new_session=True)
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'server_command_timeout')
                for key, _ in selector.select(min(remaining, 1)):
                    block = os.read(key.fd, 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                        break
                    require(len(output) + len(block) <= 4 * 1024 * 1024, 'command_output_too_large')
                    output.extend(block)
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'server_command_timeout')
        require(process.wait(timeout=remaining) == 0, 'server_command_failed')
        return bytes(output)
    finally:
        # Kill descendants as well if a helper timed out or output exceeded its budget.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()


def compose(deploy=None, config=CONFIG):
    deploy = deploy or CURRENT.resolve() / 'deploy'
    return ['/usr/bin/docker', 'compose', '--env-file', str(config), '-f',
            str(deploy / 'compose.yaml'), '-p', 'q']


def current_release():
    trusted(RELEASES, directory=True)
    trusted(CONFIG, private=True)
    require(CURRENT.is_symlink() and CURRENT.lstat().st_uid == 0, 'invalid_current_link')
    release = CURRENT.resolve(strict=True)
    require(release.parent == RELEASES, 'current_outside_releases')
    trusted(release, directory=True)
    return release


def verify_tree(root):
    trusted(root, directory=True)
    for entry in root.iterdir():
        if entry.name == 'artifact':
            continue
        if entry.is_dir() and not entry.is_symlink():
            verify_tree(entry)
        else:
            trusted(entry)


def readiness(component):
    trusted(STATE, directory=True, private=True)
    old = current_release()
    verify_tree(old / 'deploy')
    for name in ('backup.sh', 'backup-policy.sh', 'health-check.sh'):
        trusted(RUNTIME / name)
    require((old / 'deploy' / 'backup-policy.sh').read_bytes() == (RUNTIME / 'backup-policy.sh').read_bytes(),
            'backup_policy_upgrade_required')
    if component == 'admin':
        for name in ('remote.sh', 'deploy_tools.py'):
            trusted(WEB / name)
        run(['/usr/sbin/nginx', '-t'])
    else:
        run(compose() + ['config', '--quiet'])
    run([RUNTIME / 'health-check.sh'])
    return old


def atomic_write(path, data):
    fd, name = tempfile.mkstemp(prefix='.q-ci-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def set_current(release):
    temp = CURRENT.parent / ('.q-ci-link-' + secrets.token_hex(8))
    os.symlink(str(release), temp)
    os.replace(temp, CURRENT)


def set_image(config, image):
    require(re.fullmatch('[a-zA-Z0-9_.-]+', image), 'invalid_image_tag')
    text = config.decode('utf-8')
    require(len(re.findall(r'^Q_RELEASE=', text, flags=re.M)) == 1, 'release_config_not_unique')
    return re.sub(r'^Q_RELEASE=.*$', 'Q_RELEASE=' + image, text, flags=re.M).encode()


def migrations():
    return run(compose() + ['exec', '-T', 'db', 'psql', '-X', '-U', 'q_admin', '-d', 'q', '-At',
                           '-v', 'ON_ERROR_STOP=1', '-c',
                           "SELECT version || ':' || encode(checksum,'hex') || ':' || success FROM _sqlx_migrations ORDER BY version;"])


def verify_api(release, image_tag, binary_hash):
    require(CURRENT.resolve() == release, 'release_link_mismatch')
    health = fetch_json('http://127.0.0.1:18787/health')
    require(health.get('status') == 'ok' and health.get('mode') == 'demo', 'health_mismatch')
    container = run(compose() + ['ps', '-q', 'api']).decode().strip()
    require(re.fullmatch('[0-9a-f]{12,64}', container), 'api_container_missing')
    expected = run(['/usr/bin/docker', 'image', 'inspect', '--format', '{{.Id}}', 'q-api:' + image_tag]).decode().strip()
    actual = run(['/usr/bin/docker', 'inspect', '--format', '{{.Image}}', container]).decode().strip()
    require(actual == expected and re.fullmatch('sha256:[0-9a-f]{64}', actual), 'image_mismatch')
    digest = run(['/usr/bin/docker', 'exec', container, '/usr/local/bin/busybox', 'sha256sum', '/proc/1/exe']).decode().split()[0]
    require(digest == binary_hash, 'running_binary_mismatch')
    run([RUNTIME / 'health-check.sh'])
    return actual


def receipt_path(r):
    return STATE / (str(r['pipeline_id']) + '-' + r['component'] + '-' + r['source_sha'] + '.json')


def save_receipt(path, receipt):
    atomic_write(path, (json.dumps(receipt, sort_keys=True) + '\n').encode())


def migration_upgrade(manifest, applied):
    planned = {}
    previous = 0
    require(0 < len(manifest) <= 1024 * 1024, 'invalid_migration_manifest_size')
    for line in manifest.decode('ascii').splitlines():
        match = re.fullmatch(r'([1-9][0-9]*) ([0-9a-f]{96})', line)
        require(match is not None, 'invalid_migration_manifest')
        version = int(match[1])
        require(version > previous and version < 2**63, 'unordered_migration_manifest')
        planned[version] = match[2]
        previous = version
    require(bool(planned), 'empty_migration_manifest')
    installed = set()
    for line in applied.decode('ascii').splitlines():
        match = re.fullmatch(r'([0-9]+):([0-9a-f]{96}):(true|t)', line)
        require(match is not None, 'invalid_applied_migration')
        version = int(match[1])
        require(version not in installed and planned.get(version) == match[2],
                'migration_downgrade_or_drift')
        installed.add(version)
    return bool(set(planned) - installed)


def stage_api_release(old, new, files):
    """Stage only validated payloads; a fresh artifact directory cannot inherit an old CLI."""
    require(not new.exists(), 'release_already_exists')
    new.mkdir(mode=0o700)
    shutil.copytree(old / 'deploy', new / 'deploy', ignore=lambda directory, names: ['artifact'] if 'artifact' in names else [])
    for name in ('backup.sh', 'backup-policy.sh', 'health-check.sh'):
        shutil.copy2(RUNTIME / name, new / 'deploy' / name)
    artifact = new / 'deploy' / 'artifact'
    artifact.mkdir(mode=0o700)
    binary = files['q-release/xiaoq-backend']
    (artifact / 'xiaoq-backend').write_bytes(binary)
    (artifact / 'xiaoq-backend').chmod(0o555)
    if 'q-release/account-admin' in files:
        (artifact / 'account-admin').write_bytes(files['q-release/account-admin'])
        (artifact / 'account-admin').chmod(0o555)
    release_meta = new / 'q-release'
    release_meta.mkdir(mode=0o700)
    for name, content in files.items():
        if name not in ('q-release/xiaoq-backend', 'q-release/account-admin'):
            (release_meta / name.split('/')[1]).write_bytes(content)


def perform_api(r, files, receipt, path):
    old = current_release()
    original_env = CONFIG.read_bytes()
    tag = 'ci-' + r['source_sha'] + '-' + r['archive_sha256'][:16]
    new = RELEASES / ('ci-' + str(r['pipeline_id']) + '-' + r['source_sha'] + '-' + r['archive_sha256'][:16])
    stage_api_release(old, new, files)
    binary = files['q-release/xiaoq-backend']
    candidate = new / 'build.env'
    candidate.write_bytes(set_image(original_env, tag))
    candidate.chmod(0o600)
    # The Dockerfile and compose configuration above came only from root-owned runtime.
    run(compose(new / 'deploy', candidate) + ['config', '--quiet'])
    run(compose(new / 'deploy', candidate) + ['build', '--pull=false', 'api'], timeout=600)
    candidate.unlink()
    authorize(r)  # main may have advanced during upload/build
    backup_result = run([RUNTIME / 'backup.sh'], timeout=900)
    marker = re.search(rb'^Q local backup completed: ([0-9]{8}T[0-9]{6}Z) ', backup_result, re.M)
    require(marker is not None, 'backup_not_completed')
    stamp = marker[1].decode('ascii')
    backup_dir = Path('/var/backups/q')
    dump = trusted(backup_dir / ('q-db-' + stamp + '.dump'), private=True)
    checksum = trusted(backup_dir / ('q-db-' + stamp + '.sha256'), private=True).read_text().strip()
    trusted(backup_dir / 'secrets' / ('q-secrets-' + stamp + '.env'), private=True)
    hasher = hashlib.sha256()
    with dump.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
    require(dump.stat().st_size > 0 and hasher.hexdigest() == checksum, 'backup_digest_mismatch')
    before = migrations()
    schema_upgrade = migration_upgrade(files['q-release/MIGRATIONS'], before)
    receipt.update(release=str(new), image_tag=tag, binary_sha256=hashlib.sha256(binary).hexdigest(),
                   previous_release=str(old), migration_sha256=hashlib.sha256(before).hexdigest(),
                   schema_upgrade=schema_upgrade, backup_stamp=stamp, backup_sha256=checksum)
    save_receipt(path, receipt)
    activate_api(r, old, new, original_env, tag, before, receipt, path)


def assert_active_state(release, config):
    trusted(CONFIG, private=True)
    require(CURRENT.is_symlink() and CURRENT.lstat().st_uid == 0 and
            CURRENT.resolve() == release and CONFIG.read_bytes() == config,
            'operator_state_changed')


def activate_api(r, old, new, original_env, tag, before, receipt, path):
    authorize(r)
    candidate_env = set_image(original_env, tag)
    # Root operators must take the same deployment lock. This CAS also detects edits
    # made while this receiver was building/backing up instead of silently replacing them.
    assert_active_state(old, original_env)
    env_written = False
    link_written = False
    try:
        atomic_write(CONFIG, candidate_env)
        env_written = True
        assert_active_state(old, candidate_env)
        set_current(new)
        link_written = True
        run(compose() + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'api', 'gateway'], timeout=240)
        assert_active_state(new, candidate_env)
        receipt['image_id'] = verify_api(new, tag, receipt['binary_sha256'])
    except Exception:
        # With pending migrations, even an unchanged SQLx history cannot prove that
        # no nontransactional DDL happened. Leave reconciliation to the operator.
        # Unknown history or concurrent operator edits also prevent ALL rollback.
        try:
            require(receipt.get('schema_upgrade') is False, 'schema_upgrade_requires_operator')
            assert_active_state(new if link_written else old,
                                candidate_env if env_written else original_env)
            require(migrations() == before, 'migration_state_changed')
            assert_active_state(new if link_written else old,
                                candidate_env if env_written else original_env)
            if env_written:
                atomic_write(CONFIG, original_env)
            if link_written:
                set_current(old)
            if env_written or link_written:
                run(compose() + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'api', 'gateway'], timeout=240)
                run([RUNTIME / 'health-check.sh'])
                receipt['status'] = 'rolled_back_requires_operator'
                save_receipt(path, receipt)
        except Exception:
            # Pending receipt survives; operator reconciliation is mandatory.
            pass
        raise


def verify_admin(r, files):
    base = Path('/var/www/q-admin-demo')
    current = base / 'current'
    require(current.is_symlink() and current.lstat().st_uid == 0 and
            current.resolve() == base / 'releases' / r['source_sha'], 'admin_target_mismatch')
    release = current.resolve()
    trusted(release, directory=True)
    for name, content in files.items():
        deployed = trusted(release / name)
        require(hashlib.sha256(deployed.read_bytes()).digest() == hashlib.sha256(content).digest(),
                'admin_artifact_mismatch')
    run(['/usr/bin/python3', '-I', WEB / 'deploy_tools.py', 'smoke', '--sha', r['source_sha']])


def perform_admin(r, archive):
    # Root-owned upload, never executable helpers from the submitted archive.
    upload = Path('/tmp/q-admin-demo.upload.' + secrets.token_hex(4))
    upload.mkdir(mode=0o700)
    try:
        (upload / 'release.tar.gz').write_bytes(archive)
        shutil.copy2(WEB / 'deploy_tools.py', upload / 'deploy_tools.py')
        authorize(r)
        run([WEB / 'remote.sh', 'deploy', r['source_sha'], r['archive_sha256'], str(r['pipeline_id']), upload], timeout=600)
        run(['/usr/bin/python3', '-I', WEB / 'deploy_tools.py', 'smoke', '--sha', r['source_sha']])
    finally:
        shutil.rmtree(upload)


def execute(r, archive):
    authorize(r)
    readiness(r['component'])
    if r['action'] == 'check':
        return {'status': 'success', 'action': 'check', 'component': r['component'],
                'source_sha': r['source_sha'], 'pipeline_id': r['pipeline_id'], 'job_id': r['job_id'],
                'readiness_verified': True, 'deployment_performed': False}
    files = unpack(archive, r['component'], r['source_sha'])
    require(STATE.exists(), 'receiver_not_bootstrapped')
    trusted(STATE, directory=True, private=True)
    fd = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW | os.O_CREAT, 0o600)
    try:
        st = os.fstat(fd)
        require(st.st_uid == 0 and stat.S_ISREG(st.st_mode) and not st.st_mode & 0o077, 'untrusted_lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        authorize(r)
        readiness(r['component'])
        path = receipt_path(r)
        previous = None
        for stored in STATE.glob('*.json'):
            trusted(stored, private=True)
            record = json_load(stored.read_bytes())
            require(record.get('status') == 'success', 'operator_reconciliation_required')
            if stored == path:
                previous = record
        if previous is not None:
            require(previous['archive_sha256'] == r['archive_sha256'], 'duplicate_artifact_mismatch')
            if r['component'] == 'api':
                verify_api(Path(previous['release']), previous['image_tag'], previous['binary_sha256'])
            else:
                verify_admin(r, files)
            previous.update(job_id=r['job_id'], duplicate=True)
            return previous
        receipt = {key: r[key] for key in ('component', 'source_sha', 'pipeline_id', 'job_id', 'archive_sha256')}
        receipt['status'] = 'pending_requires_operator'
        save_receipt(path, receipt)  # durable before any deployment side effect
        if r['component'] == 'api':
            perform_api(r, files, receipt, path)
        else:
            perform_admin(r, archive)
            verify_admin(r, files)
        receipt.update(status='success', health_verified=True, version_verified=True)
        save_receipt(path, receipt)
        return receipt
    finally:
        os.close(fd)


def main():
    os.umask(0o077)
    def expired(signum, frame):
        raise Refused('receiver_timeout')
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(30)  # small unauthenticated header budget
    try:
        require(os.geteuid() == 0 and len(sys.argv) == 1, 'invalid_invocation')
        # Ignore SSH_ORIGINAL_COMMAND, caller PATH, Docker settings and Python path.
        os.environ.clear()
        os.environ.update(CHILD_ENV)
        request = read_header(sys.stdin.buffer)
        authorize(request)  # Never accept a large body before validating the live job.
        signal.alarm(900)
        archive = read_archive(sys.stdin.buffer, request)
        signal.alarm(1800)
        result = execute(request, archive)
        print(json.dumps(result, sort_keys=True), flush=True)
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, Refused) else 'deployment_failed_requires_operator'
        print(json.dumps({'status': 'error', 'code': code}), flush=True)
        return 1
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    sys.exit(main())
