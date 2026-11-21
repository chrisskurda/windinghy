#!/usr/bin/env node
// dinghy — WinDinghy host CLI
// Talks to the WinBoat Guest Server inside a Windows VM (UTM or anything
// reachable over IP) and turns Windows apps into native-feeling macOS
// launchers that open as RemoteApp windows via Microsoft's "Windows App".
//
// Commands:
//   dinghy vm <create|start|stop|status|snapshot|snapshots|rewind|snapshot-delete|screenshot|use|destroy>  the VM WinDinghy manages itself (QEMU, no UTM)
//   dinghy setup                hands-free setup via the UTM guest agent (falls back to serve-setup)
//   dinghy fix [session|rdp|clock|server|login]  repair common guest problems via the guest agent
//   dinghy serve-setup          serve the guest payload + setup one-liner, wait for the guest
//                               (--no-banner or config suppressBanner=on: keep the Windows banner suppressed; opt-in, may violate network policy)
//   dinghy status               guest health / version / metrics
//   dinghy permissions [--prompt]  check (or request) the macOS App Management permission
//   dinghy discover             find the VM again after its IP changed (by MAC, then subnet scan)
//   dinghy sync                 fetch app list, (re)generate ~/Applications/WinDinghy/*.app
//   dinghy launch <name>        launch a synced app
//   dinghy desktop              open a full Windows desktop session
//   dinghy login                save the Windows password in the macOS Keychain (native client)
//   dinghy config [key value]   show or set config (host, username, appsDir, ...)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import * as G from "./guest.mjs";
import * as VM from "./vm.mjs";

// Single source of truth for the WinDinghy version. Release: bump this,
// move CHANGELOG "Unreleased" entries under the new version, tag vX.Y.Z.
const VERSION = "0.2.0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
// Inside the menu-bar app the payload and the native client sit next to dinghy.mjs.
const PAYLOAD_DIR = fs.existsSync(path.join(__dirname, "payload")) ? path.join(__dirname, "payload") : path.join(PROJECT_ROOT, "payload");
const CONFIG_DIR = path.join(os.homedir(), ".config", "windinghy");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const SETUP_PORT = Number(process.env.DINGHY_SETUP_PORT) || 8756;

const DEFAULTS = {
    host: "192.168.64.8",
    apiPort: 7148,
    rdpPort: 3389,
    username: "",
    scale: "",
    promptcreds: "on",
    vmName: "Windows",
    vmCpus: 4,           // managed VM resources (applied the next time it starts)
    vmRamGB: 6,
    vmDiskGB: 64,
    shareClipboard: "on",  // what Windows apps may reach on this Mac (applied at the next app launch)
    shareHome: "on",
    redirect_documents: "on", redirect_downloads: "on", redirect_desktop: "on", redirect_pictures: "on", redirect_music: "on", redirect_videos: "on",
    sharePrinters: "off",
    shareAudio: "on",
    sharedFolders: [],
    readOnlyShares: [],  // share names (Home, Documents, ...) served read-only to Windows
    advanced: "off",     // on: unlock unsupported setups (UTM or another hypervisor, remote hosts, custom clients)
    vmBackend: "utm",    // utm (a VM you run in UTM) or qemu (the VM WinDinghy manages: dinghy vm create)
    vmDir: "",           // where the managed VM lives (default ~/Library/Application Support/WinDinghy/vm)
    vmMac: "",           // learned automatically: the VM's MAC, used to find it when its IP changes
    filter: "on",
    client: "auto",      // auto | native | windows-app
    nativeBin: "",       // path to the patched sdl-freerdp (default: vendor/freerdp/bin)
    suppressBanner: "off", // on: guest setup also blanks the Windows logon banner (see docs; may violate network policy)
    nativeDebug: "off",  // on: log RAIL window/focus traffic to ~/.config/windinghy/logs/<app>.log
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

// Make a saved config safe to use whatever state it's in (hand-edited, from an older version, left
// over from a removed VM or build). Returns the list of things it fixed.
function sanitizeConfig(cfg) {
    const notes = [];
    const fix = (cond, msg, apply) => { if (cond) { apply(); notes.push(msg); } };
    fix(!["utm", "qemu"].includes(cfg.vmBackend), `unknown vmBackend "${cfg.vmBackend}" -> utm`, () => { cfg.vmBackend = "utm"; });
    fix(!["auto", "native", "windows-app"].includes(cfg.client), `unknown client "${cfg.client}" -> auto`, () => { cfg.client = "auto"; });
    for (const k of ["apiPort", "rdpPort"])
        fix(!Number.isInteger(cfg[k]) || cfg[k] < 1 || cfg[k] > 65535, `bad ${k} "${cfg[k]}" -> ${DEFAULTS[k]}`, () => { cfg[k] = DEFAULTS[k]; });
    if (cfg.vmBackend === "qemu") {
        // The managed VM is always behind these forwarded ports; anything else is stale.
        fix(cfg.host !== "127.0.0.1" || cfg.rdpPort !== VM.RDP_PORT || cfg.apiPort !== VM.API_PORT,
            "managed VM address reset to 127.0.0.1 and its forwarded ports", () => { cfg.host = "127.0.0.1"; cfg.rdpPort = VM.RDP_PORT; cfg.apiPort = VM.API_PORT; });
        fix(cfg.vmName !== VM.VM_NAME, `managed VM name "${cfg.vmName}" -> ${VM.VM_NAME}`, () => { cfg.vmName = VM.VM_NAME; });
    }
    fix(cfg.nativeBin && !fs.existsSync(cfg.nativeBin), `nativeBin ${cfg.nativeBin} no longer exists (removed volume or build) -> use the bundled client`, () => { cfg.nativeBin = ""; });
    if (cfg.profiles === undefined) cfg.profiles = {};   // absent is normal (nothing saved yet)
    fix(!cfg.profiles || typeof cfg.profiles !== "object" || Array.isArray(cfg.profiles), "saved backend profiles were corrupt -> reset", () => { cfg.profiles = {}; });
    fix(!Array.isArray(cfg.readOnlyShares) || cfg.readOnlyShares.some(x => typeof x !== "string"), "read-only share list was corrupt -> cleared", () => { cfg.readOnlyShares = []; });
    fix(typeof cfg.username !== "string", "username wasn't text -> cleared", () => { cfg.username = ""; });
    // Banner files from older VMs: drop any that are unreadable or hold no real text.
    for (const f of ["banner.json", "banner-qemu.json"]) {
        const bp = path.join(CONFIG_DIR, f);
        if (!fs.existsSync(bp)) continue;
        let ok = false;
        try { const b = JSON.parse(fs.readFileSync(bp, "utf8")); ok = !!(cleanBanner(b.text) || cleanBanner(b.caption)); } catch {}
        if (!ok) { fs.rmSync(bp, { force: true }); notes.push(`removed empty/corrupt ${f}`); }
    }
    return notes;
}

function loadConfig() {
    migrateLegacyPaths();
    let cfg;
    try {
        cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
    } catch (e) {
        cfg = { ...DEFAULTS };
        if (fs.existsSync(CONFIG_PATH)) {
            // Unreadable config: keep a copy for inspection and start clean instead of failing.
            const bak = `${CONFIG_PATH}.broken-${Date.now()}`;
            try { fs.copyFileSync(CONFIG_PATH, bak); console.error(`WinDinghy: config.json was unreadable; saved a copy as ${path.basename(bak)} and started fresh.`); } catch {}
            try { saveConfig(cfg); } catch {}
        }
    }
    const repaired = sanitizeConfig(cfg);
    if (repaired.length) {
        for (const n of repaired) console.error(`WinDinghy: repaired settings: ${n}`);
        try { saveConfig(cfg); } catch {}
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

// ---------- advanced mode ----------
// The supported setup is the VM WinDinghy manages itself (dinghy vm create). Anything else (UTM or
// another hypervisor, a VM on another machine, a custom RDP client) may work but is unsupported and
// lives behind advanced mode.

const isAdvanced = cfg => cfg.advanced === "on";

function needAdvanced(cfg, what) {
    if (isAdvanced(cfg)) return;
    throw new Error(`${what} is an advanced option and isn't supported. WinDinghy's supported setup is the VM it manages itself (dinghy vm create). If you know what you're doing: dinghy config advanced on`);
}

// Local = this Mac (the managed VM) or UTM's private bridge. Anything else is another machine.
function isLocalHost(h) {
    return /^(127\.|localhost$|::1$|192\.168\.64\.)/i.test(String(h ?? ""));
}

const REMOTE_WARNING = "This host isn't on this Mac. The guest API is plain HTTP and the connection is only as private as the network it crosses: don't use it over the internet or untrusted networks unless it's inside an encrypted VPN (WireGuard, Tailscale, ...). Encrypted remote support is on the roadmap.";

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
    await ensureAppManagement(cfg);
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
        const meta = { Name: app.Name, Path: app.Path, Args: app.Args ?? "", Source: app.Source ?? "", Category: appCategory(app) };
        const appPath = writeAppBundle(cfg, key, app.Name, rdpForApp(cfg, app), app.Icon, tmpDir, meta);
        kept.add(path.basename(appPath));
        made++;
    }

    // Windows Settings (also the target of the helpers that open specific Settings pages)
    const settingsApp = { Name: "Windows Settings", Path: "C:\\Windows\\explorer.exe", Args: "ms-settings:", Source: "dinghy" };
    kept.add(path.basename(writeAppBundle(cfg, "Windows Settings", "Windows Settings", rdpForApp(cfg, settingsApp), null, tmpDir, { ...settingsApp, Category: "tool" })));
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
    spawnSync("osascript", ["-e", `display notification ${JSON.stringify(msg)} with title "WinDinghy"`], { stdio: "ignore" });
}

async function guestAlive(cfg, timeoutMs = 2500) {
    try {
        const res = await fetch(`${apiBase(cfg)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
    } catch { return false; }
}

// Scan vmnet bridge subnets (bridge100/101/...) for the guest API port.
// Only ~254 candidates on host-only interfaces, checked in parallel: ~1-2s.
// ---- finding the VM when its address changes ----
// Identify the VM by MAC (stable across DHCP changes): live ARP table first, then
// macOS's DHCP lease file; always verify the candidate before trusting it. Falls
// back to probing the guest-server port across the vmnet bridge subnets.

function normMac(m) {
    return String(m).toLowerCase().split(":").map(x => x.padStart(2, "0")).join(":");
}

function arpTable() {
    const r = spawnSync("arp", ["-an"], { encoding: "utf8" });
    const out = [];
    for (const line of (r.stdout || "").split("\n")) {
        const m = line.match(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i);
        if (m) out.push({ ip: m[1], mac: normMac(m[2]) });
    }
    return out;
}

function macForIp(ip) {
    const find = () => arpTable().find(e => e.ip === ip)?.mac ?? null;
    // ARP entries expire after ~20 minutes: poke the address once to refresh it.
    return find() ?? (spawnSync("ping", ["-c", "1", "-t", "2", ip], { stdio: "ignore" }), find());
}

function leaseIpsForMac(mac) {
    const hits = [];
    try {
        const txt = fs.readFileSync("/var/db/dhcpd_leases", "utf8");
        for (const block of txt.split("}")) {
            const ip = block.match(/ip_address=(\S+)/)?.[1];
            const hw = block.match(/hw_address=\d+,(\S+)/)?.[1];
            const lease = parseInt(block.match(/lease=(0x[0-9a-f]+)/i)?.[1] ?? "0", 16);
            if (ip && hw && normMac(hw) === mac) hits.push({ ip, lease });
        }
    } catch {}
    return hits.sort((x, y) => y.lease - x.lease).map(h => h.ip);
}

let discoverMethod = "";

async function ipForMac(cfg, mac) {
    const fromArp = arpTable().filter(e => e.mac === mac).map(e => e.ip);
    const fromLease = leaseIpsForMac(mac);
    for (const [how, ips] of [["MAC via ARP", fromArp], ["MAC via DHCP lease", fromLease]]) {
        for (const ip of ips) {
            if (await portOpen(ip, cfg.apiPort) || await portOpen(ip, cfg.rdpPort)) { discoverMethod = how; return ip; }
        }
    }
    return null;
}

// UTM VMs known on this Mac: name + MAC addresses, read from their config.plist.
function utmVms() {
    const dirs = new Set();
    const docs = path.join(os.homedir(), "Library/Containers/com.utmapp.UTM/Data/Documents");
    const addFrom = d => { try { for (const f of fs.readdirSync(d)) if (f.endsWith(".utm")) dirs.add(path.join(d, f)); } catch {} };
    addFrom(docs);
    try { for (const v of fs.readdirSync("/Volumes")) addFrom(path.join("/Volumes", v)); } catch {}
    const md = spawnSync("mdfind", ['kMDItemFSName == "*.utm"'], { encoding: "utf8", timeout: 5000 });
    for (const p of (md.stdout || "").split("\n")) if (p.endsWith(".utm")) dirs.add(p);
    const vms = [];
    for (const d of dirs) {
        const r = spawnSync("plutil", ["-convert", "json", "-o", "-", path.join(d, "config.plist")], { encoding: "utf8" });
        if (r.status !== 0) continue;
        try {
            const j = JSON.parse(r.stdout);
            const macs = (j.Network ?? []).map(n => n.MacAddress).filter(Boolean).map(normMac);
            if (macs.length) vms.push({ name: j.Information?.Name ?? path.basename(d, ".utm"), path: d, macs });
        } catch {}
    }
    return vms;
}

// Remember the guest's MAC (and which UTM VM it is) once it has been seen.
function learnGuest(cfg, ip) {
    const mac = macForIp(ip);
    if (!mac) return;
    let changed = false;
    if (cfg.vmMac !== mac) { cfg.vmMac = mac; changed = true; }
    const vm = utmVms().find(v => v.macs.includes(mac));
    if (vm && cfg.vmName !== vm.name) { cfg.vmName = vm.name; changed = true; }
    if (changed) saveConfig(cfg);
}

async function discoverGuest(cfg) {
    if (G.backendKind() === "qemu") return null; // fixed forwarded address: nothing to discover
    if (cfg.vmMac) {
        const ip = await ipForMac(cfg, normMac(cfg.vmMac));
        if (ip) return ip;
    }
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
        if (found) { discoverMethod = "subnet scan"; learnGuest(cfg, found); return found; }
    }
    return null;
}

// Like guestAlive, but also re-discovers the VM when its address changed
// (DHCP reassignment) and updates the saved config.
async function findGuest(cfg, timeoutMs = 2500) {
    if (await guestAlive(cfg, timeoutMs)) {
        if (!cfg.vmMac) learnGuest(cfg, cfg.host);
        return true;
    }
    const found = await discoverGuest(cfg);
    if (!found) return false;
    if (found !== cfg.host) {
        cfg.host = found;
        saveConfig(cfg);
        console.log(`VM address changed; config updated to ${found}`);
    }
    return true;
}

function utmctlStart(cfg) {
    if (G.backendKind() === "qemu") return G.startVm(cfg.vmName);
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

// Guest clock drift after VM pauses breaks CredSSP with opaque security
// errors (0x1807). Returns skew in seconds, or 0 if it can't be measured.
async function guestClockSkew(cfg) {
    try {
        const res = await fetch(`${apiBase(cfg)}/health`, { signal: AbortSignal.timeout(3000) });
        return Math.abs(Date.now() - new Date(res.headers.get("date")).getTime()) / 1000;
    } catch { return 0; }
}

// ---------- native client (patched FreeRDP sdl-freerdp) ----------
// Replaces Windows App: one process per launch, windows are real macOS windows.
// See docs/native-client-evaluation.md and patches/ (scripts/build-freerdp.sh).

const KEYCHAIN_SERVICE = "windinghy";
const LOG_DIR = path.join(CONFIG_DIR, "logs");

function nativeBin(cfg) {
    const candidates = [
        cfg.nativeBin,
        path.join(__dirname, "freerdp", "bin", "sdl-freerdp"),                 // bundled in the app
        path.join(PROJECT_ROOT, "vendor", "freerdp", "bin", "sdl-freerdp"),    // built from a checkout
    ].filter(Boolean);
    return candidates.find(c => fs.existsSync(c)) ?? null;
}

function useNative(cfg) {
    if (cfg.client === "windows-app") return false;
    const bin = nativeBin(cfg);
    if (cfg.client === "native" && !bin) throw new Error("client is 'native' but no sdl-freerdp was found. Run scripts/build-freerdp.sh or: dinghy config nativeBin <path>");
    return !!bin;
}

function winUser(cfg) {
    return (cfg.username || "").replace("/", "\\");
}

function keychainGet(user) {
    const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", user, "-w"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
}

function keychainSet(user, pw) {
    // `security -i` reads the command from stdin so the password never shows up in argv.
    const q = v => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const r = spawnSync("security", ["-i"], {
        input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${q(user)} -w ${q(pw)}\n`,
        encoding: "utf8",
    });
    return r.status === 0;
}

function keychainDelete(user) {
    spawnSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", user], { stdio: "ignore" });
}

function asDialog(script) {
    const r = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
}

const asq = t => t.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function promptPassword(user, retry = false) {
    const msg = retry ? `Windows rejected the saved password for ${user}. Enter it again:` : `Enter the Windows password for ${user}. It is stored in your macOS Keychain.`;
    return asDialog(`text returned of (display dialog "${asq(msg)}" default answer "" with hidden answer with title "WinDinghy" buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel")`);
}

function getPassword(cfg, forcePrompt = false) {
    const user = winUser(cfg);
    if (!forcePrompt) {
        const pw = keychainGet(user);
        if (pw) return pw;
    }
    const pw = promptPassword(user, forcePrompt);
    if (pw) keychainSet(user, pw);
    return pw || null;
}

// The logon banner belongs to a specific VM: keep one file per backend so the old VM's text
// never shows up for a new one (banner.json is the original UTM one).
function bannerPath(cfg) {
    return path.join(CONFIG_DIR, (cfg?.vmBackend ?? "utm") === "qemu" ? "banner-qemu.json" : "banner.json");
}

// A banner counts only if it has real text: registries can hold a lone NUL or whitespace.
function cleanBanner(t) { return String(t ?? "").replace(/\0/g, "").replace(/\r\n?/g, "\n").trim(); }

// The Windows logon banner (legal notice), reported by the guest during setup.
// Shown natively when the server actually asks for it (the client logs a marker);
// accepting signals the client to dismiss the matching Windows dialog.
function readBanner(cfg) {
    try {
        const b = JSON.parse(fs.readFileSync(bannerPath(cfg), "utf8"));
        return cleanBanner(b.text) || cleanBanner(b.caption) ? b : null;
    } catch { return null; }
}

function nativeBannerAccepted(b) {
    const clean = t => String(t ?? "").replace(/\0/g, "").replace(/\r\n?/g, "\n");
    const body = clean(b.text).trim().slice(0, 3000);
    const out = asDialog(`button returned of (display dialog "${asq(body)}" with title "${asq(clean(b.caption) || "Windows logon notice")}" buttons {"Decline", "Accept"} default button "Accept" cancel button "Decline")`);
    return out === "Accept";
}

function nativeArgs(cfg, meta, pw) {
    const a = [`/v:${cfg.host}`, `/port:${cfg.rdpPort}`];
    if (cfg.username) a.push(`/u:${winUser(cfg)}`);
    a.push(`/p:${pw}`, "/cert:ignore", `/scale-desktop:${cfg.scale || 100}`, "/scale-device:100", "/gfx", "/log-level:WARN");
    // Sharing with the Mac (Preferences > Sharing). Folders appear in Windows as \\tsclient\<name>.
    if (cfg.shareClipboard !== "off") a.push("+clipboard");
    if (cfg.shareAudio !== "off") a.push("/sound");
    if (cfg.sharePrinters === "on") a.push("/printer");
    const drive = (name, p) => a.push(`/drive:${String(name).replace(/[,\/\\:]/g, "_") || "Share"},${p}`);
    if (cfg.shareHome !== "off") drive("Home", os.homedir());
    for (const f of KNOWN_FOLDERS) {
        const mac = path.join(os.homedir(), f.mac);
        if (redirectOn(cfg, f) && fs.existsSync(mac)) drive(f.share, mac);
    }
    for (const f of Array.isArray(cfg.sharedFolders) ? cfg.sharedFolders : []) {
        if (typeof f === "string" && fs.existsSync(f)) drive(path.basename(f), f);
    }
    if (cfg.nativeDebug === "on") a.push("/log-filters:com.freerdp.client.sdl.rail:DEBUG,com.freerdp.channels.rail.client:DEBUG");
    if (meta.desktop) {
        a.push("/size:1440x900", "/dynamic-resolution");
    } else {
        const clean = v => String(v ?? "").replace(/,/g, " ");
        a.push(`/app:program:${meta.Path},name:${clean(meta.Name)}` + (meta.Args ? `,cmd:${meta.Args}` : ""));
    }
    return a;
}

function logTail(file) {
    try { return fs.readFileSync(file, "utf8").split("\n").slice(-40).join("\n"); } catch { return ""; }
}

// ---------- macOS App Management permission ----------
// macOS blocks one app from modifying another app's bundle unless it is allowed in System Settings >
// Privacy & Security > App Management. WinDinghy's launchers in ~/Applications/WinDinghy count as apps,
// so when the menu-bar app (or a dinghy it started) must rewrite them, the switch has to be on.
// There's no API to request it, but a probe tells us whether it's granted: try a harmless edit inside
// an existing launcher's MacOS folder (where the signed client copy lives) and see if macOS refuses.

const APP_MGMT_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles";

// true = allowed (or nothing to protect yet), false = blocked
function probeAppManagement(cfg) {
    let apps = [];
    try { apps = fs.readdirSync(cfg.appsDir).filter(e => e.endsWith(".app")); } catch {}
    const withClient = apps.find(a => fs.existsSync(path.join(cfg.appsDir, a, "Contents", "MacOS", "freerdp"))) ?? apps[0];
    if (!withClient) return true;
    const probe = path.join(cfg.appsDir, withClient, "Contents", "MacOS", ".dinghy-probe");
    try { fs.writeFileSync(probe, "1"); fs.rmSync(probe, { force: true }); return true; }
    catch (e) { return !/^(EPERM|EACCES)$/.test(e.code ?? ""); }
}

// Prompt (native dialog) and, if asked, wait for the user to flip the switch. Returns true if allowed.
async function ensureAppManagement(cfg, { wait = true } = {}) {
    if (probeAppManagement(cfg)) return true;
    const out = asDialog(`button returned of (display dialog "WinDinghy needs permission to update its app launchers.\n\nIn System Settings > Privacy & Security > App Management, turn on WinDinghy. This is a one-time step; I'll continue automatically once it's on." with title "WinDinghy" with icon caution buttons {"Not now", "Open Settings"} default button "Open Settings")`);
    if (out !== "Open Settings") return false;
    spawnSync("open", [APP_MGMT_PANE]);
    if (!wait) return false;
    console.log("Waiting for you to turn on WinDinghy under App Management (up to 3 minutes)...");
    const ok = await waitFor(() => probeAppManagement(cfg), 180, 2500);
    console.log(ok ? "Permission granted." : "Still not allowed: launchers can't be updated until it is.");
    return ok;
}

// macOS "App Management" protection blocks one app from modifying another app's bundle. The launcher
// bundles in ~/Applications/WinDinghy count as apps, so when the menu-bar app (or dinghy started from
// it) can't rewrite them, explain the one-time permission instead of failing silently.
function appManagementHint(err) {
    if (!err || !/^(EPERM|EACCES)$/.test(err.code ?? "")) return false;
    const flag = path.join(CONFIG_DIR, "app-management-hint");
    try { if (Date.now() - fs.statSync(flag).mtimeMs < 600000) return true; } catch {} // at most every 10 minutes
    try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(flag, ""); } catch {}
    const out = asDialog(`button returned of (display dialog "macOS is blocking WinDinghy from updating its app launchers (App Management protection).\n\nOpen System Settings > Privacy & Security > App Management, turn on WinDinghy, then try again." with title "WinDinghy" with icon caution buttons {"Not now", "Open Settings"} default button "Open Settings")`);
    if (out === "Open Settings") spawnSync("open", [APP_MGMT_PANE]);
    return true;
}

