"""Importer app server: relays to a fake agent dashboard (stdlib only, no Hermes, no network beyond loopback).

Covers the dashboard sign-in, the write guard (custom header, foreign Origin), streaming upload relay, the
"agent too old" answer, and that the app forwards only the documented fields.
"""
import importlib.util
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FakeDashboard(BaseHTTPRequestHandler):
    calls = []
    engine = True

    def log_message(self, *a):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        if self.path == '/auth/password-login':
            self.send_header('Set-Cookie', 'hermes_session_at=ok; Path=/; HttpOnly')
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n)

    def authed(self):
        return 'hermes_session_at=ok' in (self.headers.get('Cookie') or '')

    def do_POST(self):
        raw = self.body()
        if self.path == '/auth/password-login':
            ok = json.loads(raw).get('password') == 'p' * 20
            return self.reply(200 if ok else 401, {})
        FakeDashboard.calls.append((self.command, self.path, self.headers.get('X-Wizard-Import'), raw))
        if not self.authed():
            return self.reply(401, {'detail': 'Unauthorized'})
        if self.path.endswith('/scan'):
            return self.reply(200, {'success': True, 'import_id': 'abc', 'echo': json.loads(raw)})
        return self.reply(409, {'detail': 'Scan the export first.'})

    def do_GET(self):
        FakeDashboard.calls.append((self.command, self.path, None, b''))
        if not self.authed():
            return self.reply(401, {'detail': 'Unauthorized'})
        if not FakeDashboard.engine:
            return self.reply(404, {'detail': 'Not Found'})
        return self.reply(200, {'success': True, 'local': [], 'files': [], 'read_only': False})

    def do_PUT(self):
        raw = self.body()
        FakeDashboard.calls.append((self.command, self.path, self.headers.get('X-Wizard-Import'), raw))
        return self.reply(200, {'success': True, 'path': 'Inbox/x.zip', 'size': len(raw)})


def serve(handler):
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dash = serve(FakeDashboard)
        os.environ.update(WIZARD_IMPORTER_HERMES_URL=f'http://127.0.0.1:{cls.dash.server_port}',
                          HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='p' * 20, PORT='18999')
        spec = importlib.util.spec_from_file_location('importer_server', ROOT / 'app/server.py')
        cls.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.mod)
        cls.app = serve(cls.mod.Handler)
        cls.base = f'http://127.0.0.1:{cls.app.server_port}'
        cls.mod.TRUSTED_HOSTS.add(f'127.0.0.1:{cls.app.server_port}')

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown(); cls.dash.shutdown()

    def setUp(self):
        FakeDashboard.calls.clear(); FakeDashboard.engine = True; self.mod.Agent.opener = None

    def req(self, method, path, body=None, data=None, headers=None):
        h = {'X-Wizard-Request': 'importer', **(headers or {})}
        if body is not None:
            data = json.dumps(body).encode(); h['Content-Type'] = 'application/json'
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=10) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')

    def test_status_signs_in_and_reports_connected(self):
        self.assertEqual(self.req('GET', '/api/status'), (200, {'connected': True, 'read_only': False}))

    def test_agent_without_engine_says_update_needed(self):
        FakeDashboard.engine = False
        code, body = self.req('GET', '/api/status')
        self.assertEqual((code, body['connected'], body['reason']), (200, False, 'no_engine'))

    def test_writes_need_the_app_header_and_a_trusted_origin(self):
        self.assertEqual(self.req('POST', '/api/scan', {'path': 'x'}, headers={'X-Wizard-Request': ''})[0], 403)
        self.assertEqual(self.req('POST', '/api/scan', {'path': 'x'}, headers={'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(FakeDashboard.calls, [])

    def test_scan_forwards_only_documented_fields_with_the_engine_header(self):
        code, body = self.req('POST', '/api/scan', {'path': 'Inbox/x.zip', 'evil': '../../etc'})
        self.assertEqual(code, 200)
        self.assertEqual(body['echo'], {'path': 'Inbox/x.zip'})
        self.assertEqual(FakeDashboard.calls[-1][:3], ('POST', '/api/plugins/wizard-os/bring-data/scan', '1'))

    def test_dest_is_an_agent_id_relayed_to_the_engine(self):
        code, body = self.req('POST', '/api/scan', {'path': 'x', 'dest': 'oscar-os'})
        self.assertEqual((code, body['echo']), (200, {'path': 'x', 'dest': 'oscar-os'}))
        for bad in ('../x', '/home', 'Oscar', 3):
            self.assertEqual(self.req('POST', '/api/scan', {'path': 'x', 'dest': bad})[0], 400, bad)
            self.assertEqual(self.req('POST', '/api/undo', {'import_id': 'a', 'dest': bad})[0], 400, bad)
        self.assertEqual(self.req('GET', '/api/imports?dest=oscar-os')[0], 200)
        self.assertEqual(FakeDashboard.calls[-1][1], '/api/plugins/wizard-os/bring-data/imports?dest=oscar-os')
        self.assertEqual(self.req('GET', '/api/imports?dest=..%2Fx')[0], 400)
        self.req('POST', '/api/import', {'import_id': 'a', 'facts': True, 'dest': 'oscar-os', 'evil': 1})
        self.assertEqual(json.loads(FakeDashboard.calls[-1][3]), {'import_id': 'a', 'facts': True, 'dest': 'oscar-os'})

    def test_engine_refusal_text_reaches_the_screen(self):
        code, body = self.req('POST', '/api/import', {'import_id': 'nope', 'chats': True})
        self.assertEqual((code, body['error']), (409, 'Scan the export first.'))

    def test_upload_is_relayed_byte_for_byte(self):
        data = os.urandom(3 * 1024 * 1024 + 7)
        code, body = self.req('PUT', '/api/upload?name=my%20export.zip', data=data)
        self.assertEqual((code, body['size']), (200, len(data)))
        method, path, header, raw = FakeDashboard.calls[-1]
        self.assertEqual((method, path, header), ('PUT', '/api/plugins/wizard-os/bring-data/upload?name=my+export.zip', '1'))
        self.assertEqual(raw, data)

    def test_mcp_tools_are_read_only(self):
        code, body = self.req('POST', '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
        self.assertEqual([t['name'] for t in body['result']['tools']], ['importer_sources', 'importer_imports'])
        code, body = self.req('POST', '/mcp', {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'importer_sources'}})
        self.assertFalse(body['result']['isError'])
        self.assertEqual(body['result']['structuredContent']['files'], [])


class PackageTests(unittest.TestCase):
    def test_install_form_values_reach_the_container(self):
        # The install form's agent address and login must be passed into the container, or an installed app
        # can never sign in to the agent (0.1.0 shipped without them).
        compose = (ROOT / 'runtipi/docker-compose.yml').read_text('utf-8')
        fields = json.loads((ROOT / 'runtipi/config.json').read_text('utf-8'))['form_fields']
        for field in fields:
            var = field['env_variable']
            self.assertIn(f'      {var}: ${{{var}:-', compose, var)


if __name__ == '__main__':
    unittest.main()
