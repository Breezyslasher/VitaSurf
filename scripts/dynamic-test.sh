#!/usr/bin/env bash
# Run tests/dom/dynamic-state.html in the monkey harness: it clicks where
# the page expects and asks it to report after each click.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/deps/netsurf"
{ echo WINDOW NEW
  echo "WINDOW GO 0 file://$ROOT/tests/dom/dynamic-state.html"
  sleep 2
  echo "WINDOW CLICK WIN 0 X 20 Y 20 BUTTON LEFT KIND SINGLE"; sleep 1
  echo "WINDOW EXEC 0 JS report('link')"; sleep 1
  echo "WINDOW CLICK WIN 0 X 20 Y 120 BUTTON LEFT KIND SINGLE"; sleep 1
  echo "WINDOW EXEC 0 JS report('field')"; sleep 1
  echo "WINDOW CLICK WIN 0 X 20 Y 60 BUTTON LEFT KIND SINGLE"; sleep 2
  echo "WINDOW EXEC 0 JS report('menu')"; sleep 1
  echo QUIT
} | timeout 60 ./nsmonkey --enable_javascript=1 2>&1 | grep -E "console:|SIGSEGV|Assertion"

# rows under a long list, as GitHub's: a tap on a row must restyle the
# row, not rebuild the page
{ echo WINDOW NEW
  echo "WINDOW GO 0 file://$ROOT/tests/dom/hover-rows.html"
  sleep 2
  echo "WINDOW CLICK WIN 0 X 30 Y 70 BUTTON LEFT KIND SINGLE"; sleep 1
  echo "WINDOW EXEC 0 JS report('row3')"; sleep 1
  echo "WINDOW CLICK WIN 0 X 30 Y 110 BUTTON LEFT KIND SINGLE"; sleep 1
  echo "WINDOW EXEC 0 JS report('row5')"; sleep 1
  echo "WINDOW MOVE WIN 0 X 30 Y 130"
  echo "WINDOW MOVE WIN 0 X 30 Y 150"
  echo "WINDOW MOVE WIN 0 X 30 Y 170"
  echo "WINDOW MOVE WIN 0 X 30 Y 190"; sleep 2
  echo "WINDOW EXEC 0 JS report('moved')"; sleep 1
  echo QUIT
} | timeout 60 ./nsmonkey --enable_javascript=1 2>&1 |
  grep -E "console:|SIGSEGV|Assertion|laid the page out again|pointer rested" |
  awk '/pointer rested/ { n++; next } { print } END { print "rebuilds after the pointer rested: " n+0 }'