// Give the bundle its own copy of the client so macOS shows the app's icon and
// name in the Dock and menu bar (it keys both off the .app containing the
// running executable). The copy finds its dylibs via a Contents/lib symlink.
function bundleClient(bin, bundleDir) {
    try {
        const contents = path.resolve(bundleDir, "..");
        if (!contents.endsWith(".app/Contents")) return bin;
        const dest = path.join(contents, "MacOS", "freerdp");
        const src = fs.statSync(bin);
        let stale = true;
        try { const d = fs.statSync(dest); stale = d.size !== src.size || d.mtimeMs < src.mtimeMs; } catch {}
        if (stale) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(bin, dest);
            fs.chmodSync(dest, 0o755);
            spawnSync("codesign", ["--force", "--sign", "-", dest], { stdio: "ignore" });
        }
        const lib = path.join(contents, "lib");
        const target = path.resolve(path.dirname(bin), "..", "lib");
        let cur = null;
        try { cur = fs.readlinkSync(lib); } catch {}
        if (cur !== target) { try { fs.unlinkSync(lib); } catch {} fs.symlinkSync(target, lib); }
        return dest;
    } catch (e) { appManagementHint(e); return bin; }
}

async function launchNative(cfg, meta, bundleDir, retried = false) {
    const bin = bundleClient(nativeBin(cfg), bundleDir);
    if (!cfg.username) { notify(`Set your Windows login first: dinghy config username <domain\\user>`); process.exit(1); }
    const pw = getPassword(cfg, retried);
    if (!pw) { notify("No Windows password saved. Run: dinghy login"); process.exit(1); }

    const launchedAt = Date.now();
    // Windows keeps one live connection per user, so a newer launch replaces this one. Record our
    // start time; if a later launch has started by the time we exit, we were superseded (silently).
    const lastLaunchFile = path.join(CONFIG_DIR, "last-launch");
    try { fs.writeFileSync(lastLaunchFile, String(launchedAt)); } catch {}
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logFile = path.join(LOG_DIR, `${safeName(meta.Name ?? "desktop")}.log`);
    const fd = fs.openSync(logFile, "w");
    // Credentials go in over stdin (/args-from) so they never appear in `ps`.
    const child = spawn(bin, ["/args-from:stdin"], { detached: true, stdio: ["pipe", fd, fd], env: { ...process.env, WINDINGHY_RO_DRIVES: (Array.isArray(cfg.readOnlyShares) ? cfg.readOnlyShares : []).join(","), WINDINGHY_APP_NAME: meta.Name ?? "Windows Desktop", WINDINGHY_NO_ERROR_DIALOGS: "1" } });
    child.stdin.end(nativeArgs(cfg, meta, pw).join("\n") + "\n");
    child.unref();
    bumpUsage(meta.Name ?? "Windows Desktop");

    // Watch the first seconds: show the logon banner natively when the server
    // asks for it, and turn common failures into useful messages.
    let exited = null, bannerHandled = false;
    child.on("exit", code => { exited = code ?? -1; });
    const deadline = Date.now() + 25000;
    while (exited === null && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 400));
        if (!bannerHandled && logTail(logFile).includes("WINDINGHY-LOGON-NOTICE")) {
            bannerHandled = true;
            const b = readBanner(cfg);
            if (b && (b.text || b.caption)) {
                if (nativeBannerAccepted(b)) process.kill(child.pid, "SIGUSR1");
                else { process.kill(child.pid, "SIGTERM"); return; }
            }
            // No stored banner text: leave the Windows dialog for the user to click.
        }
    }
    // Connected: stay alive until the client exits, then explain any failure.
    while (exited === null) await new Promise(r => setTimeout(r, 1000));
    const log = logTail(logFile);
    if (/ERRCONNECT_LOGON_FAILURE|0x00020014/.test(log) && !retried) {
        keychainDelete(winUser(cfg));
        return launchNative(cfg, meta, bundleDir, true);
    }
    let supersededBy = 0;
    try { supersededBy = Number(fs.readFileSync(lastLaunchFile, "utf8")); } catch {}
    if (supersededBy > launchedAt) return; // a newer launch took over the Windows session
    const problem = diagnoseExit(cfg, exited, log, (Date.now() - launchedAt) / 1000);
    if (problem) showError(problem.title, problem.message, logFile);
}

