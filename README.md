# WinDinghy

Run Windows apps on your Mac as if they were Mac apps. Every Windows app gets a real `.app` in `~/Applications/WinDinghy`, available from Spotlight, the Dock and Finder, and opens in its own window.

WinDinghy runs a lean Windows 11 (ARM64) virtual machine in the background (QEMU with Apple's Hypervisor.framework) and shows each program through RDP RemoteApp with a patched FreeRDP client. You never see the VM unless you want to.

> **Independent project.** Not affiliated with, endorsed by, or approved by Microsoft or by WinBoat. You need your own Windows licence. Built on [WinBoat](https://github.com/TibixDev/winboat)'s guest agent: thank you, TibixDev. See [NOTICE.md](NOTICE.md).

## Quick start

Needs an Apple Silicon Mac, Homebrew, Node.js, and about 64 GB of free disk space.

```sh
git clone https://github.com/chrisskurda/windinghy.git ~/windinghy
cd ~/windinghy && host/menubar/build.sh     # builds ~/Applications/WinDinghy.app
open ~/Applications/WinDinghy.app
```

Open WinDinghy from the menu bar, then choose **Set Up Windows**. It downloads the helpers, finds (or opens Microsoft's page for) the Windows ARM64 installer, installs Windows unattended, and syncs your apps. First run takes roughly 20-30 minutes. Everything is also available from the terminal: `dinghy vm create`.

The tested Windows version is **Windows 11 24H2 (build 26100) ARM64**. Other versions ask for confirmation first. See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## The WinDinghy window

| Section | What it does |
|---|---|
| **Apps** | Your Windows apps, plus the Windows Desktop. |
| **Windows Desktop** | The full Windows desktop in its own window (can go full screen). |
| **Windows Tools** | Control Panel, Device Manager, Event Viewer and other admin tools, kept apart from your apps. |
| **Software** | Search and install software with winget. No Microsoft account or Store sign-in needed. |
| **Account & Activation** | Check activation, enter a product key, open Microsoft account settings. |
| **Work & School** | Join a domain, work or school account, refresh Group Policy. |
| **Windows / Resources / Sharing / Snapshots / Storage & Backup** | Start, stop, restart; cores, memory, disk; clipboard, printers, audio, folders; restore points; move, export and import the VM. |
| **General** | Menu-bar icon, login, updates, versions, credits. |

## Sharing between Mac and Windows

- Your **home folder** is shared by default (`\\tsclient\Home`).
- **USB devices** can be handed to Windows in Sharing (dongles, hardware with Windows-only software). Keyboards, mice and other input devices stay with the Mac. USB drives aren't supported as USB devices: share the drive's folder instead.
- **Documents, Downloads, Desktop, Pictures, Music and Videos** in Windows are your Mac's folders by default. Switch any of them off in Sharing.
- Any share can be marked **Read-only**: Windows can look but not change. Enforced in the RDP client.
- Clipboard, audio and printers are shared and can be turned off.

## Everyday commands

```sh
dinghy sync                       # rescan apps after installing something in Windows
dinghy launch "Excel"             # or open the .app from Spotlight
dinghy pkg search firefox         # find software; then: dinghy pkg install Mozilla.Firefox
dinghy vm snapshot before-office  # restore point; dinghy vm rewind before-office
dinghy vm export ~/Backups/win.windinghyvm   # full image backup; dinghy vm import <bundle>
dinghy folders status             # which Mac folders Windows uses
dinghy about                      # versions vs tested versions
dinghy fix                        # repair common problems
```

More in [docs/GUIDE.md](docs/GUIDE.md).

## Updating

General > **Check for Updates…**, or `dinghy update`. It fast-forwards the git checkout, rebuilds the RDP client if its patches changed, rebuilds the menu-bar app and relaunches it. It never touches a checkout with local changes or diverged commits; it shows you what to resolve. The updater logic is `host/dinghy-update.sh`, run through a gitignored copy at the repo root so a bad update can't break the thing that fixes it.

## Advanced mode

By default WinDinghy only supports its own managed VM. **Advanced mode** (General) unlocks UTM or another hypervisor, a Windows machine elsewhere on the network, and custom RDP clients. These aren't covered by the tested versions. Don't use a remote machine without an encrypted VPN.

## Not possible yet

- **Windows Desktop inside the main window.** It opens in its own window. Embedding needs an in-process RDP view.
- **USB drives as USB devices.** Formatting or flashing a drive from Windows isn't possible: macOS won't release the drive (taking it needs root and Full Disk Access). Share its folder instead.
- **3D acceleration.** Windows on QEMU/HVF has no GPU driver, so graphics are software-rendered.

## Layout

```
dinghy               CLI entry point
host/dinghy.mjs      the host-side tool (zero-dependency Node)
host/vm.mjs          QEMU VM management, unattended install, snapshots
host/guest.mjs       talks to the guest (QEMU agent, or UTM in advanced mode)
host/compat.json     the tested versions
host/menubar/        the SwiftUI window and menu-bar app
host/dinghy-update.sh  updater logic
payload/             installed in the VM: setup.ps1 and WinBoat's guest server
patches/ scripts/    the patched FreeRDP client and how to build it
docs/                guide, compatibility, roadmap, design notes
```

## Troubleshooting

`dinghy doctor` checks the setup; `dinghy fix` repairs the usual problems (clock drift, saved login, permissions, VM address). Logs are in `~/.config/windinghy/logs/`.

## Licence

MIT. Parts derived from WinBoat are Copyright (c) 2026 TibixDev, MIT: see [LICENSE.winboat](LICENSE.winboat) and [NOTICE.md](NOTICE.md).
