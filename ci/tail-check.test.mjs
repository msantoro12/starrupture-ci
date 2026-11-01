// Tests for tail-check.mjs.
//
//   node --test ci/tail-check.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addFunction, emit, parse, parseKeys, unionKeys } from './version-map.mjs';
import { checkBuildCl, checkMigrated, declaresMigrated, readOffsets } from './tail-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'tail-check.mjs');

// ---- migrated -------------------------------------------------------------------

const SRC = 'PluginInfo info = { "Fixture", "1.0", "x", "y", 72, 0, PLUGIN_GAME_BUILT_CL, PLUGIN_MAP_MIGRATED };\n';
const USED = ['AFoo', 'AFoo::Bar', 'AFoo::Baz', 'FVec::X', 'UEngine::Tick'];
const keys = (text) => unionKeys([parseKeys(text)]);

test('a plugin that declares the flag with one used member uncovered fails, naming it', () => {
  const r = checkMigrated({ sources: [SRC], used: USED, keys: keys('field AFoo::Bar\n'), checks: ['FVec::X'], engine: ['UEngine'] });
  assert.equal(r.declared, true);
  assert.deepEqual(r.uncovered, ['AFoo::Baz']);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^AFoo::Baz: /);
});

test('the same plugin passes when that member is a field, a native field, a check row or an engine member', () => {
  for (const cover of [
    { keys: keys('field AFoo::Bar\nfield AFoo::Baz\n'), checks: ['FVec::X'], engine: ['UEngine'] },
    { keys: keys('field AFoo::Bar\nnative AFoo::Baz 0x10 0x4 0x00\n'), checks: ['FVec::X'], engine: ['UEngine'] },
    { keys: keys('field AFoo::Bar\n'), checks: ['FVec::X', 'AFoo::Baz'], engine: ['UEngine::Tick'] },
    { keys: keys('field AFoo::Bar\n'), checks: ['FVec::X'], engine: ['UEngine', 'AFoo'] },
  ]) {
    const r = checkMigrated({ sources: [SRC], used: USED, ...cover });
    assert.deepEqual(r.problems, [], JSON.stringify(cover));
  }
});

test('a plugin that does not declare the flag is not held to the used set', () => {
  const r = checkMigrated({ sources: ['PluginInfo info = { "Fixture", "1.0", "x", "y", 72, 0 };'], used: USED, keys: keys('field AFoo::Bar\n') });
  assert.equal(r.declared, false);
  assert.deepEqual(r.problems, []);
  assert.ok(r.uncovered.length > 0);
});

test('the flag counts only in code, not in a comment or a string', () => {
  assert.equal(declaresMigrated('// PLUGIN_MAP_MIGRATED later\nint x;'), false);
  assert.equal(declaresMigrated('/* PLUGIN_MAP_MIGRATED */ int x;'), false);
  assert.equal(declaresMigrated('const char* s = "PLUGIN_MAP_MIGRATED";'), false);
  assert.equal(declaresMigrated('uint32_t mapFlags = PLUGIN_MAP_MIGRATED;'), true);
  assert.equal(declaresMigrated('x = MY_PLUGIN_MAP_MIGRATED_2;'), false);
});

// ---- build-cl -------------------------------------------------------------------

const BASIC = `namespace Offsets
{
	constexpr int32 GObjects = 0x08E2D3B0;
	constexpr int32 AppendString = 0x01234560;
	constexpr int32 GNames = 0x0DEAD000;
	constexpr int32 GWorld = 0x0E000000;
}`;

function loaderMap() {
  const map = parse(readFileSync(join(here, 'fixtures', 'version-map', 'loader.h'), 'utf8').replace(/\r\n/g, '\n'));
  for (const cl of [127004, 128786]) {
    addFunction(map, { key: 'FName::AppendString', kind: 1, fp: 0, cl, pattern: '48 89 5C 24 ??', resultOffset: 0, followRel32At: -1, followRipDispAt: -1, rva: cl === 128786 ? 0x01234560 : 0x01230000 });
  }
  return map;
}

test('a build_cl.txt that names the CL its dump belongs to passes', () => {
  const r = checkBuildCl({ buildCl: '128786\n', basic: BASIC, map: loaderMap() });
  assert.deepEqual(r.problems, []);
  assert.equal(r.cl, 128786);
  // GWorld and GNames differ from the engine's by design: reported, not enforced.
  assert.equal(r.notes.length, 1, r.notes.join('\n'));
  assert.ok(r.notes.some((n) => n.includes('GWorld')));
});

test('a build_cl.txt that names the wrong CL for its dump fails', () => {
  const r = checkBuildCl({ buildCl: '127004\n', basic: BASIC, map: loaderMap() });
  assert.ok(r.problems.length >= 2);
  assert.ok(r.problems.some((p) => p.includes('Offsets::GObjects') && p.includes('wrong CL')));
  assert.ok(r.problems.some((p) => p.includes('Offsets::AppendString')));
});

test('a CL outside the build table, and a file that is not a CL, fail', () => {
  assert.match(checkBuildCl({ buildCl: '999999', basic: BASIC, map: loaderMap() }).problems[0], /not in the map's build table/);
  assert.match(checkBuildCl({ buildCl: 'CL-128786', basic: BASIC, map: loaderMap() }).problems[0], /not one CL number/);
});

test('Basic.hpp offsets are read by name', () => {
  assert.deepEqual(readOffsets(BASIC), { GObjects: 0x08e2d3b0, AppendString: 0x01234560, GNames: 0x0dead000, GWorld: 0x0e000000 });
});

// ---- command line -----------------------------------------------------------------

test('the command line exits 3 on a failed check and 0 on a passing one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailcheck-'));
  const w = (name, text) => { writeFileSync(join(dir, name), text); return join(dir, name); };
  const common = ['migrated', '--used', w('used.txt', USED.join('\n')), '--checks', w('checks.txt', 'FVec::X\n'), '--engine', w('engine.txt', 'UEngine\n'), '--source', w('plugin.cpp', SRC)];
  const bad = spawnSync(process.execPath, [TOOL, ...common, '--keys', w('k1.txt', 'field AFoo::Bar\n')], { encoding: 'utf8', windowsHide: true });
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /AFoo::Baz/);
  const good = spawnSync(process.execPath, [TOOL, ...common, '--keys', w('k2.txt', 'field AFoo::Bar\nfield AFoo::Baz\n')], { encoding: 'utf8', windowsHide: true });
  assert.equal(good.status, 0, good.stderr);
  const m = w('map.h', emit(loaderMap()));
  const wrong = spawnSync(process.execPath, [TOOL, 'build-cl', '--build-cl', w('cl.txt', '127004\n'), '--basic', w('Basic.hpp', BASIC), '--map', m], { encoding: 'utf8', windowsHide: true });
  assert.equal(wrong.status, 3);
  const right = spawnSync(process.execPath, [TOOL, 'build-cl', '--build-cl', w('cl2.txt', '128786\n'), '--basic', join(dir, 'Basic.hpp'), '--map', m], { encoding: 'utf8', windowsHide: true });
  assert.equal(right.status, 0, right.stderr);
});
