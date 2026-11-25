// Tests for the automatic mod index publish (ci/mod-index-auto.mjs and .github/workflows/sr-mod-index-auto.yml): when the
// verdict is `dispatch` and when it never is, how the difference reads, what reaches the summary and the outputs, and
// what the workflow file can and cannot do.
//
//   node --test ci/mod-index-auto.test.mjs
//
// The workflow is read as text, the way ci/mod-index-workflow.test.mjs does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_FAILURES, decide, diffIndex, main, renderSummary, summariseRuns } from './mod-index-auto.mjs';
import { buildModIndex } from './mod-index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const SHA = 'a'.repeat(40);
const entry = (id, extra = {}) => ({ id, name: id, page_url: `https://github.com/AlienXAXS/StarRupture-Plugin-${id}`, ...extra });
const body = (list) => `${JSON.stringify(list, null, 2)}\n`;
const LIVE = body([entry('codex'), entry('waila')]);
const NEW = body([entry('codex'), entry('waila', { description: 'x' }), entry('minimap')]);

// Everything a dispatch needs; each test takes one thing away.
const ready = (over = {}) => ({ sha: SHA, variable: 'true', dryRun: false, indexState: 'present', indexBody: NEW, liveState: 'present', liveBody: LIVE, liveError: null, signerError: null, inFlight: 0, failures: 0, ...over });

// ---- decide -------------------------------------------------------------------------------------------------------

test('dispatch: the variable is true, the index differs, the checks pass, nothing is going, no failures', () => {
  const v = decide(ready());
  assert.equal(v.action, 'dispatch');
  assert.ok(v.diff && v.diff.added.length === 1);
});

test('the variable unset or anything but the exact string true never dispatches', () => {
  for (const variable of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', 'true\n', '1', 'yes', 'on', 'truee', 'null', true]) {
    const v = decide(ready({ variable }));
    assert.equal(v.action, 'report', `variable ${JSON.stringify(variable)}`);
    assert.ok(v.diff, 'it still reports the difference');
  }
});

test('a dry run never dispatches, whatever the variable says', () => {
  const v = decide(ready({ dryRun: true }));
  assert.equal(v.action, 'report');
  assert.match(v.reason, /dry run/);
  assert.equal(decide(ready({ dryRun: 'true' })).action, 'dispatch', 'only the boolean true is a dry run; the workflow passes one');
});

test('equal bodies: up to date, no dispatch', () => {
  const v = decide(ready({ indexBody: LIVE }));
  assert.equal(v.action, 'skip');
  assert.match(v.reason, /up to date/);
});

test('the live mod index is missing: report, never dispatch (the first live publish is by hand)', () => {
  for (const variable of ['true', undefined]) {
    const v = decide(ready({ variable, liveState: 'missing', liveBody: undefined }));
    assert.equal(v.action, 'report');
    assert.match(v.reason, /first live publish is a manual decision/);
  }
});

test('the index is missing on main: skip, never dispatch', () => {
  const v = decide(ready({ indexState: 'missing', indexBody: undefined }));
  assert.equal(v.action, 'skip');
  assert.match(v.reason, /index not on main yet/);
});

test('the signer\'s checks fail: fail, no dispatch, with the variable on', () => {
  const v = decide(ready({ signerError: 'entry 2 (waila): download_url must be https://github.com/...' }));
  assert.equal(v.action, 'fail');
  assert.match(v.detail, /download_url/);
  assert.equal(decide(ready({ signerError: 'x', variable: undefined })).action, 'fail', 'also with the switch off');
});

test('a run of the publish workflow is queued or going: no dispatch', () => {
  const v = decide(ready({ inFlight: 1 }));
  assert.equal(v.action, 'report');
  assert.match(v.reason, /already queued or going/);
});

test(`${MAX_FAILURES} failed runs in a row: no dispatch, a clear STOPPED line, stopped is set; one failure still retries`, () => {
  const one = decide(ready({ failures: MAX_FAILURES - 1 }));
  assert.equal(one.action, 'dispatch');
  assert.equal(one.stopped, false);
  for (const failures of [MAX_FAILURES, MAX_FAILURES + 5]) {
    const v = decide(ready({ failures }));
    assert.equal(v.action, 'report');
    assert.equal(v.stopped, true);
    assert.match(v.reason, /^STOPPED: /);
  }
});

