# Version map

`version-map.mjs` keeps the header `version_map.generated.h`, in two flavours:

- **The loader's map is the central one.** It holds the locators of every
  tracked component's keys (the loader's own and each tracked plugin's) on every
  game build in its build table: a pattern and an RVA for each function key, and
  an offset, size and bool mask for each native field key and for each
  reflected field that moved or was renamed. `export-feed` writes it out as the
  feed that players' loaders fetch between loader releases.
- **A plugin's map** holds the plugin's own rows for its built CL (`kBuiltCL`)
  only. Every other build is the loader map's.

With it, one DLL runs on several game builds; a new build needs only rows in the
loader's map.

The header is the only copy of the data. There is no JSON twin: the tool reads
the header, changes what it read and writes it back. It refuses a header that is
not, byte for byte, what it would write itself, so a hand edit or a merge
artifact fails every command instead of being carried along.

The header is plain data for C++20: `<array>`, `<cstdint>` and, in a plugin map,
`plugin_interface.h` for the row types. It is deterministic: no timestamps, no
paths, every list sorted.

## Keys

A function key has one of two forms, and one `kind` (a `PluginScanKind`) on
every row it has:

- **A global key**, `Class::Function` or a global's name (`GWorld`), names one
  game symbol. Kinds 1 (FUNCTION_START) and 4 (DATA) read it. It has no `/`.
- **A scoped key**, `<owner>/<hookName>`, where the owner is a plugin's
  `PluginInfo` name or `ModLoader`. Kinds 2 (IN_FUNCTION), 3 (CODE), 5 (VTABLE)
  and 6 (ANY) read it. A scoped row's address is right only for the request it
  was verified with, so the row carries that request's `fp`, the fingerprint the
  harness prints for it (FNV-1a 32, never 0). One key can have a row set per
  `fp`, for the current release of its owner and the one before it.

The row identity is the key, the `fp` (0 on a global row) and the CL. A field
key is `Class::Member`.

## Commands

```
node ci/version-map.mjs init <header> --flavour plugin|loader --built-cl <CL>
node ci/version-map.mjs add-build <header> --cl <CL> --stamp <hex> --size <hex> --source <text>
node ci/version-map.mjs add-function <header> --key <key> --cl <CL> --rva <hex>
     (--pattern <aob> | --rva-only) [--result-offset <n>] [--follow-rel32-at <n>]
     [--follow-rip-disp-at <n>] [--kind <1-6> [--fp <hex>]]
node ci/version-map.mjs add-absent <header> --key <key> --cl <CL> --kind <1-6>
     (--fp <hex> | --owners <owner>[,<owner>...])
node ci/version-map.mjs add-field <header> --key <key> --cl <CL> --offset <hex> --size <hex>
     [--mask <hex>] [--member <name>]
node ci/version-map.mjs replace-build <header> --cl <CL> --stamp <hex> --size <hex> --source <text>
node ci/version-map.mjs remove-key <header> --key <key>
node ci/version-map.mjs prune <header> --keep <CL>[,<CL>...]
node ci/version-map.mjs check <header> [--keys <keys.txt>]...
node ci/version-map.mjs export-feed <header> --out <file>
```

- `init` writes an empty map and refuses to overwrite a file. `--built-cl` is
  the CL the component's SDK and code patterns were written for (`kBuiltCL`).
- `add-build` adds a build: its CL, the exe's PE `TimeDateStamp` and
  `SizeOfImage`, and where it came from (`public 25646882`,
  `public_test_branch 26271156`: the branch and the Steam build ID). A plugin
  map takes its `kBuiltCL` only.
- `add-function` adds the row for one key on one build. The build must be in
  the table; the row takes its stamp and size from there. `--pattern` is IDA
  style, upper-case hex bytes and `??` separated by single spaces. `--rva-only`
  writes a row with no pattern, which the loader honours only on that exact
  exe (CL, stamp and size all equal). `--result-offset` and `--follow-rel32-at`
  mean what they mean in a `PluginScanRequest`. A loader map row needs
  `--kind`, and `--fp` for a scoped key; `--follow-rip-disp-at` is for its own
  global keys. A plugin map refuses all three.
