# Starts the installed dedicated server headless, waits for a world, copies the
# logs out and shuts the server down. It decides nothing: pass or fail is
# ci/verdict.ps1's job, run on what this script wrote to -OutDir.
#
# Written to -OutDir:
#   boot.json      timings, exit state, peak memory (the facts verdict.ps1 needs)
#   game.log       the engine log (StarRupture\Saved\Logs\StarRupture.log)
#   modloader.log  ModLoader\Logs\ModLoader.log, when the loader is installed

param(
    [Parameter(Mandatory)][string]$ServerRoot,
    [Parameter(Mandatory)][string]$OutDir,
    [string]$Label = 'boot',
    # Regex on the engine log (or ModLoader.log) that means "the world is up".
    [string]$ReadyRegex = 'ChimeraMain',
    [int]$TimeoutSec = 600,
    # Keep running this long after the ready line so late errors surface.
    [int]$SettleSec = 60,
    [string]$ExtraArgs = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$launcher = Join-Path $ServerRoot 'StarRuptureServerEOS.exe'
if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }
$shipping = Get-ChildItem -Path $ServerRoot -Recurse -Filter 'StarRuptureServerEOS-Win64-Shipping.exe' -File | Select-Object -First 1
if (-not $shipping) { throw "StarRuptureServerEOS-Win64-Shipping.exe not found under $ServerRoot" }
$exeDir = $shipping.DirectoryName
$gameLogDir = Join-Path $ServerRoot 'StarRupture\Saved\Logs'
$gameLog = Join-Path $gameLogDir 'StarRupture.log'
$mlLog = Join-Path $exeDir 'ModLoader\Logs\ModLoader.log'

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Fresh logs, so nothing from an earlier boot can satisfy a check.
if (Test-Path $gameLogDir) { Remove-Item (Join-Path $gameLogDir '*') -Recurse -Force -ErrorAction SilentlyContinue }
$mlLogDir = Join-Path $exeDir 'ModLoader\Logs'
if (Test-Path $mlLogDir) { Remove-Item (Join-Path $mlLogDir '*') -Recurse -Force -ErrorAction SilentlyContinue }

# Hosting guides: DSSettings.txt next to the launcher makes the server create
# (StartNewGame) or load a world by itself; without it the server waits for a
# client to pick one. All values are strings.
$dsSettings = @'
{
  "SessionName": "CiLab",
  "SaveGameInterval": "300",
  "StartNewGame": "true",
  "LoadSavedGame": "false",
  "SaveGameName": "AutoSave0.sav"
}
'@
Set-Content -Path (Join-Path $ServerRoot 'DSSettings.txt') -Value $dsSettings -Encoding ascii

function Read-SharedText([string]$Path) {
    if (-not (Test-Path $Path)) { return '' }
    try {
        $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite,Delete')
        try { $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8); return $sr.ReadToEnd() }
        finally { $fs.Dispose() }
    } catch { return '' }
}

$argLine = '-Log -port=7777'
if ($ExtraArgs) { $argLine = "$argLine $ExtraArgs" }
Write-Host "[$Label] starting: $launcher $argLine"
$start = Get-Date
$null = Start-Process -FilePath $launcher -ArgumentList $argLine -WorkingDirectory $ServerRoot -WindowStyle Hidden -PassThru

