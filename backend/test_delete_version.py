import time
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.app import app
from backend.archives import connect,cleanup_pending_assets,PENDING_TTL
from backend.test_support import IsolatedAuthTest,authenticated_client
from backend.test_archives import payload

class DeleteVersionTests(IsolatedAuthTest):
    def setUp(self):
        super().setUp();self.client=authenticated_client(app)
    def save(self,data):
        r=self.client.post('/api/archives',json=data)
        self.assertEqual(r.status_code,200,r.text);return r.json()
    def test_delete_one_keeps_other_versions_images_and_sequence(self):
        a=payload();first=self.save(a);a['project']['revision']=2;second=self.save(a)
        url='/api/archives/'+second['id']
        self.assertEqual(self.client.delete(url).json()['deleted_versions'],1)
        self.assertEqual(self.client.delete(url).json()['deleted_versions'],0)
        self.assertEqual(self.client.get(url+'/project').status_code,404)
        with patch('backend.archives.time.time',return_value=time.time()+PENDING_TTL+1):cleanup_pending_assets()
        self.assertEqual(self.client.get('/api/archives/'+first['id']+'/project').status_code,200)
        third=self.save(a);self.assertEqual(third['sequence'],3)
        self.assertEqual(len(self.client.get('/api/archives').json()),2)
    def test_last_version_can_be_deleted_without_deleting_campaign(self):
        data=payload();saved=self.save(data)
        self.client.delete('/api/archives/'+saved['id'])
        again=self.save(data);self.assertEqual(again['sequence'],2)
    def test_metadata_does_not_expand_or_include_image_assets(self):
        data=payload();version=self.save(data)
        response=self.client.get('/api/archives/'+version['id'])
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['project']['campaign'],data['project']['campaign'])
        self.assertNotIn('data:image',response.text)
        self.assertNotIn('products',response.json()['project'])
    def test_auth_and_unknown_id(self):
        version=self.save(payload());url='/api/archives/'+version['id']
        self.assertEqual(TestClient(app).delete(url).status_code,401)
        self.assertEqual(self.client.delete(url,headers={'Origin':'https://evil.invalid'}).status_code,403)
        self.assertEqual(self.client.delete('/api/archives/invalid').status_code,422)
        self.assertEqual(self.client.get(url).status_code,200)
