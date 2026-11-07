# The client test rig's set: which loader and plugin builds go into the game client,
# fetched and installed. Three steps of one job, none of which needs the Steam login:
#
#   -Mode Resolve  Reads the dispatch inputs, the optional candidate overlay and the
#                  releases API, validates all of it, and writes the plan
#                  (rig-plan.json). Fails here, before any launch, on a bad input.
#   -Mode Fetch    Downloads what -DownloadDir (an actions/cache path) lacks: the loader's
#                  client zip and each plugin's <name>-Client.dll. Never a manifest.
#   -Mode Install  Unpacks the loader into the game folder, copies the plugins, lays the
#                  candidate over them, drops removed plugins, and writes set.json for
#                  ci/verdict.ps1 -Client.
#
# The inputs are lists of tokens separated by space, comma or semicolon:
#   -Tags "Compass=v0.20.0 Loader=v1.23.0"   release to take instead of Latest
#   -Expect "Waila=v0.21.0"                  version the log must show, instead of the release tag
#   -ExpectRefused "Codex"                   plugins that must be refused on this build
#   -RemovePlugins "Codex"                   dropped from the install but still expected
# Names are the loader, or a plugin by repo name, log name or asset name, in any case.
# A name in -Expect that is not one of the nine is an extra plugin to expect.
#
# -CandidateDir is a downloaded build artifact laid over the release set. Its layout is
# the game folder's: dwmapi.dll, ModLoader/..., ModLoader/Plugins/*.dll. Every DLL it
# replaces needs an -Expect entry.

[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Resolve', 'Fetch', 'Install')][string]$Mode,
    [string]$Branch = 'public',
    [string]$Tags = '',
    [string]$Expect = '',
    [string]$ExpectRefused = '',
    [string]$RemovePlugins = '',
    [string]$CandidateDir = '',
    # Owner of the mod repos: the same two the other pipeline workflows accept.
    [string]$Owner = 'AlienXAXS',
    [string]$PlanPath = '',
    [string]$DownloadDir = 'D:\rig-dl',
    [string]$InstallDir = '',
    [string]$OutDir = 'out'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $PlanPath) { $PlanPath = Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }) 'rig-plan.json' }

# The nine plugins. Name is the repo's short name (and the key of the inputs), LogName the
# name in the loader's "Plugin info" line, Asset the release asset's prefix: <Asset>-Client.dll
# is installed as <Asset>.dll.
$Plugins = @(
    [pscustomobject]@{ Name = 'BetterCheats'; Repo = 'StarRupture-Plugin-BetterCheats'; LogName = 'BetterCheats'; Asset = 'BetterCheats' }
    [pscustomobject]@{ Name = 'BetterDrone'; Repo = 'StarRupture-Plugin-BetterDrone'; LogName = 'BetterDrone'; Asset = 'BetterDrone' }
    [pscustomobject]@{ Name = 'CameraControls'; Repo = 'StarRupture-Plugin-CameraControls'; LogName = 'CameraControls'; Asset = 'CameraControls' }
    [pscustomobject]@{ Name = 'Codex'; Repo = 'StarRupture-Plugin-Codex'; LogName = 'Codex'; Asset = 'Codex' }
    [pscustomobject]@{ Name = 'Compass'; Repo = 'StarRupture-Plugin-Compass'; LogName = 'Compass'; Asset = 'Compass_Plugin' }
    [pscustomobject]@{ Name = 'ProductionViewer'; Repo = 'StarRupture-Plugin-ProductionViewer'; LogName = 'ProductionViewer'; Asset = 'ProductionViewer' }
    [pscustomobject]@{ Name = 'RuptureTimer'; Repo = 'StarRupture-Plugin-RuptureTimer'; LogName = 'AxRuptureTimer'; Asset = 'RuptureTimer' }
    [pscustomobject]@{ Name = 'WAILA'; Repo = 'StarRupture-Plugin-WAILA'; LogName = 'Waila'; Asset = 'Waila' }
    [pscustomobject]@{ Name = 'WaveOptimiser'; Repo = 'StarRupture-Plugin-WaveOptimiser'; LogName = 'WaveOptimiser'; Asset = 'WaveOptimiser' }
)
$LoaderRepo = 'StarRupture-ModLoader'

