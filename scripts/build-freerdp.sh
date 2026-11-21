#!/bin/bash
# Build the patched FreeRDP SDL client used by WinDinghy's native mode.
#   scripts/build-freerdp.sh                 # -> vendor/freerdp (gitignored), self-contained
#   WORK=/Volumes/SSD/build PREFIX=/Volumes/SSD/freerdp scripts/build-freerdp.sh
# Needs: brew install cmake ninja pkg-config sdl3 sdl3_ttf openssl uriparser jansson
#
# The default build is "lean": no ffmpeg/H.264 (RDP falls back to the progressive codec,
# fine for RemoteApp) so the result only needs a handful of libraries, which
# scripts/relocate-dylibs.py then copies next to the binary (no Homebrew needed to run it).
# LEAN=0 builds the full-featured variant (ffmpeg, USB redirection) against Homebrew.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$ROOT/vendor/build}"
PREFIX="${PREFIX:-$ROOT/vendor/freerdp}"
LEAN="${LEAN:-1}"
BASE="$(cat "$ROOT/patches/freerdp-base-commit.txt")"
mkdir -p "$WORK"
if [ ! -d "$WORK/src/.git" ]; then
  git init -q "$WORK/src"
  git -C "$WORK/src" remote add origin https://github.com/FreeRDP/FreeRDP.git
fi
cd "$WORK/src"
git fetch --quiet --depth 1 origin "$BASE"
git checkout --quiet -f FETCH_HEAD
git apply "$ROOT/patches/freerdp-sdl-macos-remoteapp.patch"

FLAGS=(-DWITH_CLIENT_SDL=ON -DWITH_CLIENT_SDL3=ON -DWITH_CLIENT_SDL2=OFF -DWITH_X11=OFF
  -DWITH_SERVER=OFF -DWITH_SHADOW=OFF -DWITH_PROXY=OFF -DWITH_SAMPLE=OFF -DWITH_MANPAGES=OFF
  -DWITH_CLIENT_MAC=OFF -DBUILD_TESTING=OFF -DWITH_PKCS11=OFF -DWITH_PCSC=OFF -DWITH_CUPS=ON -DCHANNEL_PRINTER_CLIENT=ON
  -DWITH_KRB5=OFF -DWITH_WEBVIEW=OFF -DWITH_AAD=OFF)
if [ "$LEAN" = "1" ]; then
  FLAGS+=(-DWITH_FFMPEG=OFF -DWITH_VIDEO_FFMPEG=OFF -DWITH_DSP_FFMPEG=OFF -DWITH_SWSCALE=OFF
          -DWITH_GFX_H264=OFF -DWITH_APPLE_VIDEOTOOLBOX=OFF -DCHANNEL_URBDRC=OFF)
else
  FLAGS+=(-DWITH_FFMPEG=ON)
fi
BREW="$(brew --prefix)"
OPENSSL="$(brew --prefix openssl@4 2>/dev/null || brew --prefix openssl)"
cmake -G Ninja -S . -B "$WORK/out" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  "${FLAGS[@]}" -DCMAKE_PREFIX_PATH="$BREW;$OPENSSL"
ninja -C "$WORK/out" install

if [ "$LEAN" = "1" ]; then
  python3 -I "$ROOT/scripts/relocate-dylibs.py" "$PREFIX"
fi
echo "Built: $PREFIX/bin/sdl-freerdp"
