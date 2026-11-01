#!/usr/bin/env node
// Turn the Game-SDK's layout assertions into a compact table a loader or plugin
// DLL embeds, so it can check those layouts against the live game's reflection
// data at startup (design: adaptive version gate, section 4).
//
//   node ci/layout-table.mjs gen <Client/Assertions.inl> --cl <build> \
//        [--used used-classes.txt]... [--src <source-dir>]... \
//        [--sdk <Client/SDK dir>] [--granularity 0|1] [--namespace SrLayoutTable] [--out layout_table.generated.h]
//   node ci/layout-table.mjs compare <old.h> <new.h> [--json report.json]
//   node ci/layout-table.mjs keys <table.h> [--out keys.txt]
//   node ci/layout-table.mjs pdb-diff <base.json> <next.json> [--keys keys.txt] [--json report.json]
//
// gen
//   Selects the classes to embed: the names in each --used list plus whatever
//   used-classes.mjs finds in each --src directory, all resolved against the
//   Assertions.inl (a used name also selects namespace-qualified and nested
//   classes, as layout-diff.mjs does). Every member of a selected class goes in
//   (class granularity). With --granularity 1 (needs --src), a UClass or
//   Blueprint class keeps only the rows whose member name the sources use
//   (`.X`, `->X`, `::X`, `offsetof(T, X)`): code reaches such classes through
//   pointers, so only the members it reads matter, and its size is written as
//   0 (not compared) unless the sources take `sizeof` or `alignof` of it.
//   Script structs and parameter blocks are held by value and keep every row. --sdk adds member sizes and bool masks from the
//   Dumper-7 *_classes.hpp, *_structs.hpp and *_parameters.hpp next to it;
//   without it those columns are 0.
//   The output is deterministic: classes sorted by name, rows by offset then
//   member name, no timestamps, no paths.
//
// compare
//   Reads two generated headers and reports what the new build breaks in the
//   old table, the same test the runtime check applies against live reflection
//   data. Exit codes: 0 nothing broken, 3 at least one row or class broken,
//   2 usage or parse error.
//
// keys
//   Lists a table as the keys `sr-aobscan --layout` reads from a game PDB: each
//   class (its size), then each of its rows as `Class::Member`. Blueprint
//   classes are left out: they are assets, not C++ types, so no PDB has them.
//
// pdb-diff
//   Compares two `sr-aobscan --layout --json` reports of the same key list, one
//   per build, key by key: same, moved (another offset), changed (same offset,
//   another size or bool mask), missing (resolved on the base build only:
//   removed, or renamed), added (resolved on the next build only) and
//   unresolved (on neither). The PDB lookup is by name, so a renamed member
//   counts as missing. --keys compares only the keys in that list (one per
//   line, '#' comments), so one report per build can serve several
//   components. Exit codes: 0 nothing moved, changed or missing; 3 otherwise;
//   2 usage or parse error.
//
// The table format is documented in ci/LAYOUT-TABLE.md.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALIGN, EXIT_ERROR, EXIT_USED_CHANGED, SIZE, isMain, loadLayout, matchUsed, parseUsedList, ParseError } from './layout-diff.mjs';
import { collectLazyMembers, collectMemberNames, collectRequests, collectSizedNames, collectSizeUses, collectUsed, knownFilter } from './used-classes.mjs';

export const FORMAT_VERSION = 1;
const DEFAULT_NAMESPACE = 'SrLayoutTable';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hex = (n) => '0x' + n.toString(16).toUpperCase();

// ---- Dumper-7 headers: member sizes and bool masks --------------------------

