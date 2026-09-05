# Install BelayVDD on a real machine, WITHOUT disabling Secure Boot.
#
#   Right-click > Run with PowerShell (as Administrator), or:
#   powershell -ExecutionPolicy Bypass -File install-main-machine.ps1
#
# WHY THIS MIGHT WORK WITH SECURE BOOT ON
# ---------------------------------------
# BelayVDD is a UMDF2 driver and the package contains NO kernel binary:
#
#     BelayVdd.dll   user-mode, loaded into WUDFHost.exe
#     BelayVdd.inf   installs Microsoft's own signed WUDFRd as the kernel service
#     belayvdd.cat   the catalog
#
# Kernel Mode Code Integrity - the thing Secure Boot enforces, and the thing
# `bcdedit /set testsigning on` exists to relax - governs images the KERNEL
# loads. There is no such image here. What Windows checks instead is that the
# driver PACKAGE catalog is signed by a certificate the machine trusts, and that
# is a trust-store question, not a boot-policy one.
#
# So this may install on a machine with Secure Boot and Memory Integrity both
# on. It is worth trying before touching firmware settings on a machine you
# actually use. If Windows refuses, it will say so plainly and nothing has been
# changed except a trusted certificate you can remove.
#
# RISK, HONESTLY
# --------------
# Low, and bounded by design: the display device is created ON DEMAND by an
# elevated Belay host and destroyed when that process exits. Nothing is created
# at boot, so a bad driver cannot leave you unable to log in. If a display does
# misbehave, closing the Belay host removes it.
#
# TO UNDO EVERYTHING (printed again at the end):
#   pnputil /enum-drivers            # find the oemN.inf for belayvdd
#   pnputil /delete-driver oemN.inf /uninstall /force
#   Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\TrustedPublisher |
#     Where-Object { $_.Subject -like '*BelayVDD*' } | Remove-Item

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg = Join-Path $here 'dist\x64\BelayVdd'
$inf = Join-Path $pkg 'BelayVdd.inf'
$cer = Join-Path $here 'BelayVddTest.cer'

Write-Host ''
Write-Host 'BelayVDD — install on a real machine' -ForegroundColor Cyan
Write-Host '------------------------------------'

if (-not (Test-Path $inf)) {
    throw "no built package at $pkg. Run build-driver.ps1 first."
}

Write-Host ''
Write-Host '[1/4] Machine state'
$sb = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State' -Name UEFISecureBootEnabled -EA SilentlyContinue).UEFISecureBootEnabled
Write-Host "      Secure Boot        : $(if ($sb -eq 1) { 'ON' } else { 'off' })"
$bcd = bcdedit /enum '{current}' 2>&1 | Out-String
$ts = ($bcd -split "`n" | Where-Object { $_ -match 'testsigning' }) -join ''
Write-Host "      test signing       : $(if ($ts) { $ts.Trim() } else { 'not set' })"
Write-Host '      package            : UMDF2, no kernel binary'

Write-Host ''
Write-Host '[2/4] Trusting the test certificate'
foreach ($store in 'Root', 'TrustedPublisher') {
    $existing = Get-ChildItem "Cert:\LocalMachine\$store" -EA SilentlyContinue |
        Where-Object { $_.Subject -like '*BelayVDD*' }
    if ($existing) {
        Write-Host "      $store : already trusted"
    } else {
        Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\LocalMachine\$store" | Out-Null
        Write-Host "      $store : added" -ForegroundColor Green
    }
}

Write-Host ''
Write-Host '[3/4] Installing the driver package'
$out = & pnputil.exe @('/add-driver', $inf, '/install') 2>&1 | Out-String
Write-Host ($out.Trim() -split "`n" | ForEach-Object { "      $_" }) -Separator "`n"

if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host "      pnputil exit code $LASTEXITCODE" -ForegroundColor Yellow
    Write-Host '      If it refused on signature grounds, the fallback is the one this' -ForegroundColor Yellow
    Write-Host '      script was written to avoid: Secure Boot off in UEFI, then' -ForegroundColor Yellow
    Write-Host '      bcdedit /set testsigning on, then reboot and re-run this.' -ForegroundColor Yellow
    exit 1
}

Write-Host ''
Write-Host '[4/4] Does it work? Creating a display and looking for it'
$helper = Join-Path $here '..\BelayHost.exe'
if (-not (Test-Path $helper)) {
    Write-Host '      BelayHost.exe not built — skipping the live check.' -ForegroundColor Yellow
    Write-Host '      Build it with: npm run build:native:win  (in server/)' -ForegroundColor Yellow
} else {
    Add-Type -AssemblyName System.Windows.Forms
    $before = [System.Windows.Forms.SystemInformation]::MonitorCount
    Write-Host "      monitors before : $before"

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Resolve-Path $helper).Path
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardOutput.ReadLine() | Out-Null   # startup banner
    $p.StandardInput.WriteLine('{"id":1,"cmd":"virtualdisplay","action":"create","w":1920,"h":1080,"hz":60}')
    $p.StandardInput.Flush()
    $reply = $p.StandardOutput.ReadLine()
    Write-Host "      create -> $reply"
    Start-Sleep -Seconds 5
    $after = [System.Windows.Forms.SystemInformation]::MonitorCount
    Write-Host "      monitors after  : $after"
    $p.StandardInput.Close(); $p.WaitForExit(5000) | Out-Null

    if ($after -gt $before) {
        Write-Host ''
        Write-Host '      WORKING — the desktop extended onto the virtual display,' -ForegroundColor Green
        Write-Host '      with Secure Boot left exactly as it was.' -ForegroundColor Green
    } else {
        Write-Host ''
        Write-Host '      The package installed but no display appeared.' -ForegroundColor Yellow
        Write-Host '      The reply above says why. Note the host must be ELEVATED to' -ForegroundColor Yellow
        Write-Host '      create one — this script is, so if it failed here the cause' -ForegroundColor Yellow
        Write-Host '      is the driver rather than permissions.' -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host 'To remove all of this:' -ForegroundColor Cyan
Write-Host '  pnputil /enum-drivers                              # find the oemN.inf for belayvdd'
Write-Host '  pnputil /delete-driver oemN.inf /uninstall /force'
Write-Host '  Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\TrustedPublisher |'
Write-Host '    Where-Object { $_.Subject -like "*BelayVDD*" } | Remove-Item'
Write-Host ''
