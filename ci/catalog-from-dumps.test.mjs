// Tests for catalog-from-dumps.mjs.
//
//   node --test ci/catalog-from-dumps.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeDumps, parseDump } from './catalog-from-dumps.mjs';
import { buildCatalog } from './plugin-catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(here, 'fixtures', 'catalog-dumps', name), 'utf8').replace(/\r\n/g, '\n');
const reasons = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };
const dump = (cl, ...rows) => `format\t1\nkind\tdeclared-features\ngame_cl\t${cl}\nloader\t1.23.2\n${rows.map((r) => `${r}\n`).join('')}`;
const merged = (...texts) => mergeDumps(texts.map(parseDump));

test('parseDump reads the fixture, spaces in plugin names included', () => {
  const d = parseDump(fx('build-100.txt'));
  assert.equal(d.gameCl, '100');
  assert.equal(d.loader, '1.23.2');
  assert.deepEqual(d.plugins[0], { name: 'Best Builder', version: '1.2.0', features: [
    { id: 'grid', state: 'on', title: 'Grid snapping' }, { id: 'copy', state: 'off', title: 'Copy and paste' }] });
});

test('merge across two builds lists only the CLs whose dump says off, never *', () => {
  const { input, warnings } = merged(fx('build-200.txt'), fx('build-100.txt'));
  assert.deepEqual(warnings, []);
  assert.deepEqual(input, { plugins: [
    { name: 'Best Builder', version: '1.2.0', features: [
      { id: 'copy', title: 'Copy and paste', off: ['100'] }, { id: 'grid', title: 'Grid snapping', off: '-' }] },
    { name: 'WAILA', version: '2.0.0', features: [{ id: 'tooltip', title: 'Block tooltip', off: ['200'] }] },
  ] });
  assert.match(buildCatalog(input), /feature\tBest Builder\tcopy\t100\tCopy and paste\n/);
});

test('a feature off on both builds lists both CLs, sorted numerically', () => {
  const { input } = merged(dump(1000, 'plugin\tP\t1.0', 'feature\tP\ta\toff\tA'), dump(99, 'plugin\tP\t1.0', 'feature\tP\ta\toff\tA'));
  assert.deepEqual(input.plugins[0].features[0].off, ['99', '1000']);
});

test('all on everywhere is "-"', () => {
  const { input } = merged(dump(1, 'plugin\tP\t1.0', 'feature\tP\ta\ton\tA'), dump(2, 'plugin\tP\t1.0', 'feature\tP\ta\ton\tA'));
  assert.equal(input.plugins[0].features[0].off, '-');
});

test('a plugin or feature missing from some dumps is kept, off only from dumps that list it', () => {
  const { input, warnings } = merged(
    dump(1, 'plugin\tP\t1.0', 'feature\tP\ta\toff\tA'),
    dump(2, 'plugin\tP\t1.0', 'feature\tP\ta\ton\tA', 'feature\tP\tb\ton\tB', 'plugin\tQ\t3.0', 'feature\tQ\tz\toff\tZ'));
  assert.deepEqual(warnings, []);
  assert.deepEqual(input.plugins.map((p) => [p.name, p.features.map((f) => [f.id, f.off])]), [
    ['P', [['a', ['1']], ['b', '-']]], ['Q', [['z', ['2']]]]]);
});

test('a differing plugin version keeps the highest and warns', () => {
  const { input, warnings } = merged(dump(1, 'plugin\tP\t1.10.0'), dump(2, 'plugin\tP\t1.9.0'));
  assert.equal(input.plugins[0].version, '1.10.0');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plugin P: version differs.*kept 1\.10\.0/);
});

test('a differing title keeps the highest game CL and warns', () => {
  const { input, warnings } = merged(dump(300, 'plugin\tP\t1', 'feature\tP\ta\ton\tNew'), dump(100, 'plugin\tP\t1', 'feature\tP\ta\ton\tOld'));
  assert.equal(input.plugins[0].features[0].title, 'New');
  assert.match(warnings[0], /title differs.*CL 300/);
});

test('output is sorted by name then id whatever the dump order', () => {
  const { input } = merged(dump(1, 'plugin\tZed\t1', 'feature\tZed\tb\ton\tB', 'feature\tZed\ta\ton\tA', 'plugin\tAlpha\t1'));
  assert.deepEqual(input.plugins.map((p) => p.name), ['Alpha', 'Zed']);
  assert.deepEqual(input.plugins[1].features.map((f) => f.id), ['a', 'b']);
});

