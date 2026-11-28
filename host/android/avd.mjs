// host/android/avd.mjs — the RoboDinghy Android VM: one AVD run headless by Google's Android Emulator.
// Same exported surface style as host/vm.mjs (WinDinghy's QEMU VM), so the CLI's power policy and
// snapshot verbs read the same way.
//
// Layout (default ~/Library/Application Support/RoboDinghy, override with config vmDir):
//   avd/                 ANDROID_AVD_HOME: RoboDinghy.ini + RoboDinghy.avd/ (config.ini, disks, snapshots/)
//   emulator.pid         pid of the detached emulator (it has no -pidfile of its own)
//   emulator.port        its console port (adb serial emulator-<port>) while it runs
//   emulator.log         its stdout/stderr
//   paused               marker: the VM is frozen (not off), for the menu-bar app
//   suspend.json         { savedAt, bytes } beside the "robodinghy-suspend" emulator snapshot (vm save);
//                        { ..., loadedAt } once a start has restored it (consumed: never loaded again),
//                        { savingAt } while a save is in progress (an unfinished save is never loaded)
//   .power.lock/         held (mkdir) while start / finishStart / stop / saveState / destroy run, so two
//                        robodinghy processes never interleave power transitions
//   helper.sha256        hash of the helper APK last installed into this AVD
//   sdk/                 only when RoboDinghy had to install the SDK itself (see sdk.mjs)
//
// The emulator always runs with -no-snapshot-save, so quitting never writes a quickboot snapshot behind
// our back: saving is the explicit `vm save` (snapshot robodinghy-suspend + kill), and the next start
// loads it once (-snapshot robodinghy-suspend). The start marks it consumed (loadedAt) *before* the
// emulator runs, so even if the booting CLI is killed or times out, the state is never loaded a second
// time (that would roll the disk back). The consumed snapshot is deleted after boot (finishStart) or,
// failing that, offline once the emulator has exited (stop / the next start).
//
// Exports:
//   vmDir(cfg), files(cfg), exists(cfg), pidOf(cfg), isRunning(cfg), isPaused(cfg)
//   runningPort(cfg)                         console port the running emulator was started with, or null
//   isOurs(cfg)                              the emulator answering on our serial is our AVD: true / false /
//                                            null (console didn't answer)
//   readIni(file) / writeIni(file, kv)       key=value files (config.ini); writeIni merges keys
//   create(cfg, { say })                     avdmanager create avd ... -d desktop_medium, then config.ini
//   applyResources(cfg)                      RAM/cores/data size from cfg into config.ini; returns notes
//   start(cfg, { cold })                     spawn the emulator detached; { restoring } (doesn't wait for boot);
//                                            throws if the console/adb/gRPC ports are taken
//   finishStart(cfg)                         after boot: drop a consumed (already loaded) suspend snapshot
//   stop(cfg, waitSec=60)                    graceful power-off, then console kill, then SIGKILL; true if graceful
//   pause(cfg) / resume(cfg)                 freeze/unfreeze the vCPUs (console `avd pause` / `avd resume`)
//   saveState(cfg)                           snapshot robodinghy-suspend + kill; throws (VM left running) if it can't
//   hasState(cfg)                            a saved state that the next start will load
//   discardState(cfg)
//   ramGB(cfg)                               RAM the guest really gets (the emulator raises less to 4 GB)
//   freeBytes(dir), minFreeBytes(cfg, forState), spaceCheck(cfg, forState)
//   validSnapshotName(n), snapshotList(cfg) -> [{name, date(ms)}] (internal names hidden),
//   snapshotCreate / snapshotApply / snapshotDelete(cfg, name)   (create/apply need the VM running)
//   destroy(cfg), sizeOnDisk(cfg), emulatorArgs(cfg, { snapshot })

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tools, toolEnv, imageId, imageDir } from "./sdk.mjs";
import * as A from "./adb.mjs";
import { VM_DIR, AVD_NAME, CONSOLE_PORT, GRPC_PORT, SUSPEND_SNAPSHOT, CLI } from "./product.mjs";

