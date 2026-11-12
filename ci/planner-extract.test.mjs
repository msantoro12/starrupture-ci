// Tests for ci/planner-extract.mjs: which builds get a planner data extract, when it is retried,
// and when the alert is raised.
//
//   node --test ci/planner-extract.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alertBody, alertTitle, decide, failuresOf, plan, reconcile, runTarget } from './planner-extract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const PIN = '6caf9f6999dafea24b1c829b71ea9dd8aafa5791';
const B = { branch: 'public', buildid: '25646882' };
const OTHER = { branch: 'public_test_branch', buildid: '26461198' };
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
const run = (b, over = {}) => ({ title: `SR data extract ${b.branch} ${b.buildid}`, status: 'completed', conclusion: 'failure', event: 'workflow_dispatch', updatedAt: at(10), url: `https://github.com/o/r/actions/runs/${Math.floor(Math.random() * 1e6)}`, ...over });
const good = { name: 'sr-data-public-25646882', expired: false, runConclusion: 'success' };

test('the pin is one full sha in one file', () => {
  const pin = readFileSync(join(here, 'data', 'extractor-ref.txt'), 'utf8');
  assert.match(pin, /^[0-9a-f]{40}\r?\n$/);
  assert.equal(pin.trim(), PIN);
});

test('nothing covers the build: start', () => {
  const d = decide({ ...B, now: NOW });
  assert.equal(d.action, 'start');
  assert.equal(d.failures, 0);
});

test('covered by a planner tag alone', () => {
  assert.equal(decide({ ...B, now: NOW, tags: ['srdata-public-25646882'] }).action, 'none');
});

test('covered by a failed-gate planner tag alone', () => {
  const d = decide({ ...B, now: NOW, tags: ['srdata-failed-public-25646882'] });
  assert.equal(d.action, 'none');
  assert.match(d.why, /srdata-failed-public-25646882/);
});

test('covered by a successful artifact alone; an expired, failed or other artifact does not cover', () => {
  assert.equal(decide({ ...B, now: NOW, artifacts: [good] }).action, 'none');
  assert.equal(decide({ ...B, now: NOW, artifacts: [{ ...good, expired: true }] }).action, 'start');
  assert.equal(decide({ ...B, now: NOW, artifacts: [{ ...good, runConclusion: 'failure' }] }).action, 'start');
  assert.equal(decide({ ...B, now: NOW, artifacts: [{ ...good, name: 'sr-data-public-1' }] }).action, 'start');
});

test('tags of another build, another branch, or another kind do not cover', () => {
  const tags = ['srdata-public-25646881', 'srdata-public_test_branch-25646882', 'srdata-tools-42425187905-public-25646882', 'srdata-failed-public_test_branch-25646882'];
  assert.equal(decide({ ...B, now: NOW, tags }).action, 'start');
});

test('an extract for this build already queued or going: nothing new', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const d = decide({ ...B, now: NOW, runs: [run(B, { status, conclusion: null })] });
    assert.equal(d.action, 'none', status);
  }
  // A run for another build or a pull-request run of the workflow is not this build's.
  assert.equal(decide({ ...B, now: NOW, runs: [run(OTHER, { status: 'queued', conclusion: null })] }).action, 'start');
  assert.equal(decide({ ...B, now: NOW, runs: [run(B, { status: 'queued', conclusion: null, event: 'pull_request' })] }).action, 'start');
  assert.equal(decide({ ...B, now: NOW, runs: [{ title: 'SR data extract', status: 'queued', event: 'workflow_dispatch' }] }).action, 'start');
});

test('the Steam group busy: wait, and start nothing', () => {
  const d = decide({ ...B, now: NOW, groupBusy: true });
  assert.equal(d.action, 'wait');
  // Covered builds are still covered, whatever the group does.
  assert.equal(decide({ ...B, now: NOW, groupBusy: true, tags: ['srdata-public-25646882'] }).action, 'none');
});