// Map a client exit to a user-facing problem, or null for a normal end.
function diagnoseExit(cfg, code, log, elapsedSec = 0) {
    // Judge by genuine error lines only: warnings (e.g. "This build does not support AAD security")
    // and debug chatter appear in every healthy session and must not be mistaken for failures.
    const errs = log.split("\n").filter(l => /\[ERROR\]/.test(l)).join("\n");
    if (/LAST-WINDOW-CLOSED/.test(log)) return null;
    // Windows allows one live connection per user: launching another app re-attaches to the same
    // session and replaces this connection (its windows move to the newer client). Not an error.
    if (/CONN_REPLACED|DISCONNECTED_BY_OTHER_CONNECTION/.test(errs)) return null;
    if (/ERRINFO_RPC_INITIATED_DISCONNECT_BY_USER|ERRINFO_DISCONNECT_BY_USER/.test(errs)) return null;
    // Quitting the app (Dock > Quit, Cmd-Q) cancels the connection on purpose; that's not a lost VM.
    if (/ERRCONNECT_CONNECT_CANCELLED|0x0002000B/.test(errs) && !/TRANSPORT_FAILED|CONNECT_FAILED|refused|timed out/i.test(errs.replace(/ERRCONNECT_CONNECT_CANCELLED/g, ""))) return null;
    if (code === 0 || code === null || code === -1) return null; // clean exit or killed by a signal
    if (/ERRCONNECT_LOGON_FAILURE|0x00020014/.test(errs))
        return { title: "Windows rejected the login", message: `Windows rejected the password for ${winUser(cfg)}. Run "dinghy fix login" to reset it, or "dinghy login" to enter the right one.` };
    if (/ERRCONNECT_ACCESS_DENIED|0x00020016|authorization result/.test(errs))
        return { title: "Not allowed to use Remote Desktop", message: `${winUser(cfg)} signed in but isn't allowed to log on over Remote Desktop. Run: dinghy fix login` };
    if (/ERRINFO_(LOGOFF_BY_USER|RPC_INITIATED_DISCONNECT)\b/.test(errs)) {
        // The user signing out of Windows (or an app quitting) a while after connecting is a normal end.
        if (elapsedSec > 45) return null;
        if (cfg.vmBackend === "qemu")
            return { title: "Windows ended the session", message: "Windows closed the session right after connecting (the app may have exited immediately, or isn't installed in this VM). Run: dinghy sync   then try again; if it keeps happening: dinghy fix" };
        return { title: "Windows ended the session", message: `If you're signed in on the VM's own screen as ${winUser(cfg)}, sign out there: RemoteApp can't attach to a desktop session.` };
    }
    if (/0x0*1807|CREDSSP|ERRCONNECT_SECURITY|ERRCONNECT_TLS|SEC_E_/i.test(errs))
        return { title: "Security error", message: "Windows refused the secure connection, usually because the VM clock drifted. Run: dinghy fix clock" };
    if (/TRANSPORT_FAILED|Broken pipe|CONNECT_FAILED|ERRCONNECT_(DNS|CONNECT)|timed out|refused/i.test(errs))
        return { title: "Lost the Windows VM", message: cfg.vmBackend === "qemu"
            ? "Couldn't reach (or lost) the WinDinghy VM. Start it with: dinghy vm start   (then try again)."
            : `Couldn't reach (or lost) the VM at ${cfg.host}. Is it running? Start it in UTM and try again.` };
    if (/IDLE_TIMEOUT|LOGON_TIMEOUT/.test(errs))
        return { title: "Session timed out", message: "Windows ended the session because it was idle or the logon took too long." };
    const last = errs.split("\n").filter(l => /WINDINGHY-ERROR/.test(l)).pop() ?? "";
    const text = last.replace(/^.*WINDINGHY-ERROR:\s*/, "").replace(/\[0x[0-9a-f]+\]/gi, "").trim();
    return { title: "Connection failed", message: (text ? `Windows said: ${text}` : `The Windows connection ended unexpectedly (exit ${code}).`).slice(0, 300) + "  (Show Log has the details.)" };
}

// Native error screen (AppleScript dialog with a caution icon).
function showError(title, message, logFile) {
    const out = asDialog(`button returned of (display dialog "${asq(message)}" with title "WinDinghy: ${asq(title)}" with icon caution buttons {"Show Log", "OK"} default button "OK")`);
    if (out === "Show Log" && logFile) spawnSync("open", ["-t", logFile]);
}

async function cmdOpenRdp(cfg, bundleDir) {
    const metaPath = path.join(bundleDir, "app.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const ok = await ensureGuest(cfg, false);
    if (!ok) {
        notify(`Can't reach the Windows VM. ${startHint(cfg)}, then try again.`);
        process.exit(1);
    }
    // A drifted guest clock breaks CredSSP with opaque errors (0x1807). Set it from the
    // Mac through the guest agent; without the agent, wait for the guest to resync.
    if (!await ensureGuestClock(cfg)) {
        let skew = await guestClockSkew(cfg);
        if (skew > 120) {
            notify(`Windows clock is off by ${Math.round(skew)}s: waiting for it to resync…`);
            const deadline = Date.now() + 75_000;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 5000));
                skew = await guestClockSkew(cfg);
                if (skew <= 120) break;
            }
            if (skew > 120) {
                notify(`Clock still drifted: the connection may fail with a security error (0x1807). Run "dinghy fix clock" (needs the guest agent) or restart the VM.`);
            }
        }
    }
    if (useNative(cfg)) {
        await launchNative(cfg, meta, bundleDir);
        return;
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

    if (nativeBin(cfg) && cfg.client !== "windows-app") {
        add(true, `native RDP client (${nativeBin(cfg)})`, "");
    } else {
        add(fs.existsSync("/Applications/Windows App.app"), "RDP client (Windows App) installed",
            "Run scripts/build-freerdp.sh for the native client, or install Windows App from the Mac App Store.");
    }
    if (isQemu(cfg)) {
        add(VM.tools().ok, "QEMU installed", "Run: brew install qemu");
        add(!VM.exists(cfg) || VM.isRunning(cfg), "WinDinghy VM running", "Start it with: dinghy vm start");
    } else {
        add(fs.existsSync("/Applications/UTM.app"), "UTM installed",
            "Install from https://mac.getutm.app, or run: dinghy vm create (a WinDinghy VM needs no UTM)");
    }
    add(true, `node ${process.version}`, "");
    const cfgExists = fs.existsSync(CONFIG_PATH);
    add(cfgExists, "dinghy config present", "Run: dinghy setup");
    const alive = await guestAlive(cfg, 3000);
    add(alive, `guest agent at ${cfg.host}:${cfg.apiPort}`,
        "VM off or guest components not installed. Run: dinghy setup (it starts the VM and installs everything), or dinghy fix if it was working before.");
    const rdp = await portOpen(cfg.host, cfg.rdpPort);
    add(rdp, `RDP at ${cfg.host}:${cfg.rdpPort}`,
        "RDP isn't reachable. Run: dinghy fix rdp (needs Windows Pro/Enterprise).");
    if (alive) {
        // Clock skew breaks CredSSP with opaque security errors (0x1807)
        try {
            const res = await fetch(`${apiBase(cfg)}/health`, { signal: AbortSignal.timeout(3000) });
            const guestTime = new Date(res.headers.get("date")).getTime();
            const skew = Math.abs(Date.now() - guestTime) / 1000;
            add(skew < 120, `guest clock skew ${Math.round(skew)}s`,
                "Guest clock has drifted (a sleeping Mac pauses the VM; domain policy can block time sync). Run: dinghy fix clock");
        } catch {}
    }
    if (G.utmInstalled() && G.vmStatus(cfg.vmName) === "started") {
        add(G.agentUp(cfg.vmName), "guest agent (enables dinghy setup / fix)",
            isQemu(cfg) ? "The agent isn't answering; give the VM a minute after starting, or run: dinghy fix"
                        : "In UTM choose Virtual Machine > Install Windows Guest Tools, run the installer in Windows once, then: dinghy setup");
    }
    add(probeAppManagement(cfg), "App Management permission (lets WinDinghy update app launchers)",
        "Turn on WinDinghy in System Settings > Privacy & Security > App Management, or run: dinghy permissions --prompt");
    if (isAdvanced(cfg)) add(true, "advanced mode is ON (unsupported setups allowed)", "");
    if (!isLocalHost(cfg.host)) add(false, `host ${cfg.host} is not on this Mac`, REMOTE_WARNING);
    add(fs.existsSync(path.join(PROJECT_ROOT, "host", "dinghy-update.sh")), "updater available",
        "This checkout is missing host/dinghy-update.sh — re-clone the repo.");
    const launcherCount = fs.existsSync(cfg.appsDir) ? fs.readdirSync(cfg.appsDir).filter(e => e.endsWith(".app")).length : 0;
    add(launcherCount > 0, `${launcherCount} app launchers in ${cfg.appsDir}`, "Run: dinghy sync");

    let allOk = true;
    for (const c of checks) {
        console.log(`${c.ok ? " OK " : "FAIL"}  ${c.label}`);
        if (!c.ok && c.advice) { console.log(`      -> ${c.advice}`); allOk = false; }
    }
    process.exit(allOk ? 0 : 1);
}

