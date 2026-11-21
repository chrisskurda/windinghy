# Versioning and releasing

WinDinghy uses [Semantic Versioning](https://semver.org). Before 1.0, a minor bump (0.x.0) may include breaking changes; patch releases (0.x.y) are fixes only. The changelog follows [Keep a Changelog](https://keepachangelog.com).

Each release is validated against one set of components, recorded in [`host/compat.json`](../host/compat.json): the Windows build, the WinBoat base version, the FreeRDP commit and QEMU version.

## Day to day

Add a line under `## [Unreleased]` in CHANGELOG.md in the same commit as the change (Added, Changed, Fixed, Removed, Security). Write for users: what they can now do or what stopped breaking.

## Cutting a release

1. Validate on a clean install: `dinghy vm create`, launch an app, snapshot and rewind, `dinghy pkg install`, folder sharing.
2. Update `host/compat.json` for anything that changed (Windows build and validation date, WinBoat base, FreeRDP commit, QEMU). Update `docs/COMPATIBILITY.md` to match.
3. Set `VERSION` in `host/dinghy.mjs` and `"windinghy"` in `host/compat.json` to the new number.
4. In CHANGELOG.md, rename `[Unreleased]` to `[x.y.z] - YYYY-MM-DD`, add an empty `[Unreleased]` above it, and update the compare links at the bottom.
5. Commit ("Release x.y.z"), then tag and push:

   ```sh
   git tag -a vX.Y.Z -m "WinDinghy X.Y.Z"
   git push origin main vX.Y.Z
   ```

6. On GitHub, create a release from the tag and paste that version's changelog section.

`dinghy about` flags an install that differs from `compat.json`, so a mismatch is visible to users.
