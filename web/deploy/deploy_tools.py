#!/usr/bin/env python3
"""Small standard-library helpers for Q's explicit static demo release.

No business API, database, cloud SDK, or credential discovery belongs here.
"""

import argparse
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time


BASE = Path('/var/www/q-admin-demo')
SNIPPETS = Path('/etc/nginx/snippets/q-admin-demo')
CONFIGS = {
    'https': Path('/etc/nginx/conf.d/kai-c02-ip-https.conf'),
    'http': Path('/etc/nginx/conf.d/kai-cloud-web-ip-preview.conf'),
}
MAX_BYTES = 100 * 1024 * 1024
MAX_FILES = 4096
SHA = re.compile(r'[0-9a-f]{40}')
TRANSACTION = re.compile(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}-[0-9]+')
EXTENSIONS = {'.html', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg',
              '.webp', '.avif', '.gif', '.ico', '.woff', '.woff2', '.ttf',
              '.mp4', '.webm', '.txt', '.webmanifest'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular_file(path):
    require(path.is_file() and not path.is_symlink(), f'Expected regular file: {path}')
    return path.read_bytes()


def safe_asset_name(name):
    path = PurePosixPath(name)
    require(not path.is_absolute() and str(path) == name, 'Noncanonical asset path')
    require(all(part not in ('', '.', '..') and not part.startswith('.') for part in path.parts),
            'Hidden or traversing asset path')
    require(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_./-]*', name) is not None,
            f'Unsupported asset filename: {name}')
    require(path.suffix.lower() in EXTENSIONS, f'Unsupported artifact type: {name}')


def validate_version(data, sha, pipeline_id):
    version = json.loads(data)
    require(version.get('sha') == sha and SHA.fullmatch(sha), 'version.json SHA mismatch')
    require(version.get('mode') == 'demo', 'Only mode=demo may be published')
    require(version.get('sourceDirty') is False, 'Build must record sourceDirty=false')
    built_at = version.get('builtAt')
    require(isinstance(built_at, str), 'version.json must record builtAt')
    require(dt.datetime.fromisoformat(built_at.replace('Z', '+00:00')).tzinfo is not None,
            'builtAt must include a timezone')
    built_pipeline = version.get('pipelineId')
    require(built_pipeline in (None, '', 'local') or str(built_pipeline) == pipeline_id,
            'Build pipeline does not match the verified deployment pipeline')
    return version


def package(repo, dist, sha, pipeline_id, output):
    require(SHA.fullmatch(sha), 'Expected a full lowercase commit SHA')
    git = lambda *args: subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
    require(git('rev-parse', 'HEAD') == sha, 'Requested SHA must equal checked-out HEAD')
    require(not git('status', '--porcelain', '--untracked-files=all'), 'Worktree must be clean before packaging')
    require(dist.is_dir() and not dist.is_symlink(), 'dist must be a real directory')
    files = {}
    total = 0
    for path in sorted(dist.rglob('*')):
        require(not path.is_symlink(), 'Artifact contains a symlink')
        if path.is_dir():
            continue
        require(stat.S_ISREG(path.stat().st_mode), 'Artifact contains a special file')
        name = path.relative_to(dist).as_posix()
        safe_asset_name(name)
        data = path.read_bytes()
        total += len(data)
        require(total <= MAX_BYTES and len(files) < MAX_FILES, 'Artifact exceeds size/file budget')
        files[name] = data
    require('index.html' in files and 'version.json' in files, 'Missing index.html/version.json')
    validate_version(files['version.json'], sha, pipeline_id)
    require(b'/q-admin/' in files['index.html'], 'Build must use the /q-admin/ asset base')
    manifest = {'sha': sha, 'pipelineId': pipeline_id, 'mode': 'demo',
                'files': {name: digest(data) for name, data in files.items()}}
    with tarfile.open(output, 'w:gz') as archive:
        for name, data in [('release.json', json.dumps(manifest, sort_keys=True).encode()),
                           *[(f'public/q-admin/{name}', data) for name, data in files.items()]]:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(data))
    inspect_archive(output, sha, pipeline_id)


