// The WinDinghy main window (SwiftUI), following the design handoff: sidebar + detail, a status card,
// and a first-run setup flow. State lives in AppStore; actions go to the `dinghy` CLI.
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

struct StatusCard: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(store.vmOnline ? Color.green : Color.secondary.opacity(0.5)).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(store.busy ?? (store.vmOnline ? "Windows is running" : "Windows is off")).font(.system(size: 12, weight: .medium))
                Text(subline).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(.quaternary))
    }

    var subline: String {
        guard store.vmOnline else { return "Starts when you open an app" }
        let ram = store.ramTotalMB > 0 ? String(format: "%.1f GB", store.ramUsedMB / 1024) : "–"
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
            case .tools: AppsView(tools: true)
            case .desktop: DesktopView()
            case .software: SoftwareView()
            case .account: AccountView()
            case .enterprise: EnterpriseView()
            case .storage: StorageView()
            case .machine: MachineView()
            case .resources: ResourcesView()
            case .sharing: SharingView()
            case .snapshots: SnapshotsView()
            case .general: GeneralView()
            }
        }
        .navigationTitle(store.screen.title)
    }
}

// MARK: - shared bits

/// Small observable value holder. `@State` is a macro in recent SDKs and needs the SwiftUI macro plugin,
/// which isn't in the Command Line Tools; `@StateObject` + this box needs nothing extra.
final class Box<T>: ObservableObject {
    @Published var value: T
    init(_ v: T) { value = v }
}

struct Card<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(.quaternary))
    }
}

struct StatusDot: View {
    let ok: Bool
    var body: some View { Circle().fill(ok ? Color.green : Color.secondary.opacity(0.5)).frame(width: 8, height: 8) }
}

// MARK: - Apps

struct AppsView: View {
    @EnvironmentObject var store: AppStore
    var tools = false
    let columns = [GridItem(.adaptive(minimum: 112), spacing: 16)]

    var body: some View {
        let apps = store.filteredApps(tools: tools)
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Color.clear.frame(height: 0).id("top")
                Text(tools ? "Windows administration tools, kept apart from your apps." : "\(store.apps.filter { !$0.isTool }.count) Windows apps").font(.system(size: 13)).foregroundStyle(.secondary)
                if apps.isEmpty {
                    Text(store.apps.isEmpty ? "No apps yet. Choose Sync Apps Now once Windows is running." : "No apps match “\(store.query)”.")
                        .foregroundStyle(.secondary).padding(.top, 30).frame(maxWidth: .infinity)
                }
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(apps) { app in AppCell(app: app) }
                }
                Divider().padding(.top, 8)
                Text("Each app is a real .app in ~/Applications/WinDinghy, available from Spotlight and Finder. Opening one starts the VM if needed.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .padding(24)
        }
        // The grid can open scrolled to the end when the list loads after the first layout. A task keyed on
        // the content runs on appear and whenever the list or search changes (works on macOS 13 and later,
        // unlike onChange, whose one-parameter form is deprecated on 14 and whose replacement needs 14).
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
    let app: WinApp
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
            Button("Run as Administrator") { store.launchAsAdmin(app) }
                .disabled(store.adminBlocker(app) != nil)
            if isRunning { Button("Quit") { store.quit(app) } }
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: app.path)]) }
        }
    }
}

// MARK: - Windows (machine)

struct MachineView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                Card(padding: 18) {
                    HStack(spacing: 14) {
                        Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 48, height: 48)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Windows 11").font(.system(size: 16, weight: .semibold))
                            Text("ARM64 · \(store.busy ?? (store.vmOnline ? "Running" : "Off"))").font(.system(size: 13)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if store.vmOnline {
                            Button("Restart") { store.restartWindows() }.disabled(store.busy != nil)
                            Button("Stop Windows") { store.stopWindows() }.disabled(store.busy != nil)
                        } else {
                            Button("Start Windows") { store.startWindows() }.buttonStyle(.borderedProminent).disabled(store.busy != nil)
                        }
                    }
                }
                HStack(spacing: 14) {
                    Metric(label: "CPU", value: String(format: "%.0f%%", store.cpu), fraction: store.cpu / 100)
                    Metric(label: "Memory",
                           value: store.ramTotalMB > 0 ? String(format: "%.1f of %.0f GB", store.ramUsedMB / 1024, store.ramTotalMB / 1024) : "–",
                           fraction: store.ramTotalMB > 0 ? store.ramUsedMB / store.ramTotalMB : 0)
                    Metric(label: "Disk",
                           value: store.diskTotalGB > 0 ? String(format: "%.0f of %.0f GB", store.diskUsedGB, store.diskTotalGB) : "–",
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
                    }
                }
                Card {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Show Windows desktop").font(.system(size: 13, weight: .medium))
                            Text("Opens a full desktop session. Apps normally run without it.").font(.system(size: 12)).foregroundStyle(.secondary)
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

struct Metric: View {
    let label: String, value: String, fraction: Double
    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                Text(label).font(.system(size: 12)).foregroundStyle(.secondary)
                Text(value).font(.system(size: 22, weight: .semibold))
                ProgressView(value: min(max(fraction, 0), 1)).progressViewStyle(.linear)
            }
        }
    }
}

