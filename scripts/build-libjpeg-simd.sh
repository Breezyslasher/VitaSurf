#!/usr/bin/env bash
# Replace vdpm's libjpeg-turbo with one that uses the Vita's NEON unit.
#
# vdpm builds libjpeg-turbo with -DWITH_SIMD=FALSE, so every JPEG the
# Vita decodes goes through the plain C paths: inverse DCT, colour
# conversion and upsampling a pixel at a time on a Cortex-A9 that has
# NEON sitting idle. Build 442 took 315-420 ms for each 500x750 poster
# on the decode thread. libjpeg-turbo's AArch32 NEON code is intrinsics
# only, so the VitaSDK compiler builds it without an assembler.
#
# NEON is chosen at compile time here. libjpeg-turbo only looks for it
# at run time on Linux and Android, through /proc/cpuinfo or getauxval,
# and the Vita has neither: jsimdcpu.c turns it on when __ARM_NEON__ is
# defined, so -mfpu=neon goes on every file, not just the SIMD ones.
# REQUIRE_SIMD makes a build that cannot use it fail here rather than
# quietly come out as slow as the one it replaces.
#
# The version matches vdpm's package, so the headers NetSurf compiled
# against and the library it links stay the same API.
#
# Usage: ./scripts/build-libjpeg-simd.sh
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/vita-env.sh"

if [ -n "${VITASURF_NATIVE:-}" ]; then
    echo "build-libjpeg-simd.sh: host builds use the system libjpeg" >&2
    exit 0
fi

LIBJPEG_TAG="${LIBJPEG_TAG:-3.2.0}"
TOOLCHAIN="$VITASDK/share/vita.toolchain.cmake"

[ -f "$TOOLCHAIN" ] || { echo "no $TOOLCHAIN -- is VITASDK set?" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==== libjpeg-turbo $LIBJPEG_TAG (with NEON)"
git clone --depth 1 --branch "$LIBJPEG_TAG" \
    https://github.com/libjpeg-turbo/libjpeg-turbo "$work/libjpeg-turbo"
cmake -S "$work/libjpeg-turbo" -B "$work/libjpeg-turbo/build" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_C_FLAGS="-mfpu=neon" \
    -DENABLE_SHARED=FALSE \
    -DENABLE_STATIC=TRUE \
    -DWITH_SIMD=TRUE \
    -DREQUIRE_SIMD=TRUE \
    -DWITH_TURBOJPEG=FALSE \
    -DWITH_TOOLS=FALSE \
    -DWITH_TESTS=FALSE \
    2>&1 | tee "$work/configure.log"
# libjpeg-turbo says "SIMD extensions: ARM (WITH_SIMD = 1)" when it
# found them; REQUIRE_SIMD should already have stopped a build without them
grep -q 'SIMD extensions: ARM (WITH_SIMD = 1)' "$work/configure.log" || {
    echo "libjpeg-turbo configured without its ARM SIMD extensions" >&2
    exit 1
}
cmake --build "$work/libjpeg-turbo/build" --target jpeg-static -j"$JOBS"
lib="$work/libjpeg-turbo/build/libjpeg.a"
no_pic_relocations "$lib"
# the NEON inverse DCT is what most of a decode spends its time in
# (grep -c, not -q, for the same pipefail reason as no_pic_relocations)
if ! "$VITASDK/bin/arm-vita-eabi-nm" "$lib" 2>/dev/null |
        grep -c ' T jsimd_idct_islow_neon$' >/dev/null; then
    echo "libjpeg.a has no NEON inverse DCT; SIMD did not build" >&2
    exit 1
fi
# By hand: the install rules would also want the TurboJPEG library and
# the tools. A static library and the four headers NetSurf includes.
install -d "$PREFIX/lib" "$PREFIX/include"
install -m 644 "$lib" "$PREFIX/lib/libjpeg.a"
install -m 644 "$work/libjpeg-turbo/build/jconfig.h" "$PREFIX/include"
for h in jerror.h jmorecfg.h jpeglib.h; do
    for d in "$work/libjpeg-turbo/src" "$work/libjpeg-turbo"; do
        if [ -f "$d/$h" ]; then
            install -m 644 "$d/$h" "$PREFIX/include"
            break
        fi
    done
done
echo "libjpeg-turbo installed with NEON"
