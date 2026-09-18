#!/usr/bin/env bash
# Prove the patch series reproduces the live submodule trees.
#
# For each submodule that has patches: clone it pristine at its pinned
# commit, apply every patch in order the way CI does, and compare each
# tracked or patch-created file with the working tree. A file the working
# tree has that the applied series lacks is the failure this exists to
# catch -- a source that a Makefile names but no patch carries, which is
# a cross build that dies at "No rule to make target".
#
#   ./scripts/check-patches.sh            every submodule with patches
#   ./scripts/check-patches.sh libcss     one submodule
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
status=0

subs="${1:-$(ls "$ROOT"/patches/*.patch | sed 's/.*\/[0-9]*-\([^-]*\)-.*/\1/' | sort -u)}"

for sub in $subs; do
    dir="$ROOT/deps/$sub"
    work="$(mktemp -d)"
    git clone -q --shared --no-checkout "$dir" "$work/t"
    git -C "$work/t" checkout -q "$(git -C "$dir" rev-parse HEAD)"

    applied=0
    for p in "$ROOT"/patches/*-"$sub"-*.patch; do
        if ! git -C "$work/t" apply "$p" 2>/dev/null; then
            echo "$sub: $(basename "$p") does not apply"
            status=1
            break
        fi
        applied=$((applied + 1))
    done

    differ=0
    while IFS= read -r f; do
        case "$f" in
            .vitasurf-patched|*/res/Messages) continue ;;  # stamp; build output
        esac
        [ -f "$dir/$f" ] || continue
        if [ "$(head -c 4 "$dir/$f" | tr -d '\0')" = "$(printf '\177ELF')" ]; then
            continue                                       # a built harness
        fi
        if ! cmp -s "$dir/$f" "$work/t/$f"; then
            echo "$sub: $f differs from the applied series"
            differ=$((differ + 1))
        fi
    done < <({ git -C "$dir" ls-files; git -C "$dir" ls-files --others --exclude-standard; } | sort -u)

    if [ "$differ" -eq 0 ]; then
        echo "$sub: $applied patches apply and reproduce the working tree"
    else
        status=1
    fi
    rm -rf "$work"
done
exit $status
