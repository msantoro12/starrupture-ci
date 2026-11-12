// Tests for ci/planner-extract.mjs: which builds get a planner data extract, when it is retried,
// and when the alert is raised.
//
//   node --test ci/planner-extract.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alertBody, alertTitle, cancelExtracts, cancelPlan, decide, failuresOf, groupBusyIn, plan, reconcile, realIo, runTarget } from './planner-extract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const PIN = '0123456789abcdef0123456789abcdef01234567';
const B = { branch: 'public', buildid: '25646882' };
const OTHER = { branch: 'public_test_branch', buildid: '26461198' };
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
const run = (b, over = {}) => ({ title: `SR data extract ${b.branch} ${b.buildid}`, status: 'completed', conclusion: 'failure', event: 'workflow_dispatch', updatedAt: at(10), url: `https://github.com/o/r/actions/runs/${Math.floor(Math.random() * 1e6)}`, ...over });
const good = { name: 'sr-data-public-25646882', expired: false, runConclusion: 'success' };

test('the pin is one full sha in one file', () => {
  const pin = readFileSync(join(here, 'data', 'extractor-ref.txt'), 'utf8');
  assert.match(pin, /^[0-9a-f]{40}\r?\n$/);
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

// ---- a cancelled extract is not a failure ------------------------------------------------------

test('cancelled runs add no backoff and count toward no alert', () => {
  const cancelled = (hoursAgo) => run(B, { conclusion: 'cancelled', updatedAt: at(hoursAgo) });
  // Cancelled runs alone: the build starts again at once, however recent.
  const d = decide({ ...B, now: NOW, runs: [cancelled(0.01), cancelled(0.02), cancelled(0.03)] });
  assert.equal(d.action, 'start');
  assert.equal(d.failures, 0);
  // One failure 10 hours ago and a cancel a minute ago: the backoff is judged from the failure only.
  assert.equal(decide({ ...B, now: NOW, runs: [run(B, { updatedAt: at(10) }), cancelled(0.01)] }).action, 'start');
  // One failure 2 hours ago still waits, and a later cancel does not move the retry time.
  const w = decide({ ...B, now: NOW, runs: [run(B, { updatedAt: at(2) }), cancelled(0.01)] });
  assert.equal(w.action, 'wait');
  assert.equal(w.retryAt, new Date(NOW + 4 * HOUR).toISOString());
  // One failure and many cancels never reach the two-failure alert; two failures and a cancel do, counted as two.
  assert.equal(decide({ ...B, now: NOW, runs: [run(B, { updatedAt: at(20) }), cancelled(8), cancelled(7), cancelled(6.5)] }).action, 'start');
  const a = decide({ ...B, now: NOW, runs: [run(B, { updatedAt: at(20) }), cancelled(10), run(B, { updatedAt: at(8) })] });
  assert.equal(a.action, 'alert');
  assert.equal(a.failures, 2);
});

// ---- cancelling the extracts in front of the chain ---------------------------------------------

const live = (id, over = {}) => run(B, { id, status: 'in_progress', conclusion: null, ...over });

test('cancelPlan: queued or going extract runs for a build; not finished, not pull-request, not build-only runs', () => {
  const runs = [
    live(1), live(2, { status: 'queued' }), live(3, { status: 'waiting' }), live(4, { status: 'pending' }), live(5, { status: 'requested' }),
    live(6, { status: 'completed', conclusion: 'success' }), live(7, { event: 'pull_request' }),
    live(8, { title: 'SR data extract' }), live(9, { title: 'Add the data extract workflow' }),
    { ...live(10), id: undefined }, run(OTHER, { id: 11, status: 'in_progress', conclusion: null }),
  ];
  assert.deepEqual(cancelPlan(runs), [1, 2, 3, 4, 5, 11]);
  assert.deepEqual(cancelPlan([]), []);
  assert.deepEqual(cancelPlan(undefined), []);
});

// A fake for the cancel effects: `ends` maps a run id to the poll count at which it has ended.
const cancelIo = ({ runs, ends = {}, refuse = [], listFails = false } = {}) => {
  const cancelled = [];
  let polls = 0;
  return {
    cancelled,
    polls: () => polls,
    io: {
      runs: () => {
        if (listFails && polls > 0) throw new Error('boom');
        polls++;
        return runs.map((r) => (cancelled.includes(r.id) && polls > (ends[r.id] ?? 1e9) ? { ...r, status: 'completed', conclusion: 'cancelled' } : r));
      },
      cancel: (id) => { if (refuse.includes(id)) throw new Error('403 refused'); cancelled.push(id); },
    },
  };
};
const noSleep = { sleep: async () => {}, log: () => {} };

test('cancelExtracts: cancels every queued or going extract run and returns once they have ended', async () => {
  const f = cancelIo({ runs: [live(1), live(2, { status: 'queued' }), live(3, { status: 'completed', conclusion: 'success' })], ends: { 1: 3, 2: 2 } });
  const out = await cancelExtracts({ io: f.io, ...noSleep });
  assert.deepEqual(f.cancelled, [1, 2]);
  assert.deepEqual(out, { cancelled: [1, 2], ended: true });
});

test('cancelExtracts: nothing to cancel is quiet and fast', async () => {
  const f = cancelIo({ runs: [live(3, { status: 'completed', conclusion: 'success' })] });
  assert.deepEqual(await cancelExtracts({ io: f.io, ...noSleep }), { cancelled: [], ended: true });
  assert.deepEqual(f.cancelled, []);
  assert.equal(f.polls(), 1);
});

test('cancelExtracts: --dry-run changes nothing', async () => {
  const lines = [];
  const f = cancelIo({ runs: [live(1)] });
  const out = await cancelExtracts({ io: f.io, dryRun: true, sleep: async () => {}, log: (l) => lines.push(l) });
  assert.deepEqual(f.cancelled, []);
  assert.deepEqual(out.cancelled, [1]);
  assert.match(lines[0], /would cancel extract run\(s\) 1/);
});

test('cancelExtracts: a run that will not end is waited for only the bounded time, then a warning, no throw', async () => {
  const lines = [];
  const slept = [];
  const f = cancelIo({ runs: [live(1)] });
  const out = await cancelExtracts({ io: f.io, waitSeconds: 60, intervalSeconds: 15, sleep: async (s) => slept.push(s), log: (l) => lines.push(l) });
  assert.equal(out.ended, false);
  assert.deepEqual(slept, [15, 15, 15, 15]);
  assert.match(lines.at(-1), /^warning: .*still going after 60 seconds; the chain goes on/);
});

test('cancelExtracts: a refused cancel is a warning; the other runs are still cancelled and the call does not throw', async () => {
  const lines = [];
  const f = cancelIo({ runs: [live(1), live(2)], refuse: [1], ends: { 2: 1 } });
  const out = await cancelExtracts({ io: f.io, sleep: async () => {}, log: (l) => lines.push(l) });
  assert.deepEqual(f.cancelled, [2]);
  assert.equal(out.ended, true);
  assert.ok(lines.some((l) => /^warning: extract run 1 could not be cancelled/.test(l)));
  // Every cancel refused: no waiting at all.
  const g = cancelIo({ runs: [live(1)], refuse: [1] });
  const slept = [];
  assert.deepEqual(await cancelExtracts({ io: g.io, sleep: async (s) => slept.push(s), log: () => {} }), { cancelled: [], ended: false });
  assert.deepEqual(slept, [5, 5], 'three tries, five seconds apart, and no waiting for runs that were not cancelled');
});

test('cancelExtracts: one failed call is tried again; the cancel and the listing both recover', async () => {
  let listCalls = 0;
  let cancelCalls = 0;
  const ended = [];
  const io = {
    runs: () => {
      if (++listCalls === 1) throw new Error('502');
      return [live(1, ended.length ? { status: 'completed', conclusion: 'cancelled' } : {})];
    },
    cancel: (id) => { if (++cancelCalls === 1) throw new Error('secondary rate limit'); ended.push(id); },
  };
  const out = await cancelExtracts({ io, sleep: async () => {}, log: () => {} });
  assert.deepEqual(out, { cancelled: [1], ended: true });
  assert.deepEqual(ended, [1]);
});

test('a run that never started or went stale counts as a failure, a cancelled one does not', () => {
  for (const conclusion of ['startup_failure', 'stale']) assert.equal(failuresOf([run(B, { conclusion })], B.branch, B.buildid).length, 1);
  assert.equal(failuresOf([run(B, { conclusion: 'cancelled' })], B.branch, B.buildid).length, 0);
});

test('cancelExtracts: a runs list that cannot be read, before or after the cancel, is a warning and no throw', async () => {
  const lines = [];
  const bad = { runs: () => { throw new Error('502'); }, cancel: () => { throw new Error('unreachable'); } };
  assert.deepEqual(await cancelExtracts({ io: bad, sleep: async () => {}, log: (l) => lines.push(l) }), { cancelled: [], ended: false });
  assert.match(lines[0], /^warning: the extract runs could not be listed/);
  const f = cancelIo({ runs: [live(1)], listFails: true });
  const out = await cancelExtracts({ io: f.io, sleep: async () => {}, log: (l) => lines.push(l) });
  assert.deepEqual(out, { cancelled: [1], ended: false });
  assert.match(lines.at(-1), /^warning: the extract runs could not be listed while waiting/);
});

test('cancel command: a bad listing never gives a nonzero exit (dry run, no network use needed for the usage error)', () => {
  const r = spawnSync(process.execPath, [join(here, 'planner-extract.mjs'), 'cancel'], { encoding: 'utf8' });
  assert.equal(r.status, 2, 'a missing --repo is a usage error');
  assert.match(r.stderr, /--repo is required/);
});

// ---- the workflow text ---------------------------------------------------------------------------

const stripped = (s) => s.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const workflowText = (name) => stripped(readFileSync(join(here, '..', '.github', 'workflows', name), 'utf8'));
const watch = workflowText('sr-watch.yml');
const clientCheck = workflowText('sr-client-check.yml');
const dataExtract = workflowText('sr-data-extract.yml');
// The jobs of a workflow as { name: text }, split at the two-space keys under jobs:.
const jobsOf = (text) => {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const out = {};
  let cur = null;
  for (const line of body.split('\n')) {
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { cur = m[1]; out[cur] = ''; } else if (cur) out[cur] += `${line}\n`;
  }
  return out;
};
const watchJobs = jobsOf(watch);

test('sr-watch.yml: the extract job is there and no job needs it', () => {
  assert.ok(watchJobs['planner-extract'], 'the planner-extract job exists');
  for (const [name, text] of Object.entries(watchJobs)) {
    if (name !== 'planner-extract') assert.ok(!/needs:[^\n]*planner-extract|^\s+- planner-extract\s*$|needs\.planner-extract/m.test(text), `${name} must not need planner-extract`);
  }
  assert.ok(!clientCheck.includes('planner-extract'), 'sr-client-check.yml has nothing to do with the extract job');
  assert.ok(!/needs:.*planner-extract/.test(watch));
});

test('sr-watch.yml: the extract job starts after the chain and cannot fail the run', () => {
  const j = watchJobs['planner-extract'];
  assert.match(j, /^    needs: \[poll, client-check\]$/m);
  assert.match(j, /^    if: \$\{\{ !cancelled\(\) && needs\.poll\.result == 'success' \}\}$/m);
  assert.match(j, /^    continue-on-error: true$/m);
  assert.match(j, /^    timeout-minutes: \d+$/m);
});

test('sr-watch.yml: permissions are job-scoped, the extract job holds no secret, and only it and the poll write actions', () => {
  assert.match(watch, /^permissions: \{\}$/m, 'the workflow default stays empty');
  const j = watchJobs['planner-extract'];
  const perms = /^    permissions:\n((?:      .*\n)+)/m.exec(j)[1].split('\n').filter(Boolean).map((l) => l.trim().split(/\s+#/)[0]);
  assert.deepEqual(perms, ['contents: read', 'actions: write', 'issues: write']);
  assert.ok(!/secrets\./.test(j) && !/secrets:/.test(j), 'no secret is passed to the extract job');
  const writers = Object.entries(watchJobs).filter(([, t]) => /^      actions: write/m.test(t)).map(([n]) => n);
  assert.deepEqual(writers.sort(), ['client-check', 'planner-extract', 'poll']);
  // The call to the client check keeps the ceiling it had.
  assert.match(watchJobs['client-check'], /^      actions: write   # feed-loader-cleanup/m);
});

test('sr-watch.yml: the pin is read from the file, not written in the workflow', () => {
  const j = watchJobs['planner-extract'];
  assert.ok(!/[0-9a-f]{40}/.test(j), 'no sha in the job');
  assert.ok(!/extractor_ref|--pin/.test(j + watchJobs.poll), 'the workflow passes no pin; the script reads the file');
  assert.match(j, /sparse-checkout: \|\n\s+ci\n/, 'the file comes with the checkout of ci');
  const script = readFileSync(join(here, 'planner-extract.mjs'), 'utf8');
  assert.ok(script.includes("a['pin-file'] ?? 'ci/data/extractor-ref.txt'"), 'the script reads ci/data/extractor-ref.txt by default');
});

test('sr-watch.yml: the alert job still waits for the poll and the build only', () => {
  assert.match(watchJobs.alert, /^    needs: \[poll, build\]$/m);
});

test('sr-watch.yml: the cancel step runs only when the client chain starts and cannot fail the poll or the chain', () => {
  const poll = watchJobs.poll;
  const at = poll.indexOf('      - name: Cancel planner data extract runs\n');
  assert.ok(at >= 0, 'the poll job has the cancel step');
  const step = poll.slice(at);
  assert.equal(poll.slice(at + 1).includes('\n      - name:'), false, 'it is the last step of the poll job');
  const cond = /^        if: (.*)$/m.exec(step)[1];
  // The same condition as the client-check job, so a cancel happens exactly when the Steam chain starts.
  const chain = /^    if: (.*)$/m.exec(watchJobs['client-check'])[1];
  assert.equal(cond, "steps.poll.outputs.changed == 'true' && steps.pr.outputs.skip != 'true' && startsWith(steps.poll.outputs.client_matrix, '[{')");
  assert.equal(cond.replace(/steps\.poll\./g, 'needs.poll.').replace('steps.pr.outputs.skip', 'needs.poll.outputs.skip'), chain);
  assert.match(step, /^        continue-on-error: true$/m);
  assert.match(step, /^        timeout-minutes: [1-9]$/m);
  assert.match(step, /node ci\/planner-extract\.mjs cancel --repo "\$GH_REPO" --wait-seconds 240$/m);
  // The wait fits in the poll job's time limit with room for the other steps.
  const stepMin = Number(/timeout-minutes: (\d+)/.exec(step)[1]);
  const jobMin = Number(/^    timeout-minutes: (\d+)$/m.exec(poll)[1]);
  assert.ok(jobMin >= stepMin + 8, 'the poll job limit leaves its usual 8 minutes besides the cancel step');
  assert.ok(Number(/--wait-seconds (\d+)/.exec(step)[1]) <= stepMin * 60 - 60);
});

test('sr-watch.yml: the known gap, a hand-started client check, is written down at the cancel step', () => {
  const raw = readFileSync(join(here, '..', '.github', 'workflows', 'sr-watch.yml'), 'utf8').replace(/\r\n/g, '\n');
  const before = raw.slice(0, raw.indexOf('- name: Cancel planner data extract runs'));
  assert.match(before.slice(before.lastIndexOf('# A planner data extract')), /started by hand[\s\S]*cancels nothing and waits behind a running extract/);
});

test('sr-data-extract.yml: the run name is what the script looks for', () => {
  const m = /^run-name: \$\{\{ (.*) \}\}$/m.exec(dataExtract);
  assert.ok(m, 'the workflow has a run-name');
  const expr = m[1];
  assert.match(expr, /^github\.event_name == 'workflow_dispatch' && inputs\.build_only == false && format\('(SR data extract \{0\} \{1\})', inputs\.branch, inputs\.buildid\) \|\| '(SR data extract)'$/);
  const [, fmt, plain] = /format\('([^']*)', .*\) \|\| '([^']*)'$/.exec(expr);
  const title = fmt.replace('{0}', 'public_test_branch').replace('{1}', '26461198');
  assert.deepEqual(runTarget(title), { branch: 'public_test_branch', buildid: '26461198' });
  assert.equal(runTarget(plain), null, 'the plain title (build-only, pull request, call) matches no build');
});

test('sr-data-extract.yml: a cancelled run does not fail on top of the cancel', () => {
  const step = dataExtract.replace(/\r\n/g, '\n').split('      - name: Outputs and result')[1];
  assert.ok(step, 'the last step is there');
  assert.match(step, /^ {10}CANCELLED: \$\{\{ job\.status == 'cancelled' \}\}$/m);
  assert.match(step, /if \(\$status -ne 'ok' -and \$env:CANCELLED -ne 'true'\) \{[^\n]*exit 1 \}/);
});

test('the alert body names the runs, the owner and the hand start', () => {
  const body = alertBody({ owner: 'me', branch: 'public', buildid: '1', pin: PIN, repo: 'o/r', failed: [{ url: 'https://x/1' }, { url: 'https://x/2' }] });
  assert.match(body, /^@me /);
  assert.ok(body.includes('- failed run: https://x/1') && body.includes('- failed run: https://x/2'));
  assert.ok(body.includes('gh workflow run sr-data-extract.yml -R o/r --ref main -f branch=public -f buildid=1'));
});

// ---- the busy look is one read ------------------------------------------------------------------

const steamRun = (over = {}) => ({ status: 'in_progress', event: 'workflow_dispatch', path: '.github/workflows/sr-client-check.yml', ...over });

test('groupBusyIn: a Steam run in any of the five states makes the group busy; the rest does not', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    assert.equal(groupBusyIn([steamRun({ status })]), true, status);
  }
  for (const path of ['.github/workflows/sr-client-rig.yml', '.github/workflows/sr-data-extract.yml', '.github/workflows/sr-client-check.yml@refs/heads/main']) assert.equal(groupBusyIn([steamRun({ path })]), true, path);
  assert.equal(groupBusyIn([]), false);
  assert.equal(groupBusyIn([steamRun({ status: 'completed' })]), false, 'a finished run');
  assert.equal(groupBusyIn([steamRun({ event: 'pull_request' })]), false, 'a pull-request run');
  assert.equal(groupBusyIn([steamRun({ path: '.github/workflows/sr-watch.yml' })]), false, 'a run that does not use Steam');
});

test('realIo.groupBusy: one read of the runs whatever their status; a read error is thrown, so reconcile starts nothing', async () => {
  const calls = [];
  const rows = [steamRun({ status: 'requested' }), steamRun({ status: 'completed', path: '.github/workflows/sr-watch.yml' })].map((r) => JSON.stringify(r)).join('\n');
  const io = realIo({ repo: 'o/r', owner: 'me', pollScript: 'x', run: (cmd, args) => { calls.push([cmd, ...args]); return rows; } });
  assert.equal(io.groupBusy(), true);
  assert.equal(calls.length, 1, 'a single gh call');
  assert.ok(!calls[0].join(' ').includes('status='), 'not asked per status');
  const idle = realIo({ repo: 'o/r', owner: 'me', pollScript: 'x', run: () => JSON.stringify(steamRun({ status: 'completed' })) });
  assert.equal(idle.groupBusy(), false);

  const f = fakeIo({ tags: [] });
  f.io.groupBusy = realIo({ repo: 'o/r', owner: 'me', pollScript: 'x', run: () => { throw new Error('502'); } }).groupBusy;
  await assert.rejects(go(f), /502/);
  assert.deepEqual(f.calls, [], 'nothing started or raised');
});
