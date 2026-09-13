#!/usr/bin/env bash
# Run a DOM behaviour probe in a real browser and in VitaSurf's bindings,
# and print every line where they disagree.
#
# Reverse-engineering one site's minified bundle finds one bug per site.
# A browser is the specification made executable: run the same page in
# both, and every difference is a bug here, found without a website.
#
#   ./scripts/dom-compare.sh                 every probe in tests/dom
#   ./scripts/dom-compare.sh tests/dom/x.html   just that one
#
# A probe prints one "XX name: value" line per fact, into #out and to the
# console, so the browser can be read with --dump-dom and VitaSurf from
# its log. Keep values stable: no timings, no absolute paths.
#
# NSMONKEY  NetSurf's monkey frontend built with these bindings
# CHROME    a Chromium or Chrome binary
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}"
NSMONKEY="${NSMONKEY:-$ROOT/deps/netsurf/nsmonkey}"

if [ ! -x "$CHROME" ]; then echo "no browser at $CHROME" >&2; exit 2; fi
if [ ! -x "$NSMONKEY" ]; then echo "no monkey frontend at $NSMONKEY" >&2; exit 2; fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

run_browser() {
    # the pre spans lines, so pull it out whole
    "$CHROME" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
        --virtual-time-budget=4000 --dump-dom "file://$1" 2>/dev/null |
    python3 -c '
import sys, re, html
d = sys.stdin.read()
m = re.search(r"<pre id=\"out\">(.*?)</pre>", d, re.S)
print(html.unescape(m.group(1)).strip() if m else "")'
}

run_vita() {
    (
        echo "WINDOW NEW"
        echo "WINDOW GO 0 file://$1"
        sleep 4
        echo "QUIT"
    ) | ( cd "$(dirname "$NSMONKEY")" && timeout 90 "$NSMONKEY" --enable_javascript=1 ) 2>&1 |
    sed -n 's/^.*console: \(XX .*\)$/\1/p'
}

status=0
pages=("$@")
if [ ${#pages[@]} -eq 0 ]; then pages=("$ROOT"/tests/dom/*.html); fi

for page in "${pages[@]}"; do
    abs="$(cd "$(dirname "$page")" && pwd)/$(basename "$page")"
    run_browser "$abs" > "$work/browser.txt"
    run_vita "$abs" > "$work/vita.txt"
    name="$(basename "$page")"
    # A probe that printed nothing is a broken probe, not a passing one.
    if [ ! -s "$work/browser.txt" ] || [ ! -s "$work/vita.txt" ]; then
        echo "== $name: no facts from $([ -s "$work/browser.txt" ] || echo -n 'the browser')$([ -s "$work/browser.txt" ] || [ -s "$work/vita.txt" ] || echo -n ' and ')$([ -s "$work/vita.txt" ] || echo -n 'vitasurf') -- the probe did not run"
        status=1
        continue
    fi
    if diff -q "$work/browser.txt" "$work/vita.txt" >/dev/null; then
        echo "== $name: same as the browser ($(wc -l < "$work/browser.txt") facts)"
    else
        n=$(diff "$work/browser.txt" "$work/vita.txt" | grep -c '^[<>]')
        echo "== $name: $n lines differ"
        diff "$work/browser.txt" "$work/vita.txt" |
            sed 's/^</  browser:/;s/^>/  vitasurf:/' | grep -v '^[0-9-]'
        status=1
    fi
done
exit $status
