#!/usr/bin/env python3
r"""The page being left is frozen once the next one commits.

    python3 -I tests/navigation/freeze-server.py 8009

/a pings /tick every 100 ms from a timer, and keeps a WebSocket-free
fetch going; /b answers its headers and the start of its body at once,
so the navigation commits, and holds the rest for six seconds. The
server prints each tick with the time.

Go to /a, then to /b: the ticks stop within a quarter of a second of
/b's start and do not come back (/a is closed when /b is ready), and
the log says "waits while the page replacing it loads" and then
"closed after N ms frozen". Go to /a, then to /b, and stop the load
within the six seconds: the ticks come back, and the log says "carries
on after N ms frozen". Chrome unloads /a once /b commits, so its ticks
stop the same way; it shows /b's start where NetSurf keeps /a on the
screen until /b is ready.
"""
import http.server, socketserver, sys, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8009
T0 = time.time()

A = b'''<!DOCTYPE html><title>A</title><p>page A
<script>
var n = 0;
setInterval(function () {
  n++;
  fetch('/tick?n=' + n).catch(function () {});
}, 100);
</script>'''


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/tick':
            print('%.2f tick %s' % (time.time() - T0, self.path), flush=True)
            self.send_response(204)
            self.send_header('Content-Length', '0')
            self.end_headers()
        elif path == '/a':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(A)))
            self.end_headers()
            self.wfile.write(A)
        elif path == '/b':
            print('%.2f b asked' % (time.time() - T0), flush=True)
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(b'<!DOCTYPE html><title>B</title><p>page B '
                             b'<script>var b = 1;</script>' + b' ' * 2048)
            self.wfile.flush()
            time.sleep(6)
            self.wfile.write(b'<p>the rest of B')
            self.wfile.flush()
            print('%.2f b done' % (time.time() - T0), flush=True)
            self.close_connection = True
        else:
            self.send_response(404)
            self.send_header('Content-Length', '0')
            self.end_headers()


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


S(('', PORT), H).serve_forever()
