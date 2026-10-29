# Fixture tests for verdict.ps1: a good boot passes, and each way a boot can go
# wrong (missing file, empty log, missing marker, bad value) must fail.
$ErrorActionPreference = 'Stop'
$verdict = Join-Path $PSScriptRoot 'verdict.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) 'verdict-cases'
if (Test-Path $root) { Remove-Item $root -Recurse -Force }
New-Item -ItemType Directory $root | Out-Null
$tag = 'v0.0.0-cilab.7'

$ml = @(
'[16:51:04.116] [INFO ] [T:01484] OS version: Windows 10 or greater',
'[16:51:04.170] [INFO ] [T:01484] [ModLoader] Game version OK: ++Earth20+Neon-CL-127004',
'[16:51:04.172] [INFO ] [T:01484] [init] Pattern preflight starting...',
'[16:51:17.700] [INFO ] [T:01484] [ModLoader] [Preflight] Pattern verification complete: 31/31 usable (0 fatal, 0 non-fatal)',
'[16:51:17.701] [INFO ] [T:01484] [init] Pattern preflight passed in 13500 ms',
'[16:51:17.710] [INFO ] [T:01484] [init] Engine hooks installed in 12 ms',
'[16:51:17.723] [INFO ] [T:01484] [ModLoader] Running server build of modloader',
"[16:51:37.031] [INFO ] [T:45484] [AutoUpdate] Starting auto-update check (current version: $tag)",
'[16:51:40.164] [INFO ] [T:01484] [ModLoader] Loading plugin: C:\srds\Waila.dll',
'[16:51:40.166] [INFO ] [T:01484] [ModLoader] Plugin info - Name: Waila, Version: v0.19.0, Author: AlienX, Interface: 70 (modloader expects [70, 70])',
'[16:51:40.166] [INFO ] [T:01484] [ModLoader] Successfully loaded plugin DLL: Waila vv0.19.0 (PluginInit deferred)',
'[16:51:41.000] [INFO ] [T:75664] [ModLoader] InitAllLoadedPlugins: 1 initialized, 0 failed (of 1 deferred)',
"[16:52:03.427] [INFO ] [T:75664] [Plugin:Compass] OnAnyWorldBeginPlay: 'ChimeraMain' -- loading"
)
$game = @('[2026.10.29-16.51.00:000][  0]LogInit: Build: ++Earth20+Neon-CL-127004', '[2026.10.29-16.52.03:100][  0]LogWorld: Bringing World /Game/Maps/ChimeraMain up for play')
$boot = [ordered]@{ label='full'; process_found=$true; process_found_s=6; ready_s=90; ready_line='x'; exited_early=$false; exit_code=$null; alive_at_end=$true; crash_files=@() }

function New-Case([string]$Name, [scriptblock]$Mutate) {
    $d = Join-Path $root $Name; New-Item -ItemType Directory $d | Out-Null
    $c = @{ ml = [string[]]$ml; game = [string[]]$game; boot = ($boot | ConvertTo-Json -Depth 3 | ConvertFrom-Json); exit = '0'; scan = 'OK 31/31 patterns' ; skip = @() }
    & $Mutate $c
    if ('ml' -notin $c.skip) { Set-Content (Join-Path $d 'modloader.log') $c.ml -Encoding utf8 }
    if ('game' -notin $c.skip) { Set-Content (Join-Path $d 'game.log') $c.game -Encoding utf8 }
    if ('boot' -notin $c.skip) { $c.boot | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $d 'boot.json') -Encoding utf8 }
    if ('exit' -notin $c.skip) { Set-Content (Join-Path $d 'scanner.exit') $c.exit -Encoding ascii }
    if ('scan' -notin $c.skip) { Set-Content (Join-Path $d 'scanner.txt') $c.scan -Encoding utf8 }
    $shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
    $out = & $shell -NoProfile -File $verdict -OutDir $d -ExpectTag $tag -ExpectPlugins Waila 2>&1
    [pscustomobject]@{ Case=$Name; Exit=$LASTEXITCODE; Out=($out -join "`n") }
}

