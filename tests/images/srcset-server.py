#!/usr/bin/env python3
r"""srcset, sizes and <picture>, as the HTML standard selects an image.

    python3 -I tests/images/srcset-server.py 8012

/ has an image for each case. Its script logs a line per case,
'srcset: PASS ...' or 'srcset: FAIL ...', from each image's
currentSrc, and the server prints each image asked for. The answers
hold for any viewport from 700 to 1000 px wide at a device pixel ratio
of 1, so the Vita's 960 and the harness's 800 agree with Chrome.

Asked for, and nothing else: a1, b-src, c1200, d400, e500, f250,
g-medium, h-png, i-src, j1, k-good, l-src, then l2 once script changes
its srcset, m-a, then m-b once script changes its source, n400, o800,
p1x. Never any of a2, b2, c-src, c400, c2400, d-src, d1200, e300,
e1000, f150, f600, g-large, g-small, h-bad, h-src, i-never, k-bad,
m-src, n250, n800, o-noh, p2x.

NetSurf fetched src alone: c-src, d-src, e1000 and the rest, nothing
for j, and g-small for the picture.
"""
import http.server, socketserver, struct, sys, time, zlib

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8012
T0 = time.time()


def png(w, h):
    raw = b''.join(b'\x00' + b'\x30\x60\x90' * w for _ in range(h))
    def chunk(t, d):
        return (struct.pack('>I', len(d)) + t + d +
                struct.pack('>I', zlib.crc32(t + d) & 0xffffffff))
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


IMG = png(4, 4)

CASES = [
    # name, markup, the image it should show
    ('density descriptors', '<img id="a" srcset="/i/a1.png 1x, /i/a2.png 2x">',
     'a1'),
    ('src is the 1x of a set without one',
     '<img id="b" src="/i/b-src.png" srcset="/i/b2.png 2x">', 'b-src'),
    ('widths against the default size, 100vw',
     '<img id="c" src="/i/c-src.png" srcset="/i/c400.png 400w, '
     '/i/c1200.png 1200w, /i/c2400.png 2400w">', 'c1200'),
    ('a sizes media condition that fails, then a plain size',
     '<img id="d" src="/i/d-src.png" sizes="(max-width: 600px) 100vw, '
     '300px" srcset="/i/d400.png 400w, /i/d1200.png 1200w">', 'd400'),
    ('a calc() size',
     '<img id="e" sizes="calc(50vw - 20px)" srcset="/i/e300.png 300w, '
     '/i/e500.png 500w, /i/e1000.png 1000w">', 'e500'),
    ('the first matching condition wins',
     '<img id="f" sizes="(min-width: 2000px) 1000px, (orientation: '
     'landscape) 200px, 50vw" srcset="/i/f150.png 150w, /i/f250.png 250w, '
     '/i/f600.png 600w">', 'f250'),
    ('a picture source by media',
     '<picture><source media="(min-width: 1200px)" '
     'srcset="/i/g-large.png"><source media="(min-width: 600px)" '
     'srcset="/i/g-medium.png"><img id="g" src="/i/g-small.png"></picture>',
     'g-medium'),
    ('a picture source by type',
     '<picture><source type="image/x-not-an-image" srcset="/i/h-bad.png">'
     '<source type="image/png" srcset="/i/h-png.png"><img id="h" '
     'src="/i/h-src.png"></picture>', 'h-png'),
    ('a picture whose sources do not fit falls to its img',
     '<picture><source media="(max-width: 100px)" srcset="/i/i-never.png">'
     '<img id="i" src="/i/i-src.png"></picture>', 'i-src'),
    ('srcset without src', '<img id="j" srcset="/i/j1.png">', 'j1'),
    ('a candidate with a bad descriptor is dropped',
     '<img id="k" srcset="/i/k-bad.png 2q, /i/k-good.png 1x">', 'k-good'),
    ('script gives an img a srcset', '<img id="l" src="/i/l-src.png">',
     'l2'),
    ('script changes a picture source',
     '<picture><source srcset="/i/m-a.png"><img id="m" '
     'src="/i/m-src.png"></picture>', 'm-b'),
    ('a min() size',
     '<img id="n" sizes="min(300px, 50vw)" srcset="/i/n250.png 250w, '
     '/i/n400.png 400w, /i/n800.png 800w">', 'n400'),
    ('a width with a height, and a height alone dropped',
     '<img id="o" sizes="700px" srcset="/i/o-noh.png 100h, '
     '/i/o800.png 800w 600h">', 'o800'),
    ('commas inside a URL and none between candidates',
     '<img id="p" srcset="/i/p1x.png?a,b 1x,/i/p2x.png 2x">', 'p1x'),
]

rows = []
for i, (name, markup, want) in enumerate(CASES):
    rows.append('<div data-case="%d" data-want="%s">%s</div>' %
                (i, want, markup))

PAGE = ('''<!DOCTYPE html><meta charset="utf-8"><title>srcset</title>
<style>img{width:40px;height:20px;display:inline-block}</style>
<body>''' + '\n'.join(rows) + '''
<pre id="out"></pre>
<script>
var names = ''' + repr([c[0] for c in CASES]).replace("'", '"') + ''';
var out = [];
function shown(img) {
 var u = img.currentSrc || '';
 var m = /\\/i\\/([^/?]+?)\\.png/.exec(u);
 return m ? m[1] : u;
}
function check() {
 var divs = document.querySelectorAll('[data-case]');
 for (var i = 0; i < divs.length; i++) {
  var img = divs[i].querySelector('img');
  var want = divs[i].getAttribute('data-want');
  var got = shown(img);
  out.push((got === want ? 'PASS ' : 'FAIL ') + names[i] +
           (got === want ? '' : ': ' + got + ', want ' + want));
 }
 document.getElementById('out').textContent = out.join('\\n');
 out.forEach(function (l) { console.log('srcset: ' + l); });
 console.log('srcset: done');
}
addEventListener('load', function () {
 document.getElementById('l').srcset = '/i/l2.png 1x';
 document.querySelector('[data-case="12"] source').srcset = '/i/m-b.png';
 setTimeout(check, 500);
});
</script>''').encode()


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith('/i/'):
            print('%.2f %s' % (time.time() - T0, self.path), flush=True)
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
