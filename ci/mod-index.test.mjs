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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOADER_REPO, MOD_INDEX_MAX_BYTES, ModIndexError, bodyOf, buildModIndex, checkBody, githubApi, resolveLoaderRef } from './mod-index.mjs';
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

test('build refuses a CR, no final LF, bad JSON, a scalar, an empty file and one over the cap', () => {
  assert.match(reason(() => buildModIndex(INDEX.replace(/\n/g, '\r\n'))), /CR/);
  assert.match(reason(() => buildModIndex(INDEX.trimEnd())), /does not end in LF/);
  assert.match(reason(() => buildModIndex('{"a": \n')), /not valid JSON/);
  assert.equal(buildModIndex('[1]\n'), 'format\t1\nkind\tmod-index\n[1]\n'); // the loader's index.json is an array
  assert.match(reason(() => buildModIndex('"x"\n')), /not a JSON object or array/);
  assert.match(reason(() => buildModIndex('null\n')), /not a JSON object or array/);
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
  assert.match(reason(() => sign(k, unsigned('"x"\n'))), /not a JSON object or array/);
  assert.match(reason(() => sign(k, `format\t1\n${INDEX}`)), /kind line/);
  assert.match(reason(() => sign(k, `format\t1\nkind\tplugin-catalog\n${INDEX}`)), /kind line/);
  assert.match(reason(() => sign(k, `format\t1\nkind\tmod-index\n${'{"p":"'}${'a'.repeat(MOD_INDEX_MAX_BYTES)}"}\n`)), /mod index is over/);
  // a correct signature over such a file (made past the signer) does not make it verify
  assert.match(reason(() => verify(k, forge(k, ['format\t1', `seq\t${NOW}`, 'kind\tmod-index', '{', '"a":', '1,', 'sig\tk1\tAAAA', '}', '']))), /sig or seq/);
  assert.match(reason(() => verify(k, forge(k, ['format\t1', `seq\t${NOW}`, 'kind\tmod-index', '"x"', '']))), /not a JSON object or array/);
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

// ---- loader-ref: the gate on what gets signed, against a faked GitHub API ----

// A made-up loader repository. parents holds every commit the API can resolve, those of forks and pull requests
// included: the compare answer is worked out from it, as GitHub does for any commit of the repository's network.
const id = (c) => c.repeat(40);
const C = { root: id('1'), main: id('2'), nextOnly: id('3'), next: id('4'), version: id('5'), feature: id('6'), auto: id('7'), work: id('8'), fork: id('9'), forkOnMain: id('a'), gone: id('b') };
const parents = { [C.root]: [], [C.main]: [C.root], [C.nextOnly]: [C.root], [C.next]: [C.nextOnly], [C.version]: [C.main], [C.feature]: [C.main], [C.auto]: [C.main], [C.work]: [C.root], [C.fork]: [C.root], [C.forkOnMain]: [C.main] };
const HEADS = { main: C.main, 'release/next': C.next, 'release/1.28.0': C.version, 'release/loader-unknown-build': C.work, 'feat/mod-browser': C.feature, 'auto/update-1-2-3': C.auto };
const history = (c) => new Set([c, ...parents[c].flatMap((p) => [...history(p)])]);
const refEntry = (name, sha) => ({ ref: `refs/heads/${name}`, object: { type: 'commit', sha } });
function fakeApi(heads = HEADS, broken = () => {}) {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    broken(path);
    const p = path.replace(`repos/${LOADER_REPO}/`, '');
    assert.notEqual(p, path, `only the loader repository is asked: ${path}`);
    if (p === 'git/matching-refs/heads/release/') return Object.keys(heads).filter((n) => n.startsWith('release/')).map((n) => refEntry(n, heads[n]));
    if (p === 'git/ref/heads/main' && heads.main) return refEntry('main', heads.main);
    const m = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})\?per_page=1$/.exec(p);
    if (m && parents[m[1]] && parents[m[2]]) {
      const [, base, head] = m;
      const up = history(head);
      const down = history(base);
      const ahead = [...up].filter((c) => !down.has(c)).length;
      const behind = [...down].filter((c) => !up.has(c)).length;
      const status = ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'identical';
      return { status, ahead_by: ahead, behind_by: behind, merge_base_commit: { sha: [...down].find((c) => up.has(c)) } };
    }
    throw new ModIndexError(`GitHub API ${path} answered HTTP 404`);
  };
  return { get, calls };
}
const refusal = async (promise) => {
  try { await promise; } catch (e) { assert.ok(e instanceof ModIndexError, e.stack); return e.message; }
  return null;
};

