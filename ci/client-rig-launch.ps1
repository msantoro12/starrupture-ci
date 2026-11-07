# The client test rig's launch: installs the game client, signs the real Steam client
# in from the saved CI login, launches the game with the loader and the plugin set
# (ci/client-rig-set.ps1 put them in the install), and records what happened under
# -OutDir for ci/verdict.ps1 -Client. It decides nothing: pass or fail is the verdict's.
#
#   -Phase Install  steamcmd installs the game client for -Branch (verified against the
#                   install's own manifest) and prints install_dir for the workflow.
#   -Phase Launch   firewall (outbound blocked for every exe in the install), modloader.ini,
#                   SHA-256 of every DLL, Steam client sign-in, the game launch (one relaunch
#                   rule, below), then the files the verdict reads.
#   -Check          exercises the helpers with no login, to catch a script bug before one.
#
# Written to -OutDir (set.json is the set script's):
#   boot.json         process facts for the shipping exe
#   dll-hashes.json   sha256 before the first launch and after the last stop
#   modloader.log, proxy.log, autoupdate.log   the loader's logs of the last attempt, scrubbed
#
# Relaunch: the first launch in a client session can end on Steam's "Application load
# error" dialog, which holds the process open with no timeout. That one dialog, and only
# that, kills the game and launches it again, at most -MaxRelaunch times; every attempt is
# recorded in boot.json. Any other failure is left as it is for the verdict.
#
# The login arrives in STEAM_USER and STEAM_CACHE and is cleared from the environment
# before the game starts. Everything printed or written goes through Scrub. Steam's own
# logs and config files, the game's files and its engine logs never reach -OutDir.
#
# The persona name is read from what the Steam client wrote after the sign-in, once the game
# is stopped and Steam has shut down. If that cannot be determined the scrub and the leak
# gate cannot cover it, so the launch writes rig-hold.txt (in RUNNER_TEMP) saying why, and
# the workflow uploads and publishes nothing taken from the logs.
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Launch')][string]$Phase,
    [string]$Branch = 'public',
    [string]$InstallDir = '',
    [string]$OutDir = 'out',
    [string]$GameArgs = '-nullrhi -unattended -nosound -log',
    # Longest an attempt may take to boot; a finished boot always gets its settle.
    [int]$AttemptCapSec = 300,
    [int]$SettleSec = 60,
    [int]$MaxRelaunch = 2,
    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class RigWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  static string Text(IntPtr h) { var s = new StringBuilder(1024); GetWindowTextW(h, s, 1024); return s.ToString(); }
  static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString(); }
  public static string[] Snapshot() {
    var r = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var kids = new List<string>();
      EnumChildWindows(h, (c, m) => { var t = Text(c); if (t.Length > 0) kids.Add(Cls(c) + "=" + t.Replace("\r", " ").Replace("\n", " ")); return true; }, IntPtr.Zero);
      r.Add("pid=" + pid + " visible=" + IsWindowVisible(h) + " class=" + Cls(h) + " title=[" + Text(h) + "] children=[" + string.Join(" | ", kids) + "]");
      return true;
    }, IntPtr.Zero);
    return r.ToArray();
  }
}
'@

# ---- helpers (also run by -Check) -----------------------------------------------------

# The first dialog among the snapshot's windows that means a failed launch. 'load-error' is
# the known first-launch Steam error (any owner: Steam may raise it); 'dialog' is a visible
# window of the game with a crash or error title, e.g. the loader's "The game has crashed".
function Find-GameDialog([string[]]$Lines, [int[]]$GamePids) {
    $found = $null
    foreach ($l in $Lines) {
        if ($l -match '^pid=(\d+) visible=(\w+) class=(.*?) title=\[(.*?)\] children=\[(.*)\]$') {
            $owner = [int]$Matches[1]; $visible = $Matches[2]; $class = $Matches[3]; $title = $Matches[4]; $kids = $Matches[5]
            if ($visible -ne 'True') { continue }
            if ($class -eq '#32770' -and $title -ceq 'Steam Error' -and $kids -match 'Application load error') {
                return [pscustomobject]@{ Kind = 'load-error'; Title = $title; Text = $kids }
            }
            if (-not $found -and $owner -in $GamePids -and $title -match '(?i)crash|fatal|error|exception') {
                $found = [pscustomobject]@{ Kind = 'dialog'; Title = $title; Text = $kids }
            }
        }
    }
    return $found
}

# Created before the launch: the updater child runs before Core makes the ini. No BOM, which
# would hide the first section.
function New-IniText { "[AutoUpdate]`r`nEnabled=0`r`n[Logging]`r`nLevel=INFO`r`n[UI]`r`nEnabled=0`r`n" }

function Build-LoginUsers([string]$id64, [string]$name, [long]$now) {
    "`"users`"`n{`n`"$id64`"`n{`n`"AccountName`" `"$name`"`n`"PersonaName`" `"$name`"`n`"RememberPassword`" `"1`"`n`"WantsOfflineMode`" `"0`"`n`"SkipOfflineModeWarning`" `"0`"`n`"AllowAutoLogin`" `"1`"`n`"MostRecent`" `"1`"`n`"Timestamp`" `"$now`"`n}`n}`n"
}

