#!/usr/bin/env bash
# Run tests/pending-sheet in the monkey harness: move the focus while a
# stylesheet is still fetching, which asserted in build 489.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=${PORT:-8811}
python3 "$ROOT/tests/pending-sheet/server.py" "$PORT" &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1
cd "$ROOT/deps/netsurf"
{ echo WINDOW NEW
  echo "WINDOW GO 0 http://127.0.0.1:$PORT/focus.html"
  sleep 9
  echo QUIT
} | timeout 30 ./nsmonkey --enable_javascript=1 2>&1 |
        grep -E "console:|SIGSEGV|Assertion"
