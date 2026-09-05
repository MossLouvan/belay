# build-driver.ps1 — builds and test-signs the BelayVDD indirect display driver.
#
# STATUS: WRITTEN-BUT-NOT-RUN. Authored on a machine with no Windows; every
# step below is the documented WDK flow, not a verified one. Run it on a
# Windows box with VS2022 + SDK + WDK installed, then follow the install and
# verification steps in docs/VIRTUAL-DISPLAY.md.
#
# What this produces (in .\dist\<arch>\BelayVdd\):
#   BelayVdd.dll   — the UMDF2 driver
#   BelayVdd.inf   — install package
#   BelayVdd.cat   — catalog, TEST-SIGNED ONLY by this script
#
# HONESTY REQUIRED: test-signing is for development machines with
# `bcdedit /set testsigning on`. Shipping to real users requires an EV code
# signing certificate and Microsoft Hardware Dev Center attestation signing
# (or full WHQL). This script cannot and does not do that — see the
# "Signing for release" section of docs/VIRTUAL-DISPLAY.md.

[CmdletBinding()]
param(
    [ValidateSet('x64', 'ARM64')]
    [string]$Platform = 'x64',
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    # Path to an existing test certificate (PFX). When omitted, a throwaway
    # self-signed cert is created in the machine store (dev machines only).
    [string]$TestCertPfx = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- locate MSBuild (VS2022 with the WDK extension) -------------------------
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) {
    throw 'vswhere.exe not found. Install Visual Studio 2022 with the Windows Driver Kit extension.'
}
# No -requires filter: the Microsoft.Component.MSBuild component id is not
# installed on the Visual Studio *Build Tools* SKU (MSBuild is intrinsic
# there), so requiring it finds nothing on a perfectly good driver box.
# 64-bit MSBuild, deliberately. The WDK's DPVerifierTask (INF verification)
# loads InfVerif.dll from a bitness-matched subdirectory, and the WDK ships
# only x64/arm64 copies - under the 32-bit MSBuild the build dies with
# "Unable to load DLL 'x86\InfVerif.dll'".
# -nologo, and filter to lines that are actually a path to MSBuild.exe:
# vswhere prints a version banner on stdout that otherwise ends up in $msbuild.
function Find-MSBuild([string]$relative) {
    & $vswhere -nologo -latest -products * -find $relative |
        Where-Object { $_ -like '*MSBuild.exe' -and (Test-Path $_) } |
        Select-Object -First 1
}
$msbuild = Find-MSBuild 'MSBuild\**\Bin\amd64\MSBuild.exe'

# Deterministic fallback: derive the path from the install root instead of
# trusting the -find glob. Cheap insurance, and it stops a bad pattern above
# from silently degrading to the 32-bit MSBuild, which then fails much later and
# far less legibly, inside INF verification.
if (-not $msbuild) {
    $installPath = & $vswhere -nologo -latest -products * -property installationPath |
        Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($installPath) {
        $candidate = Join-Path $installPath 'MSBuild\Current\Bin\amd64\MSBuild.exe'
        if (Test-Path $candidate) { $msbuild = $candidate }
    }
}

if (-not $msbuild) {
    $msbuild = Find-MSBuild 'MSBuild\**\Bin\MSBuild.exe'
    if ($msbuild) { Write-Warning 'Only 32-bit MSBuild found; INF verification may fail to load InfVerif.dll' }
}
if (-not $msbuild) { throw 'MSBuild not found via vswhere. Is VS2022 (or VS2022 Build Tools) installed?' }

# ---- native shim ------------------------------------------------------------
# SwDeviceCreate pins the module that owns its creation callback, and a CLR
# delegate thunk belongs to no module - so the call fails from C# with
# ERROR_MOD_NOT_FOUND no matter how the arguments are marshalled. See the header
# of BelayVddShim.cpp. This builds the tiny DLL that owns that callback and
# drops it beside BelayHost.exe, which P/Invokes it.
$installPathForCl = & $vswhere -nologo -latest -products * -property installationPath |
    Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$vcvars = if ($installPathForCl) { Join-Path $installPathForCl 'VC\Auxiliary\Build\vcvars64.bat' } else { $null }

