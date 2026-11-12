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
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FEED_MAX_BYTES, MapError, SignatureRefused, addAbsent, addAbsentField, addBuild, addField, addFunction, carriedFieldKeys, checkMap, clOfBuild, emit, emptyMap, exportFeed, feedDelta, holdsCl, importPublished, parse,
  parseFeed, parseKeys, parseRowList, preserveCheck, prune, readPublished, removeKey, replaceBuild, restorePublished, unionKeys,
} from './version-map.mjs';
import { signFeed } from './vmap-sign.mjs';

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
  // The cap is under the 1 MiB every loader accepts, and the refusal names the size.
  assert.ok(FEED_MAX_BYTES <= 1048576);
  assert.throws(() => exportFeed(map), (e) => e instanceof MapError && /the feed is \d+ bytes, over the \d+ the export allows/.test(e.message));
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

test('add-absent-field writes the entry the pipeline writes, and changes nothing else', () => {
  const { dir, ok } = commands();
  const h = join(dir, 'version_map.generated.h');
  const original = fixture('loader.h');
  writeFileSync(h, original);
  const hotbars = 'UCrHotbarLocalPlayerSubsystem::Hotbars';
  const index = 'UCrHotbarLocalPlayerSubsystem::CurrentHotbarIndex';
  assert.match(ok('add-absent-field', h, '--key', hotbars, '--cl', '127004').err, /added absent field/);
  ok('add-absent-field', h, '--key', index, '--cl', '128786');
  // The text the model writes: sorted by key, the array sized to the entries.
  const text = readFileSync(h, 'utf8');
  assert.ok(text.includes(`std::array<AbsentField, 2> kAbsentFields = {{
	{ "${index}", 128786 },
	{ "${hotbars}", 127004 },
}};`));
  const direct = parse(original);
  addAbsentField(direct, { key: hotbars, cl: 127004 });
  addAbsentField(direct, { key: index, cl: 128786 });
  assert.equal(text, emit(direct));
  // An entry already there: success, file untouched.
  assert.match(ok('add-absent-field', h, '--key', hotbars, '--cl', '127004').err, /already there/);
  assert.equal(readFileSync(h, 'utf8'), text);
  // Taking the entries out again gives the original file byte for byte.
  const back = parse(text);
  back.absentFields = [];
  assert.equal(emit(back), original);
  // Refusals leave the file as it was.
  const refuse = (...args) => {
    const r = run('add-absent-field', h, ...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert.equal(readFileSync(h, 'utf8'), text);
    return r.err;
  };
  assert.match(refuse('--key', 'ACrCrafter::CraftComponent', '--cl', '127004'), /verified field row/);
  assert.match(refuse('--key', hotbars, '--cl', '99999'), /CL-99999 is not in the build table/);
  assert.match(refuse('--key', 'Hotbars', '--cl', '127004'), /<Class::Member>/);
  assert.match(refuse('--cl', '127004'), /<Class::Member>/);
  assert.match(refuse('--key', hotbars), /--cl is required/);
  assert.match(refuse('--key', hotbars, '--cl', 'x'), /--cl x is not a number/);
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

test('a feed refuses an address-only row whose build has no image stamp', () => {
  const map = parse(fixture('loader.h'));
  const row = map.functions.find((r) => r.pattern === null && !r.absent);
  assert.ok(row, 'the fixture has an address-only row');
  assert.doesNotThrow(() => exportFeed(map));
  map.builds.find((b) => b.cl === row.cl).stamp = 0;
  assert.throws(() => exportFeed(map), /address-only row .*image stamp/);
});

test('addBuild compares the Steam build id, stamp and size, not the label', () => {
  const map = emptyMap('loader', 127004);
  addBuild(map, { cl: 127004, stamp: 1, size: 2, source: 'public 25646882' });
  assert.equal(addBuild(map, { cl: 127004, stamp: 1, size: 2, source: 'steam_build 25646882' }), false);
  assert.equal(map.builds[0].source, 'public 25646882');
  assert.throws(() => addBuild(map, { cl: 127004, stamp: 1, size: 2, source: 'steam_build 25646883' }), /Steam build id 25646882 in the table, 25646883 measured/);
  assert.throws(() => addBuild(map, { cl: 127004, stamp: 9, size: 2, source: 'public 25646882' }), /another image stamp or size/);
  assert.throws(() => addBuild(map, { cl: 127004, stamp: 1, size: 2, source: 'steam_build' }), /no Steam build id/);
});

test('clOfBuild: the CL of a Steam build id comes from the build rows, in either label form; unknown or odd ids give null', () => {
  const m = emptyMap('loader', 127004);
  addBuild(m, { cl: 127004, stamp: 1, size: 2, source: 'public 25646882' });
  addBuild(m, { cl: 129402, stamp: 3, size: 4, source: 'steam_build 26271156' });
  assert.equal(clOfBuild(m, '25646882'), 127004);
  assert.equal(clOfBuild(m, '26271156'), 129402);
  assert.equal(clOfBuild(m, 26271156), 129402);
  assert.equal(clOfBuild(m, '26271157'), null, 'a build the map has not measured');
  for (const odd of ['', undefined, null, 'public', '12 34', '1e3']) assert.equal(clOfBuild(m, odd), null, String(odd));
});

test('holdsCl: the build row and the number of present function rows of one CL; an absent row does not count', () => {
  const m = emptyMap('loader', 127004);
  addBuild(m, { cl: 127004, stamp: 1, size: 2, source: 'public 25646882' });
  addBuild(m, { cl: 129402, stamp: 3, size: 4, source: 'steam_build 26271156' });
  addFunction(m, { key: 'K', kind: 1, cl: 127004, pattern: '48 ??', rva: 0x10 });
  addAbsent(m, { key: 'G', kind: 1, cl: 129402, owners: ['WAILA'] });
  assert.deepEqual(holdsCl(m, 127004), { build: true, rows: 1 });
  assert.deepEqual(holdsCl(m, 129402), { build: true, rows: 0 });
  assert.deepEqual(holdsCl(m, '127004'), { build: true, rows: 1 });
  assert.deepEqual(holdsCl(m, 1), { build: false, rows: 0 });
});

// ---- The feed export carries every CL in the header ----------------------------------------------------------

// The loader fixture holds CL-127004 and CL-128786; this adds a third, CL-129402.
const withThirdCL = () => {
  const map = parse(fixture('loader.h'));
  addBuild(map, { cl: 129402, stamp: 0x6499f129, size: 0x0f482000, source: 'steam_build 26461198' });
  addFunction(map, { key: 'GWorld', kind: 4, cl: 129402, pattern: '48 8B 1D ?? ?? ?? ?? 48 85 DB 74 ?? 41 B0 01', followRipDispAt: 0, rva: 0x0e604e38 });
  addField(map, { key: 'ACrCrafter::CraftComponent', cl: 129402, offset: 0x6e8, size: 8, mask: 0, member: null });
  addField(map, { key: 'UCrSomething', cl: 129402, offset: 0, size: 0x120, mask: 0, member: null });
  return map;
};
const clsOf = (feed) => [...new Set(parseFeed(feed).builds.map((b) => b.cl))];

test('export-feed: every CL in the header is in the feed, whatever Steam branch it runs on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vmap-all-'));
  const [h, feed] = [join(dir, 'version_map.generated.h'), join(dir, 'feed.txt')];
  writeFileSync(h, emit(withThirdCL()));
  const r = run('export-feed', h, '--out', feed);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(clsOf(readFileSync(feed, 'utf8')), [127004, 128786, 129402]);
  const rows = parseFeed(readFileSync(feed, 'utf8'));
  assert.ok(rows.functions.some((x) => x.cl === 129402) && rows.fields.some((x) => x.cl === 129402), 'the rows of the added CL are exported with its build row');
  // The public-only option and its list are gone.
  assert.equal(run('export-feed', h, '--out', feed, '--public-builds', 'x.json').code, 2);
});

