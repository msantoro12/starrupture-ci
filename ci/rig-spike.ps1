# Spike 4: with the real Steam client signed in from the saved CI login, do the
# icon stale-pointer fixes stop the crash under the icon code's tick, and does a
# plain -dx11 launch of the released set hit it? Several launches in one client
# session, each with fresh logs: CONTROL-A, FIX-ALL x2 (Codex, ProductionViewer
# and WAILA fixed), CONTROL-B.
# Reads the login from STEAM_USER / STEAM_CACHE, then clears both from the
# environment, so no launched process inherits them. Decides nothing for the
# pipeline: it records what each stage did under -OutDir. Everything written or
# printed goes through Scrub. Steam's own logs and config files never reach
# -OutDir, only a filtered connection_log excerpt and derived yes/no facts.
# -Check only exercises the helpers, with no login.
param(
  [string]$Install,
  [string]$OutDir = 'out',
  [string]$GameArgs = '-nullrhi -unattended -nosound -log',
  [int]$CapSec = 300,
  [int]$SettleSec = 90,
  [int]$BudgetMin = 50,
  [string]$FixDir,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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

function Get-ConnectCacheBody([string]$vdf) {
  if ($vdf -match '"ConnectCache"\s*\{([^{}]*)\}') { $Matches[1].Trim() } else { '' }
}

function Build-LocalVdf([string]$body) {
  "`"MachineUserConfigStore`"`n{`n`"Software`"`n{`n`"Valve`"`n{`n`"Steam`"`n{`n`"ConnectCache`"`n{`n$body`n}`n}`n}`n}`n}`n"
}

function Build-LoginUsers([string]$id64, [string]$name, [long]$now) {
  "`"users`"`n{`n`"$id64`"`n{`n`"AccountName`" `"$name`"`n`"PersonaName`" `"$name`"`n`"RememberPassword`" `"1`"`n`"WantsOfflineMode`" `"0`"`n`"SkipOfflineModeWarning`" `"0`"`n`"AllowAutoLogin`" `"1`"`n`"MostRecent`" `"1`"`n`"Timestamp`" `"$now`"`n}`n}`n"
}

function Add-LibraryEntry([string]$vdf, [string]$lib, [string]$appId, [long]$size) {
  $path = $lib -replace '\\', '\\'
  $ids = @(-1) + @([regex]::Matches($vdf, '(?m)^\s*"(\d+)"\s*$') | ForEach-Object { [int]$_.Groups[1].Value })
  $next = 1 + ($ids | Measure-Object -Maximum).Maximum
  $entry = "`"$next`"`n{`n`"path`" `"$path`"`n`"label`" `"`"`n`"contentid`" `"0`"`n`"totalsize`" `"0`"`n`"update_clean_bytes_tally`" `"0`"`n`"time_last_update_verified`" `"0`"`n`"apps`"`n{`n`"$appId`" `"$size`"`n}`n}`n"
  $cut = $vdf.LastIndexOf('}')
  if ($cut -lt 0) { return "`"libraryfolders`"`n{`n$entry}`n" }
  $vdf.Substring(0, $cut) + $entry + "}`n"
}

if ($Check) {
  "Windows visible to this session: $(@([RigWin]::Snapshot()).Count)"
  Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier rigCheck | Out-Null
  Start-Process -FilePath "$env:ComSpec" -ArgumentList '/c', 'exit' -WindowStyle Hidden -Wait
  Start-Sleep -Seconds 3
  "Process trace events: $(@(Get-Event -SourceIdentifier rigCheck -ErrorAction SilentlyContinue).Count)"
  Unregister-Event -SourceIdentifier rigCheck
  $fake = "`"InstallConfigStore`"`n{`n`"Software`"`n{`n`"Valve`"`n{`n`"Steam`"`n{`n`"ConnectCache`"`n`t{`n`t`t`"abc1`"`t`t`"00ff`"`n`t}`n}`n}`n}`n}`n"
  $cc = Get-ConnectCacheBody $fake
  if ($cc -notmatch '"abc1"\s+"00ff"') { throw 'ConnectCache was not read back' }
  if ((Get-ConnectCacheBody (Build-LocalVdf $cc)) -ne $cc) { throw 'local.vdf does not round-trip' }
  $lf = Add-LibraryEntry "`"libraryfolders`"`n{`n`"0`"`n{`n`"path`" `"C:\\Steam`"`n}`n}`n" 'D:\sr-lib' '1631270' 5
  if ($lf -notmatch '"1"\s+\{\s+"path" "D:\\\\sr-lib"' -or $lf.Split('{').Count -ne $lf.Split('}').Count) { throw 'libraryfolders entry is wrong' }
  if ((Add-LibraryEntry '' 'D:\sr-lib' '1631270' 5) -notmatch '^"libraryfolders"') { throw 'fresh libraryfolders is wrong' }
  if ((Build-LoginUsers '1' 'a' 2) -notmatch '"AllowAutoLogin" "1"') { throw 'loginusers is wrong' }
  'Check passed.'
  exit 0
}

$user = "$env:STEAM_USER".Trim()
$cacheB64 = "$env:STEAM_CACHE".Trim()
Remove-Item Env:STEAM_USER, Env:STEAM_CACHE -ErrorAction SilentlyContinue
if ($user -notmatch '^[A-Za-z0-9_]{3,64}$') { throw 'STEAM_USER is not a valid Steam account name' }
Write-Host "::add-mask::$user"
$cacheBytes = [Convert]::FromBase64String($cacheB64)
$cacheB64 = $null
$cacheText = [Text.Encoding]::UTF8.GetString($cacheBytes)
$script:secrets = [Collections.Generic.List[string]]::new()
$gateFile = Join-Path $env:RUNNER_TEMP 'rig-gate-terms.txt'

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

New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$runLog = Join-Path $OutDir 'run.log'
function Say([string]$s) {
  $l = Scrub ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $s)
  Write-Host $l
  Add-Content -LiteralPath $runLog -Value $l
}

function Read-Shared([string]$path) {
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite,Delete')
  try { (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
}

$appId = '1631270'
$root = 'C:\steamcmd'
$steamcmd = Join-Path $root 'steamcmd.exe'
$steamDir = Join-Path ${env:ProgramFiles(x86)} 'Steam'
$steamExe = Join-Path $steamDir 'steam.exe'
$steamLogs = Join-Path $steamDir 'logs'
$localDir = Join-Path $env:LOCALAPPDATA 'Steam'
$steamFlags = '-silent -cef-disable-gpu -cef-disable-gpu-compositing -no-cef-sandbox -nofriendsui -nochatui'
$activeKey = 'HKCU:\Software\Valve\Steam\ActiveProcess'
$gameRx = '^(StarRupture|UnrealCEF|CrashReport|steamerrorreporter|WerFault)'
$deadline = (Get-Date).AddMinutes($BudgetMin)

function Set-GamePaths([string]$dir) {
  $script:exe = (Get-ChildItem -LiteralPath $dir -Recurse -Filter 'StarRuptureGameSteam-Win64-Shipping.exe' | Select-Object -First 1).FullName
  $script:bin = Split-Path $script:exe
  $script:mlDir = Join-Path $script:bin 'ModLoader'
  $script:mlLogs = Join-Path $script:mlDir 'Logs'
  $gameRoot = (Get-Item $script:bin).Parent.Parent.FullName
  $script:engineDirs = @((Join-Path $gameRoot 'Saved\Logs'), (Join-Path $env:LOCALAPPDATA 'StarRupture\Saved\Logs'))
  $script:crashDirs = @((Join-Path $gameRoot 'Saved\Crashes'), (Join-Path $env:LOCALAPPDATA 'StarRupture\Saved\Crashes'))
}
Set-GamePaths $Install

Say ("Session {0}, UserInteractive {1}, CPUs {2}, video: {3}" -f [Diagnostics.Process]::GetCurrentProcess().SessionId, [Environment]::UserInteractive, [Environment]::ProcessorCount, ((Get-CimInstance Win32_VideoController | ForEach-Object Name) -join '; '))

function Assert-ValveSigned([string]$file) {
  $sig = Get-AuthenticodeSignature $file
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -cnotmatch '^CN=Valve(?: Corp\.)?, (?:OU=[^,"]+, )?O=Valve(?: Corp\.)?, (?:L=Bellevue, )?S=Washington, C=US$') {
    throw "$(Split-Path $file -Leaf) is not Valve-signed (status $($sig.Status))"
  }
}

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
  $left = @(Get-SteamProcs)
  Say "Steam stopped after $([int]$sw.Elapsed.TotalSeconds) s; killed: $(($left | ForEach-Object ProcessName) -join ', ')"
  $left | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

$script:seenWin = @{}
function Note-Windows([string]$file, [int]$at) {
  $snap = @([RigWin]::Snapshot())
  foreach ($w in $snap) {
    if (-not $script:seenWin.ContainsKey($w)) {
      $script:seenWin[$w] = $true
      Add-Content -LiteralPath $file -Value (Scrub ("{0,5}s {1}" -f $at, $w))
    }
  }
  $snap
}

function Read-ConnectionLines {
  $p = Join-Path $steamLogs 'connection_log.txt'
  if (Test-Path -LiteralPath $p) { @((Read-Shared $p) -split "`r?`n") } else { @() }
}

# Only the account's connection lines leave the runner, scrubbed first and cut
# after, so a name is never split past the scrub. Addresses are not needed.
function Save-ConnectionExcerpt {
  $lines = @(Read-ConnectionLines | Where-Object { $_ -match '(?i)LogOn|Logged|LogOff|Denied|InvalidPassword|Expired|Revoked|RateLimit' } | Select-Object -Last 120 | ForEach-Object {
    $l = (Scrub $_) -replace '\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b', '<ip>'
    $l.Substring(0, [math]::Min(200, $l.Length))
  })
  Set-Content -LiteralPath (Join-Path $OutDir 'client-connection-excerpt.txt') -Value $lines -Encoding utf8
}

function Note-Persona {
  $p = Join-Path $steamDir 'config\loginusers.vdf'
  if (Test-Path -LiteralPath $p) {
    foreach ($m in [regex]::Matches((Read-Shared $p), '"PersonaName"\s+"([^"\r\n]{3,})"')) { Add-Secret $m.Groups[1].Value -Gate }
  }
}

# Yes/no facts and Steam's own state words, never lines of its logs.
function Say-ClientFacts([string]$when) {
  Note-Persona
  $content = Join-Path $steamLogs 'content_log.txt'
  $console = Join-Path $steamLogs 'console_log.txt'
  $boot = Join-Path $steamLogs 'bootstrap_log.txt'
  $c = if (Test-Path -LiteralPath $content) { Read-Shared $content } else { '' }
  $k = if (Test-Path -LiteralPath $console) { Read-Shared $console } else { '' }
  $b = if (Test-Path -LiteralPath $boot) { Read-Shared $boot } else { '' }
  $states = @([regex]::Matches($c, "AppID $appId state changed : ([A-Za-z, ]+)") | ForEach-Object { $_.Groups[1].Value.Trim() } | Select-Object -Unique) -join ' / '
  $procs = @(Get-SteamProcs | Group-Object ProcessName | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ' '
  Say ("Client facts ({0}): activeProcessKey={1}; activeUser={2}; appStates=[{3}]; appUpdateStarted={4}; gameProcessAdded={5}; gameProcessRemoved={6}; bootstrapLog={7}; procs=[{8}]" -f $when,
    (Test-Path $activeKey), $(if (Test-ActiveUser) { 'present, non-zero' } else { 'absent or zero' }), $states,
    ($c -match "AppID $appId update started"), ($k -match "Game process added : AppID $appId"), ($k -match "Game process removed: AppID $appId"), [bool]$b, $procs)
  Save-ConnectionExcerpt
}

function Install-SteamClient {
  $setup = Join-Path $env:RUNNER_TEMP 'SteamSetup.exe'
  Invoke-WebRequest -Uri 'https://cdn.cloudflare.steamstatic.com/client/installer/SteamSetup.exe' -OutFile $setup -TimeoutSec 180
  Assert-ValveSigned $setup
  Say 'SteamSetup.exe is Valve-signed'
  $p = Start-Process -FilePath $setup -ArgumentList '/S' -WindowStyle Hidden -PassThru
  if (-not $p.WaitForExit(300000)) { $p.Kill(); throw 'SteamSetup.exe did not finish in 5 min' }
  Say "SteamSetup exit code: $($p.ExitCode); steam.exe present: $(Test-Path -LiteralPath $steamExe)"
  Assert-ValveSigned $steamExe
}

# First start: the client downloads itself. No login exists yet.
function Invoke-Bootstrap {
  $file = Join-Path $OutDir 'client-windows.txt'
  Start-Steam
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $readyAt = $null
  while ($sw.Elapsed.TotalSeconds -lt 480) {
    Start-Sleep -Seconds 3
    [void](Note-Windows $file ([int]$sw.Elapsed.TotalSeconds))
    $ready = (Test-Path -LiteralPath (Join-Path $steamDir 'steamui.dll')) -and @(Get-Process steamwebhelper -ErrorAction SilentlyContinue).Count -gt 0
    if ($ready -and -not $readyAt) { $readyAt = $sw.Elapsed.TotalSeconds }
    if (-not $ready) { $readyAt = $null }
    if ($readyAt -and ($sw.Elapsed.TotalSeconds - $readyAt) -ge 30) { break }
  }
  Say "Bootstrap: steamwebhelper up and steady: $([bool]$readyAt) after $([int]$sw.Elapsed.TotalSeconds) s"
  Say-ClientFacts 'after bootstrap'
  Assert-ValveSigned $steamExe
  $script:bootOk = [bool]$readyAt
}

# Level 1: the secret's config.vdf. Level 2 adds the ordinary "remember me"
# settings. Level 3 adds the same ConnectCache entry to local.vdf.
function Write-ClientLogin([int]$level) {
  $cfgDir = Join-Path $steamDir 'config'
  New-Item -ItemType Directory -Force $cfgDir | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $cfgDir 'config.vdf'), $cacheBytes)
  if ($level -ge 2) {
    if (-not (Test-Path 'HKCU:\Software\Valve\Steam')) { New-Item -Path 'HKCU:\Software\Valve\Steam' -Force | Out-Null }
    Set-ItemProperty 'HKCU:\Software\Valve\Steam' -Name AutoLoginUser -Value $user -Type String
    Set-ItemProperty 'HKCU:\Software\Valve\Steam' -Name RememberPassword -Value 1 -Type DWord
    if ($script:id64) {
      Set-Content -LiteralPath (Join-Path $cfgDir 'loginusers.vdf') -Value (Build-LoginUsers $script:id64 $user ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())) -Encoding ascii -NoNewline
    } else { Say 'No SteamID known: loginusers.vdf not written' }
  }
  if ($level -ge 3) {
    $body = Get-ConnectCacheBody $cacheText
    if (-not $body) { throw 'The saved login has no ConnectCache block' }
    New-Item -ItemType Directory -Force $localDir | Out-Null
    Set-Content -LiteralPath (Join-Path $localDir 'local.vdf') -Value (Build-LocalVdf $body) -Encoding ascii -NoNewline
  }
}

# live | guard | denied | prompt | nothing, from what the client itself shows.
function Wait-ClientLogin([string]$label, [int]$cap = 180) {
  $file = Join-Path $OutDir 'client-windows.txt'
  $before = @(Read-ConnectionLines).Count
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $promptAt = $null
  $result = 'nothing'
  while ($sw.Elapsed.TotalSeconds -lt $cap) {
    Start-Sleep -Seconds 3
    if (Test-ActiveUser) { $result = 'live'; break }
    $new = @(Read-ConnectionLines | Select-Object -Skip $before) -join "`n"
    if ($new -match '(?i)AccessDenied|InvalidPassword|Expired|Revoked|RateLimit|AccountLoginDenied') { $result = 'denied'; break }
    $titles = @(Note-Windows $file ([int]$sw.Elapsed.TotalSeconds))
    if (@($titles -match '(?i)title=\[[^\]]*(steam guard|two-factor|authenticator)').Count) { $result = 'guard'; break }
    if (@($titles -match '(?i)visible=True[^\[]*title=\[[^\]]*(sign in|log ?in)').Count) {
      if (-not $promptAt) { $promptAt = $sw.Elapsed.TotalSeconds }
      if (($sw.Elapsed.TotalSeconds - $promptAt) -ge 45) { $result = 'prompt'; break }
    } else { $promptAt = $null }
  }
  Say "Login $label`: $result after $([int]$sw.Elapsed.TotalSeconds) s"
  Say-ClientFacts "login $label"
  $script:loginResult = $result
}

$stages = @(
  @('proxy-loaded', 'Proxy.log', 'dwmapi\.dll proxy\) loaded'),
  @('updater-finished', 'Proxy.log', 'Auto-updater finished'),
  @('core-attached', 'Proxy.log', 'Core_Attach\(\) succeeded'),
  @('core-build-line', 'ModLoader.log', '\[init\] Build:'),
  @('game-version-ok', 'ModLoader.log', 'Game version OK'),
  @('preflight-passed', 'ModLoader.log', 'Pattern preflight passed'),
  @('hooks-installed', 'ModLoader.log', 'Running client build of modloader'),
  @('engine-init-called', 'ModLoader.log', 'FEngineLoop::Init called'),
  @('engine-ready', 'ModLoader.log', 'ENGINE READY'),
  @('plugin-search', 'ModLoader.log', 'Searching for plugins'),
  @('plugin-dll-loaded', 'ModLoader.log', 'Successfully loaded plugin DLL'),
  @('plugins-initialized', 'ModLoader.log', 'InitAllLoadedPlugins: [1-9]'),
  @('startup-complete', 'ModLoader.log', 'Plugin startup phase complete'),
  @('boot-finished', 'ModLoader.log', 'Boot sequence finished')
)

function Write-TraceEvents([string]$procFile, [int]$at) {
  foreach ($src in 'rigStart', 'rigStop') {
    foreach ($e in @(Get-Event -SourceIdentifier $src -ErrorAction SilentlyContinue)) {
      $n = $e.SourceEventArgs.NewEvent
      $tail = if ($src -eq 'rigStop') { "exit=0x{0:X8}" -f [uint32]$n.ExitStatus } else { "parent=$($n.ParentProcessID)" }
      Add-Content -LiteralPath $procFile -Value (Scrub ("{0,5}s {1} {2} pid={3} {4}" -f $at, $src, $n.ProcessName, $n.ProcessID, $tail))
      Remove-Event -EventIdentifier $e.EventIdentifier
    }
  }
}

function Get-FreeBytes { @{ C = (Get-PSDrive C).Free; D = (Get-PSDrive D).Free } }

$script:downloadTripped = $false

function Run-Attempt([string]$label, [string]$route, [string]$line, [int]$noGameCap, [int]$pluginCount) {
  $dir = Join-Path $OutDir "attempt-$label"
  New-Item -ItemType Directory -Force $dir | Out-Null
  Say "=== Attempt $label"
  $script:seenWin = @{}
  if (Test-Path -LiteralPath $script:mlLogs) { Get-ChildItem -LiteralPath $script:mlLogs -File | Remove-Item -Force -ErrorAction SilentlyContinue }
  foreach ($d in $script:engineDirs + $script:crashDirs) {
    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $procFile = Join-Path $dir 'processes.txt'
  $winFile = Join-Path $dir 'windows.txt'
  New-Item -ItemType File -Force $procFile, $winFile | Out-Null
  Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier rigStart | Out-Null
  Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace -SourceIdentifier rigStop | Out-Null

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $free0 = Get-FreeBytes
  $peakMb = 0.0
  $regNames = @{}
  $doneAt = $null
  $sawGame = $false
  $goneAt = $null
  $ml = Join-Path $script:mlLogs 'ModLoader.log'
  if (Test-Path -LiteralPath $ml) { Say 'A ModLoader.log survived the clean-up: this attempt reads an old log' }
  $launchInfo = Launch-Game $route $line
  $crashAt = $null
  $stubError = $false
  $nextBeat = 0
  $beatFile = Join-Path $dir 'heartbeat.txt'

  # The cap bounds the boot. A finished boot always gets its whole settle.
  while ($doneAt -or $sw.Elapsed.TotalSeconds -lt $CapSec) {
    Start-Sleep -Seconds 2
    Write-TraceEvents $procFile ([int]$sw.Elapsed.TotalSeconds)
    $snapNow = @(Note-Windows $winFile ([int]$sw.Elapsed.TotalSeconds))
    # The stub's dialog holds the process open with no engine behind it.
    if (@($snapNow -match 'visible=True class=#32770 title=\[Steam Error\]').Count) {
      $stubError = $true
      Say "Steam Error dialog at $([int]$sw.Elapsed.TotalSeconds) s"
      break
    }
    # Value names only, never values.
    $reg = Get-Item $activeKey -ErrorAction SilentlyContinue
    if ($reg) { foreach ($v in $reg.Property) { $regNames[$v] = $true }; $regNames['(key present)'] = $true }

    $free = Get-FreeBytes
    if ((($free0.C - $free.C) -gt 3GB) -or (($free0.D - $free.D) -gt 3GB)) {
      $script:downloadTripped = $true
      Say 'More than 3 GB of disk used during the attempt: stopping Steam so it cannot download the game'
      Stop-Steam
      break
    }

    $game = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'StarRupture*' })
    if ($game.Count) {
      $sawGame = $true; $goneAt = $null
      foreach ($g in $game) { try { $peakMb = [math]::Max($peakMb, $g.PeakWorkingSet64 / 1MB) } catch {} }
      if ($sw.Elapsed.TotalSeconds -ge $nextBeat) {
        $nextBeat = $sw.Elapsed.TotalSeconds + 15
        foreach ($g in $game) { try { Add-Content -LiteralPath $beatFile -Value ("{0,5}s responding={1} wsMb={2} cpuSec={3} threads={4}" -f [int]$sw.Elapsed.TotalSeconds, $g.Responding, [int]($g.WorkingSet64 / 1MB), [int]$g.TotalProcessorTime.TotalSeconds, $g.Threads.Count) } catch {} }
      }
    } elseif ($sawGame -and -not $goneAt) { $goneAt = $sw.Elapsed.TotalSeconds }
    if ($goneAt -and ($sw.Elapsed.TotalSeconds - $goneAt) -ge 20) { Say 'Game processes gone for 20 s'; break }
    if (-not $sawGame -and $sw.Elapsed.TotalSeconds -ge $noGameCap) { Say "No game process seen after $noGameCap s"; break }

    $mlNow = if (Test-Path -LiteralPath $ml) { Read-Shared $ml } else { '' }
    # The crash dialog keeps the process alive, so a crash ends the wait itself.
    if (-not $crashAt -and $mlNow -match 'FATAL ENGINE CRASH') {
      $crashAt = $sw.Elapsed.TotalSeconds
      Say "Fatal crash in the log by $([int]$crashAt) s"
    }
    if ($crashAt -and ($sw.Elapsed.TotalSeconds - $crashAt) -ge 15) { break }
    if (-not $doneAt -and $mlNow -match 'Boot sequence finished') {
      $doneAt = $sw.Elapsed.TotalSeconds
      Say "Boot sequence finished at $([int]$doneAt) s; settling $SettleSec s"
    }
    if ($doneAt -and ($sw.Elapsed.TotalSeconds - $doneAt) -ge $SettleSec) { break }
  }
  $alive = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'StarRupture*' }).Count -gt 0
  Say "Attempt $label loop ended at $([int]$sw.Elapsed.TotalSeconds) s; game alive: $alive"
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match $gameRx } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
  Write-TraceEvents $procFile ([int]$sw.Elapsed.TotalSeconds)
  Unregister-Event -SourceIdentifier rigStart -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier rigStop -ErrorAction SilentlyContinue

  Note-Persona
  # Loader logs, scrubbed.
  foreach ($f in 'Proxy.log', 'AutoUpdate.log', 'ModLoader.log') {
    $p = Join-Path $script:mlLogs $f
    if (Test-Path -LiteralPath $p) { Set-Content -LiteralPath (Join-Path $dir $f) -Value (Scrub (Read-Shared $p)) -Encoding utf8 }
  }
  $reached = @()
  foreach ($s in $stages) {
    $p = Join-Path $script:mlLogs $s[1]
    if ((Test-Path -LiteralPath $p) -and ((Read-Shared $p) -cmatch $s[2])) { $reached += $s[0] }
  }
  # The engine log itself never leaves the runner: matching lines only.
  $rhiFile = Join-Path $dir 'engine-rhi.txt'
  $engine = @()
  foreach ($d in $script:engineDirs) {
    if (Test-Path -LiteralPath $d) { $engine += @(Get-ChildItem -LiteralPath $d -Filter *.log) }
  }
  $matchFile = Join-Path $dir 'engine-matches.txt'
  foreach ($l in $engine) {
    Add-Content -LiteralPath $matchFile -Value (Scrub "--- $($l.Name), $($l.Length) bytes")
    (Read-Shared $l.FullName) -split "`r?`n" | Where-Object { $_ -match '(?i)RHI|fatal|error|steam' } | Select-Object -First 500 | ForEach-Object {
      $t = Scrub $_
      Add-Content -LiteralPath $matchFile -Value ($t.Substring(0, [math]::Min(400, $t.Length)))
    }
    (Read-Shared $l.FullName) -split "`r?`n" | Where-Object { $_ -match '(?i)LogRHI|LogD3D|RHI:|D3D1[12]|DXGI|NullDrv|nullrhi|Adapter|Feature ?Level|Shader ?Model|\bSM[56]\b|Vulkan|LogInit: .*GPU|Command ?Line|LoadMap|LogExit|Failed to create' } | Select-Object -First 300 | ForEach-Object {
      $t = Scrub $_
      Add-Content -LiteralPath $rhiFile -Value ($t.Substring(0, [math]::Min(400, $t.Length)))
    }
  }
  # Crash folders: names only.
  $crashes = @()
  foreach ($d in $script:crashDirs) {
    if (Test-Path -LiteralPath $d) { $crashes += @(Get-ChildItem -LiteralPath $d -Recurse -File | ForEach-Object { $_.Name }) }
  }
  $mlText = if (Test-Path -LiteralPath $ml) { Read-Shared $ml } else { '' }
  $ok = ($mlText -match "InitAllLoadedPlugins: $pluginCount initialized, 0 failed") -and ($mlText -match 'Plugin startup phase complete') -and ($mlText -match 'Boot sequence finished')
  $stubExit = ("$(Get-Content -LiteralPath $procFile -Raw)") -match 'rigStop StarRuptureGam\S* pid=\d+ exit=0x00000035'
  $mlLines = @(($mlText -split "`r?`n") | Where-Object { $_ })
  $crashed = $mlText -match 'FATAL ENGINE CRASH'
  # Seconds from "Boot sequence finished" to the crash, by the log's own clock.
  $stamp = { param($rx) $m = ($mlLines | Where-Object { $_ -match $rx } | Select-Object -First 1); if ($m -and $m -match '^\[(\d\d:\d\d:\d\d\.\d+)\]') { [TimeSpan]::Parse($Matches[1]) } else { $null } }
  $tBoot = & $stamp 'Boot sequence finished'
  $tCrash = & $stamp 'FATAL ENGINE CRASH'
  $bootToCrash = if ($tBoot -and $tCrash) { [math]::Round(($tCrash - $tBoot).TotalSeconds, 1) } else { $null }
  $upAfterBoot = if ($doneAt -and -not $crashed) { [int]($sw.Elapsed.TotalSeconds - $doneAt) } else { $null }
  $gameExits = @([regex]::Matches("$(Get-Content -LiteralPath $procFile -Raw)", 'rigStop StarRuptureGam\S* pid=\d+ exit=(0x[0-9A-F]+)') | ForEach-Object { $_.Groups[1].Value })
  $summary = [ordered]@{
    bootFinishedSec = $(if ($doneAt) { [int]$doneAt } else { $null }); crashSec = $(if ($crashAt) { [int]$crashAt } else { $null }); fatalCrash = $crashed; steamErrorDialog = $stubError
    crashDialog = ("$(Get-Content -LiteralPath $winFile -Raw)") -match 'The game has crashed'; killedByRig = $alive; gameExitCodes = $gameExits
    bootToCrashSec = $bootToCrash; upAfterBootSec = $upAfterBoot
    errorLines = @($mlLines -match '\[ERROR\]').Count; lastLogLine = $(if ($mlLines.Count) { $mlLines[-1] } else { '' })
    attempt = $label; seconds = [int]$sw.Elapsed.TotalSeconds; launch = "$launchInfo"; sawGameProcess = $sawGame; gameAliveAtEnd = $alive
    peakWorkingSetMb = [int]$peakMb; stages = $reached; stubExit35 = $stubExit; success = $ok; engineLogs = @($engine | ForEach-Object { "$($_.Name) $($_.Length)" })
    crashFiles = $crashes; activeProcessValueNames = @($regNames.Keys); activeUser = $(if (Test-ActiveUser) { 'present, non-zero' } else { 'absent or zero' })
  }
  Set-Content -LiteralPath (Join-Path $dir 'summary.json') -Value (Scrub ($summary | ConvertTo-Json -Depth 4)) -Encoding utf8
  Say "Attempt $label stages: $($reached -join ', '); exit 0x35: $stubExit; success: $ok; fatal crash: $crashed; killed by the rig: $alive; exits: $($gameExits -join ' ')"
  ($mlText -split "`r?`n") | Where-Object { $_ -match 'Plugin info - |InitAllLoadedPlugins|Plugin startup phase complete|Boot sequence finished' } | ForEach-Object { Say $_ }
  Say "Attempt $label last log line: $($mlLines | Select-Object -Last 1 | ForEach-Object { $_.Substring(0, [math]::Min(300, $_.Length)) })"
  Say "Attempt $label timing: boot finished at $(if ($doneAt) { [int]$doneAt } else { 'never' }) s; boot to crash by the log: $(if ($null -ne $bootToCrash) { "$bootToCrash s" } else { 'no crash' }); up after boot without a crash: $(if ($null -ne $upAfterBoot) { "$upAfterBoot s" } else { 'n/a' }); crash dialog: $($summary.crashDialog); [ERROR] lines: $($summary.errorLines)"
  # The crash block, if any, with its frames.
  $blk = @($mlLines | Where-Object { $_ -match 'PluginGuard|CrashReporter|^\s+#\d+ |Fault addr' } | Select-Object -First 45)
  foreach ($b in $blk) { Say ("  | " + $b.Substring(0, [math]::Min(300, $b.Length))) }
  Say-ClientFacts "attempt $label"
  $script:last = [pscustomobject]@{ ok = $ok; crashed = $crashed; stubError = $stubError }
}

