# Tested versions

Each WinDinghy release is validated against one set of components. The machine-readable source of truth is [`host/compat.json`](../host/compat.json); `dinghy about` shows what you have installed against it, and the app's General pane shows the same table.

| Component | Tested | Notes |
|---|---|---|
| WinDinghy | 0.2.0 | |
| Windows | **11 24H2, build 26100, ARM64** (validated at 26100.4349) | Retail ISO from Microsoft. Pro edition. 25H2 shares this servicing branch but has not been validated. |
| WinBoat guest agent | based on **v0.9.0** (`0.9.0-mac`) | Latest upstream seen: v0.9.2 (2026-11-20). Not merged automatically. |
| FreeRDP | 3.33.2-dev0, commit `6fd1571` | Patched SDL3 client. Includes a read-only share patch. |
| QEMU | 11.1.3 (minimum 9.0) | Homebrew. Newer versions probably work but are untested. |
| macOS | 27 (minimum 14) | |

## Installing a Windows build that isn't tested

`dinghy vm create` reads the build number from the ISO. If it is not in the tested list, the setup window says so and asks you to confirm ("Install Anyway"). From the terminal, add `--allow-untested`. It may work. Expect to debug yourself, and please report what you find.

## Why trimmed Windows images are discouraged

Images stripped down by tools like nano11 or tiny11 typically remove parts of the servicing stack, so Windows Update stops working and the VM falls behind on security fixes. They are only available through the advanced `--iso` option.

## How versions are kept current

- `host/compat.json` is updated in the same commit that validates a new Windows, QEMU or FreeRDP version. Nothing is bumped silently.
- The FreeRDP client is rebuilt from a pinned upstream commit plus `patches/`. The updater rebuilds it when those change.
- QEMU comes from Homebrew. `dinghy about` flags a version that differs from the tested one; it does not upgrade it for you.
