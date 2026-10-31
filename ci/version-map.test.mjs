// Tests for version-map.mjs.
//
//   node --test ci/version-map.test.mjs
//
// The fixtures in fixtures/version-map were written by the tool itself (the
// commands are the ones the command tests below replay); their numbers are made
// up. Where a C++ compiler is on the PATH (g++ or clang++), the headers are also
// compiled.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FEED_MAX_BYTES, MapError, addAbsent, addBuild, addField, addFunction, checkMap, emit, emptyMap, exportFeed, parse, parseFeed, parseKeys, prune,
  removeKey, replaceBuild, unionKeys,
} from './version-map.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures', 'version-map');
const TOOL = join(here, 'version-map.mjs');
// LF, whatever line ends the checkout gave the files.
const fixture = (name) => readFileSync(join(FIX, name), 'utf8').replace(/\r\n/g, '\n');

function run(...args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const PE = 'BetterCheats/AActor::ProcessEvent caller';
const GO = 'ModLoader/GObjects (GUObjectArray.ObjObjects)';
const BC = 'UCrBuildingComponent::GetPlacementResourceConditionResult';

test('every fixture reads and writes back byte for byte', () => {
  for (const name of ['plugin.h', 'loader.h', 'empty.h']) {
    const text = fixture(name);
    assert.equal(emit(parse(text, name)), text, name);
  }
});

test('the fixtures read as the model they were written from', () => {
  const p = parse(fixture('plugin.h'));
  assert.equal(p.flavour, 'plugin');
  assert.equal(p.builtCL, 127004);
  assert.deepEqual(p.builds.map((b) => b.cl), [127004]);
  assert.equal(p.functions.length, 3);
  assert.deepEqual(p.functions.find((r) => r.key === 'AActor::ProcessEvent caller'),
    { key: 'AActor::ProcessEvent caller', kind: 0, fp: 0, cl: 127004, absent: false, pattern: 'E8 ?? ?? ?? ?? 48 8B 5C 24 ?? 48 83 C4 20', resultOffset: 0, followRel32At: 0, followRipDispAt: -1, rva: 0x00c01230, owners: null });
  assert.equal(p.functions.find((r) => r.key === 'UCrSomething::Function').pattern, null);
  assert.deepEqual(p.fields.find((r) => r.key === 'ACrCharacterPlayerBase::ADSMoveSpeed'),
    { key: 'ACrCharacterPlayerBase::ADSMoveSpeed', cl: 127004, offset: 0x13c8, size: 4, mask: 0, member: 'ADSMoveSpeedScale' });
  assert.equal(p.fields.find((r) => r.key === 'UCrSomething::bFlag').mask, 0x10);
  const l = parse(fixture('loader.h'));
  assert.equal(l.flavour, 'loader');
  assert.deepEqual(l.functions.filter((r) => r.key === GO).map((r) => [r.kind, r.fp, r.followRipDispAt]), [[6, 0x1c4d2e3f, 0], [6, 0x1c4d2e3f, 0]]);
  assert.deepEqual(l.functions.find((r) => r.key === 'UCrSomething::Function' && r.cl === 128786),
    { key: 'UCrSomething::Function', kind: 1, fp: 0, cl: 128786, absent: true, pattern: null, resultOffset: 0, followRel32At: -1, followRipDispAt: -1, rva: 0, owners: ['BetterCheats', 'WAILA'] });
  assert.deepEqual(l.functions.find((r) => r.key === PE && r.cl === 128786 && r.absent), { key: PE, kind: 2, fp: 0xb3405899, cl: 128786, absent: true, pattern: null, resultOffset: 0, followRel32At: -1, followRipDispAt: -1, rva: 0, owners: null });
  assert.equal(l.functions.find((r) => r.key === BC && r.cl === 128786).pattern, null);
});

test('CRLF line ends read as LF', () => {
  for (const name of ['plugin.h', 'loader.h']) {
    const text = fixture(name);
    assert.deepEqual(parse(text.replace(/\n/g, '\r\n')), parse(text));
  }
});

test('anything off the format is refused', () => {
  const p = fixture('plugin.h');
  const l = fixture('loader.h');
  const bad = {
    'a trailing space': [p, p.replace('kBuiltCL = 127004;', 'kBuiltCL = 127004; ')],
    'an extra blank line': [p, p.replace('\n\nnamespace', '\n\n\nnamespace')],
    'no final newline': [p, p.replace(/\n$/, '')],
    'a hand comment': [p, p.replace('#pragma once\n', '#pragma once\n// edited\n')],
    'builds out of order': [l, l.replace(/(\t\{ 127004, [^\n]*\n)(\t\{ 128786, [^\n]*\n)/, '$2$1')],
    'rows out of order': [l, l.replace(/(\t\{ 127004, 0x68F0A1B2, 0x0A3F2000, 4, [^\n]*\n)(\t\{ 128786, [^\n]*\n)/, '$2$1')],
    'fingerprints out of order': [l, l.replace(/(\t\{ 127004, 0x68F0A1B2, 0x0A3F2000, 2, 0x2D1AC6AE[^\n]*\n\t[^\n]*\n)(\t\{ 127004, 0x68F0A1B2, 0x0A3F2000, 2, 0xB3405899[^\n]*\n\t[^\n]*\n)/, '$2$1')],
    'a wrong count': [p, p.replace('std::array<PluginScanCandidate, 3>', 'std::array<PluginScanCandidate, 4>')],
    'a wrong index': [p, p.replace('"UCrBuildingComponent::GetPlacementResourceConditionResult", 1, 1', '"UCrBuildingComponent::GetPlacementResourceConditionResult", 0, 1')],
    "a row stamp that is not its build's": [p, p.replace('{ 127004, 0x68F0A1B2, 0x0A3F2000, "48 89 5C', '{ 127004, 0x68F0A1B3, 0x0A3F2000, "48 89 5C')],
    'a flag that disagrees with followRel32At': [p, p.replace('"48 89 5C 24 ?? 55 56 57 48 8D AC 24", PLUGIN_SCAN_FLAG_NONE', '"48 89 5C 24 ?? 55 56 57 48 8D AC 24", PLUGIN_SCAN_FLAG_FOLLOW_REL32')],
    'a lower-case pattern': [p, p.replace('48 8D AC 24', '48 8d ac 24')],
    'a single-? wildcard': [p, p.replace('48 8D AC 24', '48 8D AC ?')],
    'a lower-case hex number': [p, p.replace('0x13C8', '0x13c8')],
    'a decimal offset': [p, p.replace('0x13C8', '5064')],
    'a row whose CL has no build': [l, l.replace('{ 128786, 0x565, 0x1, 0x10, nullptr }', '{ 128787, 0x565, 0x1, 0x10, nullptr }')],
    'two rows for one key, fp and CL': [l, l.replace(/(\t\{ 128786, 0x6E0[^\n]*\n)/, '$1$1')],
    'a mask wider than a byte': [p, p.replace('0x565, 0x1, 0x10', '0x565, 0x1, 0x110')],
    'format version 1': [p, p.replace('kFormatVersion = 2;', 'kFormatVersion = 1;')],
    'a key comment that disagrees with the index': [p, p.replace('\t// UCrSomething::bFlag', '\t// UCrSomething::bOther')],
    'a plugin map without its include': [p, p.replace('#include "plugin_interface.h"\n', '')],
    'a loader row in a plugin map': [p, p.replace('PLUGIN_SCAN_FLAG_NONE, 0, -1, 0x01A2A100', '0, -1, -1, 0x01A2A100')],
    'a second CL in a plugin map': [p, p.replace('std::array<Build, 1> kBuilds = {{\n\t{ 127004, 0x68F0A1B2, 0x0A3F2000, "public 25646882" },\n',
      'std::array<Build, 2> kBuilds = {{\n\t{ 127004, 0x68F0A1B2, 0x0A3F2000, "public 25646882" },\n\t{ 128786, 0x6A1B2C3D, 0x0A412000, "public_test_branch 26271156" },\n')],
    'a loader map missing its row struct': [l, l.replace(/struct FieldRow[^\n]*\n/, '')],
    'the format 1 loader row struct': [l, l.replace(/int32_t kind; uint32_t fp; bool absent; /, '').replace(/; const char\* owners; \}/, '; }')],
    'a rip follow and a rel32 follow on one row': [l, l.replace('"48 8B 1D ?? ?? ?? ?? 48 85 DB 74 ?? 41 B0 01", 0, -1, 0, 0x0E1A2B30', '"48 8B 1D ?? ?? ?? ?? 48 85 DB 74 ?? 41 B0 01", 0, 3, 0, 0x0E1A2B30')],
    'a scoped row with fp 0': [l, l.replace('2, 0x2D1AC6AE, false, "48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??", 0, -1, -1, 0x00C02240', '2, 0x00000000, false, "48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??", 0, -1, -1, 0x00C02240')],
    'a scoped row with no fp': [l, l.replace('2, 0x2D1AC6AE, false, "48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??", 0, -1, -1, 0x00C02240', '2, false, "48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??", 0, -1, -1, 0x00C02240')],
    'a scoped absent row with fp 0': [l, l.replace('2, 0xB3405899, true', '2, 0x00000000, true')],
    'a global row with an fp': [l, l.replace('4, 0x00000000, false, "48 8B 1D ?? ?? ?? ?? 48 85 DB 74 ?? 41 B0 01", 0, -1, 0, 0x0E2B3C40', '4, 0x00000001, false, "48 8B 1D ?? ?? ?? ?? 48 85 DB 74 ?? 41 B0 01", 0, -1, 0, 0x0E2B3C40')],
    'two kinds under one key': [l, l.replace('{ 128786, 0x6A1B2C3D, 0x0A412000, 4, ', '{ 128786, 0x6A1B2C3D, 0x0A412000, 1, ')],
    'a global kind under a scoped key': [l, l.replace(/, 6, 0x1C4D2E3F, /g, ', 4, 0x1C4D2E3F, ')],
    'a scoped kind under a global key': [l, l.replace(/0x0A3F2000, 4, 0x00000000/, '0x0A3F2000, 2, 0x00000001').replace(/0x0A412000, 4, 0x00000000/, '0x0A412000, 2, 0x00000001')],
    'kind 0': [l, l.replace(/0x0A3F2000, 1, 0x00000000, false, "40 53/, '0x0A3F2000, 0, 0x00000000, false, "40 53')],
    'kind 7': [l, l.replace(/, 6, 0x1C4D2E3F, /g, ', 7, 0x1C4D2E3F, ')],
    'an absent row with a pattern': [l, l.replace('true, nullptr, 0, -1, -1, 0x00000000, "BetterCheats,WAILA"', 'true, "40 53", 0, -1, -1, 0x00000000, "BetterCheats,WAILA"')],
    'an absent row with an rva': [l, l.replace('true, nullptr, 0, -1, -1, 0x00000000, "BetterCheats,WAILA"', 'true, nullptr, 0, -1, -1, 0x01B00020, "BetterCheats,WAILA"')],
    'a global absent row with no owners': [l, l.replace('"BetterCheats,WAILA"', 'nullptr')],
    'owners out of order': [l, l.replace('"BetterCheats,WAILA"', '"WAILA,BetterCheats"')],
    'an owner twice': [l, l.replace('"BetterCheats,WAILA"', '"BetterCheats,BetterCheats"')],
    'an empty owner': [l, l.replace('"BetterCheats,WAILA"', '"BetterCheats,"')],
    'an owner named -': [l, l.replace('"BetterCheats,WAILA"', '"-"')],
    'a scoped absent row with owners': [l, l.replace('2, 0xB3405899, true, nullptr, 0, -1, -1, 0x00000000, nullptr', '2, 0xB3405899, true, nullptr, 0, -1, -1, 0x00000000, "BetterCheats"')],
    'owners on a locator': [l, l.replace('0x01B00010, nullptr', '0x01B00010, "WAILA"')],
  };
  for (const [what, [from, text]] of Object.entries(bad)) {
    assert.notEqual(text, from, `the mutation "${what}" changed nothing`);
    assert.throws(() => parse(text), MapError, what);
  }
});

test('the model refuses rows it cannot write', () => {
  const plugin = emptyMap('plugin', 127004);
  addBuild(plugin, { cl: 127004, stamp: 1, size: 2, source: 'public 1' });
  const loader = emptyMap('loader', 127004);
  addBuild(loader, { cl: 127004, stamp: 1, size: 2, source: 'public 1' });
  addBuild(loader, { cl: 128786, stamp: 3, size: 4, source: 'public_test_branch 2' });
  const bad = [
    () => addBuild(plugin, { cl: 127004, stamp: 9, size: 2, source: 'public 1' }),
    () => addBuild(emptyMap('loader', 127004), { cl: 128786, stamp: 1, size: 2, source: 'has "quotes"' }),
    () => addBuild(plugin, { cl: 128786, stamp: 1, size: 2, source: 'public_test_branch 2' }),
    () => addFunction(plugin, { key: 'K', cl: 128786, pattern: '48', rva: 1 }),
    () => addFunction(plugin, { key: 'K', cl: 127004, pattern: null, rva: 0 }),
    () => addFunction(plugin, { key: 'K', cl: 127004, pattern: '48', rva: 1, followRipDispAt: 0 }),
    () => addFunction(plugin, { key: 'back\\slash', cl: 127004, pattern: '48', rva: 1 }),
    () => addFunction(plugin, { key: 'K', cl: 127004, pattern: '48', rva: 1, kind: 1 }),
    () => addAbsent(plugin, { key: 'K', cl: 127004, kind: 1, owners: ['P'] }),
    () => addFunction(loader, { key: 'K', cl: 127004, pattern: '48', rva: 1 }),
    () => addFunction(loader, { key: 'P/K', cl: 127004, kind: 2, pattern: '48', rva: 1 }),
    () => addFunction(loader, { key: 'P/K', cl: 127004, kind: 2, fp: 0, pattern: '48', rva: 1 }),
    () => addFunction(loader, { key: 'K', cl: 127004, kind: 3, fp: 5, pattern: '48', rva: 1 }),
    () => addFunction(loader, { key: '/K', cl: 127004, kind: 2, fp: 5, pattern: '48', rva: 1 }),
    () => addFunction(loader, { key: 'P,Q/K', cl: 127004, kind: 2, fp: 5, pattern: '48', rva: 1 }),
    () => addFunction(loader, { key: 'P/K', cl: 127004, kind: 1, pattern: '48', rva: 1 }),
    () => addFunction(loader, { key: 'K', cl: 127004, kind: 4, fp: 5, pattern: '48', rva: 1 }),
    () => addAbsent(loader, { key: 'K', cl: 127004, kind: 1 }),
    () => addAbsent(loader, { key: 'K', cl: 127004, kind: 1, owners: ['A,B'] }),
    () => addAbsent(loader, { key: 'K', cl: 127004, kind: 1, owners: ['-'] }),
    () => addAbsent(loader, { key: 'K', cl: 127004, kind: 1, owners: ['A/B'] }),
    () => addAbsent(loader, { key: 'P/K', cl: 127004, kind: 2, fp: 5, owners: ['P'] }),
    () => addAbsent(loader, { key: 'P/K', cl: 127004, kind: 2 }),
    () => addField(plugin, { key: 'F', cl: 127004, offset: 0x10, size: 0 }),
    () => addField(plugin, { key: 'F', cl: 127004, offset: 0x10, size: 4, member: 'not a name' }),
    () => addField(plugin, { key: 'F', cl: 127004, offset: 0x10, size: 4, mask: 0x11 }),
    () => emptyMap('server', 127004),
  ];
  for (const f of bad) assert.throws(f, MapError, f.toString());
});

test('adding a row twice changes nothing; adding another value for it is refused', () => {
  const map = emptyMap('loader', 127004);
  assert.equal(addBuild(map, { cl: 127004, stamp: 1, size: 2, source: 'public 1' }), true);
  assert.equal(addBuild(map, { cl: 127004, stamp: 1, size: 2, source: 'public 1' }), false);
  assert.equal(addFunction(map, { key: 'K', kind: 1, cl: 127004, pattern: '48 ??', rva: 0x10 }), true);
  assert.equal(addFunction(map, { key: 'K', kind: 1, cl: 127004, pattern: '48 ??', rva: 0x10 }), false);
  assert.throws(() => addFunction(map, { key: 'K', kind: 1, cl: 127004, pattern: '48 ??', rva: 0x20 }), MapError);
  assert.equal(addField(map, { key: 'F', cl: 127004, offset: 8, size: 4 }), true);
  assert.equal(addField(map, { key: 'F', cl: 127004, offset: 8, size: 4 }), false);
  assert.throws(() => addField(map, { key: 'F', cl: 127004, offset: 12, size: 4 }), MapError);
  assert.equal(map.functions.length + map.fields.length, 2);
});

test('only a verified row replaces an absent one; absent never replaces a verified row', () => {
  const map = emptyMap('loader', 127004);
  addBuild(map, { cl: 127004, stamp: 1, size: 2, source: 'public 1' });
  // A global key: an absent row adds owners, a locator replaces it, an absent add onto the locator is refused.
  assert.equal(addAbsent(map, { key: 'K', kind: 1, cl: 127004, owners: ['WAILA'] }), true);
  assert.equal(addAbsent(map, { key: 'K', kind: 1, cl: 127004, owners: ['WAILA'] }), false);
  assert.equal(addAbsent(map, { key: 'K', kind: 1, cl: 127004, owners: ['BetterCheats'] }), true);
  assert.deepEqual(map.functions[0].owners, ['BetterCheats', 'WAILA']);
  assert.throws(() => addAbsent(map, { key: 'K', kind: 4, cl: 127004, owners: ['WAILA'] }), MapError);
  assert.throws(() => addFunction(map, { key: 'K', kind: 4, cl: 127004, pattern: '48', rva: 0x10 }), MapError);
  assert.equal(addFunction(map, { key: 'K', kind: 1, cl: 127004, pattern: '48', rva: 0x10 }), true);
  assert.deepEqual(map.functions.map((r) => [r.absent, r.owners]), [[false, null]]);
  assert.throws(() => addAbsent(map, { key: 'K', kind: 1, cl: 127004, owners: ['WAILA'] }), MapError);
  // A scoped key: an absent row guards its own fp only.
  assert.equal(addFunction(map, { key: 'P/S', kind: 2, fp: 7, cl: 127004, pattern: '48', rva: 0x20 }), true);
  assert.equal(addAbsent(map, { key: 'P/S', kind: 2, fp: 9, cl: 127004 }), true);
  assert.equal(addAbsent(map, { key: 'P/S', kind: 2, fp: 9, cl: 127004 }), false);
  assert.throws(() => addAbsent(map, { key: 'P/S', kind: 2, fp: 7, cl: 127004 }), MapError);
  assert.equal(addFunction(map, { key: 'P/S', kind: 2, fp: 9, cl: 127004, pattern: '48 8B', rva: 0x30 }), true);
  assert.deepEqual(map.functions.filter((r) => r.key === 'P/S').map((r) => [r.fp, r.absent, r.rva]), [[7, false, 0x20], [9, false, 0x30]]);
  assert.equal(emit(parse(emit(map))), emit(map));
});

test('one scoped key with two fps on one exe keeps both rows through a round-trip and an export', () => {
  const map = parse(fixture('loader.h'));
  const rows = (m) => m.functions.filter((r) => r.key === PE && r.cl === 127004).map((r) => [r.fp, r.rva, r.pattern]);
  const want = [[0x2d1ac6ae, 0x00c01230, '48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??'], [0xb3405899, 0x00c01230, '?? ?? ?? ?? 48 85 C0 74']];
  assert.deepEqual(rows(map), want);
  assert.deepEqual(rows(parse(emit(map))), want);
  assert.deepEqual(rows(parseFeed(exportFeed(map))), want);
});

test('the feed: the fixture export, byte-identical twice, and it parses back equal', () => {
  const map = parse(fixture('loader.h'));
  const feed = exportFeed(map);
  assert.equal(feed, fixture('loader.feed.txt'));
  assert.equal(exportFeed(parse(fixture('loader.h'))), feed);
  assert.ok(feed.startsWith('format\t1\n') && feed.endsWith('\n') && !feed.includes('\r'));
  const back = parseFeed(feed);
  assert.deepEqual({ builds: back.builds, functions: back.functions, fields: back.fields }, { builds: map.builds, functions: map.functions, fields: map.fields });
  assert.equal(exportFeed(back), feed);
  // The same rows added in another order give the same feed.
  const shuffled = { ...map, builds: [...map.builds].reverse(), functions: [...map.functions].reverse(), fields: [...map.fields].reverse() };
  assert.equal(exportFeed(shuffled), feed);
  assert.throws(() => exportFeed(parse(fixture('plugin.h'))), MapError);
});

test('the feed parse refuses anything off the format', () => {
  const f = fixture('loader.feed.txt');
  const line = (start) => f.split('\n').find((l) => l.startsWith(start));
  const scoped = line(`function\t${PE}\t0x2D1AC6AE\t128786`);
  const bad = {
    'a scoped row with fp 0': f.replace(scoped, scoped.replace('0x2D1AC6AE', '0x00000000')),
    'a scoped row with no fp': f.replace(scoped, scoped.replace('\t0x2D1AC6AE', '')),
    'a scoped row with fp -': f.replace(scoped, scoped.replace('0x2D1AC6AE', '-')),
    'a scoped absent row with fp 0': f.replace(`absent\t${PE}\t0xB3405899`, `absent\t${PE}\t0x00000000`),
    'a global row with an fp': f.replace('function\tGWorld\t0x00000000\t128786', 'function\tGWorld\t0x00000001\t128786'),
    'CRLF': f.replace(/\n/g, '\r\n'),
    'no final newline': f.replace(/\n$/, ''),
    'a blank line': f.replace('\nfield', '\n\nfield'),
    'another format': f.replace('format\t1', 'format\t2'),
    'a space for a tab': f.replace('format\t1', 'format 1'),
    'a sig line': `${f}sig\tk1\tAAAA\n`,
    'an unknown line': f.replace('\nfield', '\nseq\t1\nfield'),
    'a trailing tab': f.replace(scoped, `${scoped}\t`),
    'lines out of order': f.replace(/(build\t127004[^\n]*\n)(build\t128786[^\n]*\n)/, '$2$1'),
    'fingerprints out of order': f.replace(/(function\tBetterCheats[^\n]*\t0x2D1AC6AE\t127004[^\n]*\n)(function\tBetterCheats[^\n]*\t0x2D1AC6AE\t128786[^\n]*\n)(function\tBetterCheats[^\n]*\t0xB3405899[^\n]*\n)/, '$3$1$2'),
    "a row stamp that is not its build's": f.replace(scoped, scoped.replace('0x6A1B2C3D', '0x6A1B2C3E')),
    'a lower-case hex number': f.replace('0x13C8', '0x13c8'),
    'a row whose CL has no build': f.replace('field\tUCrSomething::bFlag\t128786', 'field\tUCrSomething::bFlag\t128787'),
    'two kinds under one key': f.replace('function\tGWorld\t0x00000000\t128786\t0x6A1B2C3D\t0x0A412000\t4', 'function\tGWorld\t0x00000000\t128786\t0x6A1B2C3D\t0x0A412000\t1'),
    'a global absent row with no owners': f.replace('\tBetterCheats,WAILA\n', '\t-\n'),
    'owners out of order': f.replace('BetterCheats,WAILA', 'WAILA,BetterCheats'),
    'a pattern on an absent line': f.replace('\tBetterCheats,WAILA\n', '\t40 53\t0\t-1\t-1\t0x00000000\n'),
  };
  for (const [what, text] of Object.entries(bad)) {
    assert.notEqual(text, f, `the mutation "${what}" changed nothing`);
    assert.throws(() => parseFeed(text), MapError, what);
  }
});

test('export-feed refuses a feed over its size cap', () => {
  const map = emptyMap('loader', 127004);
  addBuild(map, { cl: 127004, stamp: 1, size: 2, source: 'public 1' });
  const pattern = Array(40).fill('48').join(' ');
  const row = (i) => ({ key: `Key${String(i).padStart(6, '0')}::Function`, kind: 1, fp: 0, cl: 127004, absent: false, pattern, resultOffset: 0, followRel32At: -1, followRipDispAt: -1, rva: i + 1, owners: null });
  map.functions.push(row(0));
  const line = Buffer.byteLength(exportFeed(map).split('\n').at(-2)) + 1;
  const fits = Math.floor((FEED_MAX_BYTES - Buffer.byteLength(exportFeed(map))) / line);
  for (let i = 1; i <= fits; i++) map.functions.push(row(i));
  assert.ok(Buffer.byteLength(exportFeed(map)) <= FEED_MAX_BYTES);
  map.functions.push(row(fits + 1));
  assert.throws(() => exportFeed(map), MapError);
});

test('prune keeps the builds listed and drops the rest with their rows', () => {
  const map = parse(fixture('loader.h'));
  assert.deepEqual(prune(map, [128786]), { builds: 1, functions: 6, fields: 1 });
  assert.deepEqual(map.builds.map((b) => b.cl), [128786]);
  assert.ok([...map.functions, ...map.fields].every((r) => r.cl === 128786));
  assert.throws(() => prune(parse(fixture('loader.h')), [130001]), MapError);
  assert.equal(emit(parse(emit(map))), emit(map));
});

test('replace-build records a new exe for a CL and drops that CL\'s rows', () => {
  const map = parse(fixture('loader.h'));
  assert.equal(replaceBuild(map, { cl: 128786, stamp: 0x6a1b2c3e, size: 0x0a412000, source: 'public 26300000' }), 9);
  assert.deepEqual(map.builds.find((b) => b.cl === 128786), { cl: 128786, stamp: 0x6a1b2c3e, size: 0x0a412000, source: 'public 26300000' });
  assert.ok([...map.functions, ...map.fields].every((r) => r.cl === 127004));
  assert.throws(() => replaceBuild(map, { cl: 130001, stamp: 1, size: 2, source: 'public 1' }), MapError);
  assert.equal(emit(parse(emit(map))), emit(map));
  const plugin = parse(fixture('plugin.h'));
  assert.equal(replaceBuild(plugin, { cl: 127004, stamp: 0x68f0a1b3, size: 0x0a3f2000, source: 'public 25700000' }), 6);
});

test('remove-key drops a key on every build and every fp', () => {
  const map = parse(fixture('loader.h'));
  assert.deepEqual(removeKey(map, PE), { functions: 4, fields: 0 });
  assert.deepEqual(removeKey(map, 'ACrCrafter::CraftComponent'), { functions: 0, fields: 2 });
  assert.throws(() => removeKey(map, PE), MapError);
  const keys = parseKeys(LOADER_KEYS.replace(`function ${PE}\n`, '').replace(/native [^\n]*\n/, ''));
  assert.deepEqual(checkMap(map, keys), []);
});

const PLUGIN_KEYS = `# the plugin fixture's keys
function AActor::ProcessEvent caller
function UCrBuildingComponent::GetPlacementResourceConditionResult
function UCrSomething::Function
native ACrPackageTransportReplicator::Native2C0 0x2C0 0x8 0x0
field ACrCharacterPlayerBase::ADSMoveSpeed
field UCrSomething::bFlag
`;

// The loader fixture's keys, as one list; the command test splits them over two.
const LOADER_KEYS = `# the loader fixture's keys
required GWorld
required ${GO}
function ${PE}
function ${BC}
function UCrSomething::Function
native ACrCrafter::CraftComponent 0x6D8 0x8 0x0
field ACrCharacterPlayerBase::ADSMoveSpeed
field UCrSomething::bFlag
`;

test('check: a complete map passes', () => {
  assert.deepEqual(checkMap(parse(fixture('plugin.h')), parseKeys(PLUGIN_KEYS)), []);
  assert.deepEqual(checkMap(parse(fixture('loader.h')), parseKeys(LOADER_KEYS)), []);
});

test('check: the built CL must have a build row', () => {
  assert.deepEqual(checkMap(parse(fixture('empty.h')), parseKeys('')), ['the built CL-127004 has no build row']);
  const map = parse(fixture('loader.h'));
  prune(map, [128786]);
  assert.ok(checkMap(map, parseKeys(LOADER_KEYS)).includes('the built CL-127004 has no build row'));
});

test('check: missing coverage, orphan keys and a built-CL mismatch are each reported', () => {
  const keys = parseKeys(LOADER_KEYS.replace('function UCrSomething::Function\n', '') + 'function New::Hook\nnative New::Native\n');
  const map = parse(fixture('loader.h'));
  map.fields.find((r) => r.key === 'ACrCrafter::CraftComponent' && r.cl === 127004).offset = 0x6D0;
  map.functions = map.functions.filter((r) => !(r.key === PE && r.fp === 0x2d1ac6ae && r.cl === 128786));
  assert.deepEqual(checkMap(map, keys), [
    'orphan function key UCrSomething::Function: no key list has it',
    'no function row for New::Hook on CL-127004',
    'no native field row for New::Native on CL-127004',
    'no function row for BetterCheats/AActor::ProcessEvent caller (fp 0x2D1AC6AE) on CL-128786',
    'no function row for New::Hook on CL-128786',
    'no native field row for New::Native on CL-128786',
    'native field ACrCrafter::CraftComponent on the built CL-127004: the row says 0x6D0/0x8/0x00, the code was built with 0x6D8/0x8/0x00',
  ]);
  assert.deepEqual(checkMap(parse(fixture('loader.h')), parseKeys(LOADER_KEYS.replace('field UCrSomething::bFlag\n', ''))), [
    'orphan field key UCrSomething::bFlag: no key list has it',
  ]);
});

test('check: an absent row for a required global loader key is refused', () => {
  const map = parse(fixture('loader.h'));
  assert.deepEqual(checkMap(map, parseKeys(LOADER_KEYS.replace('function UCrSomething::Function', 'required UCrSomething::Function'))), [
    'required key UCrSomething::Function is absent on CL-128786: the loader needs a locator there',
  ]);
  // A required scoped key's absent row is the writer's to judge (which fp is the newest release's), not check's.
  assert.deepEqual(checkMap(map, parseKeys(LOADER_KEYS.replace(`function ${PE}`, `required ${PE}`))), []);
});

test('check: the keys of several lists are taken together', () => {
  const [a, b] = [parseKeys('required GWorld\nnative N::A 0x10 0x4 0x0\nfield F::A\n', 'a.txt'), parseKeys('function GWorld\nfunction P/K\nnative N::A\nfield F::A\n', 'b.txt')];
  const u = unionKeys([a, b]);
  assert.deepEqual([...u.functions].sort(), ['GWorld', 'P/K']);
  assert.deepEqual([...u.required], ['GWorld']);
  assert.deepEqual(u.native.get('N::A'), { offset: 0x10, size: 4, mask: 0 });
  assert.deepEqual(unionKeys([b, a]).native.get('N::A'), { offset: 0x10, size: 4, mask: 0 });
  assert.deepEqual([...u.fields], ['F::A']);
  for (const [x, y] of [['function K', 'field K'], ['required K', 'native K'], ['native K', 'field K'], ['native K 0x10 0x4 0x0', 'native K 0x14 0x4 0x0']]) {
    assert.throws(() => unionKeys([parseKeys(x, 'a.txt'), parseKeys(y, 'b.txt')]), MapError, `${x} / ${y}`);
  }
});

test('the keys file refuses what it cannot read', () => {
  for (const text of ['hook K', 'function', 'function K\nfunction K', 'function K\nrequired K', 'field F 0x1 0x2 0x3', 'required K 0x1 0x2 0x3', 'native back\\slash',
    'native A::B 0x10 0x4', 'native A::B 0x10', 'native A::B 0x10 0x4 0x1FF', 'native A::B 0x10 0x4 0x01', 'native A::B 0x10 0x0 0x00']) {
    assert.throws(() => parseKeys(text), MapError, text);
  }
  const k = parseKeys('function StaticFindObject (ByPath)\nrequired GWorld\nnative A::B\nnative C::D 0x10 0x1 0xFF\n');
  assert.ok(k.functions.has('StaticFindObject (ByPath)'));
  assert.ok(k.functions.has('GWorld') && k.required.has('GWorld') && !k.required.has('StaticFindObject (ByPath)'));
  assert.equal(k.native.get('A::B'), null);
  assert.deepEqual(k.native.get('C::D'), { offset: 0x10, size: 1, mask: 0xff });
});

function commands() {
  const dir = mkdtempSync(join(tmpdir(), 'version-map-'));
  const ok = (...args) => {
    const r = run(...args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}${r.out}`);
    return r;
  };
  return { dir, ok };
}

test('the commands build the plugin fixture and check it', () => {
  const { dir, ok } = commands();
  const h = join(dir, 'version_map.generated.h');
  const keys = join(dir, 'keys.txt');
  writeFileSync(keys, PLUGIN_KEYS);
  ok('init', h, '--flavour', 'plugin', '--built-cl', '127004');
  assert.equal(run('init', h, '--flavour', 'plugin', '--built-cl', '127004').code, 2);
  // A plugin map holds its built CL only.
  assert.equal(run('add-build', h, '--cl', '128786', '--stamp', '0x6A1B2C3D', '--size', '0x0A412000', '--source', 'public_test_branch 26271156').code, 2);
  ok('add-build', h, '--cl', '127004', '--stamp', '0x68F0A1B2', '--size', '0x0A3F2000', '--source', 'public 25646882');
  ok('add-function', h, '--key', 'AActor::ProcessEvent caller', '--cl', '127004', '--pattern', 'E8 ?? ?? ?? ?? 48 8B 5C 24 ?? 48 83 C4 20', '--follow-rel32-at', '0', '--rva', '0x00C01230');
  ok('add-function', h, '--key', 'UCrBuildingComponent::GetPlacementResourceConditionResult', '--cl', '127004', '--pattern', '48 89 5C 24 ?? 55 56 57 48 8D AC 24', '--rva', '0x01A2A100');
  // Before the rest of the rows: check reports the gaps.
  const partial = run('check', h, '--keys', keys);
  assert.equal(partial.code, 3, partial.err);
  assert.match(partial.out, /no function row for UCrSomething::Function on CL-127004/);
  ok('add-function', h, '--key', 'UCrSomething::Function', '--cl', '127004', '--rva-only', '--rva', '0x01B00010');
  ok('add-field', h, '--key', 'ACrPackageTransportReplicator::Native2C0', '--cl', '127004', '--offset', '0x2C0', '--size', '0x8');
  ok('add-field', h, '--key', 'UCrSomething::bFlag', '--cl', '127004', '--offset', '0x565', '--size', '0x1', '--mask', '0x10');
  ok('add-field', h, '--key', 'ACrCharacterPlayerBase::ADSMoveSpeed', '--cl', '127004', '--offset', '0x13C8', '--size', '0x4', '--member', 'ADSMoveSpeedScale');
  assert.equal(readFileSync(h, 'utf8'), fixture('plugin.h'));
  assert.match(ok('check', h, '--keys', keys).out, /0 coverage problems/);
  assert.match(ok('check', h).out, /format only/);
  // The same row again is a no-op; another value for it is refused and leaves the file alone.
  ok('add-field', h, '--key', 'UCrSomething::bFlag', '--cl', '127004', '--offset', '0x565', '--size', '0x1', '--mask', '0x10');
  assert.equal(run('add-field', h, '--key', 'UCrSomething::bFlag', '--cl', '127004', '--offset', '0x566', '--size', '0x1', '--mask', '0x10').code, 2);
  assert.equal(readFileSync(h, 'utf8'), fixture('plugin.h'));
  // Usage errors, and what only the loader map has.
  assert.equal(run('add-function', h, '--key', 'K', '--cl', '127004', '--rva', '0x10').code, 2);
  assert.equal(run('add-function', h, '--key', 'K', '--cl', '127004', '--rva-only', '--rva', '0x10', '--kind', '1').code, 2);
  assert.equal(run('add-absent', h, '--key', 'K', '--cl', '127004', '--kind', '1', '--owners', 'P').code, 2);
  assert.equal(run('export-feed', h, '--out', join(dir, 'feed.txt')).code, 2);
  assert.equal(run('add-field', h, '--key', 'K', '--cl', '127004', '--offset', '16', '--size', '0x4').code, 2);
  assert.equal(run('add-field', h, '--key', 'K', '--key', 'L', '--cl', '127004', '--offset', '0x10', '--size', '0x4').code, 2);
  assert.equal(run('check', h, '--bogus', 'x').code, 2);
  assert.equal(run('prune', h, '--keep', '130001').code, 2);
  assert.equal(run('remove-key', h, '--key', 'No::Such').code, 2);
  assert.equal(run('replace-build', h, '--cl', '130001', '--stamp', '0x1', '--size', '0x2', '--source', 'public 1').code, 2);
  assert.equal(readFileSync(h, 'utf8'), fixture('plugin.h'));
  // A hand edit makes every command refuse the file.
  writeFileSync(h, fixture('plugin.h').replace('0x2C0', '0x2c0'));
  assert.equal(run('check', h).code, 2);
  writeFileSync(h, fixture('plugin.h'));
  ok('remove-key', h, '--key', 'UCrSomething::bFlag');
  ok('replace-build', h, '--cl', '127004', '--stamp', '0x68F0A1B3', '--size', '0x0A3F2000', '--source', 'public 25700000');
  assert.match(ok('check', h).out, /1 builds, 0 function rows, 0 field rows/);
  ok('prune', h, '--keep', '127004');
});

test('the commands build the loader fixture, check it over two key lists, and export the feed', () => {
  const { dir, ok } = commands();
  const h = join(dir, 'version_map.generated.h');
  const [loaderKeys, pluginKeys, feed] = [join(dir, 'loader-keys.txt'), join(dir, 'plugin-keys.txt'), join(dir, 'feed.txt')];
  writeFileSync(loaderKeys, `required GWorld\nrequired ${GO}\nnative ACrCrafter::CraftComponent 0x6D8 0x8 0x0\n`);
  writeFileSync(pluginKeys, `function GWorld\nfunction ${PE}\nfunction ${BC}\nfunction UCrSomething::Function\nnative ACrCrafter::CraftComponent\nfield ACrCharacterPlayerBase::ADSMoveSpeed\nfield UCrSomething::bFlag\n`);
  ok('init', h, '--flavour', 'loader', '--built-cl', '127004');
  ok('add-build', h, '--cl', '128786', '--stamp', '0x6A1B2C3D', '--size', '0x0A412000', '--source', 'public_test_branch 26271156');
  ok('add-build', h, '--cl', '127004', '--stamp', '0x68F0A1B2', '--size', '0x0A3F2000', '--source', 'public 25646882');
  ok('add-function', h, '--key', PE, '--kind', '2', '--fp', '0x2D1AC6AE', '--cl', '127004', '--pattern', '48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??', '--rva', '0x00C01230');
  ok('add-function', h, '--key', PE, '--kind', '2', '--fp', '0x2D1AC6AE', '--cl', '128786', '--pattern', '48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??', '--rva', '0x00C02240');
  ok('add-function', h, '--key', PE, '--kind', '2', '--fp', '0xB3405899', '--cl', '127004', '--pattern', '?? ?? ?? ?? 48 85 C0 74', '--result-offset', '-4', '--rva', '0x00C01230');
  ok('add-absent', h, '--key', PE, '--kind', '2', '--fp', '0xB3405899', '--cl', '128786');
  ok('add-function', h, '--key', 'GWorld', '--kind', '4', '--cl', '127004', '--pattern', '48 8B 1D ?? ?? ?? ?? 48 85 DB 74 ?? 41 B0 01', '--follow-rip-disp-at', '0', '--rva', '0x0E1A2B30');
  ok('add-function', h, '--key', 'GWorld', '--kind', '4', '--cl', '128786', '--pattern', '48 8B 1D ?? ?? ?? ?? 48 85 DB 74 ?? 41 B0 01', '--follow-rip-disp-at', '0', '--rva', '0x0E2B3C40');
  ok('add-function', h, '--key', GO, '--kind', '6', '--fp', '0x1C4D2E3F', '--cl', '127004', '--pattern', '48 8B 05 ?? ?? ?? ?? 48 8B 0C C8 48 8D 04 D1', '--follow-rip-disp-at', '0', '--rva', '0x08E1C2A0');
  ok('add-function', h, '--key', GO, '--kind', '6', '--fp', '0x1C4D2E3F', '--cl', '128786', '--pattern', '48 8B 05 ?? ?? ?? ?? 48 8B 0C C8 48 8D 04 D1', '--follow-rip-disp-at', '0', '--rva', '0x08E2D3B0');
  ok('add-function', h, '--key', BC, '--kind', '1', '--cl', '127004', '--pattern', '48 89 5C 24 ?? 55 56 57 48 8D AC 24', '--rva', '0x01A2A100');
  ok('add-function', h, '--key', BC, '--kind', '1', '--cl', '128786', '--rva-only', '--rva', '0x01A2B3C0');
  ok('add-function', h, '--key', 'UCrSomething::Function', '--kind', '1', '--cl', '127004', '--pattern', '40 53 48 83 EC 20 48 8B D9', '--rva', '0x01B00010');
  ok('add-absent', h, '--key', 'UCrSomething::Function', '--kind', '1', '--cl', '128786', '--owners', 'WAILA');
  // Before the field rows: check over both lists reports the native gap.
  const partial = run('check', h, '--keys', loaderKeys, '--keys', pluginKeys);
  assert.equal(partial.code, 3, partial.err);
  assert.match(partial.out, /no native field row for ACrCrafter::CraftComponent on CL-127004/);
  ok('add-absent', h, '--key', 'UCrSomething::Function', '--kind', '1', '--cl', '128786', '--owners', 'BetterCheats,WAILA');
  ok('add-field', h, '--key', 'ACrCrafter::CraftComponent', '--cl', '127004', '--offset', '0x6D8', '--size', '0x8');
  ok('add-field', h, '--key', 'ACrCrafter::CraftComponent', '--cl', '128786', '--offset', '0x6E0', '--size', '0x8');
  ok('add-field', h, '--key', 'ACrCharacterPlayerBase::ADSMoveSpeed', '--cl', '128786', '--offset', '0x13C8', '--size', '0x4', '--member', 'ADSMoveSpeedScale');
  ok('add-field', h, '--key', 'UCrSomething::bFlag', '--cl', '128786', '--offset', '0x565', '--size', '0x1', '--mask', '0x10');
  assert.equal(readFileSync(h, 'utf8'), fixture('loader.h'));
  assert.match(ok('check', h, '--keys', loaderKeys, '--keys', pluginKeys).out, /0 coverage problems/);
  // One list alone leaves the other's keys orphans.
  assert.equal(run('check', h, '--keys', loaderKeys).code, 3);
  ok('export-feed', h, '--out', feed);
  const first = readFileSync(feed, 'utf8');
  ok('export-feed', h, '--out', feed);
  assert.equal(readFileSync(feed, 'utf8'), first);
  assert.equal(first, fixture('loader.feed.txt'));
  // The refusals leave the header alone.
  assert.equal(run('add-function', h, '--key', 'GWorld', '--cl', '127004', '--pattern', '48', '--rva', '0x10').code, 2);
  assert.equal(run('add-function', h, '--key', PE, '--kind', '2', '--cl', '127004', '--pattern', '48', '--rva', '0x10').code, 2);
  assert.equal(run('add-function', h, '--key', PE, '--kind', '2', '--fp', '0x0', '--cl', '127004', '--pattern', '48', '--rva', '0x10').code, 2);
  assert.equal(run('add-absent', h, '--key', 'GWorld', '--kind', '4', '--cl', '127004', '--owners', 'WAILA').code, 2);
  assert.equal(run('add-absent', h, '--key', 'UCrSomething::Function', '--kind', '1', '--cl', '128786', '--owners', 'A,,B').code, 2);
  assert.equal(run('export-feed', h, '--out', h).code, 2);
  if (process.platform === 'win32') assert.equal(run('export-feed', h, '--out', h.toUpperCase()).code, 2);
  assert.equal(readFileSync(h, 'utf8'), fixture('loader.h'));
  // A verified row replaces the absent one.
  ok('add-function', h, '--key', 'UCrSomething::Function', '--kind', '1', '--cl', '128786', '--pattern', '40 53 48 83 EC 20 48 8B D9', '--rva', '0x01B00020');
  assert.ok(parse(readFileSync(h, 'utf8')).functions.every((r) => r.key !== 'UCrSomething::Function' || !r.absent));
  // A scoped row with fp 0, written by hand, fails check.
  writeFileSync(h, fixture('loader.h').replace('2, 0x2D1AC6AE, false, "48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??", 0, -1, -1, 0x00C02240', '2, 0x00000000, false, "48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??", 0, -1, -1, 0x00C02240'));
  const zero = run('check', h);
  assert.equal(zero.code, 2);
  assert.match(zero.err, /a scoped row needs the fp/);
});

// The fixtures as C++: the plugin map against the row types plugin_interface.h
// declares, the loader map on its own.
const STUB = `#pragma once
#include <cstdint>
enum { PLUGIN_SCAN_FLAG_NONE = 0, PLUGIN_SCAN_FLAG_OPTIONAL = 1 << 0, PLUGIN_SCAN_FLAG_FOLLOW_REL32 = 1 << 1 };
struct PluginScanCandidate { uint32_t gameCL, imageStamp, imageSize; const char* pattern; uint32_t flags; int32_t resultOffset, followRel32At; uint32_t rva; };
struct PluginFieldCandidate { uint32_t gameCL; int32_t offset; uint32_t size; uint8_t boolMask; const char* member; };
`;
const compiler = ['g++', 'clang++'].find((c) => spawnSync(c, ['--version'], { windowsHide: true }).status === 0);

test('the fixtures compile as C++20', { skip: !compiler && 'no g++ or clang++ on the PATH' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'version-map-cxx-'));
  writeFileSync(join(dir, 'plugin_interface.h'), STUB);
  for (const name of ['plugin.h', 'loader.h', 'empty.h']) {
    const src = join(dir, `use-${name}.cpp`);
    const loader = name === 'loader.h' ? 'static_assert(VersionMap::kFunctionRows[3].absent && VersionMap::kFunctionRows[3].fp == 0xB3405899u);\n' : '';
    writeFileSync(src, `#include "${join(FIX, name).replace(/\\/g, '/')}"\nstatic_assert(VersionMap::kFormatVersion == 2);\nstatic_assert(VersionMap::kFunctions.size() == 0 || VersionMap::kFunctions.back().first + VersionMap::kFunctions.back().count == VersionMap::kFunctionRows.size());\n${loader}int main() { return 0; }\n`);
    const r = spawnSync(compiler, ['-std=c++20', '-fsyntax-only', '-Wall', '-Wextra', '-Werror', '-I', dir, src], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});
