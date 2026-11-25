# Which plugin DLLs may reach sr-aobscan --plugin. The scanner loads the DLL, so its code runs: only a
# DLL this run built from source may, and only from our own repositories or the nine AlienXAXS plugins.
# A downloaded DLL never may, whoever published it. No input, variable or list entry widens this.
# sr-client-check.yml dot-sources this before every scanner call, and before a plugin is fetched.
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

# The refusal facts of a pinned plugin whose DLL is not scanned: Pin.Facts in plugin-names.json, what a
# past scan of exactly that DLL read. Returned only when the release asset's digest ($Digest, hex) is
# exactly the Pin's, so a re-uploaded asset, a missing digest or a new Pin without Facts declares
# nothing. The rig still checks the claim: a declared refusal the loader does not make fails it.
function Get-PinnedFacts([string]$NamesPath, [string]$Name, [string]$Tag, [string]$Digest) {
    if ($Digest -cnotmatch '^[0-9a-f]{64}$') { return $null }
    $all = Get-Content -LiteralPath $NamesPath -Raw | ConvertFrom-Json
    $hit = @($all | ForEach-Object { $_ } | Where-Object { $_.Name -ceq $Name })
    if ($hit.Count -ne 1 -or -not $hit[0].PSObject.Properties['Pin']) { return $null }
    $pin = $hit[0].Pin
    if (-not $pin.PSObject.Properties['Facts'] -or $pin.Tag -cne $Tag -or $pin.Digest -cne "sha256:$Digest") { return $null }
    $f = $pin.Facts
    foreach ($k in 'InterfaceVersion', 'GameBuild', 'Migrated', 'ObservedIn') { if (-not $f.PSObject.Properties[$k]) { return $null } }
    if ($f.Migrated -isnot [bool]) { return $null }
    [ordered]@{ plugin = [ordered]@{ interfaceVersion = [int]$f.InterfaceVersion; gameBuild = [string]$f.GameBuild }
                rule3 = [ordered]@{ migrated = $f.Migrated }; factsFrom = [string]$f.ObservedIn }
}
