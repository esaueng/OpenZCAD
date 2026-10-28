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

from cloud import Source, stored_representation_matches
from sealed import gpg, ram_directory, safe_extract, seal, unseal
from snapshot import SnapshotError, complete_snapshot
from test_snapshot import SCHEMA, SOURCE


class SealedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = ram_directory()
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



if __name__=='__main__': unittest.main()