test('loader-ref: main and a release branch are accepted, by name (as their tip) and by any commit they reach', async () => {
  for (const [ref, sha, branch] of [
    ['main', C.main, 'main'], [C.main, C.main, 'main'], [C.root, C.root, 'main'],
    ['release/next', C.next, 'release/next'], [C.next, C.next, 'release/next'], [C.nextOnly, C.nextOnly, 'release/next'],
    ['release/1.28.0', C.version, 'release/1.28.0'], [C.version, C.version, 'release/1.28.0'],
  ]) {
    assert.deepEqual(await resolveLoaderRef(ref, fakeApi().get), { sha, branch }, ref);
  }
});

test('loader-ref: a commit no accepted branch reaches is refused, though the compare API resolves it', async () => {
  for (const [what, sha] of [
    ['fork only', C.fork], ['fork or pull request commit on top of main', C.forkOnMain], ['feature branch', C.feature],
    ['auto/ branch', C.auto], ['another branch under release/', C.work],
  ]) {
    const api = fakeApi();
    assert.match(await refusal(resolveLoaderRef(sha, api.get)), /is refused: neither main nor a release branch/, what);
    assert.ok(api.calls.some((c) => c.includes(`/compare/${sha}...${C.main}`)), what);
    assert.ok(!api.calls.some((c) => [C.feature, C.auto, C.work].some((t) => c.includes(`...${t}`))), 'no unaccepted tip is compared with');
  }
  assert.match(await refusal(resolveLoaderRef(C.gone, fakeApi().get)), /answered HTTP 404/, 'a commit the API does not know');
});

test('loader-ref: every name but main and a release branch is refused before the API is asked', async () => {
  const names = ['feat/mod-browser', 'auto/update-1-2-3', 'release/loader-unknown-build', 'release/', 'release/1.28', 'release/1.28.0-rc.1', 'release/next/x', 'rc/loader-next', 'v1.27.0',
    'refs/heads/main', 'refs/pull/7/head', 'refs/tags/v1.27.0', 'msantoro12:main', 'Main', 'main ', 'main\n', '', C.main.slice(0, 12), C.forkOnMain.toUpperCase(), undefined];
  for (const ref of names) {
    const api = fakeApi();
    assert.match(await refusal(resolveLoaderRef(ref, api.get)), /^loader_ref .* is refused: /, JSON.stringify(ref));
    assert.deepEqual(api.calls, [], JSON.stringify(ref));
  }
  assert.match(await refusal(resolveLoaderRef('release/9.9.9', fakeApi().get)), /has no branch release\/9\.9\.9/);
});

test('loader-ref: an API failure on any call refuses the run, with no fall-through to another branch', async () => {
  for (const [ref, part] of [['main', '/git/ref/heads/main'], ['release/next', '/git/matching-refs/'], [C.main, '/git/ref/heads/main'], [C.nextOnly, `/compare/${C.nextOnly}...${C.main}`], [C.nextOnly, '/git/matching-refs/'], [C.nextOnly, `...${C.next}?`]]) {
    const api = fakeApi(HEADS, (path) => { if (path.includes(part)) throw new ModIndexError('boom'); });
    assert.equal(await refusal(resolveLoaderRef(ref, api.get)), 'boom', `${ref} ${part}`);
    assert.ok(api.calls.at(-1).includes(part), 'nothing is asked after the failure');
  }
});