// ---- feedDelta: what a feed adds to, or changes in, a header's rows for one CL

test('feedDelta: identical rows are no difference, whatever else the header holds', () => {
  const header = parse(fixture('loader.h'));
  const feed = parseFeed(exportFeed(header));
  for (const cl of [127004, 128786]) assert.deepEqual(feedDelta(feed, header, cl), { added: [], changed: [] }, `CL-${cl}`);
  // A header that holds more than the feed does is still no difference: a feed removes nothing.
  const more = { ...header, fields: header.fields.concat({ key: 'ZExtra::Member', cl: 128786, offset: 0x10, size: 4, mask: 0, member: null }) };
  assert.deepEqual(feedDelta(feed, more, 128786), { added: [], changed: [] });
});

test('feedDelta: a row the header lacks is added, a row the header has with other values is changed, and only for the CL asked', () => {
  const header = parse(fixture('loader.h'));
  const feed = parseFeed(exportFeed(header));
  // The header lacks one function row and one field row of CL-128786, and one build row.
  const lacking = {
    ...header,
    functions: header.functions.filter((r) => !(r.cl === 128786 && r.key === 'GWorld')),
    fields: header.fields.filter((r) => !(r.cl === 128786 && r.key === 'UCrSomething::bFlag')),
  };
  assert.deepEqual(feedDelta(feed, lacking, 128786), { added: ['field UCrSomething::bFlag', 'function GWorld (fp 0x00000000)'], changed: [] });
  assert.deepEqual(feedDelta(feed, lacking, 127004), { added: [], changed: [] }, 'another CL is not looked at');
  assert.deepEqual(feedDelta(feed, { ...header, builds: header.builds.filter((b) => b.cl !== 128786), functions: [], fields: [] }, 128786).added.slice(0, 1), ['build']);
  // Same keys, other values: an address, an offset, a build stamp.
  const changed = {
    ...header,
    builds: header.builds.map((b) => (b.cl === 128786 ? { ...b, stamp: b.stamp + 1 } : b)),
    functions: header.functions.map((r) => (r.cl === 128786 && r.key === 'GWorld' ? { ...r, rva: r.rva + 0x10 } : r)),
    fields: header.fields.map((r) => (r.cl === 128786 && r.key === 'ACrCrafter::CraftComponent' ? { ...r, offset: r.offset + 8 } : r)),
  };
  assert.deepEqual(feedDelta(feed, changed, 128786), { added: [], changed: ['build', 'field ACrCrafter::CraftComponent', 'function GWorld (fp 0x00000000)'] });
  // A CL the header has no rows for at all: everything is added.
  const d = feedDelta(feed, { ...header, builds: [], functions: [], fields: [] }, 127004);
  assert.deepEqual([d.changed.length, d.added.length], [0, 1 + header.functions.filter((r) => r.cl === 127004).length + header.fields.filter((r) => r.cl === 127004).length]);
});

