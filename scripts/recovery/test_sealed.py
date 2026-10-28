import io
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from cloud import Source, stored_representation_matches, owner_only_file
from sealed import gpg, ram_directory, safe_extract, seal, unseal
from snapshot import MAX_METADATA_BYTES, MAX_OBJECT_BYTES, SnapshotError, complete_snapshot
from restore import database_state
from test_snapshot import SCHEMA, SOURCE


class RamPolicyTests(unittest.TestCase):
    def test_plaintext_staging_requires_tmpfs_and_safe_swap(self):
        mounts = 'tmpfs /dev/shm tmpfs rw 0 0\n'
        header = 'Filename Type Size Used Priority\n'
        for mounted, device, identity, allowed in [
            (False, None, None, False),
            (True, None, None, True),
            (True, 'zram0', None, True),
            (True, 'sda2', None, False),
            (True, 'swapfile', None, False),
            (True, 'dm-0', 'LVM-unencrypted', False),
            (True, 'dm-0', 'CRYPT-PLAIN-cryptswap', True),
            (True, 'dm-0', 'CRYPT-LUKS2-test', True),
        ]:
            with self.subTest(mounted=mounted, device=device, identity=identity):
                files = {'/proc/mounts': mounts if mounted else '',
                         '/proc/swaps': header + (f'/dev/{device} partition 1024 0 -2\n' if device else '')}
                if identity is not None:
                    files[f'/sys/class/block/{device}/dm/uuid'] = identity
                def read(path):
                    return files[str(path)]
                with patch.object(Path, 'read_text', read), \
                     patch.object(Path, 'is_file', lambda path: str(path) in files), \
                     patch('sealed.tempfile.TemporaryDirectory') as allocate:
                    if allowed:
                        self.assertIs(ram_directory(), allocate.return_value)
                        allocate.assert_called_once_with(prefix='openzcad-recovery-', dir=Path('/dev/shm'))
                    else:
                        with self.assertRaises(SnapshotError):
                            ram_directory()
                        allocate.assert_not_called()


