// Guest transport: talk to the Windows VM without RDP, through UTM's guest agent
// (utmctl exec / file / ip-address). The agent (qemu-ga, from "UTM Guest Tools")
// runs as SYSTEM inside Windows, so this is how WinDinghy sets the guest up and
// repairs it hands-free. Set DINGHY_UTMCTL to point at a different utmctl (tests).

import fs from "node:fs";
import { spawnSync } from "node:child_process";

export const UTMCTL = process.env.DINGHY_UTMCTL || "/Applications/UTM.app/Contents/MacOS/utmctl";

function utm(args, { input, timeout = 60000 } = {}) {
    const r = spawnSync(UTMCTL, args, { input: typeof input === "string" ? Buffer.from(input) : input, encoding: "buffer", timeout });
    return {
        status: r.status ?? (r.error ? -1 : 0),
        stdout: r.stdout ?? Buffer.alloc(0),
        stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
        timedOut: r.error?.code === "ETIMEDOUT",
    };
}

export function utmInstalled() {
    return fs.existsSync(UTMCTL);
}

// [{ uuid, status, name }]
export function listVms() {
    const r = utm(["list"], { timeout: 20000 });
    if (r.status !== 0) return [];
    return r.stdout.toString("utf8").split("\n").slice(1).map(l => l.match(/^([0-9A-F-]{36})\s+(\S+)\s+(.+?)\s*$/i)).filter(Boolean)
        .map(m => ({ uuid: m[1], status: m[2], name: m[3] }));
}

export function vmStatus(name) {
    const r = utm(["status", name], { timeout: 20000 });
    return r.status === 0 ? r.stdout.toString("utf8").trim() : null;
}

export function startVm(name) {
    // utmctl can block on automation prompts: never wait long on it.
    return utm(["start", name], { timeout: 30000 }).status === 0;
}

export function stopVm(name) {
    return utm(["stop", name], { timeout: 30000 }).status === 0;
}

// True once the guest agent answers (UTM Guest Tools installed and running).
export function agentUp(name) {
    return utm(["ip-address", name], { timeout: 15000 }).status === 0;
}

export function guestIps(name) {
    const r = utm(["ip-address", name], { timeout: 15000 });
    if (r.status !== 0) return [];
    return r.stdout.toString("utf8").split("\n").map(s => s.trim()).filter(s => /^\d+\.\d+\.\d+\.\d+$/.test(s) && !s.startsWith("169.254."));
}

// Run a program in the guest (as SYSTEM). Returns { status } (the program's exit code).
export function exec(name, argv, { env = {}, input, timeout = 300000 } = {}) {
    const args = ["exec", name];
    if (input != null) args.push("--input");
    for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
    args.push("--cmd", ...argv);
    const r = utm(args, { input, timeout });
    return { status: r.status, stderr: r.stderr, timedOut: r.timedOut };
}

export function pull(name, guestPath) {
    const r = utm(["file", "pull", name, guestPath], { timeout: 30000 });
    return r.status === 0 ? r.stdout : null;
}

export function push(name, guestPath, buf) {
    return utm(["file", "push", name, guestPath], { input: buf, timeout: 120000 }).status === 0;
}

const OUT = "C:\\Windows\\Temp\\dinghy-out.txt";

// Run a PowerShell script in the guest. Output is captured by redirecting it to a
// file and pulling that back (exec only returns the exit code).
export function ps(name, script, { env = {}, timeout = 300000, secret = false } = {}) {
    const wrapped = `$ErrorActionPreference='Continue'; & { ${script} } *>&1 | Out-String | Set-Content -Encoding UTF8 -Path '${OUT}'`;
    // secret: send the script on stdin so it never appears in a process list on the Mac.
    const r = secret
        ? exec(name, ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"], { env, timeout, input: wrapped + "\n" })
        : exec(name, ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(wrapped, "utf16le").toString("base64")], { env, timeout });
    const out = pull(name, OUT);
    return { status: r.status, output: out ? out.toString("utf8").replace(/^\uFEFF/, "").trim() : "", timedOut: r.timedOut };
}
