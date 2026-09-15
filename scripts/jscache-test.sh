#!/usr/bin/env bash
#
# Exercise the compiled script cache (bc_load/bc_store in vita/js/qjs.c)
# in the native harness. The cache hands QuickJS bytes off the memory
# card and tells it to run them, so the cases that matter are the ones
# where those bytes are not what the cache thinks they are.
#
# Usage: scripts/jscache-test.sh <a-script-over-128KB.js>
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS="$ROOT/deps/netsurf/nsmonkey"
CACHE=/tmp/vitasurf-jscache
BIG="${1:?usage: jscache-test.sh <script.js over 128 KB>}"

[ -x "$NS" ] || { echo "build the harness first"; exit 1; }
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp "$BIG" "$WORK/big.js"
printf '\nwindow.__JCMARK="v1";\n' >> "$WORK/big.js"
cat > "$WORK/p.html" <<'HTML'
<!DOCTYPE html><html><body><div id=x>hi</div>
<script src="big.js"></script>
<script>console.log('JC mark=' + window.__JCMARK +
  ' dom=' + document.getElementById('x').textContent);</script>
</body></html>
HTML

run() {
  { echo "WINDOW NEW"; echo "WINDOW GO 0 file://$WORK/p.html"
    sleep 6; echo "QUIT"; } | timeout 90 "$NS" --enable_javascript=1 2>&1 |
  grep -E "qjs: script .* (compiled|read from cache)|JC mark=" || true
}
fail=0
check() {  # check <what> <regex that must appear in $out>
  if echo "$out" | grep -qE "$2"; then echo "  ok: $1"
  else echo "  FAIL: $1"; echo "$out" | sed 's/^/    /'; fail=1; fi
}

rm -rf "$CACHE"; mkdir -p "$CACHE"

echo "1. first load compiles and stores"
out=$(run); check "compiled" "compiled in"; check "ran correctly" "JC mark=v1 dom=hi"

echo "2. second load reads the cache"
out=$(run); check "read from cache" "read from cache"; check "ran correctly" "JC mark=v1 dom=hi"

echo "3. the bundle changes behind the same URL"
sed -i 's/__JCMARK="v1"/__JCMARK="v2"/' "$WORK/big.js"
out=$(run); check "recompiled, not the stale entry" "compiled in"
check "ran the new code" "JC mark=v2 dom=hi"

echo "4. the entry is truncated"
truncate -s 4096 "$CACHE"/*.bc
out=$(run); check "recompiled" "compiled in"; check "ran correctly" "JC mark=v2 dom=hi"

echo "5. the entry is garbage past QuickJS's own version byte"
out=$(run) >/dev/null   # rebuild a good entry
for seed in 1 2 3; do
  python3 - "$(ls "$CACHE"/*.bc)" "$seed" <<'PY'
import sys, struct, random
p, seed = sys.argv[1], int(sys.argv[2])
d = bytearray(open(p, 'rb').read())
bclen = struct.unpack('<6I', d[:24])[5]
ver = d[24]
random.seed(seed)
body = bytearray(random.getrandbits(8) for _ in range(bclen))
body[0] = ver          # past the version check, into the deserialiser
open(p, 'wb').write(bytes(d[:24]) + bytes(body))
PY
  out=$(run)
  check "seed $seed: recompiled without crashing" "compiled in"
  check "seed $seed: ran correctly" "JC mark=v2 dom=hi"
done

[ $fail -eq 0 ] && echo "all cache cases pass" || { echo "cache cases FAILED"; exit 1; }