# A failed step leaves its one-line reason for the job's outputs.
function Stop-Rig([string]$Message) {
    Write-Host "::error::$Message"
    $f = Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }) 'rig-reason.txt'
    if (-not (Test-Path -LiteralPath $f)) { Set-Content -LiteralPath $f -Value (($Message -replace '\s+', ' ').Trim()) -Encoding utf8 }
    exit 1
}

# 'Loader', a plugin's Name, or $null. Matches the repo name, log name and asset name too.
function Find-Entry([string]$Name) {
    if ($Name -ieq 'Loader') { return 'Loader' }
    foreach ($p in $Plugins) {
        if ($Name -ieq $p.Name -or $Name -ieq $p.LogName -or $Name -ieq $p.Asset) { return $p.Name }
    }
    return $null
}

# "A=1 B=2" -> ordered map; a token without '=' is an error.
function Read-Pairs([string]$Text, [string]$What) {
    $map = [ordered]@{}
    foreach ($t in @($Text -split '[\s,;]+' | Where-Object { $_ })) {
        if ($t -notmatch '^([A-Za-z0-9_.-]+)=([A-Za-z0-9][A-Za-z0-9._+-]*)$') { throw "$What has '$t', which is not Name=value" }
        if ($map.Contains($Matches[1])) { throw "$What names '$($Matches[1])' twice" }
        $map[$Matches[1]] = $Matches[2]
    }
    return $map
}

function Read-Names([string]$Text) {
    $names = @()
    foreach ($t in @($Text -split '[\s,;]+' | Where-Object { $_ })) {
        if ($t -notmatch '^[A-Za-z0-9_.-]+$') { throw "'$t' is not a plugin name" }
        $names += $t
    }
    return , $names
}

function Get-Release([string]$Repo, [string]$Tag) {
    $h = @{ Accept = 'application/vnd.github+json' }
    if ($env:GH_TOKEN) { $h.Authorization = "Bearer $env:GH_TOKEN" }
    $uri = if ($Tag) { "https://api.github.com/repos/$Owner/$Repo/releases/tags/$Tag" } else { "https://api.github.com/repos/$Owner/$Repo/releases/latest" }
    try { return Invoke-RestMethod -Headers $h -Uri $uri -TimeoutSec 60 }
    catch { throw "$Owner/$Repo $(if ($Tag) { $Tag } else { 'Latest' }): the releases API said: $($_.Exception.Message)" }
}

# The one asset to download. Only the loader's client zip and a plugin's client DLL are ever
# picked; the manifests among a release's assets are never touched.
function Select-Asset($Release, [string]$Label, [string]$Prefix) {
    $assets = @($Release.assets)
    if ($Prefix) {
        $hit = @($assets | Where-Object { $_.name -ieq "$Prefix-Client.dll" })
        # An old release that named the file differently still has one client DLL.
        if ($hit.Count -eq 0) { $hit = @($assets | Where-Object { $_.name -match '-Client\.dll$' }) }
    } else {
        $hit = @($assets | Where-Object { $_.name -match '^StarRupture-ModLoader-Client-[^/\\]+\.zip$' })
    }
    if ($hit.Count -ne 1) { throw "$Label $($Release.tag_name): expected one client asset, found $($hit.Count) ($((@($assets | ForEach-Object { $_.name }) -join ', ')))" }
    return [pscustomobject]@{ name = [string]$hit[0].name; url = [string]$hit[0].browser_download_url }
}