// MARK: - Resources

struct ResourcesView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        Form {
            Section {
                SliderRow(title: "Processor cores", value: $store.cores, range: 2...max(2, min(8, store.hostCores)), step: 1,
                          display: "\(store.cores) cores", note: "Of \(store.hostCores) on this Mac.")
                SliderRow(title: "Memory", value: $store.ramGB, range: 4...max(4, min(16, store.hostRAMGB - 4)), step: 1,
                          display: "\(store.ramGB) GB",
                          note: store.ramGB < 6 ? "4 GB is the minimum. Office apps may feel slow." : "Of \(store.hostRAMGB) GB on this Mac.")
                SliderRow(title: "Disk size", value: $store.diskGB, range: 40...256, step: 8,
                          display: "\(store.diskGB) GB", note: "Disks can grow later, not shrink.")
            } footer: {
                Text("Resource changes apply the next time the Windows machine starts.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            if store.cfg.vmBackend == "qemu" { PowerSection() }
            Section {
                DisclosureGroup("Advanced") {
                    let c = store.cfg
                    KV("Virtual machine name", c.vmName)
                    KV("Remote display port", "\(c.host):\(c.rdpPort)")
                    KV("Guest API port", "\(c.host):\(c.apiPort)")
                    KV("Display scaling", ConfigFile.string("scale", "Auto"))
                    KV("Hide app launch filter", ConfigFile.string("filter", "on") == "off" ? "Off" : "On")
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

    private var ramGB: Int { ConfigFile.int("vmRamGB", 6) }
    private var needGB: Int { ramGB + minFreeBox.value }
    private var spaceShort: Bool { (freeGBBox.value ?? 9999) < Double(needGB) }
    private var savesState: Bool { onQuitBox.value == "save" || idleActionBox.value == "save" }

    var body: some View {
        Section {
            Toggle("Start Windows when WinDinghy opens", isOn: Binding(get: { autoStartBox.value }, set: { autoStartBox.value = $0; ConfigFile.setBool("vmAutoStart", $0) }))
            if autoStartBox.value {
                Picker("Delay after login", selection: Binding(get: { delayBox.value }, set: { delayBox.value = $0; ConfigFile.set("vmStartDelaySec", $0) })) {
                    Text("None").tag(0); Text("15 seconds").tag(15); Text("30 seconds").tag(30)
                    Text("1 minute").tag(60); Text("2 minutes").tag(120); Text("5 minutes").tag(300)
                }
            }
            if autoStartBox.value && !loginOnBox.value {
                note("WinDinghy isn't set to start at login (General), so Windows only starts once you open WinDinghy yourself.", warn: true)
            } else if !autoStartBox.value && loginOnBox.value {
                note("WinDinghy starts at login, but Windows will only start when you open an app.", warn: false)
            } else if autoStartBox.value && delayBox.value > 0 {
                note("The delayBox.value applies when WinDinghy opens at login, so logging in stays quick. Opening it yourself starts Windows right away.", warn: false)
            }
            Picker("When WinDinghy quits", selection: Binding(get: { onQuitBox.value }, set: { onQuitBox.value = $0; ConfigFile.set("vmOnQuit", $0) })) {
                Text("Save Windows and stop it").tag("save")
                Text("Shut Windows down").tag("shutdown")
                Text("Leave Windows running").tag("keep")
            }
            Picker("When no Windows apps are open", selection: Binding(get: { idleActionBox.value }, set: { idleActionBox.value = $0; ConfigFile.set("vmIdleAction", $0) })) {
                Text("Do nothing").tag("off")
                Text("Pause Windows (saves power, wakes instantly)").tag("pause")
                Text("Save Windows and stop it").tag("save")
                Text("Shut Windows down").tag("shutdown")
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
                    note(String(format: "Only %.0f GB is free on the VM's disk; a saved state needs %d GB (%d GB of memory + %d GB kept free). Until there's room, Windows is shut down normally instead of saved. Free up space, or move the VM in Storage.", freeGBBox.value ?? 0, needGB, ramGB, minFreeBox.value), warn: true)
                } else {
                    note("A saved state is about as large as Windows's memory (\(ramGB) GB) and is deleted as soon as Windows starts again. Needs \(needGB) GB free; \(Int(freeGBBox.value ?? 0)) GB is.", warn: false)
                }
            }
            if idleActionBox.value == "pause" {
                note("Paused Windows keeps its memory but uses no processor time. Background work inside Windows (downloads, updates) stops until you open an app.", warn: false)
            }
        } header: { Text("Power") } footer: {
            Text("Windows's own sleep and hibernate aren't offered: they're unreliable on this virtual machine. Pause and save do the same job from outside.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .onAppear(perform: load)
    }

    @ViewBuilder private func note(_ text: String, warn: Bool) -> some View {
        Label(text, systemImage: warn ? "exclamationmark.triangle.fill" : "info.circle")
            .font(.system(size: 12)).foregroundStyle(warn ? Color.orange : Color.secondary)
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

struct SliderRow: View {
    let title: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    let step: Int
    let display: String
    let note: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack { Text(title); Spacer(); Text(display).foregroundStyle(.secondary) }
            Slider(value: Binding(get: { Double(value) }, set: { value = Int($0) }),
                   in: Double(range.lowerBound)...Double(range.upperBound), step: Double(step))
            Text(note).font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

struct KV: View {
    let k: String, v: String
    init(_ k: String, _ v: String) { self.k = k; self.v = v }
    var body: some View {
        HStack { Text(k); Spacer(); Text(v).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary) }
    }
}

// MARK: - Sharing

struct SharingView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        Form {
            Section {
                Toggle(isOn: $store.shareClipboard) { Row("Clipboard", "Copy and paste between Mac and Windows apps.") }
                Toggle(isOn: $store.shareHome) { Row("Home folder", "Your Mac home appears in Windows as \\\\tsclient\\Home.") }
                if store.shareHome { ReadOnlyToggle(share: "Home") }
                Toggle(isOn: $store.sharePrinters) { Row("Printers", "Use Mac printers from Windows apps.") }
                Toggle(isOn: $store.shareAudio) { Row("Audio", "Play sound from Windows apps.") }
            } footer: {
                Text("Changes apply the next time an app opens.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .toggleStyle(.switch)
            Section {
                ForEach(KnownFolder.all, id: \.key) { f in
                    Toggle(isOn: Binding(get: { store.redirects[f.key] ?? true }, set: { store.setRedirect(f.key, $0) })) {
                        Row(f.label, "Windows \(f.label) is your Mac's \(f.mac) folder.")
                    }
                    if store.redirects[f.key] ?? true { ReadOnlyToggle(share: f.share) }
                }
                if store.redirectDirty {
                    HStack {
                        Text("Windows apps will close and reopen to use the new locations.").font(.system(size: 12)).foregroundStyle(.secondary)
                        Spacer()
                        Button("Apply Now") { store.applyRedirects() }
                    }
                }
            } header: {
                Text("Windows folders")
            } footer: {
                Text("On by default, so files saved in Windows land in your Mac folders. Turn a folder off to keep Windows' own copy. macOS may ask permission the first time an app opens one of them.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .toggleStyle(.switch)
            Section("Shared folders") {
                if store.folders.isEmpty {
                    Text("No extra folders shared.").foregroundStyle(.secondary)
                }
                ForEach(store.folders, id: \.self) { path in
                    HStack {
                        Text(path.replacingOccurrences(of: NSHomeDirectory(), with: "~")).font(.system(size: 12, design: .monospaced))
                        Image(systemName: "arrow.right").foregroundStyle(.secondary).font(.system(size: 10))
                        Text("\\\\tsclient\\\(URL(fileURLWithPath: path).lastPathComponent)").font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
                        Spacer()
                        Toggle("Read-only", isOn: Binding(get: { store.isReadOnly(URL(fileURLWithPath: path).lastPathComponent) }, set: { store.setReadOnly(URL(fileURLWithPath: path).lastPathComponent, $0) })).toggleStyle(.checkbox)
                        Button { store.folders.removeAll { $0 == path } } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
                    }
                }
                Button("Add Folder…") { addFolder() }
            }
        }
        .formStyle(.grouped)
        .frame(maxWidth: 620)
        .frame(maxWidth: .infinity)
    }

    func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Share"
        if panel.runModal() == .OK {
            for u in panel.urls where !store.folders.contains(u.path) { store.folders.append(u.path) }
        }
    }
}

struct ReadOnlyToggle: View {
    @EnvironmentObject var store: AppStore
    let share: String
    var body: some View {
        Toggle("Read-only: Windows can look but not change", isOn: Binding(get: { store.isReadOnly(share) }, set: { store.setReadOnly(share, $0) }))
            .toggleStyle(.checkbox).font(.system(size: 12)).padding(.leading, 18)
    }
}

struct Row: View {
    let title: String, detail: String
    init(_ t: String, _ d: String) { title = t; detail = d }
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Snapshots

struct SnapshotsView: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var confirm = Box<SnapshotItem?>(nil)
    @StateObject private var naming = Box(false)
    @StateObject private var newName = Box("")

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Rewind Windows to an earlier state. Your Mac files are not affected.").foregroundStyle(.secondary)
                    Spacer()
                    Button("Take Snapshot") { newName.value = ""; naming.value = true }
                        .buttonStyle(.borderedProminent).disabled(store.snapshotBusy)
                }
                if store.snapshotBusy {
                    HStack { ProgressView().controlSize(.small); Text("Working… Windows restarts briefly.").foregroundStyle(.secondary) }
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
                                    Text(s.date.formatted(.dateTime.month().day().hour().minute())).font(.system(size: 12)).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Rewind") { confirm.value = s }.disabled(store.snapshotBusy)
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
        .alert("Rewind Windows?", isPresented: Binding(get: { confirm.value != nil }, set: { if !$0 { confirm.value = nil } })) {
            Button("Cancel", role: .cancel) {}
            Button("Rewind", role: .destructive) { if let s = confirm.value { store.rewind(s.name) } }
        } message: {
            Text("Everything changed in Windows since “\(confirm.value?.name ?? "")” (files, installed programs, settings) will be lost.")
        }
        .alert("Take a snapshot", isPresented: $naming.value) {
            TextField("Name (optional)", text: $newName.value)
            Button("Cancel", role: .cancel) {}
            Button("Take Snapshot") { store.takeSnapshot(newName.value.trimmingCharacters(in: .whitespaces)) }
        } message: {
            Text("Windows shuts down briefly so the snapshot is consistent.")
        }
    }
}

// MARK: - General

struct GeneralView: View {
    @EnvironmentObject var store: AppStore
    @StateObject private var username = Box("")
    @StateObject private var askPassword = Box(true)
    @StateObject private var login = Box(SMAppService.mainApp.status == .enabled)

    var body: some View {
        Form {
            Section("Account") {
                TextField("Windows username", text: $username.value, onCommit: { ConfigFile.set("username", username.value) })
                Toggle("Ask for password on launch", isOn: Binding(get: { askPassword.value }, set: { askPassword.value = $0; ConfigFile.set("promptcreds", $0 ? "on" : "off") }))
            }
            Section("Startup & appearance") {
                Toggle("Start WinDinghy at login", isOn: Binding(get: { login.value }, set: { setLogin($0) }))
                if login.value && store.cfg.vmBackend == "qemu" && ConfigFile.bool("vmAutoStart", true) {
                    Text("Windows also starts with WinDinghy, after a short delay (see Power in Resources).")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Picker("Menu bar icon", selection: Binding(get: { store.menubarIcon }, set: { store.menubarIcon = $0; store.delegate?.setMenubarIcon($0) })) {
                    Text("WinDinghy dinghy").tag("boat")
                    Text("Window symbol").tag("symbol")
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
            } footer: {
                Text("Unlocks unsupported setups (UTM or another hypervisor, a Windows machine elsewhere, a custom client). Don't use a remote machine without an encrypted VPN.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(maxWidth: 620)
        .frame(maxWidth: .infinity)
        .onAppear {
            username.value = store.cfg.username
            askPassword.value = store.cfg.promptcreds != "off"
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
                    .shadow(color: Color(red: 0.06, green: 0.42, blue: 0.88).opacity(0.4), radius: 12, y: 8)
                content
            }
            .frame(width: 500)
            .multilineTextAlignment(.center)
        }
    }

    @ViewBuilder var content: some View {
        switch store.setupPhase {
        case .welcome?, nil:
            Text("Windows apps on your Mac").font(.system(size: 26, weight: .bold))
            Text("WinDinghy sets up Windows in the background. Your Windows apps appear in the Dock, Spotlight and Finder like any other Mac app.")
                .font(.system(size: 15)).foregroundStyle(.secondary)
            Button { store.beginSetup() } label: { Text("Set Up Windows").font(.system(size: 15, weight: .semibold)).padding(.horizontal, 28) }
                .buttonStyle(.borderedProminent).controlSize(.large)
            Button("Customize…") { store.setupPhase = .customize }.buttonStyle(.link)
            Text("Downloads about 1 GB, plus the Windows installer (about 5 GB). Needs 64 GB free disk space.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            Text("Independent project: not affiliated with or endorsed by Microsoft or WinBoat. You need your own Windows licence.")
                .font(.system(size: 10)).foregroundStyle(.tertiary)
        case .customize?:
            Text("Customize").font(.system(size: 22, weight: .bold))
            Form {
                HStack { Text("Windows installer (ISO)"); Spacer()
                    Text(store.setupISO.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "Find in Downloads").foregroundStyle(.secondary)
                    Button("Choose…") { store.chooseISO() }
                }
                HStack { Text("Windows account name"); Spacer()
                    TextField("", text: $store.setupUser).textFieldStyle(.roundedBorder).frame(width: 160).multilineTextAlignment(.trailing) }
                HStack { Text("Windows password"); Spacer()
                    SecureField("Generate one for me", text: $store.setupPassword).textFieldStyle(.roundedBorder).frame(width: 160).multilineTextAlignment(.trailing) }
                HStack { Text("Edition"); Spacer(); Text("Windows 11 Pro · ARM64").foregroundStyle(.secondary) }
                HStack { Text("Cores · Memory · Disk"); Spacer(); Text("\(store.cores) · \(store.ramGB) GB · \(store.diskGB) GB").foregroundStyle(.secondary) }
                HStack { Text("VM location"); Spacer(); Text("Application Support").foregroundStyle(.secondary) }
            }
            .formStyle(.grouped).frame(height: 270)
            Text("Windows needs Microsoft's installer. If it isn't in Downloads, WinDinghy opens Microsoft's download page and continues when the file arrives.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            HStack {
                Button("Back") { store.setupPhase = .welcome }
                Button("Install") { store.beginSetup() }.buttonStyle(.borderedProminent)
            }
        case .installing(let pct, let title)?:
            Text(title).font(.system(size: 22, weight: .bold))
            ProgressView(value: pct / 100).progressViewStyle(.linear).frame(width: 360)
            Text("\(Int(pct))% · about 10 minutes in total. You can keep using your Mac.").font(.system(size: 12)).foregroundStyle(.secondary)
        case .done(let n)?:
            Text("Windows is ready").font(.system(size: 26, weight: .bold))
            Text("\(n) apps were added to ~/Applications/WinDinghy.").font(.system(size: 15)).foregroundStyle(.secondary)
            Button("Show My Apps") { store.setupPhase = nil; store.screen = .apps; store.refresh() }.buttonStyle(.borderedProminent).controlSize(.large)
            Text("The first launch asks for your Windows password once. It is saved to Keychain.").font(.system(size: 11)).foregroundStyle(.secondary)
        case .failed(let msg)?:
            if msg.contains("UNTESTED") {
                Text("This Windows version isn't tested").font(.system(size: 22, weight: .bold))
                Text(msg.replacingOccurrences(of: "UNTESTED: ", with: "")).font(.system(size: 13)).foregroundStyle(.secondary).textSelection(.enabled)
                HStack {
                    Button("Choose Another…") { store.chooseISO(); store.setupPhase = .customize }
                    Button("Install Anyway") { store.beginSetup(allowUntested: true) }.buttonStyle(.borderedProminent)
                }
            } else {
                Text("Setup didn't finish").font(.system(size: 22, weight: .bold))
                Text(msg).font(.system(size: 13)).foregroundStyle(.secondary).textSelection(.enabled)
                HStack {
                    Button("Try Again") { store.setupPhase = .welcome }.buttonStyle(.borderedProminent)
                }
            }
        }
    }
}
