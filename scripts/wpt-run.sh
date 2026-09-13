#!/usr/bin/env bash
# Run the vendored web platform tests in VitaSurf's bindings, and in a
# real browser, and report what the browser passes and we do not.
#
# The probes in tests/dom are only as good as what I thought to test, and
# a saved page only finds what that page happens to hit. These are the
# tests the specifications are checked against, so what they cover is not
# a guess.
#
#   ./scripts/wpt-run.sh                     every vendored test
#   ./scripts/wpt-run.sh tests/wpt/dom/nodes # one directory
#
# A test reports through testharness.js; the copy below adds a completion
# callback that writes each result as one line, so both engines can be
# read the same way as the probes.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}"
NSMONKEY="${NSMONKEY:-$ROOT/deps/netsurf/nsmonkey}"
WAIT="${WAIT:-4}"

if [ ! -d "$ROOT/tests/wpt" ] || [ -z "$(find "$ROOT/tests/wpt" -name '*.html' -print -quit 2>/dev/null)" ]; then
    echo "no tests in tests/wpt -- run the wpt-fetch workflow first" >&2
    exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Appended to each test: testharness.js calls this when every subtest has
# finished, and each line is one subtest's name and result.
cat > "$work/report.html" <<'REPORT'
<pre id="out"></pre>
<script>
add_completion_callback(function (tests, status) {
  var o = document.getElementById('out');
  function line(s) { o.textContent += s + '\n';
    try { console.log('XX ' + s); } catch (e) {} }
  if (status && status.status !== 0) line('HARNESS ' + status.status);
  tests.forEach(function (t) {
    line((t.status === 0 ? 'PASS ' : 'FAIL ') + t.name);
  });
});
</script>
REPORT

roots=("$@")
if [ ${#roots[@]} -eq 0 ]; then roots=("$ROOT/tests/wpt"); fi

total=0; ours=0; theirs=0; regress=0
: > "$work/regressions.txt"

while IFS= read -r test; do
    case "$test" in */resources/*) continue;; esac
    probe="${test%.html}.vitaprobe.html"
    cat "$test" "$work/report.html" > "$probe"

    "$CHROME" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
        --virtual-time-budget=$((WAIT * 1000)) --dump-dom "file://$probe" 2>/dev/null |
    python3 -c '
import sys, re, html
d = sys.stdin.read()
m = re.search(r"<pre id=\"out\"[^>]*>(.*?)</pre>", d, re.S)
sys.stdout.write(html.unescape(m.group(1)).strip() + "\n" if m else "")' > "$work/b.txt"

    (
        echo "WINDOW NEW"
        echo "WINDOW GO 0 file://$probe"
        sleep "$WAIT"
        echo "QUIT"
    ) | ( cd "$(dirname "$NSMONKEY")" && timeout $((WAIT * 8 + 30)) "$NSMONKEY" --enable_javascript=1 ) 2>&1 |
    sed -n 's/^.*console: XX \(.*\)$/\1/p' > "$work/v.txt"
    rm -f "$probe"

    rel="${test#$ROOT/}"
    bp=$(grep -c '^PASS ' "$work/b.txt")
    vp=$(grep -c '^PASS ' "$work/v.txt")
    bt=$(grep -cE '^(PASS|FAIL) ' "$work/b.txt")
    total=$((total + bt)); theirs=$((theirs + bp)); ours=$((ours + vp))
    # what the browser passes and we do not: the list worth working from
    n=$(comm -23 <(grep '^PASS ' "$work/b.txt" | sort -u) \
                 <(grep '^PASS ' "$work/v.txt" | sort -u) | wc -l)
    regress=$((regress + n))
    if [ "$n" -gt 0 ]; then
        { echo "== $rel ($vp of $bt, browser $bp)"
          comm -23 <(grep '^PASS ' "$work/b.txt" | sort -u) \
                   <(grep '^PASS ' "$work/v.txt" | sort -u) |
              sed 's/^PASS /   /' | head -12
        } >> "$work/regressions.txt"
    fi
done < <(find "${roots[@]}" -name '*.html' ! -name '*.vitaprobe.html' | sort)

cat "$work/regressions.txt"
echo
echo "web platform tests: $ours of $total subtests pass here, $theirs in the browser"
echo "$regress the browser passes and we do not"
