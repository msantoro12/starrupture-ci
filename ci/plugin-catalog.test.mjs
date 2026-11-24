// Tests for plugin-catalog.mjs and the catalog kind of vmap-sign.mjs.
//
//   node --test ci/plugin-catalog.test.mjs
//
// Every key is generated for the test run; no private key is in the repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_MAX_BYTES, buildCatalog, parseCatalog } from './plugin-catalog.mjs';
import { signFeed, verifyFeed } from './vmap-sign.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(here, 'fixtures', 'plugin-catalog', name), 'utf8').replace(/\r\n/g, '\n');
const feedFixture = () => readFileSync(join(here, 'fixtures', 'version-map', 'loader.feed.txt'), 'utf8').replace(/\r\n/g, '\n');
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), hex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
};
const NOW = 1_800_000_000;
const KEYS = (hex) => ({ k1: { hex, test: false } });
const reasons = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };
const HEAD = 'format\t1\nkind\tplugin-catalog\n';
const cat = (...rows) => HEAD + rows.map((r) => `${r}\n`).join('');
const sign = (text, k, extra = {}) => signFeed(text, k.pem, { keyId: 'k1', now: NOW, kind: 'catalog', ...extra });
const verify = (text, k, extra = {}) => verifyFeed(text, { keys: KEYS(k.hex), now: NOW, kind: 'catalog', ...extra });

test('build turns the JSON input into the sorted unsigned catalog, the same bytes every time', () => {
  const input = JSON.parse(fx('catalog-in.json'));
  assert.equal(buildCatalog(input), fx('catalog-unsigned.txt'));
  input.plugins.reverse();
  assert.equal(buildCatalog(input), fx('catalog-unsigned.txt'));
});

