// host/common/launchers.mjs — generated macOS launcher bundles (<appsDir>/<Name>.app), shared by
// dinghy (WinDinghy) and robodinghy.
//
// Bundle layout written by writeAppBundle:
//   Contents/Info.plist        CFBundleIdentifier <bundleIdPrefix><slug>, CFBundleExecutable launcher,
//                              CFBundleIconFile app (when an icon was made)
//   Contents/MacOS/launcher    bash: finds node, runs `node <cliPath> <subcommand> <Resources dir>`,
//                              else runs the product's fallback line
//   Contents/Resources/app.json  the app's metadata (the contract every consumer reads)
//   Contents/Resources/app.icns  from the PNG, or a copied default icon
//   Contents/Resources/<extra>   any extraResources files (WinDinghy: the fallback .rdp)
//
// Exports:
//   makeIcns(pngBase64, icnsPath, tmpDir, sizes=[16,32,128,256])  PNG -> .icns via sips + iconutil; true on success
//     (pass larger sizes, e.g. [16,32,64,128,256,512], for big source icons)
//   launcherScript({ nodeBin, cliPath, subcommand, header, fallback })  the launcher text.
//     header: comment line(s) after the shebang (each starting "# ", newline-terminated)
//     fallback: the final shell line, run when node or cliPath is missing
//     The `[ -n "$NODE" ] && [ -f "<cliPath>" ]` line is what staleLaunchers (and the Swift apps)
//     match: keep its shape.
//   writeAppBundle(product, { appsDir, dirName, displayName, meta, iconBase64, tmpDir,
//                             defaultIcons=[], extraResources={}, iconSizes })  -> the .app path
//     product: { bundleIdPrefix ("app.windinghy."), cliPath (the ENTRY script's own absolute path,
//                e.g. fileURLToPath(import.meta.url) in dinghy.mjs, never this module's), subcommand
//                ("open-rdp"), header, fallback (a shell line, or fn({dirName, displayName, meta}) -> line) }
//     meta defaults to { desktop: true }; defaultIcons: candidate .icns files copied when no PNG icon
//     could be made (first existing one wins); extraResources: { fileName: content } in Resources/
//   staleLaunchers(appsDir)           launcher names whose pinned node/CLI path no longer exists
//   sweepStale(appsDir, kept, onRemove?)  rm -rf every *.app in appsDir not in the `kept` Set
//                                     (basename "<Name>.app"); onRemove(entry) after each
//   removeLaunchers(appsDir)          uninstall: removes only bundles carrying Contents/Resources/app.json,
//                                     then rmdir appsDir if empty; never throws
//   findLauncher(appsDir, name)       "<Name>.app" entry matching name (case-insensitive exact, then
//                                     substring), or undefined
//   bumpUsage(configDir, name)        +1 for name in <configDir>/usage.json (menu-bar Favorites)

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function makeIcns(pngBase64, icnsPath, tmpDir, sizes = [16, 32, 128, 256]) {
    // Guest icons are 32x32 PNGs; upscale into a minimal iconset.
    const src = path.join(tmpDir, "src.png");
    fs.writeFileSync(src, Buffer.from(pngBase64, "base64"));
    const iconset = path.join(tmpDir, "app.iconset");
    fs.mkdirSync(iconset, { recursive: true });
    for (const s of sizes) {
        spawnSync("sips", ["-z", String(s), String(s), src, "--out", path.join(iconset, `icon_${s}x${s}.png`)], { stdio: "ignore" });
    }
    const r = spawnSync("iconutil", ["-c", "icns", iconset, "-o", icnsPath], { stdio: "ignore" });
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.rmSync(src, { force: true });
    return r.status === 0;
}

export function launcherScript({ nodeBin, cliPath, subcommand, header, fallback }) {
    return `#!/bin/bash
${header}DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)" "${nodeBin}"; do
    if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -n "$NODE" ] && [ -f "${cliPath}" ]; then
    exec "$NODE" "${cliPath}" ${subcommand} "$DIR"
fi
${fallback}
`;
}

