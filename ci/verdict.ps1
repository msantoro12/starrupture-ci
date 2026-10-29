# Judges one engine-test boot from what ci/boot-server.ps1 and the scanner step
# left in -OutDir. One line per check: name, PASS or FAIL, and the log line that
# proves it (or "missing"). Exits 1 when any check fails.
#
# A check passes only on positive evidence. A missing file, an empty log, a
# marker that never appeared or a value that does not parse all FAIL; nothing
# here defaults to pass.
#
# Expected files in -OutDir:
#   boot.json        boot-server.ps1 (process facts)
#   game.log         engine log
#   modloader.log    loader log
#   scanner.exit     exit code of sr-aobscan (0 = every required pattern OK)
#   scanner.txt      sr-aobscan output

param(
    [Parameter(Mandatory)][string]$OutDir,
    # Exact build tag compiled into the loader (/p:ModLoaderBuildTag).
    [Parameter(Mandatory)][string]$ExpectTag,
    # Plugin names that must report a "Plugin info" line.
    [Parameter(Mandatory)][string[]]$ExpectPlugins,
    # Same regex boot-server.ps1 waited for; re-checked here against the logs.
    [string]$ReadyRegex = 'LogLoad: Took [\d.]+ seconds to LoadMap\(/Game/Chimera/Maps/ChimeraMain/ChimeraMain\)'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$results = New-Object System.Collections.Generic.List[object]
function Add-Check([string]$Name, [bool]$Pass, [string]$Evidence) {
    if ([string]::IsNullOrWhiteSpace($Evidence)) { $Evidence = 'missing' }
    $results.Add([pscustomobject]@{ Name = $Name; Pass = $Pass; Evidence = $Evidence.Trim() })
}

function Read-Lines([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path)
    # Unary comma: keep an empty or one-line result an array through the pipeline.
    if ([string]::IsNullOrWhiteSpace($text)) { return , @() }
    return , @($text -split "`r?`n" | Where-Object { $_ -ne '' })
}

function First-Match($Lines, [string]$Regex) {
    if ($null -eq $Lines) { return $null }
    foreach ($l in $Lines) { if ($l -match $Regex) { return $l } }
    return $null
}

# ---- inputs ----------------------------------------------------------------
$boot = $null
$bootPath = Join-Path $OutDir 'boot.json'
if (Test-Path -LiteralPath $bootPath) {
    try { $boot = Get-Content -LiteralPath $bootPath -Raw | ConvertFrom-Json } catch { $boot = $null }
}
$ml = Read-Lines (Join-Path $OutDir 'modloader.log')
$game = Read-Lines (Join-Path $OutDir 'game.log')

Add-Check 'boot_record' ($null -ne $boot) $(if ($boot) { "boot.json parsed, label $($boot.label)" } else { '' })
Add-Check 'modloader_log_present' (($null -ne $ml) -and $ml.Count -gt 0) $(if ($ml -and $ml.Count -gt 0) { "$($ml.Count) lines" } else { '' })
Add-Check 'game_log_present' (($null -ne $game) -and $game.Count -gt 0) $(if ($game -and $game.Count -gt 0) { "$($game.Count) lines" } else { '' })

# ---- server process (boot.json) ---------------------------------------------
if ($boot) {
    Add-Check 'server_process_started' ([bool]$boot.process_found) "shipping process found after $($boot.process_found_s) s"
    # The server must still be running when the settle period ended: a process
    # that exited on its own (crash, clean exit before the world) is a fail.
    $alive = ([bool]$boot.alive_at_end) -and (-not [bool]$boot.exited_early)
    Add-Check 'server_alive_at_end' $alive "alive_at_end=$($boot.alive_at_end) exited_early=$($boot.exited_early) exit_code=$($boot.exit_code)"
    $crashes = @($boot.crash_files)
    Add-Check 'no_crash_files' ($crashes.Count -eq 0) $(if ($crashes.Count -eq 0) { 'Saved\Crashes empty or absent' } else { 'FOUND: ' + ($crashes -join '; ') })
} else {
    foreach ($n in 'server_process_started', 'server_alive_at_end', 'no_crash_files') { Add-Check $n $false '' }
}

# ---- loader ------------------------------------------------------------------
$buildLine = First-Match $ml 'Starting auto-update check \(current version: (.+?)\)'
$buildOk = $false
if ($buildLine -and $buildLine -match 'current version: (.+?)\)') { $buildOk = ($Matches[1] -ceq $ExpectTag) }
Add-Check 'loader_build_line' $buildOk $(if ($buildLine) { "$buildLine  (expected tag $ExpectTag)" } else { '' })

$serverLine = First-Match $ml 'Running server build of modloader'
Add-Check 'loader_server_build' ($null -ne $serverLine) $serverLine

$gv = First-Match $ml 'Game version OK:'
Add-Check 'game_version_ok' ($null -ne $gv) $gv

$pf = First-Match $ml '\[Preflight\] Pattern verification complete: (\d+)/(\d+) usable \((\d+) fatal, (\d+) non-fatal\)'
$pfOk = $false
if ($pf -and $pf -match 'complete: (\d+)/(\d+) usable \((\d+) fatal, (\d+) non-fatal\)') {
    $found = [int]$Matches[1]; $total = [int]$Matches[2]; $fatal = [int]$Matches[3]; $nonFatal = [int]$Matches[4]
    $pfOk = ($total -gt 0) -and ($found -eq $total) -and ($fatal -eq 0) -and ($nonFatal -eq 0)
}
Add-Check 'preflight_all_usable' $pfOk $pf

$pfPassed = First-Match $ml '\[init\] Pattern preflight passed in'
Add-Check 'preflight_passed_line' ($null -ne $pfPassed) $pfPassed

$hooks = First-Match $ml '\[init\] Engine hooks installed in'
Add-Check 'engine_hooks_installed' ($null -ne $hooks) $hooks

# A failed preflight on a server logs these and lets the game start unmodified.
$disabled = First-Match $ml 'Starting the game unmodified|mod loader disabled|Pattern preflight FAILED'
Add-Check 'loader_not_disabled' ($null -eq $disabled -and $null -ne $ml -and $ml.Count -gt 0) $(if ($disabled) { "FOUND: $disabled" } elseif ($ml -and $ml.Count -gt 0) { 'no disable line' } else { '' })

# ---- plugins -----------------------------------------------------------------
foreach ($p in $ExpectPlugins) {
    $esc = [regex]::Escape($p)
    $info = First-Match $ml "Plugin info - Name: $esc,"
    Add-Check "plugin_info_$p" ($null -ne $info) $info
    $loaded = First-Match $ml "Successfully loaded plugin DLL: $esc "
    Add-Check "plugin_loaded_$p" ($null -ne $loaded) $loaded
}

# A plugin whose PluginInit returns false is logged at INFO level, so the error
# check below cannot see it. The summary counts must show no failures.
foreach ($p in $ExpectPlugins) {
    $badInit = First-Match $ml ('Plugin initialization failed: ' + [regex]::Escape($p))
    Add-Check "plugin_init_$p" (($null -ne $ml) -and $ml.Count -gt 0 -and $null -eq $badInit) $(if ($badInit) { "FOUND: $badInit" } elseif ($ml -and $ml.Count -gt 0) { 'no init failure line' } else { '' })
}
$sums = @()
if ($ml) { $sums = @($ml | Where-Object { $_ -match 'InitAllLoadedPlugins: (\d+) initialized, (\d+) failed' }) }
$sumOk = $false; $sumEv = ''
if ($sums.Count -gt 0) {
    $maxInit = 0; $anyFail = $false
    foreach ($l in $sums) {
        if ($l -match 'InitAllLoadedPlugins: (\d+) initialized, (\d+) failed') {
            $maxInit = [Math]::Max($maxInit, [int]$Matches[1])
            if ([int]$Matches[2] -gt 0) { $anyFail = $true }
        }
    }
    $sumOk = (-not $anyFail) -and ($maxInit -ge @($ExpectPlugins).Count)
    $sumEv = "$($sums[-1])  (max initialized $maxInit, expected at least $(@($ExpectPlugins).Count))"
}
Add-Check 'plugins_initialized' $sumOk $sumEv

# ---- errors and crashes -------------------------------------------------------
$errLines = @()
# Known loader behaviour on the server, not a regression: the delegate hook resolves
# class 'World' before GObjects is filled, logs ERROR, and falls back (the hook installs
# later, see the Resolve UFunction warnings). Seen on a clean run before any plugin loads.
$knownBenign = @("ResolveUFunction: class 'World' not found in GObjects")
if ($ml) {
    $errLines += @($ml | Where-Object {
        ($_ -match '^\[[\d:.]+\]\s+\[ERROR\s*\]' -or $_ -match 'CRASHED') -and
        -not ($knownBenign | Where-Object { $_.Contains($_) -and $true } | Out-Null)
    })
}
Add-Check 'no_loader_errors' (($null -ne $ml) -and $ml.Count -gt 0 -and $errLines.Count -eq 0) $(
    if ($errLines.Count -gt 0) { "$($errLines.Count) found, first: $($errLines[0])" } elseif ($ml -and $ml.Count -gt 0) { 'no ERROR or CRASHED line in ModLoader.log' } else { '' })

$gameFatal = $null
if ($game) { $gameFatal = First-Match $game 'Fatal error|Unhandled Exception|Assertion failed|Critical error|EXCEPTION_ACCESS_VIOLATION|appError' }
Add-Check 'no_engine_fatal' (($null -ne $game) -and $game.Count -gt 0 -and $null -eq $gameFatal) $(
    if ($gameFatal) { "FOUND: $gameFatal" } elseif ($game -and $game.Count -gt 0) { 'no fatal/crash marker in the engine log' } else { '' })

# ---- world -------------------------------------------------------------------
# Evidence is re-read from the logs here, not taken from boot.json.
# Both must hold: the boot script saw the ready line before its timeout, and the
# logs themselves contain it.
$world = First-Match $ml $ReadyRegex
if (-not $world) { $world = First-Match $game $ReadyRegex }
$bootReady = ($null -ne $boot) -and ($null -ne $boot.ready_s)
$readyS = if ($boot) { $boot.ready_s } else { 'n/a' }
Add-Check 'world_reached' (($null -ne $world) -and $bootReady) $(if ($world) { "$world  (regex $ReadyRegex; boot ready_s=$readyS)" } else { '' })

# ---- offline scanner -----------------------------------------------------------
$exitPath = Join-Path $OutDir 'scanner.exit'
$scanExit = $null
if (Test-Path -LiteralPath $exitPath) { $raw = (Get-Content -LiteralPath $exitPath -Raw).Trim(); if ($raw -match '^\d+$') { $scanExit = [int]$raw } }
$scanLines = Read-Lines (Join-Path $OutDir 'scanner.txt')
$scanTail = if ($scanLines -and $scanLines.Count -gt 0) { $scanLines[-1] } else { '' }
Add-Check 'scanner_exit_zero' ($scanExit -eq 0) $(if ($null -ne $scanExit) { "exit $scanExit; last line: $scanTail" } else { '' })

# ---- report --------------------------------------------------------------------
$failed = @($results | Where-Object { -not $_.Pass })
$lines = foreach ($r in $results) { '{0,-26} {1,-4} {2}' -f $r.Name, $(if ($r.Pass) { 'PASS' } else { 'FAIL' }), $r.Evidence }
$lines | ForEach-Object { Write-Host $_ }
$overall = if ($failed.Count -eq 0) { 'PASS' } else { "FAIL ($($failed.Count) of $($results.Count) checks)" }
Write-Host "VERDICT: $overall"

if ($env:GITHUB_STEP_SUMMARY) {
    $md = New-Object System.Collections.Generic.List[string]
    $md.Add("### Engine test verdict: $overall")
    $md.Add('')
    $md.Add('| Check | Result | Evidence |')
    $md.Add('|---|---|---|')
    foreach ($r in $results) {
        $ev = ($r.Evidence -replace '\|', '\|') -replace '`', "'"
        $md.Add(('| {0} | {1} | `{2}` |' -f $r.Name, $(if ($r.Pass) { 'PASS' } else { 'FAIL' }), $ev))
    }
    $md -join "`n" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
}
Set-Content -LiteralPath (Join-Path $OutDir 'verdict.txt') -Value (@($lines) + "VERDICT: $overall") -Encoding utf8

if ($failed.Count -gt 0) { exit 1 }
exit 0
