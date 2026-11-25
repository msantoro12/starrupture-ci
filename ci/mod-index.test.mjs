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
import { LOADER_REPO, MAX_ENTRIES, MOD_INDEX_MAX_BYTES, ModIndexError, bodyOf, buildModIndex, checkBody, checkLoaderHead, githubApi, resolveLoaderRef } from './mod-index.mjs';
import { signFeed, verifyFeed } from './vmap-sign.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = 1_800_000_000;
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), hex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
};
const KEYS = (hex) => ({ k1: { hex, test: false } });
const reason = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };
const INDEX = '[\n  { "id": "codex", "name": "Codex", "page_url": "https://github.com/AlienXAXS/StarRupture-Plugin-Codex" }\n]\n';
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
  assert.equal(buildModIndex('[]\n'), 'format\t1\nkind\tmod-index\n[]\n'); // the loader's index.json is an array
  assert.match(reason(() => buildModIndex('[1]\n')), /entry 1 is not an object/);
  assert.match(reason(() => buildModIndex('{}\n')), /not a JSON array/);
  assert.match(reason(() => buildModIndex('"x"\n')), /not a JSON array/);
  assert.match(reason(() => buildModIndex('null\n')), /not a JSON array/);
  assert.match(reason(() => buildModIndex('')), /empty/);
  const big = `[{"pad":"${'a'.repeat(MOD_INDEX_MAX_BYTES)}"}]\n`;
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
  assert.match(reason(() => sign(k, unsigned('"x"\n'))), /not a JSON array/);
  assert.match(reason(() => sign(k, `format\t1\n${INDEX}`)), /kind line/);
  assert.match(reason(() => sign(k, `format\t1\nkind\tplugin-catalog\n${INDEX}`)), /kind line/);
  assert.match(reason(() => sign(k, `format\t1\nkind\tmod-index\n${'{"p":"'}${'a'.repeat(MOD_INDEX_MAX_BYTES)}"}\n`)), /mod index is over/);
  // a correct signature over such a file (made past the signer) does not make it verify
  assert.match(reason(() => verify(k, forge(k, ['format\t1', `seq\t${NOW}`, 'kind\tmod-index', '{', '"a":', '1,', 'sig\tk1\tAAAA', '}', '']))), /sig or seq/);
  assert.match(reason(() => verify(k, forge(k, ['format\t1', `seq\t${NOW}`, 'kind\tmod-index', '"x"', '']))), /not a JSON array/);
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
  const pad = (n) => `[{"pad":"${'a'.repeat(n)}"}]\n`;
  const fits = MOD_INDEX_MAX_BYTES - 'format\t1\nkind\tmod-index\n[{"pad":""}]\n'.length;
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
    if (p === 'git/matching-refs/heads/release/?per_page=100') return Object.keys(heads).filter((n) => n.startsWith('release/')).map((n) => refEntry(n, heads[n]));
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
  // A full page of branches may hide the one asked for on the next page: refused, not guessed.
  const full = Array.from({ length: 100 }, (_, i) => refEntry(`release/${i}.0.0`, C.next));
  assert.match(await refusal(resolveLoaderRef('release/next', async () => full)), /more than one page/);
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

// ---- the signer's own check of the entries: it does not wait for the loader's builder ----

