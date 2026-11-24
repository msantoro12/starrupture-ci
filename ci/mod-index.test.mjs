// Tests for the mod-index kind: ci/mod-index.mjs and the `mod-index` kind of ci/vmap-sign.mjs.
//
//   node --test ci/mod-index.test.mjs
//
// Every key here is generated for the test run; no private key is in the repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOD_INDEX_MAX_BYTES, bodyOf, buildModIndex, checkBody } from './mod-index.mjs';
import { signFeed, verifyFeed } from './vmap-sign.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = 1_800_000_000;
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), hex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
};
const KEYS = (hex) => ({ k1: { hex, test: false } });
const reason = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };
const INDEX = '{\n  "schema": 1,\n  "mods": [\n    { "name": "Codex", "url": "https://example.test/codex" }\n  ]\n}\n';
const sign = (k, unsigned, extra = {}) => signFeed(unsigned, k.pem, { keyId: 'k1', kind: 'mod-index', now: NOW, ...extra });
const verify = (k, text, extra = {}) => verifyFeed(text, { keys: KEYS(k.hex), now: NOW, kind: 'mod-index', ...extra });
// Signs `body` as the signer would, but past its checks, to prove the verifier refuses it on its own.
const forge = (k, bodyLines) => {
  const body = bodyLines.join('\n');
  return `${body}sig\tk1\t${edSign(null, Buffer.from(body), createPrivateKey(k.pem)).toString('base64')}\n`;
};

test('build: the file is the format and kind lines then the index byte for byte', () => {
  assert.equal(buildModIndex(INDEX), `format\t1\nkind\tmod-index\n${INDEX}`);
});

test('build refuses a CR, no final LF, bad JSON, a non-object, an empty file and one over the cap', () => {
  assert.match(reason(() => buildModIndex(INDEX.replace(/\n/g, '\r\n'))), /CR/);
  assert.match(reason(() => buildModIndex(INDEX.trimEnd())), /does not end in LF/);
  assert.match(reason(() => buildModIndex('{"a": \n')), /not valid JSON/);
  assert.match(reason(() => buildModIndex('[1]\n')), /not a JSON object/);
  assert.match(reason(() => buildModIndex('"x"\n')), /not a JSON object/);
  assert.match(reason(() => buildModIndex('null\n')), /not a JSON object/);
  assert.match(reason(() => buildModIndex('')), /empty/);
  const big = `{"pad":"${'a'.repeat(MOD_INDEX_MAX_BYTES)}"}\n`;
  assert.match(reason(() => buildModIndex(big)), /over/);
  assert.match(reason(() => buildModIndex('{\n"a":\n1,\nsig\tk1\tAAAA\n}\n')), /sig or seq/);
  assert.equal(checkBody(INDEX), undefined);
});

test('signing round trip: seq second, kind third, body byte for byte, sig last, and it verifies', () => {
  const k = pair();
  const { text, seq } = sign(k, buildModIndex(INDEX));
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['format\t1', `seq\t${NOW}`, 'kind\tmod-index']);
  assert.match(lines[lines.length - 2], /^sig\tk1\t[A-Za-z0-9+/]{86}==$/);
  assert.equal(bodyOf(text), INDEX);
  assert.deepEqual(verify(k, text), { keyId: 'k1', seq, test: false });
  assert.equal(sign(k, buildModIndex(INDEX), { seq: NOW + 5, lastSeq: NOW }).seq, NOW + 5);
});

test('a changed body byte, a wrong key and a missing signature do not verify', () => {
  const k = pair();
  const { text } = sign(k, buildModIndex(INDEX));
  assert.match(reason(() => verify(k, text.replace('Codex', 'Codey'))), /signature does not verify/);
  assert.match(reason(() => verify(pair(), text)), /signature does not verify/);
  assert.match(reason(() => verify(k, text.slice(0, text.lastIndexOf('sig\t')))), /not a sig line/);
});

test('the signer and the verifier refuse a body with a sig or seq line, a CR, or bad JSON', () => {
  const k = pair();
  const unsigned = (body) => `format\t1\nkind\tmod-index\n${body}`;
  const sigBody = '{\n"a":\n1,\nsig\tk1\tAAAA\n}\n';
  assert.match(reason(() => sign(k, unsigned(sigBody))), /seq or sig line|sig or seq/);
  assert.match(reason(() => sign(k, unsigned(INDEX.replace(/\n/g, '\r\n')))), /CR/);
  assert.match(reason(() => sign(k, unsigned('{"a": \n'))), /not valid JSON/);
  assert.match(reason(() => sign(k, unsigned('[1]\n'))), /not a JSON object/);
  assert.match(reason(() => sign(k, `format\t1\n${INDEX}`)), /kind line/);
  assert.match(reason(() => sign(k, `format\t1\nkind\tplugin-catalog\n${INDEX}`)), /kind line/);
  assert.match(reason(() => sign(k, `format\t1\nkind\tmod-index\n${'{"p":"'}${'a'.repeat(MOD_INDEX_MAX_BYTES)}"}\n`)), /mod index is over/);
  // a correct signature over such a file (made past the signer) does not make it verify
  assert.match(reason(() => verify(k, forge(k, ['format\t1', `seq\t${NOW}`, 'kind\tmod-index', '{', '"a":', '1,', 'sig\tk1\tAAAA', '}', '']))), /sig or seq/);
  assert.match(reason(() => verify(k, forge(k, ['format\t1', `seq\t${NOW}`, 'kind\tmod-index', '[1]', '']))), /not a JSON object/);
  assert.match(reason(() => verify(k, forge(k, ['format\t1', `seq\t${NOW}`, 'kind\tmod-index', '{"a": ', '']))), /not valid JSON/);
  assert.match(reason(() => verify(k, forge(k, ['format\t1', `seq\t${NOW}`, 'kind\tmod-index', '{}\r', '']))), /CR/);
  assert.match(reason(() => verify(k, forge(k, ['format\t1', `seq\t${NOW}`, '{}', '']))), /kind line/);
});

