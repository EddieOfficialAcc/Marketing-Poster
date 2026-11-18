"""Poster production workflow: 採購 submit the activity sheet, 市場部 design, check and confirm.

States
  submitted        待處理   採購 submitted the sheet; waiting for 市場部
  in_design        製作中   a 市場部 designer is editing the poster
  pending_confirm  待確認   design done, poster preview attached; waiting for content check
  confirmed        已確認   content checked and confirmed; the poster may be printed
  returned         已退回   sent back to 採購 to correct the sheet
  cancelled        已取消

Every change is an event (who, when, from → to, comment). Campaigns archived before the workflow
existed are listed too, derived from their latest archived version, and adopted on first action.
"""
import csv
import io
import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from PIL import Image
from starlette.concurrency import run_in_threadpool

try:
    from .auth import require, database as auth_database
    from .archives import connect as archive_db
    from .campaigns import parse_campaign
except ImportError:
    from auth import require, database as auth_database
    from archives import connect as archive_db
    from campaigns import parse_campaign

router = APIRouter(prefix='/api/workflow')
MAX_SHEET = 5 * 1024 * 1024
STATUS_NAMES = {'submitted': '待處理', 'in_design': '製作中', 'pending_confirm': '待確認',
                'confirmed': '已確認', 'returned': '已退回', 'cancelled': '已取消'}
TABS = {'processing': ('submitted', 'in_design', 'returned'), 'pending': ('pending_confirm',), 'done': ('confirmed', 'cancelled')}
STEPS = ['採購提交', '市場部製作', '內容核對', '已確認']
STEP_OF = {'submitted': 1, 'returned': 0, 'in_design': 1, 'pending_confirm': 2, 'confirmed': 4, 'cancelled': -1}
PRIORITIES = {'high': '高（1天內）', 'normal': '中（3天內）', 'low': '低（7天內）'}
ACTION_NAMES = {'submit': '提交活動表', 'resubmit': '重新提交活動表', 'claim': '接手製作', 'assign': '指派負責人',
                'save': '保存海報', 'submit_review': '提交確認', 'confirm': '確認海報', 'send_back': '退回修改',
                'return': '退回採購', 'cancel': '取消申請', 'reopen': '重新開啟', 'edited_after_confirm': '確認後再修改'}


def now():
    return datetime.now(timezone.utc).isoformat()


