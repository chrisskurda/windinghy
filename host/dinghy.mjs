#!/usr/bin/env node
// dinghy — WinDinghy host CLI
// Talks to the WinBoat Guest Server inside a Windows VM (UTM or anything
// reachable over IP) and turns Windows apps into native-feeling macOS
// launchers that open as RemoteApp windows via Microsoft's "Windows App".
//
// Commands:
//   dinghy serve-setup          serve the guest payload + setup one-liner, wait for the guest
//   dinghy status               guest health / version / metrics
//   dinghy sync                 fetch app list, (re)generate ~/Applications/WinBoat/*.app
//   dinghy launch <name>        launch a synced app
//   dinghy desktop              open a full Windows desktop session
//   dinghy config [key value]   show or set config (host, username, appsDir, ...)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Single source of truth for the WinDinghy version. Release: bump this,
// move CHANGELOG "Unreleased" entries under the new version, tag vX.Y.Z.
const VERSION = "0.1.0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PAYLOAD_DIR = path.join(PROJECT_ROOT, "payload");
const CONFIG_DIR = path.join(os.homedir(), ".config", "windinghy");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const SETUP_PORT = 8756;

const DEFAULTS = {
    host: "192.168.64.8",
    apiPort: 7148,
    rdpPort: 3389,
    username: "",
    scale: "",
    promptcreds: "on",
    vmName: "Windows",
    filter: "on",
    appsDir: path.join(os.homedir(), "Applications", "WinDinghy"),
};

// Default noise filter for `dinghy sync` (disable with: dinghy config filter off).
// Matches OS plumbing that shows up in the guest's app enumeration but isn't
// something you'd launch: codec/extension packs, runtimes, uninstallers, etc.
const EXCLUDE_PATTERNS = [
    /^\d+$/,
    /\b(extension|extensions|runtime|redistributable|experience pack|installer)\b/i,
    /^(bing search|cross device|application compatibility enhancements|english \(|get help|tips|windows web experience)/i,
    /\buninstall/i,
];

// The guest's CamelCase-spacing pass mangles all-caps names ("ADSIEdit" ->
// "A D S I E d i t"). If most tokens are single characters, re-join them.
function fixName(name) {
    const tokens = name.trim().split(/\s+/);
    if (tokens.length >= 4 && tokens.filter(t => t.length === 1).length / tokens.length > 0.6) {
        return tokens.join("");
    }
    return name;
}

// ---------- config ----------

// Pre-rename installs used ~/.config/winboat-mac and ~/Applications/WinBoat;
// migrate both silently so existing setups keep working.
function migrateLegacyPaths() {
    const oldConfigDir = path.join(os.homedir(), ".config", "winboat-mac");
    if (!fs.existsSync(CONFIG_DIR) && fs.existsSync(oldConfigDir)) {
        fs.cpSync(oldConfigDir, CONFIG_DIR, { recursive: true });
    }
}

function loadConfig() {
    migrateLegacyPaths();
    let cfg;
    try {
        cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
    } catch {
        cfg = { ...DEFAULTS };
    }
    const oldAppsDir = path.join(os.homedir(), "Applications", "WinBoat");
    if (cfg.appsDir === oldAppsDir) {
        cfg.appsDir = DEFAULTS.appsDir;
        try {
            if (fs.existsSync(oldAppsDir) && !fs.existsSync(cfg.appsDir)) {
                fs.renameSync(oldAppsDir, cfg.appsDir);
            }
        } catch {}
        saveConfig(cfg);
    }
    return cfg;
}

function saveConfig(cfg) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

// ---------- guest API ----------

function apiBase(cfg) {
    return `http://${cfg.host}:${cfg.apiPort}`;
}

async function api(cfg, route, opts = {}) {
    const res = await fetch(`${apiBase(cfg)}${route}`, { signal: AbortSignal.timeout(15000), ...opts });
    if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}`);
    return res;
}

// ---------- .rdp generation ----------

const RDP_COMMON = [
    "redirectclipboard:i:1",
    "drivestoredirect:s:*",
    "audiomode:i:0",
    "audiocapturemode:i:1",
    "networkautodetect:i:1",
    "bandwidthautodetect:i:1",
    "connection type:i:6",
    "compression:i:1",
    "session bpp:i:32",
    "allow font smoothing:i:1",
    "disable wallpaper:i:1",
    "disable full window drag:i:1",
    "disable menu anims:i:1",
    "dynamic resolution:i:1",
    "autoreconnection enabled:i:1",
    "videoplaybackmode:i:1",
];

function rdpForApp(cfg, app) {
    const lines = [
        `full address:s:${cfg.host}:${cfg.rdpPort}`,
        "remoteapplicationmode:i:1",
        `remoteapplicationprogram:s:${app.Path}`,
        `remoteapplicationname:s:${app.Name}`,
        `remoteapplicationcmdline:s:${app.Args ?? ""}`,
        "disableremoteappcapscheck:i:1",
        "alternate shell:s:rdpinit.exe",
        ...RDP_COMMON,
    ];
    addUsername(cfg, lines);
    if (cfg.scale) lines.push(`desktopscalefactor:i:${cfg.scale}`);
    return lines.join("\r\n") + "\r\n";
}

// Accept "domain/user" as an alias for "domain\user" so the shell's backslash
// handling can't mangle it when setting config. When a username is prefilled,
// force a credential prompt: without it, Windows App attempts NLA silently
// with no password and fails with an opaque 0x1807 security error.
function addUsername(cfg, lines) {
    if (!cfg.username) return;
    lines.unshift(`username:s:${cfg.username.replace("/", "\\")}`);
    // Force the credential prompt unless disabled (once creds are saved in
    // Windows App, turn off for silent connects: dinghy config promptcreds off)
    if (cfg.promptcreds !== "off") lines.push("prompt for credentials on client:i:1");
}

function rdpForDesktop(cfg) {
    const lines = [
        `full address:s:${cfg.host}:${cfg.rdpPort}`,
        "screen mode id:i:2",
        "smart sizing:i:1",
        "use multimon:i:0",
        ...RDP_COMMON,
    ];
    addUsername(cfg, lines);
    if (cfg.scale) lines.push(`desktopscalefactor:i:${cfg.scale}`);
    return lines.join("\r\n") + "\r\n";
}

// ---------- .app bundle generation ----------

function safeName(name) {
    return name.replace(/[/:]/g, "-").replace(/\s+/g, " ").trim();
}

// Windows App titles RemoteApp windows after the .rdp filename, so name the
// file after the app (must also be safe to embed in the launcher script).
function rdpFileName(name) {
    return (safeName(name).replace(/["'`$\\]/g, "") || "app") + ".rdp";
}

