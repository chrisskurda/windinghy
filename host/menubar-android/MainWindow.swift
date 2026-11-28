// The main window (SwiftUI), built like WinDinghy's: sidebar + detail, a status card, and a first-run
// setup flow. State lives in AppStore; actions go to the `robodinghy` CLI.
import SwiftUI
import AppKit
import ServiceManagement

// MARK: - shell

struct MainView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        Group {
            if store.setupPhase != nil {
                SetupView()   // first-run flow replaces the main UI (so no toolbar shows through)
            } else {
                NavigationSplitView {
                    SidebarView()
                        .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 260)
                } detail: {
                    DetailView()
                }
            }
        }
        .frame(minWidth: 900, minHeight: 600)
        .onAppear { store.start() }
    }
}

struct SidebarView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        List(selection: Binding(get: { store.screen }, set: { store.screen = $0 ?? .apps })) {
            ForEach(Screen.sections, id: \.0) { section in
                Section(section.0) {
                    ForEach(section.1) { s in Label(s.title, systemImage: s.symbol).tag(s) }
                }
            }
            Section {
                Label(Screen.general.title, systemImage: Screen.general.symbol).tag(Screen.general)
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) { StatusCard().padding(10) }
    }
}

/// "Android is running" plus a short state line, as the sidebar footer.
func androidStateTitle(_ store: AppStore) -> String {
    if store.vmOnline { return "\(Product.os) is running" }
    if store.vmPaused { return "\(Product.os) is paused" }
    if store.vmRunning { return "\(Product.os) is starting…" }
    return "\(Product.os) is off"
}

struct StatusCard: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(store.vmOnline ? Color.green : Color.secondary.opacity(0.5)).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(store.busy ?? androidStateTitle(store)).font(.system(size: 12, weight: .medium))
                Text(subline).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(.quaternary))
    }

    var subline: String {
        if store.vmPaused { return "Wakes when you open an app" }
        if store.vmRunning && !store.vmOnline { return "Booting, usually under a minute" }
        guard store.vmOnline else { return "Starts when you open an app" }
        let ram = store.ramUsedMB > 0 ? String(format: "%.1f GB", store.ramUsedMB / 1024) : "–"
        let n = store.running.count
        return String(format: "CPU %.0f%% · RAM %@ · %d app%@ open", store.cpu, ram, n, n == 1 ? "" : "s")
    }
}

struct DetailView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        Group {
            switch store.screen {
            case .apps: AppsView()
            case .desktop: DesktopView()
            case .software: SoftwareView()
            case .android: AndroidView()
            case .resources: ResourcesView()
            case .sharing: SharingView()
            case .snapshots: SnapshotsView()
            case .storage: StorageView()
            case .general: GeneralView()
            }
        }
        .navigationTitle(store.screen.title)
    }
}

// MARK: - shared bits

// Box, Card, StatusDot, Metric, SliderRow, KV, Row and note() live in host/common/swift/UIKit.swift.

/// "Google Play" / "AOSP" for an edition id.
func editionName(_ id: String) -> String {
    switch id {
    case "aosp": return "AOSP"
    case "play", "": return "Google Play"
    default: return id
    }
}

// MARK: - Apps

struct AppsView: View {
    @EnvironmentObject var store: AppStore
    let columns = [GridItem(.adaptive(minimum: 112), spacing: 16)]

