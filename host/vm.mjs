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
    let boot = 1;
    for (const key of ["windows", "unattend", "virtio"]) {
        if (!media[key]) continue;
        const id = `cd_${key}`;
        a.push("-drive", `file=${media[key]},media=cdrom,if=none,id=${id},readonly=on`);
        a.push("-device", `usb-storage,drive=${id}${key === "windows" ? `,bootindex=${boot++}` : ""}`);
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
export function unattendXml({ user, password }) {
    const tz = WIN_TZ[Intl.DateTimeFormat().resolvedOptions().timeZone] ?? "UTC";
    const c = (name, pass, body) => `    <component name="${name}" processorArchitecture="arm64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${body}\n    </component>`;
    const lab = ["BypassTPMCheck", "BypassSecureBootCheck", "BypassRAMCheck", "BypassCPUCheck", "BypassStorageCheck"]
        .map((k, i) => `        <RunSynchronousCommand wcm:action="add"><Order>${i + 1}</Order><Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v ${k} /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>`).join("\n");
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
        <InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>1</Value></MetaData></InstallFrom>
      </OSImage></ImageInstall>
      <UserData><AcceptEula>true</AcceptEula></UserData>`)}
  </settings>
  <settings pass="specialize">
${c("Microsoft-Windows-Shell-Setup", "specialize", `      <ComputerName>WINDINGHY</ComputerName>
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
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>${xml(user)}</Name>
            <Group>Administrators</Group>
            <Password><Value>${xml(password)}</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled><LogonCount>1</LogonCount><Username>${xml(user)}</Username>
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
export function firstLogonScript(setupPort) {
    return `$ErrorActionPreference = 'Continue'
Start-Transcript -Path C:\\Windows\\Temp\\dinghy-firstlogon.log -Force | Out-Null
$g = Get-PSDrive -PSProvider FileSystem | ForEach-Object { Join-Path $_.Root 'virtio-win-guest-tools.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($g) { Write-Host "installing $g"; Start-Process $g -ArgumentList '/install','/quiet','/norestart' -Wait }
for ($i = 0; $i -lt 120; $i++) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('10.0.2.2', ${setupPort}); $c.Close(); break } catch { Start-Sleep 5 }
}
try { Invoke-RestMethod -Uri http://10.0.2.2:${setupPort}/setup.ps1 -UseBasicParsing | Invoke-Expression } catch { Write-Host "setup failed: $_" }
Stop-Transcript | Out-Null
`;
}

// Build the answer-file CD (autounattend.xml + firstlogon.ps1) with macOS's hdiutil.
export function buildUnattendIso(cfg, { user, password, setupPort }) {
    const f = files(cfg);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dinghy-unattend-"));
    fs.writeFileSync(path.join(stage, "autounattend.xml"), unattendXml({ user, password }));
    fs.writeFileSync(path.join(stage, "firstlogon.ps1"), firstLogonScript(setupPort));
    fs.rmSync(f.unattend, { force: true });
    const r = spawnSync("hdiutil", ["makehybrid", "-iso", "-joliet", "-default-volume-name", "UNATTEND", "-o", f.unattend, stage], { encoding: "utf8" });
    fs.rmSync(stage, { recursive: true, force: true });
    if (r.status !== 0 || !fs.existsSync(f.unattend)) throw new Error(`Couldn't build the answer-file ISO: ${r.stderr}`);
    return f.unattend;
}
