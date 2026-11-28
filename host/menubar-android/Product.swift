// Identity of the Android menu-bar app. "RoboDinghy" is a codename: every product string the app
// shows or uses (name, paths, bundle id, env vars) comes from here, so a real name is a small change.
// The CLI keeps its own copy in host/android/product.mjs; the two must agree.
import Foundation

enum Product {
    /// Display name: window title, menu items, notifications, alerts.
    static let name = "RoboDinghy"
    /// The guest OS, as shown in status lines ("Android is running").
    static let os = "Android"
    /// The CLI's command name, used in "run `robodinghy …` in a terminal" hints.
    static let cli = "robodinghy"

    /// Env var that points at a checkout's host/android/robodinghy.mjs (like DINGHY_PATH).
    static let scriptEnvVar = "ROBODINGHY_PATH"
    /// The CLI in the default checkout, then the copy bundled in Contents/Resources (build.sh keeps the
    /// repo layout there, android/ next to common/, because the CLI imports ../common/*.mjs).
    static let checkoutScript = "~/windinghy/host/android/robodinghy.mjs"
    static let bundledScript = "android/robodinghy.mjs"
    /// The git checkout updates come from, and its tracked updater (shared with WinDinghy).
    static let defaultCheckout = "~/windinghy"
    static let updaterScript = "host/dinghy-update.sh"

    static let configDir = "~/.config/robodinghy"
    static var configPath: String { configDir + "/config.json" }
    static var usagePath: String { configDir + "/usage.json" }
    /// Default launcher folder (config key appsDir overrides it).
    static let appsDir = "~/Applications/RoboDinghy"
    /// The VM folder: avd/ (ANDROID_AVD_HOME), emulator.pid, emulator.log, paused, suspend.json.
    static let vmDir = "~/Library/Application Support/RoboDinghy"
    static let avdName = "RoboDinghy"
    /// The launcher sync writes for the full Android screen.
    static let desktopApp = "Android Desktop"
    /// Export bundles (`vm export`).
    static let vmBundleExtension = "robodinghyvm"

    static let windowAutosave = "RoboDinghyMain"
    static let showWindowEnv = "ROBODINGHY_SHOW_WINDOW"
}