export function writeAppBundle(product, { appsDir, dirName, displayName, meta, iconBase64, tmpDir, defaultIcons = [], extraResources = {}, iconSizes }) {
    const appPath = path.join(appsDir, `${dirName}.app`);
    const contents = path.join(appPath, "Contents");
    const macos = path.join(contents, "MacOS");
    const resources = path.join(contents, "Resources");
    fs.rmSync(appPath, { recursive: true, force: true });
    fs.mkdirSync(macos, { recursive: true });
    fs.mkdirSync(resources, { recursive: true });

    for (const [name, content] of Object.entries(extraResources)) fs.writeFileSync(path.join(resources, name), content);
    fs.writeFileSync(path.join(resources, "app.json"), JSON.stringify(meta ?? { desktop: true }, null, 2));

    let iconEntry = "";
    if (iconBase64 && makeIcns(iconBase64, path.join(resources, "app.icns"), tmpDir, iconSizes)) {
        iconEntry = "    <key>CFBundleIconFile</key>\n    <string>app</string>\n";
    } else {
        const own = defaultIcons.find(f => fs.existsSync(f));
        if (own) { fs.copyFileSync(own, path.join(resources, "app.icns")); iconEntry = "    <key>CFBundleIconFile</key>\n    <string>app</string>\n"; }
    }

    const bundleId = product.bundleIdPrefix + dirName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    fs.writeFileSync(
        path.join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleName</key>
    <string>${displayName.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>
    <key>CFBundleIdentifier</key>
    <string>${bundleId}</string>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
${iconEntry}    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
`);

    const launcher = path.join(macos, "launcher");
    // Never pin a versioned path (brew's Cellar/node/<version> disappears on upgrade/cleanup):
    // prefer the stable symlinks, then PATH, and use the recorded execPath only as a last resort.
    fs.writeFileSync(launcher, launcherScript({
        nodeBin: process.execPath,
        cliPath: product.cliPath,
        subcommand: product.subcommand,
        header: product.header,
        fallback: typeof product.fallback === "function" ? product.fallback({ dirName, displayName, meta }) : product.fallback,
    }));
    fs.chmodSync(launcher, 0o755);
    return appPath;
}

// Launchers generated by older versions pin an absolute node path (e.g. brew's Cellar/node/<version>)
// that disappears on upgrade; the launcher then runs its fallback. Mirrored in the Swift apps.
export function staleLaunchers(appsDir) {
    const bad = [];
    let entries = [];
    try { entries = fs.readdirSync(appsDir).filter(e => e.endsWith(".app")); } catch { return bad; }
    for (const e of entries) {
        let t;
        try { t = fs.readFileSync(path.join(appsDir, e, "Contents", "MacOS", "launcher"), "utf8"); } catch { continue; }
        const pinned = t.match(/-x "([^"]+)" \] && \[ -f "([^"]+)"/) || t.match(/\[ -n "\$NODE" \] && \[ -f "([^"]+)"/);
        if (!pinned) continue;
        const paths = pinned.slice(1);
        if (paths.some(p => !fs.existsSync(p))) bad.push(e);
    }
    return bad;
}

export function sweepStale(appsDir, kept, onRemove) {
    for (const entry of fs.readdirSync(appsDir)) {
        if (entry.endsWith(".app") && !kept.has(entry)) {
            fs.rmSync(path.join(appsDir, entry), { recursive: true, force: true });
            if (onRemove) onRemove(entry);
        }
    }
}

export function removeLaunchers(appsDir) {
    try {
        for (const n of fs.readdirSync(appsDir)) {
            const d = path.join(appsDir, n);
            if (n.endsWith(".app") && fs.existsSync(path.join(d, "Contents", "Resources", "app.json"))) fs.rmSync(d, { recursive: true, force: true });
        }
        try { fs.rmdirSync(appsDir); } catch {}
    } catch {}
}

export function findLauncher(appsDir, name) {
    const entries = fs.existsSync(appsDir) ? fs.readdirSync(appsDir).filter(e => e.endsWith(".app")) : [];
    return entries.find(e => e.toLowerCase() === `${name.toLowerCase()}.app`) ??
        entries.find(e => e.toLowerCase().includes(name.toLowerCase()));
}

// Local launch counts drive the menu-bar app's Favorites section.
export function bumpUsage(configDir, name) {
    const usagePath = path.join(configDir, "usage.json");
    let usage = {};
    try { usage = JSON.parse(fs.readFileSync(usagePath, "utf8")); } catch {}
    usage[name] = (usage[name] ?? 0) + 1;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(usagePath, JSON.stringify(usage, null, 2));
}