// ---- The published file is part of the base ------------------------------------------------------

const UC = 'UCrSomething::Function';
const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keys: { k1: { hex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), test: false } } };
};
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const rowOf = (key, cl, extra = {}) => ({ key, kind: 1, fp: 0, cl, absent: false, pattern: 'AA 55', resultOffset: 0, followRel32At: -1, followRipDispAt: -1, rva: 0x5500, owners: null, ...extra });
const goneRow = (r, owners = ['WAILA']) => ({ ...r, absent: true, pattern: null, rva: 0, resultOffset: 0, followRel32At: -1, followRipDispAt: -1, owners });

// The published file: the fixture's data plus a build and rows the fixture's header does not have, signed.
function published() {
  const k = keyPair();
  const map = parseFeed(exportFeed(parse(fixture('loader.h'))));
  map.builds.push({ cl: 130001, stamp: 0x55555555, size: 0x05000000, source: 'steam_build 130001' });
  map.functions.push(rowOf('UCrPublished::OnlyThere', 130001), goneRow(rowOf('UCrPublished::NoAddress', 130001)));
  map.fields.push({ key: 'ATest::Native', cl: 130001, offset: 0x50, size: 4, mask: 0, member: null });
  const text = signFeed(exportFeed(map), k.pem, { keyId: 'k1' }).text;
  return { map, text, read: () => readPublished(text, { keys: k.keys }), keys: k.keys };
}

// The fixture's header without some of the published rows: two function rows and a field row of CL-128786.
function lacking() {
  const h = parse(fixture('loader.h'));
  h.functions = h.functions.filter((r) => !(r.cl === 128786 && (r.key === 'GWorld' || r.key === BC)));
  h.fields = h.fields.filter((r) => !(r.cl === 128786 && r.key === 'UCrSomething::bFlag'));
  return h;
}
const feedLines = (map) => exportFeed(map).split('\n').slice(1, -1);
const list = (...entries) => parseRowList(entries.map((e) => e.join('\t')).join('\n'));

test('readPublished: a feed that verifies is read; a changed byte, another key, a missing sig and a TEST key are refused', () => {
  const p = published();
  assert.deepEqual(p.read().builds.map((b) => b.cl), [127004, 128786, 130001]);
  const flipped = p.text.replace('0x00005500', '0x00005501');
  assert.notEqual(flipped, p.text);
  assert.ok(thrown(() => readPublished(flipped, { keys: p.keys })) instanceof SignatureRefused);
  assert.ok(thrown(() => readPublished(p.text, { keys: keyPair().keys })) instanceof SignatureRefused, 'another key');
  assert.ok(thrown(() => readPublished(p.text.replace(/sig\t.*\n$/, ''), { keys: p.keys })) instanceof SignatureRefused, 'no sig line');
  const test = { k1: { ...p.keys.k1, test: true } };
  assert.match(thrown(() => readPublished(p.text, { keys: test })).message, /TEST key/);
  assert.equal(readPublished(p.text, { keys: test, allowTestKey: true }).builds.length, 3);
});

test('importPublished: adds the rows and the whole build the header lacks; the export holds every published row byte for byte', () => {
  const p = published();
  const base = lacking();
  const out = importPublished(base, p.read());
  assert.deepEqual(out.conflicts, []);
  assert.deepEqual(out.added, { builds: 1, functions: 4, fields: 2 });
  assert.equal(base.builds.length, 2, 'the input map is not changed');
  const lines = new Set(feedLines(parse(emit(out.map))));
  for (const l of feedLines(p.map)) assert.ok(lines.has(l), l);
  assert.deepEqual(parseFeed(exportFeed(out.map)).builds.map((b) => b.cl), [127004, 128786, 130001]);
  assert.equal(out.map.builtCL, 127004, 'the header keeps its built CL');
});

