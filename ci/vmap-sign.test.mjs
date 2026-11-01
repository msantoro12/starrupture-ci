// Tests for vmap-sign.mjs.
//
//   node --test ci/vmap-sign.test.mjs
//
// Every key here is generated for the test run; no private key is in the repo.
// The one committed signed file is the loader's TEST-key fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportFeed, parse } from './version-map.mjs';
import { PUBLIC_KEYS, signFeed, verifyFeed } from './vmap-sign.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'vmap-sign.mjs');
const fixture = (...p) => readFileSync(join(here, 'fixtures', ...p), 'utf8').replace(/\r\n/g, '\n');
const unsigned = () => fixture('version-map', 'loader.feed.txt');

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), hex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
};
const NOW = 1_800_000_000;
const KEYS = (hex) => ({ k1: { hex, test: false } });
const reasons = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };

test('signs a feed that verifies, with seq as the second line and the signature last', () => {
  const k = pair();
  const { text, seq } = signFeed(unsigned(), k.pem, { keyId: 'k1', now: NOW });
  const lines = text.split('\n');
  assert.equal(lines[0], 'format\t1');
  assert.equal(lines[1], `seq\t${NOW}`);
  assert.match(lines[lines.length - 2], /^sig\tk1\t[A-Za-z0-9+/]{86}==$/);
  assert.equal(lines[lines.length - 1], '');
  assert.deepEqual(verifyFeed(text, { keys: KEYS(k.hex), now: NOW }), { keyId: 'k1', seq, test: false });
  // The body between the seq line and the sig line is the export, byte for byte.
  assert.equal(lines.slice(2, -2).join('\n') + '\n', unsigned().split('\n').slice(1).join('\n'));
});

test('verifies an export of the real exporter', () => {
  const k = pair();
  const text = exportFeed(parse(fixture('version-map', 'loader.h'), 'loader.h'));
  const { text: signed } = signFeed(text, k.pem, { keyId: 'k1', now: NOW });
  assert.equal(verifyFeed(signed, { keys: KEYS(k.hex), now: NOW }).seq, NOW);
});

test("accepts the loader's own fixture signed by the TEST key, and flags it", () => {
  const r = verifyFeed(fixture('vmap-sign', 'test-feed-k1.txt'), { now: 1761900000 });
  assert.deepEqual(r, { keyId: 'k1', seq: 1761900000, test: true });
  assert.equal(PUBLIC_KEYS.k1.test, true);
});

test('seq is max(now, last + 1)', () => {
  const k = pair();
  assert.equal(signFeed(unsigned(), k.pem, { keyId: 'k1', now: NOW, lastSeq: NOW - 5 }).seq, NOW);
  assert.equal(signFeed(unsigned(), k.pem, { keyId: 'k1', now: NOW, lastSeq: NOW }).seq, NOW + 1);
  assert.equal(signFeed(unsigned(), k.pem, { keyId: 'k1', now: NOW, lastSeq: NOW + 100 }).seq, NOW + 101);
});

test('the signer refuses a last seq that would put seq over a day ahead', () => {
  const k = pair();
  assert.match(reasons(() => signFeed(unsigned(), k.pem, { keyId: 'k1', now: NOW, lastSeq: NOW + 86400 })), /more than a day ahead/);
  assert.equal(signFeed(unsigned(), k.pem, { keyId: 'k1', now: NOW, lastSeq: NOW + 86399 }).seq, NOW + 86400);
});

test('the signer refuses a feed that is already signed, has CR, or is not an export', () => {
  const k = pair();
  const { text } = signFeed(unsigned(), k.pem, { keyId: 'k1', now: NOW });
  assert.match(reasons(() => signFeed(text, k.pem, { keyId: 'k1', now: NOW })), /already has/);
  assert.match(reasons(() => signFeed(unsigned().replace(/\n/g, '\r\n'), k.pem, { keyId: 'k1', now: NOW })), /expected an unsigned/);
  assert.match(reasons(() => signFeed('format\t1', k.pem, { keyId: 'k1', now: NOW })), /expected an unsigned/);
  assert.match(reasons(() => signFeed(unsigned(), k.pem, { keyId: 'k3', now: NOW })), /key ID/);
  assert.match(reasons(() => signFeed(unsigned() + 'x'.repeat(512 * 1024), k.pem, { keyId: 'k1', now: NOW })), /over/);
});

