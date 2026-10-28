import gzip
import hashlib
import io
import json
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import unquote, urlsplit

from cloud import NoRedirect, Source, s3_get_authorization
from snapshot import MAX_OBJECT_BYTES, SnapshotError
from test_snapshot import SOURCE


class ObjectReadTests(unittest.TestCase):
    def client(self, body=b'fixture'):
        client=Source(SOURCE,'public-synthetic-read-token','unused-export-token')
        client.opener=Mock()
        responses=[]
        for value in [json.dumps({'success':True,'result':{'status':'active','id':'a'*32}}).encode(),body]:
            response=io.BytesIO(value)
            response.headers={'ETag':'"stored"'}
            responses.append(response)
        client.opener.open.side_effect=responses
        return client

    def test_published_aws_s3_get_signature_vector(self):
        # Public reference credentials and vector, not an operator credential:
        # https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
        headers={'host':'examplebucket.s3.amazonaws.com','range':'bytes=0-9',
                 'x-amz-content-sha256':hashlib.sha256(b'').hexdigest(),
                 'x-amz-date':'20130524T000000Z'}
        result=s3_get_authorization('/test.txt',headers,'AKIAIOSFODNN7EXAMPLE',
                    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY','us-east-1')
        self.assertEqual(result.rsplit('Signature=',1)[1],
                         'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')

    def test_d1_identity_and_export_use_only_the_d1_capable_credential(self):
        for method,kind,expected in [('GET','d1','d1-only'),('POST','export','d1-only'),
                                     ('GET','r2','r2-only')]:
            client=Source(SOURCE,'r2-only','d1-only')
            client.opener=Mock()
            response=io.BytesIO(b'{}'); response.headers={}
            client.opener.open.return_value=response
            path=client.d1+'/export' if kind=='export' else client.d1 if kind=='d1' else client.r2
            client.request(method,path)
            request=client.opener.open.call_args.args[0]
            self.assertEqual(request.get_header('Authorization'),'Bearer '+expected)
            self.assertEqual(request.full_url,'https://api.cloudflare.com/client/v4'+path)

    def test_opaque_keys_are_not_normalized_into_other_objects_or_resources(self):
        for key in ['.','..','../../escape','prefix/../key','prefix//key','/key',
                    'prefix/%2E/%2F/key','unicode/\u2713?x=#fragment']:
            client=self.client()
            with self.subTest(key=key),patch('cloud.s3_get_authorization',return_value='synthetic-signature') as signer:
                self.assertEqual(client.read_object(key,7),(b'fixture',{'etag':'"stored"'}))
                requests=[call.args[0] for call in client.opener.open.call_args_list]
                self.assertEqual(requests[0].full_url,'https://api.cloudflare.com/client/v4/user/tokens/verify')
                request=requests[1]
                url=urlsplit(request.full_url)
                self.assertEqual((url.scheme,url.netloc,url.query,url.fragment),
                    ('https',SOURCE['account']+'.r2.cloudflarestorage.com','',''))
                self.assertEqual(unquote(url.path),'/'+SOURCE['bucket']+'/'+key)
                self.assertFalse(any(part in {'.','..'} for part in url.path.split('/')))
                self.assertEqual(request.get_method(),'GET')
                self.assertIsNone(request.data)
                self.assertNotIn(client.read_token,repr(request.headers))
                self.assertEqual(unquote(signer.call_args.args[0]),'/'+SOURCE['bucket']+'/'+key)

    def test_raw_stored_gzip_is_returned_without_decoding(self):
        body=gzip.compress(b'synthetic stored gzip')
        client=self.client(body)
        self.assertEqual(client.read_object('gzip',len(body))[0],body)

    def test_body_and_requested_size_are_bounded(self):
        client=self.client(b'over-capacity')
        with self.assertRaisesRegex(SnapshotError,'Object response'):
            client.read_object('fixture',1)
        for limit in [-1,MAX_OBJECT_BYTES+1,'1']:
            client=self.client()
            with self.subTest(limit=limit),self.assertRaises(SnapshotError):
                client.read_object('fixture',limit)
            client.opener.open.assert_not_called()

    def test_inactive_or_unverified_tokens_never_reach_s3(self):
        for verification in [{'success':False},
             {'success':True,'result':{'status':'expired','id':'a'*32}},
             {'success':True,'result':{'status':'active','id':'invalid'}}]:
            client=self.client()
            client.opener.open.side_effect=None
            client.opener.open.return_value=io.BytesIO(json.dumps(verification).encode())
            with self.subTest(verification=verification),self.assertRaises(SnapshotError):
                client.read_object('fixture',1)
            self.assertEqual(client.opener.open.call_count,1)

    def test_no_redirect_or_control_plane_object_fallback(self):
        self.assertIsNone(NoRedirect().redirect_request(None,None,302,'',{},'https://unapproved.invalid'))
        client=Source(SOURCE,'synthetic-read','synthetic-export')
        with self.assertRaisesRegex(SnapshotError,'allowlist'):
            client.request('GET',client.r2+'/../other')
        client=self.client()
        client.opener.open.side_effect=HTTPError('https://fixed.invalid',302,'',{},None)
        with self.assertRaisesRegex(SnapshotError,'HTTP 302'):
            client.read_object('fixture',1)
        self.assertEqual(client.opener.open.call_count,1)


if __name__=='__main__':unittest.main()
