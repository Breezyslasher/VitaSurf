#!/usr/bin/env bash
# Build QuickJS from deps/libquickjs, with the patches in patches/, over
# the top of vdpm's copy.
#
# vdpm's quickjs-ng is the stock release, and the stock release keeps a
# copy of every function's source for Function.prototype.toString. A
# nested function's text is inside its parent's, so a bundle is held once
# per level of nesting: 35-47% of the memory compiling a large bundle
# takes. claude.ai compiled about 20 MB of script and ran out of the
# 96 MB the page's runtime is allowed. Patch 0243 has every function of a
# script point into one shared copy instead.
#
# The version and the build are vdpm's (v0.14.0, CMake Release, no libc,
# a static library named libquickjs.a), so the one difference is the
# patches. The library and quickjs.h replace vdpm's; nothing else of the
# package is used.
#
# VITASURF_NATIVE=1 builds for the host into out/native, for the test
# harness.
#
# Usage: ./scripts/build-quickjs.sh
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/vita-env.sh"

SRC="$VITASURF_ROOT/deps/libquickjs"
[ -f "$SRC/quickjs.c" ] || {
    echo "no $SRC/quickjs.c -- run: git submodule update --init deps/libquickjs" >&2
    exit 1
}

"$VITASURF_ROOT/scripts/apply-patches.sh" libquickjs
grep -q 'QJS_VITASURF_SHARED_SOURCE' "$SRC/quickjs.h" || {
    echo "deps/libquickjs is missing the shared source patch" >&2
    exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cmake_args=(
    -DCMAKE_BUILD_TYPE=Release
    -DBUILD_SHARED_LIBS=OFF
    -DQJS_BUILD_LIBC=OFF
    -DQJS_BUILD_EXAMPLES=OFF
    -DQJS_BUILD_CLI_STATIC=OFF
    -DQJS_BUILD_CLI_WITH_MIMALLOC=OFF
    -DQJS_BUILD_CLI_WITH_STATIC_MIMALLOC=OFF
)
if [ "${VITASURF_NATIVE:-0}" != "1" ]; then
    cmake_args+=(-DCMAKE_TOOLCHAIN_FILE="$VITASDK/share/vita.toolchain.cmake")
fi

echo "==== QuickJS $(git -C "$SRC" describe --tags 2>/dev/null || echo '?') (patched)"
# Out of the tree, so the submodule holds only source and the patches.
cmake -S "$SRC" -B "$work/build" "${cmake_args[@]}"
cmake --build "$work/build" --target qjs -j"$JOBS"

lib="$work/build/libqjs.a"
[ -f "$lib" ] || { echo "no libqjs.a was built" >&2; exit 1; }
if [ "${VITASURF_NATIVE:-0}" != "1" ]; then
    no_pic_relocations "$lib"
fi
install -d "$PREFIX/lib" "$PREFIX/include"
install -m 644 "$lib" "$PREFIX/lib/libquickjs.a"
install -m 644 "$SRC/quickjs.h" "$PREFIX/include/quickjs.h"
echo "QuickJS installed with shared function source"
