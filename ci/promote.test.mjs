// Tests for promote.mjs (version-map step 46).
//
//   node --test ci/promote.test.mjs
//
// All values are made up; the build ids are the ones state/steam.json records today.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOADER_REPO, stage } from './staging.mjs';
import { PromoteError, gate, plan, promote } from './promote.mjs';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'promote.mjs');
const NOW = Date.parse('2026-11-05T12:00:00Z');
const SHA = 'ab'.repeat(32);

const build = (over = {}) => ({
  cl: 128786, branch: 'public_test_branch', buildid: '26271156', productVersion: 'x', exeSha256: SHA, imageStamp: '0x6b000001', size: 1000, run: 7,
  scans: [{ exe: 'public_test_branch', buildid: '26271156', ok: true }, { exe: 'public', buildid: '25646882', ok: true }],
  repo: { sha: 'c0ffee'.repeat(6) + 'c0ff', tree: 'decade'.repeat(6) + 'dead', verdict: 'FIXED' }, ...over,
});
const stagedIndex = (...builds) => builds.reduce((index, b) => stage(b, { index, effects: { pushBranch() {}, writeIndex() {} } }).index, {});

const autopilot = { schema: 1, enabled: true, paths: ['M'], max_releases_per_day: 2 };
const history = { releases: [] };
const flip = (over = {}) => ({ buildid: '26271156', exeSha256: SHA, cl: 128786, ...over });
const inputs = (over = {}) => ({ index: stagedIndex(build()), pub: flip(), autopilot, history, lastSeq: 41, now: NOW, ...over });

