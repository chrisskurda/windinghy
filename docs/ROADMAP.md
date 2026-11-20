# WinDinghy roadmap

## Next (tuning the native client)
- Per-app Dock icons/names (bundle-local client copy; verify on macOS).
- Show connection errors as native notifications instead of FreeRDP's unscaled dialogs.
- `dinghy status` warns about a same-user console session on the VM.
- Bundle the built client in the menu-bar app; no build script for end users.
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

Order: (1) `guest.mjs` transport (done for UTM), (2) QEMU transport behind the same
interface + `dinghy vm create/start/stop/snapshot`, (3) unattended installer, (4) make
it the default, UTM stays supported.

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
