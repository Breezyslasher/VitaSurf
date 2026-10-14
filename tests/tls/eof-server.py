#!/usr/bin/env python3
r"""HTTPS answers that end with the connection, with and without TLS's
close_notify.

    python3 -I tests/tls/eof-server.py 8443

Needs the openssl command, which makes a self-signed certificate for the
run, so a browser asks to accept it first. Each path answers once and
closes the connection:

  /          a page, its body ended by closing the connection with no
             close_notify (HTTP/1.1 with neither Content-Length nor
             chunked, as www.craigslist.org answered); it must load
  /notify    the same, with close_notify first; it must load
  /short     Content-Length 100 and 20 bytes, then the close: a browser
             shows what came
  /cut       chunked, one chunk and no last chunk, then the close: an
             incomplete answer

curl built on mbedTLS took the close without close_notify for a failure
("ssl_read returned: (-0x0000)", code 56) and the page for a fetch
error; Chrome, Firefox and curl on OpenSSL with a body whose length is
the connection's take it for the end of the body. With curl's
command-line tool:

    curl -k https://127.0.0.1:8443/      the page, exit 0
    curl -k https://127.0.0.1:8443/short exit 18, partial file
    curl -k https://127.0.0.1:8443/cut   exit 18, partial file
"""
import os, socket, ssl, subprocess, sys, tempfile, threading

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8443

PAGE = (b'<!DOCTYPE html><meta charset="utf-8"><title>TLS end</title>'
        b'<p id="r">PASS: a body ended by closing the connection loaded'
        b'<script>console.log("tls-eof: PASS")</script>\n')


def answer(conn, path):
    if path in ('/', '/notify'):
        conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/html; '
                     b'charset=utf-8\r\nConnection: close\r\n\r\n' + PAGE)
        if path == '/notify':
            conn = conn.unwrap()
    elif path == '/short':
        conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n'
                     b'Content-Length: 100\r\n\r\n' + b'x' * 20)
    elif path == '/cut':
        conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n'
                     b'Transfer-Encoding: chunked\r\n\r\n14\r\n' +
                     b'y' * 20 + b'\r\n')
    else:
        conn.sendall(b'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n'
                     b'Connection: close\r\n\r\n')
    # Shut the socket under the TLS: no close_notify unless unwrapped.
    conn.shutdown(socket.SHUT_RDWR)
    conn.close()


def serve(conn):
    try:
        data = b''
        while b'\r\n\r\n' not in data:
            got = conn.recv(4096)
            if not got:
                return
            data += got
        line = data.split(b'\r\n', 1)[0].decode('latin-1')
        print(line, flush=True)
        parts = line.split(' ')
        answer(conn, parts[1].split('?')[0] if len(parts) > 1 else '/')
    except (OSError, ssl.SSLError) as e:
        print('error:', e, flush=True)


def main():
    tmp = tempfile.mkdtemp()
    key, crt = os.path.join(tmp, 'key.pem'), os.path.join(tmp, 'crt.pem')
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048',
                    '-nodes', '-keyout', key, '-out', crt, '-days', '2',
                    '-subj', '/CN=localhost'], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('', PORT))
    s.listen(16)
    print('listening on', PORT, flush=True)
    while True:
        raw, _ = s.accept()
        try:
            conn = ctx.wrap_socket(raw, server_side=True)
        except (OSError, ssl.SSLError) as e:
            print('handshake:', e, flush=True)
            raw.close()
            continue
        threading.Thread(target=serve, args=(conn,), daemon=True).start()


if __name__ == '__main__':
    main()
