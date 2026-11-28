// RoboDinghy menu-bar app (codename; identity in Product.swift): Android status, app picker, sync and
// the power lifecycle of the headless emulator. Built by build.sh (LSUIElement, no Dock icon until the
// main window opens). Every action goes through the `robodinghy` CLI; live status comes from
// `robodinghy status --json` (there is no guest HTTP API on Android).
import AppKit
import SwiftUI
import ServiceManagement

// ---------- config (shared with the CLI, which owns the schema) ----------

struct RDConfig {
    var edition = "play"          // play | aosp
    var image = ""                // advanced: a custom SDK system-image id (overrides edition)
    var apiLevel = "37.0"
    var consolePort = 5580
    var windowSize = "1280x800"
    var displayDpi = 240
    var videoCodec = "h264"
    var maxFps = 60
    var advanced = "off"
    var filter = "on"
    var menubarIcon = "boat"      // boat (the RoboDinghy dinghy) | symbol (an SF Symbol)
    var appsDir = NSString(string: Product.appsDir).expandingTildeInPath
    var vmDir = NSString(string: Product.vmDir).expandingTildeInPath

    static let file = JSONConfigFile(path: Product.configPath)

    var adbPort: Int { consolePort + 1 }
    var serial: String { "emulator-\(consolePort)" }

    static func load() -> RDConfig {
        var c = RDConfig()
        let json = file.dict()
        guard !json.isEmpty else { return c }
        if let v = json["edition"] as? String, !v.isEmpty { c.edition = v }
        if let v = json["image"] as? String { c.image = v }
        if let v = json["apiLevel"] as? String, !v.isEmpty { c.apiLevel = v }
        if let v = json["consolePort"] as? Int { c.consolePort = v }
        if let v = json["windowSize"] as? String, !v.isEmpty { c.windowSize = v }
        if let v = json["displayDpi"] as? Int { c.displayDpi = v }
        if let v = json["videoCodec"] as? String, !v.isEmpty { c.videoCodec = v }
        if let v = json["maxFps"] as? Int { c.maxFps = v }
        if let v = json["advanced"] as? String, !v.isEmpty { c.advanced = v }
        if let v = json["filter"] as? String, !v.isEmpty { c.filter = v }
        if let v = json["menubarIcon"] as? String, !v.isEmpty { c.menubarIcon = v }
        if let v = json["appsDir"] as? String, !v.isEmpty { c.appsDir = NSString(string: v).expandingTildeInPath }
        if let v = json["vmDir"] as? String, !v.isEmpty { c.vmDir = NSString(string: v).expandingTildeInPath }
        return c
    }

    static func update(_ key: String, _ value: Any) { file.set(key, value) }
}

// The robodinghy CLI (findNode, CLIRunner: host/common/swift/CLIRunner.swift): $ROBODINGHY_PATH, then the
// default checkout, then the copy bundled into Contents/Resources.
let roboCLI = CLIRunner(config: CLIConfig(
    scriptEnvVar: Product.scriptEnvVar,
    scriptCandidates: [
        NSString(string: Product.checkoutScript).expandingTildeInPath,
        Bundle.main.bundlePath + "/Contents/Resources/" + Product.bundledScript,
    ]))

/// Runs `robodinghy <args>` and hands back what it printed: stdout, then stderr. The CLI prints its
/// failures as `Error: <msg>` on stderr, so that line ends the text, where lastLine() finds it; JSON
/// results are still found by lastJSON(), which scans back to the last line that parses. Unlike
/// CLIRunner.capture it always calls back (status 127 when node or the CLI is missing), so callers'
/// busy flags can't get stuck.
func runCLI(_ args: [String], input: String? = nil, done: @escaping (Int32, String) -> Void) {
    guard let (node, script) = roboCLI.resolve() else {
        DispatchQueue.main.async { done(127, "Error: can't find node or the \(Product.cli) command-line tool") }
        return
    }
    let env = roboCLI.config.environment()
    DispatchQueue.global().async {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script] + args
        let out = Pipe(), err = Pipe(), inPipe = Pipe()
        p.standardOutput = out; p.standardError = err; p.standardInput = inPipe
        p.environment = env
        do { try p.run() } catch {
            DispatchQueue.main.async { done(1, "Error: couldn't run \(Product.cli): \(error.localizedDescription)") }
            return
        }
        if let input { inPipe.fileHandleForWriting.write(Data(input.utf8)) }
        try? inPipe.fileHandleForWriting.close()
        // Drain stderr on its own thread so neither pipe can fill up and stall the CLI.
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async { errData = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        p.waitUntilExit()
        var text = String(data: outData, encoding: .utf8) ?? ""
        let errText = String(data: errData, encoding: .utf8) ?? ""
        if !errText.isEmpty {
            if !text.isEmpty && !text.hasSuffix("\n") { text += "\n" }
            text += errText
        }
        DispatchQueue.main.async { done(p.terminationStatus, text) }
    }
}

