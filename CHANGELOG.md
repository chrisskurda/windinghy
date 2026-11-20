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

- WIP: a VM WinDinghy manages itself on QEMU + Hypervisor.framework (no UTM):
  `dinghy vm create|start|stop|status|screenshot|use|destroy`. Headless, user-mode
  networking with forwarded ports (127.0.0.1:13389 RDP, :17148 guest API, so the
  address never changes), QEMU guest agent for exec/files, unattended Windows 11
  install (answer-file CD built with hdiutil). Verified: headless boot, QMP, keys,
  screenshots. Not yet verified: the full Windows install (needs an ARM64 ISO).

### Fixed

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
