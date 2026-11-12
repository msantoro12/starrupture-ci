# Layout table

`layout-table.mjs` turns the Client `Assertions.inl` of the Game-SDK into one
header, `layout_table.generated.h`, that the loader or a plugin embeds. At
startup the embedded consumer compares the table with the live game's
reflection data and learns, class by class, whether the SDK layout it was built
against still holds. The design is section 4 of the adaptive version gate.

The header is plain data: `<cstdint>` and nothing else, no SDK include, no
`std::string`. It is deterministic (same inputs, same bytes: no timestamps, no
paths) and written for C++20 (`inline constexpr`).

## Generating

```
node ci/layout-table.mjs gen <Client/Assertions.inl> --cl <built CL> \
     --used ci/fixtures/layout/used-all.txt  [--used more.txt]... \
     [--src <source dir>]...  --sdk <Client/SDK dir> \
     [--namespace SrLayoutTable] --out layout_table.generated.h
```

- The classes come from the `--used` name lists and from `used-classes.mjs`
  run over each `--src` directory. Both resolve against the `Assertions.inl`
  with the existing `layout-diff.mjs` matching, so a used name also selects its
  namespace-qualified and nested classes. Nothing else is parsed twice.
- `--sdk` points at the Dumper-7 `SDK` directory next to the `Assertions.inl`.
  The `Assertions.inl` has no member sizes, no bit-fields and no reflection
  paths; the `*_classes.hpp`, `*_structs.hpp` and `*_parameters.hpp` files do.
  Their comment on a static array (`LineBatchers[0x4]; // 0x00F0(0x0008)`)
  gives the size of one element; the generator multiplies it by the dimension,
  so a row's `size` is the whole member, as the game reflects it.
  Without `--sdk` the table is `kDetail = 0` and is for `compare` only: it is
  never to be embedded, because it still holds classes the game does not
  reflect.
- `--cl` is the built CL, written to `kBuiltCL`.
- The tool prints counts to stderr: classes, rows, bytes, used names not in the
  layout, and what `--sdk` left out. An `--sdk` directory with none of the
  selected classes, or one that lacks a declaration for more than a quarter of
  them, is an error (wrong directory, or a header format the parser no longer
  reads), never an empty table.

A header offset that disagrees with the `Assertions.inl` stops the run (the
headers are from a different build than the assertions).

```
node ci/layout-table.mjs compare <old.h> <new.h> [--json report.json]
```

Reports what the new build breaks in the old table, per class (`BROKEN
<class>` blocks) and exits 3 if anything is broken, 0 if not, 2 on a usage or
parse error. A member only in the new table is reported and breaks nothing.
This is the test the runtime applies, run in CI between two builds.

## Format

```cpp
namespace SrLayoutTable {                       // --namespace
inline constexpr uint32_t kFormatVersion = 1;   // bumped on any change below
inline constexpr uint32_t kBuiltCL   = 127004;
inline constexpr uint32_t kDetail    = 1;       // 1: Row::size and Row::boolMask are filled, kind/path are set
inline constexpr uint32_t kGranularity = 0;     // 0: every member of each listed class has a row; 1: see below
inline constexpr uint32_t kNameCount, kClassCount, kRowCount;

struct Class { uint32_t name, sizeOf, alignOf, firstRow, rowCount, kind, path; };
struct Row   { uint32_t name, offset, size, boolMask; };

inline constexpr const char* kNames[kNameCount];   // string pool, sorted, no duplicates
inline constexpr Class       kClasses[kClassCount];// sorted by name (code-point order)
inline constexpr Row         kRows[kRowCount];     // grouped by class in kClasses order, then by offset
}
```

Every `name` and `path` is an index into `kNames`. The string pool exists so no
single string literal grows past the compiler's limit and so a name that
appears twice is stored once.

### Class