# sha256 of dwmapi.dll and every DLL and EXE under ModLoader, keyed by path relative to the
# game's Win64 folder.
function Get-DllHashes([string]$Bin) {
    $files = @()
    $proxy = Join-Path $Bin 'dwmapi.dll'
    if (Test-Path -LiteralPath $proxy) { $files += Get-Item -LiteralPath $proxy }
    $ml = Join-Path $Bin 'ModLoader'
    if (Test-Path -LiteralPath $ml) { $files += @(Get-ChildItem -LiteralPath $ml -Recurse -File | Where-Object { $_.Extension -in '.dll', '.exe' }) }
    $h = [ordered]@{}
    foreach ($f in $files) {
        $h[($f.FullName.Substring($Bin.Length).TrimStart('\', '/') -replace '\\', '/')] = (Get-FileHash -Algorithm SHA256 -LiteralPath $f.FullName).Hash.ToLower()
    }
    return $h
}

# Every exe under the install: the game, the loader's updater, UE's crash reporter and
# anything else the game or a plugin could start from there.
function Get-InstallExes([string]$Dir) {
    @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -Filter *.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | Sort-Object)
}

# The persona names Steam wrote after the sign-in. loginusers.vdf is first written by the rig
# with the account name as the persona; it counts only when Steam rewrote it. localconfig.vdf
# (userdata\<id>\config) is Steam's own. Known is false when neither gives a name Steam wrote,
# or when a name is under 3 characters, which the scrub cannot match safely.
function Get-Personas([string]$LoginUsers, [string]$Written, [string]$LocalConfig, [string]$Id64) {
    $names = [Collections.Generic.List[string]]::new()
    $short = $false; $known = $false
    $norm = { param($t) ("$t" -replace '\s+', ' ').Trim() }
    $rewritten = ($LoginUsers -ne '') -and ((& $norm $LoginUsers) -cne (& $norm $Written))
    $own = if ($LoginUsers -match ('"' + [regex]::Escape($Id64) + '"\s*\{([^{}]*)\}')) { $Matches[1] } else { '' }
    $fromLogin = $own -match '"PersonaName"\s+"([^"\r\n]*)"'
    if ($fromLogin) { $v = $Matches[1]; if ($v.Length -ge 3) { $names.Add($v) } elseif ($v) { $short = $true }; if ($rewritten) { $known = $true } }
    $fromConfig = $false
    foreach ($m in [regex]::Matches($LocalConfig, '"PersonaName"\s+"([^"\r\n]*)"')) {
        $fromConfig = $true; $known = $true
        $v = $m.Groups[1].Value
        if ($v.Length -ge 3) { $names.Add($v) } elseif ($v) { $short = $true }
    }
    if ($short -or $names.Count -eq 0) { $known = $false }
    $why = "loginusers.vdf rewritten by Steam: $(if ($rewritten) { 'yes' } else { 'no' }), persona in it: $(if ($fromLogin) { 'yes' } else { 'no' }); localconfig.vdf persona: $(if ($fromConfig) { 'yes' } else { 'no' })$(if ($short) { '; a name under 3 characters cannot be checked' })"
    return [pscustomobject]@{ Names = @($names | Select-Object -Unique); Known = $known; Why = $why }
}

function Read-Shared([string]$path) {
    $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite,Delete')
    try { (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
}

if ($Check) {
    "Windows visible to this session: $(@([RigWin]::Snapshot()).Count)"
    $steamErr = 'pid=10 visible=True class=#32770 title=[Steam Error] children=[Static=Application load error 6:0000065432 | Button=OK]'
    $crash = 'pid=20 visible=True class=#32770 title=[The game has crashed] children=[Static=Report]'
    $splash = 'pid=20 visible=True class=SplashWnd title=[StarRupture Mod Loader] children=[]'
    $other = 'pid=30 visible=True class=#32770 title=[System Properties] children=[]'
    $hidden = 'pid=20 visible=False class=#32770 title=[The game has crashed] children=[]'
    if ((Find-GameDialog @($splash, $other, $hidden) @(20)) -ne $null) { throw 'a harmless window was taken for a dialog' }
    if ((Find-GameDialog @($steamErr) @(20)).Kind -ne 'load-error') { throw 'the Steam load error was not found' }
    if ((Find-GameDialog @($splash, $crash) @(20)).Kind -ne 'dialog') { throw 'the crash dialog was not found' }
    if ((Find-GameDialog @($crash) @(99)) -ne $null) { throw 'a dialog of another process counted' }
    if ((Find-GameDialog @('pid=10 visible=True class=#32770 title=[Steam Error] children=[Static=Something else]') @(20)) -ne $null) { throw 'another Steam error was taken for the load error' }
    $ini = New-IniText
    foreach ($want in '[AutoUpdate]', 'Enabled=0', 'Level=INFO', '[UI]') { if ($ini -notmatch [regex]::Escape($want)) { throw "the ini lacks $want" } }
    if ((Build-LoginUsers '1' 'a' 2) -notmatch '"AllowAutoLogin" "1"') { throw 'loginusers is wrong' }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("rig-check-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Force (Join-Path $tmp 'ModLoader\Plugins') | Out-Null
    'a' | Set-Content (Join-Path $tmp 'dwmapi.dll'); 'b' | Set-Content (Join-Path $tmp 'ModLoader\Plugins\X.dll'); 'c' | Set-Content (Join-Path $tmp 'ModLoader\readme.txt')
    $hs = Get-DllHashes $tmp
    Remove-Item -LiteralPath $tmp -Recurse -Force
    if (@($hs.Keys).Count -ne 2 -or -not $hs.Contains('ModLoader/Plugins/X.dll') -or $hs['dwmapi.dll'].Length -ne 64) { throw 'the DLL hashes are wrong' }

    # The exes to firewall come from the install, nested ones and the crash reporter included.
    $inst = Join-Path ([IO.Path]::GetTempPath()) ("rig-check-" + [guid]::NewGuid())
    foreach ($e in 'Game\Binaries\Win64\Game-Shipping.exe', 'Game\Binaries\Win64\ModLoader\Updater.exe', 'Engine\Binaries\Win64\CrashReportClient.exe', 'Engine\Extras\Redist\en-us\Prereq.exe') {
        New-Item -ItemType Directory -Force (Split-Path (Join-Path $inst $e)) | Out-Null
        'MZ' | Set-Content (Join-Path $inst $e)
    }
    'x' | Set-Content (Join-Path $inst 'Engine\Binaries\Win64\notes.txt'); 'MZ' | Set-Content (Join-Path $inst 'Engine\Binaries\Win64\Loader.dll')
    $exes = Get-InstallExes $inst
    Remove-Item -LiteralPath $inst -Recurse -Force
    if ($exes.Count -ne 4 -or @($exes | Where-Object { $_ -like '*\CrashReportClient.exe' }).Count -ne 1 -or @($exes | Where-Object { $_ -notlike '*.exe' }).Count) { throw 'the install exes are wrong' }

    # The persona comes only from what Steam wrote.
    $id = '76561198000000001'
    $mine = Build-LoginUsers $id 'acct1' 1
    $steam = "`"users`"`n{`n`"$id`"`n{`n`"AccountName`" `"acct1`"`n`"PersonaName`" `"Real Name`"`n`"Timestamp`" `"9`"`n}`n}`n"
    $cfg = "`"UserLocalConfigStore`"`n{`n`"friends`"`n{`n`"PersonaName`" `"Cfg Name`"`n}`n}`n"
    $p = Get-Personas $mine $mine '' $id
    if ($p.Known -or $p.Names -notcontains 'acct1') { throw 'an unrewritten loginusers.vdf was taken as the persona' }
    $p = Get-Personas $steam $mine '' $id
    if (-not $p.Known -or $p.Names -notcontains 'Real Name') { throw 'a persona Steam wrote to loginusers.vdf was not found' }
    $p = Get-Personas $mine $mine $cfg $id
    if (-not $p.Known -or $p.Names -notcontains 'Cfg Name') { throw 'the persona in localconfig.vdf was not found' }
    $p = Get-Personas ($steam -replace 'Real Name', 'Al') $mine '' $id
    if ($p.Known) { throw 'a persona under 3 characters was taken as checkable' }
    $p = Get-Personas '' $mine '' $id
    if ($p.Known -or $p.Names.Count) { throw 'a missing loginusers.vdf was taken as a persona' }
    'Check passed.'
    exit 0
}

if (-not $Phase) { throw '-Phase Install or Launch is required' }

# The job's outputs name this when the rig stops before the verdict.
function Set-Reason([string]$msg) {
    $f = Join-Path $env:RUNNER_TEMP 'rig-reason.txt'
    if (-not (Test-Path -LiteralPath $f)) { Set-Content -LiteralPath $f -Value (($msg -replace '\s+', ' ').Trim()) -Encoding utf8 }
}
function Stop-WithReason([string]$msg) { Set-Reason $msg; throw $msg }

# ---- the login: read once, cleared from the environment ------------------------------
$user = "$env:STEAM_USER".Trim()
$cacheB64 = "$env:STEAM_CACHE".Trim()
Remove-Item Env:STEAM_USER, Env:STEAM_CACHE -ErrorAction SilentlyContinue
if ($user -notmatch '^[A-Za-z0-9_]{3,64}$') { Stop-WithReason 'STEAM_CI_USERNAME is not a valid Steam account name' }
Write-Host "::add-mask::$user"
try { $cacheBytes = [Convert]::FromBase64String($cacheB64) } catch { Stop-WithReason 'STEAM_CI_LOGIN_CACHE is not base64' }
$cacheB64 = $null
$cacheText = [Text.Encoding]::UTF8.GetString($cacheBytes)
if ($cacheText -notmatch '"ConnectCache"') { Stop-WithReason 'STEAM_CI_LOGIN_CACHE is not a steamcmd config.vdf with a ConnectCache entry' }
$script:secrets = [Collections.Generic.List[string]]::new()
$gateFile = Join-Path $env:RUNNER_TEMP 'rig-gate-terms.txt'

# Every value the leak gate and the scrub must know, masked in the job log as well.
function Add-Secret([string]$value, [switch]$Gate) {
    if (-not $value -or $script:secrets.Contains($value)) { return }
    Write-Host "::add-mask::$value"
    $script:secrets.Add($value)
    $script:secretRx = '(?i)' + (($script:secrets | Sort-Object Length -Descending | ForEach-Object { [regex]::Escape($_) }) -join '|')
    if ($Gate) { Add-Content -LiteralPath $gateFile -Value $value }
}
Add-Secret $user
foreach ($m in [regex]::Matches($cacheText, '"[^"\r\n]*"[ \t]+"([^"\r\n]{16,})"')) { Add-Secret $m.Groups[1].Value }

function Scrub([string]$s) {
    $s -replace '\[U:1:\d+\]', '[U:1:***]' -replace '7656119\d{10}', '***' -replace $script:secretRx, '***'
}
function Say([string]$s) { Write-Host (Scrub ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $s)) }

# The logs cannot be made safe to publish: the workflow reads this file and withholds them.
function Set-Hold([string]$msg) {
    Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'rig-hold.txt') -Value (($msg -replace '\s+', ' ').Trim()) -Encoding utf8
}

$appId = '1631270'
$root = 'C:\steamcmd'
$steamcmd = Join-Path $root 'steamcmd.exe'
$steamDir = Join-Path ${env:ProgramFiles(x86)} 'Steam'
$steamExe = Join-Path $steamDir 'steam.exe'
$steamLogs = Join-Path $steamDir 'logs'
$steamFlags = '-silent -cef-disable-gpu -cef-disable-gpu-compositing -no-cef-sandbox -nofriendsui -nochatui'
$activeKey = 'HKCU:\Software\Valve\Steam\ActiveProcess'
$gameRx = '^(StarRupture|UnrealCEF|CrashReport|steamerrorreporter|WerFault)'

function Assert-ValveSigned([string]$file) {
    $sig = Get-AuthenticodeSignature $file
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -cnotmatch '^CN=Valve(?: Corp\.)?, (?:OU=[^,"]+, )?O=Valve(?: Corp\.)?, (?:L=Bellevue, )?S=Washington, C=US$') {
        throw "$(Split-Path $file -Leaf) is not Valve-signed (status $($sig.Status))"
    }
}

# ---- Phase Install: steamcmd -------------------------------------------------------------
function Install-Client {
    if ($Branch -notmatch '^[A-Za-z0-9_]+$') { throw "bad branch name '$Branch'" }
    New-Item -ItemType Directory -Force $root | Out-Null
    $zip = Join-Path $env:RUNNER_TEMP 'steamcmd.zip'
    Invoke-WebRequest -Uri 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip' -OutFile $zip -TimeoutSec 120
    Expand-Archive -Path $zip -DestinationPath $root -Force
    Assert-ValveSigned $steamcmd
    Write-Host '::group::steamcmd self-update'
    & $steamcmd +quit | ForEach-Object { Write-Host (Scrub "$_") }
    Write-Host "self-update exit code: $LASTEXITCODE"
    Write-Host '::endgroup::'
    Assert-ValveSigned $steamcmd

    $cfgDir = Join-Path $root 'config'
    New-Item -ItemType Directory -Force $cfgDir | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $cfgDir 'config.vdf'), $cacheBytes)

    $vol = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free } | Sort-Object Free -Descending | Select-Object -First 1
    $install = Join-Path $vol.Root 'sr-client'
    New-Item -ItemType Directory -Force $install | Out-Null
    Write-Host ("Installing to {0} ({1:N1} GB free)" -f $install, ($vol.Free / 1GB))

    # The branch is always named, public included: steamcmd otherwise installs the branch it
    # last used for the app.
    $cmd = @('+@ShutdownOnFailedCommand', '1', '+@NoPromptForPassword', '1',
             '+force_install_dir', $install, '+login', $user, '+app_update', $appId, '-beta', $Branch, '+quit')
    $manifest = Join-Path $install "steamapps\appmanifest_$appId.acf"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $installed = $false; $loginOk = $false; $all = ''
    for ($i = 1; $i -le 3 -and -not $installed; $i++) {
        Write-Host "::group::steamcmd attempt $i of 3"
        $lines = [Collections.Generic.List[string]]::new()
        $lastBucket = -1
        & $steamcmd @cmd 2>&1 | ForEach-Object {
            $line = Scrub "$_"
            $lines.Add($line)
            if ($line -match 'progress:\s+([\d.]+)') {
                $bucket = [int]([double]$Matches[1] / 10)
                if ($bucket -ne $lastBucket) { $lastBucket = $bucket; Write-Host ("[{0:N0}s] {1}" -f $sw.Elapsed.TotalSeconds, $line) }
            } else { Write-Host $line }
        }
        $code = $LASTEXITCODE
        Write-Host "steamcmd exit code: $code after $([int]$sw.Elapsed.TotalSeconds) s"
        Write-Host '::endgroup::'
        $all = $lines -join "`n"
        if ($all -match 'to Steam Public\.\.\.OK|Waiting for user info\.\.\.OK') { $loginOk = $true }
        $installed = ($code -eq 0) -and (Test-Path $manifest) -and ((Get-Content $manifest -Raw) -match '"StateFlags"\s+"4"')
        # A login failure is never retried: repeats get the account rate-limited.
        if (-not $loginOk) { break }
    }
    if (-not $installed) {
        if (-not $loginOk) {
            if ($all -match 'Rate Limit') { throw 'Steam rate-limited the CI login; run the rig again later' }
            throw 'Steam rejected the saved CI login: run steam-ci-login.ps1 -Renew'
        }
        if ($all -match 'No subscription|missing license|No license') { throw "The CI Steam account does not own StarRupture (app $appId)" }
        throw 'The game client did not install'
    }
    $acf = Get-Content $manifest -Raw
    $build = if ($acf -match '"buildid"\s+"(\d+)"') { $Matches[1] } else { '' }
    $mounted = if ($acf -match '"MountedConfig"\s*\{([^{}]*)\}') { $Matches[1] } else { '' }
    $beta = if ($mounted -match '"BetaKey"\s+"([^"]*)"') { $Matches[1] } else { '' }
    if ($beta -ne $Branch -or -not $build) { throw "Steam installed the wrong thing for branch ${Branch}: branch '$beta', build '$build'" }
    Write-Host "Installed build $build of branch $beta in $([int]$sw.Elapsed.TotalSeconds) s"
    "install_dir=$install" >> $env:GITHUB_OUTPUT
}

