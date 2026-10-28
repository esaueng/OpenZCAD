#!/usr/bin/env python3
"""Seal and verify complete snapshots with GnuPG; no custom cryptography.

The passphrase is supplied on an inherited descriptor, never argv or env.
Plaintext staging must be on a private tmpfs. Ciphertext may be stored on disk.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

from snapshot import SnapshotError, snapshot_metadata, verify_snapshot

MAX_ARCHIVE_BYTES = 4 * 1024**3
MEMBER = re.compile(r'(?:database\.sql|manifest\.json|metadata\.json|COMPLETE|objects/[0-9a-f]{64}\.bin)')


def ram_directory():
    root = Path('/dev/shm')
    if not any(line.split()[1:3] == ['/dev/shm', 'tmpfs']
               for line in Path('/proc/mounts').read_text().splitlines()):
        raise SnapshotError('Private tmpfs is required for plaintext staging.')
    # tmpfs pages can swap: accept only RAM compression or encrypted block swap.
    for line in Path('/proc/swaps').read_text().splitlines()[1:]:
        device = Path(line.split()[0]).resolve()
        if device.name.startswith('zram'):
            continue
        identity = Path('/sys/class/block') / device.name / 'dm/uuid'
        if not identity.is_file() or not identity.read_text().startswith('CRYPT-'):
            raise SnapshotError('Plaintext staging requires disabled or encrypted swap.')
    return tempfile.TemporaryDirectory(prefix='openzcad-recovery-', dir=root)


def gpg(source, destination, password, *, decrypt=False, home):
    if len(password) < 32 or b'\n' in password or b'\0' in password:
        raise SnapshotError('Use a separate random backup passphrase of at least 32 bytes.')
    if destination.exists():
        raise SnapshotError('Refusing to replace an existing recovery file.')
    reader, writer = os.pipe()
    try:
        os.write(writer, password + b'\n')
        os.close(writer)
        writer = None
        args = ['gpg', '--homedir', str(home), '--batch', '--no-tty', '--no-symkey-cache',
                '--pinentry-mode', 'loopback', '--passphrase-fd', str(reader),
                '--status-fd', '1', '--output', str(destination)]
        if decrypt:
            args += ['--decrypt']
        else:
            args += ['--symmetric', '--cipher-algo', 'AES256', '--force-mdc',
                     '--s2k-mode', '3', '--s2k-digest-algo', 'SHA512',
                     '--s2k-count', '65011712', '--compress-algo', 'none']
        result = subprocess.run(args + [str(source)], pass_fds=(reader,),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
        if result.returncode or (decrypt and (b'[GNUPG:] GOODMDC' not in result.stdout
                                             or b'[GNUPG:] DECRYPTION_OKAY' not in result.stdout)):
            raise SnapshotError('Encrypted snapshot authentication failed.')
    finally:
        os.close(reader)
        if writer is not None:
            os.close(writer)


def safe_extract(archive, destination):
    total = 0
    names = set()
    destination.mkdir(mode=0o700)
    (destination / 'objects').mkdir(mode=0o700)
    with tarfile.open(archive, 'r:') as tar:
        for member in tar:
            if (not member.isfile() or not MEMBER.fullmatch(member.name)
                    or member.name in names or member.size < 0):
                raise SnapshotError('Unsafe or duplicate archive member.')
            total += member.size
            if total > MAX_ARCHIVE_BYTES or len(names) >= 100000:
                raise SnapshotError('Recovery archive exceeds supported capacity.')
            names.add(member.name)
            source = tar.extractfile(member)
            fd = os.open(destination / member.name,
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as output, source:
                shutil.copyfileobj(source, output, 1024 * 1024)
    if not {'database.sql','manifest.json','metadata.json','COMPLETE'} <= names:
        raise SnapshotError('Recovery archive is incomplete.')
    manifest = verify_snapshot(destination)
    snapshot_metadata(destination, manifest)
    return manifest


def seal(snapshot, destination, password):
    manifest = verify_snapshot(snapshot)
    snapshot_metadata(snapshot, manifest)
    with ram_directory() as temporary:
        ram = Path(temporary)
        archive = ram / 'snapshot.tar'
        members = ['database.sql','manifest.json','metadata.json','COMPLETE']
        members += ['objects/' + path.name for path in sorted((snapshot / 'objects').iterdir())]
        size = sum((snapshot / member).lstat().st_size for member in members)
        if size > MAX_ARCHIVE_BYTES or size * 3 + 64*1024**2 > shutil.disk_usage(ram).free:
            raise SnapshotError('Insufficient RAM for encrypted backup verification.')
        with tarfile.open(archive, 'w:') as tar:
            for name in members:
                path = snapshot / name
                if path.is_symlink() or not path.is_file() or not MEMBER.fullmatch(name):
                    raise SnapshotError('Unsafe snapshot member.')
                tar.add(path, arcname=name, recursive=False)
        home = ram / 'gpg'
        home.mkdir(mode=0o700)
        gpg(archive, destination, password, home=home)
        # Read back, authenticate and rederive every SQL/object reference before success.
        decoded = ram / 'decoded.tar'
        gpg(destination, decoded, password, decrypt=True, home=home)
        restored = safe_extract(decoded, ram / 'restored')
        if restored != manifest:
            raise SnapshotError('Encrypted backup readback differs from its source.')
    # Readback can be satisfied from cache. Persist both ciphertext and its
    # directory entry before qualifying this as a durable local recovery point.
    fd = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return manifest


def unseal(source, destination, password):
    # Caller must keep destination inside private RAM, never expose restored sessions.
    if not str(destination.resolve()).startswith('/dev/shm/'):
        raise SnapshotError('Restore plaintext requires private tmpfs.')
    with ram_directory() as temporary:
        ram = Path(temporary)
        home = ram / 'gpg'
        home.mkdir(mode=0o700)
        decoded = ram / 'decoded.tar'
        gpg(source, decoded, password, decrypt=True, home=home)
        return safe_extract(decoded, destination)
