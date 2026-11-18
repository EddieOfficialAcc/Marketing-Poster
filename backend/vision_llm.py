"""Azure OpenAI vision calls, following telecom_recognize_no_mssql/app/services/openai_service.py.

The deployment is configuration only (AZURE_OPENAI_DEPLOYMENT), so switching models is an
environment change. The model is never a source of product names or prices: callers send it
images plus our own data and accept only ids, flags and review notes back.
"""
import base64
import json
import logging
import os
import re

from fastapi import HTTPException

logger = logging.getLogger(__name__)

_client = None
_json_mode_supported = None
_custom_temperature_supported = None


def settings():
    return {
        'endpoint': os.environ.get('AZURE_OPENAI_ENDPOINT', '').strip(),
        'api_key': os.environ.get('AZURE_OPENAI_API_KEY', '').strip(),
        'deployment': os.environ.get('AZURE_OPENAI_DEPLOYMENT', '').strip(),
        'api_version': os.environ.get('AZURE_OPENAI_API_VERSION', '2024-12-01-preview').strip(),
        'max_tokens': int(os.environ.get('AZURE_OPENAI_MAX_COMPLETION_TOKENS', '6000') or 6000),
    }


def configured():
    s = settings()
    return bool(s['endpoint'] and s['api_key'] and s['deployment'])


def status():
    return {'available': configured(), 'deployment': settings()['deployment'] if configured() else ''}


def _get_client():
    global _client
    if _client is None:
        if not configured():
            raise HTTPException(503, '尚未設定 AI 視覺模型（AZURE_OPENAI_ENDPOINT／API_KEY／DEPLOYMENT）')
        from openai import AzureOpenAI
        s = settings()
        _client = AzureOpenAI(azure_endpoint=s['endpoint'], api_key=s['api_key'], api_version=s['api_version'], timeout=120)
    return _client


def image_part(png_or_jpeg: bytes, mime='image/png'):
    return {'type': 'image_url', 'image_url': {'url': f'data:{mime};base64,{base64.b64encode(png_or_jpeg).decode()}', 'detail': 'high'}}


def _create_completion(content):
    """Chat completion in JSON mode when the deployment supports it (same fallbacks as telecom)."""
    global _json_mode_supported, _custom_temperature_supported
    from openai import BadRequestError
    client = _get_client()
    s = settings()
    kwargs = {'model': s['deployment'], 'messages': [{'role': 'user', 'content': content}],
              'temperature': 0, 'max_completion_tokens': s['max_tokens']}
    if _custom_temperature_supported is False:
        kwargs.pop('temperature', None)

    def unsupported_temperature(exc):
        message = str(exc).lower()
        return 'temperature' in message and 'support' in message and 'temperature' in kwargs

    if _json_mode_supported is not False:
        try:
            response = client.chat.completions.create(**kwargs, response_format={'type': 'json_object'})
            _json_mode_supported = True
            return response
        except BadRequestError as exc:
            if unsupported_temperature(exc):
                logger.warning('Deployment does not support custom temperature; retrying with default')
                _custom_temperature_supported = False
                kwargs.pop('temperature', None)
                return client.chat.completions.create(**kwargs, response_format={'type': 'json_object'})
            if 'response_format' not in str(exc).lower():
                raise
            logger.warning('JSON mode is not supported by this deployment; retrying without it')
            _json_mode_supported = False
    try:
        return client.chat.completions.create(**kwargs)
    except BadRequestError as exc:
        if unsupported_temperature(exc):
            _custom_temperature_supported = False
            kwargs.pop('temperature', None)
            return client.chat.completions.create(**kwargs)
        raise


def _extract_json_object(raw):
    start, depth, in_string, escape = None, 0, False, False
    for index, char in enumerate(raw):
        if start is None:
            if char == '{':
                start, depth = index, 1
            continue
        if in_string:
            if escape:
                escape = False
            elif char == '\\':
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return raw[start:index+1]
    raise ValueError('AI 回覆不是 JSON')


def _repair(json_text):
    repaired = re.sub(r'(?<=[}\]"0-9])\s*\n\s*(?="[^"\n]+"\s*:)', ',\n', json_text)
    repaired = re.sub(r'(?<=})\s*\n\s*(?={)', ',\n', repaired)
    return re.sub(r',(\s*[}\]])', r'\1', repaired)


def parse_json(raw):
    text = _extract_json_object(raw or '')
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(_repair(text))


def ask_json(prompt, images):
    """Send a prompt plus images; return the parsed JSON object."""
    try:
        response = _create_completion([{'type': 'text', 'text': prompt}, *images])
        return parse_json(response.choices[0].message.content)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning('Vision model call failed: %s', exc)
        raise HTTPException(502, f'AI 視覺模型呼叫失敗：{str(exc)[:200]}') from exc
