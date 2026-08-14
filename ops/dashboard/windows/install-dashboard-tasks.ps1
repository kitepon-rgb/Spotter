param([Parameter(Mandatory = $true)][string]$MainServer)
$ErrorActionPreference = 'Stop'
$ops = Split-Path -Parent $MyInvocation.MyCommand.Path
$powershell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$deviceAction = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ops\spotter-dashboard-device.ps1`""
Register-ScheduledTask -TaskName 'Spotter dashboard device' -Action $deviceAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

$tunnelAction = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ops\spotter-dashboard-tunnel.ps1`" -MainServer `"$MainServer`""
Register-ScheduledTask -TaskName 'Spotter dashboard tunnel' -Action $tunnelAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName 'Spotter dashboard device'
Start-ScheduledTask -TaskName 'Spotter dashboard tunnel'
