import copy
import hashlib
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.app import app
from backend.archives import connect, cleanup_pending_assets, PENDING_TTL
from backend.test_archives import image_data, payload
from backend.test_support import IsolatedAuthTest, authenticated_client

class IncrementalArchiveTests(IsolatedAuthTest):
    def setUp(self):
        super().setUp()
        self.client=authenticated_client(app)

    def upload(self,raw):
        digest=hashlib.sha256(raw).hexdigest()
        response=self.client.put('/api/archive-assets/'+digest,content=raw,headers={'Content-Type':'image/png'})
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    def test_references_preserve_history_and_restore_embedded_backups(self):
        data=payload();original=data['project']['products'][0]['imageUrl'];_,raw=image_data()
        ref=self.upload(raw);data['project']['products'][0]['imageUrl']=ref
        data['project']['icons']=[{'id':'icon','name':'標識','width':16,'height':20,'imageUrl':ref}]
        data['project']['backgrounds']=[{'id':'bg','imageUrl':ref}];data['project']['background']=ref
        first=self.client.post('/api/archives/incremental',json=data)
        self.assertEqual(first.status_code,200,first.text)
        self.assertEqual(self.client.post('/api/archives/incremental',json=data).json()['id'],first.json()['id'])
        data['project']['revision']=2;data['project']['nodes'][0]['price']='40'
        self.assertEqual(self.client.post('/api/archives/incremental',json=data).status_code,200)
        restored=self.client.get('/api/archives/'+first.json()['id']+'/project').json()['project']
        self.assertEqual(restored['products'][0]['imageUrl'],original)
        self.assertEqual(restored['icons'][0]['imageUrl'],original)
        self.assertEqual(restored['background'],original)
        self.assertEqual(restored['nodes'][0]['price'],'33')
        db=connect()
        try:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM assets').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM pending_assets').fetchone()[0],0)
        finally:db.close()

    def test_missing_and_invalid_references_or_inline_data_cannot_commit(self):
        data=payload()
        self.assertEqual(self.client.post('/api/archives/incremental',json=data).status_code,422)
        data['project']['products'][0]['imageUrl']={'assetHash':'0'*64}
        response=self.client.post('/api/archives/incremental',json=data)
        self.assertEqual(response.status_code,409)
        self.assertEqual(response.json()['detail']['code'],'missing_assets')
        self.assertEqual(self.client.get('/api/archives').json(),[])
        with patch('backend.archives.MAX_METADATA',100):
            self.assertEqual(self.client.post('/api/archives/incremental',json=data).status_code,413)

    def test_upload_validation_and_login_are_enforced(self):
        _,raw=image_data();digest=hashlib.sha256(raw).hexdigest()
        anon=TestClient(app)
        self.assertEqual(anon.post('/api/archive-assets/check',json={'hashes':[digest]}).status_code,401)
        self.assertEqual(anon.put('/api/archive-assets/'+digest,content=raw).status_code,401)
        self.assertEqual(self.client.put('/api/archive-assets/'+'0'*64,content=raw,headers={'Content-Type':'image/png'}).status_code,422)
        bad=b'not an image'
        self.assertEqual(self.client.put('/api/archive-assets/'+hashlib.sha256(bad).hexdigest(),content=bad,headers={'Content-Type':'image/png'}).status_code,422)
        for value in [None,{'hashes':['bad']},{'hashes':['0'*64]*201}]:
            self.assertEqual(self.client.post('/api/archive-assets/check',json=value).status_code,422)

    def test_poster_reference_still_checks_exact_dimensions(self):
        data=payload();_,raw=image_data();small=self.upload(raw)
        data['project']['products'][0]['imageUrl']=small;data.update(confirmed=True,poster=small)
        self.assertEqual(self.client.post('/api/archives/incremental',json=data).status_code,422)
        _,poster=image_data((1800,2560));data['poster']=self.upload(poster)
        response=self.client.post('/api/archives/incremental',json=data)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.client.get('/api/archives/'+response.json()['id']+'/poster').content,poster)

    def test_legacy_assets_are_reused_and_cleanup_only_removes_uncommitted_uploads(self):
        legacy=payload();saved=self.client.post('/api/archives',json=legacy).json()
        _,raw=image_data();digest=hashlib.sha256(raw).hexdigest()
        self.assertEqual(self.client.post('/api/archive-assets/check',json={'hashes':[digest]}).json()['missing'],[])
        legacy['project']['products'][0]['imageUrl']={'assetHash':digest}
        self.assertEqual(self.client.post('/api/archives/incremental',json=legacy).status_code,200)
        _,orphan=image_data(color='blue');orphan_ref=self.upload(orphan)
        db=connect()
        try:
            with db:db.execute('UPDATE pending_assets SET touched=0')
        finally:db.close()
        cleanup_pending_assets()
        checked=self.client.post('/api/archive-assets/check',json={'hashes':[digest,orphan_ref['assetHash']]}).json()
        self.assertEqual(checked['missing'],[orphan_ref['assetHash']])
        self.assertEqual(self.client.get('/api/archives/'+saved['id']+'/project').status_code,200)

    def test_pending_budget_rejects_new_files_without_partial_insert(self):
        _,raw=image_data();digest=hashlib.sha256(raw).hexdigest()
        with patch('backend.archives.PENDING_BUDGET',1):
            response=self.client.put('/api/archive-assets/'+digest,content=raw,headers={'Content-Type':'image/png'})
        self.assertEqual(response.status_code,413)
        self.assertEqual(self.client.post('/api/archive-assets/check',json={'hashes':[digest]}).json()['missing'],[digest])
        self.upload(raw)
        with patch('backend.archives.PENDING_BUDGET',1):
            self.upload(raw)  # idempotent retries do not consume extra capacity
