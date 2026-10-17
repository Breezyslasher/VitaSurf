#!/bin/sh
# Web fonts are held while a page uses them (VitaSurf), in the harness.
# Usage: tests/font/webfont-lifetime.sh path/to/nsmonkey
# Loads lifetime/a.html, then b.html, then a.html again, each with three
# faces of 600,000 bytes, so two pages' faces are more than the 2 MB the
# browser holds. MONKEY_WEBFONTS makes the harness take faces and say
# so ("FONT ADD", "FONT REMOVE"). Every page must get its three faces:
# the left page's go to make room. They had been held for the session,
# and every page after the first refused its fonts as too large.
here=$(cd "$(dirname "$0")" && pwd)
bin=$(cd "$(dirname "${1:?usage: webfont-lifetime.sh nsmonkey}")" && pwd)/$(basename "$1")
dir=$(mktemp -d) || exit 1
trap 'rm -rf "${dir:?}"' EXIT
cp "$here/lifetime/a.html" "$here/lifetime/b.html" "$dir/"
for f in a1 a2 a3 b1 b2 b3; do
	head -c 600000 /dev/zero > "$dir/$f.woff2"
done
# the harness finds its resources from NetSurf's tree
cd "$here/../../deps/netsurf" || exit 1
out=$({
	echo "WINDOW NEW"
	echo "WINDOW GO 0 file://$dir/a.html"; sleep 3
	echo "WINDOW GO 0 file://$dir/b.html"; sleep 3
	echo "WINDOW GO 0 file://$dir/a.html"; sleep 3
	echo QUIT
} | MONKEY_WEBFONTS=1 NO_PROXY='*' VITASURF_NOCACHE=1 timeout 60 \
	"$bin" --enable_javascript=1 2>&1 | grep '^FONT')
echo "$out"
adds=$(echo "$out" | grep -c '^FONT ADD')
b=$(echo "$out" | grep -c '^FONT ADD Fb')
if [ "$adds" -eq 9 ] && [ "$b" -eq 3 ]; then
	echo "webfont-lifetime: PASS every page got its three faces"
else
	echo "webfont-lifetime: FAIL $adds faces taken, $b of them b's"
fi
