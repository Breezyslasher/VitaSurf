#!/usr/bin/env bash
# Build WAMR's WebAssembly interpreter from deps/wamr, with the glue the
# JS API uses (vita/wasm/glue.c), into $PREFIX/lib/libvitawamr.a; glue.h
# and WAMR's public headers go under $PREFIX/include/wamr.
#
# The configuration is vita/wasm/CMakeLists.txt: the fast interpreter and
# nothing else, on the platform layer in vita/wasm/platform.
#
# VITASURF_NATIVE=1 builds for the host into out/native, for the test
# harness.
#
# Usage: ./scripts/build-wamr.sh
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/vita-env.sh"

SRC="$VITASURF_ROOT/deps/wamr"
[ -f "$SRC/build-scripts/runtime_lib.cmake" ] || {
    echo "no $SRC/build-scripts/runtime_lib.cmake -- run: git submodule update --init deps/wamr" >&2
    exit 1
}
"$VITASURF_ROOT/scripts/apply-patches.sh" wamr
grep -q 'wasm_set_next_import_links' "$SRC/core/iwasm/interpreter/wasm_runtime.h" || {
    echo "deps/wamr is missing patch 0246 (imports linked per instance)" >&2
    exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cmake_args=(-DCMAKE_BUILD_TYPE=Release)
if [ "${VITASURF_NATIVE:-0}" != "1" ]; then
    cmake_args+=(-DCMAKE_TOOLCHAIN_FILE="$VITASDK/share/vita.toolchain.cmake")
fi

echo "==== WAMR $(git -C "$SRC" describe --tags 2>/dev/null || echo '?') (interpreter)"
cmake -S "$VITASURF_ROOT/vita/wasm" -B "$work/build" "${cmake_args[@]}"
cmake --build "$work/build" -j"$JOBS"

lib="$work/build/libvitawamr.a"
[ -f "$lib" ] || { echo "no libvitawamr.a was built" >&2; exit 1; }
if [ "${VITASURF_NATIVE:-0}" != "1" ]; then
    no_pic_relocations "$lib"
fi
install -d "$PREFIX/lib" "$PREFIX/include/wamr"
install -m 644 "$lib" "$PREFIX/lib/libvitawamr.a"
install -m 644 "$SRC"/core/iwasm/include/*.h "$VITASURF_ROOT/vita/wasm/glue.h" \
    "$PREFIX/include/wamr/"
echo "WAMR installed"
