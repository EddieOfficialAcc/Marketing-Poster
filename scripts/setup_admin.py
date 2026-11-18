"""Create a private deployment credential file without printing its password."""
import os
from pathlib import Path
import secrets

root = Path(__file__).resolve().parent.parent
path = root / '.env'
if path.is_symlink():
    raise SystemExit('Refusing to modify a symlinked .env')
content = path.read_text() if path.exists() else ''
if not any(line.startswith('ADMIN_PASSWORD=') for line in content.splitlines()):
    content += '\nADMIN_USERNAME=admin\nADMIN_PASSWORD=' + secrets.token_urlsafe(24) + '\nCOOKIE_SECURE=false\n'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(content)
os.chmod(path, 0o600)
print('Administrator configuration ready in .env (password not printed).')