test('backoff: a failure less than 6 hours old waits, exactly 6 hours old retries', () => {
  const justUnder = decide({ ...B, now: NOW, runs: [run(B, { updatedAt: new Date(NOW - 6 * HOUR + 1).toISOString() })] });
  assert.equal(justUnder.action, 'wait');
  assert.equal(justUnder.retryAt, new Date(NOW + 1).toISOString());
  assert.equal(decide({ ...B, now: NOW, runs: [run(B, { updatedAt: at(6) })] }).action, 'start');
  assert.equal(decide({ ...B, now: NOW, runs: [run(B, { updatedAt: at(6.01) })] }).action, 'start');
  // Judged from the latest failure, whatever order the runs come in.
  assert.equal(decide({ ...B, now: NOW, runs: [run(B, { updatedAt: at(1) }), run(B, { updatedAt: at(30) })] }).action, 'alert', 'two failures');
  assert.equal(decide({ ...B, now: NOW, runs: [run(B, { updatedAt: at(1) }), run(OTHER, { updatedAt: at(30) })] }).action, 'wait', 'another build\'s failure does not count');
});

test('a timed out run is a failure; a cancelled or successful one is not', () => {
  assert.equal(failuresOf([run(B, { conclusion: 'timed_out' })], B.branch, B.buildid).length, 1);
  assert.equal(failuresOf([run(B, { conclusion: 'cancelled' }), run(B, { conclusion: 'success' })], B.branch, B.buildid).length, 0);
  assert.equal(decide({ ...B, now: NOW, runs: [run(B, { conclusion: 'cancelled', updatedAt: at(0.1) })] }).action, 'start');
});

test('the second failure raises the alert, once: the alert already raised ends it quietly', () => {
  const runs = [run(B, { updatedAt: at(20) }), run(B, { updatedAt: at(8) })];
  const first = decide({ ...B, now: NOW, runs });
  assert.equal(first.action, 'alert');
  assert.equal(first.failures, 2);
  const again = decide({ ...B, now: NOW, runs, alertRaised: true });
  assert.equal(again.action, 'none');
  // Not retried after two failures, however old the second is, and busy or not.
  assert.equal(decide({ ...B, now: NOW, runs: [run(B, { updatedAt: at(500) }), run(B, { updatedAt: at(400) })], groupBusy: true }).action, 'alert');
  // A tag that appears later still covers the build.
  assert.equal(decide({ ...B, now: NOW, runs, tags: ['srdata-public-25646882'] }).action, 'none');
});

test('run titles name the branch and the build', () => {
  assert.deepEqual(runTarget('SR data extract public_test_branch 26461198'), { branch: 'public_test_branch', buildid: '26461198' });
  assert.equal(runTarget('SR data extract'), null);
  assert.equal(runTarget('Add the data extract workflow'), null);
  assert.equal(runTarget('SR data extract public 12 extra'), null);
  assert.equal(runTarget(undefined), null);
});

test('both branches: only the first build that needs a start gets it, the other waits for the next run', () => {
  const builds = [{ ...B, artifacts: [] }, { ...OTHER, artifacts: [] }];
  const [a, b] = plan({ builds, now: NOW, tags: [], runs: [], groupBusy: false });
  assert.equal(a.action, 'start');
  assert.equal(b.action, 'wait');
  assert.match(b.why, /next poll/);
  // The first branch covered: the second one starts.
  const [c, d] = plan({ builds, now: NOW, tags: ['srdata-public-25646882'], runs: [], groupBusy: false });
  assert.deepEqual([c.action, d.action], ['none', 'start']);
  // A branch that only alerts does not use up the start.
  const failed = [run(B, { updatedAt: at(20) }), run(B, { updatedAt: at(8) })];
  const [e, f] = plan({ builds, now: NOW, tags: [], runs: failed, groupBusy: false });
  assert.deepEqual([e.action, f.action], ['alert', 'start']);
});

