// host/android/adb.mjs — the adb wrapper RoboDinghy uses to talk to its own emulator, always by serial
// (emulator-<consolePort>) so other emulators and devices on this Mac are never touched.
//
// Exports:
//   serial(cfg)                     "emulator-<consolePort>"
//   adb(cfg, args, opts?)           spawnSync of the SDK's adb with -s <serial>; { status, stdout, stderr, ok }
//                                   opts: { timeout (ms, default 30000), input, noSerial }
//   shell(cfg, cmd, opts?)          `adb shell <cmd>`; trimmed stdout, or null on failure
//   emu(cfg, ...args)               emulator console through adb (`adb emu ...`): { ok, out } where ok
//                                   means the console answered without "KO"
//   avdName(cfg)                    the AVD name of the emulator on our serial (`emu avd name`), or null
//   state(cfg)                      "device" | "offline" | "unauthorized" | null (not listed)
//   getprop(cfg, name)              trimmed value or null
//   booted(cfg)                     sys.boot_completed == 1
//   storageReady(cfg)               /sdcard is mounted and writable
//   waitBoot(cfg, seconds, onTick?) async: adb sees the device, boot completed and storage is up; true/false.
//                                   onTick() runs first on every round (before the boot checks); returning
//                                   false gives up (e.g. the emulator died, or it isn't ours)
//   install(cfg, apk, { replace=true, grant=false }) { ok, out } (`adb install -r [-g]`)
//   uninstall(cfg, pkg)             { ok, out }
//   packages(cfg, { thirdParty })   [{ id, versionCode }] from `pm list packages --show-versioncode`
//   versionName(cfg, pkg)           versionName from dumpsys, or null
//   push / pull(cfg, a, b)          { ok, out }

import { spawnSync } from "node:child_process";
import { tools } from "./sdk.mjs";
import { CONSOLE_PORT } from "./product.mjs";

export const serial = cfg => `emulator-${Number(cfg.consolePort) || CONSOLE_PORT}`;

let adbBin = null;   // resolved once per process (tools() touches the file system)
export function adb(cfg, args, { timeout = 30000, input, noSerial = false } = {}) {
    const bin = adbBin ??= tools(cfg).adb;
    const r = spawnSync(bin, noSerial ? args : ["-s", serial(cfg), ...args], { encoding: "utf8", timeout, input, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ok: r.status === 0, error: r.error };
}

export function shell(cfg, cmd, opts) {
    const r = adb(cfg, ["shell", cmd], opts);
    return r.ok ? r.stdout.trim() : null;
}

export function emu(cfg, ...args) {
    const r = adb(cfg, ["emu", ...args], { timeout: 120000 });
    const out = (r.stdout + r.stderr).trim();
    return { ok: r.ok && !/^KO\b/m.test(out) && !/error: /i.test(r.stderr), out };
}

export function avdName(cfg) {
    const r = adb(cfg, ["emu", "avd", "name"], { timeout: 10000 });
    if (!r.ok) return null;
    const lines = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return lines.includes("OK") && lines[0] !== "OK" && !/^KO\b/.test(lines[0]) ? lines[0] : null;
}

export function state(cfg) {
    const r = adb(cfg, ["devices"], { noSerial: true, timeout: 15000 });
    const line = r.stdout.split("\n").find(l => l.startsWith(serial(cfg) + "\t"));
    return line ? line.split("\t")[1].trim() : null;
}

export function getprop(cfg, name) {
    const v = shell(cfg, `getprop ${name}`, { timeout: 10000 });
    return v === null || v === "" ? null : v;
}

export const booted = cfg => state(cfg) === "device" && getprop(cfg, "sys.boot_completed") === "1";

// Shared storage (/sdcard) is mounted a little after sys.boot_completed; the helper export and adb
// push/pull need it.
// (`test -w` says yes before writes really work, so probe with a real write.)
export const storageReady = cfg => shell(cfg, "echo 1 > /sdcard/.robodinghy-probe && rm -f /sdcard/.robodinghy-probe && echo y", { timeout: 10000 }) === "y";

export async function waitBoot(cfg, seconds, onTick) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
        if (onTick && onTick() === false) return false;   // the caller says give up (e.g. the emulator died)
        if (booted(cfg) && storageReady(cfg)) return true;
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

export function install(cfg, apk, { replace = true, grant = false } = {}) {
    const args = ["install", ...(replace ? ["-r"] : []), ...(grant ? ["-g"] : []), apk];
    const r = adb(cfg, args, { timeout: 600000 });
    const out = (r.stdout + r.stderr).trim();
    return { ok: r.ok && /\bSuccess\b/.test(out), out };
}

export function uninstall(cfg, pkg) {
    const r = adb(cfg, ["uninstall", pkg], { timeout: 120000 });
    const out = (r.stdout + r.stderr).trim();
    return { ok: r.ok && /\bSuccess\b/.test(out), out };
}

export function packages(cfg, { thirdParty = false } = {}) {
    const out = shell(cfg, `pm list packages ${thirdParty ? "-3 " : ""}--show-versioncode`, { timeout: 30000 }) ?? "";
    return out.split("\n").map(l => l.trim().match(/^package:(\S+)(?:\s+versionCode:(\d+))?/)).filter(Boolean)
        .map(m => ({ id: m[1], versionCode: m[2] ? Number(m[2]) : null }));
}

export function versionName(cfg, pkg) {
    const out = shell(cfg, `dumpsys package ${pkg} | grep -m1 versionName=`, { timeout: 30000 });
    return out?.match(/versionName=(\S+)/)?.[1] ?? null;
}

export function push(cfg, a, b) { const r = adb(cfg, ["push", a, b], { timeout: 600000 }); return { ok: r.ok, out: (r.stdout + r.stderr).trim() }; }
export function pull(cfg, a, b) { const r = adb(cfg, ["pull", a, b], { timeout: 600000 }); return { ok: r.ok, out: (r.stdout + r.stderr).trim() }; }
