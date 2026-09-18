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
# --allow-empty so the first patch for a submodule can be made: there are
# no earlier patches to apply, so the base is upstream unchanged and git
# would otherwise refuse the commit.
git -C "$work/base" -c user.email=vitasurf@invalid -c user.name=VitaSurf \
        commit --quiet --allow-empty -m "base plus the patches before $num"

# Which files a patch may touch: everything upstream tracks, the files
# earlier patches added (which the submodule itself never tracks, since the
# series is applied to the working tree), and the files this patch is
# adding, which are untracked and not ignored. Build output is ignored by
# the submodule and so never lands in a patch. Two untracked files are
# not source and are left out: the apply stamp, and any ELF binary, which
# is a test harness that was built in place.
#
# -P so a tracked symlink is copied as a link rather than followed.
{ git -C "$dir" ls-files -z
  git -C "$work/base" ls-files -z
  git -C "$dir" ls-files -z --others --exclude-standard |
        while IFS= read -r -d '' f; do
            case "$f" in .vitasurf-patched) continue ;; esac
            if [ -f "$dir/$f" ] &&
               [ "$(head -c 4 "$dir/$f" | tr -d '\0')" = "$(printf '\177ELF')" ]; then
                continue
            fi
            # When an older patch is being regenerated, the live tree also
            # holds the files that later patches created; those belong to
            # the patch that introduced them, not to this one.
            if grep -lq -- "^+++ b/$f\$" "$ROOT"/patches/*-"$sub"-*.patch 2>/dev/null; then
                later=0
                for lp in "$ROOT"/patches/*-"$sub"-*.patch; do
                    [ "$(basename "$lp")" \> "$num-$sub-$desc.patch" ] || continue
                    grep -q -- "^+++ b/$f\$" "$lp" && grep -q -- "^--- /dev/null" "$lp" && later=1
                done
                [ "$later" = 0 ] || continue
            fi
            printf '%s\0' "$f"
        done
} | sort -zu > "$work/files"

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