async function cmdDiscover(cfg, quiet) {
    const before = cfg.host;
    const ok = await findGuest(cfg, 2500);
    if (!ok) {
        if (!quiet) console.log("Couldn't find the Windows VM. Is it running? (Searched by MAC, then the UTM bridge subnet.)");
        process.exit(1);
    }
    if (!quiet) {
        console.log(`VM at ${cfg.host}${before !== cfg.host ? ` (was ${before}, found by ${discoverMethod || "scan"})` : ""}`);
        if (cfg.vmMac) console.log(`MAC ${cfg.vmMac}${cfg.vmName ? `, UTM VM "${cfg.vmName}"` : ""}`);
    }
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
// Serves the guest payload (setup.ps1, payload.zip) and receives the logon banner.
function startSetupServer(cfg, ip, noBanner, log = true, guestUrl = null) {
    const baseUrl = guestUrl ?? `http://${ip}:${SETUP_PORT}`;
    const setupTemplate = fs.readFileSync(path.join(PAYLOAD_DIR, "setup.ps1"), "utf8");
    const setupScript = setupTemplate.replace("__BASE_URL__", baseUrl).replace("__NO_BANNER__", noBanner ? "$true" : "$false");

    // Build payload.zip fresh (server binary + scripts + nssm)
    const zipPath = path.join(os.tmpdir(), "dinghy-payload.zip");
    fs.rmSync(zipPath, { force: true });
    execFileSync("ditto", ["-c", "-k", "--norsrc", PAYLOAD_DIR, zipPath]);
    const zipBuf = fs.readFileSync(zipPath);

    const server = http.createServer((req, res) => {
        if (req.url === "/setup.ps1") {
            if (log) console.log(`  [${new Date().toLocaleTimeString()}] guest fetched setup.ps1`);
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(setupScript);
        } else if (req.url === "/payload.zip") {
            if (log) console.log(`  [${new Date().toLocaleTimeString()}] guest fetched payload.zip (${(zipBuf.length / 1e6).toFixed(1)} MB)`);
            res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": zipBuf.length });
            res.end(zipBuf);
        } else if (req.url === "/banner" && req.method === "POST") {
            let body = "";
            req.on("data", c => { body += c; if (body.length > 65536) req.destroy(); });
            req.on("end", () => {
                try {
                    const b = JSON.parse(body);
                    fs.mkdirSync(CONFIG_DIR, { recursive: true });
                    const caption = cleanBanner(b.caption), text = cleanBanner(b.text);
                    if (!caption && !text) fs.rmSync(bannerPath(cfg), { force: true });   // the guest has no banner
                    else fs.writeFileSync(bannerPath(cfg), JSON.stringify({ caption, text }, null, 2) + "\n");
                    if (log) console.log(`  [${new Date().toLocaleTimeString()}] guest reported its logon banner${caption || text ? "" : " (none)"}`);
                    res.writeHead(204);
                } catch { res.writeHead(400); }
                res.end();
            });
        } else {
            res.writeHead(404);
            res.end("not found");
        }
    });
    server.listen(SETUP_PORT, ip);

    server.on("error", e => {
        console.error(e.code === "EADDRINUSE"
            ? `Port ${SETUP_PORT} is busy: another WinDinghy setup server is running (stop it from the menu bar, or kill the old "dinghy serve-setup").`
            : `Setup server error: ${e.message}`);
        process.exit(1);
    });
    return { server, baseUrl };
}

async function cmdServeSetup(cfg, json = false, noBanner = false) {
    noBanner = noBanner || cfg.suppressBanner === "on";
    if (noBanner && !json) {
        console.log("WARNING: logon-banner suppression is ON. The Windows banner may be your organization's");
        console.log("acceptable-use / network policy notice; hiding it may violate that policy. The guest will");
        console.log("ask you to type YES before it applies this, and keeps it suppressed with a scheduled task.\n");
    }
    if (!fs.existsSync(path.join(PAYLOAD_DIR, "setup.ps1")))
        throw new Error(`Guest payload not found at ${PAYLOAD_DIR} — run from a full windinghy checkout.`);
    const ip = detectServeIp(cfg);
    if (!ip) throw new Error(`No local interface on the guest's subnet (${cfg.host}/24). Is the VM running with shared networking?`);

    const { server, baseUrl } = startSetupServer(cfg, ip, noBanner);

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
    if (await findGuest(cfg, 2500)) {
        if (!json) console.log(`Guest is already online — serving the (updated) setup script until Ctrl-C.`);
        await new Promise(() => {});
    }

    if (!json) console.log(`Waiting for the guest server to come up on ${cfg.host}:${cfg.apiPort} (Ctrl-C to stop) ...`);
    while (true) {
        await new Promise(r => setTimeout(r, 3000));
        if (await findGuest(cfg, 2500)) break;
    }
    if (!json) console.log(`Guest server is UP. Running first sync ...`);
    server.close();
    await cmdSync(cfg);
}

// ---------- managed VM (QEMU + Hypervisor.framework, no UTM) ----------
// `dinghy vm create` builds a lean Windows 11 IoT Enterprise LTSC (ARM64) VM, installs it
// unattended, and switches WinDinghy over to it. See host/vm.mjs.

const EVAL_PAGE = "https://www.microsoft.com/en-us/evalcenter/download-windows-11-iot-enterprise-ltsc-eval";
const VIRTIO_URL = "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso";
const BACKEND_KEYS = ["host", "rdpPort", "apiPort", "username", "vmName", "vmMac"];

// Remember the settings of the backend we're leaving and load the other one's.
function switchBackend(cfg, to, defaults = {}) {
    const from = cfg.vmBackend || "utm";
    cfg.profiles = cfg.profiles ?? {};
    cfg.profiles[from] = Object.fromEntries(BACKEND_KEYS.map(k => [k, cfg[k]]));
    Object.assign(cfg, cfg.profiles[to] ?? {}, defaults);
    cfg.vmBackend = to;
    saveConfig(cfg);
    G.useBackend(cfg);
}

function findWindowsIso() {
    // Any large ISO in Downloads that isn't clearly x64, newest first (CrystalFetch, Microsoft's
    // evaluation center and UUP tools all name theirs differently). Pass --iso to pick another.
    const dir = path.join(os.homedir(), "Downloads");
    const hits = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) {
        if (!/\.iso$/i.test(n) || /(x64|amd64|x86_64|win11_.*x64)/i.test(n)) continue;
        const full = path.join(dir, n);
        try {
            const st = fs.statSync(full);
            if (st.isFile() && st.size > 3e9) hits.push({ full, mtime: st.mtimeMs });
        } catch {}
    }
    return hits.sort((a, b) => b.mtime - a.mtime)[0]?.full ?? null;
}

async function waitForIsoDownload() {
    say("No Windows ISO found. Opening Microsoft's evaluation page: pick");
    say("  \"Windows 11 IoT Enterprise LTSC 2024\" -> ISO, 64-bit ARM64, then download it.");
    say("  I'll continue automatically when it lands in ~/Downloads (waiting up to 40 minutes).");
    spawnSync("open", [EVAL_PAGE]);
    const end = Date.now() + 40 * 60 * 1000;
    while (Date.now() < end) {
        await new Promise(r => setTimeout(r, 5000));
        const iso = findWindowsIso();
        if (iso) {
            // Wait until the size stops changing (the browser is done writing it).
            let last = -1;
            for (let i = 0; i < 40; i++) {
                const sz = fs.statSync(iso).size;
                if (sz === last) return iso;
                last = sz;
                await new Promise(r => setTimeout(r, 3000));
            }
            return iso;
        }
    }
    throw new Error("No Windows ISO appeared in ~/Downloads. Download it, then run: dinghy vm create --iso <path>");
}

async function ensureVirtioIso() {
    const dest = path.join(VM.cacheDir(), "virtio-win.iso");
    const part = dest + ".part";
    const ok = () => fs.existsSync(dest) && fs.statSync(dest).size > 3e8;
    if (ok()) return dest;
    fs.mkdirSync(VM.cacheDir(), { recursive: true });
    const downloading = () => spawnSync("pgrep", ["-f", "curl.*virtio-win.iso.part"], { stdio: "ignore" }).status === 0;
    if (downloading()) {
        say("    The virtio driver ISO is still downloading; waiting for it...");
        while (downloading()) await new Promise(r => setTimeout(r, 5000));
    }
    if (!ok() && fs.existsSync(part)) { try { fs.renameSync(part, dest); } catch {} }
    if (ok()) return dest;
    say("Downloading the virtio driver ISO (~700 MB, one time)...");
    // -C - resumes a partial download
    const r = spawnSync("curl", ["-fL", "-C", "-", "--retry", "3", "-o", part, VIRTIO_URL], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("Couldn't download the virtio driver ISO.");
    fs.renameSync(part, dest);
    return dest;
}

async function guestApiUp(cfg) {
    try { return (await fetch(`http://127.0.0.1:${VM.API_PORT}/health`, { signal: AbortSignal.timeout(2500) })).ok; } catch { return false; }
}


const RESERVED_WIN_USERS = /^(administrator|guest|defaultaccount|wdagutilityaccount|system|dinghy-win|windinghy-vm|public|default|admin|root|con|prn|aux|nul)$/i;
function validWindowsUser(u) {
    return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,19}$/.test(u) && !/[. ]$/.test(u) && !RESERVED_WIN_USERS.test(u) && !/^\d+$/.test(u);
}


// ---------- tested versions (host/compat.json) ----------
function loadCompat() {
    try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "compat.json"), "utf8")); } catch { return {}; }
}

function windowsBuildTested(build) {
    return (loadCompat().windows?.tested ?? []).some(t => t.build === build);
}

function cmdAbout(cfg, json) {
    const c = loadCompat();
    const r = (cmd, args) => { try { return spawnSync(cmd, args, { encoding: "utf8" }).stdout.trim(); } catch { return ""; } };
    const q = (r("qemu-system-aarch64", ["--version"]).match(/version (\S+)/) ?? [])[1] ?? (r("/opt/homebrew/bin/qemu-system-aarch64", ["--version"]).match(/version (\S+)/) ?? [])[1] ?? "not installed";
    const nb = nativeBin(cfg);
    const fr = nb ? (r(nb, ["--version"]).match(/version (\S+)/) ?? [])[1] ?? "unknown" : "not built";
    const rows = [
        { name: "WinDinghy", have: VERSION, tested: c.windinghy ?? "", ok: VERSION === c.windinghy },
        { name: "WinBoat guest agent (base)", have: c.winboat?.guestServer ?? "", tested: c.winboat?.base ?? "", ok: true, extra: `upstream latest seen ${c.winboat?.latestUpstreamSeen}` },
        { name: "FreeRDP client", have: fr, tested: c.freerdp?.version ?? "", ok: fr === c.freerdp?.version },
        { name: "QEMU", have: q, tested: c.qemu?.tested ?? "", ok: q === c.qemu?.tested },
        { name: "Windows (recommended)", have: "", tested: c.windows?.recommended ?? "", ok: true },
    ];
    if (json) { console.log(JSON.stringify(rows)); return; }
    say(`WinDinghy ${VERSION}, built on WinBoat's guest agent ${c.winboat?.base ?? "?"}`);
    for (const x of rows) say(`${x.name.padEnd(30)} ${String(x.have).padEnd(14)} tested: ${x.tested}${x.have && !x.ok ? "   (differs from the tested version)" : ""}${x.extra ? "   " + x.extra : ""}`);
    say("\nNot affiliated with Microsoft or WinBoat. See NOTICE.md for credits and trademarks.");
}

async function vmCreate(cfg, args) {
    const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
    // The app window reads these lines to draw its progress bar.
    const progress = (pct, title) => { if (args.includes("--progress")) console.log(`PROGRESS:${Math.round(pct)}:${title}`); };
    progress(2, "Preparing…");
    const gb = Number(opt("--disk", 40)), ramMB = Number(opt("--ram", 4096)), cpus = Number(opt("--cpus", 4));
    if (VM.exists(cfg)) throw new Error("A WinDinghy VM already exists. Use: dinghy vm start   (or dinghy vm destroy --yes to start over)");

    stepSay("Checking QEMU");
    if (!VM.tools().ok) {
        say("    Installing QEMU with Homebrew (one time)...");
        const r = spawnSync("brew", ["install", "qemu"], { stdio: "inherit" });
        if (r.status !== 0 || !VM.tools().ok) throw new Error("Couldn't install QEMU. Install Homebrew (https://brew.sh) and run: brew install qemu");
    }

    progress(5, "Preparing…");
    stepSay("Windows installation media");
    let iso = opt("--iso", null) ?? findWindowsIso();
    if (!iso) { progress(6, "Waiting for the Windows installer…"); iso = await waitForIsoDownload(); }
    progress(10, "Preparing Windows…");
    if (!fs.existsSync(iso)) throw new Error(`ISO not found: ${iso}`);
    say(`    ${iso}`);
    const editions = VM.isoEditions(iso);
    const edition = VM.chooseEdition(editions);
    if (editions.length) say(`    editions: ${editions.map(e => `${e.index}=${e.name}`).join("; ")}`);
    say(`    installing: ${edition.name || "image " + edition.index}${edition.index !== 1 || editions.length > 1 ? ` (index ${edition.index})` : ""}`);
    const c = loadCompat();
    if (edition.build && !windowsBuildTested(edition.build) && !args.includes("--allow-untested")) {
        const tested = (c.windows?.tested ?? []).map(t => t.name).join(", ");
        throw new Error(`UNTESTED: this installer is Windows build ${edition.build}, which WinDinghy hasn't been tested with. Tested: ${tested}. It may still work, but expect surprises. To install it anyway: dinghy vm create --allow-untested`);
    }
    if (edition.build && windowsBuildTested(edition.build)) say(`    Windows build ${edition.build}: tested with this WinDinghy`);
    const virtio = await ensureVirtioIso();

    stepSay("Preparing the VM");
    const user = opt("--user", "WinDinghy");
    if (!validWindowsUser(user)) throw new Error(`"${user}" can't be a Windows account name (up to 20 letters, numbers, spaces, dots, dashes or underscores; not a reserved name).`);
    const password = randomPassword();
    if (!keychainSet(user, password)) throw new Error("Couldn't save the VM's password to the Keychain.");
    cfg.vmCpus = cpus; cfg.vmRamGB = Math.max(1, Math.round(ramMB / 1024)); cfg.vmDiskGB = gb;
    saveConfig(cfg);
    VM.createDisk(cfg, gb);
    const productKey = opt("--key", null) ?? VM.genericKey(edition);
    if (productKey) say(`    product key: ${opt("--key", null) ? "yours" : "Microsoft's generic install key (installs unactivated)"}`);
    const unattend = VM.buildUnattendIso(cfg, { user, password, setupPort: SETUP_PORT, imageIndex: edition.index, virtioIso: virtio, productKey });
    const { server } = startSetupServer(cfg, "127.0.0.1", false, false, `http://10.0.2.2:${SETUP_PORT}`);
    try {
        VM.start(cfg, { windows: iso, unattend, virtio }, { ramMB, cpus });
        say("    VM started (headless). Pressing a key for the installer's boot prompt...");
        await new Promise(r => setTimeout(r, 3000));
        // The "press any key" prompt lasts only a few seconds; stop before Setup's own UI appears.
        for (let i = 0; i < 12; i++) { VM.sendKeys(cfg, ["spc"]); await new Promise(r => setTimeout(r, 1000)); }

        stepSay("Installing Windows (unattended; usually 15-30 minutes)");
        const started = Date.now();
        let lastShot = 0;
        for (;;) {
            await new Promise(r => setTimeout(r, 15000));
            const mins = Math.round((Date.now() - started) / 60000);
            progress(20 + Math.min(60, ((Date.now() - started) / 60000) * 9), "Installing Windows…");
            if (await guestApiUp(cfg)) { say(`    guest server is up after ${mins} min`); break; }
            if (!VM.isRunning(cfg)) throw new Error(`The VM stopped during installation. Log: ${VM.files(cfg).log}`);
            if (Date.now() - lastShot > 120000) { VM.screenshot(cfg); lastShot = Date.now(); say(`    ...${mins} min (progress screenshot: dinghy vm screenshot)`); }
            if (mins > 150) throw new Error("Installation is taking far too long. Check: dinghy vm screenshot");
        }
    } finally {
        server.close();
    }

    progress(85, "Adding your apps…");
    stepSay("Finishing up");
    cfg.vmName = VM.VM_NAME;
    switchBackend(cfg, "qemu", { host: "127.0.0.1", rdpPort: VM.RDP_PORT, apiPort: VM.API_PORT, username: user, vmName: VM.VM_NAME, vmMac: "" });
    say("    Restarting the VM without the install media...");
    G.ps(VM.VM_NAME, "Stop-Computer -Force", { timeout: 30000 });
    for (let i = 0; i < 60 && VM.isRunning(cfg); i++) await new Promise(r => setTimeout(r, 2000));
    VM.stop(cfg, 5);
    try { VM.snapshotCreate(cfg, "clean-install"); say("    snapshot \"clean-install\" saved (rewind any time: dinghy vm rewind clean-install)"); } catch (e) { say(`    (couldn't save the baseline snapshot: ${e.message})`); }
    VM.start(cfg, {}, { ramMB, cpus });
    if (!await waitFor(() => guestApiUp(cfg), 300, 5000)) throw new Error("The VM didn't come back after the restart. Try: dinghy vm start");

    progress(94, "Adding your apps…");
    stepSay("Syncing your Windows apps");
    await cmdSync(cfg);
    progress(100, "Done");
    say(`\nDone. Your WinDinghy VM runs without UTM (disk: ${VM.files(cfg).disk}).`);
}

