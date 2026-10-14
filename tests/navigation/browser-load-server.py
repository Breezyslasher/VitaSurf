#!/usr/bin/env python3
r"""A page's script navigating while the browser loads another.

    python3 tests/navigation/browser-load-server.py 8006

/loop sends itself to /loop?<time> from a timer 2.5 s after it loads.
Open /loop, then within those 2.5 s type /slow, which the server holds
for 4 s. The timer fires while /slow is still loading, and as Chrome has
it, a page's script without the user's gesture does not cancel a load
the browser started: /slow arrives, the log says "navigate: ... ignored",
and no /loop?<time> reaches the server.

Then open /loop and within 2.5 s type /typed: that page sends itself to
/dest from an inline script as it parses, while it is still the page
being loaded, and /dest arrives, since the page asking is the one the
browser is loading.

The server prints each request with the time since it started.
"""
import http.server, sys, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8006
T0 = time.time()


def page(title, script, rest=b''):
    return (b'<!DOCTYPE html><title>' + title + b'</title><script>' +
            script + b'</script>' + rest)


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        print('%.1f GET %s' % (time.time() - T0, self.path), flush=True)
        if self.path.startswith('/slow'):
            time.sleep(4)
            body = page(b'slow', b'console.log("navtest: arrived at slow")')
        elif self.path.startswith('/typed'):
            body = page(b'typed', b'console.log("navtest: typed sends '
                        b'itself on");location.href="/dest";',
                        b'<p>' + b'x' * 200000)
        elif self.path.startswith('/dest'):
            body = page(b'dest', b'console.log("navtest: arrived at dest")')
        elif self.path.startswith('/loop'):
            body = page(b'loop', b'console.log("navtest: at ' +
                        self.path.encode() + b'");setTimeout(function(){'
                        b'location.href="/loop?"+Date.now();},2500);')
        else:
            self.send_error(404)
            return
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            print('the browser went away', flush=True)

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(('0.0.0.0', PORT), H).serve_forever()