function Resolve-Plan {
    if ($Branch -notin 'public', 'public_test_branch') { throw "branch '$Branch' is not public or public_test_branch" }
    if ($Owner -cnotin 'AlienXAXS', 'msantoro12') { throw "mod owner '$Owner' is not AlienXAXS or msantoro12" }

    # ---- inputs ----
    $tagIn = Read-Pairs $Tags 'tags'
    $tagMap = @{}
    foreach ($k in $tagIn.Keys) {
        $c = Find-Entry $k
        if (-not $c) { throw "tags names '$k', which is not the loader or one of the nine plugins" }
        $tagMap[$c] = $tagIn[$k]
    }
    $expIn = Read-Pairs $Expect 'expect'
    $expMap = @{}
    foreach ($k in $expIn.Keys) {
        $c = Find-Entry $k
        if (-not $c) { $c = $k }
        if ($expMap.ContainsKey($c)) { throw "expect names '$c' twice" }
        $expMap[$c] = $expIn[$k]
    }
    $refused = @{}
    foreach ($n in (Read-Names $ExpectRefused)) { $c = Find-Entry $n; $refused[$(if ($c) { $c } else { $n })] = $true }
    $removed = @{}
    foreach ($n in (Read-Names $RemovePlugins)) {
        $c = Find-Entry $n
        if (-not $c -or $c -eq 'Loader') { throw "remove_plugins names '$n', which is not one of the nine plugins" }
        $removed[$c] = $true
    }

    # ---- the candidate overlay ----
    $overLoader = $false
    $overPlugin = @{}     # plugin Name -> file
    $extraDll = @{}       # extra plugin name -> file
    if ($CandidateDir) {
        if (-not (Test-Path -LiteralPath $CandidateDir -PathType Container)) { throw "candidate folder '$CandidateDir' does not exist" }
        $root = (Resolve-Path -LiteralPath $CandidateDir).Path.TrimEnd('\', '/')
        $count = 0
        foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File -Force) {
            if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "candidate holds a link: $($f.Name)" }
            $count++
            $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
            if ($rel -ieq 'dwmapi.dll') { $overLoader = $true; continue }
            if ($rel -imatch '^ModLoader/Plugins/') {
                if ($rel -notmatch '^ModLoader/Plugins/([^/]+)\.dll$') {
                    if ($rel -imatch '^ModLoader/Plugins/[^/]+$') { continue }   # a pdb or readme next to a plugin
                    throw "candidate holds '$rel', below ModLoader/Plugins"
                }
                $base = $Matches[1]
                $own = @($Plugins | Where-Object { $_.Asset -ieq $base }) | Select-Object -First 1
                if ($own) { $overPlugin[$own.Name] = $rel; continue }
                if (Find-Entry $base) { throw "candidate holds '$rel', but plugin $base is installed as <asset>.dll (see the plugin table)" }
                $extraDll[$base] = $rel
                continue
            }
            if ($rel -imatch '^ModLoader/') {
                if ($rel -imatch '\.(dll|exe)$') { $overLoader = $true }
                continue
            }
            throw "candidate holds '$rel', outside dwmapi.dll and ModLoader/"
        }
        if ($count -eq 0) { throw 'the candidate artifact is empty' }
    }

    # Every DLL the candidate supplies needs a version to expect.
    $need = @()
    if ($overLoader -and -not $expMap.ContainsKey('Loader')) { $need += 'Loader' }
    foreach ($n in $overPlugin.Keys) { if (-not $expMap.ContainsKey($n)) { $need += $n } }
    foreach ($n in $extraDll.Keys) { if (-not $expMap.ContainsKey($n)) { $need += $n } }
    if ($need.Count -gt 0) { throw ('the candidate replaces ' + (($need | Sort-Object) -join ', ') + ': add Name=version for each to expect') }
    foreach ($n in $refused.Keys) {
        if (-not (@($Plugins | Where-Object { $_.Name -eq $n }).Count) -and -not $expMap.ContainsKey($n) -and -not $extraDll.ContainsKey($n)) { throw "expect_refused names '$n', which is not in the set" }
        if ($removed.ContainsKey($n)) { throw "'$n' is both expected refused and removed" }
    }
    foreach ($n in $removed.Keys) { if ($overPlugin.ContainsKey($n)) { throw "'$n' is both removed and replaced by the candidate" } }

    # ---- releases ----
    $loaderRel = Get-Release $LoaderRepo $(if ($tagMap.ContainsKey('Loader')) { $tagMap['Loader'] } else { '' })
    $loaderAsset = Select-Asset $loaderRel 'loader' ''
    $loader = [ordered]@{
        tag = [string]$loaderRel.tag_name; expect = $(if ($expMap.ContainsKey('Loader')) { $expMap['Loader'] } else { [string]$loaderRel.tag_name })
        overlaid = $overLoader; repo = $LoaderRepo; asset = $loaderAsset
    }

    $entries = @()
    foreach ($p in $Plugins) {
        $over = $overPlugin.ContainsKey($p.Name)
        $tag = ''; $asset = $null
        if ($over) {
            if ($tagMap.ContainsKey($p.Name)) { Write-Host "::warning::tags names $($p.Name), which the candidate replaces; the tag is ignored" }
        } else {
            $rel = Get-Release $p.Repo $(if ($tagMap.ContainsKey($p.Name)) { $tagMap[$p.Name] } else { '' })
            $tag = [string]$rel.tag_name
            if (-not $removed.ContainsKey($p.Name)) { $asset = Select-Asset $rel $p.Name $p.Asset }
        }
        $entries += [ordered]@{
            name = $p.Name; logName = $p.LogName; repo = $p.Repo; assetPrefix = $p.Asset; dll = "$($p.Asset).dll"; extra = $false
            tag = $tag; expect = $(if ($expMap.ContainsKey($p.Name)) { $expMap[$p.Name] } else { $tag })
            expectRefused = $refused.ContainsKey($p.Name); removed = $removed.ContainsKey($p.Name); overlaid = $over; asset = $asset
        }
    }
    $extras = @(@($expMap.Keys) + @($extraDll.Keys) + @($refused.Keys) | Where-Object { -not (Find-Entry $_) } | Sort-Object -Unique)
    foreach ($n in $extras) {
        if ($n -notmatch '^[A-Za-z0-9_]+$') { throw "extra plugin name '$n' is not a plain name" }
        $entries += [ordered]@{
            name = $n; logName = $n; repo = ''; assetPrefix = ''; dll = "$n.dll"; extra = $true
            tag = ''; expect = $(if ($expMap.ContainsKey($n)) { $expMap[$n] } else { '' })
            expectRefused = $refused.ContainsKey($n); removed = $false; overlaid = $extraDll.ContainsKey($n); asset = $null
        }
    }

    # What is fetched, and the cache key over it.
    $downloads = @()
    $downloads += [ordered]@{ repo = $LoaderRepo; tag = $loader.tag; name = $loaderAsset.name; url = $loaderAsset.url }
    foreach ($e in $entries) { if ($e.asset) { $downloads += [ordered]@{ repo = $e.repo; tag = $e.tag; name = $e.asset.name; url = $e.asset.url } } }
    $ids = @($downloads | ForEach-Object { "$($_.repo)@$($_.tag)/$($_.name)" } | Sort-Object)
    $key = (([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($ids -join ',')) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16)

    [ordered]@{ branch = $Branch; owner = $Owner; loader = $loader; plugins = @($entries); downloads = @($downloads); cacheKey = $key } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $PlanPath -Encoding utf8

    Write-Host "Loader $($loader.tag) (expect $($loader.expect))$(if ($overLoader) { ', replaced in part by the candidate' })"
    foreach ($e in $entries) {
        $what = if ($e.overlaid) { 'candidate' } elseif ($e.removed) { "removed (release $($e.tag))" } else { "release $($e.tag)" }
        Write-Host ("  {0,-17} {1}; expect {2}{3}" -f $e.name, $what, $(if ($e.expect) { $e.expect } else { '(none)' }), $(if ($e.expectRefused) { '; must be refused' } else { '' }))
    }
    if ($env:GITHUB_OUTPUT) { "key=$key" >> $env:GITHUB_OUTPUT }
}

