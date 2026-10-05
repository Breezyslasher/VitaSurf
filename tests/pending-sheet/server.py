#!/usr/bin/env python3
"""Test server for tests/pending-sheet: /slow.css answers after 4 s,
anything else is the page. Run by scripts/pending-sheet-test.sh.

  ./tests/pending-sheet/server.py 8811
"""
import http.server, os, socketserver, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/slow.css'):
            time.sleep(4)
            body, ctype = b'#t { color: rgb(0, 128, 0) }', 'text/css'
        else:
            body = open(os.path.join(HERE, 'focus.html'), 'rb').read()
            ctype = 'text/html'
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


Server(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
