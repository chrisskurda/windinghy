// Screens that act on Android through the CLI: Android Desktop, Software (F-Droid / Play Store / APK),
// Storage & Backup (move, export, import, reset, edition switch), uninstall and Versions.
// Each action is one `robodinghy` call.
import SwiftUI
import AppKit

struct Pkg: Identifiable, Hashable {
    var id: String
    let name: String
    let version: String
    let available: String
}

final class ToolsStore: ObservableObject {
    static let shared = ToolsStore()
    private var app: AppDelegate? { AppStore.shared.delegate }

    /// The edition Android is running (status), else the configured one.
    var edition: String {
        if let e = AppStore.shared.status?.edition, !e.isEmpty { return e }
        return ConfigFile.string("edition", "play")
    }

    // software
    @Published var pkgQuery = ""
    @Published var results: [Pkg] = []
    @Published var installed: [Pkg] = []
    @Published var pkgBusy: String? = nil       // "Searching…", "Installing org.mozilla.fennec_fdroid…"
    @Published var pkgMessage: String? = nil
    @Published var installedLoaded = false

    // about
    @Published var about: [(String, String, String, Bool)] = []   // name, installed, tested, matches

    // storage & backup, uninstall
    @Published var storageBusy: String? = nil
    @Published var storageMessage: String? = nil
    @Published var removePct: Double? = nil
    @Published var removeTitle = ""
    /// An `edition` switch is running in the output window. Between moving the old AVD aside and creating
    /// the new one there is no AVD, so AppStore must not mistake that for "not set up".
    @Published var switching = false

    func loadAbout() {
        runCLI(["about", "--json"]) { [weak self] _, text in
            guard let o = lastJSON(text) as? [[String: Any]] else { return }
            self?.about = o.map { ((($0["name"] as? String) ?? ""), EmuStatus.str($0["have"]), EmuStatus.str($0["tested"]), (($0["ok"] as? Bool) ?? true)) }
        }
    }

    private func pkgs(_ any: Any?) -> [Pkg] {
        ((any as? [[String: Any]]) ?? []).compactMap { d in
            guard let id = d["id"] as? String, !id.isEmpty else { return nil }
            return Pkg(id: id, name: (d["name"] as? String) ?? id, version: EmuStatus.str(d["version"]), available: EmuStatus.str(d["available"]))
        }
    }

    // ---------- software ----------

    func search() {
        let q = pkgQuery.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, pkgBusy == nil else { return }
        pkgBusy = "Searching…"; pkgMessage = nil
        runCLI(["pkg", "search", q, "--json"]) { [weak self] status, text in
            guard let self else { return }
            self.pkgBusy = nil
            let json = lastJSON(text)
            self.results = self.pkgs(json)
            if status != 0 || (self.results.isEmpty && json == nil) { self.pkgMessage = "Couldn't search: " + lastLine(text, or: "check your internet connection.") }
            else if self.results.isEmpty { self.pkgMessage = "Nothing found for “\(q)”." }
        }
    }

    func loadInstalled() {
        guard pkgBusy == nil else { return }
        pkgBusy = "Reading installed apps…"
        runCLI(["pkg", "list", "--json"]) { [weak self] status, text in
            guard let self else { return }
            self.pkgBusy = nil
            self.installed = self.pkgs(lastJSON(text))
            self.installedLoaded = true
            if status != 0 { self.pkgMessage = "Couldn't list apps: " + lastLine(text, or: "is \(Product.os) running?") }
        }
    }

    func act(_ verb: String, _ p: Pkg) {
        guard pkgBusy == nil else { return }
        pkgBusy = (verb == "install" ? "Installing " : verb == "uninstall" ? "Removing " : "Updating ") + p.name + "…"
        pkgMessage = nil
        runCLI(["pkg", verb, p.id]) { [weak self] status, text in
            guard let self else { return }
            self.pkgBusy = nil
            self.pkgMessage = status == 0 ? "\(p.name): done." : "\(p.name): " + lastLine(text, or: "it didn't finish. Try again.")
            if self.installedLoaded { self.loadInstalled() }
            if status == 0 { self.syncAfterChange() }
        }
    }

    func upgradeAll() {
        guard pkgBusy == nil else { return }
        pkgBusy = "Updating apps…"
        runCLI(["pkg", "upgrade"]) { [weak self] status, text in
            self?.pkgBusy = nil
            self?.pkgMessage = status == 0 ? "Updates finished." : lastLine(text, or: "Updates didn't finish.")
            self?.loadInstalled()
        }
    }

