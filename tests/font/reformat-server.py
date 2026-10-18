#!/usr/bin/env python3
r"""Web fonts arriving after the page is shown (VitaSurf).

    python3 -I tests/font/reformat-server.py 8012

/ is a page of eight paragraphs, each in a family of its own, and each
family's face is answered a second and a half after it is asked for, so
all eight arrive together, after the page has loaded. tests/font/reformat-test.sh runs it with the harness, MONKEY_WEBFONTS=1
making it take the faces (FONT ADD), and counts the layouts after the
first face arrives (each prints UPDATE_EXTENT): one, after a short wait,
where each face had laid the page out at once, eight passes back to back.
"""
import http.server, socketserver, sys, threading, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8012
FACE = b'\0' * 20000
faces = ''.join('@font-face{font-family:F%d;src:url(/f%d.woff2) '
                'format("woff2")}\n' % (i, i) for i in range(1, 9))
paras = ''.join('<p style="font-family:F%d">text in face %d of eight, long '
                'enough to wrap a line or two when it is laid out</p>\n'
                % (i, i) for i in range(1, 9))
PAGE = ('<!DOCTYPE html><meta charset="utf-8"><title>web font '
        'reformat</title><style>' + faces + '</style><body>' + paras +
        '</body>').encode()


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith('/f'):
            time.sleep(1.5)
            body, ctype = FACE, 'font/woff2'
        else:
            body, ctype = PAGE, 'text/html; charset=utf-8'
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


S(('127.0.0.1', PORT), H).serve_forever()