if ($vcvars -and (Test-Path $vcvars)) {
    $shimSrc = Join-Path $here 'BelayVddShim.cpp'
    $shimOut = Join-Path $here 'shim'
    New-Item -ItemType Directory -Force -Path $shimOut | Out-Null
    $shimCmd = Join-Path $shimOut 'build-shim.cmd'
    # cfgmgr32.lib does NOT export SwDeviceCreate - it lives in SwDevice.lib.
    @"
@echo off
call "$vcvars" >nul
cd /d "$shimOut"
cl /nologo /W4 /O2 /LD /DUNICODE /D_UNICODE "$shimSrc" /Fe:BelayVddShim.dll /link SwDevice.lib cfgmgr32.lib
"@ | Set-Content -Path $shimCmd -Encoding ASCII

    # stderr is merged rather than left to surface as a NativeCommandError.
    # vcvars64.bat writes "'vswhere.exe' is not recognized" to stderr during an
    # optional lookup -- entirely harmless, the environment initialises fine and
    # cl returns 0 -- but under $ErrorActionPreference='Stop' PowerShell turns
    # that stray stderr line into a terminating error and the build dies having
    # actually succeeded. Judge the compile by its exit code, not by whether a
    # batch file was chatty.
    $shimLog = & cmd /c "`"$shimCmd`" 2>&1"
    if ($LASTEXITCODE -ne 0) {
        $shimLog | ForEach-Object { Write-Host "  $_" }
        throw "BelayVddShim.dll failed to build (exit $LASTEXITCODE)"
    }
    Write-Host "Built shim: $(Join-Path $shimOut 'BelayVddShim.dll')"
} else {
    Write-Warning 'vcvars64.bat not found; skipping BelayVddShim.dll (virtual display creation will fail from the C# host)'
}

# ---- build ------------------------------------------------------------------
$proj = Join-Path $here 'BelayVdd.vcxproj'
& $msbuild $proj "/p:Configuration=$Configuration" "/p:Platform=$Platform" '/m' '/verbosity:minimal'
if ($LASTEXITCODE -ne 0) { throw "msbuild failed with exit code $LASTEXITCODE" }

$outDir = Join-Path $here "$Platform\$Configuration\BelayVdd"
if (-not (Test-Path (Join-Path $outDir 'BelayVdd.dll'))) {
    throw "build output not found under $outDir - check the msbuild log"
}

# ---- validate the INF -------------------------------------------------------
# infverif ships with the WDK. Use /u (Universal Driver requirements), which is
# the ruleset matching <DriverTargetPlatform>Universal</DriverTargetPlatform> in
# BelayVdd.vcxproj. /w is the stricter "Windows Driver" (WCOS) ruleset and is
# NOT what this package targets - under /w the inbox WUDFRd service reference
# that every UMDF2 INF needs is reported as error 2084.
# WDK 10.0.26100 ships infverif under Tools\<ver>\x64 (and arm64) - there is no
# x86 copy, so globbing only x86 silently skipped INF validation entirely.
$infverif = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\Tools\*\x64\infverif.exe", "${env:ProgramFiles(x86)}\Windows Kits\10\Tools\*\x86\infverif.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
if ($infverif) {
    & $infverif.FullName /v /u (Join-Path $outDir 'BelayVdd.inf')
    if ($LASTEXITCODE -ne 0) { throw 'infverif reported problems; fix BelayVdd.inf before signing' }
} else {
    Write-Warning 'infverif.exe not found; skipping INF validation (install the WDK tools)'
}

# ---- test-sign the catalog --------------------------------------------------
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe not found; install the Windows SDK signing tools' }

$cat = Get-ChildItem $outDir -Filter '*.cat' | Select-Object -First 1
if (-not $cat) { throw "no .cat produced (Inf2Cat should have run during the build)" }

# The .vcxproj sets SignMode=Off so MSBuild's own SignTask stays out of the
# way, which means BOTH the binary and the catalog are signed here. The
# catalog is what PnP actually validates at install; the embedded signature on
# the DLL is belt-and-braces.
$toSign = @((Join-Path $outDir 'BelayVdd.dll'), $cat.FullName) | Where-Object { Test-Path $_ }

if ($TestCertPfx) {
    & $signtool.FullName sign /fd SHA256 /f $TestCertPfx /tr http://timestamp.digicert.com /td SHA256 @toSign
} else {
    $certName = 'BelayVDD Test Cert (DO NOT SHIP)'
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object Subject -eq "CN=$certName" | Select-Object -First 1
    if (-not $cert) {
        $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=$certName" -CertStoreLocation Cert:\CurrentUser\My
    }
    & $signtool.FullName sign /fd SHA256 /sha1 $cert.Thumbprint /tr http://timestamp.digicert.com /td SHA256 @toSign
}
if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE" }

# ---- trust the test certificate --------------------------------------------
# Test-signing mode relaxes WHICH certificate may sign a driver, but PnP still
# refuses a package whose signer does not chain to a root the MACHINE trusts.
# So the throwaway cert has to land in LocalMachine\Root (chain) and
# LocalMachine\TrustedPublisher (silent install). Both stores need elevation;
# when we don't have it, print the exact commands rather than failing late at
# `pnputil` with a signature error that looks like a build problem.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $TestCertPfx) {
    $cer = Join-Path $here 'BelayVddTest.cer'
    Export-Certificate -Cert $cert -FilePath $cer -Force | Out-Null
    if ($isAdmin) {
        # certutil, not Import-Certificate. The Cert: provider writes to
        # LocalMachine\Root through a path that fails with E_ACCESSDENIED in
        # non-interactive sessions (PowerShell Direct, WinRM, scheduled tasks)
        # even when the token really is elevated. certutil talks to the store
        # API directly and works in all of them.
        $trusted = $true
        foreach ($store in 'Root', 'TrustedPublisher') {
            $out = & certutil -f -addstore $store $cer 2>&1
            if ($LASTEXITCODE -ne 0) {
                $trusted = $false
                Write-Warning "certutil -addstore $store failed: $($out | Out-String)"
                # Fall back to the provider in case certutil is unavailable.
                try {
                    Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\LocalMachine\$store" -ErrorAction Stop | Out-Null
                    $trusted = $true
                } catch {
                    Write-Warning "Import-Certificate $store also failed: $($_.Exception.Message)"
                }
            }
        }
        if ($trusted) {
            Write-Host "Test cert trusted in LocalMachine\Root and LocalMachine\TrustedPublisher."
        } else {
            Write-Warning "Could not trust the test cert; pnputil will reject the package."
        }
    } else {
        Write-Warning "Not elevated - the test cert was NOT added to the machine trust stores."
        Write-Warning "Run these in an ELEVATED PowerShell before pnputil, or the install will fail:"
        Write-Warning "  Import-Certificate -FilePath '$cer' -CertStoreLocation Cert:\LocalMachine\Root"
        Write-Warning "  Import-Certificate -FilePath '$cer' -CertStoreLocation Cert:\LocalMachine\TrustedPublisher"
    }
}

$dist = Join-Path $here "dist\$Platform\BelayVdd"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item (Join-Path $outDir '*') $dist -Recurse -Force

# The shim is NOT part of the driver package - it must not go in the .cat or the
# Driver Store. It belongs beside BelayHost.exe, which loads it by name.
$shimDll = Join-Path $here 'shim\BelayVddShim.dll'
if (Test-Path $shimDll) {
    $hostDir = Resolve-Path (Join-Path $here '..')
    Copy-Item $shimDll $hostDir -Force
    Write-Host "Shim installed beside the host helper: $(Join-Path $hostDir 'BelayVddShim.dll')"
}

Write-Host ''
Write-Host "Built and TEST-signed: $dist"
Write-Host 'Install (dev machine, elevated, testsigning on):'
Write-Host '  bcdedit /set testsigning on   # then reboot'
Write-Host "  pnputil /add-driver `"$dist\BelayVdd.inf`" /install"
Write-Host '  # create the software device (the host does this at runtime too):'
Write-Host '  # devgen (WDK) or SwDeviceCreate with HWID Root\BelayVDD'
Write-Host 'Verify, then follow docs/VIRTUAL-DISPLAY.md for the full checklist.'
