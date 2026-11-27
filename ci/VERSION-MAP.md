# Version map

`version-map.mjs` keeps the header `version_map.generated.h`, in two flavours:

- **The loader's map is the central one.** It holds the locators of every
  tracked component's keys (the loader's own and each tracked plugin's) on every
  game build in its build table: a pattern and an RVA for each function key, and
  an offset, size and bool mask for each native field key and for each
  reflected field that moved, was renamed or is new on the build. `export-feed` writes it out as the
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
key is `Class::Member`, or a class name alone: a **class-key row** is that
struct's own size (offset 0, size N, bool mask 0, no new name), the same row a
size request (`SR_SIZE`, `SR_SIZE_CHECK`) matches in the loader. It is a normal
field row, so the header, the feed (format 1) and loaders that read it need
nothing new.

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
node ci/version-map.mjs add-absent-field <header> --key <Class::Member> --cl <CL>
node ci/version-map.mjs replace-build <header> --cl <CL> --stamp <hex> --size <hex> --source <text>
node ci/version-map.mjs remove-key <header> --key <key>
node ci/version-map.mjs prune <header> --keep <CL>[,<CL>...]
node ci/version-map.mjs check <header> [--keys <keys.txt>]...
node ci/version-map.mjs export-feed <header> --out <file>
node ci/version-map.mjs import-published <header> --published <signed feed> [--retired <file>] [--changed <file>]
node ci/version-map.mjs check-preserve <feed> --published <signed feed> [--retired <file>] [--changed <file>]
node ci/version-map.mjs restore-published <header> --published <signed feed> --cl <CL> [--retired <file>]
     [--changed <file>] [--report <file>]
node ci/version-map.mjs carry-keys <keys file> --published <signed feed> --cl <CL> --out <file> [--retired <file>] [--extra <file>]
```

- `init` writes an empty map and refuses to overwrite a file. `--built-cl` is
  the CL the component's SDK and code patterns were written for (`kBuiltCL`).
- `add-build` adds a build: its CL, the exe's PE `TimeDateStamp` and
  `SizeOfImage`, and where it came from (`public 25646882`,
  `steam_build 26271156`: the label and the Steam build ID). A plugin
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
- `add-absent-field` (loader map only) records that a field key does not exist
  on a build. It is refused when the key has a field row for that build or the
  build is not in the header. These entries stay in the header; the published
  file does not carry them.
- The same row added again changes nothing (exit 0). A row with other values
  for a key, `fp` and build already in the map is an error: a run never
  rewrites what an earlier run verified. The one exception is an absent row: a
  verified `add-function` of the same kind replaces it, and `add-absent` never
  replaces a verified row.
- `replace-build` records a new exe for a CL already in the table (the same CL
  rebuilt, as a rebuild on public may be) and drops every row of that CL,
  so each is verified again on the new exe and added back.
- `remove-key` drops a key's rows on every build and every `fp`: the way out of
  an orphan after the code renames or drops a hookName or field.
- `prune` keeps the builds listed (each must be in the table) and drops every
  other build together with all of its rows.
- `check` reads the header. With `--keys` it also applies the coverage rule
  below and prints one line per problem. `--keys` may be given once per tracked
  component; the rule then runs over the union of the lists.
- `export-feed` writes the loader map as the feed (below) to `--out`, which must
  not be the header. Every CL in the header goes into the feed, and a feed over
  the size cap (`FEED_MAX_BYTES`, 1,040,000 bytes, under the 1 MiB loaders from v1.23.0
  accept) is refused with its size.
- `import-published` adds to the header every build line and row of the signed feed
  that the header lacks, so the next `export-feed` still carries them. It reads the
  feed only after the signature verifies. See "The published feed is part of the base".
- `check-preserve` reads a new feed and exits 3, naming the rows, when a line of the
  signed feed is missing from it or has other content.
- `restore-published` is for a test run that measured a published build again. It puts back
  the published rows of `--cl` that the run did not measure, and the real rows the run measured
  as absent. A row the run measured with other content stays. See `MAP-MODE.md`, "A re-measure keeps
  published rows".
- `carry-keys` writes to `--out` the field keys of the newest published build that the key list
  does not name, for a build the published file does not hold yet, with the keys of `--extra` added. See `MAP-MODE.md`, "Carried field keys".

Exit codes: 0 ok; 3 `check` found a coverage problem, or `import-published` or
`check-preserve` holds (rows differ, rows lost); 4 the signed feed's signature does not
verify (`import-published`, `check-preserve`, `restore-published`, `carry-keys`); 2 usage error, a header off the format,
or a conflicting row. A command that fails leaves the header alone.

## The coverage rule

`check --keys` takes the keys a component uses, one per line (`#` comments and
blank lines are skipped):

