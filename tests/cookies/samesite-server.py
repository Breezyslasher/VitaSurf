#!/usr/bin/env python3
"""SameSite test server: localhost and 127.0.0.1 are two sites, and both
may hold Secure cookies over http, as browsers trust this machine.

    python3 tests/cookies/samesite-server.py 80

then load http://127.0.0.1/setb. It sets four cookies on 127.0.0.1
(SameSite None, Lax, Strict and none given) and goes on to
http://localhost/page, which loads an image and a frame from 127.0.0.1
and then sends the window to http://127.0.0.1/top. The frame, a
cross-site frame, tries to set three cookies of its own. Chrome logs:

    XX frame doc bnone=1; fnone=1
    XX frame fetch bnone=1; fnone=1
    XX top doc bdef=1; blax=1; bnone=1; bstrict=1; fnone=1
    XX top fetch bdef=1; blax=1; bnone=1; bstrict=1; fnone=1

and the server prints what each request carried:

    SRV /img bnone=1
    SRV /frame bnone=1
    SRV /top bdef=1; blax=1; bnone=1; fnone=1

A cross-site image, frame and the frame's script see only SameSite=None
cookies; the frame may set its SameSite=None cookie but not its Lax or
unmarked ones; the cross-site navigation a script started carries Lax
and unmarked cookies but not Strict; and the top-level page, the site
itself, has them all. VitaSurf's log names each cookie refused.
"""
import http.server, socket, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 80
SORT = "function s(c) { return c.split('; ').filter(Boolean).sort().join('; '); }"


def page(body):
    return ("<!doctype html><html><body>%s</body></html>" % body).encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, body, cookies=()):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        for c in cookies:
            self.send_header("Set-Cookie", c)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path
        got = "; ".join(sorted(
            c for c in self.headers.get("Cookie", "").split("; ") if c))
        if path in ("/img", "/frame", "/top"):
            print("SRV %s %s" % (path, got), flush=True)
        if path == "/setb":
            self.send(page("<script>setTimeout(function () {"
                           "location.href = 'http://localhost:%d/page'; },"
                           " 300);</script>" % PORT),
                      ["bnone=1; SameSite=None; Secure; Path=/",
                       "blax=1; SameSite=Lax; Path=/",
                       "bstrict=1; SameSite=Strict; Path=/",
                       "bdef=1; Path=/"])
        elif path == "/page":
            self.send(page("<img src='http://127.0.0.1:%d/img'>"
                           "<iframe src='http://127.0.0.1:%d/frame'></iframe>"
                           "<script>setTimeout(function () {"
                           "location.href = 'http://127.0.0.1:%d/top'; },"
                           " 2500);</script>" % (PORT, PORT, PORT)))
        elif path == "/frame":
            self.send(page("<script>%s console.log('XX frame doc ' +"
                           " s(document.cookie)); fetch('/echo').then(r =>"
                           " r.text()).then(t => console.log('XX frame fetch '"
                           " + s(t)));</script>" % SORT),
                      ["flax=1; SameSite=Lax; Path=/",
                       "fnone=1; SameSite=None; Secure; Path=/",
                       "fdef=1; Path=/"])
        elif path == "/top":
            self.send(page("<script>%s console.log('XX top doc ' +"
                           " s(document.cookie)); fetch('/echo').then(r =>"
                           " r.text()).then(t => console.log('XX top fetch '"
                           " + s(t)));</script>" % SORT))
        elif path == "/echo":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(got.encode())
        else:
            self.send_response(404)
            self.end_headers()


class Server6(http.server.ThreadingHTTPServer):
    """localhost may be ::1: take both where the machine has IPv6"""
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


try:
    server = Server6(("::", PORT), Handler)
except OSError:
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
server.serve_forever()
