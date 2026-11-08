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
#   -ExpectDecline true                      the build is one the loader's map has no row for: the rig passes
#                                            only if the loader declines cleanly and loads nothing (not with -ExpectRefused)
#   -RemovePlugins "Codex"                   dropped from the install but still expected
# Names are the loader, or a plugin by repo name, log name or asset name, in any case.
# A name in -Expect that is not one of the ten is an extra plugin to expect.
#
# -CandidateDir is a downloaded build artifact laid over the release set. Two layouts:
#   the game folder's   dwmapi.dll, ModLoader/..., ModLoader/Plugins/*.dll
#   the pipeline's own  files at the artifact root: dwmapi.dll and the loader's own files
#                       (Core, ImGui, Updater) go where the loader build puts them, and any
#                       other <Name>.dll is a plugin, installed as ModLoader/Plugins/<Name>.dll;
#                       root .json, .pdb, .txt and .md files are build metadata: ignored, listed in the log
# Every DLL it replaces needs an -Expect entry.
#
# -FeedFile is a signed version-map feed, with its -FeedSeq and the -FeedCl the running build must
# get its rows from. Install copies it, byte for byte, to ModLoader\version-map-client.v1.cache,
# the file the loader reads at start, and set.json records the seq and the CL for ci/verdict.ps1.
# It needs a candidate loader (the feed is trusted by that build only); Resolve refuses it without.

[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Resolve', 'Fetch', 'Install')][string]$Mode,
    [string]$Branch = 'public',
    [string]$Tags = '',
    [string]$Expect = '',
    [string]$ExpectRefused = '',
    [string]$ExpectDecline = '',
    [string]$RemovePlugins = '',
    [string]$CandidateDir = '',
    [string]$FeedFile = '',
    [string]$FeedSeq = '',
    [string]$FeedCl = '',
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

# The ten plugins, read from plugin-names.json (also read by the client check's map step). Name is the repo's short name (and the key of the inputs), LogName the
# name in the loader's "Plugin info" line, Asset the release asset's prefix: <Asset>-Client.dll
# is installed as <Asset>.dll. Owner, when present, is the GitHub owner of that plugin's repo
# (MiniMap is its author's, LetMeInside; the other nine take -Owner). StripV: the plugin logs its
# version without the release tag's leading v (MiniMap prints 1.2.0 for v1.2.0), so that is what
# the log must show. Pin = { Tag, Digest } is the one reviewed release of a plugin whose owner is
# neither msantoro12 nor AlienXAXS: such a plugin runs beside the live Steam login only at that tag,
# and only when the release API's digest for its client DLL is that sha256. A plugin of a third
# party without a Pin is refused, and a newer Latest release is reported (never run) for review.
# UiOffInitFailure, when present, is the one ERROR text of a plugin whose init needs the UI layer the rig
# turns off ([UI] Enabled=0); set.json carries it as uiOffInitFailure and the verdict excuses that line only.
$Plugins = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'plugin-names.json') -Raw | ConvertFrom-Json | ForEach-Object { $_ })
$LoaderRepo = 'StarRupture-ModLoader'
# The owners whose releases the rig runs at Latest; any other owner needs a reviewed Pin.
$TrustedOwners = @('msantoro12', 'AlienXAXS')
# The loader's own files besides dwmapi.dll, which a candidate may carry at its root.
$LoaderFiles = @('StarRupture-ModLoader-Core.dll', 'StarRupture-ImGui.dll', 'StarRupture-ModLoader-Updater.exe')

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

function Get-Release([string]$Repo, [string]$Tag, [string]$RepoOwner = $Owner) {
    $h = @{ Accept = 'application/vnd.github+json' }
    if ($env:GH_TOKEN) { $h.Authorization = "Bearer $env:GH_TOKEN" }
    $uri = if ($Tag) { "https://api.github.com/repos/$RepoOwner/$Repo/releases/tags/$Tag" } else { "https://api.github.com/repos/$RepoOwner/$Repo/releases/latest" }
    try { return Invoke-RestMethod -Headers $h -Uri $uri -TimeoutSec 60 }
    catch { throw "$RepoOwner/$Repo $(if ($Tag) { $Tag } else { 'Latest' }): the releases API said: $($_.Exception.Message)" }
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
    # The id and the digest (or, without one, the upload time) say which upload this is: an
    # asset replaced under the same tag is a different file.
    $digest = ''
    if ($hit[0].PSObject.Properties['digest'] -and $hit[0].digest) {
        $digest = [string]$hit[0].digest
        if ($digest -notmatch '^sha256:[0-9a-fA-F]{64}$') { throw "$Label $($Release.tag_name): the release API gives the digest '$digest', which is not sha256" }
        $digest = $digest.Substring(7).ToLowerInvariant()
    }
    return [pscustomobject]@{ name = [string]$hit[0].name; url = [string]$hit[0].browser_download_url; id = [string]$hit[0].id; digest = $digest; updated = [string]$hit[0].updated_at }
}

