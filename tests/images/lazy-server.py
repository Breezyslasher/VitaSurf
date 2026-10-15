#!/usr/bin/env python3
r"""<img loading=lazy>, as Chrome loads it.

    python3 -I tests/images/lazy-server.py 8011

/ has four eager images at the top and eighty lazy ones under them,
each 150 px tall, so the page runs to some 12,000 px. Each image is
answered after half a second. The server prints each image asked for.

Load it: the eager images and the lazy ones within about 1250 px of
the screen are asked for (lazy0 to lazy8 on a 544 px screen), and the
rest are not; the page's load event does not wait for them. After a
second and a half the page scrolls itself to 6000 px, and the images
near there are asked for (lazy27 to lazy48), as the screen is drawn
there. In the harness, WINDOW REDRAW draws it. Chrome asks for
the same ones, give or take the margin, which it sets at 1250 px on a
fast network and 2500 px on a slow one.
"""
import http.server, socketserver, struct, sys, time, zlib

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8011
T0 = time.time()


def png(w, h):
    raw = b''.join(b'\x00' + b'\x80\x40\x20' * w for _ in range(h))
    def chunk(t, d):
        return (struct.pack('>I', len(d)) + t + d +
                struct.pack('>I', zlib.crc32(t + d) & 0xffffffff))
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


IMG = png(8, 8)
rows = []
for i in range(4):
    rows.append('<img src="/img/eager%d.png" width="600" height="150" '
                'style="display:block">' % i)
for i in range(80):
    rows.append('<img src="/img/lazy%d.png" loading="lazy" width="600" '
                'height="150" style="display:block">' % i)
PAGE = ('''<!DOCTYPE html><meta charset="utf-8"><title>lazy images</title>
<body style="margin:0">''' + '\n'.join(rows) + '''
<script>
addEventListener('load',function(){
 console.log('lazy: load event');
 setTimeout(function(){scrollTo(0,6000);console.log('lazy: scrolled to 6000');},1500);});
</script>''').encode()


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith('/img/'):
            print('%.2f %s' % (time.time() - T0, self.path), flush=True)
            time.sleep(0.5)
            body, ctype = IMG, 'image/png'
        else:
            body, ctype = PAGE, 'text/html'
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


S(('', PORT), H).serve_forever()