test('importPublished: twice is the same as once; rows only the header has stay; a header that has it all is unchanged', () => {
  const p = published();
  const base = lacking();
  base.fields.push({ key: 'ZExtra::Member', cl: 128786, offset: 0x10, size: 4, mask: 0, member: null });
  const once = importPublished(base, p.read());
  const twice = importPublished(once.map, p.read());
  assert.equal(emit(twice.map), emit(once.map));
  assert.deepEqual(twice.added, { builds: 0, functions: 0, fields: 0 });
  assert.ok(once.map.fields.some((r) => r.key === 'ZExtra::Member'));
  const whole = importPublished(parse(fixture('loader.h')), parseFeed(exportFeed(parse(fixture('loader.h')))));
  assert.equal(emit(whole.map), fixture('loader.h'));
});

test('importPublished: a row both hold with other content is a hold that names the row and merges nothing', () => {
  const read = published().read();
  const differ = (edit) => { const b = lacking(); edit(b); return importPublished(b, read); };
  const fn = (b, key, cl) => b.functions.findIndex((r) => r.key === key && r.cl === cl);
  const out = differ((b) => { b.functions[fn(b, 'GWorld', 127004)].rva += 0x10; });
  assert.equal(out.map, null);
  assert.deepEqual(out.conflicts, ['function GWorld @ CL-127004: differs in rva']);
  assert.deepEqual(differ((b) => { b.fields.find((r) => r.key === 'ACrCrafter::CraftComponent' && r.cl === 127004).offset += 8; }).conflicts, ['field ACrCrafter::CraftComponent @ CL-127004: differs in offset']);
  assert.deepEqual(differ((b) => { b.builds[1].stamp += 1; }).conflicts, ['build CL-128786: differs in stamp']);
  // A verified row against an absent one, either way round, is a difference like any other.
  assert.match(differ((b) => { const i = fn(b, 'GWorld', 127004); b.functions[i] = goneRow(b.functions[i]); }).conflicts[0], /^function GWorld @ CL-127004: differs in absent, .*owners, pattern, rva$/);
  assert.match(differ((b) => { const i = fn(b, UC, 128786); b.functions[i] = rowOf(UC, 128786); }).conflicts[0], /^function UCrSomething::Function @ CL-128786: differs in absent, owners, pattern, rva/);
  // The header records a member as absent where the published file has a row for it.
  assert.deepEqual(differ((b) => { b.absentFields.push({ key: 'UCrSomething::bFlag', cl: 128786 }); }).conflicts, ['field UCrSomething::bFlag @ CL-128786: the header records the member as absent on this build, the published feed has a row']);
  // A key the header has as another kind.
  assert.match(differ((b) => { b.functions.push(rowOf('UCrPublished::OnlyThere', 127004, { kind: 4 })); }).conflicts[0], /^function UCrPublished::OnlyThere @ CL-130001: the header has the key as kind 4, the published feed as kind 1$/);
});

test('importPublished: the changed list keeps the header row, the retired list keeps a published row out', () => {
  const read = published().read();
  const base = lacking();
  base.functions[base.functions.findIndex((r) => r.key === 'GWorld' && r.cl === 127004)].rva += 0x10;
  const mine = base.functions.find((r) => r.key === 'GWorld' && r.cl === 127004);
  const kept = importPublished(base, read, { changed: list(['function', 'GWorld', '127004', 'a newer address']) });
  assert.deepEqual(kept.conflicts, []);
  assert.deepEqual(kept.kept, ['function GWorld @ CL-127004: differs in rva']);
  assert.equal(kept.map.functions.find((r) => r.key === 'GWorld' && r.cl === 127004).rva, mine.rva, 'the header row stands');
  const retired = importPublished(lacking(), read, { retired: list(['function', 'UCrPublished::OnlyThere', '130001', 'gone'], ['field', 'ACrCrafter::CraftComponent', '128786', 'gone']) });
  assert.ok(!retired.map.functions.some((r) => r.key === 'UCrPublished::OnlyThere'));
  assert.ok(retired.map.functions.some((r) => r.key === 'UCrPublished::NoAddress'));
  const wholeBuild = importPublished(lacking(), read, { retired: list(['build', '-', '130001', 'the build is gone']) });
  assert.ok(!wholeBuild.map.builds.some((b) => b.cl === 130001) && !wholeBuild.map.functions.some((r) => r.cl === 130001) && !wholeBuild.map.fields.some((r) => r.cl === 130001));
});

