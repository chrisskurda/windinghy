# WinDinghy user guide

## First run

1. Build and open the app (see the README). Choose **Set Up Windows**.
2. **Customize…** lets you pick the Windows installer, the Windows account name (defaults to your macOS username), and cores, memory and disk size.
3. If no installer is in Downloads, WinDinghy opens Microsoft's page. Download the **Windows 11 ARM64** ISO and it continues on its own.
4. If the installer is a Windows version WinDinghy hasn't been tested with, you get a warning and a choice: **Choose Another…** or **Install Anyway**.
5. When it finishes, your apps are in `~/Applications/WinDinghy`. The first launch asks for the Windows password once; it is saved in your Keychain.

macOS asks for **App Management** permission so WinDinghy can update its app launchers. Turn it on in System Settings > Privacy & Security > App Management.

## Apps, tools and the desktop

- **Apps** lists your Windows programs. Click one to open it; it appears as its own window and in the Dock.
- **Windows Tools** has Control Panel, Device Manager, Event Viewer, PowerShell and similar. They are kept out of Apps.
- **Windows Desktop** opens the whole Windows desktop. Use it for anything that isn't a single app. It can be made full screen.
- After installing something inside Windows, press **Sync Apps Now** (or `dinghy sync`).

## Installing software

**Software** searches the winget catalog and installs for all users. It works without a Microsoft account. Installed software can be updated or removed there. The Microsoft Store also works from the Windows Desktop if you sign in.

## Files

- Your Mac home folder is `\\tsclient\Home` in Windows.
- Windows' Documents, Downloads, Desktop, Pictures, Music and Videos are your Mac's folders. Turn each off in **Sharing**, then press **Apply Now**: Windows apps close and reopen with the new locations.
- Mark any share **Read-only** to stop Windows changing it. The next app you open uses the new setting.
- macOS may ask permission the first time an app reaches Documents, Downloads or Desktop.

## Account, activation, work

- **Account & Activation** shows whether Windows is activated and takes a product key. The Microsoft account buttons open the matching Windows Settings page in a window. A Microsoft account is optional.
- **Work & School** joins a domain (it must be reachable from the VM, which usually means the office network or a VPN on the Mac) or opens the work/school account settings. Windows restarts to finish a join. Domain policy can change Windows' clock, banner and firewall.

## Snapshots and backups

- **Snapshots** are restore points inside the VM's disk: take one before a risky change, rewind if it goes wrong. Rewinding discards everything since.
- **Storage & Backup** moves the VM to another folder or drive, **exports** a full copy (snapshots included) and **imports** one. Use export as a backup, or to move to another Mac. The Windows password isn't included: run `dinghy login` after an import.

## Reset, reinstall, uninstall

In **Storage & Backup > Reset & uninstall**:

- **Rewind to clean install** goes back to the restore point taken right after setup.
- **Reinstall Windows** deletes the VM and installs a fresh one with the same account name and resources. It can save a safety export to the Desktop first. Takes 20 to 30 minutes.
- **Remove Windows** deletes the VM, snapshots, saved password and app launchers (optionally cached downloads and WinDinghy's settings). Exported backups, the Windows installer you downloaded and your Mac files are never touched. Terminal: `dinghy uninstall`.

## Resources

Cores, memory and disk size apply the next time the VM starts. The disk can grow, not shrink.

## When something is wrong

- `dinghy doctor` (or General > Setup Check) lists what's healthy.
- `dinghy fix` repairs clock drift, a stale saved password, permissions and the VM address. `dinghy fix login` re-saves the password.
- **Clock wrong after the Mac sleeps:** fixed automatically on wake; `dinghy fix clock` does it by hand.
- **Updates:** General > Check for Updates. A result window always appears. If your checkout has local changes the update stops and says so.

## Versions and credits

`dinghy about` (and General) compare what's installed with the tested versions in `host/compat.json`. WinDinghy is not affiliated with Microsoft or WinBoat; see [NOTICE.md](../NOTICE.md).