$cases = [ordered]@{
 'good'                   = { param($c) }
 'ml_missing'             = { param($c) $c.skip += 'ml' }
 'ml_empty'               = { param($c) $c.ml = @() }
 'game_missing'           = { param($c) $c.skip += 'game' }
 'boot_missing'           = { param($c) $c.skip += 'boot' }
 'scanner_exit_missing'   = { param($c) $c.skip += 'exit' }
 'scanner_exit_1'         = { param($c) $c.exit = '1' }
 'scanner_exit_garbage'   = { param($c) $c.exit = 'oops' }
 'wrong_tag'              = { param($c) $c.ml = $c.ml -replace 'cilab\.7', 'cilab.6' }
 'tag_dev'                = { param($c) $c.ml = $c.ml -replace 'version: v0\.0\.0-cilab\.7', 'version: dev' }
 'no_preflight_complete'  = { param($c) $c.ml = $c.ml | Where-Object { $_ -notmatch 'verification complete' } }
 'preflight_fatal'        = { param($c) $c.ml = $c.ml -replace '31/31 usable \(0 fatal, 0 non-fatal\)', '30/31 usable (1 fatal, 0 non-fatal)' }
 'preflight_nonfatal'     = { param($c) $c.ml = $c.ml -replace '31/31 usable \(0 fatal, 0 non-fatal\)', '30/31 usable (0 fatal, 1 non-fatal)' }
 'preflight_zero_total'   = { param($c) $c.ml = $c.ml -replace '31/31 usable \(0 fatal, 0 non-fatal\)', '0/0 usable (0 fatal, 0 non-fatal)' }
 'unmodified_start'       = { param($c) $c.ml += '[16:51:20.000] [ERROR] [T:01484] [init] Starting the game unmodified' }
 'plugin_info_missing'    = { param($c) $c.ml = $c.ml | Where-Object { $_ -notmatch 'Plugin info' } }
 'plugin_wrong_name'      = { param($c) $c.ml = $c.ml -replace 'Name: Waila,', 'Name: Wailaa,' }
 'plugin_not_loaded'      = { param($c) $c.ml = $c.ml | Where-Object { $_ -notmatch 'Successfully loaded' } }
 'error_line'             = { param($c) $c.ml += '[16:53:00.000] [ERROR] [T:01484] [ModLoader] something broke' }
 'plugin_crashed'         = { param($c) $c.ml += "[16:53:00.000] [WARN ] [T:01484] [PluginManager] Plugin 'Waila' CRASHED during init" }
 'engine_fatal'           = { param($c) $c.game += '[2026.10.29-16.54.00:000]Fatal error: [File:X] [Line: 1]' }
 'no_world'               = { param($c) $c.ml = $c.ml | Where-Object { $_ -notmatch 'ChimeraMain' }; $c.game = @('[x]LogInit: Build') }
 'world_in_game_only'     = { param($c) $c.ml = $c.ml | Where-Object { $_ -notmatch 'ChimeraMain' } }
 'process_not_found'      = { param($c) $c.boot.process_found = $false }
 'exited_early'           = { param($c) $c.boot.exited_early = $true; $c.boot.alive_at_end = $false; $c.boot.exit_code = 3 }
 'crash_files'            = { param($c) $c.boot.crash_files = @('StarRupture\Saved\Crashes\crash1\UE4Minidump.dmp') }
 'no_build_line'          = { param($c) $c.ml = $c.ml | Where-Object { $_ -notmatch 'auto-update check' } }
 'plugin_init_failed'     = { param($c) $c.ml += '[16:51:41.100] [INFO ] [T:75664] [ModLoader] Plugin initialization failed: Waila' }
 'init_summary_failed'    = { param($c) $c.ml = $c.ml -replace '1 initialized, 0 failed', '0 initialized, 1 failed' }
 'init_summary_missing'   = { param($c) $c.ml = $c.ml | Where-Object { $_ -notmatch 'InitAllLoadedPlugins' } }
 'boot_ready_timeout'     = { param($c) $c.boot.ready_s = $null }
 'no_server_build'        = { param($c) $c.ml = $c.ml | Where-Object { $_ -notmatch 'server build' } }
}
$expectPass = @('good', 'world_in_game_only')
$bad = 0
foreach ($k in $cases.Keys) {
    $r = New-Case $k $cases[$k]
    $want = if ($k -in $expectPass) { 0 } else { 1 }
    $ok = ($r.Exit -eq $want)
    if (-not $ok) { $bad++ }
    $failed = ($r.Out -split "`n" | Where-Object { $_ -match ' FAIL ' } | ForEach-Object { ($_ -split '\s+')[0] }) -join ','
    '{0,-24} exit={1} want={2} {3}  failed: {4}' -f $k, $r.Exit, $want, $(if ($ok) { 'OK ' } else { 'BAD' }), $failed
}
"mismatches: $bad"
if ($bad -gt 0) { exit 1 }
