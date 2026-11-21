#!/bin/bash
# WinDinghy updater — tracked source of truth.
#
# The actual entry point people/the menu-bar app run is the repo-root
# `update` script, which is deliberately gitignored: git operations in here
# (fetch/pull/reset/checkout) can never touch it, so it survives no matter
# what state the tracked tree ends up in, and it can always pull a fix even
# if a bad commit broke dinghy.mjs itself. This file exists so the launcher's
# logic is versioned and reviewable in git — every run re-syncs the launcher
# to match this file, so fixes here take effect without a separate install
# step.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR" && git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "Not a git checkout — can't check for updates." >&2
    exit 1
}
cd "$ROOT"

LAUNCHER="$ROOT/update"
TRACKED="$ROOT/host/dinghy-update.sh"
sync_launcher() {
    if ! cmp -s "$TRACKED" "$LAUNCHER" 2>/dev/null; then
        cp "$TRACKED" "$LAUNCHER"
        chmod +x "$LAUNCHER"
    fi
}
sync_launcher

version() { sed -n 's/^const VERSION = "\(.*\)".*/\1/p' host/dinghy.mjs; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "Checking for updates ($BRANCH)..."
if ! git fetch --quiet origin "$BRANCH"; then
    echo "Couldn't reach the git remote — check your network." >&2
    exit 1
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "Already up to date (v$(version))."
    exit 0
fi

if [ "${1:-}" = "--check" ]; then
    echo "An update is available:"
    git log --oneline "HEAD..origin/$BRANCH" | head -20
    exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
    echo "Local changes present — not updating automatically." >&2
    echo "Commit, stash, or discard them, then re-run." >&2
    exit 1
fi

if ! git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
    echo "Local branch has diverged from origin/$BRANCH — not updating automatically." >&2
    echo "Resolve manually (git log, git status), then re-run." >&2
    exit 1
fi

OLD_VER="$(version)"
echo ""
echo "Updating:"
git log --oneline "HEAD..origin/$BRANCH"
echo ""

OLD_HEAD="$(git rev-parse HEAD)"
git pull --ff-only --quiet origin "$BRANCH"
CHANGED="$(git diff --name-only "$OLD_HEAD" HEAD)"
NEW_VER="$(version)"
sync_launcher  # the pull may have changed host/dinghy-update.sh itself

echo "Updated v$OLD_VER -> v$NEW_VER"

# A new FreeRDP patch or build recipe means the bundled client must be rebuilt first.
if [ -d vendor/freerdp ] && echo "$CHANGED" | grep -qE '^(patches/|scripts/build-freerdp.sh|scripts/relocate-dylibs.py)'; then
    echo "The RDP client changed; rebuilding it (a few minutes)..."
    if ! scripts/build-freerdp.sh >/tmp/dinghy-update-freerdp.log 2>&1; then
        echo "RDP client rebuild failed; see /tmp/dinghy-update-freerdp.log (the previous client keeps working)." >&2
    fi
fi

if [ -f "host/menubar/build.sh" ]; then
    echo "Rebuilding the menu-bar app..."
    RUNNING=0
    if pgrep -qf windinghy-menubar; then RUNNING=1; fi
    if ! ( cd host/menubar && ./build.sh ) >/tmp/dinghy-update-build.log 2>&1; then
        echo "Menu-bar rebuild failed — see /tmp/dinghy-update-build.log" >&2
    elif [ "$RUNNING" = "1" ]; then
        pkill -f windinghy-menubar 2>/dev/null || true
        sleep 1
        open "$HOME/Applications/WinDinghy.app"
        echo "Menu-bar app relaunched."
    fi
fi

echo "Done."
