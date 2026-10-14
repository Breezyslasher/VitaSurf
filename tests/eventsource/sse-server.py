#!/usr/bin/env python3
r"""Server-sent events, for EventSource.

    python3 tests/eventsource/sse-server.py 8007

Open http://<host>:8007/ and the page checks EventSource against this
server, printing PASS or FAIL for each case and then "done", as Chrome
does with every case PASS. The server prints each request.

/stream sends its events in pieces, a few tenths of a second apart: a
comment, a retry time, events split across pieces, a character whose
UTF-8 is cut between two pieces, every line ending (CRLF, LF and CR, the
CR at the end of one piece and its LF at the start of the next), a named
event, an id, and then it closes. The page's EventSource opens it again
after the retry time with Last-Event-ID, and the second time it sends one
event saying what it was sent. /wrongtype answers text/plain, which
fails the connection for good; /cross is the same stream on the other
port given as a second argument, with or without the
Access-Control-Allow-Origin it needs.
"""
import http.server, sys, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8007
PAGE = r'''<!DOCTYPE html><meta charset="utf-8"><title>EventSource</title>
<pre id="out"></pre><script>
var out=[],pending=4;
function check(n,ok,x){out.push((ok?'PASS ':'FAIL ')+n+(ok?'':' '+(x||'')));}
function finish(){if(--pending)return;out.push('done');
 document.getElementById('out').textContent=out.join('\n');
 out.forEach(function(l){console.log('eventsource: '+l);});}
check('interface',typeof EventSource==='function'&&EventSource.length===1&&
 EventSource.CLOSED===2&&EventSource.prototype.OPEN===1);
var es=new EventSource('/stream'),got=[],opens=0,errors=0,named=[];
check('connecting at first',es.readyState===0&&es.url===location.origin+'/stream');
es.onopen=function(){opens++;};
es.onerror=function(){errors++;};
es.onmessage=function(e){got.push(e.data+'|'+e.lastEventId);
 if(e.data.indexOf('again:')===0){
  es.close();
  check('opened twice, an error between',opens===2&&errors===1,opens+' '+errors);
  check('events, lines and pieces',got.slice(0,-1).join(',')===
   'one|,two\nlines|,café été|,cr|,crlf|,split|,with id|7',got.join(','));
  check('named event not a message',named.join()==='ping:pong|7');
  check('origin',e.origin===location.origin);
  check('Last-Event-ID sent again',e.data==='again:7',e.data);
  check('closed',es.readyState===2);
  finish();}};
es.addEventListener('ping',function(e){named.push('ping:'+e.data+'|'+e.lastEventId);});
var bad=new EventSource('/wrongtype');
bad.onerror=function(){check('wrong type fails for good',bad.readyState===2);finish();};
bad.onmessage=function(){check('wrong type gives no message',false);};
var xp=location.port==='%(port)d'?%(xport)d:0;
if(xp){
 var x1=new EventSource('http://'+location.hostname+':'+xp+'/cross?allow=1'),
     x2=new EventSource('http://'+location.hostname+':'+xp+'/cross');
 x1.onmessage=function(e){check('cross-origin allowed',e.data==='cross');x1.close();finish();};
 x2.onmessage=function(){check('cross-origin refused gives nothing',false);};
 x2.onerror=function(){check('cross-origin refused fails',x2.readyState===2);x2.close();finish();};
}else{pending-=2;}
setTimeout(function(){if(pending>0){check('finished in time',false,pending+' left');pending=1;finish();}},15000);
</script>'''


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def piece(self, b):
        self.wfile.write(b'%x\r\n' % len(b) + b + b'\r\n')
        self.wfile.flush()
        time.sleep(0.25)

    def do_GET(self):
        print(self.path, self.headers.get('Last-Event-ID'), flush=True)
        if self.path == '/':
            body = (PAGE % {'port': PORT, 'xport': XPORT}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == '/wrongtype':
            body = b'data: no\n\n'
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if not (self.path.startswith('/stream') or self.path.startswith('/cross')):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Transfer-Encoding', 'chunked')
        if self.path.endswith('allow=1'):
            self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        if self.path.startswith('/cross'):
            self.piece(b'data: cross\n\n')
        elif self.headers.get('Last-Event-ID'):
            self.piece(b'data: again:' +
                       self.headers['Last-Event-ID'].encode() + b'\n\n')
            time.sleep(5)
        else:
            cafe = 'café été'.encode()
            for p in [b'\xef\xbb\xbf: a comment\nretry: 500\n',
                      b'data: one\n\n', b'data: two\nda', b'ta: lines\n\n',
                      b'data: ' + cafe[:4], cafe[4:] + b'\n\n',
                      b'data: cr\r\r', b'data: crlf\r\n\r\n',
                      b'data: sp', b'lit\r', b'\n\r\n',
                      b'event: ping\ndata: pong\nid: 7\n\n',
                      b'data: with id\n\n']:
                self.piece(p)
        self.wfile.write(b'0\r\n\r\n')
        self.close_connection = True

    def log_message(self, *a):
        pass


XPORT = int(sys.argv[2]) if len(sys.argv) > 2 else 0
http.server.ThreadingHTTPServer(('0.0.0.0', PORT), H).serve_forever()
