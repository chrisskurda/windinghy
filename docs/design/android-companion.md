# Android companion app (design draft)

Status: draft for review, Nov 2026. Nothing here is built yet. Phase 0 (spike) answers the open
questions marked **[spike]** before any real code is written.

## Goal

A companion to WinDinghy that does for Android what WinDinghy does for Windows: run an Android VM
out of sight and show each Android app as a real Mac app (its own `.app`, Dock icon and window),
plus a full **Android Desktop** in one window when wanted.

Same product rules as WinDinghy:

- **The managed VM is the supported path.** WinDinghy downloads, creates and runs it. Anything
  else is advanced mode.
- **Stock images by default.** The two supported editions are **Google Play** (retail) and
  **AOSP**. Users are free to try other system images (microG builds, LineageOS, GSIs,
  self-built), but those are advanced, unsupported, and driven by the user.
- **Separate app, shared core.** A second menu-bar app and CLI in this repo, built on code pulled
  out of `host/dinghy.mjs`. Merging both into one multi-guest app (ROADMAP "Far out: more than one
  VM, Linux and Android") stays possible later and starts from the same shared core.

### Why a separate app, and not a separate repo or the same app

- **Not a separate repo:** most of WinDinghy is plumbing both apps need (config, logs, Keychain,
  launcher generation, App Management permissions, updater, compat/about, menu-bar structure).
  Two repos would mean keeping two copies in step.
- **Not the same app (yet):** WinDinghy assumes one VM everywhere (fixed ports 13389/17148, one VM
  folder, one launcher folder, one menu). Merging needs the multi-VM refactor first. The audiences
  differ too: an Android-only user shouldn't see Windows setup, activation or domain join, and
  separate binaries mean an Android bug can't break Windows.
- **Costs of two apps, and the fixes:** two menu-bar icons (either can be hidden); two VMs competing
  for RAM (a shared resource-budget file in a common config folder, so each app warns before
  starting when the other VM is running and memory is short); updates (one `git pull`, and the
  updater rebuilds both apps).
- **Later:** with the shared core in place, merging into one app with a VM picker is mostly a
  front-end job.

Name: TBD. Keep "Android" and "Droid" out of the product name (Google and Lucasfilm trademarks).
"…for Android apps" is fine as a description.

## How the pieces map

| Piece | WinDinghy (Windows) | Android companion |
|---|---|---|
| VM engine | QEMU + Hypervisor.framework, run by us (`host/vm.mjs`) | Google's **Android Emulator**, run headless (`-no-window`): QEMU-based, uses Hypervisor.framework, arm64 images |
| Each app in its own window | Patched FreeRDP RemoteApp | **scrcpy** `--new-display=WxH/dpi --start-app=<pkg>`: one Android virtual display per app, one Mac window |
| Full desktop | Windows Desktop over RDP | A large scrcpy virtual display with Android desktop windowing on **[spike]**, or a desktop-class AVD |
| Guest agent | WinBoat guest server (:7148) | `adb` plus our own **helper APK** (`guest-android/`) for the launcher app list, icons as PNG, and change notices |
| Software | winget search | Play Store (Google Play edition); F-Droid index search with install over adb (AOSP edition); APK drag-and-drop (both) |
| Setup | Windows ISO, unattended install (20–30 min) | `sdkmanager` (user accepts Google's SDK licence) → `avdmanager create avd` → first boot (~5 min) |
| Snapshots, suspend | QMP savevm, saved state | Emulator snapshots (`adb emu avd snapshot save/load`), quickboot |
| Clipboard, audio, input | RDP channels | scrcpy (clipboard sync, audio on Android 11+, keyboard and mouse) |
| Credentials | Keychain | None needed for the VM. A Google account lives inside the guest only |

Why the Android Emulator and not plain QEMU: on macOS it is the only maintained arm64 Android that
runs on Hypervisor.framework. Cuttlefish needs Linux/KVM, and Android-x86 and Bliss are x86-only.
It also gives GPU acceleration (see below), which the Windows VM can't have.

Why scrcpy: since 3.0 it can create a virtual display per app, which is the Android version of
RemoteApp. Each app is its own scrcpy process, so each app gets its own Dock identity for free.
That is the problem WinDinghy still has with one shared RDP connection.

## Editions

| Edition | System image | Stores | Support |
|---|---|---|---|
| **Google Play** (default) | `system-images;android-<N>;google_apis_playstore;arm64-v8a` | Play Store with the user's Google account; APK install | Supported |
| **AOSP** | `system-images;android-<N>;default;arm64-v8a` | F-Droid (installed by setup); APK install | Supported |
| **Custom image** | Any arm64 image the user points at (`--image <sdk-id>` or a local image folder) | Whatever the image has | Advanced mode, unsupported |

- We never redistribute system images or Google components. `sdkmanager` downloads them on the
  user's Mac, the same way WinDinghy has the user supply Windows.
- The Play image can't be rooted or have its system partition changed. That's fine, because we
  don't need root. The AOSP image allows `adb root`, used only by `doctor` and debugging.
- **Custom images** are where microG, LineageOS emulator builds and GSIs fit. We document how to
  point the app at one and what `doctor` checks: boots, adb reachable, the helper APK installs,
  scrcpy virtual displays work. We don't build, host or patch images. Advanced users may root an
  image themselves (rootAVD and similar) to add microG; we don't automate that.
- **Switching editions** creates a new AVD. Images can't be converted in place, and app data doesn't
  carry over. The old AVD can be kept (6–10 GB) or deleted. v1 allows **one active edition at a
  time**; running two side by side is the multi-VM problem.
- `about` / `doctor` show the edition, image API level and revision, and emulator and scrcpy
  versions against a `compat.json`, the same as WinDinghy's tested versions.

## Graphics and video acceleration

Short answer (measured in the spike): **3D rendering is accelerated. Video decoding is done on the
Mac (hardware for H.264/HEVC). The cost is scrcpy's software re-encode of each window.**

| Stage | What happens | Accelerated? |
|---|---|---|
| App rendering (OpenGL ES / Vulkan) | gfxstream forwards GPU calls to the host with `-gpu host` | **Yes**, on both editions, including headless: guest reports `OpenGL ES 3.0 (4.1 Metal)` on Apple M5 |
| H.264 / HEVC playback | Guest uses `c2.goldfish.h264/hevc.decoder`; the emulator decodes on the host with VideoToolbox | **Yes**, Mac hardware |
| VP9 playback | Guest uses `c2.goldfish.vp9.decoder`; decoded on the host in software | Off-loaded to the Mac's CPU (cheaper than in the guest) |
| AV1 playback | Not tested | Probably software in the guest |
| Getting frames to the Mac window (scrcpy) | Guest encodes each virtual display; scrcpy decodes on the Mac | Guest **encode is software** (`c2.android.*` only). Mac side: Metal renderer + VideoToolbox decode, ~3% CPU |
| DRM (Widevine) | Emulators only have Widevine L3 | Netflix/Disney+ etc. will be SD-only or refuse. Not fixable |

Measured on the AOSP image, Android 17, 1080p60 test clip, CPU as % of one core (the Mac has 10):

| Clip | Emulator, video only | Emulator, video in a 1920x1080 scrcpy window | scrcpy (Mac) | Frame rate |
|---|---|---|---|---|
| idle | ~7% | | | |
| H.264 | ~58% | ~130% | ~3% | 60 fps |
| HEVC | ~59% | ~130% | ~3% | 60 fps |
| VP9 | ~58% | ~140% | ~3% | 60 fps |

Consequences and mitigations:

- UI and games are smooth. Full-screen 1080p60 video costs about 1.3 cores, roughly 0.75 of that
  for scrcpy's re-encode. Acceptable; lower for smaller windows or `--max-fps`.
- scrcpy knobs to tune: `--video-codec` (h264 vs h265), `--video-encoder` (pick whatever is fastest
  on the emulator), `--max-fps`, `--video-bit-rate`, and capping the virtual display size.
- Fallback if the encode hop is too costly **[spike]**: the emulator's own windows (native, no
  re-encode) for the Desktop, or the emulator's gRPC screen stream (raw frames over a local
  socket) with a small native viewer. Both give up scrcpy's per-app virtual displays, so they would
  be for the Desktop window only.

