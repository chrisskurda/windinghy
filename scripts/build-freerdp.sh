#!/bin/bash
# Build the patched FreeRDP SDL client used by WinDinghy's native mode.
#   scripts/build-freerdp.sh                 # vendor/freerdp (gitignored)
#   WORK=/Volumes/SSD/freerdp-build PREFIX=/Volumes/SSD/freerdp scripts/build-freerdp.sh
# Needs: brew install cmake ninja pkg-config freerdp   (freerdp brings the build deps)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$ROOT/vendor/build}"
PREFIX="${PREFIX:-$ROOT/vendor/freerdp}"
BASE="$(cat "$ROOT/patches/freerdp-base-commit.txt")"
mkdir -p "$WORK"
if [ ! -d "$WORK/src/.git" ]; then
  git clone https://github.com/FreeRDP/FreeRDP.git "$WORK/src"
fi
cd "$WORK/src"
git fetch --quiet origin "$BASE" 2>/dev/null || git fetch --quiet origin
git checkout --quiet -f "$BASE"
git apply "$ROOT/patches/freerdp-sdl-macos-remoteapp.patch"
cmake -G Ninja -S . -B "$WORK/out" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DWITH_CLIENT_SDL=ON -DWITH_CLIENT_SDL3=ON -DWITH_CLIENT_SDL2=OFF -DWITH_X11=OFF \
  -DWITH_SERVER=OFF -DWITH_SHADOW=OFF -DWITH_PROXY=OFF -DWITH_SAMPLE=OFF -DWITH_MANPAGES=OFF \
  -DWITH_CLIENT_MAC=OFF -DBUILD_TESTING=OFF -DWITH_FFMPEG=ON -DWITH_PKCS11=OFF -DWITH_PCSC=OFF \
  -DWITH_CUPS=OFF -DCMAKE_PREFIX_PATH="$(brew --prefix);$(brew --prefix openssl@4 2>/dev/null || brew --prefix openssl)"
ninja -C "$WORK/out" install
echo "Built: $PREFIX/bin/sdl-freerdp"
