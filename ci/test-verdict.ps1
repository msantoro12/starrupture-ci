# Fixture tests for verdict.ps1: a good boot passes, and each way a boot can go
# wrong (missing file, empty log, missing marker, bad value) must fail. Server mode
# first (engine-test), then client mode (the client test rig).
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
$game = @('[2026.10.29-16.51.00:000][  0]LogInit: Build: ++Earth20+Neon-CL-127004', '[2026.10.29-16.52.03:100][  0]LogLoad: Took 3.811666 seconds to LoadMap(/Game/Chimera/Maps/ChimeraMain/ChimeraMain)')
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
 'world_start_map_only'   = { param($c) $c.game = @('[x]LogInit: Build', '[x]LogOnlineSession: EOS: EOS_SessionModification_AddAttribute() named (MapName) with value (/Game/Chimera/Maps/ChimeraMain/ChimeraMain)', '[x]LogLoad: Took 6.855587 seconds to LoadMap(/Game/Chimera/Maps/DedicatedServerStart)') }
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
 'compat_report_line'     = { param($c) $c.ml += '[16:53:00.000] [INFO ] [T:01484] [ModLoader] [LayoutCheck] Compatibility report written to ModLoader\compat-report-128786.json' }
 'compat_report_listed'   = { param($c) $c.boot | Add-Member -NotePropertyName compat_reports -NotePropertyValue @('compat-report-128786.json') -Force }
 'plugins_switched_off'   = { param($c) $c.ml += '[16:53:00.000] [ERROR] [T:01484] [init] Layout mismatch -- plugins are switched off for this session' }
}
# Cases that must fail one particular check, not just exit 1.
$serverMustFail = @{ compat_report_line = 'no_compat_report'; compat_report_listed = 'no_compat_report'; plugins_switched_off = 'plugins_not_switched_off' }
$expectPass = @('good', 'world_in_game_only')
$bad = 0
foreach ($k in $cases.Keys) {
    $r = New-Case $k $cases[$k]
    $want = if ($k -in $expectPass) { 0 } else { 1 }
    $ok = ($r.Exit -eq $want)
    if (-not $ok) { $bad++ }
    $failed = ($r.Out -split "`n" | Where-Object { $_ -match ' FAIL ' } | ForEach-Object { ($_ -split '\s+')[0] }) -join ','
    if ($ok -and $serverMustFail.ContainsKey($k) -and (($failed -split ',') -notcontains $serverMustFail[$k])) { $ok = $false; $bad++ }
    '{0,-24} exit={1} want={2} {3}  failed: {4}' -f $k, $r.Exit, $want, $(if ($ok) { 'OK ' } else { 'BAD' }), $failed
}

# ---- client mode ---------------------------------------------------------------
# The clean fixture is fixtures\client: the logs of a real nine-plugin launch of the
# public build (loader v1.23.1, overlay off), trimmed to the lines the judge reads and
# scrubbed of nothing because they held nothing private. dll-hashes.json holds
# hashes derived from the file names, not real ones. Each case below starts from it,
# changes one thing, and must fail the check named in $clientMustFail.
$fx = Join-Path (Join-Path $PSScriptRoot 'fixtures') 'client'
function Read-FxLines([string]$n) { [string[]](Get-Content -LiteralPath (Join-Path $fx $n) -Encoding UTF8) }
function Read-FxJson([string]$n) { Get-Content -LiteralPath (Join-Path $fx $n) -Raw -Encoding UTF8 | ConvertFrom-Json }
function Drop($c, [string]$re) { $c.ml = @($c.ml | Where-Object { $_ -notmatch $re }) }
function Plugin($c, [string]$repo) { $c.set.plugins | Where-Object { $_.repo -eq $repo } }

function New-ClientCase([string]$Name, [scriptblock]$Mutate) {
    $d = Join-Path $root "client-$Name"; New-Item -ItemType Directory $d | Out-Null
    $c = @{
        ml = Read-FxLines 'modloader.log'; proxy = Read-FxLines 'proxy.log'; au = Read-FxLines 'autoupdate.log'
        boot = Read-FxJson 'boot.json'; set = Read-FxJson 'set.json'; hashes = Read-FxJson 'dll-hashes.json'
        skip = @()
    }
    & $Mutate $c
    foreach ($f in @(@('ml', 'modloader.log'), @('proxy', 'proxy.log'), @('au', 'autoupdate.log'))) {
        if ($f[0] -notin $c.skip) { Set-Content (Join-Path $d $f[1]) $c[$f[0]] -Encoding utf8 }
    }
    foreach ($f in @(@('boot', 'boot.json'), @('set', 'set.json'), @('hashes', 'dll-hashes.json'))) {
        if ($f[0] -notin $c.skip) { $c[$f[0]] | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $d $f[1]) -Encoding utf8 }
    }
    $shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
    $out = & $shell -NoProfile -File $verdict -OutDir $d -Client 2>&1
    [pscustomobject]@{ Case = $Name; Exit = $LASTEXITCODE; Out = ($out -join "`n"); Dir = $d }
}

# The feed-path rig: set.json names the feed the run seeded, and the loader logs it applied
# just before the game version gate. The fixture's build is CL 127004.
function Seed-Feed($c, $Seq = 41, $Cl = 127004, [string]$Line = '', [switch]$AfterGate) {
    $c.set | Add-Member -NotePropertyName feed -NotePropertyValue ([pscustomobject]@{ seq = $Seq; cl = $Cl }) -Force
    if (-not $Line) { $Line = "[07:13:48.640] [INFO ] [T:03432] [VersionFeed] Feed seq $Seq (key k1, TEST KEY): 12 rows from the feed, 0 discarded (0 clashed with the loader's map on this exe, 0 absent rows filled, 0 scoped rows without fp dropped)" }
    if ($AfterGate) { $c.ml += $Line; return }
    $i = [array]::IndexOf($c.ml, ($c.ml | Where-Object { $_ -match 'Game version OK:' } | Select-Object -First 1))
    $c.ml = @($c.ml[0..($i - 1)]) + @($Line) + @($c.ml[$i..($c.ml.Count - 1)])
}
$vf = '[07:13:48.700] [WARN ] [T:03432] [VersionFeed] '

