// host/android/sdk.mjs — finding and installing the Android SDK pieces RoboDinghy needs (Google's
// emulator, platform-tools/adb, cmdline-tools, one system image), Java for sdkmanager/avdmanager,
// and scrcpy (Homebrew).
//
// We never redistribute any of it: sdkmanager downloads from Google on the user's Mac after the user
// accepts Google's SDK licence (`setup --accept-licences`).
//
// Exports:
//   sdkCandidates(cfg)          the SDK roots tried, in order (cfg.sdkRoot, $ANDROID_HOME, $ANDROID_SDK_ROOT,
//                               Homebrew's android-commandlinetools, ~/Library/Android/sdk, our own)
//   sdkRoot(cfg)                the first candidate that exists (any of emulator/, platform-tools/,
//                               cmdline-tools/ inside), else our own (may not exist yet)
//   imageId(cfg)                SDK package id of the system image (cfg.image overrides edition+apiLevel)
//   imageDir(cfg, root?)        its folder inside the SDK
//   imageInfo(cfg)              { id, dir, installed, revision, tag, api } (revision from source.properties)
//   javaHome()                  a usable JDK home or null
//   tools(cfg)                  { sdk, emulator, adb, sdkmanager, avdmanager, qemuImg, apksigner, java,
//                                 scrcpy, scrcpyServer, ok:{emulator, adb, sdkmanager, scrcpy, image} }
//   toolEnv(cfg, extra?)        process env for SDK tools (ANDROID_HOME/ANDROID_SDK_ROOT, JAVA_HOME,
//                               ANDROID_AVD_HOME when given in extra)
//   missingPackages(cfg)        SDK package ids still needed ("emulator", "platform-tools", image)
//   licenceText(pkgs)           the "LICENCE: ..." line printed when --accept-licences is missing
//   ensureSdk(cfg, { acceptLicences, progress, say })  async: bootstraps cmdline-tools if there's no
//                               sdkmanager, accepts licences, installs missing packages; throws on failure
//   ensureJava({ say })         installs Homebrew openjdk if no JDK is found; returns the JDK home
//   ensureScrcpy({ say })       installs Homebrew scrcpy if missing; returns tools().scrcpy
//   emulatorVersion(t), adbVersion(t), scrcpyVersion(t)  version strings or null

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { OWN_SDK_DIR, DEFAULT_API } from "./product.mjs";

const exists = p => { try { return !!p && fs.existsSync(p); } catch { return false; } };
const firstExisting = list => list.filter(Boolean).find(exists) ?? null;

export function sdkCandidates(cfg) {
    return [
        cfg.sdkRoot,
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        "/opt/homebrew/share/android-commandlinetools",
        "/usr/local/share/android-commandlinetools",
        path.join(os.homedir(), "Library", "Android", "sdk"),
        OWN_SDK_DIR,
    ].filter(Boolean);
}

export function sdkRoot(cfg) {
    for (const c of sdkCandidates(cfg)) {
        if (["emulator", "platform-tools", "cmdline-tools"].some(d => exists(path.join(c, d)))) return c;
    }
    return cfg.sdkRoot || OWN_SDK_DIR;
}

export function imageId(cfg) {
    if (cfg.image) return cfg.image;
    const tag = cfg.edition === "aosp" ? "default" : "google_apis_playstore";
    return `system-images;android-${cfg.apiLevel || DEFAULT_API};${tag};arm64-v8a`;
}

export function imageDir(cfg, root = sdkRoot(cfg)) {
    return path.join(root, ...imageId(cfg).split(";"));
}

function readProps(file) {
    const out = {};
    try {
        for (const l of fs.readFileSync(file, "utf8").split("\n")) {
            const m = l.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
            if (m) out[m[1]] = m[2];
        }
    } catch {}
    return out;
}