def inspect_archive(archive_path, sha, pipeline_id):
    """Return verified bytes; never hand untrusted names to tar extraction."""
    files = {}
    total = 0
    with tarfile.open(archive_path, 'r:gz') as archive:
        for member in archive:
            require(member.isfile() and not member.issym() and not member.islnk(),
                    'Only ordinary files are accepted in the release archive')
            require(member.name not in files and len(files) <= MAX_FILES, 'Duplicate/too many archive members')
            if member.name != 'release.json':
                require(member.name.startswith('public/q-admin/'), 'Archive path is outside the public prefix')
                safe_asset_name(member.name[len('public/q-admin/'):])
            require(0 <= member.size <= MAX_BYTES, 'Invalid archive member size')
            total += member.size
            require(total <= MAX_BYTES + 1024 * 1024, 'Unpacked archive exceeds budget')
            stream = archive.extractfile(member)
            require(stream is not None, 'Unreadable archive member')
            data = stream.read(member.size + 1)
            require(len(data) == member.size, 'Archive member length mismatch')
            files[member.name] = data
    require('release.json' in files, 'Missing release manifest')
    manifest = json.loads(files['release.json'])
    require(manifest.get('sha') == sha and manifest.get('pipelineId') == pipeline_id
            and manifest.get('mode') == 'demo', 'Release manifest identity mismatch')
    actual = {name[len('public/q-admin/'):]: digest(data) for name, data in files.items()
              if name != 'release.json'}
    require(actual == manifest.get('files'), 'Release file hashes do not match')
    require('index.html' in actual and 'version.json' in actual, 'Incomplete public files')
    validate_version(files['public/q-admin/version.json'], sha, pipeline_id)
    return files


def nginx_tokens(text):
    # Preserve source offsets; quotes/comments may contain braces or the word server.
    pattern = re.compile(r'\s+|\#[^\n]*|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[{};]|[^\s{};\#]+')
    return [(m.group(), m.start(), m.end()) for m in pattern.finditer(text)
            if not m.group().isspace() and not m.group().startswith('#')]


def insert_include(text, protocol):
    """Locate the unique IP server by direct server_name and listen directives."""
    tokens = nginx_tokens(text)
    candidates = []
    for index, token in enumerate(tokens[:-1]):
        if token[0] != 'server' or tokens[index + 1][0] != '{':
            continue
        depth = 1
        directives = []
        current = []
        end = index + 2
        while end < len(tokens) and depth:
            value = tokens[end][0]
            if value == '{':
                depth += 1
                current = []
            elif value == '}':
                depth -= 1
                current = []
            elif depth == 1:
                if value == ';':
                    directives.append(current)
                    current = []
                else:
                    current.append(value.strip('\"\''))
            end += 1
        require(depth == 0, 'Unbalanced existing Nginx configuration')
        names = [d[1:] for d in directives if d and d[0] == 'server_name']
        listens = [d[1] for d in directives if len(d) > 1 and d[0] == 'listen']
        port = '443' if protocol == 'https' else '80'
        if any('8.163.108.216' in name for name in names) and any(
                listen == port or listen.endswith(':' + port) for listen in listens):
            candidates.append((index, end, directives))
    require(len(candidates) == 1, f'Expected exactly one IP {protocol} server')
    index, end, directives = candidates[0]
    target = str(SNIPPETS / f'{protocol}.conf')
    occurrences = [d for d in directives if d and d[0] == 'include' and target in d[1:]]
    require(len(occurrences) <= 1, 'Duplicate Q include')
    if occurrences:
        return text
    block = text[tokens[index][1]:tokens[end - 1][2]]
    require('/q-admin' not in block, 'Existing /q-admin configuration requires manual review')
    offset = tokens[index + 1][2]
    return text[:offset] + f'\n    include {target}; # Q static demo only\n' + text[offset:]


