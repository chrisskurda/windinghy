// Screens that drive the guest: Windows Desktop, Software (winget), Account & Activation,
// Work & School, and Storage & Backup. Each action is one `dinghy` CLI call.
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
    private var cli: AppDelegate? { AppStore.shared.delegate }

    // software
    @Published var pkgQuery = ""
    @Published var results: [Pkg] = []
    @Published var installed: [Pkg] = []
    @Published var pkgBusy: String? = nil       // "Searching…", "Installing 7zip.7zip…"
    @Published var pkgMessage: String? = nil
    @Published var installedLoaded = false

    // account
    @Published var activation: String? = nil
    @Published var activated: Bool? = nil
    @Published var productKey = ""
    @Published var accountMessage: String? = nil
    @Published var accountBusy = false

    // sign-in (Windows account)
    @Published var shownPassword: String? = nil
    @Published var newPassword = ""
    @Published var signInMessage: String? = nil
    @Published var signInBusy = false
    @Published var accounts: [String] = []
    @Published var otherUser = ""
    @Published var otherPassword = ""
    @Published var createOther = false
    @Published var currentUser = ConfigFile.string("username", "")

    func loadSignIn() {
        currentUser = ConfigFile.string("username", "")
        cli?.runDinghyCapture(["user", "list", "--json"]) { [weak self] status, text in
            guard let self, status == 0, let a = self.json(text) as? [[String: Any]] else { return }
            self.accounts = a.compactMap { $0["name"] as? String }
        }
    }

    func revealPassword() {
        if shownPassword != nil { shownPassword = nil; return }
        cli?.runDinghyCapture(["password", "show"]) { [weak self] status, text in
            self?.shownPassword = status == 0 ? text.trimmingCharacters(in: .whitespacesAndNewlines) : "(none saved)"
        }
    }

    func copyPassword() {
        cli?.runDinghyCapture(["password", "show"]) { status, text in
            guard status == 0 else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text.trimmingCharacters(in: .whitespacesAndNewlines), forType: .string)
        }
    }

    func changePassword(random: Bool) {
        signInBusy = true; signInMessage = nil
        let args = random ? ["password", "random"] : ["password", "set"]
        let input = random ? nil : (try? JSONSerialization.data(withJSONObject: ["password": newPassword])).flatMap { String(data: $0, encoding: .utf8) }
        cli?.runDinghyCapture(args, input: input) { [weak self] status, text in
            guard let self else { return }
            self.signInBusy = false
            self.signInMessage = status == 0 ? "Password changed. It's saved in your Keychain." : "Windows didn't accept it: use at least 8 characters, and make sure Windows is running."
            if status == 0 { self.newPassword = ""; self.shownPassword = nil }
        }
    }

    func switchUser() {
        signInBusy = true; signInMessage = nil
        var args = ["user", "use", otherUser]
        if createOther { args.append("--create") }
        let body: [String: String] = ["password": otherPassword, "fullName": otherUser]
        let input = (try? JSONSerialization.data(withJSONObject: body)).flatMap { String(data: $0, encoding: .utf8) }
        cli?.runDinghyCapture(args, input: input) { [weak self] status, text in
            guard let self else { return }
            self.signInBusy = false
            if status == 0 {
                self.signInMessage = "Now signing in as \(self.otherUser). Apps switch on their next launch (close any open Windows apps first)."
                self.otherPassword = ""; self.shownPassword = nil
                self.loadSignIn()
                AppStore.shared.refresh()
            } else {
                self.signInMessage = "Couldn't switch: " + (text.split(separator: "\n").last.map(String.init) ?? "check the name and password, and that Windows is running.")
            }
        }
    }

    // work & school
    @Published var domainStatus: String? = nil
    @Published var domainJoined = false
    @Published var domainName = ""
    @Published var domainUser = ""
    @Published var domainPassword = ""
    @Published var domainOU = ""
    @Published var workMessage: String? = nil
    @Published var workBusy = false

    // about
    @Published var about: [(String, String, String, Bool)] = []   // name, installed, tested, matches

    func loadAbout() {
        cli?.runDinghyCapture(["about", "--json"]) { [weak self] _, text in
            guard let o = self?.json(text) as? [[String: Any]] else { return }
            self?.about = o.map { ((($0["name"] as? String) ?? ""), (($0["have"] as? String) ?? ""), (($0["tested"] as? String) ?? ""), (($0["ok"] as? Bool) ?? true)) }
        }
    }

    // storage & backup
    @Published var storageBusy: String? = nil
    @Published var storageMessage: String? = nil

    private func json(_ text: String) -> Any? {
        // the CLI may print progress lines first; take the last line that parses
        for line in text.split(separator: "\n").reversed() {
            if let d = String(line).data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) { return o }
        }
        return nil
    }

    private func pkgs(_ any: Any?) -> [Pkg] {
        ((any as? [[String: Any]]) ?? []).compactMap { d in
            guard let id = d["id"] as? String, !id.isEmpty else { return nil }
            return Pkg(id: id, name: (d["name"] as? String) ?? id, version: (d["version"] as? String) ?? "", available: (d["available"] as? String) ?? "")
        }
    }

    // ---------- software ----------

    func search() {
        let q = pkgQuery.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, pkgBusy == nil else { return }
        pkgBusy = "Searching…"; pkgMessage = nil
        cli?.runDinghyCapture(["pkg", "search", q, "--json"]) { [weak self] status, text in
            guard let self else { return }
            self.pkgBusy = nil
            self.results = self.pkgs(self.json(text))
            if status != 0 || (self.results.isEmpty && self.json(text) == nil) { self.pkgMessage = "Couldn't search. Is Windows running?" }
            else if self.results.isEmpty { self.pkgMessage = "Nothing found for “\(q)”." }
        }
    }

    func loadInstalled() {
        guard pkgBusy == nil else { return }
        pkgBusy = "Reading installed software…"
        cli?.runDinghyCapture(["pkg", "list", "--json"]) { [weak self] _, text in
            guard let self else { return }
            self.pkgBusy = nil
            self.installed = self.pkgs(self.json(text))
            self.installedLoaded = true
        }
    }

    func act(_ verb: String, _ p: Pkg) {
        guard pkgBusy == nil else { return }
        pkgBusy = (verb == "install" ? "Installing " : verb == "uninstall" ? "Removing " : "Updating ") + p.name + "…"
        pkgMessage = nil
        cli?.runDinghyCapture(["pkg", verb, p.id]) { [weak self] status, _ in
            guard let self else { return }
            self.pkgBusy = nil
            self.pkgMessage = status == 0 ? "\(p.name): done." : "\(p.name): it didn't finish. Try again, or use the Windows desktop."
            self.loadInstalled()
            AppStore.shared.refresh()
        }
    }

    func upgradeAll() {
        guard pkgBusy == nil else { return }
        pkgBusy = "Updating software…"
        cli?.runDinghyCapture(["pkg", "upgrade"]) { [weak self] _, _ in
            self?.pkgBusy = nil; self?.pkgMessage = "Updates finished."; self?.loadInstalled()
        }
    }

    // ---------- account & activation ----------

    func loadActivation() {
        cli?.runDinghyCapture(["activation", "--json"]) { [weak self] status, text in
            guard let self else { return }
            if status == 0, let d = self.json(text) as? [String: Any] {
                self.activated = d["activated"] as? Bool
                self.activation = "\((d["edition"] as? String) ?? "Windows") — \((d["status"] as? String) ?? "unknown")"
            } else { self.activation = "Start Windows to check activation."; self.activated = nil }
        }
    }

    func enterKey() {
        let k = productKey.trimmingCharacters(in: .whitespaces).uppercased()
        accountBusy = true; accountMessage = nil
        cli?.runDinghyCapture(["activation", "key", k]) { [weak self] status, text in
            guard let self else { return }
            self.accountBusy = false
            self.accountMessage = status == 0 ? "Key sent to Windows." : (text.split(separator: "\n").last.map(String.init) ?? "That key wasn't accepted.")
            if status == 0 { self.productKey = "" }
            self.loadActivation()
        }
    }

    func openSettings(_ page: String) {
        cli?.runDinghyCapture(["open-settings", page]) { _, _ in }
    }

    // ---------- work & school ----------

    func loadDomain() {
        cli?.runDinghyCapture(["domain", "status", "--json"]) { [weak self] status, text in
            guard let self else { return }
            if status == 0, let d = self.json(text) as? [String: Any] {
                self.domainJoined = (d["domainJoined"] as? Bool) ?? false
                if self.domainJoined { self.domainStatus = "Joined to \((d["domain"] as? String) ?? "a domain")" }
                else if (d["azureAdJoined"] as? Bool) == true { self.domainStatus = "Joined to a work or school account" }
                else { self.domainStatus = "Not joined to a domain" }
            } else { self.domainStatus = "Start Windows to check." }
        }
    }

    func joinDomain() {
        let body: [String: String] = ["domain": domainName, "user": domainUser, "password": domainPassword, "ou": domainOU]
        guard let data = try? JSONSerialization.data(withJSONObject: body), let input = String(data: data, encoding: .utf8) else { return }
        workBusy = true; workMessage = nil
        cli?.runDinghyCapture(["domain", "join"], input: input) { [weak self] status, text in
            guard let self else { return }
            self.workBusy = false
            self.domainPassword = ""
            self.workMessage = status == 0 ? "Joined. Windows is restarting to finish." : (text.split(separator: "\n").first { $0.contains("FAILED") }.map(String.init) ?? "Couldn't join the domain.")
            self.loadDomain()
        }
    }

    func leaveDomain() {
        workBusy = true; workMessage = nil
        cli?.runDinghyCapture(["domain", "leave"], input: "{}") { [weak self] status, _ in
            self?.workBusy = false
            self?.workMessage = status == 0 ? "Left the domain. Windows is restarting." : "Couldn't leave the domain (it may need domain credentials)."
            self?.loadDomain()
        }
    }

    func groupPolicy() {
        workBusy = true
        cli?.runDinghyCapture(["domain", "gpupdate"]) { [weak self] _, _ in self?.workBusy = false; self?.workMessage = "Group Policy refreshed." }
    }

    // ---------- storage & backup ----------

    func moveVM() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
        panel.prompt = "Move Here"; panel.message = "Choose where the Windows disk should live (an external drive works)."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run("Moving Windows…", ["vm", "move", url.appendingPathComponent("WinDinghy VM").path], "Moved.")
    }

    func exportVM() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "WinDinghy.windinghyvm"
        panel.message = "Export a copy of the Windows VM. Use it as a backup or to move to another Mac."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run("Exporting…", ["vm", "export", url.path], "Exported.")
    }

    func importVM() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = true; panel.prompt = "Import"
        panel.message = "Choose a .windinghyvm bundle."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run("Importing…", ["vm", "import", url.path], "Imported. Start Windows, then save its password once: dinghy login")
    }

    @Published var removePct: Double? = nil
    @Published var removeTitle = ""

    /// Runs `dinghy uninstall --progress` and shows its PROGRESS lines. When it finishes, the main window
    /// notices there's no VM and goes back to the setup wizard.
    func uninstall(cache: Bool, settings: Bool, done: @escaping (Bool) -> Void) {
        guard let node = findNode(), let dinghy = findDinghy() else { storageMessage = "Can't find node or dinghy.mjs."; return }
        var args = [dinghy, "uninstall", "--yes", "--progress"]
        if cache { args.append("--purge-cache") }
        if settings { args.append("--purge-settings") }
        removePct = 1; removeTitle = "Preparing…"; storageMessage = nil
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = pipe
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
                        DispatchQueue.main.async { self?.removePct = pct; self?.removeTitle = parts[1] }
                    }
                }
            }
        }
        p.terminationHandler = { [weak self] proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                self?.removePct = nil
                self?.storageMessage = proc.terminationStatus == 0 ? nil : "Removing Windows didn't finish. Run: dinghy uninstall --yes"
                AppStore.shared.refresh()
                done(proc.terminationStatus == 0)
            }
        }
        do { try p.run() } catch { removePct = nil; storageMessage = error.localizedDescription }
    }

    private func run(_ title: String, _ args: [String], _ ok: String) {
        storageBusy = title; storageMessage = nil
        cli?.runDinghyCapture(args) { [weak self] status, text in
            self?.storageBusy = nil
            self?.storageMessage = status == 0 ? ok : (text.split(separator: "\n").last.map(String.init) ?? "That didn't work.")
            AppStore.shared.refresh()
        }
    }
}

