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

# no_pic_relocations comes from vita-env.sh.

echo "==== brotli $BROTLI_TAG"
git clone --depth 1 --branch "$BROTLI_TAG" https://github.com/google/brotli \
    "$work/brotli"
# brotli asks for position independent code for all three libraries, so
# that a shared build works. Nothing here is shared, and on ARM it turns
# every access to a global into a GOT one. Ask for the opposite.
grep -q 'POSITION_INDEPENDENT_CODE TRUE' "$work/brotli/CMakeLists.txt" || {
    echo "brotli $BROTLI_TAG no longer sets POSITION_INDEPENDENT_CODE;" \
         "check what it does instead before removing this" >&2
    exit 1
}
sed -i 's/POSITION_INDEPENDENT_CODE TRUE/POSITION_INDEPENDENT_CODE FALSE/' \
    "$work/brotli/CMakeLists.txt"
cmake -S "$work/brotli" -B "$work/brotli/build" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBROTLI_DISABLE_TESTS=ON
# Only the decoder, by target name. brotli 1.1.0 has no switch for it:
# "cmake --build" would also build the brotli command line tool, which
# reads st_atim and st_mtim out of struct stat, and newlib has neither,
# so the whole build fails on a member name. FreeType wants the decoder
# and nothing else, and skipping the encoder and the tool takes about
# two minutes off this.
cmake --build "$work/brotli/build" --target brotlidec brotlicommon -j"$JOBS"
no_pic_relocations "$work/brotli/build/libbrotlicommon.a"
no_pic_relocations "$work/brotli/build/libbrotlidec.a"
# By hand as well, because brotli's install rules are all or nothing and
# would ask for that same tool. This is a static library, five headers
# and the two pkg-config files FreeType looks it up through.
install -d "$PREFIX/lib/pkgconfig" "$PREFIX/include/brotli"
install -m 644 "$work/brotli/build/libbrotlicommon.a" \
               "$work/brotli/build/libbrotlidec.a" "$PREFIX/lib"
install -m 644 "$work/brotli/build/libbrotlicommon.pc" \
               "$work/brotli/build/libbrotlidec.pc" "$PREFIX/lib/pkgconfig"
install -m 644 "$work/brotli"/c/include/brotli/*.h "$PREFIX/include/brotli"

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
no_pic_relocations "$work/freetype/build/libfreetype.a"
cmake --install "$work/freetype/build"

if grep -q '^#define FT_CONFIG_OPTION_USE_BROTLI' \
        "$PREFIX/include/freetype2/freetype/config/ftoption.h"; then
    echo "freetype installed with WOFF2 support"
else
    echo "freetype installed WITHOUT WOFF2 support" >&2
    exit 1
fi