class SealedTests(unittest.TestCase):
    def setUp(self):
        # These archives contain only synthetic fixtures and public test keys.
        # Exercise the host staging policy separately, without requiring CI's
        # swap configuration to qualify it for handling production plaintext.
        def synthetic_ram():
            return tempfile.TemporaryDirectory(prefix='openzcad-recovery-test-', dir='/dev/shm')
        allocator = patch('sealed.ram_directory', synthetic_ram)
        allocator.start()
        self.addCleanup(allocator.stop)
        self.temporary = synthetic_ram()
        self.addCleanup(self.temporary.cleanup)
        self.ram = Path(self.temporary.name)
        self.root = self.ram/'snapshot'
        self.root.mkdir(mode=0o700)
        (self.root/'objects').mkdir(mode=0o700)
        db = sqlite3.connect(':memory:')
        db.executescript(SCHEMA)
        (self.root/'database.sql').write_text('\n'.join(db.iterdump()))
        db.close()
        (self.root/'metadata.json').write_text(json.dumps({'objects':{}}))
        complete_snapshot(self.root,SOURCE)
        self.password = b'a separate random test passphrase 0123456789'

    def test_encrypted_roundtrip_and_independent_verify(self):
        archive = self.ram/'backup.gpg'
        expected = seal(self.root,archive,self.password)
        self.assertNotIn(b'CREATE TABLE',archive.read_bytes())
        self.assertEqual(unseal(archive,self.ram/'restored',self.password),expected)
        self.assertEqual((self.ram/'restored/metadata.json').read_bytes(),
                         (self.root/'metadata.json').read_bytes())

    def test_oversized_metadata_is_refused_before_sealing(self):
        archive = self.ram/'refused.gpg'
        with (self.root/'metadata.json').open('wb') as file:
            file.truncate(MAX_METADATA_BYTES+1)
        with patch('sealed.gpg') as encrypt:
            with self.assertRaises(SnapshotError):
                seal(self.root,archive,self.password)
            encrypt.assert_not_called()
        self.assertFalse(archive.exists())

    def test_extracted_metadata_uses_the_same_bound_and_reference_check(self):
        for index, value in enumerate([{'objects':{},'padding':'synthetic'},
                                       {'objects':{'unreferenced':{}}}]):
            (self.root/'metadata.json').write_text(json.dumps(value))
            archive = self.ram/f'metadata-{index}.tar'
            with tarfile.open(archive,'w:') as tar:
                for name in ['database.sql','metadata.json','manifest.json','COMPLETE']:
                    tar.add(self.root/name,arcname=name)
            with patch('snapshot.MAX_METADATA_BYTES', 20 if index==0 else MAX_METADATA_BYTES):
                with self.assertRaises(SnapshotError):
                    safe_extract(archive,self.ram/f'metadata-output-{index}')

    def test_wrong_password_tamper_and_truncation_never_extract(self):
        archive = self.ram/'backup.gpg'
        seal(self.root,archive,self.password)
        data = archive.read_bytes()
        for index,(encoded,password) in enumerate([
            (data,b'wrong but sufficiently long test passphrase'),
            (data[:-12],self.password),
            (data[:-10]+bytes([data[-10]^1])+data[-9:],self.password),
        ]):
            with self.subTest(index=index):
                changed = self.ram/f'changed-{index}.gpg'
                changed.write_bytes(encoded)
                target = self.ram/f'refused-{index}'
                with self.assertRaises(SnapshotError):
                    unseal(changed,target,password)
                self.assertFalse(target.exists())

    def test_unsafe_duplicate_link_and_excessive_members_are_refused(self):
        for index,name in enumerate(['../escape','/absolute','objects/../escape','database.sql']):
            archive=self.ram/f'unsafe-{index}.tar'
            with tarfile.open(archive,'w:') as tar:
                member=tarfile.TarInfo(name)
                member.size=1
                tar.addfile(member,io.BytesIO(b'x'))
                if name=='database.sql':
                    tar.addfile(member,io.BytesIO(b'x'))
            with self.subTest(name=name),self.assertRaises(SnapshotError):
                safe_extract(archive,self.ram/f'output-{index}')
        archive=self.ram/'link.tar'
        with tarfile.open(archive,'w:') as tar:
            member=tarfile.TarInfo('database.sql')
            member.type=tarfile.SYMTYPE
            member.linkname='/etc/passwd'
            tar.addfile(member)
        with self.assertRaises(SnapshotError):
            safe_extract(archive,self.ram/'linked')

    def test_source_client_cannot_mutate_source_or_other_resources(self):
        client=Source(SOURCE,'read-token','export-token')
        for method,path in [('DELETE',client.r2+'/key'),('PUT',client.r2+'/key'),
                            ('POST',client.d1+'/query'),('POST',client.d1+'/import'),
                            ('GET','/accounts/'+SOURCE['account']+'/workers/scripts')]:
            with self.subTest(method=method,path=path),self.assertRaises(SnapshotError):
                client.request(method,path)

    def test_changed_etag_or_metadata_invalidates_source_copy(self):
        db=sqlite3.connect(self.root/'fixture.sqlite')
        db.executescript(SCHEMA)
        db.execute("INSERT INTO artifacts VALUES('fixture')")
        (self.root/'database.sql').write_text('\n'.join(db.iterdump()))
        db.close()
        item={'key':'fixture','size':4,'etag':'first','http_metadata':{},'custom_metadata':{}}
        client=Source(SOURCE,'read-token','export-token')
        with patch.object(client,'inventory',return_value={'fixture':item}),\
             patch.object(client,'request',return_value=(b'data',{'etag':'"changed"'})):
            with self.assertRaises(SnapshotError):client.copy(self.root)

        changed={**item,'http_metadata':{'contentType':'changed'}}
        with patch.object(client,'inventory',side_effect=[{'fixture':item},{'fixture':changed}]),\
             patch.object(client,'request',return_value=(b'data',{'etag':'"first"'})):
            with self.assertRaises(SnapshotError):client.copy(self.root)

    def test_source_copy_preserves_stored_gzip_representation(self):
        db=sqlite3.connect(':memory:')
        db.executescript(SCHEMA)
        db.execute("INSERT INTO artifacts VALUES('fixture')")
        (self.root/'database.sql').write_text('\n'.join(db.iterdump()))
        db.close()
        data=gzip.compress(b'synthetic stored representation')
        item={'key':'fixture','size':len(data),'etag':'stored',
              'http_metadata':{'contentEncoding':'gzip'},'custom_metadata':{}}
        client=Source(SOURCE,'read-token','export-token')
        def fetch(method,path,**kwargs):
            self.assertEqual(kwargs['headers']['Accept-Encoding'],'gzip')
            return data,{'etag':'"stored"'}
        with patch.object(client,'inventory',return_value={'fixture':item}),\
             patch.object(client,'request',side_effect=fetch):
            client.copy(self.root)
        from snapshot import object_path
        self.assertEqual(object_path(self.root,'fixture').read_bytes(),data)

    def test_weak_http_tag_requires_exact_single_part_stored_bytes(self):
        data=b'{"synthetic":"unchanged stored JSON"}'
        etag=hashlib.md5(data,usedforsecurity=False).hexdigest()
        metadata={'size':len(data),'etag':etag}
        self.assertTrue(stored_representation_matches(data,'W/"'+etag+'"',metadata))
        self.assertFalse(stored_representation_matches(data[:-1]+b'x','W/"'+etag+'"',metadata))
        self.assertFalse(stored_representation_matches(data+b'x','W/"'+etag+'"',metadata))
        self.assertFalse(stored_representation_matches(data,'W/"'+etag+'-2"',{'size':len(data),'etag':etag+'-2'}))
        self.assertFalse(stored_representation_matches(data,'W/"'+'0'*32+'"',metadata))

    def test_backup_refuses_objects_outside_the_shared_restore_bound(self):
        db=sqlite3.connect(':memory:')
        db.executescript(SCHEMA)
        db.execute("INSERT INTO artifacts VALUES('too-large')")
        (self.root/'database.sql').write_text('\n'.join(db.iterdump()))
        db.close()
        client=Source(SOURCE,'read-token','export-token')
        with patch.object(client,'inventory',return_value={'too-large':{'key':'too-large','size':MAX_OBJECT_BYTES+1}}),\
             patch.object(client,'request') as request:
            with self.assertRaises(SnapshotError):client.copy(self.root)
            request.assert_not_called()

    def test_operator_file_modes_and_ownership_are_enforced_on_open_descriptor(self):
        token=self.ram/'synthetic-token'
        token.write_bytes(b'synthetic credential')
        token.chmod(0o644)
        with self.assertRaises(SnapshotError):owner_only_file(token,1024)
        token.chmod(0o600)
        self.assertEqual(owner_only_file(token,1024),b'synthetic credential')
        with patch('cloud.os.getuid',return_value=token.stat().st_uid+1):
            with self.assertRaises(SnapshotError):owner_only_file(token,1024)

    def test_restore_schema_comparison_includes_constraints_indexes_and_triggers(self):
        base='CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY,p INTEGER REFERENCES parent(id),v TEXT CHECK(length(v)<10));'
        full=base+'CREATE INDEX lookup ON child(p); CREATE TRIGGER protect BEFORE DELETE ON child BEGIN SELECT RAISE(ABORT,\'protected\'); END;'
        for changed in [base, full.replace('CREATE INDEX lookup ON child(p);',''),
                        full.replace('CHECK(length(v)<10)','CHECK(length(v)<20)'),
                        full.replace('REFERENCES parent(id)','REFERENCES parent(id) ON DELETE CASCADE'),
                        full.replace('CREATE TABLE parent(id INTEGER PRIMARY KEY);','CREATE TABLE parent(id INTEGER PRIMARY KEY) WITHOUT ROWID;')]:
            with self.subTest(changed=changed):
                self.assertNotEqual(database_state(full.encode()),database_state(changed.encode()))

    def test_restore_row_comparison_preserves_sqlite_storage_types_and_ignores_row_order(self):
        self.assertNotEqual(database_state(b"CREATE TABLE t(v);INSERT INTO t VALUES(X'DEAD');"),
                            database_state(b"CREATE TABLE t(v);INSERT INTO t VALUES('dead');"))
        self.assertEqual(database_state(b'CREATE TABLE t(v);INSERT INTO t VALUES(1),(2);'),
                         database_state(b'CREATE TABLE t(v);INSERT INTO t VALUES(2),(1);'))



if __name__=='__main__': unittest.main()