// After the virtual disk grew (Preferences > Resources), Windows still has the old partition: extend it.
async function extendWindowsPartition(cfg) {
    if (G.backendKind() !== "qemu" || !VM.needsExtend(cfg)) return;
    const r = await G.psAsync(VM.VM_NAME, "$max=(Get-PartitionSupportedSize -DriveLetter C).SizeMax; Resize-Partition -DriveLetter C -Size $max -ErrorAction Stop; 'extended'", { timeout: 120000 });
    if (/extended/.test(r.output)) VM.clearNeedsExtend(cfg);
}


// ---------- move / export / import the VM (also a simple image backup) ----------
// A WinDinghy VM bundle is a folder holding the disk (snapshots included), the UEFI variables and a
// manifest. The Windows password is not included: after an import, `dinghy login` saves it again.

function cloneOrCopy(src, dst) {
    if (spawnSync("cp", ["-c", src, dst]).status === 0) return;   // APFS clone: instant, no extra space
    if (spawnSync("cp", [src, dst]).status !== 0) throw new Error(`Couldn't copy ${src} (is there enough free space?)`);
}

function moveFile(src, dst) {
    try { fs.renameSync(src, dst); } catch { cloneOrCopy(src, dst); fs.unlinkSync(src); }
}

function vmMove(cfg, dest) {
    if (!dest) throw new Error("Usage: dinghy vm move <folder>");
    dest = path.resolve(dest.replace(/^~(?=\/|$)/, os.homedir()));
    const from = VM.vmDir(cfg);
    if (dest === from) { say("The VM is already there."); return; }
    if (!VM.exists(cfg)) { cfg.vmDir = dest; saveConfig(cfg); say(`New VM location set: ${dest}`); return; }
    if (fs.existsSync(path.join(dest, "disk.qcow2"))) throw new Error(`There's already a VM disk in ${dest}.`);
    say("Shutting down Windows...");
    VM.stop(cfg, 90);
    fs.mkdirSync(dest, { recursive: true });
    say(`Moving the VM to ${dest} (this can take a while for a big disk)...`);
    for (const n of ["disk.qcow2", "efi-vars.fd", "unattend.iso"]) {
        const f = path.join(from, n);
        if (fs.existsSync(f)) moveFile(f, path.join(dest, n));
    }
    cfg.vmDir = dest; saveConfig(cfg);
    try { fs.rmSync(from, { recursive: true, force: true }); } catch {}
    say("Moved. Start Windows again with: dinghy vm start");
}

function vmExport(cfg, dest) {
    if (!VM.exists(cfg)) throw new Error("No managed VM to export.");
    if (!dest) dest = path.join(os.homedir(), "Desktop", `WinDinghy-${new Date().toISOString().slice(0, 10)}.windinghyvm`);
    dest = path.resolve(dest.replace(/^~(?=\/|$)/, os.homedir()));
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists.`);
    const wasRunning = VM.isRunning(cfg);
    if (wasRunning) { say("Shutting down Windows for a consistent copy..."); VM.stop(cfg, 90); }
    const f = VM.files(cfg);
    fs.mkdirSync(dest, { recursive: true });
    say(`Exporting to ${dest} ...`);
    cloneOrCopy(f.disk, path.join(dest, "disk.qcow2"));
    cloneOrCopy(f.vars, path.join(dest, "efi-vars.fd"));
    fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify({
        format: 1, created: new Date().toISOString(), username: cfg.username,
        vmCpus: cfg.vmCpus, vmRamGB: cfg.vmRamGB, vmDiskGB: cfg.vmDiskGB,
    }, null, 2));
    say(`Exported (${(fs.statSync(path.join(dest, "disk.qcow2")).size / 1e9).toFixed(1)} GB).`);
    if (wasRunning) { VM.start(cfg); say("Windows is starting again."); }
    say(dest);
}

async function vmImport(cfg, src) {
    if (!src) throw new Error("Usage: dinghy vm import <bundle.windinghyvm>");
    src = path.resolve(src.replace(/^~(?=\/|$)/, os.homedir()));
    const disk = path.join(src, "disk.qcow2");
    if (!fs.existsSync(disk)) throw new Error("That isn't a WinDinghy VM bundle (no disk.qcow2 inside).");
    if (VM.exists(cfg)) throw new Error("A WinDinghy VM already exists. Export it first if you want to keep it, then: dinghy vm destroy --yes");
    if (!VM.tools().ok) throw new Error("QEMU isn't installed. Run: brew install qemu");
    let m = {};
    try { m = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8")); } catch {}
    const f = VM.files(cfg);
    fs.mkdirSync(f.dir, { recursive: true });
    say("Importing...");
    cloneOrCopy(disk, f.disk);
    if (fs.existsSync(path.join(src, "efi-vars.fd"))) cloneOrCopy(path.join(src, "efi-vars.fd"), f.vars);
    else fs.copyFileSync(VM.tools().varsTemplate, f.vars);
    if (m.vmCpus) cfg.vmCpus = m.vmCpus;
    if (m.vmRamGB) cfg.vmRamGB = m.vmRamGB;
    switchBackend(cfg, "qemu", { host: "127.0.0.1", rdpPort: VM.RDP_PORT, apiPort: VM.API_PORT, username: m.username || cfg.username, vmName: VM.VM_NAME, vmMac: "" });
    say("Imported. Start it with: dinghy vm start");
    say("The Windows password isn't part of a bundle: run  dinghy login  to save it on this Mac.");
}

async function cmdVm(cfg, args) {
    const sub = args[0] ?? "status";
    switch (sub) {
        case "create": return vmCreate(cfg, args.slice(1));
        case "move": return vmMove(cfg, args[1]);
        case "export": return vmExport(cfg, args[1]);
        case "import": return vmImport(cfg, args[1]);
        case "start": {
            if (!VM.exists(cfg)) throw new Error("No WinDinghy VM yet. Create it with: dinghy vm create");
            VM.start(cfg);
            say("Starting...");
            if (!await waitFor(() => guestApiUp(cfg), 300, 4000)) throw new Error("The VM started but the guest server didn't answer in 5 minutes.");
            await extendWindowsPartition(cfg);
            say("Online.");
            return;
        }
        case "stop": say(VM.stop(cfg) ? "Stopped." : "Couldn't stop the VM."); return;
        case "status": {
            const f = VM.files(cfg);
            if (!VM.exists(cfg)) { say("No WinDinghy VM yet. Create it with: dinghy vm create"); return; }
            const size = fs.statSync(f.disk).size;
            say(`WinDinghy VM: ${VM.isRunning(cfg) ? `running (pid ${VM.pidOf(cfg)})` : "stopped"}`);
            say(`disk: ${f.disk} (${(size / 1e9).toFixed(1)} GB used)`);
            say(`active backend: ${cfg.vmBackend || "utm"}; RDP 127.0.0.1:${VM.RDP_PORT}, guest API 127.0.0.1:${VM.API_PORT}`);
            const snaps = VM.snapshotList(cfg);
            say(`snapshots: ${snaps.length ? snaps.map(x => x.name).join(", ") : "none (dinghy vm snapshot)"}`);
            return;
        }
        case "screenshot": {
            const file = VM.screenshot(cfg, args[1] ? path.resolve(args[1]) : undefined);
            if (!file) throw new Error("Couldn't take a screenshot (is the VM running?).");
            say(file); spawnSync("open", [file]); return;
        }
        case "snapshot": {
            if (!VM.exists(cfg)) throw new Error("No WinDinghy VM yet. Create it with: dinghy vm create");
            const name = args[1] ?? `snap-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2")}`;
            if (!VM.validSnapshotName(name)) throw new Error("Snapshot names may use letters, digits, '.', '_' and '-' (up to 40 characters).");
            const wasRunning = VM.isRunning(cfg);
            if (wasRunning) { say("Shutting Windows down to take a consistent snapshot..."); if (!VM.stop(cfg, 120)) throw new Error("Couldn't stop the VM."); }
            VM.snapshotCreate(cfg, name);
            say(`Snapshot "${name}" taken.`);
            if (wasRunning) { VM.start(cfg); say("Restarting the VM..."); await waitFor(() => guestApiUp(cfg), 300, 4000); }
            return;
        }
        case "snapshots": {
            const list = VM.snapshotList(cfg);
            if (args.includes("--json")) { console.log(JSON.stringify(list.map(x => ({ name: x.name, date: x.date })))); return; }
            if (!list.length) { say("No snapshots yet. Take one with: dinghy vm snapshot [name]"); return; }
            for (const x of list) say(`${x.name.padEnd(24)} ${new Date(x.date).toLocaleString()}`);
            return;
        }
        case "rewind": {
            const name = args[1];
            if (!name) throw new Error("Usage: dinghy vm rewind <snapshot>   (see: dinghy vm snapshots)");
            if (!VM.snapshotList(cfg).some(x => x.name === name)) throw new Error(`There's no snapshot named "${name}".`);
            // Rewinding discards everything done in Windows since the snapshot: confirm.
            if (!args.includes("--yes")) {
                const ok = asDialog(`button returned of (display dialog "Rewind Windows to \"${asq(name)}\"?\n\nEverything changed in Windows since then (files, installed programs, settings) will be lost." with title "WinDinghy" with icon caution buttons {"Cancel", "Rewind"} default button "Cancel")`);
                if (ok !== "Rewind") { say("Cancelled."); return; }
            }
            const wasRunning = VM.isRunning(cfg);
            if (wasRunning) { VM.stop(cfg, 20); }
            VM.snapshotApply(cfg, name);
            say(`Rewound to "${name}".`);
            if (wasRunning) { VM.start(cfg); say("Restarting the VM..."); await waitFor(() => guestApiUp(cfg), 300, 4000); }
            return;
        }
        case "snapshot-delete": {
            if (!args[1]) throw new Error("Usage: dinghy vm snapshot-delete <snapshot>");
            const wasRunning = VM.isRunning(cfg);
            if (wasRunning) { if (!VM.stop(cfg, 120)) throw new Error("Couldn't stop the VM."); }
            VM.snapshotDelete(cfg, args[1]);
            say(`Deleted snapshot "${args[1]}".`);
            if (wasRunning) { VM.start(cfg); await waitFor(() => guestApiUp(cfg), 300, 4000); }
            return;
        }
        case "use": {
            const to = args[1];
            if (!["utm", "qemu"].includes(to)) throw new Error("Usage: dinghy vm use <utm|qemu>");
            if (to === "utm") needAdvanced(cfg, "Using a UTM VM");
            switchBackend(cfg, to);
            say(`Now using the ${to} backend (host ${cfg.host}).`);
            return;
        }
        case "destroy":
            if (!args.includes("--yes")) throw new Error("This deletes the WinDinghy VM and its disk. Re-run with --yes to confirm.");
            VM.destroy(cfg);
            if (cfg.vmBackend === "qemu") switchBackend(cfg, "utm");
            say("Deleted.");
            return;
        default:
            throw new Error("Usage: dinghy vm <create|start|stop|status|snapshot|snapshots|rewind|snapshot-delete|screenshot|use|destroy>");
    }
}

// ---------- Windows tools vs apps ----------
// Keep user apps uncluttered: Windows administration tools get their own place in the window.

