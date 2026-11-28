// Shared state for the main window (SwiftUI). One store, observed by the window; the menu-bar
// controller (AppDelegate in main.swift) sets itself as `delegate` for the actions that need its
// machinery (notifications, the output window, updates). Live status comes from
// `robodinghy status --json`, polled every 3 s while the window is open (every 30 s from the menu).
import SwiftUI
import AppKit

enum Screen: String, CaseIterable, Identifiable {
    case apps, desktop, software
    case android, resources, sharing, snapshots, storage
    case general
    var id: String { rawValue }
    var title: String {
        switch self {
        case .apps: return "Apps"
        case .desktop: return Product.desktopApp
        case .software: return "Software"
        case .android: return Product.os
        case .resources: return "Resources"
        case .sharing: return "Sharing"
        case .snapshots: return "Snapshots"
        case .storage: return "Storage & Backup"
        case .general: return "General"
        }
    }
    var symbol: String {
        switch self {
        case .apps: return "square.grid.2x2"
        case .desktop: return "display"
        case .software: return "shippingbox"
        case .android: return "iphone"
        case .resources: return "cpu"
        case .sharing: return "arrow.left.arrow.right"
        case .snapshots: return "clock.arrow.circlepath"
        case .storage: return "externaldrive"
        case .general: return "gearshape"
        }
    }
    /// Sidebar groups, in order (General sits alone at the bottom).
    static let sections: [(String, [Screen])] = [
        ("Apps", [.apps, .desktop, .software]),
        (Product.os, [.android, .resources, .sharing, .snapshots, .storage]),
    ]
}

struct AndroidApp: Identifiable, Hashable {
    let id: String      // full path of the generated .app
    let name: String
    var package = ""    // from the launcher's app.json, when the CLI recorded it
    var path: String { id }
}

struct SnapshotItem: Identifiable {
    var id: String { name }
    let name: String
    let date: Date
}

struct HealthRow: Identifiable {
    var id: String { title }
    let title: String
    let detail: String
    let ok: Bool
}

enum SetupPhase: Equatable {
    case welcome
    case customize
    case installing(pct: Double, title: String)
    case done(apps: Int)
    case failed(String)
}

/// Read/write single keys of ~/.config/robodinghy/config.json (shared with the CLI).
/// A thin static front for RDConfig.file (JSONConfigFile, host/common/swift).
enum ConfigFile {
    static func dict() -> [String: Any] { RDConfig.file.dict() }
    static func string(_ key: String, _ def: String) -> String { RDConfig.file.string(key, def) }
    static func int(_ key: String, _ def: Int) -> Int { RDConfig.file.int(key, def) }
    static func bool(_ key: String, _ def: Bool) -> Bool { RDConfig.file.bool(key, def) }
    static func set(_ key: String, _ value: Any) { RDConfig.file.set(key, value) }
    static func setBool(_ key: String, _ on: Bool) { RDConfig.file.setBool(key, on) }
}

/// One `robodinghy status --json` result:
/// {exists, running, paused, booted, edition, android, api, serial, cpu, ramMB, appsOpen, emulator, adb, scrcpy, helper, avdDir}.
/// cpu and ramMB are the emulator process on the Mac (`ps`): cpu is summed over its threads, so it can
/// pass 100; use guestCPU(cores:). adb and helper are only known while Android runs (false / null when off).
/// Parsed leniently: the health fields may be booleans, strings (a version or reason) or objects.
struct EmuStatus {
    var exists = false, running = false, paused = false, booted = false
    var edition = "", android = "", api = "", serial = "", avdDir = ""
    var cpu = 0.0, ramMB = 0.0, ramTotalMB = 0.0
    var appsOpen = 0
    var emulator = (ok: false, detail: ""), adb = (ok: false, detail: ""), scrcpy = (ok: false, detail: ""), helper = (ok: false, detail: "")

    /// Booted and not frozen: apps can open now.
    var online: Bool { running && booted && !paused }

    init() {}

    init(_ d: [String: Any]) {
        exists = d["exists"] as? Bool ?? false
        running = d["running"] as? Bool ?? false
        paused = d["paused"] as? Bool ?? false
        booted = d["booted"] as? Bool ?? false
        edition = Self.str(d["edition"])
        android = Self.str(d["android"])
        api = Self.str(d["api"])
        serial = Self.str(d["serial"])
        avdDir = Self.str(d["avdDir"])
        cpu = Self.num(d["cpu"])
        if let r = d["ramMB"] as? [String: Any] {
            ramMB = Self.num(r["used"]); ramTotalMB = Self.num(r["total"])
        } else {
            ramMB = Self.num(d["ramMB"]); ramTotalMB = Self.num(d["ramTotalMB"])
        }
        appsOpen = Int(Self.num(d["appsOpen"]))
        emulator = Self.health(d["emulator"]); adb = Self.health(d["adb"]); scrcpy = Self.health(d["scrcpy"]); helper = Self.health(d["helper"])
    }