# ---- Phase Launch: the Steam client --------------------------------------------------------
function Test-ActiveUser {
    try { [long](Get-ItemPropertyValue $activeKey -Name ActiveUser -ErrorAction Stop) -ne 0 } catch { $false }
}
function Get-SteamProcs { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(steam|gameoverlayui)' }) }
function Start-Steam { Start-Process -FilePath $steamExe -ArgumentList $steamFlags -WorkingDirectory $steamDir | Out-Null }

function Stop-Steam {
    if (-not @(Get-SteamProcs).Count) { return }
    if (Test-Path -LiteralPath $steamExe) { Start-Process -FilePath $steamExe -ArgumentList '-shutdown' -WorkingDirectory $steamDir | Out-Null }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt 45 -and @(Get-SteamProcs | Where-Object { $_.ProcessName -ne 'steamservice' }).Count) { Start-Sleep -Seconds 2 }
    @(Get-SteamProcs) | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

function Install-SteamClient {
    $setup = Join-Path $env:RUNNER_TEMP 'SteamSetup.exe'
    Invoke-WebRequest -Uri 'https://cdn.cloudflare.steamstatic.com/client/installer/SteamSetup.exe' -OutFile $setup -TimeoutSec 180
    Assert-ValveSigned $setup
    $p = Start-Process -FilePath $setup -ArgumentList '/S' -WindowStyle Hidden -PassThru
    if (-not $p.WaitForExit(300000)) { $p.Kill(); throw 'SteamSetup.exe did not finish in 5 min' }
    Assert-ValveSigned $steamExe
    Say "Steam client installed (setup exit code $($p.ExitCode))"
}

# First start: the client downloads itself. No login exists yet.
function Invoke-Bootstrap {
    Start-Steam
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $readyAt = $null
    while ($sw.Elapsed.TotalSeconds -lt 480) {
        Start-Sleep -Seconds 3
        $ready = (Test-Path -LiteralPath (Join-Path $steamDir 'steamui.dll')) -and @(Get-Process steamwebhelper -ErrorAction SilentlyContinue).Count -gt 0
        if ($ready -and -not $readyAt) { $readyAt = $sw.Elapsed.TotalSeconds }
        if (-not $ready) { $readyAt = $null }
        if ($readyAt -and ($sw.Elapsed.TotalSeconds - $readyAt) -ge 30) { break }
    }
    Assert-ValveSigned $steamExe
    if (-not $readyAt) { throw 'The Steam client did not come up (no steady steamwebhelper in 8 min)' }
    Say "Steam client up after $([int]$sw.Elapsed.TotalSeconds) s"
}

# The secret's config.vdf plus the ordinary "remember me" settings: the client signs in
# with no password and no Guard code.
function Write-ClientLogin {
    $cfgDir = Join-Path $steamDir 'config'
    New-Item -ItemType Directory -Force $cfgDir | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $cfgDir 'config.vdf'), $cacheBytes)
    if (-not (Test-Path 'HKCU:\Software\Valve\Steam')) { New-Item -Path 'HKCU:\Software\Valve\Steam' -Force | Out-Null }
    Set-ItemProperty 'HKCU:\Software\Valve\Steam' -Name AutoLoginUser -Value $user -Type String
    Set-ItemProperty 'HKCU:\Software\Valve\Steam' -Name RememberPassword -Value 1 -Type DWord
    $script:loginUsersWritten = Build-LoginUsers $script:id64 $user ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
    Set-Content -LiteralPath (Join-Path $cfgDir 'loginusers.vdf') -Value $script:loginUsersWritten -Encoding ascii -NoNewline
}