def security_headers(cache):
    # Defining the complete set here deliberately prevents inheritance of another app's CSP.
    cache_always = '' if 'immutable' in cache else ' always'
    return f'''add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; media-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
    add_header Cache-Control "{cache}"{cache_always};'''


def snippet(protocol):
    headers = security_headers('no-store')
    if protocol == 'http':
        return f'''# Managed Q static demo. No other route is changed.
location = /q-admin {{
    {headers}
    return 308 https://8.163.108.216/q-admin/$is_args$args;
}}
location ^~ /q-admin/ {{
    {headers}
    return 308 https://8.163.108.216$request_uri;
}}
'''
    root = str(BASE / 'current/public')
    return f'''# Managed Q static demo. Files are public/q-admin/... inside each release.
location = /q-admin {{
    {headers}
    return 308 /q-admin/$is_args$args;
}}
location = /q-admin/version.json {{
    root {root};
    try_files $uri =404;
    {headers}
}}
location ^~ /q-admin/assets/ {{
    root {root};
    try_files $uri =404;
    {security_headers('public, max-age=31536000, immutable')}
}}
location ^~ /q-admin/ {{
    root {root};
    index index.html;
    try_files $uri /q-admin/index.html;
    {security_headers('no-cache')}
    # A missing file must not masquerade as the SPA document.
    location ~ \\.[^/]+$ {{
        try_files $uri =404;
    }}
}}
'''


