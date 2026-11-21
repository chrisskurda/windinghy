// Shared state for the WinDinghy main window (SwiftUI). One store, observed by the window; the
// menu-bar controller (AppDelegate in main.swift) sets itself as `delegate` for the actions that
// need its machinery (starting the VM, the progress window, ...).
import SwiftUI
import AppKit

enum Screen: String, CaseIterable, Identifiable {
    case apps, desktop, tools, software
    case account, enterprise
    case machine, resources, sharing, snapshots, storage
    case general
    var id: String { rawValue }
    var title: String {
        switch self {
        case .apps: return "Apps"
        case .desktop: return "Windows Desktop"
        case .tools: return "Windows Tools"
        case .software: return "Software"
        case .account: return "Account & Activation"
        case .enterprise: return "Work & School"
        case .machine: return "Windows"
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
        case .tools: return "wrench.and.screwdriver"
        case .software: return "shippingbox"
        case .account: return "person.crop.circle.badge.checkmark"
        case .enterprise: return "building.2"
        case .machine: return "macwindow"
        case .resources: return "cpu"
        case .sharing: return "arrow.left.arrow.right"
        case .snapshots: return "clock.arrow.circlepath"
        case .storage: return "externaldrive"
        case .general: return "gearshape"
        }
    }
    /// Sidebar groups, in order (General sits alone at the bottom).
    static let sections: [(String, [Screen])] = [
        ("Apps", [.apps, .desktop, .tools, .software]),
        ("Windows", [.account, .enterprise]),
        ("Virtual Machine", [.machine, .resources, .sharing, .snapshots, .storage]),
    ]
}

struct WinApp: Identifiable, Hashable {
    let id: String      // full path of the generated .app
    let name: String
    var isTool = false
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

/// Read/write single keys of ~/.config/windinghy/config.json (shared with the dinghy CLI).
enum ConfigFile {
    static func dict() -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: WBConfig.path),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        return json
    }
    static func string(_ key: String, _ def: String) -> String { (dict()[key] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? def }
    static func int(_ key: String, _ def: Int) -> Int { (dict()[key] as? Int) ?? def }
    static func bool(_ key: String, _ def: Bool) -> Bool {
        guard let v = dict()[key] as? String else { return def }
        return v == "on"
    }
    static func set(_ key: String, _ value: Any) { WBConfig.update(key, value) }
    static func setBool(_ key: String, _ on: Bool) { WBConfig.update(key, on ? "on" : "off") }
}

final class AppStore: ObservableObject {
    static let shared = AppStore()
    weak var delegate: AppDelegate?

    // navigation
    @Published var screen: Screen = .apps
    @Published var query = ""

    // apps
    @Published var apps: [WinApp] = []
    @Published var running: Set<String> = []
    @Published var syncing = false

    // machine
    @Published var vmOnline = false
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

    // resources (persisted; applied the next time the VM starts)
    @Published var cores: Int { didSet { ConfigFile.set("vmCpus", cores) } }
    @Published var ramGB: Int { didSet { ConfigFile.set("vmRamGB", ramGB) } }
    @Published var diskGB: Int { didSet { ConfigFile.set("vmDiskGB", diskGB) } }

    // sharing (persisted; applied to the next app launch)
    @Published var shareClipboard: Bool { didSet { ConfigFile.setBool("shareClipboard", shareClipboard) } }
    @Published var shareHome: Bool { didSet { ConfigFile.setBool("shareHome", shareHome) } }
    @Published var sharePrinters: Bool { didSet { ConfigFile.setBool("sharePrinters", sharePrinters) } }
    @Published var shareAudio: Bool { didSet { ConfigFile.setBool("shareAudio", shareAudio) } }
    @Published var redirects: [String: Bool] = {
        var d: [String: Bool] = [:]
        for k in ["documents", "downloads", "desktop", "pictures", "music", "videos"] { d[k] = ConfigFile.bool("redirect_" + k, true) }
        return d
    }()
    @Published var updateStatus: String? = nil
    @Published var redirectDirty = false
    @Published var readOnly: Set<String> = Set((ConfigFile.dict()["readOnlyShares"] as? [String]) ?? [])
    func isReadOnly(_ share: String) -> Bool { readOnly.contains(share) }
    func setReadOnly(_ share: String, _ on: Bool) {
        if on { readOnly.insert(share) } else { readOnly.remove(share) }
        ConfigFile.set("readOnlyShares", Array(readOnly).sorted())
    }
    @Published var folders: [String] { didSet { ConfigFile.set("sharedFolders", folders) } }

