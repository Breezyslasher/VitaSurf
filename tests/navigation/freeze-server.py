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

/slow waits four seconds before it answers at all, so nothing commits
until then. Go to /a, then to /slow: the browser began that load, and /a
is frozen from its start, not its commit, so the ticks stop within a
quarter of a second of "slow asked" and none come before "slow answered"
(NetSurf runs a page's script on the one thread the new load needs).
Go to /a-self instead, a page whose own script sends it to /slow after
a second: the ticks go on through the four seconds, since a navigation a
page asked for leaves it running until the commit, as Chrome does.

/a-frame sends itself to /b-late after half a second, and a tenth of a
second later, the navigation under way, adds an iframe whose script the
server keeps three seconds. /b-late answers after a second and commits,
and the HTML standard unloads /a-frame there, its frame's load with it:
the server prints "frame script asked" but never "frame ran", and the
log never compiles /frame.js. NetSurf had loaded and run the frames the
page it was leaving made after the navigation began (BBC's offer
iframe, left for lite.cnn.com, 2 s of jQuery and Angular).
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


A_FRAME = (b'<!DOCTYPE html><title>A frame</title><p>page A with a frame'
           b'<script>setTimeout(function () {'
           b'  location.href = "/b-late";'
           b'  setTimeout(function () {'
           b'    var f = document.createElement("iframe");'
           b'    f.src = "/frame";'
           b'    document.body.appendChild(f);'
           b'  }, 100);'
           b'}, 500);</script>')

FRAME = b'<!DOCTYPE html><title>Frame</title><p>frame<script src="/frame.js"></script><p>after'

FRAME_JS = b"fetch('/tick?frame=ran').catch(function () {});"


A_SELF = A.replace(b'</script>', b'setTimeout(function () { location.href = "/slow"; }, 1000);\n</script>')


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/tick':
            print('%.2f %s %s' % (time.time() - T0,
                                  'frame ran' if 'frame' in self.path else 'tick',
                                  self.path), flush=True)
            self.send_response(204)
            self.send_header('Content-Length', '0')
            self.end_headers()
        elif path == '/a':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(A)))
            self.end_headers()
            self.wfile.write(A)
        elif path == '/a-self':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(A_SELF)))
            self.end_headers()
            self.wfile.write(A_SELF)
        elif path in ('/a-frame', '/frame'):
            body = A_FRAME if path == '/a-frame' else FRAME
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == '/frame.js':
            print('%.2f frame script asked' % (time.time() - T0), flush=True)
            time.sleep(3)
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript')
            self.send_header('Content-Length', str(len(FRAME_JS)))
            self.end_headers()
            try:
                self.wfile.write(FRAME_JS)
            except OSError:
                pass
        elif path == '/slow':
            print('%.2f slow asked' % (time.time() - T0), flush=True)
            time.sleep(4)
            print('%.2f slow answered' % (time.time() - T0), flush=True)
            body = b'<!DOCTYPE html><title>Slow</title><p>slow page'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path in ('/b', '/b-late'):
            print('%.2f b asked' % (time.time() - T0), flush=True)
            if path == '/b-late':
                time.sleep(1)
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