function makeIcns(pngBase64, icnsPath, tmpDir) {
    // Guest icons are 32x32 PNGs; upscale into a minimal iconset.
    const src = path.join(tmpDir, "src.png");
    fs.writeFileSync(src, Buffer.from(pngBase64, "base64"));
    const iconset = path.join(tmpDir, "app.iconset");
    fs.mkdirSync(iconset, { recursive: true });
    const sizes = [16, 32, 128, 256];
    for (const s of sizes) {
        spawnSync("sips", ["-z", String(s), String(s), src, "--out", path.join(iconset, `icon_${s}x${s}.png`)], { stdio: "ignore" });
    }
    const r = spawnSync("iconutil", ["-c", "icns", iconset, "-o", icnsPath], { stdio: "ignore" });
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.rmSync(src, { force: true });
    return r.status === 0;
}

function writeAppBundle(cfg, dirName, displayName, rdpContent, iconBase64, tmpDir, appMeta) {
    const appPath = path.join(cfg.appsDir, `${dirName}.app`);
    const contents = path.join(appPath, "Contents");
    const macos = path.join(contents, "MacOS");
    const resources = path.join(contents, "Resources");
    fs.rmSync(appPath, { recursive: true, force: true });
    fs.mkdirSync(macos, { recursive: true });
    fs.mkdirSync(resources, { recursive: true });

    // Static .rdp as a last-resort fallback; normal launches go through
    // `dinghy open-rdp`, which regenerates it with the VM's current address.
    const rdpFile = rdpFileName(displayName);
    fs.writeFileSync(path.join(resources, rdpFile), rdpContent);
    fs.writeFileSync(path.join(resources, "app.json"), JSON.stringify(appMeta ?? { desktop: true }, null, 2));

    let iconEntry = "";
    if (iconBase64 && makeIcns(iconBase64, path.join(resources, "app.icns"), tmpDir)) {
        iconEntry = "    <key>CFBundleIconFile</key>\n    <string>app</string>\n";
    }

    const bundleId = "app.windinghy." + dirName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
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
    const nodeBin = process.execPath;
    const wbmPath = fileURLToPath(import.meta.url);
    fs.writeFileSync(
        launcher,
        `#!/bin/bash
# Generated by dinghy sync. Launches via dinghy (auto-rediscovers the VM, boots it
# if needed); falls back to the static .rdp if node/dinghy has moved.
DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
if [ -x "${nodeBin}" ] && [ -f "${wbmPath}" ]; then
    exec "${nodeBin}" "${wbmPath}" open-rdp "$DIR"
fi
exec open -a "Windows App" "$DIR/${rdpFile}"
`);
    fs.chmodSync(launcher, 0o755);
    return appPath;
}

