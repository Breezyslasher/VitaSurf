#!/usr/bin/env python3
r"""Forms the user submits: a tap on a button, and Enter in a field.

    python3 tests/forms/tap-server.py 8005

Each case is its own page, /c/<case>, with its button over the top left
corner (0,0 to 200,60) and a text field at y 100 to 130. Tap at (50,30),
or tap the field at (50,115) and press Enter. The server prints what it
gets, as tests/forms/submit-server.py does. Chrome sends:

    multipart   tap: multipart, q=v then go=1 (the button that was tapped)
    formdata    tap: urlencoded q=v&extra=yes (a formdata listener's entry)
    cancelled   tap: no submission, since the click was cancelled; the page
                then fetches /r/cancelled-done
    image       tap: img.x=50&img.y=30, where the image button was hit
    submitevt   tap: the page's submit listener sees its submitter, and
                fetches /r/submitevt-saw-go before the form goes
    enter       Enter: the default button is clicked, q=v&go=1
    enter-one   Enter, one field and no button: q=v, no submitter
    enter-two   Enter, two fields and no button: nothing is submitted
"""
import http.server, re, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8005

STYLE = ("<style>body{margin:0}#b{position:absolute;left:0;top:0;"
         "width:200px;height:60px;margin:0;padding:0;border:0}"
         "#q{position:absolute;left:0;top:100px;width:200px;height:30px;"
         "margin:0;padding:0;border:0}"
         "#q2{position:absolute;left:0;top:200px}</style>")
BUTTON = "<button id=b name=go value=1>go</button>"
FIELD = "<input id=q name=q value=v>"
PIXEL = ("data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAAB"
         "AAEAAAICRAEAOw==")

CASES = {
    "multipart": ("method=post enctype=multipart/form-data action=/r/multipart",
                  FIELD + BUTTON, ""),
    "formdata": ("method=post action=/r/formdata", FIELD + BUTTON,
                 "f.addEventListener('formdata',function(e){"
                 "e.formData.append('extra','yes');});"),
    "cancelled": ("method=post action=/r/cancelled", FIELD + BUTTON,
                  "document.getElementById('b').addEventListener('click',"
                  "function(e){e.preventDefault();setTimeout(function(){"
                  "fetch('/r/cancelled-done');},100);});"),
    "image": ("method=post action=/r/image", FIELD +
              '<input type=image id=b name=img src="%s">' % PIXEL, ""),
    "submitevt": ("method=post action=/r/submitevt", FIELD + BUTTON,
                  "f.addEventListener('submit',function(e){"
                  "fetch('/r/submitevt-saw-'+(e.submitter?e.submitter.name:"
                  "'none'));});"),
    "enter": ("method=post action=/r/enter",
              FIELD + "<input id=q2 name=q2 value=w>" + BUTTON, ""),
    "enter-one": ("method=post action=/r/enter-one", FIELD, ""),
    "enter-two": ("method=post action=/r/enter-two",
                  FIELD + "<input id=q2 name=q2 value=w>", ""),
}


def page(name):
    attrs, inner, script = CASES[name]
    return ("<!doctype html><meta charset=utf-8>%s<form id=f %s>%s</form>"
            "<script>var f=document.getElementById('f');%s</script>"
            % (STYLE, attrs, inner, script)).encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_page(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def report(self, body=b""):
        ctype = self.headers.get("Content-Type") or ""
        m = re.search(r"boundary=(\S+)", ctype)
        if m:
            body = body.replace(m.group(1).encode(), b"BOUNDARY")
            ctype = ctype.replace(m.group(1), "BOUNDARY")
        print("%s %s [%s] %r" % (self.command, self.path, ctype, body),
              flush=True)

    def do_GET(self):
        if self.path.startswith("/c/") and self.path[3:] in CASES:
            self.send_page(page(self.path[3:]))
        elif self.path.startswith("/r/"):
            self.report()
            self.send_page(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.report(self.rfile.read(n))
        self.send_page(b"ok")


http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
