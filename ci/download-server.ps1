# Installs the StarRupture Dedicated Server (Steam app 3809400) with an
# anonymous SteamCMD login and records what it cost: bytes on the wire, bytes
# on disk, seconds, and free disk space before and after.
#
# The server is expected to be anonymous-downloadable (no account, no key); this script tests that. Nothing from the
# install is ever uploaded or cached: the folder only lives on the runner.

param(
    [string]$AppId = '3809400',
    [string]$SteamCmdDir = 'C:\steamcmd',
    [int]$Attempts = 3
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-FreeGb([string]$Root) {
    $d = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -eq $Root }
    if (-not $d) { return $null }
    [math]::Round($d.Free / 1GB, 1)
}

function Get-NetReceivedBytes {
    # Bytes received on every adapter. The runner is idle apart from this
    # download, so the delta is the real download size (compressed, as sent).
    $sum = (Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum
    if ($null -eq $sum) { return [int64]0 }
    [int64]$sum
}

# ---- live lookup of the current public build ------------------------------
# Informational only (the install does not depend on it), so a failed lookup is
# reported and the download goes ahead.
$liveBuild = 'unknown'; $depotSize = $null; $depotDownload = $null; $appName = $AppId
try {
    $info = Invoke-RestMethod -Uri "https://api.steamcmd.net/v1/info/$AppId" -TimeoutSec 60
    $app = $info.data.$AppId
    $appName = [string]$app.common.name
    $liveBuild = [string]$app.depots.branches.public.buildid
    foreach ($p in $app.depots.PSObject.Properties) {
        if ($p.Value -is [psobject] -and $p.Value.PSObject.Properties['manifests']) {
            $depotSize = [int64]$p.Value.manifests.public.size
            $depotDownload = [int64]$p.Value.manifests.public.download
        }
    }
} catch { Write-Host "::warning::Live lookup failed: $($_.Exception.Message)" }
Write-Host "Live lookup: app $AppId '$appName' public buildid $liveBuild, depot size $depotSize bytes (on disk), download $depotDownload bytes"

# ---- pick the volume with the most free space ----------------------------
$vols = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null -and $_.Free -ne $null }
$vols | ForEach-Object { Write-Host ("Volume {0} free {1:N1} GB used {2:N1} GB" -f $_.Root, ($_.Free / 1GB), ($_.Used / 1GB)) }
$best = $vols | Sort-Object Free -Descending | Select-Object -First 1
$installDir = Join-Path $best.Root 'srds'
$freeBefore = Get-FreeGb $best.Root
Write-Host "Installing to $installDir (free before: $freeBefore GB)"

# ---- SteamCMD -------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $SteamCmdDir | Out-Null
$zip = Join-Path $env:RUNNER_TEMP 'steamcmd.zip'
Invoke-WebRequest -Uri 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip' -OutFile $zip -TimeoutSec 120
Expand-Archive -Path $zip -DestinationPath $SteamCmdDir -Force
$steamcmd = Join-Path $SteamCmdDir 'steamcmd.exe'

# First run self-updates and often exits non-zero; that is expected.
Write-Host '::group::SteamCMD self-update'
& $steamcmd +quit | ForEach-Object { Write-Host $_ }
Write-Host "self-update exit code: $LASTEXITCODE"
Write-Host '::endgroup::'

# ---- download -------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$netBefore = Get-NetReceivedBytes
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$ok = $false
for ($i = 1; $i -le $Attempts -and -not $ok; $i++) {
    Write-Host "::group::app_update attempt $i of $Attempts"
    $lastBucket = -1
    & $steamcmd +@ShutdownOnFailedCommand 1 +@NoPromptForPassword 1 `
        +force_install_dir $installDir +login anonymous +app_update $AppId +quit 2>&1 |
        ForEach-Object {
            $line = "$_"
            # Print every state change, but progress lines only each 10 %.
            if ($line -match 'progress:\s+([\d.]+)') {
                $bucket = [int]([double]$Matches[1] / 10)
                if ($bucket -ne $lastBucket) { $lastBucket = $bucket; Write-Host ("[{0:N0}s] {1}" -f $sw.Elapsed.TotalSeconds, $line) }
            } else {
                Write-Host $line
            }
        }
    $code = $LASTEXITCODE
    Write-Host "steamcmd exit code: $code after $([int]$sw.Elapsed.TotalSeconds)s"
    Write-Host '::endgroup::'
    $manifest = Join-Path $installDir "steamapps\appmanifest_$AppId.acf"
    if ($code -eq 0 -and (Test-Path $manifest)) { $ok = $true }
}
$sw.Stop()
if (-not $ok) { throw "SteamCMD did not install app $AppId after $Attempts attempts" }

# ---- what did we get ------------------------------------------------------
$netAfter = Get-NetReceivedBytes
$manifestText = Get-Content (Join-Path $installDir "steamapps\appmanifest_$AppId.acf") -Raw
function Get-Acf([string]$Key) { if ($manifestText -match "`"$Key`"\s+`"([^`"]*)`"") { $Matches[1] } else { '' } }
$installedBuild = Get-Acf 'buildid'
$stateFlags = Get-Acf 'StateFlags'
$sizeOnDisk = Get-Acf 'SizeOnDisk'
$files = Get-ChildItem -Path $installDir -Recurse -File -Force -ErrorAction SilentlyContinue
$measured = ($files | Measure-Object -Property Length -Sum).Sum
$freeAfter = Get-FreeGb $best.Root

if ($stateFlags -ne '4') { throw "appmanifest StateFlags is '$stateFlags', not 4 (fully installed)" }
if ($liveBuild -ne 'unknown' -and $installedBuild -ne $liveBuild) {
    Write-Host "::warning::Installed buildid $installedBuild differs from the live lookup $liveBuild (third-party API can lag)."
}

$rows = [ordered]@{
    'Install dir'                   = $installDir
    'Live public buildid (lookup)'  = $liveBuild
    'Installed buildid (manifest)'  = $installedBuild
    'Depot size, on disk (API)'     = $depotSize
    'Depot download (API)'          = $depotDownload
    'SizeOnDisk (manifest, bytes)'  = $sizeOnDisk
    'Measured on disk (bytes)'      = $measured
    'Files'                         = @($files).Count
    'Received on the wire (bytes)'  = ($netAfter - $netBefore)
    'Download seconds'              = [int]$sw.Elapsed.TotalSeconds
    'Free before (GB)'              = $freeBefore
    'Free after (GB)'               = $freeAfter
}
$rows.GetEnumerator() | ForEach-Object { Write-Host ("{0,-32} {1}" -f $_.Key, $_.Value) }

if ($env:GITHUB_STEP_SUMMARY) {
    "### Server download`n`n| Item | Value |`n|---|---|" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
    $rows.GetEnumerator() | ForEach-Object { "| $($_.Key) | $($_.Value) |" } | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
}
if ($env:GITHUB_OUTPUT) {
    "install_dir=$installDir" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
    "build_id=$installedBuild" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
}
