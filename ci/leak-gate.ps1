# Nothing of the Steam login may be in what a workflow uploads. Shared by sr-client-rig.yml
# and sr-data-extract.yml. Reads the login from STEAM_USER and STEAM_CACHE (the workflow passes
# the secrets to the gate step only) and fails if the account name, a long value of the login,
# a SteamID64/SteamID3, or a term the launch recorded in RUNNER_TEMP/rig-gate-terms.txt appears
# in any file under -Path. It also fails, first of all, if the launch left RUNNER_TEMP/rig-hold.txt
# (it could not tell the persona name, so the gate cannot cover it).
#
#   -Path          the folder that would be uploaded
#   -AllowMissing  a -Path that does not exist passes (the rig has no output folder when the
#                  launch never got that far); without it a missing -Path fails
#   -Strict        for output that may hold binary files (the data extract): also read every file
#                  byte for byte (Latin-1) as well as as UTF-8, refuse login-file names (*.vdf,
#                  ssfn*, steam_appid.txt), and match a digits-only term (an id32) only when
#                  digits do not run on either side of it, so a long number in JSON is not a hit
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Path,
    [switch]$AllowMissing,
    [switch]$Strict
)
$ErrorActionPreference = 'Stop'

# The launch could not tell the persona name: the gate cannot cover it, so nothing taken from
# the logs goes out.
$hold = Join-Path $env:RUNNER_TEMP 'rig-hold.txt'
if (Test-Path -LiteralPath $hold) { Write-Host "::error::$((Get-Content -LiteralPath $hold -Raw).Trim())"; exit 1 }
$user = "$env:STEAM_USER".Trim()
if (-not $user) { Write-Host '::error::No account name to check against'; exit 1 }
# The name, every long value in the login, and the IDs and persona the launch met.
$terms = @($user)
$vdf = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("$env:STEAM_CACHE".Trim()))
foreach ($m in [regex]::Matches($vdf, '"[^"\r\n]*"[ \t]+"([^"\r\n]{16,})"')) { $terms += $m.Groups[1].Value }
$extra = Join-Path $env:RUNNER_TEMP 'rig-gate-terms.txt'
if (Test-Path -LiteralPath $extra) { $terms += @(Get-Content -LiteralPath $extra | Where-Object { $_ }); Remove-Item -LiteralPath $extra -Force }

function Test-Term([string]$text, [string]$term) {
    if ($Strict -and $term -match '^\d+$') {
        return [regex]::IsMatch($text, '(?<!\d)' + [regex]::Escape($term) + '(?!\d)')
    }
    $text.IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

$latin1 = [Text.Encoding]::GetEncoding(28591)
$bad = 0; $n = 0
if (Test-Path -LiteralPath $Path) {
    foreach ($f in Get-ChildItem -LiteralPath $Path -Recurse -File) {
        $n++
        $hit = $false
        if ($Strict) {
            $bytes = [IO.File]::ReadAllBytes($f.FullName)
            $texts = @($latin1.GetString($bytes), [Text.Encoding]::UTF8.GetString($bytes))
            if ($f.Name -match '(?i)\.vdf$|^ssfn|^steam_appid\.txt$') { $hit = $true }
        } else {
            $texts = @([IO.File]::ReadAllText($f.FullName))
        }
        foreach ($t in $texts) {
            if ($t -match '7656119\d{10}|\[U:1:\d+\]') { $hit = $true }
            foreach ($term in $terms) { if (Test-Term $t $term) { $hit = $true } }
        }
        if ($hit) {
            Write-Host "::error::Account data found in $($f.Name)"
            $bad++
        }
    }
} elseif (-not $AllowMissing) {
    Write-Host "::error::$Path does not exist, so there is nothing to check"
    exit 1
}
if ($bad) { exit 1 }
"No account data in $n file(s) under $Path."