function Read-Plan {
    if (-not (Test-Path -LiteralPath $PlanPath)) { throw 'no plan: the Resolve step did not run' }
    return (Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json)
}

function Get-AssetPath($Item) { Join-Path $DownloadDir (Join-Path "$($Item.repo)\$($Item.tag)" ([IO.Path]::GetFileName($Item.name))) }

function Get-Assets {
    $plan = Read-Plan
    $fetched = 0
    foreach ($d in $plan.downloads) {
        $file = Get-AssetPath $d
        if (-not (Test-Path -LiteralPath $file)) {
            New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
            Invoke-WebRequest -Uri $d.url -OutFile $file -TimeoutSec 120
            Write-Host "Downloaded $($d.repo) $($d.tag) $($d.name)"
            $fetched++
        }
        $magic = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($file), 0, 2)
        $want = if ($d.name -match '\.zip$') { 'PK' } else { 'MZ' }
        if ($magic -ne $want) { Remove-Item -LiteralPath $file -Force; throw "$($d.name) is not a $want file" }
    }
    Write-Host "Release assets downloaded in this run: $fetched"

    # The cache may come back from a restore key, holding other tags' files. Install reads
    # only the paths above, so they are harmless there, but they would be saved again under
    # the new key and pile up. Keep exactly this set.
    $keep = @($plan.downloads | ForEach-Object { ([IO.Path]::GetFullPath((Get-AssetPath $_))).ToLowerInvariant() })
    $pruned = 0
    if (Test-Path -LiteralPath $DownloadDir) {
        foreach ($f in Get-ChildItem -LiteralPath $DownloadDir -Recurse -File -Force) {
            if ($f.FullName.ToLowerInvariant() -notin $keep) { Remove-Item -LiteralPath $f.FullName -Force; $pruned++ }
        }
        Get-ChildItem -LiteralPath $DownloadDir -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending |
            Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } | Remove-Item -Force
    }
    Write-Host "Files from other releases removed from the cache folder: $pruned"
}

