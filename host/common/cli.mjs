// host/common/cli.mjs — generic CLI plumbing shared by dinghy (WinDinghy) and robodinghy.
// Zero dependencies (Node built-ins only). Nothing here knows about a product: callers pass their
// own names, paths and texts.
//
// Exports:
//   say(msg)                          console.log(msg)
//   stepSay(msg)                      prints "==> msg"
//   progress(pct, title)              prints exactly "PROGRESS:<Math.round(pct)>:<title>" (the Swift apps parse it)
//   makeProgress(enabled)             -> (pct, title) => progress(...) when enabled, else a no-op
//                                     (typical: makeProgress(args.includes("--progress")))
//   waitFor(fn, seconds, everyMs=3000) async poll: resolves true as soon as `await fn()` is truthy,
//                                     false after `seconds`
//   readStdinJson()                   parses JSON from stdin (fd 0); {} on empty/invalid input
//   portOpen(host, port)              async TCP probe (3 s timeout) -> boolean
//   logTail(file)                     last 40 lines of a file ("" if unreadable)
//   safeName(name)                    file-name-safe display name ("/" and ":" -> "-", whitespace collapsed)
//   hasFlag(args, flag)               args.includes(flag)
//   positional(args)                  args without "--flags" (values of flags are NOT removed)
//   optValue(args, name, def)         value after `name` in args (e.g. "--ram 4096"), else def
//   runUpdater(projectRoot)           installs <root>/update from <root>/host/dinghy-update.sh if missing,
//                                     runs it with inherited stdio and exits with its status

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function say(msg) { console.log(msg); }
export function stepSay(msg) { console.log(`==> ${msg}`); }

export function progress(pct, title) { console.log(`PROGRESS:${Math.round(pct)}:${title}`); }
export function makeProgress(enabled) { return (pct, title) => { if (enabled) progress(pct, title); }; }

export async function waitFor(fn, seconds, everyMs = 3000) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
        if (await fn()) return true;
        await new Promise(r => setTimeout(r, everyMs));
    }
    return false;
}

export function readStdinJson() {
    try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; }
}

export async function portOpen(host, port) {
    const { default: net } = await import("node:net");
    return new Promise(resolve => {
        const s = net.connect({ host, port, timeout: 3000 });
        s.on("connect", () => { s.destroy(); resolve(true); });
        s.on("error", () => resolve(false));
        s.on("timeout", () => { s.destroy(); resolve(false); });
    });
}

export function logTail(file) {
    try { return fs.readFileSync(file, "utf8").split("\n").slice(-40).join("\n"); } catch { return ""; }
}

export function safeName(name) {
    return name.replace(/[/:]/g, "-").replace(/\s+/g, " ").trim();
}

export const hasFlag = (args, flag) => args.includes(flag);
export const positional = args => args.filter(a => !String(a).startsWith("--"));
export function optValue(args, name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }

// Delegates to the repo-root `update` launcher (installed from the tracked host/dinghy-update.sh on
// first run) rather than reimplementing the git logic; see host/dinghy-update.sh for why.
export function runUpdater(projectRoot) {
    const launcher = path.join(projectRoot, "update");
    const tracked = path.join(projectRoot, "host", "dinghy-update.sh");
    if (!fs.existsSync(launcher)) {
        if (!fs.existsSync(tracked)) throw new Error("Updater script missing — this isn't a full windinghy checkout.");
        fs.copyFileSync(tracked, launcher);
        fs.chmodSync(launcher, 0o755);
    }
    const r = spawnSync(launcher, [], { stdio: "inherit" });
    process.exit(r.status ?? 1);
}
