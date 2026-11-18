"""Read-only POS lookup and mounted photo library, behind application authentication."""
import hashlib
import json
import io
import os
import re
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from PIL import Image, ImageOps

router = APIRouter()
_lock = threading.Lock()
_cache = None
EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp'}


def roots():
    return [(label, Path(value).resolve()) for label, key in
            [('街貨', 'PRODUCT_PHOTO_STREET_ROOT'), ('倉貨', 'PRODUCT_PHOTO_WAREHOUSE_ROOT')]
            if (value := os.environ.get(key))]


def photo_index():
    global _cache
    configured = roots()
    with _lock:
        if _cache and _cache[0] == configured and time.monotonic() - _cache[1] < 3600:
            return _cache[2]
        entries = {}
        if not configured:
            raise HTTPException(503, '尚未設定商品圖片掛載目錄')
        signature = [[label, str(root)] for label, root in configured]
        cache_file = Path(os.environ.get('POSTER_DATA_DIR', '/data')) / 'product-photo-index.json'
        # Persist names only: container restarts do not rescan the SMB share.
        try:
            stored = json.loads(cache_file.read_text())
            if stored['roots'] == signature and 0 <= time.time() - stored['created'] < 3600:
                by_label = dict(configured)
                for token, label, relative in stored['entries']:
                    part = Path(relative)
                    if part.is_absolute() or '..' in part.parts:
                        raise ValueError('invalid cached path')
                    root = by_label[label]
                    entries[token] = (label, root, root / part, relative)
                _cache = (configured, time.monotonic(), entries)
                return entries
        except (OSError, ValueError, KeyError, TypeError):
            entries = {}
        for label, root in configured:
            if not root.is_dir():
                raise HTTPException(503, f'{label}圖片目錄不可讀，請檢查伺服器掛載')
            pending = [root]
            try:
                while pending:
                    folder = pending.pop()
                    with os.scandir(folder) as files:
                        for entry in files:
                            # DirEntry uses directory-listing metadata. Avoid resolve/stat
                            # on every photo over SMB; revalidate only photos actually read.
                            if entry.is_symlink():
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                pending.append(Path(entry.path))
                                continue
                            path = Path(entry.path)
                            if path.suffix.lower() not in EXTENSIONS:
                                continue
                            relative = path.relative_to(root).as_posix()
                            key = hashlib.sha256(f'{label}/{relative}'.encode()).hexdigest()
                            entries[key] = (label, root, path, relative)
                            if len(entries) > 300000:
                                raise HTTPException(503, '圖片庫超過掃描上限，請縮小掛載範圍')
            except OSError as exc:
                raise HTTPException(503, f'{label}圖片目錄掃描失敗，請檢查掛載權限') from exc
        try:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = cache_file.with_suffix('.tmp')
            temporary.write_text(json.dumps({'roots': signature, 'created': time.time(),
                'entries': [[token, item[0], item[3]] for token, item in entries.items()]}))
            temporary.replace(cache_file)
        except OSError:
            pass  # A read-only data directory must not prevent photo matching.
        _cache = (configured, time.monotonic(), entries)
        return entries


_identifier_cache = None
_identifier_lock = threading.Lock()

def identifier_index(entries):
    """Build once per directory snapshot; exact identifier -> photo tokens."""
    global _identifier_cache
    with _identifier_lock:
        if _identifier_cache and _identifier_cache[0] is entries:
            return _identifier_cache[1]
        inverted = {}
        for token, (_, _, _, relative) in entries.items():
            path = Path(relative)
            stem = path.stem.casefold()
            keys = set(re.findall(r'[\w-]+', stem.replace('_', ' ')))
            keys.update(p.casefold() for p in path.parts[:-1])
            if re.fullmatch(r'\d{8,}-[0-9]{1,2}', stem):
                keys.add(stem.rsplit('-', 1)[0])
            for key in keys:
                inverted.setdefault(key, set()).add(token)
        _identifier_cache = (entries, inverted)
        return inverted


