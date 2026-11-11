"""Importer: bring your ChatGPT, Claude, Claude Code or Hermes data into this Wizard.

This app is the screen. The engine is the agent's own `wizard-os` plugin (`bring_data.py`, the same code the
`wizard_bring_data` agent tool uses), reached through the agent's dashboard at
/api/plugins/wizard-os/bring-data/* with the dashboard login this app was installed with (the ChatGPT
connection app's pattern). This app parses nothing, stores no export and holds no memory: it relays.

Stdlib only. The Wizard gateway owns owner authentication; direct ports stay loopback.
"""
import http.cookiejar
import json
import re
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent if '__file__' in globals() else Path(os.environ.get('APP_ROOT', '.')).resolve()
APP_ID = 'importer'
VERSION = '0.1.8'
STATIC_TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'}
HERMES_URL = (os.environ.get('WIZARD_IMPORTER_HERMES_URL', '') or 'http://hermes-agent:9119').rstrip('/')
HERMES_USER = os.environ.get('HERMES_DASHBOARD_BASIC_AUTH_USERNAME', '') or 'hermes'
HERMES_PASSWORD = os.environ.get('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD', '')
ENGINE = '/api/plugins/wizard-os/bring-data'
MAX_UPLOAD = int(os.environ.get('WIZARD_IMPORTER_MAX_UPLOAD', str(8 * 1024 * 1024 * 1024)))
MAX_JSON = 256 * 1024


class Problem(Exception):
    def __init__(self, code, message, kind=''):
        super().__init__(message)
        self.code, self.message, self.kind = code, message, kind


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # never follow a redirect with the dashboard session
        return None


class Agent:
    """The agent's dashboard, signed in with its dashboard login (session cookie kept in memory only)."""
    lock = threading.Lock()
    opener = None

    @classmethod
    def _login(cls):
        if not HERMES_PASSWORD:
            raise Problem(503, 'This app is not connected to your agent yet.', 'not_configured')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect,
                                             urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        body = json.dumps({'provider': 'basic', 'username': HERMES_USER, 'password': HERMES_PASSWORD}).encode()
        req = urllib.request.Request(HERMES_URL + '/auth/password-login', data=body, method='POST',
                                     headers={'Content-Type': 'application/json'})
        try:
            with opener.open(req, timeout=20) as response:
                response.read()
        except urllib.error.HTTPError as error:
            error.close()
            raise Problem(503, 'Your agent did not accept this app’s sign-in.', 'login_rejected') from None
        except (urllib.error.URLError, OSError):
            raise Problem(503, 'Can’t reach your agent right now.', 'unreachable') from None
        cls.opener = opener
        return opener

    @classmethod
    def call(cls, method, path, body=None, data=None, length=None, timeout=900):
        """One engine call. A lapsed session signs in once more; an upload is never re-sent."""
        for attempt in (0, 1):
            with cls.lock:
                opener = cls.opener or cls._login()
            headers = {'X-Wizard-Import': '1', 'Accept': 'application/json'}
            payload = None
            if body is not None:
                payload = json.dumps(body).encode()
                headers['Content-Type'] = 'application/json'
            elif data is not None:
                payload = data
                headers['Content-Type'] = 'application/octet-stream'
                headers['Content-Length'] = str(length)
            req = urllib.request.Request(HERMES_URL + ENGINE + path, data=payload, method=method, headers=headers)
            try:
                with opener.open(req, timeout=timeout) as response:
                    return json.loads(response.read(32 * 1024 * 1024) or b'{}')
            except urllib.error.HTTPError as error:
                status = error.code
                try:
                    detail = json.loads(error.read(65536) or b'{}').get('detail')
                except ValueError:
                    detail = None
                error.close()
                if status == 401 and attempt == 0 and data is None:
                    cls.opener = None
                    continue
                if status == 404 and path == '/sources':
                    raise Problem(503, 'Your agent needs a Wizard OS update before it can import.', 'no_engine') from None
                raise Problem(status if 400 <= status < 500 else 502,
                              detail if isinstance(detail, str) else 'That didn’t work. Try again.') from None
            except (urllib.error.URLError, OSError, ValueError):
                cls.opener = None
                raise Problem(503, 'Can’t reach your agent right now.', 'unreachable') from None
        raise Problem(503, 'Your agent did not accept this app’s sign-in.', 'login_rejected')


