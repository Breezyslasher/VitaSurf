#!/usr/bin/env python3
"""Cookie parsing rules browsers apply, against tests/cookies/cookie-server.py's
setup (www.vstest.example mapped to 127.0.0.1 in /etc/hosts):

    python3 tests/cookies/cookie-rules-server.py 80

then load http://www.vstest.example/. Over http, Chrome logs:

    XX doc comma=lang=en,theme=dark; eq=a==; js=a=b,c=d; ma1=1; ma2=1; sslax=1
    XX sent comma=lang=en,theme=dark; eq=a==; js=a=b,c=d; ma1=1; ma2=1; sslax=1

A comma does not end a cookie; Max-Age wins over Expires in either
order; and a Secure cookie from http, __Host- and __Secure- names
without Secure, SameSite=None without Secure, and a name and value over
4096 bytes are refused. VitaSurf's log says why for each ("cookie:
refused, ...").
"""
import http.server, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 80
BIG = 'x' * 4100
PAGE = b"""<!doctype html><html><body><p>c</p><script>
function names(s) { return s.split('; ').map(x => x.length > 40 ? x.slice(0, 12) + '...(' + x.length + ')' : x).sort().join('; '); }
document.cookie = 'js=a=b,c=d';
console.log('XX doc ' + names(document.cookie));
fetch('/echo').then(r => r.text()).then(t => console.log('XX sent ' + names(t)));
</script></body></html>"""
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            for c in ['comma=lang=en,theme=dark; Path=/',
                      'sec=1; Secure; Path=/',
                      '__Host-h=1; Path=/',
                      '__Secure-s=1; Path=/',
                      'ssn=1; SameSite=None; Path=/',
                      'sslax=1; SameSite=Lax; Path=/',
                      'ma1=1; Max-Age=100; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
                      'ma2=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=100; Path=/',
                      'big=' + BIG + '; Path=/',
                      'eq=a==; Path=/']:
                self.send_header('Set-Cookie', c)
            self.end_headers(); self.wfile.write(PAGE)
        elif self.path == '/echo':
            self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.end_headers()
            self.wfile.write(self.headers.get('Cookie', '').encode())
        else:
            self.send_response(404); self.end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
