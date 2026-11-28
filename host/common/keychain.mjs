// host/common/keychain.mjs — macOS Keychain generic passwords via /usr/bin/security.
//
// Exports:
//   makeKeychain(service) -> { get(account), set(account, password), del(account) }
//     get: the password, or null if there is none
//     set: true on success; the command goes in over `security -i` stdin so the password never
//          appears in argv / ps
//     del: removes it (silently ignores a missing item)

import { spawnSync } from "node:child_process";

export function makeKeychain(service) {
    function get(user) {
        const r = spawnSync("security", ["find-generic-password", "-s", service, "-a", user, "-w"], { encoding: "utf8" });
        return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
    }
    function set(user, pw) {
        // `security -i` reads the command from stdin so the password never shows up in argv.
        const q = v => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        const r = spawnSync("security", ["-i"], {
            input: `add-generic-password -U -s ${service} -a ${q(user)} -w ${q(pw)}\n`,
            encoding: "utf8",
        });
        return r.status === 0;
    }
    function del(user) {
        spawnSync("security", ["delete-generic-password", "-s", service, "-a", user], { stdio: "ignore" });
    }
    return { get, set, del };
}
