// host/android/fdroid.mjs — software for the AOSP edition from the official F-Droid repository, installed
// over adb (the F-Droid client app inside Android works too; this is what `pkg` and the menu-bar app's
// Software screen use).
//
// Index: https://f-droid.org/repo/entry.jar, a JAR signed with F-Droid's repo key, carries entry.json,
// which names the current index-v2.json and its SHA-256. The JAR signature is verified against the pinned
// repo certificate (FDROID_REPO_CERT_SHA256) like the F-Droid client does, so the index and every APK
// hash in it are authenticated by F-Droid's key, not only by TLS. We
// download the index (~75 MB) only when that hash changes, verify it, and keep a slim cache
// (<configDir>/fdroid/index.json: name, summary and the newest stable arm64-compatible versions per
// package). Every APK download is checked against the index's SHA-256 before `adb install`.
//
// Exports:
//   loadIndex(cacheDir, { refresh, maxAgeH=24, say })  async: { timestamp, packages: { id: {n, s, v:[...]} } }
//   bestVersion(pkg, sdk)            newest stable version for that API level: { code, name, file, sha256, size, minSdk }
//   search(index, q, limit=50)       [{ id, name, summary, version }] (ranked: id/name matches first)
//   download(cacheDir, ver, { onPct }) async: verified local APK path
//   verifyApkSigner(apk, sha256)     SHA-256 of the APK's signing certificate (APK Signature Scheme v2/v3
//                                    block, no Java needed) === sha256; { ok, got }
//   apkSignerDigests(apk)            [hex sha256 of each signer certificate]
//   verifySignedJar(buf, certSha256, entryName)  the bytes of entryName from a v1-signed JAR whose signer
//                                    certificate has that SHA-256 (signature, .SF and manifest digests all
//                                    checked); throws otherwise

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { downloadFile } from "./sdk.mjs";
import zlib from "node:zlib";
import { FDROID_REPO, FDROID_REPO_CERT_SHA256 } from "./product.mjs";

const loc = v => (v && typeof v === "object" ? (v["en-US"] ?? v.en ?? Object.values(v)[0]) : v) ?? "";

function slim(index) {
    const out = {};
    for (const [id, p] of Object.entries(index.packages ?? {})) {
        const vers = [];
        for (const v of Object.values(p.versions ?? {})) {
            const m = v.manifest ?? {};
            const nc = m.nativecode ?? [];
            if (nc.length && !nc.includes("arm64-v8a")) continue;
            if (Array.isArray(v.releaseChannels) && v.releaseChannels.length) continue;   // betas
            vers.push([m.versionCode ?? 0, m.versionName ?? "", v.file?.name ?? "", v.file?.sha256 ?? "", v.file?.size ?? 0, m.usesSdk?.minSdkVersion ?? 1]);
        }
        if (!vers.length) continue;
        vers.sort((a, b) => b[0] - a[0]);
        // d: the start of the description, searched but not shown ("firefox" finds Fennec)
        out[id] = { n: loc(p.metadata?.name) || id, s: loc(p.metadata?.summary), d: String(loc(p.metadata?.description)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 240).toLowerCase(), v: vers.slice(0, 4) };
    }
    return out;
}

export async function loadIndex(cacheDir, { refresh = false, maxAgeH = 24, say = () => {} } = {}) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, "index.json");
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}
    const fresh = cached?.format === 2 && Date.now() - (cached.checked ?? 0) < maxAgeH * 3600e3;
    if (cached && fresh && !refresh) return cached;
    let entry;
    try {
        const res = await fetch(`${FDROID_REPO}/entry.jar`, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const jar = Buffer.from(await res.arrayBuffer());
        let json;
        try { json = verifySignedJar(jar, FDROID_REPO_CERT_SHA256, "entry.json"); }
        catch (e) { throw Object.assign(new Error(`F-Droid's app list isn't signed by F-Droid's repository key (${e.message}); not trusting it`), { untrusted: true }); }
        entry = JSON.parse(json.toString("utf8"));
        if (!/^[0-9a-f]{64}$/.test(entry.index?.sha256 ?? "") || !String(entry.index?.name ?? "").startsWith("/")) throw Object.assign(new Error("F-Droid's signed app list has an unexpected format"), { untrusted: true });
    } catch (e) {
        if (e.untrusted) throw new Error(`${e.message}.`);
        if (cached) { say(`WARN: couldn't check F-Droid for updates (${e.message}); using the list from ${new Date(cached.checked).toLocaleString()}.`); return cached; }
        throw new Error(`Couldn't reach F-Droid (${e.message}).`);
    }
    if (cached && cached.sha256 === entry.index?.sha256 && cached.format === 2) {
        cached.checked = Date.now();
        fs.writeFileSync(cacheFile, JSON.stringify(cached));
        return cached;
    }
    say(`Downloading the F-Droid app list (${((entry.index?.size ?? 0) / 1e6).toFixed(0)} MB, once a day at most)...`);
    const tmp = path.join(cacheDir, "index-v2.json");
    await downloadFile(`${FDROID_REPO}${entry.index.name}`, tmp, { timeoutMs: 600000 });
    const buf = fs.readFileSync(tmp);
    fs.rmSync(tmp, { force: true });
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got !== entry.index.sha256) throw new Error("The F-Droid app list failed its checksum; try again later.");
    const out = { format: 2, sha256: got, timestamp: entry.timestamp, checked: Date.now(), packages: slim(JSON.parse(buf.toString("utf8"))) };
    fs.writeFileSync(cacheFile + ".tmp", JSON.stringify(out));
    fs.renameSync(cacheFile + ".tmp", cacheFile);
    return out;
}