test('the kinds never cross-verify: a mod index is not a feed or a catalog, and neither is one a mod index', () => {
  const k = pair();
  const { text } = sign(k, buildModIndex(INDEX));
  assert.match(reason(() => verifyFeed(text, { keys: KEYS(k.hex), now: NOW })), /kind line/);
  assert.match(reason(() => verifyFeed(text, { keys: KEYS(k.hex), now: NOW, kind: 'catalog' })), /kind line/);
  const feed = signFeed(readFileSync(join(here, 'fixtures', 'version-map', 'loader.feed.txt'), 'utf8').replace(/\r\n/g, '\n'), k.pem, { keyId: 'k1', now: NOW }).text;
  assert.match(reason(() => verify(k, feed)), /kind line/);
  const catalog = signFeed(readFileSync(join(here, 'fixtures', 'plugin-catalog', 'catalog-unsigned.txt'), 'utf8').replace(/\r\n/g, '\n'), k.pem, { keyId: 'k1', kind: 'catalog', now: NOW }).text;
  assert.match(reason(() => verify(k, catalog)), /kind line/);
  assert.match(reason(() => signFeed(buildModIndex(INDEX), k.pem, { keyId: 'k1', now: NOW })), /kind line/);
  assert.match(reason(() => signFeed(buildModIndex(INDEX), k.pem, { keyId: 'k1', now: NOW, kind: 'nope' })), /the kind is/);
});

test('the file cap is checked on the whole file by the signer and by the verifier', () => {
  const k = pair();
  const pad = (n) => `{"pad":"${'a'.repeat(n)}"}\n`;
  const fits = MOD_INDEX_MAX_BYTES - 'format\t1\nkind\tmod-index\n{"pad":""}\n'.length;
  // the signed file carries a seq line and a sig line on top of the unsigned text
  const signedLen = (n) => Buffer.byteLength(sign(k, `format\t1\nkind\tmod-index\n${pad(n)}`).text);
  const extra = Buffer.byteLength(sign(k, `format\t1\nkind\tmod-index\n${pad(1)}`).text) - Buffer.byteLength(`format\t1\nkind\tmod-index\n${pad(1)}`);
  const fitsSigned = fits - extra;
  // a body that fits signed signs, and the verifier accepts it
  const ok = sign(k, `format\t1\nkind\tmod-index\n${pad(fitsSigned)}`);
  assert.equal(Buffer.byteLength(ok.text), MOD_INDEX_MAX_BYTES);
  assert.equal(verify(k, ok.text).keyId, 'k1');
  assert.equal(signedLen(fitsSigned - 1), MOD_INDEX_MAX_BYTES - 1);
  // one that fits unsigned but not signed is refused at sign time
  assert.match(reason(() => sign(k, `format\t1\nkind\tmod-index\n${pad(fitsSigned + 1)}`)), /signed mod index is over/);
  assert.match(reason(() => sign(k, `format\t1\nkind\tmod-index\n${pad(fits)}`)), /signed mod index is over/);
  assert.match(reason(() => sign(k, `format\t1\nkind\tmod-index\n${pad(fits + 1)}`)), /over/);
  const big = forge(k, ['format\t1', `seq\t${NOW}`, 'kind\tmod-index', pad(MOD_INDEX_MAX_BYTES), '']);
  assert.match(reason(() => verify(k, big)), /over the mod index cap/);
});

test('same: the published body equals index.json byte for byte, a changed byte or a different file does not', () => {
  const k = pair();
  const dir = mkdtempSync(join(tmpdir(), 'mod-index-'));
  const f = (n) => join(dir, n);
  writeFileSync(f('index.json'), INDEX);
  writeFileSync(f('asset.txt'), sign(k, buildModIndex(INDEX)).text);
  const run = (...a) => spawnSync(process.execPath, [join(here, 'mod-index.mjs'), ...a], { encoding: 'utf8', windowsHide: true });
  assert.equal(run('same', f('asset.txt'), f('index.json')).status, 0);
  writeFileSync(f('index2.json'), INDEX.replace('Codex', 'Codey'));
  assert.equal(run('same', f('asset.txt'), f('index2.json')).status, 1);
  writeFileSync(f('index3.json'), `${INDEX}\n`);
  assert.equal(run('same', f('asset.txt'), f('index3.json')).status, 1);
  assert.equal(run('same', f('asset.txt')).status, 2);
  // build through the command line writes the unsigned file the signer takes
  assert.equal(run('build', f('index.json'), '--out', f('unsigned.txt')).status, 0);
  assert.equal(readFileSync(f('unsigned.txt'), 'utf8'), `format\t1\nkind\tmod-index\n${INDEX}`);
  writeFileSync(f('crlf.json'), INDEX.replace(/\n/g, '\r\n'));
  const bad = run('build', f('crlf.json'), '--out', f('x.txt'));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /CR/);
  writeFileSync(f('bom.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(INDEX)]));
  const bom = run('build', f('bom.json'), '--out', f('x.txt'));
  assert.equal(bom.status, 2);
  assert.match(bom.stderr, /byte order mark/);
});