// A fake for every outside effect of reconcile; `calls` lists the ones that change something.
const fakeIo = ({ live = { public: '25646882', public_test_branch: '26461198' }, tags = [], runs = [], busy = false, artifacts = {}, alerts = [] } = {}) => {
  const calls = [];
  return {
    calls,
    io: {
      tags: () => tags, runs: () => runs, groupBusy: () => busy,
      liveBuildid: (b) => live[b] ?? '',
      artifacts: (n) => artifacts[n] ?? [],
      alertRaised: (t) => alerts.includes(t),
      dispatch: (x) => calls.push(['dispatch', x]),
      raiseAlert: (x) => calls.push(['alert', x.title, x.body]),
    },
  };
};
const go = (f, over = {}) => reconcile({ repo: 'o/r', branches: ['public', 'public_test_branch'], owner: 'me', pin: PIN, now: NOW, io: f.io, log: () => {}, ...over });

test('reconcile: dispatches the first missing build with the pin, from the live build id', async () => {
  const f = fakeIo({ tags: ['srdata-public-25646882'] });
  const out = await go(f);
  assert.deepEqual(out.map((d) => d.action), ['none', 'start']);
  assert.deepEqual(f.calls, [['dispatch', { branch: 'public_test_branch', buildid: '26461198', pin: PIN }]]);
});

test('reconcile: both branches missing, one dispatch only; both covered, none', async () => {
  const f = fakeIo();
  await go(f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].branch, 'public');
  const g = fakeIo({ tags: ['srdata-public-25646882', 'srdata-public_test_branch-26461198'] });
  await go(g);
  assert.deepEqual(g.calls, []);
});

test('reconcile: a busy Steam group starts nothing; an unreadable build id skips that branch', async () => {
  const f = fakeIo({ busy: true });
  await go(f);
  assert.deepEqual(f.calls, []);
  const g = fakeIo({ live: { public: '', public_test_branch: '26461198' } });
  const out = await go(g);
  assert.equal(out.length, 1);
  assert.equal(g.calls[0][1].branch, 'public_test_branch');
});

test('reconcile: the second failure raises the alert once; the next run finds it raised and stays quiet', async () => {
  const runs = [run(B, { updatedAt: at(20) }), run(B, { updatedAt: at(8) })];
  const f = fakeIo({ runs, tags: ['srdata-public_test_branch-26461198'] });
  await go(f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'alert');
  assert.equal(f.calls[0][1], alertTitle('public', '25646882'));
  assert.match(f.calls[0][2], /^@me .*failed 2 times/);
  assert.ok(f.calls[0][2].includes(`extractor_ref=${PIN}`));
  const g = fakeIo({ runs, tags: ['srdata-public_test_branch-26461198'], alerts: [alertTitle('public', '25646882')] });
  await go(g);
  assert.deepEqual(g.calls, [], 'no second alert, no retry');
});

test('reconcile: --dry-run prints the decision and changes nothing', async () => {
  const lines = [];
  const runs = [run(B, { updatedAt: at(20) }), run(B, { updatedAt: at(8) })];
  const f = fakeIo({ runs });
  const out = await go(f, { dryRun: true, log: (l) => lines.push(l) });
  assert.deepEqual(out.map((d) => d.action), ['alert', 'start']);
  assert.deepEqual(f.calls, []);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^public_test_branch 26461198: start/);
});

test('reconcile: a pin that is not a full sha is refused before anything is read', async () => {
  const f = fakeIo();
  await assert.rejects(go(f, { pin: 'main' }), /full commit sha/);
  await assert.rejects(go(f, { pin: '6caf9f6' }), /full commit sha/);
  assert.deepEqual(f.calls, []);
});

test('the alert body names the runs, the owner and the hand start', () => {
  const body = alertBody({ owner: 'me', branch: 'public', buildid: '1', pin: PIN, repo: 'o/r', failed: [{ url: 'https://x/1' }, { url: 'https://x/2' }] });
  assert.match(body, /^@me /);
  assert.ok(body.includes('- failed run: https://x/1') && body.includes('- failed run: https://x/2'));
  assert.ok(body.includes('gh workflow run sr-data-extract.yml -R o/r --ref main -f branch=public -f buildid=1'));
});
