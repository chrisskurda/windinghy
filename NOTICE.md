# Notices and credits

## Not affiliated

WinDinghy is an independent, community, open-source project.

- It is **not affiliated with, endorsed by, sponsored by, or approved by Microsoft Corporation.** Windows, Microsoft, Microsoft 365, Microsoft Store, Edge, Entra, and related names are trademarks of Microsoft Corporation. WinDinghy does not include or distribute Windows. You download Windows from Microsoft and need your own valid licence.
- It is **not affiliated with, endorsed by, or approved by the WinBoat project or its author.** WinDinghy is a separate project that reuses part of WinBoat's code (see below).
- It is not affiliated with Apple, QEMU, FreeRDP, UTM, or the Fedora Project. All other names belong to their owners.

## Thank you, WinBoat

WinDinghy exists because of [WinBoat](https://github.com/TibixDev/winboat) by **TibixDev** and its contributors. WinBoat showed that Windows apps can feel like native desktop apps, and it did the hard part of building a guest agent that lists installed apps, their icons and system metrics.

- **What we use:** WinBoat's guest server (`guest_server/`), rebuilt for Windows ARM64 and shipped in `payload/server/`, plus the service-wrapper approach in `payload/setup.ps1`. The base is WinBoat **v0.9.0** (guest server version string `0.9.0-mac`).
- **Licence:** WinBoat is MIT licensed, Copyright (c) 2026 TibixDev. The full licence text is in [LICENSE.winboat](LICENSE.winboat) and applies to the parts derived from WinBoat.
- **What we replaced:** WinBoat's Linux-only parts (Docker backend, X11 FreeRDP client) became a QEMU/Hypervisor.framework VM manager and a patched macOS FreeRDP client.

If you want a polished Linux solution, please use WinBoat and star it.

## Other projects WinDinghy depends on

| Project | Used for | Licence |
|---|---|---|
| [FreeRDP](https://www.freerdp.com) | The RemoteApp client (patched SDL3 build, patches in `patches/`) | Apache-2.0 |
| [QEMU](https://www.qemu.org) | The managed Windows VM, using Apple's Hypervisor.framework | GPL-2.0 |
| [virtio-win drivers](https://github.com/virtio-win/kvm-guest-drivers-windows) (Fedora Project) | Windows storage/network/guest-agent drivers in the VM | BSD-3-Clause and others |
| [NSSM](https://nssm.cc) | Service wrapper for the guest agent | Public domain |
| [winget](https://github.com/microsoft/winget-cli) | Software installs inside Windows (Microsoft's tool, used as shipped in Windows) | MIT |

## Windows licensing

Running Windows in a VM requires a valid licence for each copy. WinDinghy installs Windows unattended with the generic Microsoft install keys, which let Setup run but do not activate Windows. Activate with your own key in the Account & Activation pane. Some Windows editions have licensing terms about virtualization and remote use: read yours.

## Network policy

Windows can be configured to show a sign-in banner or notice. WinDinghy can hide it on a machine you control. On a managed or employer network that may violate policy. Don't connect to a Windows machine over an untrusted network without an encrypted VPN.
