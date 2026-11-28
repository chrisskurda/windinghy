// Self-update for a menu-bar app that lives in a git checkout. The update logic itself is a tracked
// shell script (e.g. host/<cli>-update.sh) that is only ever run through a gitignored copy at the repo
// root (`update`), so the running script is never the file `git pull` rewrites. The app's user-facing
// wording (titles, alerts) stays in the app; this only finds, installs and runs the launcher.
//
// API
//   UpdaterConfig(scriptEnvVar:defaultCheckout:trackedScript:launcherName:pathEnv:)
//       scriptEnvVar      Env var that points at <checkout>/host/<cli>.mjs; its grandparent is the checkout.
//       defaultCheckout   Checkout used otherwise, e.g. "~/<app>" ("~" is expanded).
//       trackedScript     Repo-relative updater script, e.g. "host/<cli>-update.sh".
//       launcherName      Repo-root launcher name (default "update").
//   Updater(config)
//     .findRepoRoot() -> String?                 A checkout with .git (never the copy in the app bundle).
//     .installedUpdateLauncher(root:) -> String? The launcher, copied from trackedScript (0755) if missing.
//     .run(launcher:done:)                       Async: /bin/bash <launcher> with git prompts disabled and
//                                                ssh in batch mode; stdout+stderr merged.
//                                                done(status, fullOutput, launchError) on main.
import Foundation

struct UpdaterConfig {
    let scriptEnvVar: String
    let defaultCheckout: String
    let trackedScript: String
    var launcherName = "update"
    var pathEnv: String = CLIConfig.defaultPATH
}

struct Updater {
    let config: UpdaterConfig

    func findRepoRoot() -> String? {
        let fm = FileManager.default
        if let env = ProcessInfo.processInfo.environment[config.scriptEnvVar] {
            let root = ((env as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
            if fm.fileExists(atPath: root + "/.git") { return root }
        }
        let candidate = NSString(string: config.defaultCheckout).expandingTildeInPath
        return fm.fileExists(atPath: candidate + "/.git") ? candidate : nil
    }

    func installedUpdateLauncher(root: String) -> String? {
        let fm = FileManager.default
        let launcherPath = root + "/" + config.launcherName
        if fm.fileExists(atPath: launcherPath) { return launcherPath }
        let trackedPath = root + "/" + config.trackedScript
        guard fm.fileExists(atPath: trackedPath) else { return nil }
        try? fm.copyItem(atPath: trackedPath, toPath: launcherPath)
        try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launcherPath)
        return fm.fileExists(atPath: launcherPath) ? launcherPath : nil
    }

    func run(launcher launcherPath: String, done: @escaping (Int32, String, Error?) -> Void) {
        let pathEnv = config.pathEnv
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [launcherPath]
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = pathEnv
            env["GIT_TERMINAL_PROMPT"] = "0"
            env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes -o ConnectTimeout=15"
            p.environment = env
            let out = Pipe()
            p.standardOutput = out; p.standardError = out
            do { try p.run() } catch {
                DispatchQueue.main.async { done(1, "", error) }
                return
            }
            let data = out.fileHandleForReading.readDataToEndOfFile()   // read to EOF: no lost output
            p.waitUntilExit()
            let text = String(data: data, encoding: .utf8) ?? ""
            DispatchQueue.main.async { done(p.terminationStatus, text, nil) }
        }
    }
}