    var body: some View {
        let apps = store.filteredApps()
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Color.clear.frame(height: 0).id("top")
                Text("\(store.apps.count) \(Product.os) apps").font(.system(size: 13)).foregroundStyle(.secondary)
                if apps.isEmpty {
                    Text(store.apps.isEmpty ? "No apps yet. Choose Sync Apps Now once \(Product.os) is running." : "No apps match “\(store.query)”.")
                        .foregroundStyle(.secondary).padding(.top, 30).frame(maxWidth: .infinity)
                }
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(apps) { app in AppCell(app: app) }
                }
                Divider().padding(.top, 8)
                Text("Each app is a real .app in \(store.cfg.appsDir.replacingOccurrences(of: NSHomeDirectory(), with: "~")), available from Spotlight and Finder. Opening one starts \(Product.os) if needed.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .padding(24)
        }
        // Scroll to the top whenever the list or search changes (macOS 13 workaround, as in WinDinghy).
        .task(id: "\(store.apps.count)|\(store.query)") {
            try? await Task.sleep(nanoseconds: 50_000_000)   // let the grid lay out first
            proxy.scrollTo("top", anchor: .top)
        }
        }
        .searchable(text: $store.query, prompt: "Search apps")
        .toolbar {
            ToolbarItem {
                Button { store.syncApps() } label: {
                    Label(store.syncing ? "Syncing…" : "Sync Apps Now", systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(store.syncing)
            }
        }
    }
}

struct AppCell: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var tools: ToolsStore
    let app: AndroidApp
    @StateObject private var hover = Box(false)

    var body: some View {
        let isRunning = store.running.contains(app.name)
        VStack(spacing: 8) {
            Image(nsImage: store.icon(for: app)).resizable().frame(width: 52, height: 52)
            Text(app.name).font(.system(size: 13, weight: .medium)).multilineTextAlignment(.center).lineLimit(2)
                .frame(height: 34, alignment: .top)   // same height for 1- and 2-line names so icons line up
            Text(isRunning ? "Open" : " ").font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(EdgeInsets(top: 14, leading: 6, bottom: 10, trailing: 6))
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 10).fill((isRunning || hover.value) ? AnyShapeStyle(.quaternary) : AnyShapeStyle(Color.clear)))
        .contentShape(Rectangle())
        .onHover { hover.value = $0 }
        .onTapGesture { store.launch(app) }
        .contextMenu {
            Button("Open") { store.launch(app) }
            if isRunning { Button("Quit") { store.quit(app) } }
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: app.path)]) }
            if !app.package.isEmpty {
                Divider()
                Button("Uninstall from \(Product.os)…") { tools.confirmUninstall(app) }
            }
        }
    }
}

// MARK: - Android (machine)

struct AndroidView: View {
    @EnvironmentObject var store: AppStore

    var headline: String {
        let v = store.status?.android ?? ""
        return v.isEmpty ? Product.os : (v.lowercased().hasPrefix(Product.os.lowercased()) ? v : "\(Product.os) \(v)")
    }

