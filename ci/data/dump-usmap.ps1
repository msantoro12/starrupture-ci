# The payload of the data-extract launch: inject Dumper-7 into the running game, wait for
# the .usmap it writes, and leave a copy under <OutDir>/usmap. Run by
# ci/client-rig-launch.ps1 -PayloadScript, once the game process exists (as a background
# job of the launch, so the launch keeps watching for Steam's load error and for crashes).
#
# Why an injector of our own: the dump needs Dumper-7 in the game process and nothing else.
# No mod loader, no plugin, no third-party injector binary: a 30-line LoadLibraryW
# injector (CreateRemoteThread) compiled here, injecting the one DLL the workflow built from
# the pinned Dumper-7 source. It refuses an install that holds a loader proxy.
#
#   -GamePid         the game's process id
#   -Bin             the game's Win64 folder (the game's working directory: Dumper-7.ini goes here)
#   -OutDir          where usmap/<name>.usmap is written
#   -DllPath         the Dumper-7.dll built by the workflow (default: $env:DUMPER_DLL)
#   -InjectDelaySec  wait after the process appears before injecting (engine init, DRM stub)
#   -SleepTimeoutSec Dumper-7's own delay between injection and the dump (its SleepTimeout)
#   -TimeoutSec      longest the whole payload may take
#   -Check           compile the injector and test the helpers; no game needed
[CmdletBinding()]
param(
    [int]$GamePid = 0,
    [string]$Bin = '',
    [string]$OutDir = 'out',
    [string]$DllPath = $env:DUMPER_DLL,
    [int]$InjectDelaySec = 45,
    [int]$SleepTimeoutSec = 120,
    [int]$TimeoutSec = 780,
    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SrInject {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr VirtualAllocEx(IntPtr h, IntPtr addr, UIntPtr size, uint type, uint prot);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteProcessMemory(IntPtr h, IntPtr addr, byte[] buf, UIntPtr size, out UIntPtr written);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool VirtualFreeEx(IntPtr h, IntPtr addr, UIntPtr size, uint type);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr GetModuleHandleW(string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true)] static extern IntPtr GetProcAddress(IntPtr mod, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateRemoteThread(IntPtr h, IntPtr attr, UIntPtr stack, IntPtr start, IntPtr param, uint flags, out uint tid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeThread(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  // Loads `dll` into process `pid` by running LoadLibraryW there. Returns "" on success, else why not.
  public static string Inject(int pid, string dll) {
    // CREATE_THREAD | QUERY_INFORMATION | VM_OPERATION | VM_WRITE | VM_READ
    IntPtr proc = OpenProcess(0x2 | 0x400 | 0x8 | 0x20 | 0x10, false, pid);
    if (proc == IntPtr.Zero) return "OpenProcess failed (" + Marshal.GetLastWin32Error() + ")";
    IntPtr mem = IntPtr.Zero, thread = IntPtr.Zero;
    try {
      byte[] path = System.Text.Encoding.Unicode.GetBytes(dll + "\0");
      mem = VirtualAllocEx(proc, IntPtr.Zero, (UIntPtr)path.Length, 0x3000, 0x04);
      if (mem == IntPtr.Zero) return "VirtualAllocEx failed (" + Marshal.GetLastWin32Error() + ")";
      UIntPtr written;
      if (!WriteProcessMemory(proc, mem, path, (UIntPtr)path.Length, out written) || (int)written != path.Length) return "WriteProcessMemory failed (" + Marshal.GetLastWin32Error() + ")";
      IntPtr load = GetProcAddress(GetModuleHandleW("kernel32.dll"), "LoadLibraryW");
      if (load == IntPtr.Zero) return "LoadLibraryW not found";
      uint tid;
      thread = CreateRemoteThread(proc, IntPtr.Zero, UIntPtr.Zero, load, mem, 0, out tid);
      if (thread == IntPtr.Zero) return "CreateRemoteThread failed (" + Marshal.GetLastWin32Error() + ")";
      if (WaitForSingleObject(thread, 60000) != 0) return "LoadLibraryW did not return in 60 s";
      uint code;
      // The thread's exit code is the low half of the module handle: 0 means the DLL did not load.
      if (!GetExitCodeThread(thread, out code) || code == 0) return "LoadLibraryW returned 0 (the DLL did not load)";
      return "";
    } finally {
      if (thread != IntPtr.Zero) CloseHandle(thread);
      if (mem != IntPtr.Zero) VirtualFreeEx(proc, mem, UIntPtr.Zero, 0x8000);
      CloseHandle(proc);
    }
  }
}
'@

# ---- helpers (also run by -Check) -----------------------------------------------------

# Dumper-7.ini, read from the game's working directory by Dumper-7 (Settings::Config::Load).
# SleepTimeout is in seconds when under 1000; DumpKey 0 means no key press; ShouldAutoUnload
# lets it leave the process when done. Paths use / and stay under 256 characters (its buffer).
function New-DumperIni([string]$SdkPath, [string]$LogPath, [int]$SleepSec) {
    foreach ($p in $SdkPath, $LogPath) { if ($p.Length -ge 240) { throw "path too long for Dumper-7.ini: $p" } }
    "[Settings]`r`nSDKGenerationPath=$($SdkPath -replace '\\', '/')`r`nSleepTimeout=$SleepSec`r`nDumpKey=0`r`nShouldAutoUnload=1`r`nLogFilePath=$($LogPath -replace '\\', '/')`r`n"
}

# The .usmap Dumper-7 wrote under its output folder (<folder>/<game>/Mappings/<name>.usmap).
function Find-Usmap([string]$Dir) {
    @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Filter '*.usmap' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending) | Select-Object -First 1
}

function Read-Shared([string]$path) {
    $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite,Delete')
    try { (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
}

if ($Check) {
    $ini = New-DumperIni 'D:\a\x\out\dumper' 'D:\a\x\out\dumper.log' 120
    foreach ($want in '[Settings]', 'SDKGenerationPath=D:/a/x/out/dumper', 'SleepTimeout=120', 'DumpKey=0', 'ShouldAutoUnload=1', 'LogFilePath=D:/a/x/out/dumper.log') {
        if ($ini -notmatch [regex]::Escape($want)) { throw "the ini lacks $want" }
    }
    $threw = $false
    try { New-DumperIni ('D:\' + ('x' * 250)) 'a' 1 | Out-Null } catch { $threw = $true }
    if (-not $threw) { throw 'a path over the ini buffer was accepted' }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("dump-check-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Force (Join-Path $tmp 'g\Mappings') | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $tmp 'g\Mappings\5.6.1-1+++Earth20+Neon-StarRupture.usmap'), [byte[]](1, 2, 3))
    Set-Content (Join-Path $tmp 'g\other.txt') 'x'
    $u = Find-Usmap $tmp
    Remove-Item -LiteralPath $tmp -Recurse -Force
    if (-not $u -or $u.Name -notlike '*.usmap') { throw 'the usmap was not found' }
    # A process that does not exist: the injector must say so, not throw.
    $r = [SrInject]::Inject(2147483000, 'C:\nope.dll')
    if ($r -notlike 'OpenProcess failed*') { throw "the injector answered '$r' for a missing process" }
    'Check passed.'
    exit 0
}

# ---- the payload ---------------------------------------------------------------------------
if ($GamePid -le 0 -or -not $Bin) { throw '-GamePid and -Bin are required' }
if (-not $DllPath -or -not (Test-Path -LiteralPath $DllPath)) { throw "Dumper-7.dll not found ($DllPath)" }
$DllPath = (Resolve-Path -LiteralPath $DllPath).Path
$Bin = (Resolve-Path -LiteralPath $Bin).Path
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

# This job injects one DLL and nothing else: an install holding a loader proxy is refused.
if (Test-Path -LiteralPath (Join-Path $Bin 'dwmapi.dll')) { throw 'the install has a dwmapi.dll (a loader proxy); only Dumper-7 may be injected' }
if (Test-Path -LiteralPath (Join-Path $Bin 'ModLoader')) { throw 'the install has a ModLoader folder; only Dumper-7 may be injected' }

$dump = Join-Path $OutDir 'dumper'
$log = Join-Path $OutDir 'dumper.log'
New-Item -ItemType Directory -Force $dump | Out-Null
Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
[IO.File]::WriteAllText((Join-Path $Bin 'Dumper-7.ini'), (New-DumperIni $dump $log $SleepTimeoutSec), (New-Object Text.UTF8Encoding $false))
$dllHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $DllPath).Hash.ToLower()
"Dumper-7.dll sha256 $dllHash; inject in $InjectDelaySec s, dump $SleepTimeoutSec s after that, cap $TimeoutSec s"

$sw = [Diagnostics.Stopwatch]::StartNew()
function Test-GameAlive { [bool](Get-Process -Id $GamePid -ErrorAction SilentlyContinue) }
function Show-LogTail { if (Test-Path -LiteralPath $log) { (Read-Shared $log) -split "`r?`n" | Select-Object -Last 40 } }

while ($sw.Elapsed.TotalSeconds -lt $InjectDelaySec) {
    if (-not (Test-GameAlive)) { throw 'the game exited before Dumper-7 was injected' }
    Start-Sleep -Seconds 2
}
if (-not (Test-GameAlive)) { throw 'the game exited before Dumper-7 was injected' }
$err = [SrInject]::Inject($GamePid, $DllPath)
if ($err) { throw "injecting Dumper-7 failed: $err" }
"Injected at $([int]$sw.Elapsed.TotalSeconds) s"

# Dumper-7 opens its log when it starts: no log is no Dumper-7.
$logWait = [Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path -LiteralPath $log) -and $logWait.Elapsed.TotalSeconds -lt 30) { Start-Sleep -Seconds 1 }
if (-not (Test-Path -LiteralPath $log)) { throw 'Dumper-7 was loaded but wrote no log (its ini was not read)' }

$done = $false
while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Seconds 3
    $text = try { Read-Shared $log } catch { '' }
    if ($text -match 'Generating SDK took') { $done = $true; break }
    if (-not (Test-GameAlive)) { Show-LogTail; throw 'the game exited before the dump finished' }
}
if (-not $done) { Show-LogTail; throw "no finished dump in $TimeoutSec s" }
"Dump finished at $([int]$sw.Elapsed.TotalSeconds) s"

$u = Find-Usmap $dump
if (-not $u) { Show-LogTail; throw 'the dump finished but wrote no .usmap' }
# Written by a generator that has finished; make sure the size is steady anyway.
$size = -1
for ($i = 0; $i -lt 10 -and $u.Length -ne $size; $i++) { $size = $u.Length; Start-Sleep -Seconds 2; $u.Refresh() }
# CL127004's usmap is 730 KB; a dump that lost most classes is far below this.
if ($u.Length -lt 200KB) { Show-LogTail; throw "the usmap is only $($u.Length) bytes" }
$dest = Join-Path $OutDir 'usmap'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -LiteralPath $u.FullName -Destination (Join-Path $dest $u.Name) -Force
"usmap: $($u.Name), $($u.Length) bytes"