## Architecture

```
host/common/            pulled out of host/dinghy.mjs, used by both apps:
                        config + paths, logging, Keychain, .app launcher generation,
                        App Management permission checks, updater, compat/about
host/android/
  avd.mjs               SDK/emulator/AVD: install, create, start, stop, pause, snapshots,
                        resources (RAM, cores, disk), editions, custom images
  adb.mjs               adb wrapper: wait-for-boot, install, shell, forward, emu console
  apps.mjs              helper-APK client: launcher apps, icons, package add/remove events
  scrcpy.mjs            launch command per app and for the Desktop; window sizing, codec settings
  fdroid.mjs            F-Droid index fetch, search, download + adb install (AOSP edition)
  cli.mjs               the CLI (name TBD)
guest-android/          helper APK (Kotlin, small): ContentProvider or local socket served
                        over `adb forward`; lists LAUNCHER activities, renders adaptive icons to
                        PNG, broadcasts package changes
host/menubar-android/   SwiftUI menu-bar app + window, reusing the WinDinghy views' structure
```

- **Config and files:** `~/.config/<name>/` and a separate VM folder. AVD home set with
  `ANDROID_AVD_HOME` so nothing mixes with an existing Android Studio install. The SDK lives in our
  cache, not `~/Library/Android`, unless the user opts into an existing SDK (advanced).