$sig = '[00:00:01.000] [WARN ] [T:03432] [ModLoader] '
$err = '[00:00:01.000] [ERROR] [T:03432] [ModLoader] '
$clientCases = [ordered]@{
 'good'                    = @{ Mut = { param($c) } }
 # Plugin missing, wrong, refused, crashed
 'plugin_lines_missing'    = @{ Mut = { param($c) Drop $c 'Waila' };                                                       Fail = 'plugin_loaded_WAILA' }
 'plugin_removed'          = @{ Mut = { param($c) (Plugin $c 'WAILA').removed = $true; Drop $c 'Waila' };                 Fail = 'plugin_loaded_WAILA' }
 'plugin_info_only'        = @{ Mut = { param($c) Drop $c 'Successfully loaded plugin DLL: Waila ' };                     Fail = 'plugin_loaded_WAILA' }
 'log_name_is_repo_name'   = @{ Mut = { param($c) (Plugin $c 'WAILA').PSObject.Properties.Remove('logName') };            Fail = 'plugin_loaded_WAILA' }
 'rupture_timer_repo_name' = @{ Mut = { param($c) (Plugin $c 'RuptureTimer').PSObject.Properties.Remove('logName') };     Fail = 'plugin_loaded_RuptureTimer' }
 'plugin_older_version'    = @{ Mut = { param($c) $c.ml = $c.ml -replace 'Name: Waila, Version: v0\.20\.0', 'Name: Waila, Version: v0.19.0' }; Fail = 'plugin_version_WAILA' }
 'plugin_version_no_v'     = @{ Mut = { param($c) $c.ml = $c.ml -replace 'Name: Waila, Version: v0\.20\.0', 'Name: Waila, Version: 0.20.0' }; Fail = 'plugin_version_WAILA' }
 'plugin_version_dev'      = @{ Mut = { param($c) $c.ml = $c.ml -replace 'Name: Waila, Version: v0\.20\.0', 'Name: Waila, Version: dev' }; Fail = 'plugin_version_WAILA' }
 'refused_not_loaded'      = @{ Mut = { param($c) $c.ml += "$($sig)Plugin 'Codex' is not loaded: Needs an update to run on CL-128786" };  Fail = 'plugin_not_refused_Codex' }
 'refused_was_NOT_loaded'  = @{ Mut = { param($c) $c.ml += "$($sig)Plugin 'Codex' was NOT loaded: it declares layouts the game no longer has" }; Fail = 'plugin_not_refused_Codex' }
 'refused_wrong_target'    = @{ Mut = { param($c) $c.ml += "$($sig)Plugin 'Waila' was built for a server build but this is a client build -- refusing to load" }; Fail = 'plugin_not_refused_WAILA' }
 'refused_hooks'           = @{ Mut = { param($c) $c.ml += "$($err)Plugin 'Waila' was NOT loaded: one or more of its hooks could not be resolved." }; Fail = 'plugin_not_refused_WAILA' }
 'refused_switched_off'    = @{ Mut = { param($c) $c.ml += "$($sig)Plugin 'Waila' is switched off: its layouts do not match this game" };  Fail = 'plugin_not_refused_WAILA' }
 'refused_interface_newer' = @{ Mut = { param($c) $c.ml += "$($sig)Plugin interface version 80 is newer than this loader supports (up to 75): D:\g\ModLoader\Plugins\Waila.dll" }; Fail = 'plugin_not_refused_WAILA' }
 'refused_missing_exports' = @{ Mut = { param($c) $c.ml += "$($sig)Plugin missing required exports: D:\g\ModLoader\Plugins\Compass_Plugin.dll" }; Fail = 'plugin_not_refused_Compass' }
 'refused_path_unknown'    = @{ Mut = { param($c) $c.ml += "$($sig)Plugin missing required exports: D:\g\ModLoader\Plugins\Mystery.dll" }; Fail = 'no_unexpected_refusal' }
 'refused_plugin_unlisted' = @{ Mut = { param($c) $c.ml += "$($sig)Plugin 'StarRuptureTimer' is not loaded: Needs an update to run on CL-127004" }; Fail = 'no_unexpected_refusal' }
 'plugin_crashed'          = @{ Mut = { param($c) $c.ml += "$($err)[PluginManager] Plugin 'Waila' CRASHED in its tick callback -- code=0xC0000005 fault=0x7FF700001234" }; Fail = 'plugin_no_fault_WAILA' }
 # A plugin the set does not name must not load, whichever way the set falls short
 'unexpected_plugin'       = @{ Mut = { param($c)
        $i = [array]::IndexOf($c.ml, ($c.ml | Where-Object { $_ -match 'Successfully loaded plugin DLL: Codex ' } | Select-Object -First 1))
        $add = @("$($sig)Plugin info - Name: Evil, Version: v6.6.6, Author: X, Interface: 75 (modloader expects [70, 75]), game build CL-127004",
                 "$($sig)Successfully loaded plugin DLL: Evil vv6.6.6 (PluginInit deferred)")
        $c.ml = @($c.ml[0..$i]) + $add + @($c.ml[($i + 1)..($c.ml.Count - 1)]) };                                              Fail = 'no_unexpected_plugin' }
 'set_names_one_plugin'    = @{ Mut = { param($c) $c.set.plugins = @($c.set.plugins | Select-Object -First 1) };               Fail = 'no_unexpected_plugin' }
 'init_summary_more'       = @{ Mut = { param($c) $c.ml = $c.ml -replace '9 initialized, 0 failed \(of 9', '10 initialized, 0 failed (of 10' }; Fail = 'plugins_initialized' }
 'plugin_init_failed'      = @{ Mut = { param($c) $c.ml += "$($sig)Plugin initialization failed: Waila" };                  Fail = 'plugin_no_fault_WAILA' }
 'plugin_not_initialized'  = @{ Mut = { param($c) Drop $c 'Plugin initialized: Waila$' };                                  Fail = 'plugin_initialized_WAILA' }
 # Declared refusals
 'expect_refused_loaded'   = @{ Mut = { param($c) (Plugin $c 'Compass').expectRefused = $true };                           Fail = 'plugin_not_loaded_Compass' }
 'expect_refused_no_line'  = @{ Mut = { param($c) (Plugin $c 'Compass').expectRefused = $true; Drop $c 'Compass' };       Fail = 'plugin_refusal_line_Compass' }
 'expect_refused_ok'       = @{ Mut = { param($c)
        (Plugin $c 'Compass').expectRefused = $true; Drop $c 'Compass'
        $c.ml += "$($sig)Plugin 'Compass' is not loaded: Needs an update to run on CL-128786"
        $c.ml = $c.ml -replace '9 initialized, 0 failed \(of 9 deferred\)', '8 initialized, 0 failed (of 8 deferred)' } }
 # A declared refusal excuses the refusal lines only, never a fault of the same plugin
 'refused_but_faulted'     = @{ Mut = { param($c)
        (Plugin $c 'Compass').expectRefused = $true; Drop $c 'Compass'
        $c.ml += "$($err)Plugin 'Compass' is not loaded: Needs an update to run on CL-128786"
        $c.ml += "$($err)[PluginGuard] Fault (code=0xC0000005 at 00007FF7A6224989) under plugin 'Compass', in its tick callback, raised in engine or loader code: not contained"
        $c.ml = $c.ml -replace '9 initialized, 0 failed \(of 9 deferred\)', '8 initialized, 0 failed (of 8 deferred)' }; Fail = 'plugin_no_fault_Compass' }
 'refused_but_crashed'     = @{ Mut = { param($c)
        (Plugin $c 'Compass').expectRefused = $true; Drop $c 'Compass'
        $c.ml += "$($err)Plugin 'Compass' was NOT loaded: one or more of its hooks could not be resolved."
        $c.ml += "$($err)[PluginManager] Plugin 'Compass' CRASHED in its tick callback -- code=0xC0000005 fault=0x7FF700001234"
        $c.ml = $c.ml -replace '9 initialized, 0 failed \(of 9 deferred\)', '8 initialized, 0 failed (of 8 deferred)' }; Fail = 'no_crash_markers' }
 'expect_refused_error_ok' = @{ Mut = { param($c)
        (Plugin $c 'Compass').expectRefused = $true; Drop $c 'Compass'
        $c.ml += "$($err)Plugin 'Compass' was NOT loaded: one or more of its hooks could not be resolved."
        $c.ml += "$($err)[HookScan] 'Compass' will NOT be loaded -- PluginInit will not be called."
        $c.ml = $c.ml -replace '9 initialized, 0 failed \(of 9 deferred\)', '8 initialized, 0 failed (of 8 deferred)' } }
 # Loader and layout
 'loader_older'            = @{ Mut = { param($c) $c.ml = $c.ml -replace 'Build: v1\.23\.1 \(client\)', 'Build: v1.23.0 (client)' }; Fail = 'loader_build_line' }
 'loader_dev'              = @{ Mut = { param($c) $c.ml = $c.ml -replace 'Build: v1\.23\.1 \(client\)', 'Build: dev (client)' };    Fail = 'loader_build_line' }
 'loader_server_build'     = @{ Mut = { param($c) $c.ml = $c.ml -replace 'Build: v1\.23\.1 \(client\)', 'Build: v1.23.1 (server)' }; Fail = 'loader_build_line' }
 'preflight_fatal'         = @{ Mut = { param($c) $c.ml = $c.ml -replace '65/65 usable \(0 fatal, 0 non-fatal\)', '64/65 usable (1 fatal, 0 non-fatal)' }; Fail = 'preflight_all_usable' }
 'preflight_missing'       = @{ Mut = { param($c) Drop $c 'verification complete' };                                       Fail = 'preflight_all_usable' }
 'preflight_failed_line'   = @{ Mut = { param($c) $c.ml += "$($err)[init] Pattern preflight failed -- mod loader disabled" }; Fail = 'loader_not_disabled' }
 'version_mismatch'        = @{ Mut = { param($c) $c.ml += "$($err)[ModLoader] VERSION MISMATCH: expected 'a', got 'b'" }; Fail = 'loader_not_disabled' }
 'hookscan_failed'         = @{ Mut = { param($c) $c.ml += "$($err)[HookScan] Plugin 'Waila' (hooks): 6 resolved, 2 failed" };  Fail = 'hookscan_clean' }
 'hookscan_not_loaded'     = @{ Mut = { param($c) $c.ml += "$($err)[HookScan] 'Waila' will NOT be loaded -- PluginInit will not be called." }; Fail = 'hookscan_clean' }
 'layout_mismatch'         = @{ Mut = { param($c) $c.ml = $c.ml -replace '159 checked, 0 mismatched', '159 checked, 3 mismatched' }; Fail = 'layout_ok' }
 'layout_missing_classes'  = @{ Mut = { param($c) $c.ml = $c.ml -replace '0 missing', '2 missing' };                        Fail = 'layout_ok' }
 'layout_line_missing'     = @{ Mut = { param($c) Drop $c 'SDK CL 127004 against' };                                       Fail = 'layout_ok' }
 'layout_plugins_off'      = @{ Mut = { param($c) $c.ml += "$($err)[init] Layout mismatch -- plugins are switched off for this session" }; Fail = 'plugins_not_switched_off' }
 'compat_report_line'      = @{ Mut = { param($c) $c.ml += "$($sig)[LayoutCheck] Compatibility report written to ModLoader\compat-report-128786.json" }; Fail = 'compat_report_ok' }
 'compat_report_listed'    = @{ Mut = { param($c) $c.boot.compat_reports = @('compat-report-128786.json') };               Fail = 'compat_report_ok' }
 # Crashes
 'fatal_engine_crash'      = @{ Mut = { param($c) $c.ml += "$($err)[CrashReporter] *** FATAL ENGINE CRASH *** -- suppressing CrashReportClient upload" }; Fail = 'no_crash_markers' }
 'pluginguard_fault'       = @{ Mut = { param($c) $c.ml += "$($err)[PluginGuard] Fault (code=0xC0000005 at 00007FF7A6224989) under plugin 'ProductionViewer', in its tick callback, raised in engine or loader code: not contained" }; Fail = 'no_crash_markers' }
 'crash_dialog'            = @{ Mut = { param($c) $c.boot.crash_dialog = 'The game has crashed' };                         Fail = 'no_crash_dialog' }
 'crash_files'             = @{ Mut = { param($c) $c.boot.crash_files = @('StarRupture\Saved\Crashes\crash1\UE4Minidump.dmp') }; Fail = 'no_crash_files' }
 # A boot.json that lacks a field is no evidence of a clean run
 'boot_no_crash_files'     = @{ Mut = { param($c) $c.boot.PSObject.Properties.Remove('crash_files') };                        Fail = 'no_crash_files' }
 'boot_no_crash_dialog'    = @{ Mut = { param($c) $c.boot.PSObject.Properties.Remove('crash_dialog') };                       Fail = 'no_crash_dialog' }
 'boot_no_compat_reports'  = @{ Mut = { param($c) $c.boot.PSObject.Properties.Remove('compat_reports') };                     Fail = 'compat_report_ok' }
 'early_exit_zero'         = @{ Mut = { param($c) $c.boot.exited_early = $true; $c.boot.alive_at_end = $false; $c.boot.exit_code = 0 }; Fail = 'client_alive_at_end' }
 'early_exit_nonzero'      = @{ Mut = { param($c) $c.boot.exited_early = $true; $c.boot.alive_at_end = $false; $c.boot.exit_code = 53 }; Fail = 'client_alive_at_end' }
 'process_not_found'       = @{ Mut = { param($c) $c.boot.process_found = $false };                                        Fail = 'client_process_started' }
 'unexpected_error'        = @{ Mut = { param($c) $c.ml += "$($err)[ImGuiBackend] D3D12CreateDevice failed" };              Fail = 'no_loader_errors' }
 'proxy_fatal'             = @{ Mut = { param($c) $c.proxy += '[2026-11-07 07:13:48.700] [ERROR] FATAL: LoadLibrary failed for StarRupture-ModLoader-Core.dll' }; Fail = 'proxy_core_attached' }
 'proxy_no_attach'         = @{ Mut = { param($c) $c.proxy = @($c.proxy | Where-Object { $_ -notmatch 'Core_Attach\(\) succeeded' }) }; Fail = 'proxy_core_attached' }
 # Boot never completes
 'no_init_summary'         = @{ Mut = { param($c) Drop $c 'InitAllLoadedPlugins' };                                        Fail = 'plugins_initialized' }
 'init_summary_short'      = @{ Mut = { param($c) $c.ml = $c.ml -replace '9 initialized, 0 failed \(of 9', '8 initialized, 0 failed (of 9' }; Fail = 'plugins_initialized' }
 'init_summary_failed'     = @{ Mut = { param($c) $c.ml = $c.ml -replace '9 initialized, 0 failed', '8 initialized, 1 failed' }; Fail = 'plugins_initialized' }
 'no_startup_phase'        = @{ Mut = { param($c) Drop $c 'Plugin startup phase complete' };                               Fail = 'startup_phase_complete' }
 'no_boot_finished'        = @{ Mut = { param($c) Drop $c 'Boot sequence finished' };                                      Fail = 'boot_sequence_finished' }
 # No update traffic, no DLL changes
 'manifest_url'            = @{ Mut = { param($c) $c.ml += '[07:13:52.894] [INFO ] [T:00700] [AutoUpdate] Manifest URL: https://example.invalid/manifest-client.json (compiled-in default)' }; Fail = 'no_update_check' }
 'update_check_not_off'    = @{ Mut = { param($c) Drop $c 'Disabled via modloader' };                                      Fail = 'no_update_check' }
 'autoupdate_log_no_off'   = @{ Mut = { param($c) $c.au = @($c.au | Where-Object { $_ -notmatch 'disabled via' }) };       Fail = 'autoupdate_log_disabled' }
 'dll_changed'             = @{ Mut = { param($c) $c.hashes.'ModLoader/Plugins/Waila.dll'.after = 'ab' * 32 };             Fail = 'dll_hashes_unchanged' }
 'dll_gone_after'          = @{ Mut = { param($c) $c.hashes.'ModLoader/Plugins/Waila.dll'.after = $null };                 Fail = 'dll_hashes_unchanged' }
 'dll_hashes_empty'        = @{ Mut = { param($c) $c.hashes = [pscustomobject]@{} };                                       Fail = 'dll_hashes_unchanged' }
 # Missing inputs
 'ml_missing'              = @{ Mut = { param($c) $c.skip += 'ml' };                                                       Fail = 'modloader_log_present' }
 'ml_empty'                = @{ Mut = { param($c) $c.ml = @() };                                                           Fail = 'modloader_log_present' }
 'proxy_missing'           = @{ Mut = { param($c) $c.skip += 'proxy' };                                                    Fail = 'proxy_log_present' }
 'autoupdate_missing'      = @{ Mut = { param($c) $c.skip += 'au' };                                                       Fail = 'autoupdate_log_present' }
 'boot_missing'            = @{ Mut = { param($c) $c.skip += 'boot' };                                                     Fail = 'boot_record' }
 'set_missing'             = @{ Mut = { param($c) $c.skip += 'set' };                                                      Fail = 'set_record' }
 'set_no_expect'           = @{ Mut = { param($c) (Plugin $c 'Codex').PSObject.Properties.Remove('expect') };              Fail = 'set_record' }
 'hashes_missing'          = @{ Mut = { param($c) $c.skip += 'hashes' };                                                   Fail = 'dll_hashes_unchanged' }
 # The feed-path rig (set.json carries a feed)
 'feed_good'               = @{ Mut = { param($c) Seed-Feed $c } }
 'feed_record_bad'         = @{ Mut = { param($c) Seed-Feed $c; $c.set.feed.seq = 'x' };                                   Fail = 'feed_record' }
 'feed_line_missing'       = @{ Mut = { param($c) Seed-Feed $c; Drop $c '\[VersionFeed\] Feed seq' };                      Fail = 'feed_applied' }
 'feed_wrong_seq'          = @{ Mut = { param($c) Seed-Feed $c 41 127004; $c.set.feed.seq = 42 };                          Fail = 'feed_applied' }
 'feed_zero_rows'          = @{ Mut = { param($c) Seed-Feed $c -Line "[07:13:48.640] [INFO ] [T:03432] [VersionFeed] Feed seq 41 (key k1, TEST KEY): 0 rows from the feed, 12 discarded (0 clashed with the loader's map on this exe, 0 absent rows filled, 0 scoped rows without fp dropped)" }; Fail = 'feed_applied' }
 'feed_release_key'        = @{ Mut = { param($c) Seed-Feed $c -Line "[07:13:48.640] [INFO ] [T:03432] [VersionFeed] Feed seq 41 (key k2): 12 rows from the feed, 0 discarded (0 clashed with the loader's map on this exe, 0 absent rows filled, 0 scoped rows without fp dropped)" }; Fail = 'feed_applied' }
 'feed_after_the_gate'     = @{ Mut = { param($c) Seed-Feed $c -AfterGate };                                               Fail = 'feed_rows_used' }
 'feed_other_cl'           = @{ Mut = { param($c) Seed-Feed $c 41 128786 };                                                Fail = 'feed_rows_used' }
 'feed_cache_unusable'     = @{ Mut = { param($c) Seed-Feed $c; $c.ml += "$($vf)The feed cache is not usable (signature does not verify); using the loader's own map" }; Fail = 'feed_not_refused' }
 'feed_cache_unread'       = @{ Mut = { param($c) Seed-Feed $c; $c.ml += "$($vf)The feed cache 'D:\g\ModLoader\version-map-client.v1.cache' could not be read (or is over 1 MiB); using the loader's own map" }; Fail = 'feed_not_refused' }
 'feed_cl_refused'         = @{ Mut = { param($c) Seed-Feed $c; $c.ml += "$($vf)CL-127004 from the feed is refused: it lacks 3 of the keys the loader needs" }; Fail = 'feed_not_refused' }
 'feed_fetch_started'      = @{ Mut = { param($c) Seed-Feed $c; $c.ml += '[07:13:49.000] [INFO ] [T:03432] [VersionFeed] Fetching the feed (stage 1)' }; Fail = 'feed_not_fetched' }
 'feed_fetched_stored'     = @{ Mut = { param($c) Seed-Feed $c; $c.ml += '[07:13:49.500] [INFO ] [T:03432] [VersionFeed] Feed seq 41 stored for the next launch' }; Fail = 'feed_not_fetched' }
 'feed_no_request_ok'      = @{ Mut = { param($c) Seed-Feed $c; $c.ml += '[07:13:49.000] [INFO ] [T:03432] [VersionFeed] No feed request (stage 1): auto-update is off' } }
 # Not a failure
 'feature_off_note'        = @{ Mut = { param($c) $c.ml += "$($sig)[Map] Waila: feature ""Hover details"" is off: no row for CL-128786 (reflected)" } }
}

