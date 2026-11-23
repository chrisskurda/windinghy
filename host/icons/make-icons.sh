#!/bin/bash
# Regenerates the committed .icns files from the SVGs here (run after editing one).
set -e
cd "$(dirname "$0")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/render.swift" <<'SWIFT'
import AppKit
let a = CommandLine.arguments
guard let svg = NSImage(contentsOfFile: a[1]) else { fatalError("cannot read \(a[1])") }
for spec in a.dropFirst(3) {
    let p = spec.split(separator: ":"); let px = Int(p[0])!
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: px, height: px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current!.imageInterpolation = .high
    svg.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(a[2])/\(p[1])"))
}
SWIFT
for svg in *.svg; do
    name="${svg%.svg}"; set="$TMP/$name.iconset"; mkdir -p "$set"
    swift "$TMP/render.swift" "$svg" "$set" 16:icon_16x16.png 32:icon_16x16@2x.png 32:icon_32x32.png 64:icon_32x32@2x.png 128:icon_128x128.png 256:icon_128x128@2x.png 256:icon_256x256.png 512:icon_256x256@2x.png 512:icon_512x512.png 1024:icon_512x512@2x.png
    iconutil -c icns "$set" -o "$name.icns"
    echo "Wrote $(pwd)/$name.icns"
done
