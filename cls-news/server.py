"""Read-only CLS telegraph relay. No credentials, arbitrary URLs or stock-service changes."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import threading
import time
import requests

PORT = 8767
TZ = timezone(timedelta(hours=8))
ORIGINS = {'https://tianzui49-oss.github.io', 'http://localhost:8001', 'http://127.0.0.1:8001'}
CACHE = {}
LOCK = threading.Lock()
SLOTS = threading.BoundedSemaphore(6)


def official_page(cursor):
    # CLS's public website accepts rn=20. Larger values can return empty data.
    query = f'app=CailianpressWeb&category=&last_time={cursor}&os=web&refresh_type=1&rn=20&sv=7.7.5'
    sign = hashlib.md5(hashlib.sha1(query.encode()).hexdigest().encode()).hexdigest()
    response = requests.get('https://www.cls.cn/v1/roll/get_roll_list?' + query + '&sign=' + sign,
                            headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.cls.cn/telegraph'}, timeout=12)
    response.raise_for_status()
    data = response.json()
    if str(data.get('errno')) != '0' or not isinstance(data.get('data', {}).get('roll_data'), list):
        raise ValueError('upstream unavailable')
    result = []
    for row in data['data']['roll_data']:
        if row.get('is_ad') or not isinstance(row.get('ctime'), (int, float)):
            continue
        ident = int(row.get('id', 0))
        if ident <= 0:
            continue
        result.append({'id': ident, 'timestamp': int(row['ctime']), 'title': str(row.get('title') or ''),
                       'content': str(row.get('content') or row.get('brief') or ''),
                       'time': datetime.fromtimestamp(row['ctime'], TZ).isoformat(),
                       'url': f'https://www.cls.cn/detail/{ident}', 'important': bool(row.get('bold'))})
    return result


def news(params):
    mode = params.get('date', [''])[0]
    today = datetime.now(TZ).date()
    if mode:
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', mode):
            raise ValueError('invalid date')
        day = datetime.strptime(mode, '%Y-%m-%d').date()
        if day > today:
            raise ValueError('future date')
        start = int(datetime.combine(day, datetime.min.time(), TZ).timestamp())
        end = start + 86400
    else:
        start = int(datetime.combine(today - timedelta(days=2), datetime.min.time(), TZ).timestamp())
        end = int(time.time()) + 1
    raw = params.get('cursor', [''])[0]
    if raw and (not raw.isdigit() or len(raw) > 11):
        raise ValueError('invalid cursor')
    cursor = min(int(raw) if raw else end, end, int(time.time()) + 1)
    if cursor < start:
        raise ValueError('cursor outside range')
    key = (mode, cursor if raw or mode and day < today else 'latest')
    with LOCK:
        cached = CACHE.get(key)
        if cached and time.monotonic() - cached[0] < (15 if not mode or day == today else 300):
            return cached[1]
    if not SLOTS.acquire(blocking=False):
        raise RuntimeError('busy')
    try:
        rows = official_page(cursor)
    finally:
        SLOTS.release()
    # Reject unrelated dates instead of presenting today's news as history.
    if rows and max(r['timestamp'] for r in rows) > cursor:
        raise RuntimeError('upstream cursor mismatch')
    oldest = min((r['timestamp'] for r in rows), default=start)
    filtered = [r for r in rows if start <= r['timestamp'] < end]
    result = {'source': '财联社', 'source_url': 'https://www.cls.cn/telegraph',
              'date': mode or None, 'range_start': datetime.fromtimestamp(start, TZ).isoformat(),
              'range_end': datetime.fromtimestamp(end, TZ).isoformat(), 'items': filtered,
              'next_cursor': oldest if oldest > start and oldest < cursor else None,
              'fetched_at': datetime.now(TZ).isoformat()}
    with LOCK:
        if len(CACHE) > 300:
            CACHE.clear()
        CACHE[key] = (time.monotonic(), result)
    return result


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if self.headers.get('Origin') and self.headers['Origin'] not in ORIGINS:
            self.send_json(403, {'error': 'origin_not_allowed'})
            return
        if parsed.path == '/health':
            self.send_json(200, {'ok': True, 'service': 'cls-telegraph-readonly'})
            return
        if parsed.path != '/api/cls-telegraph':
            self.send_json(404, {'error': 'not_found'})
            return
        try:
            params = parse_qs(parsed.query, keep_blank_values=True)
            if set(params) - {'date', 'cursor'} or any(len(v) != 1 for v in params.values()):
                raise ValueError('invalid query')
            self.send_json(200, news(params))
        except ValueError:
            self.send_json(400, {'error': 'invalid_query'})
        except Exception:
            self.send_json(502, {'error': 'official_source_unavailable'})

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    print(f'CLS read-only relay listening on {PORT}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