def status():
    try:
        sources = Agent.call('GET', '/sources', timeout=60)
    except Problem as problem:
        return {'connected': False, 'reason': problem.kind or 'error', 'message': problem.message}
    return {'connected': True, 'read_only': bool(sources.get('read_only'))}


DEST = re.compile(r'^(here|[a-z][a-z0-9-]{0,30})$')  # an agent id from the engine's sources.into, never a path
SCAN_ID = re.compile(r'^[A-Za-z0-9_-]{8,64}$')       # the screen's random id for one scan (progress, cancel)


def pick(body, keys):
    out = {k: body[k] for k in keys if k in body}
    if 'dest' in out and not (isinstance(out['dest'], str) and DEST.fullmatch(out['dest'])):
        raise Problem(400, 'Unknown agent.')
    if 'scan_id' in out and not (isinstance(out['scan_id'], str) and SCAN_ID.fullmatch(out['scan_id'])):
        raise Problem(400, 'Invalid scan id.')
    return out


TOOLS = [
    {'name': 'importer_sources', 'description': 'What the Importer can bring in now: agent folders on this box '
     '(Claude Code, other Hermes homes) and export zips waiting in Files Inbox/Downloads. Read-only.',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'importer_imports', 'description': 'Earlier imports made with the Importer or wizard_bring_data, '
     'with what each brought in. Read-only; undo happens on the Importer screen.',
     'inputSchema': {'type': 'object', 'properties': {}}},
]


def rpc(msg):
    if not isinstance(msg, dict):
        return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Expected a JSON-RPC object.'}}
    m, i, p = msg.get('method'), msg.get('id'), msg.get('params') or {}
    if 'id' not in msg:
        return None
    try:
        if m == 'initialize':
            r = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name': APP_ID, 'version': VERSION}}
        elif m == 'tools/list':
            r = {'tools': TOOLS}
        elif m == 'tools/call':
            name = p.get('name')
            if name == 'importer_sources':
                value = Agent.call('GET', '/sources', timeout=60)
            elif name == 'importer_imports':
                value = Agent.call('GET', '/imports', timeout=60)
            else:
                return {'jsonrpc': '2.0', 'id': i, 'error': {'code': -32602, 'message': 'Unknown tool.'}}
            value.pop('success', None)
            r = {'content': [{'type': 'text', 'text': json.dumps(value)}], 'structuredContent': value, 'isError': False}
        elif m == 'ping':
            r = {}
        else:
            return {'jsonrpc': '2.0', 'id': i, 'error': {'code': -32601, 'message': 'Unknown method.'}}
    except Problem as e:
        r = {'content': [{'type': 'text', 'text': e.message}], 'isError': True}
    return {'jsonrpc': '2.0', 'id': i, 'result': r}


def _csv(name):
    return {x.strip().lower() for x in os.environ.get(name, '').split(',') if x.strip()}


# Who may talk to this app. Trust never comes from the request itself: the Host must be one this app
# was configured for (stops DNS rebinding), and a browser Origin on writes must be configured too.
_LOOPBACK = {f"127.0.0.1:{os.environ.get('PORT', '8799')}", f"localhost:{os.environ.get('PORT', '8799')}"}
TRUSTED_HOSTS = _csv('WIZARD_TRUSTED_HOSTS') | _LOOPBACK
TRUSTED_ORIGINS = _csv('WIZARD_TRUSTED_ORIGINS') | {'http://' + h for h in _LOOPBACK}


class Reader:
    """Exactly ``length`` bytes of the request body, read in blocks while relaying (never held whole)."""

    def __init__(self, stream, length):
        self.stream, self.left = stream, length

    def read(self, n=-1):
        if self.left <= 0:
            return b''
        n = self.left if n is None or n < 0 else min(n, self.left)
        chunk = self.stream.read(min(n, 1024 * 1024))
        self.left -= len(chunk)
        return chunk