test('the command line builds the file and exits 2 on bad input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-catalog-'));
  const out = join(dir, 'unsigned.txt');
  const tool = join(here, 'plugin-catalog.mjs');
  const input = join(here, 'fixtures', 'plugin-catalog', 'catalog-in.json');
  const r = spawnSync(process.execPath, [tool, 'build', input, '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, 'utf8'), fx('catalog-unsigned.txt'));
  const bad = spawnSync(process.execPath, [tool, 'build', out, '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(bad.status, 2);
});

test('parse reads the rows back', () => {
  const c = parseCatalog(fx('catalog-unsigned.txt'));
  assert.equal(c.seq, null);
  assert.deepEqual(c.plugins.map((p) => [p.name, p.version, p.features.map((f) => [f.id, f.off, f.title])]), [
    ['Codex', '2.0.0-dev.1', [['pins', '-', 'Pin collapse']]],
    ['WAILA', '1.2.3', [['badge', '*', 'Health badge'], ['tooltip', '127004,130045', 'Block tooltip']]],
  ]);
});

test('signs with a test key and verifies; the signed file has the kind line third and the sig last', () => {
  const k = pair();
  const { text, seq } = sign(fx('catalog-unsigned.txt'), k);
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['format\t1', `seq\t${NOW}`, 'kind\tplugin-catalog']);
  assert.match(lines[lines.length - 2], /^sig\tk1\t[A-Za-z0-9+/]{86}==$/);
  assert.deepEqual(verify(text, k), { keyId: 'k1', seq, test: false });
  assert.equal(parseCatalog(text).seq, NOW);
});

test('multibyte titles sign and verify as UTF-8', () => {
  const k = pair();
  const { text } = sign(cat('plugin\tA\t1', 'feature\tA\tx\t-\tKarte üä'), k);
  assert.equal(verify(text, k).seq, NOW);
});

test('REFUSED: a tampered body byte, a tampered signature, a wrong key id', () => {
  const k = pair();
  const { text } = sign(fx('catalog-unsigned.txt'), k);
  assert.match(reasons(() => verify(text.replace('1.2.3', '1.2.4'), k)), /does not verify/);
  assert.match(reasons(() => verify(text.replace(/(sig\tk1\t.)(.)/, (m, a, b) => a + (b === 'A' ? 'B' : 'A')), k)), /does not verify/);
  assert.match(reasons(() => verify(text.replace('\tk1\t', '\tk3\t'), k)), /unknown key ID k3/);
  assert.match(reasons(() => verify(text, pair())), /does not verify/);
});

test('REFUSED: a signed version map as a catalog, and a signed catalog as a version map', () => {
  const k = pair();
  const feed = signFeed(feedFixture(), k.pem, { keyId: 'k1', now: NOW }).text;
  assert.match(reasons(() => verify(feed, k)), /kind line/);
  const catalog = sign(fx('catalog-unsigned.txt'), k).text;
  assert.match(reasons(() => verifyFeed(catalog, { keys: KEYS(k.hex), now: NOW })), /kind line/);
  assert.match(reasons(() => verifyFeed(catalog, { keys: KEYS(k.hex), now: NOW, kind: 'feed' })), /kind line/);
});

test('REFUSED: a catalog without its kind line, signed or not', () => {
  const k = pair();
  const noKind = 'format\t1\nplugin\tA\t1\n';
  assert.match(reasons(() => sign(noKind, k)), /kind line/);
  assert.match(reasons(() => parseCatalog(noKind)), /kind line/);
  assert.match(reasons(() => parseCatalog('catalog\t1\nkind\tplugin-catalog\n')), /first line/);
});

test('REFUSED: seq not above --last-seq', () => {
  const k = pair();
  const { text } = sign(fx('catalog-unsigned.txt'), k);
  assert.match(reasons(() => verify(text, k, { lastSeq: NOW })), /does not rise/);
  assert.match(reasons(() => verify(text, k, { lastSeq: NOW + 1 })), /does not rise/);
  assert.equal(verify(text, k, { lastSeq: NOW - 1 }).seq, NOW);
  assert.match(reasons(() => sign(fx('catalog-unsigned.txt'), k, { seq: NOW, lastSeq: NOW })), /does not rise/);
  assert.equal(sign(fx('catalog-unsigned.txt'), k, { lastSeq: NOW }).seq, NOW + 1);
});

test('REFUSED: duplicates, compared without regard to case', () => {
  const k = pair();
  const p = 'plugin\tWAILA\t1';
  assert.match(reasons(() => sign(cat(p, 'plugin\tWAILA\t2'), k)), /listed twice/);
  assert.match(reasons(() => sign(cat(p, 'plugin\twaila\t2'), k)), /listed twice/);
  assert.match(reasons(() => sign(cat(p, 'feature\tWAILA\tTip\t-\tT', 'feature\tWAILA\ttip\t-\tT'), k)), /listed twice/);
  assert.match(reasons(() => buildCatalog({ plugins: [{ name: 'A', version: '1' }, { name: 'a', version: '1' }] })), /listed twice/);
  assert.match(reasons(() => parseCatalog(cat(p, 'feature\tWAILA\tx\t-\tT', 'feature\tWAILA\tx\t*\tT'))), /listed twice/);
});

test('a plugin name with single spaces: Best Builder parses, builds and takes feature rows', () => {
  const rows = ['plugin	Best Builder	1.0', 'feature	Best Builder	grid	-	Grid'];
  const c = parseCatalog(cat(...rows));
  assert.equal(c.plugins[0].name, 'Best Builder');
  assert.equal(c.plugins[0].features[0].id, 'grid');
  const text = buildCatalog({ plugins: [{ name: 'Best Builder', version: '1.0', features: [{ id: 'grid', title: 'Grid' }] }] });
  assert.equal(text, cat(...rows));
  assert.ok(reasons(() => parseCatalog(cat('plugin	Best Builder	1', 'feature	Best  Builder	x	-	T'))), 'feature must name the plugin exactly');
  assert.equal(parseCatalog(cat(`plugin	${'a'.repeat(31)} ${'b'.repeat(32)}	1`)).plugins.length, 1);
});

test('REFUSED: a bad spaced name, a space in a feature id, a name that differs only by case', () => {
  const bad = [' A', 'A ', 'A  B', 'A	B'.replace('	', ' '), 'A B ', `${'a'.repeat(32)} ${'b'.repeat(32)}`, 'a'.repeat(65), 'é'];
  for (const n of bad) assert.ok(reasons(() => parseCatalog(cat(`plugin	${n}	1`))), JSON.stringify(n));
  assert.ok(reasons(() => parseCatalog(cat('plugin	A	1', 'feature	A	x y	-	T'))), 'no space in an id');
  assert.ok(reasons(() => buildCatalog({ plugins: [{ name: 'A	B', version: '1' }] })), 'tab');
  assert.match(reasons(() => parseCatalog(cat('plugin	Best Builder	1', 'plugin	best builder	1'))), /listed twice/);
});

test('REFUSED: a feature before its plugin row, or for another plugin', () => {
  assert.match(reasons(() => parseCatalog(cat('feature\tA\tx\t-\tT', 'plugin\tA\t1'))), /before its plugin row/);
  assert.match(reasons(() => parseCatalog(cat('plugin\tA\t1', 'feature\tB\tx\t-\tT'))), /before its plugin row/);
});

test('REFUSED: bad characters or lengths in name, id, version', () => {
  const rows = ['plugin\tbad.name\t1', 'plugin\tA.B\t1', 'plugin\t\t1', `plugin\t${'a'.repeat(65)}\t1`, 'plugin\tA\t', 'plugin\tA\tv 1', `plugin\tA\t${'1'.repeat(33)}`];
  for (const row of rows) assert.ok(reasons(() => parseCatalog(cat(row))), row);
  assert.equal(parseCatalog(cat(`plugin\t${'a'.repeat(64)}\t${'1'.repeat(32)}`)).plugins.length, 1);
  assert.equal(parseCatalog(cat('plugin\tA_b-1\t1.0+x_y-z')).plugins.length, 1);
  assert.ok(reasons(() => parseCatalog(cat('plugin\tA\t1', 'feature\tA\ta.b\t-\tT'))), 'no dot in an id');
  assert.ok(reasons(() => parseCatalog(cat('plugin\tA\t1', `feature\tA\t${'a'.repeat(65)}\t-\tT`))));
});

test('title limits are in UTF-8 bytes: 80 passes, 81 is refused, multibyte counts by byte', () => {
  const t = (title) => cat('plugin\tA\t1', `feature\tA\tx\t-\t${title}`);
  assert.equal(parseCatalog(t('a'.repeat(80))).plugins[0].features.length, 1);
  assert.match(reasons(() => parseCatalog(t('a'.repeat(81)))), /81 bytes/);
  assert.equal(parseCatalog(t('ü'.repeat(40))).plugins.length, 1);
  assert.match(reasons(() => parseCatalog(t('ü'.repeat(41)))), /82 bytes/);
  assert.match(reasons(() => parseCatalog(t(''))), /0 bytes/);
  assert.match(reasons(() => parseCatalog(t('a\u0001b'))), /control/);
  assert.match(reasons(() => parseCatalog(t('a\u007fb'))), /control/);
});

test('REFUSED: 201 plugins and 2001 feature rows; the limits themselves pass', () => {
  const plugins = (n) => Array.from({ length: n }, (_, i) => `plugin\tP${i}\t1`);
  assert.equal(parseCatalog(cat(...plugins(200))).plugins.length, 200);
  assert.match(reasons(() => parseCatalog(cat(...plugins(201)))), /more than 200 plugins/);
  const feats = (n) => Array.from({ length: n }, (_, i) => `feature\tP0\tf${i}\t-\tT`);
  assert.equal(parseCatalog(cat('plugin\tP0\t1', ...feats(2000))).plugins[0].features.length, 2000);
  assert.match(reasons(() => parseCatalog(cat('plugin\tP0\t1', ...feats(2001)))), /more than 2000 feature rows/);
});

test('REFUSED: an unknown row type, a wrong field count, a blank or comment line', () => {
  assert.match(reasons(() => parseCatalog(cat('widget\tA\t1'))), /unknown row type/);
  assert.match(reasons(() => parseCatalog(cat('plugin\tA'))), /plugin row is/);
  assert.match(reasons(() => parseCatalog(cat('plugin\tA\t1\textra'))), /plugin row is/);
  assert.match(reasons(() => parseCatalog(cat('plugin\tA\t1', 'feature\tA\tx\t-'))), /feature row is/);
  assert.match(reasons(() => parseCatalog(cat('plugin\tA\t1', 'feature\tA\tx\t-\tT\textra'))), /feature row is/);
  assert.ok(reasons(() => parseCatalog(cat('plugin\tA\t1', ''))));
  assert.ok(reasons(() => parseCatalog(cat('# note'))));
  assert.match(reasons(() => parseCatalog(HEAD.replace(/\n/g, '\r\n'))), /CR/);
});

test('REFUSED: a bad off token; - * and CL lists pass', () => {
  const off = (o) => cat('plugin\tA\t1', `feature\tA\tx\t${o}\tT`);
  for (const ok of ['-', '*', '127004', '127004,130045']) assert.equal(parseCatalog(off(ok)).plugins[0].features[0].off, ok);
  for (const bad of ['', 'x', '12a', '1,', ',1', '1,,2', '1;2', '-1', '*,1', '-,1', '1,1', ' 1']) assert.match(reasons(() => parseCatalog(off(bad))), /off/, JSON.stringify(bad));
  assert.match(reasons(() => buildCatalog({ plugins: [{ name: 'A', version: '1', features: [{ id: 'x', title: 'T', off: ['12a'] }] }] })), /off/);
});

test('REFUSED: a CL with a leading zero or over 10 digits; 0 and 10 digits pass', () => {
  const off = (o) => cat('plugin\tA\t1', `feature\tA\tx\t${o}\tT`);
  for (const ok of ['0', '0,5', '1234567890', '9999999999']) assert.equal(parseCatalog(off(ok)).plugins[0].features[0].off, ok);
  for (const bad of ['012', '00', '1,012', '12345678901']) assert.match(reasons(() => parseCatalog(off(bad))), /off/, bad);
  const build = (o) => buildCatalog({ plugins: [{ name: 'A', version: '1', features: [{ id: 'x', title: 'T', off: o }] }] });
  assert.match(build([0, 5]), /\t0,5\t/);
  assert.match(build([7, '0']), /\t0,7\t/);
  assert.match(reasons(() => build(['007'])), /CL number/);
  assert.match(reasons(() => build(['012', 5])), /CL number/);
  assert.match(reasons(() => build(['12345678901'])), /CL number/);
  assert.match(reasons(() => build([12345678901])), /CL number/);
});

test('REFUSED: a seq line with a leading zero or zero', () => {
  const seq = (s) => `format\t1\nseq\t${s}\nkind\tplugin-catalog\n`;
  for (const s of ['01', '007', '0']) assert.ok(reasons(() => parseCatalog(seq(s))), s);
  assert.equal(parseCatalog(seq('10')).seq, 10);
});

test('REFUSED: oversize', () => {
  const k = pair();
  const pad = (n) => { const base = cat('plugin\tA\t1'); return base + 'x'.repeat(n - Buffer.byteLength(base) - 1) + '\n'; };
  assert.match(reasons(() => sign(pad(CATALOG_MAX_BYTES + 1), k)), /over/);
  assert.match(reasons(() => parseCatalog(pad(CATALOG_MAX_BYTES + 1))), /over/);
  // At the cap the size passes and the grammar still refuses the padding row.
  assert.match(reasons(() => sign(pad(CATALOG_MAX_BYTES), k)), /unknown row type/);
});

test('the command line signs and verifies a catalog, and refuses it as a feed', () => {
  const k = pair();
  const dir = mkdtempSync(join(tmpdir(), 'plugin-catalog-'));
  const src = join(dir, 'unsigned.txt');
  const key = join(dir, 'k.pem');
  const out = join(dir, 'signed.txt');
  writeFileSync(src, fx('catalog-unsigned.txt'));
  writeFileSync(key, k.pem);
  const run = (...a) => spawnSync(process.execPath, [join(here, 'vmap-sign.mjs'), ...a], { encoding: 'utf8', windowsHide: true });
  const s = run('sign', src, '--out', out, '--key-id', 'k1', '--key-file', key, '--kind', 'catalog', '--last-seq', '5', '--now', String(NOW));
  assert.equal(s.status, 0, s.stderr);
  const pub = `k1=${k.hex}`;
  const v = run('verify', out, '--pub', pub, '--kind', 'catalog', '--last-seq', '5', '--now', String(NOW));
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout, `ok seq=${NOW} key=k1\n`);
  assert.equal(run('verify', out, '--pub', pub, '--now', String(NOW)).status, 3);
  assert.equal(run('verify', out, '--pub', pub, '--kind', 'catalog', '--last-seq', String(NOW), '--now', String(NOW)).status, 3);
  assert.equal(run('sign', src, '--out', out, '--key-id', 'k1', '--key-file', key, '--now', String(NOW)).status, 2);
});
