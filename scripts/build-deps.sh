#!/usr/bin/env bash
# Cross-build the NetSurf libraries and utf8proc and install them into the
# VitaSDK sysroot ($VITASDK/arm-vita-eabi).
#
# Usage: ./scripts/build-deps.sh [clean]
#
# Requires VITASDK plus these vdpm packages: zlib bzip2 libpng libjpeg-turbo
# freetype openssl-1.1.1 curl expat. Set VITASURF_NATIVE=1 to build for the host
# instead (see scripts/vita-env.sh).
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/vita-env.sh"

"$VITASURF_ROOT/scripts/apply-patches.sh"

# Order matters: each library only depends on the ones before it.
LIBS="libwapcaplet libparserutils libnslog libnsutils libhubbub libdom libcss
      libnsbmp libnsgif libsvgtiny libnspsl libnsfb"

mapfile -t MAKE_ARGS < <(ns_make_args)

if [ "${1:-}" = "clean" ]; then
    for lib in $LIBS; do
        make -C "$VITASURF_ROOT/deps/$lib" "${MAKE_ARGS[@]}" clean
    done
    make -C "$VITASURF_ROOT/deps/utf8proc" clean
    exit 0
fi

mkdir -p "$PREFIX/lib/pkgconfig" "$PREFIX/include"

for lib in $LIBS; do
    echo "==== $lib"
    make -C "$VITASURF_ROOT/deps/$lib" "${MAKE_ARGS[@]}" -j"$JOBS" install
done

# utf8proc (MIT) has a plain Makefile rather than the NetSurf buildsystem.
# Only the static library is built; the pkg-config file is generated so that
# NetSurf's pkg-config check for libutf8proc succeeds.
echo "==== utf8proc"
UTF8PROC="$VITASURF_ROOT/deps/utf8proc"
make -C "$UTF8PROC" CC="$TARGET_CC" AR="$TARGET_AR" CFLAGS="-O2" PICFLAG="" libutf8proc.a
make -C "$UTF8PROC" prefix="$PREFIX" libdir="$PREFIX/lib" includedir="$PREFIX/include" libutf8proc.pc
install -m 644 "$UTF8PROC/utf8proc.h" "$PREFIX/include/utf8proc.h"
install -m 644 "$UTF8PROC/libutf8proc.a" "$PREFIX/lib/libutf8proc.a"
install -m 644 "$UTF8PROC/libutf8proc.pc" "$PREFIX/lib/pkgconfig/libutf8proc.pc"

echo "==== installed into $PREFIX"
for pc in libwapcaplet libparserutils libnslog libnsutils libhubbub libdom libcss \
          libnsbmp libnsgif libsvgtiny libnspsl libnsfb libutf8proc; do
    printf '  %-16s %s\n' "$pc" "$($NS_PKGCONFIG --modversion "$pc" 2>/dev/null || echo MISSING)"
done
