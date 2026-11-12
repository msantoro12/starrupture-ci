// Tests for ci/pipeline-alert.mjs, from the real job logs and annotations of live run 1
// (run 42393906454: push-loader failed on the missing deploy key, the compile check's loader jobs on a
// bash step run by pwsh).
//
//   node --test ci/pipeline-alert.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRACT_JOB_NAME, causeText, collectCauses, firstAnnotationError, firstLogError, inClientCheck, jobError, outsideBody, raise } from './pipeline-alert.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, 'fixtures', 'live-run-1', n), 'utf8');
const DEPLOY_KEY = /^the secret SR_DEPLOYKEY_MODLOADER is not set in the environment fork-push of msantoro12\/starrupture-ci/;
const watchWf = readFileSync(join(here, '..', '.github', 'workflows', 'sr-watch.yml'), 'utf8').replace(/\r\n/g, '\n');

test('error line: the first real ##[error] of the job log, from the live push-loader log', () => {
  assert.match(firstLogError(fx('push-loader.log')), DEPLOY_KEY);
  // Only the runner's exit line (the pwsh ParserError is not an ##[error] line): that line, not nothing.
  assert.equal(firstLogError(fx('loader-server.log')), 'Process completed with exit code 1.');
  assert.equal(firstLogError(''), '');
  assert.equal(firstLogError('﻿2026-11-07T17:19:42.5Z ##[error]first\r\n2026-11-07T17:19:42.6Z ##[error]second\r\n'), 'first');
});

test('error line: the failure annotations, from the live push-loader job', () => {
  assert.match(firstAnnotationError(JSON.parse(fx('push-loader.annotations.json'))), DEPLOY_KEY);
  assert.equal(firstAnnotationError(JSON.parse(fx('loader-server.annotations.json'))), '', 'only the exit-code line');
  assert.equal(firstAnnotationError(null), '');
  assert.match(jobError(JSON.parse(fx('push-loader.annotations.json')), ''), DEPLOY_KEY);
  assert.equal(jobError(JSON.parse(fx('loader-server.annotations.json')), fx('loader-server.log')), 'Process completed with exit code 1.');
});

// A fake gh: answers by path; `logs` is a list of answers for the log, one per try (null: the call fails).
const fakeGh = ({ jobs, annotations = {}, logs = {} }) => {
  const calls = [];
  const tries = {};
  const call = (args) => {
    calls.push(args.join(' '));
    const p = args[1];
    if (/\/jobs\?per_page=100$/.test(p)) return jobs.map((j) => JSON.stringify(j)).join('\n') + '\n';
    let m = /check-runs\/(\d+)\/annotations$/.exec(p);
    if (m) return annotations[m[1]] ?? null;
    m = /actions\/jobs\/(\d+)\/logs$/.exec(p);
    if (m) { const i = tries[m[1]] = (tries[m[1]] ?? 0) + 1; return (logs[m[1]] ?? [])[i - 1] ?? null; }
    return null;
  };
  return { call, calls };
};
const LIVE_JOBS = [
  { id: 128467144285, name: 'build-all / loader-server', step: 'Check the loader repository' },
  { id: 128472624358, name: 'client-check (public_test_branch) / push the map rows to the loader fork', step: 'Check the deploy key' },
];

test('live run 1: the cause line carries the step and its first error line even while the job log is not there yet', async () => {
  // The alert ran 8 s after push-loader ended and its log fetch came back empty, so the issue said only the step.
  // The annotations exist as soon as the step emits ::error, so the error line no longer waits on the log.
  const gh = fakeGh({ jobs: LIVE_JOBS, annotations: { 128472624358: fx('push-loader.annotations.json'), 128467144285: fx('loader-server.annotations.json') }, logs: { 128467144285: [null, fx('loader-server.log')] } });
  const jobs = await collectCauses({ repo: 'msantoro12/starrupture-ci', run: '42393906454', wait: 0, call: gh.call });
  const push = jobs.find((j) => j.id === 128472624358);
  assert.match(causeText(push), /^step "Check the deploy key": the secret SR_DEPLOYKEY_MODLOADER is not set in the environment fork-push/);
  assert.ok(!gh.calls.some((c) => c.includes('jobs/128472624358/logs')), 'the annotation was enough');
  // The loader job: no annotation but the exit line, so the log is read, again after a failed try.
  assert.equal(jobs[0].error, 'Process completed with exit code 1.');
  assert.equal(gh.calls.filter((c) => c.includes('jobs/128467144285/logs')).length, 2);
});

test('causes: a log that never comes is tried --tries times, and leaves the cause at the step', async () => {
  const gh = fakeGh({ jobs: [LIVE_JOBS[0]] });
  const [j] = await collectCauses({ repo: 'o/r', run: '1', tries: 3, wait: 0, call: gh.call });
  assert.equal(gh.calls.filter((c) => c.includes('/logs')).length, 3);
  assert.equal(j.error, '');
  assert.equal(causeText(j), 'step "Check the loader repository"');
  assert.deepEqual(await collectCauses({ repo: 'o/r', run: '1', wait: 0, call: () => null }), [], 'no job list, no causes');
});

