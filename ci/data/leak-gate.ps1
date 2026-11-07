# Nothing of the Steam login may be in what is uploaded. Reads the login from STEAM_USER and
# STEAM_CACHE (the workflow passes the secrets to this step only) and fails if the account
# name, a long value of the login, a SteamID64/SteamID3, or a term the launch recorded in
# RUNNER_TEMP/rig-gate-terms.txt appears in any file under -Path. Files are read as Latin-1,
# so binary files (PNGs, the usmap) are scanned byte for byte.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Path)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$user = "$env:STEAM_USER".Trim()
if (-not $user) { throw 'No account name to check against' }
$terms = @($user)
$vdf = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("$env:STEAM_CACHE".Trim()))
foreach ($m in [regex]::Matches($vdf, '"[^"\r\n]*"[ \t]+"([^"\r\n]{16,})"')) { $terms += $m.Groups[1].Value }
$extra = Join-Path $env:RUNNER_TEMP 'rig-gate-terms.txt'
if (Test-Path -LiteralPath $extra) { $terms += @(Get-Content -LiteralPath $extra | Where-Object { $_ }); Remove-Item -LiteralPath $extra -Force }

$bad = 0; $n = 0
foreach ($f in Get-ChildItem -LiteralPath $Path -Recurse -File) {
    $n++
    $t = [Text.Encoding]::Latin1.GetString([IO.File]::ReadAllBytes($f.FullName))
    $hit = $t -match '7656119\d{10}|\[U:1:\d+\]'
    foreach ($term in $terms) { if ($t.IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $true } }
    if ($hit) { Write-Host "::error::Account data found in $($f.Name)"; $bad++ }
}
if ($bad) { exit 1 }
"No account data in $n file(s) under $Path."
