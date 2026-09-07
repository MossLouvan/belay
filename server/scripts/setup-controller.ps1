# Official, pinned ViGEm runtime and driver. Windows driver installation needs
# an administrator prompt; never change OS security settings to suppress it.
param([switch]$InstallDriver)
$ErrorActionPreference = 'Stop'
$native = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\native'))
$work = Join-Path $env:TEMP ('belay-controller-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$package = Join-Path $work 'client.zip'
Invoke-WebRequest 'https://api.nuget.org/v3-flatcontainer/nefarius.vigem.client/1.21.256/nefarius.vigem.client.1.21.256.nupkg' -OutFile $package
Expand-Archive -LiteralPath $package -DestinationPath (Join-Path $work 'client')
$assembly = [Reflection.Assembly]::LoadFile((Join-Path $work 'client\lib\netstandard2.0\Nefarius.ViGEm.Client.dll'))
$resource = $assembly.GetManifestResourceStream('costura64.vigemclient.dll')
if ($null -eq $resource) { throw 'Pinned package did not contain the x64 runtime.' }
$output = [IO.File]::Create((Join-Path $native 'ViGEmClient.dll'))
try { $resource.CopyTo($output) } finally { $output.Dispose(); $resource.Dispose() }
Write-Output 'Installed x64 ViGEmClient.dll beside the host helper.'
if ($InstallDriver) {
    $installer = Join-Path $work 'ViGEmBus.exe'
    Invoke-WebRequest 'https://github.com/nefarius/ViGEmBus/releases/download/v1.22.0/ViGEmBus_1.22.0_x64_x86_arm64.exe' -OutFile $installer
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Nefarius Software Solutions') { throw 'Driver publisher verification failed.' }
    $process = Start-Process -FilePath $installer -Verb RunAs -ArgumentList '/exenoui','/qn','/norestart' -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -eq 3010) { Write-Output 'Driver installed; Windows requests a restart.' }
    elseif ($process.ExitCode -ne 0) { throw "Driver installation failed: $($process.ExitCode)" }
    else { Write-Output 'Driver installed. Re-enter Gaming to attach the virtual controller.' }
}