- `add-absent` (loader map only) records that CI could not place a key on a
  build. A global key's absent row lists the owners whose requests CI tested (a `PluginInfo`
  name or `ModLoader`: no `,`, no `/`, not `-`);
  adding it again with other owners adds them. A scoped key's absent row takes
  the `fp` CI tested instead and binds only the requests with it.
- `add-field` adds the row for one field key on one build. `--member` is the
  member's new name when it was renamed. Offsets, sizes and masks are hex; a
  mask needs size 1.
- The same row added again changes nothing (exit 0). A row with other values
  for a key, `fp` and build already in the map is an error: a run never
  rewrites what an earlier run verified. The one exception is an absent row: a
  verified `add-function` of the same kind replaces it, and `add-absent` never
  replaces a verified row.
- `replace-build` records a new exe for a CL already in the table (the same CL
  rebuilt, as a beta's public rebuild may be) and drops every row of that CL,
  so each is verified again on the new exe and added back.
- `remove-key` drops a key's rows on every build and every `fp`: the way out of
  an orphan after the code renames or drops a hookName or field.
- `prune` keeps the builds listed (each must be in the table) and drops every
  other build together with all of its rows.
- `check` reads the header. With `--keys` it also applies the coverage rule
  below and prints one line per problem. `--keys` may be given once per tracked
  component; the rule then runs over the union of the lists.
- `export-feed` writes the loader map as the feed (below) to `--out`, which must
  not be the header.

Exit codes: 0 ok; 3 `check` found a coverage problem; 2 usage error, a header off
the format, or a conflicting row. A command that fails leaves the header alone.

## The coverage rule

`check --keys` takes the keys a component uses, one per line (`#` comments and
blank lines are skipped):

```
function <key>                          a hookName, or a loader registry name
required <key>                          a function key the loader needs to start
native <key> [<offset> <size> <mask>] [optional]   a native (non-reflected) field; the values as built, hex, all three or none
field <key> [optional]                  a reflected field
```

A member gone on a build refuses the plugin that requests it, so by default a build
that lacks it holds the map (`field-rows.mjs`, exit 3). A trailing `optional` marks a
member the plugin has a fallback for: a member gone on a build gets an absent row and
the plugin takes its fallback. When several lists have a key, it is optional only if every
list says so.

Several lists are taken together: a key may be in more than one under the same
kind (`required` and `function` are both function keys), a key that is a
function key in one list and a field in another is an error, and so are two
lists that give a native key different built values.

It reports:

- a `kBuiltCL` with no row in the build table;
- every build in the table that lacks a row, a locator or an absent row, for a
  `function` or `native` key, and for a scoped key one per `fp` the map holds.
  Keys that did not move need a row too (the same pattern, the new RVA), so on a
  known build the exact row always applies;
- an absent row for a `required` global key: the loader needs a locator there.
  For a required scoped key, `check` cannot tell which `fp` is the newest
  release's; the writer that knows it from the harness enforces that;
- every key in the map that no list has (an orphan, such as a hookName renamed
  in the code);
- a `native` key with built values whose row on `kBuiltCL` disagrees with them.

A `field` key needs rows only where it moved or was renamed: reflection gives its
offset live on any build.

## Format

The plugin flavour, as `ci/fixtures/version-map/plugin.h` has it:

```cpp
// Generated by starrupture-ci ci/version-map.mjs. Do not edit by hand.
// Format: ci/VERSION-MAP.md in starrupture-ci.
#pragma once
#include <array>
#include <cstdint>
#include "plugin_interface.h"

namespace VersionMap
{
inline constexpr uint32_t kFormatVersion = 2;
inline constexpr uint32_t kBuiltCL = 127004;

struct Build { uint32_t gameCL, imageStamp, imageSize; const char* source; };
struct Index { const char* key; uint16_t first, count; };

inline constexpr std::array<Build, 1> kBuilds = {{
	{ 127004, 0x68F0A1B2, 0x0A3F2000, "public 25646882" },
}};

inline constexpr std::array<PluginScanCandidate, 3> kFunctionRows = {{
	// AActor::ProcessEvent caller
	{ 127004, 0x68F0A1B2, 0x0A3F2000, "E8 ?? ?? ?? ?? 48 8B 5C 24 ?? 48 83 C4 20", PLUGIN_SCAN_FLAG_FOLLOW_REL32, 0, 0, 0x00C01230 },
	...
}};

inline constexpr std::array<PluginFieldCandidate, 3> kFieldRows = {{
	// ACrCharacterPlayerBase::ADSMoveSpeed
	{ 127004, 0x13C8, 0x4, 0x00, "ADSMoveSpeedScale" },
	...
}};

inline constexpr std::array<Index, 3> kFunctions = {{
	{ "AActor::ProcessEvent caller", 0, 1 },
	...
}};

inline constexpr std::array<Index, 3> kFields = {{ ... }};
}
```

- `kBuilds` is sorted by CL. The row arrays are grouped by key, the keys in byte
  order (as `strcmp` sorts them, so a binary search over `kFunctions` and
  `kFields` works), each group under a `// <key>` line. Function rows are
  sorted by `fp`, then CL, inside a group; field rows by CL.
- A plugin function row is a `PluginScanCandidate`: CL, stamp, size, pattern
  (`nullptr` for an RVA-only row), flags, result offset, follow-rel32 offset
  (-1: none), RVA. The flags are `PLUGIN_SCAN_FLAG_FOLLOW_REL32` exactly when
  the follow offset is set, else `PLUGIN_SCAN_FLAG_NONE`.
- A field row is a `PluginFieldCandidate`: CL, offset, size, bool mask
  (`0xFF` for a native bool, one bit for a bitfield, else `0x00`), and the new
  member name or `nullptr`.
- `kFunctions` and `kFields` index the rows: the key, its first row, its row
  count.
- An empty list is `inline constexpr std::array<T, 0> kName = {};`, which is why
  the lists are `std::array` and not C arrays (a zero-length C array does not
  compile).
- Keys, sources and patterns are printable ASCII without `"` or `\`, so they
  need no escaping in a string literal or a `//` line. Members are C++
  identifiers. Numbers are decimal for CLs, kinds and the signed request
  offsets, upper-case hex elsewhere (8 digits for stamps, sizes, `fp`s and
  RVAs).

The loader flavour (`ci/fixtures/version-map/loader.h`) has no
`plugin_interface.h` include and declares its own two row types after `Index`:

```cpp
struct FunctionRow { uint32_t gameCL, imageStamp, imageSize; int32_t kind; uint32_t fp; bool absent; const char* pattern; int32_t resultOffset, followRel32At, followRipDispAt; uint32_t rva; const char* owners; };
struct FieldRow { uint32_t gameCL; int32_t offset; uint32_t size; uint8_t boolMask; const char* member; };
```

```cpp
	// BetterCheats/AActor::ProcessEvent caller
	{ 127004, 0x68F0A1B2, 0x0A3F2000, 2, 0x2D1AC6AE, false, "48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??", 0, -1, -1, 0x00C01230, nullptr },
	{ 128786, 0x6A1B2C3D, 0x0A412000, 2, 0x2D1AC6AE, false, "48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??", 0, -1, -1, 0x00C02240, nullptr },
	{ 127004, 0x68F0A1B2, 0x0A3F2000, 2, 0xB3405899, false, "?? ?? ?? ?? 48 85 C0 74", -4, -1, -1, 0x00C01230, nullptr },
	{ 128786, 0x6A1B2C3D, 0x0A412000, 2, 0xB3405899, true, nullptr, 0, -1, -1, 0x00000000, nullptr },
	...
	// UCrSomething::Function
	{ 127004, 0x68F0A1B2, 0x0A3F2000, 1, 0x00000000, false, "40 53 48 83 EC 20 48 8B D9", 0, -1, -1, 0x01B00010, nullptr },
	{ 128786, 0x6A1B2C3D, 0x0A412000, 1, 0x00000000, true, nullptr, 0, -1, -1, 0x00000000, "BetterCheats,WAILA" },
```

- A loader function row has no flags column. It carries the key's `kind`, the
  `fp` (0 on a global key, never 0 on a scoped one), `absent`, and
  `followRipDispAt`; a row follows a rel32 or a rip displacement, never both.
- An absent row has no pattern, a 0 RVA and the offsets 0, -1, -1. On a global
  key, `owners` lists the owners whose requests CI tested, comma-separated,
  sorted and each once; on a scoped key, and on every locator, it is `nullptr`.
- A map that holds a key under two kinds is refused.

The flavour is read from the file: a map that includes `plugin_interface.h` is a
plugin map. CRLF line ends, which a Windows checkout may give, read as LF; the
tool writes LF. A format 1 header (no kinds, `fp`s or absent rows)
is refused; `init` and the `add-` commands write format 2.

## The feed

`export-feed` writes the loader map as plain text, as
`ci/fixtures/version-map/loader.feed.txt` has it:

```
format	1
build	127004	0x68F0A1B2	0x0A3F2000	public 25646882
build	128786	0x6A1B2C3D	0x0A412000	public_test_branch 26271156
function	BetterCheats/AActor::ProcessEvent caller	0x2D1AC6AE	127004	0x68F0A1B2	0x0A3F2000	2	48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??	0	-1	-1	0x00C01230
...
absent	BetterCheats/AActor::ProcessEvent caller	0xB3405899	128786	0x6A1B2C3D	0x0A412000	2	-
...
absent	UCrSomething::Function	0x00000000	128786	0x6A1B2C3D	0x0A412000	1	BetterCheats,WAILA
field	ACrCharacterPlayerBase::ADSMoveSpeed	128786	0x13C8	0x4	0x00	ADSMoveSpeedScale
...
```

- One line per record, fields separated by one tab, LF line ends, a final LF.
  The first line is `format	1`. Then:
  - `build	<cl>	<stamp>	<size>	<source>`
  - `function	<key>	<fp>	<cl>	<stamp>	<size>	<kind>	<pattern|->	<resultOffset>	<followRel32At>	<followRipDispAt>	<rva>`
  - `absent	<key>	<fp>	<cl>	<stamp>	<size>	<kind>	<owners|->`
  - `field	<key>	<cl>	<offset>	<size>	<mask>	<member|->`
- `-` stands for no value (`nullptr` in the header). Numbers are written as in
  the header.
- Builds come sorted by CL; function and absent lines together by key, `fp` and
  CL (the table holds one exe per CL, so CL order is exe order); field lines by
  key and CL. The same map gives the same bytes, whatever order its rows were
  added in.
- Every function and absent line repeats its build's stamp and size, so a line
  read alone names its exe.
- The feed has no `kBuiltCL`, no sequence number and no signature; signing is
  not this tool's. It is unsigned bytes, not a checkout file, so CRLF is refused.
- `export-feed` fails above 512 KiB, so the loader's 1 MiB cap is never reached
  silently.

`parseFeed` reads a feed back strictly: any line off the format is
an error, a scoped row with no `fp` or with 0 included, and the map it reads
must export to the same bytes.

## What never goes in

No PDB names, no types, no bytes of the exe: only the components' own key text,
offsets, sizes, masks, patterns, RVAs and request fingerprints, the same kind of
data the code and the pattern suggester already publish.

## Tests

```
node --test ci/version-map.test.mjs
```

The fixtures in `ci/fixtures/version-map` were written by the commands above
(the tests that run the commands rebuild `plugin.h`, `loader.h` and
`loader.feed.txt` and compare); their numbers are made up. Where g++ or clang++
is on the PATH, as on the CI runner, the fixtures are also compiled as C++20
with warnings as errors.
