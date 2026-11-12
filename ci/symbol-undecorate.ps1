# Undecorates MSVC symbol names with dbghelp.dll (UnDecorateSymbolName), which every Windows
# ships. Used by ci/symbol-lookup.mjs: one decorated name per line on standard input, one JSON
# array on standard output with the undecorated declaration of each name, in the same order
# ('' for a name dbghelp cannot undecorate). The names are data, read from stdin; nothing is
# put on a command line.
#
#   -Check   undecorates a known name and exits 1 if the answer is not the expected one.
[CmdletBinding()]
param([switch]$Check)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SymbolUndecorate {
  [DllImport("dbghelp.dll", CharSet = CharSet.Ansi)]
  static extern uint UnDecorateSymbolName(string name, StringBuilder output, uint maxLength, uint flags);

  // Flags 0 is UNDNAME_COMPLETE: access, calling convention, return type and argument list.
  public static string Run(string name) {
    var sb = new StringBuilder(4096);
    return UnDecorateSymbolName(name, sb, (uint)sb.Capacity, 0) == 0 ? "" : sb.ToString();
  }
}
'@

if ($Check) {
    $got = [SymbolUndecorate]::Run('?Foo@@YAXH@Z')
    if ($got -ne 'void __cdecl Foo(int)') { Write-Host "::error::dbghelp undecorated ?Foo@@YAXH@Z as '$got'"; exit 1 }
    'Check passed.'
    exit 0
}

$names = @([Console]::In.ReadToEnd() -split "\r?\n" | Where-Object { $_ })
$result = @($names | ForEach-Object { [SymbolUndecorate]::Run($_) })
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
