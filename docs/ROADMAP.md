# WinDinghy roadmap

## Product decisions (Nov 2026)

- **The supported setup is the VM WinDinghy manages itself** (`dinghy vm create`: QEMU on Apple's
  hypervisor, retail Windows 11 ARM64). It is the first-class path and the default for new users.
  Anything else (UTM or another hypervisor, a VM on another machine, a custom RDP client) may work
  but is unsupported and lives behind **advanced mode** (`dinghy config advanced on`, or the menu-bar
  toggle). Pointing WinDinghy at a non-local machine without an encrypted VPN (WireGuard, Tailscale,
  ...) is discouraged: the guest API is plain HTTP. Encrypted remote support is planned (below).
- **Hypervisor management is WinDinghy's job**, hidden from a typical user but reachable when something
  needs fixing: install/verify QEMU, start/stop/restart the VM, snapshots with rewind (done), logs and
  the VM folder (menu bar > Windows VM). Still to do: install and update QEMU automatically (or bundle it),
  idle auto-stop/suspend to save battery, RAM/CPU/disk settings, move the VM to an external disk,
  disk compaction, backups.
- **Stock Windows only by default.** Stripped images (nano11/tiny11 style) break Windows Update, so they
  are an advanced option via `dinghy vm create --iso <path>`, not a recommendation.
- **Unity-style integration** (as Parallels and VMware Fusion had):
  - *Per-app Dock identity.* Windows allows one live session per user, so all apps share one RDP
    connection and today the newest client's Dock icon represents every window. Design: one long-lived
    client per VM (new apps are launched over the existing connection with RAIL exec through a control
    socket) plus small stub apps that own each app's Dock icon, name and menu and forward activation to
    the right windows.
  - *A Start button / widget.* A Windows-style launcher: a menu-bar popover or floating panel with search,
    pinned and recent apps, a list of running apps and their windows, Windows Desktop, and VM controls.
  - Optional: Dock stack for the apps folder, Spotlight actions, Mission Control grouping.
- **Menu-bar icon:** the new dinghy glyph (a template image) is the default; the original window symbol
  stays available (menu bar > Menu Bar Icon).

## Far out: more than one VM, Linux and Android

Managing several VMs (advanced mode) belongs with supporting other guests, Linux and Android, so it is a
long way off and should be designed together with them. Today the code assumes one VM: fixed forwarded
ports (13389 / 17148), a single VM folder and name, and one set of launchers. It would need:

- a VM list with per-VM folder, ports, resources, power settings, snapshots and saved state;
- a per-VM launcher folder (or a VM badge on launchers) and a VM picker in the menu bar and window;
- a guest abstraction beyond Windows/RemoteApp (Linux apps over Wayland/RDP, Android via its own display
  protocol), and a decision on whether one RDP client per VM still makes sense;
- the "one long-lived client per VM" Unity-style design above, generalised to several VMs.

## Next (tuning the native client)
- Per-app Dock icons/names (bundle-local client copy; verify on macOS).
- Show connection errors as native notifications instead of FreeRDP's unscaled dialogs (done).
- `dinghy status` warns about a same-user console session on the VM.
- Bundle the built client in the menu-bar app (done: lean client, no Homebrew at runtime). Still to do: ship a prebuilt/notarized app so end users skip the first-time build.
- Edge/popup focus issue: collect `nativeDebug` logs if it recurs.
- Logon banner suppression stays opt-in (`dinghy config suppressBanner on` or
  `serve-setup --no-banner`; guest requires typing YES and warns about policy).

## Remote PC support (encrypted host <-> client)
Today the Mac talks to a VM on the local vmnet bridge. Two plaintext pieces
must change before it is safe over a network:

| Channel | Today | Remote plan |
|---|---|---|
| RDP session | TLS/NLA, but `/cert:ignore` | Pin the server certificate per host (TOFU, store fingerprint in config; refuse on change). Optional RD Gateway (`/g:`). |
| Guest API :7148 (app list, icons, health) | plain HTTP, no auth | Wrap in TLS with a pinned cert + shared token, or tunnel it. The WinBoat guest binary can't be changed, so front it with a small authenticated proxy on the guest bound to the public interface while the original stays on localhost. |
| Setup server :8756 | plain HTTP on the bridge | Local-only by design; for remote hosts replace with an out-of-band install (signed one-liner or MSI). |
| Credentials | Keychain, stdin to client | Keep; make them per host. |

Recommended order: (1) host profiles + cert pinning, (2) authenticated TLS
proxy for the guest API, (3) document WireGuard/Tailscale/SSH tunnel as the
zero-code alternative, (4) RD Gateway support.