// ---------- commands ----------

async function cmdStatus(cfg) {
    process.stdout.write(`Guest API ${apiBase(cfg)} ... `);
    try {
        const health = await (await api(cfg, "/health")).json();
        const version = await (await api(cfg, "/version")).json();
        const metrics = await (await api(cfg, "/metrics")).json();
        console.log(`ok (guest server v${version.version})`);
        console.log(`  CPU ${metrics.cpu.usage.toFixed(0)}%  RAM ${metrics.ram.used}/${metrics.ram.total} MB  Disk ${(metrics.disk.used / 1024).toFixed(0)}/${(metrics.disk.total / 1024).toFixed(0)} GB`);
    } catch (e) {
        console.log(`UNREACHABLE (${e.message})`);
    }
    const rdpUp = await portOpen(cfg.host, cfg.rdpPort);
    console.log(`RDP ${cfg.host}:${cfg.rdpPort} ... ${rdpUp ? "open" : "CLOSED"}`);
}

async function portOpen(host, port) {
    const { default: net } = await import("node:net");
    return new Promise(resolve => {
        const s = net.connect({ host, port, timeout: 3000 });
        s.on("connect", () => { s.destroy(); resolve(true); });
        s.on("error", () => resolve(false));
        s.on("timeout", () => { s.destroy(); resolve(false); });
    });
}

async function cmdSync(cfg) {
    console.log(`Fetching app list from ${apiBase(cfg)}/apps ...`);
    const apps = await (await api(cfg, "/apps")).json();
    console.log(`Guest reports ${apps.length} apps`);

    fs.mkdirSync(cfg.appsDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dinghy-icons-"));
    const kept = new Set();

    // Clean names, drop noise, dedupe by name
    const byName = new Map();
    let filtered = 0;
    for (const app of apps) {
        if (!app?.Name || !app?.Path) continue;
        app.Name = fixName(app.Name);
        if (cfg.filter !== "off" && EXCLUDE_PATTERNS.some(p => p.test(app.Name))) { filtered++; continue; }
        const key = safeName(app.Name);
        if (!byName.has(key)) byName.set(key, app);
    }
    if (filtered) console.log(`Filtered ${filtered} non-app entries (codecs/runtimes/etc; disable with: dinghy config filter off)`);

    let made = 0;
    for (const [key, app] of byName) {
        const meta = { Name: app.Name, Path: app.Path, Args: app.Args ?? "", Source: app.Source ?? "" };
        const appPath = writeAppBundle(cfg, key, app.Name, rdpForApp(cfg, app), app.Icon, tmpDir, meta);
        kept.add(path.basename(appPath));
        made++;
    }

    // Full-desktop launcher
    const desktopPath = writeAppBundle(cfg, "Windows Desktop", "Windows Desktop", rdpForDesktop(cfg), null, tmpDir, { desktop: true });
    kept.add(path.basename(desktopPath));

    // Remove launchers for apps that disappeared from the guest
    for (const entry of fs.readdirSync(cfg.appsDir)) {
        if (entry.endsWith(".app") && !kept.has(entry)) {
            fs.rmSync(path.join(cfg.appsDir, entry), { recursive: true, force: true });
            console.log(`  removed stale ${entry}`);
        }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log(`Synced ${made} apps -> ${cfg.appsDir}`);
    console.log(`Launch from Spotlight, Finder, or: dinghy launch "<name>"`);
    if (!cfg.username) {
        console.log(`Tip: set your Windows username so Windows App can pre-fill it:`);
        console.log(`  dinghy config username <your-windows-user>`);
    }
}

// ---------- dynamic launch (used by the .app launchers) ----------

function notify(msg) {
    // Launchers run without a terminal; surface progress as notifications.
    spawnSync("osascript", ["-e", `display notification ${JSON.stringify(msg)} with title "WinBoat"`], { stdio: "ignore" });
}

async function guestAlive(cfg, timeoutMs = 2500) {
    try {
        const res = await fetch(`${apiBase(cfg)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
    } catch { return false; }
}

// Scan vmnet bridge subnets (bridge100/101/...) for the guest API port.
// Only ~254 candidates on host-only interfaces, checked in parallel: ~1-2s.
async function discoverGuest(cfg) {
    const subnets = [];
    for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
        if (!ifname.startsWith("bridge")) continue;
        for (const a of addrs ?? []) {
            if (a.family === "IPv4") subnets.push(a.address.split(".").slice(0, 3).join("."));
        }
    }
    for (const net of subnets) {
        const candidates = [];
        for (let i = 2; i < 255; i++) candidates.push(`${net}.${i}`);
        const results = await Promise.all(candidates.map(async ip => {
            try {
                const res = await fetch(`http://${ip}:${cfg.apiPort}/health`, { signal: AbortSignal.timeout(1500) });
                return res.ok ? ip : null;
            } catch { return null; }
        }));
        const found = results.find(Boolean);
        if (found) return found;
    }
    return null;
}

