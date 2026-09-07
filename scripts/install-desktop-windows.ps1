param([string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\Belay'))
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $repo 'desktop'
$runtime = Join-Path $desktop 'node_modules\electron\dist'
if (-not (Test-Path (Join-Path $runtime 'electron.exe'))) { throw 'Run npm ci in desktop first.' }
$receiver = Join-Path $repo 'crates\belay-client\target\release\belay-receiver.exe'
if (-not (Test-Path $receiver)) { throw 'Build crates/belay-client with cargo build --release first.' }
$destinationPath = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
Copy-Item -Path (Join-Path $runtime '*') -Destination $destinationPath -Recurse -Force
Copy-Item -LiteralPath (Join-Path $runtime 'electron.exe') -Destination (Join-Path $destinationPath 'Belay.exe') -Force
$appPath = Join-Path $destinationPath 'resources\app'
New-Item -ItemType Directory -Path $appPath -Force | Out-Null
foreach ($entry in @('main.js','preload.cjs','package.json','renderer','src')) {
    Copy-Item -LiteralPath (Join-Path $desktop $entry) -Destination $appPath -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $appPath 'native') -Force | Out-Null
Copy-Item -LiteralPath $receiver -Destination (Join-Path $appPath 'native\belay-receiver.exe') -Force
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))) {
    $shortcut = $shell.CreateShortcut((Join-Path $folder 'Belay.lnk'))
    $shortcut.TargetPath = Join-Path $destinationPath 'Belay.exe'
    $shortcut.WorkingDirectory = $destinationPath
    $shortcut.Description = 'Connect to your Mac or PC with Belay'
    $shortcut.Save()
}
Write-Output (Join-Path $destinationPath 'Belay.exe')