    // general
    @Published var cfg = WBConfig.load()
    @Published var advanced: Bool
    @Published var menubarIcon: String

    // first-run setup
    @Published var setupPhase: SetupPhase? = nil
    @Published var setupUser: String = NSUserName().filter { $0.isLetter || $0.isNumber || "._- ".contains($0) }
    @Published var setupISO: String? = nil   // nil = find in ~/Downloads

    static let debugSetup = CommandLine.arguments.contains { $0.hasPrefix("--setup=") }
    private var timer: Timer?
    private var tick = 0
    let hostCores = ProcessInfo.processInfo.activeProcessorCount
    let hostRAMGB = Int(ProcessInfo.processInfo.physicalMemory / 1_073_741_824)

    private init() {
        cores = ConfigFile.int("vmCpus", 4)
        ramGB = ConfigFile.int("vmRamGB", 6)
        diskGB = ConfigFile.int("vmDiskGB", 64)
        shareClipboard = ConfigFile.bool("shareClipboard", true)
        shareHome = ConfigFile.bool("shareHome", true)
        sharePrinters = ConfigFile.bool("sharePrinters", false)
        shareAudio = ConfigFile.bool("shareAudio", true)
        folders = (ConfigFile.dict()["sharedFolders"] as? [String]) ?? []
        let c = WBConfig.load()
        advanced = c.advanced == "on"
        menubarIcon = c.menubarIcon
        // Debug aids for visual checks: --screen=machine|resources|sharing|snapshots|general,
        // --setup=welcome|customize|installing|done|failed
        for a in CommandLine.arguments {
            if a.hasPrefix("--screen="), let s = Screen(rawValue: String(a.dropFirst(9))) { screen = s }
            if a.hasPrefix("--setup=") {
                switch a.dropFirst(8) {
                case "welcome": setupPhase = .welcome
                case "customize": setupPhase = .customize
                case "installing": setupPhase = .installing(pct: 47, title: "Installing Windows…")
                case "done": setupPhase = .done(apps: 74)
                case "failed": setupPhase = .failed("The VM stopped during installation.")
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

    func refresh() {
        tick += 1
        cfg = WBConfig.load()
        advanced = cfg.advanced == "on"
        menubarIcon = cfg.menubarIcon
        let c = cfg
        let fm = FileManager.default
        let managed = c.vmBackend == "qemu"
        let diskPath = NSString(string: "~/Library/Application Support/WinDinghy/vm/disk.qcow2").expandingTildeInPath
        // "No VM yet" means the first-run flow: no managed VM and nothing configured for another backend.
        vmExists = managed ? fm.fileExists(atPath: diskPath) : true
        if !vmExists && setupPhase == nil { setupPhase = .welcome }
        if vmExists, !Self.debugSetup, case .welcome? = setupPhase { setupPhase = nil }

        if tick % 3 == 1 { apps = listApps(c) }
        running = runningAppNames(c)

        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let health = self.fetch(c, "/health")
            let online = (health?["status"] as? String) == "ok"
            var cpu = 0.0, ru = 0.0, rt = 0.0, du = 0.0, dt = 0.0
            if online, let m = self.fetch(c, "/metrics") {
                cpu = ((m["cpu"] as? [String: Any])?["usage"] as? Double) ?? 0
                let ram = m["ram"] as? [String: Any]
                ru = Double(ram?["used"] as? Int ?? 0)
                rt = Double(ram?["total"] as? Int ?? 0)
                let disk = m["disk"] as? [String: Any]
                // The guest API reports megabytes for both RAM and disk (`dinghy status` divides disk by 1024).
                du = ((disk?["used"] as? Double) ?? Double(disk?["used"] as? Int ?? 0)) / 1024
                dt = ((disk?["total"] as? Double) ?? Double(disk?["total"] as? Int ?? 0)) / 1024
            }
            let rdp = tcpOpen(host: c.host, port: c.rdpPort, timeoutSec: 1)
            let rows = [
                HealthRow(title: "Guest agent", detail: ":\(c.apiPort)", ok: online),
                HealthRow(title: "Remote display (RDP)", detail: ":\(c.rdpPort)", ok: rdp),
                HealthRow(title: "RDP client installed", detail: Self.rdpClientDetail(), ok: Self.rdpClientDetail() != "missing"),
                HealthRow(title: "Network", detail: managed ? "Private · 127.0.0.1" : "Shared · \(c.host)", ok: online),
            ]
            DispatchQueue.main.async {
                self.vmOnline = online
                if self.busy == "Starting…" && online { self.busy = nil }
                if self.busy == "Stopping…" && !online { self.busy = nil }
                self.cpu = cpu; self.ramUsedMB = ru; self.ramTotalMB = rt; self.diskUsedGB = du; self.diskTotalGB = dt
                self.health = rows
            }
        }
    }

    private func fetch(_ c: WBConfig, _ route: String) -> [String: Any]? {
        guard let url = URL(string: "http://\(c.host):\(c.apiPort)\(route)") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        let sem = DispatchSemaphore(value: 0)
        var out: [String: Any]?
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let data, let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { out = j }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 3)
        return out
    }

    static func rdpClientDetail() -> String {
        let fm = FileManager.default
        if fm.isExecutableFile(atPath: (Bundle.main.resourcePath ?? "") + "/freerdp/bin/sdl-freerdp") { return "native (bundled)" }
        if fm.isExecutableFile(atPath: NSString(string: "~/windinghy/vendor/freerdp/bin/sdl-freerdp").expandingTildeInPath) { return "native" }
        if fm.fileExists(atPath: "/Applications/Windows App.app") { return "Windows App" }
        return "missing"
    }

    // ---------- apps ----------

    func listApps(_ c: WBConfig) -> [WinApp] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: c.appsDir) else { return [] }
        return entries
            .filter { $0.hasSuffix(".app") }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
            .map { entry in
                let dir = c.appsDir + "/" + entry
                var tool = false
                if let d = fm.contents(atPath: dir + "/Contents/Resources/app.json"),
                   let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] { tool = (j["Category"] as? String) == "tool" }
                return WinApp(id: dir, name: String(entry.dropLast(4)), isTool: tool)
            }
    }

    /// Names of launchers whose RDP client process is alive.
    func runningAppNames(_ c: WBConfig) -> Set<String> {
        var names = Set<String>()
        for app in NSWorkspace.shared.runningApplications {
            guard let url = app.bundleURL, url.path.hasPrefix(c.appsDir + "/") else { continue }
            names.insert(url.deletingPathExtension().lastPathComponent)
        }
        return names
    }

    func filteredApps(tools: Bool = false) -> [WinApp] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let pool = apps.filter { $0.isTool == tools }
        return q.isEmpty ? pool : pool.filter { $0.name.lowercased().contains(q) }
    }

    func launch(_ app: WinApp) {
        NSWorkspace.shared.open(URL(fileURLWithPath: app.path))
    }

    func quit(_ app: WinApp) {
        NSWorkspace.shared.runningApplications
            .filter { $0.bundleURL?.path == app.path }
            .forEach { $0.terminate() }
    }

    func icon(for app: WinApp) -> NSImage { NSWorkspace.shared.icon(forFile: app.path) }

    // ---------- actions ----------

    func syncApps() {
        guard !syncing else { return }
        syncing = true
        delegate?.runDinghyCapture(["sync"]) { [weak self] _, _ in
            self?.syncing = false
            self?.refresh()
        }
    }

    func startWindows() {
        busy = "Starting…"
        delegate?.runDinghyCapture(["vm", "start"]) { [weak self] _, _ in self?.busy = nil; self?.refresh() }
    }

    func stopWindows() {
        busy = "Stopping…"
        delegate?.runDinghyCapture(["vm", "stop"]) { [weak self] _, _ in self?.busy = nil; self?.refresh() }
    }

    func restartWindows() {
        busy = "Restarting…"
        delegate?.runDinghyCapture(["vm", "stop"]) { [weak self] _, _ in
            self?.delegate?.runDinghyCapture(["vm", "start"]) { _, _ in self?.busy = nil; self?.refresh() }
        }
    }

    func openDesktop() { delegate?.openDesktop() }

    // ---------- folder redirection ----------

    func setRedirect(_ key: String, _ on: Bool) {
        redirects[key] = on
        ConfigFile.setBool("redirect_" + key, on)
        redirectDirty = true
    }

    func applyRedirects() {
        redirectDirty = false
        delegate?.runDinghyCapture(["folders", "apply"]) { _, _ in }
    }

    // ---------- snapshots ----------

    func loadSnapshots() {
        delegate?.runDinghyCapture(["vm", "snapshots", "--json"]) { [weak self] status, text in
            guard status == 0, let data = text.data(using: .utf8),
                  let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return }
            self?.snapshots = arr.compactMap { d in
                guard let n = d["name"] as? String else { return nil }
                return SnapshotItem(name: n, date: Date(timeIntervalSince1970: ((d["date"] as? Double) ?? 0) / 1000))
            }.sorted { $0.date > $1.date }
        }
    }

    func takeSnapshot(_ name: String) {
        snapshotBusy = true
        delegate?.runDinghyCapture(name.isEmpty ? ["vm", "snapshot"] : ["vm", "snapshot", name]) { [weak self] _, _ in
            self?.snapshotBusy = false
            self?.loadSnapshots()
            self?.refresh()
        }
    }

    func rewind(_ name: String) {
        snapshotBusy = true
        delegate?.runDinghyCapture(["vm", "rewind", name, "--yes"]) { [weak self] _, _ in
            self?.snapshotBusy = false
            self?.refresh()
        }
    }

    // ---------- first-run setup ----------

    /// Start over with a fresh Windows. Reuses the current account name; optionally exports a safety copy first.
    func startReinstall(backup: Bool) {
        let u = (ConfigFile.string("username", "")).split(separator: "\\").last.map(String.init) ?? ""
        if !u.isEmpty { setupUser = u }
        reinstalling = true
        if backup {
            let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd-HHmm"
            reinstallBackup = NSHomeDirectory() + "/Desktop/WinDinghy-before-reinstall-\(f.string(from: Date())).windinghyvm"
        } else { reinstallBackup = nil }
        beginSetup()
    }

    func chooseISO() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.init(filenameExtension: "iso")].compactMap { $0 }
        panel.canChooseDirectories = false
        panel.message = "Choose a Windows 11 ARM64 installer (.iso)"
        if panel.runModal() == .OK { setupISO = panel.url?.path }
    }

    /// Runs `dinghy vm create --progress …` and turns its PROGRESS lines into the setup screen.
    var reinstallBackup: String? = nil   // set by Reinstall: export a safety copy first
    var reinstalling = false

    func beginSetup(allowUntested: Bool = false) {
        guard let node = findNode(), let dinghy = findDinghy() else {
            setupPhase = .failed("Can't find node or dinghy.mjs. Run `dinghy vm create` in a terminal instead.")
            return
        }
        setupPhase = .installing(pct: 1, title: "Preparing…")
        var args = reinstalling
            ? [dinghy, "vm", "reinstall", "--yes", "--progress"] + (reinstallBackup.map { ["--backup", $0] } ?? [])
            : [dinghy, "vm", "create", "--progress"]
        reinstalling = false   // a retry after a failure must create, not reinstall (the old VM is already gone)
        args += [ "--disk", "\(diskGB)", "--ram", "\(ramGB * 1024)", "--cpus", "\(cores)"]
        args += ["--user", setupUser.isEmpty ? "WinDinghy" : setupUser]
        if allowUntested { args.append("--allow-untested") }
        if let iso = setupISO { args += ["--iso", iso] }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = pipe
        var tail: [String] = []
        var buffer = ""
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            guard !d.isEmpty, let chunk = String(data: d, encoding: .utf8) else { return }
            buffer += chunk
            while let nl = buffer.firstIndex(of: "\n") {
                let line = String(buffer[buffer.startIndex..<nl])
                buffer = String(buffer[buffer.index(after: nl)...])
                if line.hasPrefix("PROGRESS:") {
                    let parts = line.dropFirst(9).split(separator: ":", maxSplits: 1).map(String.init)
                    if parts.count == 2, let pct = Double(parts[0]) {
                        DispatchQueue.main.async { self?.setupPhase = .installing(pct: pct, title: parts[1]) }
                    }
                } else if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                    tail.append(line); if tail.count > 6 { tail.removeFirst() }
                }
            }
        }
        p.terminationHandler = { [weak self] proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self else { return }
                if proc.terminationStatus == 0 {
                    self.refresh()
                    self.setupPhase = .done(apps: self.apps.count)
                } else {
                    self.setupPhase = .failed(tail.filter { $0.contains("UNTESTED") }.first ?? tail.suffix(3).joined(separator: "\n"))
                }
            }
        }
        do { try p.run() } catch { setupPhase = .failed(error.localizedDescription) }
    }
}

struct KnownFolder { let key: String; let label: String; let mac: String
    var share: String { key == "videos" ? "Movies" : mac }
    static let all = [
        KnownFolder(key: "documents", label: "Documents", mac: "Documents"),
        KnownFolder(key: "downloads", label: "Downloads", mac: "Downloads"),
        KnownFolder(key: "desktop", label: "Desktop", mac: "Desktop"),
        KnownFolder(key: "pictures", label: "Pictures", mac: "Pictures"),
        KnownFolder(key: "music", label: "Music", mac: "Music"),
        KnownFolder(key: "videos", label: "Videos", mac: "Movies"),
    ]
}
