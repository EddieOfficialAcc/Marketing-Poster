"""Login (intranet accounts plus a local break-glass administrator) and role-based access.

Intranet users sign in with their intranet account: the password goes to the intranet login
API once and is never stored; their poster roles come from the intranet `content_permissions`
codes, mapped by configuration. Sessions are durable, revocable and stored only as hashes.
"""
import hashlib
import hmac
import json
import re
import urllib.error
import urllib.request
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix='/api/auth')
COOKIE = 'poster_session'
TTL = 8 * 60 * 60


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()


@contextmanager
def database():
    root = Path(os.environ.get('POSTER_DATA_DIR', './data'))
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / 'auth.sqlite3', timeout=30)
    db.row_factory = sqlite3.Row
    try:
        db.executescript('''
          CREATE TABLE IF NOT EXISTS administrator (username TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, username TEXT NOT NULL, expires REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS known_users (username TEXT PRIMARY KEY, name TEXT NOT NULL, roles TEXT NOT NULL, last_login REAL NOT NULL, codes TEXT NOT NULL DEFAULT '[]');
          CREATE TABLE IF NOT EXISTS attempts (address TEXT PRIMARY KEY, failures INTEGER NOT NULL, started REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS role_grants (role TEXT NOT NULL, code TEXT NOT NULL, PRIMARY KEY(role, code));
        ''')
        columns = {row[1] for row in db.execute('PRAGMA table_info(sessions)')}
        for column, kind in (('name', "TEXT NOT NULL DEFAULT ''"), ('roles', "TEXT NOT NULL DEFAULT '[\"admin\"]'")):
            if column not in columns:
                db.execute(f'ALTER TABLE sessions ADD COLUMN {column} {kind}')
        if 'codes' not in {row[1] for row in db.execute('PRAGMA table_info(known_users)')}:
            db.execute("ALTER TABLE known_users ADD COLUMN codes TEXT NOT NULL DEFAULT '[]'")
        if not db.execute('SELECT 1 FROM administrator').fetchone():
            password = os.environ.get('ADMIN_PASSWORD', '')
            username = os.environ.get('ADMIN_USERNAME', 'admin')
            if len(password) < 6 or not 1 <= len(username) <= 80:
                raise HTTPException(503, '管理員帳號尚未設定，請完成部署設定')
            salt = secrets.token_hex(16)
            db.execute('INSERT OR IGNORE INTO administrator VALUES(?,?,?)', (username, salt, password_hash(password, salt)))
        yield db
        db.commit()
    finally:
        db.close()



def sync_admin():
    """Apply deployment credentials on startup and revoke sessions after a reset."""
    username = os.environ.get('ADMIN_USERNAME', 'admin')
    password = os.environ.get('ADMIN_PASSWORD', '')
    if len(password) < 6 or not 1 <= len(username) <= 80:
        raise RuntimeError('管理員部署帳號或密碼無效')
    with database() as db:
        row = db.execute('SELECT * FROM administrator WHERE username=?', (username,)).fetchone()
        if row and hmac.compare_digest(password_hash(password, row['salt']), row['password_hash']):
            return
        salt = secrets.token_hex(16)
        db.execute('DELETE FROM sessions')
        db.execute('DELETE FROM attempts')
        db.execute('DELETE FROM administrator')
        db.execute('INSERT INTO administrator VALUES(?,?,?)', (username, salt, password_hash(password, salt)))


# Roles and what they may do. 採購 submit activity sheets; 市場部 edit, check and confirm posters.
ROLE_PERMISSIONS = {
    'admin': {'view', 'submit', 'edit', 'confirm', 'admin'},
    'marketing': {'view', 'edit', 'confirm'},
    'purchaser': {'view', 'submit'},
    'viewer': {'view'},
}
ROLE_NAMES = {'admin': '管理員', 'marketing': '市場部', 'purchaser': '採購', 'viewer': '只讀'}
DEFAULT_CODES = {'admin': 'poster_admin', 'marketing': 'poster_marketing', 'purchaser': 'poster_purchaser', 'viewer': 'poster_viewer'}