export function imageInfo(cfg) {
    const id = imageId(cfg);
    const dir = imageDir(cfg);
    const p = readProps(path.join(dir, "source.properties"));
    const parts = id.split(";");
    return {
        id, dir,
        installed: exists(path.join(dir, "system.img")),
        revision: p["Pkg.Revision"] ?? null,
        tag: p["SystemImage.TagId"] ?? parts[2] ?? null,
        api: p["AndroidVersion.ApiLevel"] ?? (parts[1] ?? "").replace(/^android-/, ""),
    };
}

export function javaHome() {
    const cands = [
        process.env.JAVA_HOME,
        "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
        "/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
    ];
    for (const c of cands) if (exists(c && path.join(c, "bin", "java"))) return c;
    const r = spawnSync("/usr/libexec/java_home", [], { encoding: "utf8" });
    if (r.status === 0 && exists(path.join(r.stdout.trim(), "bin", "java"))) return r.stdout.trim();
    return null;
}

function which(cmd) {
    const r = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function cmdlineTool(sdk, name) {
    const base = path.join(sdk, "cmdline-tools");
    const dirs = ["latest"];
    try { dirs.push(...fs.readdirSync(base).filter(d => d !== "latest").sort().reverse()); } catch {}
    return firstExisting(dirs.map(d => path.join(base, d, "bin", name)));
}

function findScrcpy() {
    // ROBODINGHY_SCRCPY pins a specific scrcpy build (and, pointed at nothing, simulates a missing one).
    const pinned = process.env.ROBODINGHY_SCRCPY;
    const bin = pinned ? firstExisting([pinned]) : firstExisting(["/opt/homebrew/bin/scrcpy", "/usr/local/bin/scrcpy", which("scrcpy")]);
    if (!bin) return { scrcpy: null, scrcpyServer: null };
    let real = bin;
    try { real = fs.realpathSync(bin); } catch {}
    const server = firstExisting([
        process.env.SCRCPY_SERVER_PATH,
        path.resolve(path.dirname(real), "..", "share", "scrcpy", "scrcpy-server"),
        path.resolve(path.dirname(bin), "..", "share", "scrcpy", "scrcpy-server"),
        "/opt/homebrew/share/scrcpy/scrcpy-server",
        "/usr/local/share/scrcpy/scrcpy-server",
    ]);
    return { scrcpy: real, scrcpyServer: server };
}

export function tools(cfg) {
    const sdk = sdkRoot(cfg);
    const t = {
        sdk,
        emulator: path.join(sdk, "emulator", "emulator"),
        adb: path.join(sdk, "platform-tools", "adb"),
        qemuImg: path.join(sdk, "emulator", "qemu-img"),
        sdkmanager: cmdlineTool(sdk, "sdkmanager") ?? firstExisting(["/opt/homebrew/bin/sdkmanager"]),
        avdmanager: cmdlineTool(sdk, "avdmanager") ?? firstExisting(["/opt/homebrew/bin/avdmanager"]),
        apksigner: null,
        java: javaHome(),
        ...findScrcpy(),
    };
    try {
        const bt = fs.readdirSync(path.join(sdk, "build-tools")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        t.apksigner = firstExisting(bt.map(v => path.join(sdk, "build-tools", v, "apksigner")));
    } catch {}
    t.ok = {
        emulator: exists(t.emulator),
        adb: exists(t.adb),
        sdkmanager: !!t.sdkmanager,
        scrcpy: !!t.scrcpy && !!t.scrcpyServer,
        image: imageInfo(cfg).installed,
    };
    return t;
}

export function toolEnv(cfg, extra = {}) {
    const sdk = sdkRoot(cfg);
    const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ...extra };
    const jh = javaHome();
    if (jh) { env.JAVA_HOME = jh; env.PATH = `${path.join(jh, "bin")}:${env.PATH ?? "/usr/bin:/bin"}`; }
    return env;
}

export function missingPackages(cfg) {
    const t = tools(cfg);
    const need = [];
    if (!t.ok.emulator) need.push("emulator");
    if (!t.ok.adb) need.push("platform-tools");
    if (!t.ok.image) need.push(imageId(cfg));
    return need;
}

export function licenceText(pkgs) {
    return `LICENCE: Installing ${pkgs.join(", ")} from Google needs you to accept the Android SDK License Agreement (https://developer.android.com/studio/terms). Re-run with --accept-licences to accept it.`;
}

export async function ensureJava({ say = console.log } = {}) {
    let jh = javaHome();
    if (jh) return jh;
    say("    Installing Java (Homebrew openjdk, needed by Google's sdkmanager)...");
    const r = spawnSync("brew", ["install", "openjdk"], { stdio: ["ignore", "inherit", "inherit"] });
    jh = javaHome();
    if (r.status !== 0 || !jh) throw new Error("Couldn't install Java. Install Homebrew (https://brew.sh) and run: brew install openjdk");
    return jh;
}

export async function ensureScrcpy({ say = console.log } = {}) {
    let s = findScrcpy();
    if (s.scrcpy && s.scrcpyServer) return s.scrcpy;
    say("    Installing scrcpy with Homebrew (one time)...");
    const r = spawnSync("brew", ["install", "scrcpy"], { stdio: ["ignore", "inherit", "inherit"] });
    s = findScrcpy();
    if (r.status !== 0 || !s.scrcpy) throw new Error("Couldn't install scrcpy. Install Homebrew (https://brew.sh) and run: brew install scrcpy");
    return s.scrcpy;
}

// No SDK at all: download Google's cmdline-tools (checksum from Google's repository manifest) into our own SDK.
async function bootstrapCmdlineTools(root, { say, progress }) {
    say("    Downloading Google's Android SDK command-line tools...");
    const base = "https://dl.google.com/android/repository/";
    const xml = await (await fetch(base + "repository2-3.xml", { signal: AbortSignal.timeout(60000) })).text();
    const block = xml.split("<remotePackage").find(b => /path="cmdline-tools;latest"/.test(b));
    if (!block) throw new Error("Couldn't find the command-line tools in Google's SDK repository.");
    const arch = os.arch() === "arm64" ? "aarch64" : "x64";
    const archive = block.split("<archive>").find(a => /<host-os>macosx<\/host-os>/.test(a) && (!/<host-arch>/.test(a) || a.includes(`<host-arch>${arch}</host-arch>`)));
    const url = archive?.match(/<url>([^<]+)<\/url>/)?.[1];
    const sha1 = archive?.match(/<checksum type="sha1">([0-9a-f]+)<\/checksum>/)?.[1];
    if (!url || !sha1) throw new Error("Couldn't find a macOS command-line tools download in Google's SDK repository.");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "robodinghy-sdk-"));
    try {
        const zip = path.join(tmp, "cmdline-tools.zip");
        await downloadFile(base + url, zip, { onPct: p => progress?.(p) });
        const got = crypto.createHash("sha1").update(fs.readFileSync(zip)).digest("hex");
        if (got !== sha1) throw new Error(`The command-line tools download is corrupt (sha1 ${got}, expected ${sha1}).`);
        const out = path.join(tmp, "x");
        fs.mkdirSync(out);
        if (spawnSync("ditto", ["-x", "-k", zip, out]).status !== 0) throw new Error("Couldn't unpack the command-line tools.");
        const dest = path.join(root, "cmdline-tools", "latest");
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(path.join(out, "cmdline-tools"), dest);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Streams a URL to a file; onPct(0..100) when the size is known.
export async function downloadFile(url, dest, { onPct, timeoutMs = 3600000 } = {}) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Download failed (${res.status}) ${url}`);
    const total = Number(res.headers.get("content-length")) || 0;
    const fd = fs.openSync(dest + ".part", "w");
    let got = 0, last = -1;
    try {
        for await (const chunk of res.body) {
            fs.writeSync(fd, chunk);
            got += chunk.length;
            if (total && onPct) { const p = Math.floor(got * 100 / total); if (p !== last) { last = p; onPct(p); } }
        }
    } finally { fs.closeSync(fd); }
    fs.renameSync(dest + ".part", dest);
    return got;
}

// Runs sdkmanager with "y" answers, reporting "NN%" progress; resolves { status, out }.
function runSdkmanager(cfg, sdkmanager, args, onPct) {
    return new Promise(resolve => {
        const sdk = sdkRoot(cfg);
        const child = spawn(sdkmanager, [`--sdk_root=${sdk}`, ...args], { env: toolEnv(cfg), stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        const onData = d => {
            const s = d.toString();
            out += s;
            for (const m of s.matchAll(/(\d{1,3})%/g)) onPct?.(Number(m[1]));
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        // Licence prompts ("Accept? (y/N)") — only reached when the caller passed --accept-licences.
        const yes = setInterval(() => { try { child.stdin.write("y\n"); } catch {} }, 500);
        child.on("close", status => { clearInterval(yes); resolve({ status, out }); });
        child.on("error", e => { clearInterval(yes); resolve({ status: 1, out: String(e.message) }); });
    });
}

export async function ensureSdk(cfg, { acceptLicences = false, progress = () => {}, say = console.log } = {}) {
    const need = missingPackages(cfg);
    if (!need.length) return tools(cfg);
    if (!acceptLicences) {
        console.log(licenceText(need));
        const e = new Error("Google's Android SDK licence hasn't been accepted (setup --accept-licences).");
        e.licence = true;
        throw e;
    }
    await ensureJava({ say });
    let t = tools(cfg);
    if (!t.sdkmanager) {
        // No usable SDK: make our own, starting from Google's command-line tools.
        cfg.sdkRoot = cfg.sdkRoot || OWN_SDK_DIR;
        fs.mkdirSync(cfg.sdkRoot, { recursive: true });
        await bootstrapCmdlineTools(cfg.sdkRoot, { say, progress: p => progress(5 + p * 0.1) });
        t = tools(cfg);
        if (!t.sdkmanager) throw new Error("The command-line tools didn't install correctly.");
    }
    say("    Accepting Google's Android SDK licences (you agreed with --accept-licences)...");
    await runSdkmanager(cfg, t.sdkmanager, ["--licenses"]);
    say(`    Installing ${need.join(", ")} (a few GB, from Google)...`);
    const r = await runSdkmanager(cfg, t.sdkmanager, ["--install", ...need], pct => progress(pct));
    const left = missingPackages(cfg);
    if (r.status !== 0 || left.length) {
        const tail = r.out.split(/[\r\n]+/).filter(l => l.trim() && !/^\[?=*\s*\]?\s*\d+%/.test(l.trim())).slice(-6).join("\n");
        throw new Error(`sdkmanager couldn't install ${left.join(", ") || need.join(", ")}:\n${tail}`);
    }
    return tools(cfg);
}

const firstLine = s => (s ?? "").split("\n")[0];
export function emulatorVersion(t) {
    if (!exists(t.emulator)) return null;
    const r = spawnSync(t.emulator, ["-version"], { encoding: "utf8", timeout: 20000 });
    return (r.stdout ?? "").match(/version (\d+\.\d+\.\d+)/)?.[1] ?? null;
}
export function adbVersion(t) {
    if (!exists(t.adb)) return null;
    const r = spawnSync(t.adb, ["version"], { encoding: "utf8", timeout: 20000 });
    return (r.stdout ?? "").match(/^Version (\S+)/m)?.[1] ?? firstLine(r.stdout).match(/version (\S+)/)?.[1] ?? null;
}
export function scrcpyVersion(t) {
    if (!t.scrcpy) return null;
    const r = spawnSync(t.scrcpy, ["--version"], { encoding: "utf8", timeout: 20000 });
    return (r.stdout ?? "").match(/^scrcpy (\S+)/)?.[1] ?? null;
}
