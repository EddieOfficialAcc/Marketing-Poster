"""CPU background-removal service. Original images are not stored or overwritten."""
import io
import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool
try:
    from .poster_pdf import router as poster_pdf_router
    from .poster_auto import router as poster_auto_router
    from .workflow import router as workflow_router
    from .auth import router as auth_router, protect, sync_admin
    from .campaigns import parse_campaign
    from .product_library import router as product_library_router, enrich_campaign
    from .archives import router as archive_router, cleanup_pending_assets
    from . import cutout_jobs
    from .model_cache import ensure_model, ModelDownloadError
except ImportError:
    from poster_pdf import router as poster_pdf_router
    from poster_auto import router as poster_auto_router
    from workflow import router as workflow_router
    from auth import router as auth_router, protect, sync_admin
    from campaigns import parse_campaign
    from product_library import router as product_library_router, enrich_campaign
    from archives import router as archive_router, cleanup_pending_assets
    import cutout_jobs
    from model_cache import ensure_model, ModelDownloadError

@asynccontextmanager
async def lifespan(app):
    await run_in_threadpool(sync_admin)
    await run_in_threadpool(cutout_jobs.cleanup, compact=True)
    await run_in_threadpool(cleanup_pending_assets)
    yield

app = FastAPI(title="Poster image processing", docs_url=None, redoc_url=None, lifespan=lifespan)
app.middleware("http")(protect)
app.include_router(auth_router)
app.include_router(archive_router)
app.include_router(cutout_jobs.router)
app.include_router(poster_pdf_router)
app.include_router(poster_auto_router)
app.include_router(workflow_router)
app.include_router(product_library_router)
MAX_BYTES = 12 * 1024 * 1024
MAX_PIXELS = 25_000_000
_session = None
_lock = threading.Lock()
logger = logging.getLogger(__name__)


def decode_image(data):
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(413, "圖片必須小於 12 MB 且不可為空")
    try:
        image = Image.open(io.BytesIO(data))
        if image.format not in {"JPEG", "PNG", "WEBP"}:
            raise HTTPException(415, "僅支援 JPG、PNG、WebP")
        if image.width * image.height > MAX_PIXELS:
            raise HTTPException(413, "圖片不可超過 2500 萬像素")
        image.load()
        image = ImageOps.exif_transpose(image).convert("RGBA")
        return image
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise HTTPException(422, "圖片無法解碼") from exc


def encode_result(image):
    image = image.convert("RGBA")
    lo, hi = image.getchannel("A").getextrema()
    if lo == 255 or hi == 0:
        raise HTTPException(422, "未取得有效透明前景，請更換圖片或人工抠圖")
    # Keep the source canvas and alpha coordinates: changing the image bounds
    # makes existing poster placements scale the product up after cutout.
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    if stream.tell() > MAX_BYTES:
        raise HTTPException(413, "抠圖結果超過 12 MB，請縮小原圖後重試")
    return stream.getvalue()


def process_image(data, progress=lambda stage: None):
    global _session
    if not _lock.acquire(timeout=300):
        raise HTTPException(503, "等待圖片處理超時，請檢查服務狀態")
    try:
        image = decode_image(data)
        # Marketing output is 1800px wide; bound CPU and memory for camera originals.
        image.thumbnail((1800, 1800), Image.Resampling.LANCZOS)
        progress('loading')
        from rembg import new_session, remove
        if _session is None:
            ensure_model(progress)
            progress("initializing")
            # A checksum-verified cache prevents rembg from downloading again.
            _session = new_session("u2net", providers=["CPUExecutionProvider"])
        progress("processing")
        result = remove(image, session=_session)
        progress("saving")
        return encode_result(result)
    except HTTPException:
        raise
    except ModelDownloadError as exc:
        logger.exception("Model download failed")
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:
        logger.exception("Background removal failed")
        raise HTTPException(503, "抠圖模型未就緒或處理失敗，請檢查模型下載及服務日誌") from exc
    finally:
        _lock.release()


cutout_jobs._processor = process_image


@app.get("/api/health")
def health():
    return {"service": "cutout", "model_loaded": _session is not None}


@app.post("/api/remove-background")
async def remove_background(request: Request):
    if request.headers.get("content-type", "").split(";")[0] not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(415, "請以圖片內容傳送 JPG、PNG 或 WebP")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_BYTES:
            raise HTTPException(413, "單張圖片不可超過 12 MB")
        data.extend(chunk)
    output = await run_in_threadpool(process_image, bytes(data))
    return Response(output, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.post("/api/import-campaign")
async def import_campaign(request: Request, kind: str = "xlsx", limit: int = 12):
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > 5 * 1024 * 1024:
            raise HTTPException(413, "Excel 不可超過 5 MB")
        data.extend(chunk)
    # Template posters hold up to 12 products; full-automatic replacement of large old posters
    # (e.g. A2 with 18 cells) may ask for up to 30.
    result = await run_in_threadpool(parse_campaign, bytes(data), kind, min(30, max(1, limit)))
    return await run_in_threadpool(enrich_campaign, result)


@app.get('/api/campaign-template')
def campaign_template():
    try:
        from .campaign_template import template_bytes
    except ImportError:
        from campaign_template import template_bytes
    return Response(template_bytes(), media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    headers={'Content-Disposition': 'attachment; filename="campaign-template.xlsx"'})