def role_codes():
    """Intranet permission codes per role, e.g. POSTER_ROLE_CODES_MARKETING=mkt_poster,mkt_design."""
    return {role: {c.strip().casefold() for c in os.environ.get(f'POSTER_ROLE_CODES_{role.upper()}', default).split(',') if c.strip()}
            for role, default in DEFAULT_CODES.items()}


def combined_mapping(db):
    """Env defaults plus codes an administrator has attached to a role."""
    mapping = {role: set(codes) for role, codes in role_codes().items()}
    for row in db.execute('SELECT role, code FROM role_grants'):
        if row['role'] in mapping:
            mapping[row['role']].add(str(row['code']).casefold())
    return mapping


def roles_from_codes(codes):
    owned = {str(code).strip().casefold() for code in codes if code}
    with database() as db:
        mapping = combined_mapping(db)
    return [role for role, wanted in mapping.items() if owned & wanted]


def apply_role_mapping(db):
    """Recompute intranet users' roles after a code is mapped. The break-glass admin is left unchanged."""
    mapping = combined_mapping(db)
    admin = db.execute('SELECT username FROM administrator').fetchone()
    for user in list(db.execute('SELECT username, codes FROM known_users')):
        if admin and user['username'] == admin['username']:
            continue
        owned = {str(code).strip().casefold() for code in json.loads(user['codes'] or '[]') if code}
        roles = json.dumps([role for role, wanted in mapping.items() if owned & wanted])
        db.execute('UPDATE known_users SET roles=? WHERE username=?', (roles, user['username']))
        db.execute('UPDATE sessions SET roles=? WHERE username=?', (roles, user['username']))


def describe(username, name, roles):
    permissions = sorted(set().union(*(ROLE_PERMISSIONS.get(r, set()) for r in roles))) if roles else []
    separate = os.environ.get('POSTER_CONFIRM_BY_OTHER', 'false').lower() == 'true'
    return {'username': username, 'name': name or username, 'roles': roles, 'permissions': permissions,
            'role': roles[0] if roles else '', 'roleNames': [ROLE_NAMES[r] for r in roles if r in ROLE_NAMES],
            'policies': {'confirmByOther': separate}}


def identity(token):
    if not token or len(token) > 128:
        return None
    with database() as db:
        row = db.execute('SELECT username,name,roles FROM sessions WHERE digest=? AND expires>?',
                         (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        return describe(row['username'], row['name'], json.loads(row['roles'])) if row else None


def intranet_login(identifier, password):
    """Sign in through the intranet: returns (canonical username, display name, permission codes), or None if refused.

    POST {INTRANET_AUTH_URL}/api/auth/local gives a JWT; /api/users/me with that JWT gives the
    active content_permissions. The JWT is used for these two calls only and never stored.
    """
    base = os.environ.get('INTRANET_AUTH_URL', '').rstrip('/')
    if not base:
        return None
    def call(url, data=None, token=None):
        request = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                         method='POST' if data is not None else 'GET')
        request.add_header('Accept', 'application/json')
        if data is not None:
            request.add_header('Content-Type', 'application/json')
        if token:
            request.add_header('Authorization', f'Bearer {token}')
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())
    try:
        login = call(f'{base}/api/auth/local', {'identifier': identifier, 'password': password})
    except urllib.error.HTTPError as exc:
        if exc.code in (400, 401, 403):
            return None
        raise HTTPException(503, '內聯網登入服務暫時無法使用，請稍後重試') from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise HTTPException(503, '無法連線內聯網登入服務，請稍後重試') from exc
    token, user = login.get('jwt'), login.get('user') or {}
    if not token:
        return None
    try:
        me = call(f'{base}/api/users/me?populate[content_permissions][fields]=code'
                  '&populate[content_permissions][filters][active][$eq]=true', token=token)
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise HTTPException(503, '無法讀取內聯網用戶權限，請稍後重試') from exc
    name = me.get('displayName') or me.get('name') or user.get('displayName') or me.get('username') or user.get('username') or identifier
    # The intranet accepts an email or any letter case as identifier; keep one identity per account.
    username = me.get('username') or user.get('username') or identifier
    return str(username)[:80], str(name)[:80], permission_codes(me)


