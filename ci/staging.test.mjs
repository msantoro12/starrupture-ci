// Tests for staging.mjs (version-map step 45).
//
//   node --test ci/staging.test.mjs
//
// The hashes and stamps are made up. The build ids are the ones state/steam.json
// records today for the two client branches.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOADER_REPO, StagingError, branchName, commitMessage, makeRecord, parseCommitRecord, rederive, stage } from './staging.mjs';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'staging.mjs');

const ptr = (over = {}) => ({
  cl: 128786, branch: 'public_test_branch', buildid: '26271156', productVersion: '++Earth20+Kobalt-PTR1-CL-128786',
  exeSha256: 'ab'.repeat(32), imageStamp: '0x6b000001', size: 0x0a430000, run: 41160586757,
  scans: [{ exe: 'public_test_branch', buildid: '26271156', ok: true }, { exe: 'public', buildid: '25646882', ok: true }],
  repo: { sha: 'c0ffee'.repeat(6) + 'c0ff', tree: 'decade'.repeat(6) + 'dead', verdict: 'FIXED' },
  ...over,
});

// Effects that fail on anything but the two a beta may use.
function effects() {
  const calls = { pushBranch: [], writeIndex: [] };
  const trap = (name) => () => { throw new Error(`${name} must not run on a beta`); };
  return {
    calls,
    fx: new Proxy({ pushBranch: (p) => calls.pushBranch.push(p), writeIndex: (i) => calls.writeIndex.push(i) }, {
      get: (t, k) => (k in t ? t[k] : trap(String(k))),
    }),
  };
}

test('replaying the current PTR build gives the loader branch and the index', () => {
  const { fx, calls } = effects();
  const plan = stage(ptr(), { index: {}, effects: fx });
  assert.equal(plan.repo, LOADER_REPO);
  assert.equal(plan.branch, 'auto/update-128786');
  assert.equal(calls.pushBranch.length, 1);
  assert.equal(calls.writeIndex.length, 1);
  const e = plan.index['128786'];
  assert.equal(e.branch, 'public_test_branch');
  assert.equal(e.buildid, 26271156);
  assert.equal(e.superseded, false);
  assert.deepEqual(e.repos[LOADER_REPO], { ref: 'auto/update-128786', sha: ptr().repo.sha, tree: ptr().repo.tree, verdict: 'FIXED' });
  assert.deepEqual(e.verifiedOn, ['public 25646882', 'public_test_branch 26271156']);
});

test('no signing, no publishing and no release runs on a beta', () => {
  const { fx, calls } = effects();
  // Any other effect on the proxy throws, so a call to sign, publish, release or export would fail this test.
  stage(ptr(), { index: {}, effects: fx });
  assert.deepEqual(Object.keys(calls).sort(), ['pushBranch', 'writeIndex']);
  assert.match(stage(ptr(), { index: {}, effects: fx }).message, /not signed, not published/);
  const src = readFileSync(TOOL, 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(src, /vmap-sign|exportFeed|release\.yml|gh release|gh workflow/);
});

test('the record rides in the commit message and reads back', () => {
  const rec = makeRecord(ptr());
  assert.deepEqual(parseCommitRecord(commitMessage(rec)), rec);
  assert.throws(() => parseCommitRecord('Add map rows\n'), StagingError);
});

test('a newer build at the same CL gets the run id, and a taken name is refused', () => {
  assert.equal(branchName(128786, ['auto/update-128786'], 77), 'auto/update-128786-77');
  assert.throws(() => branchName(128786, ['auto/update-128786', 'auto/update-128786-77'], 77), /already exists/);
});

test('a newer CL on the same branch supersedes the older one, never deletes it', () => {
  const { fx } = effects();
  const first = stage(ptr(), { index: {}, effects: fx }).index;
  const second = stage(ptr({ cl: 128900, buildid: '26300000', run: 5 }), { index: first, effects: fx }).index;
  assert.equal(second['128786'].superseded, true);
  assert.equal(second['128900'].superseded, false);
  assert.deepEqual(Object.keys(second), ['128786', '128900']);
});

test('public is not staged, and both exes must pass', () => {
  const { fx } = effects();
  assert.throws(() => stage(ptr({ branch: 'public' }), { index: {}, effects: fx }), /promoted, not staged/);
  assert.throws(() => stage(ptr({ scans: [{ exe: 'public_test_branch', buildid: '1', ok: true }] }), { index: {}, effects: fx }), /no scan on the public exe/);
  assert.throws(() => stage(ptr({ scans: [{ exe: 'public_test_branch', buildid: '1', ok: true }, { exe: 'public', buildid: '2', ok: false }] }), { index: {}, effects: fx }), /did not pass/);
  assert.throws(() => stage(ptr({ exeSha256: 'xyz' }), { index: {}, effects: fx }), /sha256/);
});

test('the index is re-derived from the fork branches', () => {
  const { fx } = effects();
  const a = stage(ptr(), { index: {}, effects: fx });
  const b = stage(ptr({ cl: 128900, buildid: '26300000', run: 5 }), { index: a.index, effects: fx });
  const branches = [
    { ref: b.branch, sha: ptr().repo.sha, tree: ptr().repo.tree, message: b.message },
    { ref: a.branch, sha: ptr().repo.sha, tree: ptr().repo.tree, message: a.message },
  ];
  assert.deepEqual(rederive(branches), b.index);
});

test('the command line stages in dry run and writes the index, and refuses a bad build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-'));
  const w = (n, d) => { writeFileSync(join(dir, n), JSON.stringify(d)); return join(dir, n); };
  const index = join(dir, 'staged.json');
  const run = spawnSync(process.execPath, [TOOL, 'stage', '--build', w('b.json', ptr()), '--index', index, '--out', join(dir, 'plan.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /would push StarRupture-ModLoader auto\/update-128786; index now lists 1 CLs; nothing signed or published/);
  assert.equal(JSON.parse(readFileSync(index, 'utf8'))['128786'].buildid, 26271156);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')).pushed, [{ repo: LOADER_REPO, branch: 'auto/update-128786', done: false }]);
  const bad = spawnSync(process.execPath, [TOOL, 'stage', '--build', w('b2.json', ptr({ branch: 'public' })), '--index', index], { encoding: 'utf8', windowsHide: true });
  assert.equal(bad.status, 3);
});
