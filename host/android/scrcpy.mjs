// host/android/scrcpy.mjs — Android app windows on the Mac. Each app is its own scrcpy process showing
// one Android virtual display (scrcpy --new-display ... --start-app=<package>); the Android Desktop
// is a plain mirror of the main display. The launcher bundle gets its own copy of the scrcpy binary
// (Contents/MacOS/scrcpy) so the Dock shows the app's name and icon, like WinDinghy's FreeRDP copy.
//
// Exports:
//   scrcpyArgs(cfg, meta, { audio })  argv for an app (meta.Package) or the desktop (meta.desktop); audio=false
//                                    adds --no-audio (only one window at a time plays Android's sound)
//   scrcpyEnv(cfg)                   env with SCRCPY_SERVER_PATH and ADB pointing at our SDK's adb
//   bundleClient(bin, bundleDir, onError?)  copy scrcpy into <bundle>/Contents/MacOS/scrcpy (ad-hoc
//                                    signed, refreshed only when the source changes: Contents/MacOS/.scrcpy-source
//                                    holds "<source realpath>:<size>:<mtime>"); returns the path to run
//   openWindow(cfg, meta, bundleDir, { logFile, onError })  async: spawn detached, wait for exit; resolves
//                                    { code, elapsedSec, log } (startup serialised across launchers by a lock)
//   diagnose(code, log, elapsedSec)  { title, message } for a failed window, or null
//   openWindows(cfg)                 [{ pid, bundle, audio }] scrcpy processes running from launchers in appsDir

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tools } from "./sdk.mjs";
import { serial } from "./adb.mjs";
import { logTail } from "../common/cli.mjs";

export function scrcpyEnv(cfg) {
    const t = tools(cfg);
    return { ...process.env, ADB: t.adb, ...(t.scrcpyServer ? { SCRCPY_SERVER_PATH: t.scrcpyServer } : {}) };
}

// Every scrcpy audio capture gets Android's whole output mix (there is no per-display audio), so N open
// windows would play N copies. Only one window carries the sound: the first one opened while no other
// RoboDinghy window has audio (opts.audio=false for the rest).
export function scrcpyArgs(cfg, meta, { audio = true } = {}) {
    const name = meta.desktop ? (meta.Name ?? "Android Desktop") : meta.Name;
    const args = [`--serial=${serial(cfg)}`];
    if (!meta.desktop) {
        args.push(`--new-display=${cfg.windowSize || "1280x800"}/${Number(cfg.displayDpi) || 240}`, "--flex-display", `--start-app=${meta.Package}`);
    }
    args.push(`--window-title=${name}`);
    if (cfg.shareAudio === "off" || !audio) args.push("--no-audio");
    if (cfg.shareClipboard === "off") args.push("--no-clipboard-autosync");
    if (cfg.videoCodec) args.push(`--video-codec=${cfg.videoCodec}`);
    if (Number(cfg.maxFps) > 0) args.push(`--max-fps=${Number(cfg.maxFps)}`);
    return args;
}

export function bundleClient(bin, bundleDir, onError) {
    try {
        const contents = path.resolve(bundleDir, "..");
        if (!contents.endsWith(".app/Contents")) return bin;
        const dest = path.join(contents, "MacOS", "scrcpy");
        // The copy is re-signed, which changes its size, so compare against a stamp of the source it was
        // made from (resolved path, size, mtime), not against the copy itself.
        const stampFile = path.join(contents, "MacOS", ".scrcpy-source");
        const real = fs.realpathSync(bin);
        const src = fs.statSync(real);
        const stamp = `${real}:${src.size}:${Math.round(src.mtimeMs)}`;
        let stale = true;
        try { stale = !fs.statSync(dest).isFile() || fs.readFileSync(stampFile, "utf8") !== stamp; } catch {}
        if (stale) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const tmp = dest + ".new";
            fs.copyFileSync(real, tmp);
            fs.chmodSync(tmp, 0o755);
            spawnSync("codesign", ["--force", "--sign", "-", tmp], { stdio: "ignore" });
            fs.renameSync(tmp, dest);
            try { fs.writeFileSync(stampFile, stamp); } catch {}
        }
        return dest;
    } catch (e) { onError?.(e); return bin; }
}