$extra = {
    # Beyond the exit code: the verdict.json a caller reads.
    param($k, $r)
    $j = Get-Content -LiteralPath (Join-Path $r.Dir 'verdict.json') -Raw | ConvertFrom-Json
    $row = { param($n) $j.plugins | Where-Object { $_.name -eq $n } }
    $bad = @()
    if ($r.Exit -eq 0 -and $j.verdict -ne 'PASS') { $bad += 'verdict.json says not PASS' }
    if ($r.Exit -ne 0 -and ($j.verdict -ne 'FAIL' -or $j.reason -notmatch '^\d+ of \d+ checks failed, first: ')) { $bad += "verdict.json reason: $($j.reason)" }
    if ($k -notin 'set_missing', 'set_no_expect', 'set_names_one_plugin' -and @($j.plugins).Count -ne 9) { $bad += "verdict.json lists $(@($j.plugins).Count) plugins" }
    if ($k -eq 'good') {
        $w = & $row 'WAILA'
        if ($w.state -ne 'ok' -or $w.logVersion -ne 'v0.20.0' -or $w.expected -ne 'v0.20.0') { $bad += 'WAILA row wrong' }
        if ($j.loader.logVersion -ne 'v1.23.1') { $bad += 'loader row wrong' }
    }
    if ($k -eq 'plugin_removed' -and (& $row 'WAILA').state -ne 'missing') { $bad += 'removed plugin not reported missing' }
    if ($k -eq 'plugin_older_version' -and ((& $row 'WAILA').state -ne 'wrong version' -or (& $row 'WAILA').logVersion -ne 'v0.19.0')) { $bad += 'wrong version not reported' }
    if ($k -eq 'refused_not_loaded' -and (& $row 'Codex').state -ne 'refused') { $bad += 'refused plugin not reported refused' }
    if ($k -eq 'refused_but_faulted' -and (& $row 'Compass').state -ne 'crashed') { $bad += 'declared refusal with a fault not reported crashed' }
    if ($k -eq 'expect_refused_ok' -and (& $row 'Compass').state -ne 'refused (as declared)') { $bad += 'declared refusal not reported' }
    if ($k -eq 'feature_off_note' -and ((& $row 'WAILA').state -ne 'ok' -or (& $row 'WAILA').note -notmatch 'Hover details')) { $bad += 'feature-off note missing' }
    if ($k -eq 'rupture_timer_repo_name' -and (& $row 'RuptureTimer').state -ne 'missing') { $bad += 'repo-name lookup not reported missing' }
    $bad
}

