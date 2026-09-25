#!/usr/bin/env python3
"""Test server for tests/bench/pump*.html: answers after a delay.

  ./tests/bench/pump-server.py 8765

/slow?d=S&n=N    N bytes after S seconds; byte i is chr(48 + i*7 % 64)
/redir?d=S&to=U  a 302 to U after S seconds
anything .html   that file from tests/bench
Each request is logged to stderr with the time it arrived.
"""
import http.server, os, socketserver, sys, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))


def pattern(n):
    block = bytes(48 + (i * 7) % 64 for i in range(64))
    return (block * (n // 64 + 1))[:n]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        args = urllib.parse.parse_qs(url.query)
        sys.stderr.write('GOT %s %.3f\n' % (self.path, time.time()))
        sys.stderr.flush()
        if url.path.endswith('.html'):
            body = open(os.path.join(HERE, os.path.basename(url.path)), 'rb').read()
            self.reply(200, 'text/html', body)
            return
        time.sleep(float(args.get('d', ['0'])[0]))
        if url.path == '/redir':
            self.send_response(302)
            self.send_header('Location', args['to'][0])
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.reply(200, 'text/plain', pattern(int(args.get('n', ['1000'])[0])))

    def reply(self, code, ctype, body):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


Server(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
