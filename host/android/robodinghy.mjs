#!/usr/bin/env node
// robodinghy — RoboDinghy host CLI (codename; identity in ./product.mjs).
// Runs Android apps on the Mac: a headless Google Android Emulator VM, and one scrcpy window per app
// (an Android virtual display each) behind generated ~/Applications/RoboDinghy/*.app launchers.
// Sibling of dinghy (WinDinghy) and built the same way: zero dependencies, shared plumbing in
// ../common/, the VM backend in ./avd.mjs. Conventions: errors "Error: <msg>" on stderr + exit 1;
// --json prints one JSON line last; --progress prints PROGRESS:<pct>:<title>; "==> step" lines;
// "WARN: msg" lines for problems the caller should surface.
//
// Commands (see `robodinghy help`): setup, status, sync, launch, desktop, open-app, install, pkg,
// edition, vm, config, about, doctor, fix, permissions, update, uninstall, version.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as P from "./product.mjs";
import * as SDK from "./sdk.mjs";
import * as A from "./adb.mjs";
import * as AVD from "./avd.mjs";
import * as S from "./scrcpy.mjs";
import * as APPS from "./apps.mjs";
import * as FD from "./fdroid.mjs";
import { macIcon, genericIcon } from "./icons.mjs";
// Shared plumbing (also used by dinghy). In the app bundle these sit in Contents/Resources/common/,
// one level up from this file (Contents/Resources/android/), as in the checkout.
import { say, stepSay, waitFor, safeName, makeProgress, runUpdater, hasFlag, positional, optValue } from "../common/cli.mjs";
import { asDialog, asq, notify as notifyTitled, showError as showErrorTitled } from "../common/macos.mjs";
import { makeConfig, sanitizer, checkConfigValue, coerceConfigValue } from "../common/config.mjs";
import { makeAppManagement } from "../common/permissions.mjs";
import * as L from "../common/launchers.mjs";
import { loadCompat, aboutRow, printAbout } from "../common/about.mjs";
import { makeDoctor } from "../common/doctor.mjs";

const { VERSION, NAME, CLI, CONFIG_DIR, CONFIG_PATH, LOG_DIR } = P;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// host/android/ in a checkout; Contents/Resources/android/ in the app bundle.
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// ---------- config ----------

const DEFAULTS = {
    edition: "play",          // play (Google Play image) | aosp (plain Android + F-Droid)
    image: "",                // advanced: a custom SDK system-image id (overrides edition)
    apiLevel: P.DEFAULT_API,
    sdkRoot: "",              // advanced: Android SDK to use (default: found automatically)
    vmCpus: 4, vmRamGB: AVD.MIN_RAM_GB, vmDiskGB: 16,   // applied the next time Android starts (the disk only grows;
                              // the emulator gives the guest at least 4 GB whatever vmRamGB says)
    vmDir: "",                // where the VM lives (default ~/Library/Application Support/RoboDinghy)
    consolePort: P.CONSOLE_PORT,
    displayDpi: 240,          // app windows: Android virtual display density and starting size
    windowSize: "1280x800",
    shareClipboard: "on", shareAudio: "on",
    videoCodec: "h264", maxFps: 60,
    vmAutoStart: "on",        // start Android when RoboDinghy opens
    vmStartDelaySec: 30,      // ...after this delay when RoboDinghy opens at login
    vmOnQuit: "save",         // when RoboDinghy quits: save | shutdown | keep
    vmIdleAction: "off",      // after vmIdleMinutes with no Android windows open: off | pause | save | shutdown
    vmIdleMinutes: 15,
    vmMinFreeGB: 2,           // free space kept on the VM's disk; a saved state needs this plus the VM's RAM
    advanced: "off",          // on: unlock unsupported setups (custom images, another SDK, ports)
    filter: "on",             // sync hides developer/test plumbing apps
    appsDir: P.APPS_DIR,
};

const ENUMS = {
    edition: ["play", "aosp"], shareClipboard: ["on", "off"], shareAudio: ["on", "off"],
    videoCodec: ["h264", "h265", "av1"], vmAutoStart: ["on", "off"], vmOnQuit: ["save", "shutdown", "keep"],
    vmIdleAction: ["off", "pause", "save", "shutdown"], advanced: ["on", "off"], filter: ["on", "off"],
};
const NUMBERS = [
    ["vmStartDelaySec", 0, 600], ["vmIdleMinutes", 1, 1440], ["vmMinFreeGB", 0, 2000],
    ["vmCpus", 1, 16], ["vmRamGB", 2, 32], ["vmDiskGB", 8, 1024],
    ["displayDpi", 100, 640], ["maxFps", 0, 240], ["consolePort", 5554, 5584],
];
const WINDOW_SIZE = /^\d{3,4}x\d{3,4}$/;
const expand = p => path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir()));

// appsDir is swept on every sync (stale launchers removed), so it must be a folder of its own: never a
// shared Applications folder, the home folder, or another product's launcher folder.
function appsDirProblem(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "appsDir can't be empty";
    if (!raw.startsWith("/") && !raw.startsWith("~")) return `appsDir must be an absolute path (like ${P.APPS_DIR})`;
    const d = expand(raw);
    const home = os.homedir();
    const shared = ["/", "/Applications", "/System/Applications", "/Users", home, path.join(home, "Applications"), path.join(home, "Applications", "WinDinghy"),
        path.join(home, "Desktop"), path.join(home, "Documents"), path.join(home, "Downloads"), path.join(home, "Library"), CONFIG_DIR];
    if (shared.includes(d) || d === path.dirname(CONFIG_DIR)) return `appsDir can't be ${d}: ${NAME} removes launchers it no longer needs from it, so give it a folder of its own (default ${P.APPS_DIR})`;
    return null;
}
function vmDirProblem(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;   // default location
    if (!raw.startsWith("/") && !raw.startsWith("~")) return `vmDir must be an absolute path (like ${P.VM_DIR})`;
    return null;
}
const ADVANCED_KEYS = ["image", "sdkRoot", "consolePort", "apiLevel"];

function sanitizeConfig(cfg) {
    const { notes, fix, oneOf, numbers } = sanitizer(cfg, DEFAULTS);
    for (const [k, vals] of Object.entries(ENUMS)) oneOf(k, vals);
    numbers(NUMBERS);
    fix(cfg.consolePort % 2 !== 0, `consolePort must be even -> ${DEFAULTS.consolePort}`, () => { cfg.consolePort = DEFAULTS.consolePort; });
    fix(!WINDOW_SIZE.test(String(cfg.windowSize)), `bad windowSize "${cfg.windowSize}" -> ${DEFAULTS.windowSize}`, () => { cfg.windowSize = DEFAULTS.windowSize; });
    for (const k of ["image", "sdkRoot", "vmDir", "apiLevel"]) fix(typeof cfg[k] !== "string", `${k} wasn't text -> default`, () => { cfg[k] = DEFAULTS[k]; });
    fix(!cfg.apiLevel, `empty apiLevel -> ${DEFAULTS.apiLevel}`, () => { cfg.apiLevel = DEFAULTS.apiLevel; });
    fix(typeof cfg.appsDir !== "string" || !cfg.appsDir, "appsDir reset", () => { cfg.appsDir = DEFAULTS.appsDir; });
    const ap = appsDirProblem(cfg.appsDir);
    fix(!!ap, `bad appsDir "${cfg.appsDir}" (it must be an absolute folder of its own) -> ${DEFAULTS.appsDir}`, () => { cfg.appsDir = DEFAULTS.appsDir; });
    fix(cfg.appsDir !== expand(cfg.appsDir), `appsDir ${cfg.appsDir} -> ${expand(cfg.appsDir)}`, () => { cfg.appsDir = expand(cfg.appsDir); });
    const vp = vmDirProblem(cfg.vmDir);
    fix(!!vp, `bad vmDir "${cfg.vmDir}" (not an absolute path) -> default`, () => { cfg.vmDir = ""; });
    fix(!!cfg.vmDir && cfg.vmDir !== expand(cfg.vmDir), `vmDir ${cfg.vmDir} -> ${expand(cfg.vmDir)}`, () => { cfg.vmDir = expand(cfg.vmDir); });
    fix(cfg.sdkRoot && !fs.existsSync(cfg.sdkRoot), `sdkRoot ${cfg.sdkRoot} no longer exists -> find it automatically`, () => { cfg.sdkRoot = ""; });
    return notes;
}

