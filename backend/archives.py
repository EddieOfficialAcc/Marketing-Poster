"""Campaign snapshots, explicit campaign deletion, and shared image storage."""
import base64
import hashlib
import io
import json
import os
import re
import sqlite3
import uuid
import time
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

router = APIRouter()
MAX_PAYLOAD = 180 * 1024 * 1024
MAX_METADATA = 2 * 1024 * 1024
PENDING_TTL = 7 * 86400
PENDING_BUDGET = 3 * 1024 * 1024 * 1024


def connect():
    root = Path(os.environ.get('POSTER_DATA_DIR', './data'))
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / 'archives.sqlite3', timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS assets(hash TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_info(hash TEXT PRIMARY KEY REFERENCES assets(hash) ON DELETE CASCADE,
        bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_assets(hash TEXT PRIMARY KEY REFERENCES assets(hash) ON DELETE CASCADE, touched REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_campaigns(
        campaign_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL, deleted_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_versions(
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        deleted_at TEXT NOT NULL, deleted_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        revision INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL,
        confirmed_by TEXT, digest TEXT NOT NULL, snapshot TEXT NOT NULL,
        poster_hash TEXT REFERENCES assets(hash),
        UNIQUE(campaign_id, sequence), UNIQUE(campaign_id, digest));
    ''')
    return db


def page_dimensions(project):
    page=project.get('page', {'width':1800,'height':2560,'unit':'px','dpi':150})
    try:
        w,h,dpi=page['width'],page['height'],page['dpi']
        assert all(type(v) in (int,float) for v in (w,h,dpi))
        assert page['unit'] in ('px','mm') and 72<=dpi<=600 and w>0 and h>0
        if page['unit']=='mm': w,h=w*dpi/25.4,h*dpi/25.4
        w,h=int(w+.5),int(h+.5)
        assert 200<=w<=8192 and 200<=h<=8192 and w*h<=40000000 and .4<=w/h<=2.5
        return w,h
    except (KeyError,TypeError,ValueError,OverflowError,AssertionError):
        raise HTTPException(422,'海報尺寸不正確或超出限制')


def validate_image_bytes(data, mime, limit, expected_size=None):
    if len(data)>limit:
        raise HTTPException(413,'存檔圖片超出大小限制')
    try:
        with Image.open(io.BytesIO(data)) as image:
            formats={'image/png':'PNG','image/jpeg':'JPEG','image/webp':'WEBP'}
            if image.format!=formats.get(mime) or image.width*image.height>50_000_000:
                raise ValueError('invalid format or size')
            if expected_size is not None and (image.format!='PNG' or image.size!=expected_size):
                raise ValueError('invalid poster dimensions')
            dimensions=image.size
            image.verify()
            return dimensions
    except (ValueError,OSError,UnidentifiedImageError,Image.DecompressionBombError) as exc:
        raise HTTPException(422,'存檔圖片損壞或海報尺寸不符') from exc


def image_asset(value, *, poster=False, expected_size=(1800,2560)):
    if not isinstance(value,str):raise HTTPException(422,'存檔圖片格式不正確')
    match=re.fullmatch(r'data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)',value or '')
    if not match:raise HTTPException(422,'存檔圖片必須為 PNG、JPG 或 WebP 內嵌資料')
    try:
        data=base64.b64decode(match[2],validate=True)
    except ValueError as exc:
        raise HTTPException(422,'存檔圖片損壞或海報尺寸不符') from exc
    validate_image_bytes(data,match[1],(24 if poster else 12)*1024*1024,expected_size if poster else None)
    return hashlib.sha256(data).hexdigest(),match[1],data


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def cleanup_pending_assets():
    db = connect()
    try:
        with db:
            # Only uploads not yet attached to a version are eligible. Legacy
            # assets never enter this table, so historical snapshots are safe.
            db.execute('DELETE FROM assets WHERE hash IN (SELECT hash FROM pending_assets WHERE touched<?)', (time.time()-PENDING_TTL,))
    finally:
        db.close()


def check_assets(hashes):
    cleanup_pending_assets()
    db = connect()
    try:
        missing = []
        with db:
            for digest in hashes:
                if not db.execute('SELECT 1 FROM assets WHERE hash=?',(digest,)).fetchone():
                    missing.append(digest)
                else:
                    db.execute('UPDATE pending_assets SET touched=? WHERE hash=?',(time.time(),digest))
        return {'missing': missing}
    finally:
        db.close()


def upload_asset(digest, mime, data):
    if hashlib.sha256(data).hexdigest()!=digest:
        raise HTTPException(422,'圖片校驗碼不一致，請重新上傳')
    width,height=validate_image_bytes(data,mime,(24 if mime=='image/png' else 12)*1024*1024)
    db=connect()
    try:
        with db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT 1 FROM assets WHERE hash=?',(digest,)).fetchone():
                used=db.execute('SELECT COALESCE(SUM(i.bytes),0) FROM pending_assets p JOIN asset_info i ON i.hash=p.hash').fetchone()[0]
                if used+len(data)>PENDING_BUDGET:
                    raise HTTPException(413,'未完成存檔的圖片已超過容量上限，請先完成活動存檔')
                db.execute('INSERT INTO assets VALUES(?,?,?)',(digest,mime,data))
                db.execute('INSERT INTO pending_assets VALUES(?,?)',(digest,time.time()))
            db.execute('INSERT OR IGNORE INTO asset_info VALUES(?,?,?,?)',(digest,len(data),width,height))
            db.execute('UPDATE pending_assets SET touched=? WHERE hash=?',(time.time(),digest))
        return {'assetHash':digest}
    finally:
        db.close()


@router.post('/api/archive-assets/check')
async def asset_check(request: Request):
    body=bytearray()
    async for chunk in request.stream():
        if len(body)+len(chunk)>32*1024:raise HTTPException(413,'圖片清單過大')
        body.extend(chunk)
    try:
        hashes=json.loads(body)['hashes']
        if not isinstance(hashes,list) or len(hashes)>200 or any(not valid_hash(h) for h in hashes):raise ValueError()
    except (ValueError,TypeError,KeyError):
        raise HTTPException(422,'圖片清單格式不正確')
    return await run_in_threadpool(check_assets,list(dict.fromkeys(hashes)))


@router.put('/api/archive-assets/{digest}')
async def asset_upload(digest: str, request: Request):
    if not valid_hash(digest):raise HTTPException(422,'圖片校驗碼不正確')
    mime=request.headers.get('content-type','').split(';')[0]
    if mime not in {'image/png','image/jpeg','image/webp'}:raise HTTPException(415,'僅支援 PNG、JPG、WebP')
    body=bytearray()
    async for chunk in request.stream():
        if len(body)+len(chunk)>24*1024*1024:raise HTTPException(413,'單次圖片上傳不可超過 24 MB')
        body.extend(chunk)
    return await run_in_threadpool(upload_asset,digest,mime,bytes(body))


def check_project(project, confirmed):
    if not isinstance(project, dict) or project.get('schema') != 1:
        raise HTTPException(422, '專案格式不正確')
    output_w,output_h=page_dimensions(project)
    canvas_w=output_w/2 if project.get("canvasSpace")==2 else 900
    canvas_h=output_h/2 if project.get("canvasSpace")==2 else 900*output_h/output_w
    campaign = project.get('campaign')
    if not isinstance(campaign, dict) or not isinstance(campaign.get('name'), str):
        raise HTTPException(422, '缺少活動資料')
    if type(project.get('revision')) is not int or project['revision'] < 1:
        raise HTTPException(422, '版本號不正確')
    assets, nodes = project.get('products'), project.get('nodes')
    if not isinstance(assets, list) or not isinstance(nodes, list) or len(assets) > 100 or len(nodes) > 100:
        raise HTTPException(422, '商品或元素資料不正確')
    ids = set()
    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get('id'), str) or asset['id'] in ids:
            raise HTTPException(422, '商品圖片索引不正確')
        ids.add(asset['id'])
    icons = project.get('icons', [])
    if not isinstance(icons, list) or len(icons)>50:
        raise HTTPException(422, '標識索引不正確')
    icon_ids = set()
    for asset in icons:
        if (not isinstance(asset, dict) or not isinstance(asset.get('id'), str) or asset['id'] in icon_ids
            or not isinstance(asset.get('name'), str) or len(asset['name'])>200
            or any(type(asset.get(k)) not in (int,float) or not 0<asset[k]<=50000000 for k in ('width','height'))):
            raise HTTPException(422, '標識素材不正確')
        icon_ids.add(asset['id'])
    for node in nodes:
        if not isinstance(node, dict):
            raise HTTPException(422, '海報元素不正確')
        if node.get('type') == 'imageIcon' and node.get('iconId') not in icon_ids:
            raise HTTPException(422, '缺少海報引用的標識圖片')
        if node.get('type') == 'product':
            if node.get('cardStyle', 'classic') not in ('classic', 'retail') or node.get('averageRounding', 'tenth') not in ('integer', 'tenth', 'cent'):
                raise HTTPException(422, '商品版式或平均價規則無效')
            for key in ('originalPrice', 'originalPriceMax'):
                value = node.get(key)
                if value and (not re.fullmatch(r'\d{1,7}(\.\d{1,2})?', str(value)) or Decimal(str(value)) <= 0):
                    raise HTTPException(422, '原價格式無效')
            if node.get('originalPriceMax') and (not node.get('originalPrice') or Decimal(str(node['originalPriceMax'])) < Decimal(str(node['originalPrice']))):
                raise HTTPException(422, '原價區間無效')
            if node.get('price2'):
                value = str(node['price2'])
                paired_pics = node.get('pictures')
                if (not re.fullmatch(r'\d{1,7}(\.\d{1,2})?', value) or Decimal(value) <= 0
                    or node.get('quantity') != 1 or not isinstance(paired_pics, list) or len(paired_pics) != 2
                    or not any(isinstance(p, dict) and p.get('productId') == node.get('price2ProductId') for p in paired_pics)):
                    raise HTTPException(422, '第二件獨立售價或對應商品無效')
            if node.get('originalPrice2'):
                value = str(node['originalPrice2'])
                if (not node.get('price2') or not node.get('originalPrice')
                    or not re.fullmatch(r'\d{1,7}(\.\d{1,2})?', value) or Decimal(value) <= 0):
                    raise HTTPException(422, '第二件原價無效')
            regions = node.get('regions', {})
            if not isinstance(regions, dict):
                raise HTTPException(422, '商品區域格式無效')
            for key, box in regions.items():
                if (key not in ('image','name','spec','original','price') or not isinstance(box, dict)
                    or any(type(box.get(k)) not in (float,int) or not 0 <= box[k] <= 1 for k in ('x','y','w','h'))
                    or box['w'] <= 0 or box['h'] <= 0 or box['x']+box['w'] > 1.00001 or box['y']+box['h'] > 1.00001):
                    raise HTTPException(422, '商品區域超出組件')
            pics = node.get('pictures', [{'productId': node.get('productId')}])
            if not isinstance(pics, list) or not 1 <= len(pics) <= 6 or any(not isinstance(p, dict) or p.get('productId') not in ids for p in pics):
                raise HTTPException(422, '缺少海報引用的商品圖片')
    if not confirmed:
        return
    try:
        assert campaign['name'].strip() and campaign['stores'].strip()
        assert date.fromisoformat(campaign['start']) <= date.fromisoformat(campaign['end'])
        assert project.get('reviewedRevision') == project['revision']
        if any(not n.get('imageOnly') and n.get('pdfOcr') and n.get('pdfReview') is not True for n in nodes):
            raise HTTPException(422, '請先核對 PDF 自動識別的商品資料')
        goods = [n for n in nodes if n.get('type') == 'product']
        assert goods or (project.get('template')=='custom' and project.get('background') and project.get('posterReuse') and nodes)
        for node in goods:
            if node.get('imageOnly') is True:
                continue
            assert node['name'].strip()
            assert re.fullmatch(r'\d{1,7}(\.\d{1,2})?', str(node['price']))
            assert Decimal(str(node['price'])) > 0
            assert type(node['quantity']) is int and 1 <= node['quantity'] <= 99
        for node in nodes:
            assert all(type(node[k]) in (int, float) for k in ('x', 'y', 'w', 'h'))
            assert 0 <= node['x'] < canvas_w and 0 <= node['y'] < canvas_h
            assert node['w'] > 0 and node['h'] > 0
            assert node['x'] + node['w'] <= canvas_w+0.00001 and node['y'] + node['h'] <= canvas_h+0.00001
        if project.get('template') not in ('clean', 'retail'):
            assert project.get('background') or project.get('templateImage')
    except (AssertionError, KeyError, ValueError, TypeError, AttributeError, InvalidOperation) as exc:
        raise HTTPException(422, '確認前須完成活動、商品、價格、日期、底圖及版本校對') from exc


def same_content(a, b):
    """Snapshots equal apart from bookkeeping that changes on every open or save."""
    ignore = ('revision', 'reviewedRevision', 'savedBy', 'confirmedBy')
    return {k: v for k, v in a.items() if k not in ignore} == {k: v for k, v in b.items() if k not in ignore}


def summary(row):
    return {k: row[k] for k in ('id', 'campaign_id', 'sequence', 'revision', 'name', 'created_at', 'confirmed_by', 'digest', 'poster_hash')}


def save_version(payload, references_only=False):
    if not isinstance(payload, dict):
        raise HTTPException(422, '存檔資料格式不正確')
    try:
        campaign_id = str(uuid.UUID(payload.get('campaignId', '')))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, '活動識別碼不正確')
    project = payload.get('project')
    confirmed = payload.get('confirmed', False) is True
    actor = payload.get('confirmedBy', '')
    if confirmed and (not isinstance(actor, str) or not 1 <= len(actor.strip()) <= 80 or not payload.get('poster')):
        raise HTTPException(422, '請填確認人並先生成海報')
    check_project(project, confirmed)
    assets = {}
    db = connect()
    try:
        with db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT 1 FROM deleted_campaigns WHERE campaign_id=?', (campaign_id,)).fetchone():
                raise HTTPException(410, '此活動已刪除，請新建項目；舊分頁不能重新儲存此活動')
            referenced = set()
            def capture(value, poster=False):
                if isinstance(value,dict) and set(value)=={'assetHash'} and valid_hash(value['assetHash']):
                    digest=value['assetHash']
                    row=db.execute('SELECT a.mime,i.bytes,i.width,i.height FROM assets a LEFT JOIN asset_info i ON i.hash=a.hash WHERE a.hash=?',(digest,)).fetchone()
                    if not row:
                        raise HTTPException(409,{'code':'missing_assets','message':'部分圖片尚未上傳，請重新同步','hashes':[digest]})
                    if row['bytes'] is None:
                        raw=db.execute('SELECT data FROM assets WHERE hash=?',(digest,)).fetchone()[0]
                        with Image.open(io.BytesIO(raw)) as image:
                            width,height=image.size
                        db.execute('INSERT INTO asset_info VALUES(?,?,?,?)',(digest,len(raw),width,height))
                        row={'mime':row['mime'],'bytes':len(raw),'width':width,'height':height}
                    if row['bytes']>(24 if poster else 12)*1024*1024:
                        raise HTTPException(413,'存檔圖片超出大小限制')
                    if poster and (row['mime']!='image/png' or (row['width'],row['height'])!=page_dimensions(project)):
                        raise HTTPException(422,'海報尺寸不符')
                else:
                    if references_only:raise HTTPException(422,'增量存檔只接受已上傳的圖片引用')
                    digest,mime,data=image_asset(value,poster=poster,expected_size=page_dimensions(project))
                    assets[digest]=(digest,mime,data)
                referenced.add(digest)
                return {'assetHash':digest}

            try:
                snapshot=json.loads(json.dumps(project,allow_nan=False))
            except ValueError as exc:
                raise HTTPException(422,'存檔資料含無效數值') from exc
            for asset in snapshot['products']:
                asset['imageUrl']=capture(asset.get('imageUrl'))
            for asset in snapshot.get('icons',[]):
                asset['imageUrl']=capture(asset.get('imageUrl'))
            backgrounds=snapshot.get('backgrounds',[])
            if not isinstance(backgrounds,list) or len(backgrounds)>20:
                raise HTTPException(422,'底圖索引不正確')
            for background in backgrounds:
                if not isinstance(background,dict):raise HTTPException(422,'底圖格式不正確')
                background['imageUrl']=capture(background.get('imageUrl'))
            for key in ('background','templateImage','retailHeader','retailLogo'):
                if snapshot.get(key):snapshot[key]=capture(snapshot[key])
            poster_hash=capture(payload['poster'],True)['assetHash'] if payload.get('poster') else None
            document=json.dumps(snapshot,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
            actor=actor.strip() if confirmed else None
            digest=hashlib.sha256(json.dumps([document,poster_hash,actor],ensure_ascii=False).encode()).hexdigest()
            existing=db.execute('SELECT * FROM versions WHERE campaign_id=? AND digest=?',(campaign_id,digest)).fetchone()
            for asset in assets.values():db.execute('INSERT OR IGNORE INTO assets VALUES(?,?,?)',asset)
            db.executemany('DELETE FROM pending_assets WHERE hash=?',[(h,) for h in referenced])
            if payload.get('latestOnly') is True:
                latest=db.execute('SELECT * FROM versions WHERE campaign_id=? ORDER BY sequence DESC LIMIT 1',(campaign_id,)).fetchone()
                if latest:
                    # Late autosaves must not roll back newer edits or a confirmation, and a save without
                    # a poster whose content is unchanged (e.g. merely reopening) must not drop the poster.
                    preserve = project['revision'] < latest['revision'] or (
                        project['revision'] == latest['revision'] and latest['confirmed_by'] and not confirmed) or (
                        not poster_hash and latest['poster_hash'] and same_content(snapshot, json.loads(latest['snapshot'])))
                    # Uploads referenced only by a save that is not stored must still be cleaned up later.
                    retired=set(referenced) if preserve else set()
                    for old in db.execute('SELECT snapshot,poster_hash FROM versions WHERE campaign_id=?',(campaign_id,)):
                        retired.update(snapshot_hashes(json.loads(old['snapshot'])))
                        if old['poster_hash']:retired.add(old['poster_hash'])
                    db.execute('DELETE FROM versions WHERE campaign_id=? AND id<>?',(campaign_id,latest['id']))
                    if not preserve and latest['digest'] != digest:
                        db.execute('UPDATE versions SET revision=?,name=?,created_at=?,confirmed_by=?,digest=?,snapshot=?,poster_hash=? WHERE id=?',
                            (project['revision'],project['campaign']['name'][:120],datetime.now(timezone.utc).isoformat(),actor,digest,document,poster_hash,latest['id']))
                    for remaining in db.execute('SELECT snapshot,poster_hash FROM versions'):
                        retired.difference_update(snapshot_hashes(json.loads(remaining['snapshot'])))
                        retired.discard(remaining['poster_hash'])
                    db.executemany('INSERT OR REPLACE INTO pending_assets VALUES(?,?)',[(h,time.time()) for h in retired])
                    return {**summary(db.execute('SELECT * FROM versions WHERE id=?',(latest['id'],)).fetchone()),'stored':not preserve}
            if existing:return summary(existing)
            seq = db.execute('SELECT COALESCE(MAX(sequence),0)+1 FROM (SELECT sequence FROM versions WHERE campaign_id=? UNION ALL SELECT sequence FROM deleted_versions WHERE campaign_id=?)', (campaign_id,campaign_id)).fetchone()[0]
            version_id = str(uuid.uuid4())
            db.execute('INSERT INTO versions VALUES(?,?,?,?,?,?,?,?,?,?)', (
                version_id, campaign_id, seq, project['revision'], project['campaign']['name'][:120],
                datetime.now(timezone.utc).isoformat(), actor, digest, document, poster_hash))
            return summary(db.execute('SELECT * FROM versions WHERE id=?', (version_id,)).fetchone())
    finally:
        db.close()


async def archive_request(request: Request, incremental=False):
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > (MAX_METADATA if incremental else MAX_PAYLOAD):
            raise HTTPException(413, '增量存檔資料不可超過 2 MB' if incremental else '專案存檔不可超過 180 MB')
        body.extend(chunk)
    try:
        payload = json.loads(body, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (ValueError, UnicodeError):
        raise HTTPException(422, '存檔 JSON 不正確')
    if isinstance(payload, dict):
        payload['confirmedBy'] = request.state.user['username']
        if isinstance(payload.get('project'), dict):
            payload['project']['savedBy'] = request.state.user['username']
            if payload.get('confirmed'):
                payload['project']['confirmedBy'] = request.state.user['username']
    saved = await run_in_threadpool(save_version, payload, references_only=incremental)
    try:
        from .workflow import after_version_saved
    except ImportError:
        from workflow import after_version_saved
    # Keep the production workflow in step (start of editing, confirmation, edits after confirming).
    # A save that was not stored (stale or unchanged) must not confirm or reopen the workflow item.
    await run_in_threadpool(after_version_saved, saved['campaign_id'], saved, request.state.user,
                            payload.get('confirmed') is True and saved.get('stored', True), saved.get('stored', True))
    return saved


@router.post('/api/archives')
async def archive(request: Request):
    return await archive_request(request)


@router.post('/api/archives/incremental')
async def incremental_archive(request: Request):
    return await archive_request(request, incremental=True)


@router.get('/api/archives')
def versions(campaign_id: str = '', offset: int = 0, latest_only: bool = False):
    if offset < 0:
        raise HTTPException(422, '頁碼不正確')
    db = connect()
    try:
        query = 'SELECT * FROM versions'
        args = []
        if campaign_id:
            query += ' WHERE campaign_id=?'
            args.append(campaign_id)
        if latest_only:
            query += (' AND ' if campaign_id else ' WHERE ') + 'sequence=(SELECT MAX(v.sequence) FROM versions v WHERE v.campaign_id=versions.campaign_id)'
        return [summary(row) for row in db.execute(query + ' ORDER BY created_at DESC LIMIT 50 OFFSET ?', [*args, offset])]
    finally:
        db.close()


@router.get('/api/archives/{version_id}/project')
def project_version(version_id: str):
    db = connect()
    try:
        row = db.execute('SELECT * FROM versions WHERE id=?', (version_id,)).fetchone()
        if not row:
            raise HTTPException(404, '找不到活動版本')
        project = json.loads(row['snapshot'])

        def expand(value):
            asset = db.execute('SELECT mime,data FROM assets WHERE hash=?', (value['assetHash'],)).fetchone()
            return 'data:' + asset['mime'] + ';base64,' + base64.b64encode(asset['data']).decode()
        for asset in project['products']:
            asset['imageUrl'] = expand(asset['imageUrl'])
        for asset in project.get('icons', []):
            asset['imageUrl'] = expand(asset['imageUrl'])
        for background in project.get('backgrounds', []):
            background['imageUrl'] = expand(background['imageUrl'])
        for key in ('background', 'templateImage','retailHeader','retailLogo'):
            if project.get(key):
                project[key] = expand(project[key])
        return {'version': summary(row), 'project': project}
    finally:
        db.close()


@router.get('/api/archives/{version_id}/poster')
def poster_version(version_id: str):
    db = connect()
    try:
        row = db.execute('SELECT a.data FROM versions v JOIN assets a ON v.poster_hash=a.hash WHERE v.id=?', (version_id,)).fetchone()
        if not row:
            raise HTTPException(404, '此版本未存海報圖片')
        return Response(row['data'], media_type='image/png', headers={'Cache-Control': 'no-store'})
    finally:
        db.close()


def snapshot_hashes(value):
    if isinstance(value, dict):
        result = {value['assetHash']} if valid_hash(value.get('assetHash')) else set()
        for item in value.values(): result.update(snapshot_hashes(item))
        return result
    if isinstance(value, list):
        result = set()
        for item in value: result.update(snapshot_hashes(item))
        return result
    return set()


@router.delete('/api/campaigns/{campaign_id}')
def delete_campaign(campaign_id: str, request: Request):
    try:
        campaign_id = str(uuid.UUID(campaign_id))
    except ValueError:
        raise HTTPException(422, '活動識別碼不正確')
    db = connect()
    try:
        with db:
            db.execute('BEGIN IMMEDIATE')
            rows = db.execute('SELECT snapshot,poster_hash FROM versions WHERE campaign_id=?', (campaign_id,)).fetchall()
            if not rows:
                if db.execute('SELECT 1 FROM deleted_campaigns WHERE campaign_id=?', (campaign_id,)).fetchone():
                    return {'campaign_id': campaign_id, 'deleted_versions': 0}
                raise HTTPException(404, '找不到活動')
            candidates = set()
            for row in rows:
                candidates.update(snapshot_hashes(json.loads(row['snapshot'])))
                if row['poster_hash']: candidates.add(row['poster_hash'])
            db.execute('INSERT INTO deleted_campaigns VALUES(?,?,?)', (campaign_id, datetime.now(timezone.utc).isoformat(), request.state.user['username']))
            db.execute('DELETE FROM versions WHERE campaign_id=?', (campaign_id,))
            # Retain all images referenced by other campaigns. Released images
            # enter the existing grace-period cleanup, protecting active uploads.
            for row in db.execute('SELECT snapshot,poster_hash FROM versions'):
                candidates.difference_update(snapshot_hashes(json.loads(row['snapshot'])))
                candidates.discard(row['poster_hash'])
            for digest in candidates:
                db.execute('INSERT OR REPLACE INTO pending_assets VALUES(?,?)', (digest, time.time()))
            result = {'campaign_id': campaign_id, 'deleted_versions': len(rows)}
    finally:
        db.close()
    try:
        from .workflow import campaign_deleted
    except ImportError:
        from workflow import campaign_deleted
    campaign_deleted(campaign_id, request.state.user)
    return result


@router.get('/api/archives/{version_id}')
def version_details(version_id: str):
    db = connect()
    try:
        row = db.execute('SELECT * FROM versions WHERE id=?', (version_id,)).fetchone()
        if not row:
            raise HTTPException(404, '找不到活動版本')
        snapshot = json.loads(row['snapshot'])
        return {'version':summary(row), 'project':{'campaign':snapshot['campaign'], 'savedBy':snapshot.get('savedBy')}}
    finally:
        db.close()


@router.delete('/api/archives/{version_id}')
def delete_version(version_id: str, request: Request):
    try:
        version_id = str(uuid.UUID(version_id))
    except ValueError:
        raise HTTPException(422, '版本識別碼不正確')
    db = connect()
    try:
        with db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM versions WHERE id=?', (version_id,)).fetchone()
            if not row:
                if db.execute('SELECT 1 FROM deleted_versions WHERE id=?', (version_id,)).fetchone():
                    return {'id':version_id, 'deleted_versions':0}
                raise HTTPException(404, '找不到活動版本')
            candidates = snapshot_hashes(json.loads(row['snapshot']))
            if row['poster_hash']:
                candidates.add(row['poster_hash'])
            db.execute('INSERT INTO deleted_versions VALUES(?,?,?,?,?)', (version_id,row['campaign_id'],row['sequence'],datetime.now(timezone.utc).isoformat(),request.state.user['username']))
            db.execute('DELETE FROM versions WHERE id=?', (version_id,))
            for remaining in db.execute('SELECT snapshot,poster_hash FROM versions'):
                candidates.difference_update(snapshot_hashes(json.loads(remaining['snapshot'])))
                candidates.discard(remaining['poster_hash'])
            for digest in candidates:
                db.execute('INSERT OR REPLACE INTO pending_assets VALUES(?,?)', (digest,time.time()))
            return {'id':version_id, 'campaign_id':row['campaign_id'], 'deleted_versions':1}
    finally:
        db.close()
