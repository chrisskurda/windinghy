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
