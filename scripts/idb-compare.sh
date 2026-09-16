#!/usr/bin/env bash
#
# Compare tests/storage/indexeddb.html against a real browser, over HTTP.
#
# It cannot go through scripts/dom-compare.sh, which serves pages as
# file:// URLs: a file:// page has an opaque origin and Chrome gives it
# no IndexedDB at all, so the browser side of that comparison stopped
# after a dozen facts having never opened a database. Headless Chrome's
# --virtual-time-budget does not help either, because IndexedDB's work
# does not run on the clock virtual time controls; the browser has to be
# driven and waited for, which is what Playwright does here.
#
# Also checks what the comparison cannot: that what a page stores is
# still there in the next run, and that another origin cannot see it.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS="$ROOT/deps/netsurf/nsmonkey"
CHROME="${CHROME:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}"
PW="${PW:-/opt/node22/lib/node_modules/playwright}"
PORT_A=${PORT_A:-8731}
PORT_B=${PORT_B:-8732}
STORE="${VITASURF_STORAGE:-/tmp/vitasurf-storage}"

[ -x "$NS" ] || { echo "build the harness first"; exit 1; }
[ -x "$CHROME" ] || { echo "no browser at $CHROME"; exit 2; }
[ -d "$PW" ] || { echo "no playwright at $PW"; exit 2; }

WORK=$(mktemp -d)
cleanup() {
    # By pattern as well as by pid: a server left behind would hold the
    # port on the next run, and the comparison would then quietly pass
    # against whatever that one is serving. It did, for a while.
    [ -f "$WORK/a.pid" ] && kill "$(cat "$WORK/a.pid")" 2>/dev/null || true
    [ -f "$WORK/b.pid" ] && kill "$(cat "$WORK/b.pid")" 2>/dev/null || true
    pkill -f "http.server $PORT_A" 2>/dev/null || true
    pkill -f "http.server $PORT_B" 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/docs"
cp "$ROOT/tests/storage/indexeddb.html" "$WORK/docs/"

cat > "$WORK/docs/persist.html" <<'PAGE'
<!DOCTYPE html><html><body><script>
function L(m){ try{console.log('P ' + m);}catch(e){} }
L('visits=' + localStorage.getItem('visits'));
localStorage.setItem('visits', String((Number(localStorage.getItem('visits'))||0)+1));
var req = indexedDB.open('persistdb', 1);
req.onupgradeneeded = function(e){ e.target.result.createObjectStore('notes', {keyPath:'id'}); };
req.onsuccess = function(){
  var tx = req.result.transaction('notes','readwrite'), s = tx.objectStore('notes');
  s.count().onsuccess = function(e){ L('notes=' + e.target.result); };
  s.put({ id: 1, text: 'kept', at: new Date() });
};
</script></body></html>
PAGE

cat > "$WORK/docs/origin.html" <<'PAGE'
<!DOCTYPE html><html><body><script>
function L(m){ try{console.log('O ' + m);}catch(e){} }
L('secret=' + localStorage.getItem('secret'));
localStorage.setItem('secret', 'port' + location.port);
</script></body></html>
PAGE

( cd "$WORK/docs" && python3 -m http.server $PORT_A >/dev/null 2>&1 & echo $! > "$WORK/a.pid" )
( cd "$WORK/docs" && python3 -m http.server $PORT_B >/dev/null 2>&1 & echo $! > "$WORK/b.pid" )
sleep 1

cat > "$WORK/drive.js" <<DRIVER
const { chromium } = require('$PW');
(async () => {
  // The agent proxy in this environment would swallow a request to
  // localhost, so the browser is told to go direct.
  const b = await chromium.launch({ executablePath: '$CHROME',
    args: ['--no-sandbox', '--no-proxy-server'] });
  const p = await b.newPage();
  const r = await p.goto(process.argv[2], { waitUntil: 'load' });
  if (!r || !r.ok()) throw new Error('page returned ' + (r && r.status()));
  await p.waitForTimeout(6000);
  process.stdout.write((await p.\$eval('#out', e => e.textContent)).trim() + '\n');
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
DRIVER

vita() {
    ( echo "WINDOW NEW"; echo "WINDOW GO 0 $1"; sleep "${2:-7}"; echo "QUIT" ) |
    ( cd "$(dirname "$NS")" && timeout 90 "$NS" --enable_javascript=1 ) 2>&1
}

fail=0

echo "1. the same facts as the browser"
node "$WORK/drive.js" "http://127.0.0.1:$PORT_A/indexeddb.html" |
    sed 's/vitasurf-probe-[0-9]*/<random>/' > "$WORK/browser.txt"
vita "http://127.0.0.1:$PORT_A/indexeddb.html" |
    sed -n 's/^.*console: \(XX .*\)$/\1/p' |
    sed 's/vitasurf-probe-[0-9]*/<random>/' > "$WORK/vita.txt"
if [ ! -s "$WORK/browser.txt" ] || [ ! -s "$WORK/vita.txt" ]; then
    echo "   FAIL: one side produced nothing"; fail=1
elif diff -q "$WORK/browser.txt" "$WORK/vita.txt" >/dev/null; then
    echo "   ok: identical on $(wc -l < "$WORK/vita.txt") facts"
else
    echo "   FAIL:"
    diff -u "$WORK/browser.txt" "$WORK/vita.txt" | grep -E '^[+-]XX' | sed 's/^/     /'
    fail=1
fi

echo "2. what a page stores is there in the next run"
rm -rf "$STORE"; mkdir -p "$STORE"
vita "http://127.0.0.1:$PORT_A/persist.html" 5 > "$WORK/p1.raw" 2>&1 || true
vita "http://127.0.0.1:$PORT_A/persist.html" 5 > "$WORK/p2.raw" 2>&1 || true
one=$({ grep -oE 'P (visits|notes)=[a-z0-9]*' "$WORK/p1.raw" || true; } | tr '\n' ' ')
two=$({ grep -oE 'P (visits|notes)=[a-z0-9]*' "$WORK/p2.raw" || true; } | tr '\n' ' ')
if [ -z "$one$two" ]; then
    echo "   (no output at all; last run said:)"
    tail -5 "$WORK/p2.raw" | sed 's/^/     /'
fi
echo "   first run:  $one"
echo "   second run: $two"
case "$two" in *"visits=1"*) echo "   ok: localStorage survived";;
    *) echo "   FAIL: localStorage did not survive"; fail=1;; esac
case "$two" in *"notes=1"*) echo "   ok: the database survived";;
    *) echo "   FAIL: the database did not survive"; fail=1;; esac

