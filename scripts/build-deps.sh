#!/usr/bin/env bash
# Cross-build the NetSurf libraries and utf8proc and install them into the
# VitaSDK sysroot ($VITASDK/arm-vita-eabi).
#
# Usage: ./scripts/build-deps.sh [clean]
#
# Requires VITASDK plus these vdpm packages: zlib bzip2 libpng libjpeg-turbo
# freetype zstd mbedtls curl-mbedtls expat libvita2d. Set VITASURF_NATIVE=1 to
# build for the host instead (see scripts/vita-env.sh).
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
    make -C "$VITASURF_ROOT/deps/nsgenbind" "PREFIX=$VITASURF_ROOT/out/host" \
        "NSSHARED=$NSSHARED" VARIANT=release Q=@ clean
    exit 0
fi

mkdir -p "$PREFIX/lib/pkgconfig" "$PREFIX/include"

for lib in $LIBS; do
    echo "==== $lib"
    extra=()
    unset LIB_CFLAGS
    if [ -n "$NS_HOST" ]; then
        # Line tables for every library so crash offsets resolve to
        # file:line in CI. Debug sections are not part of the loadable
        # segments, so the VPK does not grow. The Makefile appends CFLAGS
        # from the environment.
        LIB_CFLAGS="-g"
    fi
    if [ "$lib" = "libparserutils" ] && [ -n "$NS_HOST" ]; then
        # VitaSDK newlib's iconv_open() fails for every charset, so page
        # decoding uses libparserutils' own charset codecs instead.
        LIB_CFLAGS="${LIB_CFLAGS:-} -DWITHOUT_ICONV_FILTER"
    fi
    if [ "$lib" = "libnsfb" ] && [ -z "$NS_HOST" ]; then
        : # host build keeps whatever surfaces the host offers (SDL for tests)
    elif [ "$lib" = "libnsfb" ]; then
        # The VitaSDK sysroot ships SDL, which libnsfb would otherwise detect
        # and build its SDL surface against. Only the RAM surface is wanted;
        # the Vita surface lives in vita/surface/ and is linked by CMake.
        extra=(NSFB_SDL_AVAILABLE=no NSFB_XCB_AVAILABLE=no
               NSFB_VNC_AVAILABLE=no NSFB_WLD_AVAILABLE=no)
    fi
    CFLAGS="${LIB_CFLAGS:-}" make -C "$VITASURF_ROOT/deps/$lib" "${MAKE_ARGS[@]}" "${extra[@]}" -j"$JOBS" install
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

# nsgenbind generates the JavaScript bindings at NetSurf build time. It runs
# on the build machine, so it is always compiled with the host compiler and
# installed under out/host, which scripts/build-netsurf.sh puts on PATH.
echo "==== nsgenbind (host tool)"
mkdir -p "$VITASURF_ROOT/out/host"
make -C "$VITASURF_ROOT/deps/nsgenbind" "PREFIX=$VITASURF_ROOT/out/host" \
    "NSSHARED=$NSSHARED" VARIANT=release Q=@ -j"$JOBS" install

echo "==== installed into $PREFIX"
for pc in libwapcaplet libparserutils libnslog libnsutils libhubbub libdom libcss \
          libnsbmp libnsgif libsvgtiny libnspsl libnsfb libutf8proc; do
    printf '  %-16s %s\n' "$pc" "$($NS_PKGCONFIG --modversion "$pc" 2>/dev/null || echo MISSING)"
done
