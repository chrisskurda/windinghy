# Changelog

All notable changes to WinDinghy are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
bumps may include breaking changes).

## [Unreleased]

### Added

- Reset & uninstall (Storage & Backup): rewind to the clean install, reinstall Windows (optional safety export first, same account and resources), or remove Windows from this Mac. CLI: `dinghy vm reinstall --yes [--backup <path>]`, `dinghy uninstall [--yes] [--purge-cache] [--purge-settings]`.

### Fixed

- Deleting a VM only removes the files WinDinghy created, so a custom VM folder that holds anything else is never wiped.

## [0.2.0] - 2026-11-20

The managed-VM release: WinDinghy now builds and runs its own Windows 11 ARM64 VM (no UTM needed), has a real window instead of a busy menu, and pins everything to a tested set of versions.

Tested with: Windows 11 24H2 (build 26100, ARM64), WinBoat guest agent base v0.9.0, FreeRDP 3.33.2-dev0 (`6fd1571`) with `patches/`, QEMU 11.1.3, macOS 27. See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

### Added

**Managed Windows VM**
- `dinghy vm create`: a Windows 11 VM WinDinghy builds and runs itself on QEMU and Hypervisor.framework. Headless, forwarded ports (RDP 127.0.0.1:13389, guest API :17148, so the address never changes), QEMU guest agent for commands and files. Fully unattended: finds an ARM64 Windows ISO in ~/Downloads (or opens Microsoft's page), picks the edition, installs drivers and the guest agent, runs `setup.ps1`, creates a dedicated Windows account with a random password in the Keychain, and syncs your apps. Retail ISOs use Microsoft's generic install key (installs unactivated; `--key` for your own). `--user` sets the Windows account name (the setup window defaults to your macOS username).
- `dinghy vm start|stop|status|screenshot|use|destroy|move|export|import`. Export saves a full image (snapshots included, password excluded), so it doubles as a backup; move relocates the disk, for example to an external drive.
- Snapshots: `dinghy vm snapshot|snapshots|rewind|snapshot-delete`, with a `clean-install` baseline.
- Advanced mode (`dinghy config advanced on`): UTM or another hypervisor, a remote host or a custom client. Remote hosts get an encrypted-VPN warning.
- `dinghy setup`, `fix [session|rdp|clock|server|login]`, `doctor`, discovery after a DHCP change, and clock correction (Mac time pushed into the guest, also after the Mac wakes).

**Native client**
- Patched FreeRDP SDL3 client (RemoteApp) replaces Windows App: every Windows window is a real macOS window, with the app's own Dock icon and name. Bundled in the app (lean build, no Homebrew needed to run it). Credentials in the Keychain, passed over stdin.
- Logon banner handling (shown natively; `--no-banner` opt-in with a network-policy warning).
- Native error alerts with a plain explanation and Show Log.
- Read-only shares: per-share switch in Sharing (`dinghy folders ro <name> on|off`), enforced in the patched FreeRDP drive channel.
- Printer sharing (CUPS) and audio.

**The WinDinghy window** (SwiftUI, from the design handoff)
- Apps, Windows Desktop, Windows Tools, Software, Account & Activation, Work & School, Windows, Resources, Sharing, Snapshots, Storage & Backup, General, and a first-run setup flow with progress.
- Windows tools (Control Panel, Device Manager, Event Viewer, ...) are classified at sync and kept out of the Apps grid.
- Software: `dinghy pkg search|list|install|uninstall|upgrade` through winget. No Microsoft account or Store sign-in needed.
- Account & Activation: `dinghy activation [key <KEY>]`, `dinghy open-settings <page>`. Work & School: `dinghy domain status|join|leave|gpupdate`.
- Folder redirection: Windows' Documents, Downloads, Desktop, Pictures, Music and Videos are your Mac's folders by default, each with an off switch (`dinghy folders status|on|off|apply`). The home folder is shared by default.
- The menu-bar menu is only quick actions. New dinghy app icon and menu-bar glyph (the original symbol is a setting).

**Versions, credits and docs**
- `host/compat.json` pins the tested set; `dinghy about` and General compare what's installed. Installing a Windows build outside the tested list warns first (Install Anyway / `--allow-untested`).
- NOTICE.md: not affiliated with Microsoft or WinBoat, credit and thanks to WinBoat, dependencies and licensing. Also shown in the app.
- README rewritten for the managed VM, plus docs/GUIDE.md, docs/COMPATIBILITY.md, docs/ROADMAP.md and docs/RELEASING.md.
- macOS App Management permission is requested up front (`dinghy permissions`).
- Self-update (`dinghy update`, Check for Updates).

### Changed

- The native client is the default; Windows App remains only in advanced mode.
- Guest time sync polls every 60 seconds with unlimited step correction.
- Notifications and text say WinDinghy, not WinBoat.

### Fixed

- Quitting an app from the Dock no longer shows "Lost the Windows VM".
- The updater shows a result window (notifications were silently dropped), keeps its output, can't hang on a git prompt, and rebuilds the RDP client when its patches change.
- Launching a second app no longer raises an error on the first (one connection per user; the replaced client exits quietly).
- Error classification reads only real `[ERROR]` lines; a rejected authorization no longer discards the saved password.
- The native client exits about 3 seconds after the last window closes.
- Stopping the VM shuts Windows down through the guest agent; setup works for the managed VM and on a clean slate; setup no longer deadlocks on its own web server or kills its own RDP session.
- WinDinghy repairs its own settings (corrupt `config.json`, stale ports, corrupt profiles) instead of failing.
- The app bundle includes all host modules; stale banner and console-session state from an old VM no longer leaks into a new one.
- Multi-line PowerShell through the QEMU guest agent returned empty output.

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

[Unreleased]: https://github.com/chrisskurda/windinghy/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/chrisskurda/windinghy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/chrisskurda/windinghy/releases/tag/v0.1.0
