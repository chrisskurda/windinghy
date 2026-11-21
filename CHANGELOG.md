# Changelog

All notable changes to WinDinghy are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
bumps may include breaking changes).

## [Unreleased]

### Added

- Windows folders (Documents, Downloads, Desktop, Pictures, Music, Videos) redirect to the Mac's equivalents by default, each with a switch in Sharing; `dinghy folders status|on|off|apply`. The home folder stays shared by default.
- Setup wizard asks for the Windows account name (default: your macOS username); `dinghy vm create --user`.
- Windows tools (Control Panel, Device Manager, Event Viewer, ...) are classified at sync (`Category` in app.json) and live in their own Windows Tools pane, keeping Apps for user apps. "Windows Desktop" is in the Apps list and has its own pane.
- Software pane and `dinghy pkg search|list|install|uninstall|upgrade`: winget, no Microsoft account or Store sign-in needed; new apps are synced after an install.
- Account & Activation pane (`dinghy activation [key <KEY>]`, `dinghy open-settings <page>`) and Work & School pane (`dinghy domain status|join|leave|gpupdate`).
- Storage & Backup: `dinghy vm move|export|import` to relocate the VM disk or save/restore a full image (snapshots included, password excluded).

- Native RemoteApp client (opt-in/auto): launches use a patched FreeRDP
  `sdl-freerdp` instead of Windows App, so each Windows window is a real
  macOS window. Build it with `scripts/build-freerdp.sh` (patch in `patches/`,
  notes in `docs/native-client-evaluation.md`); `dinghy config client
  native|windows-app|auto` and `nativeBin` control it. `auto` uses it when
  built.
- Credentials for the native client live in the macOS Keychain
  (`dinghy login`, or prompted on first launch) and reach FreeRDP over stdin,
  never on the command line. A rejected password is re-prompted once.
- Logon banner: `setup.ps1` reports the guest's legal-notice text; WinDinghy
  shows it in a native dialog before a new session and, once accepted, the
  client dismisses the matching Windows dialog. `dinghy serve-setup
  --no-banner` (opt-in) blanks the banner on the guest instead.
- Failed native launches explain themselves (bad password, same-user console
  session on the VM, clock drift).

- Each app's native process now runs from a bundle-local copy of the client,
  so macOS shows the app's own icon and name in the Dock; the menu bar uses
  the Windows program's name (`WINDINGHY_APP_NAME`).
- `dinghy config suppressBanner on` (or `serve-setup --no-banner`): keep the
  Windows logon banner suppressed. The guest warns that this may violate your
  network policy and requires typing YES.

- Native error screens: connection problems (bad password, VM unreachable or
  lost, security/clock errors, same-user console session, timeouts) show a
  native alert with a plain explanation and a "Show Log" button instead of
  FreeRDP's unscaled dialog; normal closes stay silent.
- `dinghy` can be symlinked into a PATH directory (`ln -s ~/windinghy/dinghy
  ~/.local/bin/dinghy`); the wrapper resolves symlinks.

- `dinghy discover` and automatic VM re-discovery: the VM is found again after a
  DHCP change by its MAC address (live ARP table, then macOS's DHCP lease file,
  verified against the guest ports), falling back to the bridge subnet scan.
  The MAC and the UTM VM name are learned automatically. `status`, `sync`,
  `doctor` and the menu-bar app (when the guest stops answering) now run it.

- `dinghy setup`: hands-free guest setup through UTM's guest agent (starts the
  VM, installs the guest components, creates a dedicated "WinDinghy" Windows
  account with a random password stored in the Keychain, syncs your apps).
  Falls back to the manual one-liner if the agent isn't installed yet.
- `dinghy fix [session|rdp|clock|server]` repairs common guest problems the
  same way (clock drift, RDP, the guest server, a blocking console session
  after a confirmation). `doctor` now points at these.
- `host/guest.mjs`: guest transport over `utmctl exec/file/ip-address`. Note `utmctl
  exec` is asynchronous, so output is collected through a unique result file that
  the script renames when finished, polled with `file pull`.

- Menu bar: "Set Up Windows VM…" now runs `dinghy setup` in a live progress
  window (with a Copy Command button for the manual fallback), and a new
  "Fix Problems…" item runs `dinghy fix`.
