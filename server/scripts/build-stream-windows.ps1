# Build the H.264 (BWP) streamer for a Windows host and put it where the
# server looks for it.
#
# Usage (in server\):
#   npm run build:stream:win
#
# Why this exists: the host reports `bwp:false` on /health until
# native\belay-stream.exe exists, and without it the phone falls back to the
# JPEG stream, which is decoded on the phone's JavaScript thread and is what
# starves the controller loop. The streamer is a standalone Rust crate (there
# is no workspace Cargo.toml; every crate under crates\ builds on its own).
#
# Toolchain: the `windows` crate (D3D11/DXGI for Desktop Duplication) and
# belay-encode's Media Foundation bindings need the MSVC target, which means
# Visual Studio Build Tools with the "Desktop development with C++" workload.
# The GNU toolchain will not link these.
#
# PowerShell 5.1 compatible on purpose: no ??, no ternary, no &&.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ServerDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RepoRoot  = (Resolve-Path (Join-Path $ServerDir '..')).Path
$Manifest  = Join-Path $RepoRoot 'crates\belay-stream\Cargo.toml'
$Built     = Join-Path $RepoRoot 'crates\belay-stream\target\release\belay-stream.exe'
$Target    = Join-Path $ServerDir 'native\belay-stream.exe'

if (-not (Test-Path $Manifest)) {
    throw "Streamer crate not found at $Manifest. Run this from a full checkout of the repo."
}

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($null -eq $cargo) {
    Write-Host 'cargo is not installed. Install the Rust toolchain, then rerun:'
    Write-Host ''
    Write-Host '    winget install --id Rustlang.Rustup -e'
    Write-Host '    (open a NEW PowerShell window so PATH picks up cargo)'
    Write-Host '    rustup default stable-x86_64-pc-windows-msvc'
    Write-Host ''
    Write-Host 'Also install Visual Studio Build Tools with the "Desktop development with C++"'
    Write-Host 'workload; the MSVC linker is required for the Windows/Media Foundation crates.'
    exit 1
}

$hostLine = (& rustc -vV | Select-String '^host:').Line
if ($hostLine -notlike '*-pc-windows-msvc') {
    Write-Warning "rustc host is '$hostLine'. The streamer needs the MSVC toolchain:"
    Write-Warning '    rustup default stable-x86_64-pc-windows-msvc'
    Write-Warning 'The build below will most likely fail to link until that is set.'
}

Write-Host "==> Building belay-stream (release) from $Manifest"
& cargo build --release --manifest-path $Manifest --bin belay-stream
if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }

if (-not (Test-Path $Built)) {
    throw "cargo reported success but $Built is missing"
}

Copy-Item -Force $Built $Target
Write-Host "==> Installed $Target"
Write-Host ''
Write-Host 'Restart the host (npm start, or the BelayHostAgent task). /health should now'
Write-Host 'report bwp:true and the phone will pick H.264 by default.'
Write-Host ''
Write-Host 'Note: per docs/BWP-STATUS.md the encoder is type-checked for this target but the'
Write-Host 'first H.264 frame on real hardware is unverified. If the picture never arrives,'
Write-Host 'the phone falls back to JPEG on its own; the host log names the encoder error.'
