# WinDinghy

Run Windows apps from a UTM virtual machine as if they were native macOS apps —
each one gets a real `.app` in `~/Applications/WinBoat` (Spotlight, Dock, Finder)
that opens as its own window via RDP RemoteApp.

This reuses [WinBoat](https://github.com/TibixDev/winboat)'s guest agent (MIT,
© TibixDev) inside the Windows VM, and replaces the Linux-only pieces (Docker
backend, FreeRDP/X11 client) with UTM + Microsoft's **Windows App** as the
display client.

## How it works

```
┌─ macOS ──────────────────────────┐      ┌─ Windows VM (UTM) ─────────────┐
│  wbm sync ──────────HTTP:7148──────────▶  WinBoat Guest Server (service) │
│    │  app list + icons           │      │    - enumerates installed apps │
│    ▼                             │      │                                │
│  ~/Applications/WinBoat/*.app    │      │  RDP host (RemoteApp/RAIL      │
│    each wraps a .rdp file        │      │   unlocked via registry)       │
│    │                             │      │                                │
│    └─ open ▶ Windows App ──RDP:3389────▶  app renders as its own window  │
└──────────────────────────────────┘      └────────────────────────────────┘
```

- The **guest server** (Go, built for Windows ARM64) runs as a service in the VM
  and serves the installed-app list, icons, health, and metrics on port 7148.
- `setup.ps1` enables the RDP host and flips the `TSAppAllowList` /
  `fAllowUnlistedRemotePrograms` registry keys so **any** program can run as a
  RemoteApp on Windows Pro — no RDS server needed.
- `wbm sync` turns each app into a small `.app` bundle containing a generated
  `.rdp` file (`remoteapplicationmode:i:1`) that opens in **Windows App**.

## Requirements

- UTM VM running Windows 11 **Pro/Enterprise/Education** (Home can't host RDP),
  on a network the Mac can reach (UTM "Shared Network" works out of the box).
- [Windows App](https://apps.apple.com/app/windows-app/id1295203466) (the former
  Microsoft Remote Desktop) — already installed.
- Node.js on the Mac (for the `wbm` CLI).

## Setup (one time)

1. Start the Windows VM, then on the Mac:

   ```sh
   ./wbm serve-setup
   ```

2. It prints a one-liner. In the VM, open **PowerShell as Administrator** and run:

   ```powershell
   irm http://192.168.64.1:8756/setup.ps1 | iex
   ```

   This enables RDP, unlocks RemoteApp, installs the guest server service, and
   opens firewall ports. It's idempotent — safe to re-run.

3. `wbm serve-setup` detects the guest coming up and runs the first sync
   automatically. Done — check `~/Applications/WinBoat`.

4. First launch only: Windows App will show a certificate warning (the VM uses a
   self-signed RDP cert — accept it) and ask for your **Windows username and
   password** (tick "save" so it goes into the Keychain). Set
   `wbm config username <user>` to pre-fill the username in generated files.

## Daily use

```sh
./wbm sync              # re-scan apps after installing something in Windows
./wbm launch "Excel"    # or just open the .app from Spotlight/Finder
./wbm desktop           # full Windows desktop session
./wbm status            # guest health, CPU/RAM, RDP reachability
./wbm config            # show config (~/.config/winboat-mac/config.json)
```

## Menu-bar app

`host/menubar/build.sh` builds `~/Applications/WinBoat.app`, a native menu-bar
"Start button": VM online/offline status with live CPU/RAM, a Running section
for open RemoteApp windows (count badge on the icon; window titles once you
grant Screen Recording), an Apps submenu with icons, Sync Apps Now, Open
Windows Desktop, Start Windows VM when it's offline, and a Start-at-Login
toggle. Rebuild after `wbm` changes: `./host/menubar/build.sh`.

Note: all RemoteApp windows belong to the single "Windows App" process, so
the Dock can only ever show one icon for all of them — per-app running
indicators live in this menu instead.

## Launch behavior

Launchers are dynamic: each `.app` calls `wbm open-rdp`, which
1. health-checks the configured VM address,
2. if unreachable, **rescans the vmnet bridge subnets** for the guest API and
   self-repairs the config (survives DHCP changes; adds ~10s to that launch),
3. if nothing answers, **starts the UTM VM** (`wbm config vmName` — default
   "Windows") and waits up to 3 minutes for it to boot, with progress shown
   as macOS notifications,
4. then generates a fresh `.rdp` and hands it to Windows App.

Sync filters out non-launchable noise (codec packs, runtimes, uninstallers);
see everything with `wbm config filter off` + re-sync.

## Troubleshooting

- **Error 0x1807 ("security error") even with correct credentials** — the
  guest's RDP security layer is in a bad state; this has been seen after
  abrupt VM shutdown/boot cycles. It is *not* a credential problem. Fix:
  restart the VM (menu bar → Restart Windows VM, or quit UTM and start it
  again).

- **Auto-start doesn't kick in** — the first `utmctl` invocation may trigger a
  macOS automation-permission prompt for UTM; approve it once. Check the VM
  name matches: `wbm config vmName`.
- **RDP closed after setup** — the VM's network profile may be "Public" with
  stricter rules; setup adds explicit any-profile rules, so re-run the
  one-liner and check `Get-Service TermService`.
- **App opens a full desktop instead of a window** — the RAIL registry keys
  didn't take; re-run setup and sign out of any open RDP session once.
- **Console shows lock screen while an app is open** — normal: an RDP
  connection takes over the Windows session, so the UTM console window locks.
  Use one or the other at a time.
- **Performance** — give the VM more RAM (it's at 4 GB; 6–8 GB helps Win11 a
  lot) in UTM settings. The generated .rdp files already use LAN-class
  settings (no wallpaper/animations, auto-detect off, font smoothing on).
  Windows App's RemoteApp path is much better than it was a few years ago,
  and over the local vmnet there's no network bottleneck.

## Layout

```
wbm              CLI entry point (bash shim → host/wbm.mjs)
host/wbm.mjs     the whole host-side tool (zero-dependency Node)
payload/         what gets installed into the VM at C:\Program Files\WinBoat
  setup.ps1        guest configurator (served templated by `wbm serve-setup`)
  server/          winboat_guest_server.exe (Go, windows/arm64) + PS scripts
  nssm.exe         service wrapper (SHA-1 verified against upstream)
```

Guest agent source: [WinBoat `guest_server/`](https://github.com/TibixDev/winboat/tree/main/guest_server),
built with `GOOS=windows GOARCH=arm64 go build ./cmd/server`.
