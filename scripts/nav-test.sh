#!/usr/bin/env bash
# Serve tests/nav over HTTP and check what a page is told about itself.
#
# The browser window commits a new address when a load finishes, which
# is after the page's own scripts have run, so these have to be fetched
# over the network from a page that was somewhere else before.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8099}"
NS="$ROOT/deps/netsurf/nsmonkey"

if [ ! -x "$NS" ]; then
    echo "error: no nsmonkey at $NS; build the harness first" >&2
    exit 1
fi
if command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
    echo "error: port $PORT is already in use" >&2
    exit 1
fi

( cd "$ROOT/tests/nav" && python3 -m http.server "$PORT" >/dev/null 2>&1 ) &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
sleep 1

status=0
for page in "$ROOT"/tests/nav/*.html; do
    name="$(basename "$page")"
    out=$( { printf 'WINDOW NEW\nWINDOW GO 0 file://%s/resources/vitasurf.html\n' "$ROOT"
             sleep 4
             printf 'WINDOW GO 0 http://127.0.0.1:%s/%s\n' "$PORT" "$name"
             sleep 6; } | ( cd "$ROOT/deps/netsurf" && ./nsmonkey --enable_javascript=1 ) 2>&1 |
           grep -o 'XX .*' || true )
    bad=$(printf '%s\n' "$out" | grep -c ': false' || true)
    if [ -z "$out" ]; then
        echo "== $name: no facts -- the probe did not run"
        status=1
    elif [ "$bad" -gt 0 ]; then
        echo "== $name: $bad of $(printf '%s\n' "$out" | wc -l) facts false"
        printf '%s\n' "$out" | sed 's/^/  /'
        status=1
    else
        echo "== $name: all $(printf '%s\n' "$out" | wc -l) facts hold"
    fi
done
exit $status
