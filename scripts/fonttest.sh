#!/usr/bin/env bash
#
# Build and run tests/font against the real fb_font_width,
# fb_font_position and fb_font_split from NetSurf's FreeType backend --
# the code the Vita actually lays text out with.
#
# It checks two things. That the advance cache returns exactly what the
# FreeType cache manager returned, across sizes, faces and scripts, so
# that nothing in layout moves; and that a character with no glyph does
# not send the loop round forever.
#
# Needs a native NetSurf tree built at least once (for utils_utf8.o and
# the netsurf libraries under out/native).
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS="$ROOT/deps/netsurf"
OUT="$ROOT/out/native"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

[ -f "$NS/build/Linux-framebuffer/utils_utf8.o" ] || {
  echo "build the native framebuffer frontend first"; exit 1; }

# fb_font_init() takes the font file names as build-time defines
for f in SANS_SERIF SANS_SERIF_BOLD SANS_SERIF_ITALIC SANS_SERIF_ITALIC_BOLD \
         SERIF SERIF_BOLD MONOSPACE MONOSPACE_BOLD CURSIVE FANTASY; do
  echo "#define NETSURF_FB_FONT_$f \"x.ttf\""
done > "$WORK/defs.h"

gcc -O2 -Wall -o "$WORK/fonttest" \
  "$ROOT/tests/font/fonttest.c" "$ROOT/tests/font/fontstubs.c" \
  -Dnsframebuffer -include "$WORK/defs.h" \
  -I"$NS" -I"$NS/include" -I"$NS/frontends" -I"$NS/content/handlers" \
  -I"$OUT/include" $(pkg-config --cflags freetype2) \
  "$NS/frontends/framebuffer/font_freetype.c" \
  "$NS/build/Linux-framebuffer/utils_utf8.o" \
  -L"$OUT/lib" -lnsutils -lparserutils -lnslog -lwapcaplet \
  $(pkg-config --libs freetype2)

"$WORK/fonttest"
