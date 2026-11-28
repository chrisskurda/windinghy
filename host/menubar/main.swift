// WinDinghy menu-bar app: ambient VM status + app picker + sync + setup check.
// Built by build.sh into ~/Applications/WinDinghy.app (LSUIElement, no dock icon).
import AppKit
import SwiftUI
import ServiceManagement

// ---------- config (shared with dinghy) ----------

struct WBConfig {
    var host = "192.168.64.8"
    var apiPort = 7148
    var rdpPort = 3389
    var vmName = "Windows"
    var vmBackend = "utm"   // utm | qemu (the VM WinDinghy manages itself)
    var advanced = "off"       // on: unsupported setups (UTM, remote hosts, ...) are allowed
    var menubarIcon = "boat"   // boat (the WinDinghy dinghy) | symbol (the original window symbol)
    var username = ""
    var promptcreds = "on"
    var appsDir = NSString(string: "~/Applications/WinDinghy").expandingTildeInPath
    var vmDir = NSString(string: "~/Library/Application Support/WinDinghy/vm").expandingTildeInPath

    static let file = JSONConfigFile(path: "~/.config/windinghy/config.json")
    static var path: String { file.path }

    static func load() -> WBConfig {
        var c = WBConfig()
        let json = file.dict()
        guard !json.isEmpty else { return c }
        if let v = json["host"] as? String, !v.isEmpty { c.host = v }
        if let v = json["apiPort"] as? Int { c.apiPort = v }
        if let v = json["rdpPort"] as? Int { c.rdpPort = v }
        if let v = json["vmName"] as? String, !v.isEmpty { c.vmName = v }
        if let v = json["vmBackend"] as? String, !v.isEmpty { c.vmBackend = v }
        if let v = json["menubarIcon"] as? String, !v.isEmpty { c.menubarIcon = v }
        if let v = json["advanced"] as? String, !v.isEmpty { c.advanced = v }
        if let v = json["username"] as? String { c.username = v }
        if let v = json["promptcreds"] as? String, !v.isEmpty { c.promptcreds = v }
        if let v = json["appsDir"] as? String, !v.isEmpty { c.appsDir = v }
        if let v = json["vmDir"] as? String, !v.isEmpty { c.vmDir = NSString(string: v).expandingTildeInPath }
        return c
    }

    // Read-modify-write a single key, preserving everything dinghy has stored.
    static func update(_ key: String, _ value: Any) { file.set(key, value) }
}

// The dinghy CLI (findNode, CLIRunner: host/common/swift/CLIRunner.swift).
let dinghyCLI = CLIRunner(config: CLIConfig(
    scriptEnvVar: "DINGHY_PATH",
    scriptCandidates: [
        NSString(string: "~/windinghy/host/dinghy.mjs").expandingTildeInPath,
        Bundle.main.bundlePath + "/Contents/Resources/dinghy.mjs",
    ]))

func findDinghy() -> String? { dinghyCLI.config.findScript() }

// Self-update (host/common/swift/Updater.swift).
let dinghyUpdater = Updater(config: UpdaterConfig(
    scriptEnvVar: "DINGHY_PATH", defaultCheckout: "~/windinghy", trackedScript: "host/dinghy-update.sh"))

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

