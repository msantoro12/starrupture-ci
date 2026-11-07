# After the game client is installed (client-rig-launch.ps1 -Phase Install), before it is
# launched: the install must be the build the caller asked for, from the branch it asked for,
# and clean (no loader, no plugin). Writes bin and paks to GITHUB_OUTPUT.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InstallDir,
    [Parameter(Mandatory)][string]$Branch,
    [Parameter(Mandatory)][string]$BuildId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$manifest = Join-Path $InstallDir 'steamapps\appmanifest_1631270.acf'
if (-not (Test-Path -LiteralPath $manifest)) { throw "no app manifest at $manifest" }
$acf = Get-Content -LiteralPath $manifest -Raw
$build = if ($acf -match '"buildid"\s+"(\d+)"') { $Matches[1] } else { '' }
$mounted = if ($acf -match '"MountedConfig"\s*\{([^{}]*)\}') { $Matches[1] } else { '' }
$beta = if ($mounted -match '"BetaKey"\s+"([^"]*)"') { $Matches[1] } else { '' }
if ($beta -ne $Branch) { throw "the install is branch '$beta', not '$Branch'" }
if ($build -ne $BuildId) { throw "Steam installed build $build for this branch, not the requested $BuildId (the branch moved on, or the build id is wrong)" }

$exe = Get-ChildItem -LiteralPath $InstallDir -Recurse -Filter 'StarRuptureGameSteam-Win64-Shipping.exe' -File | Select-Object -First 1
if (-not $exe) { throw 'the game exe is not in the install' }
$bin = $exe.DirectoryName
if ((Test-Path -LiteralPath (Join-Path $bin 'dwmapi.dll')) -or (Test-Path -LiteralPath (Join-Path $bin 'ModLoader'))) {
    throw 'the fresh install already holds a loader proxy or a ModLoader folder'
}
$paks = Join-Path (Get-Item $bin).Parent.Parent.FullName 'Content\Paks'
if (-not (Test-Path -LiteralPath (Join-Path $paks 'pakchunk0-Windows.utoc'))) { throw "no pakchunk0-Windows.utoc in $paks" }
"Install is build $build of branch $beta."
"bin=$bin" >> $env:GITHUB_OUTPUT
"paks=$paks" >> $env:GITHUB_OUTPUT
