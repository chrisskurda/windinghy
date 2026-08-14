// WinDinghy menu-bar app: ambient VM status + app picker + sync + setup check.
// Built by build.sh into ~/Applications/WinBoat.app (LSUIElement, no dock icon).
import AppKit
import ServiceManagement

// ---------- config (shared with wbm) ----------

struct WBConfig {
    var host = "192.168.64.8"
    var apiPort = 7148
    var rdpPort = 3389
    var vmName = "Windows"
    var username = ""
    var promptcreds = "on"
    var appsDir = NSString(string: "~/Applications/WinBoat").expandingTildeInPath

    static let path = NSString(string: "~/.config/winboat-mac/config.json").expandingTildeInPath

    static func load() -> WBConfig {
        var c = WBConfig()
        guard let data = FileManager.default.contents(atPath: path),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return c }
        if let v = json["host"] as? String, !v.isEmpty { c.host = v }
        if let v = json["apiPort"] as? Int { c.apiPort = v }
        if let v = json["rdpPort"] as? Int { c.rdpPort = v }
        if let v = json["vmName"] as? String, !v.isEmpty { c.vmName = v }
        if let v = json["username"] as? String { c.username = v }
        if let v = json["promptcreds"] as? String, !v.isEmpty { c.promptcreds = v }
        if let v = json["appsDir"] as? String, !v.isEmpty { c.appsDir = v }
        return c
    }

    // Read-modify-write a single key, preserving everything wbm has stored.
    static func update(_ key: String, _ value: Any) {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        var json = ((try? JSONSerialization.jsonObject(with: fm.contents(atPath: path) ?? Data())) as? [String: Any]) ?? [:]
        json[key] = value
        if let data = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }
}

func findNode() -> String? {
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if FileManager.default.isExecutableFile(atPath: p) { return p }
    }
    return nil
}

func findWbm() -> String? {
    if let env = ProcessInfo.processInfo.environment["WBM_PATH"] { return env }
    let candidates = [
        NSString(string: "~/winboat-mac/host/wbm.mjs").expandingTildeInPath,
        Bundle.main.bundlePath + "/Contents/Resources/wbm.mjs",
    ]
    return candidates.first { FileManager.default.fileExists(atPath: $0) }
}

func tcpOpen(host: String, port: Int, timeoutSec: Int32 = 3) -> Bool {
    let sock = socket(AF_INET, SOCK_STREAM, 0)
    if sock < 0 { return false }
    defer { close(sock) }
    var tv = timeval(tv_sec: __darwin_time_t(timeoutSec), tv_usec: 0)
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    guard inet_pton(AF_INET, host, &addr.sin_addr) == 1 else { return false }
    let res = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    return res == 0
}