const RE_DECL = /^(?:class|struct) (?:(?:SDK_ALIGN|alignas)\(\w+\) )?([A-Za-z0-9_:]+)(?: final)?(?: : public (.+))?$/;
// `<type> <name>[N]... [: bits];  // 0xOFFSET(0xSIZE)(...`; the type may hold spaces.
const RE_MEMBER = /^\t(.*?)\s+(\w+)((?:\[[^\]]*\])*)( : \d+)?;\s+\/\/ 0x([0-9A-Fa-f]+)\(0x([0-9A-Fa-f]+)\)\((.*)$/;
// The comment above every declaration: `// Class Engine.Actor`, `// Function Engine.Foo.Bar`, ...
const RE_KIND = /^\/\/ ([A-Za-z]+) ([A-Za-z0-9_.]+)$/;
const RE_BIT = /^BitIndex: 0x([0-9A-Fa-f]+),/;

// Parse the Dumper-7 declarations in `dir` into Map<class, { kind, path, members: Map<member, {offset, size, mask, bits, reflected}> }>.
// kind and path come from the comment above the declaration (see KIND); path is `Package.Name`, or
// `Package.Class.Function` for a function's parameter struct.
// reflected is false for the members Dumper-7 predefines (UObject::Outer, UStruct::Size, ...): the
// native class has them but UClass->ChildProperties does not.
// size is the whole member: Dumper-7 comments a static array with the size of one element
// (`LineBatchers[0x4]; // 0x00F0(0x0008)`), so it is multiplied by the dimension, the way the
// game reflects ElementSize * ArrayDim.
// mask is the FBoolProperty::FieldMask: 0xFF for a native bool, 1 << BitIndex for a
// bit-field, 0 for everything else. Padding members (Pad_*, BitPad_*) are skipped. Function parameter
// structs are keyed by their bare name, the way Assertions.inl names them.
export const KIND = { unknown: 0, class: 1, struct: 2, function: 3, blueprint: 4 };
const kindOf = (word) => (word === 'Class' ? KIND.class : word === 'Function' ? KIND.function : /BlueprintGeneratedClass$/.test(word) ? KIND.blueprint : /Struct$|^PropertyBag$/.test(word) ? KIND.struct : KIND.unknown);

export function parseSdkHeaders(dir) {
  const classes = new Map();
  for (const file of readdirSync(dir).sort()) {
    const m = /_(classes|structs|parameters)\.hpp$/.exec(file);
    if (!m) continue;
    let members = null;
    let origin = null;
    for (const raw of readFileSync(join(dir, file), 'utf8').split('\n')) {
      const line = raw.replace(/\r$/, '');
      let d;
      if ((d = RE_KIND.exec(line))) {
        origin = { kind: kindOf(d[1]), path: d[2] };
      } else if ((d = RE_DECL.exec(line))) {
        members = new Map();
        classes.set(d[1], { kind: origin?.kind ?? KIND.unknown, path: origin?.path ?? '', base: d[2] ?? null, members });
        origin = null;
      } else if (line.startsWith('};')) {
        members = null;
      } else if (members && (d = RE_MEMBER.exec(line))) {
        const [, type, name, dims, bits, off, size, rest] = d;
        if (rest.startsWith('Fixing ')) continue; // Pad_* and BitPad_*: Dumper-7 padding, not properties
        let count = 1;
        for (const [, dim] of dims.matchAll(/\[([^\]]*)\]/g)) {
          const n = Number(dim);
          if (!Number.isInteger(n) || n <= 0) throw new Error(`${file}: ${name}[${dim}] is not an array dimension the parser can read`);
          count *= n;
        }
        let mask = 0;
        if (bits) {
          const b = RE_BIT.exec(rest);
          mask = b ? 1 << parseInt(b[1], 16) : 0;
        } else if (type === 'bool') {
          mask = 0xff;
        }
        members.set(name, { offset: parseInt(off, 16), size: parseInt(size, 16) * count, mask, bits: !!bits, reflected: !rest.startsWith('NOT AUTO-GENERATED PROPERTY') });
      }
    }
  }
  return classes;
}

// ---- table model ------------------------------------------------------------