export function bestVersion(pkg, sdk = 99) {
    const v = (pkg?.v ?? []).find(x => (x[5] ?? 1) <= sdk);
    return v ? { code: v[0], name: v[1], file: v[2], sha256: v[3], size: v[4], minSdk: v[5] } : null;
}

export function search(index, q, limit = 50) {
    const needle = String(q).toLowerCase().trim();
    const words = needle.split(/\s+/).filter(Boolean);
    const hits = [];
    for (const [id, p] of Object.entries(index.packages)) {
        const hay = `${id} ${p.n} ${p.s} ${p.d ?? ""}`.toLowerCase();
        if (!words.every(w => hay.includes(w) || hay.replace(/[^a-z0-9 ]+/g, "").includes(w))) continue;
        // rank on names with punctuation removed too, so "fdroid" finds "F-Droid" first
        const flat = t => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
        const name = p.n.toLowerCase(), fname = flat(p.n), fneedle = flat(needle);
        const score = (id.toLowerCase() === needle || name === needle || (fneedle && fname === fneedle) ? 0
            : name.startsWith(needle) || (fneedle && fname.startsWith(fneedle)) ? 1
            : name.includes(needle) || (fneedle && fname.includes(fneedle)) ? 2
            : id.toLowerCase().includes(needle) ? 3 : String(p.s).toLowerCase().includes(needle) ? 4 : 5);
        hits.push({ score, id, name: p.n, summary: p.s, version: bestVersion(p)?.name ?? "" });
    }
    hits.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    return hits.slice(0, limit).map(({ score, ...h }) => h);
}

