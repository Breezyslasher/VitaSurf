#!/usr/bin/env python3
"""Cookie test server: what a response and a script may set, and who sees it.

Needs two names for this machine, in /etc/hosts:

    127.0.0.1 www.vstest.example api.vstest.example

then, as root for port 80 (a path cookie is filed under the port it came
from, so a test on another port does not reach /other):

    python3 tests/cookies/cookie-server.py 80

and load http://www.vstest.example/. Chrome logs:

    XX read a=1; d=1
    XX after writes a=1; d=1; j=1
    XX sent to / a=1; d=1; h=1; j=1
    XX sent to /other a=1; d=1; h=1; j=1; p=1

and the server prints that api.vstest.example was sent d=1 alone.
h is HttpOnly, so script neither reads nor replaces it, and cannot set
s; d's Domain has no leading dot and still covers api; p's path is not
the page's, and is kept for the requests under it. /deny answers 403,
which the log notes with the names of the cookies the request sent.
"""
import http.server, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 80
API = "http://api.vstest.example" + ("" if PORT == 80 else ":%d" % PORT)

PAGE = ("""<!doctype html><html><body><p>cookies</p>
<img src="%s/img.gif">
<script>
function sorted(s) { return s.split('; ').sort().join('; '); }
console.log('XX read ' + sorted(document.cookie));
document.cookie = 'h=2';
document.cookie = 's=1; HttpOnly';
document.cookie = 'j=1';
console.log('XX after writes ' + sorted(document.cookie));
fetch('/echo').then(r => r.text()).then(t => {
  console.log('XX sent to / ' + sorted(t));
  return fetch('/deny').then(() => fetch('/other/echo'));
}).then(r => r.text()).then(t => console.log('XX sent to /other ' + sorted(t)));
</script></body></html>""" % API).encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        cookie = self.headers.get("Cookie", "")
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Set-Cookie", "a=1; Path=/")
            self.send_header("Set-Cookie", "h=1; Path=/; HttpOnly")
            self.send_header("Set-Cookie", "d=1; Domain=vstest.example; Path=/")
            self.send_header("Set-Cookie", "p=1; Path=/other")
            self.end_headers()
            self.wfile.write(PAGE)
        elif self.path == "/deny":
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b"no")
        elif self.path.endswith("echo"):
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(cookie.encode())
        else:
            print("%s %s sent [%s]" % (self.headers.get("Host", ""),
                                       self.path, cookie), flush=True)
            self.send_response(404)
            self.end_headers()


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
