// Tests for version-map.mjs.
//
//   node --test ci/version-map.test.mjs
//
// The fixtures in fixtures/version-map were written by the tool itself (the
// commands are in ci/VERSION-MAP.md); their numbers are made up. Where a C++
// compiler is on the PATH (g++ or clang++), the fixtures are also compiled.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MapError, addBuild, addField, addFunction, checkMap, emit, emptyMap, parse, parseKeys, prune, removeKey, replaceBuild } from './version-map.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures', 'version-map');
const TOOL = join(here, 'version-map.mjs');
// LF, whatever line ends the checkout gave the files.
const fixture = (name) => readFileSync(join(FIX, name), 'utf8').replace(/\r\n/g, '\n');

function run(...args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

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
  assert.deepEqual(p.builds.map((b) => b.cl), [127004, 128786]);
  assert.equal(p.functions.length, 4);
  assert.deepEqual(p.functions.find((r) => r.cl === 128786 && r.key === 'AActor::ProcessEvent caller'),
    { key: 'AActor::ProcessEvent caller', cl: 128786, pattern: null, resultOffset: 0, followRel32At: 0, followRipDispAt: -1, rva: 0x00c02240 });
  assert.deepEqual(p.fields.find((r) => r.key === 'ACrCharacterPlayerBase::ADSMoveSpeed'),
    { key: 'ACrCharacterPlayerBase::ADSMoveSpeed', cl: 128786, offset: 0x13c8, size: 4, mask: 0, member: 'ADSMoveSpeedScale' });
  assert.equal(p.fields.find((r) => r.key === 'UCrSomething::bFlag').mask, 0x10);
  const l = parse(fixture('loader.h'));
  assert.equal(l.flavour, 'loader');
  assert.deepEqual(l.functions.filter((r) => r.key === 'GObjects').map((r) => r.followRipDispAt), [0, 0]);
  assert.equal(l.functions.find((r) => r.key === 'StaticFindObject (ByPath)' && r.cl === 128786).resultOffset, -4);
});

test('CRLF line ends read as LF', () => {
  const text = fixture('plugin.h');
  assert.deepEqual(parse(text.replace(/\n/g, '\r\n')), parse(text));
});