test('outside: the compile check failure is an alert line with its cause; the client check jobs are left to its own alert', () => {
  const jobs = [{ ...LIVE_JOBS[0], error: 'ParserError: unexpected token' }, { id: 2, name: 'build-all / loader-client', step: 'Check the loader repository', error: '' }, { ...LIVE_JOBS[1], error: 'x' }];
  const md = outsideBody(jobs, { owner: 'msantoro12', runUrl: 'https://github.com/o/r/actions/runs/1' });
  assert.match(md, /^@msantoro12 \[run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)/);
  assert.match(md, /- job \*\*build-all \/ loader-server\*\* failed\n  - cause: step "Check the loader repository": ParserError: unexpected token\n/);
  assert.match(md, /- job \*\*build-all \/ loader-client\*\* failed\n  - cause: step "Check the loader repository"\n/);
  assert.ok(!md.includes('push the map rows'));
  assert.equal(outsideBody([LIVE_JOBS[1]], { owner: 'o', runUrl: 'u' }), null);
  assert.equal(outsideBody([], { owner: 'o', runUrl: 'u' }), null);
  assert.ok(inClientCheck('client-check (public) / alert') && !inClientCheck('build-all / loader-client') && !inClientCheck('poll'));
});

test('raise: opens the issue labelled and assigned, or comments on the open one with that exact title', () => {
  const calls = [];
  raise({ title: 'SR map mode: public needs attention', bodyFile: 'a.md', owner: 'msantoro12', call: (a) => { calls.push(a.join(' ')); return ''; } });
  assert.ok(calls.includes('issue create --title SR map mode: public needs attention --body-file a.md --label pipeline-alert --assignee msantoro12'), calls.join('\n'));
  assert.ok(calls[0].startsWith('label create pipeline-alert'));
  const again = [];
  assert.equal(raise({ title: 'T', bodyFile: 'a.md', owner: 'o', call: (a) => { again.push(a.join(' ')); return a[1] === 'list' ? '39\n' : ''; } }), 39);
  assert.ok(again.includes('issue comment 39 --body-file a.md') && again.includes('issue edit 39 --add-label pipeline-alert --add-assignee o'));
  assert.ok(!again.some((c) => c.startsWith('issue create')));
  assert.ok(again.some((c) => c.includes("select(.title == env.TITLE)")) && process.env.TITLE === 'T');
});

test('sr-watch: a failed poll or compile check reaches the alert issue of each changed client branch, with its cause', () => {
  const a = watchWf.slice(watchWf.indexOf('\n  alert:\n'));
  assert.match(a, /needs: \[poll, build\]/);
  assert.match(a, /if: \$\{\{ always\(\) && \(needs\.poll\.result == 'failure' \|\| needs\.build\.result == 'failure'\) \}\}/);
  assert.match(a, /permissions:\n\s+contents: read\n\s+issues: write\n\s+actions: read.*\n\s+checks: read/);
  assert.ok(a.includes('node ci/pipeline-alert.mjs causes --repo "$GH_REPO" --run "$RUN_ID" --out failed-jobs.jsonl'));
  assert.ok(a.includes('node ci/pipeline-alert.mjs outside --causes failed-jobs.jsonl'));
  // The same title as the client check's alert, so it is the same issue.
  assert.ok(a.includes('node ci/pipeline-alert.mjs raise --title "SR map mode: $b needs attention" --body-file alert.md --owner "$OWNER"'));
  assert.ok(a.includes('MATRIX: ${{ needs.poll.outputs.client_matrix }}'));
});

test('causes: the planner data extract job, which cannot fail the run, is not a cause; the other failed jobs are', async () => {
  const gh = fakeGh({ jobs: [LIVE_JOBS[0], { id: 7, name: EXTRACT_JOB_NAME, step: 'Start the extract' }, LIVE_JOBS[1]] });
  const jobs = await collectCauses({ repo: 'o/r', run: '1', tries: 1, wait: 0, call: gh.call });
  assert.deepEqual(jobs.map((j) => j.id), [LIVE_JOBS[0].id, LIVE_JOBS[1].id]);
  assert.ok(!gh.calls.some((c) => c.includes('/7/') || c.includes('jobs/7/')), 'nothing is read for it');
  const same = await collectCauses({ repo: 'o/r', run: '1', tries: 1, wait: 0, call: fakeGh({ jobs: LIVE_JOBS }).call });
  assert.deepEqual(same.map((j) => j.id), LIVE_JOBS.map((j) => j.id), 'an alert with only real causes is unchanged');
});

test('sr-watch: the extract job is named EXTRACT_JOB_NAME and cannot fail the run', () => {
  const j = watchWf.slice(watchWf.indexOf('\n  planner-extract:\n'));
  assert.ok(j.startsWith(`\n  planner-extract:\n    name: ${EXTRACT_JOB_NAME}\n`), 'the job name is the constant');
  assert.match(j.slice(0, j.indexOf('\n    steps:')), /\n    continue-on-error: true\n/);
});