| field | meaning |
|---|---|
| `name` | the SDK's C++ name, with its prefix: `ACrCharacterPlayerBase`, `FCrFoo`, `UCrBar`, `ABP_X_C`; for a function parameter struct, the SDK name `CrClass_Function` |
| `sizeOf`, `alignOf` | `sizeof` and `alignof` of the SDK class, from the `Assertions.inl` |
| `firstRow`, `rowCount` | the class's rows are `kRows[firstRow .. firstRow + rowCount)` |
| `kind` | 0 unknown, 1 UClass, 2 UScriptStruct, 3 UFunction parameters, 4 Blueprint-generated class |
| `path` | the reflection path from the Dumper-7 comment above the declaration (`Package.Name`; for kind 3 `Package.Class.Function`); `0xFFFFFFFF` when `kDetail` is 0 |

The A/U/F prefix is a C++ convention and is not part of the reflected name; use
`path` instead of stripping prefixes. For kinds 1 to 3 the first segment of
`path` is the module (`Engine`, `CoreUObject`, `Chimera`, ...), so the object
path is `/Script/` + module + `.` + the rest: `/Script/Chimera.CrCharacterPlayerBase`
for a class or struct. Kind 3 is the parameter block of one function:
`Package.Class.Function` names the `UFunction` `/Script/Package.Class:Function`
(find the `UClass`, then `FindFunctionByName`), and the `UFunction` is itself the
`UStruct` to check (its `PropertiesSize` is the block's size, its
`ChildProperties` the parameters, `ReturnValue` included). For kind 4 the first segment of `path` is
the Blueprint's own name, not a package path, so find those classes by their
object name (the last segment) and load them late: a Blueprint class is only
in memory once its asset has loaded. A missing kind-4 class at startup is not a
mismatch, only an unchecked class.

### Row

| field | meaning |
|---|---|
| `name` | the member name as reflected (`ADSMoveSpeed`) |
| `offset` | byte offset of the member in the class |
| `size` | total bytes of the member, array dimension included (`ElementSize * ArrayDim`); `0` = unknown, do not compare |
| `boolMask` | `FBoolProperty::FieldMask`: `0xFF` for a native `bool`, `1 << BitIndex` for a bit-field, `0` for every other type |

### What a table holds, and does not

- Only the members a class declares itself; the consumer never walks base
  classes for a row. With `--sdk`, the generator adds every reflected base class
  of a listed class (and its bases in turn), so a reordered base member is
  caught on the base even when the derived class keeps its `sizeof`. Without
  `--sdk` there are no base links and the table is compare-only anyway.
- Padding (`Pad_*`, `BitPad_*`) and members the Dumper predefines without a reflected
  property (`UObject::Outer`, `UStruct::Size`, ...) have no row. Classes that
  exist only as Dumper predefines (`FName`, `FField`, `FProperty`, ...) have no
  entry.