test('a synthetic public flip prints the PR plan and "would sign and publish seq N"', () => {
  const r = plan(inputs());
  assert.equal(r.action, 'promote');
  assert.equal(r.seq, 42);
  const text = r.lines.join('\n');
  assert.match(text, /public 26271156 matches staged CL-128786 \(same build and exe\)/);
  assert.match(text, /re-scan every DLL on the public exe/);
  assert.match(text, /rebase auto\/update-128786 \(c0ffeec0\) onto the StarRupture-ModLoader fork's current tip/);
  assert.match(text, /open a PR from the fork into StarRupture-ModLoader main for CL-128786; merge once CI passes/);
  assert.equal(r.lines.at(-1), 'would sign and publish seq 42');
});

test('the same CL on a different exe re-verifies every key first, rva check off', () => {
  const r = plan(inputs({ pub: flip({ exeSha256: 'cd'.repeat(32) }) }));
  assert.equal(r.action, 'promote');
  assert.match(r.lines.join('\n'), /same CL, different exe/);
  assert.match(r.lines.join('\n'), /rva check is off, the image stamp differs/);
  assert.match(r.lines.join('\n'), /staged exe \(abababab\) as a second reference/);
});

test('a different CL runs the normal flow with the staged exe as a second reference and promotes nothing', () => {
  const r = plan(inputs({ pub: flip({ cl: 130000, buildid: '26999999' }) }));
  assert.equal(r.action, 'normal-flow');
  assert.equal(r.seq, null);
  const text = r.lines.join('\n');
  assert.match(text, /no staged CL matches/);
  assert.match(text, /normal new-CL flow .* for CL-130000 with the staged exe \(abababab\) as a second reference/);
  assert.doesNotMatch(text, /would sign/);
});

test('a superseded staged CL is listed and skipped, a newer PTR CL stays staged', () => {
  const index = stagedIndex(build(), build({ cl: 128900, buildid: '26300000', run: 9 }), build({ cl: 128950, branch: 'beta_two', buildid: '26400000', run: 11, scans: [{ exe: 'beta_two', buildid: '26400000', ok: true }, { exe: 'public', buildid: '25646882', ok: true }] }));
  const r = plan(inputs({ index, pub: flip({ cl: 128900, buildid: '26300000' }) }));
  const text = r.lines.join('\n');
  assert.match(text, /skip CL-128786: superseded, never published/);
  assert.match(text, /keep CL-128950 staged/);
  assert.equal(r.action, 'promote');
  assert.equal(plan(inputs({ index, pub: flip({ cl: 128786 }) })).action, 'normal-flow', 'a superseded CL is never promoted');
});

test('the autopilot fails closed: missing, disabled, no path M, or over the cap prints a HOLD, never "would sign"', () => {
  for (const [name, over, re] of [
    ['missing file', { autopilot: null }, /unreadable or malformed/],
    ['disabled', { autopilot: { ...autopilot, enabled: false } }, /not enabled/],
    ['path A only', { autopilot: { ...autopilot, paths: ['A'] } }, /path M .* not allowed/],
    ['malformed cap', { autopilot: { ...autopilot, max_releases_per_day: -1 } }, /malformed/],
    ['two this day', { history: { releases: [{ repo: LOADER_REPO, cl: '1', at: '2026-11-05T01:00:00Z' }, { repo: LOADER_REPO, cl: '2', at: '2026-11-05T05:00:00Z' }] } }, /2 StarRupture-ModLoader publishes in the last 24 h/],
    ['too soon', { history: { releases: [{ repo: LOADER_REPO, cl: '1', at: '2026-11-05T11:50:00Z' }] } }, /less than 30 minutes/],
    ['already published', { history: { releases: [{ repo: LOADER_REPO, cl: '128786', at: '2026-10-01T00:00:00Z' }] } }, /already published CL-128786/],
  ]) {
    const r = plan(inputs(over));
    assert.equal(r.action, 'hold', name);
    assert.match(r.hold.join('\n'), re, name);
    assert.ok(r.lines.includes(`would NOT sign and publish seq 42`), name);
    assert.ok(!r.lines.some((l) => l.startsWith('would sign')), name);
  }
});

test('the cap counts the loader repo only, and the file can only lower the limit', () => {
  const other = { releases: [{ repo: 'StarRupture-Plugin-BetterCheats', cl: '1', at: '2026-11-04T20:00:00Z' }, { repo: 'StarRupture-Plugin-WAILA', cl: '1', at: '2026-11-04T21:00:00Z' }] };
  assert.equal(plan(inputs({ history: other })).action, 'promote');
  assert.deepEqual(gate({ autopilot: { ...autopilot, max_releases_per_day: 99 }, history: { releases: [{ repo: LOADER_REPO, cl: '1', at: '2026-11-04T20:00:00Z' }, { repo: LOADER_REPO, cl: '2', at: '2026-11-05T08:00:00Z' }] }, cl: 3, now: NOW }).length, 1);
});

test('dry run calls no effect, and a live run is refused', () => {
  const trap = new Proxy({}, { get: (_, k) => () => { throw new Error(`${String(k)} must not run`); } });
  assert.equal(promote(inputs(), { effects: trap }).action, 'promote');
  assert.throws(() => promote(inputs(), { dryRun: false, effects: trap }), PromoteError);
});

test('bad inputs are refused', () => {
  assert.throws(() => plan(inputs({ lastSeq: -1 })), /last seq/);
  assert.throws(() => plan(inputs({ pub: { buildid: 'x', cl: 1 } })), /public build needs/);
  assert.throws(() => plan(inputs({ index: null })), /not an object/);
});

test('the command line prints the plan, writes the report, and refuses --live', () => {
  const dir = mkdtempSync(join(tmpdir(), 'promote-'));
  const w = (n, d) => { writeFileSync(join(dir, n), JSON.stringify(d)); return join(dir, n); };
  const args = ['plan', '--index', w('i.json', stagedIndex(build())), '--public', w('p.json', flip()), '--autopilot', w('a.json', autopilot), '--history', w('h.json', history), '--last-seq', '41', '--now', '2026-11-05T12:00:00Z'];
  const ok = spawnSync(process.execPath, [TOOL, ...args, '--out', join(dir, 'plan.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^dry run: nothing is signed, published or released/);
  assert.match(ok.stdout, /would sign and publish seq 42\n$/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')).seq, 42);
  const live = spawnSync(process.execPath, [TOOL, ...args, '--live'], { encoding: 'utf8', windowsHide: true });
  assert.equal(live.status, 3);
  assert.match(live.stderr, /live promotion is not built/);
  const noAp = spawnSync(process.execPath, [TOOL, ...args.map((a) => (a.endsWith('a.json') ? join(dir, 'missing.json') : a))], { encoding: 'utf8', windowsHide: true });
  assert.equal(noAp.status, 0);
  assert.match(noAp.stdout, /HOLD: autopilot: unreadable/);
});