export async function openWindow(cfg, meta, bundleDir, { logFile, onError } = {}) {
    const t = tools(cfg);
    if (!t.scrcpy) throw new Error("scrcpy isn't installed. Run: brew install scrcpy");
    const bin = bundleClient(t.scrcpy, bundleDir, onError);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, "w");
    // Two launchers opened at once (e.g. both clicked in the Dock) race in scrcpy's tunnel setup: they
    // grab the same local port and one window ends up wired to the other's server. They would also both
    // decide they own the audio. So window startup is serialised with a lock dir next to the logs, held
    // until this window's server is up (or it exits, or 12 s pass).
    const lock = await acquireLock(path.join(path.dirname(logFile), ".open.lock"));
    const started = Date.now();
    let exitP;
    try {
        const audio = !openWindows(cfg).some(w => w.audio);
        const child = spawn(bin, scrcpyArgs(cfg, meta, { audio }), { detached: true, stdio: ["ignore", fd, fd], env: scrcpyEnv(cfg) });
        fs.closeSync(fd);
        let exited = false;
        exitP = new Promise(resolve => {
            child.on("exit", c => { exited = true; resolve(c ?? -1); });
            child.on("error", () => { exited = true; resolve(-1); });
        });
        const ready = meta.desktop ? /\[server\] INFO: Device:/ : /\[server\] INFO: (New display|Starting app)/;
        const t0 = Date.now();
        while (!exited && Date.now() - t0 < 12000) {
            let txt = "";
            try { txt = fs.readFileSync(logFile, "utf8"); } catch {}
            if (ready.test(txt)) { await sleepMs(meta.desktop ? 1500 : 500); break; }
            await sleepMs(150);
        }
    } finally { lock.release(); }
    // detached (its own session: survives this process), but not unref'd: we stay alive until the window
    // closes so a failure can be explained, like WinDinghy's launchNative.
    const code = await exitP;
    let log = logTail(logFile);
    try { if (!/INFO: Texture/.test(log) && /INFO: Texture/.test(fs.readFileSync(logFile, "utf8"))) log = "INFO: Texture (shown)\n" + log; } catch {}
    return { code, elapsedSec: (Date.now() - started) / 1000, log };
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// mkdir is atomic: whoever creates the dir holds the lock. A lock older than 30 s is stale (its holder
// died) and is taken over. Gives up waiting after 30 s and proceeds unlocked rather than never opening.
async function acquireLock(dir) {
    const t0 = Date.now();
    for (;;) {
        try { fs.mkdirSync(dir); return { release() { try { fs.rmdirSync(dir); } catch {} } }; }
        catch (e) {
            if (e.code !== "EEXIST") return { release() {} };
            try { if (Date.now() - fs.statSync(dir).mtimeMs > 30000) { fs.rmdirSync(dir); continue; } } catch { continue; }
            if (Date.now() - t0 > 30000) return { release() {} };
            await sleepMs(150);
        }
    }
}

export function diagnose(code, log, elapsedSec) {
    if (code === 0) return null;
    // The window got a picture ("INFO: Texture"), so startup worked: it was closed later (by the user,
    // or by Android stopping / saving / rewinding). Not a failure worth a dialog.
    if (/INFO: Texture/.test(log)) return null;
    if (/Could not find any ADB device|device .* not found|no devices\/emulators/i.test(log))
        return { title: "Android isn't reachable", message: "The Android VM isn't answering over adb. Start it from the RoboDinghy menu (or: robodinghy vm start) and try again." };
    if (/start-app|Could not start app|No app found|not found.*package/i.test(log))
        return { title: "App not found", message: "This app isn't installed in Android any more. Refresh your apps (robodinghy sync)." };
    if (/server|push|Could not/i.test(log) && elapsedSec < 15)
        return { title: "Couldn't open the window", message: "scrcpy couldn't connect to Android. Try again in a moment, or run: robodinghy doctor" };
    if (elapsedSec < 10) return { title: "The window closed unexpectedly", message: "scrcpy stopped right after starting. Run: robodinghy doctor" };
    return null;   // closed after a while: most likely the user (or a killed VM); stay quiet
}

export function openWindows(cfg) {
    const r = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    const prefix = path.resolve(cfg.appsDir) + "/";
    const out = [];
    for (const l of (r.stdout ?? "").split("\n")) {
        const m = l.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        const cmd = m[2];
        if (cmd.startsWith(prefix) && /\.app\/Contents\/MacOS\/scrcpy(\s|$)/.test(cmd)) out.push({ pid: Number(m[1]), bundle: cmd.slice(prefix.length).split(".app/")[0], audio: !/\s--no-audio(\s|$)/.test(cmd) });
    }
    return out;
}