// layout: Map<class, Map<member, number>> from layout-diff.mjs; selected: iterable of class names;
// sdk: optional result of parseSdkHeaders. With sdk, a class the headers do not declare (Dumper-7's
// predefined FField, FName, ...) and a member the headers mark as predefined cannot be found through
// reflection, so they are left out and counted in `skipped`.
// Returns { cl, detail, classes: [{ name, sizeOf, alignOf, kind, path, rows: [{ member, offset, size, mask }] }], skipped }.
// usedMembers: optional Set of member names (granularity 1): a UClass or Blueprint class keeps only those rows,
// and its sizeOf and alignOf are written as 0 (not compared) unless its name is in sizedClasses, the types the
// sources take sizeof or alignof of.
// sizeUses: optional Map (granularity 2, from collectSizeUses): structs are narrowed to usedMembers too, and a
// class or struct keeps its sizeOf and alignOf only when its name is in sizeUses; a function's parameter block
// always keeps them.
export function buildTable(layout, selected, { cl, sdk = null, usedMembers = null, sizedClasses = new Set(), sizeUses = null } = {}) {
  if (sizeUses && !usedMembers) throw new Error('sizeUses (granularity 2) needs usedMembers');
  if (!Number.isInteger(cl) || cl <= 0) throw new Error('a build number (--cl) is required');
  const classes = [];
  const skipped = { classes: [], members: 0, unmatched: 0 };
  const wanted = new Set(selected);
  // A derived class's rows say nothing about a base-class member it reads, and its own sizeof can stay
  // the same when two base members swap, so every reflected base of a listed class is listed too.
  if (sdk) {
    for (const n of [...wanted]) {
      for (let b = sdk.get(n)?.base; b && layout.has(b) && !wanted.has(b); b = sdk.get(b)?.base) wanted.add(b);
    }
  }
  for (const name of [...wanted].sort(cmp)) {
    const members = layout.get(name);
    if (!members) throw new Error(`class ${name} is not in the layout`);
    const cls = sdk?.get(name);
    if (sdk && !cls) {
      skipped.classes.push(name);
      continue;
    }
    const rows = new Map();
    for (const [member, offset] of members) {
      if (member === SIZE || member === ALIGN) continue;
      const d = cls?.members.get(member);
      if (d && d.offset !== offset) throw new Error(`${name}.${member}: header offset ${hex(d.offset)} disagrees with Assertions.inl ${hex(offset)}`);
      if (d && !d.reflected) {
        skipped.members++;
        continue;
      }
      if (sdk && !d) skipped.unmatched++;
      rows.set(member, { member, offset, size: d?.size ?? 0, mask: d?.mask ?? 0 });
    }
    // Bit-fields have no offsetof assertion; the headers are the only source.
    for (const [member, d] of cls?.members ?? []) {
      if (d.bits && d.reflected && !rows.has(member)) rows.set(member, { member, offset: d.offset, size: d.size, mask: d.mask });
    }
    const kind = cls?.kind ?? KIND.unknown;
    const narrowed = usedMembers && (kind === KIND.class || kind === KIND.blueprint || (sizeUses && kind === KIND.struct));
    if (narrowed) {
      for (const member of [...rows.keys()]) if (!usedMembers.has(member)) rows.delete(member);
    }
    const sized = !narrowed || (sizeUses ? sizeUses.has(name) : sizedClasses.has(name));
    classes.push({
      name,
      sizeOf: sized ? members.get(SIZE) : 0,
      alignOf: sized ? members.get(ALIGN) ?? 0 : 0,
      kind,
      path: cls?.path ?? '',
      rows: [...rows.values()].sort((a, b) => a.offset - b.offset || cmp(a.member, b.member)),
    });
  }
  // A wrong --sdk directory, or a Dumper-7 line format this parser no longer reads, must not pass for a table.
  if (classes.length === 0) throw new Error('no classes to write' + (sdk ? ': the --sdk directory has none of the selected classes' : ''));
  if (skipped.classes.length * 4 > wanted.size) throw new Error(`${skipped.classes.length} of ${wanted.size} selected classes have no declaration in the --sdk headers (${skipped.classes.slice(0, 8).join(', ')}...); wrong directory or unreadable format`);
  return { cl, detail: sdk ? 1 : 0, granularity: sizeUses ? 2 : usedMembers ? 1 : 0, classes, skipped };
}

const NAME_RE = /^[A-Za-z0-9_:.]+$/;
export const NO_PATH = 0xffffffff;