    var subline: String {
        let s = store.status
        var parts: [String] = [editionName((s?.edition).flatMap { $0.isEmpty ? nil : $0 } ?? store.cfg.edition)]
        let api = (s?.api).flatMap { $0.isEmpty ? nil : $0 } ?? store.cfg.apiLevel
        parts.append("API \(api)")
        parts.append(store.busy ?? (store.vmOnline ? "Running" : store.vmPaused ? "Paused" : store.vmRunning ? "Starting" : "Off"))
        return parts.joined(separator: " · ")
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                Card(padding: 18) {
                    HStack(spacing: 14) {
                        Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 48, height: 48)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(headline).font(.system(size: 16, weight: .semibold))
                            Text(subline).font(.system(size: 13)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if store.vmPaused {
                            Button("Wake \(Product.os)") { store.startAndroid() }.buttonStyle(.borderedProminent).disabled(store.busy != nil)
                        } else if store.vmRunning {
                            Button("Restart") { store.restartAndroid() }.disabled(store.busy != nil)
                            Button("Stop \(Product.os)") { store.stopAndroid() }.disabled(store.busy != nil)
                        } else {
                            Button("Start \(Product.os)") { store.startAndroid() }.buttonStyle(.borderedProminent)
                                .disabled(store.busy != nil || !store.vmExists)
                        }
                    }
                }
                HStack(spacing: 14) {
                    // CPU is the emulator's share of the VM's cores. Memory is what the emulator takes on the
                    // Mac (guest RAM plus emulator overhead), so it gets no "of N GB": it can pass the guest's
                    // size. The bar compares it with the RAM given to Android.
                    Metric(label: "CPU", value: store.vmOnline ? String(format: "%.0f%%", store.cpu) : "–", fraction: store.cpu / 100)
                    Metric(label: store.ramTotalMB > 0 ? "Memory" : "Memory on this Mac",
                           value: store.ramUsedMB <= 0 ? "–"
                               : store.ramTotalMB > 0 ? String(format: "%.1f of %.0f GB", store.ramUsedMB / 1024, store.ramTotalMB / 1024)
                               : String(format: "%.1f GB", store.ramUsedMB / 1024),
                           fraction: store.ramUsedMB / (store.ramTotalMB > 0 ? store.ramTotalMB : Double(store.ramGB * 1024)))
                    Metric(label: "Disk",
                           value: store.diskTotalGB > 0 && store.diskUsedGB > 0 ? String(format: "%.1f of %.0f GB", store.diskUsedGB, store.diskTotalGB) : "–",
                           fraction: store.diskTotalGB > 0 ? store.diskUsedGB / store.diskTotalGB : 0)
                }
                Card(padding: 4) {
                    VStack(spacing: 0) {
                        ForEach(Array(store.health.enumerated()), id: \.element.id) { i, row in
                            HStack {
                                Text(row.title).font(.system(size: 13))
                                Text(row.detail).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
                                Spacer()
                                StatusDot(ok: row.ok)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 9)
                            if i < store.health.count - 1 { Divider() }
                        }
                        if store.health.isEmpty {
                            Text("Checking…").foregroundStyle(.secondary).padding(14)
                        }
                    }
                }
                Card {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Show the \(Product.os) screen").font(.system(size: 13, weight: .medium))
                            Text("Opens the whole \(Product.os) screen in a window. Apps normally run without it.").font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Open Desktop") { store.openDesktop() }
                    }
                }
            }
            .padding(24)
        }
    }
}

// MARK: - Resources

struct ResourcesView: View {
    @EnvironmentObject var store: AppStore

    static let windowSizes = ["1024x768", "1280x800", "1440x900", "1920x1200", "800x1280"]
    static let densities: [(Int, String)] = [(160, "Small (160 dpi)"), (240, "Standard (240 dpi)"), (320, "Large (320 dpi)")]

