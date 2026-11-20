# Changelog

All notable changes to WinDinghy are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
bumps may include breaking changes).

## [Unreleased]

### Added

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

### Fixed

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