export function renderHeader(table, { namespace = DEFAULT_NAMESPACE } = {}) {
  if (!/^[A-Za-z_]\w*$/.test(namespace)) throw new Error(`bad namespace '${namespace}'`);
  const pool = new Set();
  for (const c of table.classes) {
    pool.add(c.name);
    if (c.path) pool.add(c.path);
    for (const r of c.rows) pool.add(r.member);
  }
  const names = [...pool].sort(cmp);
  for (const n of names) if (!NAME_RE.test(n)) throw new Error(`name '${n}' cannot be written as a C string literal here`);
  const index = new Map(names.map((n, i) => [n, i]));
  const rowCount = table.classes.reduce((s, c) => s + c.rows.length, 0);

  const out = [];
  out.push('// layout_table.generated.h: generated, do not edit. Plain data, no includes beyond <cstdint>.');
  out.push('// Layout of the used Game-SDK classes at the built CL, for the startup layout check.');
  out.push('#pragma once');
  out.push('');
  out.push('#include <cstdint>');
  out.push('');
  out.push(`namespace ${namespace} {`);
  out.push('');
  out.push(`inline constexpr uint32_t kFormatVersion = ${FORMAT_VERSION};`);
  out.push(`inline constexpr uint32_t kBuiltCL = ${table.cl};`);
  out.push(`inline constexpr uint32_t kDetail = ${table.detail};  // 0: offsets only; 1: Row::size and Row::boolMask are filled`);
  out.push(`inline constexpr uint32_t kGranularity = ${table.granularity ?? 0};  // 0: every member of each class is listed; 1: a UClass lists only the members the sources use; 2: a struct too, and a size only where the sources depend on it`);
  out.push(`inline constexpr uint32_t kNameCount = ${names.length};`);
  out.push(`inline constexpr uint32_t kClassCount = ${table.classes.length};`);
  out.push(`inline constexpr uint32_t kRowCount = ${rowCount};`);
  out.push('');
  out.push('// name: index into kNames. sizeOf/alignOf: sizeof/alignof of the class (0 = not compared). The class owns kRows[firstRow .. firstRow + rowCount).');
  out.push('// kind: 0 unknown, 1 UClass, 2 UScriptStruct, 3 UFunction parameters, 4 Blueprint-generated class. path: index into kNames of the reflection path');
  out.push('// (`Package.Name`, or `Package.Class.Function` for kind 3), or 0xFFFFFFFF when kDetail is 0.');
  out.push('struct Class { uint32_t name; uint32_t sizeOf; uint32_t alignOf; uint32_t firstRow; uint32_t rowCount; uint32_t kind; uint32_t path; };');
  out.push('// name: index into kNames. offset: byte offset. size: total bytes of the member (0 = unknown). boolMask: FBoolProperty::FieldMask (0 = not a bool).');
  out.push('struct Row { uint32_t name; uint32_t offset; uint32_t size; uint32_t boolMask; };');
  out.push('');
  out.push('inline constexpr const char* kNames[kNameCount] = {');
  for (const n of names) out.push(`    "${n}",`);
  out.push('};');
  out.push('');
  out.push('// Sorted by name (code-point order), so a lookup may bisect. Format: { name, sizeOf, alignOf, firstRow, rowCount, kind, path }');
  out.push('inline constexpr Class kClasses[kClassCount] = {');
  let first = 0;
  for (const c of table.classes) {
    out.push(`    {${index.get(c.name)}, ${hex(c.sizeOf)}, ${hex(c.alignOf)}, ${first}, ${c.rows.length}, ${c.kind}, ${c.path ? index.get(c.path) : NO_PATH}},`);
    first += c.rows.length;
  }
  out.push('};');
  out.push('');
  out.push('// Grouped by class in kClasses order, then by offset. Format: { name, offset, size, boolMask }');
  out.push('inline constexpr Row kRows[kRowCount] = {');
  for (const c of table.classes) {
    for (const r of c.rows) out.push(`    {${index.get(r.member)}, ${hex(r.offset)}, ${hex(r.size)}, ${hex(r.mask)}},`);
  }
  out.push('};');
  out.push('');
  out.push(`}  // namespace ${namespace}`);
  return out.join('\n') + '\n';
}

