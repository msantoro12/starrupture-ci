// Tests for layout-table.mjs.
//
//   node --test ci/layout-table.test.mjs
//
// Uses the trimmed Assertions.inl fixtures in fixtures/layout (see its README) and
// small header excerpts written here in the Dumper-7 format. With LAYOUT_FULL_DIR set
// to the directory `ci/fetch-layout-fixtures.mjs` fills, the acceptance check also
// runs on the full 126119 and 127004 client files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, loadLayout, matchUsed, parseAssertions, parseUsedList } from './layout-diff.mjs';
import { KIND, buildTable, compareTables, diffLayoutReports, parseHeader, parseLayoutReport, parseSdkHeaders, renderHeader, selectKeys, tableKeys } from './layout-table.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures', 'layout');
const TOOL = join(here, 'layout-table.mjs');
const USED = parseUsedList(readFileSync(join(FIX, 'used-all.txt'), 'utf8'));

function run(...args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function tableFrom(layout, cl, sdk = null) {
  return buildTable(layout, matchUsed(USED, layout.keys()).matched.keys(), { cl, sdk });
}

const fixtureTable = (short, cl) => tableFrom(loadLayout(join(FIX, `Client-${short}.inl`)), cl);
const tmp = () => mkdtempSync(join(tmpdir(), 'layout-table-'));

// A tiny Assertions.inl, as in layout-diff.test.mjs: { name: { size, align, members } }.
function inl(classes) {
  const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(6, '0');
  const lines = ['SDK_NAMESPACE_START'];
  for (const [name, c] of Object.entries(classes)) {
    lines.push(`#define DUMPER7_ASSERTS_${name.replace(/::/g, '_')} \\`);
    lines.push(`static_assert(alignof(${name}) == ${hex(c.align ?? 8)}, "Wrong alignment on ${name}"); \\`);
    lines.push(`static_assert(sizeof(${name}) == ${hex(c.size)}, "Wrong size on ${name}"); \\`);
    for (const [m, off] of Object.entries(c.members ?? {})) {
      lines.push(`static_assert(offsetof(${name}, ${m}) == ${hex(off)}, "Member '${name}::${m}' has a wrong offset!"); \\`);
    }
    lines.push('');
  }
  lines.push('', 'SDK_NAMESPACE_END', '');
  return lines.join('\n');
}

// Header excerpts in the Dumper-7 layout (column padding shortened; the parser does not rely on it).
const CLASSES_HPP = `#pragma once

SDK_NAMESPACE_START

// Class Chimera.CrWidget
// 0x0040 (0x0070 - 0x0030)
#pragma pack(push, 0x1)
class SDK_ALIGN(0x10) UCrWidget : public UObject
{
public:
	bool                                          bEnabled;    // 0x0030(0x0001)(Edit, ZeroConstructor, IsPlainOldData, NoDestructor, HasGetValueTypeHash, NativeAccessSpecifierPublic)
	uint8                                         Pad_31[0x7];    // 0x0031(0x0007)(Fixing Size After Last Property [ Dumper-7 ])
	int32                                         Count[0x4];    // 0x0038(0x0004)(Edit, ZeroConstructor, IsPlainOldData, NoDestructor, HasGetValueTypeHash, NativeAccessSpecifierPublic)
	uint8                                         bLow : 1;    // 0x0048(0x0001)(BitIndex: 0x00, PropSize: 0x0001 (NoDestructor, HasGetValueTypeHash, NativeAccessSpecifierPublic))
	uint8                                         bHigh : 1;    // 0x0048(0x0001)(BitIndex: 0x03, PropSize: 0x0001 (NoDestructor, HasGetValueTypeHash, NativeAccessSpecifierPublic))
	uint8                                         BitPad_48_2 : 1;    // 0x0048(0x0001)(Fixing Bit-Field Size Between Bits [ Dumper-7 ])
	class TArray<struct FCrThing>                 Things;    // 0x0050(0x0010)(Edit, NativeAccessSpecifierPublic)
	class UObject*                                Outer;    // 0x0020(0x0008)(NOT AUTO-GENERATED PROPERTY)

public:
	bool IsEnabled() const;
};
#pragma pack(pop)
DUMPER7_ASSERTS_UCrWidget;

// BlueprintGeneratedClass CrBlueprintWidget.CrBlueprintWidget_C
// 0x0008 (0x0078 - 0x0070)
class UCrBlueprintWidget_C final : public UCrWidget
{
public:
	float                                         Speed;    // 0x0070(0x0004)(Edit, ZeroConstructor, IsPlainOldData, NoDestructor, HasGetValueTypeHash, NativeAccessSpecifierPublic)
};

SDK_NAMESPACE_END
`;
const STRUCTS_HPP = `// ScriptStruct Chimera.CrThing
// 0x0008 (0x0008 - 0x0000)
struct alignas(0x04) FCrThing final
{
public:
	int32                                         A;    // 0x0000(0x0004)(Edit, NativeAccessSpecifierPublic)
	int32                                         B;    // 0x0004(0x0004)(Edit, NativeAccessSpecifierPublic)
};
`;
const PARAMS_HPP = `SDK_PARAM_NAMESPACE_START

// Function Chimera.CrWidget.SetCount
// 0x0008 (0x0008 - 0x0000)
struct CrWidget_SetCount final
{
public:
	int32                                         NewCount;    // 0x0000(0x0004)(Parm, ZeroConstructor, IsPlainOldData, NoDestructor, HasGetValueTypeHash)
	bool                                          ReturnValue;    // 0x0004(0x0001)(Parm, OutParm, ZeroConstructor, ReturnParm, IsPlainOldData, NoDestructor, HasGetValueTypeHash)
	uint8                                         Pad_5[0x3];    // 0x0005(0x0003)(Fixing Size After Last Property [ Dumper-7 ])
};
`;

function writeSdk() {
  const dir = tmp();
  writeFileSync(join(dir, 'Chimera_classes.hpp'), CLASSES_HPP.replace(/\n/g, '\r\n'));
  writeFileSync(join(dir, 'Chimera_structs.hpp'), STRUCTS_HPP);
  writeFileSync(join(dir, 'Chimera_parameters.hpp'), PARAMS_HPP);
  writeFileSync(join(dir, 'Basic.hpp'), 'class FName;\n'); // not a *_classes file: ignored
  return dir;
}

const WIDGET = {
  UCrWidget: { size: 0x70, align: 0x10, members: { bEnabled: 0x30, Count: 0x38, Things: 0x50, Outer: 0x20 } },
  UCrBlueprintWidget_C: { size: 0x78, members: { Speed: 0x70 } },
  FCrThing: { size: 8, align: 4, members: { A: 0, B: 4 } },
  CrWidget_SetCount: { size: 8, align: 4, members: { NewCount: 0, ReturnValue: 4 } },
  FName: { size: 8, members: { ComparisonIndex: 0 } },
};

// ---- header parsing ------------------------------------------------------------

test('header parser: sizes, bool and bit-field masks, kinds and paths; padding and predefined members skipped', () => {
  const sdk = parseSdkHeaders(writeSdk());
  assert.deepEqual([...sdk.keys()].sort(), ['CrWidget_SetCount', 'FCrThing', 'UCrBlueprintWidget_C', 'UCrWidget']);
  const w = sdk.get('UCrWidget');
  assert.equal(w.kind, KIND.class);
  assert.equal(w.path, 'Chimera.CrWidget');
  assert.deepEqual([...w.members.keys()], ['bEnabled', 'Count', 'bLow', 'bHigh', 'Things', 'Outer'], 'Pad_ and BitPad_ members are not rows');
  assert.deepEqual(w.members.get('bEnabled'), { offset: 0x30, size: 1, mask: 0xff, bits: false, reflected: true });
  assert.equal(w.members.get('Count').size, 0x10, 'an array reports its total size');
  assert.equal(w.members.get('bHigh').mask, 1 << 3);
  assert.equal(w.members.get('bHigh').bits, true);
  assert.equal(w.members.get('Things').size, 0x10, 'a template type with spaces still parses');
  assert.equal(w.members.get('Outer').reflected, false);
  assert.equal(sdk.get('UCrBlueprintWidget_C').kind, KIND.blueprint);
  assert.equal(sdk.get('FCrThing').kind, KIND.struct);
  const p = sdk.get('CrWidget_SetCount');
  assert.equal(p.kind, KIND.function);
  assert.equal(p.path, 'Chimera.CrWidget.SetCount');
  assert.equal(p.members.has('Pad_5'), false);
});

test('header parser: a static array is the size of one element times its dimension, as the game reflects it', () => {
  // UWorld::LineBatchers in the 127004 client SDK: Dumper-7 comments the size of one pointer.
  const dir = tmp();
  writeFileSync(join(dir, 'Engine_classes.hpp'), `// Class Engine.World
// 0x08F0 (0x0920 - 0x0030)
class UWorld final : public UObject
{
public:
	class ULineBatchComponent*                    LineBatchers[0x4];                                 // 0x00F0(0x0008)(ExportObject, ZeroConstructor, Transient, InstancedReference, NoDestructor, UObjectWrapper, HasGetValueTypeHash, NativeAccessSpecifierPrivate, TObjectPtr)
	class UPhysicalMaterial*                      PhysicalMaterialMap[0x8];                          // 0x0110(0x0008)(Edit, ZeroConstructor, NoDestructor, UObjectWrapper, HasGetValueTypeHash, NativeAccessSpecifierPublic, TObjectPtr)
	float                                         Scalar;                                            // 0x0150(0x0004)(Edit, ZeroConstructor, IsPlainOldData, NoDestructor, HasGetValueTypeHash, NativeAccessSpecifierPublic)
};
`);
  const w = parseSdkHeaders(dir).get('UWorld');
  assert.equal(w.members.get('LineBatchers').size, 0x20, 'ElementSize 0x8 * ArrayDim 4');
  assert.equal(w.members.get('PhysicalMaterialMap').size, 0x40);
  assert.equal(w.members.get('Scalar').size, 4, 'a plain member keeps the commented size');

  writeFileSync(join(dir, 'Engine_classes.hpp'), `class UWorld final : public UObject
{
	int32                                         Counts[kCount];                                    // 0x00F0(0x0004)(Edit, NativeAccessSpecifierPublic)
};
`);
  assert.throws(() => parseSdkHeaders(dir), /Counts\[kCount\] is not an array dimension/);
});

test('buildTable with headers: sizes and masks filled, bit-fields added, predefined classes and members left out', () => {
  const layout = parseAssertions(inl(WIDGET), 'test');
  const sdk = parseSdkHeaders(writeSdk());
  const t = buildTable(layout, layout.keys(), { cl: 127004, sdk });
  assert.equal(t.detail, 1);
  assert.deepEqual(t.skipped, { classes: ['FName'], members: 1, unmatched: 0 });
  const w = t.classes.find((c) => c.name === 'UCrWidget');
  assert.deepEqual(w.rows.map((r) => r.member), ['bEnabled', 'Count', 'bHigh', 'bLow', 'Things']);
  assert.equal(w.sizeOf, 0x70);
  assert.equal(w.alignOf, 0x10);
  assert.deepEqual(w.rows.find((r) => r.member === 'bLow'), { member: 'bLow', offset: 0x48, size: 1, mask: 1 });
  assert.deepEqual(w.rows.find((r) => r.member === 'bEnabled'), { member: 'bEnabled', offset: 0x30, size: 1, mask: 0xff });
  assert.deepEqual(t.classes.map((c) => c.name), ['CrWidget_SetCount', 'FCrThing', 'UCrBlueprintWidget_C', 'UCrWidget']);
});

test('buildTable with usedMembers (granularity 1): a UClass keeps only the members read; structs and parameter blocks keep every row', () => {
  const layout = parseAssertions(inl(WIDGET), 'test');
  const sdk = parseSdkHeaders(writeSdk());
  const t = buildTable(layout, layout.keys(), { cl: 127004, sdk, usedMembers: new Set(['Count', 'bLow', 'A']) });
  assert.equal(t.granularity, 1);
  const rows = (n) => t.classes.find((c) => c.name === n).rows.map((r) => r.member);
  assert.deepEqual(rows('UCrWidget'), ['Count', 'bLow']);
  assert.deepEqual(rows('UCrBlueprintWidget_C'), []);
  assert.deepEqual(rows('FCrThing'), ['A', 'B']);
  assert.deepEqual(rows('CrWidget_SetCount'), ['NewCount', 'ReturnValue']);
  assert.equal(t.classes.find((c) => c.name === 'UCrWidget').sizeOf, 0x70, 'the class size is still written');
  assert.match(renderHeader(t), /kGranularity = 1;/);
  assert.match(renderHeader(buildTable(layout, layout.keys(), { cl: 127004, sdk })), /kGranularity = 0;/);
});

test('CLI: gen --granularity 1 keeps the members the sources read (., ->, ::; not in comments or strings)', () => {
  const dir = tmp();
  const sdk = writeSdk();
  const asserts = join(dir, 'Assertions.inl');
  writeFileSync(asserts, inl(WIDGET));
  const src = join(dir, 'src');
  mkdirSync(src);
  writeFileSync(join(src, 'a.cpp'), [
    'int f(SDK::UCrWidget* w) { return w->Count[0] + (*w).bLow; } // w->Things',
    'const char* s = "w->bEnabled";',
    '',
  ].join('\n'));
  const out = join(dir, 'out.h');
  const r = run('gen', asserts, '--cl', '9', '--src', src, '--sdk', sdk, '--granularity', '1', '--out', out);
  assert.equal(r.code, 0, r.err);
  const h = parseHeader(readFileSync(out, 'utf8'));
  assert.deepEqual(h.classes.find((c) => c.name === 'UCrWidget').rows.map((x) => x.member), ['Count', 'bLow']);
  assert.equal(run('gen', asserts, '--cl', '9', '--used', join(FIX, 'used-all.txt'), '--granularity', '1').code, 2, 'granularity 1 needs --src');
  assert.equal(run('gen', asserts, '--cl', '9', '--src', src, '--granularity', '2').code, 2);
});

test('buildTable: a header offset that disagrees with Assertions.inl is an error', () => {
  const layout = parseAssertions(inl({ ...WIDGET, UCrWidget: { size: 0x70, members: { bEnabled: 0x34 } } }), 'test');
  assert.throws(() => buildTable(layout, ['UCrWidget'], { cl: 1, sdk: parseSdkHeaders(writeSdk()) }), /disagrees/);
});

test('buildTable: needs a build number and a class that exists', () => {
  const layout = parseAssertions(inl(WIDGET), 'test');
  assert.throws(() => buildTable(layout, ['UCrWidget'], {}), /--cl/);
  assert.throws(() => buildTable(layout, ['UNope'], { cl: 1 }), /not in the layout/);
});

test('buildTable with headers: the reflected base classes of a listed class are listed too', () => {
  const layout = parseAssertions(inl(WIDGET), 'test');
  const t = buildTable(layout, ['UCrBlueprintWidget_C'], { cl: 1, sdk: parseSdkHeaders(writeSdk()) });
  assert.deepEqual(t.classes.map((c) => c.name), ['UCrBlueprintWidget_C', 'UCrWidget']);
  assert.deepEqual(buildTable(layout, ['UCrBlueprintWidget_C'], { cl: 1 }).classes.map((c) => c.name), ['UCrBlueprintWidget_C'], 'no headers, no base links');
});

test('buildTable with headers: a wrong or empty --sdk directory is an error, not an empty table', () => {
  const layout = parseAssertions(inl(WIDGET), 'test');
  const empty = parseSdkHeaders(tmp());
  assert.equal(empty.size, 0);
  assert.throws(() => buildTable(layout, ['UCrWidget', 'FCrThing'], { cl: 1, sdk: empty }), /no classes to write/);
  // Most of the selection without a declaration: the line format changed under the parser.
  const sdk = parseSdkHeaders(writeSdk());
  sdk.delete('FCrThing');
  sdk.delete('UCrBlueprintWidget_C');
  assert.throws(() => buildTable(layout, ['UCrWidget', 'FCrThing', 'UCrBlueprintWidget_C', 'CrWidget_SetCount'], { cl: 1, sdk }), /no declaration/);
});

// ---- rendering ------------------------------------------------------------------

test('the header is deterministic and survives a round trip through parseHeader', () => {
  const layout = parseAssertions(inl(WIDGET), 'test');
  const sdk = parseSdkHeaders(writeSdk());
  const a = renderHeader(buildTable(layout, layout.keys(), { cl: 127004, sdk }));
  const b = renderHeader(buildTable(layout, [...layout.keys()].reverse(), { cl: 127004, sdk }));
  assert.equal(a, b);
  assert.match(a, /kBuiltCL = 127004;/);
  assert.match(a, /^namespace SrLayoutTable \{$/m);
  assert.doesNotMatch(a, /[A-Za-z]:[\\/]|\\Users|Claude|gss/i, 'no paths, tags or process talk');
  const back = parseHeader(a);
  assert.equal(renderHeader(back), a);
  assert.equal(back.cl, 127004);
  assert.equal(back.classes.find((c) => c.name === 'CrWidget_SetCount').path, 'Chimera.CrWidget.SetCount');
  assert.equal(renderHeader(buildTable(layout, layout.keys(), { cl: 1, sdk }), { namespace: 'Foo' }).includes('namespace Foo {'), true);
});

test('without headers the table is offsets only and says so', () => {
  const layout = parseAssertions(inl(WIDGET), 'test');
  const t = buildTable(layout, ['UCrWidget'], { cl: 5 });
  assert.equal(t.detail, 0);
  const text = renderHeader(t);
  assert.match(text, /kDetail = 0;/);
  assert.deepEqual([t.classes[0].kind, t.classes[0].path], [0, ''], 'no kind or path');
  assert.equal(parseHeader(text).classes[0].path, '');
  assert.ok(t.classes[0].rows.every((r) => r.size === 0 && r.mask === 0));
});

test('rendering refuses names it cannot put in a string literal and bad namespaces', () => {
  const layout = parseAssertions(inl({ 'UFoo<int>': { size: 8, members: {} } }), 'test');
  assert.throws(() => renderHeader(buildTable(layout, layout.keys(), { cl: 1 })), /string literal/);
  const ok = parseAssertions(inl({ UFoo: { size: 8, members: {} } }), 'test');
  assert.throws(() => renderHeader(buildTable(ok, ok.keys(), { cl: 1 }), { namespace: 'a b' }), /namespace/);
});

test('parseHeader rejects a file that is not a table and a wrong format version', () => {
  assert.throws(() => parseHeader('int x;'), /not a layout table/);
  const layout = parseAssertions(inl({ UFoo: { size: 8, members: {} } }), 'test');
  const text = renderHeader(buildTable(layout, layout.keys(), { cl: 1 }));
  assert.throws(() => parseHeader(text.replace('kFormatVersion = 1', 'kFormatVersion = 2')), /format version/);
});

// ---- the acceptance case: the 126119 and 127004 client dumps -----------------------

test('fixtures: the 127004 table flags ACrCharacterPlayerBase (ADSMoveSpeed 0x13A8 -> 0x13B8) against the 126119 table', () => {
  const r = compareTables(fixtureTable('0b3c9e6', 126119), fixtureTable('659656c', 127004));
  assert.deepEqual(r.brokenClasses, ['ACrAPHelper', 'ACrCharacterPlayerBase']);
  assert.deepEqual(r.broken.find((b) => b.cls === 'ACrCharacterPlayerBase' && b.member === 'ADSMoveSpeed'), {
    cls: 'ACrCharacterPlayerBase', member: 'ADSMoveSpeed', kind: 'offset', old: 0x13a8, new: 0x13b8,
  });
  assert.deepEqual(r.broken.find((b) => b.cls === 'ACrCharacterPlayerBase' && b.kind === 'sizeof'), {
    cls: 'ACrCharacterPlayerBase', member: '@size', kind: 'sizeof', old: 0x15e0, new: 0x15f0,
  });
});

test('fixtures: a table compared with itself breaks nothing, and the hotfix 125897 -> 126119 breaks no used class', () => {
  const a = fixtureTable('0b3c9e6', 126119);
  assert.equal(compareTables(a, a).broken.length, 0);
  assert.equal(compareTables(fixtureTable('f3eb06b', 125897), a).broken.length, 0);
});

test('fixtures: every transition breaks exactly the used classes the layout diff reports as moved', () => {
  const steps = [['abd0ebd', 125368, 'f3eb06b', 125897], ['f3eb06b', 125897, '0b3c9e6', 126119], ['0b3c9e6', 126119, '659656c', 127004]];
  for (const [o, ocl, n, ncl] of steps) {
    const r = compareTables(fixtureTable(o, ocl), fixtureTable(n, ncl));
    const diff = buildReport(loadLayout(join(FIX, `Client-${o}.inl`)), loadLayout(join(FIX, `Client-${n}.inl`)), USED);
    assert.deepEqual(r.brokenClasses, diff.changedUsed.filter((c) => c.layoutMoved).map((c) => c.class), `${o} -> ${n}`);
  }
});

test('compare: removed class, removed member, size and bool-mask changes break; an added member does not', () => {
  const sdk = parseSdkHeaders(writeSdk());
  const layout = parseAssertions(inl(WIDGET), 'test');
  const base = buildTable(layout, layout.keys(), { cl: 1, sdk });
  const next = structuredClone(base);
  next.cl = 2;
  next.classes = next.classes.filter((c) => c.name !== 'FCrThing');
  const w = next.classes.find((c) => c.name === 'UCrWidget');
  w.rows = w.rows.filter((r) => r.member !== 'Things');
  w.rows.find((r) => r.member === 'bEnabled').mask = 1;
  w.rows.find((r) => r.member === 'Count').size = 8;
  w.rows.push({ member: 'NewField', offset: 0x60, size: 4, mask: 0 });
  const r = compareTables(base, next);
  assert.deepEqual(r.broken.map((b) => `${b.cls}.${b.member}:${b.kind}`), [
    'FCrThing.null:class-missing', 'UCrWidget.Count:size', 'UCrWidget.Things:member-missing', 'UCrWidget.bEnabled:mask',
  ]);
  assert.deepEqual(r.added, [{ cls: 'UCrWidget', member: 'NewField', offset: 0x60 }]);
  // Offsets-only tables do not compare size or mask.
  const flat = (t) => ({ ...t, detail: 0 });
  assert.deepEqual(compareTables(flat(base), flat(next)).broken.map((b) => b.kind), ['class-missing', 'member-missing']);
});

// ---- command line ------------------------------------------------------------------

test('CLI: gen writes the header, compare exits 3 on the 126119 -> 127004 pair and 0 on equal tables', () => {
  const dir = tmp();
  const used = join(FIX, 'used-all.txt');
  const gen = (short, cl) => {
    const out = join(dir, `${short}.h`);
    const r = run('gen', join(FIX, `Client-${short}.inl`), '--cl', String(cl), '--used', used, '--out', out);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /classes, \d+ rows/);
    return out;
  };
  const oldH = gen('0b3c9e6', 126119);
  const newH = gen('659656c', 127004);
  const same = run('compare', oldH, oldH);
  assert.equal(same.code, 0);
  const json = join(dir, 'r.json');
  const diff = run('compare', oldH, newH, '--json', json);
  assert.equal(diff.code, 3, diff.err);
  assert.match(diff.out, /BROKEN ACrCharacterPlayerBase/);
  assert.match(diff.out, /ADSMoveSpeed: offset 0x13A8 -> 0x13B8/);
  assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')).brokenClasses, ['ACrAPHelper', 'ACrCharacterPlayerBase']);
});

test('CLI: gen with --sdk and --src (the source scan), usage errors exit 2', () => {
  const dir = tmp();
  const sdk = writeSdk();
  const asserts = join(dir, 'Assertions.inl');
  writeFileSync(asserts, inl(WIDGET));
  const src = join(dir, 'src');
  mkdirSync(src);
  writeFileSync(join(src, 'a.cpp'), 'void f(SDK::UCrWidget* w, SDK::FCrThing t) {}\n');
  const out = join(dir, 'out.h');
  const r = run('gen', asserts, '--cl', '9', '--src', src, '--sdk', sdk, '--out', out);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(parseHeader(readFileSync(out, 'utf8')).classes.map((c) => c.name), ['FCrThing', 'UCrWidget']);
  const wrong = run('gen', asserts, '--cl', '9', '--src', src, '--sdk', dir, '--out', join(dir, 'wrong.h'));
  assert.equal(wrong.code, 2, 'an --sdk directory without headers fails');
  assert.match(wrong.err, /no classes to write/);
  assert.equal(run('gen', asserts, '--cl', '9').code, 2, 'no used list');
  assert.equal(run('gen', asserts, '--used', join(FIX, 'used-all.txt')).code, 2, 'no --cl');
  assert.equal(run('gen').code, 2);
  assert.equal(run('compare', out).code, 2);
  assert.equal(run('frobnicate').code, 2);
});

// ---- keys and pdb-diff ---------------------------------------------------------------

const report = (entries) => JSON.stringify({ summary: { keys: entries.length }, keys: entries });

test('keys: each class, then its rows as Class::Member; blueprint classes left out; CRLF headers read', () => {
  const table = {
    cl: 9, detail: 1, skipped: { classes: [], members: 0, unmatched: 0 },
    classes: [
      { name: 'ABP_Thing_C', sizeOf: 0x10, alignOf: 8, kind: KIND.blueprint, path: '', rows: [{ member: 'X', offset: 8, size: 4, mask: 0 }] },
      { name: 'UCrWidget', sizeOf: 0x40, alignOf: 8, kind: KIND.class, path: 'Chimera.CrWidget', rows: [{ member: 'A', offset: 0x30, size: 4, mask: 0 }, { member: 'bB', offset: 0x34, size: 1, mask: 1 }] },
    ],
  };
  assert.deepEqual(tableKeys(table), ['UCrWidget', 'UCrWidget::A', 'UCrWidget::bB']);
  const dir = tmp();
  const h = join(dir, 't.h');
  writeFileSync(h, renderHeader(table).replace(/\n/g, '\r\n'));
  const r = run('keys', h);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'UCrWidget\nUCrWidget::A\nUCrWidget::bB\n');
  assert.equal(run('keys').code, 2);
});