- The native RDP client is bundled in the app: `host/menubar/build.sh` builds a
  self-contained "lean" client (no ffmpeg/H.264; `scripts/build-freerdp.sh`,
  `scripts/relocate-dylibs.py` copies the remaining libraries and rewrites install
  names so Homebrew isn't needed to run it) and ships it, plus the guest payload,
  inside WinDinghy.app. `dinghy` prefers the bundled client automatically.

- Guest clock drift is fixed at the source: the Mac pushes its own time into the
  guest through the agent (`dinghy fix clock`), automatically before each launch
  when the drift exceeds a minute, and from the menu-bar app a few seconds after
  the Mac wakes. (A sleeping Mac pauses the VM, and domain Group Policy can pin
  W32Time to an internal NTP server with a slow poll, so the guest can't recover
  on its own.)
- The native client no longer shows FreeRDP's unscaled "connection is being
  established" dialog.

- `dinghy vm create`: a Windows 11 VM WinDinghy builds and runs itself on QEMU +
  Hypervisor.framework, no UTM. Headless, user-mode networking with forwarded ports
  (RDP 127.0.0.1:13389, guest API :17148, so the address never changes), QEMU guest
  agent for exec/files. Fully unattended: it finds an ARM64 Windows ISO in ~/Downloads
  (or opens Microsoft's page), reads the ISO's editions and picks Enterprise/IoT/Pro,
  builds an answer-file CD, installs (about 6 minutes), installs drivers and the guest
  agent, runs `setup.ps1` from the Mac, creates a dedicated "WinDinghy" account with a
  random password in the Keychain, and syncs your apps. Verified on Windows 11 24H2 Pro:
  9 GB on disk, RemoteApp through the native client works. Retail ISOs use Microsoft's
  generic install key (installs unactivated; `--key` for your own).
  Also `dinghy vm start|stop|status|screenshot|use|destroy`; `dinghy vm use utm|qemu`
  switches between a UTM VM and the managed one (each keeps its own settings).
- `dinghy fix login` repairs the dedicated Windows account (group membership, password).

- macOS App Management permission is now handled up front: `dinghy permissions [--prompt]`
  probes whether the menu-bar app may update the app launchers; setup, sync, Fix Problems and
  `doctor` check it, the menu-bar app asks (at most once a day) when it starts and lists it in
  "Setup Check…" with an Open App Management button, and the flows that need it open the
  Settings pane and continue automatically once the switch is on.

- **Advanced mode** (`dinghy config advanced on`, or the menu-bar toggle): UTM or another hypervisor,
  manual guest setup, a custom RDP client or any non-local host are unsupported and need it; a
  non-local host gets the encrypted-VPN warning (also flagged by `dinghy doctor`). The managed VM is
  the supported setup; without advanced mode `dinghy setup` builds one.
- **Snapshots** for the managed VM: `dinghy vm snapshot [name]`, `snapshots`, `rewind <name>`,
  `snapshot-delete <name>` (disk state plus the UEFI variables; Windows is shut down cleanly through
  the guest agent first). `vm create` saves a `clean-install` baseline.
- Menu bar: a **Windows VM** submenu (Start/Stop/Restart, Take Snapshot…, Rewind To, Show VM Folder),
  an **Advanced Mode** toggle, and a **Menu Bar Icon** choice (the new dinghy glyph, or the original
  window symbol). The new app icon and glyph are in `host/menubar` (`make-icon.sh` rebuilds the .icns).

- **The WinDinghy window** (menu bar > Open WinDinghy…, or click the Dock icon): a native SwiftUI window
  built from the design handoff (`docs/design/main-window`). Sidebar with a live status card; **Apps**
  (grid with the real app icons, search, Sync, running apps highlighted); **Windows** (start/stop/restart,
  CPU/memory/disk, health, open desktop); **Resources** (cores, memory, disk for the managed VM; applied
  at the next start, and the Windows partition is extended after a disk grows); **Sharing** (clipboard,
  home folder, printers, audio, extra folders, applied at the next app launch); **Snapshots**;
  **General** (account, start at login, menu bar icon, setup check, fix problems, updates, advanced
  mode); and a **first-run setup** flow wired to `dinghy vm create` with a progress bar.
- The menu-bar menu is now just quick actions: status, running apps, search, favorites and apps, Open
  Windows Desktop, Sync, Start Windows, Open WinDinghy…, Quit. Everything else moved into the window.
- Shared folders appear in Windows as `\\tsclient\<name>`. FreeRDP's drive redirection has no
  read-only mode, so shares are read/write. Printer sharing needs the client built with CUPS (now on).
- `dinghy vm create --progress` prints `PROGRESS:<pct>:<phase>` lines; `dinghy vm snapshots --json`.

### Fixed

- Stopping the managed VM now asks Windows to shut down through the guest agent (the ACPI power-button
  press does nothing at the lock screen).
- `dinghy setup` works for the managed (QEMU) VM and on a clean slate: it no longer assumes UTM
  (no "set the network to Shared Network" error), and with no UTM and no VM it simply builds a
  WinDinghy VM. Setup's own web server is now served while the guest call runs (the call used to
  block the server it was waiting on).
- The doctor, `fix`, the menu-bar Start/Restart VM and Setup Check are backend-aware: UTM is only
  required (and mentioned) when you actually use a UTM VM.
- The "hide the logon banner" question is only asked when the VM really has a banner (a lone NUL
  character in an unset banner no longer counts as one).
- WinDinghy repairs its own settings instead of failing: unreadable `config.json` is backed up and
  replaced, bad or stale values (removed volume, wrong ports for the managed VM, corrupt profiles,
  empty banner files) are corrected on load, and each repair is reported on stderr.
- The app bundle now includes all host modules (it previously copied only two and would have
  crashed on import).
- Launching a second app no longer risks a false "Lost the Windows VM" alert on the first
  one: each launch records its start time and a client that exits after a newer launch has
  started is treated as superseded (Windows can drop the replaced connection before it
  sends the "replaced" message, so the log alone can't tell).
- macOS App Management ("WinDinghy.app was prevented from modifying apps"): when the
  menu-bar app can't rewrite the app launchers, dinghy now explains the one-time permission
  (System Settings > Privacy & Security > App Management) and offers to open it.
- Stale state from an old VM no longer leaks into a new one: the logon banner is stored per
  backend (and the guest tells the Mac when it has none), and the "console session (UTM)"
  advice only appears for UTM VMs.
- Launching a second app no longer shows an error for the first: Windows allows one live
  connection per user, so the newer client takes over the session and displays every open
  app's windows; the replaced client exits quietly. (Client Windows editions also allow only
  one active interactive session, so concurrent separate sessions aren't possible.)
- The error classifier only reads real `[ERROR]` lines; harmless warnings (e.g. "does not
  support AAD security") no longer produce a false "security error / clock drift" alert.
- A Remote Desktop *authorization* failure (account not in Remote Desktop Users) no
  longer makes the launcher discard the saved password; only a real logon failure does,
  and the error alert now says what's wrong.
- The native client exits about 3 seconds after an app's last window closes
  (it used to linger with a blank Dock icon until the server disconnected
  ~20s later), and a normal close no longer raises a "session ended" error.
- Guest setup no longer kills its own RDP session: when run over RDP the
  TermService restart is deferred to a one-shot task.
- `dinghy serve-setup` now re-discovers the VM when its IP changed instead of
  waiting on the stale address.

### Added

- Self-update: "Check for Updates…" in the menu bar, or `dinghy update` /
  `./update` from the terminal. Fast-forwards from `origin/main`, rebuilds
  the menu-bar app, and relaunches it if it was running; refuses to touch a
  dirty tree or diverged local commits. The update logic lives in the
  tracked `host/dinghy-update.sh` but only ever runs via a gitignored copy
  installed at the repo root (`update`), so the git operations an update
  performs can never delete or corrupt the script recovering from them.

### Added

- Guest setup from the menu-bar app: a "Set Up Windows VM…" item (shown
  prominently while the guest is unreachable, e.g. on first run) serves the
  install payload and displays the PowerShell one-liner with the correct IP
  to run inside Windows; apps sync automatically once the guest comes up.
- `dinghy serve-setup --json` machine-readable mode backing the GUI flow.
- The menu-bar app's Info.plist version now tracks the dinghy `VERSION`.
- Launches now check guest clock drift first and wait for it to resync
  instead of failing with an RDP security error (0x1807).

### Changed

- Guest setup tightens time sync: NTP poll every 60s with unlimited step
  correction (was a 15-minute resync task), shrinking the post-pause window
  where CredSSP rejects connections with 0x1807. Re-run the setup script in
  the VM to apply.

### Fixed

- macOS notifications were still titled "WinBoat"; retitled to WinDinghy
  (also the Setup Check dialog and remaining user-facing CLI text).

## [0.1.0] - 2026-08-13

First versioned release.

### Added

- `dinghy` host CLI: `serve-setup`, `status`, `sync`, `launch`, `desktop`,
  `doctor`, `config`, and `version` commands.
- Guest payload (`setup.ps1` + WinBoat Guest Server via nssm) that turns on
  RDP/RemoteApp and exposes app list, health, and metrics to the host.
- `dinghy sync` generates per-app `.app` launchers in `~/Applications/WinDinghy`
  with real Windows icons; launches open as RemoteApp windows via Microsoft's
  Windows App.
- Menu-bar app: VM online status, CPU/RAM metrics, open RemoteApp window list,
  favorites by launch count, and categorized app launcher.
- Launchers auto-rediscover the VM's address and boot the VM in UTM if needed,
  falling back to a static `.rdp` file when node/dinghy has moved.

### Fixed

- `.rdp` files are named after their app so Windows App titles RemoteApp
  windows with the app name instead of "app" (also fixes the menu-bar
  window list showing every window as "app").

[Unreleased]: https://github.com/chrisskurda/windinghy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/chrisskurda/windinghy/releases/tag/v0.1.0
