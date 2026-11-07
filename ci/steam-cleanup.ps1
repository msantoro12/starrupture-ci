# Takes Steam and the CI login off the runner. Shared by sr-client-rig.yml and
# sr-data-extract.yml (one copy of what "the login is gone" means).
#
# Two parts, because only the first one is a security property:
#   Login   Stops the Steam client, the service and the game, then removes everything that
#           holds the login (steamcmd with its config and ssfn files, the Steam config and
#           userdata folders, loginusers.vdf, config.vdf, ssfn*, the Steam profile under
#           LOCALAPPDATA, the registry entries, the app id file the launch wrote) and checks
#           that each one is gone. Fatal: exits 1, and writes the reason to
#           RUNNER_TEMP/rig-reason.txt, if anything stayed behind.
#   Folder  Removes the Steam install folder, retrying for about 60 s. A folder that stays
#           locked is a warning that names the process holding it (best effort); the exit
#           code is 0, because the login is already gone.
#   All     Login, then Folder (the default; the rig reads no game file after the cleanup).
[CmdletBinding()]
param(
    [string]$InstallDir = '',
    [ValidateSet('All', 'Login', 'Folder')][string]$Phase = 'All',
    [int]$FolderRetrySec = 60
)
$ErrorActionPreference = 'Stop'

$steamDir = Join-Path ${env:ProgramFiles(x86)} 'Steam'

function Stop-SteamProcesses {
    Stop-Service 'Steam Client Service' -Force -ErrorAction SilentlyContinue
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(steam|gameoverlayui|StarRupture|UnrealCEF|CrashReport|WerFault)' } | Stop-Process -Force -ErrorAction SilentlyContinue
}

# Removes $Path, retrying while something still holds it. True once it is gone.
function Remove-WithRetry([string]$Path, [int]$Seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $wait = 1
    while ($true) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
        if ([DateTime]::UtcNow -ge $deadline) { return $false }
        Start-Sleep -Seconds $wait
        $wait = [Math]::Min($wait * 2, 10)
        Stop-SteamProcesses
    }
}

# Best effort: names the processes with a module or an image under $Path.
function Get-Locker([string]$Path) {
    $found = @()
    foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
        try {
            $hit = ($p.Path -and $p.Path.StartsWith($Path, [StringComparison]::OrdinalIgnoreCase)) -or
                (@($p.Modules | Where-Object { $_.FileName.StartsWith($Path, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0)
            if ($hit) { $found += "$($p.ProcessName) (pid $($p.Id))" }
        } catch { Write-Verbose "cannot inspect $($p.ProcessName)" }
    }
    $handle = Get-Command handle.exe, handle64.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($handle) {
        $found += @(& $handle.Source -accepteula -nobanner $Path 2>$null | Where-Object { $_ -match ' pid: ' } | ForEach-Object { $_.Trim() } | Select-Object -First 5)
    }
    if ($found) { ($found | Select-Object -Unique) -join ', ' } else { 'not found' }
}

# Returns $true once every piece of the login is gone, $false (after naming them) if not.
function Remove-Login {
    Stop-SteamProcesses
    Start-Sleep -Seconds 5
    $targets = @('C:\steamcmd', (Join-Path $env:LOCALAPPDATA 'Steam'),
        (Join-Path $steamDir 'config'), (Join-Path $steamDir 'userdata'), (Join-Path $steamDir 'logs'))
    $targets += @(Get-ChildItem -LiteralPath $steamDir -Filter 'ssfn*' -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    $targets += @(Get-ChildItem -LiteralPath $steamDir -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -in 'config.vdf', 'loginusers.vdf' } | ForEach-Object { $_.FullName })
    foreach ($t in $targets) { $null = Remove-WithRetry $t 20 }
    # The saved login's registry entries, and the app id file the launch wrote.
    Remove-Item -LiteralPath 'HKCU:\Software\Valve' -Recurse -Force -ErrorAction SilentlyContinue
    if ($InstallDir -and (Test-Path -LiteralPath $InstallDir)) {
        Get-ChildItem -LiteralPath $InstallDir -Recurse -Filter steam_appid.txt -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    }
    # Verify every one is gone.
    $left = @($targets | Where-Object { Test-Path -LiteralPath $_ })
    if (Test-Path -LiteralPath 'HKCU:\Software\Valve') { $left += 'HKCU\Software\Valve' }
    if ($InstallDir -and (Test-Path -LiteralPath $InstallDir)) {
        $left += @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Filter steam_appid.txt -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    }
    if ($left) {
        # ssfn file names carry a number that may identify the account: print the pattern only.
        $shown = @($left | ForEach-Object { $_ -replace 'ssfn\d+', 'ssfn*' } | Select-Object -Unique)
        foreach ($l in $shown) { Write-Host "::error::$l could not be removed" }
        $reason = "The Steam login could not be removed from the runner ($($shown -join ', ')), so the extractor did not run."
        if ($env:RUNNER_TEMP) { Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'rig-reason.txt') -Value $reason -Encoding utf8 }
        return $false
    }
    Write-Host 'The Steam login is removed from the runner.'
    return $true
}

function Remove-Folder {
    Stop-SteamProcesses
    if (-not (Test-Path -LiteralPath $steamDir)) { 'The Steam folder is already gone.'; return }
    if (Remove-WithRetry $steamDir $FolderRetrySec) { 'The Steam folder is removed.'; return }
    Write-Host "::warning::$steamDir could not be removed after $FolderRetrySec s; held by: $(Get-Locker $steamDir). The login is already gone, so this is only leftover files."
}

if ($Phase -in 'All', 'Login') {
    if (-not (Remove-Login)) {
        # Defence in depth: still try the folder in the rig's one-step run.
        if ($Phase -eq 'All') { Remove-Folder }
        exit 1
    }
}
if ($Phase -eq 'Folder') { Remove-Folder }
if ($Phase -eq 'All') { Remove-Folder }
exit 0
