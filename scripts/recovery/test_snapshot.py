import gzip
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from snapshot import (SnapshotError, canonical, complete_snapshot, digest, load_sql,
                      object_path, required_objects, validate_restore_target,
                      verify_snapshot)


SCHEMA = '''
CREATE TABLE d1_migrations(name TEXT);
INSERT INTO d1_migrations VALUES ('0001_initial.sql');
CREATE TABLE users(id TEXT);
CREATE TABLE projects(id TEXT);
CREATE TABLE artifacts(object_key TEXT);
CREATE TABLE upload_sessions(object_key TEXT);
CREATE TABLE project_document_objects(object_key TEXT, state TEXT, stored_bytes INTEGER,
 logical_bytes INTEGER, checksum_sha256 TEXT, content_encoding TEXT);
CREATE TABLE project_storage_assets(object_key TEXT, stored_bytes INTEGER,
 logical_bytes INTEGER, checksum_sha256 TEXT, content_encoding TEXT);
CREATE TABLE e2ee_project_versions(envelope_key TEXT, envelope_bytes INTEGER);
CREATE TABLE e2ee_content_blobs(object_key TEXT, state TEXT, ciphertext_bytes INTEGER);
CREATE TABLE e2ee_share_snapshots(envelope_key TEXT, envelope_bytes INTEGER);
CREATE TABLE artifact_mesh_discards(object_key TEXT);
'''
SOURCE = {'account': '1' * 32, 'database': '11111111-1111-4111-8111-111111111111',
          'bucket': 'source-bucket'}


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'objects').mkdir()
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.addCleanup(self.db.close)

    def sql(self):
        self.db.commit()
        (self.root / 'database.sql').write_text('\n'.join(self.db.iterdump()))

    def object(self, key, data):
        object_path(self.root, key).write_bytes(data)

    def complete(self):
        self.sql()
        return complete_snapshot(self.root, SOURCE)

    def test_all_persistent_reference_classes_and_safe_key_mapping(self):
        for key in ['legacy', '../../escape', 'unicode/\u2713', 'cipher', 'snapshot']:
            self.object(key, b'data')
        self.db.execute('INSERT INTO artifacts VALUES (?)', ('legacy',))
        plain = b'logical content'
        encoded = gzip.compress(plain)
        self.object('../../escape', encoded)
        self.object('unicode/\u2713', encoded)
        values = (len(encoded), len(plain), digest(plain), 'gzip')
        self.db.execute('INSERT INTO project_document_objects VALUES (?, ?, ?, ?, ?, ?)',
                        ('../../escape', 'committed', *values))
        self.db.execute('INSERT INTO project_storage_assets VALUES (?, ?, ?, ?, ?)',
                        ('unicode/\u2713', *values))
        self.db.execute('INSERT INTO e2ee_content_blobs VALUES (?, ?, ?)', ('cipher', 'committed', 4))
        self.db.execute('INSERT INTO e2ee_project_versions VALUES (?, ?)', ('cipher', 4))
        self.db.execute('INSERT INTO e2ee_share_snapshots VALUES (?, ?)', ('snapshot', 4))
        manifest = self.complete()
        self.assertEqual(len(manifest['objects']), 5)
        self.assertEqual(verify_snapshot(self.root), manifest)
        self.assertNotEqual(digest(encoded), digest(plain))
        self.assertEqual(object_path(self.root, '../../escape').parent, self.root / 'objects')

    def test_transient_work_does_not_require_completed_objects(self):
        self.db.execute("INSERT INTO upload_sessions VALUES ('pending')")
        self.db.execute("INSERT INTO artifact_mesh_discards VALUES ('discard')")
        self.db.execute("INSERT INTO project_document_objects VALUES ('pending', 'pending', 1, 1, ?, 'gzip')", ('0' * 64,))
        self.db.execute("INSERT INTO e2ee_content_blobs VALUES ('deleting', 'deleting', 1)")
        self.assertEqual(self.complete()['objects'], [])

    def test_missing_required_object_never_completes(self):
        self.db.execute("INSERT INTO artifacts VALUES ('missing')")
        with self.assertRaises(OSError):
            self.complete()
        self.assertFalse((self.root / 'COMPLETE').exists())

    def test_changed_stored_bytes_are_detected(self):
        self.db.execute("INSERT INTO artifacts VALUES ('file')")
        self.object('file', b'first')
        self.complete()
        self.object('file', b'other')
        with self.assertRaises(SnapshotError):
            verify_snapshot(self.root)

    def test_changed_sql_and_manifest_are_detected(self):
        self.complete()
        (self.root / 'database.sql').write_bytes(b'SELECT 1;')
        with self.assertRaisesRegex(SnapshotError, 'SQL export digest'):
            verify_snapshot(self.root)
        (self.root / 'manifest.json').write_bytes(b'{}')
        with self.assertRaisesRegex(SnapshotError, 'changed manifest'):
            verify_snapshot(self.root)

    def test_incomplete_snapshot_is_refused(self):
        self.complete()
        (self.root / 'COMPLETE').unlink()
        with self.assertRaises(OSError):
            verify_snapshot(self.root)

    def test_unsupported_schema_and_unknown_object_reference_are_refused(self):
        self.db.execute("CREATE TABLE future(object_key TEXT)")
        self.sql()
        with self.assertRaisesRegex(SnapshotError, 'unreviewed object reference'):
            complete_snapshot(self.root, SOURCE)

    def test_unreviewed_migration_is_refused(self):
        self.db.execute("INSERT INTO d1_migrations VALUES ('0045_future.sql')")
        self.sql()
        with self.assertRaises(SnapshotError):
            complete_snapshot(self.root, SOURCE)

    def test_missing_runtime_tables_are_refused(self):
        self.db.execute("INSERT INTO d1_migrations VALUES ('0040_e2ee_share_links.sql')")
        self.sql()
        with self.assertRaises(SnapshotError):
            complete_snapshot(self.root, SOURCE)

    def test_missing_and_duplicate_migrations_are_refused(self):
        for name in ['0003_provider_settings.sql', '0001_initial.sql']:
            with self.subTest(name=name):
                self.db.execute('INSERT INTO d1_migrations VALUES (?)', (name,))
                self.sql()
                with self.assertRaises(SnapshotError):
                    complete_snapshot(self.root, SOURCE)
                self.db.execute('DELETE FROM d1_migrations WHERE rowid=(SELECT MAX(rowid) FROM d1_migrations)')

    def test_foreign_key_holes_are_refused(self):
        with self.assertRaisesRegex(SnapshotError, 'foreign-key'):
            load_sql(b'CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(p REFERENCES p(id)); INSERT INTO c VALUES(1);')

    def test_retained_versions_require_committed_blob_rows(self):
        self.db.executescript('''
          ALTER TABLE e2ee_project_versions ADD COLUMN project_id TEXT;
          ALTER TABLE e2ee_project_versions ADD COLUMN version_hash TEXT;
          ALTER TABLE e2ee_project_versions ADD COLUMN envelope_inline TEXT;
          ALTER TABLE e2ee_content_blobs ADD COLUMN project_id TEXT;
          ALTER TABLE e2ee_content_blobs ADD COLUMN blob_id TEXT;
          CREATE TABLE e2ee_version_blobs(project_id TEXT,version_hash TEXT,blob_id TEXT);
          INSERT INTO e2ee_project_versions VALUES(NULL,4,'project','version','inline');
          INSERT INTO e2ee_version_blobs VALUES('project','version','blob');
        ''')
        with self.assertRaisesRegex(SnapshotError, 'noncommitted blob'):
            required_objects(self.db)
        self.db.execute("INSERT INTO e2ee_content_blobs VALUES('cipher','deleting',4,'project','blob')")
        with self.assertRaisesRegex(SnapshotError, 'noncommitted blob'):
            required_objects(self.db)
        self.db.execute("UPDATE e2ee_content_blobs SET state='committed'")
        self.object('cipher', b'data')
        self.assertEqual(len(self.complete()['objects']),1)

    def test_export_cannot_attach_files_or_change_sqlite_safety(self):
        for sql in [b"ATTACH DATABASE '/tmp/forbidden-recovery.sqlite' AS other;",
                    b'PRAGMA writable_schema=ON;', b"SELECT load_extension('bad');"]:
            with self.subTest(sql=sql), self.assertRaises(SnapshotError):
                load_sql(sql)

    def test_broken_gzip_wrong_logical_hash_and_size_are_refused(self):
        for data, logical_size, logical_hash in [
            (b'not gzip', 3, digest(b'abc')),
            (gzip.compress(b'abc'), 3, digest(b'bad')),
            (gzip.compress(b'abc'), 2, digest(b'abc')),
            (gzip.compress(b'abc')[:-1], 3, digest(b'abc')),
            (gzip.compress(b'abc') + b'extra', 3, digest(b'abc')),
        ]:
            with self.subTest(size=logical_size, data=data):
                self.db.execute('DELETE FROM project_storage_assets')
                self.db.execute('INSERT INTO project_storage_assets VALUES (?, ?, ?, ?, ?)',
                                ('bad', len(data), logical_size, logical_hash, 'gzip'))
                self.object('bad', data)
                self.sql()
                with self.assertRaises(SnapshotError):
                    complete_snapshot(self.root, SOURCE)
                self.assertFalse((self.root / 'COMPLETE').exists())

    def test_file_and_directory_symlinks_are_refused(self):
        self.db.execute("INSERT INTO artifacts VALUES ('file')")
        object_path(self.root, 'file').symlink_to('/etc/hostname')
        with self.assertRaises(OSError):
            self.complete()
        object_path(self.root, 'file').unlink()
        (self.root / 'objects').rmdir()
        (self.root / 'objects').symlink_to(self.root)
        with self.assertRaises(SnapshotError):
            self.complete()

    def test_existing_snapshot_is_never_replaced(self):
        self.complete()
        before = (self.root / 'manifest.json').read_bytes()
        with self.assertRaises(SnapshotError):
            complete_snapshot(self.root, SOURCE)
        self.assertEqual((self.root / 'manifest.json').read_bytes(), before)

    def test_restore_target_requires_separate_disposable_resources(self):
        worker = 'openzcad-recovery-drill-test'
        target = {'worker': worker, 'databaseName': worker, 'bucket': worker,
                  'database': '22222222-2222-4222-8222-222222222222',
                  'origin': f'https://{worker}.example.workers.dev'}
        validate_restore_target(SOURCE, target)
        for field, value in [('database', SOURCE['database']),
                             ('database', '7263c6f1-8781-40d1-a0fa-ea03ce874ef2'),
                             ('bucket', 'openzcad-beta-artifacts'), ('worker', 'openzcad'),
                             ('origin', 'https://zcad.app'), ('origin', 'http://'+worker+'.example.workers.dev')]:
            with self.subTest(field=field), self.assertRaises(SnapshotError):
                validate_restore_target(SOURCE, {**target, field: value})

    def test_current_repository_migrations_import(self):
        root = Path(__file__).resolve().parents[2]
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        paths = sorted((root / 'apps/web/migrations').glob('*.sql'))
        for path in paths:
            db.executescript(path.read_text())
        db.execute('CREATE TABLE d1_migrations(name TEXT)')
        db.executemany('INSERT INTO d1_migrations VALUES (?)', [(path.name,) for path in paths])
        loaded = load_sql('\n'.join(db.iterdump()).encode())
        self.addCleanup(loaded.close)
        self.assertEqual(len(required_objects(loaded)[0]), len(paths))


if __name__ == '__main__':
    unittest.main()
