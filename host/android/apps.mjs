// host/android/apps.mjs — which Android apps get a Mac launcher, and their icons.
//
// Source 1 (preferred): the RoboDinghy helper APK (guest-android/, package app.robodinghy.helper), an
// Instrumentation run with `am instrument -w -e size <px> app.robodinghy.helper/.Export`. It writes
// apps.json ([{label, package, activity, system}]) and <package>.png into its external files dir,
// which we pull with adb. `am instrument` exits 0 even on failure: success is read from the
// "INSTRUMENTATION_RESULT: RESULT=ok|error" lines (plus count= / dir= / message=), in any order.
// Source 2 (fallback): `scrcpy --list-apps` (names and packages, no icons).
//
// Exports:
//   findHelperApk(candidates)        first existing APK path, or null
//   helperInstalled(cfg)             true if the package is in the guest
//   ensureHelper(cfg, apk, stampFile) install/refresh the helper when the local APK changed (uninstalls first
//                                    on a signature mismatch); { ok, changed, message }
//   parseInstrumentation(out)        { ok, count, dir, message, code } from `am instrument -w` output
//   exportApps(cfg, { size, tmpDir }) [{ label, package, activity, system, png (Buffer|null) }]; throws
//   parseListApps(out)               [{ label, package, system }] from `scrcpy --list-apps`
//   listAppsFallback(cfg)            same via scrcpy; throws when scrcpy can't list
//   NOISE                            packages hidden when config filter=on (dev/test plumbing)
//   filterApps(apps, on)             { kept, hidden }
//   categoryOf(app)                  "tool" for system settings-like apps, else "app"

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as A from "./adb.mjs";
import { tools } from "./sdk.mjs";
import { scrcpyEnv } from "./scrcpy.mjs";
import { HELPER_PKG } from "./product.mjs";

const EXPORT_DIR = `/sdcard/Android/data/${HELPER_PKG}/files/export`;

export function findHelperApk(candidates) { return candidates.filter(Boolean).find(p => fs.existsSync(p)) ?? null; }

export function helperInstalled(cfg) {
    const out = A.shell(cfg, `pm list packages ${HELPER_PKG}`, { timeout: 20000 }) ?? "";
    return out.split("\n").some(l => l.trim() === `package:${HELPER_PKG}`);
}

const sha256 = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

export function ensureHelper(cfg, apk, stampFile) {
    if (!apk) return { ok: false, changed: false, message: "helper APK not built (guest-android/build.sh)" };
    const want = sha256(apk);
    let have = null;
    try { have = fs.readFileSync(stampFile, "utf8").trim(); } catch {}
    if (have === want && helperInstalled(cfg)) return { ok: true, changed: false };
    let r = A.install(cfg, apk);
    // Built by another checkout = signed with another debug key: replace it.
    if (!r.ok && /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(r.out)) { A.uninstall(cfg, HELPER_PKG); r = A.install(cfg, apk); }
    if (!r.ok) return { ok: false, changed: false, message: r.out.split("\n").slice(-2).join(" ") };
    try { fs.writeFileSync(stampFile, want); } catch {}
    return { ok: true, changed: true };
}

export function parseInstrumentation(out) {
    const kv = {};
    for (const l of String(out).split("\n")) { const m = l.match(/^INSTRUMENTATION_RESULT: (\w+)=(.*)$/); if (m) kv[m[1]] = m[2].trim(); }
    const code = Number(String(out).match(/^INSTRUMENTATION_CODE: (-?\d+)/m)?.[1] ?? NaN);
    return { ok: kv.RESULT === "ok", count: kv.count !== undefined ? Number(kv.count) : null, dir: kv.dir ?? null, message: kv.message ?? (kv.RESULT ? null : String(out).trim().split("\n").slice(-2).join(" ")), code };
}

export function exportApps(cfg, { size = 512, tmpDir }) {
    const r = A.adb(cfg, ["shell", "am", "instrument", "-w", "-e", "size", String(size), `${HELPER_PKG}/.Export`], { timeout: 180000 });
    const res = parseInstrumentation(r.stdout + r.stderr);
    if (!res.ok) throw new Error(`The helper couldn't list the apps: ${res.message ?? "no result"}`);
    const local = path.join(tmpDir, "export");
    fs.rmSync(local, { recursive: true, force: true });
    const p = A.pull(cfg, res.dir || EXPORT_DIR, tmpDir);
    if (!p.ok || !fs.existsSync(path.join(local, "apps.json"))) {
        // pull names the local folder after the remote one; fall back to the documented path
        const alt = A.pull(cfg, EXPORT_DIR, tmpDir);
        if (!alt.ok || !fs.existsSync(path.join(local, "apps.json"))) throw new Error(`Couldn't copy the app list from Android: ${(p.out || alt.out).split("\n").slice(-1)[0]}`);
    }
    const list = JSON.parse(fs.readFileSync(path.join(local, "apps.json"), "utf8"));
    return list.filter(a => a?.package && a?.label).map(a => {
        let png = null;
        try { png = fs.readFileSync(path.join(local, `${a.package}.png`)); } catch {}
        return { label: a.label, package: a.package, activity: a.activity ?? "", system: !!a.system, png };
    });
}

export function parseListApps(out) {
    const apps = [];
    for (const l of String(out).split("\n")) {
        const m = l.match(/^\s*([*-])\s+(.+?)\s{2,}([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\s*$/);
        if (m) apps.push({ label: m[2].trim(), package: m[3], system: m[1] === "*" });
    }
    return apps;
}

export function listAppsFallback(cfg) {
    const t = tools(cfg);
    if (!t.scrcpy) throw new Error("scrcpy isn't installed. Run: brew install scrcpy");
    const r = spawnSync(t.scrcpy, [`--serial=${A.serial(cfg)}`, "--list-apps"], { encoding: "utf8", env: scrcpyEnv(cfg), timeout: 120000 });
    const apps = parseListApps((r.stdout ?? "") + (r.stderr ?? ""));
    if (!apps.length) throw new Error(`scrcpy couldn't list the apps: ${((r.stderr || r.stdout) ?? "").trim().split("\n").slice(-1)[0]}`);
    return apps.map(a => ({ ...a, activity: "", png: null }));
}

// Developer/test plumbing shipped in emulator images: launchable, but nobody opens them as apps.
export const NOISE = new Set([
    "org.chromium.webview_shell",          // WebView Browser Tester
    "com.android.development",             // Dev Tools
    "com.android.development_settings",
    "com.android.customlocale2",           // Custom Locale
    "com.android.gesture.builder",
    "com.example.android.apis",            // API Demos
    "com.android.emulator.multidisplay",
    "com.android.stk",                     // SIM Toolkit
    "com.android.traceur",                 // System Tracing
    "com.android.camera.extensions.test",
    "com.google.android.apps.youtube.music.setupwizard",
]);

export function filterApps(apps, on) {
    if (!on) return { kept: apps, hidden: [] };
    const kept = [], hidden = [];
    for (const a of apps) (NOISE.has(a.package) || /\.(test|tests)$/.test(a.package) ? hidden : kept).push(a);
    return { kept, hidden };
}

export function categoryOf(app) {
    return /^com\.android\.settings$/.test(app.package) ? "tool" : "app";
}
