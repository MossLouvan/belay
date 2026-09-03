# Compiles BelayHost.cs into BelayHost.exe using the .NET Framework C#
# compiler that ships with Windows. No SDK or NuGet restore required.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) { throw "csc.exe not found. Install the .NET Framework or run with the dotnet SDK." }

# Every source in the helper, compiled in one csc invocation.
$src = @('BelayHost.cs', 'BelayHostDisplays.cs', 'BelayHostWindows.cs') | ForEach-Object { Join-Path $here $_ }

# ── WebRTC path (opt-in, HARDWARE-GATED, WRITTEN-BUT-NOT-COMPILED) ──────────
# $env:BELAY_WEBRTC_BUILD=1 folds in the Desktop Duplication + Media Foundation
# + libdatachannel path (BelayHostWebRtc.cs). It also needs belay_transport.dll
# (libdatachannel built for Windows from the same pinned source as macOS —
# see docs/WEBRTC-SLICE.md) placed beside BelayHost.exe at runtime. The default
# build is unchanged and the `webrtc` verb fails cleanly to the JPEG path.
$defines = @()
if ($env:BELAY_WEBRTC_BUILD -eq '1') {
    Write-Host "note: BELAY_WEBRTC_BUILD=1 - folding in the hardware-gated WebRTC path (UNVERIFIED)"
    $src += (Join-Path $here 'BelayHostWebRtc.cs')
    $defines += '/define:BELAY_WEBRTC_BUILD'
}

foreach ($f in $src) { if (-not (Test-Path $f)) { throw "missing source: $f" } }
$out = Join-Path $here 'BelayHost.exe'

$refs = @(
    'System.dll',
    'System.Drawing.dll',
    'System.Windows.Forms.dll',
    'System.Web.Extensions.dll'
) | ForEach-Object { "/r:$_" }

& $csc /nologo /target:exe /platform:x64 /optimize+ /out:"$out" @defines $refs $src
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
Write-Host "Built $out"
