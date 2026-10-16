#!/usr/bin/env python3
"""A page whose style sheet and script come slowly, to see the browser stop
fetching them once the page is left (VitaSurf).

    python3 -I tests/fetch/abandon-server.py [port]

Load http://127.0.0.1:PORT/a, then before 30 s have passed go to
http://127.0.0.1:PORT/b. The server prints, for the sheet and the script
/a asked for, how much it sent and whether the browser hung up on it:

    abandon: /slow.css stopped by the browser after 12 of 300 KB
    abandon: /slow.js stopped by the browser after 11 of 300 KB

"sent whole" for either means the browser fetched it to the end for a page
it had left. Leave the browser on /b for 25 s, the time its cache takes
to let go of what nothing uses. Chrome stops both when /b commits.
"""
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOTAL_KB = 300
CHUNK = 1024
DELAY = 0.1  # 10 KB a second


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def page(self, body):
        data = body.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def slow(self, ctype, filler):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(TOTAL_KB * CHUNK))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        sent = 0
        try:
            for _ in range(TOTAL_KB):
                self.wfile.write(filler * (CHUNK // len(filler)))
                self.wfile.flush()
                sent += 1
                time.sleep(DELAY)
        except (BrokenPipeError, ConnectionResetError):
            print('abandon: %s stopped by the browser after %d of %d KB'
                  % (self.path, sent, TOTAL_KB), flush=True)
            return
        print('abandon: %s sent whole, %d KB' % (self.path, TOTAL_KB),
              flush=True)

    def do_GET(self):
        if self.path == '/a':
            self.page('<!DOCTYPE html><html><head>'
                      '<link rel="stylesheet" href="/slow.css">'
                      '</head><body><p>a</p>'
                      '<script src="/slow.js"></script></body></html>')
        elif self.path == '/b':
            self.page('<!DOCTYPE html><html><body><p>b</p></body></html>')
        elif self.path == '/slow.css':
            self.slow('text/css', b'/* filler */ p { color: red; }\n')
        elif self.path == '/slow.js':
            self.slow('text/javascript', b'/* filler filler filler */\n')
        else:
            self.send_error(404)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8771
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