    var body: some View {
        Form {
            Section {
                SliderRow(title: "Processor cores", value: $store.cores, range: 2...max(2, min(8, store.hostCores)), step: 1,
                          display: "\(store.cores) cores", note: "Of \(store.hostCores) on this Mac.")
                SliderRow(title: "Memory", value: $store.ramGB, range: 4...max(4, min(8, store.hostRAMGB - 4)), step: 1,
                          display: "\(store.ramGB) GB",
                          note: store.ramGB <= 4 ? "4 GB is the minimum the Android emulator uses. Bigger apps may close in the background." : "Of \(store.hostRAMGB) GB on this Mac. The Google Play edition uses about 1 GB more on the Mac than this.")
                SliderRow(title: "Storage", value: $store.diskGB, range: 8...64, step: 4,
                          display: "\(store.diskGB) GB", note: "Space for apps and their data inside \(Product.os).")
            } footer: {
                Text("Resource changes apply the next time \(Product.os) starts.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Section {
                Picker("Window size", selection: $store.windowSize) {
                    ForEach(Self.windowSizes + (Self.windowSizes.contains(store.windowSize) ? [] : [store.windowSize]), id: \.self) { s in
                        Text(s.replacingOccurrences(of: "x", with: " × ") + (s == "800x1280" ? " (portrait)" : "")).tag(s)
                    }
                }
                Picker("Text and icon size", selection: $store.displayDpi) {
                    ForEach(Self.densities + (Self.densities.contains { $0.0 == store.displayDpi } ? [] : [(store.displayDpi, "\(store.displayDpi) dpi")]), id: \.0) { d in
                        Text(d.1).tag(d.0)
                    }
                }
            } header: { Text("App windows") } footer: {
                Text("Each app opens in a window this size, on a display of its own. Changes apply the next time an app opens; you can resize windows as usual.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            PowerSection()
            Section {
                DisclosureGroup("Advanced") {
                    let c = store.cfg
                    KV("Virtual device (AVD)", Product.avdName)
                    KV("Device serial", (store.status?.serial).flatMap { $0.isEmpty ? nil : $0 } ?? c.serial)
                    KV("Emulator console port", "127.0.0.1:\(c.consolePort)")
                    KV("adb port", "127.0.0.1:\(c.adbPort)")
                    KV("System image", c.image.isEmpty ? "\(editionName(c.edition)) · API \(c.apiLevel)" : c.image)
                    KV("Video", "\(c.videoCodec) · up to \(c.maxFps) fps")
                    KV("Hide system apps", c.filter == "off" ? "Off" : "On")
                }
            }
        }
        .formStyle(.grouped)
        .frame(maxWidth: 620)
        .frame(maxWidth: .infinity)
    }
}

struct PowerSection: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var autoStartBox = Box(true)
    @StateObject private var delayBox = Box(30)
    @StateObject private var onQuitBox = Box("save")
    @StateObject private var idleActionBox = Box("off")
    @StateObject private var idleMinutesBox = Box(15)
    @StateObject private var minFreeBox = Box(2)
    @StateObject private var loginOnBox = Box(false)
    @StateObject private var freeGBBox = Box<Double?>(nil)

    private var ramGB: Int { ConfigFile.int("vmRamGB", 4) }
    private var needGB: Int { ramGB + minFreeBox.value }
    private var spaceShort: Bool { (freeGBBox.value ?? 9999) < Double(needGB) }
    private var savesState: Bool { onQuitBox.value == "save" || idleActionBox.value == "save" }
    private let os = Product.os, app = Product.name

    var body: some View {
        Section {
            Toggle("Start \(os) when \(app) opens", isOn: Binding(get: { autoStartBox.value }, set: { autoStartBox.value = $0; ConfigFile.setBool("vmAutoStart", $0) }))
            if autoStartBox.value {
                Picker("Delay after login", selection: Binding(get: { delayBox.value }, set: { delayBox.value = $0; ConfigFile.set("vmStartDelaySec", $0) })) {
                    Text("None").tag(0); Text("15 seconds").tag(15); Text("30 seconds").tag(30)
                    Text("1 minute").tag(60); Text("2 minutes").tag(120); Text("5 minutes").tag(300)
                }
            }
            if autoStartBox.value && !loginOnBox.value {
                note("\(app) isn't set to start at login (General), so \(os) only starts once you open \(app) yourself.", warn: true)
            } else if !autoStartBox.value && loginOnBox.value {
                note("\(app) starts at login, but \(os) will only start when you open an app.", warn: false)
            } else if autoStartBox.value && delayBox.value > 0 {
                note("The delay applies when \(app) opens at login, so logging in stays quick. Opening it yourself starts \(os) right away.", warn: false)
            }
            Picker("When \(app) quits", selection: Binding(get: { onQuitBox.value }, set: { onQuitBox.value = $0; ConfigFile.set("vmOnQuit", $0) })) {
                Text("Save \(os) and stop it").tag("save")
                Text("Shut \(os) down").tag("shutdown")
                Text("Leave \(os) running").tag("keep")
            }
            Picker("When no \(os) apps are open", selection: Binding(get: { idleActionBox.value }, set: { idleActionBox.value = $0; ConfigFile.set("vmIdleAction", $0) })) {
                Text("Do nothing").tag("off")
                Text("Pause \(os) (saves power, wakes instantly)").tag("pause")
                Text("Save \(os) and stop it").tag("save")
                Text("Shut \(os) down").tag("shutdown")
            }
            if idleActionBox.value != "off" {
                Picker("After", selection: Binding(get: { idleMinutesBox.value }, set: { idleMinutesBox.value = $0; ConfigFile.set("vmIdleMinutes", $0) })) {
                    ForEach([5, 10, 15, 30, 60, 120], id: \.self) { Text($0 < 60 ? "\($0) minutes" : "\($0 / 60) hour\($0 == 60 ? "" : "s")").tag($0) }
                }
            }
            if savesState {
                Stepper(value: Binding(get: { minFreeBox.value }, set: { minFreeBox.value = $0; ConfigFile.set("vmMinFreeGB", $0) }), in: 0...100) {
                    HStack { Text("Keep free after saving"); Spacer(); Text("\(minFreeBox.value) GB").foregroundStyle(.secondary) }
                }
                if spaceShort {
                    note(String(format: "Only %.0f GB is free on the disk %@ lives on; a saved state needs %d GB (%d GB of memory + %d GB kept free). Until there's room, %@ is shut down normally instead of saved. Free up space, or move it in Storage & Backup.", freeGBBox.value ?? 0, os, needGB, ramGB, minFreeBox.value, os), warn: true)
                } else {
                    note("A saved state is about as large as \(os)'s memory (\(ramGB) GB) and is replaced each time. Needs \(needGB) GB free; \(Int(freeGBBox.value ?? 0)) GB is.", warn: false)
                }
            }
            if idleActionBox.value == "pause" {
                note("Paused \(os) keeps its memory but uses no processor time. Background work (downloads, sync, notifications) stops until you open an app.", warn: false)
            }
        } header: { Text("Power") } footer: {
            Text("Saving stores \(os)'s state in a snapshot, so the next start picks up where you left off in a few seconds.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .onAppear(perform: load)
    }

    private func load() {
        autoStartBox.value = ConfigFile.bool("vmAutoStart", true)
        delayBox.value = ConfigFile.int("vmStartDelaySec", 30)
        onQuitBox.value = ConfigFile.string("vmOnQuit", "save")
        idleActionBox.value = ConfigFile.string("vmIdleAction", "off")
        idleMinutesBox.value = ConfigFile.int("vmIdleMinutes", 15)
        minFreeBox.value = ConfigFile.int("vmMinFreeGB", 2)
        loginOnBox.value = SMAppService.mainApp.status == .enabled
        var dir = URL(fileURLWithPath: store.cfg.vmDir)
        while !FileManager.default.fileExists(atPath: dir.path) && dir.path != "/" { dir.deleteLastPathComponent() }
        if let b = (try? dir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage { freeGBBox.value = Double(b) / 1_073_741_824 }
    }
}

// MARK: - Sharing

struct SharingView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        Form {
            Section {
                Toggle(isOn: $store.shareClipboard) { Row("Clipboard", "Copy and paste between Mac and \(Product.os) apps.") }
                Toggle(isOn: $store.shareAudio) { Row("Audio", "Play sound from \(Product.os) apps on this Mac.") }
            } footer: {
                Text("Changes apply the next time an app opens.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .toggleStyle(.switch)
            Section {
                Text("\(Product.os) apps can't see your Mac folders. To move files, use a cloud service inside \(Product.os), or install app files (.apk) from Software.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            } header: { Text("Files") }
        }
        .formStyle(.grouped)
        .frame(maxWidth: 620)
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Snapshots

struct SnapshotsView: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var confirm = Box<SnapshotItem?>(nil)
    @StateObject private var deleting = Box<SnapshotItem?>(nil)
    @StateObject private var naming = Box(false)
    @StateObject private var newName = Box("")

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Rewind \(Product.os) to an earlier state. Your Mac files are not affected.").foregroundStyle(.secondary)
                    Spacer()
                    Button("Take Snapshot") { newName.value = ""; naming.value = true }
                        .buttonStyle(.borderedProminent).disabled(store.snapshotBusy || !store.vmExists)
                }
                if store.snapshotBusy {
                    HStack { ProgressView().controlSize(.small); Text("Working… \(Product.os) pauses briefly.").foregroundStyle(.secondary) }
                }
                if let m = store.snapshotMessage {
                    Label(m, systemImage: "exclamationmark.triangle.fill").font(.system(size: 12)).foregroundStyle(Color.orange)
                }
                Card(padding: 4) {
                    VStack(spacing: 0) {
                        if store.snapshots.isEmpty {
                            Text("No snapshots yet.").foregroundStyle(.secondary).padding(14)
                        }
                        ForEach(Array(store.snapshots.enumerated()), id: \.element.id) { i, s in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(s.name).font(.system(size: 13, weight: .medium))
                                    Text(s.date.timeIntervalSince1970 > 0 ? s.date.formatted(.dateTime.month().day().hour().minute()) : " ")
                                        .font(.system(size: 12)).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Rewind") { confirm.value = s }.disabled(store.snapshotBusy)
                                Button { deleting.value = s } label: { Image(systemName: "trash") }
                                    .buttonStyle(.borderless).help("Delete this snapshot").disabled(store.snapshotBusy)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 9)
                            if i < store.snapshots.count - 1 { Divider() }
                        }
                    }
                }
            }
            .padding(24)
        }
        .onAppear { store.loadSnapshots() }
        .alert("Rewind \(Product.os)?", isPresented: Binding(get: { confirm.value != nil }, set: { if !$0 { confirm.value = nil } })) {
            Button("Cancel", role: .cancel) {}
            Button("Rewind", role: .destructive) { if let s = confirm.value { store.rewind(s.name) } }
        } message: {
            Text("Everything changed in \(Product.os) since “\(confirm.value?.name ?? "")” (apps, their data, settings) will be lost.")
        }
        .alert("Delete this snapshot?", isPresented: Binding(get: { deleting.value != nil }, set: { if !$0 { deleting.value = nil } })) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { if let s = deleting.value { store.deleteSnapshot(s.name) } }
        } message: {
            Text("“\(deleting.value?.name ?? "")” is removed. \(Product.os) itself doesn't change.")
        }
        .alert("Take a snapshot", isPresented: $naming.value) {
            TextField("Name (optional)", text: $newName.value)
            Button("Cancel", role: .cancel) {}
            Button("Take Snapshot") { store.takeSnapshot(newName.value.trimmingCharacters(in: .whitespaces)) }
        } message: {
            Text("Letters, digits, . _ and -. Leave it blank for a dated name.")
        }
    }
}

// MARK: - General

struct GeneralView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var tools: ToolsStore
    @StateObject private var login = Box(SMAppService.mainApp.status == .enabled)
    @StateObject private var removing = Box(false)

    var body: some View {
        Form {
            Section("Startup & appearance") {
                Toggle("Start \(Product.name) at login", isOn: Binding(get: { login.value }, set: { setLogin($0) }))
                if login.value && ConfigFile.bool("vmAutoStart", true) {
                    Text("\(Product.os) also starts with \(Product.name), after a short delay (see Power in Resources).")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Picker("Menu bar icon", selection: Binding(get: { store.menubarIcon }, set: { store.menubarIcon = $0; store.delegate?.setMenubarIcon($0) })) {
                    Text("\(Product.name) dinghy").tag("boat")
                    Text("Antenna symbol").tag("symbol")
                }
            }
            Section("Maintenance") {
                HStack {
                    Button("Setup Check…") { store.delegate?.setupCheck() }
                    Button("Fix Problems…") { store.delegate?.showFix() }
                    Button("Check for Updates…") { store.delegate?.checkForUpdates() }
                }
                HStack {
                    Button("Open Apps Folder") { store.delegate?.openFolder() }
                    Button("Show VM Folder") { store.delegate?.openVMFolder() }
                }
            }
            AboutSection()
            Section {
                Toggle("Advanced mode", isOn: Binding(get: { store.advanced }, set: { _ in store.delegate?.toggleAdvanced() }))
                if store.advanced {
                    Toggle("Show system apps in Apps", isOn: Binding(get: { store.cfg.filter == "off" }, set: { ConfigFile.set("filter", $0 ? "off" : "on"); store.refresh() }))
                }
            } footer: {
                Text("Unlocks unsupported setups: other system images (set one in Storage & Backup) and system apps. Sync again after changing the app filter.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Section {
                if let pct = tools.removePct {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(tools.removeTitle).font(.system(size: 13, weight: .semibold))
                        ProgressView(value: pct / 100).progressViewStyle(.linear)
                    }
                }
                HStack {
                    Row("Uninstall \(Product.name)", "Delete \(Product.os), its snapshots and your app launchers from this Mac.")
                    Spacer()
                    Button("Uninstall…") { removing.value = true }.disabled(tools.removePct != nil || tools.storageBusy != nil)
                }
                if let m = tools.storageMessage, tools.removePct == nil { Text(m).font(.system(size: 12)).foregroundStyle(.secondary) }
            } header: { Text("Uninstall") }
        }
        .formStyle(.grouped)
        .frame(maxWidth: 620)
        .frame(maxWidth: .infinity)
        .sheet(isPresented: $removing.value) {
            ResetSheet(kind: .uninstall).environmentObject(store).environmentObject(tools)
        }
    }

    func setLogin(_ on: Bool) {
        do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch {}
        login.value = SMAppService.mainApp.status == .enabled
    }
}

// MARK: - first-run setup

struct SetupView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        ZStack {
            Rectangle().fill(.background)
            VStack(spacing: 18) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 120, height: 120)
                    .shadow(color: Color(red: 0.05, green: 0.55, blue: 0.50).opacity(0.4), radius: 12, y: 8)
                content
            }
            .frame(width: 520)
            .multilineTextAlignment(.center)
        }
    }

    var licenceToggle: some View {
        VStack(spacing: 6) {
            Toggle("I accept the Android SDK licence terms", isOn: $store.licencesAccepted).toggleStyle(.checkbox)
            HStack(spacing: 4) {
                Text("Setup downloads the Android Emulator and a system image with Google's SDK tools, under Google's licence.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Link("Read the licence", destination: URL(string: "https://developer.android.com/studio/terms")!).font(.system(size: 11))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(.quaternary))
    }

    @ViewBuilder var content: some View {
        switch store.setupPhase {
        case .welcome?, nil:
            Text("\(Product.os) apps on your Mac").font(.system(size: 26, weight: .bold))
            Text("\(Product.name) runs \(Product.os) in the background. Your \(Product.os) apps appear in the Dock, Spotlight and Finder like any other Mac app.")
                .font(.system(size: 15)).foregroundStyle(.secondary)
            EditionPicker()
            licenceToggle
            Button { store.beginSetup() } label: { Text("Set Up \(Product.os)").font(.system(size: 15, weight: .semibold)).padding(.horizontal, 28) }
                .buttonStyle(.borderedProminent).controlSize(.large).disabled(!store.licencesAccepted)
            Button("Customize…") { store.setupPhase = .customize }.buttonStyle(.link)
            Text("Downloads about 2–3 GB. Needs \(store.diskGB + 6) GB free disk space.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            Text("Independent project: not affiliated with or endorsed by Google. Android is a trademark of Google LLC.")
                .font(.system(size: 10)).foregroundStyle(.tertiary)
        case .customize?:
            Text("Customize").font(.system(size: 22, weight: .bold))
            Form {
                Picker("Edition", selection: $store.setupEdition) {
                    Text("Google Play (recommended)").tag("play")
                    Text("AOSP").tag("aosp")
                }
                SliderRow(title: "Processor cores", value: $store.cores, range: 2...max(2, min(8, store.hostCores)), step: 1,
                          display: "\(store.cores) cores", note: "Of \(store.hostCores) on this Mac.")
                SliderRow(title: "Memory", value: $store.ramGB, range: 4...max(4, min(8, store.hostRAMGB - 4)), step: 1,
                          display: "\(store.ramGB) GB", note: "3 GB suits most apps.")
                SliderRow(title: "Storage", value: $store.diskGB, range: 8...64, step: 4,
                          display: "\(store.diskGB) GB", note: "Space for apps and their data.")
                if store.advanced {
                    TextField("Custom system image (SDK package id)", text: $store.setupImage)
                        .font(.system(size: 12, design: .monospaced))
                }
                HStack { Text("\(Product.os) version"); Spacer(); Text("\(Product.os) 17 · API \(store.cfg.apiLevel) · ARM64").foregroundStyle(.secondary) }
            }
            .formStyle(.grouped).frame(height: store.advanced ? 380 : 340)
            .multilineTextAlignment(.leading)
            licenceToggle
            HStack {
                Button("Back") { store.setupPhase = .welcome }
                Button("Install") { store.beginSetup() }.buttonStyle(.borderedProminent).disabled(!store.licencesAccepted)
            }
        case .installing(let pct, let title)?:
            Text(title).font(.system(size: 22, weight: .bold))
            ProgressView(value: pct / 100).progressViewStyle(.linear).frame(width: 360)
            Text("\(Int(pct))% · about 5 to 10 minutes in total. You can keep using your Mac.").font(.system(size: 12)).foregroundStyle(.secondary)
        case .done(let n)?:
            Text("\(Product.os) is ready").font(.system(size: 26, weight: .bold))
            Text("\(n) apps were added to \(store.cfg.appsDir.replacingOccurrences(of: NSHomeDirectory(), with: "~")).").font(.system(size: 15)).foregroundStyle(.secondary)
            Button("Show My Apps") { store.setupPhase = nil; store.screen = .apps; store.refresh() }.buttonStyle(.borderedProminent).controlSize(.large)
            Text(store.setupEdition == "aosp"
                 ? "Get more apps from F-Droid in Software, or install an APK."
                 : "Open the Play Store from Software and sign in with your Google account to get more apps.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        case .failed(let msg)?:
            if msg.hasPrefix("LICENCE:") {
                Text("The SDK licences weren't accepted").font(.system(size: 22, weight: .bold))
                Text(msg.replacingOccurrences(of: "LICENCE:", with: "").trimmingCharacters(in: .whitespaces))
                    .font(.system(size: 13)).foregroundStyle(.secondary).textSelection(.enabled)
                licenceToggle
                Button("Try Again") { store.beginSetup() }.buttonStyle(.borderedProminent).disabled(!store.licencesAccepted)
            } else {
                Text("Setup didn't finish").font(.system(size: 22, weight: .bold))
                Text(msg.hasPrefix("Error: ") ? String(msg.dropFirst(7)) : msg).font(.system(size: 13)).foregroundStyle(.secondary).textSelection(.enabled)
                HStack {
                    Button("Setup Check…") { store.delegate?.setupCheck() }
                    // A setup that failed after creating the AVD (first boot, sync) leaves a VM on disk, and the
                    // welcome screen gives way to the main window as soon as refresh() sees it: rerun setup
                    // instead (it's idempotent and picks up where it stopped).
                    Button("Try Again") {
                        if store.vmExists && store.licencesAccepted { store.beginSetup() } else { store.setupPhase = .welcome }
                    }.buttonStyle(.borderedProminent)
                }
            }
        }
    }
}

/// The two supported editions as side-by-side choices.
struct EditionPicker: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        HStack(spacing: 12) {
            choice("play", "Google Play", "Recommended. The Play Store, with your Google account.", "bag")
            choice("aosp", "AOSP", "Open source, no Google services. Apps from F-Droid.", "shippingbox")
        }
    }

    func choice(_ id: String, _ title: String, _ detail: String, _ symbol: String) -> some View {
        let on = store.setupEdition == id
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: symbol).foregroundStyle(on ? Color.accentColor : Color.secondary)
                Text(title).font(.system(size: 14, weight: .semibold))
                Spacer()
                Image(systemName: on ? "checkmark.circle.fill" : "circle").foregroundStyle(on ? Color.accentColor : Color.secondary)
            }
            Text(detail).font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 78, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 10).fill(.quaternary))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(on ? Color.accentColor : Color.clear, lineWidth: 2))
        .contentShape(Rectangle())
        .onTapGesture { store.setupEdition = id }
    }
}
