// host/common/config.mjs — JSON config file handling shared by dinghy and robodinghy.
//
// Exports:
//   makeConfig({ path, defaults, migrate?, sanitize?, postLoad?, logPrefix })  -> { load(), save(cfg) }
//     load(): migrate?.()  (e.g. copy a legacy config dir; runs before anything is read)
//             cfg = { ...defaults, ...JSON(path) }
//             unreadable file -> keeps a copy as <path>.broken-<ms>, prints
//               "<logPrefix> <file> was unreadable; saved a copy as <copy> and started fresh." to stderr
//               and saves the defaults
//             notes = sanitize?.(cfg) (string[] of repairs) -> each printed as
//               "<logPrefix> repaired settings: <note>" to stderr, then saved
//             postLoad?.(cfg, save)  (product-specific one-off migrations)
//             returns cfg
//     save(cfg): mkdir -p dirname(path); writes JSON.stringify(cfg, null, 2) + "\n"
//     logPrefix is the product name with a colon, e.g. "WinDinghy:"
//
//   sanitizer(cfg, defaults) -> { notes, fix, oneOf, numbers }  rule engine for a sanitize callback:
//     fix(cond, msg, apply)             if cond: apply() and record msg
//     oneOf(key, values)                not in values -> `bad <key> "<v>" -> <default>`
//     numbers([[key, lo, hi], ...])     per key, in order: digit text -> number (`<key> was text -> number`),
//                                       then not an integer in [lo, hi] -> default (`bad <key> ...`)
//     notes                             the recorded messages (return this from sanitize)
//
//   checkConfigValue(key, value, { enums, numbers })  throws the CLI's errors for `config <key> <value>`:
//     "<key> must be one of: a, b" / "<key> must be a whole number from <lo> to <hi>"
//   coerceConfigValue(key, value, numbers)  digit text for "*Port" keys and number-table keys -> Number

import fs from "node:fs";
import nodePath from "node:path";

export function makeConfig({ path, defaults, migrate, sanitize, postLoad, logPrefix }) {
    function save(cfg) {
        fs.mkdirSync(nodePath.dirname(path), { recursive: true });
        fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
    }
    function load() {
        if (migrate) migrate();
        let cfg;
        try {
            cfg = { ...defaults, ...JSON.parse(fs.readFileSync(path, "utf8")) };
        } catch (e) {
            cfg = { ...defaults };
            if (fs.existsSync(path)) {
                // Unreadable config: keep a copy for inspection and start clean instead of failing.
                const bak = `${path}.broken-${Date.now()}`;
                try { fs.copyFileSync(path, bak); console.error(`${logPrefix} ${nodePath.basename(path)} was unreadable; saved a copy as ${nodePath.basename(bak)} and started fresh.`); } catch {}
                try { save(cfg); } catch {}
            }
        }
        const repaired = sanitize ? sanitize(cfg) : [];
        if (repaired.length) {
            for (const n of repaired) console.error(`${logPrefix} repaired settings: ${n}`);
            try { save(cfg); } catch {}
        }
        if (postLoad) postLoad(cfg, save);
        return cfg;
    }
    return { load, save };
}

export function sanitizer(cfg, defaults) {
    const notes = [];
    const fix = (cond, msg, apply) => { if (cond) { apply(); notes.push(msg); } };
    const oneOf = (k, vals) => fix(!vals.includes(cfg[k]), `bad ${k} "${cfg[k]}" -> ${defaults[k]}`, () => { cfg[k] = defaults[k]; });
    const numbers = table => {
        for (const [k, lo, hi] of table) {
            fix(typeof cfg[k] === "string" && /^\d+$/.test(cfg[k]), `${k} was text -> number`, () => { cfg[k] = Number(cfg[k]); });
            fix(!Number.isInteger(cfg[k]) || cfg[k] < lo || cfg[k] > hi, `bad ${k} "${cfg[k]}" -> ${defaults[k]}`, () => { cfg[k] = defaults[k]; });
        }
    };
    return { notes, fix, oneOf, numbers };
}

export function checkConfigValue(key, value, { enums = {}, numbers = [] } = {}) {
    if (enums[key] && !enums[key].includes(value)) throw new Error(`${key} must be one of: ${enums[key].join(", ")}`);
    const num = numbers.find(([k]) => k === key);
    if (num && (!/^\d+$/.test(value) || Number(value) < num[1] || Number(value) > num[2])) throw new Error(`${key} must be a whole number from ${num[1]} to ${num[2]}`);
}

export function coerceConfigValue(key, value, numbers = []) {
    const num = numbers.find(([k]) => k === key);
    return (/^\d+$/.test(value) && (key.endsWith("Port") || num)) ? Number(value) : value;
}