const TOOL_NAME = /^(control panel|device manager|event viewer|disk management|disk (space )?cleanup.*|computer management|component services|services|task scheduler|registry editor|task manager|resource monitor|performance monitor|reliability monitor|system information|system configuration|command prompt|windows powershell.*|powershell.*|windows terminal|terminal|windows defender firewall.*|windows firewall.*|local security policy|print management|odbc data sources.*|iscsi initiator|windows memory diagnostic|remote desktop connection|defragment and optimize drives|windows security|diagnostics utility.*|accessibility on-screen keyboard|windows tools|administrative tools|steps recorder|math input panel|windows settings|settings)$/i;
const TOOL_EXE = /\\(taskmgr|regedit|mmc|cmd|powershell|powershell_ise|msconfig|msinfo32|perfmon|resmon|eventvwr|devmgmt|diskmgmt|services|compmgmt|taskschd|control|cleanmgr|dfrgui|mdsched|iscsicpl|odbcad32|printmanagement|secpol|wt|windowsterminal|mstsc|rstrui|systempropertiesadvanced|msdt|wf)\.(exe|msc)$/i;

function appCategory(app) {
    if (/\.msc\b/i.test(app.Args ?? "")) return "tool";
    if (TOOL_NAME.test(String(app.Name ?? "").trim())) return "tool";
    if (TOOL_EXE.test(String(app.Path ?? ""))) return "tool";
    return "app";
}

// ---------- shared guest helpers ----------

function needAgent(cfg) {
    const vm = G.listVms()[0]?.name ?? cfg.vmName;
    if (!G.utmInstalled() || G.vmStatus(vm) !== "started") throw new Error("The Windows VM isn't running. Start it first (dinghy vm start).");
    if (!G.agentUp(vm)) throw new Error("The guest agent isn't answering yet. Give the VM a minute, then try again.");
    return vm;
}

// Runs a PowerShell script in the guest and returns the JSON the script printed after a "JSON:" marker.
function psJson(cfg, script, timeout = 120000) {
    const vm = needAgent(cfg);
    const r = G.ps(vm, script, { timeout });
    const i = r.output.indexOf("JSON:");
    if (i < 0) throw new Error(r.output.trim().slice(-300) || "No answer from Windows.");
    try { return JSON.parse(r.output.slice(i + 5).trim()); } catch { throw new Error("Windows returned something unreadable."); }
}

const psq = s => String(s).replace(/'/g, "''");   // quote for a single-quoted PowerShell string

// ---------- software (winget, no Microsoft account or Store needed) ----------
// winget.exe is an MSIX app: run as SYSTEM (what the guest agent is) it can't find its framework DLLs
// unless their folders are on PATH, hence the prologue.

const WINGET_PROLOGUE = `
$wa = "C:\\Program Files\\WindowsApps"
$w = (Get-ChildItem "$wa\\Microsoft.DesktopAppInstaller_*_arm64__8wekyb3d8bbwe\\winget.exe" -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1).FullName
if (-not $w) { "winget isn't installed in this Windows."; return }
$deps = Get-ChildItem $wa -Directory | Where-Object { $_.Name -like "Microsoft.VCLibs.140.00*arm64*" -or $_.Name -like "Microsoft.UI.Xaml*arm64*" } | ForEach-Object { $_.FullName }
$env:PATH = (($deps -join ";") + ";" + $env:PATH)
$common = @("--accept-source-agreements", "--disable-interactivity")
function ParseTable($text) {
    $lines = @($text -split "\\r?\\n" | Where-Object { $_.Trim() -ne "" })
    $sep = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^-{5,}") { $sep = $i; break } }
    if ($sep -lt 1) { return @() }
    $hdr = $lines[$sep - 1]
    $cols = [regex]::Matches($hdr, "\\S+(?: \\S+)*")
    $rows = @()
    for ($i = $sep + 1; $i -lt $lines.Count; $i++) {
        $l = $lines[$i]; $o = [ordered]@{}
        for ($c = 0; $c -lt $cols.Count; $c++) {
            $s = $cols[$c].Index
            $e = if ($c + 1 -lt $cols.Count) { $cols[$c + 1].Index } else { $l.Length }
            if ($s -ge $l.Length) { $o[$cols[$c].Value] = "" } else { $o[$cols[$c].Value] = $l.Substring($s, [Math]::Min($e, $l.Length) - $s).Trim() }
        }
        $rows += [pscustomobject]$o
    }
    return $rows
}
`;

function validPkgId(id) { return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}$/.test(String(id ?? "")); }

async function cmdPkg(cfg, args) {
    const sub = args[0];
    const json = args.includes("--json");
    const rest = args.slice(1).filter(a => a !== "--json");
    const show = out => console.log(out.trim());
    if (sub === "search") {
        const q = rest.join(" ").trim();
        if (!q) throw new Error("Usage: dinghy pkg search <text>");
        const res = psJson(cfg, `${WINGET_PROLOGUE}
$raw = & $w search '${psq(q)}' --source winget @common 2>&1 | Out-String
$rows = @(ParseTable $raw | Select-Object -First 40 | ForEach-Object { [pscustomobject]@{ name = $_.Name; id = $_.Id; version = $_.Version } })
"JSON:" + (ConvertTo-Json -InputObject $rows -Compress)`);
        if (json) console.log(JSON.stringify(res)); else for (const p of res) say(`${p.id.padEnd(40)} ${p.version.padEnd(14)} ${p.name}`);
    } else if (sub === "list") {
        const res = psJson(cfg, `${WINGET_PROLOGUE}
$raw = & $w list --source winget @common 2>&1 | Out-String
$up = & $w upgrade --source winget @common 2>&1 | Out-String
$upIds = @{}; foreach ($r in (ParseTable $up)) { if ($r.Id) { $upIds[$r.Id] = $r.Available } }
$rows = @(ParseTable $raw | ForEach-Object { [pscustomobject]@{ name = $_.Name; id = $_.Id; version = $_.Version; available = $upIds[$_.Id] } })
"JSON:" + (ConvertTo-Json -InputObject $rows -Compress)`, 300000);
        if (json) console.log(JSON.stringify(res)); else for (const p of res) say(`${p.id.padEnd(40)} ${p.version.padEnd(14)} ${p.available ? "-> " + p.available : ""}`);
    } else if (sub === "install" || sub === "uninstall") {
        const id = rest[0];
        if (!validPkgId(id)) throw new Error(`Usage: dinghy pkg ${sub} <package id>   (e.g. 7zip.7zip)`);
        const vm = needAgent(cfg);
        const r = G.ps(vm, sub === "install" ? `${WINGET_PROLOGUE}
& $w install --id '${psq(id)}' --exact --source winget --scope machine --silent --accept-package-agreements @common 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { "(machine-wide install not offered; trying a per-user install)"; & $w install --id '${psq(id)}' --exact --source winget --silent --accept-package-agreements @common 2>&1 | Out-String }
"exit=$LASTEXITCODE"` : `${WINGET_PROLOGUE}
& $w uninstall --id '${psq(id)}' --exact --silent @common 2>&1 | Out-String
"exit=$LASTEXITCODE"`, { timeout: 1500000 });
        const ok = /exit=0\b/.test(r.output);
        show(r.output.replace(/^[\s\S]*?(?=\S)/, "").split("\n").filter(l => l.trim() && !/^[\s\-\\|\/]+$/.test(l)).slice(-12).join("\n"));
        if (!ok) { process.exitCode = 1; return; }
        if (sub === "install") { say("\nInstalled. Refreshing your app list..."); await cmdSync(cfg); }
    } else if (sub === "upgrade") {
        const vm = needAgent(cfg);
        const target = rest[0] && validPkgId(rest[0]) ? `--id '${psq(rest[0])}' --exact` : "--all";
        const r = G.ps(vm, `${WINGET_PROLOGUE}
& $w upgrade ${target} --source winget --silent --accept-package-agreements @common 2>&1 | Out-String
"exit=$LASTEXITCODE"`, { timeout: 2400000 });
        show(r.output.split("\n").filter(l => l.trim() && !/^[\s\-\\|\/]+$/.test(l)).slice(-12).join("\n"));
    } else {
        throw new Error("Usage: dinghy pkg <search|list|install|uninstall|upgrade> [--json] ...");
    }
}

// ---------- activation ----------

async function cmdActivation(cfg, args) {
    if (args[0] === "key") {
        const key = String(args[1] ?? "").toUpperCase();
        if (!/^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/.test(key)) throw new Error("A Windows product key looks like XXXXX-XXXXX-XXXXX-XXXXX-XXXXX.");
        const vm = needAgent(cfg);
        const r = G.ps(vm, `cscript //nologo C:\\Windows\\System32\\slmgr.vbs /ipk ${key} 2>&1 | Out-String; cscript //nologo C:\\Windows\\System32\\slmgr.vbs /ato 2>&1 | Out-String`, { timeout: 180000 });
        say(r.output.trim());
        return;
    }
    const res = psJson(cfg, `
$p = Get-CimInstance SoftwareLicensingProduct -Filter "Name like 'Windows%' and PartialProductKey is not null" | Select-Object -First 1
$names = @{0='Unlicensed';1='Activated';2='Setting up';3='Grace period';4='Not genuine (grace)';5='Needs activation';6='Extended grace'}
$o = [pscustomobject]@{ edition = $p.Name; status = $names[[int]$p.LicenseStatus]; activated = ($p.LicenseStatus -eq 1); channel = $p.ProductKeyChannel; partialKey = $p.PartialProductKey }
"JSON:" + (ConvertTo-Json -InputObject $o -Compress)`);
    if (args.includes("--json")) console.log(JSON.stringify(res));
    else say(`${res.edition}\n${res.status} (${res.channel}), key ending ${res.partialKey}`);
}

// ---------- work / school / domain ----------

async function cmdDomain(cfg, args) {
    const sub = args[0] ?? "status";
    if (sub === "status") {
        const res = psJson(cfg, `
$cs = Get-CimInstance Win32_ComputerSystem
$ds = (dsregcmd /status 2>&1 | Out-String)
$aad = ($ds -match "AzureAdJoined\\s*:\\s*YES")
$o = [pscustomobject]@{ computer = $cs.Name; domainJoined = [bool]$cs.PartOfDomain; domain = $(if ($cs.PartOfDomain) { $cs.Domain } else { "" }); azureAdJoined = $aad }
"JSON:" + (ConvertTo-Json -InputObject $o -Compress)`);
        if (args.includes("--json")) console.log(JSON.stringify(res));
        else say(res.domainJoined ? `Joined to ${res.domain} (computer ${res.computer})` : res.azureAdJoined ? "Joined to a work or school account (Entra ID)" : `Not joined to a domain (computer ${res.computer})`);
    } else if (sub === "join" || sub === "leave") {
        // Credentials arrive as JSON on stdin so they never appear in a process list.
        const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
        const vm = needAgent(cfg);
        const cred = input.user ? `$c = New-Object PSCredential('${psq(input.user)}', (ConvertTo-SecureString '${psq(input.password ?? "")}' -AsPlainText -Force));` : "";
        const script = sub === "join"
            ? `${cred} try { Add-Computer -DomainName '${psq(input.domain)}' -Credential $c ${input.ou ? `-OUPath '${psq(input.ou)}'` : ""} -Force -ErrorAction Stop; 'joined: restart needed' } catch { 'FAILED: ' + $_.Exception.Message }`
            : `${cred} try { Remove-Computer ${input.user ? "-UnjoinDomainCredential $c" : ""} -Force -ErrorAction Stop; 'left: restart needed' } catch { 'FAILED: ' + $_.Exception.Message }`;
        if (sub === "join" && !input.domain) throw new Error("A domain name is needed.");
        const r = G.ps(vm, script.replace(/\n/g, " "), { timeout: 240000, secret: true });
        say(r.output.trim());
        if (/FAILED/.test(r.output)) { process.exitCode = 1; return; }
        if (!args.includes("--no-restart")) { say("Restarting Windows to finish..."); G.ps(vm, "shutdown /r /t 5", { timeout: 30000 }); }
    } else if (sub === "gpupdate") {
        const vm = needAgent(cfg);
        say(G.ps(vm, "gpupdate /force 2>&1 | Out-String", { timeout: 240000 }).output.trim());
    } else {
        throw new Error("Usage: dinghy domain <status|join|leave|gpupdate> [--json]");
    }
}

// ---------- Mac folders as Windows' own folders (redirection) ----------
// Windows' Documents, Downloads, Desktop, Pictures, Music and Videos can point at the Mac's folders
// (shared over RDP as \\tsclient\<Name>). On by default; each can be switched off in Sharing.

const KNOWN_FOLDERS = [
    { key: "documents", label: "Documents", share: "Documents", mac: "Documents", reg: ["Personal"],                                   local: "Documents" },
    { key: "downloads", label: "Downloads", share: "Downloads", mac: "Downloads", reg: ["{374DE290-123F-4565-9164-39C4925E467B}"],    local: "Downloads" },
    { key: "desktop",   label: "Desktop",   share: "Desktop",   mac: "Desktop",   reg: ["Desktop"],                                   local: "Desktop" },
    { key: "pictures",  label: "Pictures",  share: "Pictures",  mac: "Pictures",  reg: ["My Pictures"],                               local: "Pictures" },
    { key: "music",     label: "Music",     share: "Music",     mac: "Music",     reg: ["My Music"],                                  local: "Music" },
    { key: "videos",    label: "Videos",    share: "Movies",    mac: "Movies",    reg: ["My Video"],                                  local: "Videos" },
];

