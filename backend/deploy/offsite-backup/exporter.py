#!/usr/bin/env python3
"""Root-owned fixed Q backup exporter. stdout is protocol data; no arbitrary paths."""
import fcntl
import hashlib
from contextlib import contextmanager, ExitStack
import stat
import os
from pathlib import Path
import re
import sys
import tarfile

BASE = Path('/var/backups/q')
STAMP = re.compile(r'\d{8}T\d{6}Z', re.ASCII)


def sha256_stream(source):
    digest = hashlib.sha256()
    while True:
        block = source.read(1024 * 1024)
        if not block:
            return digest.hexdigest()
        digest.update(block)


def sha256_path(path):
    with path.open('rb') as source:
        return sha256_stream(source)



@contextmanager
def opened_set(stamp, base=BASE, lock_path=Path('/run/lock/q-backup.lock'), owner=0):
    if not STAMP.fullmatch(stamp):
        raise ValueError('Invalid backup timestamp')
    paths = [base / f'q-db-{stamp}.dump', base / f'q-db-{stamp}.sha256',
             base / 'secrets' / f'q-secrets-{stamp}.env']
    with ExitStack() as stack:
        # Only hold the backup/prune lock while opening this immutable set. Open
        # descriptors survive unlink, and network stalls never skip daily backup.
        with lock_path.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_SH)
            sources = []
            for path in paths:
                source = stack.enter_context(os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb'))
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_mode & 0o077:
                    raise ValueError('Unsafe backup file permissions or ownership')
                sources.append(source)
        yield sources


def validate(sources):
    sources[1].seek(0)
    expected = sources[1].read(128).decode().strip()
    if not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise ValueError('Invalid checksum')
    sources[0].seek(0)
    if sha256_stream(sources[0]) != expected:
        raise ValueError('Backup checksum mismatch')
    for source in sources:
        source.seek(0)


def files(stamp, base=BASE, lock_path=Path('/run/lock/q-backup.lock'), owner=0):
    with opened_set(stamp, base, lock_path, owner) as sources:
        validate(sources)


def export(stamp, output, base=BASE, lock_path=Path('/run/lock/q-backup.lock'), owner=0):
    with opened_set(stamp, base, lock_path, owner) as sources:
        validate(sources)
        with tarfile.open(fileobj=output, mode='w|') as archive:
            for name, source in zip(['database.dump', 'database.sha256', 'deploy.env'], sources):
                info = tarfile.TarInfo(name)
                info.size = os.fstat(source.fileno()).st_size
                info.mode = 0o600
                archive.addfile(info, source)


def main():
    if os.geteuid() != 0:
        raise ValueError('Root required')
    if sys.argv[1:] == ['list']:
        for path in sorted(BASE.glob('q-db-*.dump')):
            stamp = path.name[5:-5]
            try:
                # Metadata-only listing avoids hashing every historical dump.
                with opened_set(stamp):
                    pass
            except (ValueError, OSError, UnicodeError):
                continue
            print(stamp)
    elif len(sys.argv) == 3 and sys.argv[1] == 'export':
        export(sys.argv[2], sys.stdout.buffer)
    else:
        raise ValueError('Use list or export TIMESTAMP')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, UnicodeError):
        print('Q backup export failed', file=sys.stderr)
        sys.exit(1)
