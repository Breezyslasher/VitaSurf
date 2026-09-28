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