foreach ($k in $clientCases.Keys) {
    $r = New-ClientCase $k $clientCases[$k].Mut
    $mustFail = $clientCases[$k].Fail
    $want = if ($mustFail) { 1 } else { 0 }
    $failed = ($r.Out -split "`n" | Where-Object { $_ -match ' FAIL\s*$' -and $_ -notmatch '^VERDICT' } | ForEach-Object { ($_ -split '\s+')[0] }) -join ','
    $problems = @()
    if ($r.Exit -ne $want) { $problems += "exit $($r.Exit), want $want" }
    if ($mustFail -and (($failed -split ',') -notcontains $mustFail)) { $problems += "check $mustFail did not fail" }
    if (-not $mustFail -and $failed) { $problems += "unexpected failures: $failed" }
    if (Test-Path (Join-Path $r.Dir 'verdict.json')) { $problems += @(& $extra $k $r) } else { $problems += 'no verdict.json' }
    if ($problems.Count -gt 0) { $bad++ }
    'client {0,-24} exit={1} want={2} {3}  failed: {4}{5}' -f $k, $r.Exit, $want, $(if ($problems.Count -eq 0) { 'OK ' } else { 'BAD' }), $failed, $(if ($problems.Count -gt 0) { '  PROBLEMS: ' + ($problems -join ' | ') } else { '' })
}

# ---- client mode, the two real rig artifacts of run 42399350787 ----------------
# fixtures\rig-run-42399350787 holds what the rig uploaded for that run, untouched: the
# CL-129402 rig (candidate loader 556ce13 on CL-129402: one member moved, a
# compat report written, MiniMap refused as declared) and the public rig (MiniMap
# loaded, its init fails because the rig runs with [UI] Enabled=0). Only two things are
# not from the artifacts: set.json of the public rig gains MiniMap's uiOffInitFailure
# (the rig's set step writes it from plugin-names.json; the run predates the field), and
# that rig's compat-report-129402.json was not uploaded by that run, so it is
# written the way the loader's writer does (core/compat_report.cpp at 5172c71, format 3,
# the same layout as the real CL-128786 report) from what that run's log records: the
# product version, the layout counts, the four global RVAs and the one TimerActor change
# (the exe hash is zeros). Both runs failed the old verdict for these reasons alone.
$rigFx = Join-Path (Join-Path $PSScriptRoot 'fixtures') 'rig-run-42399350787'
$uiOffText = (@(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'plugin-names.json') -Raw | ConvertFrom-Json | ForEach-Object { $_ }) | Where-Object { $_.Name -eq 'MiniMap' }).UiOffInitFailure
if ($uiOffText -isnot [string] -or -not $uiOffText) { throw 'plugin-names.json has no UiOffInitFailure for MiniMap' }
$arrow = [string][char]0x2192