def permission_codes(profile):
    """Flat Strapi list, or the v4 `{data:[{attributes:{code}}]}` shape."""
    raw = profile.get('content_permissions') or []
    if isinstance(raw, dict):
        raw = raw.get('data') or []
    codes = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, str):
            codes.append(item)
        elif isinstance(item, dict):
            attrs = item.get('attributes') if isinstance(item.get('attributes'), dict) else item
            if attrs.get('code'):
                codes.append(str(attrs['code']))
    return codes


# Which permission each API needs. Anything not listed only needs a valid login (view).
def required_permission(method, path):
    if method in {'GET', 'HEAD', 'OPTIONS'}:
        return 'view'
    if path.startswith('/api/campaigns/'):
        return 'admin'
    if path.startswith('/api/workflow'):
        return None  # the workflow API checks per action (submit, edit, confirm, admin)
    if path.startswith(('/api/archives', '/api/archive-assets', '/api/cutout-jobs', '/api/poster-auto', '/api/poster-pdf',
                        '/api/import-campaign', '/api/remove-background')):
        return 'edit'
    return 'view'


def require(request, permission, message=None):
    user = getattr(request.state, 'user', None)
    if not user or permission not in user['permissions']:
        raise HTTPException(403, message or {'edit': '只有市場部可以編輯海報', 'confirm': '只有市場部可以確認海報',
                                             'submit': '只有採購可以提交活動表', 'admin': '只有管理員可以執行此操作'}.get(permission, '沒有權限'))
    return user


def check_origin(request):
    origin = request.headers.get('origin')
    if request.headers.get('sec-fetch-site') == 'cross-site' or (origin and urlsplit(origin).netloc != request.headers.get('host')):
        raise HTTPException(403, '請從平台頁面操作')


async def protect(request, call_next):
    public = {'/api/health', '/api/auth/login'}
    if request.url.path.startswith('/api/'):
        try:
            if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
                check_origin(request)
            if request.url.path not in public:
                user = await run_in_threadpool(identity, request.cookies.get(COOKIE))
                if not user:
                    raise HTTPException(401, '請先登入')
                request.state.user = user
                permission = required_permission(request.method, request.url.path)
                if permission:
                    require(request, permission)
        except HTTPException as exc:
            return JSONResponse({'detail': exc.detail}, status_code=exc.status_code, headers={'Cache-Control': 'no-store'})
    response = await call_next(request)
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


def remember_user(db, username, name, roles, codes, seen_at):
    db.execute('INSERT INTO known_users(username,name,roles,last_login,codes) VALUES(?,?,?,?,?) ON CONFLICT(username) DO UPDATE SET '
               'name=excluded.name, roles=excluded.roles, last_login=excluded.last_login, codes=excluded.codes',
               (username, name, json.dumps(roles), seen_at, json.dumps(list(codes))))


def authenticate(username, password, address):
    """Local administrator first (break-glass account), otherwise the intranet account."""
    now = time.time()
    with database() as db:
        db.execute('DELETE FROM attempts WHERE started<?', (now-900,))
        attempt = db.execute('SELECT failures FROM attempts WHERE address=?', (address,)).fetchone()
        if attempt and attempt['failures'] >= 5:
            return None, 429, None
        # Count the attempt before checking the password, so parallel guesses cannot all pass the limit.
        db.execute('INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(address) DO UPDATE SET failures=failures+1, started=CASE WHEN failures+1>=5 THEN excluded.started ELSE started END', (address, now))
        row = db.execute('SELECT * FROM administrator WHERE username=?', (username,)).fetchone()
    user = None
    intranet = None
    if row:
        if hmac.compare_digest(password_hash(password, row['salt']), row['password_hash']):
            user = (username, username, ['admin'])
    else:
        password_hash(password, '00'*16)  # same cost as a local check, so timing reveals nothing
        intranet = intranet_login(username, password)
        if intranet:
            username, name, codes = intranet
            roles = roles_from_codes(codes)
            if roles:
                user = (username, name, roles)
    with database() as db:
        if intranet and not user:
            username, name, codes = intranet
            db.execute('DELETE FROM attempts WHERE address=?', (address,))
            remember_user(db, username, name, [], codes, now)
            return None, 403, None
        if not user:
            return None, 401, None  # already counted above
        db.execute('DELETE FROM attempts WHERE address=?', (address,))
        db.execute('DELETE FROM sessions WHERE expires<=?', (now,))
        token = secrets.token_urlsafe(32)
        db.execute('INSERT INTO sessions(digest,username,expires,name,roles) VALUES(?,?,?,?,?)',
                   (hashlib.sha256(token.encode()).hexdigest(), user[0], now+TTL, user[1], json.dumps(user[2])))
        # Remembered for assignment lists and audit display; no password or token is kept.
        remember_user(db, user[0], user[1], user[2], intranet[2] if intranet else [], now)
        return token, 200, describe(*user)