class Handler(BaseHTTPRequestHandler):
    def refused(self, write=False):
        if (self.headers.get('Host') or '').lower() not in TRUSTED_HOSTS:
            self.send(403, {'error': 'Unknown host.'})
            return True
        if write:
            origin = (self.headers.get('Origin') or '').lower()
            if origin and origin not in TRUSTED_ORIGINS:
                self.send(403, {'error': 'Cross-origin writes refused.'})
                return True
            if not origin and (self.headers.get('Sec-Fetch-Site') or '') == 'cross-site':
                self.send(403, {'error': 'Cross-origin writes refused.'})
                return True
            # A custom header makes every write a CORS-preflighted request this app never allows.
            if urlsplit(self.path).path != '/mcp' and self.headers.get('X-Wizard-Request') != 'importer':
                self.send(403, {'error': 'Open the Importer from your Wizard.'})
                return True
        return False

    def send(self, code, body=None, content_type='application/json'):
        b = body if isinstance(body, bytes) else b'' if body is None else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(b)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; object-src 'none'; "
                         "base-uri 'self'; frame-ancestors 'self'")
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(b)

    def problem(self, e):
        self.send(e.code, {'error': e.message, 'reason': e.kind})

    def do_GET(self):
        if self.refused():
            return
        path = urlsplit(self.path).path
        try:
            if path == '/healthz':
                return self.send(200, {'ok': True, 'app': APP_ID, 'version': VERSION})
            if path == '/api/status':
                return self.send(200, status())
            if path == '/api/sources':
                return self.send(200, Agent.call('GET', '/sources', timeout=60))
            if path == '/api/progress':
                scan_id = (parse_qs(urlsplit(self.path).query).get('scan_id') or [''])[0]
                if not SCAN_ID.fullmatch(scan_id):
                    raise Problem(400, 'Invalid scan id.')
                return self.send(200, Agent.call('GET', '/progress?' + urllib.parse.urlencode({'scan_id': scan_id}), timeout=20))
            if path == '/api/imports':
                dest = (parse_qs(urlsplit(self.path).query).get('dest') or [''])[0]
                if dest and not DEST.fullmatch(dest):
                    raise Problem(400, 'Unknown agent.')
                query = '?' + urllib.parse.urlencode({'dest': dest}) if dest else ''
                return self.send(200, Agent.call('GET', '/imports' + query, timeout=60))
        except Problem as e:
            return self.problem(e)
        name = 'index.html' if path == '/' else path[1:]
        kind = STATIC_TYPES.get(Path(name).suffix)
        if kind and '/' not in name and not name.startswith('.') and (ROOT / 'web' / name).is_file():
            return self.send(200, (ROOT / 'web' / name).read_bytes(), kind)
        if path == '/openapi.json':
            return self.send(200, (ROOT / 'openapi.json').read_bytes())
        self.send(405 if path == '/mcp' else 404, {'error': 'Use POST /mcp.' if path == '/mcp' else 'Not found.'})

    def do_HEAD(self):
        self.do_GET()

    def length(self, limit):
        try:
            size = int(self.headers.get('Content-Length', ''))
        except ValueError:
            raise Problem(411, 'Content-Length required.') from None
        if not 0 <= size <= limit:
            raise Problem(413, 'That is too large.')
        return size

    def do_PUT(self):
        if self.refused(write=True):
            return
        url = urlsplit(self.path)
        try:
            if url.path != '/api/upload':
                raise Problem(404, 'Not found.')
            size = self.length(MAX_UPLOAD)
            name = (parse_qs(url.query).get('name') or [''])[0]
            query = '?' + urllib.parse.urlencode({'name': name})
            result = Agent.call('PUT', '/upload' + query, data=Reader(self.rfile, size), length=size, timeout=3600)
            return self.send(200, result)
        except Problem as e:
            self.close_connection = True  # an unread upload body must never be parsed as the next request
            return self.problem(e)

    def do_POST(self):
        if self.refused(write=True):
            return
        path = urlsplit(self.path).path
        try:
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                raise Problem(415, 'Use application/json.')
            body = json.loads(self.rfile.read(self.length(MAX_JSON)) or b'{}')
            if not isinstance(body, dict):
                raise Problem(400, 'Expected a JSON object.')
            if path == '/mcp':
                out = rpc(body)
                return self.send(202 if out is None else 200, out)
            if path == '/api/scan':
                return self.send(200, Agent.call('POST', '/scan', pick(body, ('path', 'paths', 'dest', 'scan_id'))))
            if path == '/api/cancel':
                return self.send(200, Agent.call('POST', '/cancel', pick(body, ('scan_id',)), timeout=20))
            if path == '/api/import':
                keys = ('import_id', 'chats', 'skills', 'personality', 'facts', 'about', 'dest')
                return self.send(200, Agent.call('POST', '/import', pick(body, keys)))
            if path == '/api/undo':
                return self.send(200, Agent.call('POST', '/undo', pick(body, ('import_id', 'dest'))))
            raise Problem(404, 'Not found.')
        except Problem as e:
            self.problem(e)
        except (ValueError, TypeError, AttributeError):
            self.send(400, {'error': 'Invalid JSON request.'})

    def log_message(self, format, *args):
        pass