```
function <key>                          a hookName, or a loader registry name
required <key>                          a function key the loader needs to start
native <key> [<offset> <size> <mask>] [optional]   a native (non-reflected) field; the values as built, hex, all three or none
field <key> [optional]                  a reflected field; a key with no `::` is a class (its size)
```

A member gone on a build gets an absent row: the loader turns that one request off and
the plugin runs without that feature (`field-rows.mjs` reports it as degraded, high
severity for a required request, low for an `optional` one). Only the loader's own keys,
or a class whose compiled size code uses with no `SR_SIZE_CHECK`, hold the update.
Until the loader degrades instead of refusing, a missing required request still refuses
that plugin at load; the other plugins are not affected. When several lists have a key,
it is optional only if every list says so.

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

A `field` key needs rows only where it moved, was renamed or is new on the build (a class-key row, a struct's size, is also written on every build for each size a component requests): reflection gives its
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
- `export-feed` fails above 1,040,000 bytes, so the loader's 1 MiB cap is never reached
  silently.

`parseFeed` reads a feed back strictly: any line off the format is
an error, a scoped row with no `fp` or with 0 included, and the map it reads
must export to the same bytes.

## The published feed is part of the base

The signed feed on the `vmap-feed` release is what players read. A new feed is cut from the
loader header, so a row the feed has and the header lacks would drop out of the next one.
To stop that, the published feed is added to the header first (`import-published`), and the new
feed is compared with the published one before it goes out (`check-preserve`). A published row
is never removed or rewritten by a run. Two lists name the rows that may be:

| File | Lists rows that |
|---|---|
| `ci/retired-rows.txt` | may leave the feed (the build is gone, the key was dropped) |
| `ci/changed-rows.txt` | may change content (a better pattern, a new offset, an absent row that found an address) |

One entry per line, four fields separated by tabs: kind (`function`, `field` or `build`), key
(`-` for a build), the build's CL number, and a reason. A reason is required. An entry names every
row of that key on that build. Lines starting with `#` are skipped. Example, in `retired-rows.txt`:

```
function	UCrSomething::OldFunction	127004	No release of any plugin asks for it any more.
```

`changed-rows.txt` starts with no entries; `retired-rows.txt` holds the Codex ItemIcon row of
CL-129402, which no release reads any more. A field entry also keeps that key out of the key list
carried to any future build (`carriedFieldKeys` in `version-map.mjs` uses the key alone;
`MAP-MODE.md` calls it "a field entry on any build"). An entry is never needed to keep a row; it is
only the way out for one that is meant to go. A test run that measures a build again keeps the
published rows it did not measure or measured as absent; only a different measured value needs a
`changed-rows.txt` entry. What a run does with the base, and what to do when it holds, is in
`MAP-MODE.md` ("The published feed as the base").

## Dedicated server

The dedicated server is its own exe, so its version object map gets its own header (`server.h`) and
its own feed file. The client's header and feed are not touched.

Steps:

1. `node ci/version-map.mjs init server.h --flavour server --built-cl <CL>` makes the header.
2. `add-build` takes the server exe. Its `--source` reads `server steam_build <build id>`, and the stamp
   and size are the server exe's own.
3. `add-function` takes address-only rows (`--rva-only`): kind 1 for a function start, kind 4 for a
   global. `add-field` takes member offsets and class sizes as it does for the client.
4. `node ci/version-map.mjs export-feed server.h --out feed.txt --server` writes the feed. The same
   `format 1` text, the same order for any input order, and the same size cap. The flag has to match
   the header: a server header without `--server`, or `--server` on another header, is refused.

What is different from the client's file:

- One server exe per CL. A server CL may equal a client CL with another stamp or size; the server
  file takes it, the client file still refuses it.
- Function rows are address-only. The one scoped row is `ModLoader/GObjects (GUObjectArray.ObjObjects)`
  (kind 6); its fingerprint is copied from the client's row for the same key.
- No absent rows and no absent fields. A key with no row is a key with no row.
- No `ModLoader/` row other than that GObjects row.
- A server feed does not merge into a client header (`import-published`), and a client feed does not
  merge into a server header: the build lines tell them apart.

Example, the server fixture (`ci/fixtures/version-map/server.h`, its feed `server.feed.txt`):

```
node ci/version-map.mjs init server.h --flavour server --built-cl 127004
node ci/version-map.mjs add-build server.h --cl 127004 --stamp 0x2E3595FF --size 0x0E2A8000 --source "server steam_build 25642172"
node ci/version-map.mjs add-function server.h --key GWorld --cl 127004 --rva 0x0E601F38 --rva-only --kind 4
node ci/version-map.mjs add-field server.h --key UCrMassPersistentIDSubsystem::MaxID --cl 127004 --offset 0xD0 --size 0x4
node ci/version-map.mjs export-feed server.h --out server.feed.txt --server
```

`map-mode.mjs server` fills the same header from the scanner's output (`MAP-MODE.md`, "Dedicated server"): the field and size rows from `--layout`, and the function and global rows from `--scan`, which `ci/server-scan-rows.mjs` makes from `sr-aobscan-server --json`. The server scanner is the Server Release build of the loader's `tools/AobScan`; the server leg builds it from the default `scanner_ref`, `ci/aobscan-server-rows` (the client check keeps `ci/aobscan`). A live publish of a server file requires the default inputs, `scanner_ref` included (`SCANNER_DEFAULTS` in `sr-server-check.yml`); `sr-watch.yml` passes only `buildid` and `rehearsal`, so its calls use the default too.

A server file for a new server build has to carry the loader's own rows, or the server starts with its plugins off:
the four field rows the loader reads (`ACrCrafter::CraftComponent`, `UWorld::GameState`, `UWorld::LineBatchers`,
`UWorld::NetDriver`) and the three Game-SDK global rows (`ModLoader/GObjects (GUObjectArray.ObjObjects)`,
`FName::AppendString`, `GWorld`; the loader only logs GNames). `ci/server-required-rows.txt` lists them and the `server-map`
job fails, naming the missing keys, when the new build lacks one. The loader's own baseline CL is not checked. The global
rows need the server scanner leg, which is not built yet, so until it lands every new server build stops at this check.

## The publish gate

A released server loader without the same-exe binding (v1.27.0) trusts a signed server file too far: it
reads whatever is published. `ci/server-publish-gate.mjs` judges the final text of the server file, carried
and published-base lines included, and refuses it before a signing key is read.

```
node ci/server-publish-gate.mjs <server feed> --result <server-result.json>
```

`server-result.json` holds the scanned exe's build number, time stamp and image size. Exit 0 means the file
may be signed. Any other exit stops the run (3: refused, each broken rule printed; 2: the file, the result
or a built-in table can't be read). An unknown build number, stamp or size refuses too.

Rules:

1. The file has exactly one build line. Every line carries the scanned exe's build number, and its time stamp
   and image size where the line has them.
2. On the built-in table's own exe (same build number, stamp and size), a row for a name the table has, as a
   row or as absent, repeats a built-in row exactly: same values, fingerprint and kind. New names are free.
3. On a rebuilt exe with the table's build number, the file replaces every built-in row the loader could
   still serve: every field and size row, and every function row that has a pattern or is marked absent. An
   address-only function row is not needed, because v1.27.0 tries it on its own exe only (`version_map.cpp`,
   `Select`). All of v1.27.0's function rows are address-only.

For a build number the table doesn't hold, only rule 1 applies.

**One build number per file.** The loaders can take rows from a line with another build number:

- v1.27.0 `version_map.cpp:1027-1039` keeps the pattern rows of the newest other build number (`latestCL`),
  and `Select` (`version_map.cpp:800-806`) scans for those patterns again.
- The loader with the binding, commit `5fb474c8`, does the same (`version_map.cpp:1063-1075`). Its
  `BindToExe` (`version_feed.cpp:150` on) filters only the build numbers its own table holds.

So a file with a second build number is refused. **This blocks a second server build.** Once a server file is
live, a file for a newer build is refused either way: with the published lines kept, by this gate; without
them, by the keep-published-lines check (`published-base.mjs preserve`). Nothing gets signed. It stays that
way until the project lead decides otherwise. Don't get around it with a `build` entry in
`ci/retired-rows.txt`: that takes the older build out of the live server file, and the client file reads the
same list, so it loses that build number too.

**A rebuilt 127004 exe.** Rule 3 needs every v1.27.0 field row. The pipeline does not produce
`FHttpServerRequest::Verb` or `FTransform::Translation`, so a pipeline file for a rebuilt 127004 exe is
refused. The pipeline adds no rows of its own to get past this.

**The built-in table.** `ci/data/loader-server-table/v1.27.0/version_map.server.h` is a copy of
`StarRupture-ModLoader-Core/hooks/game/version_map.server.h` at the tag `v1.27.0`, the released loader
without the binding. Earlier tags have no server table. `LOADER_TABLES` in the script records its git blob
id; another blob, or a table the script can't read in full, refuses the publish. Nothing notices a newly
released loader. If another loader without the binding is released and its table differs, copy that table to
`ci/data/loader-server-table/<tag>/` and add its `LOADER_TABLES` entry by hand. The file is then judged
against every listed table.

**Paths covered.** `sr-server-check.yml` signs a server file twice, and each signing comes right after a gate
step on that same file:

| Job | Gate step | Signing |
|---|---|---|
| `server-map` | Gate the server file for older loaders | TEST key dry run |
| `server-publish` | Gate the server file for older loaders before signing | release key |

Only `server-publish` uploads a server file (`vmap-publish.sh feed`, live and rehearsal), after its own
signing, so live publishes, rehearsals and manual runs all pass the gate. The other workflows don't publish
one: `vmap-sign.yml` signs the client fixture with the TEST key, `sr-client-check.yml` signs and uploads the
client file, and `engine-test.yml` only starts a test server with a file it is given. The client's version
object map is not touched.

**Retiring the gate.** Nothing switches it off by itself. When the minimum server loader has the binding,
the project lead decides to retire it. The one-build-number rule goes with it, and the binding at
`5fb474c8` does not cover rows from another build number (above), so settle that first. Then, in one
change:

1. Delete both gate steps, and their comments, from `sr-server-check.yml`.
2. Delete `ci/server-publish-gate.mjs`, `ci/server-publish-gate.test.mjs` and `ci/data/loader-server-table/`.
3. In `ci/server-check-workflow.test.mjs`, delete the `gate:` test and set the run step counts back to 12
   (`server-map`) and 9 (`server-publish`).
4. Delete this section, and the comments elsewhere that point to it.

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
