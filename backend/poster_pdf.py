"""Render a selected PDF page with Poppler in a temporary directory."""
import io
import os
import re
import subprocess
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from PIL import Image
from starlette.concurrency import run_in_threadpool

router = APIRouter()
MAX_BYTES = 30 * 1024 * 1024
_render_lock = threading.Lock()


def command(args, timeout=30):
    try:
        result = subprocess.run(args, capture_output=True, timeout=timeout,
                                env={**os.environ, 'LC_ALL': 'C'})
    except FileNotFoundError as exc:
        raise HTTPException(503, 'PDF 轉換元件未安裝，請重新構建後端 Docker') from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(422, 'PDF 處理超時，請將所需頁面另存為較小的 PDF') from exc
    if result.returncode:
        raise HTTPException(422, 'PDF 無法讀取；請確認檔案未損壞且沒有密碼保護')
    return result.stdout


def process_pdf(data, page=None):
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(413, 'PDF 不可為空，且不得超過 30 MB')
    if b'%PDF-' not in data[:1024]:
        raise HTTPException(415, '請上傳有效 PDF')
    if not _render_lock.acquire(blocking=False):
        raise HTTPException(429, '正在處理另一份 PDF，請稍後重試')
    try:
        with tempfile.TemporaryDirectory(prefix='poster-pdf-') as folder:
            source = Path(folder) / 'source.pdf'
            source.write_bytes(data)
            info = command(['pdfinfo', str(source)]).decode('utf-8', 'replace')
            count = re.search(r'^Pages:\s*(\d+)', info, re.M)
            if not count or re.search(r'^Encrypted:\s*yes', info, re.M):
                raise HTTPException(422, '請先解除 PDF 密碼保護後再上傳')
            pages = int(count.group(1))
            if not 1 <= pages <= 200:
                raise HTTPException(422, 'PDF 須為 1–200 頁，請將所需頁面另存後上傳')
            if page is None:
                return {'pages': pages}
            if not 1 <= page <= pages:
                raise HTTPException(422, '所選頁碼超出 PDF 頁數')
            output = Path(folder) / 'page'
            command(['pdftoppm', '-f', str(page), '-l', str(page), '-singlefile',
                     '-scale-to', '4000', '-png', str(source), str(output)], timeout=90)
            with Image.open(output.with_suffix('.png')) as image:
                w, h = image.size
                if min(w, h) < 200 or not .4 <= w/h <= 2.5:
                    raise HTTPException(422, '此頁比例不適合海報畫布（寬高比限 0.4–2.5），請先裁切')
                image.load()
                data = output.with_suffix('.png').read_bytes()
                mime = 'image/png'
                if len(data) > 12 * 1024 * 1024:
                    buffer = io.BytesIO()
                    image.convert('RGB').save(buffer, 'JPEG', quality=95)
                    data, mime = buffer.getvalue(), 'image/jpeg'
                if len(data) > 12 * 1024 * 1024:
                    raise HTTPException(413, '此頁圖片過大，請先壓縮 PDF 後重試')
                return data, mime
    finally:
        _render_lock.release()


async def read_pdf(request):
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_BYTES:
            raise HTTPException(413, 'PDF 不得超過 30 MB')
        data.extend(chunk)
    return bytes(data)


@router.post('/api/poster-pdf/info')
async def pdf_info(request: Request):
    return await run_in_threadpool(process_pdf, await read_pdf(request))


@router.post('/api/poster-pdf/render')
async def pdf_render(request: Request, page: int = 1):
    data, mime = await run_in_threadpool(process_pdf, await read_pdf(request), page)
    return Response(data, media_type=mime, headers={'Cache-Control': 'no-store'})


def process_rebuild(data, page):
    if not data or len(data) > MAX_BYTES or b'%PDF-' not in data[:1024]:
        raise HTTPException(422, '請上傳不超過 30 MB 的有效 PDF')
    if not _render_lock.acquire(blocking=False):
        raise HTTPException(429, '正在處理另一份 PDF，請稍後重試')
    try:
        try:
            from .pdf_rebuild import reconstruct_pdf
        except ImportError:
            from pdf_rebuild import reconstruct_pdf
        return reconstruct_pdf(data, page)
    finally:
        _render_lock.release()


@router.post('/api/poster-pdf/rebuild')
async def pdf_rebuild(request: Request, page: int = 1):
    return await run_in_threadpool(process_rebuild, await read_pdf(request), page)



async def read_image_request(request):
    data=bytearray()
    async for chunk in request.stream():
        if len(data)+len(chunk)>12*1024*1024:
            raise HTTPException(413,'文字圖片不得超過 12 MB')
        data.extend(chunk)
    return bytes(data)


def process_text_analysis(data, price=False):
    # Recognition takes a few seconds and the editor may ask again while one runs; queue briefly
    # behind the current image task instead of failing at once.
    if not data or not _render_lock.acquire(timeout=30):
        raise HTTPException(429,'正在處理另一項圖片任務，請稍後重試')
    try:
        try:
            from .pdf_rebuild import analyze_text_image
        except ImportError:
            from pdf_rebuild import analyze_text_image
        try:
            image=Image.open(io.BytesIO(data))
            if image.format not in ('PNG','JPEG','WEBP'):
                raise HTTPException(415,'請使用 PNG、JPG 或 WebP 圖片')
            if image.width*image.height>25_000_000:
                raise HTTPException(422,'選取的文字圖片尺寸過大')
            image.load()
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(422,'選取的文字圖片無法讀取') from exc
        return analyze_text_image(image, price=price)
    finally:
        _render_lock.release()


@router.post('/api/poster-pdf/analyze-text')
async def analyze_poster_text(request: Request, mode: str = 'text'):
    return await run_in_threadpool(process_text_analysis,await read_image_request(request),mode=='price')