echo "3. an upgrade that fails leaves no database behind"
cat > "$WORK/docs/fragile.html" <<'PAGE'
<!DOCTYPE html><html><body><script>
function L(m){ try{console.log('T ' + m);}catch(e){} }
var first = indexedDB.open('fragile', 1);
first.onupgradeneeded = function(){
  first.result.createObjectStore('keyval');
  throw new Error('the handler fell over');
};
first.onsuccess = function(){ L('first=succeeded'); next(); };
first.onerror = function(){ L('first=failed'); next(); };
function next(){
  var again = indexedDB.open('fragile');
  again.onupgradeneeded = function(){ again.result.createObjectStore('keyval'); };
  again.onsuccess = function(){
    var db = again.result;
    try {
      var tx = db.transaction('keyval', 'readwrite');
      tx.objectStore('keyval').put('value', 'k');
      tx.oncomplete = function(){ L('second=usable'); };
      tx.onabort = function(){ L('second=aborted'); };
    } catch (e) { L('second=' + e.name); }
  };
  again.onerror = function(){ L('second=openfailed'); };
}
</script></body></html>
PAGE
frag=$(vita "http://127.0.0.1:$PORT_A/fragile.html" 4 | { grep -oE 'T (first|second)=[a-zA-Z]*' || true; } | tr '\n' ' ')
echo "   $frag"
case "$frag" in *"first=failed"*) echo "   ok: the failed upgrade was reported";;
    *) echo "   FAIL: a throwing upgrade handler was swallowed"; fail=1;; esac
case "$frag" in *"second=usable"*) echo "   ok: the next open made the store properly";;
    *) echo "   FAIL: the database was left half made"; fail=1;; esac

echo "4. another origin cannot see it"
vita "http://127.0.0.1:$PORT_A/origin.html" 3 >/dev/null
other=$(vita "http://127.0.0.1:$PORT_B/origin.html" 3 | { grep -oE 'O secret=[^ ]*' || true; })
mine=$(vita "http://127.0.0.1:$PORT_A/origin.html" 3 | { grep -oE 'O secret=[^ ]*' || true; })
echo "   the other origin sees: $other"
echo "   this origin sees:      $mine"
case "$other" in *"secret=null"*) echo "   ok: kept apart";;
    *) echo "   FAIL: one origin read another's storage"; fail=1;; esac
case "$mine" in *"port$PORT_A"*) echo "   ok: its own is still there";;
    *) echo "   FAIL: an origin lost its own storage"; fail=1;; esac

if [ $fail -eq 0 ]; then echo "all storage checks pass"; else echo "storage checks FAILED"; exit 1; fi
