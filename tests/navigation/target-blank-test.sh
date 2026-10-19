#!/bin/sh
# Links that would open a new window, in the native harness (VitaSurf).
# Usage: tests/navigation/target-blank-test.sh path/to/nsmonkey
# Taps each link of target-blank.html and prints where it opened. Each
# must open in the top window but the frame's own link, and the harness
# must make no second window ("WINDOW NEW WIN 1").
here=$(cd "$(dirname "$0")" && pwd)
bin=$(cd "$(dirname "${1:?usage: target-blank-test.sh nsmonkey}")" && pwd)/$(basename "$1")
cd "$here/../../deps/netsurf" || exit 1
page="file://$here/target-blank.html"
tap() {
	echo "WINDOW GO 0 $page"; sleep 3
	echo "WINDOW CLICK WIN 0 X 20 Y $1 BUTTON LEFT KIND SINGLE"; sleep 3
}
{
	echo "WINDOW NEW"
	tap 20      # top, _blank
	tap 60      # top, named
	tap 100     # frame, _blank
	tap 140     # frame, itself
	echo QUIT
} | NO_PROXY='*' VITASURF_NOCACHE=1 timeout 60 "$bin" \
	--enable_javascript=1 --target_blank=0 2>&1 |
	grep -a -E "target-blank: .*opened|WINDOW NEW WIN [1-9]" |
	sed 's/.*console: //'
