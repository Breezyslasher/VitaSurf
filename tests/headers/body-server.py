#!/usr/bin/env python3
"""Script request test: the Content-Type a body implies, the headers a page
gives in each form HeadersInit takes, and those it may not set.

    python3 tests/headers/body-server.py 8003

then load http://127.0.0.1:8003/. The server prints each request's
Content-Type, Referer, Origin and the page's own headers. Chrome, and so
VitaSurf:

    /plain /headers /array /request /foreign /lower /xhr
               content-type application/json (x-test 1 where given)
    /nohdr     text/plain;charset=UTF-8 (a string body)
    /blob      application/json (the Blob's type), body {"a":1}
    /usp       application/x-www-form-urlencoded;charset=UTF-8
    /ab        no Content-Type (bytes)
    /twice     x-a "1, 2" (a repeated name is combined)
    /forbidden x-ok 1 alone: the page's Referer, Cookie and Sec-Fetch-Site
               are dropped
    /cross     Origin and Referer http://127.0.0.1:8003/ (to localhost)
    /get       Referer http://127.0.0.1:8003/, no Origin (a GET)

and every POST carries Origin http://127.0.0.1:8003 and Referer
http://127.0.0.1:8003/. The page logs XX lines: Headers(5) and
Headers([['a']]) throw TypeError, and a Map gives [["a","1"],["b","2"]].
"""
import http.server, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8003
PAGE = ("""<!doctype html><p>bodies</p><script>
var body = JSON.stringify({a: 1}), H = {'Content-Type': 'application/json',
  'X-Test': '1'};
function post(path, b, h) {
  return fetch(path, h ? {method: 'POST', body: b, headers: h}
                       : {method: 'POST', body: b});
}
/* another library's Headers: iterable, with methods of its own */
function Foreign(o) { this.map = {}; for (var k in o) this.map[k] = o[k]; }
Foreign.prototype.append = function (k, v) { this.map[k] = v; };
Foreign.prototype[Symbol.iterator] = function () {
  var a = []; for (var k in this.map) a.push([k, this.map[k]]);
  return a[Symbol.iterator]();
};
post('/plain', body, H);
post('/headers', body, new Headers(H));
post('/array', body, [['Content-Type', 'application/json'], ['X-Test', '1']]);
fetch(new Request('/request', {method: 'POST', body: body, headers: H}));
post('/foreign', body, new Foreign(H));
post('/lower', body, {'content-type': 'application/json'});
var x = new XMLHttpRequest(); x.open('POST', '/xhr');
x.setRequestHeader('Content-Type', 'application/json'); x.send(body);
post('/nohdr', body);
post('/blob', new Blob([body], {type: 'application/json'}));
post('/usp', new URLSearchParams('a=1'));
post('/ab', new Uint8Array([65, 66]).buffer);
var y = new XMLHttpRequest(); y.open('POST', '/twice');
y.setRequestHeader('X-A', '1'); y.setRequestHeader('x-a', '2'); y.send('t');
post('/forbidden', 'f', {'Referer': 'http://elsewhere.invalid/',
  'Cookie': 'x=1', 'Sec-Fetch-Site': 'none', 'X-Ok': '1'});
post('http://localhost:%d/cross', 'c');
fetch('/get#fragment');
function threw(f) { try { f(); return 'no throw'; } catch (e) { return e.name; } }
console.log('XX Headers(5) ' + threw(function () { new Headers(5); }));
console.log('XX Headers([[a]]) ' + threw(function () { new Headers([['a']]); }));
console.log('XX map ' + JSON.stringify(Array.from(
  new Headers(new Map([['A', '1'], ['b', '2']])).entries())));
</script>""" % PORT).encode()
SHOW = ("content-type", "referer", "origin", "x-test", "x-a", "x-ok",
        "cookie", "sec-fetch-site")


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def report(self, body=b""):
        got = ["%s=%s" % (k, self.headers.get(k)) for k in SHOW
               if self.headers.get(k) is not None]
        print("%s %s %s body=%r" % (self.command, self.path, " | ".join(got),
                                    body[:40]), flush=True)

    def do_GET(self):
        if self.path not in ("/", "/favicon.ico"):
            self.report()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(PAGE if self.path == "/" else b"ok")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.report(self.rfile.read(n))
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")


http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