function Read-ConnectionLines {
    $p = Join-Path $steamLogs 'connection_log.txt'
    if (Test-Path -LiteralPath $p) { @((Read-Shared $p) -split "`r?`n") } else { @() }
}

# live | guard | denied | prompt | nothing, from what the client itself shows.
function Wait-ClientLogin([int]$cap = 180) {
    $before = @(Read-ConnectionLines).Count
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $promptAt = $null
    $result = 'nothing'
    while ($sw.Elapsed.TotalSeconds -lt $cap) {
        Start-Sleep -Seconds 3
        if (Test-ActiveUser) { $result = 'live'; break }
        $new = @(Read-ConnectionLines | Select-Object -Skip $before) -join "`n"
        if ($new -match '(?i)AccessDenied|InvalidPassword|Expired|Revoked|RateLimit|AccountLoginDenied') { $result = 'denied'; break }
        $titles = @([RigWin]::Snapshot())
        if (@($titles -match '(?i)title=\[[^\]]*(steam guard|two-factor|authenticator)').Count) { $result = 'guard'; break }
        if (@($titles -match '(?i)visible=True[^\[]*title=\[[^\]]*(sign in|log ?in)').Count) {
            if (-not $promptAt) { $promptAt = $sw.Elapsed.TotalSeconds }
            if (($sw.Elapsed.TotalSeconds - $promptAt) -ge 45) { $result = 'prompt'; break }
        } else { $promptAt = $null }
    }
    Say "Steam client login: $result after $([int]$sw.Elapsed.TotalSeconds) s"
    return $result
}

