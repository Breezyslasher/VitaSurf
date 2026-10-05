#!/usr/bin/env python3
# Serves tests/modules/redirect.html: see README.md.
import http.server, sys, collections, urllib.parse
hits = collections.Counter()
FILES = {
 '/page.html': ('text/html', open(sys.argv[2]).read()),
 '/lib@1.2/a.js': ('text/javascript', "import {w} from './b.js';\nimport {c} from './c.js';\nexport const v = 'a' + w + c;\nexport const meta = import.meta.url;\n"),
 '/lib@1.2/b.js': ('text/javascript', "export const w = 'b';\nexport const id = {};\n"),
 '/lib@1.2/c.js': ('text/javascript', "export const c = 'c';\n"),
}
REDIR = {'/lib@%5E1.0/a.js': '/lib@1.2/a.js', '/lib@%5E1.0/b.js': '/lib@1.2/b.js', '/lib@%5E1.0/c.js': '/lib@1.2/c.js'}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        p = self.path.split('?')[0]
        hits[p] += 1
        if p == '/hits':
            body = repr(dict(hits)).encode(); self.send_response(200)
            self.send_header('Content-Type','text/plain'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body); return
        if p in REDIR:
            self.send_response(302); self.send_header('Location', REDIR[p]); self.send_header('Content-Length','0'); self.end_headers(); return
        if p in FILES:
            t, b = FILES[p]; b = b.encode(); self.send_response(200)
            self.send_header('Content-Type', t); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b); return
        self.send_response(404); self.send_header('Content-Length','0'); self.end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
