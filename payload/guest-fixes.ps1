# WinDinghy guest device fixes. Run elevated. Idempotent: setup.ps1 calls it on every run.
#
#   1. QEMU virt platform devices with no ARM64 driver -> inbox null driver (machine.inf NO_DRV):
#        ACPI\LNRO0005 x32  virtio-mmio transport slots (always in the virt DSDT; WinDinghy uses virtio-pci)
#        ACPI\QEMU0002      fw_cfg (virtio-win only ships fwcfg for x86/amd64)
#      They then show as OK under System devices instead of 33 "Unknown device" entries.
#   2. USB drives that bind to UAS (uaspstor) -> inbox Bulk-Only driver (usbstor.inf USBSTOR_BULK).
#      UAS needs USB 3 bulk streams end-to-end, which QEMU usb-host doesn't reliably provide.
#      -Install also registers a SYSTEM task that re-runs this with -UsbOnly whenever a UAS drive
#      is configured, so drives shared later get switched automatically.
#   3. Phantom devices left over from install media (QEMU CD-ROMs, virtio-scsi, usb-storage).
#
# Why not a driver package: Windows 11 Code Integrity rejects self-signed packages even when they are
# INF-only. This instead installs Microsoft-signed *inbox* INF sections onto devices those INFs don't
# list - what Device Manager's "Let me pick" does - via InboxDriver.cs (SetupAPI DiInstallDevice).

param([switch]$UsbOnly, [switch]$Install)

$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    OK: $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    WARN: $m" -ForegroundColor Yellow }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "guest-fixes.ps1 must run elevated." }

if (-not ("InboxDriver" -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot "InboxDriver.cs") }
$ClassSystem = [Guid]'4d36e97d-e325-11ce-bfc1-08002be10318'
$ClassUsb    = [Guid]'36fc9e60-c465-11cf-8056-444553540000'
$MachineInf  = Join-Path $env:windir "INF\machine.inf"
$UsbstorInf  = Join-Path $env:windir "INF\usbstor.inf"

function Set-InboxDriver($dev, $inf, $section, $class, $name) {
    try { [InboxDriver]::Install($dev.InstanceId, $inf, $section, $class, $name) | Out-Null; $true }
    catch { Warn "$($dev.InstanceId): $($_.Exception.InnerException.Message)$($_.Exception.Message)"; $false }
}

# ---------- 2. UAS -> Bulk-Only ----------
Step "Switching USB drives from UAS to Bulk-Only"
$uas = Get-PnpDevice -PresentOnly | Where-Object {
    $_.InstanceId -like 'USB\*' -and (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName DEVPKEY_Device_Service -ErrorAction SilentlyContinue).Data -eq 'UASPStor'
}
$n = 0; foreach ($d in $uas) { if (Set-InboxDriver $d $UsbstorInf 'USBSTOR_BULK' $ClassUsb $null) { $n++ } }
Ok "$n drive(s) switched"
if ($UsbOnly) { return }

# ---------- 1. null driver for QEMU platform devices ----------
Step "Installing null driver for QEMU platform devices"
$names = @{ 'ACPI\LNRO0005' = 'QEMU virtio-mmio slot (unused)'; 'ACPI\QEMU0002' = 'QEMU firmware configuration (fw_cfg)' }
$n = 0
Get-PnpDevice -PresentOnly | Where-Object { $_.Problem -ne 0 } | ForEach-Object {
    $prefix = ($_.InstanceId -split '\\')[0..1] -join '\'
    if ($names.ContainsKey($prefix) -and (Set-InboxDriver $_ $MachineInf 'NO_DRV' $ClassSystem $names[$prefix])) { $n++ }
}
Ok "$n device(s) fixed"

# ---------- 3. phantom install-media devices ----------
Step "Removing leftover install-media devices"
$patterns = '^USBSTOR\\CDROM&VEN_QEMU', '^SCSI\\CDROM&VEN_QEMU', '^USB\\VID_46F4&PID_0001\\', '^PCI\\VEN_1AF4&DEV_(1004|1048)'
$n = 0
Get-PnpDevice | Where-Object { -not $_.Present } | Where-Object { $id = $_.InstanceId; $patterns | Where-Object { $id -match $_ } } | ForEach-Object {
    pnputil /remove-device "$($_.InstanceId)" | Out-Null
    if ($LASTEXITCODE -eq 0) { $n++ }
}
Ok "$n phantom device(s) removed"

# ---------- auto-switch task for drives shared later ----------
if ($Install) {
    Step "Registering UAS auto-switch task"
    # Kernel-PnP event 400 = device configured; fire when the driver chosen was uaspstor.inf.
    $self = Join-Path $PSScriptRoot "guest-fixes.ps1"
    $xml = @"
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><EventTrigger><Enabled>true</Enabled>
    <Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="Microsoft-Windows-Kernel-PnP/Configuration"&gt;&lt;Select Path="Microsoft-Windows-Kernel-PnP/Configuration"&gt;*[System[EventID=400]] and *[EventData[Data[@Name='DriverName']='uaspstor.inf']]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription>
  </EventTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>Queue</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT5M</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -ExecutionPolicy Bypass -File "$self" -UsbOnly</Arguments></Exec></Actions>
</Task>
"@
    Register-ScheduledTask -TaskName "WinDinghyUasToBot" -Xml $xml -Force | Out-Null
    Ok "task WinDinghyUasToBot registered"
}

# ---------- report ----------
pnputil /scan-devices | Out-Null
Start-Sleep -Seconds 2
$bad = Get-PnpDevice -PresentOnly | Where-Object { $_.Problem -ne 0 }
if ($bad) {
    Warn "devices still reporting a problem:"
    $bad | ForEach-Object { Write-Host "      $($_.Problem)  $($_.FriendlyName)  $($_.InstanceId)" }
} else { Ok "no problem devices" }