# The persona names are known only after the client ran, and Steam writes them out as it
# shuts down; the gate and the scrub need them. Returns the Get-Personas result.
function Read-Personas {
    $read = { param($p) if (Test-Path -LiteralPath $p) { Read-Shared $p } else { '' } }
    $login = & $read (Join-Path $steamDir 'config\loginusers.vdf')
    $local = & $read (Join-Path $steamDir "userdata\$script:id32\config\localconfig.vdf")
    return (Get-Personas $login $script:loginUsersWritten $local $script:id64)
}

# ---- Phase Launch: the game -----------------------------------------------------------------
function Enable-Firewall([string[]]$Programs) {
    Set-NetFirewallProfile -Profile Domain, Private, Public -Enabled True
    $off = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled })
    if ($off.Count) { throw 'The Windows firewall could not be switched on' }
    # Nothing in the install gets a way out: the game and the plugins in it, the loader's
    # updater and UE's crash reporter. The rule is per program, not a sandbox: a plugin can
    # still start a program from elsewhere on the runner.
    $n = 0
    foreach ($prog in $Programs) {
        $n++
        $name = 'sr-client-rig-block-{0:D3}-{1}' -f $n, (Split-Path $prog -Leaf)
        New-NetFirewallRule -DisplayName $name -Direction Outbound -Action Block -Program $prog -Profile Any -Enabled True | Out-Null
        $rule = Get-NetFirewallRule -DisplayName $name
        $filter = $rule | Get-NetFirewallApplicationFilter
        if ($rule.Enabled -ne 'True' -or $rule.Action -ne 'Block' -or $rule.Direction -ne 'Outbound' -or $filter.Program -ne $prog) { throw "Firewall rule $name is not in force" }
    }
    Say "Firewall on; outbound blocked for $n program(s) in the install"
}

