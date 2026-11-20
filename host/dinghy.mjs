#!/usr/bin/env node
// dinghy — WinDinghy host CLI
// Talks to the WinBoat Guest Server inside a Windows VM (UTM or anything
// reachable over IP) and turns Windows apps into native-feeling macOS
// launchers that open as RemoteApp windows via Microsoft's "Windows App".
//
// Commands:
//   dinghy serve-setup          serve the guest payload + setup one-liner, wait for the guest
//                               (--no-banner or config suppressBanner=on: keep the Windows banner suppressed; opt-in, may violate network policy)
//   dinghy status               guest health / version / metrics
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
    const candidates = [cfg.nativeBin, path.join(PROJECT_ROOT, "vendor", "freerdp", "bin", "sdl-freerdp")].filter(Boolean);
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

const BANNER_PATH = path.join(CONFIG_DIR, "banner.json");

// The Windows logon banner (legal notice), reported by the guest during setup.
// Shown natively when the server actually asks for it (the client logs a marker);
// accepting signals the client to dismiss the matching Windows dialog.
function readBanner() {
    try { return JSON.parse(fs.readFileSync(BANNER_PATH, "utf8")); } catch { return null; }
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
    a.push(`/p:${pw}`, "/cert:ignore", `/scale-desktop:${cfg.scale || 100}`, "/scale-device:100", "+clipboard", "/gfx", "/log-level:WARN");
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
    } catch { return bin; }
}

async function launchNative(cfg, meta, bundleDir, retried = false) {
    const bin = bundleClient(nativeBin(cfg), bundleDir);
    if (!cfg.username) { notify(`Set your Windows login first: dinghy config username <domain\\user>`); process.exit(1); }
    const pw = getPassword(cfg, retried);
    if (!pw) { notify("No Windows password saved. Run: dinghy login"); process.exit(1); }

    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logFile = path.join(LOG_DIR, `${safeName(meta.Name ?? "desktop")}.log`);
    const fd = fs.openSync(logFile, "w");
    // Credentials go in over stdin (/args-from) so they never appear in `ps`.
    const child = spawn(bin, ["/args-from:stdin"], { detached: true, stdio: ["pipe", fd, fd], env: { ...process.env, WINDINGHY_APP_NAME: meta.Name ?? "Windows Desktop", WINDINGHY_NO_ERROR_DIALOGS: "1" } });
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
            const b = readBanner();
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
    if (/LOGON_FAILURE|ACCESS_DENIED|0x00020014/.test(log) && !retried) {
        keychainDelete(winUser(cfg));
        return launchNative(cfg, meta, bundleDir, true);
    }
    const problem = diagnoseExit(cfg, exited, log);
    if (problem) showError(problem.title, problem.message, logFile);
}

// Map a client exit to a user-facing problem, or null for a normal end.
function diagnoseExit(cfg, code, log) {
    if (/LAST-WINDOW-CLOSED/.test(log)) return null;
    if (/ERRINFO_RPC_INITIATED_DISCONNECT_BY_USER|ERRINFO_DISCONNECT_BY_USER/.test(log)) return null;
    if (code === 0 || code === null || code === -1) return null; // clean exit or killed by a signal
    if (/LOGON_FAILURE|ACCESS_DENIED|0x00020014/.test(log))
        return { title: "Windows rejected the login", message: `Windows rejected the password for ${winUser(cfg)}. Run "dinghy login" to save the right one.` };
    if (/ERRINFO_(LOGOFF_BY_USER|RPC_INITIATED_DISCONNECT)\b/.test(log))
        return { title: "Windows ended the session", message: `If you're signed in to the VM console (UTM) as ${winUser(cfg)}, sign out there: RemoteApp can't attach to a desktop session.` };
    if (/0x1807|CREDSSP|SECURITY/i.test(log))
        return { title: "Security error", message: "Windows refused the secure connection, usually because the VM clock drifted. Run \"dinghy doctor\", or restart the VM." };
    if (/TRANSPORT_FAILED|Broken pipe|CONNECT_FAILED|0x0002000[0-9a-f]|timed out|refused/i.test(log))
        return { title: "Lost the Windows VM", message: `Couldn't reach (or lost) the VM at ${cfg.host}. Is it running? Start it in UTM and try again.` };
    if (/IDLE_TIMEOUT|LOGON_TIMEOUT/.test(log))
        return { title: "Session timed out", message: "Windows ended the session because it was idle or the logon took too long." };
    const last = log.split("\n").filter(l => /WINDINGHY-ERROR|\[ERROR\]/.test(l)).pop() ?? "";
    return { title: "Connection failed", message: last.replace(/^\[[^\]]*\] \[[^\]]*\] /, "").slice(0, 400) || `The Windows connection ended unexpectedly (exit ${code}).` };
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
        notify(`Can't reach the Windows VM. Start it in UTM, then try again.`);
        process.exit(1);
    }
    // Hold the launch while a drifted clock heals (guest resyncs every 60s)
    // instead of letting the connection fail.
    let skew = await guestClockSkew(cfg);
    if (skew > 120) {
        notify(`Windows clock is off by ${Math.round(skew)}s — waiting for it to resync…`);
        const deadline = Date.now() + 75_000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 5000));
            skew = await guestClockSkew(cfg);
            if (skew <= 120) break;
        }
        if (skew > 120) {
            notify(`Clock still drifted — the connection may fail with a security error (0x1807). Restart the VM, or re-run "Set Up Windows VM…" to install the faster time sync.`);
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

    const baseUrl = `http://${ip}:${SETUP_PORT}`;
    const setupTemplate = fs.readFileSync(path.join(PAYLOAD_DIR, "setup.ps1"), "utf8");
    const setupScript = setupTemplate.replace("__BASE_URL__", baseUrl).replace("__NO_BANNER__", noBanner ? "$true" : "$false");

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
        } else if (req.url === "/banner" && req.method === "POST") {
            let body = "";
            req.on("data", c => { body += c; if (body.length > 65536) req.destroy(); });
            req.on("end", () => {
                try {
                    const b = JSON.parse(body);
                    fs.mkdirSync(CONFIG_DIR, { recursive: true });
                    fs.writeFileSync(BANNER_PATH, JSON.stringify({ caption: String(b.caption ?? ""), text: String(b.text ?? "") }, null, 2) + "\n");
                    console.log(`  [${new Date().toLocaleTimeString()}] guest reported its logon banner`);
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
        case "serve-setup": await cmdServeSetup(cfg, rest.includes("--json"), rest.includes("--no-banner")); break;
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
  dinghy version              print the WinDinghy version`);
    }
} catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
}
