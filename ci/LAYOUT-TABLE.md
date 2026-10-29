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
  Without `--sdk` the table is `kDetail = 0` and is for `compare` only: it is
  never to be embedded, because it still holds classes the game does not
  reflect.
- `--cl` is the built CL, written to `kBuiltCL`.
- The tool prints counts to stderr: classes, rows, bytes, used names not in the
  layout, and what `--sdk` left out.

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
inline constexpr uint32_t kGranularity = 0;     // 0: every member of each listed class has a row
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
`path` instead of stripping prefixes. For kind 4 the first segment of `path` is
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

- Only the members a class declares itself. Members inherited from a base
  class are in the base's own row set if that class is in the table; the
  consumer never walks base classes for a row.
- Padding (`Pad_*`) and members the Dumper predefines without a reflected
  property (`UObject::Outer`, `UStruct::Size`, ...) have no row. Classes that
  exist only as Dumper predefines (`FName`, `FField`, `FProperty`, ...) have no
  entry.
- Bit-fields share one offset; each has its own row with its own `boolMask`.
- `kGranularity` is 0 now (every member). A later generator that lists only the
  members a project touches sets it to 1, in the same format. A consumer must
  never assume a class's rows are complete when it is 1.
- `kDetail` is 1 for anything embedded. A consumer starts with
  `static_assert(SrLayoutTable::kDetail == 1)`.

## What the consumer checks

For every class in `kClasses`, at startup (Blueprint classes: when they load):

1. Resolve the `UStruct` from `path` for its `kind` (`UClass`,
   `UScriptStruct`, or the function's parameter struct from the `UFunction`).
   Not found: the class is gone, which is a mismatch (kind 4: not loaded yet,
   skip and retry).
2. `UStruct::PropertiesSize` must equal `sizeOf` and `MinAlignment` must equal
   `alignOf` (the property size of a class is the SDK's `sizeof`).
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
| loader | 61 KB |
| WAILA | 46 KB |
| BetterDrone | 130 KB |
| BetterCheats | 94 KB |
| Codex | 12 KB |
| every used class, all modules | 208 KB |

The design estimated 300-600 KB; the real figure is three to five times
smaller.

## Tests

`node --test ci/layout-table.test.mjs` uses the trimmed fixtures in
`ci/fixtures/layout` and synthetic Dumper-7 header excerpts. With
`LAYOUT_FULL_DIR` set (see `ci/fixtures/layout/README.md`) it also compares
the tables of the full 126119 and 127004 client dumps and requires that
`ACrCharacterPlayerBase` (`ADSMoveSpeed` 0x13A8 to 0x13B8, `sizeof` 0x15E0 to
0x15F0) and `ACrAPHelper` are the broken used classes.
