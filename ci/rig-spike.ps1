# Spike: can a hosted runner launch the client far enough for plugins to load?
# Reads the login from STEAM_USER / STEAM_CACHE, then clears both from the
# environment, so no launched process inherits them. Decides nothing: it
# records what each attempt did under -OutDir. Everything written or printed
# goes through Scrub. -Check only exercises the helpers, with no login.
param(
  [string]$Install,
  [string]$OutDir = 'out',
  [string[]]$Attempts = @('A', 'B', 'C'),
  [string]$GameArgs = '-nullrhi -unattended -nosound -log',
  [int]$CapSec = 300,
  [int]$SettleSec = 30,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

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

public class RigPump {
  public Process P;
  public ConcurrentQueue<string> Q = new ConcurrentQueue<string>();
  void Read(StreamReader r) {
    var b = new char[4096]; int n;
    while ((n = r.Read(b, 0, b.Length)) > 0) Q.Enqueue(new string(b, 0, n));
  }
  public RigPump(string exe, string args, string cwd) {
    var i = new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = cwd,
      RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
    P = Process.Start(i);
    var so = P.StandardOutput; var se = P.StandardError;
    new Thread(() => Read(so)) { IsBackground = true }.Start();
    new Thread(() => Read(se)) { IsBackground = true }.Start();
  }
  public void Send(string line) { P.StandardInput.WriteLine(line); P.StandardInput.Flush(); }
}
'@

if ($Check) {
  "Windows visible to this session: $(@([RigWin]::Snapshot()).Count)"
  $p = [RigPump]::new("$env:ComSpec", '', "$env:TEMP")
  $p.Send('echo rig-pump-ok'); $p.Send('exit')
  [void]$p.P.WaitForExit(10000)
  Start-Sleep -Seconds 1
  $text = ''; $chunk = $null
  while ($p.Q.TryDequeue([ref]$chunk)) { $text += $chunk }
  if ($text -notmatch 'rig-pump-ok') { throw 'The stdin/stdout pump did not round-trip' }
  Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier rigCheck | Out-Null
  Start-Process -FilePath "$env:ComSpec" -ArgumentList '/c', 'exit' -WindowStyle Hidden -Wait
  Start-Sleep -Seconds 3
  "Process trace events: $(@(Get-Event -SourceIdentifier rigCheck -ErrorAction SilentlyContinue).Count)"
  Unregister-Event -SourceIdentifier rigCheck
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
$secrets = @($user)
foreach ($m in [regex]::Matches([Text.Encoding]::UTF8.GetString($cacheBytes), '"[^"\r\n]*"[ \t]+"([^"\r\n]{16,})"')) {
  Write-Host "::add-mask::$($m.Groups[1].Value)"
  $secrets += $m.Groups[1].Value
}
$secretRx = '(?i)' + (($secrets | ForEach-Object { [regex]::Escape($_) }) -join '|')

function Scrub([string]$s) {
  $s -replace '\[U:1:\d+\]', '[U:1:***]' -replace '7656119\d{10}', '***' -replace $secretRx, '***'
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$runLog = Join-Path $OutDir 'run.log'
function Say([string]$s) {
  $l = Scrub ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $s)
  Write-Host $l
  Add-Content -LiteralPath $runLog -Value $l
}

$exeName = 'StarRuptureGameSteam-Win64-Shipping.exe'
$exe = (Get-ChildItem -LiteralPath $Install -Recurse -Filter $exeName | Select-Object -First 1).FullName
$bin = Split-Path $exe
$mlLogs = Join-Path $bin 'ModLoader\Logs'
$gameRoot = (Get-Item $bin).Parent.Parent.FullName
$engineDirs = @((Join-Path $gameRoot 'Saved\Logs'), (Join-Path $env:LOCALAPPDATA 'StarRupture\Saved\Logs'))
$crashDirs = @((Join-Path $gameRoot 'Saved\Crashes'), (Join-Path $env:LOCALAPPDATA 'StarRupture\Saved\Crashes'))
$root = 'C:\steamcmd'
$steamcmd = Join-Path $root 'steamcmd.exe'
$cfg = Join-Path $root 'config\config.vdf'
$gameRx = '^(StarRupture|UnrealCEF|CrashReport|steamerrorreporter|steam$|steamwebhelper|WerFault)'

Say ("Session {0}, UserInteractive {1}, CPUs {2}, video: {3}" -f [Diagnostics.Process]::GetCurrentProcess().SessionId, [Environment]::UserInteractive, [Environment]::ProcessorCount, ((Get-CimInstance Win32_VideoController | ForEach-Object Name) -join '; '))

# The login session, held open by a stdin pipe that is never closed.
$script:sc = $null
$script:scBuf = ''
$script:scAll = [Text.StringBuilder]::new()
$scLog = Join-Path $OutDir 'steamcmd-session.log'
$script:cfgEvents = 0

function Pump-Steamcmd {
  if (-not $script:sc) { return }
  $chunk = $null
  while ($script:sc.Q.TryDequeue([ref]$chunk)) { $script:scBuf += $chunk }
  # Only whole lines are scrubbed and kept: a name is never split over two.
  while (($i = $script:scBuf.IndexOf("`n")) -ge 0) {
    $line = Scrub ($script:scBuf.Substring(0, $i).TrimEnd("`r"))
    $script:scBuf = $script:scBuf.Substring($i + 1)
    Add-Content -LiteralPath $scLog -Value ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $line)
    [void]$script:scAll.AppendLine($line)
  }
}

function Watch-Config([string]$when) {
  if (Test-Path -LiteralPath $cfg) {
    $script:cfgEvents++
    Say "config.vdf present on disk ($when): deleting, occurrence $($script:cfgEvents)"
    Remove-Item -LiteralPath $cfg -Force
  }
}

function Steamcmd-Alive { [bool]($script:sc -and -not $script:sc.P.HasExited) }

function Start-Login([string]$thenRun = '') {
  if (Steamcmd-Alive) { return $true }
  New-Item -ItemType Directory -Force (Split-Path $cfg) | Out-Null
  [IO.File]::WriteAllBytes($cfg, $cacheBytes)
  $script:scBuf = ''
  [void]$script:scAll.Clear()
  # steamcmd's own logs show the login when its piped output lags. Old ones would match falsely.
  Remove-Item -LiteralPath (Join-Path $root 'logs') -Recurse -Force -ErrorAction SilentlyContinue
  Add-Content -LiteralPath $scLog -Value "--- login $(Get-Date -Format HH:mm:ss)"
  $scArgs = "+@ShutdownOnFailedCommand 0 +@NoPromptForPassword 1 +force_install_dir `"$Install`" +login $user $thenRun"
  $script:sc = [RigPump]::new($steamcmd, $scArgs, $root)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $ok = $false
  while ($sw.Elapsed.TotalSeconds -lt 360) {
    Start-Sleep -Seconds 2
    Pump-Steamcmd
    $t = $script:scAll.ToString()
    if ($t -match 'Waiting for user info\.\.\.OK') { $ok = $true; break }
    if ((Read-SteamLog 'connection_log.txt') -match '(?i)Logged On|LogOnResponse.*OK') { $ok = $true; break }
    if ($t -match 'Login Failure|Logon Denied|Rate Limit|Invalid Password|FAILED \(') { break }
    if ($script:sc.P.HasExited) { break }
  }
  Say "Login accepted: $ok after $([int]$sw.Elapsed.TotalSeconds) s; steamcmd alive: $(Steamcmd-Alive)"
  # Whether it succeeded or not, the cache leaves the disk before any launch.
  if (Test-Path -LiteralPath $cfg) { Remove-Item -LiteralPath $cfg -Force; Say 'config.vdf deleted after the login' }
  return $ok
}

function Read-SteamLog([string]$name) {
  $p = Join-Path $root "logs\$name"
  if (Test-Path -LiteralPath $p) { Read-Shared $p } else { '' }
}

function Read-Shared([string]$path) {
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite,Delete')
  try { (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
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

function Run-Attempt([string]$label, [scriptblock]$launch) {
  $dir = Join-Path $OutDir "attempt-$label"
  New-Item -ItemType Directory -Force $dir | Out-Null
  Say "=== Attempt $label"
  if (Test-Path -LiteralPath $mlLogs) { Get-ChildItem -LiteralPath $mlLogs -File | Remove-Item -Force -ErrorAction SilentlyContinue }
  foreach ($d in $engineDirs + $crashDirs) {
    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $seenWin = @{}
  foreach ($w in [RigWin]::Snapshot()) { $seenWin[$w] = $true }
  $procFile = Join-Path $dir 'processes.txt'
  $winFile = Join-Path $dir 'windows.txt'
  New-Item -ItemType File -Force $procFile, $winFile | Out-Null
  Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier rigStart | Out-Null
  Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace -SourceIdentifier rigStop | Out-Null

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $peakMb = 0.0
  $regNames = @{}
  $doneAt = $null
  $sawGame = $false
  $goneAt = $null
  $launchInfo = & $launch
  # B waits out the validate, then gives the launch two minutes.
  $cap = if ($label -eq 'B') { 900 } else { $CapSec }
  $noGameCap = if ($label -eq 'B') { 900 } else { 60 }
  $validated = $label -ne 'B'

  while ($sw.Elapsed.TotalSeconds -lt $cap) {
    Start-Sleep -Seconds 2
    Pump-Steamcmd
    if (-not $validated -and (Read-SteamLog 'console_log.txt') -match 'Success! App|Error! App') {
      $validated = $true
      $noGameCap = $sw.Elapsed.TotalSeconds + 120
      $cap = [math]::Min($cap, $sw.Elapsed.TotalSeconds + $CapSec)
      Say "Validate finished at $([int]$sw.Elapsed.TotalSeconds) s; config.vdf on disk now: $(Test-Path -LiteralPath $cfg)"
    }
    Watch-Config "during attempt $label"
    Write-TraceEvents $procFile ([int]$sw.Elapsed.TotalSeconds)
    foreach ($w in [RigWin]::Snapshot()) {
      if (-not $seenWin.ContainsKey($w)) {
        $seenWin[$w] = $true
        Add-Content -LiteralPath $winFile -Value (Scrub ("{0,5}s {1}" -f [int]$sw.Elapsed.TotalSeconds, $w))
      }
    }
    # Value names only, never values.
    $reg = Get-Item 'HKCU:\Software\Valve\Steam\ActiveProcess' -ErrorAction SilentlyContinue
    if ($reg) { foreach ($v in $reg.Property) { $regNames[$v] = $true }; $regNames['(key present)'] = $true }

    $game = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'StarRupture*' })
    if ($game.Count) {
      $sawGame = $true; $goneAt = $null
      foreach ($g in $game) { try { $peakMb = [math]::Max($peakMb, $g.PeakWorkingSet64 / 1MB) } catch {} }
    } elseif ($sawGame -and -not $goneAt) { $goneAt = $sw.Elapsed.TotalSeconds }
    if ($goneAt -and ($sw.Elapsed.TotalSeconds - $goneAt) -ge 20) { Say 'Game processes gone for 20 s'; break }
    if (-not $sawGame -and $sw.Elapsed.TotalSeconds -ge $noGameCap) { Say "No game process seen after $noGameCap s"; break }

    $ml = Join-Path $mlLogs 'ModLoader.log'
    if (-not $doneAt -and (Test-Path -LiteralPath $ml) -and ((Read-Shared $ml) -match 'Boot sequence finished|Plugin startup phase complete')) {
      $doneAt = $sw.Elapsed.TotalSeconds
      Say "Plugin startup seen at $([int]$doneAt) s; settling $SettleSec s"
    }
    if ($doneAt -and ($sw.Elapsed.TotalSeconds - $doneAt) -ge $SettleSec) { break }
  }
  $alive = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'StarRupture*' }).Count -gt 0
  Say "Attempt $label loop ended at $([int]$sw.Elapsed.TotalSeconds) s; game alive: $alive"
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match $gameRx } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
  Pump-Steamcmd
  Write-TraceEvents $procFile ([int]$sw.Elapsed.TotalSeconds)
  Unregister-Event -SourceIdentifier rigStart -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier rigStop -ErrorAction SilentlyContinue

  # Loader logs, scrubbed.
  foreach ($f in 'Proxy.log', 'AutoUpdate.log', 'ModLoader.log') {
    $p = Join-Path $mlLogs $f
    if (Test-Path -LiteralPath $p) { Set-Content -LiteralPath (Join-Path $dir $f) -Value (Scrub (Read-Shared $p)) -Encoding utf8 }
  }
  $reached = @()
  foreach ($s in $stages) {
    $p = Join-Path $mlLogs $s[1]
    if ((Test-Path -LiteralPath $p) -and ((Read-Shared $p) -cmatch $s[2])) { $reached += $s[0] }
  }
  # The engine log itself never leaves the runner: matching lines only.
  $engine = @()
  foreach ($d in $engineDirs) {
    if (Test-Path -LiteralPath $d) { $engine += @(Get-ChildItem -LiteralPath $d -Filter *.log) }
  }
  $matchFile = Join-Path $dir 'engine-matches.txt'
  foreach ($l in $engine) {
    Add-Content -LiteralPath $matchFile -Value (Scrub "--- $($l.Name), $($l.Length) bytes")
    (Read-Shared $l.FullName) -split "`r?`n" | Where-Object { $_ -match '(?i)RHI|fatal|error|steam' } | Select-Object -First 500 | ForEach-Object {
      Add-Content -LiteralPath $matchFile -Value (Scrub ($_.Substring(0, [math]::Min(400, $_.Length))))
    }
  }
  # Crash folders: names only.
  $crashes = @()
  foreach ($d in $crashDirs) {
    if (Test-Path -LiteralPath $d) { $crashes += @(Get-ChildItem -LiteralPath $d -Recurse -File | ForEach-Object { $_.Name }) }
  }
  $summary = [ordered]@{
    attempt = $label; seconds = [int]$sw.Elapsed.TotalSeconds; launch = "$launchInfo"; sawGameProcess = $sawGame; gameAliveAtEnd = $alive
    peakWorkingSetMb = [int]$peakMb; stages = $reached; engineLogs = @($engine | ForEach-Object { "$($_.Name) $($_.Length)" })
    crashFiles = $crashes; activeProcessValueNames = @($regNames.Keys); steamcmdAlive = (Steamcmd-Alive)
    configVdfDeletions = $script:cfgEvents
  }
  Set-Content -LiteralPath (Join-Path $dir 'summary.json') -Value (Scrub ($summary | ConvertTo-Json -Depth 4)) -Encoding utf8
  Say "Attempt $label stages: $($reached -join ', ')"
  return ($reached -contains 'plugin-dll-loaded')
}

function Launch-Direct {
  Start-Process -FilePath $exe -ArgumentList $GameArgs -WorkingDirectory $bin | Out-Null
  'direct'
}

function Launch-WithAppId {
  $env:SteamAppId = '1631270'
  try { Launch-Direct } finally { Remove-Item Env:SteamAppId }
}

$hit = $false
try {
  foreach ($a in $Attempts) {
    if ($hit) { break }
    switch ($a) {
      'A' { Watch-Config 'before A'; $hit = Run-Attempt 'A' { Launch-Direct } | Select-Object -Last 1 }
      'B' {
        # steamcmd does not read a piped stdin, so its commands go on the
        # command line. The validate runs for minutes, which is what leaves
        # the login cache deleted well before app_run fires.
        $then = "+find app_ +app_status 1631270 +app_update 1631270 -beta public validate +app_run 1631270 $GameArgs +app_launch 1631270 $GameArgs"
        if ((Start-Login $then) -or (Steamcmd-Alive)) { Watch-Config 'after the B login'; $hit = Run-Attempt 'B' { 'steamcmd command line' } | Select-Object -Last 1 } else { Say 'B skipped: steamcmd is gone' }
      }
      'E' {
        if ((Start-Login) -or (Steamcmd-Alive)) {
          Start-Sleep -Seconds 10; Watch-Config 'before E'
          Set-Content -LiteralPath (Join-Path $bin 'steam_appid.txt') -Value '1631270' -Encoding ascii -NoNewline
          $hit = Run-Attempt 'E' { Launch-Direct } | Select-Object -Last 1
        } else { Say 'E skipped: steamcmd is gone' }
      }
      'C' {
        if ((Start-Login) -or (Steamcmd-Alive)) { Start-Sleep -Seconds 10; Watch-Config 'before C'; $hit = Run-Attempt 'C' { Launch-Direct } | Select-Object -Last 1 } else { Say 'C skipped: steamcmd is gone' }
      }
      'D' {
        if ((Start-Login) -or (Steamcmd-Alive)) { Start-Sleep -Seconds 10; Watch-Config 'before D'; $hit = Run-Attempt 'D' { Launch-WithAppId } | Select-Object -Last 1 } else { Say 'D skipped: steamcmd is gone' }
      }
      default { Say "Unknown attempt $a" }
    }
  }
} catch {
  Say "Script error: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"
} finally {
  Pump-Steamcmd
  if (Steamcmd-Alive) { $script:sc.P.Kill(); [void]$script:sc.P.WaitForExit(30000) }
  Pump-Steamcmd
  if ($script:scBuf) { Add-Content -LiteralPath $scLog -Value (Scrub $script:scBuf) }
  (Read-SteamLog 'console_log.txt') -split "`r?`n" | Where-Object { $_ -notmatch 'progress:' } | Select-Object -First 1000 | ForEach-Object { Add-Content -LiteralPath (Join-Path $OutDir 'steamcmd-console_log.txt') -Value (Scrub $_) }
  (Read-SteamLog 'connection_log.txt') -split "`r?`n" | Where-Object { $_ -match '(?i)Logged|LogOn' } | Select-Object -First 40 | ForEach-Object { Add-Content -LiteralPath (Join-Path $OutDir 'steamcmd-connection_log.txt') -Value (Scrub ($_.Substring(0, [math]::Min(200, $_.Length)))) }
  Say "config.vdf on disk after steamcmd exit: $(Test-Path -LiteralPath $cfg); deletions during the attempts: $($script:cfgEvents)"
  $cacheBytes = $null
}
Say "Plugin load reached: $hit"
"plugin_load=$hit" >> $env:GITHUB_OUTPUT
exit 0