test('loader-ref: an answer that does not prove reachability is refused', async () => {
  const answering = (compare, tip = refEntry('main', C.main)) => async (path) => (path.includes('/compare/') ? compare : path.includes('matching-refs') ? [] : tip);
  const good = { status: 'ahead', behind_by: 0, merge_base_commit: { sha: C.fork } };
  assert.equal(await refusal(resolveLoaderRef(C.fork, answering(good))), null, 'the control: this answer is a proof');
  for (const bad of [{}, null, { status: 'ahead' }, { ...good, status: 'behind' }, { ...good, status: 'diverged' }, { ...good, behind_by: 1 }, { ...good, merge_base_commit: { sha: C.root } }, { ...good, merge_base_commit: undefined }]) {
    assert.match(await refusal(resolveLoaderRef(C.fork, answering(bad))), /neither main nor a release branch/, JSON.stringify(bad));
  }
  // Not the commit tip of the very branch asked for: a list (prefix match), another branch, a tag object, a short id.
  for (const tip of [[refEntry('main', C.main)], refEntry('main-old', C.main), { ref: 'refs/heads/main', object: { type: 'tag', sha: C.main } }, refEntry('main', 'abc'), {}]) {
    assert.match(await refusal(resolveLoaderRef('main', answering(good, tip))), /did not give the tip of the branch main/, JSON.stringify(tip));
  }
  assert.match(await refusal(resolveLoaderRef('release/next', async () => ({ message: 'Not Found' }))), /did not list the release branches/);
});

test('loader-ref: the commit stays fixed when the branch moves, and a commit a branch no longer reaches is refused', async () => {
  const first = await resolveLoaderRef('main', fakeApi().get);
  assert.equal((await resolveLoaderRef(first.sha, fakeApi({ ...HEADS, main: C.feature }).get)).sha, first.sha, 'main moved forward');
  assert.match(await refusal(resolveLoaderRef(first.sha, fakeApi({ main: C.fork }).get)), /neither main nor a release branch/, 'main was rewritten');
});

test('loader-ref: the API client takes a 200 with JSON only; a status, a network failure or other text is an error', async () => {
  const seen = [];
  const ok = githubApi('t0ken', async (url, init) => { seen.push([url, init]); return { status: 200, json: async () => ({ a: 1 }) }; });
  assert.deepEqual(await ok('repos/x/y'), { a: 1 });
  assert.equal(seen[0][0], 'https://api.github.com/repos/x/y');
  assert.equal(seen[0][1].headers.authorization, 'Bearer t0ken');
  assert.equal(seen[0][1].redirect, 'error');
  for (const status of [201, 301, 401, 403, 404, 422, 429, 500, 502]) {
    assert.match(await refusal(githubApi('', async () => ({ status, json: async () => ({}) }))('p')), new RegExp(`answered HTTP ${status}$`));
  }
  assert.match(await refusal(githubApi('', async () => { throw new TypeError('fetch failed'); })('p')), /p failed: fetch failed/);
  assert.match(await refusal(githubApi('', async () => ({ status: 200, json: async () => { throw new SyntaxError('bad'); } }))('p')), /did not answer JSON/);
});

// The command the workflow runs, with fetch replaced before it loads.
test('loader-ref: the command prints the commit and nothing else on stdout; a refusal or a failed API exits 2 with no stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-index-ref-'));
  const preload = join(dir, 'fake-fetch.mjs');
  writeFileSync(preload, `globalThis.fetch = async (url) => {
  if (process.env.FAKE_DOWN) throw new TypeError('fetch failed');
  const sha = ${JSON.stringify(C.main)};
  if (url.endsWith('/git/ref/heads/main')) return { status: 200, json: async () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha } }) };
  if (url.includes('/git/matching-refs/')) return { status: 200, json: async () => [] };
  return { status: 200, json: async () => ({ status: 'diverged', behind_by: 1, merge_base_commit: { sha } }) };
};
`);
  const gate = (ref, env = {}) => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(here, 'mod-index.mjs'), 'loader-ref', ref], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GH_TOKEN: '', ...env } });
  const good = gate('main');
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout, `${C.main}\n`);
  for (const [r, why] of [[gate(C.fork), /neither main nor a release branch/], [gate('feat/mod-browser'), /is refused/], [gate('main', { FAKE_DOWN: '1' }), /fetch failed/]]) {
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, why);
  }
});
