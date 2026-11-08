# Judges one boot from what the launch script left in -OutDir. One line per check:
# name, PASS or FAIL, and the log line that proves it (or "missing"). Exits 1 when
# any check fails.
#
# A check passes only on positive evidence. A missing file, an empty log, a
# marker that never appeared or a value that does not parse all FAIL; nothing
# here defaults to pass.
#
# Two modes:
#   Server (default)  engine-test.yml: a dedicated server booted by ci/boot-server.ps1.
#   Client (-Client)  the client test rig: the real game client launched with the
#                     loader and the plugin set under test.
#
# ---- Server mode: expected files in -OutDir ---------------------------------------
#   boot.json        boot-server.ps1 (process facts)
#   game.log         engine log
#   modloader.log    loader log
#   scanner.exit     exit code of sr-aobscan (0 = every required pattern OK)
#   scanner.txt      sr-aobscan output
#
# ---- Client mode: expected files in -OutDir ---------------------------------------
# Written by the launch script; this script decides nothing about how they were made.
#
#   set.json         what the run was supposed to load:
#     {
#       "branch":  "public",            Steam branch, shown in the summary
#       "buildId": "25646882",          Steam build id, shown in the summary
#       "loader":  { "expect": "v1.23.1" },        the loader's build tag, v included
#       "plugins": [
#         { "repo": "WAILA",            display name (the repo's short name); required
#           "logName": "Waila",         name in the loader's "Plugin info - Name:" line;
#                                       defaults to repo. Differs for AxRuptureTimer (repo
#                                       RuptureTimer) and Waila (repo WAILA)
#           "expect": "v0.20.0",        exact version string the log must show, v included;
#                                       required unless expectRefused
#           "expectRefused": false,     true: the plugin must be refused on this build, and
#                                       the log must say so; loading it is the failure
#           "removed": false,           true: the DLL was taken out of the install but the
#                                       plugin is still expected, so it fails as missing
#           "dll": "Waila.dll",         optional file name; lets refusal lines that only name
#                                       a path (not the plugin) be matched to this plugin
#           "uiOffInitFailure": "MiniMap: atlas texture interface initialization failed" }
#                                       optional: the one ERROR text of a plugin whose init
#                                       needs the UI layer the rig turns off ([UI] Enabled=0).
#                                       That ERROR line plus "Plugin initialization failed:
#                                       <logName>", and nothing else for the plugin, passes it
#                                       as loaded and one fewer is expected to initialise
#       ],
#       "feed": { "seq": 41, "cl": 130000 }   optional: the run seeded the loader's feed cache with
#                                       this feed (client-rig-set.ps1 -FeedFile). The loader must
#                                       log it applied, with that seq, before the game version gate;
#                                       must log no fetch, no refusal and no cache fault; and the
#                                       build it reports must be that CL
#     }
#   boot.json        process facts for the client (the shipping exe). Same fields as
#                    boot-server.ps1 writes, plus two:
#     process_found    bool   the shipping process was seen
#     process_found_s  number seconds until it was seen
#     exited_early     bool   the process left before the rig stopped it
#     exit_code        number or null
#     alive_at_end     bool   still running when the rig stopped it (a process held open by
#                             the loader's crash dialog is alive too: see crash_dialog)
#     crash_files      array  crash dumps found, empty when none
#     crash_dialog     string or null   title of a crash/error dialog seen on the game's
#                             windows (e.g. "The game has crashed"); null or "" when none
#     compat_reports   array  names of compat-report-*.json found in ModLoader\ afterwards;
#                             empty when none
#   compat-report-<CL>.json   each file boot.json lists, copied from ModLoader\. Judged by
#                    what it says: it fails on outcome "safe-off", a required pattern miss, a
#                    global that is unresolved or rejected, or a change of field "missing" or
#                    "vtableSlot". A "partial" report with only other changes passes, and the
#                    changes are shown as notes. Format 4 adds outcome "unchanged" (layout did not
#                    change, a plugin made a size request), judged like "partial". A listed file that is absent or unparseable fails.
#                    Its optional "sizes" array holds one entry per struct-size request:
#                    { plugin, key, rowCL, rowSize, reflectedSize, result }, result one of
#                    match, mismatch, row-only, no-row, reflected-only. Each entry is a note
#                    line; mismatch and no-row fail. No "sizes", or an empty one, changes nothing.
#   modloader.log    ModLoader\Logs\ModLoader.log (logging at INFO)
#   proxy.log        ModLoader\Logs\Proxy.log
#   autoupdate.log   ModLoader\Logs\AutoUpdate.log
#   dll-hashes.json  one entry per DLL under the install, sha256 (hex) measured before the
#                    launch and again after the run; any difference, or a DLL that is
#                    missing on either side, fails:
#                      { "ModLoader/Plugins/Waila.dll": { "before": "<hex>", "after": "<hex>" }, ... }
#
# Client mode also writes verdict.json next to verdict.txt:
#   { "verdict": "PASS"|"FAIL", "reason": "<one sentence naming the first failures>",
#     "notes": [ "<what passed but is worth a look, e.g. a layout that moved>" ],
#     "loader": { "expected", "logVersion", "state" },
#     "plugins": [ { "name", "expected", "logVersion", "state", "note" } ] }
# and summary.md, the job summary with the per-plugin table first. The evidence in all
# of these quotes the logs, so client mode puts none of it on the console or in
# GITHUB_STEP_SUMMARY: the console gets check names and PASS or FAIL only, and the caller
# publishes summary.md and verdict.txt once its leak gate has passed.

[CmdletBinding(DefaultParameterSetName = 'Server')]
param(
    [Parameter(Mandatory)][string]$OutDir,
    # Exact build tag compiled into the loader (/p:ModLoaderBuildTag).
    [Parameter(Mandatory, ParameterSetName = 'Server')][string]$ExpectTag,
    # Plugin names that must report a "Plugin info" line.
    [Parameter(Mandatory, ParameterSetName = 'Server')][string[]]$ExpectPlugins,
    # Same regex boot-server.ps1 waited for; re-checked here against the logs.
    [Parameter(ParameterSetName = 'Server')][string]$ReadyRegex = 'LogLoad: Took [\d.]+ seconds to LoadMap\(/Game/Chimera/Maps/ChimeraMain/ChimeraMain\)',
    # Judge a client launch (see the file list above) instead of a server boot.
    [Parameter(Mandatory, ParameterSetName = 'Client')][switch]$Client
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

function First-Match($Lines, [string]$Regex, [switch]$Case) {
    if ($null -eq $Lines) { return $null }
    foreach ($l in $Lines) {
        if ($Case) { if ($l -cmatch $Regex) { return $l } }
        elseif ($l -match $Regex) { return $l }
    }
    return $null
}

function Get-Prop($Obj, [string]$Name, $Default = $null) {
    if ($null -ne $Obj -and $Obj.PSObject.Properties[$Name]) { return $Obj.PSObject.Properties[$Name].Value }
    return $Default
}

function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}

