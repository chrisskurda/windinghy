#!/bin/bash
# Builds the RoboDinghy menu-bar app (codename; identity in Product.swift) into
# ~/Applications/RoboDinghy.app. Override the destination with APP=/path/to/Some.app.
set -e
cd "$(dirname "$0")"

APP="${APP:-$HOME/Applications/RoboDinghy.app}"
REPO_ROOT="$(cd ../.. && pwd)"
# The version literal: `const VERSION = "x.y.z"` (or `export const …`) in the CLI entry, else in
# product.mjs, where the CLI keeps its identity.
VERSION=""
for f in "$REPO_ROOT/host/android/robodinghy.mjs" "$REPO_ROOT/host/android/product.mjs"; do
    if [ -z "$VERSION" ] && [ -f "$f" ]; then
        VERSION="$(sed -n 's/^\(export \)\{0,1\}const VERSION = "\([^"]*\)".*/\2/p' "$f" | head -1)"
    fi
done

# Compile into a temp dir so no build product lands in the source tree.
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

echo "Compiling..."
# The shared Swift kit (UI building blocks, CLI runner, config file, updater) is compiled in too.
swiftc -O -swift-version 5 main.swift Product.swift Store.swift MainWindow.swift Tools.swift ../common/swift/*.swift \
    -o "$BUILD/robodinghy-menubar"

echo "Assembling bundle at $APP"
rm -rf "$APP"
RES="$APP/Contents/Resources"
mkdir -p "$APP/Contents/MacOS" "$RES/android" "$RES/common"
mv "$BUILD/robodinghy-menubar" "$APP/Contents/MacOS/"
# App icon (regenerate from icon.svg with ./make-icon.sh) and the menu-bar glyph
cp AppIcon.icns menubar-icon.svg "$RES/"
# Bundle a copy of the CLI so the app keeps working if the repo moves. The repo layout is kept
# (Resources/android next to Resources/common) because host/android/*.mjs import ../common/*.mjs.
for f in "$REPO_ROOT"/host/android/*.mjs "$REPO_ROOT"/host/android/compat.json; do
    if [ -f "$f" ]; then cp "$f" "$RES/android/"; fi
done
for f in "$REPO_ROOT"/host/common/*.mjs; do
    if [ -f "$f" ]; then cp "$f" "$RES/common/"; fi
done
[ -f "$RES/android/robodinghy.mjs" ] || echo "Note: host/android/robodinghy.mjs not found; the app will need a checkout (or ROBODINGHY_PATH)."
# The helper APK (app list + icons export), when guest-android/build.sh has built it: next to the
# bundled CLI, and at the top of Resources.
HELPER="$REPO_ROOT/guest-android/build/robodinghy-helper.apk"
if [ -f "$HELPER" ]; then cp "$HELPER" "$RES/android/"; cp "$HELPER" "$RES/"; fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleName</key><string>RoboDinghy</string>
    <key>CFBundleIdentifier</key><string>app.robodinghy.menubar</string>
    <key>CFBundleExecutable</key><string>robodinghy-menubar</string>
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
