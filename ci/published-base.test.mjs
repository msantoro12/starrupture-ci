// Tests for published-base.mjs.
//
//   node --test ci/published-base.test.mjs
//
// `gh` is replaced by a fake that answers like the API; the signed file is the loader's TEST-key
// fixture (fixtures/vmap-sign/test-feed-k1.txt), taken with --allow-test-key the way version-map.test.mjs does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_ERROR, EXIT_HOLD, EXIT_OK, FEED_ASSET, RELEASE, fetchPublished, main, preserveFeed, takeBase } from './published-base.mjs';
import { emit, exportFeed, parse } from './version-map.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'published-base.mjs');
const LF = (s) => s.replace(/\r\n/g, '\n');
const loaderHeader = () => LF(readFileSync(join(here, 'fixtures', 'version-map', 'loader.h'), 'utf8'));
// The signed file with LF ends, whatever the checkout gave it.
const K1_TEXT = LF(readFileSync(join(here, 'fixtures', 'vmap-sign', 'test-feed-k1.txt'), 'utf8'));
const TEST_KEY = ['--allow-test-key'];

// The loader fixture without CL-128786: the signed fixture adds that build and CL-130001 whole.
function reducedHeader() {
  const m = parse(loaderHeader());
  m.builds = m.builds.filter((b) => b.cl === 127004);
  m.functions = m.functions.filter((r) => r.cl === 127004);
  m.fields = m.fields.filter((r) => r.cl === 127004);
  return emit(m);
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'pubbase-'));
  const p = (...parts) => join(dir, ...parts);
  return { dir, p, write: (name, text) => { writeFileSync(p(name), text); return p(name); }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// A fake `gh`. script: what the release answers (an array of answers, one per api call; the last repeats).
// An answer is { status, stdout, stderr }. A download writes `body` into --dir (nothing when body is null).
function fakeGh({ api, body = K1_TEXT, download = { status: 0 } }) {
  const calls = [];
  const run = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'api') {
      const n = calls.filter((c) => c.startsWith('api')).length;
      return { stdout: '', stderr: '', ...api[Math.min(n, api.length) - 1] };
    }
    if (args[0] === 'release') {
      const dir = args[args.indexOf('--dir') + 1];
      if (download.status === 0 && body !== null) writeFileSync(join(dir, FEED_ASSET), body);
      return { stdout: '', stderr: '', ...download };
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { run, calls };
}
const hasFeed = { status: 0, stdout: JSON.stringify({ assets: [{ name: FEED_ASSET }] }) };
const noSleep = { sleep: async () => {} };

// ---- fetchPublished -----------------------------------------------------------------------------

test('fetchPublished: the file of the vmap-feed release is downloaded', async () => {
  const s = scratch();
  try {
    const gh = fakeGh({ api: [hasFeed] });
    const got = await fetchPublished({ dir: s.p('d'), repo: 'o/r', run: gh.run, ...noSleep });
    assert.equal(got.file, join(s.p('d'), FEED_ASSET));
    assert.equal(readFileSync(got.file, 'utf8'), K1_TEXT);
    assert.deepEqual(gh.calls, ['api repos/o/r/releases/tags/' + RELEASE, 'release download']);
  } finally { s.done(); }
});

test('fetchPublished: no release, or no file on it, is an answer (absent), not a failure, and is not retried', async () => {
  const s = scratch();
  try {
    for (const api of [{ status: 1, stderr: 'gh: Not Found (HTTP 404)' }, { status: 0, stdout: JSON.stringify({ assets: [{ name: 'vmap-history.json' }] }) }, { status: 0, stdout: '{}' }]) {
      const slept = [];
      const gh = fakeGh({ api: [api] });
      const got = await fetchPublished({ dir: s.p('d'), repo: 'o/r', run: gh.run, sleep: async (ms) => { slept.push(ms); } });
      assert.ok(got.absent, JSON.stringify(got));
      assert.equal(got.file, undefined);
      assert.deepEqual(slept, []);
      assert.equal(gh.calls.length, 1);
    }
  } finally { s.done(); }
});

test('fetchPublished: a failure is tried again after 5 s and 15 s, and a later answer is taken', async () => {
  const s = scratch();
  try {
    const slept = [];
    const gh = fakeGh({ api: [{ status: 1, stderr: 'HTTP 502 Bad Gateway' }, { status: 0, stdout: 'not json' }, hasFeed] });
    const got = await fetchPublished({ dir: s.p('d'), repo: 'o/r', run: gh.run, sleep: async (ms) => { slept.push(ms); } });
    assert.ok(got.file);
    assert.deepEqual(slept, [5000, 15000]);
  } finally { s.done(); }
});

test('fetchPublished: three failures end as an error that says why; a failed or empty download is a failure too', async () => {
  const s = scratch();
  try {
    let slept = [];
    const sleep = async (ms) => { slept.push(ms); };
    let got = await fetchPublished({ dir: s.p('a'), repo: 'o/r', run: fakeGh({ api: [{ status: 1, stderr: 'HTTP 500 boom' }] }).run, sleep });
    assert.deepEqual([got.tries, slept], [3, [5000, 15000]]);
    assert.match(got.error, /cannot read the vmap-feed release: HTTP 500 boom/);
    slept = [];
    got = await fetchPublished({ dir: s.p('b'), repo: 'o/r', run: fakeGh({ api: [hasFeed], download: { status: 1, stderr: 'timeout' } }).run, sleep });
    assert.match(got.error, /cannot download version-map-client.v1.txt: timeout/);
    assert.equal(slept.length, 2);
    got = await fetchPublished({ dir: s.p('c'), repo: 'o/r', run: fakeGh({ api: [hasFeed], body: '' }).run, sleep });
    assert.match(got.error, /downloaded empty/);
    got = await fetchPublished({ dir: s.p('d'), repo: 'o/r', run: fakeGh({ api: [hasFeed], body: null }).run, sleep });
    assert.match(got.error, /downloaded empty/);
  } finally { s.done(); }
});

test('fetchPublished: a repository is required', async () => {
  const keep = process.env.GH_REPO;
  delete process.env.GH_REPO;
  try { await assert.rejects(fetchPublished({ dir: 'x', run: () => ({}) }), /GH_REPO is not set/); } finally { if (keep !== undefined) process.env.GH_REPO = keep; }
});

// ---- takeBase -----------------------------------------------------------------------------------

test('takeBase: the published rows and build the header lacks are added, and the header is written', async () => {
  const s = scratch();
  try {
    const header = s.write('h.h', reducedHeader());
    const r = await takeBase({ header, dir: s.p('d'), repo: 'o/r', run: fakeGh({ api: [hasFeed] }).run, extraArgs: TEST_KEY, ...noSleep });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.note, /added 2 build lines/);
    const after = parse(readFileSync(header, 'utf8'));
    assert.deepEqual(after.builds.map((b) => b.cl), [127004, 128786, 130001]);
    assert.ok(after.functions.some((f) => f.key === 'Test::MapOnly' && f.cl === 130001));
  } finally { s.done(); }
});

