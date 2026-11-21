// Managed Windows VM on QEMU + Hypervisor.framework (no UTM).
//
// Layout (default ~/Library/Application Support/WinDinghy/vm, override with config vmDir):
//   disk.qcow2  efi-vars.fd  unattend.iso  qmp.sock  qga.sock  qemu.pid  qemu.log  last.png
//
// Networking is QEMU user-mode (slirp) with host port forwards, so the VM is always at
// 127.0.0.1 (RDP :13389, guest API :17148) - there is no DHCP address to chase. Inside the
// guest the Mac is reachable at 10.0.2.2 (that is how the unattended install fetches setup.ps1).
//
// Control: QMP (lifecycle, keys, screenshots) and the QEMU guest agent (see qga.mjs).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QGA = path.join(HERE, "qga.mjs");

export const VM_NAME = "WinDinghy";
export const RDP_PORT = 13389;
export const API_PORT = 17148;

export function vmDir(cfg) {
    return cfg.vmDir || path.join(os.homedir(), "Library", "Application Support", "WinDinghy", "vm");
}

export function files(cfg) {
    const d = vmDir(cfg);
    return {
        dir: d,
        disk: path.join(d, "disk.qcow2"),
        vars: path.join(d, "efi-vars.fd"),
        unattend: path.join(d, "unattend.iso"),
        qmp: path.join(d, "qmp.sock"),
        qga: path.join(d, "qga.sock"),
        pid: path.join(d, "qemu.pid"),
        log: path.join(d, "qemu.log"),
        shot: path.join(d, "last.png"),
    };
}

export function cacheDir() {
    return path.join(os.homedir(), "Library", "Application Support", "WinDinghy", "cache");
}

// ---------- tools ----------