const redirectOn = (cfg, f) => cfg[`redirect_${f.key}`] !== "off";

async function cmdFolders(cfg, args) {
    const sub = args[0] ?? "status";
    if (sub === "status") {
        const rows = KNOWN_FOLDERS.map(f => ({ key: f.key, label: f.label, mac: path.join(os.homedir(), f.mac), redirected: redirectOn(cfg, f) }));
        if (args.includes("--json")) console.log(JSON.stringify(rows)); else for (const r of rows) say(`${r.label.padEnd(10)} ${r.redirected ? "-> your Mac's" : "(Windows' own)"} ${r.mac}`);
        return;
    }
    if (sub === "ro") {
        const name = args[1], mode = args[2];
        if (!name || !["on", "off"].includes(mode)) throw new Error("Usage: dinghy folders ro <share name, e.g. Home or Documents> <on|off>");
        const set = new Set(Array.isArray(cfg.readOnlyShares) ? cfg.readOnlyShares : []);
        if (mode === "on") set.add(name); else set.delete(name);
        cfg.readOnlyShares = [...set];
        saveConfig(cfg);
        say(`${name}: ${mode === "on" ? "read-only" : "read and write"} (applies to the next app launch).`);
        return;
    }
    if (sub === "on" || sub === "off") {
        const which = args[1] === "all" ? KNOWN_FOLDERS : KNOWN_FOLDERS.filter(f => f.key === args[1]);
        if (!which.length) throw new Error(`Usage: dinghy folders ${sub} <${KNOWN_FOLDERS.map(f => f.key).join("|")}|all>`);
        for (const f of which) cfg[`redirect_${f.key}`] = sub;
        saveConfig(cfg);
        say(`${which.map(f => f.label).join(", ")}: ${sub === "on" ? "now Mac folders" : "back to Windows' own"}. Apply with: dinghy folders apply`);
        return;
    }
    if (sub !== "apply") throw new Error("Usage: dinghy folders <status|on|off|ro|apply> [--json]");
    // Write each folder's location into the Windows user's registry. A new session picks it up, so the
    // user's Windows session is signed out afterwards (open Windows apps close).
    const vm = needAgent(cfg);
    const user = winUser(cfg).split("\\").pop();
    const lines = KNOWN_FOLDERS.flatMap(f => f.reg.map(name => {
        const value = redirectOn(cfg, f) ? `\\\\tsclient\\${f.share}` : `%USERPROFILE%\\${f.local}`;
        return `Set-ItemProperty -Path $k -Name '${name}' -Value '${psq(value)}' -Type ExpandString`;
    }));
    const r = G.ps(vm, `
$u = '${psq(user)}'
$sid = (Get-LocalUser -Name $u).SID.Value
$root = "Registry::HKEY_USERS\\$sid"
$loaded = $false
if (-not (Test-Path $root)) {
    reg load "HKU\\dinghy_tmp" "C:\\Users\\$u\\NTUSER.DAT" | Out-Null
    $root = "Registry::HKEY_USERS\\dinghy_tmp"; $loaded = $true
}
$k = "$root\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders"
${lines.join("\n")}
if ($loaded) { [gc]::Collect(); Start-Sleep 1; reg unload "HKU\\dinghy_tmp" | Out-Null }
# sign the user out so the next app launch starts a session with the new folder locations
$id = (quser 2>$null | Select-String -Pattern "$u\\s+\\S*\\s+(\\d+)" | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1)
if ($id) { logoff $id }
"applied"`, { timeout: 120000 });
    say(/applied/.test(r.output) ? "Folder locations updated. Open a Windows app to see them." : `Couldn't update the folders:\n${r.output.trim()}`);
}

// ---------- open a Windows Settings page ----------

async function cmdOpenSettings(cfg, page) {
    if (!/^[a-z0-9-]{0,40}$/i.test(page ?? "")) throw new Error("Usage: dinghy open-settings <page>   (e.g. workplace, yourinfo, activation)");
    const bundle = path.join(cfg.appsDir, "Windows Settings.app", "Contents", "Resources");
    if (!fs.existsSync(bundle)) throw new Error('No "Windows Settings" launcher yet. Run: dinghy sync');
    if (!await ensureGuest(cfg, false)) throw new Error("Can't reach the Windows VM.");
    await launchNative(cfg, { Name: "Windows Settings", Path: "C:\\Windows\\explorer.exe", Args: `ms-settings:${page}`, Source: "dinghy" }, bundle);
}

// ---------- hands-free setup and repair (UTM guest agent) ----------
// `dinghy setup` and `dinghy fix` drive the guest through utmctl's guest agent
// (see guest.mjs), so a new user doesn't paste commands into Windows.

function say(msg) { console.log(msg); }
function stepSay(msg) { console.log(`==> ${msg}`); }

// Backend-aware hints (UTM VM you run yourself vs the VM WinDinghy manages).
const isQemu = cfg => cfg.vmBackend === "qemu";
const startHint = cfg => isQemu(cfg) ? "Start it with: dinghy vm start" : "Start it in UTM";
function agentHelp(cfg) {
    return isQemu(cfg)
        ? `The guest agent isn't answering. Give the VM a minute after starting it (dinghy vm start), then try again; if it never comes up, run: dinghy fix`
        : AGENT_HELP;
}

const AGENT_HELP = `The UTM guest agent isn't running in Windows. One-time step: in UTM choose
"Virtual Machine > Install Windows Guest Tools" (or install utm-guest-tools from UTM's
guest tools ISO inside Windows). Then run this command again.`;

function randomPassword() {
    const pick = (set, n) => Array.from(crypto.randomBytes(n), b => set[b % set.length]).join("");
    const pw = pick("ABCDEFGHJKLMNPQRSTUVWXYZ", 5) + pick("abcdefghijkmnopqrstuvwxyz", 7) +
               pick("23456789", 4) + pick("-_.!#%+=", 3);
    return pw.split("").sort(() => crypto.randomInt(3) - 1).join("");
}

// Pick the UTM VM to manage: the configured one, else the only/running one, else ask.
function chooseVm(cfg) {
    const vms = G.listVms();
    if (!vms.length) throw new Error(isQemu(cfg) ? "There's no WinDinghy VM yet. Create it with: dinghy vm create" : "UTM has no virtual machines. Create or import a Windows 11 ARM VM in UTM first, or run: dinghy vm create");
    let vm = vms.find(v => v.name === cfg.vmName);
    if (!vm) {
        const running = vms.filter(v => v.status === "started");
        vm = running.length === 1 ? running[0] : vms.length === 1 ? vms[0] : null;
    }
    if (!vm) {
        const names = vms.map(v => `"${asq(v.name)}"`).join(", ");
        const pick = asDialog(`choose from list {${names}} with title "WinDinghy" with prompt "Which UTM virtual machine runs Windows?"`);
        vm = vms.find(v => v.name === pick);
        if (!vm) throw new Error("No VM chosen.");
    }
    if (cfg.vmName !== vm.name) { cfg.vmName = vm.name; saveConfig(cfg); }
    return vm;
}

async function waitFor(fn, seconds, everyMs = 3000) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
        if (await fn()) return true;
        await new Promise(r => setTimeout(r, everyMs));
    }
    return false;
}

// Choose the guest address that sits on one of this Mac's vmnet bridges.
function pickGuestIp(ips) {
    const nets = [];
    for (const [ifname, addrs] of Object.entries(os.networkInterfaces()))
        if (ifname.startsWith("bridge")) for (const a of addrs ?? []) if (a.family === "IPv4") nets.push(a.address.split(".").slice(0, 3).join("."));
    return ips.find(ip => nets.includes(ip.split(".").slice(0, 3).join("."))) ?? null;
}

async function cmdSetup(cfg, args) {
    let noBanner = args.includes("--no-banner") || cfg.suppressBanner === "on";
    const qemu = isQemu(cfg);
    // Clean slate (no UTM, no managed VM yet): build a WinDinghy VM instead of asking for UTM.
    if (!qemu && !isAdvanced(cfg)) {
        say("UTM VMs are an advanced, unsupported option: creating a WinDinghy VM instead (enable advanced mode with: dinghy config advanced on).");
        return vmCreate(cfg, args);
    }
    if (qemu ? !VM.exists(cfg) : !G.utmInstalled()) {
        say(qemu ? "There's no WinDinghy VM yet: creating one." : "UTM isn't installed: creating a WinDinghy VM instead (it doesn't need UTM).");
        return vmCreate(cfg, args);
    }
    stepSay("Finding your Windows VM");
    const vm = chooseVm(cfg);
    say(`    ${vm.name} (${vm.status})`);
    if (vm.status !== "started") {
        stepSay("Starting the VM");
        G.startVm(vm.name);
        if (!await waitFor(() => G.vmStatus(vm.name) === "started", 90, 2000)) throw new Error(`The VM didn't start. ${startHint(cfg)} and run dinghy setup again.`);
    }

    stepSay("Waiting for the guest agent");
    if (!await waitFor(() => G.agentUp(vm.name), 240)) {
        if (qemu) throw new Error(agentHelp(cfg));
        say(`    Not available yet.\n${agentHelp(cfg).split("\n").map(l => "    " + l).join("\n")}`);
        say(`\nFalling back to the manual one-liner so you're not blocked:\n`);
        return cmdServeSetup(cfg, false, noBanner);
    }
    let ip;
    if (qemu) {
        ip = "127.0.0.1"; // the managed VM is reached through forwarded ports; its own address is private
    } else {
        ip = pickGuestIp(G.guestIps(vm.name));
        if (!ip) throw new Error("The VM has no address on UTM's shared network. In UTM, set the VM's first network device to \"Shared Network\".");
    }
    if (ip !== cfg.host) { cfg.host = ip; saveConfig(cfg); }
    say(`    guest agent OK, VM at ${ip}${qemu ? ` (RDP :${cfg.rdpPort}, API :${cfg.apiPort})` : ""}`);

    if (noBanner) {
        // Only ask if this VM actually shows a logon banner; otherwise there's nothing to suppress.
        const probe = G.ps(vm.name, `$k='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System'; $t=(Get-ItemProperty $k -ErrorAction SilentlyContinue); $a=("$($t.legalnoticetext)" -replace [char]0,'').Trim(); $b=("$($t.legalnoticecaption)" -replace [char]0,'').Trim(); if ($a -or $b) { 'has-banner' } else { 'no-banner' }`, { timeout: 60000 });
        if (!/has-banner/.test(probe.output)) { noBanner = false; say("    This VM has no logon banner: nothing to suppress."); }
    }
    if (noBanner) {
        const ok = asDialog(`button returned of (display dialog "You asked WinDinghy to keep Windows' logon banner suppressed.\\n\\nThat banner may be your organization's acceptable-use or network policy notice. Hiding it may violate that policy, and you are responsible for deciding this is OK." with title "WinDinghy" with icon caution buttons {"Keep the banner", "Suppress it"} default button "Keep the banner")`);
        if (ok !== "Suppress it") { noBanner = false; say("    Banner suppression skipped."); }
    }

    stepSay("Installing the WinDinghy guest components (a minute or two)");
    const serveIp = qemu ? "127.0.0.1" : detectServeIp(cfg);
    if (!serveIp) throw new Error(`No local interface on the guest's subnet (${cfg.host}/24).`);
    const { server, baseUrl } = startSetupServer(cfg, serveIp, noBanner, false, qemu ? `http://10.0.2.2:${SETUP_PORT}` : null);
    try {
        // Async: the guest fetches setup.ps1 from the server above, which this process must keep serving.
        const r = await G.psAsync(vm.name, `irm ${baseUrl}/setup.ps1 | iex`, { env: noBanner ? { WINDINGHY_YES: "YES" } : {}, timeout: 600000 });
        if (r.output) say(r.output.split("\n").map(l => "    " + l).join("\n"));
        if (!await waitFor(() => guestAlive(cfg, 2500), 90)) throw new Error("The guest server didn't come up. Run: dinghy fix");
    } finally {
        server.close();
    }

    if (!cfg.username) {
        stepSay("Creating a dedicated Windows account for your apps");
        const user = "WinDinghy";
        const pw = randomPassword();
        const r = G.ps(vm.name, [
            `$u='${user}'; $p=ConvertTo-SecureString '${pw}' -AsPlainText -Force`,
            `if (Get-LocalUser -Name $u -ErrorAction SilentlyContinue) { Set-LocalUser -Name $u -Password $p } else { New-LocalUser -Name $u -Password $p -PasswordNeverExpires -AccountNeverExpires -FullName 'WinDinghy apps' | Out-Null }`,
            `foreach ($g in 'Remote Desktop Users','Administrators') { net localgroup $g "$env:COMPUTERNAME\\$u" /add | Out-Null }`,
            `'account ready'`,
        ].join("; "), { secret: true });
        if (!/account ready/.test(r.output)) throw new Error(`Couldn't create the account:\n${r.output}`);
        cfg.username = user;
        saveConfig(cfg);
        if (!keychainSet(user, pw)) throw new Error("Couldn't save the new password to the Keychain.");
        say(`    account "${user}" created; its password is in your macOS Keychain`);
    } else if (!keychainGet(winUser(cfg))) {
        say(`    Using the Windows account ${winUser(cfg)}; WinDinghy will ask for its password on first launch (once).`);
    }

    stepSay("Syncing your Windows apps");
    await cmdSync(cfg);
    say(`\nDone. Open any app from ~/Applications/WinDinghy, or run: dinghy launch "<app>"`);
}