test('preserveCheck: a file with every published line passes; a lost or changed line is named', () => {
  const p = published();
  const imported = parseFeed(exportFeed(importPublished(lacking(), p.read()).map));
  assert.deepEqual(preserveCheck(imported, p.map), { violations: [], checked: feedLines(p.map).length });
  const copy = () => parseFeed(exportFeed(imported));
  const lost = copy();
  lost.functions = lost.functions.filter((r) => r.key !== 'GWorld');
  lost.fields = lost.fields.filter((r) => !(r.key === 'ATest::Native'));
  assert.deepEqual(preserveCheck(lost, p.map).violations, ['function GWorld @ CL-127004: missing', 'function GWorld @ CL-128786: missing', 'field ATest::Native @ CL-130001: missing']);
  const changed = copy();
  changed.functions.find((r) => r.key === 'GWorld' && r.cl === 128786).rva += 4;
  changed.functions[changed.functions.findIndex((r) => r.key === 'UCrPublished::OnlyThere')] = goneRow(rowOf('UCrPublished::OnlyThere', 130001));
  changed.builds.find((b) => b.cl === 128786).size += 0x1000;
  assert.deepEqual(preserveCheck(changed, p.map).violations, [
    'build CL-128786: differs in size',
    'function GWorld @ CL-128786: differs in rva',
    'function UCrPublished::OnlyThere @ CL-130001: differs in absent, owners, pattern, rva',
  ]);
  const noBuild = copy();
  noBuild.builds = noBuild.builds.filter((b) => b.cl !== 130001);
  noBuild.functions = noBuild.functions.filter((r) => r.cl !== 130001);
  noBuild.fields = noBuild.fields.filter((r) => r.cl !== 130001);
  assert.equal(preserveCheck(noBuild, p.map).violations.length, 4, 'the build line and its three rows');
});

test('preserveCheck: retired entries excuse a missing line, changed entries a different one, and neither excuses the other', () => {
  const p = published();
  const imported = parseFeed(exportFeed(importPublished(lacking(), p.read()).map));
  const lost = parseFeed(exportFeed(imported));
  lost.functions = lost.functions.filter((r) => r.key !== 'GWorld');
  const gworld = [['function', 'GWorld', '127004', 'x'], ['function', 'GWorld', '128786', 'x']];
  assert.deepEqual(preserveCheck(lost, p.map, { retired: list(...gworld) }).violations, []);
  assert.equal(preserveCheck(lost, p.map, { changed: list(...gworld) }).violations.length, 2, 'a change entry is not a retirement');
  const changed = parseFeed(exportFeed(imported));
  changed.functions.find((r) => r.key === 'GWorld' && r.cl === 128786).rva += 4;
  assert.deepEqual(preserveCheck(changed, p.map, { changed: list(gworld[1]) }).violations, []);
  assert.equal(preserveCheck(changed, p.map, { retired: list(gworld[0]) }).violations.length, 1, 'another build, another entry');
  const noBuild = parseFeed(exportFeed(imported));
  for (const f of ['builds', 'functions', 'fields']) noBuild[f] = noBuild[f].filter((r) => r.cl !== 130001);
  assert.deepEqual(preserveCheck(noBuild, p.map, { retired: list(['build', '-', '130001', 'the build is gone']) }).violations, []);
});

test('the row lists: the committed files are empty, and an entry needs a kind, a key, a CL and a reason', () => {
  for (const name of ['retired-rows.txt', 'changed-rows.txt']) assert.equal(parseRowList(readFileSync(join(here, name), 'utf8'), name).size, 0, name);
  assert.equal(list(['function', 'GWorld', '127004', 'a reason'], ['build', '-', '128786', 'another']).size, 2);
  assert.equal(parseRowList('# a comment\n\n   \n').size, 0);
  assert.match(thrown(() => list(['function', 'GWorld', '127004'])).message, /list:1: the entry for function GWorld on CL-127004 has no reason/);
  assert.match(thrown(() => list(['function', 'GWorld', '127004', '  '])).message, /has no reason/);
  assert.match(thrown(() => list(['row', 'GWorld', '127004', 'x'])).message, /expected/);
  assert.match(thrown(() => list(['function', 'GWorld', 'abc', 'x'])).message, /expected/);
  assert.match(thrown(() => list(['build', 'GWorld', '127004', 'x'])).message, /key of a build entry is "-"/);
  assert.match(thrown(() => parseRowList('function GWorld 127004 spaces, not tabs')).message, /expected/);
});

// ---- import-published and check-preserve on the command line

function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vmap-pub-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { dir, path: (name) => join(dir, name), done: () => rmSync(dir, { recursive: true, force: true }) };
}
// The loader's TEST-key fixture, with LF ends whatever the checkout gave it: build CL-128786 (other values than
// the fixture header's) and build CL-130001 with a function row and a field row.
const k1Fixture = () => readFileSync(join(here, 'fixtures', 'vmap-sign', 'test-feed-k1.txt'), 'utf8').replace(/\r\n/g, '\n');

test('import-published: a signature that does not verify exits 4 and leaves the header alone', () => {
  const p = published();
  const s = scratch({ 'h.h': fixture('loader.h'), 'signed-by-someone-else.txt': p.text, 'unsigned.txt': exportFeed(p.map), 'k1.txt': k1Fixture() });
  try {
    for (const name of ['signed-by-someone-else.txt', 'unsigned.txt', 'k1.txt']) {
      const r = run('import-published', s.path('h.h'), '--published', s.path(name));
      assert.equal(r.code, 4, `${name}: ${r.err}`);
      assert.match(r.err, /refused/);
    }
    assert.equal(readFileSync(s.path('h.h'), 'utf8'), fixture('loader.h'));
    assert.equal(run('import-published', s.path('h.h'), '--published', s.path('missing.txt')).code, 2);
  } finally { s.done(); }
});