function New-RigCase([string]$Name, [string]$Run, [scriptblock]$Mutate) {
    $src = Join-Path $rigFx $Run
    $d = Join-Path $root "rig-$Run-$Name"; New-Item -ItemType Directory $d | Out-Null
    $c = @{
        ml = [string[]](Get-Content -LiteralPath (Join-Path $src 'modloader.log') -Encoding UTF8)
        boot = Get-Content -LiteralPath (Join-Path $src 'boot.json') -Raw | ConvertFrom-Json
        set = Get-Content -LiteralPath (Join-Path $src 'set.json') -Raw | ConvertFrom-Json
        compat = $null
    }
    $rep = Join-Path $src 'compat-report-129402.json'
    if (Test-Path $rep) { $c.compat = Get-Content -LiteralPath $rep -Raw -Encoding UTF8 }
    if ($Run -eq 'public') { ($c.set.plugins | Where-Object { $_.repo -eq 'MiniMap' }) | Add-Member -NotePropertyName uiOffInitFailure -NotePropertyValue $uiOffText -Force }
    & $Mutate $c
    Set-Content (Join-Path $d 'modloader.log') $c.ml -Encoding utf8
    $c.boot | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $d 'boot.json') -Encoding utf8
    $c.set | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $d 'set.json') -Encoding utf8
    foreach ($f in 'proxy.log', 'autoupdate.log', 'dll-hashes.json') { Copy-Item (Join-Path $src $f) $d }
    if ($null -ne $c.compat) { Set-Content (Join-Path $d 'compat-report-129402.json') $c.compat -Encoding utf8 -NoNewline }
    $shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
    $out = & $shell -NoProfile -File $verdict -OutDir $d -Client 2>&1
    [pscustomobject]@{ Case = $Name; Exit = $LASTEXITCODE; Out = ($out -join "`n"); Dir = $d }
}
function Edit-Report($c, [string]$Old, [string]$New) {
    if (-not $c.compat.Contains($Old)) { throw "the compat report fixture lacks: $Old" }
    $c.compat = $c.compat.Replace($Old, $New)
}
# Adds a top-level "sizes" array (the loader's per-request class-key size entries) to the report.
function Add-Sizes($c, [string]$Entries) {
    $c.compat = [regex]::Replace($c.compat, '(\r?\n)\}\s*$', ",`$1  `"sizes`": [ $Entries ]`$1}")
}
function Size-Entry([string]$Plugin, [string]$Key, $RowCL, $Row, $Refl, [string]$Result) {
    '{{ "plugin": "{0}", "key": "{1}", "rowCL": {2}, "rowSize": {3}, "reflectedSize": {4}, "result": "{5}" }}' -f $Plugin, $Key, $(if ($null -eq $RowCL) { 'null' } else { $RowCL }), $(if ($null -eq $Row) { 'null' } else { $Row }), $(if ($null -eq $Refl) { 'null' } else { $Refl }), $Result
}
$szMatch = Size-Entry 'AxRuptureTimer' 'FCrEnviroWaveSettings' 129402 44 44 'match'
$szMismatch = Size-Entry 'Codex' 'FAuSimpleItem' 129402 48 52 'mismatch'
$szRowOnly = Size-Entry 'BetterCheats' 'FMassEntityManager' 129402 176 $null 'row-only'
$szNoRow = Size-Entry 'BetterCheats' 'FMassEntityManager' $null $null $null 'no-row'
$szReflOnly = Size-Entry 'Compass' 'FCrPlayerPersonalMarkerData' $null $null 40 'reflected-only'
$missRow = '{ "name": "Fname_AppendString", "module": "StarRuptureGameSteam-Win64-Shipping.exe", "pattern": "48 89 5C 24 ?? 57", "required": REQ, "found": false }'
$uiOffErr = "[19:00:31.326] [ERROR] [T:02032] [Plugin:MiniMap] $uiOffText"
$tb = 'test-branch'
$hotbarTitle = 'Ctrl + mouse wheel changes the hotbar in the drone'
$hotbarKeys = 'UCrHotbarLocalPlayerSubsystem::CurrentHotbarIndex, UCrHotbarLocalPlayerSubsystem::Hotbars'
$offWhy = 'this game build changed something it needs'
$rigCases = [ordered]@{
 # The two real runs: both must pass
 'cl-129402 real'           = @{ Run = $tb;      Mut = { param($c) } }
 'public real'                = @{ Run = 'public'; Mut = { param($c) } }
 # A compat report is judged by its contents
 'compat safe-off'            = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"outcome": "partial"' '"outcome": "safe-off"' };                    Fail = 'compat_report_ok' }
 'compat required miss'       = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"patternMisses": []' ('"patternMisses": [ ' + $missRow.Replace('REQ', 'true') + ' ]') }; Fail = 'compat_report_ok' }
 'compat optional miss'       = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"patternMisses": []' ('"patternMisses": [ ' + $missRow.Replace('REQ', 'false') + ' ]') } }
 'compat global unresolved'   = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"name": "GWorld", "resolved": true' '"name": "GWorld", "resolved": false' }; Fail = 'compat_report_ok' }
 'compat global rejected'     = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"name": "GNames", "resolved": true, "rva": 238566080, "sdkOffset": 237091840, "rejected": false' '"name": "GNames", "resolved": true, "rva": 238566080, "sdkOffset": 237091840, "rejected": true' }; Fail = 'compat_report_ok' }
 'compat missing change'      = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"member": "TimerActor", "field": "offset", "sdk": 144, "game": 152 }' '"member": "TimerActor", "field": "offset", "sdk": 144, "game": 152 }, { "class": "UCrFoo", "member": "Bar", "field": "missing" }' }; Fail = 'compat_report_ok' }
 'compat vtable slot change'  = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"member": "TimerActor", "field": "offset", "sdk": 144, "game": 152 }' '"member": "TimerActor", "field": "offset", "sdk": 144, "game": 152 }, { "class": "UObject", "member": "ProcessEvent", "field": "vtableSlot", "sdk": 76, "game": 77 }' }; Fail = 'compat_report_ok' }
 'compat missing also layout' = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"field": "offset", "sdk": 144, "game": 152' '"field": "missing"' }; Fail = 'layout_ok' }
 'compat file not kept'       = @{ Run = $tb; Mut = { param($c) $c.compat = $null };                                                                  Fail = 'compat_report_ok' }
 'compat file garbage'        = @{ Run = $tb; Mut = { param($c) $c.compat = 'this is not json' };                                                     Fail = 'compat_report_ok' }
 'compat file truncated'      = @{ Run = $tb; Mut = { param($c) $c.compat = $c.compat.Substring(0, 300) };                                            Fail = 'compat_report_ok' }
 'compat file empty'          = @{ Run = $tb; Mut = { param($c) $c.compat = ' ' };                                                                    Fail = 'compat_report_ok' }
 'compat no outcome'          = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"outcome": "partial",' '' };                                          Fail = 'compat_report_ok' }
 'compat no changes list'     = @{ Run = $tb; Mut = { param($c) $c.compat = [regex]::Replace($c.compat, '(?s),\s*"changes":.*\}\s*$', "`n}") };       Fail = 'compat_report_ok' }
 'compat unknown outcome'     = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"outcome": "partial"' '"outcome": "fine"' };                          Fail = 'compat_report_ok' }
 'compat listed not written'  = @{ Run = $tb; Mut = { param($c) $c.boot.compat_reports = @() };                                                       Fail = 'compat_report_ok' }
 'compat feature off'         = @{ Run = $tb; Mut = { param($c) $c.ml += "$($sig)[Map] Waila: feature ""Hover details"" is off: UCrFoo::Bar ($offWhy)" }; Fail = 'compat_report_ok' }
 # A feature off is accepted only when every key the loader names is optional for that plugin
 'feature off, keys optional' = @{ Run = $tb; Mut = { param($c) $c.ml += "$($sig)[Map] BetterDrone: feature ""$hotbarTitle"" is off: $hotbarKeys ($offWhy)" } }
 'feature off, log name differs' = @{ Run = $tb; Mut = { param($c) $c.ml += "$($sig)[Map] Waila: feature ""Hover details"" is off: UMassEntitySubsystem::EntityManager ($offWhy)" } }
 'feature off, key not optional' = @{ Run = $tb; Mut = { param($c) $c.ml += "$($sig)[Map] BetterDrone: feature ""$hotbarTitle"" is off: UCrHotbarLocalPlayerSubsystem::CurrentHotbarIndex, ACrPlayerControllerBase::PlayerControlState ($offWhy)" }; Fail = 'compat_report_ok' }
 'feature off, other plugin key' = @{ Run = $tb; Mut = { param($c) $c.ml += "$($sig)[Map] BetterCheats: feature ""$hotbarTitle"" is off: $hotbarKeys ($offWhy)" }; Fail = 'compat_report_ok' }
 'feature off, no keys'       = @{ Run = $tb; Mut = { param($c) $c.ml += "$($sig)[Map] BetterDrone: feature ""$hotbarTitle"" is off:  ($offWhy)" }; Fail = 'compat_report_ok' }
 'feature off, no reason'     = @{ Run = $tb; Mut = { param($c) $c.ml += "$($sig)[Map] BetterDrone: feature ""$hotbarTitle"" is off" }; Fail = 'compat_report_ok' }
 'feature off, one good one bad' = @{ Run = $tb; Mut = { param($c)
        $c.ml += "$($sig)[Map] BetterDrone: feature ""$hotbarTitle"" is off: $hotbarKeys ($offWhy)"
        $c.ml += "$($sig)[Map] Waila: feature ""Hover details"" is off: UCrFoo::Bar ($offWhy)" }; Fail = 'compat_report_ok' }
 # Class-key size rows: the map row's size against the size the game reflects
 'sizes match'               = @{ Run = $tb; Mut = { param($c) Add-Sizes $c "$szMatch, $szReflOnly" } }
 'unchanged sizes match'     = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"outcome": "partial"' '"outcome": "unchanged"'; Add-Sizes $c $szMatch } }
 'unchanged sizes mismatch'  = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"outcome": "partial"' '"outcome": "unchanged"'; Add-Sizes $c $szMismatch }; Fail = 'compat_report_ok' }
 'unchanged pattern miss'    = @{ Run = $tb; Mut = { param($c) Edit-Report $c '"outcome": "partial"' '"outcome": "unchanged"'; Edit-Report $c '"patternMisses": []' ('"patternMisses": [ ' + $missRow.Replace('REQ', 'true') + ' ]') }; Fail = 'compat_report_ok' }
 'sizes empty'               = @{ Run = $tb; Mut = { param($c) Add-Sizes $c '' } }
 'sizes mismatch'            = @{ Run = $tb; Mut = { param($c) Add-Sizes $c "$szMatch, $szMismatch" };                                Fail = 'compat_report_ok' }
 'sizes unreflected, row'    = @{ Run = $tb; Mut = { param($c) Add-Sizes $c $szRowOnly } }
 'sizes unreflected, no row' = @{ Run = $tb; Mut = { param($c) Add-Sizes $c "$szMatch, $szNoRow" };                                   Fail = 'compat_report_ok' }
 'sizes result says match'   = @{ Run = $tb; Mut = { param($c) Add-Sizes $c (Size-Entry 'Codex' 'FAuSimpleItem' 129402 48 52 'match') };  Fail = 'compat_report_ok' }
 'sizes result says differ'  = @{ Run = $tb; Mut = { param($c) Add-Sizes $c (Size-Entry 'Codex' 'FAuSimpleItem' 129402 48 48 'mismatch') }; Fail = 'compat_report_ok' }
 'sizes unknown result'      = @{ Run = $tb; Mut = { param($c) Add-Sizes $c (Size-Entry 'Codex' 'FAuSimpleItem' 129402 48 48 'fine') };  Fail = 'compat_report_ok' }
 'sizes entry no plugin'     = @{ Run = $tb; Mut = { param($c) Add-Sizes $c ($szMatch -replace '"plugin": "AxRuptureTimer", ', '') };  Fail = 'compat_report_ok' }
 'sizes not a list'          = @{ Run = $tb; Mut = { param($c) $c.compat = [regex]::Replace($c.compat, '(\r?\n)\}\s*$', ",`$1  `"sizes`": 7`$1}") }; Fail = 'compat_report_ok' }
 'compat plugins switched off' = @{ Run = $tb; Mut = { param($c) $c.ml += "$($sig)[init] The menu state for plugins is switched off" };               Fail = 'plugins_not_switched_off' }
 'compat undeclared refusal'  = @{ Run = $tb; Mut = { param($c) $c.ml += "$($sig)Plugin 'Codex' is not loaded: Needs an update to run on CL-129402" }; Fail = 'plugin_not_refused_Codex' }
 'layout moved without report' = @{ Run = $tb; Mut = { param($c) $c.boot.compat_reports = @(); $c.compat = $null; $c.ml = @($c.ml | Where-Object { $_ -notmatch 'Compatibility report written' }) }; Fail = 'layout_ok' }
 'layout moved, report has no changes' = @{ Run = $tb; Mut = { param($c) $c.compat = [regex]::Replace($c.compat, '"changes": \[.*?\]', '"changes": []', 'Singleline') }; Fail = 'layout_ok' }
 # MiniMap on the UI-off rig: only the known ERROR plus its init failure passes
 'uioff other error'          = @{ Run = 'public'; Mut = { param($c) $c.ml = $c.ml | ForEach-Object { if ($_ -eq $uiOffErr) { $_ -replace 'atlas texture interface initialization failed', 'atlas texture is broken' } else { $_ } } }; Fail = 'plugin_no_fault_MiniMap' }
 'uioff message extended'     = @{ Run = 'public'; Mut = { param($c) $c.ml = $c.ml | ForEach-Object { if ($_ -eq $uiOffErr) { "$_ (device lost)" } else { $_ } } };    Fail = 'plugin_no_fault_MiniMap' }
 'uioff no init failed line'  = @{ Run = 'public'; Mut = { param($c) $c.ml = @($c.ml | Where-Object { $_ -notmatch 'Plugin initialization failed: MiniMap' }) };    Fail = 'plugin_initialized_MiniMap' }
 'uioff no error line'        = @{ Run = 'public'; Mut = { param($c) $c.ml = @($c.ml | Where-Object { $_ -ne $uiOffErr }) };                               Fail = 'plugin_no_fault_MiniMap' }
 'uioff second error'         = @{ Run = 'public'; Mut = { param($c) $c.ml += "$($err)[Plugin:MiniMap] MiniMap: could not load the icon sheet" };                Fail = 'no_loader_errors' }
 'uioff error repeated'       = @{ Run = 'public'; Mut = { param($c) $c.ml += ($uiOffErr -replace '19:00:31.326', '19:00:31.999') };                          Fail = 'plugin_no_fault_MiniMap' }
 'uioff init failed twice'    = @{ Run = 'public'; Mut = { param($c) $c.ml += '[19:00:35.000] [INFO ] [T:02032] [ModLoader] Plugin initialization failed: MiniMap' }; Fail = 'plugin_no_fault_MiniMap' }
 'uioff error after failure'  = @{ Run = 'public'; Mut = { param($c) $c.ml = @($c.ml | Where-Object { $_ -ne $uiOffErr }) + $uiOffErr };                      Fail = 'plugin_no_fault_MiniMap' }
 'uioff other plugin same'    = @{ Run = 'public'; Mut = { param($c)
        $c.ml += "[19:00:36.000] [ERROR] [T:02032] [Plugin:Codex] $uiOffText"
        $c.ml += '[19:00:36.001] [INFO ] [T:02032] [ModLoader] Plugin initialization failed: Codex' };                                                       Fail = 'plugin_no_fault_Codex' }
 'uioff plugin crashed'       = @{ Run = 'public'; Mut = { param($c) $c.ml += "$($err)[PluginManager] Plugin 'MiniMap' CRASHED in its tick callback -- code=0xC0000005 fault=0x7FF700001234" }; Fail = 'plugin_no_fault_MiniMap' }
 'uioff plugin refused'       = @{ Run = 'public'; Mut = { param($c) $c.ml += "$($sig)Plugin 'MiniMap' is not loaded: Needs an update to run on CL-127004" };       Fail = 'plugin_not_refused_MiniMap' }
 'uioff summary says ten'     = @{ Run = 'public'; Mut = { param($c) $c.ml = $c.ml -replace '9 initialized, 1 failed \(of 10', '10 initialized, 0 failed (of 10' }; Fail = 'plugins_initialized' }
 'uioff summary two failed'   = @{ Run = 'public'; Mut = { param($c) $c.ml = $c.ml -replace '9 initialized, 1 failed \(of 10', '8 initialized, 2 failed (of 10' };  Fail = 'plugins_initialized' }
 'uioff not declared'         = @{ Run = 'public'; Mut = { param($c) ($c.set.plugins | Where-Object { $_.repo -eq 'MiniMap' }).PSObject.Properties.Remove('uiOffInitFailure') }; Fail = 'plugin_no_fault_MiniMap' }
 'uioff wrong text declared'  = @{ Run = 'public'; Mut = { param($c) ($c.set.plugins | Where-Object { $_.repo -eq 'MiniMap' }).uiOffInitFailure = 'MiniMap: something else' }; Fail = 'plugin_no_fault_MiniMap' }
 'uioff other ERROR line'     = @{ Run = 'public'; Mut = { param($c) $c.ml += "$($err)[ImGuiBackend] D3D12CreateDevice failed" };                               Fail = 'no_loader_errors' }
}
foreach ($k in $rigCases.Keys) {
    $r = New-RigCase $k $rigCases[$k].Run $rigCases[$k].Mut
    $mustFail = $rigCases[$k].Fail
    $want = if ($mustFail) { 1 } else { 0 }
    $failed = ($r.Out -split "`n" | Where-Object { $_ -match ' FAIL\s*$' -and $_ -notmatch '^VERDICT' } | ForEach-Object { ($_ -split '\s+')[0] }) -join ','
    $problems = @()
    if ($r.Exit -ne $want) { $problems += "exit $($r.Exit), want $want" }
    if ($mustFail -and (($failed -split ',') -notcontains $mustFail)) { $problems += "check $mustFail did not fail" }
    if (-not $mustFail -and $failed) { $problems += "unexpected failures: $failed" }
    if (Test-Path (Join-Path $r.Dir 'verdict.json')) {
        $j = Get-Content -LiteralPath (Join-Path $r.Dir 'verdict.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $md = Get-Content -LiteralPath (Join-Path $r.Dir 'summary.md') -Raw -Encoding UTF8
        $mm = $j.plugins | Where-Object { $_.name -eq 'MiniMap' }
        $moved = "layout moved: UCrEnviroWaveTimerSubsystem::TimerActor 0x90${arrow}0x98 (keys-only, no loader feature reads it)"
        if ($k -eq 'cl-129402 real') {
            if (@($j.notes) -notcontains $moved) { $problems += 'verdict.json lacks the layout-moved note' }
            if ($md -notmatch [regex]::Escape("Note: $moved")) { $problems += 'summary.md lacks the layout-moved note' }
            if ($mm.state -ne 'refused (as declared)') { $problems += "MiniMap state $($mm.state)" }
        }
        if ($k -in 'feature off, keys optional', 'feature off, log name differs') {
            $want = if ($k -eq 'feature off, keys optional') { "BetterDrone feature ""$hotbarTitle"" is off, accepted: $hotbarKeys optional in native-keys.txt" } else { 'Waila feature "Hover details" is off, accepted: UMassEntitySubsystem::EntityManager optional in native-keys.txt' }
            if (@($j.notes) -notcontains $want) { $problems += "accepted-off note missing: $want" }
            if ($md -notmatch [regex]::Escape("Note: $want")) { $problems += 'summary.md lacks the accepted-off note' }
            if ($r.Out -notmatch 'layout_ok\s+PASS') { $problems += 'layout_ok not PASS' }
        }
        $vt = if (Test-Path (Join-Path $r.Dir 'verdict.txt')) { Get-Content -LiteralPath (Join-Path $r.Dir 'verdict.txt') -Raw -Encoding UTF8 } else { '' }
        if ($k -eq 'feature off, key not optional' -and ($vt -notmatch 'is off: not optional: ACrPlayerControllerBase::PlayerControlState(;|\s|$)' -or $vt -match 'not optional: .*CurrentHotbarIndex')) { $problems += 'the failure does not name only the bad key' }
        if ($k -eq 'feature off, no keys' -and $vt -notmatch 'is off: names no keys') { $problems += 'no-keys failure missing' }
        if ($k -eq 'feature off, one good one bad') {
            if ($vt -notmatch 'Waila feature "Hover details" is off: not optional: UCrFoo::Bar') { $problems += 'the bad one is not named' }
            if ($vt -match 'FOUND:.*BetterDrone') { $problems += 'the accepted one is in the failure' }
        }
        if ($k -eq 'compat optional miss' -and @($j.notes) -notcontains 'optional pattern missed: Fname_AppendString') { $problems += 'optional miss not noted' }
        if ($k -eq 'sizes match') {
            $l1 = 'size row AxRuptureTimer: FCrEnviroWaveSettings row 0x2C (CL-129402), reflected 0x2C: match'
            $l2 = 'size row Compass: FCrPlayerPersonalMarkerData row none, reflected 0x28: no row, reflected only'
            foreach ($l in $l1, $l2) { if (@($j.notes) -notcontains $l) { $problems += "verdict.json lacks: $l" } }
            if ($md -notmatch [regex]::Escape("Note: $l1")) { $problems += 'summary.md lacks the match line' }
            if ($r.Out -notmatch 'compat_report_ok\s+PASS') { $problems += 'compat_report_ok not PASS' }
            if (@($j.notes) -notcontains $moved) { $problems += 'the layout-moved note went missing' }
        }
        if ($k -eq 'sizes unreflected, row' -and @($j.notes) -notcontains 'size row BetterCheats: FMassEntityManager row 0xB0 (CL-129402), reflected none: unreflected, row only') { $problems += 'row-only line missing' }
        if ($k -eq 'sizes mismatch' -and @($j.notes) -notcontains 'size row Codex: FAuSimpleItem row 0x30 (CL-129402), reflected 0x34: MISMATCH') { $problems += 'mismatch line missing' }
        if ($k -in 'cl-129402 real', 'sizes empty' -and (@($j.notes) | Where-Object { $_ -like 'size row*' })) { $problems += 'size lines without class-key rows' }
        if ($k -eq 'public real') {
            if ($mm.state -ne 'loaded; init needs the UI layer the rig turns off') { $problems += "MiniMap state $($mm.state)" }
            if ($r.Out -notmatch 'plugins_initialized\s+PASS') { $problems += 'plugins_initialized not PASS' }
            if ($j.reason -notmatch '^All \d+ checks passed') { $problems += "reason: $($j.reason)" }
        }
    } else { $problems += 'no verdict.json' }
    if ($problems.Count -gt 0) { $bad++ }
    'rig {0,-34} exit={1} want={2} {3}  failed: {4}{5}' -f $k, $r.Exit, $want, $(if ($problems.Count -eq 0) { 'OK ' } else { 'BAD' }), $failed, $(if ($problems.Count -gt 0) { '  PROBLEMS: ' + ($problems -join ' | ') } else { '' })
}

# ---- client mode, a clean decline: run 42447973574's CL-129402 rig ----------------
# fixtures\rig-run-42447973574\decline holds what that rig uploaded, untouched, except that
# set.json gains "expectDecline": true (the rig's set step writes it from the expect_decline
# input, which the run predates). The branch ran CL-129402, the candidate map had no row for
# it: the loader logged the version mismatch, aborted the hook installation, parked the main
# thread at the Stage 1 gate for 180 s and released it with one ERROR line, loaded no plugin,
# and the game was still running when the rig stopped it.
$decFx = Join-Path (Join-Path (Join-Path $PSScriptRoot 'fixtures') 'rig-run-42447973574') 'decline'
$decSig = '[05:37:00.000] [INFO ] [T:03008] '
$decErr = '[05:37:00.000] [ERROR] [T:03008] '
function New-DeclineCase([string]$Name, [scriptblock]$Mutate) {
    $d = Join-Path $root "decline-$Name"; New-Item -ItemType Directory $d | Out-Null
    $c = @{
        ml = [string[]](Get-Content -LiteralPath (Join-Path $decFx 'modloader.log') -Encoding UTF8)
        boot = Get-Content -LiteralPath (Join-Path $decFx 'boot.json') -Raw | ConvertFrom-Json
        set = Get-Content -LiteralPath (Join-Path $decFx 'set.json') -Raw | ConvertFrom-Json
    }
    $c.set | Add-Member -NotePropertyName expectDecline -NotePropertyValue $true -Force
    & $Mutate $c
    Set-Content (Join-Path $d 'modloader.log') $c.ml -Encoding utf8
    $c.boot | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $d 'boot.json') -Encoding utf8
    $c.set | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $d 'set.json') -Encoding utf8
    foreach ($f in 'proxy.log', 'autoupdate.log', 'dll-hashes.json') { Copy-Item (Join-Path $decFx $f) $d }
    $shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
    $out = & $shell -NoProfile -File $verdict -OutDir $d -Client 2>&1
    [pscustomobject]@{ Case = $Name; Exit = $LASTEXITCODE; Out = ($out -join "`n"); Dir = $d }
}
$declineCases = [ordered]@{
 'decline real'                 = @{ Mut = { param($c) } }
 # Not a decline: the same log judged as a boot, which it fails on every check a boot needs
 'declined but a boot expected' = @{ Mut = { param($c) $c.set.PSObject.Properties.Remove('expectDecline') };                                          Fail = 'game_version_ok' }
 # Each way a decline can go wrong
 'no mismatch line'             = @{ Mut = { param($c) $c.ml = @($c.ml | Where-Object { $_ -notmatch 'VERSION MISMATCH' }) };                            Fail = 'loader_declined' }
 'no abort line'                = @{ Mut = { param($c) $c.ml = @($c.ml | Where-Object { $_ -notmatch 'Hook installation aborted' }) };                  Fail = 'loader_declined' }
 'empty log'                    = @{ Mut = { param($c) $c.ml = @() };                                                                                    Fail = 'loader_declined' }
 'game version ok'              = @{ Mut = { param($c) $c.ml += "$($decSig)[ModLoader] Game version OK: ++Earth20+Kobalt-PTR2-CL-129402" };            Fail = 'no_game_version_ok' }
 'hooks installed'              = @{ Mut = { param($c) $c.ml += "$($decSig)[init] Engine hooks installed in 12 ms" };                                  Fail = 'no_hooks_installed' }
 'boot finished'                = @{ Mut = { param($c) $c.ml += "$($decSig)[init] Boot sequence finished in 9000 ms" };                                Fail = 'no_hooks_installed' }
 'plugin read'                  = @{ Mut = { param($c) $c.ml += "$($decSig)[ModLoader] Plugin info - Name: BetterCheats, Version: v0.23.0, Author: AlienX, Interface: 74" }; Fail = 'no_plugin_activity' }
 'plugin loading'               = @{ Mut = { param($c) $c.ml += "$($decSig)[ModLoader] Loading plugin: D:\Game\ModLoader\Plugins\BetterCheats.dll" }; Fail = 'no_plugin_activity' }
 'plugin loaded'                = @{ Mut = { param($c) $c.ml += "$($decSig)[ModLoader] Successfully loaded plugin DLL: BetterCheats v0.23.0 (PluginInit deferred)" }; Fail = 'no_plugin_activity' }
 'plugin initialised'           = @{ Mut = { param($c) $c.ml += "$($decSig)[ModLoader] InitAllLoadedPlugins: 3 initialized, 0 failed (of 3 deferred)" }; Fail = 'no_plugin_activity' }
 'crash marker'                 = @{ Mut = { param($c) $c.ml += "$($decErr)[CrashReporter] *** FATAL ENGINE CRASH *** -- suppressing CrashReportClient upload" }; Fail = 'no_crash_markers' }
 'other error'                  = @{ Mut = { param($c) $c.ml += "$($decErr)[ImGuiBackend] D3D12CreateDevice failed" };                                  Fail = 'no_loader_errors' }
 'second mismatch-like error'   = @{ Mut = { param($c) $c.ml += "$($decErr)[init] Stage 1 failed" };                                                      Fail = 'no_loader_errors' }
 'game exited'                  = @{ Mut = { param($c) $c.boot.exited_early = $true; $c.boot.alive_at_end = $false; $c.boot.exit_code = 53 };            Fail = 'client_alive_at_end' }
 'game not alive'               = @{ Mut = { param($c) $c.boot.alive_at_end = $false };                                                                 Fail = 'client_alive_at_end' }
 'crash dump'                   = @{ Mut = { param($c) $c.boot.crash_files = @('Crashes\crash.dmp') };                                                  Fail = 'no_crash_files' }
 'crash dialog'                 = @{ Mut = { param($c) $c.boot.crash_dialog = 'The game has crashed' };                                                 Fail = 'no_crash_dialog' }
 'update traffic'               = @{ Mut = { param($c) $c.ml += "$($decSig)[AutoUpdate] Manifest URL: https://example.invalid/manifest-client.json (compiled-in default)" }; Fail = 'no_update_check' }
}
foreach ($k in $declineCases.Keys) {
    $r = New-DeclineCase $k $declineCases[$k].Mut
    $mustFail = $declineCases[$k].Fail
    $want = if ($mustFail) { 1 } else { 0 }
    $failed = ($r.Out -split "`n" | Where-Object { $_ -match ' FAIL\s*$' -and $_ -notmatch '^VERDICT' } | ForEach-Object { ($_ -split '\s+')[0] }) -join ','
    $problems = @()
    if ($r.Exit -ne $want) { $problems += "exit $($r.Exit), want $want" }
    if ($mustFail -and (($failed -split ',') -notcontains $mustFail)) { $problems += "check $mustFail did not fail" }
    if (-not $mustFail -and $failed) { $problems += "unexpected failures: $failed" }
    if ($k -eq 'decline real') {
        $j = Get-Content -LiteralPath (Join-Path $r.Dir 'verdict.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($j.reason -notmatch 'declined the build cleanly') { $problems += "reason: $($j.reason)" }
        if (@($j.plugins | Where-Object { $_.state -notlike 'not loaded*' }).Count -gt 0) { $problems += 'a plugin row is not "not loaded"' }
        foreach ($n in 'loader_declined', 'no_game_version_ok', 'no_hooks_installed', 'no_plugin_activity', 'no_loader_errors', 'client_alive_at_end') { if ($r.Out -notmatch "$n\s+PASS") { $problems += "$n not PASS" } }
        # The decline replaces the boot checks, it does not add to them.
        if ($r.Out -match '(?m)^(plugin_loaded_|game_version_ok\s|preflight_)') { $problems += 'a boot check ran in decline mode' }
    }
    if ($problems.Count -gt 0) { $bad++ }
    'decline {0,-30} exit={1} want={2} {3}  failed: {4}{5}' -f $k, $r.Exit, $want, $(if ($problems.Count -eq 0) { 'OK ' } else { 'BAD' }), $failed, $(if ($problems.Count -gt 0) { '  PROBLEMS: ' + ($problems -join ' | ') } else { '' })
}

# Client mode keeps the logs' text off the console and out of GITHUB_STEP_SUMMARY: the
# evidence goes to files in the output folder, which the workflow publishes after its leak
# gate. Server mode still appends to the summary.
$stepSummary = Join-Path $root 'step-summary.md'
$env:GITHUB_STEP_SUMMARY = $stepSummary
try {
    $r = New-ClientCase 'summary_to_file' { param($c) $c.ml += "$($err)[ImGuiBackend] D3D12CreateDevice failed" }
    $files = @('summary.md', 'verdict.txt') | ForEach-Object { Join-Path $r.Dir $_ }
    $problems = @()
    if (Test-Path $stepSummary) { $problems += 'client mode wrote GITHUB_STEP_SUMMARY' }
    if ($r.Out -match 'D3D12CreateDevice|Successfully loaded|Plugin info') { $problems += 'client mode printed log text' }
    if ($r.Out -notmatch 'no_loader_errors\s+FAIL') { $problems += 'client console lacks the check names' }
    foreach ($f in $files) { if (-not (Test-Path $f) -or (Get-Content $f -Raw) -notmatch 'D3D12CreateDevice') { $problems += "$(Split-Path $f -Leaf) lacks the evidence" } }
    if ((Get-Content $files[0] -Raw) -notmatch '\| Plugin \| Expected \| In log \|') { $problems += 'summary.md lacks the plugin table' }
    $s = New-Case 'summary_server' { param($c) }
    if (-not (Test-Path $stepSummary) -or (Get-Content $stepSummary -Raw) -notmatch 'Engine test verdict: PASS') { $problems += 'server mode did not append to GITHUB_STEP_SUMMARY' }
} finally { Remove-Item Env:GITHUB_STEP_SUMMARY -ErrorAction SilentlyContinue }
if ($problems.Count -gt 0) { $bad++ }
'client summary_to_file                          {0}{1}' -f $(if ($problems.Count -eq 0) { 'OK ' } else { 'BAD' }), $(if ($problems.Count -gt 0) { '  PROBLEMS: ' + ($problems -join ' | ') } else { '' })

# Server mode must not have grown a verdict.json.
if (Test-Path (Join-Path $root 'good\verdict.json')) { $bad++; 'BAD server mode wrote verdict.json' }

"mismatches: $bad"
if ($bad -gt 0) { exit 1 }