// Read a header written by renderHeader back into a table.
export function parseHeader(text, label = 'input') {
  // A Windows checkout (core.autocrlf) has CRLF line ends.
  text = text.replace(/\r\n/g, '\n');
  const num = (s) => Number(s);
  const grab = (re, what) => {
    const m = re.exec(text);
    if (!m) throw new ParseError(`${label}: ${what} not found (not a layout table?)`);
    return m;
  };
  const version = num(grab(/kFormatVersion = (\d+);/, 'kFormatVersion')[1]);
  if (version !== FORMAT_VERSION) throw new ParseError(`${label}: format version ${version}, expected ${FORMAT_VERSION}`);
  const cl = num(grab(/kBuiltCL = (\d+);/, 'kBuiltCL')[1]);
  const detail = num(grab(/kDetail = (\d+);/, 'kDetail')[1]);
  const block = (name) => {
    const m = new RegExp(`\\b${name}\\[\\w+\\] = \\{\\n([\\s\\S]*?)\\n\\};`).exec(text);
    if (!m) throw new ParseError(`${label}: ${name} not found`);
    return m[1].split('\n');
  };
  const names = block('kNames').map((l, i) => {
    const m = /^\s*"([^"]*)",$/.exec(l);
    if (!m) throw new ParseError(`${label}: kNames line ${i + 1} malformed`);
    return m[1];
  });
  const tuple = (l, n, what) => {
    const m = /^\s*\{(.*)\},$/.exec(l);
    const f = m && m[1].split(',').map((s) => s.trim());
    if (!f || f.length !== n || f.some((s) => !/^(0x[0-9A-Fa-f]+|\d+)$/.test(s))) throw new ParseError(`${label}: malformed ${what} line: ${l.slice(0, 80)}`);
    return f.map(num);
  };
  const rows = block('kRows').map((l) => tuple(l, 4, 'row'));
  const classes = block('kClasses').map((l) => {
    const [name, sizeOf, alignOf, firstRow, rowCount, kind, path] = tuple(l, 7, 'class');
    return {
      name: names[name],
      sizeOf,
      alignOf,
      kind,
      path: path === NO_PATH ? '' : names[path],
      rows: rows.slice(firstRow, firstRow + rowCount).map(([member, offset, size, mask]) => ({ member: names[member], offset, size, mask })),
    };
  });
  return { cl, detail, classes };
}

// ---- compare ------------------------------------------------------------------

// What `next` breaks in `base`: each class and row of `base` must exist in `next` with the same
// values. Rows only in `next` are reported separately and break nothing. A class or member size of 0 means
// unknown and is not compared; size and mask are only compared when both tables have kDetail 1.
export function compareTables(base, next) {
  const nextByName = new Map(next.classes.map((c) => [c.name, c]));
  const broken = []; // { cls, member, kind, old, new }
  const added = [];
  const compareSize = base.detail === 1 && next.detail === 1;
  for (const c of base.classes) {
    const n = nextByName.get(c.name);
    if (!n) {
      broken.push({ cls: c.name, member: null, kind: 'class-missing', old: null, new: null });
      continue;
    }
    if (c.sizeOf !== 0 && n.sizeOf !== 0 && c.sizeOf !== n.sizeOf) broken.push({ cls: c.name, member: SIZE, kind: 'sizeof', old: c.sizeOf, new: n.sizeOf });
    if (c.alignOf !== 0 && n.alignOf !== 0 && c.alignOf !== n.alignOf) broken.push({ cls: c.name, member: ALIGN, kind: 'alignof', old: c.alignOf, new: n.alignOf });
    const nr = new Map(n.rows.map((r) => [r.member, r]));
    for (const r of c.rows) {
      const q = nr.get(r.member);
      if (!q) broken.push({ cls: c.name, member: r.member, kind: 'member-missing', old: r.offset, new: null });
      else {
        if (r.offset !== q.offset) broken.push({ cls: c.name, member: r.member, kind: 'offset', old: r.offset, new: q.offset });
        if (compareSize && r.size !== 0 && q.size !== 0 && r.size !== q.size) broken.push({ cls: c.name, member: r.member, kind: 'size', old: r.size, new: q.size });
        if (compareSize && r.mask !== q.mask) broken.push({ cls: c.name, member: r.member, kind: 'mask', old: r.mask, new: q.mask });
      }
    }
    const had = new Set(c.rows.map((r) => r.member));
    for (const r of n.rows) if (!had.has(r.member)) added.push({ cls: c.name, member: r.member, offset: r.offset });
  }
  const baseNames = new Set(base.classes.map((c) => c.name));
  const classesAdded = next.classes.filter((c) => !baseNames.has(c.name)).map((c) => c.name);
  broken.sort((a, b) => cmp(a.cls, b.cls) || cmp(a.member ?? '', b.member ?? '') || cmp(a.kind, b.kind));
  return {
    baseCL: base.cl,
    nextCL: next.cl,
    brokenClasses: [...new Set(broken.map((b) => b.cls))],
    broken,
    added,
    classesAdded,
  };
}

