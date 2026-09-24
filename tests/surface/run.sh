#!/bin/sh
# Native simulation of the Vita surface (vita/surface/vita.c): stub SDK
# headers in sdk/, fake vita2d calls that compose a screen from the
# texture parts drawn, and random scrolls, redraws, focus and pointer
# moves checked pixel for pixel against the page and the shadow buffer.
# Usage: tests/surface/run.sh [seed] [steps]
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${TMPDIR:-/tmp}/vitasurf-surface-test
mkdir -p "$out"
nsfb=$root/deps/libnsfb
seed=${1:-7}
steps=${2:-600}
sed "s/srand(7)/srand($seed)/; s/step <= 600/step <= $steps/" \
	"$here/ring.c" > "$here/.ring-run.c"
trap 'rm -f "$here/.ring-run.c"' EXIT
cc -std=gnu99 -O1 -w -D__vita__ -D_DEFAULT_SOURCE \
	-I"$here/sdk" -I"$nsfb/include" -I"$nsfb/src" \
	-I"$root/vita/platform" -I"$root/vita/surface" \
	"$here/.ring-run.c" \
	"$nsfb/src/libnsfb.c" "$nsfb/src/cursor.c" "$nsfb/src/palette.c" \
	"$nsfb/src/dump.c" "$nsfb/src/surface/surface.c" \
	"$nsfb/src/plot/api.c" "$nsfb/src/plot/generic.c" \
	"$nsfb/src/plot/util.c" "$nsfb/src/plot/32bpp-xbgr8888.c" \
	"$nsfb/src/plot/32bpp-xrgb8888.c" "$nsfb/src/plot/16bpp.c" \
	"$nsfb/src/plot/8bpp.c" \
	-o "$out/ring"
"$out/ring" | tail -n 1
