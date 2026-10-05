#!/usr/bin/env python3
"""WebSocket test server for tests/websocket/websocket.html.

Serves the page over HTTP on PORT and a WebSocket endpoint on PORT+1:
text and binary messages are echoed, "big" answers with 300 KB, "close"
makes the server close with 4001 "bye", and the first subprotocol
offered is chosen. Needs the websockets package (pip install websockets).

    python3 tests/websocket/echo-server.py 8810
"""
import asyncio, functools, http.server, os, sys, threading
import websockets

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8810
HERE = os.path.dirname(os.path.abspath(__file__))


async def handler(ws):
    async for m in ws:
        if m == "big":
            await ws.send("x" * 300000)
        elif m == "close":
            await ws.close(4001, "bye")
            return
        else:
            await ws.send(m)


def choose(conn, offered):
    return offered[0] if offered else None


async def main():
    async with websockets.serve(handler, "127.0.0.1", PORT + 1,
                                subprotocols=["chat", "other"],
                                select_subprotocol=choose,
                                max_size=None):
        await asyncio.Future()


H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
H.log_message = lambda *a: None
threading.Thread(target=http.server.ThreadingHTTPServer(
    ("127.0.0.1", PORT), H).serve_forever, daemon=True).start()
asyncio.run(main())