# What the candidate artifact holds, each file with where it goes in the game's Win64
# folder: dwmapi.dll and the loader's files, the plugins, anything else as it is.
# Kind: loader | plugin | other. Base is a plugin's file name without .dll.
function Get-CandidateFiles([string]$Dir) {
    $root = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd('\', '/')
    $items = @()
    $taken = @{}
    foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File -Force) {
        if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "candidate holds a link: $($f.Name)" }
        $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
        $kind = 'other'; $base = ''; $dest = $rel
        if ($rel -notmatch '/') {
            # The pipeline's own builds: one file at the artifact root.
            if ($rel -ieq 'dwmapi.dll') { $kind = 'loader' }
            elseif ($rel -iin $LoaderFiles) { $kind = 'loader'; $dest = "ModLoader/$rel" }
            elseif ($rel -imatch '^(.+)\.dll$') { $kind = 'plugin'; $base = $Matches[1]; $dest = "ModLoader/Plugins/$rel" }
            elseif ($rel -imatch '\.(json|pdb|txt|md)$') { Write-Host "Candidate metadata ignored: $rel"; continue }
            else { throw "candidate holds '$rel' at its root; a root file must be dwmapi.dll, one of the loader's files, a plugin DLL or build metadata (.json, .pdb, .txt, .md)" }
        } elseif ($rel -imatch '^ModLoader/Plugins/') {
            if ($rel -match '^ModLoader/Plugins/([^/]+)\.dll$') { $kind = 'plugin'; $base = $Matches[1] }
            elseif ($rel -notmatch '^ModLoader/Plugins/[^/]+$') { throw "candidate holds '$rel', below ModLoader/Plugins" }   # else a pdb or readme next to a plugin
        } elseif ($rel -imatch '^ModLoader/') {
            if ($rel -imatch '\.(dll|exe)$') { $kind = 'loader' }
        } else {
            throw "candidate holds '$rel', outside dwmapi.dll and ModLoader/"
        }
        if ($taken.ContainsKey($dest.ToLowerInvariant())) { throw "candidate holds '$dest' twice ($($taken[$dest.ToLowerInvariant()]) and $rel)" }
        $taken[$dest.ToLowerInvariant()] = $rel
        $items += [pscustomobject]@{ Source = $f.FullName; Rel = $rel; Dest = $dest; Kind = $kind; Base = $base }
    }
    return , $items
}

# The reviewed release of a plugin of another author: its Tag and the sha256 of its client DLL (lower case, without the prefix).
function Get-Pin($Plugin, [string]$PluginOwner) {
    $pin = if ($Plugin.PSObject.Properties['Pin']) { $Plugin.Pin } else { $null }
    if (-not $pin) { throw "$($Plugin.Name) is another author's plugin ($PluginOwner), and the rig runs it only at a reviewed release: add a Pin (Tag and Digest) for it to plugin-names.json" }
    $tag = if ($pin.PSObject.Properties['Tag']) { [string]$pin.Tag } else { '' }
    $digest = if ($pin.PSObject.Properties['Digest']) { [string]$pin.Digest } else { '' }
    if ($tag -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+-]*$') { throw "$($Plugin.Name): the Pin tag '$tag' is not a release tag" }
    if ($digest -cnotmatch '^sha256:[0-9a-f]{64}$') { throw "$($Plugin.Name): the Pin digest '$digest' is not sha256:<64 lower-case hex digits>" }
    return [pscustomobject]@{ Tag = $tag; Digest = $digest.Substring(7) }
}

