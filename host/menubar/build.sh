#!/bin/bash
# Builds the WinDinghy menu-bar app into ~/Applications/WinDinghy.app
set -e
cd "$(dirname "$0")"

APP="$HOME/Applications/WinDinghy.app"
REPO_ROOT="$(cd ../.. && pwd)"

echo "Compiling..."
swiftc -O -swift-version 5 main.swift -o winboat-menubar

echo "Assembling bundle at $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv winboat-menubar "$APP/Contents/MacOS/"
# Bundle a copy of wbm.mjs so Sync works even if the repo moves
cp "$REPO_ROOT/host/wbm.mjs" "$APP/Contents/Resources/wbm.mjs"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleName</key><string>WinDinghy</string>
    <key>CFBundleIdentifier</key><string>app.windinghy.menubar</string>
    <key>CFBundleExecutable</key><string>winboat-menubar</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>LSUIElement</key><true/>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force -s - "$APP" 2>/dev/null || true
echo "Done. Launch with: open '$APP'"
