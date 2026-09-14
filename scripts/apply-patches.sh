#!/usr/bin/env bash
# Apply every patch in patches/ to the matching submodule under deps/.
#
# Patch file names are <order>-<submodule>-<description>.patch, for example
# 0001-libnsfb-vita-surface-type.patch applies to deps/libnsfb. Applied
# patches are recorded in deps/<submodule>/.vitasurf-patched so the script
# is safe to run repeatedly (the build scripts call it more than once).
# A patch that is missing from the record but reverse-applies cleanly is
# treated as already applied, which covers checkouts patched before the
# record existed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

status=0
for patch in "$ROOT"/patches/*.patch; do
    [ -e "$patch" ] || continue
    name="$(basename "$patch" .patch)"
    submodule="$(echo "$name" | cut -d- -f2)"
    dir="$ROOT/deps/$submodule"
    stamp="$dir/.vitasurf-patched"
    if [ ! -d "$dir" ]; then
        echo "error: $name: no submodule at deps/$submodule" >&2
        status=1
        continue
    fi
    # Ask the source, not the record: a checkout or a reset can undo a
    # patch and leave the record behind, and then the build silently uses
    # unpatched code. The record is only a fallback for a patch that
    # cannot be reverse-checked.
    if git -C "$dir" apply --check --reverse "$patch" >/dev/null 2>&1; then
        echo "   PATCH: $name (already applied)"
        grep -qxF "$name" "$stamp" 2>/dev/null || echo "$name" >> "$stamp"
    elif git -C "$dir" apply --check "$patch" >/dev/null 2>&1; then
        echo "   PATCH: $name"
        git -C "$dir" apply "$patch"
        echo "$name" >> "$stamp"
    elif [ -f "$stamp" ] && grep -qxF "$name" "$stamp"; then
        # neither direction applies and the record says it is in: the
        # source has moved on, which is fine, but say so
        echo "   PATCH: $name (recorded, cannot verify)"
    else
        echo "error: $name does not apply cleanly to deps/$submodule" >&2
        git -C "$dir" apply --check "$patch" || true
        status=1
    fi
done
exit $status