test('pdb-diff: same, moved, changed, missing, added and unresolved, key by key', () => {
  const base = parseLayoutReport(report([
    { key: 'A', result: 'OK', size: 0x40 },
    { key: 'A::Same', result: 'OK', offset: 0x30, size: 4, boolMask: 0 },
    { key: 'A::Moved', result: 'OK', offset: 0x34, size: 4, boolMask: 0 },
    { key: 'A::Bit', result: 'OK', offset: 0x38, size: 1, boolMask: 1 },
    { key: 'A::Gone', result: 'OK', offset: 0x3C, size: 4, boolMask: 0 },
    { key: 'A::New', result: 'NOMEMBER' },
    { key: 'B', result: 'NOTYPE' },
  ]));
  const next = parseLayoutReport('﻿' + report([
    { key: 'A', result: 'OK', size: 0x48 },
    { key: 'A::Same', result: 'OK', offset: 0x30, size: 4, boolMask: 0 },
    { key: 'A::Moved', result: 'OK', offset: 0x3C, size: 4, boolMask: 0 },
    { key: 'A::Bit', result: 'OK', offset: 0x38, size: 1, boolMask: 2 },
    { key: 'A::Gone', result: 'NOMEMBER' },
    { key: 'A::New', result: 'OK', offset: 0x40, size: 8, boolMask: 0 },
    { key: 'B', result: 'NOTYPE' },
  ]));
  const r = diffLayoutReports(base, next);
  assert.deepEqual(r.counts, { same: 1, moved: 1, changed: 2, missing: 1, added: 1, unresolved: 1 });
  assert.deepEqual(r.moved, [{ key: 'A::Moved', base: { offset: 0x34, size: 4, boolMask: 0 }, next: { offset: 0x3C, size: 4, boolMask: 0 } }]);
  assert.deepEqual(r.changed.map((e) => e.key), ['A', 'A::Bit'], 'a class size change and a mask change');
  assert.deepEqual(r.missing, [{ key: 'A::Gone', base: { offset: 0x3C, size: 4, boolMask: 0 }, next: 'NOMEMBER' }]);
  assert.equal(r.same, undefined, 'unchanged keys are counted, not listed');
  assert.throws(() => diffLayoutReports(base, next.slice(1)), /same key list/);
  assert.throws(() => parseLayoutReport('{"keys":[{"key":"A","result":"OK"}]}'), /OK without a size/);
  assert.throws(() => parseLayoutReport('[]'), /no keys array/);
  assert.deepEqual(selectKeys(base, ['B', 'A']).map((k) => k.key), ['B', 'A']);
  assert.throws(() => selectKeys(base, ['C']), /no entry for C/);
});