test('stopped is set for the two-failure stop and for nothing else', () => {
  for (const over of [{}, { variable: 'no' }, { dryRun: true }, { indexState: 'missing' }, { liveState: 'missing' }, { indexBody: LIVE }, { signerError: 'x' }, { inFlight: 1 }, { sha: 'x' }]) {
    assert.equal(decide(ready(over)).stopped, false, JSON.stringify(over));
  }
  assert.equal(decide(ready({ variable: 'no', failures: MAX_FAILURES })).stopped, false, 'switch off: no stop, no alert');
  assert.equal(decide(ready({ dryRun: true, failures: MAX_FAILURES })).stopped, false, 'dry run: no alert');
});

test('fails closed on inputs that are not what they must be', () => {
  for (const sha of [undefined, '', 'main', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), `${SHA}\n`, `${'a'.repeat(39)};`]) assert.equal(decide(ready({ sha })).action, 'fail', `sha ${JSON.stringify(sha)}`);
  assert.equal(decide(ready({ indexState: 'maybe' })).action, 'fail');
  assert.equal(decide(ready({ indexState: undefined })).action, 'fail');
  assert.equal(decide(ready({ liveState: 'maybe' })).action, 'fail');
  assert.equal(decide(ready({ indexBody: undefined })).action, 'fail');
  assert.equal(decide(ready({ liveBody: undefined })).action, 'fail');
  assert.equal(decide(ready({ liveBody: undefined, liveError: 'the kind line is missing' })).action, 'fail');
  for (const inFlight of [undefined, -1, 1.5, '0', NaN]) assert.equal(decide(ready({ inFlight })).action, 'fail', `inFlight ${inFlight}`);
  for (const failures of [undefined, -1, '0']) assert.equal(decide(ready({ failures })).action, 'fail', `failures ${failures}`);
  assert.equal(decide(undefined).action, 'fail');
});

test('the dispatch verdict is reached only through the one path: every single missing condition ends it', () => {
  const broken = [{ variable: 'no' }, { dryRun: true }, { indexState: 'missing' }, { liveState: 'missing' }, { indexBody: LIVE }, { signerError: 'x' }, { inFlight: 1 }, { failures: MAX_FAILURES }, { sha: 'x' }];
  for (const b of broken) assert.notEqual(decide(ready(b)).action, 'dispatch', JSON.stringify(b));
});

// ---- the difference -----------------------------------------------------------------------------------------------

test('diffIndex lists added, removed and changed entries by id, with the keys that changed and the counts', () => {
  const live = body([entry('a'), entry('b'), entry('c', { version: '1', note: 'x' })]);
  const next = body([entry('a'), entry('d'), entry('c', { version: '2', extra: true })]);
  assert.deepEqual(diffIndex(live, next), { added: ['d'], removed: ['b'], changed: [{ id: 'c', keys: ['version', 'note', 'extra'] }], before: 3, after: 3 });
});

test('diffIndex: entries without a usable id are named by place; equal entries in another order are not a change', () => {
  const live = body([{ name: 'x' }, entry('a'), entry('b')]);
  const next = body([{ name: 'y' }, entry('b'), entry('a')]);
  assert.deepEqual(diffIndex(live, next), { added: [], removed: [], changed: [{ id: '#1', keys: ['name'] }], before: 3, after: 3 });
  const dup = diffIndex(body([entry('a'), entry('a')]), body([entry('a')]));
  assert.deepEqual(dup.added, ['a'], 'a duplicated id is not trusted as a name');
  assert.equal(diffIndex('not json', NEW), null);
  assert.equal(diffIndex('{}\n', NEW), null);
});

