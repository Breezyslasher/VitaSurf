#!/usr/bin/env python3
"""Scripts sent as types other than JavaScript's (VitaSurf).

    python3 -I tests/fetch/script-mime-server.py [port]

Load http://127.0.0.1:PORT/ and read the console: a line for each script
the page puts in, with the Content-Type it is sent as, whether it ran and
whether its element heard load or error. The Fetch standard runs a
classic script whatever it is sent as, but an image, audio, video or CSV
type, or any type but JavaScript's with "X-Content-Type-Options:
nosniff"; a module script must be sent as JavaScript; and one whose
answer is not a success (a 404 page) runs not at all. NetSurf had run
text/javascript and application/javascript alone. A script the parser
meets, fetched early by the preload scanner, is held to the same rules.
Each line must say PASS; Chrome passes them all.
"""
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# type, nosniff, module, whether it runs, status
CASES = [
    ('text/javascript', False, False, True),
    ('application/javascript', False, False, True),
    ('text/plain', False, False, True),
    ('application/octet-stream', False, False, True),
    ('application/json', False, False, True),
    ('text/html', False, False, True),
    ('', False, False, True),
    ('text/x-js', False, False, True),
    ('image/png', False, False, False),
    ('text/csv', False, False, False),
    ('audio/mpeg', False, False, False),
    ('video/mp4', False, False, False),
    ('text/plain', True, False, False),
    ('text/javascript', True, False, True),
    ('text/plain', False, True, False),
    ('text/javascript', False, True, True),
    ('text/javascript', False, False, False, 404),
    ('text/html', False, False, False, 404),
    ('text/javascript', False, False, False, 500),
]
CASES = [c if len(c) == 5 else c + (200,) for c in CASES]

PAGE = '''<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Script types</title>
<script>window.parsed = [];</script>
<script src="/js?i=2&amp;parsed=1" onload="parsed.push('load')" onerror="parsed.push('error')"></script>
<script>console.log('script-mime: ' + (window.parsedRan && parsed.join() === 'load' ?
  'PASS' : 'FAIL') + ' a parsed script sent as text/plain: ' +
  (window.parsedRan ? 'ran' : 'did not run') + ', ' + (parsed.join() || 'no event'));</script>
</head><body><script>
var cases = %s, ran = {}, left = cases.length;
function ok(c, what) {
  var want = c[3] ? 'ran, load' : 'did not run, error';
  console.log('script-mime: ' + (what === want ? 'PASS ' : 'FAIL ') +
    JSON.stringify(c[0]) + (c[1] ? ' nosniff' : '') +
    (c[2] ? ' module' : '') + (c[4] !== 200 ? ' ' + c[4] : '') + ': ' + what +
    (what === want ? '' : ', want ' + want));
  if (--left === 0) console.log('script-mime: done');
}
cases.forEach(function (c, i) {
  var s = document.createElement('script');
  if (c[2]) s.type = 'module';
  s.src = '/js?i=' + i;
  s.onload = function () { ok(c, (ran[i] ? 'ran' : 'did not run') + ', load'); };
  s.onerror = function () { ok(c, (ran[i] ? 'ran' : 'did not run') + ', error'); };
  document.head.appendChild(s);
});
</script></body></html>''' % repr([list(c) for c in CASES]).replace('True', 'true').replace('False', 'false')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def send(self, body, ctype, nosniff=False, status=200):
        data = body.encode()
        self.send_response(status)
        if ctype:
            self.send_header('Content-Type', ctype)
        if nosniff:
            self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/js':
            i = int(urllib.parse.parse_qs(u.query).get('i', ['0'])[0])
            ctype, nosniff, _module, _runs, status = CASES[i]
            if 'parsed' in u.query:
                self.send('window.parsedRan = true;', ctype, nosniff)
                return
            self.send('window.ran = window.ran || {}; ran[%d] = 1;' % i,
                      ctype, nosniff, status)
            return
        self.send(PAGE, 'text/html; charset=utf-8')


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