- Bit-fields share one offset; each has its own row with its own `boolMask`.
- `kGranularity` 0: every member. `gen --granularity 1` (needs `--src`) keeps,
  for a UClass or Blueprint class, only the rows whose member name the sources
  use (`.X`, `->X`, `::X`, `offsetof(T, X)`; by name, so it over-approximates).
  Script structs and parameter blocks keep every row. Same format. When it is 1,
  a consumer must never assume a class's rows are complete. Code reaches a
  UClass through pointers, so only the members it reads matter, and the
  generator writes its `sizeOf` and `alignOf` as 0 (not compared), unless the
  sources take `sizeof` or `alignof` of it (an allocation or a copy by value,
  such as the loader's `UFunction` clone).
- `kDetail` is 1 for anything embedded. A consumer starts with
  `static_assert(SrLayoutTable::kDetail == 1)`.

## What the consumer checks

For every class in `kClasses`, at startup (Blueprint classes: when they load):

1. Resolve the `UStruct` from `path` for its `kind` (`UClass`,
   `UScriptStruct`, or the function's parameter struct from the `UFunction`).
   Not found: the class is gone, which is a mismatch (kind 4: not loaded yet,
   skip and retry).
2. `UStruct::PropertiesSize` must equal `sizeOf` (the property size of a class
   is the SDK's `sizeof`). For kinds 1, 2 and 4, `MinAlignment` must also equal
   `alignOf`. For kind 3 (function parameters) the alignment is not compared:
   the SDK's `alignOf` is the alignment of the parameter block, but a native
   `UFunction` reflects `MinAlignment` 1, so the two are not comparable at
   runtime and the consumer skips the check. A `sizeOf` or `alignOf` of 0
   means unknown or not compared (granularity 1): do not compare it.
3. For each row, find the `FProperty` named `name` in the struct's own
   `ChildProperties` (not its super). Not found is a mismatch. Otherwise:
   - `Offset_Internal == offset`;
   - `size != 0` implies `ElementSize * ArrayDim == size`;
   - `boolMask != 0` implies the property is an `FBoolProperty` and its
     `FieldMask == boolMask`; `boolMask == 0` implies it is not.

Any mismatch marks the class as changed. What the consumer then does with a
changed class (log, disable the feature that uses it, refuse to start) is the
consumer's policy and is not in the table.

All of this runs on the game thread before any plugin touches a UObject, and
reads reflection data only (no instance pointers).

## Size

Measured at CL 127004 with the full used list, with `--sdk`:

| module | header |
|---|---|
| loader | 80 KB |
| WAILA | 56 KB |
| BetterDrone | 151 KB |
| BetterCheats | 126 KB |
| Codex | 23 KB |
| every used class, all modules | 235 KB |

The design estimated 300-600 KB; the real figure is two to four times smaller
(about 3,700 rows for all modules together).

## Reading the used layouts from the PDBs

The game ships a PDB with every build, so the layouts a component reads can be
checked against the build itself, not only against a Dumper-7 dump:

    node ci/layout-table.mjs keys <table.h> [--out keys.txt]
    sr-aobscan <game.exe> --layout keys.txt --json > layout.json
    node ci/layout-table.mjs pdb-diff <base.json> <next.json> [--keys keys.txt] [--json report.json]

`keys` lists a table as `--layout` keys: each class (its size), then each row
as `Class::Member`. Blueprint classes are left out (no PDB has them).
`ci/native-keys.txt` adds, per plugin, the members it reads at a fixed offset
because the Game-SDK has no name for them. `pdb-diff` compares two reports of
the same key list, one per build, key by key: same, moved, changed (size or
bool mask), missing, added, unresolved. A renamed member counts as missing.
It exits 3 when anything moved, changed or went missing, 0 otherwise.

A `native-keys.txt` line `<plugin> <ClassName> [size] [optional]` (no `::`) names an
unreflected struct whose size the plugin needs: `--layout` reads it from the PDB and
`field-rows.mjs` writes it as a class-key row on every build (ci/MAP-MODE.md, step 28).

A `native-keys.txt` member line may also carry an anchor, `<plugin> <Class::Member>
<file-suffix>:<regex>`, where `@` stands for the number the plugin source holds
(hex or decimal) and `~` for `\s*`. `apply-proposals.mjs offsets` finds the
number with the anchor and compares it with the PDB of the checked build. States:
ok; patch (one new constant is right for every build that matters, and
`apply-proposals.mjs apply` rewrites it); split (the offset moved between the
builds and the source reads the public one: a person decides); wrong (matches
neither build); changed (size or bool mask differs); missing (gone from the
build); unanchored (the anchor matches nothing); unchecked (no layout report, or the
step crashed). Only ok passes.

`sr-client-check` runs this once the scan tool has built: one `--layout` pass
per build over the keys of the loader and of each built plugin, then one
`pdb-diff` per component, written to `out/layout.json` (counts and the keys
that moved). It is a report: it does not change the check's verdict. If the
step fails (no plugin built, or the loader's table could not be fetched),
there is no report for any component.

## Checking the stored layout against the SDK tables

A public update takes its reference layout from the stored file of the build the plugins were built for
(ci/MAP-MODE.md). `ci/layout-store.mjs reference` checks that file against the header and the published
version object map and, when given `--sdk-tables <dir>`, against the tables this tool generates from the
game SDK. That third check is wider than the other two: the header carries about 170 of the keys and the
published version map fewer, while the tables hold every member the plugins read (854 keys in a replay
on build 127004).
For each key in both it compares the offset, the size and the bool mask (a class key compares its size where
the table has one). Keys the table lacks, or the file lacks, are ignored, but the check refuses (once enforcing, see
below) when fewer than half of the table's keys are in the file.

    node ci/layout-store.mjs reference <header> --record <layout.json> ... --sdk-tables res/sdk-tables --sdk-differences ci/sdk-table-differences.txt

The check job copies its tables and the first lines of the SDK's `SDK.hpp` into `out/sdk-tables` and uploads
them with the other results; the map-mode job downloads them as `res/sdk-tables`. A table does not say which
build it describes (its `kBuiltCL` is the build being checked), so the SDK's own header line
(`// 5.6.1-127004+++...`) is read for the build.

- It runs only when that build is the stored file's. When the SDK has moved to a newer build, there are no
  tables, the header line is missing or has another shape, a table cannot be read, or the tables carry no sizes,
  the check is skipped with one line (`the cross-check against the SDK tables was skipped: <why>`) in the log and
  in the step summary. A skip is a note, not a hold.
- **Report-only for now.** The mode is one setting, `SDK_TABLE_CHECK` in `ci/layout-store.mjs`, set to
  `report-only`. A difference, too few keys compared, an unreadable list or any error of the check itself holds
  nothing and fails nothing: the run goes on exactly as without the check, and the message, with the key and both
  values, is written as a note in the step summary and as a warning annotation on the run, worded
  `report only: this would hold once the check is enforcing: <message>`. A later one-line change sets the
  setting to `enforcing`; then a disagreement refuses the stored file and the update holds, with the key and
  both values in the message. Enforcing is fully implemented and tested; only the default is report-only.
- **A key source never holds a publish.** The folder holds two kinds of table: `table-<name>.h` for a released
  plugin and `table-ks-<name>.h` for a key source (a branch that only supplies keys). The loader's own keys are not
  in the folder, so they take no part. A key that only key-source tables ask for is a *key-source key*: a difference
  on it (the SDK row against the stored value, or a stored `NOTYPE`) is a warning, never a hold, whatever the mode.
  If any released-plugin table also names the key, it is judged as before. The warning is in the log, the step
  summary and a warning annotation (`SDK-table check (key source)`), one line per key with the table's
  offset/size/mask and the stored value or status, followed by a count line:
  `key source only: FIntPoint::X: SDK table 0x0/0x4/0x0, record NOTYPE (asked for only by table-ks-MiniMap.h)`.
- `ci/sdk-table-differences.txt` excuses known differences. Format (also at the top of the file): six
  tab-separated fields, `<build> <key> <offset|size|mask> <stored> <SDK> <reason>`. The build is a CL number,
  or `*` for any build. An entry excuses only the exact difference it names (key, field and those two values,
  on that build, or on any build for `*`); everything else on the key still holds. The reason is required. A
  malformed line, a missing reason or an unreadable file holds the update once the check is enforcing
  (report-only, it is reported); a test fails on a committed list that does not parse or lacks a reason.
- The one entry today: `*` `FEnhancedActionKeyMapping::Key`, size 0x50 stored and 0x18 in the SDK. The layout
  scan reports the enclosing struct's size for that member. The SDK is right, no row is published for the
  member, and a stored file cannot be replaced, so the difference is listed instead of held. It is for any
  build because every stored layout the scan wrote carries the same fault. The entry comes out when the scan is
  fixed; stored files are never replaced, so take it out once no stored file written before the fix can be the
  reference again.

## Tests

`node --test ci/layout-table.test.mjs` uses the trimmed fixtures in
`ci/fixtures/layout` and synthetic Dumper-7 header excerpts. With
`LAYOUT_FULL_DIR` set (see `ci/fixtures/layout/README.md`) it also compares
the tables of the full 126119 and 127004 client dumps and requires that
`ACrCharacterPlayerBase` (`ADSMoveSpeed` 0x13A8 to 0x13B8, `sizeof` 0x15E0 to
0x15F0) and `ACrAPHelper` are the broken used classes.