test('anything off the format is refused', () => {
  const p = fixture('plugin.h');
  const l = fixture('loader.h');
  const bad = {
    'a trailing space': p.replace('kBuiltCL = 127004;', 'kBuiltCL = 127004; '),
    'an extra blank line': p.replace('\n\nnamespace', '\n\n\nnamespace'),
    'no final newline': p.replace(/\n$/, ''),
    'a hand comment': p.replace('#pragma once\n', '#pragma once\n// edited\n'),
    'builds out of order': p.replace(/(\t\{ 127004, [^\n]*\n)(\t\{ 128786, [^\n]*\n)/, '$2$1'),
    'rows out of order': p.replace(/(\t\{ 127004, 0x68F0A1B2, 0x0A3F2000, "48 89[^\n]*\n)(\t\{ 128786, [^\n]*\n)/, '$2$1'),
    'a wrong count': p.replace('std::array<PluginScanCandidate, 4>', 'std::array<PluginScanCandidate, 5>'),
    'a wrong index': p.replace('"UCrBuildingComponent::GetPlacementResourceConditionResult", 2, 2', '"UCrBuildingComponent::GetPlacementResourceConditionResult", 1, 2'),
    "a row stamp that is not its build's": p.replace('{ 127004, 0x68F0A1B2, 0x0A3F2000, "48 89 5C', '{ 127004, 0x68F0A1B3, 0x0A3F2000, "48 89 5C'),
    'a flag that disagrees with followRel32At': p.replace('"48 89 5C 24 ?? 55 56 57 48 8D AC 24", PLUGIN_SCAN_FLAG_NONE', '"48 89 5C 24 ?? 55 56 57 48 8D AC 24", PLUGIN_SCAN_FLAG_FOLLOW_REL32'),
    'a lower-case pattern': p.replace('48 8D AC 24', '48 8d ac 24'),
    'a single-? wildcard': p.replace('48 8D AC 24', '48 8D AC ?'),
    'a lower-case hex number': p.replace('0x13C8', '0x13c8'),
    'a decimal offset': p.replace('0x13C8', '5064'),
    'a row whose CL has no build': p.replace('{ 128786, 0x565, 0x1, 0x10, nullptr }', '{ 128787, 0x565, 0x1, 0x10, nullptr }'),
    'two rows for one key and CL': p.replace(/(\t\{ 128786, 0x2D0[^\n]*\n)/, '$1$1'),
    'a mask wider than a byte': p.replace('0x565, 0x1, 0x10', '0x565, 0x1, 0x110'),
    'another format version': p.replace('kFormatVersion = 1;', 'kFormatVersion = 2;'),
    'a key comment that disagrees with the index': p.replace('\t// UCrSomething::bFlag', '\t// UCrSomething::bOther'),
    'a plugin map without its include': p.replace('#include "plugin_interface.h"\n', ''),
    'a loader row in a plugin map': p.replace('PLUGIN_SCAN_FLAG_NONE, 0, -1, 0x01A2A100', '0, -1, -1, 0x01A2A100'),
    'a loader map missing its row struct': l.replace(/struct FieldRow[^\n]*\n/, ''),
    'a rip follow and a rel32 follow on one row': l.replace('"48 8B 05 ?? ?? ?? ?? 48 8B 0C C8 48 8D 04 D1", 0, -1, 0, 0x08E1C2A0', '"48 8B 05 ?? ?? ?? ?? 48 8B 0C C8 48 8D 04 D1", 0, 3, 0, 0x08E1C2A0'),
  };
  for (const [what, text] of Object.entries(bad)) {
    assert.notEqual(text, what.startsWith('a loader') || what.startsWith('a rip') ? l : p, `the mutation "${what}" changed nothing`);
    assert.throws(() => parse(text), MapError, what);
  }
});

test('the model refuses rows it cannot write', () => {
  const map = emptyMap('plugin', 127004);
  addBuild(map, { cl: 127004, stamp: 1, size: 2, source: 'public 1' });
  const bad = [
    () => addBuild(map, { cl: 127004, stamp: 9, size: 2, source: 'public 1' }),
    () => addBuild(map, { cl: 128786, stamp: 1, size: 2, source: 'has "quotes"' }),
    () => addFunction(map, { key: 'K', cl: 128786, pattern: '48', rva: 1 }),
    () => addFunction(map, { key: 'K', cl: 127004, pattern: null, rva: 0 }),
    () => addFunction(map, { key: 'K', cl: 127004, pattern: '48', rva: 1, followRipDispAt: 0 }),
    () => addFunction(map, { key: 'back\\slash', cl: 127004, pattern: '48', rva: 1 }),
    () => addField(map, { key: 'F', cl: 127004, offset: 0x10, size: 0 }),
    () => addField(map, { key: 'F', cl: 127004, offset: 0x10, size: 4, member: 'not a name' }),
    () => addField(map, { key: 'F', cl: 127004, offset: 0x10, size: 4, mask: 0x11 }),
    () => emptyMap('server', 127004),
  ];
  for (const f of bad) assert.throws(f, MapError, f.toString());
});

test('adding a row twice changes nothing; adding another value for it is refused', () => {
  const map = emptyMap('loader', 127004);
  assert.equal(addBuild(map, { cl: 127004, stamp: 1, size: 2, source: 'public 1' }), true);
  assert.equal(addBuild(map, { cl: 127004, stamp: 1, size: 2, source: 'public 1' }), false);
  assert.equal(addFunction(map, { key: 'K', cl: 127004, pattern: '48 ??', rva: 0x10 }), true);
  assert.equal(addFunction(map, { key: 'K', cl: 127004, pattern: '48 ??', rva: 0x10 }), false);
  assert.throws(() => addFunction(map, { key: 'K', cl: 127004, pattern: '48 ??', rva: 0x20 }), MapError);
  assert.equal(addField(map, { key: 'F', cl: 127004, offset: 8, size: 4 }), true);
  assert.equal(addField(map, { key: 'F', cl: 127004, offset: 8, size: 4 }), false);
  assert.throws(() => addField(map, { key: 'F', cl: 127004, offset: 12, size: 4 }), MapError);
  assert.equal(map.functions.length + map.fields.length, 2);
});

test('prune keeps the builds listed and drops the rest with their rows', () => {
  const map = parse(fixture('plugin.h'));
  assert.deepEqual(prune(map, [128786]), { builds: 1, functions: 2, fields: 1 });
  assert.deepEqual(map.builds.map((b) => b.cl), [128786]);
  assert.ok([...map.functions, ...map.fields].every((r) => r.cl === 128786));
  assert.throws(() => prune(parse(fixture('plugin.h')), [130001]), MapError);
  assert.equal(emit(parse(emit(map))), emit(map));
});

test('replace-build records a new exe for a CL and drops that CL\'s rows', () => {
  const map = parse(fixture('plugin.h'));
  assert.equal(replaceBuild(map, { cl: 128786, stamp: 0x6a1b2c3e, size: 0x0a412000, source: 'public 26300000' }), 5);
  assert.deepEqual(map.builds.find((b) => b.cl === 128786), { cl: 128786, stamp: 0x6a1b2c3e, size: 0x0a412000, source: 'public 26300000' });
  assert.ok([...map.functions, ...map.fields].every((r) => r.cl === 127004));
  assert.throws(() => replaceBuild(map, { cl: 130001, stamp: 1, size: 2, source: 'public 1' }), MapError);
  assert.equal(emit(parse(emit(map))), emit(map));
});

test('remove-key drops a key on every build', () => {
  const map = parse(fixture('plugin.h'));
  assert.deepEqual(removeKey(map, 'AActor::ProcessEvent caller'), { functions: 2, fields: 0 });
  assert.deepEqual(removeKey(map, 'ACrPackageTransportReplicator::Native2C0'), { functions: 0, fields: 2 });
  assert.throws(() => removeKey(map, 'AActor::ProcessEvent caller'), MapError);
  assert.deepEqual(checkMap(map, parseKeys(KEYS.replace('function AActor::ProcessEvent caller\n', '').replace(/native [^\n]*\n/, ''))), []);
});

const KEYS = `# the plugin fixture's keys
function AActor::ProcessEvent caller
function UCrBuildingComponent::GetPlacementResourceConditionResult
native ACrPackageTransportReplicator::Native2C0 0x2C0 0x8 0x0
field ACrCharacterPlayerBase::ADSMoveSpeed
field UCrSomething::bFlag
`;

test('check: a complete map passes', () => {
  assert.deepEqual(checkMap(parse(fixture('plugin.h')), parseKeys(KEYS)), []);
});

test('check: the built CL must have a build row', () => {
  assert.deepEqual(checkMap(parse(fixture('empty.h')), parseKeys('')), ['the built CL-127004 has no build row']);
  const map = parse(fixture('plugin.h'));
  prune(map, [128786]);
  assert.ok(checkMap(map, parseKeys(KEYS)).includes('the built CL-127004 has no build row'));
});

test('check: missing coverage, orphan keys and a built-CL mismatch are each reported', () => {
  const keys = parseKeys(KEYS.replace('function AActor::ProcessEvent caller\n', '') + 'function New::Hook\nnative New::Native\n');
  const map = parse(fixture('plugin.h'));
  map.fields.find((r) => r.key === 'ACrPackageTransportReplicator::Native2C0' && r.cl === 127004).offset = 0x2C4;
  assert.deepEqual(checkMap(map, keys), [
    'orphan function key AActor::ProcessEvent caller: the component does not resolve it',
    'no function row for New::Hook on CL-127004',
    'no native field row for New::Native on CL-127004',
    'no function row for New::Hook on CL-128786',
    'no native field row for New::Native on CL-128786',
    'native field ACrPackageTransportReplicator::Native2C0 on the built CL-127004: the row says 0x2C4/0x8/0x00, the code was built with 0x2C0/0x8/0x00',
  ]);
  assert.deepEqual(checkMap(parse(fixture('plugin.h')), parseKeys(KEYS.replace('field UCrSomething::bFlag\n', ''))), [
    'orphan field key UCrSomething::bFlag: the component does not use it',
  ]);
});

test('the keys file refuses what it cannot read', () => {
  for (const text of ['hook K', 'function', 'function K\nfunction K', 'field F 0x1 0x2 0x3', 'native back\\slash',
    'native A::B 0x10 0x4', 'native A::B 0x10', 'native A::B 0x10 0x4 0x1FF', 'native A::B 0x10 0x4 0x01', 'native A::B 0x10 0x0 0x00']) {
    assert.throws(() => parseKeys(text), MapError, text);
  }
  const k = parseKeys('function StaticFindObject (ByPath)\nnative A::B\nnative C::D 0x10 0x1 0xFF\n');
  assert.ok(k.functions.has('StaticFindObject (ByPath)'));
  assert.equal(k.native.get('A::B'), null);
  assert.deepEqual(k.native.get('C::D'), { offset: 0x10, size: 1, mask: 0xff });
});

test('the commands build the plugin fixture and check it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'version-map-'));
  const h = join(dir, 'version_map.generated.h');
  const keys = join(dir, 'keys.txt');
  writeFileSync(keys, KEYS);
  const ok = (...args) => {
    const r = run(...args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}${r.out}`);
    return r;
  };
  ok('init', h, '--flavour', 'plugin', '--built-cl', '127004');
  assert.equal(run('init', h, '--flavour', 'plugin', '--built-cl', '127004').code, 2);
  ok('add-build', h, '--cl', '128786', '--stamp', '0x6A1B2C3D', '--size', '0x0A412000', '--source', 'public_test_branch 26271156');
  ok('add-build', h, '--cl', '127004', '--stamp', '0x68F0A1B2', '--size', '0x0A3F2000', '--source', 'public 25646882');
  ok('add-function', h, '--key', 'UCrBuildingComponent::GetPlacementResourceConditionResult', '--cl', '128786', '--pattern', '48 89 5C 24 ?? 55 56 57 48 8D 6C 24 ?? 48 81 EC', '--rva', '0x01A2B3C0');
  ok('add-function', h, '--key', 'UCrBuildingComponent::GetPlacementResourceConditionResult', '--cl', '127004', '--pattern', '48 89 5C 24 ?? 55 56 57 48 8D AC 24', '--rva', '0x01A2A100');
  ok('add-function', h, '--key', 'AActor::ProcessEvent caller', '--cl', '127004', '--pattern', 'E8 ?? ?? ?? ?? 48 8B 5C 24 ?? 48 83 C4 20', '--follow-rel32-at', '0', '--rva', '0x00C01230');
  // Before the rest of the rows: check reports the gaps.
  const partial = run('check', h, '--keys', keys);
  assert.equal(partial.code, 3, partial.err);
  assert.match(partial.out, /no function row for AActor::ProcessEvent caller on CL-128786/);
  ok('add-function', h, '--key', 'AActor::ProcessEvent caller', '--cl', '128786', '--rva-only', '--follow-rel32-at', '0', '--rva', '0x00C02240');
  ok('add-field', h, '--key', 'ACrPackageTransportReplicator::Native2C0', '--cl', '127004', '--offset', '0x2C0', '--size', '0x8');
  ok('add-field', h, '--key', 'ACrPackageTransportReplicator::Native2C0', '--cl', '128786', '--offset', '0x2D0', '--size', '0x8');
  ok('add-field', h, '--key', 'ACrCharacterPlayerBase::ADSMoveSpeed', '--cl', '128786', '--offset', '0x13C8', '--size', '0x4', '--member', 'ADSMoveSpeedScale');
  ok('add-field', h, '--key', 'UCrSomething::bFlag', '--cl', '128786', '--offset', '0x565', '--size', '0x1', '--mask', '0x10');
  assert.equal(readFileSync(h, 'utf8'), fixture('plugin.h'));
  assert.match(ok('check', h, '--keys', keys).out, /0 coverage problems/);
  assert.match(ok('check', h).out, /format only/);
  // The same row again is a no-op; another value for it is refused and leaves the file alone.
  ok('add-field', h, '--key', 'UCrSomething::bFlag', '--cl', '128786', '--offset', '0x565', '--size', '0x1', '--mask', '0x10');
  assert.equal(run('add-field', h, '--key', 'UCrSomething::bFlag', '--cl', '128786', '--offset', '0x566', '--size', '0x1', '--mask', '0x10').code, 2);
  assert.equal(readFileSync(h, 'utf8'), fixture('plugin.h'));
  // Usage errors.
  assert.equal(run('add-function', h, '--key', 'K', '--cl', '127004', '--rva', '0x10').code, 2);
  assert.equal(run('add-field', h, '--key', 'K', '--cl', '127004', '--offset', '16', '--size', '0x4').code, 2);
  assert.equal(run('check', h, '--bogus', 'x').code, 2);
  assert.equal(run('prune', h, '--keep', '130001').code, 2);
  assert.equal(run('remove-key', h, '--key', 'No::Such').code, 2);
  assert.equal(run('replace-build', h, '--cl', '130001', '--stamp', '0x1', '--size', '0x2', '--source', 'public 1').code, 2);
  assert.equal(readFileSync(h, 'utf8'), fixture('plugin.h'));
  // A hand edit makes every command refuse the file.
  writeFileSync(h, fixture('plugin.h').replace('0x2D0', '0x2d0'));
  assert.equal(run('check', h).code, 2);
  writeFileSync(h, fixture('plugin.h'));
  ok('remove-key', h, '--key', 'UCrSomething::bFlag');
  ok('replace-build', h, '--cl', '127004', '--stamp', '0x68F0A1B3', '--size', '0x0A3F2000', '--source', 'public 25700000');
  assert.match(ok('check', h).out, /2 builds, 2 function rows, 2 field rows/);
  ok('prune', h, '--keep', '128786');
  assert.match(ok('check', h).out, /1 builds, 2 function rows, 2 field rows/);
});

// The fixtures as C++: the plugin map against the row types plugin_interface.h
// v71 will declare, the loader map on its own.
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
    writeFileSync(src, `#include "${join(FIX, name).replace(/\\/g, '/')}"\nstatic_assert(VersionMap::kFormatVersion == 1);\nstatic_assert(VersionMap::kFunctions.size() == 0 || VersionMap::kFunctions.back().first + VersionMap::kFunctions.back().count == VersionMap::kFunctionRows.size());\nint main() { return 0; }\n`);
    const r = spawnSync(compiler, ['-std=c++20', '-fsyntax-only', '-Wall', '-Wextra', '-Werror', '-I', dir, src], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});