function Reset-GameState {
    if (Test-Path -LiteralPath $script:mlLogs) { Get-ChildItem -LiteralPath $script:mlLogs -File | Remove-Item -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath $script:mlDir -Filter 'compat-report-*.json' -File -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    foreach ($d in $script:crashDirs) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } }
}

function Stop-Game {
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match $gameRx } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 5
}

# One launch, watched until the boot has settled, the game is gone, a dialog stops it or the
# cap runs out. Returns the facts boot.json holds.
function Invoke-Attempt([int]$Number) {
    Reset-GameState
    $ml = Join-Path $script:mlLogs 'ModLoader.log'
    $env:SteamAppId = $appId
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $started = (Get-Date).ToUniversalTime()
    try { $proc = Start-Process -FilePath $script:exe -ArgumentList $GameArgs -WorkingDirectory $script:bin -PassThru }
    finally { Remove-Item Env:SteamAppId -ErrorAction SilentlyContinue }
    $null = $proc.Handle
    $a = [ordered]@{
        n = $Number; started_utc = $started.ToString('o'); process_found = $false; process_found_s = $null; exited_early = $false; exit_code = $null
        alive_at_end = $false; boot_finished_s = $null; peak_working_set_mb = 0; dialog = $null; load_error = $false; end = ''; seconds = 0
    }
    $doneAt = $null; $dialogAt = $null; $crashAt = $null; $peak = 0.0
    while ($true) {
        Start-Sleep -Seconds 2
        $t = [int]$sw.Elapsed.TotalSeconds
        $proc.Refresh()
        if (-not $a.process_found -and (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) { $a.process_found = $true; $a.process_found_s = $t }
        if ($proc.HasExited) { $a.exited_early = $true; $a.exit_code = $proc.ExitCode; $a.end = "the game exited with code $($proc.ExitCode)"; break }
        try { $peak = [math]::Max($peak, $proc.WorkingSet64 / 1MB) } catch { }

        $pids = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'StarRupture*' } | ForEach-Object { $_.Id })
        $dlg = Find-GameDialog @([RigWin]::Snapshot()) $pids
        if ($dlg -and $dlg.Kind -eq 'load-error') { $a.load_error = $true; $a.dialog = $dlg.Title + ': ' + $dlg.Text; $a.end = 'Steam Error dialog (Application load error)'; break }
        if ($dlg -and -not $dialogAt) { $dialogAt = $t; $a.dialog = $dlg.Title; Say "Dialog '$($dlg.Title)' at $t s" }
        # The dialog holds the process open; give the loader's log a moment, then stop.
        if ($dialogAt -and ($t - $dialogAt) -ge 5) { $a.end = "dialog '$($a.dialog)'"; break }

        $text = if (Test-Path -LiteralPath $ml) { try { Read-Shared $ml } catch { '' } } else { '' }
        if (-not $crashAt -and $text -match 'FATAL ENGINE CRASH') { $crashAt = $t; Say "Fatal crash in the log at $t s" }
        if ($crashAt -and ($t - $crashAt) -ge 15) { $a.end = 'fatal crash in the log'; break }
        if (-not $doneAt -and $text -match 'Boot sequence finished') { $doneAt = $t; $a.boot_finished_s = $t; Say "Boot sequence finished at $t s; settling $SettleSec s" }
        if ($doneAt -and ($t - $doneAt) -ge $SettleSec) { $a.end = 'settled'; break }
        # The cap bounds the boot only.
        if (-not $doneAt -and $t -ge $AttemptCapSec) { $a.end = "no 'Boot sequence finished' in $AttemptCapSec s"; break }
    }
    if (-not $a.exited_early) { $a.alive_at_end = $true }
    $a.peak_working_set_mb = [int]$peak
    $a.seconds = [int]$sw.Elapsed.TotalSeconds
    Say "Attempt $Number ended at $($a.seconds) s: $($a.end)"
    return $a
}

