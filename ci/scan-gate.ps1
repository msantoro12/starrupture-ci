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
# $BuiltIn, the folder this run's build of that plugin writes. Throws otherwise.
function Assert-ScanAllowed([string]$Source, [string]$Repo, [string]$Dll, [string]$BuiltIn) {
    $why = Get-ScanRefusal $Source $Repo
    if ($why) { throw $why }
    if (-not $Dll -or -not $BuiltIn -or -not (Test-Path -LiteralPath $Dll -PathType Leaf)) { throw "not scanned: gated (no DLL from this run's build)" }
    $root = (Resolve-Path -LiteralPath $BuiltIn).ProviderPath.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not (Resolve-Path -LiteralPath $Dll).ProviderPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'not scanned: gated (the DLL is outside the folder this run built it in)'
    }
}
