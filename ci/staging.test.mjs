// Tests for staging.mjs (version-map step 45).
//
//   node --test ci/staging.test.mjs
//
// The hashes and stamps are made up. The build ids are the ones state/steam.json
// records today for the two client branches.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HEADER_PATH, LOADER_REPO, PUSH_BRANCH, PUSH_REPOS, StagingError, branchName, checkTarget, commitMessage, makeRecord, parseCommitRecord, pushLoader, rederive, stage } from './staging.mjs';

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

test('both exes must pass for a beta build', () => {
  const { fx } = effects();
  assert.throws(() => stage(ptr({ scans: [{ exe: 'public_test_branch', buildid: '1', ok: true }] }), { index: {}, effects: fx }), /no scan on the public exe/);
  assert.throws(() => stage(ptr({ scans: [{ exe: 'public_test_branch', buildid: '1', ok: true }, { exe: 'public', buildid: '2', ok: false }] }), { index: {}, effects: fx }), /did not pass/);
  assert.throws(() => stage(ptr({ exeSha256: 'xyz' }), { index: {}, effects: fx }), /sha256/);
});

// A build first seen on public: pushed for the candidate loader and the rig, never staged.
const pub = (over = {}) => ptr({ branch: 'public', buildid: '26461198', scans: [{ exe: 'public', buildid: '26461198', ok: true }], ...over });

test('a build first seen on public gets a branch and a record of the public exe only, and no index entry', () => {
  const { fx, calls } = effects();
  const before = { '128786': { branch: 'public_test_branch', superseded: false } };
  const plan = stage(pub({ cl: 129402 }), { index: before, effects: fx });
  assert.equal(plan.repo, LOADER_REPO);
  assert.equal(plan.branch, 'auto/update-129402');
  assert.equal(calls.pushBranch.length, 1);
  assert.equal(calls.writeIndex.length, 0, 'nothing is written to the staged index');
  assert.deepEqual(plan.index, before, 'the index comes back unchanged');
  const rec = parseCommitRecord(plan.message);
  assert.equal(rec.branch, 'public');
  assert.deepEqual(rec.verifiedOn, ['public 26461198']);
  assert.match(plan.message, /not signed, not published/);
  assert.throws(() => stage(pub({ scans: [{ exe: 'public', buildid: '1', ok: false }] }), { index: {}, effects: fx }), /did not pass/);
  assert.throws(() => stage(pub({ scans: [] }), { index: {}, effects: fx }), /no scan on the public exe/);
});

test('a public record is not a staged build when the index is re-derived', () => {
  const { fx } = effects();
  const a = stage(ptr(), { index: {}, effects: fx });
  const p = stage(pub({ cl: 129402 }), { index: {}, effects: fx });
  const branches = [
    { ref: a.branch, sha: ptr().repo.sha, tree: ptr().repo.tree, message: a.message },
    { ref: p.branch, sha: ptr().repo.sha, tree: ptr().repo.tree, message: p.message },
  ];
  assert.deepEqual(Object.keys(rederive(branches)), ['128786']);
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
  const bad = spawnSync(process.execPath, [TOOL, 'stage', '--build', w('b2.json', ptr({ exeSha256: 'xyz' })), '--index', index], { encoding: 'utf8', windowsHide: true });
  assert.equal(bad.status, 3);
  // A build of public is planned too, and the index file keeps its one entry.
  const plan = join(dir, 'plan-public.json');
  const ok = spawnSync(process.execPath, [TOOL, 'stage', '--build', w('b3.json', pub({ cl: 129402 })), '--index', index, '--out', plan], { encoding: 'utf8', windowsHide: true });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(readFileSync(plan, 'utf8')).branch, 'auto/update-129402');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(index, 'utf8'))), ['128786']);
});

// ------------------------------------------------------------ the real push (step 26)

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const SLUG = 'msantoro12/StarRupture-ModLoader';