function formatCompare(r) {
  const v = (x) => (x === null ? '-' : hex(x));
  const lines = [`layout table compare: CL-${r.baseCL} table against CL-${r.nextCL}`];
  for (const c of r.brokenClasses) {
    lines.push(`BROKEN ${c}`);
    for (const b of r.broken.filter((x) => x.cls === c)) {
      if (b.kind === 'class-missing') lines.push('  class missing');
      else lines.push(`  ${b.member === SIZE || b.member === ALIGN ? b.member.slice(1) + 'of' : b.member}: ${b.kind} ${v(b.old)} -> ${v(b.new)}`);
    }
  }
  lines.push(`${r.brokenClasses.length} classes broken, ${r.broken.length} rows; ${r.added.length} members and ${r.classesAdded.length} classes only in the newer table`);
  return lines.join('\n') + '\n';
}

// ---- CLI ----------------------------------------------------------------------

// ---- keys and pdb-diff ----------------------------------------------------------

// The table's classes and rows as `sr-aobscan --layout` keys, one per line.
// The uses file next to a key list (`gen --uses-out`, `keys --uses-out`), read by field-rows.mjs --uses:
//   size <Class> check|compiled   the code depends on the whole size of Class (see collectSizeUses)
//   request <Class::Member>       a field request in the code (SR_FIELD and its wrappers)
//   lazy <Member>                 a PluginLazyField looks Member up by name: optional
// Only classes and keys in the table are listed: a use of something no key names never gates.
export function usesLines(sizeUses, lazy, table, requests = []) {
  const inTable = new Set(table.classes.filter((c) => c.kind !== KIND.blueprint).map((c) => c.name));
  const keys = new Set(tableKeys(table));
  const lines = [];
  for (const k of [...new Set(requests)].sort(cmp)) if (keys.has(k)) lines.push(`request ${k}`);
  for (const [name, how] of [...(sizeUses ?? [])].sort((a, b) => cmp(a[0], b[0]))) if (inTable.has(name)) lines.push(`size ${name} ${how}`);
  for (const m of [...new Set(lazy)].sort(cmp)) lines.push(`lazy ${m}`);
  return lines;
}

export function tableKeys(table) {
  const keys = [];
  for (const c of table.classes) {
    if (c.kind === KIND.blueprint) continue;
    keys.push(c.name);
    for (const r of c.rows) keys.push(`${c.name}::${r.member}`);
  }
  return keys;
}

// Read a `sr-aobscan --layout --json` report: [{ key, result, offset?, size?, boolMask? }].
export function parseLayoutReport(text, label = 'input') {
  let doc;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new ParseError(`${label}: not JSON (${e.message})`);
  }
  if (!doc || !Array.isArray(doc.keys)) throw new ParseError(`${label}: no keys array (not an sr-aobscan --layout report?)`);
  for (const k of doc.keys) {
    if (typeof k?.key !== 'string' || typeof k.result !== 'string') throw new ParseError(`${label}: malformed key entry`);
    if (k.result === 'OK' && !Number.isInteger(k.size)) throw new ParseError(`${label}: ${k.key}: OK without a size`);
  }
  return doc.keys;
}

const PDB_CLASSES = ['same', 'moved', 'changed', 'missing', 'added', 'unresolved'];

// The entries of a report for the given keys, in that order; every key must be in the report.
export function selectKeys(report, keys, label = 'input') {
  const byKey = new Map(report.map((k) => [k.key, k]));
  return keys.map((key) => {
    const k = byKey.get(key);
    if (!k) throw new ParseError(`${label}: no entry for ${key}`);
    return k;
  });
}