test('the summary lists the difference and caps long lists', () => {
  const many = Array.from({ length: 45 }, (_, i) => entry(`m${i}`));
  const text = renderSummary(SHA, decide(ready({ liveBody: body([]), indexBody: body(many) })));
  assert.match(text, /^### Mod index auto publish: dispatch\n/);
  assert.match(text, /Live: 0 entries\. Loader main: 45 entries\./);
  assert.match(text, /- added \(45\): `m0`, /);
  assert.match(text, / and 15 more/);
  const mixed = renderSummary(SHA, decide(ready()));
  assert.match(mixed, /- added \(1\): `minimap`/);
  assert.match(mixed, /- changed \(1\): `waila` \(description\)/);
  assert.ok(!/- removed/.test(mixed));
});

// ---- the runs -----------------------------------------------------------------------------------------------------

test('summariseRuns counts runs going, and the failed dispatched runs in a row, newest first, whatever the commit', () => {
  const other = 'b'.repeat(40);
  let n = 100;
  const run = (o) => ({ status: 'completed', conclusion: 'success', event: 'workflow_dispatch', display_title: `SR mod index ${SHA}`, created_at: new Date(Date.UTC(2026, 10, 1, 0, n--)).toISOString(), ...o });
  const summarise = (runs) => summariseRuns({ workflow_runs: runs });
  // Newest first. Two failures for two different commits are two failures in a row.
  assert.deepEqual(summarise([run({ conclusion: 'failure' }), run({ conclusion: 'cancelled', display_title: `SR mod index ${other}` })]), { inFlight: 0, failures: 2 });
  // A success ends the count; older failures do not count.
  assert.deepEqual(summarise([run({ conclusion: 'failure' }), run({ conclusion: 'success', display_title: `SR mod index ${other}` }), run({ conclusion: 'failure' }), run({ conclusion: 'failure' })]), { inFlight: 0, failures: 1 });
  // Not dispatched runs, other titles, skipped runs: ignored. Runs going are counted apart.
  assert.deepEqual(summarise([
    run({ status: 'in_progress', conclusion: null }),
    run({ status: 'queued', conclusion: null, display_title: 'SR mod index main' }),
    run({ conclusion: 'failure', display_title: 'SR mod index main' }),
    run({ conclusion: 'failure', event: 'workflow_call' }),
    run({ conclusion: 'failure', display_title: `SR mod index ${SHA} ` }),
    run({ conclusion: 'skipped' }),
    run({ conclusion: 'timed_out' }),
  ]), { inFlight: 2, failures: 1 });
  // The order of the answer does not matter: the newest run decides.
  assert.deepEqual(summarise([run({ conclusion: 'failure' }), run({ conclusion: 'failure' }), run({ conclusion: 'success' })].reverse()), { inFlight: 0, failures: 2 });
  assert.throws(() => summariseRuns({}), /runs list/);
  assert.throws(() => summariseRuns(null), /runs list/);
});

// ---- the command --------------------------------------------------------------------------------------------------

function plan(files, env, run = (e) => e) {
  const dir = mkdtempSync(join(tmpdir(), 'mia-'));
  try {
    const path = (name) => join(dir, name);
    const args = ['plan', '--index', path('index.json'), '--live', path('live.txt'), '--runs', path('runs.json'), '--summary', path('summary.md'), '--output', path('out.txt')];
    for (const [name, text] of Object.entries(files)) writeFileSync(path(name), text);
    const stdout = [];
    const write = process.stdout.write;
    const err = process.stderr.write;
    let stderr = '';
    process.stdout.write = (s) => { stdout.push(s); return true; };
    process.stderr.write = (s) => { stderr += s; return true; };
    let code;
    try { code = main(args, run(env)); } finally { process.stdout.write = write; process.stderr.write = err; }
    return { code, stderr, summary: existsSync(path('summary.md')) ? readFileSync(path('summary.md'), 'utf8') : '', out: existsSync(path('out.txt')) ? readFileSync(path('out.txt'), 'utf8') : '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const env = (over = {}) => ({ LOADER_SHA: SHA, INDEX_STATE: 'present', LIVE_STATE: 'present', MOD_INDEX_AUTO_PUBLISH: 'true', DRY_RUN: 'false', ...over });
const signed = (b) => `${buildModIndex(b).replace(/^(format\t1\n)/, '$1seq\t3\n')}sig\tk2\tAAAA\n`;
const noRuns = JSON.stringify({ workflow_runs: [] });

test('command: a difference with the switch on writes action=dispatch and the sha, exit 0', () => {
  const r = plan({ 'index.json': NEW, 'live.txt': signed(LIVE), 'runs.json': noRuns }, env());
  assert.equal(r.code, 0);
  assert.equal(r.out, `action=dispatch\nstopped=false\nsha=${SHA}\n`);
  assert.match(r.summary, /Mod index auto publish: dispatch/);
  assert.match(r.summary, /added \(1\): `minimap`/);
});

test('command: the switch off or unset writes action=report', () => {
  for (const v of [undefined, '', 'false', 'TRUE']) {
    const r = plan({ 'index.json': NEW, 'live.txt': signed(LIVE), 'runs.json': noRuns }, env({ MOD_INDEX_AUTO_PUBLISH: v }));
    assert.equal(r.code, 0, `variable ${v}`);
    assert.equal(r.out, `action=report\nstopped=false\nsha=${SHA}\n`);
  }
});

test('command: equal, missing live, missing index and a dry run write no dispatch', () => {
  assert.match(plan({ 'index.json': LIVE, 'live.txt': signed(LIVE), 'runs.json': noRuns }, env()).out, /^action=skip\n/);
  assert.match(plan({ 'index.json': NEW, 'runs.json': noRuns }, env({ LIVE_STATE: 'missing' })).out, /^action=report\n/);
  assert.match(plan({ 'live.txt': signed(LIVE), 'runs.json': noRuns }, env({ INDEX_STATE: 'missing' })).out, /^action=skip\n/);
  assert.match(plan({ 'index.json': NEW, 'live.txt': signed(LIVE), 'runs.json': noRuns }, env({ DRY_RUN: 'true' })).out, /^action=report\n/);
});

test('command: a run going or two failures in a row write action=report, the failures stopped=true', () => {
  const t = `SR mod index ${SHA}`;
  const going = JSON.stringify({ workflow_runs: [{ status: 'queued', event: 'workflow_dispatch', display_title: t }] });
  const failed = JSON.stringify({ workflow_runs: [SHA, 'c'.repeat(40)].map((sha) => ({ status: 'completed', conclusion: 'failure', event: 'workflow_dispatch', display_title: `SR mod index ${sha}` })) });
  assert.match(plan({ 'index.json': NEW, 'live.txt': signed(LIVE), 'runs.json': going }, env()).out, /^action=report\n/);
  const r = plan({ 'index.json': NEW, 'live.txt': signed(LIVE), 'runs.json': failed }, env());
  assert.match(r.out, /^action=report\nstopped=true\n/);
  assert.match(r.summary, /STOPPED: the last 2 dispatched runs/);
  const dispatched = (conclusion, sha) => ({ status: 'completed', conclusion, event: 'workflow_dispatch', display_title: `SR mod index ${sha}` });
  const recovered = JSON.stringify({ workflow_runs: [dispatched('failure', SHA), dispatched('success', 'c'.repeat(40)), dispatched('failure', SHA)] });
  assert.match(plan({ 'index.json': NEW, 'live.txt': signed(LIVE), 'runs.json': recovered }, env()).out, /^action=dispatch\nstopped=false\n/);
});

test('command: only the exact string false lets a run dispatch; unset, empty and other values are a dry run', () => {
  const files = { 'index.json': NEW, 'live.txt': signed(LIVE), 'runs.json': noRuns };
  for (const DRY_RUN of [undefined, '', 'TRUE', 'no', 'true']) assert.match(plan(files, env({ DRY_RUN })).out, /^action=report\n/, `DRY_RUN ${DRY_RUN}`);
  assert.match(plan(files, env({ DRY_RUN: 'false' })).out, /^action=dispatch\n/);
});

test('command: an index the signer refuses exits 1 with action=fail; a bad runs file or live file never dispatches', () => {
  const bad = body([entry('x', { download_url: 'https://evil.example/x.dll', download_sha256: 'a'.repeat(64), download_size: 5 })]);
  const r = plan({ 'index.json': bad, 'live.txt': signed(LIVE), 'runs.json': noRuns }, env());
  assert.equal(r.code, 1);
  assert.match(r.out, /^action=fail\n/);
  assert.match(r.stderr, /^::error::the index on main fails the signer/);
  const notIndex = plan({ 'index.json': '﻿[]\n', 'live.txt': signed(LIVE), 'runs.json': noRuns }, env());
  assert.equal(notIndex.code, 1, 'a byte order mark is a failure, not a crash');
  const garbled = plan({ 'index.json': NEW, 'live.txt': 'nonsense', 'runs.json': noRuns }, env());
  assert.equal(garbled.code, 1);
  assert.match(garbled.out, /^action=fail\n/);
  assert.throws(() => plan({ 'index.json': NEW, 'live.txt': signed(LIVE), 'runs.json': '{' }, env()), /JSON/);
});

test('command: an unusable loader commit writes no sha output, and a hostile value stays out of the output file', () => {
  const r = plan({ 'index.json': NEW, 'live.txt': signed(LIVE), 'runs.json': noRuns }, env({ LOADER_SHA: `${SHA}\naction=dispatch` }));
  assert.equal(r.code, 1);
  assert.equal(r.out, 'action=fail\nstopped=false\n');
});

test('command: text that came from the index cannot make markdown or a workflow command in the summary or the error line', () => {
  const evil = '[x](https://evil.example)![i](u)<script>\n::set-output name=action::dispatch\n| a | b |';
  const bad = body([entry(evil, { download_url: 'https://evil.example/x.dll' })]);
  const r = plan({ 'index.json': bad, 'live.txt': signed(LIVE), 'runs.json': noRuns }, env());
  assert.equal(r.code, 1);
  for (const text of [r.summary, r.stderr]) {
    assert.ok(!/\[x\]\(|<script>|!\[|\n::set-output/.test(text));
    assert.ok(text.split('\n').every((l) => !l.startsWith('::') || l.startsWith('::error::')), 'only our own workflow command line');
  }
  const names = body([entry('ok'), entry(evil), entry('`a`')]);
  const listedText = plan({ 'index.json': names, 'live.txt': signed(LIVE), 'runs.json': noRuns }, env({ MOD_INDEX_AUTO_PUBLISH: 'no' })).summary;
  assert.ok(!/\[x\]\(|<script>|!\[|\n::set-output|\n\| a/.test(listedText));
  assert.equal(r.out.includes('set-output'), false);
});

// ---- the workflow file --------------------------------------------------------------------------------------------

const wf = read('.github', 'workflows', 'sr-mod-index-auto.yml');
const publishWf = read('.github', 'workflows', 'sr-mod-index.yml');
const code = (text) => text.replace(/^ *#.*\n/gm, '');
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const jobText = (name) => {
  const at = wf.indexOf(`\n  ${name}:\n`);
  assert.ok(at > 0, `job ${name} exists`);
  const next = wf.slice(at + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? wf.slice(at) : wf.slice(at, at + 1 + next);
};
const planJob = jobText('plan');
const dispatchJob = jobText('dispatch');
const alertJob = jobText('alert');
const stepOf = (job, name) => {
  const at = job.indexOf(`- name: ${name}\n`);
  assert.ok(at > 0, `step "${name}" exists`);
  const next = job.indexOf('\n      - ', at + 1);
  return job.slice(at, next < 0 ? undefined : next);
};

test('triggers: a 30 minute schedule and a hand dispatch with a dry_run input; no pull_request, push or workflow_run', () => {
  const on = section(wf, '\non:\n', '\nconcurrency:');
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ['schedule', 'workflow_dispatch']);
  assert.match(on, /cron: '\d+,\d+ \* \* \* \*'/, 'twice an hour');
  const [a, b] = on.match(/cron: '(\d+),(\d+) /).slice(1).map(Number);
  assert.equal(b - a, 30);
  assert.match(on, /\n {6}dry_run:\n(?:.*\n)*?\s+type: boolean\n\s+default: false\n/);
  assert.ok(!/pull_request|push:|workflow_run|workflow_call|repository_dispatch/.test(code(wf)));
});

test('one run at a time, never cancelled; main only', () => {
  assert.match(wf, /\nconcurrency:\n {2}group: sr-mod-index-auto\n {2}cancel-in-progress: false\n/);
  assert.ok(planJob.includes("if: ${{ github.ref == 'refs/heads/main' }}"));
  assert.ok(dispatchJob.includes("github.ref == 'refs/heads/main'"));
});

test('permissions: none by default; the plan job reads, the dispatch job can start workflows, the alert job can write issues, each nothing else', () => {
  assert.match(wf, /\npermissions: \{\}\n/);
  assert.match(planJob, /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n {4}[a-z]/);
  assert.match(dispatchJob, /\n {4}permissions:\n {6}actions: write\n {4}[a-z]/);
  assert.match(alertJob, /\n {4}permissions:\n {6}issues: write\n {4}[a-z]/);
  assert.equal([...wf.matchAll(/^ +[a-z-]+: (read|write)$/gm)].length, 4, 'four permission lines in all');
  assert.ok(!/(contents|pull-requests|id-token|packages|deployments): write/.test(wf));
  assert.ok(!/issues: write/.test(planJob + dispatchJob));
});

test('the alert: one issue per stop, only on the stop verdict with the switch on, none while one is open, no dispatch', () => {
  assert.ok(planJob.includes('stopped: ${{ steps.decide.outputs.stopped }}'));
  assert.ok(alertJob.includes("needs.plan.outputs.stopped == 'true'"));
  assert.ok(alertJob.includes("vars.MOD_INDEX_AUTO_PUBLISH == 'true'") && alertJob.includes('inputs.dry_run != true') && alertJob.includes("github.ref == 'refs/heads/main'"));
  const step = stepOf(alertJob, 'Raise one alert for the stop');
  assert.ok(step.includes('gh issue list --state open') && step.indexOf('gh issue list') < step.indexOf('pipeline-alert.mjs raise'), 'looks for an open issue first');
  assert.match(step, /if \[ -n "\$open" \]; then [^\n]*exit 0; fi\n/);
  assert.match(step, /node ci\/pipeline-alert\.mjs raise --title "\$TITLE" --body-file "\$RUNNER_TEMP\/stopped\.md" --owner "\$OWNER"\n/);
  assert.ok(!/gh workflow run|secrets\./.test(alertJob));
});

test('the keepalive workflow keeps the schedule of this workflow enabled', () => {
  assert.match(read('.github', 'workflows', 'sr-keepalive.yml'), /for wf in [^\n]*\bsr-mod-index-auto\.yml\b[^\n]*; do\n/);
});

test('no secret, no environment, no key: the signing happens in the dispatched run only', () => {
  assert.ok(!/secrets\./.test(code(wf)), 'no secret is read');
  assert.ok(!/\n +environment:/.test(code(wf)), 'it never enters the vmap-sign environment');
  assert.ok(!/VMAP_SIGN_KEY|vmap-sign\.mjs|plugin-catalog-publish\.sh/.test(code(wf)));
  assert.ok(!/\bgh release (create|upload|edit|delete)|gh api[^\n]*(-X|--method) *(POST|PUT|PATCH|DELETE)/i.test(code(wf)), 'it writes nothing but the dispatch');
});

test('the dispatch is gated on the variable twice, on the verdict, a dry run and main; no other job dispatches', () => {
  assert.ok(dispatchJob.includes("needs.plan.outputs.action == 'dispatch'"));
  assert.ok(dispatchJob.includes("vars.MOD_INDEX_AUTO_PUBLISH == 'true'"), 'compared as an exact string');
  assert.ok(dispatchJob.includes('inputs.dry_run != true'));
  assert.equal([...code(wf).matchAll(/gh workflow run/g)].length, 1, 'one dispatch command in the file');
  assert.ok(!/gh workflow run/.test(code(planJob)));
  assert.ok(dispatchJob.includes('gh workflow run'));
});

test('the dispatch is live=true with the exact commit pinned, to main, after a 40-hex check, with nothing else in the job', () => {
  const step = stepOf(dispatchJob, 'Start the live publish for that commit');
  assert.ok(step.includes('[[ "$LOADER_SHA" =~ ^[0-9a-f]{40}$ ]]') && step.indexOf('=~') < step.indexOf('gh workflow run'), 'checked before use');
  assert.match(step, /gh workflow run sr-mod-index\.yml --repo "\$GH_REPO" --ref main -f live=true -f "loader_ref=\$LOADER_SHA"\n/);
  assert.ok(!/loader_ref=main|loader_ref=release/.test(wf), 'never a branch name');
  assert.ok(dispatchJob.includes('LOADER_SHA: ${{ needs.plan.outputs.sha }}'));
  assert.ok(!/actions\/checkout/.test(dispatchJob), 'the dispatch job checks out nothing');
  assert.equal([...dispatchJob.matchAll(/\n {6}- name:/g)].length, 1, 'one step');
});

test('the plan job reads the loader by commit id, never runs loader code, and passes nothing of the index through a shell', () => {
  assert.ok(stepOf(planJob, 'Resolve the loader\'s main').includes('node ci/mod-index.mjs loader-ref main'));
  const idx = stepOf(planJob, 'Read the loader\'s mod index');
  assert.ok(idx.includes('contents/mod-index/index.json?ref=$LOADER_SHA'), 'by sha, not branch');
  assert.ok(idx.includes('[[ "$LOADER_SHA" =~ ^[0-9a-f]{40}$ ]]') && idx.includes('grep -q \'HTTP 404\''));
  assert.ok(!/build-mod-index/.test(code(planJob)), 'the loader\'s builder is not run here');
  assert.ok(!/(^|\s)(source|eval|bash|sh) [^\n]*index\.json|\$\(cat index|cat index\.json|\$\(< *index/.test(planJob), 'index.json is only read by the script');
  assert.ok(!/\$\{\{ *(steps|needs)\.[a-z]+\.outputs[^}]*\}\}/.test(section(planJob, '      - name: Decide', '\n  dispatch') .replace(/ {10}[A-Z_]+: \$\{\{[^}]*\}\}\n/g, '')), 'no step output is interpolated into a script body');
  const live = stepOf(planJob, 'Read the live mod index');
  assert.ok(live.includes('gh release view vmap-feed') && live.includes('release not found') && live.includes('grep -qxF mod-index.v1.txt'));
});

test('the decide step: the variable and every gathered value come in as environment values and the script decides', () => {
  const step = stepOf(planJob, 'Decide');
  assert.ok(step.includes('MOD_INDEX_AUTO_PUBLISH: ${{ vars.MOD_INDEX_AUTO_PUBLISH }}'));
  assert.ok(step.includes('DRY_RUN: ${{ inputs.dry_run == true }}'));
  const script = step.slice(step.indexOf('run: |'));
  assert.ok(!/\$\{\{/.test(script), 'no expression inside the script text');
  assert.match(script, /node ci\/mod-index-auto\.mjs plan --index index\.json --live live\/mod-index\.v1\.txt --runs runs\.json --summary "\$GITHUB_STEP_SUMMARY" --output "\$GITHUB_OUTPUT"/);
  assert.ok(planJob.includes('action: ${{ steps.decide.outputs.action }}') && planJob.includes('sha: ${{ steps.decide.outputs.sha }}'));
});

test('actions are pinned and credentials are not kept', () => {
  for (const use of wf.matchAll(/uses: (\S+)/g)) assert.match(use[1], /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, use[1]);
  assert.match(planJob, /persist-credentials: false/);
});

test('the publish workflow titles its runs by loader_ref, which the failure count reads; live is still read once', () => {
  assert.match(publishWf, /\nrun-name: SR mod index \$\{\{ inputs\.loader_ref \}\}\n/);
  assert.equal((publishWf.match(/inputs\.live/g) ?? []).length, 1);
  assert.ok(wf.includes('actions/workflows/sr-mod-index.yml/runs'));
});

test('the new test file runs in the node tests workflow', () => {
  assert.ok(read('.github', 'workflows', 'sr-node-tests.yml').includes('ci/mod-index-auto.test.mjs'));
});