export async function download(cacheDir, ver, { onPct } = {}) {
    const dir = path.join(cacheDir, "apks");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(ver.file));
    const ok = f => { try { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") === ver.sha256; } catch { return false; } };
    if (fs.existsSync(dest) && ok(dest)) return dest;
    await downloadFile(`${FDROID_REPO}${ver.file.startsWith("/") ? "" : "/"}${ver.file}`, dest, { onPct, timeoutMs: 1800000 });
    if (!ok(dest)) { fs.rmSync(dest, { force: true }); throw new Error(`The download of ${path.basename(ver.file)} failed its checksum (not installed).`); }
    return dest;
}

// ---------- APK signer (APK Signature Scheme v2 / v3 block) ----------

function lenPrefixed(buf, off) {   // uint32 length + bytes
    const n = buf.readUInt32LE(off);
    return { data: buf.subarray(off + 4, off + 4 + n), next: off + 4 + n };
}
function seq(buf) {                // a sequence of length-prefixed items
    const items = [];
    for (let off = 0; off + 4 <= buf.length;) { const { data, next } = lenPrefixed(buf, off); items.push(data); off = next; }
    return items;
}

export function apkSignerDigests(apk) {
    const b = fs.readFileSync(apk);
    // End of central directory: the last "PK\x05\x06"
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("not a zip/APK");
    const cdOff = b.readUInt32LE(eocd + 16);
    if (b.toString("latin1", cdOff - 16, cdOff) !== "APK Sig Block 42") throw new Error("no APK signing block (v1-only signature)");
    const blockSize = Number(b.readBigUInt64LE(cdOff - 24));
    const start = cdOff - blockSize - 8;
    const pairs = b.subarray(start + 8, cdOff - 24);
    const certs = [];
    for (let off = 0; off + 12 <= pairs.length;) {
        const len = Number(pairs.readBigUInt64LE(off));
        const id = pairs.readUInt32LE(off + 8);
        const val = pairs.subarray(off + 12, off + 8 + len);
        off += 8 + len;
        if (id !== 0xf05368c0 && id !== 0x7109871a) continue;   // v3, v2
        for (const signer of seq(lenPrefixed(val, 0).data)) {
            const signedData = lenPrefixed(signer, 0).data;
            const digests = lenPrefixed(signedData, 0);
            const certSeq = lenPrefixed(signedData, digests.next).data;
            for (const c of seq(certSeq)) certs.push(crypto.createHash("sha256").update(c).digest("hex"));
        }
        if (certs.length) break;   // v3 first if present, else v2
    }
    if (!certs.length) throw new Error("no v2/v3 signer found");
    return [...new Set(certs)];
}

export function verifyApkSigner(apk, sha256) {
    try { const got = apkSignerDigests(apk); return { ok: got.includes(sha256.toLowerCase()), got }; }
    catch (e) { return { ok: false, got: [], error: e.message }; }
}

// ---------- signed JAR (v1 / JAR signing, as F-Droid signs its index) ----------

// Minimal zip reader: { name: Buffer } for every entry (stored or deflated).
function unzip(b) {
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("not a zip file");
    const count = b.readUInt16LE(eocd + 10);
    let off = b.readUInt32LE(eocd + 16);
    const out = {};
    for (let i = 0; i < count; i++) {
        if (b.readUInt32LE(off) !== 0x02014b50) throw new Error("bad zip directory");
        const method = b.readUInt16LE(off + 10), csize = b.readUInt32LE(off + 20), usize = b.readUInt32LE(off + 24);
        const nlen = b.readUInt16LE(off + 28), xlen = b.readUInt16LE(off + 30), clen = b.readUInt16LE(off + 32);
        const local = b.readUInt32LE(off + 42);
        const name = b.toString("utf8", off + 46, off + 46 + nlen);
        off += 46 + nlen + xlen + clen;
        if (b.readUInt32LE(local) !== 0x04034b50) throw new Error("bad zip entry");
        const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
        const raw = b.subarray(start, start + csize);
        const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
        if (!data || data.length !== usize) throw new Error(`can't read ${name}`);
        if (name in out) throw new Error(`duplicate entry ${name}`);
        out[name] = data;
    }
    return out;
}

// Minimal DER reader: { tag, start (of contents), end, hdr (offset of the tag byte) }.
function der(b, off) {
    const tag = b[off];
    let len = b[off + 1], p = off + 2;
    if (len & 0x80) { const n = len & 0x7f; if (n < 1 || n > 4) throw new Error("bad DER length"); len = 0; for (let i = 0; i < n; i++) len = len * 256 + b[p++]; }
    if (p + len > b.length) throw new Error("truncated DER");
    return { tag, start: p, end: p + len, hdr: off };
}
function derChildren(b, node) { const out = []; for (let o = node.start; o < node.end;) { const c = der(b, o); out.push(c); o = c.end; } return out; }
function derOid(b, node) {
    const v = b.subarray(node.start, node.end);
    const parts = [Math.floor(v[0] / 40), v[0] % 40];
    let n = 0;
    for (let i = 1; i < v.length; i++) { n = n * 128 + (v[i] & 0x7f); if (!(v[i] & 0x80)) { parts.push(n); n = 0; } }
    return parts.join(".");
}
const DIGESTS = { "2.16.840.1.101.3.4.2.1": "sha256", "2.16.840.1.101.3.4.2.2": "sha384", "2.16.840.1.101.3.4.2.3": "sha512" };
const SIG_HASH = { "1.2.840.113549.1.1.11": "sha256", "1.2.840.113549.1.1.12": "sha384", "1.2.840.113549.1.1.13": "sha512" };

// PKCS#7 SignedData (META-INF/*.RSA|EC): verify that a certificate with the pinned SHA-256 signed `content`.
function verifyPkcs7(p7, content, certSha256) {
    const top = derChildren(p7, der(p7, 0));                         // ContentInfo: oid, [0]
    if (derOid(p7, top[0]) !== "1.2.840.113549.1.7.2") throw new Error("not PKCS#7 SignedData");
    const sd = derChildren(p7, derChildren(p7, top[1])[0]);           // SignedData
    let i = 3;                                                        // version, digestAlgorithms, contentInfo
    const certs = [];
    if (sd[i]?.tag === 0xa0) { for (const c of derChildren(p7, sd[i])) certs.push(p7.subarray(c.hdr, c.end)); i++; }
    if (sd[i]?.tag === 0xa1) i++;                                      // CRLs
    const signers = derChildren(p7, sd[i]);
    if (!certs.length || !signers.length) throw new Error("no signer");
    const pinned = certs.find(c => crypto.createHash("sha256").update(c).digest("hex") === certSha256.toLowerCase());
    if (!pinned) throw new Error("signed with a different certificate");
    const key = new crypto.X509Certificate(pinned).publicKey;
    for (const si of signers) {
        const f = derChildren(p7, si);                                // version, sid, digestAlg, [0] attrs?, sigAlg, sig
        const hash = DIGESTS[derOid(p7, derChildren(p7, f[2])[0])];
        if (!hash) continue;
        let k = 3, signed = content;
        if (f[k].tag === 0xa0) {
            // Signed attributes: the signature covers them (as a SET), and their messageDigest covers content.
            const attrs = derChildren(p7, f[k]);
            const md = attrs.map(a => derChildren(p7, a)).find(a => derOid(p7, a[0]) === "1.2.840.113549.1.9.4");
            if (!md) continue;
            const v = derChildren(p7, md[1])[0];
            if (!crypto.createHash(hash).update(content).digest().equals(p7.subarray(v.start, v.end))) continue;
            signed = Buffer.concat([Buffer.from([0x31]), p7.subarray(f[k].hdr + 1, f[k].end)]);
            k++;
        }
        const sigAlg = derOid(p7, derChildren(p7, f[k])[0]);
        const sigHash = sigAlg === "1.2.840.113549.1.1.1" || sigAlg === "1.2.840.10045.2.1" ? hash : SIG_HASH[sigAlg];
        if (!sigHash) continue;
        const sig = p7.subarray(f[k + 1].start, f[k + 1].end);
        try { if (crypto.verify(sigHash, signed, key, sig)) return true; } catch {}
    }
    throw new Error("bad signature");
}

// Manifest-style text: main section + named sections, with 72-byte line continuations.
function manifestSections(buf) {
    const lines = buf.toString("utf8").replace(/\r\n?/g, "\n").replace(/\n /g, "").split("\n");
    const out = [{}];
    for (const l of lines) {
        if (!l) { if (Object.keys(out[out.length - 1]).length) out.push({}); continue; }
        const m = l.match(/^([^:]+):\s?(.*)$/);
        if (m) out[out.length - 1][m[1]] = m[2];
    }
    return out.filter(s => Object.keys(s).length);
}

export function verifySignedJar(buf, certSha256, entryName) {
    const z = unzip(buf);
    const sfName = Object.keys(z).find(n => /^META-INF\/[^/]+\.SF$/i.test(n));
    if (!sfName) throw new Error("unsigned");
    const base = sfName.slice(0, -3);
    const p7Name = Object.keys(z).find(n => n.slice(0, -4).toUpperCase() === base.toUpperCase() && /\.(RSA|EC|DSA)$/i.test(n));
    const mf = z["META-INF/MANIFEST.MF"];
    if (!p7Name || !mf || !z[entryName]) throw new Error("incomplete signature");
    verifyPkcs7(z[p7Name], z[sfName], certSha256);
    const b64 = (alg, data) => crypto.createHash(alg).update(data).digest("base64");
    const algs = [["SHA-256", "sha256"], ["SHA-384", "sha384"], ["SHA-512", "sha512"]];
    // .SF -> whole manifest
    const sf = manifestSections(z[sfName])[0] ?? {};
    const mfAlg = algs.find(([n]) => sf[`${n}-Digest-Manifest`]);
    if (!mfAlg || sf[`${mfAlg[0]}-Digest-Manifest`] !== b64(mfAlg[1], mf)) throw new Error("manifest digest mismatch");
    // manifest -> the entry
    const sec = manifestSections(mf).find(s => s.Name === entryName);
    const eAlg = sec && algs.find(([n]) => sec[`${n}-Digest`]);
    if (!eAlg || sec[`${eAlg[0]}-Digest`] !== b64(eAlg[1], z[entryName])) throw new Error(`${entryName} digest mismatch`);
    return z[entryName];
}