const INTERNAL_SNAPSHOTS = new Set([SUSPEND_SNAPSHOT, "default_boot", "suspend"]);
const GB = 1024 ** 3;
const sleep = s => spawnSync("sleep", [String(s)]);

export function vmDir(cfg) { return cfg.vmDir || VM_DIR; }

export function files(cfg) {
    const d = vmDir(cfg);
    const avdHome = path.join(d, "avd");
    const avd = path.join(avdHome, `${AVD_NAME}.avd`);
    return {
        dir: d,
        avdHome,
        avd,
        ini: path.join(avdHome, `${AVD_NAME}.ini`),
        config: path.join(avd, "config.ini"),
        snapshots: path.join(avd, "snapshots"),
        pid: path.join(d, "emulator.pid"),
        port: path.join(d, "emulator.port"),     // console port the running emulator was started with
        log: path.join(d, "emulator.log"),
        pausedMark: path.join(d, "paused"),
        stateMeta: path.join(d, "suspend.json"),
        helperStamp: path.join(d, "helper.sha256"),
    };
}

export function exists(cfg) { return fs.existsSync(files(cfg).config); }

export function pidOf(cfg) {
    try {
        const f = files(cfg);
        const pid = Number(fs.readFileSync(f.pid, "utf8").trim());
        if (!pid) return null;
        process.kill(pid, 0);
        // emulator.pid survives a crash or reboot, and the pid can then belong to anything, including
        // another AVD's emulator. Only count it if its command line is ours: -avd RoboDinghy on the port
        // we recorded (the emulator keeps that argv when it execs qemu).
        const args = ` ${spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).stdout.trim()} `;
        if (!/emulator|qemu/i.test(args) || !args.includes(` -avd ${AVD_NAME} `)) return null;
        let port = null;
        try { port = Number(fs.readFileSync(f.port, "utf8").trim()) || null; } catch {}
        if (port && !args.includes(` -port ${port} `)) return null;
        return pid;
    } catch { return null; }
}

export function isRunning(cfg) { return pidOf(cfg) !== null; }

// The console port of the running emulator (it can differ from the config if that changed meanwhile).
export function runningPort(cfg) {
    if (!isRunning(cfg)) return null;
    try { const n = Number(fs.readFileSync(files(cfg).port, "utf8").trim()); return n > 0 ? n : null; } catch { return null; }
}

// ---------- config.ini ----------

export function readIni(file) {
    const out = {};
    try {
        for (const l of fs.readFileSync(file, "utf8").split("\n")) {
            const m = l.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
            if (m) out[m[1]] = m[2];
        }
    } catch {}
    return out;
}