// A bare "fork" with one commit that holds the header, and clones of it standing in for the runner's checkout.
function fork() {
  const dir = mkdtempSync(join(tmpdir(), 'push-'));
  const remote = join(dir, 'remote.git');
  sh(dir, 'init', '-q', '--bare', '--initial-branch=main', remote);
  const seed = join(dir, 'seed');
  sh(dir, 'init', '-q', '--initial-branch=main', seed);
  mkdirSync(dirname(join(seed, HEADER_PATH)), { recursive: true });
  writeFileSync(join(seed, HEADER_PATH), 'old rows\n');
  writeFileSync(join(seed, 'README.md'), 'loader\n');
  sh(seed, 'add', '-A');
  sh(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  sh(seed, 'push', '-q', remote, 'main');
  const base = { sha: sh(seed, 'rev-parse', 'HEAD'), tree: sh(seed, 'rev-parse', 'HEAD^{tree}'), verdict: 'FIXED' };
  const url = pathToFileURL(remote).href;
  let n = 0;
  const checkout = () => { const c = join(dir, `co${n++}`); sh(dir, '-c', 'core.autocrlf=false', 'clone', '-q', url, c); return c; };
  const header = (text) => { const p = join(dir, `h${n++}.h`); writeFileSync(p, text); return p; };
  const plan = { repo: LOADER_REPO, branch: 'auto/update-129402', message: commitMessage(makeRecord(ptr({ cl: 129402, repo: base }))) };
  return { dir, remote, url, base, checkout, header, plan, build: { repo: base } };
}
const refs = (f) => sh(f.remote, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean).sort();
const push = (f, over = {}, git) => pushLoader({ repo: SLUG, plan: f.plan, build: f.build, header: f.header('new rows\n'), checkout: f.checkout(), runId: 77, runAttempt: 1, url: f.url, ...over }, git);

test('the push is one commit on the loader commit the rows were read from, and it changes only the header', () => {
  const f = fork();
  const r = push(f);
  assert.deepEqual(r, { branch: 'auto/update-129402', sha: r.sha, tree: r.tree, pushed: true });
  assert.deepEqual(refs(f), ['refs/heads/auto/update-129402', 'refs/heads/main']);
  assert.equal(sh(f.remote, 'rev-parse', 'refs/heads/auto/update-129402'), r.sha);
  assert.equal(sh(f.remote, 'rev-parse', `${r.sha}^`), f.base.sha, 'cut from the recorded loader commit');
  assert.deepEqual(sh(f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', r.sha).split('\n'), [HEADER_PATH]);
  assert.equal(sh(f.remote, 'show', `${r.sha}:${HEADER_PATH}`), 'new rows');
  assert.equal(sh(f.remote, 'log', '-1', '--format=%B', r.sha).trim(), f.plan.message.trim());
  assert.deepEqual(sh(f.remote, 'tag', '-l').split('\n').filter(Boolean), [], 'no tag');
});

test('a branch that already holds the same tree is left alone', () => {
  const f = fork();
  const first = push(f, { header: f.header('new rows\n') });
  const again = push(f, { header: f.header('new rows\n'), runId: 78 });
  assert.equal(again.pushed, false);
  assert.equal(again.branch, 'auto/update-129402');
  assert.equal(again.sha, first.sha);
  assert.deepEqual(refs(f), ['refs/heads/auto/update-129402', 'refs/heads/main']);
});

test('a branch that holds another tree is never overwritten: the push goes to a run-suffixed name', () => {
  const f = fork();
  const first = push(f, { header: f.header('rows A\n') });
  const second = push(f, { header: f.header('rows B\n'), runId: 78, runAttempt: 2 });
  assert.equal(second.pushed, true);
  assert.equal(second.branch, 'auto/update-129402-78-2');
  assert.equal(sh(f.remote, 'rev-parse', 'refs/heads/auto/update-129402'), first.sha, 'the first branch is untouched');
  // The same rows again are found on the suffixed name; a third tree has nowhere to go.
  assert.equal(push(f, { header: f.header('rows B\n'), runId: 78, runAttempt: 2 }).pushed, false);
  assert.throws(() => push(f, { header: f.header('rows C\n'), runId: 78, runAttempt: 2 }), /both exist with other trees/);
  assert.deepEqual(refs(f), ['refs/heads/auto/update-129402', 'refs/heads/auto/update-129402-78-2', 'refs/heads/main']);
});

test('a proof run pushes only the run-suffixed name, never the plain auto/update-<CL>', () => {
  const f = fork();
  const r = push(f, { proof: true, runId: 78, runAttempt: 2 });
  assert.equal(r.pushed, true);
  assert.equal(r.branch, 'auto/update-129402-78-2');
  assert.deepEqual(refs(f), ['refs/heads/auto/update-129402-78-2', 'refs/heads/main'], 'the plain name stays free for the unattended chain');
  // The same rows again are found there; other rows have nowhere to go.
  assert.equal(push(f, { proof: true, runId: 78, runAttempt: 2 }).pushed, false);
  assert.throws(() => push(f, { proof: true, runId: 78, runAttempt: 2, header: f.header('rows C\n') }), /auto\/update-129402-78-2 exists with another tree/);
  // A proof run never takes the plain name, even when it is free and holds the same tree.
  const g = fork();
  push(g, { header: g.header('same\n') });
  assert.equal(push(g, { proof: true, header: g.header('same\n') }).branch, 'auto/update-129402-77-1');
});

test('git never sees a force, a tag, a delete or a ref outside auto/update-<CL>', () => {
  const f = fork();
  const calls = [];
  const git = (args, o) => { calls.push(args); return execFileSync('git', args, { cwd: o.cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); };
  push(f, {}, git);
  const pushes = calls.filter((a) => a.includes('push'));
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0].includes('--no-tags'));
  assert.match(pushes[0].at(-1), /^HEAD:refs\/heads\/auto\/update-\d+$/);
  for (const a of calls.flat()) assert.doesNotMatch(a, /^(--force|--force-with-lease|-f|--mirror|--delete|--tags|--all)$|^\+|refs\/tags/);
});

test('the allowlist: one repository and the auto/update-<CL> branch pattern only', () => {
  assert.doesNotThrow(() => checkTarget(SLUG, 'auto/update-129402'));
  assert.doesNotThrow(() => checkTarget(SLUG, 'auto/update-129402-41160586757-2'));
  assert.deepEqual(PUSH_REPOS, [SLUG]);
  for (const repo of ['AlienXAXS/StarRupture-ModLoader', 'msantoro12/StarRupture-Plugin-WAILA', 'msantoro12/starrupture-ci', 'msantoro12/StarRupture-ModLoader-evil', '', undefined]) {
    assert.throws(() => checkTarget(repo, 'auto/update-129402'), StagingError, String(repo));
  }
  for (const branch of ['main', 'gss/loader-work', 'auto/test', 'auto/update-', 'auto/update-12a', 'auto/update-1-2-3-4', 'auto/update-1/x', 'auto/update-1\nmain', 'refs/tags/v1', 'v1.2.3', '../auto/update-1', 'auto/update-129402 main', '', undefined]) {
    assert.throws(() => checkTarget(SLUG, branch), StagingError, String(branch));
  }
  assert.ok(PUSH_BRANCH.test('auto/update-1') && !PUSH_BRANCH.test('xauto/update-1'));
});

test('a repository or branch outside the allowlist is refused before git runs', () => {
  const f = fork();
  const never = () => { throw new Error('git must not run'); };
  const base = { build: f.build, header: 'x', checkout: 'y', runId: 1, runAttempt: 1 };
  assert.throws(() => pushLoader({ ...base, repo: 'AlienXAXS/StarRupture-ModLoader', plan: f.plan }, never), /not a repository the push job writes to/);
  assert.throws(() => pushLoader({ ...base, repo: SLUG, plan: { ...f.plan, branch: 'main' } }, never), /not a branch the push job writes/);
  assert.throws(() => pushLoader({ ...base, repo: SLUG, plan: { ...f.plan, branch: 'v1.0.0' } }, never), /not a branch the push job writes/);
});

test('refused: a checkout that is not the recorded loader commit, rows equal to the loader header, or more than the header changed', () => {
  const f = fork();
  assert.throws(() => push(f, { build: { repo: { ...f.base, sha: 'a'.repeat(40) } } }), /not the loader commit the chain read/);
  assert.throws(() => push(f, { build: { repo: { ...f.base, tree: 'b'.repeat(40) } } }), /checkout tree is not the one/);
  assert.throws(() => push(f, { header: f.header('old rows\n') }), /no rows to push/);
  const co = f.checkout();
  writeFileSync(join(co, 'README.md'), 'changed\n');
  sh(co, 'add', 'README.md');
  assert.throws(() => push(f, { checkout: co }), /more than the header: README\.md/);
  assert.deepEqual(refs(f), ['refs/heads/main'], 'nothing was pushed');
});

test('the command line checks the target alone (the push job runs it before it uses the key)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'target-'));
  const planFile = join(dir, 'plan.json');
  writeFileSync(planFile, JSON.stringify({ repo: LOADER_REPO, branch: 'auto/update-129402', message: 'm' }));
  const run = (repo) => spawnSync(process.execPath, [TOOL, 'target', '--repo', repo, '--plan', planFile], { encoding: 'utf8', windowsHide: true });
  assert.equal(run(SLUG).status, 0);
  assert.equal(run('AlienXAXS/StarRupture-ModLoader').status, 3);
  writeFileSync(planFile, JSON.stringify({ repo: LOADER_REPO, branch: 'gss/loader-work', message: 'm' }));
  const bad = run(SLUG);
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /not a branch the push job writes/);
});