test('the verifier refuses a flipped byte, an unknown key, a truncation and an oversize file', () => {
  const k = pair();
  const { text } = signFeed(unsigned(), k.pem, { keyId: 'k1', now: NOW });
  const opts = { keys: KEYS(k.hex), now: NOW };
  const flipped = text.replace('0x00C01230', '0x00C01231');
  assert.notEqual(flipped, text);
  assert.match(reasons(() => verifyFeed(flipped, opts)), /does not verify/);
  assert.match(reasons(() => verifyFeed(text.replace('\tk1\t', '\tk2\t'), opts)), /unknown key ID k2/);
  assert.match(reasons(() => verifyFeed(text.slice(0, -40), opts)), /not a sig line|does not end/);
  assert.match(reasons(() => verifyFeed(text.slice(0, text.lastIndexOf('sig\t')), opts)), /not a sig line/);
  assert.match(reasons(() => verifyFeed(Buffer.alloc(1024 * 1024 + 1, 0x41), opts)), /over the loader/);
  assert.match(reasons(() => verifyFeed(text, { keys: KEYS(pair().hex), now: NOW })), /does not verify/);
});

test('the verifier refuses an equal or lower seq, and a seq over a day ahead', () => {
  const k = pair();
  const { text } = signFeed(unsigned(), k.pem, { keyId: 'k1', now: NOW });
  assert.equal(verifyFeed(text, { keys: KEYS(k.hex), now: NOW, lastSeq: NOW - 1 }).seq, NOW);
  assert.match(reasons(() => verifyFeed(text, { keys: KEYS(k.hex), now: NOW, lastSeq: NOW })), /does not rise/);
  assert.match(reasons(() => verifyFeed(text, { keys: KEYS(k.hex), now: NOW, lastSeq: NOW + 5 })), /does not rise/);
  assert.match(reasons(() => verifyFeed(text, { keys: KEYS(k.hex), now: NOW - 86401 })), /a day ahead/);
  assert.equal(verifyFeed(text, { keys: KEYS(k.hex), now: NOW - 86400 }).seq, NOW);
});

import { sign as edSign, createPrivateKey } from 'node:crypto';
const rebuild = (body, k) => `${body}sig\tk1\t${edSign(null, Buffer.from(body), createPrivateKey(k.pem)).toString('base64')}\n`;

test('the verifier refuses a validly signed file with no seq line, seq 0 or a leading-zero seq', () => {
  const k = pair();
  for (const body of ['format\t1\nbuild\t1\t0x1\t0x1\tx\n', 'format\t1\nseq\t0\n', 'format\t1\nseq\t012\n']) {
    assert.match(reasons(() => verifyFeed(rebuild(body, k), { keys: KEYS(k.hex), now: NOW })), /seq line/);
  }
});

test('the command line signs and verifies, takes the key from the environment, and prints no key', () => {
  const k = pair();
  const dir = mkdtempSync(join(tmpdir(), 'vmap-sign-'));
  const src = join(dir, 'feed.txt');
  const out = join(dir, 'signed.txt');
  writeFileSync(src, unsigned());
  const run = (args, env = {}) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
  const s = run(['sign', src, '--out', out, '--key-id', 'k1', '--now', String(NOW)], { VMAP_SIGN_KEY: k.pem });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, new RegExp(`seq ${NOW}`));
  const v = run(['verify', out, '--pub', `k1=${k.hex}`, '--now', String(NOW), '--last-seq', String(NOW - 1)]);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout, `ok seq=${NOW} key=k1\n`);
  for (const text of [s.stdout, s.stderr, v.stdout, v.stderr]) {
    assert.ok(!text.includes('PRIVATE'));
    assert.ok(!text.includes(k.pem.replace(/-----[A-Z ]+-----|\n/g, '')));
  }
  // Equal seq: refused with exit 3.
  const eq = run(['verify', out, '--pub', `k1=${k.hex}`, '--now', String(NOW), '--last-seq', String(NOW)]);
  assert.equal(eq.status, 3);
  assert.match(eq.stderr, /does not rise/);
  // Tampered: refused with exit 3.
  writeFileSync(out, readFileSync(out, 'utf8').replace('0x00C01230', '0x00C01231'));
  assert.equal(run(['verify', out, '--pub', `k1=${k.hex}`, '--now', String(NOW)]).status, 3);
  // No key: exit 2.
  const nk = run(['sign', src, '--out', join(dir, 'x.txt'), '--key-id', 'k1'], { VMAP_SIGN_KEY: '' });
  assert.equal(nk.status, 2);
  assert.match(nk.stderr, /no private key/);
});
