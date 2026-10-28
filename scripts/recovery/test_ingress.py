from contextlib import nullcontext
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from restore import restore, verified_ingress
from snapshot import SnapshotError
from test_snapshot import SOURCE


VERSION = '11111111-1111-4111-8111-111111111111'
TARGET = {'account':SOURCE['account'], 'worker':'openzcad-recovery-drill-fixture',
          'databaseName':'openzcad-recovery-drill-fixture',
          'database':'22222222-2222-4222-8222-222222222222',
          'bucket':'openzcad-recovery-drill-fixture', 'subdomain':'fixture',
          'origin':'https://openzcad-recovery-drill-fixture.fixture.workers.dev',
          'ingressWorker':'openzcad-recovery-drill-fixture-ingress',
          'ingressOrigin':'https://openzcad-recovery-drill-fixture-ingress.fixture.workers.dev'}
BASE='/accounts/'+TARGET['account']+'/workers/scripts/'+TARGET['ingressWorker']
CODE=Path(__file__).with_name('restore-worker.mjs').read_bytes()


def multipart(code=CODE, filename='restore-worker.mjs', extra=False):
    part=(f'--fixture-boundary\r\nContent-Disposition: form-data; name="{filename}"; filename="{filename}"\r\n'
          'Content-Type: application/javascript+module\r\n\r\n').encode()+code+b'\r\n'
    return part+(part if extra else b'')+b'--fixture-boundary--\r\n'


def responses():
    def value(data):
        return json.dumps({'success':True,'result':data}).encode(),{}
    return {
        '/deployments':value({'deployments':[{'versions':[{'version_id':VERSION,'percentage':100}]}]}),
        '/versions/'+VERSION:value({'id':VERSION,'resources':{'script':{'etag':'reviewed'},'bindings':[
            {'type':'r2_bucket','name':'TARGET','bucket_name':TARGET['bucket']},
            {'type':'plain_text','name':'TARGET_BUCKET','text':TARGET['bucket']},
            {'type':'secret_text','name':'RESTORE_TOKEN'}]}}),
        '/content/v2':(multipart(),{'etag':'"reviewed"','content-type':'multipart/form-data; boundary=fixture-boundary'}),
        '/subdomain':value({'previews_enabled':True}),
        'account/subdomain':value({'subdomain':TARGET['subdomain']}),
    }


