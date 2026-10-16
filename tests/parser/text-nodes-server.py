#!/usr/bin/env python3
r"""Text the parser makes is one Text node per run, as the HTML standard has it.

    python3 -I tests/parser/text-nodes-server.py 8013

/ logs a line per case, 'text-nodes: PASS ...' or 'text-nodes: FAIL
...'; every line must say PASS, as Chrome's do. The page is sent in
pieces of 2 KB a few milliseconds apart, so its 300 KB paragraph and
its 200 KB inline JSON reach the parser over many chunks.

hubbub gave each run of characters a node of its own, cut at every '<'
and '&' and at each chunk, so <p>a &amp; b</p> was three Text nodes
and its firstChild.data "a ", and reading the text of an inline script
in thousands of pieces copied it thousands of times.
"""
import http.server, json, socketserver, sys, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8013

BIG_P = ''.join('word%d &amp; more &lt;%d&gt; ' % (i, i) for i in range(12000))
BIG_P_TEXT_LEN = len(BIG_P.replace('&amp;', '&').replace('&lt;', '<')
                     .replace('&gt;', '>'))
DATA = {'items': [{'id': i, 'title': 'Item <%d> & "q"' % i}
                  for i in range(4000)]}

PAGE = ('''<!DOCTYPE html><html><head><meta charset="utf-8">
<title>a &amp; b &lt; c</title>
<style id="st">#styled { color: rgb(0, 128, 0) } /* a < b & c */
#styled2 { color: rgb(0, 0, 255) }</style>
</head><body>
<p id="p1">a &amp; b &lt; c</p>
<p id="p2">x<b>y</b>z &amp; w</p>
<script id="s1">var inScript = "<b>" + "</i" + "x"; // a < b && c
</script>
<textarea id="ta">t &amp; u &lt; v</textarea>
<p id="big">''' + BIG_P + '''</p>
<script type="application/json" id="json">''' + json.dumps(DATA) + '''</script>
<table id="tb">x<tr><td>1</td></tr></table>
<p id="styled">s</p><p id="styled2">s</p>
<pre id="out"></pre>
<script>
var out = [];
function ok(name, got, want) { out.push((got === want ? 'PASS ' : 'FAIL ') + name + (got === want ? '' : ': ' + JSON.stringify(got) + ', want ' + JSON.stringify(want))); }
var p1 = document.getElementById('p1');
ok('a paragraph with entities is one Text node', p1.childNodes.length, 1);
ok('and its first child holds all of it', p1.firstChild.data, 'a & b < c');
var p2 = document.getElementById('p2');
ok('text around an element is a node on each side', p2.childNodes.length, 3);
ok('the text after it is one node', p2.lastChild.data, 'z & w');
var s1 = document.getElementById('s1');
ok('an inline script is one Text node', s1.childNodes.length, 1);
ok('its text reads whole', s1.textContent.indexOf('a < b && c') > 0, true);
ok('a textarea keeps its text', document.getElementById('ta').value, 't & u < v');
var big = document.getElementById('big');
ok('a paragraph sent in many pieces is one Text node', big.childNodes.length, 1);
ok('and all of it', big.firstChild.data.length, ''' + str(BIG_P_TEXT_LEN) + ''');
var js = document.getElementById('json');
ok('inline JSON is one Text node', js.childNodes.length, 1);
ok('and parses from its first child', JSON.parse(js.firstChild.data).items.length, 4000);
ok('the title', document.title, 'a & b < c');
ok('text moved out of a table joins the text before it',
   document.getElementById('tb').previousSibling.data, '\\nx');
var d = document.createElement('div');
d.innerHTML = 'a &lt; b<i>c</i>d &amp; e';
ok('innerHTML makes one node a run', d.childNodes.length, 3);
ok('the first run whole', d.firstChild.data, 'a < b');
ok('a style sheet split by < and & still applies',
   getComputedStyle(document.getElementById('styled2')).color, 'rgb(0, 0, 255)');
ok('a style element is one Text node', document.getElementById('st').childNodes.length, 1);
document.getElementById('out').textContent = out.join('\\n');
out.forEach(function (l) { console.log('text-nodes: ' + l); });
console.log('text-nodes: done');
</script>
</body></html>''').encode()


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(PAGE)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        for i in range(0, len(PAGE), 2048):
            self.wfile.write(PAGE[i:i + 2048])
            self.wfile.flush()
            time.sleep(0.002)


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


S(('', PORT), H).serve_forever()
