import os
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

PASSWORD = 'test-admin-password-2026'

def authenticated_client(app):
    client = TestClient(app)
    with patch.dict(os.environ, {'ADMIN_USERNAME': 'admin', 'ADMIN_PASSWORD': PASSWORD}):
        response = client.post('/api/auth/login', json={'username': 'admin', 'password': PASSWORD})
    assert response.status_code == 200, response.text
    return client

class IsolatedAuthTest(unittest.TestCase):
    def setUp(self):
        self.auth_dir = tempfile.TemporaryDirectory()
        self.auth_env = patch.dict(os.environ, {'POSTER_DATA_DIR': self.auth_dir.name, 'ADMIN_USERNAME': 'admin', 'ADMIN_PASSWORD': PASSWORD})
        self.auth_env.start()
        self.addCleanup(self.auth_dir.cleanup)
        self.addCleanup(self.auth_env.stop)
