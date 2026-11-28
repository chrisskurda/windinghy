#!/bin/bash
# Builds the WinDinghy menu-bar app into ~/Applications/WinDinghy.app
set -e
cd "$(dirname "$0")"

APP="${APP:-$HOME/Applications/WinDinghy.app}"
REPO_ROOT="$(cd ../.. && pwd)"
VERSION="$(sed -n 's/^const VERSION = "\([^"]*\)".*/\1/p' ../dinghy.mjs)"

echo "Compiling..."
# The shared Swift kit (UI building blocks, CLI runner, config file, updater) is compiled in too.
swiftc -O -swift-version 5 main.swift Store.swift MainWindow.swift Tools.swift ../common/swift/*.swift -o windinghy-menubar

echo "Assembling bundle at $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv windinghy-menubar "$APP/Contents/MacOS/"
# App icon (regenerate from icon.svg with ./make-icon.sh)
cp AppIcon.icns menubar-icon.svg "$APP/Contents/Resources/"
# Bundle a copy of dinghy.mjs so Sync works even if the repo moves
cp "$REPO_ROOT"/host/*.mjs "$REPO_ROOT"/host/compat.json "$APP/Contents/Resources/"
# Modules shared with other CLIs (dinghy.mjs imports ./common/*.mjs). None yet is fine.
mkdir -p "$APP/Contents/Resources/common"
for f in "$REPO_ROOT"/host/common/*.mjs; do
    if [ -f "$f" ]; then cp "$f" "$APP/Contents/Resources/common/"; fi
done
cp "$REPO_ROOT"/host/icons/*.icns "$APP/Contents/Resources/"   # launcher icons (Windows Desktop)   # dinghy, guest, vm, qga, ps-worker, tested versions
# Guest payload (setup.ps1, guest server) so `dinghy setup` works from the app alone
ditto "$REPO_ROOT/payload" "$APP/Contents/Resources/payload"

# Native RDP client (patched FreeRDP): build the self-contained "lean" client once if it
# isn't there, then bundle it. Set SKIP_FREERDP=1 to skip (the app falls back to Windows App).
FREERDP="${FREERDP:-$REPO_ROOT/vendor/freerdp}"
if [ ! -x "$FREERDP/bin/sdl-freerdp" ] && [ "${SKIP_FREERDP:-0}" != "1" ]; then
    echo "Building the native RDP client (one time, a few minutes)..."
    "$REPO_ROOT/scripts/build-freerdp.sh" || echo "Native client build failed; continuing without it."
fi
if [ -x "$FREERDP/bin/sdl-freerdp" ]; then
    echo "Bundling the native RDP client"
    mkdir -p "$APP/Contents/Resources/freerdp"
    ditto "$FREERDP/bin" "$APP/Contents/Resources/freerdp/bin"
    mkdir -p "$APP/Contents/Resources/freerdp/lib"
    for f in "$FREERDP"/lib/*.dylib; do ditto "$f" "$APP/Contents/Resources/freerdp/lib/$(basename "$f")"; done
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleName</key><string>WinDinghy</string>
    <key>CFBundleIdentifier</key><string>app.windinghy.menubar</string>
    <key>CFBundleExecutable</key><string>windinghy-menubar</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleShortVersionString</key><string>${VERSION:-0.0.0}</string>
    <key>LSUIElement</key><true/>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force -s - "$APP" 2>/dev/null || true
# A rebuilt bundle keeps its path but changes contents, and Launch Services can keep serving the old
# (or a generic) icon. Re-register it and bump the folder's modification time.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
touch "$APP"
echo "Done. Launch with: open '$APP'"