/// The last line of CLI output, for showing why something failed (`Error: …` prefix dropped).
func lastLine(_ text: String, or fallback: String) -> String {
    let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    // Prefer the CLI's error line over any progress or warning printed after it.
    if let e = lines.last(where: { $0.hasPrefix("Error: ") }) { return String(e.dropFirst(7)) }
    return lines.last ?? fallback
}

// Self-update (host/common/swift/Updater.swift). The updater script is shared with WinDinghy.
let roboUpdater = Updater(config: UpdaterConfig(
    scriptEnvVar: Product.scriptEnvVar, defaultCheckout: Product.defaultCheckout, trackedScript: Product.updaterScript))

/// The checkout to update. $ROBODINGHY_PATH is <root>/host/android/robodinghy.mjs, three levels below the
/// root (Updater assumes two, as for host/dinghy.mjs), so try that first.
func findRepoRoot() -> String? {
    if let env = ProcessInfo.processInfo.environment[Product.scriptEnvVar] {
        let root = URL(fileURLWithPath: env).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
        if FileManager.default.fileExists(atPath: root + "/.git") { return root }
    }
    return roboUpdater.findRepoRoot()
}

// ---------- streaming output window (setup check, fix, edition switch) ----------

final class RunWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    let textView = NSTextView()
    let spinner = NSProgressIndicator()
    let statusLabel = NSTextField(labelWithString: "Working…")
    let closeButton = NSButton(title: "Cancel", target: nil, action: nil)
    var process: Process?
    var finished = false
    var onFinish: ((Int32) -> Void)?
    var onClose: (() -> Void)?

    init(title: String) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 380),
                          styleMask: [.titled, .closable, .miniaturizable],
                          backing: .buffered, defer: false)
        super.init()
        window.title = title
        window.isReleasedWhenClosed = false
        window.delegate = self
        let content = NSView(frame: window.contentRect(forFrameRect: window.frame))
        window.contentView = content

        let scroll = NSScrollView(frame: NSRect(x: 16, y: 56, width: 568, height: 308))
        scroll.hasVerticalScroller = true
        scroll.autoresizingMask = [.width, .height]
        textView.isEditable = false
        textView.font = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
        textView.textContainerInset = NSSize(width: 6, height: 6)
        textView.autoresizingMask = [.width]
        scroll.documentView = textView
        content.addSubview(scroll)

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.frame = NSRect(x: 16, y: 20, width: 16, height: 16)
        spinner.startAnimation(nil)
        content.addSubview(spinner)
        statusLabel.frame = NSRect(x: 38, y: 18, width: 420, height: 20)
        content.addSubview(statusLabel)

        closeButton.frame = NSRect(x: 484, y: 14, width: 100, height: 28)
        closeButton.target = self; closeButton.action = #selector(closePressed)
        closeButton.keyEquivalent = "\u{1b}"
        content.addSubview(closeButton)
    }

    func show() {
        window.center()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func append(_ text: String) {
        textView.textStorage?.append(NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular),
            .foregroundColor: NSColor.textColor]))
        textView.scrollToEndOfDocument(nil)
    }

    func run(node: String, script: String, args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script] + args
        p.environment = roboCLI.config.environment()
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        streamOutput(of: p, pipe: pipe, onText: { [weak self] s in
            DispatchQueue.main.async { self?.append(s) }
        }, done: { [weak self] status in self?.finish(status) })
        do { try p.run(); process = p } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            append("Couldn't run \(Product.cli): \(error.localizedDescription)\n")
            finish(1)
        }
    }

    func finish(_ status: Int32) {
        finished = true
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        statusLabel.stringValue = status == 0 ? "Finished." : "Stopped (see the log above)."
        closeButton.title = "Close"
        onFinish?(status)
    }

    @objc func closePressed() { window.close() }

    func windowWillClose(_ notification: Notification) {
        if !finished { process?.terminate() }
        onClose?()
    }
}

