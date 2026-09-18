#!/usr/bin/env bash
# Replace vdpm's FreeType with one that can read WOFF2.
#
# vdpm builds FreeType against bzip2, libpng and zlib only, and vdpm has
# no brotli package at all, so FreeType is compiled without
# FT_CONFIG_OPTION_USE_BROTLI and every WOFF2 font is refused with
# "unknown file format" (FreeType error 2).
#
# That matters more than it sounds. WOFF2 is what the web serves: Google
# Fonts hands it to every modern browser, and so does every icon set.
# An icon font is usually a ligature font, so when it is refused the page
# draws the ligature's own name instead of the glyph -- Audiobookshelf's
# sidebar read "home", "import", "view_column" in icon-sized letters,
# with the layout shoved about to fit them.
#
# So: build brotli's decoder, then build FreeType against it, both into
# the VitaSDK sysroot over the top of vdpm's copies. Sources come from
# git rather than release tarballs because a shallow clone of a tag is
# reproducible without carrying checksums for a file this script does
# not host.
#
# Usage: ./scripts/build-freetype-woff2.sh
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/vita-env.sh"

if [ -n "${VITASURF_NATIVE:-}" ]; then
    echo "build-freetype-woff2.sh: host builds use the system FreeType" >&2
    exit 0
fi

BROTLI_TAG="${BROTLI_TAG:-v1.1.0}"
FREETYPE_TAG="${FREETYPE_TAG:-VER-2-14-3}"
TOOLCHAIN="$VITASDK/share/vita.toolchain.cmake"

[ -f "$TOOLCHAIN" ] || { echo "no $TOOLCHAIN -- is VITASDK set?" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==== brotli $BROTLI_TAG"
git clone --depth 1 --branch "$BROTLI_TAG" https://github.com/google/brotli \
    "$work/brotli"
cmake -S "$work/brotli" -B "$work/brotli/build" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBROTLI_DISABLE_TESTS=ON \
    -DBROTLI_BUILD_TOOLS=OFF
cmake --build "$work/brotli/build" -j"$JOBS"
cmake --install "$work/brotli/build"

echo "==== freetype $FREETYPE_TAG (with brotli)"
git clone --depth 1 --branch "$FREETYPE_TAG" \
    https://github.com/freetype/freetype "$work/freetype"
# FT_REQUIRE_BROTLI makes a missing brotli a configure failure rather
# than a silently WOFF2-less build, which is the whole point of this.
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" \
PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" \
cmake -S "$work/freetype" -B "$work/freetype/build" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DBUILD_SHARED_LIBS=OFF \
    -DFT_DISABLE_HARFBUZZ=TRUE \
    -DFT_REQUIRE_BROTLI=TRUE \
    -DCMAKE_C_FLAGS="-std=gnu11 -Wno-error=implicit-function-declaration -Wno-error=int-conversion -Wno-error=incompatible-pointer-types"
cmake --build "$work/freetype/build" -j"$JOBS"
cmake --install "$work/freetype/build"

if grep -q '^#define FT_CONFIG_OPTION_USE_BROTLI' \
        "$PREFIX/include/freetype2/freetype/config/ftoption.h"; then
    echo "freetype installed with WOFF2 support"
else
    echo "freetype installed WITHOUT WOFF2 support" >&2
    exit 1
fi