// The VM on disk is the truth for edition/apiLevel: after a lost or reset config.json the defaults
// ("play") would otherwise describe an AOSP VM as a Play one (wrong image, F-Droid disabled, ...).
// Only the two stock images are recognised; a custom `image` is left alone.
function reconcileWithAvd(cfg, save) {
    if (cfg.image) return;
    let ini;
    try { ini = fs.readFileSync(AVD.files(cfg).config, "utf8"); } catch { return; }
    const m = ini.match(/^image\.sysdir\.1\s*=\s*system-images\/android-([^/]+)\/([^/]+)\//m);
    if (!m) return;
    const edition = { google_apis_playstore: "play", default: "aosp" }[m[2]];
    if (!edition) return;
    const notes = [];
    if (cfg.edition !== edition) { notes.push(`edition "${cfg.edition}" -> ${edition} (matches the Android VM)`); cfg.edition = edition; }
    if (cfg.apiLevel !== m[1]) { notes.push(`apiLevel "${cfg.apiLevel}" -> ${m[1]} (matches the Android VM)`); cfg.apiLevel = m[1]; }
    if (!notes.length) return;
    for (const n of notes) console.error(`${P.LOG_PREFIX} repaired settings: ${n}`);
    try { save(cfg); } catch {}
}
const configFile = makeConfig({ path: CONFIG_PATH, defaults: DEFAULTS, logPrefix: P.LOG_PREFIX, sanitize: sanitizeConfig, postLoad: reconcileWithAvd });
const loadConfig = () => configFile.load();
const saveConfig = cfg => configFile.save(cfg);

const isAdvanced = cfg => cfg.advanced === "on";
function needAdvanced(cfg, what) {
    if (isAdvanced(cfg)) return;
    throw new Error(`${what} is an advanced option and isn't supported. ${NAME}'s supported setup is the Google Play or AOSP edition it installs itself. If you know what you're doing: ${CLI} config advanced on`);
}

const notify = msg => notifyTitled(NAME, msg);
// Also printed, so `robodinghy launch` in a terminal says why it failed (launchers have no terminal).
const showError = (title, message, logFile) => { console.error(`Error: ${title}: ${message}`); showErrorTitled(`${NAME}: ${title}`, message, logFile); };
const appMgmt = makeAppManagement({ appName: NAME, configDir: CONFIG_DIR, preferBinary: "scrcpy" });
const bumpUsage = name => L.bumpUsage(CONFIG_DIR, name);
const fdroidDir = () => path.join(CONFIG_DIR, "fdroid");
const isPlay = cfg => /google_apis_playstore|playstore/.test(SDK.imageId(cfg));

// ---------- launchers ----------

const LAUNCHER_HEADER = `# Generated by ${CLI} sync. Opens the Android app in its own window through ${CLI}\n# (starts the Android VM if needed).\n`;
const LAUNCHER_FALLBACK = `exec osascript -e 'display alert "${NAME}" message "${NAME} or node has moved. Open ${NAME} and choose Sync, or run: ${CLI} sync"'`;

function writeLauncher(cfg, dirName, displayName, meta, png, tmpDir) {
    return L.writeAppBundle({
        bundleIdPrefix: P.BUNDLE_ID_PREFIX, cliPath: __filename, subcommand: "open-app",
        header: LAUNCHER_HEADER, fallback: LAUNCHER_FALLBACK,
    }, {
        appsDir: cfg.appsDir, dirName, displayName, meta, tmpDir,
        iconBase64: png ? png.toString("base64") : null, iconSizes: [16, 32, 128, 256, 512],
    });
}

// Launcher folder / log file name for an Android label. Labels come from any installed app and may be
// huge or carry control characters; a file name can hold 255 bytes, and Info.plist no control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const cleanLabel = label => String(label ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
function launcherName(label, fallback = "") {
    let n = safeName(cleanLabel(label)).replace(/^\.+/, "").trim();
    const bytes = t => Buffer.byteLength(t.normalize("NFD"));   // HFS+ stores names decomposed (longer)
    if (bytes(n) > 200) {
        let out = "";
        for (const ch of n) { if (bytes(out + ch) > 200) break; out += ch; }
        n = out.trim();
    }
    return n || (fallback ? launcherName(fallback) : "");
}

// A bundle sync made: has our app.json and a launcher bundle id (app.robodinghy.<slug>). Only these are
// ever removed from appsDir, whatever else lives there.
function isOwnLauncher(appPath) {
    if (!fs.existsSync(path.join(appPath, "Contents", "Resources", "app.json"))) return false;
    try {
        const id = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8").match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? "";
        return id.startsWith(P.BUNDLE_ID_PREFIX) && id !== `${P.BUNDLE_ID_PREFIX}menubar`;
    } catch { return false; }
}
function sweepOwnStale(appsDir, kept, onRemove) {
    for (const entry of fs.readdirSync(appsDir)) {
        if (!entry.endsWith(".app") || kept.has(entry)) continue;
        const p = path.join(appsDir, entry);
        if (!isOwnLauncher(p)) continue;
        fs.rmSync(p, { recursive: true, force: true });
        onRemove?.(entry);
    }
}
function removeOwnLaunchers(appsDir) {
    try { sweepOwnStale(appsDir, new Set()); } catch {}
    try { fs.rmdirSync(appsDir); } catch {}
}

const helperApk = () => APPS.findHelperApk([
    path.join(__dirname, P.HELPER_APK),                                   // bundled next to this file
    path.join(__dirname, "..", P.HELPER_APK),                             // ...or in Resources/
    path.join(PROJECT_ROOT, "guest-android", "build", P.HELPER_APK),      // built in a checkout
]);

const appsCachePath = () => path.join(CONFIG_DIR, "apps-cache.json");   // package -> label, from the last sync

// ---------- the VM, booted ----------

// Start Android if needed and wait until it has finished booting. Throws with the reason.
async function ensureBooted(cfg, { quiet = false, progress = () => {} } = {}) {
    if (!AVD.exists(cfg)) throw new Error(`No ${NAME} Android VM yet. Run: ${CLI} setup`);
    if (AVD.isRunning(cfg) && AVD.isPaused(cfg)) { AVD.resume(cfg); if (!quiet) say("Resumed."); }
    if (!AVD.isRunning(cfg)) {
        const { restoring } = AVD.start(cfg);
        if (!quiet) say(restoring ? "Restoring Android from its saved state..." : "Starting Android...");
    }
    const t0 = Date.now();
    let unauthorizedSince = 0, foreign = false;
    const ok = await A.waitBoot(cfg, 300, () => {
        progress((Date.now() - t0) / 1000);
        if (!AVD.isRunning(cfg)) return false;
        const st = A.state(cfg);
        // Google Play images only accept the adb key the emulator was started with (~/.android/adbkey.pub).
        if (st === "unauthorized") { unauthorizedSince ||= Date.now(); if (Date.now() - unauthorizedSince > 60000) return false; }
        else unauthorizedSince = 0;
        // Never treat another emulator that answers as emulator-<port> as ours.
        if (st && AVD.isOurs(cfg) === false) { foreign = true; return false; }
        return true;
    });
    if (!ok) {
        if (foreign) throw new Error(`Another Android emulator (${A.avdName(cfg) ?? "not " + P.AVD_NAME}) answers as ${A.serial(cfg)}. Quit it, or (advanced) give ${NAME} another port: ${CLI} config consolePort <5554-5584>`);
        if (!AVD.isRunning(cfg)) throw new Error(`The Android Emulator stopped while starting. See ${AVD.files(cfg).log}`);
        // Google Play images trust only the adb key they first booted with (kept in Android's /data).
        if (unauthorizedSince) throw new Error(`Android doesn't trust this Mac's adb key. Google Play images only accept the key from their first start (~/.android/adbkey): if that file was replaced, restore it, or reset Android (${CLI} vm destroy --yes, then ${CLI} setup).`);
        throw new Error("Android didn't finish starting in 5 minutes.");
    }
    AVD.finishStart(cfg);
    return true;
}

function psStats(pid) {
    if (!pid) return { cpu: null, ramMB: null };
    const r = spawnSync("ps", ["-o", "%cpu=,rss=", "-p", String(pid)], { encoding: "utf8" });
    const [cpu, rss] = (r.stdout ?? "").trim().split(/\s+/).map(Number);
    return { cpu: Number.isFinite(cpu) ? cpu : null, ramMB: Number.isFinite(rss) ? Math.round(rss / 1024) : null };
}

// ---------- status ----------

function statusInfo(cfg) {
    const t = SDK.tools(cfg);
    const img = SDK.imageInfo(cfg);
    const f = AVD.files(cfg);
    const exists = AVD.exists(cfg);
    const pid = AVD.pidOf(cfg);
    const running = pid !== null;
    const paused = running && AVD.isPaused(cfg);
    const adbState = running ? A.state(cfg) : null;
    const booted = running && !paused && adbState === "device" && A.getprop(cfg, "sys.boot_completed") === "1";
    const { cpu, ramMB } = psStats(pid);
    return {
        exists, running, paused, booted,
        saved: exists && !running && AVD.hasState(cfg),
        edition: cfg.image ? "custom" : cfg.edition,
        android: booted ? A.getprop(cfg, "ro.build.version.release") : null,
        api: (booted ? A.getprop(cfg, "ro.build.version.sdk_full") ?? A.getprop(cfg, "ro.build.version.sdk") : null) ?? img.api ?? null,
        image: img.id,
        serial: A.serial(cfg),
        pid, cpu, ramMB,
        appsOpen: S.openWindows(cfg).length,
        emulator: t.ok.emulator,
        adb: adbState === "device",
        scrcpy: t.ok.scrcpy,
        helper: booted ? APPS.helperInstalled(cfg) : null,
        avdDir: f.avd,
        vmDir: f.dir,
    };
}

function cmdStatus(cfg, json) {
    const s = statusInfo(cfg);
    if (json) { console.log(JSON.stringify(s)); return; }
    if (!s.exists) { say(`No ${NAME} Android VM yet. Run: ${CLI} setup`); return; }
    say(`Android (${s.edition}, ${s.image}): ${s.running ? (s.paused ? "paused" : s.booted ? `running, Android ${s.android}` : "starting") : s.saved ? "stopped, with its state saved" : "stopped"}`);
    if (s.running) say(`  emulator pid ${s.pid}  CPU ${s.cpu ?? "?"}%  RAM ${s.ramMB ?? "?"} MB  serial ${s.serial}`);
    say(`  windows open: ${s.appsOpen}`);
    say(`  adb ${s.adb ? "connected" : "not connected"}, scrcpy ${s.scrcpy ? "installed" : "MISSING"}, helper ${s.helper === null ? "?" : s.helper ? "installed" : "not installed"}`);
    say(`  AVD: ${s.avdDir}`);
}

// ---------- sync ----------

async function cmdSync(cfg, { quiet = false } = {}) {
    await appMgmt.ensure(cfg.appsDir);
    await ensureBooted(cfg, { quiet });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "robodinghy-icons-"));
    try {
        let apps = null, source = "";
        const apk = helperApk();
        if (apk) {
            const h = APPS.ensureHelper(cfg, apk, AVD.files(cfg).helperStamp);
            if (h.changed) say("Installed the RoboDinghy helper in Android.");
            if (!h.ok) say(`WARN: couldn't install the helper APK (${h.message}); apps get a generic icon.`);
            else {
                try { apps = APPS.exportApps(cfg, { size: 512, tmpDir }); source = "helper"; }
                catch (e) { say(`WARN: ${e.message}; falling back to scrcpy's app list (generic icons).`); }
            }
        } else say(`WARN: the helper APK isn't built (guest-android/build.sh), so apps get a generic icon.`);
        if (!apps) { apps = APPS.listAppsFallback(cfg); source = "scrcpy"; }
        say(`Android reports ${apps.length} apps${source === "scrcpy" ? " (via scrcpy)" : ""}`);

        const { kept: shown, hidden } = APPS.filterApps(apps, cfg.filter !== "off");
        if (hidden.length) say(`Filtered ${hidden.length} developer/test entries (disable with: ${CLI} config filter off)`);

        fs.mkdirSync(cfg.appsDir, { recursive: true });
        const kept = new Set();
        const byName = new Map();
        for (const a of shown) { const key = launcherName(a.label, a.package); if (key && !byName.has(key) && key !== P.DESKTOP_NAME) byName.set(key, a); }
        const fallbackIcon = genericIcon("app", 512);
        let made = 0;
        for (const [key, a] of byName) {
            const label = cleanLabel(a.label) || a.package;
            const meta = { Name: label, Package: a.package, Activity: a.activity ?? "", System: !!a.system, Category: APPS.categoryOf(a) };
            // One odd app (a name the file system refuses, ...) mustn't fail the whole sync.
            try { kept.add(path.basename(writeLauncher(cfg, key, label, meta, a.png ? macIcon(a.png) : fallbackIcon, tmpDir))); made++; }
            catch (e) { if (e.code === "EPERM" || e.code === "EACCES") throw e; say(`WARN: skipped ${a.package}: ${e.message}`); }
        }
        kept.add(path.basename(writeLauncher(cfg, P.DESKTOP_NAME, P.DESKTOP_NAME, { desktop: true, Name: P.DESKTOP_NAME }, genericIcon("desktop", 512), tmpDir)));
        sweepOwnStale(cfg.appsDir, kept, entry => say(`  removed stale ${entry}`));
        try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(appsCachePath(), JSON.stringify(Object.fromEntries(apps.map(a => [a.package, a.label])))); } catch {}
        say(`Synced ${made} apps -> ${cfg.appsDir}`);
        if (!quiet) say(`Launch from Spotlight, Finder, or: ${CLI} launch "<name>"`);
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
}

