#!/usr/bin/env bash
# Run locally ON the staging server as root, with an independently reviewed source tree.
# Usage: sudo bash install-ci-receiver.sh /root/reviewed-q /root/qdeploy.pub
# Never uploads, generates credentials, changes application services, or merges code.
set -euo pipefail
[[ $EUID -eq 0 && $# == 2 ]] || { echo 'Usage (root): install-ci-receiver.sh REVIEWED_REPO PUBLIC_KEY_FILE' >&2; exit 2; }
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
exec /usr/bin/python3 -I - "$1" "$2" <<'PY'
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile

os.umask(0o077)
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
BASE = Path('/usr/local/lib/q-ci')
SERVICE_HOME = Path('/var/lib/q-ci-ssh')
STATE = Path('/var/lib/q/ci-deploy')
SUDOERS = Path('/etc/sudoers.d/q-ci-deploy')
COMMAND = '/usr/bin/sudo -n /usr/bin/python3 -I /usr/local/lib/q-ci/ci_receiver.py'
RULE = 'qdeploy ALL=(root) NOPASSWD: /usr/bin/python3 -I /usr/local/lib/q-ci/ci_receiver.py\n'
FILES = {
    'ci_receiver.py': 'backend/deploy/ci_receiver.py',
    'runtime/backup.sh': 'backend/deploy/backup.sh',
    'runtime/backup-policy.sh': 'backend/deploy/backup-policy.sh',
    'runtime/health-check.sh': 'backend/deploy/health-check.sh',
    'web/remote.sh': 'web/deploy/remote.sh',
    'web/deploy_tools.py': 'web/deploy/deploy_tools.py',
}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def trusted(path, directory=False):
    path = Path(path)
    st = path.lstat()
    require(st.st_uid == 0 and not st.st_mode & 0o022 and not stat.S_ISLNK(st.st_mode), 'Untrusted root path: ' + str(path))
    require(stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode), 'Unexpected file type: ' + str(path))
    for parent in path.parents:
        ps = parent.lstat()
        require(stat.S_ISDIR(ps.st_mode) and ps.st_uid == 0 and not ps.st_mode & 0o022, 'Untrusted parent: ' + str(parent))
    return path


def run(args, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV, timeout=30)
    require(result.returncode == 0, 'Validation command failed: ' + args[0])
    return result.stdout


def atomic(path, content, mode):
    fd, temporary = tempfile.mkstemp(prefix='.q-ci-install-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def directory(path, mode):
    if path.exists() or path.is_symlink():
        trusted(path, directory=True)
        require(stat.S_IMODE(path.stat().st_mode) == mode, 'Conflicting directory mode: ' + str(path))
    else:
        trusted(path.parent, directory=True)
        path.mkdir(mode=mode)
        path.chmod(mode)


def main():
    require(os.geteuid() == 0 and len(sys.argv) == 3, 'Root and two local paths required')
    repo = Path(sys.argv[1]).absolute()
    trusted(repo, directory=True)
    public_file = trusted(Path(sys.argv[2]).absolute())
    require(public_file.stat().st_size <= 8192, 'Public key too large')
    key_lines = public_file.read_text().splitlines()
    require(len(key_lines) == 1, 'Exactly one public key is required')
    match = re.fullmatch(r'ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?', key_lines[0])
    require(match is not None, 'Only an OpenSSH Ed25519 public key is accepted')
    raw = base64.b64decode(match[1], validate=True)
    require(len(raw) == 51 and raw[:19] == b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20', 'Invalid Ed25519 public key')
    public_key = ('ssh-ed25519 ' + match[1]).encode()
    key_line = ('restrict,command="' + COMMAND + '" ').encode() + public_key + b' q-ci-staging\n'
    contents = {target: trusted(repo / source).read_bytes() for target, source in FILES.items()}
    compile(contents['ci_receiver.py'], 'ci_receiver.py', 'exec')
    compile(contents['web/deploy_tools.py'], 'deploy_tools.py', 'exec')
    for target in ('runtime/backup.sh', 'runtime/backup-policy.sh', 'runtime/health-check.sh', 'web/remote.sh'):
        run(['/bin/bash', '-n'], data=contents[target])
    for command in ('/usr/bin/python3', '/usr/bin/sudo', '/usr/sbin/visudo', '/usr/sbin/useradd', '/usr/bin/ssh-keygen'):
        require(Path(command).is_file(), 'Required system tool missing: ' + command)
    # Existing runtime policy must already be reviewed. Installation never repairs it silently.
    current = Path('/opt/q/current')
    require(current.is_symlink() and current.lstat().st_uid == 0, 'Invalid Q current link')
    release = current.resolve(strict=True)
    require(release.parent == Path('/opt/q/releases'), 'Q current outside releases')
    policy = trusted(release / 'deploy/backup-policy.sh')
    require(policy.read_bytes() == contents['runtime/backup-policy.sh'],
            'Current backup policy differs: review/update it separately before installing CI')
    marker = BASE / 'installation.json'
    previous = None
    if BASE.exists() or BASE.is_symlink():
        trusted(BASE, directory=True)
        previous = json.loads(trusted(marker).read_bytes())
        require(previous.get('format') == 1 and previous.get('user') == 'qdeploy', 'Unmanaged receiver directory')
        require(previous.get('public_key_sha256') == hashlib.sha256(public_key).hexdigest(),
                'Key change requires a separate reviewed rotation')
        for target, digest in previous.get('files', {}).items():
            require(target in FILES and hashlib.sha256(trusted(BASE / target).read_bytes()).hexdigest() == digest,
                    'Installed helper changed; preserve operator changes and reconcile first')
        require(set(previous.get('files', {})) == set(FILES), 'Incomplete installation marker')
    try:
        account = pwd.getpwnam('qdeploy')
    except KeyError:
        account = None
    if account is not None:
        require(previous is not None and account.pw_dir == str(SERVICE_HOME) and account.pw_shell == '/bin/sh',
                'Existing qdeploy account is not managed by this installer')
        require(account.pw_uid != 0 and run(['/usr/bin/id', '-G', 'qdeploy']).decode().split() == [str(account.pw_gid)],
                'qdeploy has unexpected groups')
        shadow = run(['/usr/bin/getent', 'shadow', 'qdeploy']).decode().split(':')
        require(len(shadow) > 1 and shadow[1].startswith(('!', '*')), 'qdeploy password must remain locked')
    else:
        require(previous is None, 'Managed qdeploy account unexpectedly missing')
    for path, expected in ((SUDOERS, RULE.encode()), (SERVICE_HOME / '.ssh/authorized_keys', key_line)):
        if path.exists() or path.is_symlink():
            require(previous is not None and trusted(path).read_bytes() == expected,
                    'Conflicting access configuration: ' + str(path))
    if SERVICE_HOME.exists() or SERVICE_HOME.is_symlink():
        require(previous is not None, 'Unmanaged service home exists')
        trusted(SERVICE_HOME, directory=True)
    with tempfile.TemporaryDirectory(prefix='q-ci-install-', dir='/root') as temp:
        candidate = Path(temp) / 'sudoers'
        candidate.write_text(RULE)
        candidate.chmod(0o440)
        run(['/usr/sbin/visudo', '-cf', str(candidate)])
        key_check = Path(temp) / 'key.pub'
        key_check.write_bytes(public_key + b'\n')
        run(['/usr/bin/ssh-keygen', '-l', '-f', str(key_check)])
        # Shared deployment lock excludes installation from an in-progress release.
        lock_fd = os.open('/run/lock/q-ci-deploy.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            ls = os.fstat(lock_fd)
            require(ls.st_uid == 0 and stat.S_ISREG(ls.st_mode) and not ls.st_mode & 0o077, 'Untrusted deployment lock')
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            directory(BASE, 0o755)
            directory(BASE / 'runtime', 0o755)
            directory(BASE / 'web', 0o755)
            directory(SERVICE_HOME, 0o755)
            directory(SERVICE_HOME / '.ssh', 0o755)
            directory(STATE, 0o700)
            if account is None:
                run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home',
                     '--home-dir', str(SERVICE_HOME), '--shell', '/bin/sh', '--password', '!', 'qdeploy'])
            for target, content in contents.items():
                atomic(BASE / target, content, 0o755 if target.endswith('.sh') else 0o644)
            atomic(SUDOERS, RULE.encode(), 0o440)
            run(['/usr/sbin/visudo', '-c'])
            record = {'format': 1, 'user': 'qdeploy', 'public_key_sha256': hashlib.sha256(public_key).hexdigest(),
                      'files': {target: hashlib.sha256(content).hexdigest() for target, content in contents.items()}}
            atomic(marker, json.dumps(record, sort_keys=True).encode() + b'\n', 0o600)
            # Activation is last: no unforced key, no password, no user-writable home.
            atomic(SERVICE_HOME / '.ssh/authorized_keys', key_line, 0o644)
        finally:
            os.close(lock_fd)
    print('Q staging receiver installed. No application services changed. Verify live JOB-TOKEN check before deployment.')


try:
    main()
except Exception as error:
    # No credential contents or subprocess output are displayed.
    message = str(error) if isinstance(error, RuntimeError) else 'Installation failed; reconcile partial state before retrying.'
    print(message, file=sys.stderr)
    sys.exit(1)
PY