# ---- wizard.app-switches/1 ------------------------------------------------------------------------------------------
# Owner feature switches for the Tracker's Try it (wizard-os docs/APP_SWITCHES.md). Shared block: the same text ships in
# every Wizard app (template: wizard-app-manager templates/hello-wizard). Every new feature ships behind a switch, off by
# default: append it to SWITCHES with the issue it delivers, e.g.
#   {'id': 'compact-header', 'name': 'Compact top bar', 'description': '...', 'default': False,
#    'issues': ['humanitylabs-org/<repo>#20']}
# and gate the feature on switch_on('compact-header'). State lives on the box (DATA_DIR/switches.json), so the app's
# page, the Tracker (through the App Manager) and the agent see one state. GET/POST /api/switches, owner only: the
# box's Tailscale Serve owner login with X-Wizard-Switch: 1; never a bearer, agent grant or box-local host.
import json as _sw_json
import os as _sw_os
import re as _sw_re
import threading as _sw_threading
from pathlib import Path as _SwPath
from urllib.parse import urlsplit as _sw_urlsplit

SWITCHES = []
_SW_CONTRACT = 'wizard.app-switches/1'
_SW_ROUTE = _sw_re.compile(r'(?:/[a-z0-9][a-z0-9-]{0,62})?/api/switches/?')
_SW_LOCAL = {'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'}
_sw_lock = _sw_threading.Lock()


def _sw_file():
    return _SwPath(_sw_os.environ.get('WIZARD_SWITCHES_DIR') or _sw_os.environ.get('DATA_DIR') or '/data') / 'switches.json'


def _sw_saved():
    try:
        saved = _sw_json.loads(_sw_file().read_text())
    except (OSError, ValueError):
        return {}
    return saved if isinstance(saved, dict) else {}


def switches_doc():
    saved = _sw_saved()
    return {'contract': _SW_CONTRACT, 'switches': [
        dict(s, on=saved[s['id']] if isinstance(saved.get(s['id']), bool) else bool(s.get('default'))) for s in SWITCHES]}


def switch_on(switch_id):
    return next((s['on'] for s in switches_doc()['switches'] if s['id'] == switch_id), False)


def _sw_set(switch_id, on):
    with _sw_lock:
        ids = {s['id'] for s in SWITCHES}
        saved = {k: v for k, v in _sw_saved().items() if k in ids and isinstance(v, bool)}
        saved[switch_id] = on
        f = _sw_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f.name + '.tmp')
        tmp.write_text(_sw_json.dumps(saved))
        _sw_os.replace(tmp, f)
    return switches_doc()


