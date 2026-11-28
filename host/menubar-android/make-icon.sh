#!/bin/bash
# Regenerates AppIcon.icns from icon.svg (run after editing the SVG; the .icns is committed).
set -e
cd "$(dirname "$0")"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"

# AppKit rasterizes SVG natively, with transparency, so no extra tools are needed.
cat > "$TMP/render.swift" <<'SWIFT'
import AppKit
let args = CommandLine.arguments
guard let svg = NSImage(contentsOfFile: args[1]) else { fatalError("cannot read \(args[1])") }
for spec in args.dropFirst(3) {
    let parts = spec.split(separator: ":")
    let px = Int(parts[0])!
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: px, height: px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current!.imageInterpolation = .high
    svg.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!
        .write(to: URL(fileURLWithPath: "\(args[2])/\(parts[1])"))
}
SWIFT

swift "$TMP/render.swift" icon.svg "$ICONSET" \
    16:icon_16x16.png 32:icon_16x16@2x.png 32:icon_32x32.png 64:icon_32x32@2x.png \
    128:icon_128x128.png 256:icon_128x128@2x.png 256:icon_256x256.png 512:icon_256x256@2x.png \
    512:icon_512x512.png 1024:icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o AppIcon.icns
[ -n "$PREVIEW" ] && cp "$ICONSET/icon_512x512@2x.png" "$ICONSET/icon_32x32.png" "$PREVIEW/"
echo "Wrote $(pwd)/AppIcon.icns"