test('import-published: a conflict exits 3, names the rows and writes nothing; the retired list lets the rest through', () => {
  const s = scratch({ 'h.h': fixture('loader.h'), 'k1.txt': k1Fixture(), 'retired.txt': '# none\nbuild\t-\t128786\tthe fixture build is not the loader fixture one\n', 'bad.txt': 'build\t-\t128786\t\n' });
  try {
    let r = run('import-published', s.path('h.h'), '--published', s.path('k1.txt'), '--allow-test-key');
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, /hold: 1 rows differ/);
    assert.match(r.err, /build CL-128786: differs in size, source, stamp/);
    assert.equal(readFileSync(s.path('h.h'), 'utf8'), fixture('loader.h'));
    r = run('import-published', s.path('h.h'), '--published', s.path('k1.txt'), '--allow-test-key', '--retired', s.path('bad.txt'));
    assert.equal(r.code, 2, 'an entry without a reason fails the command');
    assert.match(r.err, /has no reason/);
    r = run('import-published', s.path('h.h'), '--published', s.path('k1.txt'), '--allow-test-key', '--retired', s.path('retired.txt'));
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /added 1 build lines, 1 function rows, 1 field rows/);
    const after = parse(readFileSync(s.path('h.h'), 'utf8'));
    assert.ok(after.builds.some((b) => b.cl === 130001) && after.functions.some((x) => x.key === 'Test::MapOnly') && after.fields.some((x) => x.key === 'ATest::Native'));
  } finally { s.done(); }
});

test('check-preserve: names the published lines a feed lost, capped, and passes once they are retired or changed', () => {
  const s = scratch({
    'feed.txt': exportFeed(parse(fixture('loader.h'))), 'k1.txt': k1Fixture(),
    'retired.txt': 'build\t-\t130001\tnot published after all\n', 'changed.txt': 'build\t-\t128786\tthe measured exe is the new one\n',
  });
  try {
    let r = run('check-preserve', s.path('feed.txt'), '--published', s.path('k1.txt'), '--allow-test-key');
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, /hold: 4 published lines are missing from .* or changed in it/);
    assert.match(r.err, /build CL-128786: differs in size, source, stamp\n.*build CL-130001: missing\n.*function Test::MapOnly @ CL-130001: missing\n.*field ATest::Native @ CL-130001: missing/);
    r = run('check-preserve', s.path('feed.txt'), '--published', s.path('k1.txt'), '--allow-test-key', '--retired', s.path('retired.txt'), '--changed', s.path('changed.txt'));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /all 4 published lines are in .* unchanged/);
    assert.equal(run('check-preserve', s.path('feed.txt'), '--published', s.path('k1.txt')).code, 4, 'no TEST key without the flag');
  } finally { s.done(); }
});

// ---- A re-measure keeps the published rows of its build ------------------------------------------

// The published file's header as a test run starts: every published row in it. The re-measure then drops the
// rows of CL-128786 and writes back only what it measured (function rows, field rows, absent fields).
function remeasured({ functions = [], fields = [], absentFields = [] } = {}) {
  const p = published();
  const map = importPublished(lacking(), p.read()).map;
  map.functions = [...map.functions.filter((r) => r.cl !== 128786), ...functions];
  map.fields = [...map.fields.filter((r) => r.cl !== 128786), ...fields];
  map.absentFields = [...(map.absentFields ?? []).filter((r) => r.cl !== 128786), ...absentFields];
  return { p, map, read: p.read() };
}

test('restorePublished: a published row the run did not measure comes back as published, and is named', () => {
  const { p, map, read } = remeasured();
  assert.equal(map.functions.some((r) => r.cl === 128786), false, 'the re-measure left no row of the build');
  const out = restorePublished(map, read, 128786);
  assert.deepEqual(out.differs, []);
  assert.ok(out.kept.length >= 3);
  assert.ok(out.kept.every((k) => k.why === 'the run did not measure it'));
  assert.ok(out.kept.some((k) => k.name === 'function GWorld @ CL-128786'));
  assert.ok(out.kept.some((k) => k.name === 'field UCrSomething::bFlag @ CL-128786'));
  assert.deepEqual(preserveCheck(parseFeed(exportFeed(map)), p.map), { violations: [], checked: feedLines(p.map).length });
});

test('restorePublished: a real published function row is never replaced by an absent row, nor a field row by an absent field', () => {
  const real = published().map.functions.find((r) => r.cl === 128786 && r.key === 'GWorld');
  const field = published().map.fields.find((r) => r.cl === 128786 && r.key === 'UCrSomething::bFlag');
  const { p, map, read } = remeasured({ functions: [goneRow({ ...real })], absentFields: [{ key: field.key, cl: 128786 }] });
  assert.ok(map.functions.find((r) => r.key === 'GWorld' && r.cl === 128786).absent);
  const out = restorePublished(map, read, 128786);
  assert.deepEqual(out.differs, []);
  assert.deepEqual(out.kept.filter((k) => /GWorld|bFlag/.test(k.name)).map((k) => [k.name, k.why]), [
    ['function GWorld @ CL-128786', 'the run found no address for it'],
    ['field UCrSomething::bFlag @ CL-128786', 'the run found no member for it'],
  ]);
  assert.equal(map.functions.find((r) => r.key === 'GWorld' && r.cl === 128786).absent, false);
  assert.equal(map.absentFields.some((r) => r.key === field.key && r.cl === 128786), false);
  assert.deepEqual(preserveCheck(parseFeed(exportFeed(map)), p.map).violations, []);
});