// ---------- opening apps (the launchers' target) ----------

async function cmdOpenApp(cfg, bundleDir) {
    if (!bundleDir) throw new Error(`Usage: ${CLI} open-app <launcher Resources dir>`);
    const meta = JSON.parse(fs.readFileSync(path.join(bundleDir, "app.json"), "utf8"));
    const name = meta.Name ?? P.DESKTOP_NAME;
    if (!AVD.exists(cfg)) { notify(`Android isn't set up yet. Open ${NAME} to set it up.`); process.exit(1); }
    if (!(AVD.isRunning(cfg) && !AVD.isPaused(cfg) && A.booted(cfg))) {
        notify(`Starting Android for ${name}…`);
        try { await ensureBooted(cfg, { quiet: true }); }
        catch (e) { showError("Android didn't start", e.message, AVD.files(cfg).log); process.exit(1); }
    }
    // scrcpy would open an empty window for an app that's gone: say so instead.
    if (!meta.desktop && meta.Package && !A.shell(cfg, `pm path ${meta.Package}`, { timeout: 15000 })) {
        showError("App not found", `${name} (${meta.Package}) isn't installed in Android any more. Refresh your apps: open ${NAME} and choose Sync, or run: ${CLI} sync`);
        process.exit(1);
    }
    const logFile = path.join(LOG_DIR, `${launcherName(name, meta.Package ?? "app")}.log`);
    bumpUsage(name);
    let res;
    try { res = await S.openWindow(cfg, meta, bundleDir, { logFile, onError: e => appMgmt.hint(e) }); }
    catch (e) { showError(`Couldn't open ${name}`, e.message, fs.existsSync(logFile) ? logFile : undefined); process.exit(1); }   // launchers have no terminal
    // Android was stopped, saved or paused while the window was open: the window closing is expected.
    const vmGone = !AVD.isRunning(cfg) || AVD.isPaused(cfg);
    const problem = vmGone ? null : S.diagnose(res.code, res.log, res.elapsedSec);
    if (problem) showError(problem.title, problem.message, logFile);
}

async function cmdLaunch(cfg, name) {
    if (!name) throw new Error(`Usage: ${CLI} launch "<app name>"`);
    const match = L.findLauncher(cfg.appsDir, name);
    if (!match) {
        if (name === P.DESKTOP_NAME) {   // not synced yet: open the desktop without a launcher
            say(`Opening ${P.DESKTOP_NAME} ...`);
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "robodinghy-desktop-"));
            fs.writeFileSync(path.join(tmp, "app.json"), JSON.stringify({ desktop: true, Name: P.DESKTOP_NAME }));
            try { await cmdOpenApp(cfg, tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
            return;
        }
        throw new Error(`No synced app matches "${name}". Run: ${CLI} sync`);
    }
    say(`Launching ${match.replace(/\.app$/, "")} ...`);
    await cmdOpenApp(cfg, path.join(cfg.appsDir, match, "Contents", "Resources"));
}

// ---------- software ----------

async function cmdInstall(cfg, file) {
    if (!file) throw new Error(`Usage: ${CLI} install <file.apk>`);
    const apk = path.resolve(file.replace(/^~(?=\/|$)/, os.homedir()));
    if (!fs.existsSync(apk)) throw new Error(`No such file: ${apk}`);
    await ensureBooted(cfg);
    say(`Installing ${path.basename(apk)} ...`);
    const r = A.install(cfg, apk);
    if (!r.ok) throw new Error(`Android refused the APK: ${r.out.split("\n").slice(-1)[0]}`);
    say("Installed. Refreshing your app list...");
    await cmdSync(cfg, { quiet: true });
}

const validPkgId = id => /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(String(id ?? ""));

async function installFromFdroid(cfg, index, id, { progress = () => {} } = {}) {
    const sdk = Number(A.getprop(cfg, "ro.build.version.sdk")) || 99;
    const ver = FD.bestVersion(index.packages[id], sdk);
    if (!ver) throw new Error(`F-Droid has no version of ${id} for this Android (API ${sdk}, arm64).`);
    say(`Downloading ${index.packages[id].n} ${ver.name} (${(ver.size / 1e6).toFixed(1)} MB) from F-Droid...`);
    const apk = await FD.download(fdroidDir(), ver, { onPct: p => progress(p) });
    say("Checksum OK. Installing...");
    const r = A.install(cfg, apk);
    if (!r.ok) throw new Error(`Android refused ${id}: ${r.out.split("\n").slice(-1)[0]}`);
    return ver;
}