def connect():
    root = Path(os.environ.get('POSTER_DATA_DIR', './data'))
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / 'workflow.sqlite3', timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS workflow(
        campaign_id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, start TEXT, end TEXT, stores TEXT,
        product_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
        due_date TEXT, note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, created_at TEXT NOT NULL,
        assignee TEXT, assignee_name TEXT, submitted_by TEXT, submitted_by_name TEXT,
        confirmed_by TEXT, confirmed_by_name TEXT, confirmed_at TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_sheets(
        campaign_id TEXT PRIMARY KEY REFERENCES workflow(campaign_id), filename TEXT NOT NULL, kind TEXT NOT NULL,
        data BLOB NOT NULL, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL, at TEXT NOT NULL,
        actor TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL,
        from_status TEXT, to_status TEXT, comment TEXT NOT NULL DEFAULT '', version INTEGER);
      CREATE INDEX IF NOT EXISTS workflow_events_campaign ON workflow_events(campaign_id, id);
    ''')
    return db


def latest_versions(campaign_ids=None):
    """Latest archived version per campaign: summary plus campaign fields from the snapshot."""
    db = archive_db()
    try:
        query = ('SELECT id,campaign_id,sequence,revision,name,created_at,confirmed_by,poster_hash,snapshot FROM versions v '
                 'WHERE sequence=(SELECT MAX(sequence) FROM versions w WHERE w.campaign_id=v.campaign_id)')
        args = []
        if campaign_ids is not None:
            if not campaign_ids:
                return {}
            query += ' AND campaign_id IN (' + ','.join('?'*len(campaign_ids)) + ')'
            args = list(campaign_ids)
        result = {}
        for row in db.execute(query, args):
            try:
                project = json.loads(row['snapshot'])
            except ValueError:
                project = {}
            campaign = project.get('campaign') or {}
            result[row['campaign_id']] = {
                'versionId': row['id'], 'sequence': row['sequence'], 'revision': row['revision'], 'savedAt': row['created_at'],
                'confirmedBy': row['confirmed_by'], 'hasPoster': bool(row['poster_hash']), 'name': row['name'],
                'start': campaign.get('start', ''), 'end': campaign.get('end', ''), 'stores': campaign.get('stores', ''),
                'savedBy': project.get('savedBy', ''), 'products': sum(1 for n in project.get('nodes', []) if isinstance(n, dict) and n.get('type') == 'product')}
        return result
    finally:
        db.close()


def next_code(db):
    prefix = 'P' + datetime.now().strftime('%y%m') + '-'
    last = db.execute('SELECT code FROM workflow WHERE code LIKE ? ORDER BY length(code) DESC, code DESC LIMIT 1', (prefix+'%',)).fetchone()
    return f"{prefix}{int(last['code'].rsplit('-', 1)[1])+1 if last else 1:03d}"


def event(db, campaign_id, user, action, before, after, comment='', version=None):
    db.execute('INSERT INTO workflow_events(campaign_id,at,actor,actor_name,action,from_status,to_status,comment,version) VALUES(?,?,?,?,?,?,?,?,?)',
               (campaign_id, now(), user['username'], user.get('name') or user['username'], action, before, after, comment, version))


def row_dict(row, version=None, user=None):
    item = dict(row)
    item['statusName'] = STATUS_NAMES[item['status']]
    item['priorityName'] = PRIORITIES.get(item['priority'], '')
    item['step'] = STEP_OF[item['status']]
    item['steps'] = STEPS
    item['version'] = version
    item['legacy'] = False
    if user:
        item['actions'] = allowed_actions(item, user, version)
    return item


def legacy_item(campaign_id, version, user=None):
    """A campaign archived before the workflow: status follows its latest version."""
    status = 'confirmed' if version['confirmedBy'] else 'in_design'
    item = {'campaign_id': campaign_id, 'code': '—', 'name': version['name'], 'start': version['start'], 'end': version['end'],
            'stores': version['stores'], 'product_count': version['products'], 'status': status, 'priority': 'normal',
            'due_date': None, 'note': '', 'created_by': version['savedBy'], 'created_by_name': version['savedBy'] or '—',
            'created_at': version['savedAt'], 'assignee': version['savedBy'] or None, 'assignee_name': version['savedBy'] or None,
            'submitted_by': None, 'submitted_by_name': None, 'confirmed_by': version['confirmedBy'],
            'confirmed_by_name': version['confirmedBy'], 'confirmed_at': version['savedAt'] if version['confirmedBy'] else None,
            'updated_at': version['savedAt']}
    item = row_dict(item, version, user)
    item['legacy'] = True
    return item


def allowed_actions(item, user, version):
    """Actions this user may take now, for the page to offer (the server checks again on use)."""
    p, status = set(user['permissions']), item['status']
    owner = item['created_by'] == user['username'] or 'admin' in p
    actions = []
    if 'edit' in p and status in ('submitted', 'in_design', 'pending_confirm', 'returned'):
        actions.append('edit')
    if 'edit' in p and status == 'submitted':
        actions.append('claim')
    if 'edit' in p and status in ('submitted', 'in_design', 'pending_confirm'):
        actions += ['assign', 'return']
    if 'edit' in p and status == 'in_design' and version and version['hasPoster']:
        actions.append('submit_review')
    if 'confirm' in p and status == 'pending_confirm':
        actions += ['confirm', 'send_back']
    if 'edit' in p and status == 'confirmed':
        actions.append('reopen')
    if 'submit' in p and owner and status in ('returned', 'submitted'):
        actions.append('resubmit')
    if (('submit' in p and owner) or 'admin' in p) and status in ('submitted', 'returned', 'in_design'):
        actions.append('cancel')
    return actions


def list_items(user, tab='processing', query=''):
    db = connect()
    try:
        rows = {r['campaign_id']: r for r in db.execute('SELECT * FROM workflow')}
    finally:
        db.close()
    versions = latest_versions()
    items = [row_dict(r, versions.get(cid), user) for cid, r in rows.items()]
    items += [legacy_item(cid, v, user) for cid, v in versions.items() if cid not in rows]
    counts = {name: sum(i['status'] in statuses for i in items) for name, statuses in TABS.items()}
    wanted = TABS.get(tab, TABS['processing'])
    items = [i for i in items if i['status'] in wanted]
    if query:
        q = query.casefold()
        items = [i for i in items if any(q in str(i.get(k) or '').casefold()
                                         for k in ('code', 'name', 'stores', 'created_by_name', 'assignee_name', 'statusName'))]
    order = {'high': 0, 'normal': 1, 'low': 2}
    items.sort(key=lambda i: (order.get(i['priority'], 1), i['due_date'] or '9999', ''.join(chr(0x10FFFF-ord(c)) for c in i['updated_at'] or '')))
    return {'items': items, 'counts': counts, 'statusNames': STATUS_NAMES}


def get_item(campaign_id, user):
    db = connect()
    try:
        row = db.execute('SELECT * FROM workflow WHERE campaign_id=?', (campaign_id,)).fetchone()
        events = [dict(e) for e in db.execute('SELECT * FROM workflow_events WHERE campaign_id=? ORDER BY id DESC', (campaign_id,))]
        sheet = db.execute('SELECT filename,uploaded_by,uploaded_at,length(data) AS bytes FROM workflow_sheets WHERE campaign_id=?', (campaign_id,)).fetchone()
    finally:
        db.close()
    version = latest_versions([campaign_id]).get(campaign_id)
    if row:
        item = row_dict(row, version, user)
    elif version:
        item = legacy_item(campaign_id, version, user)
    else:
        raise HTTPException(404, '找不到此海報申請')
    for e in events:
        e['actionName'] = ACTION_NAMES.get(e['action'], e['action'])
        e['fromName'] = STATUS_NAMES.get(e['from_status'], '')
        e['toName'] = STATUS_NAMES.get(e['to_status'], '')
    item['events'] = events
    item['sheet'] = dict(sheet) if sheet else None
    return item


def parse_sheet(data, filename):
    kind = filename.rsplit('.', 1)[-1].lower()
    if kind not in ('xlsx', 'csv'):
        raise HTTPException(415, '活動表請使用 .xlsx 或 UTF-8 .csv')
    result = parse_campaign(data, kind, 30)
    if result['errors']:
        raise HTTPException(422, '活動表有錯誤：' + '；'.join(result['errors'][:5]))
    rows = result['rows']
    first = rows[0]
    return kind, {'name': first.get('campaign', '')[:120] or '未命名活動', 'start': first.get('start', ''), 'end': first.get('end', ''),
                  'stores': first.get('stores', '')[:200], 'product_count': len(rows)}


def create(user, data, filename, priority, due_date, note):
    kind, info = parse_sheet(data, filename)
    import uuid
    campaign_id = str(uuid.uuid4())
    stamp = now()
    db = connect()
    try:
        with db:
            db.execute('BEGIN IMMEDIATE')
            code = next_code(db)
            db.execute('INSERT INTO workflow(campaign_id,code,name,start,end,stores,product_count,status,priority,due_date,note,'
                       'created_by,created_by_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (campaign_id, code, info['name'], info['start'], info['end'], info['stores'], info['product_count'],
                        'submitted', priority, due_date, note, user['username'], user['name'], stamp, stamp))
            db.execute('INSERT INTO workflow_sheets VALUES(?,?,?,?,?,?)', (campaign_id, filename, kind, data, user['username'], stamp))
            event(db, campaign_id, user, 'submit', None, 'submitted', note)
        return {'campaign_id': campaign_id, 'code': code}
    finally:
        db.close()


def adopt(db, campaign_id, user):
    """Give a pre-workflow campaign a workflow row the first time someone acts on it."""
    row = db.execute('SELECT * FROM workflow WHERE campaign_id=?', (campaign_id,)).fetchone()
    if row:
        return row
    version = latest_versions([campaign_id]).get(campaign_id)
    if not version:
        raise HTTPException(404, '找不到此海報申請')
    item = legacy_item(campaign_id, version)
    db.execute('INSERT INTO workflow(campaign_id,code,name,start,end,stores,product_count,status,priority,created_by,created_by_name,'
               'created_at,assignee,assignee_name,confirmed_by,confirmed_by_name,confirmed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
               (campaign_id, next_code(db), item['name'], item['start'], item['end'], item['stores'], item['product_count'], item['status'],
                'normal', item['created_by'] or user['username'], item['created_by_name'], item['created_at'], item['assignee'],
                item['assignee_name'], item['confirmed_by'], item['confirmed_by_name'], item['confirmed_at'], now()))
    return db.execute('SELECT * FROM workflow WHERE campaign_id=?', (campaign_id,)).fetchone()


def act(user, campaign_id, action, comment='', assignee=None, sheet=None):
    comment = (comment or '').strip()[:500]
    db = connect()
    confirmed_now = False
    confirmed_sequence = None
    try:
        with db:
            db.execute('BEGIN IMMEDIATE')
            row = adopt(db, campaign_id, user)
            version = latest_versions([campaign_id]).get(campaign_id)
            item = row_dict(row, version, user)
            if action not in item['actions']:
                require_perm = {'confirm': 'confirm', 'send_back': 'confirm', 'resubmit': 'submit', 'cancel': 'submit'}.get(action, 'edit')
                if require_perm not in user['permissions']:
                    raise HTTPException(403, {'confirm': '只有市場部可以確認海報', 'submit': '只有提交人或管理員可以修改活動表'}.get(require_perm, '只有市場部可以處理海報'))
                raise HTTPException(409, f"目前狀態「{STATUS_NAMES[row['status']]}」不能{ACTION_NAMES.get(action, '執行此操作')}")
            if action in ('return', 'send_back', 'reopen', 'cancel') and not comment:
                raise HTTPException(422, '請填寫原因，方便對方跟進')
            before, after, updates = row['status'], row['status'], {}
            if action == 'claim':
                after, updates = 'in_design', {'assignee': user['username'], 'assignee_name': user['name']}
            elif action == 'assign':
                with auth_database() as adb:
                    target = adb.execute('SELECT * FROM known_users WHERE username=?', (assignee or '',)).fetchone()
                if not target or not set(json.loads(target['roles'])) & {'marketing', 'admin'}:
                    raise HTTPException(422, '請選擇市場部同事（須曾登入本系統）')
                updates = {'assignee': target['username'], 'assignee_name': target['name']}
                comment = comment or f"指派給 {target['name']}"
                if before == 'submitted':
                    after = 'in_design'
            elif action == 'submit_review':
                after, updates = 'pending_confirm', {'submitted_by': user['username'], 'submitted_by_name': user['name']}
            elif action == 'confirm':
                if not version or not version['hasPoster']:
                    raise HTTPException(409, '最新版本沒有海報預覽，請市場部重新生成並提交確認')
                if separate_confirm() and row['submitted_by'] == user['username']:
                    raise HTTPException(409, '設計與確認須由不同同事負責：請另一位市場部同事確認')
                after, updates = 'confirmed', {'confirmed_by': user['username'], 'confirmed_by_name': user['name'], 'confirmed_at': now()}
            elif action == 'send_back':
                after = 'in_design'
            elif action == 'return':
                after = 'returned'
            elif action == 'resubmit':
                if sheet:
                    data, filename = sheet
                    kind, info = parse_sheet(data, filename)
                    db.execute('INSERT INTO workflow_sheets VALUES(?,?,?,?,?,?) ON CONFLICT(campaign_id) DO UPDATE SET filename=excluded.filename,'
                               'kind=excluded.kind,data=excluded.data,uploaded_by=excluded.uploaded_by,uploaded_at=excluded.uploaded_at',
                               (campaign_id, filename, kind, data, user['username'], now()))
                    updates = {k: info[k] for k in ('name', 'start', 'end', 'stores', 'product_count')}
                after = 'submitted'
            elif action == 'cancel':
                after = 'cancelled'
            elif action == 'reopen':
                after, updates = 'in_design', {'confirmed_by': None, 'confirmed_by_name': None, 'confirmed_at': None}
            elif action == 'edit':
                raise HTTPException(422, '請直接開啟編輯頁')
            else:
                raise HTTPException(422, '未知操作')
            updates['status'], updates['updated_at'] = after, now()
            db.execute('UPDATE workflow SET ' + ','.join(f'{k}=?' for k in updates) + ' WHERE campaign_id=?', (*updates.values(), campaign_id))
            event(db, campaign_id, user, action, before, after, comment, version['sequence'] if version else None)
            confirmed_now = after == 'confirmed'
            confirmed_sequence = version['sequence'] if version else None
    finally:
        db.close()
    if confirmed_now:
        stamp_confirmation(campaign_id, user['username'], confirmed_sequence)
    return get_item(campaign_id, user)


def separate_confirm():
    """When set, the colleague who designed the poster cannot be the one who confirms it."""
    return os.environ.get('POSTER_CONFIRM_BY_OTHER', 'false').lower() == 'true'


def own_design(row, user):
    return row['submitted_by'] == user['username'] or row['assignee'] == user['username'] or not (row['assignee'] or row['submitted_by'])


def stamp_confirmation(campaign_id, username, sequence=None):
    """Record the confirmer on the latest archived poster. Workflow confirmation is the process record;
    this keeps the archive column used by older screens in agreement."""
    db = archive_db()
    try:
        row = db.execute('SELECT id, sequence, confirmed_by, poster_hash FROM versions WHERE campaign_id=? ORDER BY sequence DESC LIMIT 1', (campaign_id,)).fetchone()
        if not row or not row['poster_hash'] or row['confirmed_by']:
            return
        if sequence is not None and row['sequence'] != sequence:
            return  # a newer version was saved after the confirmation; it has not been reviewed
        db.execute('UPDATE versions SET confirmed_by=? WHERE id=?', (username, row['id']))
        db.commit()
    finally:
        db.close()


def after_version_saved(campaign_id, version, user, confirmed, stored=True):
    """Keep the workflow in step with editor saves (called after every archive save)."""
    db = connect()
    unstamp = False
    try:
        with db:
            # Lock before reading so a concurrent action (cancel, return…) cannot be overwritten.
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM workflow WHERE campaign_id=?', (campaign_id,)).fetchone()
            if not row:
                return
            stamp, status = now(), row['status']
            if not stored:
                return
            if confirmed and 'confirm' in user['permissions'] and status in ('submitted', 'in_design', 'pending_confirm'):
                if separate_confirm() and own_design(row, user):
                    unstamp = True
                    db.execute('UPDATE workflow SET status=?,assignee=COALESCE(assignee,?),assignee_name=COALESCE(assignee_name,?),'
                               'submitted_by=?,submitted_by_name=?,updated_at=? WHERE campaign_id=?',
                               ('pending_confirm', user['username'], user['name'], user['username'], user['name'], stamp, campaign_id))
                    event(db, campaign_id, user, 'submit_review', status, 'pending_confirm', '設計與確認須由不同同事，已提交等待確認', version['sequence'])
                else:
                    db.execute('UPDATE workflow SET status=?,assignee=COALESCE(assignee,?),assignee_name=COALESCE(assignee_name,?),'
                               'confirmed_by=?,confirmed_by_name=?,confirmed_at=?,updated_at=? WHERE campaign_id=?',
                               ('confirmed', user['username'], user['name'], user['username'], user['name'], stamp, stamp, campaign_id))
                    event(db, campaign_id, user, 'confirm', status, 'confirmed', '於編輯頁確認', version['sequence'])
            elif not confirmed and status == 'confirmed' and version['revision'] > 0 and not version.get('confirmed_by'):
                # A confirmed poster that is edited again needs confirming again.
                db.execute('UPDATE workflow SET status=?,confirmed_by=NULL,confirmed_by_name=NULL,confirmed_at=NULL,updated_at=? WHERE campaign_id=?',
                           ('in_design', stamp, campaign_id))
                event(db, campaign_id, user, 'edited_after_confirm', status, 'in_design', '確認後內容有修改，需重新確認', version['sequence'])
            elif status == 'submitted':
                db.execute('UPDATE workflow SET status=?,assignee=COALESCE(assignee,?),assignee_name=COALESCE(assignee_name,?),updated_at=? WHERE campaign_id=?',
                           ('in_design', user['username'], user['name'], stamp, campaign_id))
                event(db, campaign_id, user, 'claim', status, 'in_design', '開始編輯海報', version['sequence'])
            else:
                db.execute('UPDATE workflow SET updated_at=? WHERE campaign_id=?', (stamp, campaign_id))
    finally:
        db.close()
    if unstamp and version.get('id'):
        # The designer only submitted for review; the archive's confirmer is stamped when a colleague confirms.
        adb = archive_db()
        try:
            adb.execute('UPDATE versions SET confirmed_by=NULL WHERE id=?', (version['id'],))
            adb.commit()
        finally:
            adb.close()
        version['confirmed_by'] = None


def campaign_deleted(campaign_id, user):
    """A deleted campaign can no longer be saved, so its open workflow item is cancelled."""
    db = connect()
    try:
        with db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT status FROM workflow WHERE campaign_id=?', (campaign_id,)).fetchone()
            if not row or row['status'] in ('confirmed', 'cancelled'):
                return
            db.execute('UPDATE workflow SET status=?,updated_at=? WHERE campaign_id=?', ('cancelled', now(), campaign_id))
            event(db, campaign_id, user, 'cancel', row['status'], 'cancelled', '活動存檔已刪除')
    finally:
        db.close()


def poster_image(campaign_id, width):
    version = latest_versions([campaign_id]).get(campaign_id)
    if not version or not version['hasPoster']:
        raise HTTPException(404, '尚未生成海報')
    db = archive_db()
    try:
        row = db.execute('SELECT a.data FROM versions v JOIN assets a ON v.poster_hash=a.hash WHERE v.id=?', (version['versionId'],)).fetchone()
    finally:
        db.close()
    if not width:
        return row['data'], 'image/png'
    with Image.open(io.BytesIO(row['data'])) as image:
        image = image.convert('RGB')
        image.thumbnail((max(80, min(width, 1600)), max(80, min(width, 1600)*2)))
        output = io.BytesIO()
        image.save(output, 'JPEG', quality=82)
    return output.getvalue(), 'image/jpeg'


def export_csv(user):
    rows = []
    for tab in TABS:
        rows += list_items(user, tab)['items']
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['編號', '活動名稱', '活動開始', '活動結束', '適用門店', '商品數', '狀態', '重要性', '期限', '提交人', '市場部負責人',
                     '確認人', '確認時間', '最後更新', '最新版本'])
    for i in rows:
        writer.writerow([i['code'], i['name'], i['start'], i['end'], i['stores'], i['product_count'], i['statusName'], i['priorityName'],
                         i['due_date'] or '', i['created_by_name'], i['assignee_name'] or '', i['confirmed_by_name'] or '',
                         i['confirmed_at'] or '', i['updated_at'], (i['version'] or {}).get('sequence', '')])
    return ('﻿' + output.getvalue()).encode('utf-8')


async def read_body(request, limit):
    data = bytearray()
    async for chunk in request.stream():
        if len(data)+len(chunk) > limit:
            raise HTTPException(413, '檔案過大')
        data.extend(chunk)
    return bytes(data)


@router.get('')
def workflow_list(request: Request, tab: str = 'processing', q: str = ''):
    return list_items(request.state.user, tab, q[:100])


@router.get('/export')
def workflow_export(request: Request):
    return Response(export_csv(request.state.user), media_type='text/csv; charset=utf-8',
                    headers={'Content-Disposition': "attachment; filename*=UTF-8''" + quote(f'海報製作流程-{datetime.now():%Y%m%d}.csv')})


@router.post('')
async def workflow_create(request: Request, filename: str, priority: str = 'normal', due: str = '', note: str = ''):
    user = require(request, 'submit')
    if priority not in PRIORITIES:
        raise HTTPException(422, '重要性不正確')
    if due:
        try:
            datetime.strptime(due, '%Y-%m-%d')
        except ValueError as exc:
            raise HTTPException(422, '期限日期格式不正確') from exc
    data = await read_body(request, MAX_SHEET)
    if not data:
        raise HTTPException(422, '請上傳活動表')
    return await run_in_threadpool(create, user, data, filename[:200], priority, due or None, note[:500])


@router.get('/{campaign_id}')
def workflow_item(campaign_id: str, request: Request):
    return get_item(campaign_id, request.state.user)


@router.post('/{campaign_id}/action')
async def workflow_action(campaign_id: str, request: Request):
    try:
        body = json.loads(await read_body(request, 8192) or b'{}')
    except ValueError as exc:
        raise HTTPException(422, '資料格式不正確') from exc
    return await run_in_threadpool(act, request.state.user, campaign_id, str(body.get('action', '')), str(body.get('comment', '')), body.get('assignee'))


@router.put('/{campaign_id}/sheet')
async def workflow_resubmit(campaign_id: str, request: Request, filename: str, note: str = ''):
    user = require(request, 'submit')
    data = await read_body(request, MAX_SHEET)
    return await run_in_threadpool(act, user, campaign_id, 'resubmit', note, None, (data, filename[:200]))


@router.get('/{campaign_id}/sheet')
def workflow_sheet(campaign_id: str):
    db = connect()
    try:
        row = db.execute('SELECT * FROM workflow_sheets WHERE campaign_id=?', (campaign_id,)).fetchone()
    finally:
        db.close()
    if not row:
        raise HTTPException(404, '此申請沒有活動表')
    mime = 'text/csv' if row['kind'] == 'csv' else 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    return Response(row['data'], media_type=mime, headers={'Content-Disposition': "attachment; filename*=UTF-8''" + quote(row['filename'])})


@router.get('/{campaign_id}/poster')
def workflow_poster(campaign_id: str, width: int = 0):
    data, mime = poster_image(campaign_id, width)
    return Response(data, media_type=mime, headers={'Cache-Control': 'private, max-age=60'})