def atomic_write(path, data, mode=0o644):
    descriptor, temporary = tempfile.mkstemp(prefix='.q-admin-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def state_path(transaction):
    require(TRANSACTION.fullmatch(transaction), 'Invalid transaction ID')
    return BASE / 'backups' / transaction / 'state.json'


def current_target():
    current = BASE / 'current'
    if not current.exists() and not current.is_symlink():
        return None
    require(current.is_symlink(), 'current must be a symlink, never a real directory')
    target = os.readlink(current)
    require(re.fullmatch(re.escape(str(BASE / 'releases')) + r'/[0-9a-f]{40}', target),
            'Existing current points outside managed releases')
    require(Path(target).is_dir() and not Path(target).is_symlink(), 'Existing release is invalid')
    return target


def switch_current(target):
    current = BASE / 'current'
    if target is None:
        current.unlink(missing_ok=True)
        return
    temporary = BASE / f'.current-{os.getpid()}'
    require(not temporary.exists() and not temporary.is_symlink(), 'Temporary current already exists')
    try:
        temporary.symlink_to(target)
        os.replace(temporary, current)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(upload, sha, checksum, pipeline_id, transaction):
    require(SHA.fullmatch(sha), 'Invalid SHA')
    require((upload / 'release.tar.gz').stat().st_size <= MAX_BYTES + 1024 * 1024,
            'Compressed archive exceeds budget')
    archive = regular_file(upload / 'release.tar.gz')
    require(digest(archive) == checksum, 'Uploaded archive checksum mismatch')
    files = inspect_archive(upload / 'release.tar.gz', sha, pipeline_id)
    for directory in [BASE, BASE / 'releases', BASE / 'backups', SNIPPETS]:
        require(not directory.is_symlink(), f'Managed directory is a symlink: {directory}')
        directory.mkdir(parents=True, exist_ok=True)
    previous = current_target()
    backup = state_path(transaction).parent
    backup.mkdir(mode=0o700)
    release = BASE / 'releases' / sha
    require(not release.is_symlink(), 'Release path cannot be a symlink')
    reuse_release = release.exists()
    if reuse_release:
        require(release.is_dir(), 'Existing release is not a directory')
        existing = {}
        for path in release.rglob('*'):
            require(not path.is_symlink(), 'Existing release contains a symlink')
            if not path.is_dir():
                existing[path.relative_to(release).as_posix()] = regular_file(path)
        require(existing == files, 'Existing SHA has different bytes; never overwrite an immutable release')
    targets = []
    for protocol, config in CONFIGS.items():
        original = regular_file(config)
        updated = insert_include(original.decode(), protocol).encode()
        targets.append((config, original, updated))
    for protocol in CONFIGS:
        target = SNIPPETS / f'{protocol}.conf'
        original = regular_file(target) if target.exists() or target.is_symlink() else None
        targets.append((target, original, snippet(protocol).encode()))
    records = []
    for index, (target, original, updated) in enumerate(targets):
        original_name = f'{index}.original'
        updated_name = f'{index}.updated'
        if original is not None:
            (backup / original_name).write_bytes(original)
        (backup / updated_name).write_bytes(updated)
        records.append({'path': str(target), 'original': original_name if original is not None else None,
                        'before': digest(original) if original is not None else None,
                        'updated': updated_name, 'after': digest(updated),
                        'mode': stat.S_IMODE(target.stat().st_mode) if original is not None else 0o644})
    # Extract only already-validated ordinary file names into a new staging directory.
    if not reuse_release:
        stage = Path(tempfile.mkdtemp(prefix='.release-', dir=BASE))
        try:
            for name, data in files.items():
                destination = stage / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
                destination.chmod(0o644)
            stage.chmod(0o755)
            os.replace(stage, release)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    state = {'sha': sha, 'pipelineId': pipeline_id, 'archiveSha256': checksum,
             'previous': previous, 'release': str(release), 'files': records}
    atomic_write(backup / 'state.json', json.dumps(state, indent=2).encode(), 0o600)


def load_state(transaction):
    path = state_path(transaction)
    state = json.loads(regular_file(path))
    require(SHA.fullmatch(state['sha']), 'Invalid saved SHA')
    require(state['release'] == str(BASE / 'releases' / state['sha']), 'Invalid saved release')
    allowed = {str(path) for path in CONFIGS.values()} | {
        str(SNIPPETS / 'http.conf'), str(SNIPPETS / 'https.conf')}
    require({record['path'] for record in state['files']} == allowed, 'Unexpected saved config paths')
    require(state['previous'] is None or re.fullmatch(
        re.escape(str(BASE / 'releases')) + r'/[0-9a-f]{40}', state['previous']), 'Invalid prior release')
    return path.parent, state


def assert_unchanged(record, allowed_hashes):
    target = Path(record['path'])
    current_hash = digest(regular_file(target)) if target.exists() or target.is_symlink() else None
    require(current_hash in allowed_hashes, f'Concurrent configuration change; stop rather than overwrite {target}')


def activate(transaction):
    backup, state = load_state(transaction)
    require(current_target() == state['previous'], 'Current release changed during preparation')
    for record in state['files']:
        assert_unchanged(record, [record['before']])
    # Snippets must exist before configurations refer to them.
    for record in reversed(state['files']):
        data = regular_file(backup / record['updated'])
        require(digest(data) == record['after'], 'Prepared config checksum mismatch')
        atomic_write(Path(record['path']), data, record['mode'])
    switch_current(state['release'])


def restore(transaction):
    backup, state = load_state(transaction)
    require(current_target() in (state['release'], state['previous']),
            'A different release is active; roll back the latest transaction first')
    # Preflight every path before restoring anything; preserve concurrent operators' changes.
    for record in state['files']:
        assert_unchanged(record, [record['before'], record['after']])
        if record['original'] is not None:
            require(digest(regular_file(backup / record['original'])) == record['before'],
                    'Original config backup checksum mismatch')
    switch_current(state['previous'])
    for record in state['files']:
        target = Path(record['path'])
        if record['original'] is None:
            target.unlink(missing_ok=True)
        else:
            atomic_write(target, regular_file(backup / record['original']), record['mode'])
    print(f'Restored prior static target: {state["previous"] or "none (first deployment)"}')


def complete(transaction):
    backup, state = load_state(transaction)
    require(current_target() == state['release'], 'Cannot mark an inactive release complete')
    state['localSmokePassedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
    atomic_write(backup / 'state.json', json.dumps(state, indent=2).encode(), 0o600)


def smoke(sha):
    def request(path, protocol='https', max_time=15):
        port = '443' if protocol == 'https' else '80'
        result = subprocess.run([
            'curl', '--silent', '--show-error', '--connect-timeout', str(min(2, max_time)),
            '--max-time', str(max_time), '--noproxy', '*',
            '--resolve', f'8.163.108.216:{port}:127.0.0.1',
            '--write-out', '\n%{http_code}', f'{protocol}://8.163.108.216{path}',
        ], check=True, capture_output=True)
        body, status_code = result.stdout.rsplit(b'\n', 1)
        return body, status_code.decode()

    # Nginx reload is graceful: old workers or a transient reset can precede readiness.
    # Retry only this static GET, within one wall-clock budget. TLS/configuration errors
    # fail immediately; never use curl's broad retry flags or bypass verification.
    deadline = time.monotonic() + 20
    last_result = 'no response'
    while True:
        remaining = deadline - time.monotonic()
        require(remaining > 0, f'Release not ready within 20 seconds: {last_result}; expected SHA {sha}')
        try:
            version, code = request('/q-admin/version.json', max_time=min(3, remaining))
            if code == '200':
                served = json.loads(version)
                require(isinstance(served, dict) and isinstance(served.get('sha'), str)
                        and SHA.fullmatch(served['sha']), 'Invalid served release metadata')
                if served['sha'] == sha:
                    break
                last_result = 'another release SHA is still being served'
            else:
                require(code == '404', f'Release readiness returned unexpected HTTP {code}')
                last_result = 'HTTP 404'
        except subprocess.CalledProcessError as error:
            # Connection refused, timeout, empty reply, or reset during the worker switch.
            if error.returncode not in (7, 28, 52, 56):
                raise
            last_result = f'curl transport exit {error.returncode}'
        remaining = deadline - time.monotonic()
        require(remaining > 0, f'Release not ready within 20 seconds: {last_result}; expected SHA {sha}')
        time.sleep(min(0.5, remaining))

    root, code = request('/q-admin/')
    require(code == '200' and b'/q-admin/' in root, 'Demo entry failed')
    deep, code = request('/q-admin/__deployment-smoke')
    require(code == '200' and deep == root, 'SPA deep link fallback failed')
    _, code = request('/q-admin/assets/__missing__.js')
    require(code == '404', 'Missing asset did not return 404')
    _, code = request('/q-admin/')
    require(code == '200', 'HTTPS entry failed')
    for path in ('/q-admin', '/q-admin/'):
        _, code = request(path, 'http')
        require(code == '308', 'HTTP demo redirect failed')
    print('Local Nginx smoke checks passed (TLS verified).')


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('package')
    for name in ('repo', 'dist', 'output'):
        command.add_argument('--' + name, type=Path, required=True)
    for name in ('sha', 'pipeline-id'):
        command.add_argument('--' + name, required=True)
    command = commands.add_parser('checksum')
    command.add_argument('path', type=Path)
    command = commands.add_parser('prepare')
    command.add_argument('--upload', type=Path, required=True)
    for name in ('sha', 'checksum', 'pipeline-id', 'transaction'):
        command.add_argument('--' + name, required=True)
    for name in ('activate', 'restore', 'complete'):
        command = commands.add_parser(name)
        command.add_argument('--transaction', required=True)
    command = commands.add_parser('smoke')
    command.add_argument('--sha', required=True)
    args = vars(parser.parse_args())
    command = args.pop('command')
    if command == 'checksum':
        print(digest(regular_file(args['path'])))
    else:
        globals()[command](**args)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, json.JSONDecodeError, tarfile.TarError,
            subprocess.CalledProcessError) as error:
        print(f'Q deployment stopped: {error}', file=sys.stderr)
        sys.exit(1)