    /// CPU as a share of the VM's cores (0–100): `ps` reports one core as 100%.
    func guestCPU(cores: Int) -> Double { min(100, max(0, cpu / Double(max(cores, 1)))) }

    static func str(_ v: Any?) -> String {
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return ""
    }

    static func num(_ v: Any?) -> Double {
        if let n = v as? NSNumber { return n.doubleValue }
        if let s = v as? String { return Double(s) ?? 0 }
        return 0
    }

    static func health(_ v: Any?) -> (ok: Bool, detail: String) {
        if let b = v as? Bool { return (b, b ? "ok" : "missing") }
        if let s = v as? String {
            let bad = ["", "missing", "none", "no", "false", "offline", "not installed", "not found"].contains(s.lowercased())
            return (!bad, s.isEmpty ? "missing" : s)
        }
        if let d = v as? [String: Any] {
            let ok = (d["ok"] as? Bool) ?? (d["installed"] as? Bool) ?? (d["present"] as? Bool) ?? false
            let detail = str(d["version"] ?? d["state"] ?? d["detail"] ?? d["path"])
            return (ok, detail.isEmpty ? (ok ? "ok" : "missing") : detail)
        }
        return (false, "unknown")
    }
}

final class AppStore: ObservableObject {
    static let shared = AppStore()
    weak var delegate: AppDelegate?

    // navigation
    @Published var screen: Screen = .apps
    @Published var query = ""

    // apps
    @Published var apps: [AndroidApp] = []
    @Published var running: Set<String> = []
    @Published var syncing = false

    // Android (from `status --json`)
    @Published var status: EmuStatus? = nil
    @Published var vmOnline = false
    @Published var vmRunning = false
    @Published var vmPaused = false
    @Published var vmExists = true
    @Published var busy: String? = nil      // "Starting…", "Stopping…"
    @Published var cpu: Double = 0
    @Published var ramUsedMB: Double = 0
    @Published var ramTotalMB: Double = 0
    @Published var diskUsedGB: Double = 0
    @Published var diskTotalGB: Double = 0
    @Published var health: [HealthRow] = []

    // snapshots
    @Published var snapshots: [SnapshotItem] = []
    @Published var snapshotBusy = false
    @Published var snapshotMessage: String? = nil

    // resources (persisted; applied the next time Android starts)
    @Published var cores: Int { didSet { ConfigFile.set("vmCpus", cores) } }
    @Published var ramGB: Int { didSet { ConfigFile.set("vmRamGB", ramGB) } }
    @Published var diskGB: Int { didSet { ConfigFile.set("vmDiskGB", diskGB) } }
    // app windows (persisted; applied to the next app launch)
    @Published var windowSize: String { didSet { ConfigFile.set("windowSize", windowSize) } }
    @Published var displayDpi: Int { didSet { ConfigFile.set("displayDpi", displayDpi) } }

    // sharing (persisted; applied to the next app launch)
    @Published var shareClipboard: Bool { didSet { ConfigFile.setBool("shareClipboard", shareClipboard) } }
    @Published var shareAudio: Bool { didSet { ConfigFile.setBool("shareAudio", shareAudio) } }

    @Published var updateStatus: String? = nil

    // general
    @Published var cfg = RDConfig.load()
    @Published var advanced: Bool
    @Published var menubarIcon: String

    // first-run setup
    @Published var setupPhase: SetupPhase? = nil
    @Published var setupEdition: String = ConfigFile.string("edition", "play")
    @Published var setupImage: String = ConfigFile.string("image", "")   // advanced: custom SDK image id
    @Published var licencesAccepted = false

    static let debugSetup = CommandLine.arguments.contains { $0.hasPrefix("--setup=") }
    private var timer: Timer?
    private var tick = 0
    private var statusInFlight = false
    private var statusWaiters: [(EmuStatus?) -> Void] = []
    private var diskInFlight = false
    let hostCores = ProcessInfo.processInfo.activeProcessorCount
    let hostRAMGB = Int(ProcessInfo.processInfo.physicalMemory / 1_073_741_824)