def _sw_owner(h, write):
    hd = h.headers
    if hd.get('Authorization') or hd.get('X-Wizard-Switch') != '1':
        return False
    if (hd.get('Sec-Fetch-Site') or 'same-origin').lower() not in ('same-origin', 'none'):
        return False
    host = (hd.get('Host') or '').strip().lower()
    name = host.split(']')[0] + ']' if host.startswith('[') else host.rsplit(':', 1)[0]
    if not name or name in _SW_LOCAL or '.' not in name:      # box-local and container hosts never prove the owner
        return False
    origin = hd.get('Origin')
    trusted = {o.strip() for o in (_sw_os.environ.get('WIZARD_TRUSTED_ORIGINS') or '').split(',') if o.strip()}
    if origin and _sw_urlsplit(origin).netloc.lower() != host and origin not in trusted:
        return False
    if write and not origin:
        return False
    logins = [x.strip() for x in (hd.get_all('Tailscale-User-Login') or [])]
    owners = {x.strip().lower() for x in (_sw_os.environ.get('WIZARD_OWNER_LOGINS') or '').split(',') if x.strip()}
    return len(logins) == 1 and '@' in logins[0] and (not owners or logins[0].lower() in owners)


def _sw_send(h, code, doc):
    body = _sw_json.dumps(doc).encode()
    h.send_response(code)
    h.send_header('Content-Type', 'application/json')
    h.send_header('Cache-Control', 'no-store')
    h.send_header('Content-Length', str(len(body)))
    h.end_headers()
    if h.command != 'HEAD':
        h.wfile.write(body)


def _sw_handle(h):
    """Serve /api/switches (or /<app>/api/switches) and return True; False for every other request."""
    if not _SW_ROUTE.fullmatch(_sw_urlsplit(h.path).path):
        return False
    if h.command in ('GET', 'HEAD'):
        if not _sw_owner(h, False):
            _sw_send(h, 403, {'error': "Only this Wizard's owner can see these switches.", 'code': 'owner_only'})
        else:
            _sw_send(h, 200, switches_doc())
        return True
    if not _sw_owner(h, True):
        _sw_send(h, 403, {'error': "Only this Wizard's owner can change these switches.", 'code': 'owner_only'})
        return True
    try:
        if (h.headers.get('Content-Type') or '').split(';')[0].strip() != 'application/json':
            raise ValueError
        size = int(h.headers.get('Content-Length') or '0')
        if size <= 0 or size > 4096:
            raise ValueError
        body = _sw_json.loads(h.rfile.read(size))
        if not isinstance(body, dict) or not isinstance(body.get('id'), str) or not isinstance(body.get('on'), bool) \
                or set(body) - {'id', 'on'}:
            raise ValueError
    except (ValueError, TypeError):
        _sw_send(h, 400, {'error': 'Send JSON {"id": "...", "on": true|false}', 'code': 'invalid_input'})
        return True
    if body['id'] not in {s['id'] for s in SWITCHES}:
        _sw_send(h, 404, {'error': 'No such switch', 'code': 'unknown_switch'})
        return True
    try:
        _sw_send(h, 200, _sw_set(body['id'], body['on']))
    except OSError:
        _sw_send(h, 500, {'error': 'storage_failure'})
    return True


def wizard_switches_install(handler_cls):
    """Route the switch endpoint ahead of the app's own GET/HEAD/POST handlers."""
    for method in ('do_GET', 'do_HEAD', 'do_POST'):
        orig = getattr(handler_cls, method, None)
        if getattr(orig, '_wizard_switches', False):
            continue

        def wrapped(self, _orig=orig):
            if _sw_handle(self):
                return None
            if _orig is None:
                return self.send_error(501)
            return _orig(self)
        wrapped._wizard_switches = True
        setattr(handler_cls, method, wrapped)
    return handler_cls
# ---- end wizard.app-switches/1 ---------------------------------------------------------------------------------------

wizard_switches_install(Handler)


if __name__ == '__main__':
    ThreadingHTTPServer((os.environ.get('BIND', '0.0.0.0'), int(os.environ.get('PORT', '8799'))), Handler).serve_forever()
