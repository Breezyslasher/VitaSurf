#!/bin/sh
# Drags the page is told of, in the native harness (VitaSurf).
# Usage: tests/input/drag-test.sh path/to/nsmonkey
# Loads page-drags.html, presses, moves and lets go with WINDOW DRAG as
# the Vita's touch screen and held Cross do, and prints the page's PASS
# and FAIL lines and what each press answered: 8 a press that found an
# element, plus 1 if the page cancelled its touch, 2 and 4 if
# touch-action forbids panning across and down.
here=$(cd "$(dirname "$0")" && pwd)
bin=$(cd "$(dirname "${1:?usage: drag-test.sh nsmonkey}")" && pwd)/$(basename "$1")
# the harness finds its resources from NetSurf's tree
cd "$here/../../deps/netsurf" || exit 1
d() { echo "WINDOW DRAG WIN 0 $1 X $2 Y $3 $4"; sleep 0.3; }
{
	echo "WINDOW NEW"
	echo "WINDOW GO 0 file://$here/page-drags.html"
	sleep 4
	d DOWN 20 30 TOUCH; d MOVE 200 30 TOUCH; d MOVE 250 32 TOUCH
	d UP 250 32 TOUCH
	d DOWN 20 90 TOUCH; d MOVE 120 90 TOUCH; d UP 120 90 TOUCH
	d DOWN 20 150 TOUCH; d MOVE 20 190 TOUCH; d CANCEL 20 190 TOUCH
	d DOWN 20 210 MOUSE; d MOVE 150 210 MOUSE; d UP 150 210 MOUSE
	d DOWN 20 270 TOUCH; d MOVE 200 272 TOUCH; d CANCEL 200 272 TOUCH
	d DOWN 30 320 MOUSE; d CLICK 30 320 MOUSE
	d DOWN 30 380 TOUCH; d MOVE 110 380 TOUCH; d UP 110 380 TOUCH
	echo "WINDOW EXEC WIN 0 check()"
	sleep 1
	echo QUIT
} | NO_PROXY='*' MONKEY_WIN_W=960 MONKEY_WIN_H=544 VITASURF_NOCACHE=1 \
	timeout 60 "$bin" --enable_javascript=1 2>&1 |
	grep -a "page-drags:\|DRAG WIN"