test('restorePublished: a value the run measured differently stays as measured and is named, so the preserve check holds on it', () => {
  const real = published().map.functions.find((r) => r.cl === 128786 && r.key === 'GWorld');
  const field = published().map.fields.find((r) => r.cl === 128786 && r.key === 'UCrSomething::bFlag');
  const { p, map, read } = remeasured({ functions: [{ ...real, rva: real.rva + 4 }], fields: [{ ...field, offset: field.offset + 8 }] });
  const out = restorePublished(map, read, 128786);
  assert.deepEqual(out.differs, ['function GWorld @ CL-128786', 'field UCrSomething::bFlag @ CL-128786']);
  assert.equal(map.functions.find((r) => r.key === 'GWorld' && r.cl === 128786).rva, real.rva + 4);
  assert.deepEqual(preserveCheck(parseFeed(exportFeed(map)), p.map).violations, [
    'function GWorld @ CL-128786: differs in rva',
    'field UCrSomething::bFlag @ CL-128786: differs in offset',
  ]);
  // The changed list excuses exactly those rows.
  assert.deepEqual(preserveCheck(parseFeed(exportFeed(map)), p.map, { changed: list(['function', 'GWorld', '128786', 'x'], ['field', 'UCrSomething::bFlag', '128786', 'x']) }).violations, []);
});

test('restorePublished: an absent published row that the run gave an address is a difference, not a restore', () => {
  const p = published();
  const map = importPublished(lacking(), p.read()).map;
  map.functions = map.functions.map((r) => (r.key === 'UCrPublished::NoAddress' ? rowOf('UCrPublished::NoAddress', 130001) : r));
  assert.deepEqual(restorePublished(map, p.read(), 130001), { kept: [], differs: ['function UCrPublished::NoAddress @ CL-130001'] });
});

test('restorePublished: a retired row stays out; a changed-list row is put back only when the run left it out', () => {
  const { map, read } = remeasured();
  const out = restorePublished(map, read, 128786, { retired: list(['function', 'GWorld', '128786', 'x']), changed: list(['field', 'UCrSomething::bFlag', '128786', 'x']) });
  assert.ok(!out.kept.some((k) => /GWorld/.test(k.name)));
  assert.equal(map.functions.some((r) => r.key === 'GWorld' && r.cl === 128786), false, 'retired: not put back');
  assert.ok(out.kept.some((k) => k.name === 'field UCrSomething::bFlag @ CL-128786'), 'the changed list excuses a change, never a loss');
  // Measured with another value, the changed-list row stays as measured and is not a difference.
  const field = published().map.fields.find((r) => r.cl === 128786 && r.key === 'UCrSomething::bFlag');
  const m = remeasured({ fields: [{ ...field, offset: field.offset + 8 }] });
  assert.deepEqual(restorePublished(m.map, m.read, 128786, { changed: list(['field', 'UCrSomething::bFlag', '128786', 'x']) }).differs, []);
  assert.equal(m.map.fields.find((r) => r.key === field.key && r.cl === 128786).offset, field.offset + 8);
  const again = remeasured();
  const before = emit(again.map);
  assert.deepEqual(restorePublished(again.map, again.read, 999999), { kept: [], differs: [] });
  assert.equal(emit(again.map), before);
});

test('restorePublished: an absent row measured with fewer owners is put back; with an owner more it is a difference', () => {
  const p = published();
  const owned = (owners) => {
    const read = p.read();
    read.functions = read.functions.map((r) => (r.key === 'UCrPublished::NoAddress' ? { ...r, owners: ['BetterDrone', 'WAILA'] } : r));
    const map = importPublished(lacking(), p.read()).map;
    map.functions = map.functions.map((r) => (r.key === 'UCrPublished::NoAddress' ? { ...r, owners } : r));
    return { map, read };
  };
  const fewer = owned(['WAILA']);
  assert.deepEqual(restorePublished(fewer.map, fewer.read, 130001), { kept: [{ name: 'function UCrPublished::NoAddress @ CL-130001', why: 'the run measured fewer owners for it' }], differs: [] });
  assert.deepEqual(fewer.map.functions.find((r) => r.key === 'UCrPublished::NoAddress').owners, ['BetterDrone', 'WAILA']);
  const more = owned(['WAILA', 'Zed']);
  assert.deepEqual(restorePublished(more.map, more.read, 130001), { kept: [], differs: ['function UCrPublished::NoAddress @ CL-130001'] });
});