test('same game CL: identical dumps merge, different content is refused', () => {
  const a = dump(5, 'plugin\tP\t1', 'feature\tP\ta\ton\tA');
  assert.equal(merged(a, a).input.plugins.length, 1);
  assert.match(reasons(() => merged(a, dump(5, 'plugin\tP\t1', 'feature\tP\ta\toff\tA'))), /game CL 5 differ/);
});

test('parseDump refuses what it should', () => {
  const ok = dump(1, 'plugin\tP\t1');
  assert.equal(reasons(() => parseDump(ok)), null);
  assert.equal(reasons(() => parseDump(dump(0, 'plugin	P	1'))), null);
  assert.equal(reasons(() => parseDump(dump('1234567890', 'plugin	P	1'))), null);
  const bad = {
    'wrong format': ok.replace('format\t1', 'format\t2'),
    'bad kind': ok.replace('declared-features', 'plugin-catalog'),
    'non-digit CL': ok.replace('game_cl\t1', 'game_cl\t1x'),
    'leading-zero CL': ok.replace('game_cl	1', 'game_cl	012'),
    'CL over 10 digits': ok.replace('game_cl	1', 'game_cl	12345678901'),
    'no trailing LF': ok.slice(0, -1),
    CR: ok.replace(/\n/g, '\r\n'),
    'feature before plugin': dump(1, 'feature\tP\ta\ton\tA', 'plugin\tP\t1'),
    'unknown row': dump(1, 'plugin\tP\t1', 'extra\tx'),
    'bad state': dump(1, 'plugin\tP\t1', 'feature\tP\ta\tmaybe\tA'),
    'duplicate plugin, other case': dump(1, 'plugin\tP\t1', 'plugin\tp\t1'),
    'duplicate feature, other case': dump(1, 'plugin\tP\t1', 'feature\tP\ta\ton\tA', 'feature\tP\tA\ton\tB'),
    'bad id': dump(1, 'plugin\tP\t1', 'feature\tP\ta b\ton\tA'),
    'double space name': dump(1, 'plugin\tA  B\t1'),
    'short feature row': dump(1, 'plugin\tP\t1', 'feature\tP\ta\ton'),
  };
  for (const [what, text] of Object.entries(bad)) assert.ok(reasons(() => parseDump(text)), `${what} is refused`);
});

test('the command line writes the input, and the verdict follows the published rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfd-'));
  const run = (...args) => spawnSync(process.execPath, [join(here, 'catalog-from-dumps.mjs'), ...args], { encoding: 'utf8', windowsHide: true });
  const d1 = join(dir, 'a.txt'), d2 = join(dir, 'b.txt'), out = join(dir, 'in.json');
  writeFileSync(d1, fx('build-100.txt'));
  writeFileSync(d2, fx('build-200.txt'));

  // no published catalog (file absent): changed
  let r = run(d1, d2, '--out', out, '--published', join(dir, 'none.txt'), '--verdict', join(dir, 'v1'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'changed\n');
  assert.equal(readFileSync(join(dir, 'v1'), 'utf8'), 'changed');
  const input = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(input.plugins.length, 2);

  // published rows equal, with a seq and a signature line: unchanged
  const pub = join(dir, 'pub.txt');
  writeFileSync(pub, `${buildCatalog(input).replace('format\t1\n', 'format\t1\nseq\t7\n')}sig\tk1\tAAAA\n`);
  r = run(d1, d2, '--out', out, '--published', pub, '--verdict', join(dir, 'v2'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'unchanged\n');
  assert.equal(readFileSync(join(dir, 'v2'), 'utf8'), 'unchanged');

  // a feature went off on a build: changed, still exit 0
  writeFileSync(d2, fx('build-200.txt').replace('copy\ton', 'copy\toff'));
  r = run(d1, d2, '--out', out, '--published', pub, '--verdict', join(dir, 'v3'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'v3'), 'utf8'), 'changed');

  // warnings go to stderr; a bad dump exits 2 and writes nothing new
  writeFileSync(d2, 'format\t1\nkind\tbogus\n');
  r = run(d1, d2, '--out', join(dir, 'x.json'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /kind is not declared-features/);
});
