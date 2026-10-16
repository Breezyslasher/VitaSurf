#!/usr/bin/env python3
"""Fake DNS server for VitaSurf's own DNS client (vita/platform/vita_dns.c),
with a web page whose images name each case.

    python3 tests/dns/dns-server.py

answers DNS on 127.0.0.1:5353 (UDP and TCP) and serves http on :8001.
Run the native harness with VITASURF_DNS_SERVER=127.0.0.1:5353 and load
http://a.test:8001/. The web server should see a.test, alias.test (an
alias with its address), alias2.test (an alias alone, asked again),
big.test (truncated over UDP, asked over TCP) and refused1.test (refused
once, then answered: a refusal is a reason to ask again, as glibc and
Chrome do); the log should say

    dns: nx.test failed after N ms: no such name (rcode 3 from 127.0.0.1)
    dns: v6only.test failed after N ms: no IPv4 address, only IPv6, ...
    dns: refused.test: VitaSurf's own query was refused (rcode 5, last
         from 127.0.0.1) after N ms (3 sent to 1 server), so the system
         resolver was asked
    dns: slow.test: VitaSurf's own query had no answer after 4500 ms
         (3 sent), so the system resolver was asked

the first three at once rather than after a resolver's timeout.
"""
import http.server
import socket, struct, threading
PORT = 5353
def name_bytes(n):
    out = b''
    for l in n.strip('.').split('.'):
        out += bytes([len(l)]) + l.encode()
    return out + b'\0'
def parse_q(d):
    i = 12; labels = []
    while d[i]:
        l = d[i]; labels.append(d[i+1:i+1+l].decode()); i += 1 + l
    qtype, qclass = struct.unpack('>HH', d[i+1:i+5])
    return '.'.join(labels).lower(), qtype, d[12:i+5]
def rr(name, t, rdata):
    return name_bytes(name) + struct.pack('>HHIH', t, 1, 60, len(rdata)) + rdata
LOCAL = socket.inet_aton('127.0.0.1')
asked = {}
def answer(d, tcp):
    qid = d[:2]; name, qtype, q = parse_q(d)
    rcode = 0; ans = []; tc = False
    print('Q %s %d %s' % (name, qtype, 'tcp' if tcp else 'udp'), flush=True)
    if name == 'slow.test':
        return None
    asked[name, qtype] = asked.get((name, qtype), 0) + 1
    if name == 'a.test' and qtype == 1:
        ans = [rr(name, 1, LOCAL)]
    elif name == 'alias.test' and qtype == 1:
        ans = [rr(name, 5, name_bytes('a.test')), rr('a.test', 1, LOCAL)]
    elif name == 'alias2.test' and qtype == 1:
        ans = [rr(name, 5, name_bytes('a.test'))]
    elif name == 'v6only.test':
        if qtype == 28:
            ans = [rr(name, 28, socket.inet_pton(socket.AF_INET6, '2001:db8::1'))]
    elif name == 'nx.test':
        rcode = 3
    elif name == 'refused.test':
        rcode = 5
    elif name == 'refused1.test' and qtype == 1:
        if asked[name, qtype] == 1:
            rcode = 5
        else:
            ans = [rr(name, 1, LOCAL)]
    elif name == 'big.test' and qtype == 1:
        if not tcp:
            tc = True
        else:
            ans = [rr(name, 1, LOCAL)]
    elif name.endswith('.test'):
        rcode = 3
    flags = 0x8180 | rcode | (0x0200 if tc else 0)
    return qid + struct.pack('>HHHHH', flags, 1, len(ans), 0, 0) + q + b''.join(ans)
def udp():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('127.0.0.1', PORT))
    while True:
        d, a = s.recvfrom(2048); r = answer(d, False)
        if r: s.sendto(r, a)
def tcp():
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', PORT)); s.listen(5)
    while True:
        c, a = s.accept(); l = struct.unpack('>H', c.recv(2))[0]; d = b''
        while len(d) < l: d += c.recv(l - len(d))
        r = answer(d, True)
        if r: c.sendall(struct.pack('>H', len(r)) + r)
        c.close()


class Web(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        print('WEB %s %s' % (self.headers.get('Host'), self.path), flush=True)
        if self.path == '/':
            body = b'<!doctype html><p>dns</p>' + b''.join(
                b'<img src="http://%s:8001/x.gif">' % h for h in
                [b'alias.test', b'alias2.test', b'v6only.test', b'nx.test',
                 b'big.test', b'refused.test', b'refused1.test',
                 b'slow.test'])
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


threading.Thread(target=tcp, daemon=True).start()
threading.Thread(target=http.server.ThreadingHTTPServer(
    ('127.0.0.1', 8001), Web).serve_forever, daemon=True).start()
udp()