function Resolve-Plan {
    if ($Branch -notin 'public', 'public_test_branch') { throw "branch '$Branch' is not public or public_test_branch" }
    if ($Owner -cnotin 'AlienXAXS', 'msantoro12') { throw "mod owner '$Owner' is not AlienXAXS or msantoro12" }

    # ---- inputs ----
    $tagIn = Read-Pairs $Tags 'tags'
    $tagMap = @{}
    foreach ($k in $tagIn.Keys) {
        $c = Find-Entry $k
        if (-not $c) { throw "tags names '$k', which is not the loader or one of the ten plugins" }
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
    if ($ExpectDecline -cnotin '', 'true', 'false') { throw "expect_decline is '$ExpectDecline', not true or false" }
    $decline = $ExpectDecline -ceq 'true'
    if ($decline -and $ExpectRefused.Trim()) { throw 'expect_decline and expect_refused exclude each other: a loader that declines the build refuses nothing, it loads nothing' }
    $refused = @{}
    foreach ($n in (Read-Names $ExpectRefused)) { $c = Find-Entry $n; $refused[$(if ($c) { $c } else { $n })] = $true }
    $removed = @{}
    foreach ($n in (Read-Names $RemovePlugins)) {
        $c = Find-Entry $n
        if (-not $c -or $c -eq 'Loader') { throw "remove_plugins names '$n', which is not one of the ten plugins" }
        $removed[$c] = $true
    }

    # ---- the feed to seed ----
    $feed = $null
    if ($FeedFile -or $FeedSeq -or $FeedCl) {
        if (-not $FeedFile -or -not $FeedSeq -or -not $FeedCl) { throw 'the feed file, its seq and its CL go together' }
        if (-not $CandidateDir) { throw 'a seeded feed needs the candidate loader that trusts it; no candidate was given' }
        if ($FeedSeq -cnotmatch '^[1-9][0-9]{0,14}$') { throw "the feed seq '$FeedSeq' is not a number" }
        if ($FeedCl -cnotmatch '^[1-9][0-9]{0,8}$') { throw "the feed CL '$FeedCl' is not a number" }
        if (-not (Test-Path -LiteralPath $FeedFile -PathType Leaf)) { throw "feed file '$FeedFile' does not exist" }
        $feedBytes = [IO.File]::ReadAllBytes($FeedFile)
        # The loader reads at most 1 MiB and refuses a file that does not end in a line feed.
        if ($feedBytes.Length -eq 0 -or $feedBytes.Length -gt 1MB -or $feedBytes[$feedBytes.Length - 1] -ne 10) { throw "feed file '$FeedFile' is empty, over 1 MiB, or does not end in a line feed" }
        if (-not [Text.Encoding]::ASCII.GetString($feedBytes).StartsWith("format$([char]9)1$([char]10)", [StringComparison]::Ordinal)) { throw "feed file '$FeedFile' is not a format 1 feed" }
        $feed = [ordered]@{ seq = [int64]$FeedSeq; cl = [int]$FeedCl }
    }

    # ---- the candidate overlay ----
    $overLoader = $false
    $overPlugin = @{}     # plugin Name -> file
    $extraDll = @{}       # extra plugin name -> file
    if ($CandidateDir) {
        if (-not (Test-Path -LiteralPath $CandidateDir -PathType Container)) { throw "candidate folder '$CandidateDir' does not exist" }
        $files = Get-CandidateFiles $CandidateDir
        if ($files.Count -eq 0) { throw 'the candidate artifact is empty' }
        foreach ($c in $files) {
            if ($c.Kind -eq 'loader') { $overLoader = $true }
            elseif ($c.Kind -eq 'plugin') {
                $own = @($Plugins | Where-Object { $_.Asset -ieq $c.Base }) | Select-Object -First 1
                if ($own) { $overPlugin[$own.Name] = $c.Rel; continue }
                if (Find-Entry $c.Base) { throw "candidate holds '$($c.Rel)', but plugin $($c.Base) is installed as <asset>.dll (see the plugin table)" }
                $extraDll[$c.Base] = $c.Rel
            }
        }
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
    $review = @()
    foreach ($p in $Plugins) {
        $over = $overPlugin.ContainsKey($p.Name)
        $tag = ''; $asset = $null
        if ($over) {
            if ($tagMap.ContainsKey($p.Name)) { Write-Host "::warning::tags names $($p.Name), which the candidate replaces; the tag is ignored" }
        } else {
            $pOwner = if ($p.PSObject.Properties['Owner'] -and $p.Owner) { [string]$p.Owner } else { $Owner }
            $pin = if ($pOwner -cnotin $TrustedOwners) { Get-Pin $p $pOwner } else { $null }
            if ($pin -and $tagMap.ContainsKey($p.Name) -and $tagMap[$p.Name] -cne $pin.Tag) {
                throw "tags names $($p.Name)=$($tagMap[$p.Name]), but $($p.Name) is another author's plugin: the rig runs only its reviewed release $($pin.Tag)"
            }
            $rel = Get-Release $p.Repo $(if ($pin) { $pin.Tag } elseif ($tagMap.ContainsKey($p.Name)) { $tagMap[$p.Name] } else { '' }) $pOwner
            $tag = [string]$rel.tag_name
            if (-not $removed.ContainsKey($p.Name)) {
                $asset = Select-Asset $rel $p.Name $p.Asset
                if ($pin -and $asset.digest -cne $pin.Digest) {
                    throw "$($p.Name) ${tag}: the release's $($asset.name) has the digest sha256:$($asset.digest), not the reviewed sha256:$($pin.Digest); the asset changed after review, so the rig does not run it"
                }
            }
            if ($pin) {
                # A newer release is reported for review and never run. Failing to ask is not a failure of the rig.
                try { $latestTag = [string](Get-Release $p.Repo '' $pOwner).tag_name }
                catch { $latestTag = ''; Write-Host "::warning title=Latest release not read::$($p.Name): $($_.Exception.Message)" }
                if ($latestTag -and $latestTag -cne $pin.Tag) {
                    $shown = if ($latestTag -cmatch '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$') { $latestTag } else { 'unreadable-tag' }
                    $review += "$($p.Name)=$shown"
                    Write-Host "::warning title=New release waiting for review::new $($p.Name) release $shown waiting for review; the rig runs the reviewed $($pin.Tag)"
                }
            }
        }
        $entries += [ordered]@{
            name = $p.Name; logName = $p.LogName; repo = $p.Repo; assetPrefix = $p.Asset; dll = "$($p.Asset).dll"; extra = $false
            tag = $tag; expect = $(if ($expMap.ContainsKey($p.Name)) { $expMap[$p.Name] } elseif ($p.PSObject.Properties['StripV'] -and $p.StripV) { $tag -replace '^v', '' } else { $tag })
            expectRefused = $refused.ContainsKey($p.Name); removed = $removed.ContainsKey($p.Name); overlaid = $over; asset = $asset
            uiOffInitFailure = $(if ($p.PSObject.Properties['UiOffInitFailure']) { [string]$p.UiOffInitFailure } else { '' })
        }
    }
    $extras = @(@($expMap.Keys) + @($extraDll.Keys) + @($refused.Keys) | Where-Object { -not (Find-Entry $_) } | Sort-Object -Unique)
    foreach ($n in $extras) {
        if ($n -notmatch '^[A-Za-z0-9_]+$') { throw "extra plugin name '$n' is not a plain name" }
        $entries += [ordered]@{
            name = $n; logName = $n; repo = ''; assetPrefix = ''; dll = "$n.dll"; extra = $true
            tag = ''; expect = $(if ($expMap.ContainsKey($n)) { $expMap[$n] } else { '' })
            expectRefused = $refused.ContainsKey($n); removed = $false; overlaid = $extraDll.ContainsKey($n); asset = $null; uiOffInitFailure = ''
        }
    }

    # What is fetched, and the cache key over it.
    $downloads = @()
    $downloads += [ordered]@{ repo = $LoaderRepo; tag = $loader.tag; name = $loaderAsset.name; url = $loaderAsset.url; id = $loaderAsset.id; digest = $loaderAsset.digest; updated = $loaderAsset.updated }
    foreach ($e in $entries) { if ($e.asset) { $downloads += [ordered]@{ repo = $e.repo; tag = $e.tag; name = $e.asset.name; url = $e.asset.url; id = $e.asset.id; digest = $e.asset.digest; updated = $e.asset.updated } } }
    # The key follows the upload, not only the tag: re-uploading an asset under the same tag
    # changes its id and its digest or time, so the cache cannot serve the old bytes.
    $ids = @($downloads | ForEach-Object { "$($_.repo)@$($_.tag)/$($_.name)#$($_.id):$(if ($_.digest) { $_.digest } else { $_.updated })" } | Sort-Object)
    $key = (([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($ids -join ',')) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16)

    [ordered]@{ branch = $Branch; expectDecline = $decline; owner = $Owner; loader = $loader; plugins = @($entries); downloads = @($downloads); cacheKey = $key; review = @($review); feed = $feed } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $PlanPath -Encoding utf8

    Write-Host "Loader $($loader.tag) (expect $($loader.expect))$(if ($overLoader) { ', replaced in part by the candidate' })"
    foreach ($e in $entries) {
        $what = if ($e.overlaid) { 'candidate' } elseif ($e.removed) { "removed (release $($e.tag))" } else { "release $($e.tag)" }
        Write-Host ("  {0,-17} {1}; expect {2}{3}" -f $e.name, $what, $(if ($e.expect) { $e.expect } else { '(none)' }), $(if ($e.expectRefused) { '; must be refused' } else { '' }))
    }
    if ($env:GITHUB_OUTPUT) {
        "key=$key" >> $env:GITHUB_OUTPUT
        # <Plugin>=<tag> for each pinned plugin whose Latest release is not the reviewed one; the check's alert reads it.
        "review=$($review -join ' ')" >> $env:GITHUB_OUTPUT
    }
}

function Read-Plan {
    if (-not (Test-Path -LiteralPath $PlanPath)) { throw 'no plan: the Resolve step did not run' }
    return (Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json | ForEach-Object { $_ })
}

# The asset's id is in the path, so a file cached for another upload is never read for this one.
function Get-AssetPath($Item) { Join-Path $DownloadDir (Join-Path "$($Item.repo)\$($Item.tag)\$($Item.id)" ([IO.Path]::GetFileName($Item.name))) }

function Get-Assets {
    $plan = Read-Plan
    $fetched = 0
    foreach ($d in $plan.downloads) {
        $file = Get-AssetPath $d
        # The API's digest is checked on a cached file and on a fresh download alike.
        if ($d.digest -and (Test-Path -LiteralPath $file) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() -ne $d.digest) {
            Write-Host "Cached $($d.name) does not match the release's digest; downloading it again"
            Remove-Item -LiteralPath $file -Force
        }
        if (-not (Test-Path -LiteralPath $file)) {
            New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
            Invoke-WebRequest -Uri $d.url -OutFile $file -TimeoutSec 120
            Write-Host "Downloaded $($d.repo) $($d.tag) $($d.name)"
            $fetched++
            if ($d.digest -and (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() -ne $d.digest) {
                Remove-Item -LiteralPath $file -Force
                throw "$($d.name) does not match the digest the release gives (sha256:$($d.digest))"
            }
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

    $loaderZip = Get-AssetPath ([pscustomobject]@{ repo = $plan.loader.repo; tag = $plan.loader.tag; id = $plan.loader.asset.id; name = $plan.loader.asset.name })
    Expand-Archive -LiteralPath $loaderZip -DestinationPath $bin -Force
    New-Item -ItemType Directory -Force $plugDir | Out-Null
    foreach ($e in $plan.plugins) {
        if ($e.asset) { Copy-Item -LiteralPath (Get-AssetPath ([pscustomobject]@{ repo = $e.repo; tag = $e.tag; id = $e.asset.id; name = $e.asset.name })) -Destination (Join-Path $plugDir $e.dll) -Force }
    }
    if ($CandidateDir) {
        foreach ($c in (Get-CandidateFiles $CandidateDir)) {
            $dest = Join-Path $bin ($c.Dest -replace '/', '\')
            New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
            Copy-Item -LiteralPath $c.Source -Destination $dest -Force
        }
    }
    foreach ($e in $plan.plugins) {
        if ($e.removed) { Remove-Item -LiteralPath (Join-Path $plugDir $e.dll) -Force -ErrorAction SilentlyContinue }
        elseif (-not $e.extra -and -not (Test-Path -LiteralPath (Join-Path $plugDir $e.dll))) { throw "$($e.dll) is not in the install" }
    }

    # The feed the candidate loader reads at start, as the loader stores it: the signed file itself.
    if ($plan.feed) {
        $cache = Join-Path $bin 'ModLoader\version-map-client.v1.cache'
        New-Item -ItemType Directory -Force (Split-Path $cache) | Out-Null
        Copy-Item -LiteralPath $FeedFile -Destination $cache -Force
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $cache).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $FeedFile).Hash) { throw 'the seeded feed cache differs from the feed file' }
        (Get-Item -LiteralPath $cache).LastWriteTimeUtc = [DateTime]::UtcNow
        Write-Host "Seeded the feed cache with seq $($plan.feed.seq) for CL-$($plan.feed.cl)"
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
            if ($_.uiOffInitFailure) { $row.uiOffInitFailure = $_.uiOffInitFailure }
            $row
        })
    }
    if ($plan.PSObject.Properties['expectDecline'] -and $plan.expectDecline) { $set.expectDecline = $true }
    if ($plan.feed) { $set.feed = [ordered]@{ seq = [int64]$plan.feed.seq; cl = [int]$plan.feed.cl } }
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
