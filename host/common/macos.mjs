// host/common/macos.mjs — AppleScript dialogs and notifications (osascript), product-neutral.
//
// Exports:
//   asDialog(script)                  runs an AppleScript; trimmed stdout, or null on error/cancel
//   asq(text)                         escapes text for an AppleScript string literal ("..." contents)
//   notify(title, msg)                macOS notification (launchers have no terminal)
//   showError(title, message, logFile?)  caution dialog titled `title` with "Show Log" / "OK";
//                                     Show Log opens logFile in the default text editor.
//                                     Callers prefix their product: showError("WinDinghy: " + t, ...)

import { spawnSync } from "node:child_process";

export function asDialog(script) {
    const r = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
}

export const asq = t => t.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function notify(title, msg) {
    spawnSync("osascript", ["-e", `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}`], { stdio: "ignore" });
}

export function showError(title, message, logFile) {
    const out = asDialog(`button returned of (display dialog "${asq(message)}" with title "${asq(title)}" with icon caution buttons {"Show Log", "OK"} default button "OK")`);
    if (out === "Show Log" && logFile) spawnSync("open", ["-t", logFile]);
}