    /// Installs an .apk chosen in a panel (`robodinghy install <file>`).
    func installAPK() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.init(filenameExtension: "apk")].compactMap { $0 }
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose an Android app (.apk) to install"
        panel.prompt = "Install"
        guard panel.runModal() == .OK, let url = panel.url, pkgBusy == nil else { return }
        pkgBusy = "Installing \(url.lastPathComponent)…"; pkgMessage = nil
        runCLI(["install", url.path]) { [weak self] status, text in
            guard let self else { return }
            self.pkgBusy = nil
            self.pkgMessage = status == 0 ? "\(url.lastPathComponent) is installed." : "Couldn't install it: " + lastLine(text, or: "is \(Product.os) running?")
            if status == 0 { self.syncAfterChange(); if self.installedLoaded { self.loadInstalled() } }
        }
    }

    /// Opens the Play Store's launcher, or asks the CLI to launch it by name before the first sync.
    func openPlayStore() {
        if let store = AppStore.shared.apps.first(where: { $0.name.localizedCaseInsensitiveContains("Play Store") }) {
            AppStore.shared.launch(store); return
        }
        pkgMessage = nil
        runCLI(["launch", "Google Play Store"]) { [weak self] status, text in
            if status != 0 { self?.pkgMessage = "Couldn't open the Play Store: " + lastLine(text, or: "sync your apps first.") }
        }
    }

    /// App launchers follow the installed apps: sync in the background after an install or removal.
    private func syncAfterChange() {
        guard !AppStore.shared.syncing else { return }
        AppStore.shared.syncApps()
    }

    /// From an app's context menu in Apps: confirm, then `pkg uninstall <package>`.
    func confirmUninstall(_ a: AndroidApp) {
        let alert = NSAlert()
        alert.messageText = "Uninstall \(a.name)?"
        alert.informativeText = "The app and its data are removed from \(Product.os), and its launcher from this Mac."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Uninstall")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        AppStore.shared.quit(a)
        act("uninstall", Pkg(id: a.package, name: a.name, version: "", available: ""))
    }

    // ---------- storage & backup ----------

    func moveVM() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
        panel.prompt = "Move Here"; panel.message = "Choose where \(Product.os) should live (an external drive works)."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run("Moving \(Product.os)…", ["vm", "move", url.appendingPathComponent("\(Product.name) VM").path], "Moved.")
    }

    func exportVM() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "\(Product.name).\(Product.vmBundleExtension)"
        panel.message = "Export a copy of \(Product.os). Use it as a backup or to move to another Mac."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run("Exporting…", ["vm", "export", url.path], "Exported.")
    }

    func importVM() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = true; panel.prompt = "Import"
        panel.message = "Choose a .\(Product.vmBundleExtension) bundle."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run("Importing…", ["vm", "import", url.path], "Imported.")
    }

    /// Deletes this Android (`vm destroy --yes`); the window then goes back to the setup screen.
    func resetAndroid() {
        run("Deleting \(Product.os)…", ["vm", "destroy", "--yes"], "Deleted.")
    }

    /// Whether the other edition's VM was kept from an earlier switch (switching back then reuses it and
    /// downloads nothing): <vmDir>/kept/<edition>/<avd>.avd, as the CLI's cmdEdition lays it out.
    func isKept(_ e: String) -> Bool {
        FileManager.default.fileExists(atPath: AppStore.shared.cfg.vmDir + "/kept/\(e)/\(Product.avdName).avd")
    }

    /// Switching editions creates a new AVD and can download a system image (under Google's SDK licence,
    /// hence --accept-licences once the sheet's licence box is ticked), so it runs in the output window.
    func switchEdition(to e: String, deleteOld: Bool, acceptLicences: Bool) {
        guard let app else { return }
        var args = ["edition", e, "--yes"]
        if deleteOld { args.append("--delete-old") }
        if acceptLicences { args.append("--accept-licences") }
        switching = true   // before the call: a launch failure finishes (and clears it) synchronously
        let started = app.runCLIWindow(title: "Switch to \(editionName(e))", args: args) { status in
            ToolsStore.shared.switching = false
            AppStore.shared.setupEdition = ConfigFile.string("edition", e)
            if status == 0 { ToolsStore.shared.installed = []; ToolsStore.shared.installedLoaded = false }
            AppStore.shared.refresh()
        }
        if !started { switching = false }
    }

    /// Runs `robodinghy uninstall --yes --progress` and shows its PROGRESS lines. When it finishes, the main
    /// window notices there's no Android and goes back to the setup screen.
    func uninstall(settings: Bool, done: @escaping (Bool) -> Void) {
        guard roboCLI.resolve() != nil else { storageMessage = "Can't find node or the \(Product.cli) command-line tool."; return }
        var args = ["uninstall", "--yes", "--progress"]
        if settings { args.append("--purge-settings") }
        removePct = 1; removeTitle = "Preparing…"; storageMessage = nil
        let err = roboCLI.progress(args, onProgress: { [weak self] pct, title in
            self?.removePct = pct; self?.removeTitle = title
        }, done: { [weak self] status in
            self?.removePct = nil
            self?.storageMessage = status == 0 ? nil : "Uninstalling didn't finish. Run: \(Product.cli) uninstall --yes"
            AppStore.shared.refresh()
            done(status == 0)
        })
        if let err { removePct = nil; storageMessage = err.localizedDescription }
    }

    private func run(_ title: String, _ args: [String], _ ok: String) {
        storageBusy = title; storageMessage = nil
        runCLI(args) { [weak self] status, text in
            self?.storageBusy = nil
            self?.storageMessage = status == 0 ? ok : lastLine(text, or: "That didn't work.")
            AppStore.shared.refresh()
        }
    }
}

