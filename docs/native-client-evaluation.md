# Native RDP client evaluation (Nov 2026)

Question: can WinDinghy drop Windows App / Docker and own the experience?

## Findings

- **Windows ARM in Docker on macOS: no.** Docker Desktop's Linux VM has no
  `/dev/kvm`, so Windows would run under pure emulation. UTM/QEMU already uses
  Hypervisor.framework (`Hypervisor: true`), so CPU is near-native.
- **Apple Virtualization.framework for Windows: no.** macOS/Linux guests only
  in practice; no Windows drivers for its virtio devices, no vTPM.
- **FreeRDP on macOS: yes, already.** FreeRDP 3.x's SDL3 client
  (`sdl-freerdp`, Homebrew `freerdp`) has a RemoteApp/RAIL implementation
  (`client/SDL/SDL3/sdl_rail*.cpp`): one native window per remote window.
  No X server needed. Flags needed on macOS Retina: `/scale-desktop:100
  /scale-device:100` (without them windows are ~2x too large).
- **XLibre / yserver: fallback only.** yserver has a macOS rootless mode but
  puts every window under one Dock icon; XLibre is an X.Org fork and doesn't
  fix the real control point (the RDP client).

## Patch: `patches/freerdp-sdl-macos-remoteapp.patch`

Base: FreeRDP commit in `freerdp-base-commit.txt`. Fixes a black full-screen
macOS Space under every RemoteApp window:

- `sdl_context.cpp`: RemoteApp turns on multimon, which made the client put its
  (hidden) per-display desktop windows into native fullscreen; on macOS that
  creates fullscreen Spaces. Skip fullscreen when in RemoteApp mode.
- `sdl_window.cpp`: on cocoa, measure displays with `SDL_GetDisplayBounds`
  instead of a fullscreen probe window (same Space side effect).

## Guest findings

- RemoteApp fails (session logged off) if the same user has a console session
  open on the VM: Windows reconnects the RDP client to the existing desktop
  session, which cannot become a RemoteApp session. Sign out of the console or
  use a dedicated account.
- `C:\Windows\System32\notepad.exe` on Windows 11 is a stub that launches the
  packaged app and exits, which ends the RemoteApp session. Use classic Win32
  programs (or launch by AppUserModelID) when testing.
- Domain GPO logon banners (legal notice) block the session until accepted;
  the client shows the desktop for it.
- `setup.ps1`'s `fAllowUnlistedRemotePrograms` was missing after setup on a
  domain-joined VM (cause unknown); `fDisabledAllowList` persisted.

## Open items

- Re-hide the desktop after a logon prompt once the app is running.
- `dinghy serve-setup`/sync should re-detect the VM when its IP changes.
- Detect same-user console sessions in `dinghy status`.
- Optional `-NoLogonBanner` setup switch, or a native banner dialog.
- Wire up `dinghy launch --native` using `sdl-freerdp` + Keychain credentials
  (pass the password over stdin, not `/p:`).

## Edge notes

- Edge shows a "Restore pages" bubble (322x140, WS_POPUP + NOREDIRECTIONBITMAP,
  owned by the Edge window) when the previous Edge was killed by a session end.
  It renders fine inside the Edge window bitmap.
- Reported once: after Edge opened, input seemed blocked as if an invisible
  dialog held focus. Not reproduced yet; `dinghy config nativeDebug on` logs
  RAIL window/activation traffic to ~/.config/windinghy/logs/<app>.log.
  Suspects: popup/owner z-order or activation sent for the wrong window id
  (sdl_rail_window.cpp), or the Enter sent by the banner auto-accept landing
  in Edge.

## Clock drift (guest)

- A Mac sleeping (including Maintenance Sleep / DarkWake cycles) pauses the VM, so the
  guest clock falls behind by the sleep time. A skew over a few minutes breaks CredSSP
  (RDP 0x1807) and the client just hangs on "connecting".
- On a domain-joined VM, Group Policy sets W32Time (`Type NTP`, `NtpServer` an internal
  address, `SpecialPollInterval 3600`, all "(Policy)"), overriding `setup.ps1`'s 60 s poll,
  and the internal NTP server is unreachable off the district network.
- Fix: push the Mac's clock in through the guest agent (`Set-Date` as SYSTEM): before each
  launch, after wake, and via `dinghy fix clock`.

## Installing Windows 11 ARM64 under QEMU/HVF (lessons)

- **Install media speed matters.** A 5 GB Windows ISO attached as USB storage reads at ~1.4 MB/s
  (emulated xHCI), which would make setup take hours. Attach it as a **virtio-scsi CD-ROM** instead
  (~10x faster; Setup was at 21% in ~100 s). The firmware boots it natively; Windows Setup then needs
  the `vioscsi` driver, which the answer file loads with `drvload` from the virtio ISO (kept on
  USB: it's small).
- The ARM64 UEFI firmware has **no AHCI/SATA driver**, so SATA CD-ROMs aren't an option.
- Don't use a `$WinPEDriver$` folder or `DriverPaths` for this: Setup's own driver-injection step
  fails (`CDlpActionDriverInstallation ... 0x80070103`, shown by Setup as
  `0x80070103 - 0x40031`). Setup's logs are in `X:\$WINDOWS.~BT\Sources\Panther\setuperr.log`;
  read them via Shift+F10 (QMP `send-key`; the Alt key's qcode is `alt`).
- Stop sending the "press any key" space bar after ~12 s, or it presses buttons in Setup's UI.
- virtio-win has ARM64 **drivers** but **no ARM64 guest-agent MSI**; install `qemu-ga-x86_64.msi`
  (runs under Windows on ARM's x64 emulation) and the drivers via `pnputil`.