- **Ports:** emulator console 5554, adb 5555, gRPC 8554 (pick a free pair at create time and store
  it). No clash with WinDinghy's 13389/17148.
- **Launchers:** `~/Applications/<Name>/*.app`, generated by the shared launcher code. Each runs a
  bundled scrcpy with the app's package, window title and icon. A sync is triggered by the
  helper APK's package events, so installing an app in Android adds its Mac app without a manual
  `sync`.
- **Bundling:** scrcpy and adb (platform-tools) are bundled or fetched and verified like the
  FreeRDP client. The emulator and images are downloaded by `sdkmanager` at setup.
- **Memory:** this Mac has 16 GB. Windows at 6 GB plus Android at 3–4 GB is workable but tight.
  Default Android to 3 GB, and reuse WinDinghy's idle stop/suspend settings.

## CLI sketch

```sh
<cli> setup [--edition play|aosp] [--image <sdk-id>]   # download, create AVD, first boot, helper APK
<cli> start | stop | pause | resume | status
<cli> sync                    # regenerate launchers
<cli> launch "<app>"          # or open the .app
<cli> desktop                 # Android Desktop window
<cli> install <file.apk>
<cli> pkg search <q> / pkg install <id>    # F-Droid (AOSP edition)
<cli> snapshot <name> / rewind <name> / snapshots
<cli> edition [play|aosp]     # switch (creates a new AVD)
<cli> doctor / fix / about
```

## Phases

**0. Spike (2–3 days).** Answer every [spike] item:
1. Headless emulator + `-gpu host` + scrcpy `--new-display` renders correctly on Apple Silicon.
2. Can a `--new-display` window be resized, or is its size fixed when created?
3. What happens to an app's tasks when its virtual display closes?
4. Desktop windowing on a scrcpy virtual display (Android 15/16 images).
5. Both the Play image and the AOSP image work with virtual displays and `--start-app`.
6. Which video codecs are host-accelerated; which encoder scrcpy gets on the emulator, and its CPU
   cost at 1080p/60.
7. F-Droid installs and updates cleanly over adb on the AOSP image.
8. RAM, boot time and disk: AOSP vs Play.

### Spike results (2026-11-27)

Setup: Apple M5, 16 GB, Android Emulator 37.3.10, scrcpy 5.0.1, system images
`android-37.0` (Android 17) `default` and `google_apis_playstore`, arm64. AVDs from the
`desktop_medium` profile, changed to 1920x1200/240, 3 GB RAM, 4 cores, `hw.gpu.mode=host`. Test
AVDs, clips and recordings live in `~/Library/Caches/windinghy-android-spike/` (delete when done).