// MARK: - Android Desktop

struct DesktopView: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "display").font(.system(size: 54)).foregroundStyle(.secondary)
            Text("The full \(Product.os) screen").font(.system(size: 20, weight: .semibold))
            Text("Use it for anything the app list doesn't cover: Settings, the home screen, notifications. It opens in its own window, which you can make full screen.")
                .font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 440)
            Button { store.openDesktop() } label: { Text("Open \(Product.desktopApp)").padding(.horizontal, 16) }
                .buttonStyle(.borderedProminent).controlSize(.large)
            if !store.vmOnline {
                Text(store.vmExists ? "\(Product.os) starts first if it isn't running." : "Set up \(Product.os) first.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Software

struct SoftwareView: View {
    @EnvironmentObject var tools: ToolsStore
    @EnvironmentObject var store: AppStore

    var body: some View {
        let aosp = tools.edition == "aosp"
        Form {
            if aosp {
                Section {
                    HStack {
                        TextField("Search F-Droid (e.g. firefox, newpipe, k-9)", text: $tools.pkgQuery).onSubmit { tools.search() }
                        Button("Search") { tools.search() }.disabled(tools.pkgBusy != nil || tools.pkgQuery.isEmpty)
                    }
                    ForEach(tools.results) { p in
                        HStack {
                            VStack(alignment: .leading) { Text(p.name); Text("\(p.id) · \(p.version)").font(.system(size: 11)).foregroundStyle(.secondary) }
                            Spacer()
                            Button("Install") { tools.act("install", p) }.disabled(tools.pkgBusy != nil)
                        }
                    }
                } header: { Text("Find apps") } footer: {
                    Text("Installs from F-Droid, the catalogue of free and open-source Android apps. Each download is checked against F-Droid's index before it's installed. New apps appear in Apps after a sync.")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
            } else {
                Section {
                    HStack {
                        Row("Google Play Store", "Sign in with your Google account to install apps. New apps appear in Apps after a sync.")
                        Spacer()
                        Button("Open Play Store") { tools.openPlayStore() }
                    }
                } header: { Text("Find apps") }
            }
            Section {
                HStack {
                    Row("Install an app file", "Choose an .apk you downloaded. Only install apps from sources you trust.")
                    Spacer()
                    Button("Install APK…") { tools.installAPK() }.disabled(tools.pkgBusy != nil)
                }
                if let busy = tools.pkgBusy {
                    HStack { ProgressView().controlSize(.small); Text(busy).foregroundStyle(.secondary) }
                }
                if let m = tools.pkgMessage { Text(m).font(.system(size: 12)).foregroundStyle(.secondary) }
            }
            Section {
                if !tools.installedLoaded { Button("Show Installed Apps") { tools.loadInstalled() }.disabled(tools.pkgBusy != nil) }
                if tools.installedLoaded && tools.installed.isEmpty {
                    Text("No apps you installed yourself yet.").foregroundStyle(.secondary)
                }
                ForEach(tools.installed) { p in
                    HStack {
                        VStack(alignment: .leading) { Text(p.name); Text(p.version.isEmpty ? p.id : "\(p.id) · \(p.version)").font(.system(size: 11)).foregroundStyle(.secondary) }
                        Spacer()
                        if !p.available.isEmpty { Button("Update to \(p.available)") { tools.act("upgrade", p) }.disabled(tools.pkgBusy != nil) }
                        Button("Remove") { tools.act("uninstall", p) }.disabled(tools.pkgBusy != nil)
                    }
                }
                if tools.installedLoaded {
                    HStack {
                        Button("Refresh") { tools.loadInstalled() }
                        if aosp { Button("Update All") { tools.upgradeAll() } }
                    }.disabled(tools.pkgBusy != nil)
                }
            } header: { Text("Installed") } footer: {
                if !aosp {
                    Text("Apps from Google Play are updated by the Play Store.").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Storage & backup

enum ResetKind: String, Identifiable { case reset, uninstall, edition; var id: String { rawValue } }

struct ResetSheet: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var tools: ToolsStore
    let kind: ResetKind
    @Environment(\.dismiss) var dismiss
    @StateObject private var settings = Box(false)
    @StateObject private var deleteOld = Box(false)

    var target: String { tools.edition == "aosp" ? "play" : "aosp" }

    var title: String {
        switch kind {
        case .reset: return "Delete \(Product.os) and start over?"
        case .uninstall: return "Uninstall \(Product.name)?"
        case .edition: return "Switch to \(editionName(target))?"
        }
    }

    /// A switch to an edition that wasn't kept runs setup, which may download its system image.
    var needsLicence: Bool { kind == .edition && !tools.isKept(target) }

    var size: String { store.diskUsedGB > 0 ? String(format: " (%.0f GB)", store.diskUsedGB.rounded()) : "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.system(size: 17, weight: .semibold))
            switch kind {
            case .reset:
                Text("\(Product.os), its apps, their data and its snapshots\(size) are deleted, and you can set up a fresh one. Exported backups and your Mac files are not affected.")
            case .uninstall:
                Text("Deletes \(Product.os) and its snapshots\(size) and your app launchers. Exported backups, the shared Android SDK and your Mac files are not touched.")
                Toggle("Also remove \(Product.name)'s settings", isOn: $settings.value).toggleStyle(.checkbox)
                Text("The \(Product.name) app itself stays; drag it to the Trash to remove it.").font(.system(size: 12)).foregroundStyle(.secondary)
            case .edition:
                Text(target == "aosp"
                     ? "A separate AOSP \(Product.os) is set up next to this one: open source, no Google services, with F-Droid for apps. Apps and data don't carry over."
                     : "A separate Google Play \(Product.os) is set up next to this one, with the Play Store. Apps and data don't carry over.")
                Toggle("Delete the current \(editionName(tools.edition)) \(Product.os)\(size)", isOn: $deleteOld.value).toggleStyle(.checkbox)
                Text(deleteOld.value ? "Its apps, data and snapshots are lost." : "It's kept, so you can switch back later.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                if needsLicence {
                    VStack(alignment: .leading, spacing: 4) {
                        Toggle("I accept the Android SDK licence terms", isOn: $store.licencesAccepted).toggleStyle(.checkbox)
                        Text("The new \(Product.os) may need a system image downloaded with Google's SDK tools, under Google's licence.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                        Link("Read the licence", destination: URL(string: "https://developer.android.com/studio/terms")!).font(.system(size: 11))
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(.quaternary))
                }
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(kind == .reset ? "Delete \(Product.os)" : kind == .uninstall ? "Uninstall" : "Switch", role: kind == .edition && !deleteOld.value ? nil : .destructive) {
                    dismiss()
                    switch kind {
                    case .reset: tools.resetAndroid()
                    case .uninstall: tools.uninstall(settings: settings.value) { _ in }
                    case .edition: tools.switchEdition(to: target, deleteOld: deleteOld.value, acceptLicences: needsLicence && store.licencesAccepted)
                    }
                }
                .disabled(needsLicence && !store.licencesAccepted)
            }
        }
        .font(.system(size: 13))
        .padding(22).frame(width: 460)
    }
}

struct StorageView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var tools: ToolsStore
    @StateObject private var sheet = Box<ResetKind?>(nil)
    @StateObject private var image = Box(ConfigFile.string("image", ""))

    var body: some View {
        Form {
            Section {
                HStack {
                    Text(store.cfg.vmDir.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Move…") { tools.moveVM() }.disabled(tools.storageBusy != nil)
                }
            } header: { Text("Where \(Product.os) lives") } footer: {
                Text("Moving shuts \(Product.os) down first. An external drive works, but it has to be connected whenever \(Product.os) runs.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Section {
                HStack { Row("Export", "Save a full copy of \(Product.os), snapshots included. A good backup before big changes."); Spacer(); Button("Export…") { tools.exportVM() }.disabled(tools.storageBusy != nil) }
                HStack { Row("Import", "Restore a copy, or bring \(Product.os) from another Mac."); Spacer(); Button("Import…") { tools.importVM() }.disabled(tools.storageBusy != nil) }
                if let b = tools.storageBusy { HStack { ProgressView().controlSize(.small); Text(b).foregroundStyle(.secondary) } }
                if let m = tools.storageMessage { Text(m).font(.system(size: 12)).foregroundStyle(.secondary) }
            } header: { Text("Backup") } footer: {
                Text("Exports don't include your Google account sign-in; sign in again after an import.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Section {
                HStack { Text("Edition"); Spacer(); Text(editionName(tools.edition)).foregroundStyle(.secondary) }
                HStack {
                    Row("Switch to \(editionName(tools.edition == "aosp" ? "play" : "aosp"))",
                        tools.edition == "aosp" ? "Google's Play Store and services, with your Google account." : "Open source with no Google services; apps from F-Droid.")
                    Spacer()
                    Button(tools.switching ? "Switching…" : "Switch…") { sheet.value = .edition }.disabled(tools.storageBusy != nil || tools.switching || !store.vmExists)
                }
                if store.advanced {
                    TextField("Custom system image (SDK package id)", text: $image.value, onCommit: { ConfigFile.set("image", image.value.trimmingCharacters(in: .whitespaces)) })
                        .font(.system(size: 12, design: .monospaced))
                    note("Overrides the edition the next time \(Product.os) is set up or switched. Unsupported: you're on your own.", warn: true)
                }
            } header: { Text("Edition") } footer: {
                Text("Each edition is a separate \(Product.os) with its own apps and data.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Section {
                HStack { Row("Delete \(Product.os)", "Delete this \(Product.os) and set up a fresh one."); Spacer(); Button("Delete…") { sheet.value = .reset }.disabled(tools.storageBusy != nil || !store.vmExists) }
            } header: { Text("Reset") } footer: {
                Text("This doesn't touch your Mac's own files. Export first if you might want this \(Product.os) back. To remove \(Product.name) completely, use Uninstall in General.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .sheet(item: Binding(get: { sheet.value }, set: { sheet.value = $0 })) { kind in
            ResetSheet(kind: kind).environmentObject(store).environmentObject(tools)
        }
    }
}

// MARK: - About & credits

struct AboutSection: View {
    @EnvironmentObject var tools: ToolsStore
    @EnvironmentObject var store: AppStore
    var body: some View {
        Section("Versions") {
            if tools.about.isEmpty { Text("Checking…").foregroundStyle(.secondary) }
            ForEach(tools.about, id: \.0) { row in
                HStack {
                    Text(row.0)
                    Spacer()
                    if !row.1.isEmpty { Text(row.1).foregroundStyle(row.3 ? Color.secondary : Color.orange).font(.system(size: 12, design: .monospaced)) }
                }
            }
            if let s = store.updateStatus { HStack { ProgressView().controlSize(.small); Text(s).foregroundStyle(.secondary) } }
            Text("Each release is tested against one Android Emulator, one system image per edition and one scrcpy. Orange means what's installed differs from what was tested.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .onAppear { tools.loadAbout() }
        Section("Credits & notices") {
            Text("\(Product.name) is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Google. Android and Google Play are trademarks of Google LLC. The Android Emulator and system images are downloaded from Google under Google's licence; \(Product.name) doesn't redistribute them.")
                .font(.system(size: 12))
            Text("Thank you to the scrcpy project, which shows each \(Product.os) app in a window of its own, to the Android Open Source Project, and to F-Droid.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            HStack {
                Link("scrcpy", destination: URL(string: "https://github.com/Genymobile/scrcpy")!)
                Link("AOSP", destination: URL(string: "https://source.android.com")!)
                Link("F-Droid", destination: URL(string: "https://f-droid.org")!)
            }.font(.system(size: 12))
        }
    }
}
