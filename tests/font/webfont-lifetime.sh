#!/bin/sh
# Web fonts are held while a page uses them (VitaSurf), in the harness.
# Usage: tests/font/webfont-lifetime.sh path/to/nsmonkey
# Loads lifetime/a.html, then b.html, then a.html again, each with three
# faces of 1,400,000 bytes, so two pages' faces are more than the 6 MB
# the browser holds. MONKEY_WEBFONTS makes the harness take faces and say
# so ("FONT ADD", "FONT REMOVE"). Every page must hold its three faces
# once it has loaded: the left page's go to make room. They had been held for the session,
# and every page after the first refused its fonts as too large.
here=$(cd "$(dirname "$0")" && pwd)
bin=$(cd "$(dirname "${1:?usage: webfont-lifetime.sh nsmonkey}")" && pwd)/$(basename "$1")
dir=$(mktemp -d) || exit 1
trap 'rm -rf "${dir:?}"' EXIT
cp "$here/lifetime/a.html" "$here/lifetime/b.html" "$dir/"
for f in a1 a2 a3 b1 b2 b3; do
	head -c 1400000 /dev/zero > "$dir/$f.woff2"
done
# the harness finds its resources from NetSurf's tree
cd "$here/../../deps/netsurf" || exit 1
out=$({
	echo "WINDOW NEW"
	for p in a b a; do
		echo "WINDOW GO 0 file://$dir/$p.html"; sleep 3
		echo "WINDOW EXEC WIN 0 console.log('lifetime: $p')"; sleep 0.5
	done
	echo QUIT
} | MONKEY_WEBFONTS=1 NO_PROXY='*' VITASURF_NOCACHE=1 timeout 60 \
	"$bin" --enable_javascript=1 2>&1 | grep -E '^FONT|lifetime: [ab]$' |
	sed 's/^.*console: //')
echo "$out"
# the faces held when each page has loaded, from what was taken and let go
echo "$out" | awk '
/^FONT ADD/ { held[$3] = 1 }
/^FONT REMOVE/ { delete held[$3] }
/^lifetime: / {
	p = $2; n = 0
	for (i = 1; i <= 3; i++) if (("F" p i) in held) n++
	if (n == 3) print "webfont-lifetime: PASS " p " has its three faces"
	else { print "webfont-lifetime: FAIL " p " has " n " of its three faces"; bad = 1 }
}'