test('takeBase: a row both hold with other content is a hold that names it, and the header is not changed', async () => {
  const s = scratch();
  try {
    const header = s.write('h.h', loaderHeader());
    const r = await takeBase({ header, dir: s.p('d'), repo: 'o/r', run: fakeGh({ api: [hasFeed] }).run, extraArgs: TEST_KEY, ...noSleep });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'import');
    assert.match(r.reasons[0], /^published base: .*1 rows differ/);
    assert.ok(r.reasons.some((x) => /build CL-128786: differs in size, source, stamp/.test(x)), r.reasons.join(' | '));
    assert.equal(readFileSync(header, 'utf8'), loaderHeader());
  } finally { s.done(); }
});

test('takeBase: a file whose signature is refused is a hold, never a base', async () => {
  const s = scratch();
  try {
    const header = s.write('h.h', reducedHeader());
    // The fixture is TEST-signed; without the test-key flag the real key list refuses it.
    const r = await takeBase({ header, dir: s.p('d'), repo: 'o/r', run: fakeGh({ api: [hasFeed] }).run, ...noSleep });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /^published base: the published file's signature was refused/);
    assert.match(r.reasons[0], /the import did not run/);
    assert.equal(readFileSync(header, 'utf8'), reducedHeader());
  } finally { s.done(); }
});