function Launch-Game([string]$route, [string]$line) {
  switch ($route) {
    'direct' { Start-Process -FilePath $script:exe -ArgumentList $line -WorkingDirectory $script:bin | Out-Null }
    'appid' {
      Set-Content -LiteralPath (Join-Path $script:bin 'steam_appid.txt') -Value $appId -Encoding ascii -NoNewline
      $env:SteamAppId = $appId
      try { Start-Process -FilePath $script:exe -ArgumentList $line -WorkingDirectory $script:bin | Out-Null } finally { Remove-Item Env:SteamAppId }
    }
    'applaunch' { Start-Process -FilePath $steamExe -ArgumentList "-applaunch $appId $line" -WorkingDirectory $steamDir | Out-Null }
  }
  "$route $line"
}

# The moves are renames on one volume, so nothing is copied or downloaded.
function Set-SteamLibrary {
  Stop-Steam
  $lib = (Split-Path $Install -Qualifier) + '\sr-lib'
  $acf = Join-Path $Install "steamapps\appmanifest_$appId.acf"
  $acfText = Get-Content -LiteralPath $acf -Raw
  if ($acfText -notmatch '"installdir"\s+"([^"]+)"') { throw 'The app manifest names no installdir' }
  $target = Join-Path $lib "steamapps\common\$($Matches[1])"
  $size = if ($acfText -match '"SizeOnDisk"\s+"(\d+)"') { [long]$Matches[1] } else { 0 }
  New-Item -ItemType Directory -Force $lib | Out-Null
  Move-Item -LiteralPath (Join-Path $Install 'steamapps') -Destination (Join-Path $lib 'steamapps')
  New-Item -ItemType Directory -Force (Join-Path $lib 'steamapps\common') | Out-Null
  Move-Item -LiteralPath $Install -Destination $target
  Set-GamePaths $target
  New-NetFirewallRule -DisplayName 'rig-spike-block-updater-2' -Direction Outbound -Action Block -Program (Join-Path $script:mlDir 'StarRupture-ModLoader-Updater.exe') | Out-Null
  Set-Content -LiteralPath (Join-Path $lib 'libraryfolder.vdf') -Value "`"libraryfolder`"`n{`n`"contentid`" `"0`"`n`"label`" `"`"`n}`n" -Encoding ascii -NoNewline
  foreach ($vdf in (Join-Path $steamDir 'steamapps\libraryfolders.vdf'), (Join-Path $steamDir 'config\libraryfolders.vdf')) {
    New-Item -ItemType Directory -Force (Split-Path $vdf) | Out-Null
    $old = if (Test-Path -LiteralPath $vdf) { Get-Content -LiteralPath $vdf -Raw } else { '' }
    Set-Content -LiteralPath $vdf -Value (Add-LibraryEntry "$old" $lib $appId $size) -Encoding ascii -NoNewline
  }
  Say "Install is now a Steam library, app manifest present: $(Test-Path -LiteralPath (Join-Path $lib "steamapps\appmanifest_$appId.acf"))"
}

function Set-Ini([bool]$uiOff, [string]$level = 'INFO') {
  $ini = "[AutoUpdate]`r`nEnabled=0`r`n[Logging]`r`nLevel=$level`r`n"
  if ($uiOff) { $ini += "[UI]`r`nEnabled=0`r`n" }
  Set-Content -LiteralPath (Join-Path $script:mlDir 'modloader.ini') -Value $ini -Encoding ascii -NoNewline
}

# The released Codex, ProductionViewer and WAILA DLLs are kept aside; each attempt
# gets the set it names: released or fixall (all three fixed). The fix DLLs come
# from the fixes job's artifacts.
$script:released = @{}
$script:swapped = 'Codex', 'ProductionViewer', 'Waila'
function Stash-Released {
  $dir = Join-Path $env:RUNNER_TEMP 'released'
  New-Item -ItemType Directory -Force $dir | Out-Null
  foreach ($n in $script:swapped) {
    $f = @(Get-ChildItem -LiteralPath (Join-Path $script:mlDir 'Plugins') -Filter "*$n*.dll")
    if ($f.Count -ne 1) { throw "Expected one $n DLL, found $($f.Count)" }
    Copy-Item -LiteralPath $f[0].FullName -Destination (Join-Path $dir $f[0].Name)
    $script:released[$n] = [pscustomobject]@{ name = $f[0].Name; stash = (Join-Path $dir $f[0].Name) }
  }
}

function Set-PluginSet([string]$set) {
  $plugins = Join-Path $script:mlDir 'Plugins'
  foreach ($n in $script:swapped) {
    $r = $script:released[$n]
    $dest = Join-Path $plugins $r.name
    $fix = ($set -eq 'fixall')
    $src = $r.stash
    if ($fix) {
      $f = @(Get-ChildItem -LiteralPath (Join-Path $FixDir "fix-$n") -Filter *.dll -ErrorAction SilentlyContinue)
      if ($f.Count -ne 1) { throw "Expected one fixed $n DLL under $FixDir, found $($f.Count)" }
      $src = $f[0].FullName
      Say ("Fix build of ${n}: " + (Get-Content -LiteralPath (Join-Path $FixDir "fix-$n\build.json") -Raw) -replace '\s+', ' ')
    }
    Copy-Item -LiteralPath $src -Destination $dest -Force
    Say ("Plugin set ${set}: $n is the {0} DLL, sha256 {1}" -f $(if ($fix) { 'FIX' } else { 'released' }), (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant())
  }
}

# Steam must be stopped first: one account, one session.
function Test-LoginAfter {
  Say 'Final check: does the saved login still work in steamcmd?'
  $cfg = Join-Path $root 'config\config.vdf'
  New-Item -ItemType Directory -Force (Split-Path $cfg) | Out-Null
  [IO.File]::WriteAllBytes($cfg, $cacheBytes)
  Remove-Item -LiteralPath (Join-Path $root 'logs') -Recurse -Force -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $steamcmd -ArgumentList "+@ShutdownOnFailedCommand 1 +@NoPromptForPassword 1 +login $user +quit" -WorkingDirectory $root -WindowStyle Hidden -PassThru
  $done = $p.WaitForExit(240000)
  if (-not $done) { $p.Kill() }
  $log = Join-Path $root 'logs\console_log.txt'
  $text = if (Test-Path -LiteralPath $log) { Read-Shared $log } else { '' }
  $ok = $text -match 'Waiting for user info\.\.\.\s*(\[[^\]]+\]\s*)?OK'
  Say "Saved login after the client ran: accepted by steamcmd: $ok; exited in time: $done"
  ($text -split "`r?`n") | Where-Object { $_ -match '(?i)Logging in|FAILED|Expired|Denied|Invalid|Waiting for user' } | Select-Object -Last 10 | ForEach-Object { Say "steamcmd: $_" }
  Remove-Item -LiteralPath $cfg -Force -ErrorAction SilentlyContinue
}

$verdict = 'no definite result'
$clientRan = $false
try {
  # IDs from the install's login, for the scrub and the leak gate. steamcmd has exited.
  $install0 = Join-Path $root 'logs\console_log.txt'
  $id32 = if ((Test-Path -LiteralPath $install0) -and ((Read-Shared $install0) -match '\[U:1:(\d+)\]')) { $Matches[1] } else { '' }
  $script:id64 = if ($cacheText -match '"SteamID"\s+"(7656119\d{10})"') { $Matches[1] } elseif ($id32) { "$(76561197960265728L + [long]$id32)" } else { '' }
  if (-not $id32 -and $script:id64) { $id32 = "$([long]$script:id64 - 76561197960265728L)" }
  Add-Secret $id32 -Gate
  Add-Secret $script:id64
  Say "SteamID known: $([bool]$script:id64)"
  Get-Process steamcmd -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $root 'config') -Recurse -Force -ErrorAction SilentlyContinue

  Install-SteamClient
  $clientRan = $true
  Invoke-Bootstrap
  Stop-Steam
  $hashBefore = $null
  $script:loginResult = 'nothing'
  foreach ($level in 2, 3) {
    Write-ClientLogin $level
    $hashBefore = (Get-FileHash (Join-Path $steamDir 'config\config.vdf')).Hash
    Say "Login level $level given to the client"
    Start-Steam
    Wait-ClientLogin "level-$level"
    if ($script:loginResult -in 'live', 'guard', 'denied') { break }
    Stop-Steam
  }
  Say ("Client's config.vdf after the login: {0}" -f $(if ((Get-FileHash (Join-Path $steamDir 'config\config.vdf')).Hash -ne $hashBefore) { 'rewritten by the client' } else { 'unchanged' }))
  Say "Bootstrap reached a running webhelper: $($script:bootOk); login result: $($script:loginResult)"

  if ($script:loginResult -ne 'live') {
    $verdict = "not portable or no login: $($script:loginResult)"
  } else {
    # The first launch of earlier runs hit a Steam Error dialog; a relaunch passed.
    Say 'Letting the client settle for 90 s after sign-in'
    Start-Sleep -Seconds 90
    Stash-Released
    $results = @()
    foreach ($p in @(
        @{ label = 'CONTROL-A'; line = $GameArgs; set = 'released'; plugins = 9 },
        @{ label = 'FIX-ALL-1'; line = $GameArgs; set = 'fixall';   plugins = 9 },
        @{ label = 'FIX-ALL-2'; line = $GameArgs; set = 'fixall';   plugins = 9 },
        @{ label = 'CONTROL-B'; line = $GameArgs; set = 'released'; plugins = 9 })) {
      if ((Get-Date) -gt $deadline -or $script:downloadTripped -or -not (Test-ActiveUser)) { Say "Stopping before attempt $($p.label): client signed in: $(Test-ActiveUser)"; break }
      Set-Ini $false 'INFO'
      Set-PluginSet $p.set
      # A Steam Error dialog means the game never started; relaunch the same attempt.
      for ($try = 0; $try -lt 3; $try++) {
        $name = if ($try) { "$($p.label)-retry$try" } else { $p.label }
        Run-Attempt $name 'appid' $p.line 240 $p.plugins
        $results += "${name}: loaded $($script:last.ok), crashed $($script:last.crashed), Steam Error $($script:last.stubError)"
        if (-not $script:last.stubError) { break }
        Start-Sleep -Seconds $(if ($try) { 120 } else { 5 })
      }
    }
    $verdict = $results -join '; '
  }
} catch {
  Say "Script error: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"
} finally {
  if ($clientRan) { Say-ClientFacts 'end'; Stop-Steam; Save-ConnectionExcerpt }
  try { Test-LoginAfter } catch { Say "Final login check failed to run: $($_.Exception.Message)" }
  $cacheBytes = $null; $cacheText = $null
}
Say "Verdict: $verdict"
exit 0
