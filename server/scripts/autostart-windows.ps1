# Install (or remove) the Deskhandler host agent as a Windows scheduled task, so the
# machine is reachable from your phone whenever it is awake and logged in.
#
# Usage:
#   npm run autostart            install and start
#   npm run autostart -- status  show whether it is running
#   npm run autostart -- remove  stop and uninstall
#
# Why "run only when the user is logged on"
# -----------------------------------------
# The tempting option is "Run whether user is logged on or not". It is a trap.
# That mode performs a batch logon with no interactive desktop, so the task ends
# up in Session 0 on the Service-0x0-3e7$ window station rather than
# WinSta0\Default. From there SendInput cannot reach the interactive desktop and
# screen capture returns nothing — the agent starts, reports healthy, and every
# screen and input call silently fails.
#
# So the agent runs in the interactive session, which means it starts at logon
# rather than at boot. For an unattended restart to leave the machine reachable,
# enable automatic logon and set the power plan to never sleep.

[CmdletBinding()]
param(
    [ValidateSet('install', 'status', 'remove')]
    [string]$Action = 'install'
)

$ErrorActionPreference = 'Stop'

$TaskName  = 'DeskhandlerHostAgent'
# The pre-rename task name. Left registered, it would race the new task for the
# port at every logon — so install and remove both clean it up.
$LegacyTaskName = 'TetherHostAgent'
$ServerDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Get-HostTask {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Get-LegacyHostTask {
    Get-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
}

function Remove-LegacyHostTask {
    if ($null -ne (Get-LegacyHostTask)) {
        Stop-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false
        Write-Host "Removed pre-rename scheduled task '$LegacyTaskName'"
    }
}

switch ($Action) {
    'status' {
        $task = Get-HostTask
        if ($null -eq $task) {
            Write-Host 'Deskhandler autostart: not installed'
            if ($null -ne (Get-LegacyHostTask)) {
                Write-Host "note: the pre-rename task '$LegacyTaskName' is still registered; re-run install to replace it"
            }
        }
        else {
            $info = Get-ScheduledTaskInfo -TaskName $TaskName
            Write-Host 'Deskhandler autostart: INSTALLED'
            Write-Host "  State        : $($task.State)"
            Write-Host "  Last run     : $($info.LastRunTime)"
            Write-Host "  Last result  : $($info.LastTaskResult)"
        }
        return
    }
    'remove' {
        $removed = $false
        if ($null -ne (Get-HostTask)) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "Removed scheduled task '$TaskName'"
            $removed = $true
        }
        if ($null -ne (Get-LegacyHostTask)) {
            Remove-LegacyHostTask
            $removed = $true
        }
        if (-not $removed) {
            Write-Host 'Nothing to remove.'
        }
        Write-Host 'Your pairings are untouched - they live in the agent state file.'
        return
    }
}

# --- install ---------------------------------------------------------------

# No `??` here (or ternaries, or `&&` chains): the npm script invokes Windows
# PowerShell 5.1, which refuses to even parse PowerShell 7 syntax — the whole
# file dies before doing anything.
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    throw 'node is not on PATH; install Node before setting up autostart.'
}

# The task runs node directly rather than `npm start`, for the same reason the
# macOS script tells launchd to run node: with npm in between the server is a
# grandchild the scheduler never started, so stopping or removing the task
# left an orphaned node holding the port, and the next install died on
# EADDRINUSE. The absolute node path is captured now, at install time, so
# nothing later prepended to PATH can swap the binary the task executes.
$tsxCli = Join-Path $ServerDir 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path $tsxCli)) {
    throw "$tsxCli is missing. Run 'npm install' in server\ first."
}

Write-Host "==> Server directory : $ServerDir"
Write-Host "==> node             : $($node.Source)"

# Earlier versions generated a scripts\start-hidden.vbs here and pointed the
# task at it. The task no longer executes anything written into the checkout,
# so delete the shim an old install may have left behind.
Remove-Item (Join-Path $ServerDir 'scripts\start-hidden.vbs') -ErrorAction SilentlyContinue

if ($null -ne (Get-HostTask)) {
    Write-Host '==> Removing the existing task first'
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Remove-LegacyHostTask

# A plain console task opens a window at every logon, and Task Scheduler has no
# setting that reliably suppresses a child console on its own. So node runs
# inside a hidden powershell.exe — named by absolute path, since the command a
# logon task runs must not be resolvable through anything user-writable — with
# the whole launch command embedded in the task definition, which only
# administrators can rewrite. The call operator keeps node a child of the
# task's own process tree rather than a detached process, so stopping the task
# takes the agent down with it.
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launchCmd = "& '$($node.Source)' '$tsxCli' '$(Join-Path $ServerDir 'src\index.ts')'"
$taskAction = New-ScheduledTaskAction -Execute $powershellExe `
                                     -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$launchCmd`"" `
                                     -WorkingDirectory $ServerDir
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Interactive, not S4U or Service: this must land on WinSta0\Default or screen
# capture and input injection both fail. RunLevel Limited, deliberately: none
# of what the agent does needs elevation, and running an admin token over code
# that lives in a user-writable checkout hands local privilege escalation to
# anyone who can edit these files. Elevated windows and the UAC secure desktop
# were already out of reach — that is uiAccess, which Highest never granted.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                                        -LogonType Interactive `
                                        -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                                          -DontStopIfGoingOnBatteries `
                                          -StartWhenAvailable `
                                          -RestartCount 3 `
                                          -RestartInterval (New-TimeSpan -Minutes 1) `
                                          -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName `
                       -Action $taskAction `
                       -Trigger $trigger `
                       -Principal $principal `
                       -Settings $settings `
                       -Description 'Runs the Deskhandler host agent so this PC is reachable from the Deskhandler app.' | Out-Null

Write-Host "==> Registered scheduled task '$TaskName'"

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ''
Write-Host 'Deskhandler will now start automatically when you log in.'
Write-Host "  Last result: $($info.LastTaskResult)  (0 means started cleanly)"

Write-Host @'

Two things to know
------------------
1. Windows Defender may flag the input helper the first time it injects
   keystrokes. It is a locally compiled binary, not downloaded - see
   docs/SETUP.md for the exclusion steps.

2. This starts at logon, not at boot. For an unattended restart to leave the
   machine reachable, enable automatic logon and set the power plan to never
   sleep. Also run `powercfg /h off` to disable Fast Startup, which otherwise
   makes a "shutdown" a hibernate that never re-runs logon tasks.

   npm run autostart -- status    is it running
   npm run autostart -- remove    undo all of this
'@