    private init() {
        cores = ConfigFile.int("vmCpus", 4)
        ramGB = ConfigFile.int("vmRamGB", 4)
        diskGB = ConfigFile.int("vmDiskGB", 16)
        windowSize = ConfigFile.string("windowSize", "1280x800")
        displayDpi = ConfigFile.int("displayDpi", 240)
        shareClipboard = ConfigFile.bool("shareClipboard", true)
        shareAudio = ConfigFile.bool("shareAudio", true)
        let c = RDConfig.load()
        advanced = c.advanced == "on"
        menubarIcon = c.menubarIcon
        // Debug aids for visual checks: --screen=<Screen rawValue>,
        // --setup=welcome|customize|installing|done|failed
        for a in CommandLine.arguments {
            if a.hasPrefix("--screen="), let s = Screen(rawValue: String(a.dropFirst(9))) { screen = s }
            if a.hasPrefix("--setup=") {
                switch a.dropFirst(8) {
                case "welcome": setupPhase = .welcome
                case "customize": setupPhase = .customize
                case "installing": setupPhase = .installing(pct: 47, title: "Downloading the system image…")
                case "done": setupPhase = .done(apps: 18)
                case "failed": setupPhase = .failed("The emulator didn't finish booting.")
                default: break
                }
            }
        }
    }

    // ---------- polling ----------

