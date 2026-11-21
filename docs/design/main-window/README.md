# Handoff: WinDinghy main window (SwiftUI / AppKit)

## Overview
A native macOS window for WinDinghy (Windows apps from a local Windows 11 ARM VM, shown as Mac apps via RDP RemoteApp). It adds a main window to the existing menu-bar app (`host/menubar/main.swift`): app library, VM status, resources, sharing, snapshots, first-run setup. The menu-bar dropdown mirrors the existing NSMenu and is not redesigned.

## About the Design Files
`WinDinghy.dc.html` is a **design reference in HTML**, a prototype of the intended look and behavior. It is not production code. Recreate it in SwiftUI (macOS 13+, with AppKit where noted) using system controls and the existing `dinghy` CLI / guest API. Do not ship the HTML. The window and sidebar use native materials, so match system look rather than the literal hex values where the system provides them.

## Fidelity
High fidelity for layout, hierarchy, copy and states. Colors and type should map to system equivalents (listed below) so Light/Dark and accent color follow macOS.

## Window
- `Window` 1060x700 default, min 900x600. Sidebar + detail: use `NavigationSplitView`, sidebar width 210 (min 190, max 260), `.listStyle(.sidebar)`. Hidden title bar content, toolbar item for the detail title and screen-specific controls (search field, Sync button on Apps).
- Sidebar items (SF Symbols): Apps `square.grid.2x2`, Windows `macwindow`, Resources `cpu`, Sharing `arrow.left.arrow.right`, Snapshots `clock.arrow.circlepath`.
- Sidebar footer: status card (8pt dot green/gray, "Windows is running" / "Windows is off", subline "CPU 14% · RAM 3.1 GB · N apps open" or "Starts when you open an app"). Card: `.quaternary` fill, radius 8, padding 10, 12pt text.
- Appearance follows system (the prototype's Light/Dark toggle is a preview aid only).

## Screens

### Apps
- Toolbar: `.searchable` field "Search apps", button "Sync Apps Now" (label "Syncing…" for ~1.4 s while `dinghy sync` runs).
- Subtitle: "{n} Windows apps" (secondary).
- `LazyVGrid(columns: adaptive(min: 112))`, spacing 16. Cell: padding 14/6/10, radius 10, vertical stack spacing 8: app icon 52x52 radius 12 (use the real icon from the generated `.app`; prototype shows a colored letter placeholder), name 13 medium centered, status 11 secondary ("Open" if running, else empty). Running cells have `.quaternary` background; hover shows the same fill.
- Click: launch app (`dinghy open-rdp` / open the `.app`), starts VM if offline.
- Footer note (12pt secondary, top divider): "Each app is a real .app in ~/Applications/WinDinghy, available from Spotlight and Finder. Opening one starts the VM if needed."

### Windows (machine status)
- Header card (`.quaternary`, radius 10, padding 18): app icon 48, "Windows 11 Pro" 16 semibold, "ARM64 · {status}", right-aligned prominent button "Start Windows" / "Stop Windows".
- Three metric cards (equal columns, gap 14, padding 16, radius 10): label 12 secondary, value 22 semibold, `ProgressView(value:)` linear 6pt. CPU "14%", Memory "3.1 of 8 GB", Disk "21 of 64 GB". Source: guest API `:7148` metrics.
- Health list card: rows "Guest agent :7148", "Remote display (RDP) :3389", "Windows App client installed", "Network Shared · 192.168.64.2", each with trailing 8pt status dot (green ok, gray offline); detail in monospaced 12 secondary.
- Row card: "Show Windows desktop" / "Opens a full desktop session. Apps normally run without it." with bordered button "Open Desktop" (= `dinghy desktop`).

### Resources
- `Form` style `.grouped`, max width 620. Three rows with `Slider`: Processor cores 2-8 step 1 ("4 cores", note "Of 10 on this Mac."), Memory 4-16 GB step 1 (note "4 GB is the minimum. Office apps may feel slow." when < 6, else "Of 24 GB on this Mac."), Disk size 40-256 GB step 8 (note "Disks can grow later, not shrink."). Show host totals from `ProcessInfo`.
- Caption: "Resource changes apply the next time the Windows machine starts."
- `DisclosureGroup("Advanced")` collapsed by default: Virtual machine name (Windows), Remote display port (127.0.0.1:13389), Guest API port (127.0.0.1:17148), Display scaling (Auto), Hide app launch filter (On). Values monospaced; editable in production (`dinghy config`).

### Sharing
- Toggles (`Toggle` `.switch`): Clipboard (Copy and paste between Mac and Windows apps.), Home folder (Windows apps can open files from your Mac.), Printers (Use Mac printers from Windows apps.), Audio (Play sound from Windows apps.). Defaults: on, on, off, on.
- "Shared folders" (600 weight): table rows Mac path to Windows path + mode: ~/Documents → Z:\Docs Read & Write; ~/Downloads → Z:\Down Read & Write; ~/Desktop → Z:\Desk Read only. Paths monospaced 12. "+ Add Folder…" opens `NSOpenPanel` (directories).

### Snapshots
- Intro: "Rewind Windows to an earlier state. Your Mac files are not affected." Prominent button "Take Snapshot".
- List rows: name 13 medium, meta 12 secondary ("Nov 18 · 9.1 GB"), trailing bordered button "Rewind" (confirm with an alert; shows "Restored" after). Backend: qcow2 snapshots (see docs/ROADMAP.md).

### First-run setup (full-window overlay, shown while no VM exists)
Centered column, width 500, gap 18, text centered, app icon 120 above.
1. Welcome: "Windows apps on your Mac" (26 bold); "WinDinghy sets up Windows in the background. Your Windows apps appear in the Dock, Spotlight and Finder like any other Mac app." (15 secondary); prominent button "Set Up Windows" (15 semibold, h-padding 28); link-style "Customize…"; caption "Downloads about 5 GB. Needs 64 GB free disk space."
2. Customize: grouped list rows: Windows installer (ISO) / Download automatically; Edition / Windows 11 Pro ARM64; Cores · Memory · Disk / 4 · 8 GB · 64 GB; VM location / Application Support. Buttons Back, Install.
3. Install: title by phase ("Downloading Windows…" 0-30%, "Installing Windows…" 30-85%, "Adding your apps…" 85-100%), linear progress 8pt, caption "{pct}% · about 6 minutes in total. You can keep using your Mac."
4. Done: "Windows is ready", "6 apps were added to ~/Applications/WinDinghy.", prominent "Show My Apps", caption "The first launch asks for your Windows password once. It is saved to Keychain."
Wire to the existing unattended installer (`dinghy vm`).

### Menu bar dropdown (reference only; matches current NSMenu)
Status lines (disabled), search field, optional Running section (app name + Quit), Favorites, All Apps ›, divider, Open Windows Desktop ⌘D, Sync Apps Now ⌘S, Restart Windows VM, divider, Windows Username…, Ask for Password on Launch ✓, Setup Check…, Set Up Windows VM…, Fix Problems…, Check for Updates…, Windows VM ›, Menu Bar Icon ›, Advanced Mode, Start at Login ✓, Open Apps Folder, Quit WinDinghy ⌘Q. Add "Open WinDinghy…" to open this window. Status item shows a dot (green online) and a running-app count.

## State
- `selectedScreen`: apps | machine | resources | sharing | snapshots
- `vmState`: on / off (poll guest API `:7148` health every ~2 s)
- `runningApps: Set<String>` (from the RemoteApp window list used by the menu bar)
- `apps: [App]` (from `~/Applications/WinDinghy` / `dinghy sync`), `query`
- `resources: cores, ramGB, diskGB` (persist via `dinghy config`, apply on next VM start)
- `sharing: clipboard, home, printers, audio` + `folders`
- `snapshots: [Snapshot]`
- `setupPhase`: welcome | customize | installing(pct) | done | nil
- `syncing: Bool`
Share one `@Observable` store between the menu bar and window.

## Interactions
- Toggle/slider changes persist immediately. Snapshot/sync/start/stop are async with a disabled-control busy state.
- Toggle switch knob animates 0.15 s ease. Hover fills use `.quaternary`.
- Menu bar dot and count update live.
- Stopping the VM clears running apps.

## Design Tokens (map to system where possible)
- Accent: system accent; brand blue #0F6BE0 (icon gradient #4FB4FF → #0F6BE0 → #04235F; sail white, hull accent #FFB648).
- Status: green #28C840 (`.green`), gray `.secondary`.
- Light: window #FFFFFF (`windowBackgroundColor`), sidebar #EEEEF2 (sidebar material), card #F3F3F6 (`.quaternary`), divider rgba(0,0,0,.1) (`separatorColor`), text #1D1D1F, secondary #6E6E73.
- Dark: window #1E1E20, sidebar #2C2C2E, card rgba(255,255,255,.07), divider rgba(255,255,255,.12), text #F2F2F4, secondary #9A9AA2.
- Type: SF Pro. 26 bold (setup title), 22 bold/semibold, 16 semibold, 15 semibold/secondary, 13 regular/medium (body), 12 (notes), 11 (caption). Monospaced: SF Mono 12.
- Radii: window 12, cards 10, sidebar items 7, buttons 6-8, app icons 12, toggles 11.
- Spacing: 4, 6, 8, 10, 12, 14, 16, 18, 24. Content padding 24. Toolbar height 52.
- Shadows: window system default; setup icon `0 8 24 rgba(15,107,224,.4)`.

## Assets
- `assets/icon.svg`: app icon from the repo (`host/menubar/icon.svg`), for the setup screen and Windows header. Render at 1024 for the app icon; the white-hull-over-sea artwork already contains the macOS tile.
- App icons in the grid are colored letter placeholders; use the real icons from the synced `.app` bundles.

## Files
- `WinDinghy.dc.html`: the interactive prototype (open in a browser; Tweaks toggle Dark).
- `assets/icon.svg`
- `github.md`: source repo reference (chrisskurda/windinghy).
