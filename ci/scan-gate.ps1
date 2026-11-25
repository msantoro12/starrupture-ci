# Which plugin DLLs may reach sr-aobscan --plugin. The scanner loads the DLL, so its code runs: only a
# DLL this run built from source may, and only from our own repositories or the nine AlienXAXS plugins.
# A downloaded DLL never may, whoever published it. No input, variable or list entry widens this.
# sr-client-check.yml dot-sources this before every scanner call, and before a plugin is fetched.
# Both checks also use it on a ref that names code compiled here (Assert-OwnRef, below).
$ScanOwnRepos = '^(msantoro12/StarRupture-Plugin-[A-Za-z0-9_-]+|GoodStuffSoftware/sr-bestbuilder)$'
$ScanThirdPartySource = '^AlienXAXS/StarRupture-Plugin-(BetterCheats|BetterDrone|WAILA|Codex|Compass|ProductionViewer|RuptureTimer|WaveOptimiser|CameraControls)$'

# $null when a plugin from this source and repository may be built and scanned, else the reason.
# $Source is how this run gets the DLL: only 'build' (built from source here) passes.
function Get-ScanRefusal([string]$Source, [string]$Repo) {
    if ($Source -cne 'build') { return 'not scanned: gated (a downloaded DLL; only a DLL this run built from source is scanned)' }
    if ($Repo -cnotmatch $ScanOwnRepos -and $Repo -cnotmatch $ScanThirdPartySource) {
        return "not scanned: gated (another author's source that is not one of the nine allowed AlienXAXS plugins)"
    }
    $null
}

# The check at the scanner call itself: the source and repository above, and the DLL is a file under
# $BuiltIn, the folder this run's build of that plugin writes. A junction or link anywhere from the DLL
# up to $BuiltIn is refused: the path check does not follow one. Throws otherwise.
function Assert-ScanAllowed([string]$Source, [string]$Repo, [string]$Dll, [string]$BuiltIn) {
    $why = Get-ScanRefusal $Source $Repo
    if ($why) { throw $why }
    if (-not $Dll -or -not $BuiltIn -or -not (Test-Path -LiteralPath $Dll -PathType Leaf)) { throw "not scanned: gated (no DLL from this run's build)" }
    $root = (Resolve-Path -LiteralPath $BuiltIn).ProviderPath.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not (Resolve-Path -LiteralPath $Dll).ProviderPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'not scanned: gated (the DLL is outside the folder this run built it in)'
    }
    $item = Get-Item -LiteralPath $Dll -Force
    while ($item -and ($item.FullName.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar).StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'not scanned: gated (a junction or link on the way to the DLL)' }
        $item = if ($item -is [IO.DirectoryInfo]) { $item.Parent } else { $item.Directory }
    }
}

# A commit id is taken only when a branch or tag of the named repository reaches it. GitHub serves the commits of
# forks and pull requests under the parent repository's name (checkout, fetch and the compare API all resolve
# them), so the commit is compared with the tips $RefLines (git ls-remote) lists as that repository's own heads and tags.
function Assert-OwnCommit([string]$Repo, [string]$Sha, [string[]]$RefLines, $Headers) {
    # An annotated tag counts as its commit: the peeled line follows the tag's own and replaces it.
    $tips = [ordered]@{}
    foreach ($line in $RefLines) { $id, $name = $line -split '\s+'; if ($name -cmatch '^refs/(heads|tags)/') { $tips[($name -creplace '\^\{\}$')] = $id } }
    if (@($tips.Values) -contains $Sha) { return }
    $why = ''
    foreach ($name in @($tips.Keys | Sort-Object { $_ -cnotmatch '^refs/heads/(main|master)$' })) {
        try { $status = [string](Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/compare/$Sha...$($tips[$name])?per_page=1" -Headers $Headers -TimeoutSec 60).status }
        catch { $why = " (last compare error: $($_.Exception.Message))"; continue }
        if ($status -ceq 'ahead' -or $status -ceq 'identical') { return }
    }
    throw "the commit $Sha is in no branch or tag of $Repo (to run it, push a branch for it to that repository)$why"
}

# An input that names a ref of a public repository: a branch or tag of $Repo itself, or a full commit id that
# one of them reaches. Anything else (refs/pull/*, a short id, a blank) is refused: the checkout would take it.
function Assert-OwnRef([string]$What, [string]$Repo, [string]$Ref, $Headers) {
    $refs = @(git ls-remote "https://github.com/$Repo" 'refs/heads/*' 'refs/tags/*')
    if ($LASTEXITCODE -ne 0) { throw "git ls-remote $Repo failed (exit $LASTEXITCODE)" }
    if ($Ref -match '^[0-9a-f]{40}$') { Assert-OwnCommit $Repo $Ref $refs $Headers; return }
    if (-not @($refs | Where-Object { @("refs/heads/$Ref", "refs/tags/$Ref") -ccontains ($_ -split '\s+')[1] }).Count) {
        throw "$What '$Ref' is not a branch, a tag or a full commit id of $Repo"
    }
}

# The refusal facts of a pinned plugin whose DLL is not scanned: Pin.Facts in plugin-names.json, what a
# past scan of one DLL read, with that DLL's digest in Facts.Digest. Returned only when Facts.Digest,
# Pin.Digest and the release asset's digest ($Digest, hex) all name that one DLL, so a re-uploaded
# asset, a missing digest or a new Pin whose Facts are missing or still the old DLL's declares
# nothing. The rig still checks the claim: a declared refusal the loader does not make fails it.
function Get-PinnedFacts([string]$NamesPath, [string]$Name, [string]$Tag, [string]$Digest) {
    if ($Digest -cnotmatch '^[0-9a-f]{64}$') { return $null }
    $all = Get-Content -LiteralPath $NamesPath -Raw | ConvertFrom-Json
    $hit = @($all | ForEach-Object { $_ } | Where-Object { $_.Name -ceq $Name })
    if ($hit.Count -ne 1 -or -not $hit[0].PSObject.Properties['Pin']) { return $null }
    $pin = $hit[0].Pin
    if (-not $pin.PSObject.Properties['Facts'] -or $pin.Tag -cne $Tag -or $pin.Digest -cne "sha256:$Digest") { return $null }
    $f = $pin.Facts
    foreach ($k in 'Digest', 'InterfaceVersion', 'GameBuild', 'Migrated', 'ObservedIn') { if (-not $f.PSObject.Properties[$k]) { return $null } }
    if ($f.Digest -cne $pin.Digest) { return $null }
    if ($f.Migrated -isnot [bool]) { return $null }
    [ordered]@{ plugin = [ordered]@{ interfaceVersion = [int]$f.InterfaceVersion; gameBuild = [string]$f.GameBuild }
                rule3 = [ordered]@{ migrated = $f.Migrated }; factsFrom = [string]$f.ObservedIn }
}
