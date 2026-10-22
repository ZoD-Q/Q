#!/usr/bin/env python3
"""Decrypt to memory and verify fixed members and dump checksum; never print secrets."""
import argparse
import hashlib
import subprocess
import tarfile


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



def verify(stream):
    seen = set()
    dump_hash = expected = None
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            if member.name not in {'database.dump', 'database.sha256', 'deploy.env'} or member.name in seen or not member.isfile():
                raise ValueError('Invalid archive members')
            seen.add(member.name)
            if member.name == 'database.dump':
                dump_hash = sha256_stream(archive.extractfile(member))
                if member.size == 0:
                    raise ValueError('Empty database')
            else:
                if member.size > 1024 * 1024 or member.size == 0:
                    raise ValueError('Invalid metadata size')
                content = archive.extractfile(member).read()
                if member.name == 'database.sha256':
                    expected = content.decode().strip()
    if seen != {'database.dump', 'database.sha256', 'deploy.env'} or dump_hash != expected:
        raise ValueError('Incomplete archive or checksum mismatch')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--age', required=True)
    p.add_argument('--identity', required=True)
    p.add_argument('archive')
    a = p.parse_args()
    source = subprocess.Popen([a.age, '-d', '-i', a.identity, a.archive], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        verify(source.stdout)
        # Drain to EOF so age verifies authentication of the entire encrypted stream.
        while source.stdout.read(1024 * 1024):
            pass
        if source.wait(timeout=30):
            raise ValueError('Decryption failed')
    finally:
        source.stdout.close()
        if source.poll() is None:
            source.kill()
            source.wait()
    print('Encrypted Q archive and database checksum verified; PostgreSQL restore is a separate check')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Q archive verification failed', file=__import__('sys').stderr)
        raise SystemExit(1)