// ---------- app delegate ----------

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSSearchFieldDelegate {
    var statusItem: NSStatusItem!
    let menu = NSMenu()
    var cfg = WBConfig.load()
    var online = false
    var metricsLine = ""
    var syncing = false
    var searchQuery = ""
    var searchField: NSSearchField?
    var searchItem: NSMenuItem?
    var currentAppItems: [NSMenuItem] = []

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            // Fallback chain: symbol names vary across macOS versions, and a
            // bad name silently yields nil (invisible icon).
            let img = NSImage(systemSymbolName: "macwindow.on.rectangle", accessibilityDescription: "WinDinghy")
                ?? NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: "WinDinghy")
                ?? NSImage(named: NSImage.computerName)
            img?.isTemplate = true
            btn.image = img
            btn.imagePosition = .imageLeft
        }
        menu.delegate = self
        statusItem.menu = menu
        poll()
        updateBadge()
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.poll() }
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.updateBadge() }
    }

    // ---------- guest polling ----------

    func fetchJSON(_ route: String, timeout: TimeInterval = 4, done: @escaping ([String: Any]?) -> Void) {
        guard let url = URL(string: "http://\(cfg.host):\(cfg.apiPort)\(route)") else { done(nil); return }
        var req = URLRequest(url: url); req.timeoutInterval = timeout
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            var result: [String: Any]? = nil
            if let data, (resp as? HTTPURLResponse)?.statusCode == 200 {
                result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            }
            DispatchQueue.main.async { done(result) }
        }.resume()
    }

    func poll() {
        cfg = WBConfig.load()  // pick up wbm's self-repaired host
        fetchJSON("/health") { [weak self] health in
            guard let self else { return }
            self.online = health?["status"] as? String == "ok"
            self.updateBadge()
            if self.online {
                self.fetchJSON("/metrics") { [weak self] m in
                    guard let self, let m else { return }
                    let cpu = (m["cpu"] as? [String: Any])?["usage"] as? Double ?? 0
                    let ram = m["ram"] as? [String: Any]
                    let used = Double(ram?["used"] as? Int ?? 0) / 1024
                    let total = Double(ram?["total"] as? Int ?? 0) / 1024
                    self.metricsLine = String(format: "CPU %.0f%%  ·  RAM %.1f / %.1f GB", cpu, used, total)
                }
            } else {
                self.metricsLine = ""
            }
        }
    }

    // ---------- running RemoteApp windows ----------

    func remoteAppWindows() -> [String] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        var titles: [String] = []
        for w in list {
            guard w[kCGWindowOwnerName as String] as? String == "Windows App",
                  (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
            let title = w[kCGWindowName as String] as? String ?? ""
            if title == "Windows App" || title == "Devices" { continue }
            titles.append(title)
        }
        return titles
    }

    // Always-visible status: green dot = guest agent up and ready, dim dot =
    // down. Window count appended only when RemoteApp windows are open.
    func updateBadge() {
        guard let btn = statusItem.button else { return }
        let count = remoteAppWindows().count
        let text = count > 0 ? " ●\u{2009}\(count)" : " ●"
        let attr = NSMutableAttributedString(string: text)
        let full = NSRange(location: 0, length: attr.length)
        attr.addAttribute(.font, value: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium), range: full)
        let dotRange = NSRange(location: 1, length: 1)
        attr.addAttribute(.foregroundColor, value: online ? NSColor.systemGreen : NSColor.tertiaryLabelColor, range: dotRange)
        attr.addAttribute(.font, value: NSFont.systemFont(ofSize: 9), range: dotRange)
        attr.addAttribute(.baselineOffset, value: 1.5, range: dotRange)
        btn.attributedTitle = attr
    }

    // ---------- app enumeration ----------

    struct AppEntry {
        let name: String
        let path: String
        let source: String
    }

    func listApps() -> [AppEntry] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: cfg.appsDir) else { return [] }
        return entries
            .filter { $0.hasSuffix(".app") && $0 != "Windows Desktop.app" }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
            .map { entry -> AppEntry in
                let full = cfg.appsDir + "/" + entry
                var source = ""
                let metaPath = full + "/Contents/Resources/app.json"
                if let data = fm.contents(atPath: metaPath),
                   let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                    source = (json["Source"] as? String ?? "").lowercased()
                }
                return AppEntry(name: String(entry.dropLast(4)), path: full, source: source)
            }
    }

    func usageCounts() -> [String: Int] {
        let path = NSString(string: "~/.config/winboat-mac/usage.json").expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: path),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Int] else { return [:] }
        return json
    }

    static let sourceLabels: [(key: String, label: String)] = [
        ("startmenu", "Start Menu"),
        ("system", "System"),
        ("winreg", "Programs"),
        ("registry", "Programs"),
        ("uwp", "Microsoft Store"),
        ("chocolatey", "Chocolatey"),
        ("choco", "Chocolatey"),
        ("scoop", "Scoop"),
        ("custom", "Custom"),
    ]

    // ---------- menu ----------

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu()
        poll()
        // Route typing to the search box instead of menu type-select
        DispatchQueue.main.async { [weak self] in
            guard let self, let field = self.searchField else { return }
            field.window?.makeFirstResponder(field)
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        searchQuery = ""
        searchField?.stringValue = ""
    }

    func rebuildMenu() {
        menu.removeAllItems()

        let status = NSMenuItem(title: online ? "Windows VM · online" : "Windows VM · offline", action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        if online && !metricsLine.isEmpty {
            let m = NSMenuItem(title: metricsLine, action: nil, keyEquivalent: "")
            m.isEnabled = false
            menu.addItem(m)
        }
        menu.addItem(.separator())

        let running = remoteAppWindows()
        if !running.isEmpty {
            let header = NSMenuItem(title: "Running (\(running.count))", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            let titlesVisible = running.contains { !$0.isEmpty }
            if titlesVisible {
                for title in running where !title.isEmpty {
                    let item = NSMenuItem(title: "  " + title, action: #selector(focusWindowsApp), keyEquivalent: "")
                    item.target = self
                    menu.addItem(item)
                }
            } else {
                let hint = NSMenuItem(title: "  (grant Screen Recording to see titles)", action: nil, keyEquivalent: "")
                hint.isEnabled = false
                menu.addItem(hint)
            }
            menu.addItem(.separator())
        }

        menu.addItem(makeSearchItem())
        currentAppItems = appSectionItems()
        for item in currentAppItems { menu.addItem(item) }
        menu.addItem(.separator())

        if online {
            menu.addItem(makeItem("Open Windows Desktop", #selector(openDesktop), "d"))
            menu.addItem(makeItem(syncing ? "Syncing…" : "Sync Apps Now", #selector(runSync), "s", enabled: !syncing))
            menu.addItem(makeItem("Restart Windows VM", #selector(restartVM), ""))
        } else {
            menu.addItem(makeItem("Start Windows VM", #selector(startVM), "b"))
        }
        menu.addItem(.separator())

        let userTitle = cfg.username.isEmpty ? "Set Windows Username…" : "Windows Username: \(cfg.username)…"
        menu.addItem(makeItem(userTitle, #selector(setUsername), ""))
        let promptItem = makeItem("Ask for Password on Launch", #selector(togglePromptCreds), "")
        promptItem.state = cfg.promptcreds != "off" ? .on : .off
        menu.addItem(promptItem)
        menu.addItem(makeItem("Setup Check…", #selector(setupCheck), ""))
        let login = makeItem("Start at Login", #selector(toggleLogin), "")
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(makeItem("Open Apps Folder", #selector(openFolder), ""))
        let quit = NSMenuItem(title: "Quit WinDinghy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        menu.addItem(quit)
    }

    // Search field lives in ONE persistent view; rebuilding it per keystroke
    // would drop keyboard focus.
    func makeSearchItem() -> NSMenuItem {
        if let item = searchItem { return item }
        let field = NSSearchField(frame: NSRect(x: 12, y: 1, width: 212, height: 26))
        field.placeholderString = "Search Windows apps"
        field.delegate = self
        field.sendsSearchStringImmediately = true
        let wrapper = NSView(frame: NSRect(x: 0, y: 0, width: 236, height: 28))
        wrapper.addSubview(field)
        let item = NSMenuItem()
        item.view = wrapper
        searchField = field
        searchItem = item
        return item
    }

    func appSectionItems() -> [NSMenuItem] {
        let apps = listApps()
        var items: [NSMenuItem] = []

        if !searchQuery.isEmpty {
            let q = searchQuery.lowercased()
            let hits = apps.filter { $0.name.lowercased().contains(q) }.prefix(20)
            if hits.isEmpty {
                let none = NSMenuItem(title: "No matches", action: nil, keyEquivalent: "")
                none.isEnabled = false
                items.append(none)
            }
            for app in hits { items.append(appItem(app)) }
            return items
        }

        // Favorites: top launched apps
        let usage = usageCounts()
        let favs = apps
            .filter { (usage[$0.name] ?? 0) > 0 }
            .sorted { (usage[$0.name] ?? 0) > (usage[$1.name] ?? 0) }
            .prefix(5)
        if !favs.isEmpty {
            let header = NSMenuItem(title: "Favorites", action: nil, keyEquivalent: "")
            header.isEnabled = false
            items.append(header)
            for app in favs { items.append(appItem(app)) }
        }

        // All apps grouped by source category
        let allItem = NSMenuItem(title: "All Apps", action: nil, keyEquivalent: "")
        let allSub = NSMenu()
        var grouped: [String: [AppEntry]] = [:]
        for app in apps { grouped[app.source, default: []].append(app) }
        var placedKeys = Set<String>()
        for (key, label) in Self.sourceLabels {
            guard let group = grouped[key], !group.isEmpty, !placedKeys.contains(key) else { continue }
            placedKeys.insert(key)
            let catItem = NSMenuItem(title: "\(label) (\(group.count))", action: nil, keyEquivalent: "")
            let catSub = NSMenu()
            for app in group { catSub.addItem(appItem(app)) }
            catItem.submenu = catSub
            allSub.addItem(catItem)
        }
        let leftovers = grouped.filter { !placedKeys.contains($0.key) }.values.flatMap { $0 }
        if !leftovers.isEmpty {
            let catItem = NSMenuItem(title: "Other (\(leftovers.count))", action: nil, keyEquivalent: "")
            let catSub = NSMenu()
            for app in leftovers.sorted(by: { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) {
                catSub.addItem(appItem(app))
            }
            catItem.submenu = catSub
            allSub.addItem(catItem)
        }
        allItem.submenu = allSub
        items.append(allItem)
        return items
    }

    // Swap only the rows under the search field, leaving the field untouched
    // so it keeps keyboard focus while the user types.
    func updateAppSection() {
        guard let sItem = searchItem, menu.index(of: sItem) >= 0 else { return }
        for item in currentAppItems where menu.index(of: item) >= 0 {
            menu.removeItem(item)
        }
        currentAppItems = appSectionItems()
        var idx = menu.index(of: sItem) + 1
        for item in currentAppItems {
            menu.insertItem(item, at: idx)
            idx += 1
        }
    }

    func appItem(_ app: AppEntry) -> NSMenuItem {
        let item = NSMenuItem(title: app.name, action: #selector(launchApp(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = app.path
        let icon = NSWorkspace.shared.icon(forFile: app.path)
        icon.size = NSSize(width: 16, height: 16)
        item.image = icon
        return item
    }

    func makeItem(_ title: String, _ action: Selector, _ key: String, enabled: Bool = true) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: enabled ? action : nil, keyEquivalent: key)
        item.target = self
        return item
    }

    // Live search: only the result rows change; the field keeps focus.
    func controlTextDidChange(_ obj: Notification) {
        guard let field = obj.object as? NSSearchField else { return }
        searchQuery = field.stringValue
        updateAppSection()
    }

    // ---------- actions ----------

    @objc func launchApp(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: .init())
    }

    @objc func openDesktop() {
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: cfg.appsDir + "/Windows Desktop.app"), configuration: .init())
    }

    @objc func focusWindowsApp() {
        if let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == "Windows App" }) {
            app.activate()
        }
    }

    @objc func openFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: cfg.appsDir))
    }

    // Start the VM via utmctl, but tell the truth about the outcome: utmctl
    // can hang on automation-permission prompts or fail on a wedged VM, so run
    // it async with a timeout and report via notification.
    @objc func startVM() {
        let utmctl = "/Applications/UTM.app/Contents/MacOS/utmctl"
        guard FileManager.default.isExecutableFile(atPath: utmctl) else {
            notify("UTM not found at /Applications/UTM.app")
            return
        }
        notify("Starting Windows VM \"\(cfg.vmName)\"…")
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: utmctl)
            p.arguments = ["start", self.cfg.vmName]
            let errPipe = Pipe()
            p.standardError = errPipe
            p.standardOutput = Pipe()
            do { try p.run() } catch {
                DispatchQueue.main.async { self.notify("Couldn't run utmctl: \(error.localizedDescription)") }
                return
            }
            // Wait up to 20s for utmctl itself (it returns once the VM begins booting)
            let deadline = Date().addingTimeInterval(20)
            while p.isRunning && Date() < deadline { usleep(300_000) }
            if p.isRunning {
                p.terminate()
                DispatchQueue.main.async {
                    self.notify("utmctl didn't respond — it may need automation permission, or the VM is in a bad state. Opening UTM so you can start it manually.")
                    NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/UTM.app"))
                }
                return
            }
            let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            let errStr = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            DispatchQueue.main.async {
                if p.terminationStatus == 0 {
                    self.notify("VM \"\(self.cfg.vmName)\" is booting — apps will work in a minute or two.")
                } else {
                    let reason = errStr.isEmpty ? "exit code \(p.terminationStatus)" : errStr
                    self.notify("Couldn't start the VM (\(reason)). Opening UTM so you can start it manually.")
                    NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/UTM.app"))
                }
            }
        }
    }

    // Recovery for wedged guest states (e.g. RDP security errors like 0x1807
    // that persist regardless of credentials): graceful shutdown, then boot.
    @objc func restartVM() {
        let utmctl = "/Applications/UTM.app/Contents/MacOS/utmctl"
        guard FileManager.default.isExecutableFile(atPath: utmctl) else {
            notify("UTM not found at /Applications/UTM.app")
            return
        }
        notify("Restarting VM \"\(cfg.vmName)\" — asking Windows to shut down…")
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            func run(_ args: [String], timeout: TimeInterval) -> Bool {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: utmctl)
                p.arguments = args
                p.standardOutput = Pipe(); p.standardError = Pipe()
                guard (try? p.run()) != nil else { return false }
                let deadline = Date().addingTimeInterval(timeout)
                while p.isRunning && Date() < deadline { usleep(300_000) }
                if p.isRunning { p.terminate(); return false }
                return p.terminationStatus == 0
            }
            _ = run(["stop", "--request", self.cfg.vmName], timeout: 15)
            // Wait for the guest agent to actually go away (up to 90s)
            let downDeadline = Date().addingTimeInterval(90)
            var isDown = false
            while Date() < downDeadline {
                if !tcpOpen(host: self.cfg.host, port: self.cfg.apiPort, timeoutSec: 2) { isDown = true; break }
                sleep(3)
            }
            if !isDown {
                // Graceful request ignored; force it
                DispatchQueue.main.async { self.notify("Windows didn't shut down gracefully — forcing stop.") }
                _ = run(["stop", "--force", self.cfg.vmName], timeout: 20)
                sleep(3)
            }
            let started = run(["start", self.cfg.vmName], timeout: 20)
            DispatchQueue.main.async {
                self.notify(started ? "VM restarting — back in a minute or two."
                                    : "Couldn't restart automatically — opening UTM.")
                if !started { NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/UTM.app")) }
            }
        }
    }

    @objc func runSync() {
        guard let node = findNode(), let wbm = findWbm() else {
            notify("Can't find node or wbm.mjs — run wbm sync from a terminal instead.")
            return
        }
        syncing = true
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [wbm, "sync"]
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                self?.syncing = false
                self?.notify(proc.terminationStatus == 0 ? "App list synced." : "Sync failed — run wbm sync in a terminal for details.")
            }
        }
        try? p.run()
    }

    // ---------- setup check ----------

    @objc func setupCheck() {
        cfg = WBConfig.load()
        let c = cfg
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let fm = FileManager.default
            var lines: [String] = []
            var advice: [String] = []

            func check(_ ok: Bool, _ label: String, _ fix: String) {
                lines.append("\(ok ? "✓" : "✗")  \(label)")
                if !ok { advice.append("• " + fix) }
            }

            check(fm.fileExists(atPath: "/Applications/Windows App.app"), "Windows App installed",
                  "Install \"Windows App\" from the Mac App Store — it renders the RemoteApp windows.")
            check(fm.fileExists(atPath: "/Applications/UTM.app"), "UTM installed",
                  "Install UTM from https://mac.getutm.app — it runs the Windows VM.")
            check(findNode() != nil, "Node.js available",
                  "Install node (brew install node) — the launchers use it to find the VM.")
            check(findWbm() != nil, "wbm CLI found",
                  "Keep the winboat-mac folder at ~/winboat-mac, or set WBM_PATH.")

            var apiOk = false
            var skewSec: Double? = nil
            let sem = DispatchSemaphore(value: 0)
            var req = URLRequest(url: URL(string: "http://\(c.host):\(c.apiPort)/health")!)
            req.timeoutInterval = 3
            URLSession.shared.dataTask(with: req) { _, resp, _ in
                if let http = resp as? HTTPURLResponse {
                    apiOk = http.statusCode == 200
                    if let dateStr = http.value(forHTTPHeaderField: "Date") {
                        let fmt = DateFormatter()
                        fmt.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
                        fmt.locale = Locale(identifier: "en_US_POSIX")
                        if let guestDate = fmt.date(from: dateStr) {
                            skewSec = abs(guestDate.timeIntervalSinceNow)
                        }
                    }
                }
                sem.signal()
            }.resume()
            _ = sem.wait(timeout: .now() + 4)
            check(apiOk, "Guest agent reachable (\(c.host):\(c.apiPort))",
                  "Start the VM in UTM. If the agent was never installed: run `./wbm serve-setup` in Terminal, then inside Windows open PowerShell as Administrator and paste the one-liner it prints.")
            if apiOk, let skew = skewSec {
                check(skew < 120, "Guest clock skew \(Int(skew))s",
                      "Guest clock drifted — RDP will fail with security errors (0x1807). In the VM run `w32tm /resync`, or restart the VM. Re-running the setup one-liner installs an automatic 15-minute sync.")
            }

            let rdpOk = tcpOpen(host: c.host, port: c.rdpPort)
            check(rdpOk, "RDP reachable (\(c.host):\(c.rdpPort))",
                  "Windows isn't accepting RDP — re-run the serve-setup one-liner inside the VM (requires Windows Pro/Enterprise, not Home).")

            let launcherCount = ((try? fm.contentsOfDirectory(atPath: c.appsDir)) ?? []).filter { $0.hasSuffix(".app") }.count
            check(launcherCount > 0, "\(launcherCount) app launchers synced",
                  "Run Sync Apps Now from this menu (VM must be online).")

            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = advice.isEmpty ? "WinBoat is fully set up" : "WinBoat setup needs attention"
                var body = lines.joined(separator: "\n")
                if !advice.isEmpty {
                    body += "\n\nWhat to do:\n" + advice.joined(separator: "\n")
                }
                alert.informativeText = body
                alert.alertStyle = advice.isEmpty ? .informational : .warning
                alert.addButton(withTitle: "OK")
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
        }
    }

    @objc func setUsername() {
        let alert = NSAlert()
        alert.messageText = "Windows Username"
        alert.informativeText = "Pre-fills the username on RDP connections.\nFormats: user, DOMAIN\\user, or user@domain.\nLeave empty to disable pre-fill."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = cfg.username
        field.placeholderString = "user@domain"
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            WBConfig.update("username", field.stringValue.trimmingCharacters(in: .whitespaces))
            cfg = WBConfig.load()
            notify(cfg.username.isEmpty ? "Username pre-fill disabled." : "Username set to \(cfg.username) — takes effect on next launch.")
        }
    }

    @objc func togglePromptCreds() {
        let newVal = cfg.promptcreds != "off" ? "off" : "on"
        WBConfig.update("promptcreds", newVal)
        cfg = WBConfig.load()
        notify(newVal == "off" ? "Launches will connect silently with saved credentials."
                               : "Launches will ask for the password.")
    }

    @objc func toggleLogin() {
        if SMAppService.mainApp.status == .enabled {
            try? SMAppService.mainApp.unregister()
        } else {
            try? SMAppService.mainApp.register()
        }
    }

    func notify(_ msg: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", "display notification \(jsonEscape(msg)) with title \"WinBoat\""]
        try? p.run()
    }

    func jsonEscape(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        let str = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(str.dropFirst(1).dropLast(1))
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
