#!/usr/bin/env python3
r"""What a closed page left is collected once the next page has loaded.

    python3 tests/navigation/collect-after-load-server.py 8007

/big makes 150,000 objects that point at themselves and keeps them.
Open it, then open /next, whose image the server holds for 4 s. The log
says "page closed" for /big as /next commits, and "collected what 1
closed pages left ... N ms after they closed" only after /next has
finished loading, N being how long /next took, where the collection had
run at once and held the main loop as /next's fetches began.

/full fills the runtime to its memory limit, as a page that runs out of
memory does. Open it, then /next: there must be no crash. A context
QuickJS could not make for want of memory had been freed while still on
its collector's list, and the next collection read it (patch 0490).

The server prints each request with the time since it started.
"""
import http.server, sys, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8007
T0 = time.time()

PAGES = {
    '/big': b"<!DOCTYPE html><title>big</title><script>var k=[];"
            b"for(var i=0;i<150000;i++){var o={i:i,s:'n'+i};o.me=o;"
            b"k.push(o);}window.K=k;console.log('collect: big made')"
            b"</script><p>big</p>",
    '/full': b"<!DOCTYPE html><title>full</title><script>var keep=[];"
             b"for(var i=0;i<3000000;i++){var o={id:i,name:'n'+i,"
             b"kids:[],f:function(){return i;}};o.self=o;keep.push(o);}"
             b"</script><p>full</p>",
    '/next': b"<!DOCTYPE html><title>next</title><p>next</p><script>"
             b"console.log('collect: next ran')</script>"
             b"<img src='/slow.png'>",
}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        print('%7.2f %s' % (time.time() - T0, self.path), flush=True)
        if self.path.startswith('/slow.png'):
            time.sleep(4)
            self.send_response(404)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        b = PAGES.get(self.path.split('?')[0])
        if b is None:
            self.send_response(404)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)


http.server.ThreadingHTTPServer(('', PORT), H).serve_forever()
