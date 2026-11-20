#!/usr/bin/env node
// Minimal QEMU guest-agent client over a unix socket (used by guest.mjs for the managed
// QEMU VM). One call per process so guest.mjs can use it synchronously:
//
//   qga.mjs <socket> ping
//   qga.mjs <socket> ips                         -> one IPv4 per line
//   qga.mjs <socket> exec <timeoutSec> <path> [args...]   (stdin = optional input)
//         -> prints JSON {exitcode, stdout, stderr}
//   qga.mjs <socket> pull <guestPath>            -> file bytes on stdout
//   qga.mjs <socket> push <guestPath>            (stdin = file bytes)
//
// Exit code 0 = the call worked; 2 = the agent didn't answer; 1 = other error.

import net from "node:net";
import fs from "node:fs";

const [sock, cmd, ...args] = process.argv.slice(2);

function connect(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const s = net.connect(sock);
        const t = setTimeout(() => { s.destroy(); reject(new Error("agent connect timeout")); }, timeoutMs);
        s.once("connect", () => { clearTimeout(t); resolve(s); });
        s.once("error", e => { clearTimeout(t); reject(e); });
    });
}

class Agent {
    constructor(s) { this.s = s; this.buf = ""; this.waiters = []; s.on("data", d => this.onData(d)); }
    onData(d) {
        this.buf += d.toString("utf8");
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (!line) continue;
            try { const w = this.waiters.shift(); if (w) w(JSON.parse(line)); } catch {}
        }
    }
    call(execute, argumentsObj, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`agent call ${execute} timed out`)), timeoutMs);
            this.waiters.push(r => { clearTimeout(t); r.error ? reject(new Error(r.error.desc ?? "agent error")) : resolve(r.return); });
            this.s.write(JSON.stringify({ execute, arguments: argumentsObj }) + "\n");
        });
    }
    // The agent may hold stale bytes from a previous client: guest-sync flushes them.
    async sync() {
        const id = Math.floor(Math.random() * 2 ** 30);
        this.s.write("\xff"); // invalidates a partial command, per the qga protocol
        const r = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("agent didn't answer guest-sync")), 4000);
            const loop = obj => { if (obj.return === id) { clearTimeout(t); resolve(obj.return); } else this.waiters.push(loop); };
            this.waiters.push(loop);
            this.s.write(JSON.stringify({ execute: "guest-sync", arguments: { id } }) + "\n");
        });
        return r;
    }
}

function readStdin() {
    try { return fs.readFileSync(0); } catch { return Buffer.alloc(0); }
}

// QMP (the QEMU monitor): greeting, qmp_capabilities, then one command.
async function qmpCall(execute, argsJson) {
    const s = await connect();
    let buf = "";
    const next = () => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("qmp timeout")), 15000);
        const tryRead = () => {
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                if (!line) continue;
                const o = JSON.parse(line);
                if (o.event) continue; // asynchronous events are not replies
                clearTimeout(t); resolve(o); return;
            }
        };
        s.on("data", d => { buf += d.toString("utf8"); tryRead(); });
        tryRead();
    });
    s.write(""); // greeting arrives unprompted
    await next();
    s.write(JSON.stringify({ execute: "qmp_capabilities" }) + "\n");
    await next();
    s.write(JSON.stringify({ execute, arguments: JSON.parse(argsJson || "{}") }) + "\n");
    const r = await next();
    s.end();
    if (r.error) { console.error(r.error.desc); process.exit(1); }
    console.log(JSON.stringify(r.return ?? {}));
}

try {
    if (cmd === "qmp") { await qmpCall(args[0], args[1]); process.exit(0); }
    const agent = new Agent(await connect());
    try { await agent.sync(); } catch { process.exit(2); }
    if (cmd === "ping") {
        process.exit(0);
    } else if (cmd === "ips") {
        const ifs = await agent.call("guest-network-get-interfaces", {});
        for (const i of ifs) for (const a of i["ip-addresses"] ?? [])
            if (a["ip-address-type"] === "ipv4" && !a["ip-address"].startsWith("127.") && !a["ip-address"].startsWith("169.254.")) console.log(a["ip-address"]);
    } else if (cmd === "exec") {
        const [timeoutSec, path, ...rest] = args;
        const input = readStdin();
        const a = { path, arg: rest, "capture-output": true };
        if (input.length) a["input-data"] = input.toString("base64");
        const { pid } = await agent.call("guest-exec", a);
        const deadline = Date.now() + Number(timeoutSec) * 1000;
        for (;;) {
            const st = await agent.call("guest-exec-status", { pid });
            if (st.exited) {
                console.log(JSON.stringify({
                    exitcode: st.exitcode ?? 0,
                    stdout: st["out-data"] ? Buffer.from(st["out-data"], "base64").toString("utf8") : "",
                    stderr: st["err-data"] ? Buffer.from(st["err-data"], "base64").toString("utf8") : "",
                }));
                break;
            }
            if (Date.now() > deadline) { console.error("timed out"); process.exit(1); }
            await new Promise(r => setTimeout(r, 400));
        }
    } else if (cmd === "pull") {
        const h = await agent.call("guest-file-open", { path: args[0], mode: "rb" });
        const chunks = [];
        for (;;) {
            const r = await agent.call("guest-file-read", { handle: h, count: 1 << 20 });
            chunks.push(Buffer.from(r["buf-b64"], "base64"));
            if (r.eof) break;
        }
        await agent.call("guest-file-close", { handle: h });
        process.stdout.write(Buffer.concat(chunks));
    } else if (cmd === "push") {
        const data = readStdin();
        const h = await agent.call("guest-file-open", { path: args[0], mode: "wb" });
        for (let o = 0; o < data.length; o += 1 << 18)
            await agent.call("guest-file-write", { handle: h, "buf-b64": data.subarray(o, o + (1 << 18)).toString("base64") });
        await agent.call("guest-file-close", { handle: h });
    } else {
        console.error(`unknown command ${cmd}`);
        process.exit(1);
    }
    process.exit(0);
} catch (e) {
    console.error(e.message);
    process.exit(e.code === "ENOENT" || e.code === "ECONNREFUSED" || /connect timeout/.test(e.message) ? 2 : 1);
}
