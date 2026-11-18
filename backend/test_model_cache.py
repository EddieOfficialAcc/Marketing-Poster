import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from backend import model_cache as cache

class Reply:
    def __init__(self, chunks, status=200, headers=None):
        self.chunks=iter(chunks);self.status=status;self.headers=headers or {}
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self,size):
        chunk=next(self.chunks,b'')
        if isinstance(chunk,Exception): raise chunk
        return chunk

class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.env=patch.dict(os.environ,{'U2NET_HOME':self.temp.name});self.env.start()
        self.hash=patch.object(cache,'CHECKSUM',hashlib.md5(b'abcdef').hexdigest());self.hash.start()
    def tearDown(self):
        self.hash.stop();self.env.stop();self.temp.cleanup()
    def test_valid_cache_never_downloads(self):
        (self.root/'u2net.onnx').write_bytes(b'abcdef')
        with patch.object(cache.urllib.request,'urlopen') as fetch:
            cache.ensure_model();fetch.assert_not_called()
    def test_timeout_resumes_partial_and_verifies(self):
        replies=[Reply([b'abc',TimeoutError()],headers={'Content-Length':'6'}),Reply([b'def'],206,{'Content-Range':'bytes 3-5/6'})]
        with patch.object(cache.urllib.request,'urlopen',side_effect=replies) as fetch,patch.object(cache.time,'sleep'):
            path=cache.ensure_model()
        self.assertEqual(path.read_bytes(),b'abcdef')
        self.assertEqual(fetch.call_args_list[1].args[0].get_header('Range'),'bytes=3-')
    def test_server_ignoring_range_replaces_instead_of_appending(self):
        (self.root/'u2net.onnx.part').write_bytes(b'abc')
        with patch.object(cache.urllib.request,'urlopen',return_value=Reply([b'abcdef'],headers={'Content-Length':'6'})):
            self.assertEqual(cache.ensure_model().read_bytes(),b'abcdef')
    def test_exhausted_retries_preserve_partial_without_installing_model(self):
        (self.root/'u2net.onnx.part').write_bytes(b'abc')
        with patch.object(cache.urllib.request,'urlopen',side_effect=TimeoutError()),patch.object(cache.time,'sleep'):
            with self.assertRaises(cache.ModelDownloadError):cache.ensure_model()
        self.assertEqual((self.root/'u2net.onnx.part').read_bytes(),b'abc')
        self.assertFalse((self.root/'u2net.onnx').exists())
    def test_wrong_checksum_never_becomes_ready(self):
        with patch.object(cache.urllib.request,'urlopen',side_effect=lambda *a,**k:Reply([b'bad'])),patch.object(cache.time,'sleep'):
            with self.assertRaises(cache.ModelDownloadError):cache.ensure_model()
        self.assertFalse((self.root/'u2net.onnx').exists())