## Own the VM (no UTM, near-zero setup for new users)

UTM works well when the user builds their own Windows VM. To remove that burden,
WinDinghy can create and run the VM itself.

Options considered (Apple Silicon, Windows 11 ARM guest):

| Option | Scriptable | Verdict |
|---|---|---|
| **QEMU + Hypervisor.framework (HVF), headless** | Fully: QMP socket, qemu-guest-agent, unattended install | **Recommended.** Same engine UTM uses; free; no GUI needed because RemoteApp renders over RDP. |
| UTM (QEMU or Apple backend) | `utmctl` (start/stop/exec/file/ip) | Keep as "bring your own VM"; best path for users who already have one. |
| VMware Fusion (free, Broadcom account) | `vmrun` | Viable fallback; closed, heavier, account required. Guest ops on ARM unverified. |
| Parallels | `prlctl` | Best UX/perf but paid; not a default. |
| Apple Virtualization.framework | n/a | No Windows guests (no drivers / vTPM). |
| Docker / containers | n/a | No `/dev/kvm` on macOS: pure emulation. |

Design for the QEMU backend:
- Headless VM, **user-mode networking with host port forwards** (e.g. 127.0.0.1:13389 -> 3389,
  :17148 -> 7148). No vmnet, no DHCP address changes, no root, and the address WinDinghy
  uses never moves (this replaces the discover/MAC logic for managed VMs).
- Control over QMP (lifecycle) and the qemu guest agent over a virtio-serial socket
  (exec, file, IPs) - the same operations `guest.mjs` already abstracts for UTM.
- Unattended install: autounattend.xml (local account with a random password stored in the
  Keychain, Pro edition, RDP on) + virtio drivers injected, FirstLogonCommands install the
  guest agent and run `setup.ps1`. TPM via swtpm (Windows 11 can also be installed with
  the TPM check bypassed).
- The only user input: supply (or let WinDinghy open the download page for) the Windows 11
  ARM64 ISO. Everything else is automatic.
- Disk lives under `~/Library/Application Support/WinDinghy/vm` or a user-chosen volume;
  qcow2 snapshots give "rewind to clean".

Existing projects doing the same thing, useful as references (check licenses before reuse):
[windows-desktop-vm](https://github.com/milesbuckton/windows-desktop-vm),
[winvm](https://github.com/stuffbucket/winvm),
[vitrine](https://github.com/cioufong/vitrine),
[SiliconWin](https://github.com/OathWallet/SiliconWin),
[alcove](https://github.com/YangTaeyoung/alcove).
Open question from their notes: TPM under HVF depends on the QEMU version (alcove disables
it; vitrine and SiliconWin use swtpm).

Status: (1) guest transport, (2) QEMU backend + `dinghy vm`, and (3) the unattended installer
are done and verified (Windows 11 Pro, ~6 min, 9 GB). Remaining: (4) make it the default for
new users with UTM kept as "bring your own VM"; qcow2 snapshots ("rewind to clean"); try a
nano11-style stripped ISO as `--iso`; TPM (swtpm) if an edition needs it; a `dinghy vm`
menu-bar flow; move the VM to an external disk (`vmDir`).

## Connection manager (no RemoteApp)
A general RDP connection manager built on the same patched FreeRDP:
- Host profiles (address, user, Keychain ref, gateway, resolution/scaling,
  clipboard, drives, audio, multi-monitor); import/export `.rdp`.
- Desktop-mode sessions through `sdl-freerdp` (no RAIL), with the macOS
  fixes already in the patch; profile list in the menu-bar app and as a
  separate lightweight app.
- Refactor config from one `host` to `hosts[]`; app bundles reference a host id.
- Shares the credential, certificate-pinning and error-reporting code with
  the RemoteApp path.

## Not yet possible (decided 2026-11)

- **Windows Desktop embedded in the main window** needs an in-process RDP view (libfreerdp plus AppKit rendering). Today it opens in its own full-screen-capable window. The same work enables one-connection Dock identity and a Start widget.
- **Read-only shared folders**: done (FreeRDP drive-channel patch).
- **USB sharing**: done on the QEMU side (usb-host hot-plugged over QMP, picker in Sharing). Limits: macOS keeps devices it has a driver for (keyboards, mice), identical devices share one vendor:product id, and it needs the managed VM.
- **3D acceleration**: none for Windows guests on QEMU/HVF today (no ARM64 WDDM virtio-gpu driver); software rendering only.
