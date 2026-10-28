#!/usr/bin/env python3
"""Restore a complete encrypted backup only into new disposable drill resources."""
import argparse
from email.parser import BytesParser
from email.policy import default as mime_policy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import quote
from urllib.request import Request
from urllib.error import HTTPError

from cloud import Source, private_json, secret_command, owner_only_file
from sealed import ram_directory, unseal
from snapshot import (MAX_SQL_BYTES, MAX_OBJECT_BYTES, SnapshotError, canonical, load_sql, object_path,
                      read_private_file, snapshot_metadata, validate_restore_target)


def ingress_read(provider, path, limit=65536):
    try:
        with provider.opener.open(Request('https://api.cloudflare.com/client/v4'+path,
                                  headers={'Authorization':'Bearer '+provider.export_token,
                                           'User-Agent':'OpenZCAD-Recovery/1.0',
                                           'Accept-Encoding':'identity'}),timeout=30) as response:
            body=response.read(limit+1)
            if len(body)>limit:
                raise SnapshotError('Restore ingress response exceeds supported capacity.')
            return body,{key.lower():value for key,value in response.headers.items()}
    except HTTPError as error:
        raise SnapshotError('Restore ingress verification failed, HTTP '+str(error.code)) from None


def verified_ingress(provider, target):
    ingress=target['ingressWorker']
    if (not re.fullmatch(r'openzcad-recovery-drill-[a-z0-9-]+',ingress)
            or not re.fullmatch(r'[a-z0-9-]+',target['subdomain'])
            or target['ingressOrigin']!='https://'+ingress+'.'+target['subdomain']+'.workers.dev'):
        raise SnapshotError('Invalid disposable restore ingress identity.')
    base='/accounts/'+target['account']+'/workers/scripts/'+ingress
    def get(path):
        value=json.loads(ingress_read(provider,base+path)[0])
        if value.get('success') is not True:
            raise SnapshotError('Restore ingress provider verification failed.')
        return value['result']
    deployments=get('/deployments')['deployments']
    versions=deployments[0]['versions'] if deployments else []
    if len(versions)!=1 or versions[0].get('percentage')!=100:
        raise SnapshotError('Restore ingress must have one fully active version.')
    version_id=versions[0].get('version_id','')
    if not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',version_id):
        raise SnapshotError('Restore ingress version identity is invalid.')
    version=get('/versions/'+version_id)
    if version.get('id')!=version_id:
        raise SnapshotError('Restore ingress version identity changed.')
    resources=version['resources']
    bindings=resources['bindings']
    expected=[{'type':'r2_bucket','name':'TARGET','bucket_name':target['bucket']},
              {'type':'plain_text','name':'TARGET_BUCKET','text':target['bucket']},
              {'type':'secret_text','name':'RESTORE_TOKEN'}]
    if sorted(bindings,key=lambda item:item['name'])!=sorted(expected,key=lambda item:item['name']):
        raise SnapshotError('Restore ingress has an unapproved provider binding.')
    content,headers=ingress_read(provider,base+'/content/v2',1024**2)
    etag=resources.get('script',{}).get('etag')
    if not etag or headers.get('etag')!='"'+etag+'"':
        raise SnapshotError('Restore ingress content does not name the active version.')
    message=BytesParser(policy=mime_policy).parsebytes(
        ('Content-Type: '+headers.get('content-type','')+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+content)
    parts=list(message.iter_parts())
    if message.defects or message.get_content_type()!='multipart/form-data' or len(parts)!=1:
        raise SnapshotError('Restore ingress must contain only the reviewed module.')
    part=parts[0]
    if (part.defects or part.is_multipart() or part.get_content_type()!='application/javascript+module'
            or part.get_content_disposition()!='form-data'
            or part.get_filename()!='restore-worker.mjs'
            or part.get_param('name',header='content-disposition')!='restore-worker.mjs'
            or len(part.get_all('Content-Disposition',[]))!=1
            or len(part.get_all('Content-Type',[]))!=1
            or part.get('Content-Transfer-Encoding') is not None
            or part.get_payload(decode=True)!=read_private_file(Path(__file__).with_name('restore-worker.mjs'),1024**2)):
        raise SnapshotError('Restore ingress code differs from the reviewed module; deploy with --no-bundle.')
    if get('/subdomain').get('previews_enabled') is not True:
        raise SnapshotError('Restore ingress requires immutable version URLs.')
    route=json.loads(ingress_read(provider,'/accounts/'+target['account']+'/workers/subdomain')[0])
    if route.get('success') is not True or route.get('result',{}).get('subdomain')!=target['subdomain']:
        raise SnapshotError('Restore ingress subdomain does not belong to the approved account.')
    # Use the verified immutable version, never the mutable deployment URL or
    # a preview alias. Later deployments cannot change this code or binding.
    return 'https://'+version_id[:8]+'-'+ingress+'.'+target['subdomain']+'.workers.dev'


def database_state(sql):
    db = load_sql(sql)
    try:
        result = {}
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")]
        for table in tables:
            quoted='"'+table.replace('"','""')+'"'
            rows = [canonical([[type(value).__name__, value.hex() if isinstance(value,bytes) else value] for value in row])
                    for row in db.execute('SELECT * FROM '+quoted)]
            result[table] = {'rows':len(rows),'digest':hashlib.sha256(b'\n'.join(sorted(rows))).hexdigest(),
                             'columns':[tuple(row) for row in db.execute('PRAGMA table_info('+quoted+')')],
                             'foreignKeys':[tuple(row) for row in db.execute('PRAGMA foreign_key_list('+quoted+')')]}
        schema = [tuple(row) for row in db.execute('''SELECT type,name,tbl_name,sql FROM sqlite_master
                  WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
                    AND tbl_name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE '_cf_%'
                  ORDER BY type,name''')]
        sequences={}
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone():
            sequences={name:value for name,value in db.execute('SELECT name,seq FROM sqlite_sequence')
                       if name in result}
        return {'tables':result,'schema':schema,'sequences':sequences}
    finally:
        db.close()


def restore(config, archive):
    password = secret_command(config['passphraseCommand'])
    read_token = owner_only_file(Path(config['readTokenFile']),16384).decode().strip()
    export_token = json.loads(secret_command(config['exportTokenCommand']))['token']
    target = config['target']
    with ram_directory() as temporary:
        ram = Path(temporary)
        root = ram/'snapshot'
        manifest = unseal(archive,root,password)
        metadata = snapshot_metadata(root,manifest)
        validate_restore_target(manifest['source'],target)
        if manifest['source'] != config['source']:
            raise SnapshotError('Archive source does not match the approved operator configuration.')
        provider = Source({'account':target['account'],'database':target['database'],'bucket':target['bucket']},read_token,export_token)
        identity = provider.json('GET',provider.d1)['result']
        if identity.get('name') != target['databaseName']:
            raise SnapshotError('Provider target database identity differs from configuration.')
        origin = verified_ingress(provider,target)
        if provider.inventory():
            raise SnapshotError('Restore target bucket is not empty.')
        empty=ram/'empty-target'
        empty.mkdir(mode=0o700)
        provider.export(empty)
        initial=load_sql(read_private_file(empty/'database.sql',MAX_SQL_BYTES))
        try:
            if initial.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' LIMIT 1").fetchone():
                raise SnapshotError('Restore target database is not empty.')
        finally:
            initial.close()
        runtime = private_json(Path(target['config']))
        databases=runtime.get('d1_databases',[])
        if (runtime.get('account_id')!=target['account'] or runtime.get('name')!=target['worker']
                or len(databases)!=1 or databases[0].get('database_id')!=target['database']):
            raise SnapshotError('Restore command configuration does not match the approved target.')
        # The token is inherited inside encrypted Wrangler auth, not on argv or in SQL.
        args=config['wranglerCommand']+['d1','execute',target['database'],'--remote',
             '--config',target['config'],'--file',str(root/'database.sql')]
        result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=600)
        if result.returncode:
            raise SnapshotError('Disposable D1 import failed; provider output withheld.')
        ingress_token=secret_command(config['ingressTokenCommand']).decode()
        if verified_ingress(provider,target)!=origin:
            raise SnapshotError('Restore ingress version changed before object transfer.')
        for item in manifest['objects']:
            data=read_private_file(object_path(root,item['key']),MAX_OBJECT_BYTES)
            original=metadata[item['key']]
            encoded=quote(json.dumps(original,separators=(',',':')),safe='')
            request=Request(origin+'/restore',data=data,method='PUT',headers={
                'Authorization':'Bearer '+ingress_token,'Content-Type':'application/octet-stream',
                'X-OpenZCAD-Metadata':encoded,'User-Agent':'OpenZCAD-Recovery/1.0'})
            try:
                with provider.opener.open(request,timeout=90) as response:
                    if response.status!=201: raise SnapshotError('Disposable object restore failed.')
            except HTTPError as error:
                raise SnapshotError('Disposable object upload failed, HTTP '+str(error.code)) from None
        actual=provider.inventory()
        if set(actual)!=set(metadata):
            raise SnapshotError('Restored object inventory differs from the paired backup.')
        for item in manifest['objects']:
            original=metadata[item['key']]
            restored=actual[item['key']]
            for field in ['size','http_metadata','custom_metadata','storage_class']:
                if restored.get(field)!=original.get(field):
                    raise SnapshotError('Restored object metadata differs from its source.')
            encoding=(restored.get('http_metadata') or {}).get('contentEncoding') or 'identity'
            data,_=provider.request('GET',provider.r2+'/'+quote(item['key'],safe='/'),limit=item['bytes'],
                                    headers={'Accept-Encoding':encoding})
            if hashlib.sha256(data).hexdigest()!=item['storedSha256']:
                raise SnapshotError('Restored object stored-byte digest differs.')
        exported=ram/'target'
        exported.mkdir(mode=0o700)
        provider.export(exported)
        expected=database_state(read_private_file(root/'database.sql',MAX_SQL_BYTES))
        restored=database_state(read_private_file(exported/'database.sql',MAX_SQL_BYTES))
        if expected!=restored:
            raise SnapshotError('Restored database content or schema differs from the paired backup.')
        return {'objects':len(manifest['objects']),'tables':len(expected['tables']),'status':'restored-and-verified'}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('--archive',type=Path,required=True)
    args=parser.parse_args()
    os.umask(0o077)
    try:
        print(json.dumps(restore(private_json(args.config),args.archive)))
    except Exception as error:
        detail=str(error) if isinstance(error,SnapshotError) else type(error).__name__
        raise SystemExit('Disposable restore failed: '+detail) from None
