from backend.test_support import authenticated_client, IsolatedAuthTest
import io
import os
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
from fastapi.testclient import TestClient
from backend.app import app
from backend import cutout_jobs as jobs


def photo(color):
    stream=io.BytesIO()
    Image.new('RGB',(16,16),color).save(stream,'PNG')
    return stream.getvalue()


class JobsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.env=patch.dict(os.environ,{'POSTER_DATA_DIR':self.temp.name});self.env.start()
        self.worker=patch.object(jobs,'ensure_worker');self.worker.start()
        self.client=authenticated_client(app)

    def tearDown(self):
        self.worker.stop();self.env.stop();self.temp.cleanup()

    def submit(self,color):
        response=self.client.post('/api/cutout-jobs',content=photo(color),headers={'Content-Type':'image/png'})
        self.assertEqual(response.status_code,202,response.text)
        return response.json()

    def test_busy_requests_queue_and_refresh_reads_persisted_result(self):
        a=self.submit('red');b=self.submit('blue')
        self.assertEqual(b['ahead'],1)
        self.assertEqual(self.submit('red')['id'],a['id'])
        seen=[]
        def processor(data,progress):
            seen.append(data);progress('processing');return data
        with patch.object(jobs,'_processor',processor):
            self.assertTrue(jobs.process_next());self.assertTrue(jobs.process_next())
            self.assertFalse(jobs.process_next())
        self.assertEqual(seen,[photo('red'),photo('blue')])
        fresh=authenticated_client(app)
        self.assertEqual(fresh.get('/api/cutout-jobs/'+a['id']).json()['state'],'succeeded')
        self.assertEqual(fresh.get('/api/cutout-jobs/'+a['id']+'/result').content,photo('red'))
        self.assertEqual(self.submit('red')['id'],a['id'])

    def test_failed_task_does_not_block_next_and_can_retry(self):
        a=self.submit('red');b=self.submit('blue')
        with patch.object(jobs,'_processor',side_effect=[RuntimeError('failed'),photo('blue')]):
            jobs.process_next();jobs.process_next()
        self.assertEqual(self.client.get('/api/cutout-jobs/'+a['id']).json()['state'],'failed')
        self.assertEqual(self.client.get('/api/cutout-jobs/'+b['id']).json()['state'],'succeeded')
        self.assertNotEqual(self.submit('red')['id'],a['id'])

    def test_unfinished_and_invalid_tasks_do_not_return_fake_images(self):
        a=self.submit('red')
        self.assertEqual(self.client.get('/api/cutout-jobs/'+a['id']+'/result').status_code,409)
        self.assertEqual(self.client.post('/api/cutout-jobs',content=b'bad',headers={'Content-Type':'image/png'}).status_code,422)
        self.assertEqual(self.client.get('/api/cutout-jobs/missing/result').status_code,404)

    def test_terminal_sources_released_and_cache_cleanup_never_touches_active_jobs(self):
        a=self.submit('red');b=self.submit('blue')
        with patch.object(jobs,'_processor',return_value=photo('red')):jobs.process_next()
        conn=jobs.db()
        try:
            self.assertIsNone(conn.execute('SELECT source FROM jobs WHERE id=?',(a['id'],)).fetchone()[0])
            with conn:conn.execute('UPDATE jobs SET finished=1 WHERE id=?',(a['id'],))
        finally:conn.close()
        jobs.cleanup(now=jobs.CACHE_DAYS*86400+2)
        conn=jobs.db()
        try:
            self.assertIsNone(conn.execute('SELECT id FROM jobs WHERE id=?',(a['id'],)).fetchone())
            self.assertEqual(conn.execute('SELECT source FROM jobs WHERE id=?',(b['id'],)).fetchone()[0],photo('blue'))
        finally:conn.close()

    def test_completed_cache_has_count_and_byte_budgets(self):
        import time
        now=time.time();conn=jobs.db()
        try:
            with conn:
                for i in range(5):
                    conn.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)',(str(i),str(i),'succeeded','done',now+i,None,now+i,b'original',b'x'*10,None))
        finally:conn.close()
        with patch.object(jobs,'CACHE_JOBS',3),patch.object(jobs,'CACHE_BYTES',20):jobs.cleanup(now=now+5)
        conn=jobs.db()
        try:
            self.assertEqual([r[0] for r in conn.execute('SELECT id FROM jobs ORDER BY id')],['3','4'])
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM jobs WHERE source IS NOT NULL').fetchone()[0],0)
        finally:conn.close()
