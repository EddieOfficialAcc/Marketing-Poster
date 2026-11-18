"""Resumable download of the pinned rembg U2Net release, with upstream checksum."""
import hashlib
import http.client
import urllib.error
import os
import re
import time
import urllib.request
from pathlib import Path

URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx'
CHECKSUM = '60024c5c889badc19c04ad937298a77b'
MAX_SIZE = 250 * 1024 * 1024


class ModelDownloadError(RuntimeError):
    pass


def valid(path):
    if not path.is_file():
        return False
    digest = hashlib.md5()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest() == CHECKSUM


def ensure_model(progress=lambda stage: None):
    root = Path(os.environ.get('U2NET_HOME', str(Path.home()/'.u2net')))
    root.mkdir(parents=True, exist_ok=True)
    target, partial = root/'u2net.onnx', root/'u2net.onnx.part'
    if valid(target):
        return target
    last_error = None
    for attempt in range(1, 4):
        if valid(partial):
            partial.replace(target)
            return target
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            progress(f'download:retry:{attempt}')
            headers = {'Accept-Encoding':'identity'}
            if offset:
                headers['Range'] = f'bytes={offset}-'
            with urllib.request.urlopen(urllib.request.Request(URL, headers=headers), timeout=120) as response:
                if response.status == 206:
                    match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range',''))
                    if not match or int(match[1]) != offset:
                        raise OSError('伺服器回傳的續傳位置不符')
                    total = int(match[3])
                    mode = 'ab'
                elif response.status == 200:
                    # Server ignored Range: replace partial bytes, never append a full file.
                    offset = 0
                    total = int(response.headers.get('Content-Length',0))
                    mode = 'wb'
                else:
                    raise OSError(f'下載回應 {response.status}')
                if total > MAX_SIZE:
                    raise OSError('模型檔案大小異常')
                last_percent = -1
                with partial.open(mode) as output:
                    while True:
                        chunk = response.read(64*1024)
                        if not chunk:
                            break
                        offset += len(chunk)
                        if offset > MAX_SIZE:
                            raise OSError('模型檔案大小超出限制')
                        output.write(chunk)
                        percent = min(99, int(offset*100/total)) if total else 0
                        if percent != last_percent:
                            progress(f'download:{percent}:{attempt}')
                            last_percent = percent
                if total and offset < total:
                    raise OSError('模型下載中斷')
            progress('verifying')
            if not valid(partial):
                partial.unlink(missing_ok=True)
                raise OSError('模型校驗失敗，重新下載')
            partial.replace(target)
            return target
        except (OSError, ValueError, http.client.HTTPException) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code == 416:
                partial.unlink(missing_ok=True)
            last_error = error
            if attempt < 3:
                progress(f'download:retry:{attempt+1}')
                time.sleep(attempt*2)
    raise ModelDownloadError('模型下載失敗，已嘗試 3 次。已下載部分保留；檢查 GitHub 連線後重新提交可續傳。') from last_error
