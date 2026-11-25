# WinDinghy guest setup
# Run inside the Windows VM in an *elevated* PowerShell:
#   irm http://<mac-ip>:8756/setup.ps1 | iex
#
# Enables RDP + RemoteApp (RAIL), installs the WinBoat Guest Server as a
# service, and opens the needed firewall ports. Idempotent - safe to re-run.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$BaseUrl = "__BASE_URL__"
$NoLogonBanner = __NO_BANNER__   # opt-in: dinghy serve-setup --no-banner
$WB = "C:\Program Files\WinBoat"

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    WARN: $msg" -ForegroundColor Yellow }

# --- Preflight ---
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script must run in an elevated (Administrator) PowerShell."
}

$edition = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").EditionID
$arch = $env:PROCESSOR_ARCHITECTURE
Step "Windows edition: $edition ($arch)"
if ($edition -like "Core*") {
    Warn "This looks like Windows Home, which cannot host RDP connections."
    Warn "RemoteApp needs Pro/Enterprise/Education. Aborting."
    throw "Unsupported edition: $edition"
}

# --- 1. Enable Remote Desktop host ---
Step "Enabling Remote Desktop"
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server" -Name fDenyTSConnections -Value 0 -Type DWord
# Enable the built-in RDP firewall rules across all profiles (vmnet often lands on 'Public')
Get-NetFirewallRule -Name "RemoteDesktop-UserMode-In-TCP","RemoteDesktop-UserMode-In-UDP" -ErrorAction SilentlyContinue | Enable-NetFirewallRule
if (-not (Get-NetFirewallRule -DisplayName "WinBoat RDP 3389" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "WinBoat RDP 3389" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3389 -Profile Any | Out-Null
    New-NetFirewallRule -DisplayName "WinBoat RDP 3389 UDP" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 3389 -Profile Any | Out-Null
}
Ok "RDP enabled"

# --- 2. RemoteApp (RAIL) unlock ---
Step "Unlocking RemoteApp for unlisted programs"
New-Item -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\TSAppAllowList" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\TSAppAllowList" -Name fDisabledAllowList -Value 1 -Type DWord
New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services" -Name fAllowUnlistedRemotePrograms -Value 1 -Type DWord
# Keep the host's keyboard layout in RDP sessions
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Keyboard Layout" -Name IgnoreRemoteKeyboardLayout -Value 1 -Type DWord
# Suppress "make this PC discoverable" prompts
New-Item -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Network\NewNetworkWindowOff" -Force | Out-Null
Ok "RAIL unlocked"

# --- 3. Install the Guest Server ---
Step "Downloading guest server payload from $BaseUrl"
if (-not (Test-Path $WB)) { New-Item -ItemType Directory -Path $WB -Force | Out-Null }
try { Add-MpPreference -ExclusionPath $WB -ErrorAction SilentlyContinue } catch { Warn "Could not add Defender exclusion (non-fatal)" }

$zip = Join-Path $env:TEMP "winboat_payload.zip"
Invoke-WebRequest -Uri "$BaseUrl/payload.zip" -OutFile $zip -UseBasicParsing

# Service management section: nssm/schtasks write status noise to stderr and
# use non-zero exits for "nothing to do" - under EAP=Stop that becomes a fatal
# NativeCommandError, so run this whole section permissively and verify the
# result explicitly at the end.
$ErrorActionPreference = "Continue"

# Stop anything from a previous run before overwriting binaries (re-run case)
$nssm = Join-Path $WB "nssm.exe"
if (Test-Path $nssm) {
    cmd /c "`"$nssm`" stop WinBoatGuestServer >nul 2>&1"
}
cmd /c 'schtasks /end /tn "WinBoatGuestServer" >nul 2>&1'
Stop-Process -Name "winboat_guest_server" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Expand-Archive -Path $zip -DestinationPath $WB -Force
Remove-Item $zip -Force
Ok "Payload installed to $WB"

Step "Installing WinBoatGuestServer service"
cmd /c "`"$nssm`" install WinBoatGuestServer `"$WB\server\winboat_guest_server.exe`" >nul 2>&1"
cmd /c "`"$nssm`" set WinBoatGuestServer Start SERVICE_AUTO_START >nul 2>&1"
cmd /c "`"$nssm`" set WinBoatGuestServer AppDirectory `"$WB\server`" >nul 2>&1"
cmd /c "`"$nssm`" set WinBoatGuestServer Description `"WinBoat Guest Server API on port 7148`" >nul 2>&1"
cmd /c "`"$nssm`" set WinBoatGuestServer ObjectName `"NT AUTHORITY\SYSTEM`" >nul 2>&1"
cmd /c "`"$nssm`" restart WinBoatGuestServer >nul 2>&1"
Start-Sleep -Seconds 2

$svc = Get-Service WinBoatGuestServer -ErrorAction SilentlyContinue
if (-not $svc -or $svc.Status -ne "Running") {
    Warn "nssm service not running (status: $($svc.Status)); falling back to a scheduled task"
    cmd /c "schtasks /create /f /tn `"WinBoatGuestServer`" /sc ONSTART /RL HIGHEST /RU SYSTEM /tr `"\`"$WB\server\winboat_guest_server.exe\`"`" >nul 2>&1"
    cmd /c 'schtasks /run /tn "WinBoatGuestServer" >nul 2>&1'
}
$ErrorActionPreference = "Stop"

if (-not (Get-NetFirewallRule -DisplayName "WinBoat API 7148" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "WinBoat API 7148" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7148 -Profile Any | Out-Null
}

# --- 3b. Device fixes (unknown QEMU devices, UAS -> Bulk-Only for shared USB drives) ---
try { & (Join-Path $WB "guest-fixes.ps1") -Install } catch { Warn "Device fixes failed (non-fatal): $_" }

# --- 4. RDP robustness on QEMU/vmnet ---
# UDP transport over QEMU shared networking is unreliable and can wedge the
# RDP security layer (client sees generic security errors, e.g. 0x1807, until
# reboot). Pin RDP to TCP. Also sync the clock aggressively: guest clock drift
# after VM pauses breaks CredSSP the same way.
Step "Pinning RDP to TCP-only transport"
New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services" -Name SelectTransport -Value 1 -Type DWord
$ErrorActionPreference = "Continue"
if ($env:SESSIONNAME -like "RDP*") {
    # Running over RDP: restarting TermService now would drop this very session mid-script.
    # Restart it from a one-shot SYSTEM task a minute after we finish instead.
    $when = (Get-Date).AddMinutes(2).ToString("HH:mm")
    cmd /c "schtasks /create /f /tn WinDinghyRestartRDP /sc once /st $when /ru SYSTEM /tr `"powershell -NoProfile -Command Restart-Service TermService -Force; schtasks /delete /f /tn WinDinghyRestartRDP`" >nul 2>&1"
    Ok "RDP transport pinned to TCP (TermService restart scheduled for $when; your RDP session will reconnect)"
} else {
    Restart-Service TermService -Force -ErrorAction SilentlyContinue
    Ok "RDP transport pinned to TCP (TermService restarted)"
}

Step "Disabling Edge background mode (breaks RemoteApp relaunch)"
# Edge's startup-boost/background processes make a second RemoteApp launch
# hand off to the resident instance and exit -> the session closes before any
# window appears. Force Edge to fully exit when closed.
New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge" -Name StartupBoostEnabled -Value 0 -Type DWord
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge" -Name BackgroundModeEnabled -Value 0 -Type DWord
Ok "Edge background mode disabled"

Step "Configuring aggressive time sync"
cmd /c 'w32tm /config /manualpeerlist:"time.windows.com,0x9 time.apple.com,0x9" /syncfromflags:manual /update >nul 2>&1'
# 0x9 peers use SpecialPollInterval; default 1h leaves the clock minutes off
# after a VM pause until the next poll, which breaks CredSSP (RDP 0x1807).
# Poll every 60s and allow unlimited step corrections so any drift heals fast.
$w32 = "HKLM:\SYSTEM\CurrentControlSet\Services\W32Time"
Set-ItemProperty -Path "$w32\TimeProviders\NtpClient" -Name SpecialPollInterval -Value 60 -Type DWord
Set-ItemProperty -Path "$w32\Config" -Name MaxPosPhaseCorrection -Value 0xFFFFFFFF -Type DWord
Set-ItemProperty -Path "$w32\Config" -Name MaxNegPhaseCorrection -Value 0xFFFFFFFF -Type DWord
cmd /c 'net stop w32time >nul 2>&1'
cmd /c 'net start w32time >nul 2>&1'
cmd /c 'w32tm /resync /force >nul 2>&1'
# Belt-and-braces resync task in case w32time stalls
cmd /c 'schtasks /create /f /tn "WinBoatTimeSync" /sc minute /mo 5 /ru SYSTEM /tr "w32tm /resync" >nul 2>&1'
Ok "Time sync: NTP poll every 60s + resync task every 5 minutes"
$ErrorActionPreference = "Stop"

# --- 4b. Logon banner (legal notice) ---
# Report the banner text to the Mac so WinDinghy can show it as a native dialog
# before connecting. With -NoLogonBanner (dinghy serve-setup --no-banner) it is
# also blanked locally and re-blanked every 15 minutes in case Group Policy
# restores it. Off by default: the banner may be an organization's policy.
Step "Logon banner"
$ErrorActionPreference = "Continue"
$sysPol = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
$bCap = (Get-ItemProperty $sysPol -Name legalnoticecaption -ErrorAction SilentlyContinue).legalnoticecaption
$bTxt = (Get-ItemProperty $sysPol -Name legalnoticetext -ErrorAction SilentlyContinue).legalnoticetext
# An unset banner can hold a lone NUL character, which is "non-empty" to PowerShell: strip it.
$bCap = ("$bCap" -replace [char]0, "").Trim()
$bTxt = ("$bTxt" -replace [char]0, "").Trim()
if ($bTxt -or $bCap) {
    try {
        $body = @{ caption = "$bCap"; text = "$bTxt" } | ConvertTo-Json
        Invoke-RestMethod -Uri "$BaseUrl/banner" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing | Out-Null
        Ok "Logon banner reported to the Mac"
    } catch { Warn "Could not report the logon banner (non-fatal)" }
    if ($NoLogonBanner) {
        Write-Host ""
        Write-Host "    WARNING: you asked to SUPPRESS the Windows logon banner." -ForegroundColor Red
        Write-Host "    That banner may be your organization's acceptable-use / network policy notice." -ForegroundColor Red
        Write-Host "    Hiding it may violate that policy. You are responsible for deciding this is OK." -ForegroundColor Red
        $confirm = if ($env:WINDINGHY_YES -eq "YES") { "YES" } else { Read-Host "    Type YES to suppress it (anything else keeps the banner)" }
        if ($confirm -ne "YES") { $NoLogonBanner = $false; Warn "Banner suppression skipped" }
    }
    if ($NoLogonBanner) {
        $blank = 'Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -Name legalnoticecaption -Value ""; Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -Name legalnoticetext -Value ""'
        Invoke-Expression $blank
        $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($blank))
        cmd /c "schtasks /create /f /tn WinDinghyNoBanner /sc minute /mo 15 /ru SYSTEM /tr `"powershell -NoProfile -EncodedCommand $enc`" >nul 2>&1"
        Ok "Logon banner suppressed (task WinDinghyNoBanner re-applies it every 15 min)"
    }
} else {
    Ok "No logon banner configured"
    cmd /c 'schtasks /delete /f /tn WinDinghyNoBanner >nul 2>&1'
    # Tell the Mac so it forgets any banner it stored for an earlier VM.
    try { Invoke-RestMethod -Uri "$BaseUrl/banner" -Method Post -Body (@{ caption = ""; text = "" } | ConvertTo-Json) -ContentType "application/json" -UseBasicParsing | Out-Null } catch {}
}
$ErrorActionPreference = "Stop"

# --- 5. Health check ---
Step "Health check"
Start-Sleep -Seconds 2
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:7148/health" -UseBasicParsing -TimeoutSec 10
    Ok "Guest server is up: $($health.status)"
} catch {
    Warn "Guest server not answering yet on 7148. It may need a few seconds, or check: Get-Service WinBoatGuestServer"
}

$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "169.*" -and $_.IPAddress -ne "127.0.0.1" }).IPAddress -join ", "
Write-Host ""
Write-Host "Done. Guest IPs: $ips" -ForegroundColor Green
Write-Host "Back on the Mac, run: dinghy sync" -ForegroundColor Green
