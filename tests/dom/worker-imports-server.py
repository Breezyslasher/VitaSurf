#!/usr/bin/env python3
"""A worker whose importScripts() calls name slow scripts (VitaSurf).

    python3 -I tests/dom/worker-imports-server.py [port]

Load http://127.0.0.1:PORT/ and read the console. The worker imports
/slow-a.js (answered after 1.5 s, and itself importing /c.js, answered
after 0.5 s), /b.js, and a script whose name it builds, /d.js. A browser
fetches a worker's imports on the worker's thread, and the page's own
timers keep running meanwhile; here the worker shares the page's thread,
so each import's fetch held the browser for its round trip. Every line
must say PASS:

    worker-imports: PASS the worker saw all four scripts
    worker-imports: PASS the page's timers kept running (longest gap N ms)
"""
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>Worker imports</title></head>
<body><pre id="out"></pre><script>
var out = [], last = performance.now(), gap = 0;
function ok(name, good) { out.push((good ? "PASS " : "FAIL ") + name); }
var tick = setInterval(function () {
  var now = performance.now();
  if (now - last > gap) gap = now - last;
  last = now;
}, 20);
var w = new Worker("/w.js");
w.onmessage = function (e) {
  clearInterval(tick);
  var d = e.data;
  ok("the worker saw all four scripts (" + JSON.stringify(d) + ")",
     d.a === 1 && d.b === 2 && d.c === 3 && d.d === 4);
  ok("the page's timers kept running (longest gap " + Math.round(gap) + " ms)", gap < 700);
  document.getElementById("out").textContent = out.join("\\n");
  out.forEach(function (l) { console.log("worker-imports: " + l); });
  console.log("worker-imports: done");
};
w.onerror = function (e) { console.log("worker-imports: FAIL worker error " + e.message); };
</script></body></html>
"""

SCRIPTS = {
    '/w.js': (0, "importScripts('/slow-a.js');\nimportScripts(\"/b.js\");\n"
                 "var n = 'd';\nimportScripts('/' + n + '.js');\n"
                 "postMessage({a: self.A, b: self.B, c: self.C, d: self.D});\n"),
    '/slow-a.js': (1.5, "self.A = 1;\nimportScripts('/c.js');\n"),
    '/b.js': (0, "self.B = 2;\n"),
    '/c.js': (0.5, "self.C = 3;\n"),
    '/d.js': (0, "self.D = 4;\n"),
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def send(self, body, ctype, status=200):
        data = body.encode()
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/':
            self.send(PAGE, 'text/html; charset=utf-8')
        elif path in SCRIPTS:
            delay, body = SCRIPTS[path]
            time.sleep(delay)
            print('worker-imports: served %s' % path, flush=True)
            self.send(body, 'text/javascript')
        else:
            self.send('not found', 'text/plain', 404)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8093
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
