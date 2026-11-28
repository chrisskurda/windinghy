// host/common/permissions.mjs — the macOS "App Management" permission (System Settings > Privacy &
// Security > App Management). macOS blocks one app from modifying another app's bundle unless it is
// allowed there; generated launchers in ~/Applications/<Product> count as apps. There's no API to
// request it, but a probe tells whether it's granted: try a harmless write inside an existing
// launcher's Contents/MacOS (preferring one that holds the bundled client copy) and see if macOS refuses.
//
// Exports:
//   APP_MGMT_PANE                     the System Settings URL of the pane
//   makeAppManagement({ appName, configDir, preferBinary })
//       appName       product name shown in dialogs ("WinDinghy")
//       configDir     where the rate-limit stamps live (app-management-hint, app-management-prompted)
//       preferBinary  Contents/MacOS/<name> marking a launcher that holds a client copy ("freerdp", "scrcpy")
//     -> {
//       probe(appsDir)                  true = allowed (or no launcher to protect yet), false = blocked
//       ensure(appsDir, { wait=true })  async: dialog + open the pane; with wait, poll up to 3 minutes
//                                       (prints progress lines); resolves true if allowed
//       hint(err)                       for EPERM/EACCES errors: explain in a dialog (at most every
//                                       10 minutes) and return true; false for any other error
//       command(appsDir, args)          async: the `permissions [--prompt] [--quiet]` command body;
//                                       --prompt --quiet asks at most once a day; prints the result
//                                       line unless --quiet; returns ok (caller exits 0/1)
//     }

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { asDialog, asq } from "./macos.mjs";
import { waitFor } from "./cli.mjs";

export const APP_MGMT_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles";

export function makeAppManagement({ appName, configDir, preferBinary }) {
    const name = asq(appName);

    function probe(appsDir) {
        let apps = [];
        try { apps = fs.readdirSync(appsDir).filter(e => e.endsWith(".app")); } catch {}
        const withClient = apps.find(a => fs.existsSync(path.join(appsDir, a, "Contents", "MacOS", preferBinary))) ?? apps[0];
        if (!withClient) return true;
        const probeFile = path.join(appsDir, withClient, "Contents", "MacOS", ".dinghy-probe");
        try { fs.writeFileSync(probeFile, "1"); fs.rmSync(probeFile, { force: true }); return true; }
        catch (e) { return !/^(EPERM|EACCES)$/.test(e.code ?? ""); }
    }

    async function ensure(appsDir, { wait = true } = {}) {
        if (probe(appsDir)) return true;
        const out = asDialog(`button returned of (display dialog "${name} needs permission to update its app launchers.\n\nIn System Settings > Privacy & Security > App Management, turn on ${name}. This is a one-time step; I'll continue automatically once it's on." with title "${name}" with icon caution buttons {"Not now", "Open Settings"} default button "Open Settings")`);
        if (out !== "Open Settings") return false;
        spawnSync("open", [APP_MGMT_PANE]);
        if (!wait) return false;
        console.log(`Waiting for you to turn on ${appName} under App Management (up to 3 minutes)...`);
        const ok = await waitFor(() => probe(appsDir), 180, 2500);
        console.log(ok ? "Permission granted." : "Still not allowed: launchers can't be updated until it is.");
        return ok;
    }

    function hint(err) {
        if (!err || !/^(EPERM|EACCES)$/.test(err.code ?? "")) return false;
        const flag = path.join(configDir, "app-management-hint");
        try { if (Date.now() - fs.statSync(flag).mtimeMs < 600000) return true; } catch {} // at most every 10 minutes
        try { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(flag, ""); } catch {}
        const out = asDialog(`button returned of (display dialog "macOS is blocking ${name} from updating its app launchers (App Management protection).\n\nOpen System Settings > Privacy & Security > App Management, turn on ${name}, then try again." with title "${name}" with icon caution buttons {"Not now", "Open Settings"} default button "Open Settings")`);
        if (out === "Open Settings") spawnSync("open", [APP_MGMT_PANE]);
        return true;
    }

    async function command(appsDir, args) {
        let ok;
        if (args.includes("--prompt")) {
            const quiet = args.includes("--quiet");
            const stamp = path.join(configDir, "app-management-prompted");
            // Background callers (app start) don't nag: at most one prompt a day.
            if (quiet && !probe(appsDir) && (() => { try { return Date.now() - fs.statSync(stamp).mtimeMs < 86400000; } catch { return false; } })()) {
                ok = false;
            } else {
                if (quiet && !probe(appsDir)) { try { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(stamp, ""); } catch {} }
                ok = await ensure(appsDir, { wait: !quiet });
            }
        } else ok = probe(appsDir);
        if (!args.includes("--quiet")) console.log(ok ? "App Management: allowed" : `App Management: BLOCKED (System Settings > Privacy & Security > App Management > ${appName})`);
        return ok;
    }

    return { probe, ensure, hint, command };
}
