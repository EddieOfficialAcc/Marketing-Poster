from backend.test_support import authenticated_client, IsolatedAuthTest
import base64
import copy
import io
import os
import tempfile
import unittest
import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image
from backend.app import app
from backend.archives import connect


def image_data(size=(16, 20), color='red'):
    stream = io.BytesIO()
    Image.new('RGBA', size, color).save(stream, 'PNG')
    data = stream.getvalue()
    return 'data:image/png;base64,' + base64.b64encode(data).decode(), data


def payload():
    image, _ = image_data()
    return {'campaignId': str(uuid.uuid4()), 'project': {
        'schema': 1, 'revision': 1, 'reviewedRevision': 1,
        'campaign': {'name': '會員優惠', 'start': '2026-10-01', 'end': '2026-10-31', 'stores': 'A店'},
        'template': 'clean', 'background': None,
        'products': [{'id': 'rice', 'name': '米', 'imageUrl': image}],
        'nodes': [{'id': 'node', 'type': 'product', 'productId': 'rice', 'name': '米', 'price': '33', 'quantity': 2, 'x': 40, 'y': 200, 'w': 240, 'h': 300}],
    }}


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'POSTER_DATA_DIR': self.temp.name})
        self.env.start()
        self.client = authenticated_client(app)

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def save(self, data):
        response = self.client.post('/api/archives', json=data)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_latest_only_updates_one_record_and_deleted_campaign_stays_deleted(self):
        data=payload()
        self.save(data)
        data['project']['revision']=2
        latest=self.save(data)
        data['latestOnly']=True
        data['project']['revision']=3
        updated=self.save(data)
        self.assertEqual(updated['id'],latest['id'])
        self.assertEqual(len(self.client.get('/api/archives').json()),1)
        self.assertEqual(updated['revision'],3)
        data['project']['revision']=2
        self.assertEqual(self.save(data)['revision'],3)
        response=self.client.delete('/api/campaigns/'+data['campaignId'])
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.client.post('/api/archives',json=data).status_code,410)
        self.assertEqual(self.client.get('/api/archives').json(),[])

    def test_latest_only_preserves_confirmation_when_autosave_follows(self):
        data=payload();data['latestOnly']=True
        data.update(confirmed=True,confirmedBy='admin',poster=image_data((1800,2560))[0])
        saved=self.save(data)
        data.update(confirmed=False,confirmedBy='',poster=None)
        saved_again=self.save(data)
        self.assertEqual(saved_again['id'],saved['id'])
        self.assertEqual(saved_again['poster_hash'],saved['poster_hash'])
        self.assertTrue(saved_again['confirmed_by'])
        # A draft queued before confirmation has no reviewedRevision yet.
        data['project']['reviewedRevision']=None
        self.assertTrue(self.save(data)['confirmed_by'])
        # Reopening bumps the revision without changing content: the confirmed poster stays.
        data['project']['revision']+=1
        reopened=self.save(data)
        self.assertTrue(reopened['confirmed_by'])
        self.assertEqual(reopened['poster_hash'],saved['poster_hash'])
        self.assertFalse(reopened['stored'])
        # A real edit after confirming needs confirming again.
        data['project']['campaign']['name']+='（改）'
        self.assertFalse(self.save(data)['confirmed_by'])

    def test_stale_confirmation_is_not_stored(self):
        data=payload();data['latestOnly']=True
        data['project']['revision']=10;data['project']['reviewedRevision']=10
        self.save(data)
        stale=payload();stale['latestOnly']=True;stale['campaignId']=data['campaignId']
        stale['project']['revision']=5;stale['project']['reviewedRevision']=5;stale['project']['campaign']['name']+='（舊）'
        stale.update(confirmed=True,confirmedBy='admin',poster=image_data((1800,2560))[0])
        result=self.save(stale)
        self.assertFalse(result['stored'])
        self.assertFalse(result['confirmed_by'])
        self.assertEqual(result['revision'],10)

    def test_latest_only_retires_unused_images_and_keeps_shared_assets(self):
        data=payload();data['latestOnly']=True
        saved=self.save(data)
        with connect() as db:
            old_hash=db.execute('SELECT hash FROM assets').fetchone()[0]
        data['project']['revision']+=1
        data['project']['products'][0]['imageUrl']=image_data(color='blue')[0]
        updated=self.save(data)
        with connect() as db:
            self.assertIsNotNone(db.execute('SELECT 1 FROM pending_assets WHERE hash=?',(old_hash,)).fetchone())
        self.assertEqual(updated['id'],saved['id'])
        self.assertEqual(self.save(data)['created_at'],updated['created_at'])


    def test_persist_reload_and_deduplicate_images_and_retries(self):
        data = payload()
        first = self.save(data)
        self.assertEqual(self.save(data)['id'], first['id'])
        data['project']['revision'] = 2
        data['project']['nodes'][0]['price'] = '40'
        second = self.save(data)
        self.assertEqual(second['sequence'], 2)
        # New client/database connection reads the old immutable snapshot.
        original = authenticated_client(app).get(f"/api/archives/{first['id']}/project").json()
        self.assertEqual(original['project']['nodes'][0]['price'], '33')
        self.assertEqual(original['project']['products'][0]['imageUrl'], data['project']['products'][0]['imageUrl'])
        db = connect()
        try:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM assets').fetchone()[0], 1)
        finally:
            db.close()

    def test_confirmation_preserves_exact_poster_and_actor(self):
        data = payload()
        poster, raw = image_data((1800, 2560))
        data.update(confirmed=True, confirmedBy='陳小姐 / M01', poster=poster)
        version = self.save(data)
        self.assertEqual(version['confirmed_by'], 'admin')
        self.assertTrue(version['created_at'])
        self.assertEqual(len(version['digest']), 64)
        self.assertEqual(self.client.get(f"/api/archives/{version['id']}/poster").content, raw)
        data['project']['revision'] = 2
        data['project']['reviewedRevision'] = 2
        data['project']['products'][0]['imageUrl'] = image_data(color='blue')[0]
        data['poster'] = image_data((1800, 2560), 'blue')[0]
        later = self.save(data)
        self.assertNotEqual(later['poster_hash'], version['poster_hash'])
        self.assertEqual(self.client.get(f"/api/archives/{version['id']}/poster").content, raw)

    def test_confirmation_rejects_missing_proof_or_invalid_offer(self):
        valid = payload()
        valid.update(confirmed=True, confirmedBy='M01', poster=image_data((1800, 2560))[0])
        variants = []
        for key, value in [('poster', None)]:
            p = copy.deepcopy(valid); p[key] = value; variants.append(p)
        p = copy.deepcopy(valid); p['project']['reviewedRevision'] = None; variants.append(p)
        p = copy.deepcopy(valid); p['project']['nodes'][0]['price'] = '-1'; variants.append(p)
        p = copy.deepcopy(valid); p['project']['nodes'][0]['pictures'] = [{'productId': 'missing'}]; variants.append(p)
        p = copy.deepcopy(valid); p['project']['template'] = 'membership'; variants.append(p)
        for data in variants:
            self.assertEqual(self.client.post('/api/archives', json=data).status_code, 422)
        self.assertEqual(self.client.get('/api/archives').json(), [])

    def test_templates_and_original_photos_round_trip(self):
        data = payload()
        data['project']['template'] = 'membership'
        data['project']['templateImage'] = image_data(color='green')[0]
        data['project']['backgrounds'] = [{'id': 'b', 'imageUrl': image_data(color='blue')[0]}]
        version = self.save(data)
        restored = self.client.get(f"/api/archives/{version['id']}/project").json()['project']
        self.assertEqual(restored, {**data['project'], 'savedBy': 'admin'})
        # No version overwrite/delete routes are exposed.
        self.assertEqual(self.client.delete(f"/api/archives/{version['id']}/project").status_code, 405)

    def test_invalid_images_never_create_partial_archive(self):
        data = payload()
        data['project']['products'][0]['imageUrl'] = 'data:image/png;base64,YWJj'
        self.assertEqual(self.client.post('/api/archives', json=data).status_code, 422)
        self.assertEqual(self.client.get('/api/archives').json(), [])
        self.assertEqual(self.client.get('/api/archives/missing/project').status_code, 404)

    def test_campaign_filter_does_not_mix_versions(self):
        one, two = payload(), payload()
        self.save(one); self.save(two)
        rows = self.client.get('/api/archives', params={'campaign_id': one['campaignId']}).json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['campaign_id'], one['campaignId'])
        self.assertEqual(self.client.get('/api/archives?offset=-1').status_code, 422)

    def test_custom_page_checks_actual_png_size_and_keeps_background_transform(self):
        data = payload()
        data['project']['page'] = {'width':1080,'height':1080,'unit':'px','dpi':150}
        data['project']['backgroundPlacement'] = {'x':-30,'y':0,'w':930,'h':1200}
        data.update(confirmed=True,confirmedBy='M01',poster=image_data((1080,1080))[0])
        version = self.save(data)
        stored=self.client.get(f"/api/archives/{version['id']}/project").json()['project']
        self.assertEqual(stored['page'],data['project']['page'])
        self.assertEqual(stored['backgroundPlacement'],data['project']['backgroundPlacement'])
        data['poster']=image_data((1800,2560))[0]
        self.assertEqual(self.client.post('/api/archives',json=data).status_code,422)

    def test_icon_assets_round_trip_and_missing_reference_rejected(self):
        data=payload();image,_=image_data()
        data['project']['icons']=[{'id':'logo','name':'標識','width':16,'height':20,'imageUrl':image}]
        data['project']['nodes'].append({'id':'icon','type':'imageIcon','iconId':'logo','text':'標識','x':40,'y':80,'w':60,'h':75})
        saved=self.save(data)
        restored=self.client.get(f"/api/archives/{saved['id']}/project").json()['project']
        self.assertEqual(restored['icons'],data['project']['icons'])
        self.assertEqual(restored['nodes'][-1]['iconId'],'logo')
        data['project']['nodes'][-1]['iconId']='missing'
        self.assertEqual(self.client.post('/api/archives',json=data).status_code,422)