// Console session of the configured user (blocks RemoteApp): returns the session id or null.
function consoleSessionId(cfg, vm) {
    const user = winUser(cfg).split("\\").pop();
    if (!user) return null;
    const r = G.ps(vm, `qwinsta | ForEach-Object { if ($_ -match '^\\s*>?console\\s+(\\S+)\\s+(\\d+)') { "$($matches[1])|$($matches[2])" } }`, { timeout: 60000 });
    for (const line of r.output.split("\n")) {
        const [u, id] = line.trim().split("|");
        if (u && id && u.toLowerCase() === user.toLowerCase()) return Number(id);
    }
    return null;
}

// The domain's Group Policy often forces W32Time to an internal NTP server and a slow poll,
// and a sleeping Mac pauses the VM, so the guest clock falls behind. The Mac's clock is the
// reliable one: push it into the guest through the agent.
function setGuestClock(vmName) {
    const iso = new Date(Date.now() + 1000).toISOString(); // + ~1s for the exec round trip
    const r = G.ps(vmName, `$t=[DateTimeOffset]::Parse('${iso}'); Set-Date -Date $t.LocalDateTime | Out-Null; 'clock set'`, { timeout: 60000 });
    return /clock set/.test(r.output);
}

// Used at launch: returns true if the clock is (or was just made) right.
async function ensureGuestClock(cfg) {
    let skew = await guestClockSkew(cfg);
    if (skew <= 60) return true;
    if (G.utmInstalled() && cfg.vmName && G.agentUp(cfg.vmName)) {
        notify(`Windows clock is off by ${Math.round(skew)}s: setting it from your Mac…`);
        if (setGuestClock(cfg.vmName)) return (await guestClockSkew(cfg)) <= 60;
    }
    return false;
}

async function cmdFix(cfg, args) {
    if (args.includes("--quiet")) {
        // For background callers (e.g. after the Mac wakes): fix the clock only, no dialogs, no output.
        if (G.utmInstalled() && cfg.vmName && G.vmStatus(cfg.vmName) === "started" && G.agentUp(cfg.vmName)
            && await findGuest(cfg) && await guestClockSkew(cfg) > 30) setGuestClock(cfg.vmName);
        return;
    }
    const which = args[0] && !args[0].startsWith("-") ? args[0] : "all";
    const valid = ["all", "session", "rdp", "clock", "server", "login"];
    if (!valid.includes(which)) throw new Error(`Usage: dinghy fix [${valid.join("|")}]`);
    if (!G.utmInstalled()) throw new Error(isQemu(cfg) ? "QEMU isn't installed (brew install qemu)." : "UTM isn't installed.");
    const vm = chooseVm(cfg).name;
    if (G.vmStatus(vm) !== "started") { say(`VM "${vm}" isn't running. ${isQemu(cfg) ? "Start it with: dinghy vm start" : "Start it (menu bar > Start VM, or: dinghy launch \"<app>\")"} and try again.`); return; }
    if (!G.agentUp(vm)) { say(agentHelp(cfg)); process.exitCode = 1; return; }
    await findGuest(cfg);
    let fixed = 0;
    const all = which === "all";
    if (all && !probeAppManagement(cfg)) { await ensureAppManagement(cfg); fixed++; }

    if (all || which === "server") {
        if (!await guestAlive(cfg, 2500)) {
            stepSay("Guest server isn't answering: restarting it");
            const r = G.ps(vm, `Restart-Service WinBoatGuestServer -ErrorAction Stop; 'restarted'`);
            say(`    ${/restarted/.test(r.output) ? "restarted" : "couldn't restart: " + r.output}`);
            fixed++;
        } else if (!all) say("Guest server is fine.");
    }
    if (all || which === "clock") {
        const skew = await guestClockSkew(cfg);
        if (skew > 60 || !all) {
            stepSay(`Setting the Windows clock from your Mac${skew ? ` (off by ${Math.round(skew)}s)` : ""}`);
            say(`    ${setGuestClock(vm) ? "done" : "couldn't set the clock"}`);
            fixed++;
        }
    }
    if (all || which === "rdp") {
        if (!await portOpen(cfg.host, cfg.rdpPort) || !all) {
            stepSay("Making sure Remote Desktop is on and reachable");
            const r = G.ps(vm, `Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' fDenyTSConnections 0; Get-NetFirewallRule -Name 'RemoteDesktop-UserMode-In-TCP' -ErrorAction SilentlyContinue | Enable-NetFirewallRule; Restart-Service TermService -Force; 'ok'`);
            say(`    ${/ok$/.test(r.output) ? "done" : r.output}`);
            fixed++;
        }
    }
    if (which === "login") {
        // Repair the Windows account WinDinghy signs in with: group membership (qualified with the
        // computer name, see vm.mjs) and a fresh random password saved to the Keychain.
        const user = winUser(cfg).split("\\").pop();
        if (!user) throw new Error("No Windows username is configured (dinghy config username <name>).");
        const pw = randomPassword();
        stepSay(`Repairing the Windows account ${user}`);
        const r = G.ps(vm, [
            `$u='${user}'; $p=ConvertTo-SecureString '${pw}' -AsPlainText -Force`,
            `if (Get-LocalUser -Name $u -ErrorAction SilentlyContinue) { Set-LocalUser -Name $u -Password $p } else { New-LocalUser -Name $u -Password $p -PasswordNeverExpires -AccountNeverExpires -FullName 'WinDinghy apps' | Out-Null }`,
            `foreach ($g in 'Administrators','Remote Desktop Users') { net localgroup $g "$env:COMPUTERNAME\\$u" /add 2>&1 | Out-Null }`,
            `'account repaired'`,
        ].join("; "), { secret: true });
        if (!/account repaired/.test(r.output)) throw new Error(`Couldn't repair the account:\n${r.output}`);
        if (!keychainSet(winUser(cfg), pw)) throw new Error("Repaired the account but couldn't save the password to the Keychain.");
        say("    done; the new password is in your Keychain");
        fixed++;
    }
    if (all || which === "session") {
        const id = consoleSessionId(cfg, vm);
        if (id != null) {
            const yes = asDialog(`button returned of (display dialog "You're signed in on the Windows VM's own screen as ${asq(winUser(cfg))}. Windows apps can't open through WinDinghy while that session exists.\\n\\nSign it out now? Unsaved work in that Windows session will be lost." with title "WinDinghy" with icon caution buttons {"Leave it", "Sign out"} default button "Leave it")`);
            if (yes === "Sign out") {
                stepSay("Signing out the console session");
                G.ps(vm, `logoff ${id}`);
                fixed++;
            } else say("Left the console session alone.");
        } else if (!all) say("No console session is blocking RemoteApp.");
    }
    say(fixed ? `\nApplied ${fixed} fix${fixed === 1 ? "" : "es"}. Try your app again.` : `\nNothing needed fixing.`);
}

// Delegates to the repo-root `update` launcher (installed from the tracked
// host/dinghy-update.sh on first run) rather than reimplementing the git
// logic here — see host/dinghy-update.sh for why it's a separate script.
function cmdLogin(cfg) {
    if (!cfg.username) throw new Error("Set your Windows login first: dinghy config username <domain\\user>");
    const pw = promptPassword(winUser(cfg));
    if (!pw) { console.log("Cancelled."); return; }
    console.log(keychainSet(winUser(cfg), pw) ? `Saved the password for ${winUser(cfg)} in your Keychain.` : "Could not save to the Keychain.");
}

function cmdUpdate() {
    const launcher = path.join(PROJECT_ROOT, "update");
    const tracked = path.join(PROJECT_ROOT, "host", "dinghy-update.sh");
    if (!fs.existsSync(launcher)) {
        if (!fs.existsSync(tracked)) throw new Error("Updater script missing — this isn't a full windinghy checkout.");
        fs.copyFileSync(tracked, launcher);
        fs.chmodSync(launcher, 0o755);
    }
    const r = spawnSync(launcher, [], { stdio: "inherit" });
    process.exit(r.status ?? 1);
}

// Settings that point WinDinghy at something other than its own managed VM.
const ADVANCED_KEYS = ["host", "apiPort", "rdpPort", "client", "nativeBin", "vmBackend"];

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
    if (ADVANCED_KEYS.includes(key)) needAdvanced(cfg, `Changing "${key}"`);
    cfg[key] = /^\d+$/.test(value) && key.endsWith("Port") ? Number(value) : value;
    saveConfig(cfg);
    console.log(`${key} = ${cfg[key]}`);
    if (key === "advanced" && value === "on") {
        console.log("\nAdvanced mode is on. Other setups (UTM or another hypervisor, a VM on another machine, a custom client) are unsupported:");
        console.log("they may work, and you're on your own if they don't. " + REMOTE_WARNING);
    }
    if (key === "host" && !isLocalHost(cfg.host)) console.log("\nWARNING: " + REMOTE_WARNING);
}

// ---------- main ----------

const [cmd, ...rest] = process.argv.slice(2);
const cfg = loadConfig();
G.useBackend(cfg);

try {
    switch (cmd) {
        case "serve-setup": needAdvanced(cfg, "Manual guest setup (serve-setup)"); await cmdServeSetup(cfg, rest.includes("--json"), rest.includes("--no-banner")); break;
        case "status":      await findGuest(cfg); await cmdStatus(cfg); break;
        case "sync":        await findGuest(cfg); await cmdSync(cfg); break;
        case "discover":    await cmdDiscover(cfg, rest.includes("--quiet")); break;
        case "launch":      await cmdLaunch(cfg, rest.join(" ")); break;
        case "desktop":     await cmdLaunch(cfg, "Windows Desktop"); break;
        case "open-rdp":    await cmdOpenRdp(cfg, rest[0]); break;
        case "doctor":      await findGuest(cfg); await cmdDoctor(cfg); break;
        case "config":      cmdConfig(cfg, rest[0], rest[1]); break;
        case "update":      cmdUpdate(); break;
        case "login":       cmdLogin(cfg); break;
        case "pkg":         await cmdPkg(cfg, rest); break;
        case "activation":  await cmdActivation(cfg, rest); break;
        case "domain":      await cmdDomain(cfg, rest); break;
        case "folders":     await cmdFolders(cfg, rest); break;
        case "open-settings": await cmdOpenSettings(cfg, rest[0]); break;
        case "permissions": {
            let ok;
            if (rest.includes("--prompt")) {
                const quiet = rest.includes("--quiet");
                const stamp = path.join(CONFIG_DIR, "app-management-prompted");
                // Background callers (app start) don't nag: at most one prompt a day.
                if (quiet && !probeAppManagement(cfg) && (() => { try { return Date.now() - fs.statSync(stamp).mtimeMs < 86400000; } catch { return false; } })()) {
                    ok = false;
                } else {
                    if (quiet && !probeAppManagement(cfg)) { try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(stamp, ""); } catch {} }
                    ok = await ensureAppManagement(cfg, { wait: !quiet });
                }
            } else ok = probeAppManagement(cfg);
            if (!rest.includes("--quiet")) console.log(ok ? "App Management: allowed" : "App Management: BLOCKED (System Settings > Privacy & Security > App Management > WinDinghy)");
            process.exit(ok ? 0 : 1);
        }
        case "setup":       await cmdSetup(cfg, rest); break;
        case "vm":          await cmdVm(cfg, rest); break;
        case "about":
        case "components":  cmdAbout(cfg, rest.includes("--json")); break;
        case "fix":         await cmdFix(cfg, rest); break;
        case "version":
        case "--version":
        case "-v":          console.log(`dinghy ${VERSION}`); break;
        default:
            console.log(`dinghy — WinDinghy ${VERSION}

Usage:
  dinghy serve-setup          serve guest payload; prints the one-liner to run in the VM
  dinghy status               guest health / metrics / RDP reachability
  dinghy sync                 generate ~/Applications/WinDinghy/*.app launchers
  dinghy launch "<name>"      launch a Windows app
  dinghy desktop              full Windows desktop session
  dinghy doctor               check mac-side + guest-side requirements
  dinghy config [key [val]]   show/set config (host, apiPort, rdpPort, username, appsDir)
  dinghy update               pull the latest WinDinghy from git and rebuild
  dinghy about                versions installed vs the tested versions
  dinghy pkg <search|list|install|uninstall|upgrade> ...   software via winget
  dinghy folders <status|on|off|ro|apply>   Mac folders as Windows folders; read-only shares
  dinghy activation [key <KEY>]   Windows activation status / enter a key
  dinghy domain <status|join|leave|gpupdate>   work, school and domain
  dinghy open-settings <page> open a Windows Settings page (workplace, yourinfo, activation...)
  dinghy vm <move|export|import> ...   relocate, back up or restore the VM
  dinghy version              print the WinDinghy version`);
    }
} catch (e) {
    if (appManagementHint(e)) console.error("Error: macOS App Management is blocking WinDinghy from updating its app launchers (System Settings > Privacy & Security > App Management > WinDinghy).");
    else console.error(`Error: ${e.message}`);
    process.exit(1);
}
