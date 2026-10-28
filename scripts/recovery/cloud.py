#!/usr/bin/env python3
"""Read-only source exporter for paired D1/R2 snapshots.

The only source POST is D1's polling export; there are no source data writes.
Configuration and credentials are private operator inputs, never repository data.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sqlite3
import subprocess
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from snapshot import (MAX_OBJECT_BYTES, MAX_SQL_BYTES, SnapshotError, canonical,
                      complete_snapshot, load_sql, object_path, read_private_file,
                      required_objects, write_new)
from sealed import ram_directory, seal, unseal


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def s3_get_authorization(uri, headers, access, secret, region='auto'):
    """AWS SigV4 for a bodyless GET with no query, without path normalization."""
    stamp = headers['x-amz-date']
    scope = stamp[:8] + '/' + region + '/s3/aws4_request'
    names = ';'.join(sorted(headers))
    canonical_headers = ''.join(name + ':' + headers[name] + '\n' for name in sorted(headers))
    canonical_request = ('GET\n' + uri + '\n\n' + canonical_headers + '\n' + names
                         + '\n' + headers['x-amz-content-sha256'])
    to_sign = ('AWS4-HMAC-SHA256\n' + stamp + '\n' + scope + '\n'
               + hashlib.sha256(canonical_request.encode()).hexdigest())
    key = ('AWS4' + secret).encode()
    for segment in (stamp[:8], region, 's3', 'aws4_request'):
        key = hmac.new(key, segment.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return ('AWS4-HMAC-SHA256 Credential=' + access + '/' + scope
            + ',SignedHeaders=' + names + ',Signature=' + signature)


def stored_representation_matches(data, response_etag, metadata):
    if len(data) != metadata['size']:
        return False
    expected = metadata['etag']
    if response_etag == '"' + expected + '"':
        return True
    # The HTTP edge can weaken a JSON tag after transfer decoding even when
    # its bytes are identical to R2. Accept only a single-part stored ETag
    # whose byte digest also matches; never infer multipart hashes this way.
    # SHA-256 remains the snapshot's content-integrity digest.
    return (response_etag == 'W/"' + expected + '"'
            and re.fullmatch(r'[0-9a-f]{32}', expected) is not None
            and hashlib.md5(data, usedforsecurity=False).hexdigest() == expected)


def owner_only_file(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > limit):
            raise SnapshotError('Operator files must be bounded regular owner-only files.')
        value = file.read(limit + 1)
        if len(value) > limit:
            raise SnapshotError('Operator file exceeds supported capacity.')
        return value


def private_json(path):
    return json.loads(owner_only_file(path, 65536))


def secret_command(args):
    if not isinstance(args, list) or not args or not all(isinstance(s,str) for s in args):
        raise SnapshotError('A credential command is required.')
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    if result.returncode:
        raise SnapshotError('Encrypted credential lookup failed.')
    return result.stdout.strip()


class Source:
    def __init__(self, source, read_token, export_token):
        if (not re.fullmatch(r'[0-9a-f]{32}', source['account'])
                or not re.fullmatch(r'[0-9a-f-]{36}', source['database'])
                or not re.fullmatch(r'[a-z0-9-]{3,63}', source['bucket'])):
            raise SnapshotError('Invalid source resource identity.')
        self.source = source
        self.base = '/accounts/' + source['account']
        self.d1 = self.base + '/d1/database/' + source['database']
        self.r2 = self.base + '/r2/buckets/' + source['bucket'] + '/objects'
        self.read_token = read_token
        self.export_token = export_token
        self.opener = build_opener(NoRedirect)
        self.s3_access = None

    def request(self, method, path, body=None, *, limit=16*1024**2, headers=None):
        clean = urlsplit(path).path
        export = method == 'POST' and path == self.d1 + '/export'
        if not export and not (method == 'GET' and
                (clean == self.d1 or clean == self.r2)):
            raise SnapshotError('Operation is outside the read-only source allowlist.')
        auth = self.export_token if export else self.read_token
        req = Request('https://api.cloudflare.com/client/v4' + path, method=method,
                      data=json.dumps(body).encode() if body is not None else None,
                      headers={'Authorization':'Bearer '+auth, 'Content-Type':'application/json',
                               'Accept-Encoding':'identity', **(headers or {})})
        try:
            with self.opener.open(req,timeout=45) as response:
                data = response.read(limit+1)
                if len(data) > limit:
                    raise SnapshotError('Provider response exceeds the supported capacity.')
                return data, dict((key.lower(),value) for key,value in response.headers.items())
        except HTTPError as error:
            raise SnapshotError('Source provider request failed, HTTP '+str(error.code)) from None

    def read_object(self, key, limit):
        object_path(Path('.'), key)
        if not isinstance(limit, int) or not 0 <= limit <= MAX_OBJECT_BYTES:
            raise SnapshotError('Object transfer exceeds the supported capacity.')
        try:
            if self.s3_access is None:
                request = Request('https://api.cloudflare.com/client/v4/user/tokens/verify',
                    headers={'Authorization': 'Bearer ' + self.read_token,
                             'User-Agent': 'OpenZCAD-Recovery/1.0'})
                with self.opener.open(request, timeout=45) as response:
                    data = response.read(65537)
                if len(data) > 65536:
                    raise SnapshotError('Token verification exceeds the supported capacity.')
                verification = json.loads(data)
                result = verification.get('result') or {}
                if (verification.get('success') is not True or result.get('status') != 'active'
                        or not re.fullmatch(r'[0-9a-f]{32}', result.get('id', ''))):
                    raise SnapshotError('Object reads require an active user R2 read token.')
                self.s3_access = result['id']
            # Cloudflare documents deriving S3 credentials from the existing
            # read token: its ID and SHA-256 of its value. Keep both in memory.
            host = self.source['account'] + '.r2.cloudflarestorage.com'
            uri = '/' + self.source['bucket'] + '/' + quote(key, safe='/~')
            headers = {'host': host, 'x-amz-content-sha256': hashlib.sha256(b'').hexdigest(),
                       'x-amz-date': datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}
            headers['Authorization'] = s3_get_authorization(uri, headers, self.s3_access,
                hashlib.sha256(self.read_token.encode()).hexdigest())
            headers.update({'User-Agent': 'OpenZCAD-Recovery/1.0', 'Accept-Encoding': 'identity'})
            # Encode the bucket/key separator too, so a scalar '.' or '..'
            # never becomes a URL path segment at the HTTP edge. R2 decodes
            # this transport path before checking the unnormalized signature.
            path = '/' + self.source['bucket'] + '%2F' + quote(key, safe='~')
            with self.opener.open(Request('https://' + host + path, headers=headers), timeout=45) as response:
                data = response.read(limit + 1)
                if len(data) > limit:
                    raise SnapshotError('Object response exceeds the supported capacity.')
                return data, {name.lower(): value for name, value in response.headers.items()}
        except HTTPError as error:
            raise SnapshotError('Object provider request failed, HTTP ' + str(error.code)) from None

    def json(self, method, path, body=None):
        value = json.loads(self.request(method,path,body)[0])
        if value.get('success') is not True:
            raise SnapshotError('Source provider operation did not succeed.')
        return value

    def export(self, root):
        started = time.monotonic()
        body = {'output_format':'polling'}
        bookmark = None
        while True:
            value = self.json('POST',self.d1+'/export',body)['result']
            current = value.get('at_bookmark')
            if bookmark is not None and current != bookmark:
                raise SnapshotError('Export bookmark changed.')
            bookmark = current
            if not isinstance(bookmark,str) or not bookmark:
                raise SnapshotError('Export has no fixed bookmark.')
            if value.get('status') == 'error':
                raise SnapshotError('D1 export failed.')
            if value.get('status') == 'complete':
                url = value['result']['signed_url']
                parsed = urlsplit(url)
                if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port:
                    raise SnapshotError('Invalid export download URL.')
                # Signed URLs are short-lived secrets. Never forward the API credential.
                with self.opener.open(Request(url,headers={'Accept-Encoding':'identity'}),timeout=60) as response:
                    data = response.read(MAX_SQL_BYTES+1)
                if len(data) > MAX_SQL_BYTES:
                    raise SnapshotError('SQL export exceeds supported capacity.')
                write_new(root/'database.sql',data)
                return {'bookmark':bookmark,'seconds':round(time.monotonic()-started,3)}
            if time.monotonic()-started > 300:
                raise SnapshotError('D1 export exceeded its qualification limit.')
            body['current_bookmark'] = bookmark
            time.sleep(0.5)

    def inventory(self):
        cursor = None
        result = {}
        seen = set()
        while True:
            query = {'per_page':1000}
            if cursor:
                query['cursor'] = cursor
            value = self.json('GET',self.r2+'?'+urlencode(query))
            for item in value['result']:
                key = item['key']
                object_path(Path('.'),key)
                if key in result or not isinstance(item.get('size'),int):
                    raise SnapshotError('Invalid or duplicate provider object metadata.')
                result[key] = item
            info = value.get('result_info') or {}
            if not info.get('is_truncated'):
                return result
            cursor = info.get('cursor')
            if not cursor or cursor in seen or len(result)>100000:
                raise SnapshotError('Invalid or excessive object pagination.')
            seen.add(cursor)

    def copy(self, root):
        db = load_sql(read_private_file(root/'database.sql',MAX_SQL_BYTES))
        try:
            _, references = required_objects(db)
        finally:
            db.close()
        first = self.inventory()
        total = sum(first.get(ref['key'],{}).get('size',MAX_OBJECT_BYTES+1) for ref in references)
        if total*4+128*1024**2 > shutil.disk_usage(root).free:
            raise SnapshotError('Insufficient RAM for a complete verified paired backup.')
        metadata = {}
        for ref in references:
            item = first.get(ref['key'])
            if not item or not 0 <= item['size'] <= MAX_OBJECT_BYTES:
                raise SnapshotError('A committed object is missing or exceeds capacity.')
            data, headers = self.read_object(ref['key'], item['size'])
            if not stored_representation_matches(data,headers.get('etag',''),item):
                response_encoding=headers.get('content-encoding')
                encoding_label=response_encoding if response_encoding in {'gzip','br','deflate'} else 'other-or-none'
                raise SnapshotError('Source object changed during transfer '
                    f"(expectedBytes={item['size']}, receivedBytes={len(data)}, "
                    f"etagMatches={headers.get('etag','').strip(chr(34))==item['etag']}, "
                    f"responseEncoding={encoding_label}).")
            write_new(object_path(root,ref['key']),data)
            metadata[ref['key']] = item
        last = self.inventory()
        if any(last.get(key) != item for key,item in metadata.items()):
            raise SnapshotError('Source object metadata changed during snapshot.')
        return metadata


def backup(config, destination):
    token_path = Path(config['readTokenFile'])
    read_token = owner_only_file(token_path,16384).decode().strip()
    export_token = json.loads(secret_command(config['exportTokenCommand']))['token']
    password = secret_command(config['passphraseCommand'])
    source = Source(config['source'],read_token,export_token)
    if destination.exists():
        raise SnapshotError('Use a fresh encrypted backup destination.')
    with ram_directory() as temporary:
        root = Path(temporary)
        (root/'objects').mkdir(mode=0o700)
        export = source.export(root)
        metadata = source.copy(root)
        write_new(root/'metadata.json',canonical({'export':export,'objects':metadata}))
        manifest = complete_snapshot(root,config['source'])
        seal(root,destination,password)
    return {'objects':len(manifest['objects']),
            'bytes':sum(item['bytes'] for item in manifest['objects']),
            'exportSeconds':export['seconds']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['backup','verify'])
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('--archive',type=Path,required=True)
    args = parser.parse_args()
    os.umask(0o077)
    config = private_json(args.config)
    if args.action == 'backup':
        result = backup(config,args.archive)
    else:
        with ram_directory() as temporary:
            manifest = unseal(args.archive,Path(temporary)/'restored',secret_command(config['passphraseCommand']))
            result = {'objects':len(manifest['objects'])}
    print(json.dumps({'status':'verified',**result}))


if __name__ == '__main__':
    try:
        main()
    except (SnapshotError,OSError,ValueError,KeyError,sqlite3.Error,subprocess.SubprocessError) as error:
        detail = str(error) if isinstance(error,SnapshotError) else type(error).__name__
        raise SystemExit('Recovery failed: '+detail) from None