// MARK: - Windows Desktop

struct DesktopView: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "display").font(.system(size: 54)).foregroundStyle(.secondary)
            Text("The full Windows desktop").font(.system(size: 20, weight: .semibold))
            Text("Use it for anything the app list doesn't cover: Settings, installers, the Start menu. It opens in its own window, which you can make full screen.")
                .font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 440)
            Button { store.openDesktop() } label: { Text("Open Windows Desktop").padding(.horizontal, 16) }
                .buttonStyle(.borderedProminent).controlSize(.large)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Software

struct SoftwareView: View {
    @EnvironmentObject var tools: ToolsStore
    var body: some View {
        Form {
            Section {
                HStack {
                    TextField("Search for software (e.g. 7zip, firefox, vscode)", text: $tools.pkgQuery).onSubmit { tools.search() }
                    Button("Search") { tools.search() }.disabled(tools.pkgBusy != nil || tools.pkgQuery.isEmpty)
                }
                if let busy = tools.pkgBusy {
                    HStack { ProgressView().controlSize(.small); Text(busy).foregroundStyle(.secondary) }
                }
                if let m = tools.pkgMessage { Text(m).font(.system(size: 12)).foregroundStyle(.secondary) }
                ForEach(tools.results) { p in
                    HStack {
                        VStack(alignment: .leading) { Text(p.name); Text("\(p.id) · \(p.version)").font(.system(size: 11)).foregroundStyle(.secondary) }
                        Spacer()
                        Button("Install") { tools.act("install", p) }.disabled(tools.pkgBusy != nil)
                    }
                }
            } header: { Text("Find software") } footer: {
                Text("Installs from the open winget catalog. No Microsoft account or Store sign-in needed. New apps appear in Apps automatically. The Microsoft Store also works from the Windows desktop.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Section {
                if !tools.installedLoaded { Button("Show Installed Software") { tools.loadInstalled() }.disabled(tools.pkgBusy != nil) }
                ForEach(tools.installed) { p in
                    HStack {
                        VStack(alignment: .leading) { Text(p.name); Text("\(p.id) · \(p.version)").font(.system(size: 11)).foregroundStyle(.secondary) }
                        Spacer()
                        if !p.available.isEmpty { Button("Update to \(p.available)") { tools.act("upgrade", p) }.disabled(tools.pkgBusy != nil) }
                        Button("Remove") { tools.act("uninstall", p) }.disabled(tools.pkgBusy != nil)
                    }
                }
                if tools.installedLoaded {
                    HStack { Button("Refresh") { tools.loadInstalled() }; Button("Update All") { tools.upgradeAll() } }.disabled(tools.pkgBusy != nil)
                }
            } header: { Text("Installed (winget)") }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Account & activation

struct AccountView: View {
    @EnvironmentObject var tools: ToolsStore
    var body: some View {
        Form {
            Section {
                HStack { Text("Signed in as"); Spacer(); Text(tools.currentUser).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary) }
                HStack {
                    Text("Password")
                    Spacer()
                    Text(tools.shownPassword ?? "••••••••••").font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
                    Button(tools.shownPassword == nil ? "Show" : "Hide") { tools.revealPassword() }
                    Button("Copy") { tools.copyPassword() }
                }
                HStack {
                    SecureField("New password (8+ characters)", text: $tools.newPassword)
                    Button("Change") { tools.changePassword(random: false) }.disabled(tools.signInBusy || tools.newPassword.count < 8)
                    Button("Generate New") { tools.changePassword(random: true) }.disabled(tools.signInBusy)
                }
            } header: { Text("Windows sign-in") } footer: {
                Text("WinDinghy signs in to Windows with this account and keeps its password in your Keychain. You'll need the password for the Windows lock screen and anything that asks for it.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Section {
                if tools.accounts.count > 1 {
                    Picker("Use an existing account", selection: $tools.otherUser) {
                        Text("Choose…").tag("")
                        ForEach(tools.accounts.filter { $0 != tools.currentUser }, id: \.self) { Text($0).tag($0) }
                    }
                }
                TextField("Account name", text: $tools.otherUser)
                SecureField("Its password", text: $tools.otherPassword)
                Toggle("Create this account in Windows", isOn: $tools.createOther)
                HStack {
                    Button("Switch to This Account") { tools.switchUser() }
                        .disabled(tools.signInBusy || tools.otherUser.isEmpty || tools.otherPassword.count < 8)
                    if tools.signInBusy { ProgressView().controlSize(.small) }
                }
                if let m = tools.signInMessage { Text(m).font(.system(size: 12)).foregroundStyle(.secondary) }
            } header: { Text("Switch account") }
            Section("Activation") {
                HStack {
                    StatusDot(ok: tools.activated == true)
                    Text(tools.activation ?? "Checking…")
                    Spacer()
                    Button("Open Activation Settings") { tools.openSettings("activation") }
                }
                HStack {
                    TextField("Product key", text: $tools.productKey)
                    Button("Activate") { tools.enterKey() }.disabled(tools.accountBusy || tools.productKey.count < 25)
                }
                if let m = tools.accountMessage { Text(m).font(.system(size: 12)).foregroundStyle(.secondary) }
            }
            Section {
                HStack { Row("Microsoft account", "Sign in to sync settings and use Microsoft 365 or the Store."); Spacer(); Button("Open Account Settings") { tools.openSettings("yourinfo") } }
                HStack { Row("Email & accounts", "Add mail, Microsoft, or work accounts."); Spacer(); Button("Open") { tools.openSettings("emailandaccounts") } }
                HStack { Row("Windows Update", "Check for Windows updates."); Spacer(); Button("Open") { tools.openSettings("windowsupdate") } }
            } header: { Text("Accounts") } footer: {
                Text("These open the Windows Settings page in a window of its own. A Microsoft account is optional.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { tools.loadActivation(); tools.loadSignIn() }
    }
}

// MARK: - Work & school

struct EnterpriseView: View {
    @EnvironmentObject var tools: ToolsStore
    var body: some View {
        Form {
            Section("Status") {
                HStack { StatusDot(ok: tools.domainJoined); Text(tools.domainStatus ?? "Checking…") }
            }
            Section {
                HStack { Row("Work or school account", "Join Microsoft Entra ID or connect a work account."); Spacer(); Button("Open Settings") { tools.openSettings("workplace") } }
            }
            Section {
                TextField("Domain (e.g. corp.example.com)", text: $tools.domainName)
                TextField("Domain user", text: $tools.domainUser)
                SecureField("Password", text: $tools.domainPassword)
                TextField("OU path (optional)", text: $tools.domainOU)
                HStack {
                    Button("Join Domain") { tools.joinDomain() }.disabled(tools.workBusy || tools.domainName.isEmpty || tools.domainUser.isEmpty)
                    if tools.domainJoined { Button("Leave Domain") { tools.leaveDomain() }.disabled(tools.workBusy) }
                    Button("Refresh Group Policy") { tools.groupPolicy() }.disabled(tools.workBusy || !tools.domainJoined)
                    if tools.workBusy { ProgressView().controlSize(.small) }
                }
                if let m = tools.workMessage { Text(m).font(.system(size: 12)).foregroundStyle(.secondary) }
            } header: { Text("Join a domain") } footer: {
                Text("Windows restarts to finish. The domain must be reachable from the VM, which usually means being on the office network or a VPN on this Mac. Domain policy may change Windows' clock, sign-in banner and firewall.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { tools.loadDomain() }
    }
}

// MARK: - Storage & backup

enum ResetKind: String, Identifiable { case rewind, reinstall, uninstall; var id: String { rawValue } }

struct ResetSheet: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var tools: ToolsStore
    let kind: ResetKind
    @Environment(\.dismiss) var dismiss
    @StateObject private var backup = Box(true)
    @StateObject private var cache = Box(false)
    @StateObject private var settings = Box(false)

    var title: String {
        switch kind {
        case .rewind: return "Rewind to the clean install?"
        case .reinstall: return "Reinstall Windows?"
        case .uninstall: return "Remove Windows from this Mac?"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.system(size: 17, weight: .semibold))
            switch kind {
            case .rewind:
                Text("Windows returns to how it was right after setup. Anything you installed or saved inside Windows since then is lost. Your Mac files are not affected.")
            case .reinstall:
                Text("The current Windows VM is deleted and a fresh Windows is installed with the same account name, memory and disk settings. Anything inside Windows that isn't in a snapshot or export is lost. Your Mac files are not affected, even the ones Windows sees as Documents or Desktop.")
                Toggle("Save a safety copy to the Desktop first (about \(Int(store.diskUsedGB.rounded())) GB)", isOn: $backup.value).toggleStyle(.checkbox)
                Text("Reinstalling takes 20 to 30 minutes.").font(.system(size: 12)).foregroundStyle(.secondary)
            case .uninstall:
                Text("Deletes the Windows VM and its snapshots (\(Int(store.diskUsedGB.rounded())) GB), the saved Windows password and your app launchers. Exported backups, the Windows installer you downloaded and your Mac files are not touched.")
                Toggle("Also remove cached helper downloads", isOn: $cache.value).toggleStyle(.checkbox)
                Toggle("Also remove WinDinghy's settings", isOn: $settings.value).toggleStyle(.checkbox)
                Text("The WinDinghy app itself stays; drag it to the Trash to remove it.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(kind == .rewind ? "Rewind" : kind == .reinstall ? "Reinstall" : "Remove Windows", role: .destructive) {
                    dismiss()
                    switch kind {
                    case .rewind: store.rewind("clean-install")
                    case .reinstall: store.startReinstall(backup: backup.value)
                    case .uninstall: tools.uninstall(cache: cache.value, settings: settings.value) { _ in }
                    }
                }
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
    var body: some View {
        Form {
            if let pct = tools.removePct {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(tools.removeTitle).font(.system(size: 15, weight: .semibold))
                        ProgressView(value: pct / 100).progressViewStyle(.linear)
                        Text("\(Int(pct))%").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                } header: { Text("Removing Windows") }
            }
            Section {
                HStack {
                    Text(ConfigFile.string("vmDir", "~/Library/Application Support/WinDinghy/vm").replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Move…") { tools.moveVM() }.disabled(tools.storageBusy != nil)
                }
            } header: { Text("Where Windows lives") } footer: {
                Text("Moving shuts Windows down first. An external drive works, but it has to be connected whenever Windows runs.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Section {
                HStack { Row("Export", "Save a full copy of Windows, snapshots included. A good backup before big changes."); Spacer(); Button("Export…") { tools.exportVM() }.disabled(tools.storageBusy != nil) }
                HStack { Row("Import", "Restore a copy, or bring Windows from another Mac. Needs no existing Windows VM."); Spacer(); Button("Import…") { tools.importVM() }.disabled(tools.storageBusy != nil) }
                if let b = tools.storageBusy { HStack { ProgressView().controlSize(.small); Text(b).foregroundStyle(.secondary) } }
                if let m = tools.storageMessage { Text(m).font(.system(size: 12)).foregroundStyle(.secondary) }
            } header: { Text("Backup") } footer: {
                Text("Exports don't include your Windows password; save it again after an import.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Section {
                HStack { Row("Rewind to clean install", "Go back to the restore point taken right after setup."); Spacer(); Button("Rewind…") { sheet.value = .rewind }.disabled(store.snapshotBusy || !store.snapshots.contains { $0.name == "clean-install" }) }
                HStack { Row("Reinstall Windows", "Delete this Windows and set up a fresh one."); Spacer(); Button("Reinstall…") { sheet.value = .reinstall }.disabled(tools.storageBusy != nil) }
                HStack { Row("Remove Windows", "Delete the VM, its password and launchers from this Mac."); Spacer(); Button("Remove…") { sheet.value = .uninstall }.disabled(tools.storageBusy != nil || tools.removePct != nil) }
            } header: { Text("Reset & uninstall") } footer: {
                Text("None of these touch your Mac's own files. Export first if you might want Windows back.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { store.loadSnapshots() }
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
            ForEach(tools.about, id: \.0) { row in
                HStack {
                    Text(row.0)
                    Spacer()
                    if !row.1.isEmpty { Text(row.1).foregroundStyle(row.3 ? Color.secondary : Color.orange).font(.system(size: 12, design: .monospaced)) }
                }
            }
            if let s = store.updateStatus { HStack { ProgressView().controlSize(.small); Text(s).foregroundStyle(.secondary) } }
            Text("Each release is tested against one Windows build, one QEMU and one FreeRDP client. Orange means what's installed differs from what was tested.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .onAppear { tools.loadAbout() }
        Section("Credits & notices") {
            Text("WinDinghy is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Microsoft or by the WinBoat project. Windows is a trademark of Microsoft Corporation. You need your own Windows licence.")
                .font(.system(size: 12))
            Text("Thank you to TibixDev and the WinBoat contributors: WinDinghy's guest agent is WinBoat's (MIT licence), and WinBoat's idea of Windows apps as native apps is what this project builds on. Thanks also to the FreeRDP and QEMU projects, and the Fedora virtio-win drivers.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            HStack {
                Link("WinBoat", destination: URL(string: "https://github.com/TibixDev/winboat")!)
                Link("FreeRDP", destination: URL(string: "https://www.freerdp.com")!)
                Link("QEMU", destination: URL(string: "https://www.qemu.org")!)
                Link("virtio-win", destination: URL(string: "https://github.com/virtio-win/kvm-guest-drivers-windows")!)
            }.font(.system(size: 12))
        }
    }
}

// MARK: - USB sharing (managed VM)

struct UsbDevice: Identifiable, Hashable {
    let id: String            // "vvvv:pppp"
    let name: String
    let vendor: String
    let storage: Bool
    let hid: Bool
    var shared: Bool          // remembered: re-shared whenever Windows starts and it's plugged in
    var attached: Bool        // in Windows right now
    var absent: Bool          // remembered but not plugged in
}

final class UsbStore: ObservableObject {
    static let shared = UsbStore()
    private var cli: AppDelegate? { AppStore.shared.delegate }
    @Published var devices: [UsbDevice] = []
    @Published var running = false
    @Published var busy: String? = nil       // id being switched
    @Published var message: String? = nil

    func refresh() {
        cli?.runDinghyCapture(["usb", "list", "--json"]) { [weak self] status, text in
            guard let self, status == 0,
                  let line = text.split(separator: "\n").reversed().first(where: { $0.hasPrefix("{") }),
                  let data = String(line).data(using: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            self.running = (o["running"] as? Bool) ?? false
            self.devices = ((o["devices"] as? [[String: Any]]) ?? []).map {
                UsbDevice(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? "USB device",
                          vendor: $0["vendor"] as? String ?? "", storage: $0["storage"] as? Bool ?? false,
                          hid: $0["hid"] as? Bool ?? false, shared: $0["shared"] as? Bool ?? false,
                          attached: $0["attached"] as? Bool ?? false, absent: $0["absent"] as? Bool ?? false)
            }
        }
    }

    func set(_ d: UsbDevice, share: Bool) {
        busy = d.id; message = nil
        cli?.runDinghyCapture(["usb", share ? "share" : "unshare", d.id]) { [weak self] status, text in
            guard let self else { return }
            self.busy = nil
            if status != 0 {
                // the CLI prints its error as the last line ("dinghy: ...")
                let why = text.split(separator: "\n").last.map(String.init) ?? "Windows may not be running."
                self.message = "Couldn't share \(d.name): " + why
            }
            self.refresh()
        }
    }
}

struct UsbSection: View {
    @ObservedObject private var usb = UsbStore.shared
    private let tick = Timer.publish(every: 3, on: .main, in: .common).autoconnect()

    var body: some View {
        Section {
            if usb.devices.isEmpty {
                Text("No USB devices found. Plug one in and it shows up here.").foregroundStyle(.secondary)
            }
            ForEach(usb.devices) { d in
                Toggle(isOn: Binding(get: { d.shared }, set: { usb.set(d, share: $0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(d.name)
                        Text(detail(d)).font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
                .disabled(usb.busy != nil || d.absent && !d.shared)
            }
            if let m = usb.message {
                Label(m, systemImage: "exclamationmark.triangle.fill").font(.system(size: 12)).foregroundStyle(Color.orange)
            }
        } header: { Text("USB devices") } footer: {
            Text("A shared device disappears from the Mac and appears in Windows, and comes back to the Mac when you turn it off. It stays shared whenever it's plugged in and Windows starts. Drives are ejected from the Mac first. Keyboards, mice and other input devices stay with the Mac.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .toggleStyle(.switch)
        .onAppear { usb.refresh() }
        .onReceive(tick) { _ in if usb.busy == nil { usb.refresh() } }
    }

    private func detail(_ d: UsbDevice) -> String {
        var parts: [String] = []
        if d.absent { parts.append("Not plugged in") }
        else if d.attached { parts.append("In Windows now") }
        else if d.shared { parts.append(usb.running ? "Couldn't be shared: unplug and replug it, or turn it off and on" : "Shared when Windows starts") }
        else if d.storage { parts.append("Drive") }
        if !d.vendor.isEmpty && !d.absent { parts.append(d.vendor) }
        parts.append(d.id)
        return parts.joined(separator: " · ")
    }
}
