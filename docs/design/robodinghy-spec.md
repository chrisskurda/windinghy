# RoboDinghy implementation spec (codename)

Status: build spec, Nov 2026, branch `android-companion`. Companion to
[android-companion.md](android-companion.md) (the why); this file is the what. "RoboDinghy" is a
codename: every identity string lives in **one** place per language (`host/android/product.mjs`,
`host/menubar-android/Product.swift`) so a real name is a small change.

## Hard rules

1. **WinDinghy must not change behaviour.** Same CLI output bytes, exit codes, files written, dialog
   text, launcher bundle bytes, config handling, menu-bar UI. Refactors keep call sites and strings
   identical; WinDinghy passes today's literals into shared code.
2. **Zero-dependency Node** (built-ins only) and **plain `swiftc`** (no Xcode project, no SwiftPM),
   same as WinDinghy.
3. Never set `persist.wm.debug.desktop_experience_devopts` or
   `persist.wm.debug.desktop_mode_enforce_device_restrictions` (SystemUI crash-loop, see the spike).
4. Never touch the user's other AVDs (`pod34`, `spike-*`) or the WinDinghy VM.
5. No commits. Work stays in the working tree on branch `android-companion`.

## Identity (codename)

| Thing | Value |
|---|---|
| Display name | RoboDinghy |
| CLI | `robodinghy` (repo-root script, like `dinghy`) → `node host/android/robodinghy.mjs` |
| Config dir | `~/.config/robodinghy/` (`config.json`, `usage.json`, `logs/`, stamps) |
| Launchers | `~/Applications/RoboDinghy/*.app`, bundle ids `app.robodinghy.<slug>` |
| Menu-bar app | `~/Applications/RoboDinghy.app`, id `app.robodinghy.menubar`, executable `robodinghy-menubar` |
| VM folder | `~/Library/Application Support/RoboDinghy/` (`avd/` = `ANDROID_AVD_HOME`, `emulator.pid`, `emulator.log`, `paused`, `suspend.json`) |
| AVD name | `RoboDinghy` |
| Ports | console `5580`, adb `5581` (console+1), gRPC `8580`. Serial `emulator-5580` |
| Env override | `ROBODINGHY_PATH` (like `DINGHY_PATH`) |
| Helper APK | package `app.robodinghy.helper` |

## Layout and file ownership

```
host/common/            shared Node plumbing           (owner: core-js)
host/common/swift/      shared Swift kit               (owner: core-swift)
host/dinghy.mjs, host/dinghy-update.sh                 (owner: core-js)
host/menubar/*          WinDinghy app + its build.sh   (owner: core-swift)
host/android/*.mjs      RoboDinghy CLI + backends      (owner: android-cli)
host/android/compat.json                               (owner: android-cli)
robodinghy              repo-root entry script         (owner: android-cli)
guest-android/          helper APK source + build.sh   (owner: helper-apk)
host/menubar-android/   RoboDinghy app + build.sh      (owner: android-swift)
```

Nobody edits a file they don't own. `.gitignore` additions: whoever needs one appends a line at the
end (append-only, no rewrites).

## Shared Node core (`host/common/*.mjs`)

Only clearly generic plumbing moves; Windows logic and the power policy stay in `dinghy.mjs`
(RoboDinghy writes its own power policy mirroring it).

- `cli.mjs`: `say`, `stepSay` (`==> msg`), `progress(pct, title)` printing exactly
  `PROGRESS:<int>:<title>`, `waitFor`, `readStdinJson`, `portOpen`, `logTail`, `safeName`,
  `hasFlag(rest, f)`, `positional(rest)`.
- `macos.mjs`: `asDialog`, `asq`, `notify(title, msg)`, `showError(title, msg, logPath)`.
- `config.mjs`: `makeConfig({path, defaults, migrate?, sanitize, logPrefix})` → `{load, save}`
  reproducing `loadConfig`/`saveConfig` exactly (backup of unreadable file, notes printed with the
  given prefix). Sanitizer engine helpers (`fix`, `oneOf`, numeric-range table).
- `keychain.mjs`: `makeKeychain(service)` → `{get, set, del}` (password via `security -i` stdin).
- `permissions.mjs`: App Management probe / ensure / hint, parameterised by
  `{appsDir, configDir, preferBinary, appName}`.