# Log lines a declared refusal accounts for (client mode only); the handoff checks and
# the error scan skip them. Empty in server mode.
$accounted = New-Object 'System.Collections.Generic.HashSet[string]'

# True when boot.json carries the field at all. Null or an empty value is a record that
# nothing was found; a missing field is no record.
function Test-BootField($Boot, [string]$Name) { return ($null -ne $Boot) -and ($null -ne $Boot.PSObject.Properties[$Name]) }

# Fail when the loader wrote a compatibility report (the game's layout changed under
# the plugins) or switched plugins off. Both mean the handoff to a new build is not
# clean. Client mode (-SkipCompat) judges the report by its contents instead
# (Get-CompatJudgement) and keeps only the switched-off check here.
function Add-HandoffChecks($Ml, $Boot, [switch]$RequireBootField, [switch]$SkipCompat) {
    $haveLog = ($null -ne $Ml) -and $Ml.Count -gt 0
    $compat = $null; $off = $null
    if ($Ml) {
        foreach ($l in $Ml) {
            if ($accounted.Contains($l)) { continue }
            if ($null -eq $compat -and $l -match 'Compatibility report written') { $compat = $l }
            if ($null -eq $off -and $l -match 'switched off|Plugin loading is off') { $off = $l }
        }
    }
    $listed = @(@(Get-Prop $Boot 'compat_reports' @()) | Where-Object { $_ })
    $fieldOk = (-not $RequireBootField) -or (Test-BootField $Boot 'compat_reports')
    if (-not $SkipCompat) {
        Add-Check 'no_compat_report' ($haveLog -and $fieldOk -and $null -eq $compat -and $listed.Count -eq 0) $(
            if ($compat) { "FOUND: $compat" } elseif ($listed.Count -gt 0) { 'boot.json lists: ' + ($listed -join '; ') } elseif (-not $fieldOk) { 'boot.json has no compat_reports field' } elseif ($haveLog) { 'no report line, none listed in boot.json' } else { '' })
    }
    Add-Check 'plugins_not_switched_off' ($haveLog -and $null -eq $off) $(
        if ($off) { "FOUND: $off" } elseif ($haveLog) { 'no "switched off" line' } else { '' })
}

# Client mode: judges the compat-report-<CL>.json files boot.json lists by what they say.
# The loader writes one when the game's layout changed under it (compat_report.cpp, format
# 3; format 4 adds outcome "unchanged" and sizes): outcome "safe-off" (every plugin refused),
# "partial" or, from format 4, "unchanged" (layout did not move, a size request wrote the
# report; both informational on their own),
# patternMisses[] {name, required, found}, globals[] {name, resolved, rejected} and
# changes[] {class, member, field, sdk, game}, and sizes[] {plugin, key, rowCL, rowSize,
# reflectedSize, result}: one entry per class-key size request, the map row's size against the
# size the running game reflects. Returns Bad (what fails), Notes (what passes but is worth a
# look), Sizes (one line per sizes[] entry, passing or not), SizeCounts (entries per result),
# Parsed (reports read) and Changes (changes[] entries seen).
function Get-CompatJudgement($Ml, $Boot) {
    $arrow = [string][char]0x2192
    $bad = New-Object System.Collections.Generic.List[string]
    $notes = New-Object System.Collections.Generic.List[string]
    $sizeLines = New-Object System.Collections.Generic.List[string]
    $sizeCounts = [ordered]@{}
    $parsed = 0; $changeCount = 0
    $listed = @(@(Get-Prop $Boot 'compat_reports' @()) | Where-Object { $_ })
    if (-not (Test-BootField $Boot 'compat_reports')) { $bad.Add('boot.json has no compat_reports field') }
    $written = $null
    $quiet = $false
    if ($Ml) {
        foreach ($l in $Ml) {
            if ($null -eq $written -and $l -match 'Compatibility report written') { $written = $l }
            if ($l -match 'Layout changed on this build \(.*\): no loader feature reads them') { $quiet = $true }
        }
    }
    if ($written -and $listed.Count -eq 0) { $bad.Add("the log says a report was written but boot.json lists none: $written") }
    foreach ($name in $listed) {
        $name = [string]$name
        if ($name -cnotmatch '^compat-report-[A-Za-z0-9._-]+\.json$') { $bad.Add("$name is not a compat report file name"); continue }
        $path = Join-Path $OutDir $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $bad.Add("$name is listed in boot.json but was not kept"); continue }
        $r = $null
        try { $r = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json -ErrorAction Stop } catch { $r = $null }
        if ($null -eq $r -or $r -isnot [pscustomobject]) { $bad.Add("$name cannot be parsed"); continue }
        $shape = @()
        $outcome = [string](Get-Prop $r 'outcome' '')
        if ($outcome -eq '') { $shape += 'outcome' }
        foreach ($k in 'patternMisses', 'globals', 'changes') {
            if (-not $r.PSObject.Properties[$k] -or $r.PSObject.Properties[$k].Value -isnot [System.Array]) { $shape += $k }
        }
        if ($shape.Count -gt 0) { $bad.Add("$name has no usable " + ($shape -join ', ')); continue }
        $parsed++
        if ($outcome -ceq 'safe-off') { $bad.Add("$name outcome is safe-off: every plugin is switched off") }
        elseif ($outcome -cne 'partial' -and $outcome -cne 'unchanged') { $bad.Add("$name outcome is '$outcome', not partial or unchanged") }
        foreach ($m in @($r.patternMisses)) {
            $mName = [string](Get-Prop $m 'name' ''); $req = Get-Prop $m 'required'
            if ($mName -eq '' -or $req -isnot [bool]) { $bad.Add("$name has a pattern miss without name or required"); continue }
            if ($req) { $bad.Add("${name}: required pattern missed: $mName") } else { $notes.Add("optional pattern missed: $mName") }
        }
        foreach ($g in @($r.globals)) {
            $gName = [string](Get-Prop $g 'name' ''); $res = Get-Prop $g 'resolved'; $rej = Get-Prop $g 'rejected'
            if ($gName -eq '' -or $res -isnot [bool] -or $rej -isnot [bool]) { $bad.Add("$name has a global without name, resolved or rejected"); continue }
            if (-not $res) { $bad.Add("${name}: global $gName is unresolved") }
            elseif ($rej) { $bad.Add("${name}: global $gName was rejected") }
        }
        foreach ($c in @($r.changes)) {
            $cls = [string](Get-Prop $c 'class' ''); $mem = [string](Get-Prop $c 'member' ''); $field = [string](Get-Prop $c 'field' '')
            if ($cls -eq '' -or $mem -eq '' -or $field -eq '') { $bad.Add("$name has a change without class, member or field"); continue }
            $changeCount++
            if ($field -ceq 'missing' -or $field -ceq 'vtableSlot') { $bad.Add("${name}: ${cls}::$mem is $field"); continue }
            $sdk = Get-Prop $c 'sdk'; $game = Get-Prop $c 'game'
            if ($sdk -isnot [ValueType] -or $game -isnot [ValueType]) { $bad.Add("${name}: ${cls}::$mem ($field) has no sdk and game values"); continue }
            $what = if ($field -cne 'offset') { "$field " } else { '' }
            $why = if ($quiet) { ' (keys-only, no loader feature reads it)' } else { '' }
            $notes.Add(('layout moved: {0}::{1} {2}0x{3:X}{4}0x{5:X}{6}' -f $cls, $mem, $what, [long]$sdk, $arrow, [long]$game, $why))
        }
        # A class-key size row against the size the game reflects. A loader that writes no
        # "sizes", or an empty one, leaves this out entirely.
        $sizesProp = $r.PSObject.Properties['sizes']
        if ($sizesProp -and $null -ne $sizesProp.Value) {
            if ($sizesProp.Value -isnot [System.Array]) { $bad.Add("$name has no usable sizes"); continue }
            foreach ($e in @($sizesProp.Value)) {
                $plugin = [string](Get-Prop $e 'plugin' ''); $key = [string](Get-Prop $e 'key' ''); $res = [string](Get-Prop $e 'result' '')
                $rowSize = Get-Prop $e 'rowSize'; $refl = Get-Prop $e 'reflectedSize'; $rowCL = Get-Prop $e 'rowCL'
                if ($plugin -eq '' -or $key -eq '' -or $res -eq '') { $bad.Add("$name has a size entry without plugin, key or result"); continue }
                if (($null -ne $rowSize -and $rowSize -isnot [ValueType]) -or ($null -ne $refl -and $refl -isnot [ValueType])) { $bad.Add("${name}: ${plugin}: $key has a size that is not a number"); continue }
                $rowText = if ($null -ne $rowSize) { ('0x{0:X}' -f [long]$rowSize) + $(if ($null -ne $rowCL) { " (CL-$rowCL)" } else { '' }) } else { 'none' }
                $reflText = if ($null -ne $refl) { '0x{0:X}' -f [long]$refl } else { 'none' }
                $line = "size row ${plugin}: $key row $rowText, reflected ${reflText}: "
                $problem = $null
                switch -CaseSensitive ($res) {
                    'match'          { if ($null -eq $rowSize -or $null -eq $refl) { $problem = 'match without both sizes' } elseif ([long]$rowSize -ne [long]$refl) { $problem = 'reported as a match but the sizes differ' } }
                    'mismatch'       { if ($null -eq $rowSize -or $null -eq $refl) { $problem = 'mismatch without both sizes' } elseif ([long]$rowSize -eq [long]$refl) { $problem = 'reported as a mismatch but the sizes are equal' } }
                    'row-only'       { if ($null -eq $rowSize) { $problem = 'row-only without a row size' } }
                    'reflected-only' { if ($null -eq $refl) { $problem = 'reflected-only without a reflected size' } }
                    'no-row'         { }
                    default          { $problem = "has the unknown result '$res'" }
                }
                if ($problem) { $bad.Add("${name}: ${plugin}: $key $problem"); continue }
                $sizeCounts[$res] = 1 + $(if ($sizeCounts.Contains($res)) { $sizeCounts[$res] } else { 0 })
                switch -CaseSensitive ($res) {
                    'match'          { $sizeLines.Add($line + 'match') }
                    'mismatch'       { $sizeLines.Add($line + 'MISMATCH'); $bad.Add("${name}: ${plugin}: $key size row is $rowText, the game reflects $reflText") }
                    'row-only'       { $sizeLines.Add($line + 'unreflected, row only') }
                    'reflected-only' { $sizeLines.Add($line + 'no row, reflected only') }
                    'no-row'         { $sizeLines.Add($line + 'NO ROW'); $bad.Add("${name}: ${plugin}: $key is unreflected and has no size row") }
                }
            }
        }
    }
    # With a report on record, a plugin that lost a feature is not a clean handoff.
    if ($listed.Count -gt 0 -and $Ml) {
        foreach ($l in $Ml) {
            if ($l -cmatch '\[Map\] (\S+): feature "(.+?)" is off') { $bad.Add("$($Matches[1]) feature ""$($Matches[2])"" is off") }
        }
    }
    return [pscustomobject]@{ Listed = $listed; Written = $written; Bad = @($bad); Notes = @($notes); Sizes = @($sizeLines); SizeCounts = $sizeCounts; Parsed = $parsed; Changes = $changeCount }
}

