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
foreach ($f in $src) { if (-not (Test-Path $f)) { throw "missing source: $f" } }
$out = Join-Path $here 'BelayHost.exe'

$refs = @(
    'System.dll',
    'System.Drawing.dll',
    'System.Windows.Forms.dll',
    'System.Web.Extensions.dll'
) | ForEach-Object { "/r:$_" }

& $csc /nologo /target:exe /platform:x64 /optimize+ /out:"$out" $refs $src
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
Write-Host "Built $out"
