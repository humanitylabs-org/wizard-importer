import json, os, sys, mimetypes
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
UX = Path(os.environ['UX_WEB']); APP = Path(os.environ['APP_WEB']); FIX = json.load(open('fixture.json'))
HARNESS = Path('harness.html').read_text()
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def out(self, code, body, ctype='application/json'):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def file(self, p):
        if not p.is_file(): return self.out(404, {'error': 'nf'})
        self.out(200, p.read_bytes(), mimetypes.guess_type(str(p))[0] or 'application/octet-stream')
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/': return self.out(200, HARNESS.encode(), 'text/html')
        if path.startswith('/wizard-os-home/'): return self.file(UX / path[len('/wizard-os-home/'):])
        if path == '/importer/api/sources': return self.out(200, {**FIX['sources'], 'history': True, 'success': True})
        if path == '/importer/api/imports': return self.out(200, {'imports': []})
        if path == '/importer/api/progress': return self.out(200, {'state': 'done'})
        if path.startswith('/importer/'): return self.file(APP / (path[len('/importer/'):] or 'index.html'))
        self.out(404, {})
    def do_POST(self):
        path = self.path.split('?')[0]
        n = int(self.headers.get('Content-Length') or 0); body = json.loads(self.rfile.read(n) or b'{}')
        open('posts.jsonl', 'a').write(json.dumps([path, body]) + '\n')
        if path == '/importer/api/scan': return self.out(200, FIX['scan'] if body.get('history') else {'error': 'history flag missing'})
        if path == '/importer/api/import': return self.out(200, FIX['import'])
        self.out(404, {})
ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
