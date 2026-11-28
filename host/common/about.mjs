// host/common/about.mjs — `about [--json]`: installed component versions vs the tested ones.
//
// Row model (what `about --json` prints, one JSON array on one line; the Swift apps parse
// name/have/tested/ok):  { name, have, tested, ok, extra? }
//
// Exports:
//   loadCompat(dir)                   JSON of <dir>/compat.json, {} if missing/invalid (pass the entry
//                                     script's own directory, not this module's)
//   capture(cmd, args)                trimmed stdout of a command, "" if it can't run
//   versionOf(cmds, re=/version (\S+)/)  first match group of `re` in `<cmd> --version` output, trying
//                                     each command (string or [cmd, ...args]) in turn; null if none
//   aboutRow(name, have, tested, { ok, extra }?)  a row; ok defaults to have === tested
//   printAbout(rows, { json, header, footer })  --json: the rows array; else the header, one padded
//                                     line per row, then the footer

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { say } from "./cli.mjs";

export function loadCompat(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, "compat.json"), "utf8")); } catch { return {}; }
}

export function capture(cmd, args) {
    try { return spawnSync(cmd, args, { encoding: "utf8" }).stdout.trim(); } catch { return ""; }
}

export function versionOf(cmds, re = /version (\S+)/) {
    for (const c of cmds) {
        const [cmd, ...args] = Array.isArray(c) ? c : [c, "--version"];
        const m = capture(cmd, args).match(re);
        if (m) return m[1];
    }
    return null;
}

export function aboutRow(name, have, tested, { ok, extra } = {}) {
    const row = { name, have, tested, ok: ok ?? have === tested };
    if (extra !== undefined) row.extra = extra;
    return row;
}

export function printAbout(rows, { json, header, footer }) {
    if (json) { console.log(JSON.stringify(rows)); return; }
    if (header !== undefined) say(header);
    for (const x of rows) say(`${x.name.padEnd(30)} ${String(x.have).padEnd(14)} tested: ${x.tested}${x.have && !x.ok ? "   (differs from the tested version)" : ""}${x.extra ? "   " + x.extra : ""}`);
    if (footer !== undefined) say(footer);
}
