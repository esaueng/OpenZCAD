#!/usr/bin/env python3
"""Offline integrity checks for a paired D1/R2 recovery snapshot.

This inner format must be kept inside an authenticated, encrypted backup.
It neither supplies encryption nor authorizes a production restore.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import zlib

FORMAT = 'openzcad-cloud-recovery-v1'
MAX_SQL_BYTES = 512 * 1024 * 1024
MAX_OBJECT_BYTES = 100 * 1024 * 1024
MAX_LOGICAL_OBJECT_BYTES = 2 * 1024 * 1024 * 1024
OFFICIAL_DATABASE = '7263c6f1-8781-40d1-a0fa-ea03ce874ef2'
OFFICIAL_BUCKET = 'openzcad-beta-artifacts'
OBJECT_COLUMNS = {
    'artifacts': {'object_key'},
    'project_document_objects': {'object_key'},
    'project_storage_assets': {'object_key'},
    'e2ee_project_versions': {'envelope_key'},
    'e2ee_content_blobs': {'object_key'},
    'e2ee_share_snapshots': {'envelope_key'},
    # Transient work is retained in SQL but is not a committed object.
    'upload_sessions': {'object_key'},
    'artifact_mesh_discards': {'object_key'},
}


class SnapshotError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_private_file(path: Path, limit: int):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise SnapshotError('A snapshot file is not a bounded regular file.')
        result = file.read(limit + 1)
        if len(result) > limit:
            raise SnapshotError('Snapshot file exceeds its size limit.')
        return result


def object_path(root: Path, key: str):
    if not isinstance(key, str) or not key or '\0' in key or len(key.encode()) > 1024:
        raise SnapshotError('Invalid object key in the snapshot inventory.')
    # Original keys are data, never filesystem paths or command arguments.
    return root / 'objects' / (digest(key.encode()) + '.bin')


def load_sql(data: bytes):
    if len(data) > MAX_SQL_BYTES:
        raise SnapshotError('SQL export exceeds the supported size limit.')
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row

    def authorize(action, arg1, arg2, _database, _source):
        if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_PRAGMA and arg1.lower() not in {
            'foreign_keys', 'defer_foreign_keys', 'table_info', 'integrity_check',
            'foreign_key_check', 'foreign_key_list', 'query_only',
        }:
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION and (arg2 or '').lower() in {
            'load_extension', 'readfile', 'writefile',
        }:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    db.set_authorizer(authorize)
    try:
        db.executescript(data.decode('utf-8'))
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise SnapshotError('SQL export failed its integrity check.')
        if db.execute('PRAGMA foreign_key_check').fetchone() is not None:
            raise SnapshotError('SQL export has a broken foreign-key reference.')
        db.execute('PRAGMA query_only = ON')
        return db
    except (sqlite3.Error, UnicodeError):
        db.close()
        raise SnapshotError('SQL export is invalid or uses unsupported operations.') from None


def required_objects(db):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'd1_migrations' not in tables:
        raise SnapshotError('SQL export has no migration ledger.')
    migrations = [row[0] for row in db.execute('SELECT name FROM d1_migrations ORDER BY name')]
    if not migrations or any(not re.fullmatch(r'00[0-4][0-9]_[a-z0-9_]+\.sql', name) for name in migrations):
        raise SnapshotError('Unsupported migration ledger.')
    if max(int(name[:4]) for name in migrations) > 44:
        raise SnapshotError('Review new migrations before using this snapshot tool.')
    version = max(int(name[:4]) for name in migrations)
    reviewed = sorted(path.name for path in
                      (Path(__file__).resolve().parents[2] / 'apps/web/migrations').glob('*.sql')
                      if int(path.name[:4]) <= version)
    if migrations != reviewed:
        raise SnapshotError('Migration ledger is incomplete, duplicated or unrecognized.')
    required = {'users', 'projects', 'artifacts', 'upload_sessions'}
    if version >= 11:
        required.update({'project_document_objects', 'project_storage_assets'})
    if version >= 33:
        required.add('e2ee_project_versions')
    if version >= 34:
        required.update({'e2ee_content_blobs', 'e2ee_version_blobs'})
    if version >= 40:
        required.add('e2ee_share_snapshots')
    if required - tables:
        raise SnapshotError('SQL export is missing required storage tables.')
    for table in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        columns = {row[1] for row in db.execute('PRAGMA table_info(' + quoted + ')')}
        object_columns = {name for name in columns if 'object_key' in name or 'envelope_key' in name}
        if object_columns - OBJECT_COLUMNS.get(table, set()):
            raise SnapshotError('The SQL schema contains an unreviewed object reference.')

    references = {}

    def add_rows(table, key_column, where='', size=None, logical=False):
        if table not in tables:
            return
        rows = db.execute(f'SELECT * FROM {table}' + (f' WHERE {where}' if where else ''))
        for row in rows:
            key = row[key_column]
            if key is None:
                continue
            object_path(Path('.'), key)
            item = {'key': key}
            if size:
                item['bytes'] = row[size]
                if not isinstance(item['bytes'], int) or not 0 <= item['bytes'] <= MAX_OBJECT_BYTES:
                    raise SnapshotError('Invalid stored object size.')
            if logical:
                item.update(logicalBytes=row['logical_bytes'], logicalSha256=row['checksum_sha256'], encoding=row['content_encoding'])
                if (item['encoding'] != 'gzip' or not isinstance(item['logicalBytes'], int)
                        or not 0 <= item['logicalBytes'] <= MAX_LOGICAL_OBJECT_BYTES
                        or not re.fullmatch(r'[0-9a-f]{64}', item['logicalSha256'])):
                    raise SnapshotError('Invalid logical object integrity metadata.')
            previous = references.get(key)
            if previous is not None and previous != item:
                raise SnapshotError('Conflicting integrity metadata for one object.')
            references[key] = item

    add_rows('artifacts', 'object_key')
    add_rows('project_document_objects', 'object_key', "state='committed'", 'stored_bytes', True)
    add_rows('project_storage_assets', 'object_key', size='stored_bytes', logical=True)
    add_rows('e2ee_project_versions', 'envelope_key', size='envelope_bytes')
    add_rows('e2ee_content_blobs', 'object_key', "state='committed'", 'ciphertext_bytes')
    add_rows('e2ee_share_snapshots', 'envelope_key', size='envelope_bytes')
    if {'e2ee_version_blobs', 'e2ee_content_blobs'} <= tables:
        if db.execute('''SELECT 1 FROM e2ee_version_blobs v
                         JOIN e2ee_project_versions p ON p.project_id=v.project_id AND p.version_hash=v.version_hash
                         LEFT JOIN e2ee_content_blobs b ON b.project_id=v.project_id AND b.blob_id=v.blob_id
                         WHERE (p.envelope_key IS NOT NULL OR p.envelope_inline IS NOT NULL)
                           AND (b.blob_id IS NULL OR b.state != 'committed') LIMIT 1''').fetchone():
            raise SnapshotError('A retained version references a noncommitted blob.')
    return migrations, sorted(references.values(), key=lambda value: value['key'])


def inspect_object(root, reference):
    # The object directory itself must not be redirected through a symlink.
    if not stat.S_ISDIR((root / 'objects').lstat().st_mode):
        raise SnapshotError('Object storage directory is not a real directory.')
    path = object_path(root, reference['key'])
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    stored_hash = hashlib.sha256()
    logical_hash = hashlib.sha256()
    stored_size = logical_size = 0
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if reference.get('encoding') == 'gzip' else None
    with os.fdopen(fd, 'rb') as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise SnapshotError('An object is not a regular file.')
        while chunk := file.read(1024 * 1024):
            stored_size += len(chunk)
            if stored_size > reference.get('bytes', MAX_OBJECT_BYTES):
                raise SnapshotError('Stored object exceeds its declared size.')
            stored_hash.update(chunk)
            if decoder:
                try:
                    plain = decoder.decompress(chunk, reference['logicalBytes'] - logical_size + 1)
                except zlib.error:
                    raise SnapshotError('Invalid gzip object.') from None
                logical_size += len(plain)
                logical_hash.update(plain)
                if logical_size > reference['logicalBytes'] or decoder.unconsumed_tail:
                    raise SnapshotError('Object exceeds its logical size.')
    if 'bytes' in reference and stored_size != reference['bytes']:
        raise SnapshotError('Stored object size mismatch.')
    if decoder and (not decoder.eof or decoder.unused_data
                    or logical_size != reference['logicalBytes']
                    or logical_hash.hexdigest() != reference['logicalSha256']):
        raise SnapshotError('Logical object integrity check failed.')
    return {**reference, 'bytes': stored_size, 'storedSha256': stored_hash.hexdigest()}


def write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())


def complete_snapshot(root: Path, source):
    if (root / 'COMPLETE').exists() or (root / 'manifest.json').exists():
        raise SnapshotError('Use a fresh snapshot directory.')
    sql = read_private_file(root / 'database.sql', MAX_SQL_BYTES)
    db = load_sql(sql)
    try:
        migrations, references = required_objects(db)
        objects = [inspect_object(root, reference) for reference in references]
    finally:
        db.close()
    manifest = {'format': FORMAT, 'source': source, 'sqlSha256': digest(sql),
                'migrations': migrations, 'objects': objects}
    encoded = canonical(manifest)
    write_new(root / 'manifest.json', encoded)
    # Completion is last. This checksum is not a replacement for outer authentication.
    write_new(root / 'COMPLETE', digest(encoded).encode())
    return manifest


def verify_snapshot(root: Path):
    encoded = read_private_file(root / 'manifest.json', 64 * 1024 * 1024)
    marker = read_private_file(root / 'COMPLETE', 64)
    if marker != digest(encoded).encode():
        raise SnapshotError('Incomplete snapshot or changed manifest.')
    manifest = json.loads(encoded)
    if manifest.get('format') != FORMAT:
        raise SnapshotError('Unsupported snapshot format.')
    sql = read_private_file(root / 'database.sql', MAX_SQL_BYTES)
    if digest(sql) != manifest['sqlSha256']:
        raise SnapshotError('SQL export digest mismatch.')
    db = load_sql(sql)
    try:
        migrations, references = required_objects(db)
        actual = [inspect_object(root, reference) for reference in references]
    finally:
        db.close()
    if migrations != manifest['migrations'] or actual != manifest['objects']:
        raise SnapshotError('Snapshot references or object digests do not match.')
    return manifest


def validate_restore_target(source, target):
    prefix = 'openzcad-recovery-drill-'
    if not all(target.get(field, '').startswith(prefix) for field in ('worker', 'databaseName', 'bucket')):
        raise SnapshotError('Restore requires explicitly named disposable drill resources.')
    if target.get('database') in {source.get('database'), OFFICIAL_DATABASE}:
        raise SnapshotError('Restore must not target a source or production database.')
    if target.get('bucket') in {source.get('bucket'), OFFICIAL_BUCKET}:
        raise SnapshotError('Restore must not target a source or production bucket.')
    if not re.fullmatch(r'[0-9a-f-]{36}', target.get('database', '')):
        raise SnapshotError('Restore target database ID is missing or malformed.')
    expected = re.escape(target['worker']) + r'\.[a-z0-9-]+\.workers\.dev'
    if not re.fullmatch('https://' + expected, target.get('origin', '')):
        raise SnapshotError('Restore requires the disposable Worker HTTPS origin.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['complete', 'verify'])
    parser.add_argument('--snapshot-dir', required=True, type=Path)
    parser.add_argument('--source-json', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == 'complete':
        if args.source_json is None:
            parser.error('complete requires --source-json')
        source = json.loads(read_private_file(args.source_json, 65536))
        manifest = complete_snapshot(args.snapshot_dir, source)
    else:
        manifest = verify_snapshot(args.snapshot_dir)
    print(json.dumps({'status': 'verified', 'objects': len(manifest['objects']),
                      'storedBytes': sum(obj['bytes'] for obj in manifest['objects'])}))


if __name__ == '__main__':
    try:
        main()
    except (SnapshotError, OSError, KeyError, json.JSONDecodeError, sqlite3.Error) as error:
        # Object keys, SQL text and content never belong in normal output.
        raise SystemExit('Recovery verification failed: ' + type(error).__name__) from None
