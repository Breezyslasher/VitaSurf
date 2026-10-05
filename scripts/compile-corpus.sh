#!/usr/bin/env bash
# Check a change to the QuickJS compiler against a corpus of real bundles.
#
#   ./scripts/compile-corpus.sh [BASE]
#
# BASE is a VitaSurf revision (default HEAD). The base compiler is the
# QuickJS submodule's own commit with the libquickjs patches BASE had; the
# new one is deps/libquickjs as it is now. Both are built natively, every
# .js, .mjs and .cjs file of the packages in tests/compile/packages.txt is
# compiled by each as a script and as a module, and the bytecode compared:
# a compiler change meant to be faster only must leave every line the same.
# Then the largest file of each package is timed, the best of three.
#
# The packages are fetched once from the npm registry into out/corpus.
# Needs cmake, a C compiler and curl.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${1:-HEAD}"
OUT="$ROOT/out/corpus"
JOBS="${JOBS:-$(nproc)}"
SRC="$ROOT/deps/libquickjs"
mkdir -p "$OUT/npm"

# --- the corpus --------------------------------------------------------------
grep -v '^#' "$ROOT/tests/compile/packages.txt" | while read -r p; do
    [ -n "$p" ] || continue
    d="$OUT/npm/$(echo "$p" | tr '/@' '__')"
    [ -d "$d" ] && continue
    name="${p%@*}"; ver="${p##*@}"
    mkdir -p "$d"
    curl -sSL --max-time 300 \
        "https://registry.npmjs.org/$name/-/$(basename "$name")-$ver.tgz" |
        tar -xzf - -C "$d" || { echo "could not fetch $p" >&2; rm -rf "$d"; }
done
find "$OUT/npm" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) \
    -size +1k -size -15M | sort > "$OUT/files.txt"
echo "corpus: $(wc -l < "$OUT/files.txt") files"

# --- the two compilers -------------------------------------------------------
build() {  # dir -> dir/dump
    cmake -S "$1" -B "$1/b" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
        -DQJS_BUILD_LIBC=OFF -DQJS_BUILD_EXAMPLES=OFF -DQJS_BUILD_CLI_STATIC=OFF \
        -DQJS_BUILD_CLI_WITH_MIMALLOC=OFF > /dev/null
    cmake --build "$1/b" --target qjs -j"$JOBS" > /dev/null
    cc -O2 -o "$1/dump" "$ROOT/tests/compile/dump.c" -I"$1" "$1/b/libqjs.a" -lm -lpthread
}
rm -rf "$OUT/base" "$OUT/new"
mkdir -p "$OUT/base" "$OUT/new"
git -C "$SRC" archive HEAD | tar -xf - -C "$OUT/base"
for patch in $(git -C "$ROOT" ls-tree --name-only "$BASE" patches/ | grep -- '-libquickjs-'); do
    # patch, not git apply: out/ is inside this repository, and git apply
    # run there skips every path outside the directory without a word
    git -C "$ROOT" show "$BASE:$patch" | patch -s -p1 -d "$OUT/base"
done
(cd "$SRC" && git ls-files -co --exclude-standard | tar -cf - -T -) | tar -xf - -C "$OUT/new"
build "$OUT/base"
build "$OUT/new"

# --- same bytecode -----------------------------------------------------------
run() {  # which args... -> stdout, sharded over JOBS
    local which="$1"; shift
    split -n "l/$JOBS" -d "$OUT/files.txt" "$OUT/shard."
    for s in "$OUT"/shard.*; do "$OUT/$which/dump" "$@" $(cat "$s") > "$s.out" & done
    wait
    cat "$OUT"/shard.*.out
    rm -f "$OUT"/shard.*
}
run base > "$OUT/base.txt"
run new > "$OUT/new.txt"
if cmp -s "$OUT/base.txt" "$OUT/new.txt"; then
    echo "bytecode: all $(wc -l < "$OUT/new.txt") compiles the same"
else
    echo "bytecode: DIFFERENT"
    diff "$OUT/base.txt" "$OUT/new.txt" | head -20
    exit 1
fi

# --- time, the largest file of each package ----------------------------------
python3 - "$OUT/files.txt" > "$OUT/big.txt" <<'EOF'
import os, re, sys
fs = [l.strip() for l in open(sys.argv[1])]
fs = [f for f in fs if '/test/' not in f and '.d.' not in f]
fs.sort(key=lambda f: -os.path.getsize(f))
seen = set()
for f in fs:
    pkg = re.sub(r'.*/npm/([^/]*)/.*', r'\1', f)
    if pkg not in seen:
        seen.add(pkg)
        print(f)
EOF
for which in base new; do
    for k in 1 2 3; do "$OUT/$which/dump" -t $(cat "$OUT/big.txt"); done |
        awk '{k = $1 " " $2; if (!(k in m) || $3 < m[k]) m[k] = $3}
             END {for (k in m) t += m[k]; printf "%.0f\n", t}' > "$OUT/$which.ms"
done
b=$(cat "$OUT/base.ms"); n=$(cat "$OUT/new.ms")
echo "time: $(wc -l < "$OUT/big.txt") largest files compile in $b ms before, $n ms after"