# Check lines, verdict.txt and the job summary. Client mode sets $script:LeadMd (the
# per-plugin table, printed first) and $script:VerdictJson (written as verdict.json).
# Server mode prints the evidence and appends the summary to GITHUB_STEP_SUMMARY. Client
# mode quotes launch logs there, so it prints names only and writes summary.md instead.
$script:LeadMd = $null
$script:VerdictJson = $null
$script:Notes = @()
function Publish-Verdict([string]$Title) {
    $failed = @($results | Where-Object { -not $_.Pass })
    $lines = foreach ($r in $results) { '{0,-26} {1,-4} {2}' -f $r.Name, $(if ($r.Pass) { 'PASS' } else { 'FAIL' }), $r.Evidence }
    if ($Client) { foreach ($r in $results) { Write-Host ('{0,-26} {1}' -f $r.Name, $(if ($r.Pass) { 'PASS' } else { 'FAIL' })) } }
    else { $lines | ForEach-Object { Write-Host $_ } }
    $overall = if ($failed.Count -eq 0) { 'PASS' } else { "FAIL ($($failed.Count) of $($results.Count) checks)" }
    Write-Host "VERDICT: $overall"

    $md = New-Object System.Collections.Generic.List[string]
    $md.Add("### ${Title}: $overall")
    $md.Add('')
    if ($script:LeadMd) { foreach ($m in $script:LeadMd) { $md.Add($m) }; $md.Add('') }
    $md.Add('| Check | Result | Evidence |')
    $md.Add('|---|---|---|')
    foreach ($r in $results) {
        $ev = ($r.Evidence -replace '\|', '\|') -replace '`', "'"
        $md.Add(('| {0} | {1} | `{2}` |' -f $r.Name, $(if ($r.Pass) { 'PASS' } else { 'FAIL' }), $ev))
    }
    if ($Client) { [System.IO.File]::WriteAllText((Join-Path $OutDir 'summary.md'), (($md -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false)) }
    elseif ($env:GITHUB_STEP_SUMMARY) { $md -join "`n" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8 }
    Set-Content -LiteralPath (Join-Path $OutDir 'verdict.txt') -Value (@($lines) + "VERDICT: $overall") -Encoding utf8
    if ($script:VerdictJson) {
        [System.IO.File]::WriteAllText((Join-Path $OutDir 'verdict.json'), ($script:VerdictJson | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))
    }
    return $failed.Count
}

# ---- client mode ---------------------------------------------------------------
# Refusal and crash lines of the loader (plugin_manager.cpp, plugin_hook_report.cpp).
# Each yields the plugin's log name (capture 1) ...
$script:NamedLines = @(
    @{ Kind = 'crashed'; Re = "Plugin '([^']+)' CRASHED " },
    @{ Kind = 'crashed'; Re = "Plugin '([^']+)' crashed during PluginInit" },
    @{ Kind = 'crashed'; Re = "\[PluginGuard\] Fault .*? under plugin '([^']+)'" },
    @{ Kind = 'refused'; Re = "Plugin '([^']+)'[^\r\n]*switched off" },
    @{ Kind = 'refused'; Re = "Plugin '([^']+)' is not loaded: " },
    @{ Kind = 'refused'; Re = "Plugin '([^']+)' was NOT loaded: " },
    @{ Kind = 'refused'; Re = "Plugin '([^']+)' was built for a .+ build but this is a .+ build -- refusing to load" },
    @{ Kind = 'refused'; Re = "\[HookScan\] '([^']+)' will NOT be loaded" },
    @{ Kind = 'initfailed'; Re = 'Plugin initialization failed: (\S+)' }
)
# ... or only the DLL path (capture 1), which set.json's optional "dll" resolves.
$script:PathLines = @(
    @{ Kind = 'crashed'; Re = "Plugin DLL '(.+?)' CRASHED during" },
    @{ Kind = 'crashed'; Re = 'Plugin DLL crashed while loading -- skipping: (.+)$' },
    @{ Kind = 'refused'; Re = 'Plugin interface version \d+ is newer than this loader supports \(up to \d+\): (.+)$' },
    @{ Kind = 'refused'; Re = 'Plugin loading is off \(.*\) -- skipping: (.+)$' },
    @{ Kind = 'refused'; Re = 'Plugin missing required exports: (.+)$' },
    @{ Kind = 'refused'; Re = 'Failed to load plugin DLL: (.+?) \(error: \d+\)' }
)

function Get-PluginLines($Ml, $Specs) {
    $items = New-Object System.Collections.Generic.List[object]
    if (-not $Ml) { return , @() }
    foreach ($l in $Ml) {
        $hit = $null
        foreach ($p in $script:NamedLines) {
            if ($l -match $p.Re) { $hit = [pscustomobject]@{ Kind = $p.Kind; Name = $Matches[1]; Line = $l }; break }
        }
        if (-not $hit) {
            foreach ($p in $script:PathLines) {
                if ($l -match $p.Re) {
                    $file = ($Matches[1].Trim().Trim("'") -split '[\\/]')[-1]
                    $owner = @($Specs | Where-Object { $_.Dll -and $_.Dll -ieq $file }) | Select-Object -First 1
                    $hit = [pscustomobject]@{ Kind = $p.Kind; Name = $(if ($owner) { $owner.LogName } else { $null }); Line = $l }
                    break
                }
            }
        }
        if ($hit) { $items.Add($hit) }
    }
    return , $items.ToArray()
}

function Short([string]$Text, [int]$Max = 150) {
    if ($Text.Length -le $Max) { return $Text }
    return $Text.Substring(0, $Max - 3) + '...'
}

# A log line without its time, level and thread prefix.
function Bare([string]$Line) { return ($Line -replace '^\[[\d:.]+\]\s+\[\w+\s*\]\s+\[T:\d+\]\s+', '') }

function Invoke-ClientVerdict {
    $boot = Read-Json (Join-Path $OutDir 'boot.json')
    $set = Read-Json (Join-Path $OutDir 'set.json')
    $hashes = Read-Json (Join-Path $OutDir 'dll-hashes.json')
    $ml = Read-Lines (Join-Path $OutDir 'modloader.log')
    $proxy = Read-Lines (Join-Path $OutDir 'proxy.log')
    $au = Read-Lines (Join-Path $OutDir 'autoupdate.log')
    $haveLog = ($null -ne $ml) -and $ml.Count -gt 0
    $compat = Get-CompatJudgement $ml $boot

    # ---- the set under test ----
    $specs = @()
    $setOk = $false; $setEv = ''
    $loaderExpect = [string](Get-Prop (Get-Prop $set 'loader') 'expect' '')
    if ($set) {
        $raw = @(Get-Prop $set 'plugins' @())
        $bad = @()
        foreach ($p in $raw) {
            $repo = [string](Get-Prop $p 'repo' '')
            $refused = [bool](Get-Prop $p 'expectRefused' $false)
            $expect = [string](Get-Prop $p 'expect' '')
            if (-not $repo -or (-not $refused -and -not $expect)) { $bad += $(if ($repo) { $repo } else { '(no repo)' }); continue }
            $logName = [string](Get-Prop $p 'logName' '')
            $specs += [pscustomobject]@{
                Repo = $repo; LogName = $(if ($logName) { $logName } else { $repo }); Expect = $expect
                Refused = $refused; Removed = [bool](Get-Prop $p 'removed' $false); Dll = [string](Get-Prop $p 'dll' '')
                UiOffInitFailure = [string](Get-Prop $p 'uiOffInitFailure' '')
            }
        }
        $setOk = ($loaderExpect -ne '') -and ($raw.Count -gt 0) -and ($bad.Count -eq 0)
        $setEv = if ($setOk) { "set.json parsed: loader $loaderExpect, $($specs.Count) plugin(s), branch $(Get-Prop $set 'branch' 'n/a'), build $(Get-Prop $set 'buildId' 'n/a')" }
                 elseif ($bad.Count -gt 0) { 'set.json: plugin entry without repo or expect: ' + ($bad -join ', ') }
                 else { 'set.json has no loader.expect or no plugins' }
    }
    Add-Check 'set_record' $setOk $setEv
    Add-Check 'boot_record' ($null -ne $boot) $(if ($boot) { "boot.json parsed, label $(Get-Prop $boot 'label' 'n/a')" } else { '' })
    Add-Check 'modloader_log_present' $haveLog $(if ($haveLog) { "$($ml.Count) lines" } else { '' })
    Add-Check 'proxy_log_present' (($null -ne $proxy) -and $proxy.Count -gt 0) $(if ($proxy -and $proxy.Count -gt 0) { "$($proxy.Count) lines" } else { '' })
    Add-Check 'autoupdate_log_present' (($null -ne $au) -and $au.Count -gt 0) $(if ($au -and $au.Count -gt 0) { "$($au.Count) lines" } else { '' })

    # ---- client process (boot.json) ----
    if ($boot) {
        Add-Check 'client_process_started' ([bool](Get-Prop $boot 'process_found' $false)) "shipping process found after $(Get-Prop $boot 'process_found_s' 'n/a') s"
        $exited = [bool](Get-Prop $boot 'exited_early' $false)
        $alive = [bool](Get-Prop $boot 'alive_at_end' $false) -and -not $exited
        Add-Check 'client_alive_at_end' $alive "alive_at_end=$(Get-Prop $boot 'alive_at_end' 'n/a') exited_early=$exited exit_code=$(Get-Prop $boot 'exit_code' 'n/a')"
        # A field the launch did not write is no evidence of a clean run: only an explicit
        # empty list, null or empty string passes.
        $crashes = @(@(Get-Prop $boot 'crash_files' @()) | Where-Object { $_ })
        $haveFiles = Test-BootField $boot 'crash_files'
        Add-Check 'no_crash_files' ($haveFiles -and $crashes.Count -eq 0) $(if ($crashes.Count -gt 0) { 'FOUND: ' + ($crashes -join '; ') } elseif (-not $haveFiles) { 'boot.json has no crash_files field' } else { 'no crash files' })
        $dialog = [string](Get-Prop $boot 'crash_dialog' '')
        $haveDialog = Test-BootField $boot 'crash_dialog'
        Add-Check 'no_crash_dialog' ($haveDialog -and $dialog -eq '') $(if ($dialog -ne '') { "FOUND dialog: $dialog" } elseif (-not $haveDialog) { 'boot.json has no crash_dialog field' } else { 'no crash dialog recorded' })
    } else {
        foreach ($n in 'client_process_started', 'client_alive_at_end', 'no_crash_files', 'no_crash_dialog') { Add-Check $n $false '' }
    }

    # ---- proxy ----
    $proxyBad = First-Match $proxy 'FATAL|bootstrap failed'
    $attached = First-Match $proxy 'Core_Attach\(\) succeeded'
    Add-Check 'proxy_core_attached' (($null -ne $attached) -and $null -eq $proxyBad) $(if ($proxyBad) { "FOUND: $proxyBad" } else { $attached })

    # ---- loader ----
    $buildLine = First-Match $ml '\[init\] Build: (.+?) \(client\), PID'
    $logLoader = ''
    if ($buildLine -and $buildLine -match '\[init\] Build: (.+?) \(client\), PID') { $logLoader = $Matches[1] }
    Add-Check 'loader_build_line' ([bool]($buildLine -and $loaderExpect -ne '' -and ($logLoader -ceq $loaderExpect))) $(if ($buildLine) { "$buildLine  (expected $loaderExpect)" } else { '' })
    $clientBuild = First-Match $ml 'Running client build of modloader'
    Add-Check 'loader_client_build' ($null -ne $clientBuild) $clientBuild
    $gv = First-Match $ml 'Game version OK:'
    Add-Check 'game_version_ok' ($null -ne $gv) $gv

    # ---- the seeded feed (feed-path rig only) ----
    # The cache holds a TEST-signed feed for the running build, with rows the loader's own map
    # lacks or holds with other values (the workflow runs this rig only then). The loader must
    # read it (the line names the seq), take rows from it ("N rows from the feed", N > 0: the
    # loader counts the rows it took from the feed, and a row the compiled map holds for the
    # running exe wins over the feed's), do it before the game version gate, and pass that gate
    # on the CL the feed was made for. Fetching, a refused feed and a cache fault all fail; a run
    # that touched the network is not a test of the cache.
    $feedSpec = Get-Prop $set 'feed' $null
    if ($feedSpec) {
        $fSeq = [string](Get-Prop $feedSpec 'seq' '')
        $fCl = [string](Get-Prop $feedSpec 'cl' '')
        $fSpecOk = ($fSeq -cmatch '^[1-9][0-9]{0,14}$') -and ($fCl -cmatch '^[1-9][0-9]{0,8}$')
        Add-Check 'feed_record' $fSpecOk $(if ($fSpecOk) { "set.json feed: seq $fSeq, CL $fCl" } else { '' })
        $fApplied = $null; $fRows = 0; $fAt = -1; $gvAt = -1
        if ($fSpecOk -and $ml) {
            for ($i = 0; $i -lt $ml.Count; $i++) {
                if ($null -eq $fApplied -and $ml[$i] -cmatch "\[VersionFeed\] Feed seq $fSeq \(key [^,)]+, TEST KEY\): (\d+) rows from the feed") {
                    $fApplied = $ml[$i]; $fRows = [int]$Matches[1]; $fAt = $i
                }
                if ($gvAt -lt 0 -and $ml[$i] -cmatch '\[ModLoader\] Game version OK:') { $gvAt = $i }
            }
        }
        Add-Check 'feed_applied' ($null -ne $fApplied -and $fRows -gt 0) $fApplied
        $gvCl = ''
        if ($gv -and $gv -cmatch 'Game version OK: .*-CL-(\d+)') { $gvCl = $Matches[1] }
        Add-Check 'feed_rows_used' ($fSpecOk -and $null -ne $fApplied -and $fAt -ge 0 -and $gvAt -gt $fAt -and $gvCl -ceq $fCl) $(
            if ($gv) { "$gv  (CL $fCl expected; feed line at log line $($fAt + 1), version gate at $($gvAt + 1))" } else { '' })
        $fBad = First-Match $ml '\[VersionFeed\].*(feed cache is not usable|feed cache .* could not be read|from the feed is refused|fetched feed is refused|feed could not be fetched)'
        Add-Check 'feed_not_refused' ($haveLog -and $null -eq $fBad) $(if ($fBad) { "FOUND: $fBad" } elseif ($haveLog) { 'no refusal or cache fault line' } else { '' })
        $fFetch = First-Match $ml '\[VersionFeed\] (Fetching the feed|Feed seq \d+ stored for the next launch|The fetched feed is not stored)'
        Add-Check 'feed_not_fetched' ($haveLog -and $null -eq $fFetch) $(if ($fFetch) { "FOUND: $fFetch" } elseif ($haveLog) { 'no fetch or store line' } else { '' })
    }

    $pf = First-Match $ml '\[Preflight\] Pattern verification complete: (\d+)/(\d+) usable \((\d+) fatal, (\d+) non-fatal\)'
    $pfOk = $false
    if ($pf -and $pf -match 'complete: (\d+)/(\d+) usable \((\d+) fatal, (\d+) non-fatal\)') {
        $pfOk = ([int]$Matches[2] -gt 0) -and ($Matches[1] -eq $Matches[2]) -and ([int]$Matches[3] -eq 0) -and ([int]$Matches[4] -eq 0)
    }
    Add-Check 'preflight_all_usable' $pfOk $pf
    $pfPassed = First-Match $ml '\[init\] Pattern preflight passed in'
    Add-Check 'preflight_passed_line' ($null -ne $pfPassed) $pfPassed
    $hooks = First-Match $ml '\[init\] Engine hooks installed in'
    Add-Check 'engine_hooks_installed' ($null -ne $hooks) $hooks
    $disabled = First-Match $ml '(?i)Starting the game unmodified|mod loader disabled|Pattern preflight failed|REQUIRED pattern FAILED|VERSION MISMATCH|Hook installation aborted|chose to start the game without'
    Add-Check 'loader_not_disabled' ($haveLog -and $null -eq $disabled) $(if ($disabled) { "FOUND: $disabled" } elseif ($haveLog) { 'no disable line' } else { '' })

    # Layout: the loader's check of the SDK's class layouts against the running game.
    # A moved member is no fault when the loader's own compat report, judged by its contents,
    # holds only changes it can live with (Get-CompatJudgement): then it is a note.
    $lay = First-Match $ml '\[LayoutCheck\] SDK CL \d+ against the game: (\d+) classes, (\d+) checked, (\d+) mismatched, (\d+) missing'
    $layOk = $false; $layMoved = $false
    if ($lay -and $lay -match 'against the game: (\d+) classes, (\d+) checked, (\d+) mismatched, (\d+) missing') {
        $layMoved = [int]$Matches[3] -gt 0
        $layOk = ([int]$Matches[2] -gt 0) -and ([int]$Matches[4] -eq 0)
    }
    $layBad = First-Match $ml 'Layout mismatch'
    $layChanged = First-Match $ml 'Layout changed on this build'
    $layExplained = $layMoved -and $null -ne $layChanged -and $compat.Parsed -gt 0 -and $compat.Changes -gt 0 -and $compat.Bad.Count -eq 0
    $layPass = $layOk -and $null -eq $layBad -and ($layExplained -or (-not $layMoved -and $null -eq $layChanged))
    Add-Check 'layout_ok' $layPass $(
        if ($layBad) { "FOUND: $layBad" } elseif ($layChanged -and -not $layExplained) { "FOUND: $layChanged" }
        elseif ($layExplained) { "$lay; " + ($compat.Notes -join '; ') } else { $lay })

    # ---- no update traffic ----
    # The loader logs "Starting auto-update check" even when updates are off, and the
    # next line says so (see the nine-plugin run). Only a check that was not switched
    # off counts, and any Manifest URL line means a manifest was about to be fetched.
    $manifest = First-Match $ml 'Manifest URL'
    $pending = $null
    foreach ($l in $(if ($ml) { $ml } else { @() })) {
        if ($l -match 'Starting auto-update check') { $pending = $l }
        elseif ($l -match '\[AutoUpdate\].*Disabled via modloader\.ini') { $pending = $null }
    }
    Add-Check 'no_update_check' ($haveLog -and $null -eq $manifest -and $null -eq $pending) $(
        if ($manifest) { "FOUND: $manifest" } elseif ($pending) { "FOUND, not followed by the disabled line: $pending" } elseif ($haveLog) { 'check logged only with the disabled line, no Manifest URL' } else { '' })
    $auOff = First-Match $au '(?i)disabled via modloader\.ini'
    Add-Check 'autoupdate_log_disabled' ($null -ne $auOff) $auOff

    # ---- DLLs untouched ----
    $changed = @(); $nDll = 0
    if ($hashes) {
        foreach ($e in $hashes.PSObject.Properties) {
            $nDll++
            $b = [string](Get-Prop $e.Value 'before' ''); $a = [string](Get-Prop $e.Value 'after' '')
            if (-not $b -or -not $a -or $b -ine $a) {
                $changed += "$($e.Name) ($(if ($b) { $b.Substring(0, [Math]::Min(8, $b.Length)) } else { 'none' }) -> $(if ($a) { $a.Substring(0, [Math]::Min(8, $a.Length)) } else { 'none' }))"
            }
        }
    }
    Add-Check 'dll_hashes_unchanged' ($nDll -gt 0 -and $changed.Count -eq 0) $(
        if ($nDll -eq 0) { '' } elseif ($changed.Count -gt 0) { 'CHANGED: ' + ($changed -join '; ') } else { "$nDll DLL(s), sha256 equal before and after" })

    # ---- plugins ----
    $found = Get-PluginLines $ml $specs
    # A declared refusal accounts for that plugin's refusal lines only: a fault or crash
    # line of the same plugin still fails the crash, error and fault checks.
    foreach ($s in $specs) {
        if ($s.Refused) { foreach ($i in $found) { if ($i.Kind -eq 'refused' -and $i.Name -ceq $s.LogName) { [void]$accounted.Add($i.Line) } } }
    }
    $rows = @()
    $uiOffCount = 0
    foreach ($s in $specs) {
        $esc = [regex]::Escape($s.LogName)
        $info = First-Match $ml "Plugin info - Name: $esc," -Case
        $logVer = ''
        if ($info -and $info -cmatch "Plugin info - Name: $esc, Version: (.+?), Author") { $logVer = $Matches[1] }
        $loaded = First-Match $ml "Successfully loaded plugin DLL: $esc " -Case
        $mine = @($found | Where-Object { $_.Name -ceq $s.LogName })
        $refusals = @($mine | Where-Object { $_.Kind -eq 'refused' })
        $crashLines = @($mine | Where-Object { $_.Kind -in 'crashed', 'initfailed' })
        $off = @()
        if ($ml) { foreach ($l in $ml) { if ($l -cmatch ('\[Map\] ' + $esc + ': feature "(.+?)" is off')) { $off += $Matches[1] } } }
        $note = @()
        $state = 'ok'
        if ($s.Refused) {
            Add-Check "plugin_not_loaded_$($s.Repo)" ($haveLog -and $null -eq $loaded) $(if ($loaded) { "FOUND, declared refused: $loaded" } elseif ($haveLog) { "no load line for $($s.LogName)" } else { '' })
            $refLine = if ($refusals.Count -gt 0) { $refusals[0].Line } else { $null }
            Add-Check "plugin_refusal_line_$($s.Repo)" ($null -ne $refLine) $(if ($refLine) { $refLine } else { "no refusal line for $($s.LogName)" })
            Add-Check "plugin_no_fault_$($s.Repo)" ($haveLog -and $crashLines.Count -eq 0) $(
                if ($crashLines.Count -gt 0) { "FOUND: $($crashLines[0].Line)" } elseif ($haveLog) { "no crash or init-failure line for $($s.LogName)" } else { '' })
            $state = if ($loaded) { 'loaded (declared refused)' } elseif ($crashLines.Count -gt 0) { 'crashed' } elseif ($refLine) { 'refused (as declared)' } else { 'not refused (no refusal line)' }
            if ($refLine) { $note += (Short (Bare $refLine) 120) }
            if ($crashLines.Count -gt 0) { $note += (Short (Bare $crashLines[0].Line) 120) }
        } else {
            $hasLoad = ($null -ne $info) -and ($null -ne $loaded)
            $loadEv = if ($hasLoad) { $loaded } else {
                "no load line for $($s.LogName)" + $(if ($s.Removed) { ' (removed from the install)' } else { '' }) + $(if ($info -and -not $loaded) { ': Plugin info present, DLL load line missing' } else { '' })
            }
            Add-Check "plugin_loaded_$($s.Repo)" $hasLoad $loadEv
            $verOk = ($logVer -ne '') -and ($logVer -ceq $s.Expect)
            Add-Check "plugin_version_$($s.Repo)" $verOk $(if ($logVer) { "log version $logVer, expected $($s.Expect)" } else { '' })
            Add-Check "plugin_not_refused_$($s.Repo)" ($haveLog -and $refusals.Count -eq 0) $(
                if ($refusals.Count -gt 0) { "FOUND: $($refusals[0].Line)" } elseif ($haveLog) { "no refusal or switched-off line for $($s.LogName)" } else { '' })
            $inited = First-Match $ml ("Plugin initialized: $esc$") -Case
            # A plugin whose init needs the UI layer the rig turns off ([UI] Enabled=0) logs one
            # known ERROR and then "Plugin initialization failed". That pair, and nothing else
            # for the plugin, passes it as loaded; the ERROR line is the only one excused.
            $uiOffLine = $null
            if ($s.UiOffInitFailure -and $hasLoad -and $verOk -and -not $inited -and $refusals.Count -eq 0 -and $crashLines.Count -eq 1 -and $crashLines[0].Kind -eq 'initfailed') {
                $want = "[Plugin:$($s.LogName)] $($s.UiOffInitFailure)"
                $hits = @(); $errAt = -1; $failAt = -1
                for ($i = 0; $i -lt $ml.Count; $i++) {
                    if ($ml[$i] -cmatch '^\[[\d:.]+\]\s+\[ERROR\s*\]' -and $ml[$i].EndsWith($want, [StringComparison]::Ordinal)) { $hits += $ml[$i]; $errAt = $i }
                    if ($ml[$i] -ceq $crashLines[0].Line -and $failAt -lt 0) { $failAt = $i }
                }
                if ($hits.Count -eq 1 -and $failAt -gt $errAt) { $uiOffLine = $hits[0]; [void]$accounted.Add($uiOffLine); $uiOffCount++ }
            }
            Add-Check "plugin_no_fault_$($s.Repo)" ($haveLog -and ($crashLines.Count -eq 0 -or $uiOffLine)) $(
                if ($uiOffLine) { "loaded, not refused; init needs the UI layer the rig turns off: $uiOffLine" }
                elseif ($crashLines.Count -gt 0) { "FOUND: $($crashLines[0].Line)" } elseif ($haveLog) { "no crash or init-failure line for $($s.LogName)" } else { '' })
            Add-Check "plugin_initialized_$($s.Repo)" (($null -ne $inited) -or $uiOffLine) $(
                if ($uiOffLine) { 'not initialised, as expected: init needs the UI layer the rig turns off ([UI] Enabled=0)' } else { $inited })
            if ($refusals.Count -gt 0) { $state = 'refused'; $note += (Short (Bare $refusals[0].Line) 120) }
            elseif ($uiOffLine) { $state = 'loaded; init needs the UI layer the rig turns off'; $note += (Short (Bare $uiOffLine) 120) }
            elseif ($crashLines.Count -gt 0) { $state = 'crashed'; $note += (Short (Bare $crashLines[0].Line) 120) }
            elseif (-not $hasLoad) { $state = 'missing'; if ($s.Removed) { $note += 'removed from the install' } }
            elseif (-not $verOk) { $state = 'wrong version' }
            elseif (-not $inited) { $state = 'not initialised' }
        }
        if ($off.Count -gt 0) { $note += "$($off.Count) feature(s) off: " + (($off | ForEach-Object { '"' + $_ + '"' }) -join ', ') }
        $rows += [pscustomobject]@{ name = $s.Repo; expected = $s.Expect; logVersion = $logVer; state = $state; note = ($note -join '; ') }
    }

    # Refusal lines for a plugin the set does not name, or that name no plugin.
    $names = @($specs | ForEach-Object { $_.LogName })
    $stray = @($found | Where-Object { $_.Kind -eq 'refused' -and ($null -eq $_.Name -or $_.Name -cnotin $names) })
    Add-Check 'no_unexpected_refusal' ($haveLog -and $stray.Count -eq 0) $(
        if ($stray.Count -gt 0) { "FOUND: $($stray[0].Line)" } elseif ($haveLog) { 'no refusal line for a plugin outside the set' } else { '' })

    # InitAllLoadedPlugins: the first line is logged early with 0 plugins; the real one
    # follows. No line may report a failure, and one must show every expected plugin.
    # Every plugin the loader read must be one the set names: a "Plugin info" or
    # "Successfully loaded" line for any other name is code nobody declared.
    $strangers = @()
    if ($ml) {
        foreach ($l in $ml) {
            if ($l -cmatch 'Plugin info - Name: ([^,]+),' -or $l -cmatch 'Successfully loaded plugin DLL: (\S+) ') {
                if ($Matches[1] -cnotin $names -and $Matches[1] -cnotin $strangers) { $strangers += $Matches[1] }
            }
        }
    }
    Add-Check 'no_unexpected_plugin' ($haveLog -and $strangers.Count -eq 0) $(
        if ($strangers.Count -gt 0) { 'FOUND a plugin outside the set: ' + ($strangers -join ', ') } elseif ($haveLog) { 'every plugin the loader read is in the set' } else { '' })

    $wantInit = @($specs | Where-Object { -not $_.Refused }).Count
    # A plugin excused for the UI layer the rig turns off is loaded but does not initialise:
    # the summary shows one fewer initialised and that many failed, and nothing more.
    $wantInited = $wantInit - $uiOffCount
    $sums = @(); if ($ml) { $sums = @($ml | Where-Object { $_ -match 'InitAllLoadedPlugins: (\d+) initialized, (\d+) failed' }) }
    $sumOk = $false; $sumEv = ''
    if ($sums.Count -gt 0) {
        $maxInit = 0; $maxFail = 0
        foreach ($l in $sums) {
            if ($l -match 'InitAllLoadedPlugins: (\d+) initialized, (\d+) failed') {
                $maxInit = [Math]::Max($maxInit, [int]$Matches[1])
                $maxFail = [Math]::Max($maxFail, [int]$Matches[2])
            }
        }
        $sumOk = ($maxFail -eq $uiOffCount) -and ($maxInit -eq $wantInited)
        $sumEv = "$($sums[-1])  (max initialized $maxInit, expected $wantInited$(if ($uiOffCount -gt 0) { ", $uiOffCount excused for the UI layer" }))"
    }
    Add-Check 'plugins_initialized' $sumOk $sumEv
    $startup = First-Match $ml 'Plugin startup phase complete'
    Add-Check 'startup_phase_complete' ($null -ne $startup) $startup
    $bootDone = First-Match $ml '\[init\] Boot sequence finished in'
    Add-Check 'boot_sequence_finished' ($null -ne $bootDone) $bootDone

    # HookScan: a plugin whose patterns do not resolve is not loaded.
    $scanBad = $null
    if ($ml) {
        foreach ($l in $ml) {
            if (-not $accounted.Contains($l) -and $l -match '\[HookScan\].*: \d+ resolved, [1-9]\d* failed|\[HookScan\] .*will NOT be loaded|one or more of its hooks could not be resolved') { $scanBad = $l; break }
        }
    }
    $scanOk = First-Match $ml '\[HookScan\] .*pattern\(s\) resolved, no failures'
    Add-Check 'hookscan_clean' ($haveLog -and $null -eq $scanBad -and $null -ne $scanOk) $(if ($scanBad) { "FOUND: $scanBad" } elseif ($scanOk) { $scanOk } else { '' })

    Add-HandoffChecks $ml $boot -RequireBootField -SkipCompat
    # A compat report is judged by what it says (Get-CompatJudgement), not by existing.
    Add-Check 'compat_report_ok' ($haveLog -and $compat.Bad.Count -eq 0) $(
        if ($compat.Bad.Count -gt 0) { 'FOUND: ' + ($compat.Bad -join '; ') }
        elseif (-not $haveLog) { '' }
        elseif ($compat.Parsed -eq 0) { 'no compat report written' }
        else {
            $sizeSummary = if ($compat.Sizes.Count -gt 0) { '; size rows: ' + (($compat.SizeCounts.Keys | ForEach-Object { "$($compat.SizeCounts[$_]) $_" }) -join ', ') } else { '' }
            "$($compat.Parsed) report(s) judged: " + $(if ($compat.Notes.Count -gt 0) { $compat.Notes -join '; ' } else { 'nothing moved' }) + $sizeSummary })
    $script:Notes = @($compat.Notes) + @($compat.Sizes)

    # ---- crashes and errors ----
    $crashRe = 'CRASHED|FATAL ENGINE CRASH|\[PluginGuard\]'
    $crash = $null
    if ($ml) { foreach ($l in $ml) { if (-not $accounted.Contains($l) -and $l -match $crashRe) { $crash = $l; break } } }
    Add-Check 'no_crash_markers' ($haveLog -and $null -eq $crash) $(if ($crash) { "FOUND: $crash" } elseif ($haveLog) { 'no CRASHED, FATAL ENGINE CRASH or PluginGuard line' } else { '' })

    # No ERROR line is known to be benign on a client: the clean client logs checked
    # (nine plugins with the overlay off, and a run with it on) have none. Keep this
    # empty; add an entry only with a line from a clean log to show for it.
    $knownBenign = @()
    $errLines = @()
    if ($ml) {
        foreach ($l in $ml) {
            if ($l -notmatch '^\[[\d:.]+\]\s+\[ERROR\s*\]' -or $l -match $crashRe -or $accounted.Contains($l)) { continue }
            $benign = $false
            foreach ($b in $knownBenign) { if ($l.Contains($b)) { $benign = $true } }
            if (-not $benign) { $errLines += $l }
        }
    }
    Add-Check 'no_loader_errors' ($haveLog -and $errLines.Count -eq 0) $(
        if ($errLines.Count -gt 0) { "$($errLines.Count) found, first: $($errLines[0])" } elseif ($haveLog) { 'no unexpected ERROR line in ModLoader.log' } else { '' })

    # ---- result ----
    $failed = @($results | Where-Object { -not $_.Pass })
    $seen = @{}; $firsts = @()
    foreach ($f in $failed) {
        if (-not $seen.ContainsKey($f.Evidence) -and $firsts.Count -lt 3) { $seen[$f.Evidence] = $true; $firsts += "$($f.Name) ($(Short $f.Evidence))" }
    }
    $reason = if ($failed.Count -eq 0) { "All $($results.Count) checks passed: loader $logLoader and $($wantInit) plugin(s) loaded at their expected versions." }
              else { "$($failed.Count) of $($results.Count) checks failed, first: " + ($firsts -join '; ') + '.' }
    $loaderState = if ($logLoader -and $logLoader -ceq $loaderExpect) { 'ok' } elseif ($logLoader) { 'wrong version' } else { 'missing' }
    $script:VerdictJson = [ordered]@{
        verdict = $(if ($failed.Count -eq 0) { 'PASS' } else { 'FAIL' })
        reason  = $reason
        notes   = @($script:Notes)
        loader  = [ordered]@{ expected = $loaderExpect; logVersion = $logLoader; state = $loaderState }
        plugins = @($rows)
    }
    $cell = { param($t) ([string]$t -replace '\|', '\|') -replace '`', "'" }
    $md = New-Object System.Collections.Generic.List[string]
    $md.Add("Branch $(Get-Prop $set 'branch' 'n/a'), build $(Get-Prop $set 'buildId' 'n/a'). $reason")
    foreach ($n in $script:Notes) { $md.Add(''); $md.Add("Note: $n") }
    $md.Add('')
    $md.Add('| Plugin | Expected | In log | State | Note |')
    $md.Add('|---|---|---|---|---|')
    $md.Add("| Loader | $(& $cell $loaderExpect) | $(& $cell $logLoader) | $loaderState | |")
    foreach ($r in $rows) { $md.Add("| $(& $cell $r.name) | $(& $cell $r.expected) | $(& $cell $r.logVersion) | $(& $cell $r.state) | $(& $cell $r.note) |") }
    $script:LeadMd = @($md)
}

if ($Client) {
    Invoke-ClientVerdict
    $failedCount = Publish-Verdict 'Client test verdict'
    if ($failedCount -gt 0) { exit 1 }
    exit 0
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
    foreach ($l in $ml) {
        if (-not ($l -match '^\[[\d:.]+\]\s+\[ERROR\s*\]' -or $l -match 'CRASHED')) { continue }
        $benign = $false
        foreach ($b in $knownBenign) { if ($l.Contains($b)) { $benign = $true } }
        if (-not $benign) { $errLines += $l }
    }
}
Add-Check 'no_loader_errors' (($null -ne $ml) -and $ml.Count -gt 0 -and $errLines.Count -eq 0) $(
    if ($errLines.Count -gt 0) { "$($errLines.Count) found, first: $($errLines[0])" } elseif ($ml -and $ml.Count -gt 0) { 'no ERROR or CRASHED line in ModLoader.log' } else { '' })

$gameFatal = $null
if ($game) { $gameFatal = First-Match $game 'Fatal error|Unhandled Exception|Assertion failed|Critical error|EXCEPTION_ACCESS_VIOLATION|appError' }
Add-Check 'no_engine_fatal' (($null -ne $game) -and $game.Count -gt 0 -and $null -eq $gameFatal) $(
    if ($gameFatal) { "FOUND: $gameFatal" } elseif ($game -and $game.Count -gt 0) { 'no fatal/crash marker in the engine log' } else { '' })

# ---- handoff -------------------------------------------------------------------
Add-HandoffChecks $ml $boot

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
$failedCount = Publish-Verdict 'Engine test verdict'
if ($failedCount -gt 0) { exit 1 }
exit 0