@router.post('/login')
async def login(request: Request):
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 4096:
            raise HTTPException(413, '登入資料過長')
    import json
    try:
        data = json.loads(body)
        username, password = data['username'], data['password']
        if not isinstance(username, str) or not isinstance(password, str) or len(username)>80 or len(password)>256:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise HTTPException(422, '請填寫帳號及密碼')
    address = request.headers.get('x-real-ip') or request.client.host
    token, status, user = await run_in_threadpool(authenticate, username, password, address)
    if not token:
        raise HTTPException(status, {429: '登入嘗試過多，請在 15 分鐘後重試', 403: '此帳號未獲授權使用海報系統。請管理員在「權限對應」配上內聯網權限代碼，或在內聯網開通海報權限'}.get(status, '帳號或密碼不正確'))
    response = JSONResponse(user)
    response.set_cookie(COOKIE, token, max_age=TTL, httponly=True, samesite='strict',
                        secure=os.environ.get('COOKIE_SECURE', 'false').lower() == 'true', path='/')
    return response


@router.get('/me')
def me(request: Request):
    return request.state.user


@router.get('/users')
def users(request: Request):
    """People who have signed in, for choosing a marketing assignee."""
    require(request, 'edit', '只有市場部可以查看同事名單')
    with database() as db:
        return [{'username': r['username'], 'name': r['name'], 'roles': json.loads(r['roles'])}
                for r in db.execute('SELECT * FROM known_users ORDER BY name')]


CODE_PATTERN = re.compile(r'[A-Za-z0-9_.:-]{1,80}')


@router.get('/role-grants')
def role_grants(request: Request):
    """Intranet permission codes currently mapped to poster roles, plus accounts already seen."""
    require(request, 'admin')
    with database() as db:
        grants = [{'role': r['role'], 'code': r['code']} for r in db.execute('SELECT role, code FROM role_grants ORDER BY role, code')]
        people = [{'username': r['username'], 'name': r['name'], 'roles': json.loads(r['roles']),
                   'codes': json.loads(r['codes'] or '[]'), 'lastLogin': r['last_login']}
                  for r in db.execute('SELECT * FROM known_users ORDER BY last_login DESC')]
        defaults = {role: sorted(codes) for role, codes in combined_mapping(db).items()}
    return {'defaults': defaults, 'grants': grants, 'users': people, 'roleNames': ROLE_NAMES}


@router.post('/role-grants')
async def add_role_grant(request: Request):
    require(request, 'admin')
    try:
        body = await request.json()
        role, code = str(body['role']), str(body['code']).strip()
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(422, '請填寫角色及權限代碼') from exc
    if role not in ROLE_PERMISSIONS or not CODE_PATTERN.fullmatch(code):
        raise HTTPException(422, '角色或權限代碼不正確')
    with database() as db:
        db.execute('INSERT OR IGNORE INTO role_grants VALUES(?,?)', (role, code.casefold()))
        apply_role_mapping(db)
    return {'ok': True}


@router.delete('/role-grants')
def remove_role_grant(request: Request, role: str, code: str):
    require(request, 'admin')
    if role not in ROLE_PERMISSIONS:
        raise HTTPException(422, '角色不正確')
    with database() as db:
        db.execute('DELETE FROM role_grants WHERE role=? AND code=?', (role, code.strip().casefold()))
        apply_role_mapping(db)
    return {'ok': True}


@router.post('/logout')
def logout(request: Request):
    with database() as db:
        db.execute('DELETE FROM sessions WHERE digest=?', (hashlib.sha256(request.cookies[COOKIE].encode()).hexdigest(),))
    response = JSONResponse({'ok': True})
    response.delete_cookie(COOKIE, path='/')
    return response
