# Takes Steam and the CI login off the runner: stops the client and the game, removes
# steamcmd, the Steam client, their registry entries and the app id file the launch wrote.
# Shared by sr-client-rig.yml and sr-data-extract.yml (one copy of what "the login is gone"
# means). Runs always; exits 1 if anything stayed behind.
[CmdletBinding()]
param([string]$InstallDir = '')
$ErrorActionPreference = 'Stop'

Stop-Service 'Steam Client Service' -Force -ErrorAction SilentlyContinue
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(steam|gameoverlayui|StarRupture|UnrealCEF|CrashReport|WerFault)' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5
$left = 0
foreach ($d in 'C:\steamcmd', (Join-Path ${env:ProgramFiles(x86)} 'Steam'), (Join-Path $env:LOCALAPPDATA 'Steam')) {
    Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $d) { Write-Host "::error::$d could not be removed"; $left++ }
}
# The saved login's registry entries, and the app id file the launch wrote.
Remove-Item -LiteralPath 'HKCU:\Software\Valve' -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath 'HKCU:\Software\Valve') { Write-Host '::error::HKCU\Software\Valve could not be removed'; $left++ }
if ($InstallDir -and (Test-Path -LiteralPath $InstallDir)) {
    Get-ChildItem -LiteralPath $InstallDir -Recurse -Filter steam_appid.txt -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}
if ($left) { exit 1 }
'steamcmd, the Steam client and the login are removed from the runner.'