// Key-by-key comparison of two reports of the same key list (see pdb-diff above).
// Returns { keys, counts: { same, moved, ... }, moved: [...], changed, missing, added, unresolved }.
export function diffLayoutReports(base, next) {
  if (base.length !== next.length || base.some((k, i) => k.key !== next[i].key)) throw new ParseError('the two reports are not of the same key list');
  const out = Object.fromEntries(PDB_CLASSES.map((c) => [c, []]));
  const fields = (k) => ({ offset: k.offset ?? null, size: k.size, boolMask: k.boolMask ?? null });
  base.forEach((b, i) => {
    const n = next[i];
    const okB = b.result === 'OK';
    const okN = n.result === 'OK';
    if (okB && okN) {
      if ((b.offset ?? null) !== (n.offset ?? null)) out.moved.push({ key: b.key, base: fields(b), next: fields(n) });
      else if (b.size !== n.size || (b.boolMask ?? null) !== (n.boolMask ?? null)) out.changed.push({ key: b.key, base: fields(b), next: fields(n) });
      else out.same.push(b.key);
    } else if (okB) out.missing.push({ key: b.key, base: fields(b), next: n.result });
    else if (okN) out.added.push({ key: b.key, base: b.result, next: fields(n) });
    else out.unresolved.push({ key: b.key, base: b.result, next: n.result });
  });
  const { same, ...listed } = out;
  return { keys: base.length, counts: Object.fromEntries(PDB_CLASSES.map((c) => [c, out[c].length])), ...listed };
}

function formatPdbDiff(r) {
  const h = (f) => (typeof f === 'string' ? f : `${f.offset === null ? '-' : hex(f.offset)}/${hex(f.size)}${f.boolMask ? `/${hex(f.boolMask)}` : ''}`);
  const lines = [`${r.keys} keys: ` + PDB_CLASSES.map((c) => `${r.counts[c]} ${c}`).join(', ')];
  for (const c of PDB_CLASSES.slice(1)) {
    for (const e of r[c]) lines.push(`${c.toUpperCase().padEnd(10)} ${e.key}: ${h(e.base)} -> ${h(e.next)}`);
  }
  return lines.join('\n') + '\n';
}