test('restorePublished: another exe at the same CL keeps nothing, and the build line is the difference', () => {
  const { p, map, read } = remeasured();
  map.builds = map.builds.map((b) => (b.cl === 128786 ? { ...b, stamp: b.stamp + 1 } : b));
  const before = emit(map);
  assert.deepEqual(restorePublished(map, read, 128786), { kept: [], differs: ['build CL-128786'] });
  assert.equal(emit(map), before, 'no row of the old exe is put next to the new build row');
  assert.deepEqual(preserveCheck(parseFeed(exportFeed(map)), p.map).violations.filter((v) => v.startsWith('build')), ['build CL-128786: differs in stamp']);
  assert.deepEqual(restorePublished(map, read, 128786, { changed: list(['build', '-', '128786', 'x']) }), { kept: [], differs: [] }, 'a listed build change is not named again');
});

test('restorePublished: twice is the same as once', () => {
  const { map, read } = remeasured();
  restorePublished(map, read, 128786);
  const once = emit(map);
  assert.deepEqual(restorePublished(map, read, 128786), { kept: [], differs: [] });
  assert.equal(emit(map), once);
});

test('carriedFieldKeys: the field keys of the newest published build that the key list lacks; none for a build the file holds', () => {
  const p = published().read();
  assert.deepEqual(carriedFieldKeys(p, 130002, new Set()), { from: 130001, keys: ['ATest::Native'] });
  assert.deepEqual(carriedFieldKeys(p, 130002, new Set(['ATest::Native'])), { from: null, keys: [] }, 'the run already lists it');
  assert.deepEqual(carriedFieldKeys(p, 130001, new Set()), { from: null, keys: [] }, 'a build the file holds is kept by restorePublished');
  assert.deepEqual(carriedFieldKeys(parseFeed('format\t1\n'), 130002, new Set()), { from: null, keys: [] });
});

test('carriedFieldKeys: a key with a retired entry, on any build, is not carried', () => {
  const p = published().read();
  assert.deepEqual(carriedFieldKeys(p, 130002, new Set(), { retired: list(['field', 'ATest::Native', '127004', 'x']) }).keys, []);
  assert.deepEqual(carriedFieldKeys(p, 130002, new Set(), { retired: list(['build', '-', '130001', 'x']) }).keys, []);
  assert.deepEqual(carriedFieldKeys(p, 130002, new Set(), { retired: list(['function', 'ATest::Native', '130001', 'x']) }).keys, ['ATest::Native'], 'a function entry is another kind');
});

test('restore-published and carry-keys on the command line', () => {
  const s = scratch({ h: fixture('loader.h'), 'k1.txt': k1Fixture(), 'retired.txt': 'build\t-\t128786\tthe fixture build is not the loader fixture one\n', 'keys.txt': '# the run\nGWorld\n' });
  try {
    const k1 = ['--published', s.path('k1.txt'), '--allow-test-key'];
    assert.equal(run('import-published', s.path('h'), ...k1, '--retired', s.path('retired.txt')).code, 0);
    const whole = readFileSync(s.path('h'), 'utf8');
    // The re-measure drops CL-130001's rows; the command puts them back.
    const dropped = parse(whole);
    dropped.functions = dropped.functions.filter((r) => r.cl !== 130001);
    dropped.fields = dropped.fields.filter((r) => r.cl !== 130001);
    writeFileSync(s.path('h'), emit(dropped));
    const r = run('restore-published', s.path('h'), ...k1, '--cl', '130001', '--report', s.path('kept.json'));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /kept published function Test::MapOnly @ CL-130001: the run did not measure it\nkept published field ATest::Native @ CL-130001: the run did not measure it/);
    assert.equal(readFileSync(s.path('h'), 'utf8'), whole);
    assert.deepEqual(JSON.parse(readFileSync(s.path('kept.json'), 'utf8')), { cl: 130001, kept: [{ name: 'function Test::MapOnly @ CL-130001', why: 'the run did not measure it' }, { name: 'field ATest::Native @ CL-130001', why: 'the run did not measure it' }], differs: [] });
    assert.equal(run('restore-published', s.path('h'), ...k1).code, 2, '--cl is required');
    assert.equal(run('restore-published', s.path('h'), '--published', s.path('k1.txt'), '--cl', '130001').code, 4, 'no TEST key without the flag');
    // carry-keys: CL-130002 is new to the file, so the newest build's field key is carried.
    const c = run('carry-keys', s.path('keys.txt'), ...k1, '--cl', '130002', '--out', s.path('carry.txt'));
    assert.equal(c.code, 0, c.err);
    assert.equal(readFileSync(s.path('carry.txt'), 'utf8'), 'ATest::Native\n');
    assert.match(c.out, /1 field keys of CL-130001/);
    assert.equal(run('carry-keys', s.path('keys.txt'), ...k1, '--cl', '130001', '--out', s.path('none.txt')).code, 0);
    assert.equal(readFileSync(s.path('none.txt'), 'utf8'), '');
  } finally { s.done(); }
});