| # | Question | Result |
|---|---|---|
| 1 | Headless + GPU + scrcpy virtual displays | **Pass.** `-no-window -gpu host` renders through Metal. Note: scrcpy 5 with `--no-window` turns video off, so tests need a real window |
| 2 | Resizable app windows | **Supported:** scrcpy 5's `-x/--flex-display` resizes the virtual display to follow the window. Confirm by hand (resizing from a script needs Accessibility) |
| 3 | Closing an app's window | The virtual display is removed and the app's task is **destroyed** (like swiping it away). `--no-vd-destroy-content` moves it to the main display instead |
| 4 | Desktop windowing on a virtual display | **Fail (unstable).** With `setprop persist.wm.debug.desktop_experience_devopts 1` and `persist.wm.debug.desktop_mode_enforce_device_restrictions false`, a scrcpy display briefly showed wallpaper, taskbar and freeform windows, but SystemUI then crash-loops (`wmshell.main`: `Can't create root task for unsupported windowingMode=5`, thousands of restarts; the emulator logs `Failed to find ColorBuffer` repeatedly). **Never set those two props.** With only the `settings` keys, it's stable but apps open full screen with no taskbar. Desktop window for v1: mirror the main display (plain `scrcpy`, the normal launcher). Revisit on a later image or a desktop-class system image |
| 5 | Play image | **Mostly pass:** per-app windows and Play Store work; desktop mode shows the taskbar but apps open full screen because `persist.wm.debug.*` can't be set on the `user` build. **Follow-up:** try the Developer options toggle in the UI |
| 6 | Video codecs and encode cost | See "Graphics and video acceleration": decode on the Mac, software encode in the guest, ~1.3 cores for 1080p60 |
| 7 | F-Droid on AOSP | **Pass.** Official APK (signer SHA-256 `43238d51…a9c9ccab`) installs over adb and loads its index. Setup should pre-grant `POST_NOTIFICATIONS` and allow `REQUEST_INSTALL_PACKAGES` |
| 8 | Boot, RAM, disk | Boot (cold, headless): AOSP 10 s, Play 11 s. Emulator RSS with 3 GB guest: AOSP ~2.5 GB, Play ~4.0 GB. Images: AOSP 1.9 GB, Play 2.6 GB; AVD data ~1 GB after first boot |

Decisions from the spike:
- Pin **Android 17 (API 37.0)** for both editions: both images exist for arm64.
- Use scrcpy for both app windows and the Android Desktop window; the emulator's own window isn't
  needed.
- Default VM RAM 3 GB, but budget ~4 GB of host memory for the Play edition.
- `--list-apps` from scrcpy is enough for a first `sync`; the helper APK is still needed for icons.

**1. Shared core.** Pull the common modules out of `host/dinghy.mjs` with no change in WinDinghy's
behaviour. Worth doing even if the Android app never ships.

**2. CLI MVP.** setup (both editions), start/stop, sync (`cmd package query-activities` first, then
the helper APK for proper icons), launch, desktop, install, snapshots, doctor.

**3. Menu-bar app.** Sections: Apps, Android Desktop, Software, Android VM (resources, power,
edition), Sharing, Snapshots, General.

**4. Integration.** Folder sharing (see limits), automatic launcher updates, idle suspend, a shared
memory warning when both VMs run, custom-image support in advanced mode.

## Known limits

- **Play Integrity fails on emulators.** Banking apps, some streaming apps and some games refuse
  to run. Not fixable and not worked around.
- **DRM video** is Widevine L3 only (see above).
- **Folder sharing** is weaker than `\\tsclient`: the emulator has no host folder share. Options are
  adb push/pull on demand, or a storage provider in the helper APK that shows Mac folders served
  over `adb forward`.
- **arm64 apps only.** Apps built only for x86 won't run (rare now).
- **USB passthrough** is out of scope.

## Open decisions

- Product and CLI name.
- Freeform windows in the Play edition's desktop (spike item 5 follow-up).

Settled by the spike: Android 17 (API 37.0) for both editions; scrcpy for the Desktop window.