function installedPackages(cfg, index) {
    let labels = {};
    try { labels = JSON.parse(fs.readFileSync(appsCachePath(), "utf8")); } catch {}
    return A.packages(cfg, { thirdParty: true }).filter(p => p.id !== P.HELPER_PKG).map(p => {
        const fd = index?.packages[p.id];
        const best = fd ? FD.bestVersion(fd) : null;
        return {
            id: p.id,
            name: labels[p.id] ?? fd?.n ?? p.id,
            version: A.versionName(cfg, p.id) ?? String(p.versionCode ?? ""),
            available: best && p.versionCode !== null && best.code > p.versionCode ? best.name : null,
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

async function cmdPkg(cfg, args) {
    const sub = args[0];
    const json = hasFlag(args, "--json");
    const rest = positional(args.slice(1));
    const aosp = !isPlay(cfg);
    const out = (rows, line) => { if (json) console.log(JSON.stringify(rows)); else if (!rows.length) say("Nothing found."); else for (const r of rows) say(line(r)); };
    if (sub === "search") {
        const q = rest.join(" ").trim();
        if (!q) throw new Error(`Usage: ${CLI} pkg search <text>`);
        if (!aosp) { say("WARN: the Google Play edition gets its apps from the Play Store: open Play Store from your apps."); if (json) console.log("[]"); return; }
        const index = await FD.loadIndex(fdroidDir(), { say: m => json ? console.error(m) : say(m) });
        let installed = new Set();
        if (AVD.isRunning(cfg) && A.booted(cfg)) installed = new Set(A.packages(cfg, { thirdParty: true }).map(p => p.id));
        const rows = FD.search(index, q).map(h => ({ ...h, available: null, installed: installed.has(h.id) }));
        out(rows, p => `${p.id.padEnd(44)} ${String(p.version).padEnd(14)} ${p.name}${p.installed ? "  (installed)" : ""}`);
    } else if (sub === "list") {
        await ensureBooted(cfg, { quiet: json });
        let index = null;
        if (aosp) { try { index = await FD.loadIndex(fdroidDir(), { say: m => json ? console.error(m) : say(m) }); } catch (e) { say(`WARN: ${e.message} (update checks skipped)`); } }
        out(installedPackages(cfg, index), p => `${p.id.padEnd(44)} ${String(p.version).padEnd(14)} ${p.available ? "-> " + p.available : ""}`);
    } else if (sub === "install") {
        const id = rest[0];
        if (!validPkgId(id)) throw new Error(`Usage: ${CLI} pkg install <package id>   (e.g. org.mozilla.fennec_fdroid)`);
        if (!aosp) throw new Error("The Google Play edition installs apps from the Play Store (open Play Store from your apps), or use: robodinghy install <file.apk>");
        const index = await FD.loadIndex(fdroidDir(), { say });
        if (!index.packages[id]) throw new Error(`F-Droid has no package "${id}". Search with: ${CLI} pkg search <text>`);
        await ensureBooted(cfg);
        const progress = makeProgress(hasFlag(args, "--progress"));
        progress(1, "Downloading…");
        const ver = await installFromFdroid(cfg, index, id, { progress: p => progress(p * 0.8, "Downloading…") });
        progress(90, "Adding it to your apps…");
        say(`Installed ${index.packages[id].n} ${ver.name}. Refreshing your app list...`);
        await cmdSync(cfg, { quiet: true });
        progress(100, "Done");
    } else if (sub === "uninstall") {
        const id = rest[0];
        if (!validPkgId(id)) throw new Error(`Usage: ${CLI} pkg uninstall <package id>`);
        await ensureBooted(cfg);
        const r = A.uninstall(cfg, id);
        if (!r.ok) throw new Error(`Couldn't uninstall ${id}: ${r.out.split("\n").slice(-1)[0]}`);
        say(`Uninstalled ${id}. Refreshing your app list...`);
        await cmdSync(cfg, { quiet: true });
    } else if (sub === "upgrade") {
        if (!aosp) { say("WARN: the Google Play edition updates apps through the Play Store."); return; }
        const index = await FD.loadIndex(fdroidDir(), { say, refresh: true });
        await ensureBooted(cfg);
        let todo = installedPackages(cfg, index).filter(p => p.available);
        if (rest[0]) {
            if (!validPkgId(rest[0])) throw new Error(`Usage: ${CLI} pkg upgrade [package id]`);
            todo = todo.filter(p => p.id === rest[0]);
        }
        if (!todo.length) { say("Everything is up to date."); return; }
        let failed = 0;
        for (const p of todo) {
            try { await installFromFdroid(cfg, index, p.id); say(`Upgraded ${p.name} ${p.version} -> ${p.available}`); }
            catch (e) { failed++; say(`WARN: ${e.message}`); }
        }
        if (failed) process.exitCode = 1;
        await cmdSync(cfg, { quiet: true });
    } else {
        throw new Error(`Usage: ${CLI} pkg <search|list|install|uninstall|upgrade> [--json] ...`);
    }
}

// ---------- setup ----------

// The official F-Droid client: downloaded from f-droid.org, installed only if signed by F-Droid's key.
async function installFdroidClient(cfg) {
    const pm = A.packages(cfg).map(p => p.id);
    if (!pm.includes(P.FDROID_PKG)) {
        fs.mkdirSync(fdroidDir(), { recursive: true });
        const apk = path.join(fdroidDir(), "F-Droid.apk");
        say("    Downloading the F-Droid app from f-droid.org...");
        await SDK.downloadFile(P.FDROID_APK_URL, apk, { timeoutMs: 600000 });
        const v = FD.verifyApkSigner(apk, P.FDROID_SIGNER_SHA256);
        if (!v.ok) { fs.rmSync(apk, { force: true }); throw new Error(`The F-Droid download isn't signed by F-Droid (${v.error ?? "signer " + v.got.join(", ")}); not installed.`); }
        say("    Signature OK (F-Droid's signing key). Installing...");
        const r = A.install(cfg, apk);
        if (!r.ok) throw new Error(`Android refused the F-Droid app: ${r.out.split("\n").slice(-1)[0]}`);
    } else say("    F-Droid is already installed.");
    // So F-Droid can tell about updates and install what you pick without extra prompts.
    A.shell(cfg, `pm grant ${P.FDROID_PKG} android.permission.POST_NOTIFICATIONS`);
    A.shell(cfg, `appops set ${P.FDROID_PKG} REQUEST_INSTALL_PACKAGES allow`);
}

function avdImagePath(cfg) {
    return (AVD.readIni(AVD.files(cfg).config)["image.sysdir.1"] ?? "").replace(/\/+$/, "");
}

async function cmdSetup(cfg, args) {
    const progress = makeProgress(hasFlag(args, "--progress"));
    progress(2, "Preparing…");
    const edition = optValue(args, "--edition", null);
    if (edition !== null && !ENUMS.edition.includes(edition)) throw new Error(`Usage: ${CLI} setup [--edition play|aosp]`);
    const image = optValue(args, "--image", null);
    if (image) { needAdvanced(cfg, "A custom system image"); cfg.image = image; }
    if (edition) { if (AVD.exists(cfg) && edition !== cfg.edition) throw new Error(`An Android VM (${cfg.edition}) already exists. Switch with: ${CLI} edition ${edition}`); cfg.edition = edition; }
    const ram = optValue(args, "--ram", null), cpus = optValue(args, "--cpus", null), disk = optValue(args, "--disk", null);
    if (ram !== null) { const n = Number(ram); if (!(n > 0)) throw new Error("--ram takes megabytes, e.g. --ram 4096"); cfg.vmRamGB = Math.max(AVD.MIN_RAM_GB, Math.round(n >= 64 ? n / 1024 : n)); }
    if (cpus !== null) { const n = Number(cpus); if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error("--cpus takes 1 to 16"); cfg.vmCpus = n; }
    if (disk !== null) { const n = Number(disk); if (!Number.isInteger(n) || n < 8) throw new Error("--disk takes gigabytes (at least 8)"); cfg.vmDiskGB = n; }
    saveConfig(cfg);

    stepSay("Checking scrcpy (app windows)");
    progress(4, "Checking tools…");
    await SDK.ensureScrcpy({ say });

    stepSay(`Android SDK (${SDK.imageId(cfg)})`);
    progress(6, "Checking the Android SDK…");
    const missing = SDK.missingPackages(cfg);
    if (missing.length) {
        await SDK.ensureSdk(cfg, { acceptLicences: hasFlag(args, "--accept-licences"), say, progress: p => progress(8 + p * 0.42, "Downloading Android…") });
        saveConfig(cfg);   // ensureSdk may have chosen our own SDK folder
    } else say(`    already installed in ${SDK.sdkRoot(cfg)} (revision ${SDK.imageInfo(cfg).revision ?? "?"})`);

    stepSay("Creating the Android VM");
    progress(52, "Creating the Android VM…");
    if (AVD.exists(cfg)) {
        const have = avdImagePath(cfg), want = SDK.imageId(cfg).split(";").join("/");
        if (have && have !== want) throw new Error(`The existing Android VM uses ${have}, not ${want}. Switch with: ${CLI} edition <play|aosp>`);
        say("    already created");
    } else {
        if (!SDK.tools(cfg).avdmanager) throw new Error("avdmanager is missing (Android SDK command-line tools). Run: brew install --cask android-commandlinetools");
        await SDK.ensureJava({ say });
        AVD.create(cfg, { say });
    }

    stepSay("Starting Android");
    progress(58, "Starting Android…");
    await ensureBooted(cfg, { progress: sec => progress(58 + Math.min(14, sec / 6), "Starting Android…") });
    say("    Android is up.");

    stepSay("Setting up Android");
    progress(74, "Setting up Android…");
    if (!isPlay(cfg) && !cfg.image) {
        try { await installFdroidClient(cfg); }
        catch (e) { say(`WARN: ${e.message} You can install F-Droid later with: ${CLI} fix fdroid`); }
    }
    const apk = helperApk();
    if (apk) {
        const h = APPS.ensureHelper(cfg, apk, AVD.files(cfg).helperStamp);
        say(h.ok ? "    RoboDinghy helper installed." : `WARN: couldn't install the helper APK (${h.message}).`);
    } else say("WARN: the helper APK isn't built (guest-android/build.sh): apps will get generic icons.");

    stepSay("Adding your Android apps to the Mac");
    progress(84, "Adding your apps…");
    await cmdSync(cfg, { quiet: true });
    progress(100, "Done");
    say(`\nAndroid is ready. Open apps from ${cfg.appsDir}, Spotlight, or: ${CLI} launch "<name>"`);
    if (isPlay(cfg)) say("Sign in to Google Play inside Android (open Google Play Store) to install apps.");
}

// ---------- editions ----------

function keptDir(cfg, edition) { return path.join(AVD.vmDir(cfg), "kept", edition); }

async function cmdEdition(cfg, args) {
    const want = positional(args)[0];
    if (!want) {
        const kept = ENUMS.edition.filter(e => fs.existsSync(path.join(keptDir(cfg, e), `${P.AVD_NAME}.avd`)));
        if (hasFlag(args, "--json")) { console.log(JSON.stringify({ edition: cfg.edition, image: SDK.imageId(cfg), exists: AVD.exists(cfg), kept })); return; }
        say(`Edition: ${cfg.edition === "play" ? "Google Play" : "AOSP"} (${SDK.imageId(cfg)})${AVD.exists(cfg) ? "" : ", not set up yet"}`);
        if (kept.length) say(`Kept from before: ${kept.join(", ")} (switching back reuses it)`);
        return;
    }
    if (!ENUMS.edition.includes(want)) throw new Error(`Usage: ${CLI} edition [play|aosp] [--yes] [--delete-old]`);
    if (cfg.image) needAdvanced(cfg, "Switching editions with a custom image set");
    if (want === cfg.edition && AVD.exists(cfg)) { say(`Already on the ${want} edition.`); return; }
    if (!AVD.exists(cfg) && !fs.existsSync(path.join(keptDir(cfg, want), `${P.AVD_NAME}.avd`))) {
        cfg.edition = want; saveConfig(cfg);
        say(`Edition set to ${want}. Create its Android VM with: ${CLI} setup --accept-licences`);
        return;
    }
    const old = cfg.edition, deleteOld = hasFlag(args, "--delete-old");
    if (!hasFlag(args, "--yes")) {
        say(`Switching to the ${want} edition creates a separate Android VM: apps and data don't carry over.\n` +
            `The current (${old}) VM is ${deleteOld ? "DELETED" : `kept (${(AVD.sizeOnDisk(cfg) / 1e9).toFixed(1)} GB) so you can switch back`}.\nRe-run with --yes to do it. Options: --delete-old --accept-licences`);
        return;
    }
    // Fail before touching the current VM if the target edition's image still has to be downloaded
    // and the licence hasn't been accepted — otherwise the old VM is moved/deleted and setup then stops.
    if (!fs.existsSync(path.join(keptDir(cfg, want), `${P.AVD_NAME}.avd`)) && !hasFlag(args, "--accept-licences")) {
        const need = SDK.missingPackages({ ...cfg, edition: want });
        if (need.length) {
            console.log(SDK.licenceText(need));
            throw new Error("Google's Android SDK licence hasn't been accepted (edition --yes --accept-licences).");
        }
    }
    const f = AVD.files(cfg);
    if (AVD.exists(cfg)) {
        if (AVD.isRunning(cfg)) { say("Shutting down Android..."); AVD.stop(cfg, 60); }
        if (deleteOld) { say(`Deleting the ${old} VM...`); AVD.destroy(cfg); }
        else {
            const k = keptDir(cfg, old);
            fs.rmSync(k, { recursive: true, force: true });
            fs.mkdirSync(k, { recursive: true });
            fs.renameSync(f.avd, path.join(k, `${P.AVD_NAME}.avd`));
            if (fs.existsSync(f.stateMeta)) fs.renameSync(f.stateMeta, path.join(k, "suspend.json"));
            fs.rmSync(f.ini, { force: true });
            say(`Kept the ${old} VM (switch back with: ${CLI} edition ${old}).`);
        }
        fs.rmSync(f.helperStamp, { force: true });
    }
    cfg.edition = want;
    saveConfig(cfg);
    const k = keptDir(cfg, want);
    if (fs.existsSync(path.join(k, `${P.AVD_NAME}.avd`))) {
        fs.mkdirSync(f.avdHome, { recursive: true });
        fs.renameSync(path.join(k, `${P.AVD_NAME}.avd`), f.avd);
        if (fs.existsSync(path.join(k, "suspend.json"))) fs.renameSync(path.join(k, "suspend.json"), f.stateMeta);
        AVD.writeIni(f.ini, { path: f.avd, "path.rel": `avd/${P.AVD_NAME}.avd`, target: SDK.imageId(cfg).split(";")[1] ?? "" });
        fs.rmSync(k, { recursive: true, force: true });
        say(`Switched back to your ${want} VM.`);
        await cmdSync(cfg, { quiet: true });
        return;
    }
    await cmdSetup(cfg, ["--edition", want, ...args.filter(a => a === "--accept-licences" || a === "--progress")]);
}

// ---------- the VM: power ----------

async function waitOnline(cfg) {
    await ensureBooted(cfg, { quiet: true });
    say("Online.");
}

async function vmAutoStart(cfg, atLogin) {
    if (cfg.vmAutoStart !== "on" || !AVD.exists(cfg)) return;
    if (AVD.isRunning(cfg)) { if (AVD.isPaused(cfg)) { AVD.resume(cfg); say("Resumed."); } return; }
    if (atLogin && cfg.vmStartDelaySec > 0) {
        say(`Waiting ${cfg.vmStartDelaySec}s before starting Android (login delay)...`);
        await new Promise(r => setTimeout(r, cfg.vmStartDelaySec * 1000));
        if (AVD.isRunning(cfg)) return;   // started by hand meanwhile
    }
    const t = SDK.tools(cfg);
    if (!t.ok.emulator) throw new Error(`Can't auto-start Android: the Android Emulator isn't installed. Run: ${CLI} setup`);
    say(AVD.hasState(cfg) ? "Restoring Android from its saved state..." : "Starting Android...");
    AVD.start(cfg);
    await waitOnline(cfg);
}

// quit / idle / save / pause. "save" falls back to a normal shutdown, with the reason, when it can't be done.
function vmApplyPower(cfg, action, why) {
    if (!AVD.isRunning(cfg)) return;
    if (action === "keep" || action === "off") return;
    if (action === "pause") {
        if (AVD.isPaused(cfg)) return;
        say(AVD.pause(cfg) ? "Paused Android." : "WARN: couldn't pause Android."); return;
    }
    if (action === "save") {
        try {
            say("Saving the state of Android...");
            AVD.saveState(cfg);
            say("Saved. Android will pick up where it left off.");
            return;
        } catch (e) {
            say(`WARN: ${e.message}`);
            if (why === "save") throw new Error("Android was left running.");
            say("Shutting Android down normally instead...");
        }
    }
    say(AVD.stop(cfg, 60) ? "Android is shut down." : "WARN: Android didn't shut down in time and was stopped.");
}

// ---------- the VM: files ----------

function cloneOrCopy(src, dst) {
    if (spawnSync("cp", ["-cR", src, dst]).status === 0) return;   // APFS clone: instant, no extra space
    fs.rmSync(dst, { recursive: true, force: true });
    if (spawnSync("cp", ["-R", src, dst]).status !== 0) throw new Error(`Couldn't copy ${src} (is there enough free space?)`);
}
function moveTree(src, dst) {
    try { fs.renameSync(src, dst); } catch { cloneOrCopy(src, dst); fs.rmSync(src, { recursive: true, force: true }); }
}
function dropLocks(dir) { try { for (const e of fs.readdirSync(dir)) if (e.endsWith(".lock")) fs.rmSync(path.join(dir, e), { recursive: true, force: true }); } catch {} }

function vmMove(cfg, dest) {
    if (!dest) throw new Error(`Usage: ${CLI} vm move <folder>`);
    dest = expand(dest);
    const from = AVD.files(cfg);
    if (dest === from.dir) { say("The VM is already there."); return; }
    if (!AVD.exists(cfg)) { cfg.vmDir = dest; saveConfig(cfg); say(`New VM location set: ${dest}`); return; }
    if (fs.existsSync(path.join(dest, "avd", `${P.AVD_NAME}.avd`))) throw new Error(`There's already a ${NAME} VM in ${dest}.`);
    if (dest.startsWith(from.dir + path.sep)) throw new Error(`Can't move the VM into its own folder (${from.dir}).`);
    // Check the destination before shutting Android down: a read-only volume, a file in the way or a full
    // disk should fail with Android still running.
    const created = !fs.existsSync(dest);
    try {
        fs.mkdirSync(path.join(dest, "avd"), { recursive: true });
        const probe = path.join(dest, `.${P.CLI}-write-test`);
        fs.writeFileSync(probe, "");
        fs.rmSync(probe, { force: true });
    } catch (e) {
        if (created) try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
        throw new Error(`Can't use ${dest} for the VM: ${e.code === "EROFS" ? "the volume is read-only" : e.code === "ENOTDIR" ? "part of that path is a file" : e.code === "EACCES" || e.code === "EPERM" ? "no permission to write there" : e.message}.`);
    }
    if (fs.statSync(dest).dev !== fs.statSync(from.dir).dev) {
        const need = AVD.sizeOnDisk(cfg) + 1024 ** 3, free = AVD.freeBytes(dest);
        if (free !== null && free < need) {
            try { fs.rmdirSync(path.join(dest, "avd")); if (created) fs.rmdirSync(dest); } catch {}
            throw new Error(`Not enough free space in ${dest}: ${(free / 1e9).toFixed(1)} GB free, about ${(need / 1e9).toFixed(1)} GB needed.`);
        }
    }
    if (AVD.isRunning(cfg)) { say("Shutting down Android..."); AVD.stop(cfg, 60); }
    say(`Moving the VM to ${dest} ...`);
    moveTree(from.avd, path.join(dest, "avd", `${P.AVD_NAME}.avd`));
    for (const n of ["suspend.json", "helper.sha256", "kept"]) { const p = path.join(from.dir, n); if (fs.existsSync(p)) moveTree(p, path.join(dest, n)); }
    fs.rmSync(from.ini, { force: true });
    try { fs.rmdirSync(from.avdHome); } catch {}
    cfg.vmDir = dest; saveConfig(cfg);
    const f = AVD.files(cfg);
    AVD.writeIni(f.ini, { path: f.avd, "path.rel": `avd/${P.AVD_NAME}.avd`, target: SDK.imageId(cfg).split(";")[1] ?? "" });
    say(`Moved. Start Android again with: ${CLI} vm start`);
}

async function vmExport(cfg, dest) {
    if (!AVD.exists(cfg)) throw new Error("No Android VM to export.");
    if (!dest) dest = path.join(os.homedir(), "Desktop", `${NAME}-${new Date().toISOString().slice(0, 10)}${P.BUNDLE_EXT}`);
    dest = expand(dest);
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists.`);
    const wasRunning = AVD.isRunning(cfg);
    if (wasRunning) { say("Shutting down Android for a consistent copy..."); AVD.stop(cfg, 60); }
    const f = AVD.files(cfg);
    fs.mkdirSync(dest, { recursive: true });
    say(`Exporting to ${dest} ...`);
    cloneOrCopy(f.avd, path.join(dest, `${P.AVD_NAME}.avd`));
    dropLocks(path.join(dest, `${P.AVD_NAME}.avd`));
    if (fs.existsSync(f.stateMeta)) fs.copyFileSync(f.stateMeta, path.join(dest, "suspend.json"));
    fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify({
        format: 1, product: NAME, created: new Date().toISOString(), edition: cfg.edition, image: SDK.imageId(cfg),
        vmCpus: cfg.vmCpus, vmRamGB: cfg.vmRamGB, vmDiskGB: cfg.vmDiskGB,
    }, null, 2));
    const r = spawnSync("du", ["-sk", dest], { encoding: "utf8" });
    say(`Exported (${(Number(r.stdout.split(/\s/)[0]) * 1024 / 1e9).toFixed(1)} GB).`);
    if (wasRunning) { AVD.start(cfg); say("Android is starting again."); }
    say(dest);
}

function vmImport(cfg, src) {
    if (!src) throw new Error(`Usage: ${CLI} vm import <bundle${P.BUNDLE_EXT}>`);
    src = expand(src);
    const avdSrc = path.join(src, `${P.AVD_NAME}.avd`);
    if (!fs.existsSync(path.join(avdSrc, "config.ini"))) throw new Error(`That isn't a ${NAME} VM bundle (no ${P.AVD_NAME}.avd inside).`);
    if (AVD.exists(cfg)) throw new Error(`A ${NAME} VM already exists. Export it first if you want to keep it, then: ${CLI} vm destroy --yes`);
    let m = {};
    try { m = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8")); } catch {}
    if (m.edition && ENUMS.edition.includes(m.edition)) cfg.edition = m.edition;
    for (const k of ["vmCpus", "vmRamGB", "vmDiskGB"]) if (Number.isInteger(m[k])) cfg[k] = m[k];
    if (m.image && m.image !== SDK.imageId(cfg)) { if (isAdvanced(cfg)) cfg.image = m.image; else say(`WARN: the bundle was made with ${m.image}; using ${SDK.imageId(cfg)}.`); }
    const f = AVD.files(cfg);
    fs.mkdirSync(f.avdHome, { recursive: true });
    say("Importing...");
    cloneOrCopy(avdSrc, f.avd);
    dropLocks(f.avd);
    if (fs.existsSync(path.join(src, "suspend.json"))) fs.copyFileSync(path.join(src, "suspend.json"), f.stateMeta);
    AVD.writeIni(f.ini, { path: f.avd, "path.rel": `avd/${P.AVD_NAME}.avd`, target: SDK.imageId(cfg).split(";")[1] ?? "" });
    saveConfig(cfg);
    if (!SDK.imageInfo(cfg).installed) say(`WARN: the system image ${SDK.imageId(cfg)} isn't installed on this Mac. Run: ${CLI} setup --accept-licences`);
    say(`Imported. Start it with: ${CLI} vm start`);
}

// ---------- the VM: commands ----------

// Local time (what the user sees on their clock), e.g. snap-20261128-0358.
const snapName = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `snap-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

// Snapshot verbs need a running emulator. When it was off, put it back the way it was afterwards.
async function withRunningVm(cfg, why, fn) {
    const wasRunning = AVD.isRunning(cfg), hadState = !wasRunning && AVD.hasState(cfg);
    if (!wasRunning) say(`Starting Android ${why}...`);
    await ensureBooted(cfg, { quiet: true });
    await fn();
    if (!wasRunning) {
        if (hadState) vmApplyPower(cfg, "save", "restore");
        else { AVD.stop(cfg, 60); say("Android is stopped again."); }
    }
}

async function cmdVm(cfg, args) {
    const sub = args[0] ?? "status";
    const needVm = () => { if (!AVD.exists(cfg)) throw new Error(`No ${NAME} Android VM yet. Run: ${CLI} setup`); };
    switch (sub) {
        case "move": return vmMove(cfg, args[1]);
        case "export": return vmExport(cfg, args[1]);
        case "import": return vmImport(cfg, args[1]);
        case "start": {
            needVm();
            if (AVD.isRunning(cfg) && !AVD.isPaused(cfg) && A.booted(cfg)) { say("Already running."); return; }
            if (!AVD.isRunning(cfg)) say(AVD.hasState(cfg) ? "Restoring Android from its saved state..." : "Starting...");
            await waitOnline(cfg);
            return;
        }
        case "stop": {
            if (!AVD.isRunning(cfg)) { say("Stopped."); return; }
            const graceful = AVD.stop(cfg, 60);
            if (!graceful) say("WARN: Android didn't shut down in time and was stopped.");
            say("Stopped.");
            return;
        }
        case "restart": {
            needVm();
            if (AVD.isRunning(cfg)) AVD.stop(cfg, 60);
            AVD.start(cfg, { cold: true });
            say("Starting...");
            await waitOnline(cfg);
            return;
        }
        case "autostart": return vmAutoStart(cfg, hasFlag(args, "--login"));
        case "quit": return vmApplyPower(cfg, cfg.vmOnQuit, "quit");
        case "idle": return vmApplyPower(cfg, cfg.vmIdleAction, "idle");
        case "save": return vmApplyPower(cfg, "save", "save");
        case "pause": return vmApplyPower(cfg, "pause", "pause");
        case "resume": {
            if (!AVD.isRunning(cfg)) throw new Error(`Android isn't running. Start it with: ${CLI} vm start`);
            say(AVD.resume(cfg) ? "Resumed." : "Couldn't resume Android.");
            return;
        }
        case "status": {
            if (!AVD.exists(cfg)) { say(`No ${NAME} Android VM yet. Run: ${CLI} setup`); return; }
            const f = AVD.files(cfg);
            const saved = AVD.hasState(cfg) && !AVD.isRunning(cfg) ? (() => { try { const m = JSON.parse(fs.readFileSync(f.stateMeta, "utf8")); return `saved ${new Date(m.savedAt).toLocaleString()} (${(m.bytes / 1e9).toFixed(1)} GB)`; } catch { return "saved"; } })() : null;
            say(`${NAME} VM: ${AVD.isRunning(cfg) ? (AVD.isPaused(cfg) ? `paused (pid ${AVD.pidOf(cfg)})` : `running (pid ${AVD.pidOf(cfg)})`) : (saved ? `stopped, with its state ${saved}` : "stopped")}`);
            const sp = AVD.spaceCheck(cfg, true);
            say(`free space: ${sp.free === null ? "unknown" : (sp.free / 1073741824).toFixed(1) + " GB"} (a saved state needs ${(sp.need / 1073741824).toFixed(1)} GB)${sp.ok ? "" : "  <- NOT ENOUGH: saving will fall back to a normal shutdown"}`);
            say(`AVD: ${f.avd} (${(AVD.sizeOnDisk(cfg) / 1e9).toFixed(1)} GB)`);
            say(`image: ${SDK.imageId(cfg)}; serial ${A.serial(cfg)}, console ${cfg.consolePort}, gRPC ${P.GRPC_PORT + (cfg.consolePort - P.CONSOLE_PORT)}`);
            const snaps = AVD.snapshotList(cfg);
            say(`snapshots: ${snaps.length ? snaps.map(x => x.name).join(", ") : `none (${CLI} vm snapshot)`}`);
            return;
        }
        case "snapshot": {
            needVm();
            const name = positional(args.slice(1))[0] ?? snapName();
            if (!AVD.validSnapshotName(name)) throw new Error("Snapshot names may use letters, digits, '.', '_' and '-' (up to 40 characters), and can't be an internal name.");
            if (AVD.snapshotList(cfg).some(x => x.name === name)) throw new Error(`A snapshot named "${name}" already exists.`);
            await withRunningVm(cfg, "to take the snapshot", () => { AVD.snapshotCreate(cfg, name); say(`Snapshot "${name}" taken.`); });
            return;
        }
        case "snapshots": {
            const list = AVD.snapshotList(cfg);
            if (hasFlag(args, "--json")) { console.log(JSON.stringify(list.map(x => ({ name: x.name, date: x.date })))); return; }
            if (!list.length) { say(`No snapshots yet. Take one with: ${CLI} vm snapshot [name]`); return; }
            for (const x of list) say(`${x.name.padEnd(24)} ${new Date(x.date).toLocaleString()}`);
            return;
        }
        case "rewind": {
            const name = positional(args.slice(1))[0];
            if (!name) throw new Error(`Usage: ${CLI} vm rewind <snapshot>   (see: ${CLI} vm snapshots)`);
            if (!AVD.snapshotList(cfg).some(x => x.name === name)) throw new Error(`There's no snapshot named "${name}".`);
            if (!hasFlag(args, "--yes")) {
                const ok = asDialog(`button returned of (display dialog "Rewind Android to \\"${asq(name)}\\"?\n\nEverything changed in Android since then (apps, files, settings) will be lost." with title "${asq(NAME)}" with icon caution buttons {"Cancel", "Rewind"} default button "Cancel")`);
                if (ok !== "Rewind") { say("Cancelled."); return; }
            }
            const wasRunning = AVD.isRunning(cfg);
            await withRunningVm(cfg, "to rewind it", () => { AVD.snapshotApply(cfg, name); say(`Rewound to "${name}".`); });
            if (wasRunning) await waitOnline(cfg);
            return;
        }
        case "snapshot-delete": {
            const name = positional(args.slice(1))[0];
            if (!name) throw new Error(`Usage: ${CLI} vm snapshot-delete <snapshot>`);
            if (!AVD.snapshotList(cfg).some(x => x.name === name)) throw new Error(`There's no snapshot named "${name}".`);
            AVD.snapshotDelete(cfg, name);
            say(`Deleted snapshot "${name}".`);
            return;
        }
        case "destroy":
            if (!hasFlag(args, "--yes")) throw new Error(`This deletes the ${NAME} Android VM, its apps and data. Re-run with --yes to confirm.`);
            AVD.destroy(cfg);
            say("Deleted.");
            return;
        default:
            throw new Error(`Usage: ${CLI} vm <start|stop|restart|pause|resume|save|status|autostart|idle|quit|snapshot|snapshots|rewind|snapshot-delete|move|export|import|destroy>`);
    }
}

// ---------- about / doctor / fix ----------

function helperVersion() {
    const apk = helperApk();
    if (!apk) return null;
    // The manifest has no versionName; report the build date instead.
    try { return `built ${fs.statSync(apk).mtime.toISOString().slice(0, 10)}`; } catch { return null; }
}

function cmdAbout(cfg, json) {
    const c = loadCompat(__dirname);
    const t = SDK.tools(cfg);
    const img = SDK.imageInfo(cfg);
    const em = SDK.emulatorVersion(t) ?? "not installed";
    const sc = SDK.scrcpyVersion(t) ?? "not installed";
    const ad = SDK.adbVersion(t) ?? "not installed";
    const ed = cfg.image ? "custom" : cfg.edition;
    const testedImg = c.systemImage?.[ed];
    const haveImg = img.installed ? `${ed} API ${img.api} r${img.revision ?? "?"}` : "not installed";
    const rows = [
        aboutRow(NAME, VERSION, c.robodinghy ?? ""),
        aboutRow("Android Emulator", em, c.emulator?.tested ?? ""),
        aboutRow("System image", haveImg, testedImg ? `${ed} API ${testedImg.api} r${testedImg.revision}` : "untested", { ok: !!testedImg && img.api === testedImg.api && String(img.revision) === String(testedImg.revision), extra: img.id }),
        aboutRow("scrcpy", sc, c.scrcpy?.tested ?? ""),
        aboutRow("adb (platform-tools)", ad, c.adb?.tested ?? ""),
        aboutRow("Helper APK", helperVersion() ?? "not built", c.helper?.tested ?? "", { ok: !!helperVersion() }),
    ];
    printAbout(rows, {
        json,
        header: `${NAME} ${VERSION}: Android apps on the Mac with Google's Android Emulator and scrcpy`,
        footer: "\nNot affiliated with Google or Genymobile. Android is a trademark of Google LLC. See NOTICE.md for credits and trademarks.",
    });
}

async function cmdDoctor(cfg) {
    const { add, finish } = makeDoctor();
    const t = SDK.tools(cfg);
    add(true, `node ${process.version}`, "");
    add(fs.existsSync(CONFIG_PATH), `${CLI} config present`, `Run: ${CLI} setup`);
    add(fs.existsSync(t.sdk), `Android SDK at ${t.sdk}`, `Run: ${CLI} setup --accept-licences`);
    const ev = SDK.emulatorVersion(t);
    add(!!ev, ev ? `Android Emulator ${ev}` : "Android Emulator installed", `Run: ${CLI} setup --accept-licences`);
    if (ev) {
        const acc = spawnSync(t.emulator, ["-accel-check"], { encoding: "utf8", timeout: 30000 });
        add(acc.status === 0 && /accel:\s*\n0\b|Hypervisor\.Framework/i.test(acc.stdout ?? ""), "Hypervisor.framework acceleration available", "The emulator can't use Hypervisor.framework (is this Mac Apple silicon and not itself a VM?).");
    }
    add(t.ok.adb, "adb (platform-tools) installed", `Run: ${CLI} setup --accept-licences`);
    add(t.ok.image, `system image ${SDK.imageId(cfg)}`, `Run: ${CLI} setup --accept-licences`);
    add(t.ok.scrcpy, t.scrcpy ? `scrcpy ${SDK.scrcpyVersion(t) ?? ""} with its server` : "scrcpy installed", "Run: brew install scrcpy");
    add(AVD.exists(cfg), `${NAME} Android VM created`, `Run: ${CLI} setup`);
    if (AVD.exists(cfg)) {
        const running = AVD.isRunning(cfg);
        add(running, "Android VM running", `Start it with: ${CLI} vm start`);
        if (running && !AVD.isPaused(cfg)) {
            const st = A.state(cfg);
            add(st === "device", `adb connected (${A.serial(cfg)}${st && st !== "device" ? `: ${st}` : ""})`, `Run: ${CLI} fix adb`);
            if (st === "device") {
                add(A.booted(cfg), "Android finished booting", "Give it a minute, or restart it: robodinghy vm restart");
                add(APPS.helperInstalled(cfg), "RoboDinghy helper installed in Android (app icons)", helperApk() ? `Run: ${CLI} fix helper` : "Build it: guest-android/build.sh, then: robodinghy fix helper");
                if (!isPlay(cfg) && !cfg.image) add(A.packages(cfg).some(p => p.id === P.FDROID_PKG), "F-Droid installed (AOSP edition)", `Run: ${CLI} fix fdroid`);
            }
        }
        if (cfg.vmOnQuit === "save" || cfg.vmIdleAction === "save") {
            const sp = AVD.spaceCheck(cfg, true);
            add(sp.ok, "enough free space to save Android's state", sp.message ?? "");
        }
    }
    add(appMgmt.probe(cfg.appsDir), `App Management permission (lets ${NAME} update app launchers)`,
        `Turn on ${NAME} in System Settings > Privacy & Security > App Management, or run: ${CLI} permissions --prompt`);
    if (isAdvanced(cfg)) add(true, "advanced mode is ON (unsupported setups allowed)", "");
    add(!!repoRoot(), "updater available", `No windinghy checkout found (set ${P.ENV_PATH} to its robodinghy script, or re-clone the repo).`);
    const launcherCount = fs.existsSync(cfg.appsDir) ? fs.readdirSync(cfg.appsDir).filter(e => e.endsWith(".app")).length : 0;
    add(launcherCount > 0, `${launcherCount} app launchers in ${cfg.appsDir}`, `Run: ${CLI} sync`);
    const stale = L.staleLaunchers(cfg.appsDir);
    add(stale.length === 0, stale.length ? `${stale.length} launchers point at a missing node/${CLI}` : `app launchers can find node and ${CLI}`, `Run: ${CLI} sync`);
    finish();
}

async function cmdFix(cfg, args) {
    if (hasFlag(args, "--quiet")) {
        // Background callers (e.g. after the Mac wakes): reconnect adb if the emulator dropped off. No output.
        if (AVD.isRunning(cfg) && !AVD.isPaused(cfg) && A.state(cfg) !== "device") A.adb(cfg, ["reconnect", "offline"], { noSerial: true });
        return;
    }
    const which = positional(args)[0] ?? "all";
    const valid = ["all", "adb", "locks", "helper", "fdroid"];
    if (!valid.includes(which)) throw new Error(`Usage: ${CLI} fix [${valid.join("|")}]`);
    const all = which === "all";
    let fixed = 0;
    if (all && !appMgmt.probe(cfg.appsDir)) { await appMgmt.ensure(cfg.appsDir); fixed++; }
    if ((all || which === "locks") && AVD.exists(cfg) && !AVD.isRunning(cfg)) {
        const f = AVD.files(cfg);
        const stale = (() => { try { return fs.readdirSync(f.avd).filter(e => e.endsWith(".lock")); } catch { return []; } })();
        const marks = [f.pid, f.pausedMark].filter(p => fs.existsSync(p));
        if (stale.length || marks.length) { for (const e of stale) fs.rmSync(path.join(f.avd, e), { recursive: true, force: true }); for (const p of marks) fs.rmSync(p, { force: true }); stepSay(`Removed ${stale.length + marks.length} stale lock/state files`); fixed++; }
    }
    if (AVD.isRunning(cfg) && (all || which === "adb")) {
        if (AVD.isPaused(cfg)) { AVD.resume(cfg); stepSay("Android was paused: resumed it"); fixed++; }
        if (A.state(cfg) !== "device") {
            stepSay("adb lost the emulator: reconnecting");
            A.adb(cfg, ["reconnect", "offline"], { noSerial: true });
            if (!await waitFor(() => A.state(cfg) === "device", 20, 2000)) { A.adb(cfg, ["start-server"], { noSerial: true }); await waitFor(() => A.state(cfg) === "device", 20, 2000); }
            say(`    ${A.state(cfg) === "device" ? "connected" : "still not connected: restart Android (robodinghy vm restart)"}`);
            fixed++;
        }
    } else if (which === "adb") say(`Android isn't running. Start it with: ${CLI} vm start`);
    if (all || which === "helper" || which === "fdroid") {
        if (!AVD.isRunning(cfg) || !A.booted(cfg)) { if (!all) say(`Android isn't running. Start it with: ${CLI} vm start`); }
        else {
            if ((all && !APPS.helperInstalled(cfg)) || which === "helper") {
                const apk = helperApk();
                if (!apk) say("The helper APK isn't built: run guest-android/build.sh first.");
                else { fs.rmSync(AVD.files(cfg).helperStamp, { force: true }); const h = APPS.ensureHelper(cfg, apk, AVD.files(cfg).helperStamp); stepSay(h.ok ? "Reinstalled the RoboDinghy helper" : `Couldn't install the helper: ${h.message}`); fixed++; }
            }
            if (!isPlay(cfg) && !cfg.image && ((all && !A.packages(cfg).some(p => p.id === P.FDROID_PKG)) || which === "fdroid")) {
                stepSay("Installing/repairing F-Droid");
                await installFdroidClient(cfg);
                fixed++;
            }
        }
    }
    say(fixed ? `\nApplied ${fixed} fix${fixed === 1 ? "" : "es"}. Try again.` : `\nNothing needed fixing.`);
}

// ---------- uninstall / config / update ----------

async function cmdUninstall(cfg, args) {
    const settings = hasFlag(args, "--purge-settings"), cache = hasFlag(args, "--purge-cache");
    const ownSdk = fs.existsSync(P.OWN_SDK_DIR);
    if (!hasFlag(args, "--yes")) {
        const gb = (AVD.sizeOnDisk(cfg) / 1e9).toFixed(1);
        say(`This will remove:\n  - the Android VM, its apps, data and snapshots (${gb} GB)\n  - the app launchers in ${cfg.appsDir}${cache ? `\n  - cached downloads (F-Droid)${ownSdk ? ` and the Android SDK ${NAME} installed (${P.OWN_SDK_DIR})` : ""}` : ""}${settings ? `\n  - ${NAME}'s settings and logs` : ""}\nYour Mac files, exported backups and any Android SDK you installed yourself are not touched.\nRe-run with --yes to do it. Options: --purge-cache  --purge-settings`);
        return;
    }
    const progress = makeProgress(hasFlag(args, "--progress"));
    progress(3, "Preparing…");
    for (const w of S.openWindows(cfg)) { try { process.kill(w.pid, "SIGTERM"); } catch {} }
    if (AVD.isRunning(cfg)) { say("Shutting down Android..."); progress(8, "Shutting down Android…"); AVD.stop(cfg, 30); }
    if (AVD.exists(cfg) || fs.existsSync(AVD.files(cfg).avdHome)) { say("Removing the Android VM..."); progress(40, "Deleting the Android VM…"); AVD.destroy(cfg); }
    try { fs.rmSync(path.join(AVD.vmDir(cfg), "kept"), { recursive: true, force: true }); } catch {}
    progress(70, "Removing app launchers…");
    removeOwnLaunchers(cfg.appsDir);
    if (cache) {
        progress(85, "Removing cached downloads…");
        try { fs.rmSync(fdroidDir(), { recursive: true, force: true }); } catch {}
        if (ownSdk) try { fs.rmSync(P.OWN_SDK_DIR, { recursive: true, force: true }); } catch {}
    }
    try { fs.rmdirSync(AVD.vmDir(cfg)); } catch {}
    progress(95, "Finishing…");
    if (settings) { try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {} }
    progress(100, "Done");
    say(`Done. ${NAME}'s Android is gone from this Mac.`);
    say(`To finish removing ${NAME} itself, delete ~/Applications/${NAME}.app and the windinghy folder.`);
}

function cmdConfig(cfg, key, value) {
    if (!key) {
        console.log(JSON.stringify(cfg, null, 2));
        console.log(`(config file: ${CONFIG_PATH})`);
        return;
    }
    if (!(key in DEFAULTS)) throw new Error(`Unknown config key "${key}". Valid: ${Object.keys(DEFAULTS).join(", ")}`);
    if (value === undefined) { console.log(cfg[key]); return; }
    if (ADVANCED_KEYS.includes(key)) needAdvanced(cfg, `Changing "${key}"`);
    if (key === "edition" && AVD.exists(cfg) && value !== cfg.edition) throw new Error(`Switching editions creates a new Android VM. Use: ${CLI} edition ${value}`);
    if (key === "windowSize" && !WINDOW_SIZE.test(value)) throw new Error("windowSize must look like 1280x800");
    if (key === "consolePort" && Number(value) % 2 !== 0) throw new Error("consolePort must be an even number (the adb port is the next one)");
    if (key === "consolePort" && AVD.isRunning(cfg)) throw new Error("Stop Android first (robodinghy vm stop): the running emulator uses the current port.");
    if (key === "vmDir") {
        // The VM, its pid file and saved state live there: changing it under an existing VM orphans it.
        if (AVD.exists(cfg) || AVD.isRunning(cfg)) throw new Error(`The Android VM lives in ${AVD.vmDir(cfg)}. Move it (Android is shut down and the files moved) with: ${CLI} vm move <folder>`);
        const p = vmDirProblem(value);
        if (p) throw new Error(p);
        value = value.trim() ? expand(value) : "";
    }
    if (key === "appsDir") {
        const p = appsDirProblem(value);
        if (p) throw new Error(p);
        value = expand(value);
    }
    checkConfigValue(key, value, { enums: ENUMS, numbers: NUMBERS });
    cfg[key] = coerceConfigValue(key, value, NUMBERS);
    saveConfig(cfg);
    console.log(`${key} = ${cfg[key]}`);
    if (key === "vmRamGB" && cfg.vmRamGB < AVD.MIN_RAM_GB) console.log(`Note: the Android Emulator gives Android at least ${AVD.MIN_RAM_GB} GB, so it gets ${AVD.MIN_RAM_GB} GB.`);
    if (["vmCpus", "vmRamGB", "vmDiskGB"].includes(key) && AVD.isRunning(cfg)) console.log("Applied the next time Android starts (a saved state is discarded then).");
    if (key === "advanced" && value === "on") console.log(`\nAdvanced mode is on. Custom system images, another SDK and other ports are unsupported: they may work, and you're on your own if they don't.`);
}

// The git checkout: where this file lives, or (running from the app bundle) where $ROBODINGHY_PATH points.
function repoRoot() {
    const env = process.env[P.ENV_PATH];
    const cands = [PROJECT_ROOT, env && path.resolve(path.dirname(env), env.endsWith(".mjs") ? "../.." : ".")].filter(Boolean);
    return cands.find(d => fs.existsSync(path.join(d, "host", "dinghy-update.sh"))) ?? null;
}

function cmdUpdate() {
    const root = repoRoot();
    if (!root) throw new Error(`Run update from the windinghy checkout (${CLI} update there), or: git pull && host/menubar-android/build.sh`);
    runUpdater(root);
}

// ---------- main ----------

const HELP = `${CLI} — ${NAME} ${VERSION}: Android apps on your Mac

Usage:
  ${CLI} setup [--edition play|aosp] [--accept-licences] [--ram MB] [--cpus n] [--disk GB] [--progress]
                              install Google's Android Emulator + image, create and boot the VM, add your apps
  ${CLI} status [--json]       the Android VM: running, booted, windows open, health
  ${CLI} sync                  generate ~/Applications/${NAME}/*.app launchers (one per Android app)
  ${CLI} launch "<name>"       open an Android app in its own Mac window
  ${CLI} desktop               the whole Android screen in one window
  ${CLI} install <file.apk>    install an APK
  ${CLI} pkg <search|list|install|uninstall|upgrade> [--json] ...   apps from F-Droid (AOSP edition)
  ${CLI} edition [play|aosp] [--yes] [--delete-old]   show or switch the edition (a separate VM)
  ${CLI} vm <start|stop|restart|pause|resume|save|status>   power
  ${CLI} vm <snapshot [name]|snapshots [--json]|rewind <name> [--yes]|snapshot-delete <name>>
  ${CLI} vm <move <folder>|export [path]|import <path>|destroy --yes>
  ${CLI} config [key [value]]  show/set settings (vmRamGB, vmCpus, windowSize, shareAudio, ...)
  ${CLI} about [--json]        versions installed vs the tested versions
  ${CLI} doctor                check everything ${NAME} needs
  ${CLI} fix [adb|locks|helper|fdroid]   repair common problems
  ${CLI} permissions [--prompt]   check (or request) the macOS App Management permission
  ${CLI} update                pull the latest version from git and rebuild
  ${CLI} uninstall [--yes] [--purge-cache] [--purge-settings]   remove ${NAME}'s Android from this Mac
  ${CLI} version               print the ${NAME} version`;

const [cmd, ...rest] = process.argv.slice(2);
const cfg = loadConfig();
// A running emulator keeps the port it was started with: talk to it there, whatever the config says now.
{ const p = AVD.runningPort(cfg); if (p && p !== cfg.consolePort) cfg.consolePort = p; }

try {
    switch (cmd) {
        case "setup":       await cmdSetup(cfg, rest); break;
        case "status":      cmdStatus(cfg, hasFlag(rest, "--json")); break;
        case "sync":        await cmdSync(cfg, { quiet: hasFlag(rest, "--quiet") }); break;
        case "launch":      await cmdLaunch(cfg, positional(rest).join(" ")); break;
        case "desktop":     await cmdLaunch(cfg, P.DESKTOP_NAME); break;
        case "open-app":    await cmdOpenApp(cfg, rest[0]); break;
        case "install":     await cmdInstall(cfg, rest[0]); break;
        case "pkg":         await cmdPkg(cfg, rest); break;
        case "edition":     await cmdEdition(cfg, rest); break;
        case "vm":          await cmdVm(cfg, rest); break;
        case "config":      cmdConfig(cfg, rest[0], rest[1]); break;
        case "about":
        case "components":  cmdAbout(cfg, hasFlag(rest, "--json")); break;
        case "doctor":      await cmdDoctor(cfg); break;
        case "fix":         await cmdFix(cfg, rest); break;
        case "permissions": {
            const ok = await appMgmt.command(cfg.appsDir, rest);
            process.exit(ok ? 0 : 1);
        }
        case "update":      cmdUpdate(); break;
        case "uninstall":   await cmdUninstall(cfg, rest); break;
        case "version":
        case "--version":
        case "-v":          console.log(`${CLI} ${VERSION}`); break;
        case undefined:
        case "help":
        case "-h":
        case "--help":      console.log(HELP); break;
        default:            console.log(HELP); throw new Error(`Unknown command "${cmd}" (see the list above)`);
    }
} catch (e) {
    if (appMgmt.hint(e)) console.error(`Error: macOS App Management is blocking ${NAME} from updating its app launchers (System Settings > Privacy & Security > App Management > ${NAME}).`);
    else console.error(`Error: ${e.message}`);
    process.exit(1);
}