def matching_photos(entries, identifiers):
    inverted = identifier_index(entries)
    tokens = set()
    for key in identifiers:
        if not key:continue
        normalized = key.casefold()
        tokens.update(inverted.get(normalized, ()))
        # Unusual identifiers containing punctuation/spaces retain legacy semantics.
        if not re.fullmatch(r'[\w-]+', normalized) or '_' in normalized:
            tokens.update(token for token, entry in entries.items() if matches(entry[3], [key]))
    return [(token, entries[token]) for token in sorted(tokens)]


def lookup_items(ids, codes=()):
    if not os.environ.get('MSSQL_HOST') or not os.environ.get('MSSQL_USERNAME') or not os.environ.get('MSSQL_PASSWORD'):
        raise HTTPException(503, '尚未設定 POS SQL 連線，無法按 code 查詢商品')
    column = os.environ.get('POS_BARCODE_COLUMN', 'Barcode')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', column):
        raise HTTPException(503, 'POS 條碼欄位設定無效')
    import pymssql
    try:
        with pymssql.connect(server=os.environ['MSSQL_HOST'], port=os.environ.get('MSSQL_PORT', '1433'),
                             user=os.environ['MSSQL_USERNAME'], password=os.environ['MSSQL_PASSWORD'],
                             database=os.environ.get('MSSQL_DATABASE', 'pos6'), charset='UTF-8',
                             login_timeout=5, timeout=15, as_dict=True) as connection:
            with connection.cursor() as cursor:
                predicates, params = [], []
                if ids:
                    predicates.append('i.id IN (' + ','.join(['%s'] * len(ids)) + ')')
                    params.extend(int(v) for v in ids)
                if codes:
                    predicates.append('i.code IN (' + ','.join(['%s'] * len(codes)) + ')')
                    params.extend(codes)
                if not predicates:
                    return {}
                cursor.execute(f'SELECT i.id, i.code, i.name1, b.[{column}] AS barcode '
                               'FROM dbo.item i LEFT JOIN dbo.item_barcode b '
                               "ON b.Item_ID = i.id AND b.type IN ('B', 'b') "
                               'WHERE ' + ' OR '.join(predicates), tuple(params))
                result = {}
                for row in cursor.fetchall():
                    key = str(row['id'])
                    item = result.setdefault(key, {'code': str(row['code'] or '').strip(),
                                                  'name': str(row['name1'] or '').strip(), 'barcodes': []})
                    barcode = str(row['barcode'] or '').strip()
                    if barcode and barcode not in item['barcodes']:
                        item['barcodes'].append(barcode)
                return result
    except Exception as exc:
        raise HTTPException(503, 'POS 查詢失敗，請檢查 SQL 連線、唯讀帳號權限及條碼欄位設定') from exc


def matches(relative, identifiers):
    path = Path(relative)
    # Exact ID folders or delimited filename identifiers; no fuzzy product names.
    folders = {p.casefold() for p in path.parts[:-1]}
    stem = path.stem.casefold()
    return any(key.casefold() in folders or (key.isdigit() and len(key) >= 8 and re.fullmatch(re.escape(key) + r'-[0-9]{1,2}', stem)) or re.search(r'(?<![\w-])' + re.escape(key.casefold()) + r'(?![\w-])', stem.replace('_', ' '))
               for key in identifiers if key)