    func start() {
        guard timer == nil else { return }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func stop() { timer?.invalidate(); timer = nil }

    /// The AVD folder: the CLI's answer when known, else `<vmDir>/avd`.
    var avdHome: String { cfg.vmDir + "/avd" }

    /// An AVD exists when the CLI says so, or (before its first answer, and fast enough for launch) when
    /// the AVD folder holds one. An edition switch moves the old AVD to <vmDir>/kept/<edition>/ (or
    /// deletes it) before it creates the new one, so mid-switch this is false: refresh() checks
    /// ToolsStore.switching for that. A kept AVD isn't counted: it's not the edition Android runs, and
    /// after a failed switch the setup screen is the way to create the current edition's AVD.
    func avdOnDisk() -> Bool {
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: avdHome)) ?? []
        return entries.contains { $0.hasSuffix(".avd") }
    }

    func refresh() {
        tick += 1
        cfg = RDConfig.load()
        advanced = cfg.advanced == "on"
        menubarIcon = cfg.menubarIcon
        vmExists = (status?.exists ?? false) || avdOnDisk()
        // Mid-removal the progress stays up until it finishes; mid-switch the old AVD is gone until the
        // new one is created, and a second setup must not start alongside the switch's own.
        let busyElsewhere = ToolsStore.shared.removePct != nil || ToolsStore.shared.storageBusy != nil || ToolsStore.shared.switching
        if !vmExists && setupPhase == nil && !busyElsewhere {
            setupEdition = ConfigFile.string("edition", setupEdition)   // a failed switch leaves the new edition configured
            setupPhase = .welcome
        }
        if vmExists, !Self.debugSetup, case .welcome? = setupPhase { setupPhase = nil }

        if tick % 3 == 1 { apps = listApps(cfg) }
        running = runningAppNames(cfg)
        fetchStatus(nil)
        if tick % 10 == 1 { measureDisk() }
    }

    /// Runs `status --json` (one at a time; callers that arrive meanwhile get the same answer) and
    /// publishes the result. done(nil) when the CLI is missing or printed no JSON.
    func fetchStatus(_ done: ((EmuStatus?) -> Void)?) {
        if let done { statusWaiters.append(done) }
        guard !statusInFlight else { return }
        statusInFlight = true
        runCLI(["status", "--json"]) { [weak self] _, text in
            guard let self else { return }
            self.statusInFlight = false
            let s = (lastJSON(text) as? [String: Any]).map(EmuStatus.init)
            self.apply(s)
            let waiters = self.statusWaiters
            self.statusWaiters = []
            waiters.forEach { $0(s) }
        }
    }

    private func apply(_ s: EmuStatus?) {
        status = s
        let online = s?.online ?? false
        vmOnline = online
        vmRunning = s?.running ?? false
        vmPaused = s?.paused ?? false
        if let s, s.exists || avdOnDisk() { vmExists = true }
        if busy == "Starting…" && online { busy = nil }
        if busy == "Stopping…" && !(s?.running ?? false) { busy = nil }
        cpu = online ? (s?.guestCPU(cores: cores) ?? 0) : 0
        ramUsedMB = online ? (s?.ramMB ?? 0) : 0
        ramTotalMB = s?.ramTotalMB ?? 0      // only when the CLI reports a guest total; ramMB alone is the Mac process
        guard let s else {
            health = [HealthRow(title: "\(Product.name) command-line tool", detail: "not found", ok: false)]
            return
        }
        let emuInstalled = s.emulator.ok || s.running
        let emuDetail = !emuInstalled ? "not installed"
            : s.paused ? "paused" : s.running ? (s.booted ? (s.serial.isEmpty ? cfg.serial : s.serial) : "booting…") : "\(Product.os) is off"
        // adb and the helper can only be checked inside a running Android: while it's off (or still
        // booting) their fields are false / null, which says nothing about the install.
        let off = "checked when \(Product.os) runs"
        health = [
            HealthRow(title: "Emulator", detail: emuDetail, ok: s.online),
            HealthRow(title: "Android Debug Bridge (adb)", detail: s.online ? (s.adb.ok ? "connected" : "not connected") : off, ok: s.online && s.adb.ok),
            HealthRow(title: "Helper app", detail: s.online ? (s.helper.ok ? "installed" : "not installed") : off, ok: s.online && s.helper.ok),
            HealthRow(title: "App windows (scrcpy)", detail: s.scrcpy.detail, ok: s.scrcpy.ok),
        ]
    }

    /// How much space the AVD takes (sparse images count by allocated size), off the main thread.
    private func measureDisk() {
        guard !diskInFlight else { return }
        diskInFlight = true
        let dir = (status?.avdDir).flatMap { $0.isEmpty ? nil : $0 } ?? avdHome
        let total = Double(diskGB)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var bytes: Int64 = 0
            if let e = FileManager.default.enumerator(at: URL(fileURLWithPath: dir), includingPropertiesForKeys: [.totalFileAllocatedSizeKey]) {
                for case let u as URL in e {
                    bytes += Int64((try? u.resourceValues(forKeys: [.totalFileAllocatedSizeKey]))?.totalFileAllocatedSize ?? 0)
                }
            }
            DispatchQueue.main.async {
                self?.diskInFlight = false
                self?.diskUsedGB = Double(bytes) / 1_073_741_824
                self?.diskTotalGB = total
            }
        }
    }

    // ---------- apps ----------

    func listApps(_ c: RDConfig) -> [AndroidApp] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: c.appsDir) else { return [] }
        return entries
            .filter { $0.hasSuffix(".app") && $0 != Product.desktopApp + ".app" }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
            .map { entry in
                let dir = c.appsDir + "/" + entry
                var pkg = ""
                if let d = fm.contents(atPath: dir + "/Contents/Resources/app.json"),
                   let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
                    pkg = ((j["package"] ?? j["Package"]) as? String) ?? ""
                }
                return AndroidApp(id: dir, name: String(entry.dropLast(4)), package: pkg)
            }
    }

    /// Names of launchers whose app window (scrcpy, run from inside the launcher bundle) is alive.
    func runningAppNames(_ c: RDConfig) -> Set<String> {
        var names = Set<String>()
        for app in NSWorkspace.shared.runningApplications {
            guard let url = app.bundleURL, url.path.hasPrefix(c.appsDir + "/") else { continue }
            names.insert(url.deletingPathExtension().lastPathComponent)
        }
        return names
    }

    func filteredApps() -> [AndroidApp] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return q.isEmpty ? apps : apps.filter { $0.name.lowercased().contains(q) }
    }

    func launch(_ app: AndroidApp) {
        NSWorkspace.shared.open(URL(fileURLWithPath: app.path))
    }

    func quit(_ app: AndroidApp) {
        NSWorkspace.shared.runningApplications
            .filter { $0.bundleURL?.path == app.path }
            .forEach { $0.terminate() }
    }

    func icon(for app: AndroidApp) -> NSImage { NSWorkspace.shared.icon(forFile: app.path) }

    // ---------- actions ----------

    /// The one way to run `sync` (menu, window, after installs): `sync` has no lock in the CLI and two
    /// runs would share the helper's export folder inside Android.
    func syncApps(notifyDone: Bool = false) {
        guard !syncing else { return }
        syncing = true
        runCLI(["sync"]) { [weak self] status, text in
            self?.syncing = false
            self?.refresh()
            self?.delegate?.poll()
            if status != 0 { self?.delegate?.notify("Sync failed: " + lastLine(text, or: "is \(Product.os) running?")) }
            else if notifyDone { self?.delegate?.notify("App list synced.") }
        }
    }

    func startAndroid() {
        let resume = vmPaused
        busy = "Starting…"
        runCLI(["vm", resume ? "resume" : "start"]) { [weak self] status, text in
            self?.busy = nil; self?.refresh()
            if status != 0 { self?.delegate?.notify("Couldn't start \(Product.os): " + lastLine(text, or: "see Setup Check in General.")) }
        }
    }

    func stopAndroid() {
        busy = "Stopping…"
        runCLI(["vm", "stop"]) { [weak self] _, _ in self?.busy = nil; self?.refresh() }
    }

    func restartAndroid() {
        busy = "Restarting…"
        runCLI(["vm", "stop"]) { [weak self] _, _ in
            runCLI(["vm", "start"]) { _, _ in self?.busy = nil; self?.refresh() }
        }
    }

    func openDesktop() { delegate?.openDesktop() }

    // ---------- snapshots ----------

    func loadSnapshots() {
        runCLI(["vm", "snapshots", "--json"]) { [weak self] status, text in
            guard status == 0, let arr = lastJSON(text) as? [[String: Any]] else { return }
            self?.snapshots = arr.compactMap { d in
                guard let n = d["name"] as? String else { return nil }
                return SnapshotItem(name: n, date: Self.date(d["date"]))
            }.sorted { $0.date > $1.date }
        }
    }

    /// Snapshot dates arrive as epoch milliseconds (like dinghy), epoch seconds, or an ISO 8601 string.
    static func date(_ v: Any?) -> Date {
        if let n = v as? NSNumber {
            let x = n.doubleValue
            return Date(timeIntervalSince1970: x > 100_000_000_000 ? x / 1000 : x)
        }
        if let s = v as? String {
            let f = ISO8601DateFormatter()
            if let d = f.date(from: s) { return d }
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: s) { return d }
        }
        return Date(timeIntervalSince1970: 0)
    }

    private func snapshotOp(_ args: [String], fail: String) {
        snapshotBusy = true; snapshotMessage = nil
        runCLI(args) { [weak self] status, text in
            self?.snapshotBusy = false
            if status != 0 { self?.snapshotMessage = fail + ": " + lastLine(text, or: "is \(Product.os) running?") }
            self?.loadSnapshots()
            self?.refresh()
        }
    }

    func takeSnapshot(_ name: String) {
        snapshotOp(name.isEmpty ? ["vm", "snapshot"] : ["vm", "snapshot", name], fail: "Couldn't take the snapshot")
    }

    func rewind(_ name: String) { snapshotOp(["vm", "rewind", name, "--yes"], fail: "Couldn't rewind") }

    func deleteSnapshot(_ name: String) { snapshotOp(["vm", "snapshot-delete", name], fail: "Couldn't delete it") }

    // ---------- first-run setup ----------

    /// Runs `robodinghy setup --progress --accept-licences …` and turns its PROGRESS lines into the setup screen.
    func beginSetup() {
        guard roboCLI.resolve() != nil else {
            setupPhase = .failed("Can't find node or the \(Product.cli) command-line tool. Run `\(Product.cli) setup` in a terminal instead.")
            return
        }
        guard licencesAccepted else { setupPhase = .welcome; return }
        // An edition switch runs its own setup in the output window; two would race on the SDK and AVD.
        guard !ToolsStore.shared.switching else { delegate?.runWindow?.show(); return }
        setupPhase = .installing(pct: 1, title: "Preparing…")
        var args = ["setup", "--progress", "--accept-licences", "--edition", setupEdition,
                    "--ram", "\(ramGB * 1024)", "--cpus", "\(cores)", "--disk", "\(diskGB)"]
        let image = setupImage.trimmingCharacters(in: .whitespaces)
        if advanced && !image.isEmpty { args += ["--image", image] }
        // onLine runs on the pipe's reader thread and done on main: keep the tail behind a lock.
        let lock = NSLock()
        var tail: [String] = []
        let err = roboCLI.progress(args, onProgress: { [weak self] pct, title in
            self?.setupPhase = .installing(pct: pct, title: title)
        }, onLine: { line in
            lock.lock(); tail.append(line); if tail.count > 8 { tail.removeFirst() }; lock.unlock()
        }, done: { [weak self] status in
            guard let self else { return }
            lock.lock(); let lines = tail; lock.unlock()
            if status == 0 {
                self.refresh()
                self.apps = self.listApps(self.cfg)
                self.setupPhase = .done(apps: self.apps.count)
            } else {
                let why = lines.last { $0.hasPrefix("LICENCE:") } ?? lines.last { $0.hasPrefix("Error:") }
                self.setupPhase = .failed(why ?? lines.suffix(3).joined(separator: "\n"))
            }
        })
        if let err { setupPhase = .failed(err.localizedDescription) }
    }
}
