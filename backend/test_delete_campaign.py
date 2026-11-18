import copy
import time
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.app import app
from backend.archives import connect,cleanup_pending_assets,PENDING_TTL
from backend.test_support import IsolatedAuthTest,authenticated_client
from backend.test_archives import payload,image_data

class DeleteCampaignTests(IsolatedAuthTest):
    def setUp(self):
        super().setUp()
        self.client=authenticated_client(app)

    def save(self,data):
        r=self.client.post('/api/archives',json=data)
        self.assertEqual(r.status_code,200,r.text)
        return r.json()

    def test_delete_all_versions_keeps_other_campaign_and_shared_images(self):
        a=payload();first=self.save(a)
        a['project']['revision']=2;self.save(a)
        b=payload();other=self.save(b)
        r=self.client.delete('/api/campaigns/'+a['campaignId'])
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['deleted_versions'],2)
        self.assertEqual(self.client.get('/api/archives',params={'campaign_id':a['campaignId']}).json(),[])
        self.assertEqual(self.client.get('/api/archives/'+first['id']+'/project').status_code,404)
        with patch('backend.archives.time.time',return_value=time.time()+PENDING_TTL+1):cleanup_pending_assets()
        self.assertEqual(self.client.get('/api/archives/'+other['id']+'/project').status_code,200)
        self.assertEqual(self.client.post('/api/archives',json=a).status_code,410)
        self.assertEqual(self.client.post('/api/archives/incremental',json=a).status_code,410)
        self.assertEqual(self.client.delete('/api/campaigns/'+a['campaignId']).json()['deleted_versions'],0)

    def test_unshared_assets_released_after_grace_period(self):
        a=payload();self.save(a)
        self.client.delete('/api/campaigns/'+a['campaignId'])
        with connect() as db:self.assertGreater(db.execute('SELECT COUNT(*) FROM pending_assets').fetchone()[0],0)
        with patch('backend.archives.time.time',return_value=time.time()+PENDING_TTL+1):cleanup_pending_assets()
        with connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM assets').fetchone()[0],0)

    def test_confirmed_poster_deleted_and_new_campaign_can_reuse_images(self):
        a=payload();a.update(confirmed=True,confirmedBy='admin',poster=image_data((1800,2560))[0]);v=self.save(a)
        self.assertEqual(self.client.delete('/api/campaigns/'+a['campaignId']).status_code,200)
        self.assertEqual(self.client.get('/api/archives/'+v['id']+'/poster').status_code,404)
        self.save(payload())

    def test_auth_origin_and_unknown_campaign(self):
        a=payload();self.save(a);url='/api/campaigns/'+a['campaignId']
        self.assertEqual(TestClient(app).delete(url).status_code,401)
        self.assertEqual(self.client.delete(url,headers={'Origin':'https://evil.invalid'}).status_code,403)
        self.assertEqual(self.client.delete('/api/campaigns/not-a-uuid').status_code,422)
        self.assertEqual(self.client.delete('/api/campaigns/'+payload()['campaignId']).status_code,404)
        self.assertEqual(len(self.client.get('/api/archives').json()),1)