export function writeIni(file, kv) {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(l => l.trim()) : [];
    const seen = new Set();
    const outLines = lines.map(l => {
        const m = l.match(/^\s*([^#=\s][^=]*?)\s*=/);
        if (m && m[1] in kv) { seen.add(m[1]); return `${m[1]}=${kv[m[1]]}`; }
        return l;
    });
    for (const [k, v] of Object.entries(kv)) if (!seen.has(k)) outLines.push(`${k}=${v}`);
    fs.writeFileSync(file, outLines.join("\n") + "\n");
}

// The emulator raises an AVD's RAM to at least 4 GB for current images ("Increasing RAM size to 4096MB"),
// so config.ini, the space checks and their messages use what the guest really gets.
export const MIN_RAM_GB = 4;
export const ramGB = cfg => Math.max(MIN_RAM_GB, Number(cfg.vmRamGB) || MIN_RAM_GB);
const ramMB = cfg => Math.round(ramGB(cfg) * 1024);
const dataGB = v => { const m = String(v ?? "").match(/^(\d+(?:\.\d+)?)\s*([GMK]?)/i); if (!m) return 0; const n = Number(m[1]); return /g/i.test(m[2]) ? n : /m/i.test(m[2]) ? n / 1024 : /k/i.test(m[2]) ? n / 1048576 : n / GB; };

export function applyResources(cfg) {
    const f = files(cfg);
    const cur = readIni(f.config);
    const want = { "hw.ramSize": String(ramMB(cfg)), "hw.cpu.ncore": String(Number(cfg.vmCpus) || 4) };
    // The data partition can only grow (the emulator resizes userdata on the next cold boot).
    const disk = Number(cfg.vmDiskGB) || 16;
    if (dataGB(cur["disk.dataPartition.size"]) < disk) want["disk.dataPartition.size"] = `${disk}G`;
    const changed = Object.entries(want).filter(([k, v]) => cur[k] !== v);
    if (!changed.length) return [];
    writeIni(f.config, Object.fromEntries(changed));
    return changed.map(([k, v]) => `${k} ${cur[k] ?? "-"} -> ${v}`);
}

export function create(cfg, { say = console.log } = {}) {
    const t = tools(cfg);
    const f = files(cfg);
    if (!t.avdmanager) throw new Error("avdmanager (Android SDK command-line tools) isn't installed.");
    if (exists(cfg)) throw new Error(`A ${AVD_NAME} AVD already exists in ${f.avdHome}.`);
    fs.mkdirSync(f.avdHome, { recursive: true });
    const r = spawnSync(t.avdmanager, ["create", "avd", "-n", AVD_NAME, "-k", imageId(cfg), "-d", "desktop_medium", "-p", f.avd], {
        env: toolEnv(cfg, { ANDROID_AVD_HOME: f.avdHome }), input: "no\n", encoding: "utf8", timeout: 300000,
    });
    // avdmanager prints harmless devices.xml parse errors on newer SDKs; success = the AVD exists.
    if (!fs.existsSync(f.config)) throw new Error(`avdmanager couldn't create the AVD:\n${((r.stderr || "") + (r.stdout || "")).trim().split("\n").filter(l => !/devices\.xml|cvc-|^\s*$/.test(l)).slice(-6).join("\n")}`);
    const play = /google_apis_playstore/.test(imageId(cfg));
    writeIni(f.config, {
        "hw.lcd.width": "1920", "hw.lcd.height": "1200", "hw.lcd.density": "240",
        "hw.initialOrientation": "landscape",
        "hw.ramSize": String(ramMB(cfg)), "hw.cpu.ncore": String(Number(cfg.vmCpus) || 4),
        "hw.gpu.enabled": "yes", "hw.gpu.mode": "host",
        "hw.keyboard": "yes",
        "PlayStore.enabled": play ? "true" : "false",
        "disk.dataPartition.size": `${Number(cfg.vmDiskGB) || 16}G`,
        "showDeviceFrame": "no", "skin.dynamic": "yes", "skin.name": "1920x1200", "skin.path": "_no_skin",
        "fastboot.forceColdBoot": "no", "fastboot.forceFastBoot": "no",
    });
    // Make the AVD's pointer file relative-friendly (vm move rewrites it too).
    writeIni(f.ini, { "path": f.avd, "path.rel": `avd/${AVD_NAME}.avd`, "target": imageId(cfg).split(";")[1] ?? "" });
    say(`    AVD ${AVD_NAME} (${imageId(cfg)}) in ${f.avdHome}`);
    if (!fs.existsSync(imageDir(cfg))) say(`WARN: the system image folder ${imageDir(cfg)} is missing.`);
}

// ---------- process ----------

export function emulatorArgs(cfg, { snapshot = null } = {}) {
    const port = Number(cfg.consolePort) || CONSOLE_PORT;
    return [
        "-avd", AVD_NAME,
        "-no-window", "-gpu", "host", "-no-boot-anim",
        "-port", String(port), "-grpc", String(GRPC_PORT + (port - CONSOLE_PORT)),
        // Sound: Android keeps its audio device (scrcpy captures app audio from it), but the emulator
        // itself plays nothing on the Mac, so there's no double audio and nothing when sharing is off.
        "-audio", "none",
        ...(snapshot ? ["-snapshot", snapshot] : ["-no-snapshot-load"]),
        "-no-snapshot-save",
    ];
}

// Lock files an emulator that was killed leaves behind make the next start refuse the AVD.
function clearStaleLocks(cfg) {
    const f = files(cfg);
    let entries = [];
    try { entries = fs.readdirSync(f.avd); } catch { return; }
    for (const e of entries) if (e.endsWith(".lock")) fs.rmSync(path.join(f.avd, e), { recursive: true, force: true });
}

// ---------- power lock ----------

// mkdir is atomic: whoever creates <vmDir>/.power.lock holds it. Re-entrant within one process (stop
// inside a locked caller). A lock whose owner pid is gone is taken over.
let lockDepth = 0;
function withPowerLock(cfg, fn, waitSec = 900) {
    if (lockDepth > 0) { lockDepth++; try { return fn(); } finally { lockDepth--; } }
    const d = vmDir(cfg);
    const lock = path.join(d, ".power.lock");
    const owner = path.join(lock, "pid");
    fs.mkdirSync(d, { recursive: true });
    const end = Date.now() + waitSec * 1000;
    for (;;) {
        try { fs.mkdirSync(lock); fs.writeFileSync(owner, String(process.pid)); break; }
        catch (e) {
            if (e.code !== "EEXIST") throw e;
            let holder = 0;
            try { holder = Number(fs.readFileSync(owner, "utf8").trim()); } catch {}
            let alive = false;
            if (holder) { try { process.kill(holder, 0); alive = true; } catch (k) { alive = k.code === "EPERM"; } }
            // no pid file yet: give its creator a moment, then treat it as abandoned
            const age = (() => { try { return Date.now() - fs.statSync(lock).mtimeMs; } catch { return 0; } })();
            if ((holder && !alive) || (!holder && age > 10000)) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
            if (Date.now() > end) throw new Error(`Another ${CLI} command (pid ${holder || "?"}) is starting, stopping or saving Android. Try again when it's done.`);
            sleep(0.5);
        }
    }
    lockDepth = 1;
    try { return fn(); }
    finally { lockDepth = 0; fs.rmSync(lock, { recursive: true, force: true }); }
}

// ---------- identity / ports ----------

// Ports already listening on this Mac (another emulator, or anything else). Sync: a tiny node child.
function busyPorts(ports) {
    const code = `const net=require("net");let left=process.argv.length-1;const busy=[];if(!left)process.exit(0);
for(const p of process.argv.slice(1)){const s=net.connect({host:"127.0.0.1",port:Number(p)});const done=b=>{if(b)busy.push(p);s.destroy();if(--left===0){console.log(busy.join(" "));process.exit(0);}};
s.setTimeout(1500);s.on("connect",()=>done(true));s.on("error",()=>done(false));s.on("timeout",()=>done(false));}`;
    const r = spawnSync(process.execPath, ["-e", code, ...ports.map(String)], { encoding: "utf8", timeout: 10000 });
    return (r.stdout ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
}
function portOwner(port) {
    const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fc"], { encoding: "utf8", timeout: 10000 });
    return (r.stdout ?? "").split("\n").find(l => l.startsWith("c"))?.slice(1) ?? null;
}

// Whether the emulator answering as emulator-<port> is our AVD (`emu avd name`). Cached per process once
// confirmed. null: its console didn't answer (can't tell).
let oursConfirmed = null;
export function isOurs(cfg) {
    const ser = A.serial(cfg);
    if (oursConfirmed === ser) return true;
    const name = A.avdName(cfg);
    if (name === null) return null;
    if (name === AVD_NAME) { oursConfirmed = ser; return true; }
    return false;
}

export function start(cfg, { cold = false } = {}) {
    return withPowerLock(cfg, () => {
        const f = files(cfg);
        if (isRunning(cfg)) { if (isPaused(cfg)) resume(cfg); return { restoring: false, already: true }; }
        const t = tools(cfg);
        if (!t.ok.emulator) throw new Error(`The Android Emulator isn't installed (${t.emulator}). Run: ${CLI} setup`);
        if (!exists(cfg)) throw new Error(`No ${AVD_NAME} VM yet. Run: ${CLI} setup`);
        // Something else on our ports (another emulator, e.g. Android Studio's, or one of ours orphaned by a
        // moved vmDir) would answer as emulator-<port>: we'd install into it, sync its apps, power it off.
        const port = Number(cfg.consolePort) || CONSOLE_PORT;
        const grpc = GRPC_PORT + (port - CONSOLE_PORT);
        const busy = busyPorts([port, port + 1, grpc]);
        if (busy.length) {
            const who = portOwner(busy[0]);
            throw new Error(`Port ${busy.join(", ")} is already in use${who ? ` by ${who}` : ""} (another Android emulator?). ` +
                `${AVD_NAME} needs ${port} (console), ${port + 1} (adb) and ${grpc} (gRPC). Quit the other emulator, or (advanced) pick another even port: ${CLI} config consolePort <5554-5584>`);
        }
        clearStaleLocks(cfg);
        fs.rmSync(f.pausedMark, { force: true });
        dropConsumedState(cfg);   // a state an earlier start already loaded, if its cleanup never ran
        // The adb server creates ~/.android/adbkey on first start; the emulator hands that public key to
        // Android, and Google Play (user-build) images refuse an adb they weren't given the key for.
        if (t.ok.adb) spawnSync(t.adb, ["start-server"], { stdio: "ignore", timeout: 30000 });
        const notes = applyResources(cfg);
        // A changed machine shape (or a bigger disk, which needs a cold boot) can't take the saved state.
        if (notes.length && hasState(cfg)) discardState(cfg);
        if (cold && hasState(cfg)) discardState(cfg);
        const restoring = hasState(cfg);
        // Consumed from here on: whatever happens to this process, the state is never loaded again.
        const meta = readMeta(cfg);
        if (restoring) writeMeta(cfg, { ...(meta ?? {}), loadedAt: Date.now() });
        const fd = fs.openSync(f.log, "w");
        const child = spawn(t.emulator, emulatorArgs(cfg, { snapshot: restoring ? SUSPEND_SNAPSHOT : null }), {
            detached: true, stdio: ["ignore", fd, fd], env: toolEnv(cfg, { ANDROID_AVD_HOME: f.avdHome }),
        });
        child.unref();
        fs.closeSync(fd);
        fs.writeFileSync(f.port, String(port));
        fs.writeFileSync(f.pid, String(child.pid));
        oursConfirmed = null;
        // Catch an immediate failure (bad AVD, missing image) with the reason from the log.
        for (let i = 0; i < 6; i++) {
            sleep(0.5);
            if (!isRunning(cfg)) {
                const tail = (() => { try { return fs.readFileSync(f.log, "utf8").split("\n").filter(l => /ERROR|FATAL|error/i.test(l)).slice(-4).join("\n"); } catch { return ""; } })();
                fs.rmSync(f.pid, { force: true });
                fs.rmSync(f.port, { force: true });
                // It never got going: the saved state is still good for the next try.
                if (restoring) { if (meta) writeMeta(cfg, meta); else fs.rmSync(f.stateMeta, { force: true }); }
                throw new Error(`The Android Emulator exited right away.${tail ? "\n" + tail : ""}\n(log: ${f.log})`);
            }
        }
        return { restoring, notes };
    });
}

// After boot: delete the suspend snapshot the start loaded (consumed), so it can't take space or be
// mistaken for a saved state. Safe from any process: a save in progress is marked savingAt, not loadedAt,
// and the power lock keeps it from interleaving with saveState.
export function finishStart(cfg) {
    withPowerLock(cfg, () => {
        const meta = readMeta(cfg);
        if (!meta?.loadedAt) return;
        if (!fs.existsSync(path.join(files(cfg).snapshots, SUSPEND_SNAPSHOT))) { fs.rmSync(files(cfg).stateMeta, { force: true }); return; }
        if (isRunning(cfg)) discardState(cfg);   // if the console delete fails it stays consumed: stop deletes it offline
    });
}

function waitExit(cfg, seconds) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) { if (!isRunning(cfg)) return true; sleep(0.5); }
    return !isRunning(cfg);
}

// Last resort for our own emulator process (pidOf has checked it's ours): TERM, then KILL.
function killOwn(cfg) {
    let pid = pidOf(cfg);
    if (!pid) return;
    try { process.kill(pid, "SIGTERM"); } catch {}
    if (waitExit(cfg, 10)) return;
    pid = pidOf(cfg);
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    waitExit(cfg, 5);
}

export function stop(cfg, waitSec = 60) {
    return withPowerLock(cfg, () => {
        const f = files(cfg);
        let graceful = true;
        if (isRunning(cfg)) {
            // Talk over adb/console only if emulator-<port> is really our AVD; otherwise our process gets signals.
            const ours = isOurs(cfg) !== false;
            if (ours && isPaused(cfg)) resume(cfg);
            // Android's own power-off flushes app data; the emulator exits when the guest powers down.
            if (ours && A.state(cfg) === "device") A.adb(cfg, ["shell", "reboot", "-p"], { timeout: 15000 });
            if (!ours || !waitExit(cfg, waitSec)) {
                graceful = false;
                if (ours) A.emu(cfg, "kill");
                if (!ours || !waitExit(cfg, 15)) killOwn(cfg);
            }
        }
        for (const p of [f.pid, f.port, f.pausedMark]) fs.rmSync(p, { force: true });
        dropConsumedState(cfg);
        return graceful;
    });
}

// The console's `avd pause` / `avd resume` (emulator 37.3; `avd stop/start` do the same) freeze and unfreeze the vCPUs (the console and adb bridge keep
// answering). The paused marker lets the menu-bar app tell "frozen" from "off" without asking.
function consoleStatus(cfg) { const r = A.emu(cfg, "avd", "status"); return r.ok ? r.out : ""; }
export function isPaused(cfg) {
    if (!isRunning(cfg) || !fs.existsSync(files(cfg).pausedMark)) return false;
    const s = consoleStatus(cfg);
    if (/running/i.test(s)) { fs.rmSync(files(cfg).pausedMark, { force: true }); return false; }
    return true;
}
export function pause(cfg) {
    if (!isRunning(cfg)) return false;
    if (!A.emu(cfg, "avd", "pause").ok) return false;
    try { fs.writeFileSync(files(cfg).pausedMark, String(Date.now())); } catch {}
    return true;
}
export function resume(cfg) {
    if (!isRunning(cfg)) return false;
    const ok = A.emu(cfg, "avd", "resume").ok;
    if (ok) fs.rmSync(files(cfg).pausedMark, { force: true });
    return ok;
}

// ---------- free space ----------

export function freeBytes(dir) {
    let d = dir;
    while (d && !fs.existsSync(d)) d = path.dirname(d);
    try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch { return null; }
}

export function minFreeBytes(cfg, forState = true) {
    const margin = (Number.isFinite(Number(cfg.vmMinFreeGB)) ? Number(cfg.vmMinFreeGB) : 2) * GB;
    return margin + (forState ? ramGB(cfg) * GB : 0);
}

export function spaceCheck(cfg, forState = true) {
    const free = freeBytes(vmDir(cfg));
    const need = minFreeBytes(cfg, forState);
    const g = b => (b / GB).toFixed(1);
    if (free === null || free >= need) return { ok: true, free, need };
    return {
        ok: false, free, need,
        message: `Not enough free space for a ${forState ? "saved state" : "snapshot"} on the VM's disk: ${g(free)} GB free, ${g(need)} GB needed` +
            `${forState ? ` (${ramGB(cfg)} GB of RAM + ${Number(cfg.vmMinFreeGB ?? 2)} GB kept free)` : ""}. Free some space, move the VM (${CLI} vm move <folder>), or lower "vmMinFreeGB".`,
    };
}

// ---------- saved state (vm save) ----------

function readMeta(cfg) { try { return JSON.parse(fs.readFileSync(files(cfg).stateMeta, "utf8")); } catch { return null; } }
function writeMeta(cfg, m) { const p = files(cfg).stateMeta; fs.writeFileSync(p + ".tmp", JSON.stringify(m)); fs.renameSync(p + ".tmp", p); }
const suspendDir = cfg => path.join(files(cfg).snapshots, SUSPEND_SNAPSHOT);
// Already loaded once, or an unfinished save: must never be loaded (again).
const consumed = m => !!(m && (m.loadedAt || m.savingAt));

// A saved state the next start will load. (No suspend.json at all: a state saved before the metadata
// was written, e.g. the saving process was killed after the emulator exited; still good.)
export function hasState(cfg) { return fs.existsSync(suspendDir(cfg)) && !consumed(readMeta(cfg)); }

// Stopped VM only: delete a consumed suspend snapshot from disk.
function dropConsumedState(cfg) {
    if (isRunning(cfg)) return;
    const m = readMeta(cfg);
    if (!consumed(m)) return;
    if (fs.existsSync(suspendDir(cfg))) deleteSnapshotOffline(cfg, SUSPEND_SNAPSHOT);
    if (!fs.existsSync(suspendDir(cfg))) fs.rmSync(files(cfg).stateMeta, { force: true });
}

export function discardState(cfg) {
    const f = files(cfg);
    if (!fs.existsSync(suspendDir(cfg))) { fs.rmSync(f.stateMeta, { force: true }); return; }
    if (isRunning(cfg)) {
        if (isOurs(cfg) !== false) A.emu(cfg, "avd", "snapshot", "delete", SUSPEND_SNAPSHOT);
        if (fs.existsSync(suspendDir(cfg))) {
            // Couldn't delete it live: keep it marked consumed so it's never loaded; stop() deletes it offline.
            const m = readMeta(cfg) ?? {};
            if (!consumed(m)) writeMeta(cfg, { ...m, loadedAt: Date.now() });
            return;
        }
        fs.rmSync(f.stateMeta, { force: true });
        return;
    }
    deleteSnapshotOffline(cfg, SUSPEND_SNAPSHOT);
    if (!fs.existsSync(suspendDir(cfg))) fs.rmSync(f.stateMeta, { force: true });
    else writeMeta(cfg, { ...(readMeta(cfg) ?? {}), loadedAt: Date.now() });
}

function dirBytes(d) {
    const r = spawnSync("du", ["-sk", d], { encoding: "utf8" });
    return r.status === 0 ? Number(r.stdout.split(/\s/)[0]) * 1024 : 0;
}

export function saveState(cfg) {
    return withPowerLock(cfg, () => {
        if (!isRunning(cfg)) throw new Error("The VM isn't running.");
        if (isOurs(cfg) === false) throw new Error(`The emulator answering on ${A.serial(cfg)} isn't ${AVD_NAME}.`);
        const sp = spaceCheck(cfg, true);
        if (!sp.ok) throw new Error(sp.message);
        if (isPaused(cfg)) resume(cfg);
        const f = files(cfg);
        // An old (consumed) suspend snapshot from this run's restore: remove it before saving over its name.
        if (fs.existsSync(suspendDir(cfg))) {
            A.emu(cfg, "avd", "snapshot", "delete", SUSPEND_SNAPSHOT);
            if (fs.existsSync(suspendDir(cfg))) throw new Error("The emulator couldn't replace the previous saved state.");
        }
        // Marked unfinished until the emulator has exited: a save that dies half-way is never loaded.
        writeMeta(cfg, { savingAt: Date.now() });
        const r = A.emu(cfg, "avd", "snapshot", "save", SUSPEND_SNAPSHOT);
        if (!r.ok || !/\bOK\b/.test(r.out)) throw new Error(`The emulator couldn't save the machine state${r.out ? `: ${r.out.split("\n").slice(-2).join(" ")}` : ""}.`);
        A.emu(cfg, "kill");
        if (!waitExit(cfg, 30)) killOwn(cfg);
        for (const p of [f.pid, f.port, f.pausedMark]) fs.rmSync(p, { force: true });
        writeMeta(cfg, { savedAt: Date.now(), bytes: dirBytes(suspendDir(cfg)) });
        return true;
    });
}

// ---------- snapshots (emulator snapshots: RAM + disk) ----------

export function validSnapshotName(n) { return /^[A-Za-z0-9._-]{1,40}$/.test(String(n ?? "")) && !INTERNAL_SNAPSHOTS.has(String(n)); }

export function snapshotList(cfg) {
    const d = files(cfg).snapshots;
    let names = [];
    try { names = fs.readdirSync(d).filter(n => !INTERNAL_SNAPSHOTS.has(n) && fs.statSync(path.join(d, n)).isDirectory()); } catch { return []; }
    return names.map(name => {
        let date = 0;
        for (const p of [path.join(d, name, "snapshot.pb"), path.join(d, name)]) { try { date = fs.statSync(p).mtimeMs; break; } catch {} }
        return { name, date: Math.round(date) };
    }).sort((a, b) => a.date - b.date);
}

function needRunning(cfg) {
    if (!isRunning(cfg)) throw new Error(`The VM must be running for this (${CLI} vm snapshot / rewind start it for you).`);
}

export function snapshotCreate(cfg, name) {
    if (!validSnapshotName(name)) throw new Error("Snapshot names may use letters, digits, '.', '_' and '-' (up to 40 characters).");
    needRunning(cfg);
    const sp = spaceCheck(cfg, true);   // a snapshot holds the guest's RAM too
    if (!sp.ok) throw new Error(sp.message);
    if (snapshotList(cfg).some(x => x.name === name)) throw new Error(`A snapshot named "${name}" already exists.`);
    if (isPaused(cfg)) resume(cfg);
    const r = A.emu(cfg, "avd", "snapshot", "save", name);
    if (!r.ok || !/\bOK\b/.test(r.out)) throw new Error(`Couldn't take the snapshot${r.out ? `: ${r.out.split("\n").slice(-2).join(" ")}` : ""}.`);
}

export function snapshotApply(cfg, name) {
    needRunning(cfg);
    if (!snapshotList(cfg).some(x => x.name === name)) throw new Error(`There's no snapshot named "${name}".`);
    if (isPaused(cfg)) resume(cfg);
    const r = A.emu(cfg, "avd", "snapshot", "load", name);
    if (!r.ok || !/\bOK\b/.test(r.out)) throw new Error(`Couldn't rewind${r.out ? `: ${r.out.split("\n").slice(-2).join(" ")}` : ""}.`);
    // The VM is running, so any suspend snapshot was already loaded: make sure it stays consumed.
    if (fs.existsSync(suspendDir(cfg))) discardState(cfg);
    else fs.rmSync(files(cfg).stateMeta, { force: true });
}

// Stopped VM: the disk side of a snapshot lives inside the AVD's qcow2 images; remove it there too.
function deleteSnapshotOffline(cfg, name) {
    const f = files(cfg);
    const img = tools(cfg).qemuImg;
    let entries = [];
    try { entries = fs.readdirSync(f.avd).filter(e => e.endsWith(".qcow2")); } catch {}
    for (const e of entries) {
        const p = path.join(f.avd, e);
        const l = spawnSync(img, ["snapshot", "-l", p], { encoding: "utf8" });
        if (l.status === 0 && new RegExp(`\\s${name.replace(/[.]/g, "\\.")}\\s`).test(l.stdout)) spawnSync(img, ["snapshot", "-d", name, p]);
    }
    fs.rmSync(path.join(f.snapshots, name), { recursive: true, force: true });
}

export function snapshotDelete(cfg, name) {
    if (!fs.existsSync(path.join(files(cfg).snapshots, String(name)))) throw new Error(`There's no snapshot named "${name}".`);
    if (isRunning(cfg)) {
        if (isPaused(cfg)) resume(cfg);
        const r = A.emu(cfg, "avd", "snapshot", "delete", name);
        if (!r.ok) throw new Error(`Couldn't delete the snapshot${r.out ? `: ${r.out}` : ""}.`);
        if (fs.existsSync(path.join(files(cfg).snapshots, name))) fs.rmSync(path.join(files(cfg).snapshots, name), { recursive: true, force: true });
    } else deleteSnapshotOffline(cfg, name);
}

// ---------- removal ----------

export function sizeOnDisk(cfg) { return fs.existsSync(files(cfg).avdHome) ? dirBytes(files(cfg).avdHome) : 0; }

export function destroy(cfg) {
    withPowerLock(cfg, () => {
        const f = files(cfg);
        if (isRunning(cfg)) {
            if (isOurs(cfg) !== false) A.emu(cfg, "kill");
            if (!waitExit(cfg, 15)) killOwn(cfg);
        }
        fs.rmSync(f.avd, { recursive: true, force: true });
        fs.rmSync(f.ini, { force: true });
        for (const p of [f.pid, f.port, f.pausedMark, f.stateMeta, f.helperStamp, f.log]) fs.rmSync(p, { force: true });
        try { fs.rmdirSync(f.avdHome); } catch {}
    });
}
