import io
import json
import os
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import app
from backend import auth, workflow
from backend.test_support import IsolatedAuthTest, authenticated_client

SHEET = ('活動名稱,商品名稱,規格,優惠總價,優惠件數,開始日期,結束日期,適用門店\n'
         '雙十一至優價,商品A,100克,20,1,2026-11-20,2026-11-30,全線分店\n'
         '雙十一至優價,商品B,200克,36,2,2026-11-20,2026-11-30,全線分店\n').encode()
PEOPLE = {'buyer': ('陳採購', ['poster_purchaser']), 'designer': ('李設計', ['poster_marketing']),
          'checker': ('黃核對', ['poster_marketing']), 'store': ('分店同事', ['poster_viewer']), 'nobody': ('無權限', ['other_app'])}


def login(username):
    client = TestClient(app)
    with patch.object(auth, 'intranet_login', side_effect=lambda u, p: (u, *PEOPLE[u]) if u in PEOPLE else None):
        response = client.post('/api/auth/login', json={'username': username, 'password': 'pw'})
    return client, response


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class WorkflowTests(IsolatedAuthTest):
    def setUp(self):
        super().setUp()
        self.version = None
        patcher = patch.object(workflow, 'latest_versions', side_effect=lambda ids=None: (
            {cid: self.version for cid in (ids or [])} if self.version and ids is not None else ({} if not self.version else {self.campaign: self.version})))
        patcher.start()
        self.addCleanup(patcher.stop)

    def poster(self, has=True):
        self.version = {'versionId': 'v1', 'sequence': 3, 'revision': 5, 'savedAt': '2026-11-13T10:00:00+00:00', 'confirmedBy': None,
                        'hasPoster': has, 'name': '雙十一至優價', 'start': '2026-11-20', 'end': '2026-11-30', 'stores': '全線分店',
                        'savedBy': 'designer', 'products': 2}

    def test_intranet_login_maps_permission_codes_to_roles(self):
        calls = []
        def urlopen(request, timeout):
            calls.append((request.full_url, request.get_header('Authorization'), request.data))
            if request.full_url.endswith('/api/auth/local'):
                return FakeResponse(json.dumps({'jwt': 'J', 'user': {'username': 'Jaydon Shen'}}).encode())
            return FakeResponse(json.dumps({'username': 'Jaydon Shen', 'content_permissions': [{'code': 'MKT_POSTER'}, {'code': 'hotline'}]}).encode())
        env = {'INTRANET_AUTH_URL': 'http://intranet:8082/', 'POSTER_ROLE_CODES_MARKETING': 'mkt_poster'}
        with patch.dict(os.environ, env), patch.object(auth.urllib.request, 'urlopen', side_effect=urlopen):
            response = TestClient(app).post('/api/auth/login', json={'username': 'Jaydon Shen', 'password': 'secret'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.json()['roles'], response.json()['name']), (['marketing'], 'Jaydon Shen'))
        self.assertEqual(json.loads(calls[0][2]), {'identifier': 'Jaydon Shen', 'password': 'secret'})
        self.assertIn('populate[content_permissions][fields]=code', calls[1][0])
        self.assertEqual(calls[1][1], 'Bearer J')
        with auth.database() as db:   # neither the password nor the intranet token is stored
            dump = json.dumps([list(r) for r in db.execute('SELECT * FROM sessions')] + [list(r) for r in db.execute('SELECT * FROM known_users')])
        self.assertNotIn('secret', dump)
        self.assertNotIn('"J"', dump)

    def test_intranet_login_by_email_keeps_the_canonical_username(self):
        def urlopen(request, timeout):
            if request.full_url.endswith('/api/auth/local'):
                return FakeResponse(json.dumps({'jwt': 'J', 'user': {'username': 'designer'}}).encode())
            return FakeResponse(json.dumps({'username': 'designer', 'content_permissions': [{'code': 'poster_marketing'}]}).encode())
        with patch.dict(os.environ, {'INTRANET_AUTH_URL': 'http://intranet:8082/'}), patch.object(auth.urllib.request, 'urlopen', side_effect=urlopen):
            client = TestClient(app)
            self.assertEqual(client.post('/api/auth/login', json={'username': 'Designer@Corp.com', 'password': 'pw'}).status_code, 200)
        self.assertEqual(client.get('/api/auth/me').json()['username'], 'designer')

    def test_intranet_refusals(self):
        _, response = login('nobody')
        self.assertEqual(response.status_code, 403)
        self.assertIn('未獲授權', response.json()['detail'])
        with auth.database() as db:
            stored = db.execute('SELECT codes, roles FROM known_users WHERE username=?', ('nobody',)).fetchone()
        self.assertEqual((json.loads(stored['codes']), json.loads(stored['roles'])), (['other_app'], []))
        _, response = login('stranger')
        self.assertEqual(response.status_code, 401)
        def down(request, timeout):
            raise auth.urllib.error.URLError('down')
        with patch.dict(os.environ, {'INTRANET_AUTH_URL': 'http://intranet:8082'}), patch.object(auth.urllib.request, 'urlopen', side_effect=down):
            response = TestClient(app).post('/api/auth/login', json={'username': 'someone', 'password': 'x'})
        self.assertEqual(response.status_code, 503)

    def test_roles_limit_editing_apis(self):
        buyer, _ = login('buyer')
        store, _ = login('store')
        for client in (buyer, store):
            self.assertEqual(client.post('/api/archives', json={}).status_code, 403)
            self.assertEqual(client.post('/api/cutout-jobs', content=b'x').status_code, 403)
            self.assertEqual(client.get('/api/workflow').status_code, 200)
        self.assertEqual(buyer.delete('/api/campaigns/x').status_code, 403)
        self.assertEqual(store.post('/api/workflow?filename=a.csv', content=SHEET).status_code, 403)
        admin = authenticated_client(app)
        self.assertEqual(admin.get('/api/auth/me').json()['roles'], ['admin'])

    def test_full_workflow_with_separate_designer_and_checker(self):
        buyer, _ = login('buyer')
        designer, _ = login('designer')
        checker, _ = login('checker')
        created = buyer.post('/api/workflow?filename=sheet.csv&priority=high&due=2026-11-18&note=請加新貨標籤', content=SHEET)
        self.assertEqual(created.status_code, 200, created.text)
        self.campaign = cid = created.json()['campaign_id']
        self.assertRegex(created.json()['code'], r'^P\d{4}-001$')
        item = buyer.get(f'/api/workflow/{cid}').json()
        self.assertEqual((item['status'], item['name'], item['product_count'], item['start'], item['priority']), ('submitted', '雙十一至優價', 2, '2026-11-20', 'high'))
        self.assertIn('cancel', item['actions'])
        self.assertNotIn('claim', item['actions'])
        self.assertEqual(buyer.post(f'/api/workflow/{cid}/action', json={'action': 'claim'}).status_code, 403)
        self.assertEqual(designer.get(f'/api/workflow/{cid}/sheet').content, SHEET)

        item = designer.post(f'/api/workflow/{cid}/action', json={'action': 'claim'}).json()
        self.assertEqual((item['status'], item['assignee_name']), ('in_design', '李設計'))
        self.assertNotIn('submit_review', item['actions'])          # no poster preview yet
        self.poster()
        item = designer.post(f'/api/workflow/{cid}/action', json={'action': 'submit_review'}).json()
        self.assertEqual(item['status'], 'pending_confirm')
        self.assertEqual(buyer.post(f'/api/workflow/{cid}/action', json={'action': 'confirm'}).status_code, 403)
        with patch.dict(os.environ, {'POSTER_CONFIRM_BY_OTHER': 'true'}):
            refused = designer.post(f'/api/workflow/{cid}/action', json={'action': 'confirm'})
            self.assertEqual(refused.status_code, 409)
            self.assertIn('不同同事', refused.json()['detail'])
            self.assertEqual(checker.post(f'/api/workflow/{cid}/action', json={'action': 'send_back'}).status_code, 422)  # reason required
            item = checker.post(f'/api/workflow/{cid}/action', json={'action': 'send_back', 'comment': '價格要改 $18'}).json()
            self.assertEqual(item['status'], 'in_design')
            designer.post(f'/api/workflow/{cid}/action', json={'action': 'submit_review'})
            item = checker.post(f'/api/workflow/{cid}/action', json={'action': 'confirm'}).json()
        self.assertEqual((item['status'], item['confirmed_by_name'], item['step']), ('confirmed', '黃核對', 4))
        actions = [(e['actionName'], e['actor_name'], e['toName']) for e in reversed(item['events'])]
        self.assertEqual(actions, [('提交活動表', '陳採購', '待處理'), ('接手製作', '李設計', '製作中'), ('提交確認', '李設計', '待確認'),
                                   ('退回修改', '黃核對', '製作中'), ('提交確認', '李設計', '待確認'), ('確認海報', '黃核對', '已確認')])
        listed = buyer.get('/api/workflow?tab=done').json()
        self.assertEqual(([i['code'] for i in listed['items']], listed['counts']), ([item['code']], {'processing': 0, 'pending': 0, 'done': 1}))
        self.assertIn('雙十一至優價', buyer.get('/api/workflow/export').content.decode('utf-8-sig'))

    def test_return_to_purchaser_and_resubmit_corrected_sheet(self):
        buyer, _ = login('buyer')
        designer, _ = login('designer')
        self.campaign = cid = buyer.post('/api/workflow?filename=sheet.csv', content=SHEET).json()['campaign_id']
        item = designer.post(f'/api/workflow/{cid}/action', json={'action': 'return', 'comment': '缺少規格'}).json()
        self.assertEqual(item['status'], 'returned')
        self.assertIn('resubmit', buyer.get(f'/api/workflow/{cid}').json()['actions'])
        fixed = SHEET.replace(b'2026-11-30', b'2026-12-05')
        item = buyer.put(f'/api/workflow/{cid}/sheet?filename=fixed.csv&note=已補規格', content=fixed).json()
        self.assertEqual((item['status'], item['end'], item['sheet']['filename']), ('submitted', '2026-12-05', 'fixed.csv'))
        other, _ = login('checker')
        self.assertEqual(other.put(f'/api/workflow/{cid}/sheet?filename=x.csv', content=fixed).status_code, 403)
        bad = buyer.post('/api/workflow?filename=bad.csv', content=b'activity,name\n1,2\n')
        self.assertEqual(bad.status_code, 422)

    def test_strapi_nested_permission_codes_map_to_a_role(self):
        def urlopen(request, timeout):
            if request.full_url.endswith('/api/auth/local'):
                return FakeResponse(json.dumps({'jwt': 'tok', 'user': {'username': 'buyer-1'}}).encode())
            return FakeResponse(json.dumps({'displayName': '採購甲', 'content_permissions': {'data': [
                {'id': 3, 'attributes': {'code': 'poster_purchaser'}}]}}).encode())
        with patch.dict(os.environ, {'INTRANET_AUTH_URL': 'http://intranet:8082'}), patch.object(auth.urllib.request, 'urlopen', side_effect=urlopen):
            response = TestClient(app).post('/api/auth/login', json={'username': 'buyer-1', 'password': 'pw'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.json()['roles'], response.json()['policies']['confirmByOther']), (['purchaser'], False))

    def test_admin_maps_an_unknown_intranet_code_onto_a_role(self):
        _, refused = login('nobody')
        self.assertEqual(refused.status_code, 403)
        admin = authenticated_client(app)
        self.assertEqual(login('buyer')[0].get('/api/auth/role-grants').status_code, 403)
        listed = admin.get('/api/auth/role-grants').json()
        person = next(u for u in listed['users'] if u['username'] == 'nobody')
        self.assertEqual((person['codes'], person['roles']), (['other_app'], []))
        self.assertEqual(admin.post('/api/auth/role-grants', json={'role': 'viewer', 'code': 'other_app'}).status_code, 200)
        client, response = login('nobody')
        self.assertEqual((response.status_code, response.json()['roles']), (200, ['viewer']))
        self.assertEqual(client.get('/api/workflow').status_code, 200)
        self.assertEqual(admin.delete('/api/auth/role-grants', params={'role': 'viewer', 'code': 'other_app'}).status_code, 200)

    def test_grant_updates_the_open_session(self):
        store, response = login('store')
        self.assertEqual(response.json()['roles'], ['viewer'])
        admin = authenticated_client(app)
        admin.post('/api/auth/role-grants', json={'role': 'marketing', 'code': 'poster_viewer'})
        self.assertEqual(store.get('/api/auth/me').json()['roles'], ['marketing', 'viewer'])
        self.assertEqual(store.get('/api/auth/users').status_code, 200)

    def test_editor_saves_move_the_workflow(self):
        buyer, _ = login('buyer')
        self.campaign = cid = buyer.post('/api/workflow?filename=sheet.csv', content=SHEET).json()['campaign_id']
        designer = {'username': 'designer', 'name': '李設計', 'permissions': ['view', 'edit', 'confirm']}
        workflow.after_version_saved(cid, {'sequence': 1, 'revision': 1, 'confirmed_by': None}, designer, False)
        self.poster()
        self.assertEqual(buyer.get(f'/api/workflow/{cid}').json()['status'], 'in_design')
        workflow.after_version_saved(cid, {'sequence': 2, 'revision': 2, 'confirmed_by': 'designer'}, designer, True)
        self.assertEqual(buyer.get(f'/api/workflow/{cid}').json()['status'], 'confirmed')
        workflow.after_version_saved(cid, {'sequence': 3, 'revision': 3, 'confirmed_by': None}, designer, False)
        item = buyer.get(f'/api/workflow/{cid}').json()
        self.assertEqual((item['status'], item['events'][0]['actionName']), ('in_design', '確認後再修改'))

    def test_confirming_in_the_editor_confirms_before_anyone_claims(self):
        buyer, _ = login('buyer')
        self.campaign = cid = buyer.post('/api/workflow?filename=sheet.csv', content=SHEET).json()['campaign_id']
        designer = {'username': 'designer', 'name': '李設計', 'permissions': ['view', 'edit', 'confirm']}
        workflow.after_version_saved(cid, {'sequence': 1, 'revision': 1, 'confirmed_by': 'designer'}, designer, True)
        item = buyer.get(f'/api/workflow/{cid}').json()
        self.assertEqual((item['status'], item['confirmed_by_name'], item['assignee_name']), ('confirmed', '李設計', '李設計'))

    def test_separate_confirm_sends_the_designers_own_check_to_a_colleague(self):
        buyer, _ = login('buyer')
        self.campaign = cid = buyer.post('/api/workflow?filename=sheet.csv', content=SHEET).json()['campaign_id']
        designer = {'username': 'designer', 'name': '李設計', 'permissions': ['view', 'edit', 'confirm']}
        workflow.after_version_saved(cid, {'sequence': 1, 'revision': 1, 'confirmed_by': None}, designer, False)
        with patch.dict(os.environ, {'POSTER_CONFIRM_BY_OTHER': 'true'}):
            workflow.after_version_saved(cid, {'sequence': 2, 'revision': 2, 'confirmed_by': 'designer'}, designer, True)
        item = buyer.get(f'/api/workflow/{cid}').json()
        self.assertEqual((item['status'], item['events'][0]['actionName']), ('pending_confirm', '提交確認'))
