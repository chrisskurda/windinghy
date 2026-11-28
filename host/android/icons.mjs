// host/android/icons.mjs — Mac-style launcher icons from Android icons, with no dependencies (a minimal
// PNG reader/writer on node:zlib).
//
// Android adaptive icons come out of the helper APK full-bleed and unmasked (a filled square). On the
// Mac they'd look like raw tiles, so those get the macOS icon grid: scaled into the 824/1024 content
// square and clipped to its rounded rectangle. Icons that already have their own shape (transparent
// corners: legacy Android icons) are left alone.
//
// Exports:
//   decodePng(buf)            { width, height, data (RGBA Buffer) } or null (8-bit RGB/RGBA/grey/palette,
//                             non-interlaced; anything else -> null)
//   encodePng(w, h, rgba)     PNG Buffer
//   macIcon(pngBuf)           PNG Buffer ready for makeIcns (masked when full-bleed), or the input on failure
//   genericIcon(kind, size)   PNG Buffer: "app" (phone glyph) or "desktop" (monitor glyph) on RoboDinghy teal

import zlib from "node:zlib";

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

export function decodePng(buf) {
    try {
        if (!buf.subarray(0, 8).equals(SIG)) return null;
        let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, palette = null, trns = null;
        const idat = [];
        while (off < buf.length) {
            const len = buf.readUInt32BE(off), type = buf.toString("latin1", off + 4, off + 8), d = buf.subarray(off + 8, off + 8 + len);
            if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
            else if (type === "PLTE") palette = d;
            else if (type === "tRNS") trns = d;
            else if (type === "IDAT") idat.push(d);
            else if (type === "IEND") break;
            off += 12 + len;
        }
        const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
        if (depth !== 8 || interlace !== 0 || !ch) return null;
        const raw = zlib.inflateSync(Buffer.concat(idat));
        const stride = w * ch, px = Buffer.alloc(stride * h);
        let prev = Buffer.alloc(stride);
        for (let y = 0; y < h; y++) {
            const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), out = px.subarray(y * stride, (y + 1) * stride);
            for (let i = 0; i < stride; i++) {
                const a = i >= ch ? out[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
                let v = line[i];
                if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
                else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
                out[i] = v & 0xff;
            }
            prev = out;
        }
        const data = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            const s = i * ch, o = i * 4;
            if (ctype === 6) { data[o] = px[s]; data[o + 1] = px[s + 1]; data[o + 2] = px[s + 2]; data[o + 3] = px[s + 3]; }
            else if (ctype === 2) { data[o] = px[s]; data[o + 1] = px[s + 1]; data[o + 2] = px[s + 2]; data[o + 3] = 255; }
            else if (ctype === 0) { data[o] = data[o + 1] = data[o + 2] = px[s]; data[o + 3] = 255; }
            else if (ctype === 4) { data[o] = data[o + 1] = data[o + 2] = px[s]; data[o + 3] = px[s + 1]; }
            else { const p = px[s] * 3; data[o] = palette[p]; data[o + 1] = palette[p + 1]; data[o + 2] = palette[p + 2]; data[o + 3] = trns && px[s] < trns.length ? trns[px[s]] : 255; }
        }
        return { width: w, height: h, data };
    } catch { return null; }
}

function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

export function encodePng(w, h, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
    return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// Coverage (0..1) of pixel centre (px,py) by a rounded rect, antialiased over one pixel.
function rrCover(px, py, x0, y0, x1, y1, r) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
    const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy;
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    return Math.min(1, Math.max(0, 0.5 - d));
}

function sample(img, x, y) {   // bilinear, edge-clamped, premultiplied-safe enough for opaque tiles
    const { width: w, height: h, data } = img;
    const fx = Math.min(w - 1, Math.max(0, x)), fy = Math.min(h - 1, Math.max(0, y));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    const out = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
        const p = (xx, yy) => data[(yy * w + xx) * 4 + c];
        out[c] = (p(x0, y0) * (1 - tx) + p(x1, y0) * tx) * (1 - ty) + (p(x0, y1) * (1 - tx) + p(x1, y1) * tx) * ty;
    }
    return out;
}

const GRID = { content: 824 / 1024, radius: 185.4 / 1024 };

export function macIcon(pngBuf) {
    const img = decodePng(pngBuf);
    if (!img || img.width < 16) return pngBuf;
    const { width: w, height: h, data } = img;
    const a = (x, y) => data[(y * w + x) * 4 + 3];
    const fullBleed = [a(0, 0), a(w - 1, 0), a(0, h - 1), a(w - 1, h - 1)].every(v => v > 200);
    if (!fullBleed) return pngBuf;
    const S = Math.max(w, h), out = Buffer.alloc(S * S * 4);
    const side = S * GRID.content, x0 = (S - side) / 2, r = S * GRID.radius;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const cov = rrCover(x + 0.5, y + 0.5, x0, x0, x0 + side, x0 + side, r);
        if (cov <= 0) continue;
        const [R, G, B, A] = sample(img, (x + 0.5 - x0) / side * w - 0.5, (y + 0.5 - x0) / side * h - 0.5);
        const o = (y * S + x) * 4;
        out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = Math.round(A * cov);
    }
    return encodePng(S, S, out);
}

export function genericIcon(kind = "app", S = 512) {
    const out = Buffer.alloc(S * S * 4);
    const side = S * GRID.content, b = (S - side) / 2, r = S * GRID.radius;
    const top = [43, 181, 160], bottom = [18, 122, 138], dark = [14, 95, 107];
    // glyph: list of [x0,y0,x1,y1,radius,colour] in 0..1 units, painted in order
    const W = [255, 255, 255];
    const glyph = kind === "desktop"
        ? [[0.22, 0.28, 0.78, 0.64, 0.035, W], [0.25, 0.31, 0.75, 0.61, 0.015, dark], [0.46, 0.63, 0.54, 0.71, 0, W], [0.36, 0.70, 0.64, 0.74, 0.02, W]]
        : [[0.35, 0.24, 0.65, 0.76, 0.05, W], [0.38, 0.29, 0.62, 0.69, 0.015, dark], [0.46, 0.715, 0.54, 0.735, 0.01, W]];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const px = x + 0.5, py = y + 0.5;
        const cov = rrCover(px, py, b, b, b + side, b + side, r);
        if (cov <= 0) continue;
        const t = (py - b) / side;
        let col = top.map((v, i) => v + (bottom[i] - v) * t);
        for (const [gx0, gy0, gx1, gy1, gr, gc] of glyph) {
            const c = rrCover(px, py, gx0 * S, gy0 * S, gx1 * S, gy1 * S, gr * S);
            if (c > 0) col = col.map((v, i) => v + (gc[i] - v) * c);
        }
        const o = (y * S + x) * 4;
        out[o] = Math.round(col[0]); out[o + 1] = Math.round(col[1]); out[o + 2] = Math.round(col[2]); out[o + 3] = Math.round(255 * cov);
    }
    return encodePng(S, S, out);
}