function Invoke-Launch {
    $exeItem = Get-ChildItem -LiteralPath $InstallDir -Recurse -Filter 'StarRuptureGameSteam-Win64-Shipping.exe' -File | Select-Object -First 1
    if (-not $exeItem) { throw "StarRuptureGameSteam-Win64-Shipping.exe not found under $InstallDir" }
    $script:exe = $exeItem.FullName
    $script:bin = $exeItem.DirectoryName
    $script:mlDir = Join-Path $script:bin 'ModLoader'
    $script:mlLogs = Join-Path $script:mlDir 'Logs'
    $script:updater = Join-Path $script:mlDir 'StarRupture-ModLoader-Updater.exe'
    $gameRoot = (Get-Item $script:bin).Parent.Parent.FullName
    $script:crashDirs = @((Join-Path $gameRoot 'Saved\Crashes'), (Join-Path $env:LOCALAPPDATA 'StarRupture\Saved\Crashes'))
    if (-not (Test-Path -LiteralPath (Join-Path $script:bin 'dwmapi.dll'))) { throw 'The loader is not installed (no dwmapi.dll)' }
    New-Item -ItemType Directory -Force $OutDir | Out-Null
    $OutDir = (Resolve-Path $OutDir).Path

    # The ids, from the install's login, for the scrub and the leak gate. steamcmd has exited.
    $console = Join-Path $root 'logs\console_log.txt'
    $id32 = if ((Test-Path -LiteralPath $console) -and ((Read-Shared $console) -match '\[U:1:(\d+)\]')) { $Matches[1] } else { '' }
    $script:id64 = if ($cacheText -match '"SteamID"\s+"(7656119\d{10})"') { $Matches[1] } elseif ($id32) { "$(76561197960265728L + [long]$id32)" } else { '' }
    if (-not $id32 -and $script:id64) { $id32 = "$([long]$script:id64 - 76561197960265728L)" }
    $script:id32 = $id32
    if (-not $script:id64) { throw 'The CI account SteamID could not be read from the saved login' }
    Add-Secret $id32 -Gate
    Add-Secret $script:id64
    Get-Process steamcmd -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $root 'config') -Recurse -Force -ErrorAction SilentlyContinue

    # The rule set comes from the install itself; the game and the updater must be in it.
    $exes = Get-InstallExes $InstallDir
    foreach ($must in $script:exe, $script:updater) {
        if ($exes -notcontains $must) { throw "$(Split-Path $must -Leaf) is not among the install's programs; the firewall rules would miss it" }
    }
    Enable-Firewall $exes
    Set-Content -LiteralPath (Join-Path $script:mlDir 'modloader.ini') -Value (New-IniText) -Encoding ascii -NoNewline
    Set-Content -LiteralPath (Join-Path $script:bin 'steam_appid.txt') -Value $appId -Encoding ascii -NoNewline
    $hashes = Get-DllHashes $script:bin
    Say "$(@($hashes.Keys).Count) loader and plugin binaries hashed"

    Install-SteamClient
    Invoke-Bootstrap
    Stop-Steam
    Write-ClientLogin
    Start-Steam
    $login = Wait-ClientLogin
    if ($login -eq 'denied') { throw 'Steam rejected the saved CI login: run steam-ci-login.ps1 -Renew' }
    if ($login -eq 'guard') { throw 'Steam asked for a Guard code; the saved CI login is not accepted' }
    if ($login -ne 'live') { throw "The Steam client did not sign in from the saved login ($login)" }

    $attempts = @()
    $last = $null
    for ($n = 1; $n -le (1 + $MaxRelaunch); $n++) {
        $last = Invoke-Attempt $n
        $attempts += , $last
        if (-not $last.load_error -or $n -gt $MaxRelaunch) { break }
        Say "Steam Error (Application load error) on attempt ${n}: stopping the game and launching it again"
        Stop-Game
    }

    # Facts first, then the stop: what the game was doing when the rig ended it.
    $dialogTitle = if ($last.dialog) { Scrub $last.dialog } else { $null }
    $aliveAtEnd = [bool]$last.alive_at_end
    Stop-Game
    # Steam writes the persona out as it shuts down; the game is stopped, so nothing needs it now.
    Stop-Steam
    $after = Get-DllHashes $script:bin
    $dll = [ordered]@{}
    foreach ($k in @($hashes.Keys) + @($after.Keys | Where-Object { -not $hashes.Contains($_) })) {
        $dll[$k] = [ordered]@{ before = $(if ($hashes.Contains($k)) { $hashes[$k] } else { '' }); after = $(if ($after.Contains($k)) { $after[$k] } else { '' }) }
    }
    $crashFiles = @()
    foreach ($d in $script:crashDirs) { if (Test-Path -LiteralPath $d) { $crashFiles += @(Get-ChildItem -LiteralPath $d -Recurse -File | ForEach-Object { $_.Name }) } }
    $compat = @(Get-ChildItem -LiteralPath $script:mlDir -Filter 'compat-report-*.json' -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })

    $persona = Read-Personas
    foreach ($n in $persona.Names) { Add-Secret $n -Gate }
    if (-not $persona.Known) { Set-Hold "The Steam persona name could not be determined ($($persona.Why)), so the logs were not uploaded and nothing from them was published." }
    foreach ($f in @(@('ModLoader.log', 'modloader.log'), @('Proxy.log', 'proxy.log'), @('AutoUpdate.log', 'autoupdate.log'))) {
        $p = Join-Path $script:mlLogs $f[0]
        if (Test-Path -LiteralPath $p) { [IO.File]::WriteAllText((Join-Path $OutDir $f[1]), (Scrub (Read-Shared $p)), (New-Object Text.UTF8Encoding $false)) }
    }
    $boot = [ordered]@{
        label = 'client'; started_utc = $last.started_utc; launched_args = $GameArgs
        process_found = [bool]$last.process_found; process_found_s = $last.process_found_s
        exited_early = [bool]$last.exited_early; exit_code = $last.exit_code; alive_at_end = $aliveAtEnd
        boot_finished_s = $last.boot_finished_s; peak_working_set_mb = $last.peak_working_set_mb
        crash_files = @($crashFiles); crash_dialog = $dialogTitle; compat_reports = @($compat)
        relaunches = $attempts.Count - 1
        attempts = @($attempts | ForEach-Object { [ordered]@{ n = $_.n; seconds = $_.seconds; end = $_.end; steam_load_error = $_.load_error } })
    }
    [IO.File]::WriteAllText((Join-Path $OutDir 'dll-hashes.json'), ($dll | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
    [IO.File]::WriteAllText((Join-Path $OutDir 'boot.json'), (Scrub ($boot | ConvertTo-Json -Depth 5)), (New-Object Text.UTF8Encoding $false))
    Say "Recorded $($attempts.Count) attempt(s); the last: $($last.end)"
}

$failed = $false
try {
    switch ($Phase) {
        'Install' { Install-Client }
        'Launch' { Invoke-Launch }
    }
} catch {
    $failed = $true
    $msg = Scrub "$($_.Exception.Message)"
    Write-Host "::error::$msg"
    Set-Reason $msg
} finally {
    $cacheBytes = $null; $cacheText = $null
    # steamcmd's login cache: gone as soon as the install is done.
    if ($Phase -eq 'Install') { Remove-Item -LiteralPath (Join-Path $root 'config\config.vdf') -Force -ErrorAction SilentlyContinue }
}
if ($failed) { exit 1 }