function utmctlStart(cfg) {
    // Fire-and-forget: utmctl can block on automation-permission prompts,
    // so never wait on it directly.
    const utmctl = "/Applications/UTM.app/Contents/MacOS/utmctl";
    if (!fs.existsSync(utmctl)) return false;
    const p = spawn(utmctl, ["start", cfg.vmName], { detached: true, stdio: "ignore" });
    p.unref();
    return true;
}

async function ensureGuest(cfg, interactive) {
    if (await guestAlive(cfg)) return true;

    const found = await discoverGuest(cfg);
    if (found) {
        if (found !== cfg.host) {
            cfg.host = found;
            saveConfig(cfg);
            if (interactive) console.log(`VM moved; config updated to ${found}`);
            else notify(`Windows VM found at ${found}`);
        }
        return true;
    }

    // Nothing answering: try to boot the VM and wait for it
    if (interactive) console.log(`Guest unreachable; starting UTM VM "${cfg.vmName}" ...`);
    else notify(`Starting Windows VM "${cfg.vmName}" — this can take a minute`);
    if (!utmctlStart(cfg)) return false;

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 4000));
        if (await guestAlive(cfg)) return true;
        const found2 = await discoverGuest(cfg);
        if (found2) {
            cfg.host = found2;
            saveConfig(cfg);
            return true;
        }
    }
    return false;
}

