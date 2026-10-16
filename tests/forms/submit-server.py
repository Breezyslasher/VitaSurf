#!/usr/bin/env python3
r"""Form submission test: what a form submitted from script sends, for each
method and enctype, and what FormData sends through fetch.

    python3 tests/forms/submit-server.py 8004

then load http://127.0.0.1:8004/. Each case is a frame whose form is
submitted by script; the server prints each request it gets, method,
path, Content-Type and body, with the multipart boundary shown as
BOUNDARY. VitaSurf must print what Chrome prints, line for line once
sorted:

    urlenc     POST, application/x-www-form-urlencoded,
               t=a+b%26c%3Dd%0D%0Aline&cb=on&sel=1&sel=3&ta=x%0D%0Ay&_charset_=UTF-8&f=
    multipart  POST, multipart/form-data; boundary=----WebKitFormBoundary...,
               the same fields as parts, the file input as an empty file
               part (filename="", application/octet-stream)
    plain      POST, text/plain, one name=value line each
    submitter  requestSubmit(button): the button's formaction, formmethod
               and formenctype, and its name=value among the fields
    formdata   a formdata listener's extra entry is sent
    get        GET /get?t=...#frag replaces the action's query (the
               fragment stays in the browser)
    cancel     requestSubmit() whose submit event is cancelled sends
               nothing; submit() after it sends without the event
    fetch      fetch() with a FormData: multipart, a string, a Blob as
               filename "blob", a File by its name, and set() keeping the
               first entry's place
"""
import http.server, re, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8004

FIELDS = """
<input name=t value="">
<input type=checkbox name=cb checked>
<input type=checkbox name=off>
<select name=sel multiple><option value=1 selected>1<option value=2>2
<option value=3 selected>3</select>
<textarea name=ta></textarea>
<input type=hidden name=_charset_>
<input name=dis value=no disabled>
<fieldset disabled><input name=infs value=no></fieldset>
<input type=file name=f>
<button name=b value=no>b</button>
"""
SET_VALUES = ("document.querySelector('[name=t]').value='a b&c=d\\nline';"
              "document.querySelector('textarea').value='x\\ny';")


def case(name, form_attrs, script):
    return ("<!doctype html><meta charset=utf-8><form %s>%s</form><script>"
            "var f=document.forms[0];%s%s</script>"
            % (form_attrs, FIELDS, SET_VALUES, script)).encode()


CASES = {
    "urlenc": case("urlenc", "method=post action=/r/urlenc", "f.submit();"),
    "multipart": case("multipart",
                      "method=post enctype=multipart/form-data "
                      "action=/r/multipart", "f.submit();"),
    "plain": case("plain", "method=post enctype=text/plain action=/r/plain",
                  "f.submit();"),
    "submitter": case(
        "submitter", "method=get action=/r/wrong",
        "var s=document.createElement('button');s.name='go';s.value='1';"
        "s.setAttribute('formaction','/r/submitter');"
        "s.setAttribute('formmethod','post');"
        "s.setAttribute('formenctype','multipart/form-data');"
        "f.appendChild(s);f.requestSubmit(s);"),
    "formdata": case(
        "formdata", "method=post action=/r/formdata",
        "f.addEventListener('formdata',function(e){"
        "e.formData.append('extra','yes');});f.submit();"),
    "get": case("get", "method=get action='/r/get?old=1#frag'",
                "f.submit();"),
    "cancel": case(
        "cancel", "method=post action=/r/cancel",
        "f.addEventListener('submit',function(e){e.preventDefault();"
        "parent.postMessage('cancel saw submit','*');});"
        "f.requestSubmit();setTimeout(function(){f.submit();},50);"),
    "fetch": ("<!doctype html><meta charset=utf-8><script>"
              "var d=new FormData();d.append('a','1');d.append('b','x\\ny');"
              "d.append('blob',new Blob(['hi'],{type:'text/plain'}));"
              "d.append('file',new File([new Uint8Array([0,255])],'f.bin',"
              "{type:'application/octet-stream'}));"
              "d.append('a','2');d.set('a','3');"
              "fetch('/r/fetch',{method:'POST',body:d});</script>").encode(),
}

PAGE = ("<!doctype html><meta charset=utf-8>" + "".join(
    '<iframe src="/c/%s"></iframe>' % n for n in CASES) +
    "<script>addEventListener('message',function(e){"
    "console.log('XX '+e.data);});</script>").encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def page(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def report(self, body=b""):
        ctype = self.headers.get("Content-Type") or ""
        m = re.search(r"boundary=(\S+)", ctype)
        if m:
            body = body.replace(m.group(1).encode(), b"BOUNDARY")
            ctype = ctype.replace(m.group(1), "BOUNDARY") + (
                " (WebKit form)" if m.group(1).startswith(
                    "----WebKitFormBoundary") and
                len(m.group(1)) == 38 else " (other)")
        print("%s %s [%s] %r" % (self.command, self.path, ctype, body),
              flush=True)

    def do_GET(self):
        if self.path == "/":
            self.page(PAGE)
        elif self.path.startswith("/c/") and self.path[3:] in CASES:
            self.page(CASES[self.path[3:]])
        elif self.path.startswith("/r/"):
            self.report()
            self.page(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.report(self.rfile.read(n))
        self.page(b"ok")


http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
