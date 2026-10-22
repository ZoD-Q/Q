#!/usr/bin/env python3
"""Pull matching server backup sets; only ciphertext is ever written locally."""
import argparse
import datetime as dt
import fcntl
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import sys

STAMP = re.compile(r'\d{8}T\d{6}Z', re.ASCII)
OUTPUT = re.compile(r'q-offsite-(\d{8}T\d{6}Z)\.tar\.age', re.ASCII)


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



def valid_existing(path):
    checksum = path.with_suffix(path.suffix + '.sha256')
    try:
        return (path.is_file() and not path.is_symlink() and checksum.is_file()
                and not checksum.is_symlink()
                and sha256_path(path) == checksum.read_text().strip())
    except (OSError, UnicodeError):
        return False


def publish(temp, destination):
    digest = sha256_path(temp)
    side = temp.with_suffix('.sha256')
    side.write_text(digest + '\n')
    os.chmod(side, 0o600)
    for path in [temp, side]:
        with path.open('rb') as stream:
            os.fsync(stream.fileno())
    # Ciphertext first; interrupted sidecar publication is safely retried.
    os.replace(temp, destination)
    os.replace(side, destination.with_suffix(destination.suffix + '.sha256'))
    # macOS and Linux support opening directories for durable rename metadata.
    directory = os.open(destination.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def pull(stamp, ssh, age, recipient, identity, destination):
    if not STAMP.fullmatch(stamp):
        raise ValueError('Invalid remote timestamp')
    final = destination / f'q-offsite-{stamp}.tar.age'
    if valid_existing(final):
        return
    with tempfile.TemporaryDirectory(prefix='.q-offsite-', dir=destination) as work:
        encrypted = Path(work) / 'encrypted.age'
        with encrypted.open('wb') as output:
            source = subprocess.Popen(ssh + ['sudo', '-n', '/usr/local/sbin/q-backup-export', 'export', stamp], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                encrypt = subprocess.run([age, '-R', str(recipient)], stdin=source.stdout, stdout=output, stderr=subprocess.DEVNULL, timeout=1800)
                source.stdout.close()
                status = source.wait(timeout=30)
                if status or encrypt.returncode or encrypted.stat().st_size == 0:
                    raise ValueError('Backup transfer or encryption failed')
            finally:
                if source.poll() is None:
                    source.kill()
                    source.wait()
        os.chmod(encrypted, 0o600)
        # Verify decryptability, tar paths, and database SHA without writing plaintext.
        subprocess.run([sys.executable, str(Path(__file__).with_name('verify.py')), '--age', age, '--identity', str(identity), str(encrypted)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800)
        publish(encrypted, final)


def transfer_sets(listing, ssh, age, recipient, identity, destination):
    failed = 0
    # A corrupt historical set must never starve the newest recovery point.
    for stamp in sorted(set(listing), reverse=True):
        try:
            pull(stamp, ssh, age, recipient, identity, destination)
        except Exception:
            failed += 1
            print('Q offsite backup set failed; remaining sets will continue', file=sys.stderr)
    return failed


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser()
    p.add_argument('--destination', type=Path, required=True)
    p.add_argument('--identity', type=Path, required=True)
    p.add_argument('--recipient', type=Path, required=True)
    p.add_argument('--age', required=True)
    args = p.parse_args()
    if not shutil.which(args.age) or not args.recipient.is_file():
        raise ValueError('Missing age or public recipient')
    args.destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.destination.is_symlink():
        raise ValueError('Destination must not be symlink')
    os.chmod(args.destination, 0o700)
    with (args.destination / '.q-offsite.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        ssh = ['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20', '-o', 'IdentitiesOnly=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', str(args.identity), 'ecs-user@8.163.108.216']
        listing = subprocess.run(ssh + ['sudo', '-n', '/usr/local/sbin/q-backup-export', 'list'], capture_output=True, timeout=120, check=True).stdout.decode().splitlines()
        failed = transfer_sets(listing, ssh, args.age, args.recipient, args.identity, args.destination)
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)
        for path in args.destination.iterdir():
            match = OUTPUT.fullmatch(path.name)
            if match and valid_existing(path) and dt.datetime.strptime(match[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc) < cutoff:
                path.unlink()
                path.with_suffix(path.suffix + '.sha256').unlink()
    if failed:
        raise ValueError('One or more backup sets failed')
    print('Q offsite backup pull completed')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Q offsite backup pull failed; next scheduled run will retry', file=__import__('sys').stderr)
        raise SystemExit(1)