async function cmdOpenRdp(cfg, bundleDir) {
    const metaPath = path.join(bundleDir, "app.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const ok = await ensureGuest(cfg, false);
    if (!ok) {
        notify(`Can't reach the Windows VM. Start it in UTM, then try again.`);
        process.exit(1);
    }
    const rdp = meta.desktop ? rdpForDesktop(cfg) : rdpForApp(cfg, meta);
    const rdpPath = path.join(bundleDir, rdpFileName(meta.desktop ? "Windows Desktop" : meta.Name));
    fs.writeFileSync(rdpPath, rdp);
    // Bundles synced before rdp files were named after the app left an app.rdp behind
    if (path.basename(rdpPath) !== "app.rdp") fs.rmSync(path.join(bundleDir, "app.rdp"), { force: true });
    execFileSync("open", ["-a", "Windows App", rdpPath]);
    bumpUsage(meta.Name ?? "Windows Desktop");
}

// Local launch counts drive the menu-bar app's Favorites section.
function bumpUsage(name) {
    const usagePath = path.join(CONFIG_DIR, "usage.json");
    let usage = {};
    try { usage = JSON.parse(fs.readFileSync(usagePath, "utf8")); } catch {}
    usage[name] = (usage[name] ?? 0) + 1;
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(usagePath, JSON.stringify(usage, null, 2));
}

async function cmdDoctor(cfg) {
    const checks = [];
    const add = (ok, label, advice) => checks.push({ ok, label, advice });

    add(fs.existsSync("/Applications/Windows App.app"), "Windows App installed",
        "Install it from the Mac App Store (search: Windows App).");
    add(fs.existsSync("/Applications/UTM.app"), "UTM installed",
        "Install from https://mac.getutm.app");
    add(true, `node ${process.version}`, "");
    const cfgExists = fs.existsSync(CONFIG_PATH);
    add(cfgExists, "dinghy config present", "Run: dinghy sync (or dinghy serve-setup for first-time setup)");
    const alive = await guestAlive(cfg, 3000);
    add(alive, `guest agent at ${cfg.host}:${cfg.apiPort}`,
        "VM off or agent not installed. Start the VM in UTM; for first-time guest setup run `dinghy serve-setup` on the Mac, then paste the printed one-liner into an elevated PowerShell inside Windows.");
    const rdp = await portOpen(cfg.host, cfg.rdpPort);
    add(rdp, `RDP at ${cfg.host}:${cfg.rdpPort}`,
        "RDP host not enabled in the guest — re-run the serve-setup one-liner inside Windows (needs Windows Pro/Enterprise).");
    if (alive) {
        // Clock skew breaks CredSSP with opaque security errors (0x1807)
        try {
            const res = await fetch(`${apiBase(cfg)}/health`, { signal: AbortSignal.timeout(3000) });
            const guestTime = new Date(res.headers.get("date")).getTime();
            const skew = Math.abs(Date.now() - guestTime) / 1000;
            add(skew < 120, `guest clock skew ${Math.round(skew)}s`,
                "Guest clock has drifted — RDP auth will fail with security errors. In the VM run: w32tm /resync (or re-run the serve-setup one-liner, which installs a 15-min sync task).");
        } catch {}
    }
    const launcherCount = fs.existsSync(cfg.appsDir) ? fs.readdirSync(cfg.appsDir).filter(e => e.endsWith(".app")).length : 0;
    add(launcherCount > 0, `${launcherCount} app launchers in ${cfg.appsDir}`, "Run: dinghy sync");

    let allOk = true;
    for (const c of checks) {
        console.log(`${c.ok ? " OK " : "FAIL"}  ${c.label}`);
        if (!c.ok && c.advice) { console.log(`      -> ${c.advice}`); allOk = false; }
    }
    process.exit(allOk ? 0 : 1);
}

async function cmdLaunch(cfg, name) {
    if (!name) throw new Error(`Usage: dinghy launch "<app name>"`);
    const entries = fs.existsSync(cfg.appsDir) ? fs.readdirSync(cfg.appsDir).filter(e => e.endsWith(".app")) : [];
    const match =
        entries.find(e => e.toLowerCase() === `${name.toLowerCase()}.app`) ??
        entries.find(e => e.toLowerCase().includes(name.toLowerCase()));
    if (!match) throw new Error(`No synced app matches "${name}". Run: dinghy sync`);
    console.log(`Launching ${match.replace(/\.app$/, "")} ...`);
    await cmdOpenRdp(cfg, path.join(cfg.appsDir, match, "Contents", "Resources"));
}

function detectServeIp(cfg) {
    // Pick the local interface that shares a /24 with the guest (vmnet bridge)
    const prefix = cfg.host.split(".").slice(0, 3).join(".") + ".";
    for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs ?? []) {
            if (a.family === "IPv4" && a.address.startsWith(prefix)) return a.address;
        }
    }
    return null;
}