def enrich_campaign(result):
    work_rows = list(result['rows'])
    combine_names = []
    for row in result['rows']:
        for number in (2, 3, 4):
            key = 'companion' if number == 2 else f'companion{number}'
            if row.get(f'code{number}'):
                row[key] = {'code':row[f'code{number}'], 'name':'', 'spec':row.get('spec',''), 'row':row['row']}
                work_rows.append(row[key])
        if any(row.get(f'code{i}') for i in (2,3,4)) and not row.get('name'):
            combine_names.append(row)
    ids = sorted({row['productid'] for row in work_rows if row.get('productid')})
    codes = sorted({row['code'] for row in work_rows if row.get('code')})
    if not ids and not codes:
        return result
    try:
        items = lookup_items(ids, codes) if codes else lookup_items(ids)
    except HTTPException as exc:
        # POS or the photo share being unreachable must not block the import: images are then
        # matched from the local library by code or name, and names must come from the sheet.
        result.setdefault('warnings', []).append(f'{exc.detail}；已改用本機素材庫按商品編號或名稱匹配圖片。')
        for row in result['rows']:
            if not row.get('name'):
                result['errors'].append(f"第 {row['row']} 行：POS 無法連線，請在 Excel 補填商品名稱")
        return result
    try:
        photos = photo_index()
    except HTTPException as exc:
        # POS names are still valid when only the photo share is unreachable.
        result.setdefault('warnings', []).append(f'{exc.detail}；圖片庫暫時無法讀取，請手動上傳商品圖片。')
        photos = {}
    by_code = {}
    for item_id, item in items.items():
        by_code.setdefault(item['code'].casefold(), []).append((item_id, item))
    for row in work_rows:
        key = row.get('productid')
        code = row.get('code')
        if not key and not code:
            continue
        row['libraryProducts'] = []
        row['libraryLookup'] = 'code' if code else 'productid'
        if code:
            found = by_code.get(code.casefold(), [])
            if len(found) > 1:
                result['errors'].append(f"第 {row['row']} 行：code {code} 對應多個商品，請核對 POS 資料")
                continue
            key, item = found[0] if found else (None, None)
        else:
            item = items.get(key)
        if not item:
            result['errors'].append(f"第 {row['row']} 行：POS 找不到商品 {code or key}")
            continue
        row['productid'] = key
        row['name'] = row['name'] or item['name']
        row['sku'] = item['code']
        if not row['name']:
            result['errors'].append(f"第 {row['row']} 行：商品名稱空白，請在 Excel 補填")
        identifiers = [key, item['code'], *item['barcodes']]
        for token, (category, _, path, relative) in matching_photos(photos, identifiers):
            row['libraryProducts'].append({'id': f'pos-{key}-{token[:20]}', 'externalId': key,
                'source': 'pos-library', 'name': item['name'] or row['name'], 'sku': item['code'],
                'spec': row['spec'], 'aliases': identifiers[:20], 'filename': path.name,
                'angle': f'{category} · {relative}', 'imageUrl': f'/api/product-library/photos/{token}'})
        row['libraryProducts'].sort(key=lambda p: p['angle'])
        if len(row['libraryProducts']) > 30:
            row['libraryProducts'] = []
            result['errors'].append(f"第 {row['row']} 行：匹配圖片超過 30 張，請整理商品圖片目錄")
        elif not row['libraryProducts']:
            result['warnings'].append(f"第 {row['row']} 行：{item['code']} 未找到圖片，請手動上傳並選擇")
    for row in combine_names:
        row['name'] = '／'.join(filter(None, [row['name']]+[row.get(k,{}).get('name','') for k in ('companion','companion3','companion4')]))
        if len(row['name']) > 100:
            result['errors'].append(f"第 {row['row']} 行：組合名稱超過 100 字，請填寫簡稱")
    return result


@router.get('/api/product-library/photos/{token}')
def photo(token: str):
    entry = photo_index().get(token)
    if not entry:
        raise HTTPException(404, '圖片不存在或圖片索引已更新')
    _, root, path, _ = entry
    if not path.resolve().is_relative_to(root):
        raise HTTPException(404, '圖片不存在')
    try:
        if path.stat().st_size > 40 * 1024 * 1024:
            raise ValueError('size')
        with Image.open(path) as source:
            if source.width * source.height > 50000000:
                raise ValueError('pixels')
            picture = ImageOps.exif_transpose(source).convert('RGBA')
            picture.thumbnail((2000, 2000))
            output = io.BytesIO()
            picture.save(output, format='PNG', compress_level=1)
        return Response(output.getvalue(), media_type='image/png', headers={'Cache-Control': 'private, max-age=300'})
    except Exception as exc:
        raise HTTPException(422, '商品圖片無法讀取，請檢查原圖和掛載狀態') from exc