const SHA = 'ab'.repeat(32);
const ASSET = 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex/releases/download/v1.2.0/Codex.dll';
const entry = (over = {}) => ({ id: 'codex', name: 'Codex', page_url: 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex', download_url: ASSET, download_sha256: SHA, download_size: 123456, ...over });
const asText = (list) => `${JSON.stringify(list, null, 2)}\n`;
const refused = (list, why) => assert.match(reason(() => checkBody(typeof list === 'string' ? list : asText(list))), why);

test('entries: a good entry, an entry with no install keys and a nexusmods page without them pass', () => {
  assert.equal(checkBody(asText([entry()])), undefined);
  assert.equal(checkBody(asText([entry({ page_url: 'https://github.com/alienxaxs/starrupture-plugin-codex/' })])), undefined, 'the repository compares without case');
  assert.equal(checkBody(asText([{ id: 'x', name: 'X', page_url: 'https://www.nexusmods.com/starrupture/mods/1' }])), undefined);
  assert.equal(checkBody(asText([entry(), entry({ id: 'other', page_url: 'https://github.com/Someone/Other', download_url: 'https://github.com/Someone/Other/releases/download/v1/Other.dll' })])), undefined);
});

test('entries: a download_url that is not a https GitHub release asset is refused', () => {
  for (const [what, url] of [
    ['another host', 'https://example.com/AlienXAXS/StarRupture-Plugin-Codex/releases/download/v1.2.0/Codex.dll'],
    ['a look-alike host', 'https://github.com.evil.test/AlienXAXS/StarRupture-Plugin-Codex/releases/download/v1.2.0/Codex.dll'],
    ['a look-alike host without a dot', 'https://githubusercontent.com/AlienXAXS/StarRupture-Plugin-Codex/releases/download/v1.2.0/Codex.dll'],
    ['raw.githubusercontent.com', 'https://raw.githubusercontent.com/AlienXAXS/StarRupture-Plugin-Codex/main/Codex.dll'],
    ['http', ASSET.replace('https://', 'http://')],
    ['no scheme', ASSET.slice('https://'.length)],
    ['a scheme in capitals', ASSET.replace('https://', 'HTTPS://')],
    ['a host in capitals', ASSET.replace('github.com', 'GitHub.com')],
    ['user info', ASSET.replace('https://', 'https://github.com@')],
    ['user info that names the real host last', 'https://evil.test@github.com/AlienXAXS/StarRupture-Plugin-Codex/releases/download/v1.2.0/Codex.dll'],
    ['user info with a colon', ASSET.replace('https://', 'https://user:pw@')],
    ['a port', ASSET.replace('github.com', 'github.com:443')],
    ['a backslash', ASSET.replace('/releases/', '\\releases\\')],
    ['the other repository\'s release', 'https://github.com/AlienXAXS/StarRupture-ModLoader/releases/download/v1.2.0/Codex.dll'],
    ['the other owner\'s release', 'https://github.com/Mallory/StarRupture-Plugin-Codex/releases/download/v1.2.0/Codex.dll'],
    ['a repository that only starts the same', 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex2/releases/download/v1.2.0/Codex.dll'],
    ['an archive path', 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex/archive/refs/heads/main.zip'],
    ['the latest download', 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex/releases/latest/download/Codex.dll'],
    ['a raw path', 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex/raw/main/Codex.dll'],
    ['a release page', 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex/releases/tag/v1.2.0'],
    ['an extra path segment', `${ASSET.replace('/Codex.dll', '')}/sub/Codex.dll`],
    ['a path walking back', 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex/releases/download/../../../Evil/Evil/releases/download/v1/Codex.dll'],
    ['a dot segment', 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex/releases/download/./Codex.dll'],
    ['a query that looks like a redirect', `${ASSET}?redirect=https://evil.test/Codex.dll`],
    ['a fragment', `${ASSET}#https://evil.test/Codex.dll`],
    ['an encoded slash', ASSET.replace('/v1.2.0/', '/v1.2.0%2f..%2f/')],
    ['a file that is not a dll', ASSET.replace('Codex.dll', 'Codex.exe')],
    ['a bare .dll name', ASSET.replace('Codex.dll', '.dll')],
    ['a very long url', `${ASSET.replace('Codex.dll', `${'a'.repeat(200)}.dll`)}`],
    ['a space', ASSET.replace('Codex.dll', 'Co dex.dll')],
    ['nothing', ''],
    ['a number', 5],
    ['null', null],
  ]) refused([entry({ download_url: url })], /download_url must be/);
  const noUrl = entry(); delete noUrl.download_url;
  refused([noUrl], /download_url must be/);
});

test('entries: the download_url must belong to the repository the entry\'s own page_url names', () => {
  for (const [what, page] of [
    ['a nexusmods page', 'https://www.nexusmods.com/starrupture/mods/1'],
    ['another repository', 'https://github.com/AlienXAXS/StarRupture-ModLoader'],
    ['another owner', 'https://github.com/Mallory/StarRupture-Plugin-Codex'],
    ['a look-alike host', 'https://github.com.evil.test/AlienXAXS/StarRupture-Plugin-Codex'],
    ['user info', 'https://evil.test@github.com/AlienXAXS/StarRupture-Plugin-Codex'],
    ['a page url that is only the host', 'https://github.com/'],
    ['http', 'http://github.com/AlienXAXS/StarRupture-Plugin-Codex'],
    ['a query in the repository name', 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex?x=1'],
    ['a number', 7],
  ]) refused([entry({ page_url: page })], /belong to the repository page_url names/);
  const noPage = entry(); delete noPage.page_url;
  refused([noPage], /belong to the repository page_url names/);
});

test('entries: download_sha256 is exactly 64 lowercase hex characters, download_size is 1 byte to 32 MB', () => {
  for (const hash of [SHA.toUpperCase(), `${SHA.slice(0, 63)}A`, SHA.slice(1), `${SHA}a`, `${SHA.slice(0, 63)}g`, ` ${SHA}`, `${SHA}\n`, `sha256:${SHA}`, '', 5, null, [SHA]]) {
    refused([entry({ download_sha256: hash })], /download_sha256 must be 64 lowercase hex/);
  }
  const noHash = entry(); delete noHash.download_sha256;
  refused([noHash], /download_sha256 must be/);
  const noSize = entry(); delete noSize.download_size;
  refused([noSize], /download_size must be/);
  for (const size of [0, -1, 32 * 1024 * 1024 + 1, 1.5, '123', null]) refused([entry({ download_size: size })], /download_size must be/);
  for (const size of [1, 32 * 1024 * 1024]) assert.equal(checkBody(asText([entry({ download_size: size })])), undefined);
});

test('entries: any install key brings the whole set of checks, and a hash or size with no download_url is refused', () => {
  refused([{ id: 'x', name: 'X', page_url: 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex', download_sha256: SHA }], /download_url must be/);
  refused([{ id: 'x', name: 'X', page_url: 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex', install_files: ['Codex.dll'] }], /download_url must be/);
  refused([{ id: 'x', name: 'X', page_url: 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex', update_manifest_url: 'https://evil.test/m.json' }], /download_url must be/);
  refused([entry({ download_url: null })], /download_url must be/);
});

test('entries: every entry is checked, one bad entry refuses the index, the body is a JSON array of objects', () => {
  refused([entry(), entry({ id: 'bad', download_sha256: 'zz' })], /entry 2 \(bad\): download_sha256/);
  refused({ mods: [entry()] }, /not a JSON array/);
  refused('"x"\n', /not a JSON array/);
  refused([1], /entry 1 is not an object/);
  refused([null], /entry 1 is not an object/);
  refused([[]], /entry 1 is not an object/);
  assert.equal(checkBody(asText(Array.from({ length: MAX_ENTRIES }, (_, i) => ({ id: `m${i}`, name: 'M', page_url: 'https://www.nexusmods.com/x' })))), undefined);
  refused(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ id: `m${i}`, name: 'M', page_url: 'https://www.nexusmods.com/x' })), /201 entries/);
});

test('entries: a key the loader would read from another place than the check read it from is refused', () => {
  const good = JSON.stringify(entry());
  const evil = 'https://github.com/Mallory/Evil/releases/download/v1/Evil.dll';
  // the loader takes the first "download_url" at any depth, JSON.parse the last of the top level
  refused(`[${good.replace('{', `{"download_url":"${evil}",`)}]\n`, /entry 1 \(codex\): the key download_url appears more than once/);
  refused(`[${good.slice(0, -1)},"download_url":"${evil}"}]\n`, /entry 1 \(codex\): the key download_url appears more than once/);
  refused(`[${good.replace('{', `{"extra":{"download_url":"${evil}"},`)}]\n`, /the key download_url must be a direct member of the entry/);
  refused(`[${good.replace('{', `{"extra":[{"download_sha256":"${'0'.repeat(64)}"}],`)}]\n`, /the key download_sha256 must be a direct member of the entry/);
  refused(`[${good.slice(0, -1)},"page_url":"https://github.com/Mallory/Evil"}]\n`, /the key page_url appears more than once/);
  refused(`[${good.replace('"download_url"', '"download\\u005furl"')}]\n`, /key written with a backslash escape/);
  // a string that only spells a key is not a key
  assert.equal(checkBody(`[${good.replace('"Codex"', '"download_url"')}]\n`), undefined);
  assert.equal(checkBody(`[${good.replace('"Codex"', '"a \\"download_url\\": b"')}]\n`), undefined);
});

// One entry's nested keys must not balance another entry's escaped keys: the check is per entry, not over the whole text.
test('entries: nested, duplicate and escaped keys are refused per entry, however the other entries are written', () => {
  const page = 'https://github.com/o/r';
  const installed = { download_url: 'https://github.com/o/r/releases/download/t/x.dll', download_sha256: SHA, download_size: 5, install_files: ['X.dll'] };
  const nested = JSON.stringify({ id: 'a', name: 'A', page_url: 'https://github.com/X/Y', meta: { download_url: 'https://github.com/Mallory/Evil/releases/download/v1/Evil.dll', download_sha256: '0'.repeat(64), download_size: 5, install_files: ['Evil.dll'] } });
  const plain = JSON.stringify({ id: 'b', name: 'B', page_url: page, ...installed });
  const escaped = plain.replace('"download_url"', '"download\\u005furl"').replace('"download_sha256"', '"download\\u005fsha256"').replace('"download_size"', '"download\\u005fsize"').replace('"install_files"', '"install\\u005ffiles"');
  // the reviewer's index: A has the install keys nested, B spells them with escapes, so the raw counts balance over the whole text
  refused(`[${nested},${escaped}]\n`, /entry 1 \(a\): the key download_url must be a direct member/);
  refused(`[${escaped},${nested}]\n`, /key written with a backslash escape/);
  refused(`[${plain},${nested}]\n`, /entry 2 \(a\): the key download_url must be a direct member/);
  refused(`[${nested}]\n`, /entry 1 \(a\): the key download_url must be a direct member/);
  // a duplicate in one entry, whichever entry it is
  refused(`[${plain.slice(0, -1)},"download_size":6}, ${plain}]\n`, /entry 1 \(b\): the key download_size appears more than once/);
  refused(`[${plain}, ${plain.slice(0, -1)},"install_files":["Y.dll"]}]\n`, /entry 2 \(b\): the key install_files appears more than once/);
  // an escaped spelling of any key, of the scanned ones or not, anywhere
  refused(`[${plain.replace('"page_url"', '"page\\u005furl"')}]\n`, /key written with a backslash escape/);
  refused(`[{"id":"c","name":"C","x":{"a\\u0062":1},"page_url":"${page}"}]\n`, /key written with a backslash escape/);
  // a key that only looks like an install key (another letter, same shape) is not one: the entry stays browse-only for both readers
  assert.equal(checkBody(`[${JSON.stringify({ id: 'd', name: 'D', page_url: page }).replace('{', '{"dпwnload_url":"https://evil.test/x.dll",')}]\n`), undefined);
  assert.equal(checkBody(`[${plain},${JSON.stringify({ id: 'e', name: 'E', page_url: 'https://www.nexusmods.com/x', note: { download_urls: 1 } })}]\n`), undefined);
});

test('entries: download_size is plain decimal digits, so the signer and the loader read the same number', () => {
  const good = JSON.stringify(entry({ download_size: 1234 }));
  for (const raw of ['1.5e3', '1234.0', '1.234e3', '12340e-1', '1E3', '-1234', '0']) refused(`[${good.replace('1234', raw)}]\n`, /download_size must be/);
  for (const raw of ['01234', '+1234']) refused(`[${good.replace('1234', raw)}]\n`, /not valid JSON/);
  assert.equal(checkBody(`[${good}]\n`), undefined);
  assert.equal(checkBody(`[${good.replace('"download_size":1234', '"download_size" : 1234 ')}]\n`), undefined);
});

test('entries: the page_url may not walk back out of the repository, and a letter that only lowercases to a name does not match it', () => {
  refused([entry({ page_url: 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex/../../Mallory/Evil' })], /belong to the repository page_url names/);
  refused([entry({ page_url: 'https://github.com/AlienXAXS/StarRupture-Plugin-Codex/./x' })], /belong to the repository page_url names/);
  const mallory = { download_url: 'https://github.com/Mallory/Evil/releases/download/v1/Codex.dll' };
  refused([entry({ ...mallory, page_url: 'https://github.com/Mallory/Evil/%2e%2e/%2e%2e/AlienXAXS/StarRupture-Plugin-Codex' })], /belong to the repository page_url names/);
  refused([entry({ ...mallory, page_url: 'https://github.com/Mallory/Evil/.\r./.\r./AlienXAXS/StarRupture-Plugin-Codex' })], /belong to the repository page_url names/);
  assert.equal(checkBody(asText([entry({ ...mallory, page_url: 'https://github.com/Mallory/Evil/tree/v1.0' })])), undefined, 'plain extra segments pass');
  const kelvin = 'https://github.com/Klone/r';
  refused([entry({ page_url: kelvin, download_url: 'https://github.com/klone/r/releases/download/t/x.dll' })], /belong to the repository page_url names/);
});

const COMMIT = 'c'.repeat(40);
const THUMB = (over = {}) => ({
  thumbnail_url: `https://raw.githubusercontent.com/AlienXAXS/StarRupture-Plugin-Codex/${COMMIT}/images/thumbnail.png`,
  thumbnail_sha256: SHA,
  thumbnail_size: 20000,
  ...over,
});

test('thumbnails: a good entry passes, with or without install keys, and an entry without thumbnails is unchanged', () => {
  assert.equal(checkBody(asText([entry(THUMB())])), undefined);
  assert.equal(checkBody(asText([{ id: 'x', name: 'X', page_url: 'https://github.com/alienxaxs/starrupture-plugin-codex/', ...THUMB() }])), undefined, 'browse-only entry, repository compared without case');
  assert.equal(checkBody(asText([entry()])), undefined);
  for (const size of [1, 512 * 1024]) assert.equal(checkBody(asText([entry(THUMB({ thumbnail_size: size }))])), undefined);
});

test('thumbnails: one or two of the three keys are refused, naming the missing ones', () => {
  for (const k of ['thumbnail_url', 'thumbnail_sha256', 'thumbnail_size']) {
    const t = THUMB(); delete t[k];
    refused([entry(t)], new RegExp(`all or none, missing ${k}$`));
  }
  refused([entry({ thumbnail_url: THUMB().thumbnail_url })], /missing thumbnail_sha256, thumbnail_size/);
  refused([entry({ thumbnail_size: 5 })], /missing thumbnail_url, thumbnail_sha256/);
});

test('thumbnails: thumbnail_url is the raw.githubusercontent.com image of a full lowercase commit of the page_url repository', () => {
  const raw = 'https://raw.githubusercontent.com/AlienXAXS/StarRupture-Plugin-Codex';
  const bad = [
    `https://github.com/AlienXAXS/StarRupture-Plugin-Codex/raw/${COMMIT}/images/thumbnail.png`,
    `http://raw.githubusercontent.com/AlienXAXS/StarRupture-Plugin-Codex/${COMMIT}/images/thumbnail.png`,
    `https://evil.test/AlienXAXS/StarRupture-Plugin-Codex/${COMMIT}/images/thumbnail.png`,
    `${raw}/${'c'.repeat(39)}/images/thumbnail.png`,
    `${raw}/${'c'.repeat(41)}/images/thumbnail.png`,
    `${raw}/${'C'.repeat(40)}/images/thumbnail.png`,
    `${raw}/main/images/thumbnail.png`,
    `${raw}/${COMMIT}/images/thumb.png`,
    `${raw}/${COMMIT}/thumbnail.png`,
    `${raw}/${COMMIT}/images/thumbnail.png?x=1`,
    `${raw}/${COMMIT}/images/thumbnail.png#x`,
    `${raw}/${COMMIT}/images/thumbnail.png/`,
    `${raw}/${COMMIT}/extra/images/thumbnail.png`,
    `https://raw.githubusercontent.com/../${COMMIT}/images/thumbnail.png`,
  ];
  for (const u of bad) refused([entry(THUMB({ thumbnail_url: u }))], /thumbnail_url must be/);
  for (const u of [5, null, ['x'], { a: 1 }, '']) refused([entry(THUMB({ thumbnail_url: u }))], /thumbnail_url must be/);
  const other = `https://raw.githubusercontent.com/Mallory/Evil/${COMMIT}/images/thumbnail.png`;
  refused([entry(THUMB({ thumbnail_url: other }))], /thumbnail_url must belong to the repository page_url names/);
  refused([entry(THUMB({ thumbnail_url: `https://raw.githubusercontent.com/AlienXAXS/Other/${COMMIT}/images/thumbnail.png` }))], /belong to the repository page_url names/);
  refused([{ id: 'x', name: 'X', page_url: 'https://www.nexusmods.com/starrupture/mods/1', ...THUMB() }], /thumbnail_url must belong to the repository page_url names/);
});

test('thumbnails: thumbnail_sha256 is 64 lowercase hex, thumbnail_size is plain digits from 1 to 512 KiB', () => {
  for (const h of ['AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32), 5, null]) refused([entry(THUMB({ thumbnail_sha256: h }))], /thumbnail_sha256 must be/);
  for (const n of [0, -1, 524289, 1.5, '20000', null, [1], {}]) refused([entry(THUMB({ thumbnail_size: n }))], /thumbnail_size must be/);
  const good = JSON.stringify(entry(THUMB({ thumbnail_size: 1234 })));
  for (const raw of ['1.5e3', '1234.0', '1E3', '-1234', '0']) refused(`[${good.replace('"thumbnail_size":1234', `"thumbnail_size":${raw}`)}]\n`, /thumbnail_size must be/);
  for (const raw of ['01234', '+1234']) refused(`[${good.replace('"thumbnail_size":1234', `"thumbnail_size":${raw}`)}]\n`, /not valid JSON/);
  assert.equal(checkBody(`[${good.replace('"thumbnail_size":1234', '"thumbnail_size" : 1234 ')}]\n`), undefined);
});

test('thumbnails: nested, duplicate and escaped thumbnail keys are refused per entry', () => {
  const plain = JSON.stringify(entry(THUMB()));
  const nested = JSON.stringify({ id: 'a', name: 'A', page_url: 'https://github.com/X/Y', meta: THUMB() });
  refused(`[${nested}]\n`, /entry 1 \(a\): the key thumbnail_url must be a direct member/);
  refused(`[${plain},${nested}]\n`, /entry 2 \(a\): the key thumbnail_url must be a direct member/);
  for (const k of ['thumbnail_url', 'thumbnail_sha256', 'thumbnail_size']) {
    refused(`[${plain.slice(0, -1)},"${k}":${JSON.stringify(THUMB()[k])}}]\n`, new RegExp(`entry 1 \\(codex\\): the key ${k} appears more than once`));
    refused(`[${plain.replace(`"${k}"`, `"${k.replace('_', '\\u005f')}"`)}]\n`, /key written with a backslash escape/);
  }
});

test('entries: signing and verifying run the same check, so a bad index never gets a signature', () => {
  const k = pair();
  const bad = asText([entry({ download_url: 'https://example.com/Codex.dll' })]);
  assert.match(reason(() => sign(k, `format\t1\nkind\tmod-index\n${bad}`)), /download_url must be/);
  assert.match(reason(() => verify(k, forge(k, ['format\t1', `seq\t${NOW}`, 'kind\tmod-index', ...bad.split('\n')]))), /download_url must be/);
  const good = asText([entry()]);
  assert.equal(verify(k, sign(k, `format\t1\nkind\tmod-index\n${good}`).text).keyId, 'k1');
});

test('loader-head: only the current tip of main passes, a commit behind it or on another branch does not, an API failure refuses', async () => {
  assert.equal(await checkLoaderHead(C.main, fakeApi().get), C.main);
  for (const sha of [C.root, C.version, C.next, C.fork, C.gone, 'main', 'release/next', C.main.slice(0, 7), C.forkOnMain.toUpperCase(), '', undefined]) {
    assert.match(await refusal(checkLoaderHead(sha, fakeApi().get)), /full commit id|is not the tip of main/, String(sha));
  }
  // main moved on: what was main a moment ago is refused
  assert.match(await refusal(checkLoaderHead(C.main, fakeApi({ ...HEADS, main: C.forkOnMain }).get)), /is not the tip of main of .* \(main is at a{40}\)/);
  const failing = fakeApi(HEADS, (path) => { if (path.includes('git/ref/heads/main')) throw new ModIndexError('boom'); });
  assert.match(await refusal(checkLoaderHead(C.main, failing.get)), /boom/);
  const { main, ...noMain } = HEADS;
  assert.match(await refusal(checkLoaderHead(C.main, fakeApi(noMain).get)), /HTTP 404/);
});
