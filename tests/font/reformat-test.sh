#!/bin/sh
# Web fonts that arrive together lay the page out once (VitaSurf).
# Usage: tests/font/reformat-test.sh path/to/nsmonkey [port]
# Serves tests/font/reformat-server.py, whose eight faces arrive together
# after the page has loaded, and counts the layouts (UPDATE_EXTENT) from
# the first face on. Each face had laid the page out at once.
here=$(cd "$(dirname "$0")" && pwd)
bin=$(cd "$(dirname "${1:?usage: reformat-test.sh nsmonkey [port]}")" && pwd)/$(basename "$1")
port=${2:-8012}
python3 -I "$here/reformat-server.py" "$port" &
server=$!
trap 'kill "$server"' EXIT
sleep 1
cd "$here/../../deps/netsurf" || exit 1
out=$({
	echo "WINDOW NEW"
	echo "WINDOW GO 0 http://127.0.0.1:$port/"
	sleep 6
	echo QUIT
} | MONKEY_WEBFONTS=1 NO_PROXY='*' VITASURF_NOCACHE=1 timeout 40 \
	"$bin" --enable_javascript=1 2>&1 | grep -E '^FONT ADD|UPDATE_EXTENT')
echo "$out" | awk '
/^FONT ADD/ { faces++; seen = 1 }
/UPDATE_EXTENT/ && seen { layouts++ }
END {
	if (faces == 8 && layouts >= 1 && layouts <= 2)
		print "reformat-test: PASS 8 faces, " layouts " layout(s) after them"
	else
		print "reformat-test: FAIL " faces " faces, " layouts " layouts after them, want 8 and 1 or 2"
}'