test('takeBase: a file that cannot be fetched after three tries is a hold, and the header is not changed', async () => {
  const s = scratch();
  try {
    const header = s.write('h.h', reducedHeader());
    const r = await takeBase({ header, dir: s.p('d'), repo: 'o/r', run: fakeGh({ api: [{ status: 1, stderr: 'HTTP 503' }] }).run, extraArgs: TEST_KEY, ...noSleep });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /could not be fetched after 3 tries \(cannot read the vmap-feed release: HTTP 503\); the header was not changed/);
    assert.equal(readFileSync(header, 'utf8'), reducedHeader());
  } finally { s.done(); }
});

test('takeBase: no published file is fine for a first publish and a hold for every other run', async () => {
  const s = scratch();
  try {
    const header = s.write('h.h', reducedHeader());
    const none = fakeGh({ api: [{ status: 1, stderr: 'HTTP 404' }] });
    const first = await takeBase({ header, dir: s.p('d'), repo: 'o/r', run: none.run, firstPublish: true, ...noSleep });
    assert.equal(first.ok, true);
    assert.match(first.note, /a first publish has no published file to take/);
    const other = await takeBase({ header, dir: s.p('d'), repo: 'o/r', run: none.run, ...noSleep });
    assert.equal(other.ok, false);
    assert.match(other.reasons[0], /does not exist, and this run is not a first publish/);
    assert.equal(readFileSync(header, 'utf8'), reducedHeader());
  } finally { s.done(); }
});

test('takeBase: the hold of an earlier job stands, without a fetch; a missing or unreadable report is a hold too', async () => {
  const s = scratch();
  try {
    const header = s.write('h.h', reducedHeader());
    const never = () => { throw new Error('gh must not be called'); };
    const held = s.write('held.json', JSON.stringify({ ok: false, step: 'import', reasons: ['published base: first reason', 'row two'] }));
    let r = await takeBase({ header, dir: s.p('d'), repo: 'o/r', run: never, checkReport: held, ...noSleep });
    assert.deepEqual([r.ok, r.reasons], [false, ['published base: first reason', 'row two']]);
    r = await takeBase({ header, dir: s.p('d'), repo: 'o/r', run: never, checkReport: s.p('missing.json'), ...noSleep });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /recorded no result/);
    r = await takeBase({ header, dir: s.p('d'), repo: 'o/r', run: never, checkReport: s.write('junk.json', '{'), ...noSleep });
    assert.match(r.reasons[0], /recorded no result/);
    r = await takeBase({ header, dir: s.p('d'), repo: 'o/r', run: never, checkReport: s.write('empty.json', JSON.stringify({ ok: false })), ...noSleep });
    assert.match(r.reasons[0], /held and gave no reason/);
    // An earlier job that took the base fine does not stop this one from taking it too.
    const fine = s.write('fine.json', JSON.stringify({ ok: true, step: 'import', note: 'x' }));
    r = await takeBase({ header, dir: s.p('d'), repo: 'o/r', run: fakeGh({ api: [hasFeed] }).run, checkReport: fine, extraArgs: TEST_KEY, ...noSleep });
    assert.equal(r.ok, true);
  } finally { s.done(); }
});

// ---- preserveFeed -------------------------------------------------------------------------------

test('preserveFeed: a feed that lost published lines is a hold that names them; once they are in, it passes', () => {
  const s = scratch();
  try {
    const k1 = s.write('k1.txt', K1_TEXT);
    const lost = s.write('lost.txt', exportFeed(parse(loaderHeader())));
    let r = preserveFeed({ feed: lost, published: k1, extraArgs: TEST_KEY });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'preserve');
    assert.match(r.reasons[0], /^published base: 4 published lines are missing from/);
    assert.ok(r.reasons.includes('build CL-130001: missing'), r.reasons.join(' | '));
    assert.ok(r.reasons.includes('function Test::MapOnly @ CL-130001: missing'));
    // The header the published file was taken into exports every published line.
    const header = s.write('h.h', reducedHeader());
    const imported = spawnSync(process.execPath, [join(here, 'version-map.mjs'), 'import-published', header, '--published', k1, '--allow-test-key'], { encoding: 'utf8', windowsHide: true });
    assert.equal(imported.status, 0, imported.stderr);
    const kept = s.write('kept.txt', exportFeed(parse(readFileSync(header, 'utf8'))));
    r = preserveFeed({ feed: kept, published: k1, extraArgs: TEST_KEY });
    assert.equal(r.ok, true, JSON.stringify(r));
    // And the real key list does not take the TEST-signed fixture.
    r = preserveFeed({ feed: kept, published: k1 });
    assert.match(r.reasons[0], /signature was refused/);
  } finally { s.done(); }
});

