#!/usr/bin/env bash
# Turn the live changes in one submodule into the next patch in patches/.
#
# The submodule working trees are deliberately dirty: the patch series is
# what makes them differ from the pinned upstream commit. So a new patch is
# the difference between "upstream plus every patch already in the series"
# and what is on disk now.
#
#   ./scripts/make-patch.sh libcss 0063 calc-every-length
#
# writes patches/0063-libcss-calc-every-length.patch. Patches numbered at
# or above the new one are left out of the base, so a patch can be
# regenerated in place.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sub="${1:?usage: make-patch.sh <submodule> <number> <description>}"
num="${2:?usage: make-patch.sh <submodule> <number> <description>}"
desc="${3:?usage: make-patch.sh <submodule> <number> <description>}"

dir="$ROOT/deps/$sub"
[ -d "$dir" ] || { echo "error: no submodule at deps/$sub" >&2; exit 1; }

out="$ROOT/patches/$num-$sub-$desc.patch"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --shared --quiet --no-checkout "$dir" "$work/base"
git -C "$work/base" checkout --quiet "$(git -C "$dir" rev-parse HEAD)"

for patch in "$ROOT"/patches/*-"$sub"-*.patch; do
    [ -e "$patch" ] || continue
    [ "$(basename "$patch")" \< "$num-$sub-$desc.patch" ] || continue
    git -C "$work/base" apply "$patch"
done

git -C "$work/base" add -A
git -C "$work/base" -c user.email=vitasurf@invalid -c user.name=VitaSurf \
        commit --quiet -m "base plus the patches before $num"

# Which files a patch may touch: everything upstream tracks, plus the files
# earlier patches added (which the submodule itself never tracks, since the
# series is applied to the working tree). A submodule's build output is in
# neither list and so never lands in a patch.
#
# -P so a tracked symlink is copied as a link rather than followed.
{ git -C "$dir" ls-files -z; git -C "$work/base" ls-files -z; } |
        sort -zu > "$work/files"

while IFS= read -r -d '' f; do
    if [ -e "$dir/$f" ] || [ -L "$dir/$f" ]; then
        mkdir -p "$work/base/$(dirname "$f")"
        rm -f "$work/base/$f"
        cp -Pp "$dir/$f" "$work/base/$f"
    else
        rm -f "$work/base/$f"
    fi
done < "$work/files"

git -C "$work/base" add -A
git -C "$work/base" diff --cached --binary > "$out"

if [ ! -s "$out" ]; then
    echo "no change in deps/$sub; removing empty $out" >&2
    rm -f "$out"
    exit 1
fi

echo "wrote $out"
git -C "$work/base" diff --cached --stat | tail -1
