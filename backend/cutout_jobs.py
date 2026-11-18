"""Persistent FIFO jobs for the single-worker CPU image service."""
import hashlib
import logging
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

router = APIRouter()
_guard = threading.Lock()
_worker = None
_processor = None
CACHE_DAYS = 7
CACHE_JOBS = 200
CACHE_BYTES = 512 * 1024 * 1024
_last_cleanup = 0


def db():
    root = Path(os.environ.get('POSTER_DATA_DIR', './data'))
    root.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(root / 'cutout-jobs.sqlite3', timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('''CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY, hash TEXT, state TEXT, stage TEXT, created REAL, started REAL,
      finished REAL, source BLOB, result BLOB, error TEXT)''')
    return conn


def cleanup(now=None, compact=False):
    """Only terminal job cache is disposable; archived assets live in another DB."""
    now = time.time() if now is None else now
    conn = db()
    try:
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute("UPDATE jobs SET source=NULL WHERE state IN ('succeeded','failed') AND source IS NOT NULL")
            conn.execute("DELETE FROM jobs WHERE state IN ('succeeded','failed') AND COALESCE(finished,created)<?", (now-CACHE_DAYS*86400,))
            rows = conn.execute("SELECT id,COALESCE(length(result),0) AS bytes FROM jobs WHERE state IN ('succeeded','failed') ORDER BY COALESCE(finished,created) DESC,id DESC").fetchall()
            total = 0
            expired = []
            for index, row in enumerate(rows):
                total += row['bytes']
                if index >= CACHE_JOBS or total > CACHE_BYTES:
                    expired.append((row['id'],))
            conn.executemany('DELETE FROM jobs WHERE id=?', expired)
        if compact:
            free = conn.execute('PRAGMA freelist_count').fetchone()[0]*conn.execute('PRAGMA page_size').fetchone()[0]
            if free >= 16*1024*1024:
                conn.execute('VACUUM')
            conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    finally:
        conn.close()


def metadata(row, conn):
    position = conn.execute("SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running') AND created<?", (row['created'],)).fetchone()[0] if row['state'] == 'queued' else 0
    return {k: row[k] for k in ('id', 'state', 'stage', 'created', 'started', 'finished', 'error')} | {'ahead': position}


def set_stage(job_id, stage):
    conn = db()
    try:
        with conn:
            conn.execute('UPDATE jobs SET stage=? WHERE id=?', (stage, job_id))
    finally:
        conn.close()


def process_next():
    conn = db()
    try:
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            job = conn.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1").fetchone()
            if job:
                conn.execute("UPDATE jobs SET state='running',stage='loading',started=? WHERE id=?", (time.time(), job['id']))
        if not job:
            return False
        try:
            result = _processor(job['source'], lambda stage: set_stage(job['id'], stage))
            with conn:
                conn.execute("UPDATE jobs SET state='succeeded',stage='done',finished=?,result=?,source=NULL,error=NULL WHERE id=?", (time.time(), result, job['id']))
        except Exception as error:
            message = error.detail if isinstance(error, HTTPException) else '圖片處理失敗，請檢查服務日誌'
            with conn:
                conn.execute("UPDATE jobs SET state='failed',stage='failed',finished=?,source=NULL,error=? WHERE id=?", (time.time(), str(message), job['id']))
        try:
            cleanup()
        except sqlite3.Error:
            logging.exception('Cutout cache cleanup failed; completed job is preserved')
        return True
    finally:
        conn.close()


def work():
    global _last_cleanup
    while True:
        if time.time()-_last_cleanup>3600:
            try:
                cleanup(compact=True)
            except sqlite3.Error:
                logging.exception('Cutout cache cleanup failed; will retry')
            _last_cleanup = time.time()
        if not process_next():
            time.sleep(.3)


def ensure_worker():
    global _worker
    with _guard:
        if _worker is not None and _worker.is_alive():
            return
        conn = db()
        try:
            with conn:
                conn.execute("UPDATE jobs SET state='queued',stage='queued',started=NULL WHERE state='running'")
        finally:
            conn.close()
        _worker = threading.Thread(target=work, daemon=True, name='cutout-queue')
        _worker.start()


def submit(data):
    # Validate before occupying queue capacity; no expensive model inference here.
    from PIL import Image
    import io
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in ('PNG','JPEG','WEBP') or image.width*image.height>25_000_000:
                raise ValueError()
            image.verify()
    except Exception as error:
        raise HTTPException(422, '圖片無法解碼或超過 2500 萬像素') from error
    cleanup()
    digest = hashlib.sha256(data).hexdigest()
    conn = db()
    try:
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            old = conn.execute("SELECT id,state,stage,created,started,finished,error FROM jobs WHERE hash=? AND state!='failed' ORDER BY created DESC LIMIT 1", (digest,)).fetchone()
            if old:
                return metadata(old, conn)
            if conn.execute("SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running')").fetchone()[0] >= 12:
                raise HTTPException(429, '抠圖佇列已滿（12 張），請等待部分任務完成')
            job_id = str(uuid.uuid4())
            conn.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)', (job_id,digest,'queued','queued',time.time(),None,None,data,None,None))
            return metadata(conn.execute('SELECT id,state,stage,created,started,finished,error FROM jobs WHERE id=?', (job_id,)).fetchone(), conn)
    finally:
        conn.close()


@router.post('/api/cutout-jobs', status_code=202)
async def create_job(request: Request):
    if request.headers.get('content-type','').split(';')[0] not in ('image/jpeg','image/png','image/webp'):
        raise HTTPException(415, '僅支援 JPG、PNG、WebP')
    body = bytearray()
    async for chunk in request.stream():
        if len(body)+len(chunk)>12*1024*1024:
            raise HTTPException(413, '圖片不可超過 12 MB')
        body.extend(chunk)
    result = await run_in_threadpool(submit, bytes(body))
    ensure_worker()
    return result


@router.get('/api/cutout-jobs/{job_id}')
def get_job(job_id: str):
    ensure_worker()
    conn = db()
    try:
        row = conn.execute('SELECT id,state,stage,created,started,finished,error FROM jobs WHERE id=?', (job_id,)).fetchone()
        if not row:
            raise HTTPException(404, '找不到抠圖任務，可能已超過快取保留期限；已存入活動的素材不受影響')
        return metadata(row, conn)
    finally:
        conn.close()


@router.get('/api/cutout-jobs/{job_id}/result')
def result(job_id: str):
    conn = db()
    try:
        row = conn.execute('SELECT state,result FROM jobs WHERE id=?', (job_id,)).fetchone()
        if not row:
            raise HTTPException(404, '找不到抠圖任務，可能已超過快取保留期限；已存入活動的素材不受影響')
        if row['state'] != 'succeeded':
            raise HTTPException(409, '抠圖尚未完成')
        return Response(row['result'], media_type='image/png')
    finally:
        conn.close()