function brewPrefix(formula) {
    const r = spawnSync("brew", ["--prefix", formula], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
}

export function tools() {
    const q = brewPrefix("qemu");
    const have = q && fs.existsSync(path.join(q, "bin", "qemu-system-aarch64"));
    const share = have ? path.join(q, "share", "qemu") : null;
    return {
        ok: !!have && fs.existsSync(path.join(share, "edk2-aarch64-code.fd")),
        qemu: have ? path.join(q, "bin", "qemu-system-aarch64") : null,
        img: have ? path.join(q, "bin", "qemu-img") : null,
        code: share ? path.join(share, "edk2-aarch64-code.fd") : null,
        varsTemplate: share ? path.join(share, "edk2-arm-vars.fd") : null,
    };
}

// ---------- process state ----------

export function pidOf(cfg) {
    try {
        const pid = Number(fs.readFileSync(files(cfg).pid, "utf8").trim());
        process.kill(pid, 0);
        return pid;
    } catch { return null; }
}

export function isRunning(cfg) { return pidOf(cfg) !== null; }
export function exists(cfg) { return fs.existsSync(files(cfg).disk); }

// ---------- QMP (via the qga.mjs helper so callers stay synchronous) ----------

export function qmp(cfg, execute, args = {}) {
    const r = spawnSync(process.execPath, [QGA, files(cfg).qmp, "qmp", execute, JSON.stringify(args)], { encoding: "utf8", timeout: 20000 });
    if (r.status !== 0) return null;
    try { return JSON.parse(r.stdout || "{}"); } catch { return {}; }
}

export function sendKeys(cfg, qcodes) {
    return qmp(cfg, "send-key", { keys: qcodes.map(k => ({ type: "qcode", data: k })) });
}

// Type text into the guest via QMP key events (debugging aid: e.g. drive a Shift+F10 prompt in Setup).
const SHIFTED = { ":": "semicolon", "$": "4", "~": "grave_accent", "|": "backslash", "_": "minus", "+": "equal", '"': "apostrophe", "<": "comma", ">": "dot", "?": "slash", "{": "bracket_left", "}": "bracket_right", "(": "9", ")": "0", "&": "7", "*": "8", "%": "5", "#": "3", "@": "2", "!": "1" };
const PLAIN = { " ": "spc", "\\": "backslash", ".": "dot", ",": "comma", "-": "minus", "=": "equal", "/": "slash", ";": "semicolon", "'": "apostrophe", "[": "bracket_left", "]": "bracket_right", "`": "grave_accent", "\n": "ret" };
export function typeText(cfg, text) {
    for (const ch of text) {
        let keys;
        if (/[a-z0-9]/.test(ch)) keys = [ch];
        else if (/[A-Z]/.test(ch)) keys = ["shift", ch.toLowerCase()];
        else if (SHIFTED[ch]) keys = ["shift", SHIFTED[ch]];
        else if (PLAIN[ch]) keys = [PLAIN[ch]];
        else continue;
        sendKeys(cfg, keys);
        spawnSync("sleep", ["0.12"]);
    }
}

export function screenshot(cfg, file = files(cfg).shot) {
    qmp(cfg, "screendump", { filename: file, format: "png" });
    return fs.existsSync(file) ? file : null;
}

// ---------- the QEMU command line ----------

// media: { windows, unattend, virtio } -> install-time CD-ROMs (all optional at runtime)
export function qemuArgs(cfg, media = {}, { ramMB = 4096, cpus = 4 } = {}) {
    const f = files(cfg);
    const t = tools();
    const a = [
        "-name", VM_NAME,
        "-M", "virt,highmem=on",
        "-accel", "hvf",
        "-cpu", "host",
        "-smp", String(cpus),
        "-m", String(ramMB),
        "-rtc", "base=localtime",
        "-drive", `if=pflash,format=raw,unit=0,readonly=on,file=${t.code}`,
        "-drive", `if=pflash,format=raw,unit=1,file=${f.vars}`,
        "-device", "ramfb",
        "-device", "qemu-xhci",
        "-device", "usb-kbd",
        "-device", "usb-tablet",
        "-drive", `file=${f.disk},if=none,id=sys,format=qcow2,discard=unmap`,
        "-device", "nvme,drive=sys,serial=windinghy,bootindex=0",
        "-netdev", `user,id=net0,hostfwd=tcp:127.0.0.1:${RDP_PORT}-:3389,hostfwd=tcp:127.0.0.1:${API_PORT}-:7148`,
        "-device", "virtio-net-pci,netdev=net0",
        "-device", "virtio-serial-pci",
        "-chardev", `socket,path=${f.qga},server=on,wait=off,id=qga0`,
        "-device", "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0",
        "-qmp", `unix:${f.qmp},server=on,wait=off`,
        "-display", process.env.DINGHY_VM_DISPLAY === "cocoa" ? "cocoa" : "none",
        "-serial", `file:${f.log}`,
        "-pidfile", f.pid,
        "-daemonize",
    ];
    // The Windows ISO is ~5 GB and Setup reads all of it, so it must be on a fast device: emulated
    // USB storage manages only ~1.4 MB/s, while a virtio-scsi CD-ROM is fast (Setup loads its
    // vioscsi driver from the virtio ISO via DriverPaths in the answer file). The two small ISOs
    // (answer file, drivers) stay on USB, which the firmware and Windows read without drivers.
    if (media.windows) {
        a.push("-device", "virtio-scsi-pci,id=scsi0");
        a.push("-drive", `file=${media.windows},media=cdrom,if=none,id=cd_windows,readonly=on`);
        a.push("-device", "scsi-cd,drive=cd_windows,bus=scsi0.0,bootindex=1");
    }
    for (const key of ["unattend", "virtio"]) {
        if (!media[key]) continue;
        a.push("-drive", `file=${media[key]},media=cdrom,if=none,id=cd_${key},readonly=on`);
        a.push("-device", `usb-storage,drive=cd_${key}`);
    }
    return a;
}

export function start(cfg, media = {}, opts = {}) {
    const f = files(cfg);
    const t = tools();
    if (!t.ok) throw new Error("QEMU isn't installed. Run: brew install qemu");
    if (!exists(cfg)) throw new Error("There's no WinDinghy VM yet. Create it with: dinghy vm create");
    if (isRunning(cfg)) return true;
    for (const s of [f.qmp, f.qga]) fs.rmSync(s, { force: true });
    const r = spawnSync(t.qemu, qemuArgs(cfg, media, opts), { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`QEMU failed to start: ${(r.stderr || r.stdout || "").trim().slice(0, 400)}`);
    return true;
}

// Graceful shutdown through ACPI, then force.
export function stop(cfg, waitSec = 60) {
    const pid = pidOf(cfg);
    if (!pid) return true;
    qmp(cfg, "system_powerdown");
    const end = Date.now() + waitSec * 1000;
    while (Date.now() < end) {
        if (!pidOf(cfg)) return true;
        spawnSync("sleep", ["1"]);
    }
    qmp(cfg, "quit");
    spawnSync("sleep", ["1"]);
    if (pidOf(cfg)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    return !pidOf(cfg);
}

// ---------- creating the VM ----------

export function createDisk(cfg, gb) {
    const f = files(cfg);
    const t = tools();
    fs.mkdirSync(f.dir, { recursive: true });
    if (fs.existsSync(f.disk)) throw new Error(`A VM disk already exists at ${f.disk}. Remove it first with: dinghy vm destroy`);
    const r = spawnSync(t.img, ["create", "-f", "qcow2", f.disk, `${gb}G`], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`qemu-img failed: ${r.stderr}`);
    fs.copyFileSync(t.varsTemplate, f.vars);
}

export function destroy(cfg) {
    stop(cfg, 20);
    fs.rmSync(vmDir(cfg), { recursive: true, force: true });
}

// ---------- reading the Windows ISO ----------

// List the editions in a Windows ISO's install.wim by reading the WIM's XML metadata directly
// (no wimlib needed): [{ index, name, edition }]. Returns [] if it can't be read.
export function isoEditions(isoPath) {
    const att = spawnSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-plist", isoPath], { encoding: "utf8" });
    if (att.status !== 0) return [];
    const mount = (att.stdout.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/) ?? [])[1];
    try {
        if (!mount) return [];
        const wim = ["install.wim", "install.swm"].map(n => path.join(mount, "sources", n)).find(p => fs.existsSync(p));
        if (!wim) return [];
        const fd = fs.openSync(wim, "r");
        try {
            const hdr = Buffer.alloc(0x60);
            fs.readSync(fd, hdr, 0, hdr.length, 0);
            if (hdr.toString("latin1", 0, 5) !== "MSWIM") return [];
            // XML data resource descriptor at 0x48: size (7 bytes) + flags, offset (8), original size (8)
            const size = Number(hdr.readUIntLE(0x48, 6));
            const offset = Number(hdr.readBigUInt64LE(0x50));
            if (!size || size > 8e6) return [];
            const xmlBuf = Buffer.alloc(size);
            fs.readSync(fd, xmlBuf, 0, size, offset);
            const xmlText = xmlBuf.toString("utf16le");
            const out = [];
            for (const m of xmlText.matchAll(/<IMAGE INDEX="(\d+)">([\s\S]*?)<\/IMAGE>/g)) {
                const name = (m[2].match(/<NAME>([^<]*)<\/NAME>/) ?? [])[1] ?? "";
                const edition = (m[2].match(/<EDITIONID>([^<]*)<\/EDITIONID>/) ?? [])[1] ?? "";
                out.push({ index: Number(m[1]), name, edition });
            }
            return out;
        } finally { fs.closeSync(fd); }
    } catch { return []; }
    finally { spawnSync("hdiutil", ["detach", mount ?? "", "-quiet"]); }
}

// Prefer an Enterprise/IoT edition (what WinDinghy targets), then Pro, then the first image.
export function chooseEdition(editions) {
    const pick = re => editions.find(e => re.test(`${e.edition} ${e.name}`));
    return pick(/IoTEnterprise|Enterprise/i) ?? pick(/Professional|Pro\b/i) ?? editions[0] ?? { index: 1, name: "(unknown)", edition: "" };
}

// Microsoft's published generic installation keys. They only get retail media past Setup's
// "Product key" page; they do not activate Windows. Enterprise/IoT/volume media need none.
const GENERIC_KEYS = {
    Core: "YTMG3-N6DKC-DKB77-7M9GH-8HVX7",
    CoreSingleLanguage: "BT79Q-G7N6G-PGBYW-4YWX6-6F4BT",
    Professional: "VK7JG-NPHTM-C97JM-9MPGT-3V66T",
};
export function genericKey(edition) { return GENERIC_KEYS[edition?.edition] ?? null; }

// IANA zone -> Windows zone id for the unattended install (UTC if unknown).
const WIN_TZ = {
    "America/New_York": "Eastern Standard Time", "America/Detroit": "Eastern Standard Time", "America/Chicago": "Central Standard Time",
    "America/Denver": "Mountain Standard Time", "America/Phoenix": "US Mountain Standard Time", "America/Los_Angeles": "Pacific Standard Time",
    "America/Anchorage": "Alaskan Standard Time", "Pacific/Honolulu": "Hawaiian Standard Time", "Europe/London": "GMT Standard Time",
    "Europe/Berlin": "W. Europe Standard Time", "Europe/Paris": "Romance Standard Time", "Asia/Tokyo": "Tokyo Standard Time",
    "Australia/Sydney": "AUS Eastern Standard Time", "UTC": "UTC",
};

function xml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// autounattend.xml for Windows 11 IoT Enterprise LTSC (arm64): GPT/UEFI layout, local admin account,
// autologon once, and a FirstLogon script that installs the virtio drivers + guest agent and
// then runs WinDinghy's setup.ps1 from the Mac.
export function unattendXml({ user, password, imageIndex = 1, productKey = null }) {
    const tz = WIN_TZ[Intl.DateTimeFormat().resolvedOptions().timeZone] ?? "UTC";
    const c = (name, pass, body) => `    <component name="${name}" processorArchitecture="arm64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${body}\n    </component>`;
    // Setup can't see the install CD until the virtio-scsi driver is loaded.
    const drvload = `        <RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>cmd /c for %d in (D E F G H I J) do @if exist %d:\\vioscsi\\w11\\ARM64\\vioscsi.inf drvload %d:\\vioscsi\\w11\\ARM64\\vioscsi.inf</Path></RunSynchronousCommand>`;
    const lab = drvload + "\n" + ["BypassTPMCheck", "BypassSecureBootCheck", "BypassRAMCheck", "BypassCPUCheck", "BypassStorageCheck"]
        .map((k, i) => `        <RunSynchronousCommand wcm:action="add"><Order>${i + 2}</Order><Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v ${k} /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>`).join("\n");
    const part = (n, type, size, extend) =>
        `            <CreatePartition wcm:action="add"><Order>${n}</Order><Type>${type}</Type>${extend ? "<Extend>true</Extend>" : `<Size>${size}</Size>`}</CreatePartition>`;
    const first = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-PSDrive -PSProvider FileSystem | ForEach-Object { $p = Join-Path $_.Root 'firstlogon.ps1'; if (Test-Path $p) { & $p; break } }"`;
    return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
${c("Microsoft-Windows-International-Core-WinPE", "windowsPE", `      <SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>
      <InputLocale>en-US</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale>`)}
${c("Microsoft-Windows-Setup", "windowsPE", `      <RunSynchronous>
${lab}
      </RunSynchronous>
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
${part(1, "EFI", 100)}
${part(2, "MSR", 16)}
${part(3, "Primary", 0, true)}
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall><OSImage>
        <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
        <InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>${imageIndex}</Value></MetaData></InstallFrom>
      </OSImage></ImageInstall>
      <UserData><AcceptEula>true</AcceptEula>${productKey ? `<ProductKey><Key>${xml(productKey)}</Key><WillShowUI>OnError</WillShowUI></ProductKey>` : ""}</UserData>`)}
  </settings>
  <settings pass="specialize">
${c("Microsoft-Windows-Shell-Setup", "specialize", `      <ComputerName>DINGHY-WIN</ComputerName>
      <TimeZone>${xml(tz)}</TimeZone>`)}
  </settings>
  <settings pass="oobeSystem">
${c("Microsoft-Windows-Shell-Setup", "oobeSystem", `      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipMachineOOBE>true</SkipMachineOOBE>
        <SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
      <UserAccounts>
        <AdministratorPassword><Value>${xml(password)}</Value><PlainText>true</PlainText></AdministratorPassword>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled><LogonCount>5</LogonCount><Username>Administrator</Username>
        <Password><Value>${xml(password)}</Value><PlainText>true</PlainText></Password>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add"><Order>1</Order><CommandLine>${xml(first)}</CommandLine><Description>WinDinghy first logon</Description></SynchronousCommand>
      </FirstLogonCommands>`)}
  </settings>
</unattend>
`;
}

// Runs once at first logon, from the answer-file CD. Installs drivers + guest agent, waits for the
// Mac (10.0.2.2), then runs setup.ps1 (RDP, RemoteApp, guest server).
export function firstLogonScript(setupPort, user, password) {
    return `$ErrorActionPreference = 'Continue'
Start-Transcript -Path C:\\Windows\\Temp\\dinghy-firstlogon.log -Force | Out-Null
# The virtio ISO: drivers (ARM64) and the guest agent. There is no ARM64 agent MSI; the x64 one runs
# under Windows on ARM's emulation (it only talks to the ARM64 vioserial driver).
$root = Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Root } | Where-Object { Test-Path (Join-Path $_ 'guest-agent\\qemu-ga-x86_64.msi') } | Select-Object -First 1
if ($root) {
    foreach ($d in 'NetKVM','vioserial','viostor','vioscsi','Balloon') {
        Get-ChildItem (Join-Path $root "$d\\w11\\ARM64") -Filter *.inf -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Host "driver $($_.FullName)"; pnputil /add-driver $_.FullName /install | Out-Host }
    }
    Write-Host "installing the guest agent"
    Start-Process msiexec.exe -ArgumentList '/i', (Join-Path $root 'guest-agent\\qemu-ga-x86_64.msi'), '/qn', '/norestart' -Wait
    Start-Service QEMU-GA -ErrorAction SilentlyContinue
} else { Write-Host "virtio ISO not found" }
# The account WinDinghy uses for RDP (this first logon runs as the built-in Administrator).
$p = ConvertTo-SecureString '${password.replace(/'/g, "''")}' -AsPlainText -Force
if (Get-LocalUser -Name '${user}' -ErrorAction SilentlyContinue) { Set-LocalUser -Name '${user}' -Password $p } else { New-LocalUser -Name '${user}' -Password $p -PasswordNeverExpires -AccountNeverExpires -FullName 'WinDinghy apps' | Out-Null }
# Qualify the member with the computer name: a bare name that equals the computer name resolves to the computer, not the user.
$member = "$env:COMPUTERNAME\\${user}"
foreach ($g in 'Administrators','Remote Desktop Users') { net localgroup $g $member /add | Out-Host }
for ($i = 0; $i -lt 120; $i++) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('10.0.2.2', ${setupPort}); $c.Close(); break } catch { Start-Sleep 5 }
}
$ok = $false
try { Invoke-RestMethod -Uri http://10.0.2.2:${setupPort}/setup.ps1 -UseBasicParsing | Invoke-Expression; $ok = $true } catch { Write-Host "setup failed: $_" }
if ($ok) {
    # Done: stop auto-logging in as the built-in Administrator and disable it.
    Set-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' AutoAdminLogon 0 -ErrorAction SilentlyContinue
    Disable-LocalUser -Name 'Administrator' -ErrorAction SilentlyContinue
}
Stop-Transcript | Out-Null
`;
}

// Windows Setup automatically loads drivers from a "$WinPEDriver$" folder at the root of any media it
// can read. Copy the few storage/network drivers it needs from the virtio ISO into one.
function stageWinPEDrivers(virtioIso, dest) {
    const att = spawnSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-plist", virtioIso], { encoding: "utf8" });
    const mount = (att.stdout.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/) ?? [])[1];
    if (!mount) throw new Error("Couldn't mount the virtio driver ISO.");
    try {
        for (const d of ["vioscsi", "viostor", "NetKVM", "vioserial"]) {
            const src = path.join(mount, d, "w11", "ARM64");
            if (!fs.existsSync(src)) continue;
            fs.cpSync(src, path.join(dest, d), { recursive: true });
        }
    } finally { spawnSync("hdiutil", ["detach", mount, "-quiet"]); }
}

// Build the answer-file CD (autounattend.xml + firstlogon.ps1) with macOS's hdiutil.
export function buildUnattendIso(cfg, { user, password, setupPort, imageIndex = 1, virtioIso = null, productKey = null }) {
    const f = files(cfg);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dinghy-unattend-"));
    // (No $WinPEDriver$ folder: Setup's own driver injection of those packages fails with 0x80070103;
    //  the explicit drvload in autounattend.xml is enough to expose the install CD.)
    fs.writeFileSync(path.join(stage, "autounattend.xml"), unattendXml({ user, password, imageIndex, productKey }));
    fs.writeFileSync(path.join(stage, "firstlogon.ps1"), firstLogonScript(setupPort, user, password));
    fs.rmSync(f.unattend, { force: true });
    const r = spawnSync("hdiutil", ["makehybrid", "-iso", "-joliet", "-default-volume-name", "UNATTEND", "-o", f.unattend, stage], { encoding: "utf8" });
    fs.rmSync(stage, { recursive: true, force: true });
    if (r.status !== 0 || !fs.existsSync(f.unattend)) throw new Error(`Couldn't build the answer-file ISO: ${r.stderr}`);
    return f.unattend;
}
