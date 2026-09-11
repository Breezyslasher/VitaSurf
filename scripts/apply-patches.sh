#!/usr/bin/env bash
# Apply every patch in patches/ to the matching submodule under deps/.
#
# Patch file names are <order>-<submodule>-<description>.patch, for example
# 0001-libnsfb-vita-surface-type.patch applies to deps/libnsfb. Patches that
# are already applied are skipped, so this script is safe to run repeatedly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

status=0
for patch in "$ROOT"/patches/*.patch; do
    [ -e "$patch" ] || continue
    name="$(basename "$patch" .patch)"
    submodule="$(echo "$name" | cut -d- -f2)"
    dir="$ROOT/deps/$submodule"
    if [ ! -d "$dir" ]; then
        echo "error: $name: no submodule at deps/$submodule" >&2
        status=1
        continue
    fi
    if git -C "$dir" apply --check --reverse "$patch" >/dev/null 2>&1; then
        echo "   PATCH: $name (already applied)"
    elif git -C "$dir" apply --check "$patch" >/dev/null 2>&1; then
        echo "   PATCH: $name"
        git -C "$dir" apply "$patch"
    else
        echo "error: $name does not apply cleanly to deps/$submodule" >&2
        git -C "$dir" apply --check "$patch" || true
        status=1
    fi
done
exit $status