$proc = $null
$readySec = $null
$procSec = $null
$exitedEarly = $false
$exitCode = $null
$peakWs = 0
$readyLine = ''
$lastReport = 0
while ($true) {
    $t = [int]((Get-Date) - $start).TotalSeconds
    if (-not $proc) {
        $proc = Get-Process -Name 'StarRuptureServerEOS-Win64-Shipping' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc) { $procSec = $t; $null = $proc.Handle; Write-Host "[$Label] +${t}s shipping process PID $($proc.Id)" }
    }
    if ($proc) {
        $proc.Refresh()
        if ($proc.HasExited) { $exitedEarly = $true; $exitCode = $proc.ExitCode; Write-Host "[$Label] +${t}s process exited, code $exitCode"; break }
        if ($proc.WorkingSet64 -gt $peakWs) { $peakWs = $proc.WorkingSet64 }
    }
    $g = Read-SharedText $gameLog
    $m = Read-SharedText $mlLog
    if ($null -eq $readySec) {
        $hit = ($g + "`n" + $m) -split "`r?`n" | Where-Object { $_ -match $ReadyRegex } | Select-Object -First 1
        if ($hit) { $readySec = $t; $readyLine = $hit; Write-Host "[$Label] +${t}s ready line: $hit" }
    }
    if ($null -ne $readySec -and ($t - $readySec) -ge $SettleSec) { break }
    if ($t -ge $TimeoutSec) { Write-Host "[$Label] +${t}s timeout"; break }
    if ($t - $lastReport -ge 30) {
        $lastReport = $t
        $ws = if ($proc) { [int]($proc.WorkingSet64 / 1MB) } else { 0 }
        Write-Host ("[{0}] +{1}s game.log {2} B, ModLoader.log {3} B, working set {4} MB" -f $Label, $t, $g.Length, $m.Length, $ws)
    }
    Start-Sleep -Seconds 3
}

# Final read, then shut down. Closing the main window first gives the engine a
# chance to exit cleanly; whatever is left after 30 s is killed.
$aliveAtEnd = ($proc -and -not $proc.HasExited)
$g = Read-SharedText $gameLog
$m = Read-SharedText $mlLog
Set-Content -Path (Join-Path $OutDir 'game.log') -Value $g -Encoding utf8
Set-Content -Path (Join-Path $OutDir 'modloader.log') -Value $m -Encoding utf8

if ($proc -and -not $proc.HasExited) {
    $null = $proc.CloseMainWindow()
    if (-not $proc.WaitForExit(30000)) { Write-Host "[$Label] still running after 30 s, killing"; $proc.Kill(); $proc.WaitForExit(15000) | Out-Null }
}
Get-Process -Name 'StarRuptureServerEOS*' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }

# Crash dumps, if the engine wrote any.
$crashDir = Join-Path $ServerRoot 'StarRupture\Saved\Crashes'
$crashes = @()
if (Test-Path $crashDir) { $crashes = @(Get-ChildItem -Path $crashDir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($ServerRoot.Length) }) }

# Names and sizes of what the boot created (no contents), to learn the layout.
Write-Host "::group::[$Label] files created under Saved and ModLoader"
foreach ($d in @((Join-Path $ServerRoot 'StarRupture\Saved'), (Join-Path $exeDir 'ModLoader'))) {
    if (Test-Path $d) {
        Get-ChildItem -Path $d -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -notin '.dll' } |
            Select-Object -First 80 |
            ForEach-Object { Write-Host ("{0,12:N0}  {1}" -f $_.Length, $_.FullName.Substring($ServerRoot.Length)) }
    }
}
Write-Host '::endgroup::'

$result = [ordered]@{
    label            = $Label
    started_utc      = $start.ToUniversalTime().ToString('o')
    launched_args    = $argLine
    process_found    = ($null -ne $procSec)
    process_found_s  = $procSec
    ready_regex      = $ReadyRegex
    ready_s          = $readySec
    ready_line       = $readyLine
    exited_early     = $exitedEarly
    exit_code        = $exitCode
    alive_at_end     = [bool]$aliveAtEnd
    peak_working_set_mb = [int]($peakWs / 1MB)
    game_log_bytes   = $g.Length
    modloader_log_bytes = $m.Length
    crash_files      = $crashes
    shipping_exe     = $shipping.FullName.Substring($ServerRoot.Length)
}
$result | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $OutDir 'boot.json') -Encoding utf8
$result.GetEnumerator() | ForEach-Object { Write-Host ("{0,-22} {1}" -f $_.Key, $_.Value) }
