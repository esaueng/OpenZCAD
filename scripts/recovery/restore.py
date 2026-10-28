#!/usr/bin/env python3
"""Restore a complete encrypted backup only into new disposable drill resources."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import quote
from urllib.request import Request
from urllib.error import HTTPError

from cloud import Source, private_json, secret_command, owner_only_file
from sealed import ram_directory, unseal
from snapshot import (MAX_SQL_BYTES, MAX_OBJECT_BYTES, SnapshotError, canonical, load_sql, object_path,
                      read_private_file, validate_restore_target)


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
        return {'tables':result,'schema':schema}
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
        validate_restore_target(manifest['source'],target)
        if manifest['source'] != config['source']:
            raise SnapshotError('Archive source does not match the approved operator configuration.')
        provider = Source({'account':target['account'],'database':target['database'],'bucket':target['bucket']},read_token,export_token)
        identity = provider.json('GET',provider.d1)['result']
        if identity.get('name') != target['databaseName']:
            raise SnapshotError('Provider target database identity differs from configuration.')
        ingress = target['ingressWorker']
        if not ingress.startswith('openzcad-recovery-drill-'):
            raise SnapshotError('Invalid disposable restore ingress identity.')
        path='/accounts/'+target['account']+'/workers/scripts/'+ingress+'/settings'
        # Read back the actual deployed binding, independent of local config.
        try:
            with provider.opener.open(Request('https://api.cloudflare.com/client/v4'+path,
                                      headers={'Authorization':'Bearer '+export_token}),timeout=30) as response:
                settings=json.load(response)
        except HTTPError as error:
            raise SnapshotError('Disposable ingress binding readback failed, HTTP '+str(error.code)) from None
        bindings=settings['result']['bindings']
        buckets=[binding for binding in bindings if binding.get('type')=='r2_bucket']
        if (settings.get('success') is not True or len(buckets)!=1
                or buckets[0].get('name')!='TARGET' or buckets[0].get('bucket_name')!=target['bucket']
                or any(binding.get('type')=='d1' for binding in bindings)):
            raise SnapshotError('Restore ingress has an unapproved provider binding.')
        origin=target['ingressOrigin']
        if origin!='https://'+ingress+'.'+target['subdomain']+'.workers.dev':
            raise SnapshotError('Restore ingress origin does not match the approved Worker.')
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
        metadata=json.loads(read_private_file(root/'metadata.json',64*1024**2))['objects']
        if set(metadata)!=set(item['key'] for item in manifest['objects']):
            raise SnapshotError('Backup object metadata and references differ.')
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
            for field in ['size','http_metadata','custom_metadata']:
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
