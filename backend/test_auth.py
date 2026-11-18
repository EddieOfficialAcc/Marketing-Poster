import hashlib
import os
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.app import app
from backend.auth import COOKIE, database
from backend.test_support import IsolatedAuthTest, PASSWORD, authenticated_client

class AuthTests(IsolatedAuthTest):
    def test_all_business_endpoints_require_login(self):
        client=TestClient(app)
        for url in ['/api/archives','/api/cutout-jobs/id','/api/archives/id/poster','/api/auth/me']:
            self.assertEqual(client.get(url).status_code,401)
        for url in ['/api/import-campaign','/api/remove-background','/api/archives']:
            self.assertEqual(client.post(url).status_code,401)
        self.assertEqual(client.get('/api/health').status_code,200)

    def test_login_cookie_persistence_logout_and_revocation(self):
        client=authenticated_client(app)
        response=client.get('/api/auth/me');self.assertEqual(response.json()['username'],'admin')
        token=client.cookies.get(COOKIE)
        other=TestClient(app);other.cookies.set(COOKIE,token)
        self.assertEqual(other.get('/api/auth/me').status_code,200)
        self.assertEqual(client.post('/api/auth/logout').status_code,200)
        self.assertEqual(other.get('/api/auth/me').status_code,401)
        self.assertEqual(client.get('/api/auth/me').status_code,401)

    def test_password_and_token_not_stored_in_plaintext_and_expiry_enforced(self):
        client=authenticated_client(app);token=client.cookies.get(COOKIE)
        with database() as db:
            row=db.execute('SELECT * FROM administrator').fetchone()
            self.assertNotEqual(row['password_hash'],PASSWORD)
            self.assertEqual(db.execute('SELECT digest FROM sessions').fetchone()[0],hashlib.sha256(token.encode()).hexdigest())
            db.execute('UPDATE sessions SET expires=0')
        self.assertEqual(client.get('/api/auth/me').status_code,401)

    def test_wrong_password_rate_limit_and_cross_site_rejected(self):
        client=TestClient(app)
        data={'username':'admin','password':'wrong'}
        for _ in range(5):self.assertEqual(client.post('/api/auth/login',json=data).status_code,401)
        self.assertEqual(client.post('/api/auth/login',json=data).status_code,429)
        self.assertEqual(client.post('/api/auth/login',json=data,headers={'Origin':'https://evil.invalid'}).status_code,403)
        self.assertEqual(client.post('/api/auth/login',json=data,headers={'Sec-Fetch-Site':'cross-site'}).status_code,403)

    def test_cookie_flags_and_no_store(self):
        with patch.dict(os.environ,{'COOKIE_SECURE':'true'}):
            response=TestClient(app).post('/api/auth/login',json={'username':'admin','password':PASSWORD})
        cookie=response.headers['set-cookie']
        for flag in ['HttpOnly','SameSite=strict','Secure']:self.assertIn(flag,cookie)
        self.assertEqual(response.headers['cache-control'],'no-store')

    def test_missing_initial_password_fails_closed(self):
        with patch.dict(os.environ,{'ADMIN_PASSWORD':''}):
            response=TestClient(app).post('/api/auth/login',json={'username':'admin','password':PASSWORD})
        self.assertEqual(response.status_code,503)

    def test_deployment_password_reset_accepts_seven_characters_and_revokes_old_sessions(self):
        from backend.auth import sync_admin
        client=authenticated_client(app)
        with patch.dict(os.environ,{'ADMIN_PASSWORD':'short77'}):
            sync_admin()
            self.assertEqual(client.get('/api/auth/me').status_code,401)
            self.assertEqual(client.post('/api/auth/login',json={'username':'admin','password':PASSWORD}).status_code,401)
            self.assertEqual(client.post('/api/auth/login',json={'username':'admin','password':'short77'}).status_code,200)
            sync_admin()
            self.assertEqual(client.get('/api/auth/me').status_code,200)

    def test_startup_applies_deployment_password(self):
        with patch.dict(os.environ,{'ADMIN_PASSWORD':'short77'}):
            with TestClient(app) as client:
                self.assertEqual(client.post('/api/auth/login',json={'username':'admin','password':'short77'}).status_code,200)

    def test_lockout_lasts_fifteen_minutes_after_the_fifth_failure(self):
        from backend.auth import authenticate
        with patch('backend.auth.time.time',return_value=1000):
            for _ in range(4):self.assertEqual(authenticate('admin','wrong','test-ip')[1],401)
        with patch('backend.auth.time.time',return_value=1800):
            self.assertEqual(authenticate('admin','wrong','test-ip')[1],401)
        with patch('backend.auth.time.time',return_value=2000):
            self.assertEqual(authenticate('admin',PASSWORD,'test-ip')[1],429)
        with patch('backend.auth.time.time',return_value=2701):
            self.assertEqual(authenticate('admin',PASSWORD,'test-ip')[1],200)