// A small window that runs a dinghy command and streams its output (setup, fix).
final class RunWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    let textView = NSTextView()
    let spinner = NSProgressIndicator()
    let statusLabel = NSTextField(labelWithString: "Working…")
    let copyButton = NSButton(title: "Copy Command", target: nil, action: nil)
    let closeButton = NSButton(title: "Cancel", target: nil, action: nil)
    var process: Process?
    var command = ""
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
        statusLabel.frame = NSRect(x: 38, y: 18, width: 300, height: 20)
        content.addSubview(statusLabel)

        copyButton.frame = NSRect(x: 340, y: 14, width: 130, height: 28)
        copyButton.target = self; copyButton.action = #selector(copyCommand)
        copyButton.isHidden = true
        content.addSubview(copyButton)
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
        let atEnd = true
        textView.textStorage?.append(NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular),
            .foregroundColor: NSColor.textColor]))
        if atEnd { textView.scrollToEndOfDocument(nil) }
        // The manual fallback prints a one-liner for the user to paste into Windows.
        for line in text.split(separator: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("irm http") { command = t; copyButton.isHidden = false }
        }
    }

    func run(node: String, dinghy: String, args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [dinghy] + args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        // streamOutput (CLIRunner.swift) delivers everything dinghy printed before finish(): its last
        // lines (an `Error: …`) arrive right as it exits.
        streamOutput(of: p, pipe: pipe, onText: { [weak self] s in
            DispatchQueue.main.async { self?.append(s) }
        }, done: { [weak self] status in self?.finish(status) })
        do { try p.run(); process = p } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            append("Couldn't run dinghy: \(error.localizedDescription)\n")
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

    @objc func copyCommand() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        statusLabel.stringValue = "Command copied: paste it into an elevated PowerShell in Windows."
    }

    @objc func closePressed() { window.close() }

    func windowWillClose(_ notification: Notification) {
        if !finished { process?.terminate() }
        onClose?()
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSSearchFieldDelegate, NSWindowDelegate {
    var statusItem: NSStatusItem!
    let menu = NSMenu()
    var cfg = WBConfig.load()
    var online = false
    var vmPaused = false          // the VM process is alive but frozen by the idle action
    var idleSince: Date? = nil
    var idleHandled = false
    var quittingVM = false
    var metricsLine = ""
    var syncing = false
    var updating = false
    var runWindow: RunWindow?
    var searchQuery = ""
    var searchField: MenuSearchField?
    var searchItem: NSMenuItem?
    var currentAppItems: [NSMenuItem] = []
    var lastDiscover = Date.distantPast
    var snapshotNames: [String] = []
    var discovering = false

    // ---------- managed VM tools (Windows VM submenu) ----------

    // Runs `dinghy <args>` and hands back everything it printed.
    func runDinghyCapture(_ args: [String], input: String? = nil, done: @escaping (Int32, String) -> Void) {
        dinghyCLI.capture(args, input: input, done: done)
    }

    func refreshSnapshots() {
        guard cfg.vmBackend == "qemu" else { snapshotNames = []; return }
        runDinghyCapture(["vm", "snapshots"]) { [weak self] status, text in
            guard status == 0 else { return }
            // "name   date" per line; the "No snapshots yet" hint has no tab-aligned name
            self?.snapshotNames = text.split(separator: "\n")
                .filter { !$0.hasPrefix("No snapshots") }
                .compactMap { $0.split(separator: " ").first.map(String.init) }
        }
    }

    @objc func stopVM() {
        notify("Shutting the WinDinghy VM down…")
        runDinghyBackground(["vm", "stop"]) { [weak self] status, last in
            self?.notify(status == 0 ? "The WinDinghy VM is stopped." : "Couldn't stop the VM: \(last)")
            self?.poll()
        }
    }

    @objc func takeSnapshot() {
        let alert = NSAlert()
        alert.messageText = "Take a snapshot"
        alert.informativeText = "Windows is shut down briefly so the snapshot is consistent, then restarted. Name it (letters, digits, . _ -), or leave blank for a dated name."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.placeholderString = "before-office-update"
        alert.accessoryView = field
        alert.addButton(withTitle: "Take Snapshot")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespaces)
        runDinghyWindow(title: "Take Snapshot", args: name.isEmpty ? ["vm", "snapshot"] : ["vm", "snapshot", name])
    }

    @objc func rewindToSnapshot(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        runDinghyWindow(title: "Rewind to \(name)", args: ["vm", "rewind", name])   // dinghy asks to confirm
    }

    @objc func openVMFolder() {
        let dir = NSString(string: "~/Library/Application Support/WinDinghy/vm").expandingTildeInPath
        NSWorkspace.shared.open(URL(fileURLWithPath: dir))
    }

    @objc func toggleAdvanced() {
        if cfg.advanced != "on" {
            let alert = NSAlert()
            alert.messageText = "Turn on advanced mode?"
            alert.informativeText = "Advanced mode unlocks setups WinDinghy doesn't support: UTM or another hypervisor, a Windows VM on another machine, a custom RDP client. They may work, and you're on your own if they don't.\n\nDon't point WinDinghy at a remote machine over the internet or an untrusted network unless it's inside an encrypted VPN (WireGuard, Tailscale, …): the guest API is plain HTTP."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Turn On")
            alert.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            WBConfig.update("advanced", "on")
        } else {
            WBConfig.update("advanced", "off")
        }
        cfg = WBConfig.load()
    }

    func vmToolsMenuItem() -> NSMenuItem {
        let parent = NSMenuItem(title: "Windows VM", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        sub.addItem(makeItem("Start", #selector(startVM), "", enabled: !online))
        sub.addItem(makeItem("Stop", #selector(stopVM), "", enabled: online))
        sub.addItem(makeItem("Restart", #selector(restartVM), ""))
        sub.addItem(.separator())
        sub.addItem(makeItem("Take Snapshot…", #selector(takeSnapshot), ""))
        let rewind = NSMenuItem(title: "Rewind To", action: nil, keyEquivalent: "")
        let rsub = NSMenu()
        if snapshotNames.isEmpty {
            let none = NSMenuItem(title: "No snapshots yet", action: nil, keyEquivalent: "")
            none.isEnabled = false
            rsub.addItem(none)
        } else {
            for name in snapshotNames {
                let item = NSMenuItem(title: name, action: #selector(rewindToSnapshot(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = name
                rsub.addItem(item)
            }
        }
        rewind.submenu = rsub
        sub.addItem(rewind)
        sub.addItem(.separator())
        sub.addItem(makeItem("Show VM Folder", #selector(openVMFolder), ""))
        parent.submenu = sub
        return parent
    }

    func advancedMenuItem() -> NSMenuItem {
        let item = makeItem("Advanced Mode", #selector(toggleAdvanced), "")
        item.state = cfg.advanced == "on" ? .on : .off
        return item
    }

    // ---------- main window (SwiftUI) ----------

    var mainWindow: NSWindow?

    @objc func activateRunningApp(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        NSWorkspace.shared.runningApplications
            .first { $0.bundleURL?.deletingPathExtension().lastPathComponent == name && ($0.bundleURL?.path.hasPrefix(cfg.appsDir) ?? false) }?
            .activate(options: [.activateAllWindows])
    }

    @objc func openMainWindow() {
        AppStore.shared.delegate = self
        if mainWindow == nil {
            let host = NSHostingController(rootView: MainView().environmentObject(AppStore.shared).environmentObject(ToolsStore.shared))
            let w = NSWindow(contentViewController: host)
            w.title = "WinDinghy"
            w.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            w.setContentSize(NSSize(width: 1060, height: 700))
            w.minSize = NSSize(width: 900, height: 600)
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.setFrameAutosaveName("WinDinghyMain")
            w.center()
            mainWindow = w
        }
        // A window needs a Dock icon and Cmd-Tab entry while it is open; back to a menu-bar-only app after.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        mainWindow?.makeKeyAndOrderFront(nil)
    }

    func setMenubarIcon(_ choice: String) {
        WBConfig.update("menubarIcon", choice)
        cfg = WBConfig.load()
        applyMenubarIcon()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openMainWindow()
        return true
    }

    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === mainWindow {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    // The menu-bar glyph: the WinDinghy dinghy (a template image, so macOS tints it for light/dark),
    // or the original window symbol. Chosen from the menu, stored as "menubarIcon" in config.json.
    func applyMenubarIcon() {
        guard let btn = statusItem.button else { return }
        var img: NSImage?
        if cfg.menubarIcon != "symbol",
           let path = Bundle.main.path(forResource: "menubar-icon", ofType: "svg"),
           let boat = NSImage(contentsOfFile: path) {
            boat.size = NSSize(width: 18, height: 18)
            img = boat
        }
        // Fallback chain: symbol names vary across macOS versions, and a bad name silently
        // yields nil (invisible icon).
        img = img ?? NSImage(systemSymbolName: "macwindow.on.rectangle", accessibilityDescription: "WinDinghy")
            ?? NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: "WinDinghy")
            ?? NSImage(named: NSImage.computerName)
        img?.isTemplate = true
        btn.image = img
        btn.imagePosition = .imageLeft
    }

    @objc func chooseMenubarIcon(_ sender: NSMenuItem) {
        let choice = sender.representedObject as? String ?? "boat"
        WBConfig.update("menubarIcon", choice)
        cfg = WBConfig.load()
        applyMenubarIcon()
    }

    func menubarIconMenuItem() -> NSMenuItem {
        let parent = NSMenuItem(title: "Menu Bar Icon", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for (title, value) in [("WinDinghy Dinghy", "boat"), ("Window Symbol", "symbol")] {
            let item = NSMenuItem(title: title, action: #selector(chooseMenubarIcon(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = value
            item.state = cfg.menubarIcon == value ? .on : .off
            sub.addItem(item)
        }
        parent.submenu = sub
        return parent
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        applyMenubarIcon()
        AppStore.shared.delegate = self
        // With no Windows installed the only useful thing to show is the setup wizard, so open the window
        // instead of quietly adding a menu-bar icon (a first-time user would keep launching the app and
        // waiting for a window).
        AppStore.shared.refresh()
        let noWindows = !AppStore.shared.vmExists
        if noWindows || CommandLine.arguments.contains("--show-window") || ProcessInfo.processInfo.environment["WINDINGHY_SHOW_WINDOW"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.openMainWindow() }
        }
        menu.delegate = self
        statusItem.menu = menu
        poll()
        updateBadge()
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.poll() }
        autoStartVM()
        // macOS App Management: WinDinghy must be allowed to update its app launchers. Ask once a day.
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in self?.requestAppManagement() }
        // A sleeping Mac pauses the VM, so its clock falls behind; push the Mac's time in once we're awake.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { self?.fixClockAfterWake() }
        }
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
        cfg = WBConfig.load()  // pick up dinghy's self-repaired host
        refreshSnapshots()
        vmPaused = vmProcessAlive() && FileManager.default.fileExists(atPath: cfg.vmDir + "/qemu.paused")
        fetchJSON("/health") { [weak self] health in
            guard let self else { return }
            self.online = health?["status"] as? String == "ok"
            self.updateBadge()
            self.checkIdle()
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
                if !self.vmPaused { self.rediscoverGuest() }   // a frozen VM isn't lost
            }
        }
    }

    // Runs as a child of this app, so macOS evaluates the permission for WinDinghy.app itself.
    func appManagementAllowed() -> Bool {
        guard let node = findNode(), let dinghy = findDinghy() else { return true }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [dinghy, "permissions", "--quiet"]
        p.standardOutput = Pipe(); p.standardError = Pipe()
        do { try p.run() } catch { return true }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    func requestAppManagement() {
        guard let node = findNode(), let dinghy = findDinghy() else { return }
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [dinghy, "permissions", "--prompt", "--quiet"]
            p.standardOutput = Pipe(); p.standardError = Pipe()
            try? p.run()
            p.waitUntilExit()
        }
    }

    func fixClockAfterWake() {
        guard let node = findNode(), let dinghy = findDinghy() else { return }
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [dinghy, "fix", "clock", "--quiet"]
            p.standardOutput = Pipe(); p.standardError = Pipe()
            try? p.run()
            p.waitUntilExit()
        }
    }

    // The VM's DHCP address can change: ask dinghy to find it again (by MAC, then a
    // subnet scan). It rewrites config.json; the next poll picks the new host up.
    func rediscoverGuest() {
        guard !discovering, !syncing, !updating, runWindow == nil,
              Date().timeIntervalSince(lastDiscover) > 60,
              let node = findNode(), let dinghy = findDinghy() else { return }
        discovering = true
        lastDiscover = Date()
        DispatchQueue.global().async { [weak self] in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [dinghy, "discover", "--quiet"]
            p.standardOutput = Pipe(); p.standardError = Pipe()
            try? p.run()
            p.waitUntilExit()
            DispatchQueue.main.async {
                self?.discovering = false
                if p.terminationStatus == 0 { self?.poll() }
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
        let path = NSString(string: "~/.config/windinghy/usage.json").expandingTildeInPath
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
    }

    // Route typing to the search box. Without focus there, the menu's own type-select takes the keys,
    // and that only matches the rows already showing (Favorites), never the apps under All Apps.
    // The field also claims focus itself when it lands in the menu's window (MenuSearchField); these
    // retries cover a menu window that is reused or slow to appear. Timers run in .common modes
    // because the menu tracks in its own run-loop mode.
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

    // The dropdown is for quick actions; everything else lives in the WinDinghy window (Open WinDinghy…).
    func rebuildMenu() {
        menu.removeAllItems()

        let status = NSMenuItem(title: online ? "Windows is running" : (vmPaused ? "Windows is paused" : "Windows is off"), action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        if online && !metricsLine.isEmpty {
            let m = NSMenuItem(title: metricsLine, action: nil, keyEquivalent: "")
            m.isEnabled = false
            menu.addItem(m)
        } else if !online {
            let hint = NSMenuItem(title: vmPaused ? "Wakes when you open an app" : "Starts when you open an app", action: nil, keyEquivalent: "")
            hint.isEnabled = false
            menu.addItem(hint)
        }
        menu.addItem(.separator())

        // Running apps (the native client runs each as its own process); click to bring forward.
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
            menu.addItem(makeItem("Open Windows Desktop", #selector(openDesktop), "d"))
            menu.addItem(makeItem(syncing ? "Syncing…" : "Sync Apps Now", #selector(runSync), "s", enabled: !syncing))
        } else {
            menu.addItem(makeItem("Start Windows", #selector(startVM), "b"))
        }
        menu.addItem(.separator())
        menu.addItem(makeItem("Open WinDinghy…", #selector(openMainWindow), "o"))
        let quit = NSMenuItem(title: "Quit WinDinghy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        menu.addItem(quit)
    }

    // Search field lives in ONE persistent view; rebuilding it per keystroke
    // would drop keyboard focus.
    func makeSearchItem() -> NSMenuItem {
        if let item = searchItem { return item }
        let field = MenuSearchField(frame: NSRect(x: 12, y: 1, width: 212, height: 26))
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
            for app in hits { items.append(contentsOf: appItems(app)) }
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
            for app in favs { items.append(contentsOf: appItems(app)) }
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
            for app in group { appItems(app).forEach { catSub.addItem($0) } }
            catItem.submenu = catSub
            allSub.addItem(catItem)
        }
        let leftovers = grouped.filter { !placedKeys.contains($0.key) }.values.flatMap { $0 }
        if !leftovers.isEmpty {
            let catItem = NSMenuItem(title: "Other (\(leftovers.count))", action: nil, keyEquivalent: "")
            let catSub = NSMenu()
            for app in leftovers.sorted(by: { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) {
                appItems(app).forEach { catSub.addItem($0) }
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

    /// One row per app. It's a custom view so it can see right-clicks, which plain menu rows ignore:
    /// click opens, ⌥-click or right-click offers Run as Administrator (see AppRowView).
    func appItems(_ app: AppEntry) -> [NSMenuItem] { [appItem(app)] }

    func appItem(_ app: AppEntry) -> NSMenuItem {
        let item = NSMenuItem(title: app.name, action: #selector(launchApp(_:)), keyEquivalent: "")   // keyboard Return
        item.target = self
        item.representedObject = app.path
        let icon = NSWorkspace.shared.icon(forFile: app.path)
        icon.size = NSSize(width: 16, height: 16)
        let row = AppRowView(name: app.name, icon: icon)
        let path = app.path
        row.blocker = AppStore.shared.adminBlocker(forAppAt: path)
        row.onOpen = { NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: .init()) }
        row.onAdmin = { AppStore.shared.launchAsAdmin(appAt: path) }
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

    @objc func launchAppAdmin(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        AppStore.shared.launchAsAdmin(appAt: path)
    }

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
    // Runs `dinghy <args>` in the background and reports the last line it printed when it finishes.
    func runDinghyBackground(_ args: [String], done: @escaping (Int32, String) -> Void) {
        if !dinghyCLI.background(args, done: done) {
            notify("Can't find node or dinghy.mjs — run `dinghy \(args.joined(separator: " "))` from a terminal instead.")
        }
    }

    @objc func startVM() {
        if cfg.vmBackend == "qemu" {
            notify("Starting the WinDinghy VM…")
            runDinghyBackground(["vm", "start"]) { [weak self] status, last in
                self?.notify(status == 0 ? "The WinDinghy VM is online." : "Couldn't start the VM: \(last)")
                if status == 0 { self?.poll() }
            }
            return
        }
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
        if cfg.vmBackend == "qemu" {
            notify("Restarting the WinDinghy VM — asking Windows to shut down…")
            runDinghyBackground(["vm", "stop"]) { [weak self] _, _ in
                self?.runDinghyBackground(["vm", "start"]) { status, last in
                    self?.notify(status == 0 ? "The WinDinghy VM is back online." : "Couldn't restart the VM: \(last)")
                    if status == 0 { self?.poll() }
                }
            }
            return
        }
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
        guard let node = findNode(), let dinghy = findDinghy() else {
            notify("Can't find node or dinghy.mjs — run dinghy sync from a terminal instead.")
            return
        }
        syncing = true
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [dinghy, "sync"]
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                self?.syncing = false
                self?.notify(proc.terminationStatus == 0 ? "App list synced." : "Sync failed — run dinghy sync in a terminal for details.")
            }
        }
        try? p.run()
    }

    // ---------- self-update ----------

    // The updater's own logic lives at host/dinghy-update.sh (tracked in
    // git) and is only ever run via the repo-root `update` launcher, which
    // is gitignored on purpose — see that file for why. This finds the real
    // checkout (not the dinghy.mjs copy bundled into Contents/Resources,
    // which has no .git and can't be updated).
    func findRepoRoot() -> String? { dinghyUpdater.findRepoRoot() }

    func installedUpdateLauncher(root: String) -> String? { dinghyUpdater.installedUpdateLauncher(root: root) }

    @objc func checkForUpdates() {
        guard !updating else { return }
        guard let root = findRepoRoot() else {
            showUpdateResult("Can't find your WinDinghy checkout", "Updates come from the WinDinghy git folder (default ~/windinghy). Clone it there, or set DINGHY_PATH.")
            return
        }
        guard let launcherPath = installedUpdateLauncher(root: root) else {
            showUpdateResult("Updater missing", "host/dinghy-update.sh isn't in your checkout. Re-clone the repo.")
            return
        }
        updating = true
        AppStore.shared.updateStatus = "Checking for updates…"
        dinghyUpdater.run(launcher: launcherPath) { [weak self] status, text, launchError in
            guard let self else { return }
            self.updating = false
            AppStore.shared.updateStatus = nil
            if let launchError { self.showUpdateResult("Couldn't run the updater", launchError.localizedDescription); return }
            let tail = text.split(separator: "\n").suffix(8).joined(separator: "\n")
            if text.contains("Already up to date") { self.showUpdateResult("WinDinghy is up to date", tail) }
            else if status == 0 { self.showUpdateResult("WinDinghy was updated", tail) }
            else { self.showUpdateResult("Update didn't finish", tail.isEmpty ? "Unknown error." : tail) }
        }
    }

    /// A visible result: notifications from a menu-bar app are often switched off, which made the updater look dead.
    func showUpdateResult(_ title: String, _ detail: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    // ---------- guest setup (serve install script) ----------

    func setupMenuItem() -> NSMenuItem {
        makeItem("Set Up Windows VM…", #selector(showSetup), "")
    }

    // Runs `dinghy setup` (hands-free through the UTM guest agent; it falls back to a
    // paste-in-Windows one-liner when the agent isn't installed) in a progress window.
    @objc func showSetup() {
        runDinghyWindow(title: "Set Up Windows VM", args: ["setup"])
    }

    @objc func showFix() {
        runDinghyWindow(title: "Fix Problems", args: ["fix"])
    }

    func runDinghyWindow(title: String, args: [String]) {
        if let w = runWindow, !w.finished { w.show(); return }
        guard let node = findNode(), let dinghy = findDinghy() else {
            notify("Can't find node or dinghy.mjs — run `dinghy \(args.joined(separator: " "))` from a terminal instead.")
            return
        }
        let w = RunWindow(title: title)
        w.onFinish = { [weak self] status in
            if status == 0 { self?.poll() }
        }
        w.onClose = { [weak self] in self?.runWindow = nil }
        runWindow = w
        w.show()
        w.run(node: node, dinghy: dinghy, args: args)
    }

    // ---------- VM power: start with the app, save on quit, idle ----------

    func vmProcessAlive() -> Bool {
        guard let txt = try? String(contentsOfFile: cfg.vmDir + "/qemu.pid", encoding: .utf8),
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
        guard cfg.vmBackend == "qemu", ConfigFile.bool("vmAutoStart", true), AppStore.shared.vmExists else { return }
        var args = ["vm", "autostart"]
        if launchedAtLogin() { args.append("--login") }
        runDinghyBackground(args) { [weak self] status, last in
            if status != 0 { self?.notify("Couldn't start Windows: \(last)") }
            self?.poll()
        }
    }

    /// No Windows apps open for a while: pause / save / shut down, per the setting.
    func checkIdle() {
        let action = ConfigFile.string("vmIdleAction", "off")
        guard cfg.vmBackend == "qemu", action != "off", online else { idleSince = nil; return }
        if !AppStore.shared.runningAppNames(cfg).isEmpty { idleSince = nil; idleHandled = false; return }
        if idleSince == nil { idleSince = Date() }
        let limit = Double(ConfigFile.int("vmIdleMinutes", 15)) * 60
        guard !idleHandled, let since = idleSince, Date().timeIntervalSince(since) >= limit else { return }
        idleHandled = true
        runDinghyBackground(["vm", "idle"]) { [weak self] _, last in
            if last.hasPrefix("WARN:") { self?.notify(last) }
            self?.poll()
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let how = ConfigFile.string("vmOnQuit", "save")
        // Never touch the VM while a setup/install is running, or if there's nothing to do.
        let installing: Bool = { if case .installing? = AppStore.shared.setupPhase { return true }; return false }()
        guard cfg.vmBackend == "qemu", how != "keep", !quittingVM, !installing, runWindow?.process?.isRunning != true,
              vmProcessAlive(), let node = findNode(), let dinghy = findDinghy() else { return .terminateNow }
        quittingVM = true
        notify(how == "save" ? "Saving Windows before quitting…" : "Shutting Windows down before quitting…")
        // Open Windows apps die with the VM; close them cleanly first.
        for app in NSWorkspace.shared.runningApplications where app.bundleURL?.path.hasPrefix(cfg.appsDir + "/") == true { app.terminate() }
        DispatchQueue.global().async { [weak self] in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [dinghy, "vm", "quit"]
            let pipe = Pipe()
            p.standardOutput = pipe; p.standardError = pipe
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            p.environment = env
            var out = ""
            if (try? p.run()) != nil {
                // Don't hold the app hostage forever (a save of 6+ GB takes under a minute; 5 min is generous).
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

            // The RDP client: the bundled native one (or a built checkout), else Windows App.
            let nativeClient = [
                (Bundle.main.resourcePath ?? "") + "/freerdp/bin/sdl-freerdp",
                NSString(string: "~/windinghy/vendor/freerdp/bin/sdl-freerdp").expandingTildeInPath,
            ].contains { fm.isExecutableFile(atPath: $0) }
            check(nativeClient || fm.fileExists(atPath: "/Applications/Windows App.app"), "RDP client available",
                  "Rebuild WinDinghy (host/menubar/build.sh builds the native client), or install \"Windows App\" from the Mac App Store.")
            if c.vmBackend == "qemu" {
                let qemuPath = "/opt/homebrew/opt/qemu/bin/qemu-system-aarch64"
                let qemuThere = fm.isExecutableFile(atPath: qemuPath)
                var qemuRuns = false
                if qemuThere {
                    let p = Process()
                    p.executableURL = URL(fileURLWithPath: qemuPath)
                    p.arguments = ["--version"]
                    p.standardOutput = FileHandle.nullDevice
                    p.standardError = FileHandle.nullDevice
                    if (try? p.run()) != nil { p.waitUntilExit(); qemuRuns = p.terminationStatus == 0 }
                }
                check(qemuRuns, qemuThere ? "QEMU installed but won't run" : "QEMU installed",
                      qemuThere ? "Run: brew reinstall qemu (a cleanup likely removed a library it needs)" : "Run: brew install qemu")
            } else {
                check(fm.fileExists(atPath: "/Applications/UTM.app"), "UTM installed",
                      "Install UTM from https://mac.getutm.app — or choose \"Set Up Windows VM…\" to build a WinDinghy VM that needs no UTM.")
            }
            check(findNode() != nil, "Node.js available",
                  "Install node (brew install node) — the launchers use it to find the VM.")
            check(findDinghy() != nil, "dinghy CLI found",
                  "keep the windinghy folder at ~/windinghy, or set DINGHY_PATH.")

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
                  c.vmBackend == "qemu" ? "Choose \"Start Windows VM\" from this menu (or run: dinghy vm start)." : "Start the VM in UTM. If the agent was never installed, choose \"Set Up Windows VM…\" from this menu.")
            if apiOk, let skew = skewSec {
                check(skew < 120, "Guest clock skew \(Int(skew))s",
                      "Guest clock drifted — RDP will fail with security errors (0x1807). In the VM run `w32tm /resync`, or restart the VM. Re-running the setup one-liner installs an automatic 15-minute sync.")
            }

            let rdpOk = tcpOpen(host: c.host, port: c.rdpPort)
            check(rdpOk, "RDP reachable (\(c.host):\(c.rdpPort))",
                  "Windows isn't accepting RDP — choose \"Set Up Windows VM…\" from this menu and re-run the command inside the VM (requires Windows Pro/Enterprise, not Home).")

            let appMgmtOK = self.appManagementAllowed()
            check(appMgmtOK, "App Management permission (lets WinDinghy update app launchers)",
                  "Turn on WinDinghy in System Settings > Privacy & Security > App Management.")

            if c.vmBackend == "qemu" {
                let loginOn = SMAppService.mainApp.status == .enabled
                let auto = ConfigFile.bool("vmAutoStart", true)
                if auto && !loginOn {
                    check(false, "Windows starts with WinDinghy, but WinDinghy doesn't start at login",
                          "Either turn on \"Start WinDinghy at login\" (General), or accept that Windows only starts once you open WinDinghy.")
                }
                let how = ConfigFile.string("vmOnQuit", "save"), idle = ConfigFile.string("vmIdleAction", "off")
                if how == "save" || idle == "save" {
                    let need = Double(ConfigFile.int("vmRamGB", 6) + ConfigFile.int("vmMinFreeGB", 2))
                    var dir = URL(fileURLWithPath: c.vmDir)
                    while !fm.fileExists(atPath: dir.path) && dir.path != "/" { dir.deleteLastPathComponent() }
                    let free = (try? dir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
                    let freeGB = Double(free ?? Int64.max) / 1_073_741_824
                    check(freeGB >= need, String(format: "Enough free space to save Windows's state (%.0f GB free, %.0f GB needed)", min(freeGB, 9999), need),
                          "Free up space or move the VM. Until then Windows is shut down normally on quit instead of saved.")
                }
            }
            let launcherCount = ((try? fm.contentsOfDirectory(atPath: c.appsDir)) ?? []).filter { $0.hasSuffix(".app") }.count
            check(launcherCount > 0, "\(launcherCount) app launchers synced",
                  "Run Sync Apps Now from this menu (VM must be online).")

            // Launchers that pin a node/dinghy path that no longer exists silently open Windows App.
            let staleLaunchers = ((try? fm.contentsOfDirectory(atPath: c.appsDir)) ?? []).filter { $0.hasSuffix(".app") }.filter { name in
                guard let t = try? String(contentsOfFile: c.appsDir + "/" + name + "/Contents/MacOS/launcher", encoding: .utf8),
                      let re = try? NSRegularExpression(pattern: "\\[ -x \"([^\"]+)\" \\] && \\[ -f \"([^\"]+)\"|\\[ -n \"\\$NODE\" \\] && \\[ -f \"([^\"]+)\""),
                      let m = re.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) else { return false }
                for i in 1..<m.numberOfRanges {
                    if let r = Range(m.range(at: i), in: t), !fm.fileExists(atPath: String(t[r])) { return true }
                }
                return false
            }
            check(staleLaunchers.isEmpty, staleLaunchers.isEmpty ? "App launchers can find node and dinghy" : "\(staleLaunchers.count) launchers point at a missing node/dinghy (they'd open Windows App)",
                  "Run Sync Apps Now from this menu.")

            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = advice.isEmpty ? "WinDinghy is fully set up" : "WinDinghy setup needs attention"
                var body = lines.joined(separator: "\n")
                if !advice.isEmpty {
                    body += "\n\nWhat to do:\n" + advice.joined(separator: "\n")
                }
                alert.informativeText = body
                alert.alertStyle = advice.isEmpty ? .informational : .warning
                alert.addButton(withTitle: "OK")
                if !appMgmtOK { alert.addButton(withTitle: "Open App Management") }
                NSApp.activate(ignoringOtherApps: true)
                if alert.runModal() == .alertSecondButtonReturn, !appMgmtOK,
                   let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles") {
                    NSWorkspace.shared.open(url)
                }
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
        p.arguments = ["-e", "display notification \(jsonEscape(msg)) with title \"WinDinghy\""]
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

/// A menu row for one Windows app. Menus ignore right-clicks on plain rows, so this draws its own row
/// (matching the system look) and handles the mouse itself.
final class AppRowView: NSView {
    let name: String
    let icon: NSImage
    var blocker: String?          // why Run as Administrator isn't available, if it isn't
    var onOpen: (() -> Void)?
    var onAdmin: (() -> Void)?
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
        if e.modifierFlags.contains(.option) { onAdmin?() } else { onOpen?() }
    }
    override func rightMouseUp(with e: NSEvent) { showChoices() }

    private func showChoices() {
        enclosingMenuItem?.menu?.cancelTracking()
        let m = NSMenu()
        let open = NSMenuItem(title: "Open", action: #selector(chooseOpen), keyEquivalent: "")
        let admin = NSMenuItem(title: "Run as Administrator", action: blocker == nil ? #selector(chooseAdmin) : nil, keyEquivalent: "")
        admin.toolTip = blocker
        for i in [open, admin] { i.target = self }
        m.addItem(open); m.addItem(admin)
        if let why = blocker {
            let note = NSMenuItem(title: why, action: nil, keyEquivalent: ""); note.isEnabled = false
            m.addItem(note)
        }
        // After the main menu has closed
        DispatchQueue.main.async { m.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil) }
    }
    @objc private func chooseOpen() { onOpen?() }
    @objc private func chooseAdmin() { onAdmin?() }
}