// ---------- app delegate ----------

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSSearchFieldDelegate, NSWindowDelegate {
    var statusItem: NSStatusItem!
    let menu = NSMenu()
    var cfg = RDConfig.load()
    var online = false            // Android has booted and isn't paused
    var vmRunning = false         // the emulator process is up (maybe still booting)
    var vmPaused = false          // the emulator is alive but frozen by the idle action
    var idleSince: Date? = nil
    var idleHandled = false
    var quittingVM = false
    var metricsLine = ""
    var updating = false
    var runWindow: RunWindow?
    var searchQuery = ""
    var searchField: MenuSearchField?
    var searchItem: NSMenuItem?
    var currentAppItems: [NSMenuItem] = []

    // Runs `robodinghy <args>` and hands back everything it printed.
    func runCLICapture(_ args: [String], input: String? = nil, done: @escaping (Int32, String) -> Void) {
        runCLI(args, input: input, done: done)
    }

    // Runs `robodinghy <args>` in the background and reports the last line it printed when it finishes.
    func runCLIBackground(_ args: [String], done: @escaping (Int32, String) -> Void) {
        if !roboCLI.background(args, done: done) {
            notify("Can't find node or the \(Product.cli) command-line tool — run `\(Product.cli) \(args.joined(separator: " "))` from a terminal instead.")
        }
    }

    // ---------- VM power ----------

    @objc func startVM() {
        let resume = vmPaused
        notify(resume ? "Waking Android…" : "Starting Android…")
        runCLIBackground(["vm", resume ? "resume" : "start"]) { [weak self] status, last in
            self?.notify(status == 0 ? "Android is running." : "Couldn't start Android: \(last)")
            self?.poll()
        }
    }

    @objc func stopVM() {
        notify("Shutting Android down…")
        runCLIBackground(["vm", "stop"]) { [weak self] status, last in
            self?.notify(status == 0 ? "Android is stopped." : "Couldn't stop Android: \(last)")
            self?.poll()
        }
    }

    @objc func restartVM() {
        notify("Restarting Android…")
        runCLIBackground(["vm", "stop"]) { [weak self] _, _ in
            self?.runCLIBackground(["vm", "start"]) { status, last in
                self?.notify(status == 0 ? "Android is back." : "Couldn't restart Android: \(last)")
                self?.poll()
            }
        }
    }

    @objc func openVMFolder() {
        let dir = cfg.vmDir
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(URL(fileURLWithPath: dir))
    }

    @objc func openFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: cfg.appsDir))
    }

    @objc func toggleAdvanced() {
        if cfg.advanced != "on" {
            let alert = NSAlert()
            alert.messageText = "Turn on advanced mode?"
            alert.informativeText = "Advanced mode unlocks setups \(Product.name) doesn't support: other Android system images (microG builds, LineageOS, GSIs, your own), and showing system apps. They may work, and you're on your own if they don't."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Turn On")
            alert.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            RDConfig.update("advanced", "on")
        } else {
            RDConfig.update("advanced", "off")
        }
        cfg = RDConfig.load()
        AppStore.shared.refresh()
    }

    // ---------- main window (SwiftUI) ----------

    var mainWindow: NSWindow?

    @objc func activateRunningApp(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        NSWorkspace.shared.runningApplications
            .first { $0.bundleURL?.deletingPathExtension().lastPathComponent == name && ($0.bundleURL?.path.hasPrefix(cfg.appsDir + "/") ?? false) }?
            .activate(options: [.activateAllWindows])
    }

    @objc func openMainWindow() {
        AppStore.shared.delegate = self
        if mainWindow == nil {
            let host = NSHostingController(rootView: MainView().environmentObject(AppStore.shared).environmentObject(ToolsStore.shared))
            let w = NSWindow(contentViewController: host)
            w.title = Product.name
            w.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            w.setContentSize(NSSize(width: 1060, height: 700))
            w.minSize = NSSize(width: 900, height: 600)
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.setFrameAutosaveName(Product.windowAutosave)
            w.center()
            mainWindow = w
        }
        AppStore.shared.start()
        // A window needs a Dock icon and Cmd-Tab entry while it is open; back to a menu-bar-only app after.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        mainWindow?.makeKeyAndOrderFront(nil)
    }

    func setMenubarIcon(_ choice: String) {
        RDConfig.update("menubarIcon", choice)
        cfg = RDConfig.load()
        applyMenubarIcon()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openMainWindow()
        return true
    }

    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === mainWindow {
            NSApp.setActivationPolicy(.accessory)
            // The window's 3 s status poll spawns the CLI; the menu's 30 s poll carries on without it.
            AppStore.shared.stop()
        }
    }

    // The menu-bar glyph: the RoboDinghy dinghy (a template image, so macOS tints it for light/dark),
    // or an SF Symbol. Stored as "menubarIcon" in config.json.
    func applyMenubarIcon() {
        guard let btn = statusItem.button else { return }
        var img: NSImage?
        if cfg.menubarIcon != "symbol",
           let path = Bundle.main.path(forResource: "menubar-icon", ofType: "svg"),
           let boat = NSImage(contentsOfFile: path) {
            boat.size = NSSize(width: 18, height: 18)
            img = boat
        }
        // Fallback chain: symbol names vary across macOS versions, and a bad name silently yields nil.
        img = img ?? NSImage(systemSymbolName: "antenna.radiowaves.left.and.right", accessibilityDescription: Product.name)
            ?? NSImage(systemSymbolName: "iphone", accessibilityDescription: Product.name)
            ?? NSImage(named: NSImage.computerName)
        img?.isTemplate = true
        btn.image = img
        btn.imagePosition = .imageLeft
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        applyMenubarIcon()
        AppStore.shared.delegate = self
        // With no Android set up the only useful thing to show is the setup screen, so open the window
        // instead of quietly adding a menu-bar icon.
        AppStore.shared.refresh()
        let noVM = !AppStore.shared.vmExists
        if noVM || CommandLine.arguments.contains("--show-window") || ProcessInfo.processInfo.environment[Product.showWindowEnv] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.openMainWindow() }
        }
        menu.delegate = self
        statusItem.menu = menu
        poll()
        updateBadge()
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.poll() }
        autoStartVM()
        // macOS App Management: the app must be allowed to update its app launchers. Ask once a day.
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in self?.requestAppManagement() }
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.updateBadge() }
    }

    // ---------- status polling (`robodinghy status --json`) ----------

    func poll() {
        cfg = RDConfig.load()
        AppStore.shared.fetchStatus { [weak self] s in
            guard let self else { return }
            self.vmRunning = s?.running ?? false
            self.vmPaused = s?.paused ?? false
            self.online = s?.online ?? false
            if self.online, let s {
                // CPU as a share of the VM's cores; RAM is the emulator process on the Mac, which can pass the
                // guest's size, so it gets a total only when the CLI reports the guest's own.
                let cpu = s.guestCPU(cores: ConfigFile.int("vmCpus", 4))
                self.metricsLine = s.ramMB <= 0 ? String(format: "CPU %.0f%%", cpu)
                    : s.ramTotalMB > 0 ? String(format: "CPU %.0f%%  ·  RAM %.1f / %.1f GB", cpu, s.ramMB / 1024, s.ramTotalMB / 1024)
                    : String(format: "CPU %.0f%%  ·  RAM %.1f GB on this Mac", cpu, s.ramMB / 1024)
            } else {
                self.metricsLine = ""
            }
            self.updateBadge()
            self.checkIdle()
        }
    }

    // Runs as a child of this app, so macOS evaluates the permission for the app itself.
    func requestAppManagement() {
        guard let node = findNode(), let script = roboCLI.config.findScript() else { return }
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [script, "permissions", "--prompt", "--quiet"]
            p.environment = roboCLI.config.environment()
            p.standardOutput = Pipe(); p.standardError = Pipe()
            try? p.run()
            p.waitUntilExit()
        }
    }

    // Always-visible status: green dot = Android booted and ready, dim dot = off, paused or booting.
    // The count of open Android app windows is appended when there are any.
    func updateBadge() {
        guard let btn = statusItem.button else { return }
        let count = AppStore.shared.runningAppNames(cfg).count
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
            .filter { $0.hasSuffix(".app") && $0 != Product.desktopApp + ".app" }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
            .map { entry -> AppEntry in
                let full = cfg.appsDir + "/" + entry
                var source = ""
                if let data = fm.contents(atPath: full + "/Contents/Resources/app.json"),
                   let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                    if let s = (json["Source"] ?? json["source"]) as? String { source = s.lowercased() }
                    else if let sys = (json["System"] ?? json["system"]) as? Bool { source = sys ? "system" : "user" }   // sync writes "System"
                }
                return AppEntry(name: String(entry.dropLast(4)), path: full, source: source)
            }
    }

    func usageCounts() -> [String: Int] {
        let path = NSString(string: Product.usagePath).expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: path),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Int] else { return [:] }
        return json
    }

    static let sourceLabels: [(key: String, label: String)] = [
        ("user", "Your Apps"),
        ("play", "Google Play"),
        ("fdroid", "F-Droid"),
        ("apk", "Installed APKs"),
        ("system", "System"),
    ]

    // ---------- menu ----------

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu()
        poll()
    }

    // Route typing to the search box (see MenuSearchField). Timers run in .common modes because the menu
    // tracks in its own run-loop mode.
    func menuWillOpen(_ menu: NSMenu) {
        for delay in [0.0, 0.05, 0.2] {
            let t = Timer(timeInterval: delay, repeats: false) { [weak self] _ in self?.searchField?.claimFocus() }
            RunLoop.main.add(t, forMode: .common)
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        searchQuery = ""
        searchField?.stringValue = ""
    }

    var statusTitle: String {
        if online { return "\(Product.os) is running" }
        if vmPaused { return "\(Product.os) is paused" }
        if vmRunning { return "\(Product.os) is starting…" }
        return "\(Product.os) is off"
    }

    // The dropdown is for quick actions; everything else lives in the main window (Open RoboDinghy…).
    func rebuildMenu() {
        menu.removeAllItems()

        let status = NSMenuItem(title: statusTitle, action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        if online && !metricsLine.isEmpty {
            let m = NSMenuItem(title: metricsLine, action: nil, keyEquivalent: "")
            m.isEnabled = false
            menu.addItem(m)
        } else if !online && !vmRunning || vmPaused {
            let hint = NSMenuItem(title: vmPaused ? "Wakes when you open an app" : "Starts when you open an app", action: nil, keyEquivalent: "")
            hint.isEnabled = false
            menu.addItem(hint)
        }
        menu.addItem(.separator())

        // Running apps (each scrcpy window is its own process); click to bring forward.
        let running = AppStore.shared.runningAppNames(cfg).sorted()
        if !running.isEmpty {
            let header = NSMenuItem(title: "Running (\(running.count))", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            for name in running {
                let item = NSMenuItem(title: "  " + name, action: #selector(activateRunningApp(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = name
                menu.addItem(item)
            }
            menu.addItem(.separator())
        }

        menu.addItem(makeSearchItem())
        currentAppItems = appSectionItems()
        for item in currentAppItems { menu.addItem(item) }
        menu.addItem(.separator())

        if online {
            menu.addItem(makeItem("Open \(Product.desktopApp)", #selector(openDesktop), "d"))
            let syncing = AppStore.shared.syncing
            menu.addItem(makeItem(syncing ? "Syncing…" : "Sync Apps Now", #selector(runSync), "s", enabled: !syncing))
        } else if vmPaused {
            menu.addItem(makeItem("Wake \(Product.os)", #selector(startVM), "b"))
        } else if !vmRunning {
            menu.addItem(makeItem("Start \(Product.os)", #selector(startVM), "b", enabled: AppStore.shared.vmExists))
        }
        menu.addItem(.separator())
        menu.addItem(makeItem("Open \(Product.name)…", #selector(openMainWindow), "o"))
        let quit = NSMenuItem(title: "Quit \(Product.name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        menu.addItem(quit)
    }

    // Search field lives in ONE persistent view; rebuilding it per keystroke would drop keyboard focus.
    func makeSearchItem() -> NSMenuItem {
        if let item = searchItem { return item }
        let field = MenuSearchField(frame: NSRect(x: 12, y: 1, width: 212, height: 26))
        field.placeholderString = "Search \(Product.os) apps"
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

        // All apps: grouped by source when the launchers say where they came from, else one flat list.
        let allItem = NSMenuItem(title: "All Apps", action: nil, keyEquivalent: "")
        let allSub = NSMenu()
        var grouped: [String: [AppEntry]] = [:]
        for app in apps { grouped[app.source, default: []].append(app) }
        if grouped.count <= 1 {
            for app in apps { allSub.addItem(appItem(app)) }
            if apps.isEmpty {
                let none = NSMenuItem(title: "No apps yet: Sync Apps Now", action: nil, keyEquivalent: "")
                none.isEnabled = false
                allSub.addItem(none)
            }
        } else {
            var placed = Set<String>()
            for (key, label) in Self.sourceLabels {
                guard let group = grouped[key], !group.isEmpty else { continue }
                placed.insert(key)
                let catItem = NSMenuItem(title: "\(label) (\(group.count))", action: nil, keyEquivalent: "")
                let catSub = NSMenu()
                for app in group { catSub.addItem(appItem(app)) }
                catItem.submenu = catSub
                allSub.addItem(catItem)
            }
            let leftovers = grouped.filter { !placed.contains($0.key) }.values.flatMap { $0 }
            if !leftovers.isEmpty {
                let catItem = NSMenuItem(title: "Other (\(leftovers.count))", action: nil, keyEquivalent: "")
                let catSub = NSMenu()
                for app in leftovers.sorted(by: { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) {
                    catSub.addItem(appItem(app))
                }
                catItem.submenu = catSub
                allSub.addItem(catItem)
            }
        }
        allItem.submenu = allSub
        items.append(allItem)
        return items
    }

    // Swap only the rows under the search field, leaving the field untouched so it keeps keyboard focus.
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

    /// One row per app: a custom view so it can see right-clicks, which plain menu rows ignore.
    func appItem(_ app: AppEntry) -> NSMenuItem {
        let item = NSMenuItem(title: app.name, action: #selector(launchApp(_:)), keyEquivalent: "")   // keyboard Return
        item.target = self
        item.representedObject = app.path
        let icon = NSWorkspace.shared.icon(forFile: app.path)
        icon.size = NSSize(width: 16, height: 16)
        let row = AppRowView(name: app.name, icon: icon)
        let path = app.path
        row.onOpen = { NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: .init()) }
        row.onReveal = { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
        item.view = row
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

    /// The synced "Android Desktop" launcher, or `robodinghy desktop` when it hasn't been synced yet.
    @objc func openDesktop() {
        let path = cfg.appsDir + "/" + Product.desktopApp + ".app"
        if FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: .init())
        } else {
            runCLIBackground(["desktop"]) { [weak self] status, last in
                if status != 0 { self?.notify("Couldn't open \(Product.desktopApp): \(last)") }
            }
        }
    }

    /// One sync at a time: the menu, the window's Sync button and the post-install sync all go through
    /// AppStore.syncApps, whose `syncing` flag the menu item also reads.
    @objc func runSync() { AppStore.shared.syncApps(notifyDone: true) }

    // ---------- self-update ----------

    // The updater (host/dinghy-update.sh, shared with WinDinghy) only ever runs through the gitignored
    // repo-root `update` launcher; this finds the real checkout, never the CLI copy in Contents/Resources.
    @objc func checkForUpdates() {
        guard !updating else { return }
        guard let root = findRepoRoot() else {
            showUpdateResult("Can't find your \(Product.name) checkout", "Updates come from the git folder \(Product.name) was built from (default \(Product.defaultCheckout)). Clone it there, or set \(Product.scriptEnvVar).")
            return
        }
        guard let launcherPath = roboUpdater.installedUpdateLauncher(root: root) else {
            showUpdateResult("Updater missing", "\(Product.updaterScript) isn't in your checkout. Re-clone the repo.")
            return
        }
        updating = true
        AppStore.shared.updateStatus = "Checking for updates…"
        roboUpdater.run(launcher: launcherPath) { [weak self] status, text, launchError in
            guard let self else { return }
            self.updating = false
            AppStore.shared.updateStatus = nil
            if let launchError { self.showUpdateResult("Couldn't run the updater", launchError.localizedDescription); return }
            let tail = text.split(separator: "\n").suffix(8).joined(separator: "\n")
            if text.contains("Already up to date") { self.showUpdateResult("\(Product.name) is up to date", tail) }
            else if status == 0 { self.showUpdateResult("\(Product.name) was updated", tail) }
            else { self.showUpdateResult("Update didn't finish", tail.isEmpty ? "Unknown error." : tail) }
        }
    }

    /// A visible result: notifications from a menu-bar app are often switched off.
    func showUpdateResult(_ title: String, _ detail: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    // ---------- maintenance windows ----------

    /// `robodinghy doctor`: the CLI owns the checks (SDK pieces, emulator, adb, scrcpy, helper, launchers,
    /// App Management), so the app shows its report instead of re-implementing them.
    @objc func setupCheck() { runCLIWindow(title: "Setup Check", args: ["doctor"]) }

    @objc func showFix() { runCLIWindow(title: "Fix Problems", args: ["fix"]) }

    /// Runs the CLI in the output window. False when it didn't start (another run is still going, which is
    /// brought forward, or the CLI is missing), in which case onFinish is never called.
    @discardableResult
    func runCLIWindow(title: String, args: [String], onFinish: ((Int32) -> Void)? = nil) -> Bool {
        if let w = runWindow, !w.finished { w.show(); return false }
        guard let (node, script) = roboCLI.resolve() else {
            notify("Can't find node or the \(Product.cli) command-line tool — run `\(Product.cli) \(args.joined(separator: " "))` from a terminal instead.")
            return false
        }
        let w = RunWindow(title: title)
        w.onFinish = { [weak self] status in
            self?.poll()
            AppStore.shared.refresh()
            onFinish?(status)
        }
        w.onClose = { [weak self] in self?.runWindow = nil }
        runWindow = w
        w.show()
        w.run(node: node, script: script, args: args)
        return true
    }

    // ---------- VM power: start with the app, idle action, save on quit ----------

    func vmProcessAlive() -> Bool {
        guard let txt = try? String(contentsOfFile: cfg.vmDir + "/emulator.pid", encoding: .utf8),
              let pid = Int32(txt.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
        return kill(pid, 0) == 0
    }

    /// Opened by the "start at login" item (or soon after the Mac booted)? Then the VM start is delayed.
    func launchedAtLogin() -> Bool {
        if ProcessInfo.processInfo.systemUptime < 600 { return true }
        let ev = NSAppleEventManager.shared().currentAppleEvent
        return ev?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }

    func autoStartVM() {
        guard ConfigFile.bool("vmAutoStart", true), AppStore.shared.vmExists else { return }
        var args = ["vm", "autostart"]
        if launchedAtLogin() { args.append("--login") }
        runCLIBackground(args) { [weak self] status, last in
            if status != 0 { self?.notify("Couldn't start \(Product.os): \(last)") }
            self?.poll()
        }
    }

    /// No Android apps open for a while: pause / save / shut down, per the setting.
    func checkIdle() {
        let action = ConfigFile.string("vmIdleAction", "off")
        guard action != "off", online else { idleSince = nil; return }
        if !AppStore.shared.runningAppNames(cfg).isEmpty { idleSince = nil; idleHandled = false; return }
        if idleSince == nil { idleSince = Date() }
        let limit = Double(ConfigFile.int("vmIdleMinutes", 15)) * 60
        guard !idleHandled, let since = idleSince, Date().timeIntervalSince(since) >= limit else { return }
        idleHandled = true
        runCLIBackground(["vm", "idle"]) { [weak self] _, last in
            if last.hasPrefix("WARN:") { self?.notify(last) }
            self?.poll()
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let how = ConfigFile.string("vmOnQuit", "save")
        // Never touch the VM while a setup/install is running, or if there's nothing to do.
        let installing: Bool = { if case .installing? = AppStore.shared.setupPhase { return true }; return false }()
        guard how != "keep", !quittingVM, !installing, runWindow?.process?.isRunning != true,
              vmProcessAlive() || vmRunning, let (node, script) = roboCLI.resolve() else { return .terminateNow }
        quittingVM = true
        notify(how == "save" ? "Saving \(Product.os) before quitting…" : "Shutting \(Product.os) down before quitting…")
        // Open Android apps lose their display with the emulator; close them cleanly first.
        for app in NSWorkspace.shared.runningApplications where app.bundleURL?.path.hasPrefix(cfg.appsDir + "/") == true { app.terminate() }
        DispatchQueue.global().async { [weak self] in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [script, "vm", "quit"]
            let pipe = Pipe()
            p.standardOutput = pipe; p.standardError = pipe
            p.environment = roboCLI.config.environment()
            var out = ""
            if (try? p.run()) != nil {
                // Don't hold the app hostage forever (5 min is generous for a snapshot save).
                let timer = DispatchSource.makeTimerSource(queue: .global())
                timer.schedule(deadline: .now() + 300)
                timer.setEventHandler { if p.isRunning { p.terminate() } }
                timer.resume()
                out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                p.waitUntilExit()
                timer.cancel()
            }
            if let warn = out.split(separator: "\n").first(where: { $0.hasPrefix("WARN:") }) {
                DispatchQueue.main.async { self?.notify(String(warn)) }
                usleep(300_000)
            }
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ n: Notification) {
        runWindow?.process?.terminate()
    }

    func notify(_ msg: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        // The text goes in as argv, not spliced into the script, so no quoting can break it (JSON-style
        // escaping turns "/" into "\\/", which AppleScript rejects, losing any message with a path).
        p.arguments = ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
                       "-e", "end run", msg, Product.name]
        try? p.run()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()


/// The menu's search box. It takes keyboard focus as soon as it is placed in the menu's window, so typing
/// filters every app instead of falling through to the menu's type-select.
final class MenuSearchField: NSSearchField {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        claimFocus()
    }

    func claimFocus() {
        guard let w = window, currentEditor() == nil else { return }
        w.makeFirstResponder(self)
    }
}

/// A menu row for one Android app. Menus ignore right-clicks on plain rows, so this draws its own row
/// (matching the system look) and handles the mouse itself: click opens, right-click (or ⌃-click)
/// offers Open and Show in Finder.
final class AppRowView: NSView {
    let name: String
    let icon: NSImage
    var onOpen: (() -> Void)?
    var onReveal: (() -> Void)?
    private var hover = false

    init(name: String, icon: NSImage) {
        self.name = name; self.icon = icon
        super.init(frame: NSRect(x: 0, y: 0, width: 260, height: 22))
        autoresizingMask = [.width]
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil))
    }
    required init?(coder: NSCoder) { fatalError() }

    override func mouseEntered(with e: NSEvent) { hover = true; needsDisplay = true }
    override func mouseExited(with e: NSEvent) { hover = false; needsDisplay = true }

    override func draw(_ dirty: NSRect) {
        let lit = hover || (enclosingMenuItem?.isHighlighted ?? false)
        if lit {
            NSColor.selectedContentBackgroundColor.setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 5, dy: 1), xRadius: 4, yRadius: 4).fill()
        }
        icon.draw(in: NSRect(x: 14, y: 3, width: 16, height: 16))
        let para = NSMutableParagraphStyle(); para.lineBreakMode = .byTruncatingTail
        (name as NSString).draw(in: NSRect(x: 38, y: 3, width: bounds.width - 50, height: 16), withAttributes: [
            .font: NSFont.menuFont(ofSize: 0),
            .foregroundColor: lit ? NSColor.selectedMenuItemTextColor : NSColor.labelColor,
            .paragraphStyle: para,
        ])
    }

    override func mouseUp(with e: NSEvent) {
        if e.modifierFlags.contains(.control) { showChoices(); return }
        enclosingMenuItem?.menu?.cancelTracking()
        onOpen?()
    }
    override func rightMouseUp(with e: NSEvent) { showChoices() }

    private func showChoices() {
        enclosingMenuItem?.menu?.cancelTracking()
        let m = NSMenu()
        let open = NSMenuItem(title: "Open", action: #selector(chooseOpen), keyEquivalent: "")
        let reveal = NSMenuItem(title: "Show in Finder", action: #selector(chooseReveal), keyEquivalent: "")
        for i in [open, reveal] { i.target = self; m.addItem(i) }
        // After the main menu has closed
        DispatchQueue.main.async { m.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil) }
    }
    @objc private func chooseOpen() { onOpen?() }
    @objc private func chooseReveal() { onReveal?() }
}
