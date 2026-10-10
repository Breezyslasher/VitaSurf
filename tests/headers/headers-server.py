#!/usr/bin/env python3
"""Request headers test: what each kind of request carries.

    python3 tests/headers/headers-server.py 8002

then load http://127.0.0.1:8002/ (typed, so the user's own navigation).
The page loads a same-origin image, style sheet and script, an image and
a frame from localhost (another site), fetches /api, and a second later
a timer sends the window to /next, which fetches /deny (a 403 carrying
cf-mitigated: challenge). The server prints, for each path, the Accept,
Accept-Language, Referer and Fetch Metadata headers it got: the Referer
is the page's URL to the same origin and its origin alone to another, as
the default referrer policy has it. Chrome's Sec-Fetch-*
values are listed by each case below; its Accept values are its own,
VitaSurf's those of the Fetch standard, as Firefox's are.

    /          site none, mode navigate, dest document, user ?1, UIR 1
    /i.png     same-origin, no-cors, image
    /s.css     same-origin, no-cors, style
    /j.js      same-origin, no-cors, script
    /x.png     cross-site, no-cors, image       (from localhost)
    /frame     cross-site, navigate, iframe     (from localhost)
    /api       same-origin, cors, empty
    /next      same-origin, navigate, document, no user (a timer)
"""
import http.server, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8002
WANT = ("accept", "accept-language", "referer", "sec-fetch-site",
        "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user",
        "upgrade-insecure-requests")
PAGE = ("""<!doctype html><html><head><link rel=stylesheet href=/s.css>
<script src=/j.js></script></head><body><img src=/i.png>
<img src="http://localhost:%d/x.png">
<iframe src="http://localhost:%d/frame"></iframe>
<script>fetch('/api'); setTimeout(function () { location.href = '/next'; },
1000);</script></body></html>""" % (PORT, PORT)).encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        path = self.path
        got = ["%s=%s" % (k, self.headers.get(k)) for k in WANT
               if self.headers.get(k) is not None]
        if path != "/favicon.ico":
            print("HDR %s %s" % (path, " | ".join(got)), flush=True)
        if path == "/":
            body, ctype = PAGE, "text/html"
        elif path == "/next":
            body, ctype = b"<!doctype html><script>fetch('/deny')</script>", "text/html"
        elif path == "/deny":
            self.send_response(403)
            self.send_header("cf-mitigated", "challenge")
            self.end_headers()
            self.wfile.write(b"no")
            return
        elif path.endswith(".css"):
            body, ctype = b"p{}", "text/css"
        elif path.endswith(".js"):
            body, ctype = b"1;", "text/javascript"
        else:
            body, ctype = b"<!doctype html><p>x", "text/html"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)


http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