// With json=true (used by the menu-bar app) the first stdout line is
// machine-readable: {"url": ..., "oneliner": ...}; human logs are suppressed.
async function cmdServeSetup(cfg, json = false) {
    if (!fs.existsSync(path.join(PAYLOAD_DIR, "setup.ps1")))
        throw new Error(`Guest payload not found at ${PAYLOAD_DIR} — run from a full windinghy checkout.`);
    const ip = detectServeIp(cfg);
    if (!ip) throw new Error(`No local interface on the guest's subnet (${cfg.host}/24). Is the VM running with shared networking?`);

    const baseUrl = `http://${ip}:${SETUP_PORT}`;
    const setupTemplate = fs.readFileSync(path.join(PAYLOAD_DIR, "setup.ps1"), "utf8");
    const setupScript = setupTemplate.replace("__BASE_URL__", baseUrl);

    // Build payload.zip fresh (server binary + scripts + nssm)
    const zipPath = path.join(os.tmpdir(), "dinghy-payload.zip");
    fs.rmSync(zipPath, { force: true });
    execFileSync("ditto", ["-c", "-k", "--norsrc", PAYLOAD_DIR, zipPath]);
    const zipBuf = fs.readFileSync(zipPath);

    const server = http.createServer((req, res) => {
        if (req.url === "/setup.ps1") {
            console.log(`  [${new Date().toLocaleTimeString()}] guest fetched setup.ps1`);
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(setupScript);
        } else if (req.url === "/payload.zip") {
            console.log(`  [${new Date().toLocaleTimeString()}] guest fetched payload.zip (${(zipBuf.length / 1e6).toFixed(1)} MB)`);
            res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": zipBuf.length });
            res.end(zipBuf);
        } else {
            res.writeHead(404);
            res.end("not found");
        }
    });
    server.listen(SETUP_PORT, ip);

    const oneliner = `irm ${baseUrl}/setup.ps1 | iex`;
    if (json) {
        console.log(JSON.stringify({ url: baseUrl, oneliner }));
    } else {
        console.log(`Serving guest setup on ${baseUrl}`);
        console.log(``);
        console.log(`  In the Windows VM, open PowerShell **as Administrator** and run:`);
        console.log(``);
        console.log(`      ${oneliner}`);
        console.log(``);
    }
    // Re-run case: guest already online means the user is refreshing guest
    // config, not installing — keep serving until stopped (Ctrl-C, or the
    // menu-bar app's Stop button).
    if (await guestAlive(cfg, 2500)) {
        if (!json) console.log(`Guest is already online — serving the (updated) setup script until Ctrl-C.`);
        await new Promise(() => {});
    }

    if (!json) console.log(`Waiting for the guest server to come up on ${cfg.host}:${cfg.apiPort} (Ctrl-C to stop) ...`);
    while (true) {
        await new Promise(r => setTimeout(r, 3000));
        if (await guestAlive(cfg, 2500)) break;
    }
    if (!json) console.log(`Guest server is UP. Running first sync ...`);
    server.close();
    await cmdSync(cfg);
}

function cmdConfig(cfg, key, value) {
    if (!key) {
        console.log(JSON.stringify(cfg, null, 2));
        console.log(`(config file: ${CONFIG_PATH})`);
        return;
    }
    if (!(key in DEFAULTS)) throw new Error(`Unknown config key "${key}". Valid: ${Object.keys(DEFAULTS).join(", ")}`);
    if (value === undefined) {
        console.log(cfg[key]);
        return;
    }
    cfg[key] = /^\d+$/.test(value) && key.endsWith("Port") ? Number(value) : value;
    saveConfig(cfg);
    console.log(`${key} = ${cfg[key]}`);
}

// ---------- main ----------

const [cmd, ...rest] = process.argv.slice(2);
const cfg = loadConfig();

try {
    switch (cmd) {
        case "serve-setup": await cmdServeSetup(cfg, rest.includes("--json")); break;
        case "status":      await cmdStatus(cfg); break;
        case "sync":        await cmdSync(cfg); break;
        case "launch":      await cmdLaunch(cfg, rest.join(" ")); break;
        case "desktop":     await cmdLaunch(cfg, "Windows Desktop"); break;
        case "open-rdp":    await cmdOpenRdp(cfg, rest[0]); break;
        case "doctor":      await cmdDoctor(cfg); break;
        case "config":      cmdConfig(cfg, rest[0], rest[1]); break;
        case "version":
        case "--version":
        case "-v":          console.log(`dinghy ${VERSION}`); break;
        default:
            console.log(`dinghy — WinDinghy ${VERSION}

Usage:
  dinghy serve-setup          serve guest payload; prints the one-liner to run in the VM
  dinghy status               guest health / metrics / RDP reachability
  dinghy sync                 generate ~/Applications/WinBoat/*.app launchers
  dinghy launch "<name>"      launch a Windows app
  dinghy desktop              full Windows desktop session
  dinghy doctor               check mac-side + guest-side requirements
  dinghy config [key [val]]   show/set config (host, apiPort, rdpPort, username, appsDir)
  dinghy version              print the WinDinghy version`);
    }
} catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
}