class IngressTests(unittest.TestCase):
    def setUp(self):
        self.provider=Mock()
        self.data=responses()
        def read(provider,path,limit=65536):
            self.assertIs(provider,self.provider)
            if path=='/accounts/'+TARGET['account']+'/workers/subdomain':
                return self.data['account/subdomain']
            self.assertTrue(path.startswith(BASE+'/'))
            return self.data[path[len(BASE):]]
        self.reader=patch('restore.ingress_read',side_effect=read)
        self.reader.start()
        self.addCleanup(self.reader.stop)

    def change_json(self,path,change):
        data=json.loads(self.data[path][0])
        change(data['result'])
        self.data[path]=json.dumps(data).encode(),{}

    def test_exact_reviewed_code_and_bindings_use_an_immutable_version_url(self):
        origin=verified_ingress(self.provider,TARGET)
        self.assertEqual(origin,'https://11111111-'+TARGET['ingressWorker']+'.fixture.workers.dev')
        self.assertNotEqual(origin,TARGET['ingressOrigin'])

    def test_changed_bundled_extra_or_malformed_modules_are_refused(self):
        for content in [multipart(CODE+b'// changed'),multipart(filename='restore-worker.js'),
                        multipart(extra=True),b'not a multipart module',
                        multipart().replace(b'application/javascript+module',b'text/plain')]:
            with self.subTest(contentBytes=len(content)):
                self.data=responses()
                self.data['/content/v2']=(content,self.data['/content/v2'][1])
                with self.assertRaises(SnapshotError):verified_ingress(self.provider,TARGET)

    def test_missing_weak_or_other_version_etag_is_refused(self):
        for etag in [None,'W/"reviewed"','"other-version"']:
            with self.subTest(etag=etag):
                self.data=responses()
                body,headers=self.data['/content/v2']
                headers={**headers,'etag':etag}
                self.data['/content/v2']=body,headers
                with self.assertRaises(SnapshotError):verified_ingress(self.provider,TARGET)

    def test_partial_multiple_and_disabled_version_routes_are_refused(self):
        for versions in [[],[{'version_id':VERSION,'percentage':99}],
                         [{'version_id':VERSION,'percentage':100}]*2,
                         [{'version_id':'../other','percentage':100}]]:
            with self.subTest(versions=versions):
                self.data=responses()
                self.change_json('/deployments',lambda data:data['deployments'][0].update(versions=versions))
                with self.assertRaises(SnapshotError):verified_ingress(self.provider,TARGET)
        self.data=responses()
        self.change_json('/subdomain',lambda data:data.update(previews_enabled=False))
        with self.assertRaises(SnapshotError):verified_ingress(self.provider,TARGET)

    def test_wrong_duplicate_or_additional_bindings_are_refused(self):
        for binding in [{'type':'d1','name':'DB','id':'unapproved'},
                        {'type':'service','name':'OUTBOUND','service':'unapproved'},
                        {'type':'r2_bucket','name':'TARGET','bucket_name':TARGET['bucket']}]:
            with self.subTest(binding=binding):
                self.data=responses()
                self.change_json('/versions/'+VERSION,lambda data:data['resources']['bindings'].append(binding))
                with self.assertRaises(SnapshotError):verified_ingress(self.provider,TARGET)
        self.data=responses()
        self.change_json('/versions/'+VERSION,lambda data:data['resources']['bindings'][1].update(text='openzcad-beta-artifacts'))
        with self.assertRaises(SnapshotError):verified_ingress(self.provider,TARGET)

    def test_another_accounts_matching_worker_hostname_is_refused(self):
        target={**TARGET,'subdomain':'another-account',
                'ingressOrigin':'https://'+TARGET['ingressWorker']+'.another-account.workers.dev'}
        with self.assertRaisesRegex(SnapshotError,'subdomain'):
            verified_ingress(self.provider,target)

    def test_changed_code_stops_even_empty_snapshots_before_import_or_ingress_secret(self):
        _,headers=self.data['/content/v2']
        self.data['/content/v2']=multipart(CODE+b'// changed'),headers
        self.provider.d1='/synthetic-database'
        self.provider.json.return_value={'result':{'name':TARGET['databaseName']}}
        config={'source':SOURCE,'target':TARGET,'passphraseCommand':['password'],
                'readTokenFile':'synthetic-read-token','exportTokenCommand':['export'],
                'ingressTokenCommand':['ingress']}
        def secret(command):
            if command==['ingress']:self.fail('Ingress secret must not be requested')
            return b'{"token":"synthetic-export"}' if command==['export'] else b'public fixture password'
        with patch('restore.secret_command',side_effect=secret), \
             patch('restore.owner_only_file',return_value=b'synthetic-read'), \
             patch('restore.unseal',return_value={'source':SOURCE,'objects':[]}), \
             patch('restore.snapshot_metadata',return_value={}), \
             patch('restore.ram_directory') as ram, \
             patch('restore.Source',return_value=self.provider), \
             patch('restore.subprocess.run') as execute:
            ram.return_value.__enter__.return_value='/dev/shm/synthetic-unused'
            with self.assertRaises(SnapshotError):restore(config,Path('unused-fixture.gpg'))
            execute.assert_not_called()
        self.provider.inventory.assert_not_called()
        self.provider.export.assert_not_called()
        self.provider.opener.open.assert_not_called()

    def test_changed_version_after_credential_lookup_stops_before_any_object_put(self):
        events=[]
        origin='https://11111111-'+TARGET['ingressWorker']+'.fixture.workers.dev'
        def check(*unused):
            events.append('version')
            return origin if len(events)==1 else origin+'-changed'
        def secret(command):
            if command==['ingress']:
                events.append('ingress-secret')
                return b'synthetic-ingress'
            return b'{"token":"synthetic-export"}' if command==['export'] else b'public fixture password'
        target={**TARGET,'config':'unused-config'}
        config={'source':SOURCE,'target':target,'passphraseCommand':['password'],
                'readTokenFile':'synthetic-read-token','exportTokenCommand':['export'],
                'ingressTokenCommand':['ingress'],'wranglerCommand':['synthetic-command']}
        self.provider.d1='/synthetic-database'
        self.provider.json.return_value={'result':{'name':TARGET['databaseName']}}
        self.provider.inventory.return_value={}
        self.provider.export.side_effect=lambda root:(root/'database.sql').write_text('')
        runtime={'account_id':target['account'],'name':target['worker'],
                 'd1_databases':[{'database_id':target['database']}]}
        with tempfile.TemporaryDirectory(dir='/dev/shm') as ram, \
             patch('restore.secret_command',side_effect=secret), \
             patch('restore.owner_only_file',return_value=b'synthetic-read'), \
             patch('restore.unseal',return_value={'source':SOURCE,'objects':[]}), \
             patch('restore.snapshot_metadata',return_value={}), \
             patch('restore.ram_directory',return_value=nullcontext(ram)), \
             patch('restore.Source',return_value=self.provider), \
             patch('restore.private_json',return_value=runtime), \
             patch('restore.verified_ingress',side_effect=check), \
             patch('restore.subprocess.run',return_value=SimpleNamespace(returncode=0)):
            with self.assertRaisesRegex(SnapshotError,'version changed'):
                restore(config,Path('unused-fixture.gpg'))
        self.assertEqual(events,['version','ingress-secret','version'])
        self.provider.opener.open.assert_not_called()


if __name__=='__main__':unittest.main()