function Install-Set {
    if (-not $InstallDir -or -not (Test-Path -LiteralPath $InstallDir)) { throw "install folder '$InstallDir' does not exist" }
    $plan = Read-Plan
    $exe = Get-ChildItem -LiteralPath $InstallDir -Recurse -Filter 'StarRuptureGameSteam-Win64-Shipping.exe' -File | Select-Object -First 1
    if (-not $exe) { throw "StarRuptureGameSteam-Win64-Shipping.exe not found under $InstallDir" }
    $bin = $exe.DirectoryName
    $plugDir = Join-Path $bin 'ModLoader\Plugins'

    $loaderZip = Get-AssetPath ([pscustomobject]@{ repo = $plan.loader.repo; tag = $plan.loader.tag; name = $plan.loader.asset.name })
    Expand-Archive -LiteralPath $loaderZip -DestinationPath $bin -Force
    New-Item -ItemType Directory -Force $plugDir | Out-Null
    foreach ($e in $plan.plugins) {
        if ($e.asset) { Copy-Item -LiteralPath (Get-AssetPath ([pscustomobject]@{ repo = $e.repo; tag = $e.tag; name = $e.asset.name })) -Destination (Join-Path $plugDir $e.dll) -Force }
    }
    if ($CandidateDir) {
        $root = (Resolve-Path -LiteralPath $CandidateDir).Path.TrimEnd('\', '/')
        foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File -Force) {
            $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/')
            $dest = Join-Path $bin $rel
            New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
            Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
        }
    }
    foreach ($e in $plan.plugins) {
        if ($e.removed) { Remove-Item -LiteralPath (Join-Path $plugDir $e.dll) -Force -ErrorAction SilentlyContinue }
        elseif (-not $e.extra -and -not (Test-Path -LiteralPath (Join-Path $plugDir $e.dll))) { throw "$($e.dll) is not in the install" }
    }

    # The install's own record: the branch Steam mounted and the build id.
    $acfPath = Join-Path $InstallDir 'steamapps\appmanifest_1631270.acf'
    if (-not (Test-Path -LiteralPath $acfPath)) { throw 'the install has no app manifest' }
    $acf = Get-Content -LiteralPath $acfPath -Raw
    $mounted = if ($acf -match '"MountedConfig"\s*\{([^{}]*)\}') { $Matches[1] } else { '' }
    $beta = if ($mounted -match '"BetaKey"\s+"([^"]*)"') { $Matches[1] } else { '' }
    $build = if ($acf -match '"buildid"\s+"(\d+)"') { $Matches[1] } else { '' }
    if ($beta -ne $plan.branch -or -not $build) { throw "the install is branch '$beta', build '$build', not $($plan.branch)" }

    New-Item -ItemType Directory -Force $OutDir | Out-Null
    $set = [ordered]@{
        branch = $plan.branch; buildId = $build
        loader = [ordered]@{ expect = $plan.loader.expect; tag = $plan.loader.tag; overlaid = [bool]$plan.loader.overlaid }
        plugins = @($plan.plugins | ForEach-Object {
            $row = [ordered]@{ repo = $_.name; logName = $_.logName; expectRefused = [bool]$_.expectRefused; removed = [bool]$_.removed; dll = $_.dll; tag = $_.tag; overlaid = [bool]$_.overlaid }
            if ($_.expect) { $row.expect = $_.expect }
            $row
        })
    }
    [IO.File]::WriteAllText((Join-Path $OutDir 'set.json'), ($set | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
    Write-Host "Installed on branch $($plan.branch), build ${build}:"
    Get-ChildItem -LiteralPath $plugDir -Filter *.dll | ForEach-Object { Write-Host ("  {0} {1:N0} bytes" -f $_.Name, $_.Length) }
}

try {
    switch ($Mode) {
        'Resolve' { Resolve-Plan }
        'Fetch' { Get-Assets }
        'Install' { Install-Set }
    }
} catch {
    Stop-Rig "$($_.Exception.Message)"
}