test('preserveFeed: a published file that is not there is a hold', () => {
  const r = preserveFeed({ feed: 'feed.txt', published: join(tmpdir(), 'no-such-published-file.txt') });
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /is not there, so the new feed cannot be compared/);
});

// ---- the command line ---------------------------------------------------------------------------

test('main: take writes the report and exits 0 (taken), 3 (hold, reasons on stderr) or 2 (usage)', async () => {
  const s = scratch();
  const errors = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (t) => { errors.push(String(t)); return true; };
  try {
    const header = s.write('h.h', reducedHeader());
    const report = s.p('report.json');
    const k1 = s.write('k1.txt', K1_TEXT);
    const gh = fakeGh({ api: [hasFeed] });
    let code = await main(['take', header, '--report', report, '--dir', s.p('d')], { repo: 'o/r', run: gh.run, extraArgs: TEST_KEY, ...noSleep });
    assert.equal(code, EXIT_OK);
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).ok, true);

    const header2 = s.write('h2.h', reducedHeader());
    code = await main(['take', header2, '--report', report, '--dir', s.p('d2')], { repo: 'o/r', run: fakeGh({ api: [{ status: 1, stderr: 'HTTP 500' }] }).run, ...noSleep });
    assert.equal(code, EXIT_HOLD);
    const held = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(held.ok, false);
    assert.match(errors.join(''), /could not be fetched after 3 tries/);

    code = await main(['preserve', s.write('f.txt', exportFeed(parse(loaderHeader()))), '--published', k1, '--report', report], { extraArgs: TEST_KEY });
    assert.equal(code, EXIT_HOLD);
    assert.match(JSON.parse(readFileSync(report, 'utf8')).reasons[0], /4 published lines are missing/);

    for (const argv of [[], ['take'], ['take', header], ['take', header, '--report'], ['preserve', 'f.txt', '--report', report], ['other', 'x', '--report', report]]) {
      assert.equal(await main(argv, {}), EXIT_ERROR, argv.join(' '));
    }
  } finally { process.stderr.write = realWrite; s.done(); }
});

test('main: the first-publish flag reaches the take, and a run needs a repository', async () => {
  const s = scratch();
  try {
    const header = s.write('h.h', reducedHeader());
    const report = s.p('report.json');
    const none = fakeGh({ api: [{ status: 1, stderr: 'HTTP 404' }] });
    assert.equal(await main(['take', header, '--report', report, '--dir', s.p('d'), '--first-publish', 'true'], { repo: 'o/r', run: none.run, ...noSleep }), EXIT_OK);
    const quiet = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try { assert.equal(await main(['take', header, '--report', report, '--dir', s.p('d'), '--first-publish', 'false'], { repo: 'o/r', run: none.run, ...noSleep }), EXIT_HOLD); } finally { process.stderr.write = quiet; }
    const keep = process.env.GH_REPO;
    delete process.env.GH_REPO;
    process.stderr.write = () => true;
    try { assert.equal(await main(['take', header, '--report', report], { run: none.run, ...noSleep }), EXIT_ERROR); } finally { process.stderr.write = quiet; if (keep !== undefined) process.env.GH_REPO = keep; }
  } finally { s.done(); }
});

test('the script runs as a command: usage is exit 2 and writes no report', () => {
  const s = scratch();
  try {
    const r = spawnSync(process.execPath, [TOOL, 'take', s.p('h.h')], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: published-base.mjs take/);
    assert.equal(existsSync(s.p('report.json')), false);
    const p = spawnSync(process.execPath, [TOOL, 'preserve', s.p('f.txt'), '--published', s.p('none.txt'), '--report', s.p('r.json')], { encoding: 'utf8', windowsHide: true });
    assert.equal(p.status, 3);
    assert.equal(JSON.parse(readFileSync(s.p('r.json'), 'utf8')).ok, false);
  } finally { s.done(); }
});

test('the committed retired and changed lists are the ones the helper passes, and they hold no entry yet', () => {
  for (const f of ['retired-rows.txt', 'changed-rows.txt']) {
    const text = readFileSync(join(here, f), 'utf8');
    assert.equal(text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length, 0, f);
  }
});