test('CLI: pdb-diff exits 3 on a move, 0 when nothing moved, and --keys narrows the comparison', () => {
  const dir = tmp();
  const a = join(dir, 'a.json');
  const b = join(dir, 'b.json');
  const keys = join(dir, 'keys.txt');
  writeFileSync(a, report([{ key: 'A', result: 'OK', size: 8 }, { key: 'A::X', result: 'OK', offset: 0, size: 4, boolMask: 0 }]));
  writeFileSync(b, report([{ key: 'A', result: 'OK', size: 8 }, { key: 'A::X', result: 'OK', offset: 4, size: 4, boolMask: 0 }]));
  const out = join(dir, 'r.json');
  const moved = run('pdb-diff', a, b, '--json', out);
  assert.equal(moved.code, 3, moved.err);
  assert.match(moved.out, /^2 keys: 1 same, 1 moved/);
  assert.match(moved.out, /MOVED +A::X: 0x0\/0x4 -> 0x4\/0x4/);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).counts.moved, 1);
  writeFileSync(keys, '# only the class\nA\n');
  const narrowed = run('pdb-diff', a, b, '--keys', keys);
  assert.equal(narrowed.code, 0, narrowed.err);
  assert.match(narrowed.out, /^1 keys: 1 same/);
  writeFileSync(keys, 'A::Y\n');
  assert.equal(run('pdb-diff', a, b, '--keys', keys).code, 2, 'a key neither report has');
  assert.equal(run('pdb-diff', a).code, 2);
});

// ---- full data -----------------------------------------------------------------------

const FULL = process.env.LAYOUT_FULL_DIR;

test('full data: 126119 -> 127004 flags ACrCharacterPlayerBase and ACrAPHelper, nothing else among the used classes', { skip: !FULL && 'LAYOUT_FULL_DIR not set' }, () => {
  const t = (short, cl) => tableFrom(loadLayout(join(FULL, `Client-${short}.inl`)), cl);
  const r = compareTables(t('0b3c9e6', 126119), t('659656c', 127004));
  assert.deepEqual(r.brokenClasses, ['ACrAPHelper', 'ACrCharacterPlayerBase']);
  const row = r.broken.find((b) => b.cls === 'ACrCharacterPlayerBase' && b.member === 'ADSMoveSpeed');
  assert.equal(row.old, 0x13a8);
  assert.equal(row.new, 0x13b8);
});