function parseArgs(argv, valued, repeated = []) {
  const opt = Object.fromEntries(repeated.map((k) => [k, []]));
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!valued.includes(k) && !repeated.includes(k)) throw new Error(`unknown option ${a}`);
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      if (repeated.includes(k)) opt[k].push(argv[++i]);
      else opt[k] = argv[++i];
    } else pos.push(a);
  }
  return { opt, pos };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'gen') {
    const { opt, pos } = parseArgs(rest, ['cl', 'sdk', 'namespace', 'out', 'granularity', 'uses-out'], ['used', 'src']);
    if (pos.length !== 1) throw new Error('usage: layout-table.mjs gen <Assertions.inl> --cl <build> [--used f]... [--src dir]... [--sdk dir] [--granularity 0|1|2] [--out f] [--uses-out f]');
    if (opt.used.length + opt.src.length === 0) throw new Error('give at least one --used list or --src directory');
    const granularity = opt.granularity ?? '0';
    if (!['0', '1', '2'].includes(granularity)) throw new Error('--granularity is 0, 1 or 2');
    if (granularity !== '0' && !opt.src.length) throw new Error(`--granularity ${granularity} reads the member names from --src`);
    if (opt['uses-out'] && !opt.src.length) throw new Error('--uses-out reads the sources from --src');
    const cl = Number(opt.cl);
    const layout = loadLayout(pos[0]);
    const used = new Set();
    for (const f of opt.used) for (const n of parseUsedList(readFileSync(f, 'utf8'))) used.add(n);
    if (opt.src.length) for (const n of collectUsed(opt.src, knownFilter([layout])).names.keys()) used.add(n);
    const { matched, unmatched } = matchUsed(used, layout.keys());
    const usedMembers = granularity !== '0' ? collectMemberNames(opt.src) : null;
    const sizedClasses = granularity === '1' ? collectSizedNames(opt.src) : undefined;
    const sizeUses = granularity === '2' || opt['uses-out'] ? collectSizeUses(opt.src) : null;
    const table = buildTable(layout, matched.keys(), { cl, sdk: opt.sdk ? parseSdkHeaders(opt.sdk) : null, usedMembers, sizedClasses, sizeUses: granularity === '2' ? sizeUses : null });
    const text = renderHeader(table, { namespace: opt.namespace });
    if (opt.out) writeFileSync(opt.out, text);
    if (opt['uses-out']) writeFileSync(opt['uses-out'], usesLines(sizeUses, collectLazyMembers(opt.src), table, collectRequests(opt.src)).join('\n') + '\n');
    else process.stdout.write(text);
    const rows = table.classes.reduce((s, c) => s + c.rows.length, 0);
    process.stderr.write(`layout-table: ${table.classes.length} classes, ${rows} rows, ${text.length} bytes; ${unmatched.length} used names not in the layout${unmatched.length ? ` (${unmatched.join(', ')})` : ''}\n`);
    const sk = table.skipped;
    if (opt.sdk) {
      process.stderr.write(`layout-table: left out ${sk.classes.length} non-reflected classes (${sk.classes.join(', ')}) and ${sk.members} predefined members; ${sk.unmatched} members without a header line (size 0)\n`);
    } else {
      process.stderr.write('layout-table: no --sdk: no sizes or bool masks, and non-reflected classes are still in; use for compare only, never embed\n');
    }
  } else if (cmd === 'compare') {
    const { opt, pos } = parseArgs(rest, ['json']);
    if (pos.length !== 2) throw new Error('usage: layout-table.mjs compare <old.h> <new.h> [--json report.json]');
    const [a, b] = pos.map((p) => parseHeader(readFileSync(p, 'utf8'), p));
    const r = compareTables(a, b);
    process.stdout.write(formatCompare(r));
    if (opt.json) writeFileSync(opt.json, JSON.stringify(r, null, 2) + '\n');
    if (r.broken.length > 0) process.exitCode = EXIT_USED_CHANGED;
  } else if (cmd === 'keys') {
    const { opt, pos } = parseArgs(rest, ['out', 'uses-out']);
    if (pos.length !== 1) throw new Error('usage: layout-table.mjs keys <table.h> [--out keys.txt] [--uses-out uses.txt]');
    const table = parseHeader(readFileSync(pos[0], 'utf8'), pos[0]);
    const text = tableKeys(table).join('\n') + '\n';
    if (opt.out) writeFileSync(opt.out, text);
    else process.stdout.write(text);
    // A committed table carries no source scan: a class it keeps a size for is one the code depends on.
    if (opt['uses-out']) writeFileSync(opt['uses-out'], usesLines(new Map(table.classes.filter((c) => c.sizeOf).map((c) => [c.name, 'compiled'])), [], table).join('\n') + '\n');
  } else if (cmd === 'pdb-diff') {
    const { opt, pos } = parseArgs(rest, ['json', 'keys']);
    if (pos.length !== 2) throw new Error('usage: layout-table.mjs pdb-diff <base.json> <next.json> [--keys keys.txt] [--json report.json]');
    let [a, b] = pos.map((p) => parseLayoutReport(readFileSync(p, 'utf8'), p));
    if (opt.keys) {
      const keys = [...parseUsedList(readFileSync(opt.keys, 'utf8'))];
      if (!keys.length) throw new Error(`${opt.keys}: no keys`);
      [a, b] = [selectKeys(a, keys, pos[0]), selectKeys(b, keys, pos[1])];
    }
    const r = diffLayoutReports(a, b);
    process.stdout.write(formatPdbDiff(r));
    if (opt.json) writeFileSync(opt.json, JSON.stringify(r, null, 2) + '\n');
    if (r.counts.moved + r.counts.changed + r.counts.missing > 0) process.exitCode = EXIT_USED_CHANGED;
  } else {
    throw new Error('usage: layout-table.mjs gen|compare|keys|pdb-diff ...');
  }
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`layout-table: ${e.message}\n`);
    process.exitCode = EXIT_ERROR;
  }
}