- `launchers.mjs`: `makeIcns(png, out, sizes?)`, `writeAppBundle(product, {...})` with
  `extraResources` instead of `rdpContent`, the launcher-script template (WinDinghy's text
  byte-identical; subcommand and fallback lines parameterised), `staleLaunchers` regex helper,
  `sweepStale`, `bumpUsage`. **The entry script passes its own path** for the launcher's
  `node <cli>` line (not the common module's path).
- `about.mjs`: `aboutRows` helper and the `[{name, have, tested, ok, extra?}]` printer.
- `doctor.mjs`: the checks harness (`add(ok, label, advice)`, `OK`/`FAIL` lines, exit code).

`host/menubar/build.sh` must copy `host/common/*.mjs` into `Resources/common/` so the bundled
`dinghy.mjs` keeps working (`import ... from "./common/x.mjs"`).

## Shared Swift kit (`host/common/swift/`)

`UIKit.swift` (Box, Card, StatusDot, Metric, SliderRow, KV, Row, note helper), `CLIRunner.swift`
(node discovery, capture / background / streaming-progress runners parameterised by
`CLIConfig {scriptEnvVar, scriptCandidates, pathEnv}`, last-JSON-line parser, `PROGRESS:` parser),
`JSONConfigFile.swift` (read/update single keys of a config.json at an injected path),
`Updater.swift` (find repo root, install `update` launcher, run it; parameterised by app name and
env var). WinDinghy's build.sh adds `../common/swift/*.swift` to its swiftc line and its views use
the kit with today's literals.

## RoboDinghy config (`~/.config/robodinghy/config.json`)

```
edition: "play" | "aosp"           (default "play")
image: ""                          (advanced: custom SDK package id, overrides edition)
apiLevel: "37.0"
sdkRoot: ""                        (auto: $ANDROID_HOME, $ANDROID_SDK_ROOT,
                                    /opt/homebrew/share/android-commandlinetools, ~/Library/Android/sdk,
                                    else ~/Library/Application Support/RoboDinghy/sdk)
vmCpus: 4, vmRamGB: 3, vmDiskGB: 16
consolePort: 5580
displayDpi: 240, windowSize: "1280x800"
shareClipboard: "on", shareAudio: "on"
videoCodec: "h264", maxFps: 60
vmAutoStart: "on", vmStartDelaySec: 30, vmOnQuit: "save"|"shutdown"|"keep",
vmIdleAction: "off"|"pause"|"save"|"shutdown", vmIdleMinutes: 15, vmMinFreeGB: 2
advanced: "off", filter: "on", appsDir: ~/Applications/RoboDinghy
```

## CLI contract (`robodinghy <cmd>`)

Same conventions as `dinghy`: errors `Error: <msg>` on stderr + exit 1; `--json` prints one JSON
line last; `--progress` prints `PROGRESS:<pct>:<title>`; `==> step` lines; `WARN: msg` lines;
background flags `--quiet`.

| Command | Behaviour / output |
|---|---|
| `setup [--edition play\|aosp] [--image <id>] [--accept-licences] [--ram MB] [--cpus n] [--disk GB] [--progress]` | Find/install SDK pieces (cmdline-tools if no SDK, emulator, platform-tools, system image; licences need `--accept-licences`, else exit 1 with `LICENCE:` line), create the AVD (`desktop_medium` profile, then config.ini: 1920x1200/240, ram, cores, `hw.gpu.mode=host`, `PlayStore.enabled`, data partition size), first boot, post-boot setup (aosp: install F-Droid from f-droid.org after verifying signer SHA-256 `43238d512c1e5eb2d6569f4a3afbf5523418b82e0a3ed1552770abb9a9c9ccab`, grant `POST_NOTIFICATIONS`, allow `REQUEST_INSTALL_PACKAGES`; both: install helper APK if built), `sync` |
| `status [--json]` | `{exists, running, paused, booted, edition, android, api, serial, cpu, ramMB, appsOpen, adb, scrcpy, helper, avdDir}` — the Swift app polls this instead of a guest HTTP API |
| `vm start\|stop\|pause\|resume\|save\|autostart [--login]\|idle\|quit` | Power verbs with WinDinghy's semantics (autostart: delay when `--login`, resume if paused, start, wait for boot; idle/quit apply `vmIdleAction`/`vmOnQuit`; `WARN:` lines for problems) |
| `vm snapshot [name]`, `vm snapshots [--json]` → `[{name, date}]`, `vm rewind <name> [--yes]`, `vm snapshot-delete <name>` | Emulator snapshots; hide internal names (`suspend`, `default_boot`) |
| `vm destroy [--yes]`, `vm move <dir>`, `vm export <path>`, `vm import <path>` | Like WinDinghy (`.robodinghyvm` folder with manifest.json) |
| `sync` | App list from helper APK (`am instrument` export: `apps.json` + PNG icons, pulled with adb) else `scrcpy --list-apps` with a generic icon; filter system plumbing when `filter=on`; write launchers + `Android Desktop.app`; sweep stale |
| `launch <name>`, `desktop` | Open a synced launcher by name / the desktop |
| `open-app <ResourcesDir>` | Launcher target: ensure booted (start if needed), copy scrcpy into the bundle (`Contents/MacOS/scrcpy`, ad-hoc signed) for Dock identity, run it detached with `SCRCPY_SERVER_PATH` and `ADB` set: `-s <serial> --new-display=<windowSize>/<dpi> --flex-display --start-app=<pkg> --window-title=<Name>` (+`--no-audio` / `--no-clipboard-autosync` per Sharing, `--video-codec`, `--max-fps`); desktop = plain mirror of the main display. Log to `logs/<name>.log`, bump usage |
| `install <file.apk>` | `adb install -r` |
| `pkg search <q> --json`, `pkg list --json` → `[{id, name, version, available}]`, `pkg install <id>`, `pkg uninstall <id>`, `pkg upgrade [id]` | aosp: F-Droid index (`https://f-droid.org/repo/index-v2.json` or v1 jar, cached in config dir) + download + verify hash + adb install. play: search returns `[]` with a `WARN:` pointing at the Play Store; list/uninstall work via adb |
| `edition [play\|aosp] [--yes]` | Show, or switch (creates a new AVD; old one kept unless `--delete-old`) |
| `config [key value]`, `about [--json]`, `doctor`, `fix`, `permissions [--prompt] [--quiet]`, `update`, `uninstall --yes [--progress] [--purge-settings]`, `version` | Same shapes as `dinghy` |

`about --json` rows: RoboDinghy, Android Emulator, system image (edition + API + revision),
scrcpy, adb, helper APK, against `host/android/compat.json`.

## Helper APK (`guest-android/`)

Java (no Kotlin, no Gradle), built by `guest-android/build.sh` with the installed SDK: `javac
--release 17` against `platforms/android-<N>/android.jar`, `d8`, `aapt2 compile/link`, `zipalign`,
`apksigner` with a generated debug keystore (gitignored, under `guest-android/build/`). Output
`guest-android/build/robodinghy-helper.apk`. Contents: an `Instrumentation` subclass
`app.robodinghy.helper.Export`, run as `am instrument -w -e out <dir> -e size 256
app.robodinghy.helper/.Export`. It lists `MAIN`/`LAUNCHER` activities (manifest `<queries>` for
that intent), renders each icon (adaptive included) to a size×size PNG, and writes `apps.json`
`[{label, package, activity, system}]` plus `<package>.png` into
`/sdcard/Android/data/app.robodinghy.helper/files/export/` (the app's external files dir), then
finishes with a status line `RESULT=ok count=<n>`. `minSdk 30`, `targetSdk 34`.

## RoboDinghy menu-bar app (`host/menubar-android/`)

Copy-and-adapt WinDinghy's app (don't parameterise WinDinghy's views). Uses `host/common/swift/`.
`Product.swift` holds identity. Screens (sidebar groups like WinDinghy):

- **Apps**: Apps grid (search, Sync toolbar), Android Desktop (hero + open button), Software
  (aosp: F-Droid search/installed/upgrade via `pkg … --json`; play: "Open Play Store" row; both:
  "Install APK…" via NSOpenPanel).
- **Android**: Android (status card from `status --json`, metrics, health rows: emulator, adb,
  helper, scrcpy; start/stop/restart), Resources (RAM/CPU/disk sliders, window size, Power section
  as WinDinghy), Sharing (clipboard, audio), Snapshots (as WinDinghy), Storage & Backup (move,
  export/import, reset, edition switch).
- **General**: login item, menu-bar icon, updates, versions (`about --json`), advanced mode, uninstall.
- **Setup** (first run, full window): edition picker (Google Play recommended / AOSP), Google SDK
  licence notice with "I accept" (passes `--accept-licences`), RAM/CPU/disk, progress from
  `PROGRESS:` lines.
- **Menu bar**: same structure as WinDinghy's (status line, running, search, favourites from
  usage.json, all apps, Open Android Desktop, Sync, Start Android, Open RoboDinghy…, Quit). Power
  lifecycle (autostart, 30 s idle check, `vm quit` on quit) as WinDinghy.
- Icons: original `icon.svg` (a dinghy with a small antenna, green/teal, not Android's robot or any
  Google mark) and a 24×24 template `menubar-icon.svg`; `make-icon.sh` as WinDinghy's.
- `build.sh`: like WinDinghy's, into `~/Applications/RoboDinghy.app` (`APP` override), bundling
  `host/android/*.mjs`, `host/common/*.mjs` (into `Resources/common/`), `compat.json`, and the helper
  APK if built. No FreeRDP.

## Updater

`host/dinghy-update.sh` stays the single updater. Its rebuild tail becomes a small per-app table;
WinDinghy's row reproduces today's behaviour exactly; RoboDinghy's row runs only if
`~/Applications/RoboDinghy.app` or `~/.config/robodinghy` exists. Write the root `update` launcher
atomically (tmp + mv). Keep the "Already up to date" / "Updated vA -> vB" strings.
