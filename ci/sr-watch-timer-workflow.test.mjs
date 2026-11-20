// Tests for the fallback watch timer (.github/workflows/sr-watch-timer.yml).
//
//   node --test ci/sr-watch-timer-workflow.test.mjs
//
// Reads the workflow as text: it may start the watcher with no inputs and itself again, with only
// the job token, one chain at a time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wf = readFileSync(join(here, '..', '.github', 'workflows', 'sr-watch-timer.yml'), 'utf8').replace(/\r\n/g, '\n');
const code = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const step = (name) => {
  const start = code.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `step "${name}" exists`);
  const next = code.indexOf('\n      - name: ', start + 1);
  return next < 0 ? code.slice(start) : code.slice(start, next);
};
const dispatches = code.split('\n').filter((l) => /gh workflow run/.test(l));

test('triggers: a hand dispatch with no inputs, and a schedule every 3 hours at an odd minute', () => {
  assert.match(code, /on:\n {2}schedule:\n {4}- cron: '(\d+) \*\/3 \* \* \*'\n {2}workflow_dispatch:\n\n/);
  assert.equal(Number(/cron: '(\d+) /.exec(code)[1]) % 2, 1, 'odd minute');
  assert.ok(!/inputs:/.test(code), 'the timer takes no inputs');
});

test('permissions: nothing at the top, actions write and contents read on the job, no secret or personal token', () => {
  assert.match(code, /\npermissions: \{\}\n/);
  assert.match(code, /timeout-minutes: 35\n {4}permissions:\n {6}actions: write[^\n]*\n {6}contents: read\n {6}issues: write[^\n]*\n {4}env:/);
  assert.match(code, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.ok(!/secrets\./.test(code), 'no secrets');
  assert.ok(!/\bPAT\b/i.test(code), 'no personal token');
});

test('concurrency: its own group, never cancelling a run in progress', () => {
  assert.match(code, /concurrency:\n {2}group: sr-watch-timer\n {2}cancel-in-progress: false\n/);
});

test('the only dispatches are sr-watch.yml and sr-watch-timer.yml from main, with no inputs', () => {
  assert.equal(dispatches.length, 2);
  assert.ok(dispatches.some((l) => /gh workflow run sr-watch\.yml --ref main\)?; then$/.test(l.trim())), 'watcher dispatch');
  assert.ok(dispatches.some((l) => /gh workflow run sr-watch-timer\.yml --ref main\)?; then$/.test(l.trim())), 'self dispatch');
  for (const l of dispatches) assert.ok(!/\s(-f|-F|--field|--raw-field|--json)\b|force|rehearsal|supersede|retry/i.test(l), `no inputs: ${l.trim()}`);
  assert.ok(!/force|rehearsal|supersede|retry|inputs\./i.test(step('Start the watcher')), 'the watcher step never names an input');
});

test('revive guard: stops quietly when another timer run is going or waiting, counting only other runs', () => {
  const g = step('Stop if another timer run is going or waiting');
  assert.match(g, /workflows\/sr-watch-timer\.yml\/runs/);
  assert.match(g, /\.id != \$me/);
  assert.match(g, /--argjson me "\$GITHUB_RUN_ID"/);
  for (const s of ['in_progress', 'queued', 'waiting', 'pending']) assert.ok(g.includes(`"${s}"`), s);
  assert.match(g, /proceed=false/);
  for (const name of ['Wait for the next poll time', 'Start the watcher', 'Start the next timer run']) {
    assert.match(step(name), /if: steps\.guard\.outputs\.proceed == 'true'/, name);
  }
});

test('watcher dispatch: skipped when the watcher is going or waiting, 3 tries, then the job fails', () => {
  const s = step('Start the watcher');
  assert.match(s, /workflows\/sr-watch\.yml\/runs/);
  for (const st of ['in_progress', 'queued', 'waiting', 'pending']) assert.ok(s.includes(`"${st}"`), st);
  assert.match(s, /\[ "\$busy" -gt 0 \][\s\S]*exit 0/);
  assert.match(s, /for attempt in 1 2 3/);
  assert.match(s, /exit 1\n?$/);
});

test('self dispatch: continues the chain, 3 tries, then the job fails', () => {
  const s = step('Start the next timer run');
  assert.match(s, /gh workflow run sr-watch-timer\.yml --ref main/);
  assert.match(s, /for attempt in 1 2 3/);
  assert.match(s, /exit 1\n?$/);
});

test('timing: waits 25 minutes inside the 35-minute timeout, and every wait step sets a notice with the due time', () => {
  assert.match(step('Wait for the next poll time'), /::notice::Next sr-watch poll due \$\(date -u -d '\+25 minutes'[^)]*\) UTC"\n\s+sleep 1500\n?$/);
  assert.match(step('Start the next timer run'), /::notice::Next timer run started; its poll is due about \$\(date -u -d '\+25 minutes'/);
  assert.match(step('Start the watcher'), /::notice::Started sr-watch\.yml/);
});

test('alert: one tracking issue when no watcher run started for over an hour, closed on recovery, never blocks the chain', () => {
  const s = step('Report a watcher that has not started');
  assert.match(s, /continue-on-error: true/);
  assert.match(s, /title='SR watch is not running'/);
  assert.match(s, /workflows\/sr-watch\.yml\/runs\?per_page=1/);
  assert.match(s, /"\$age" -gt 3600/);
  assert.match(s, /select\(\.title == env\.TITLE\)/);
  assert.match(s, /if \[ -z "\$open" \]; then\n\s+gh label create[^\n]*\n\s+gh issue create/);
  assert.ok(s.match(/gh issue comment/g).length === 1 && /gh issue close/.test(s), 'comments only to close, once');
  assert.ok(code.indexOf('Report a watcher that has not started') < code.indexOf('Stop if another timer run'), 'runs first, even when the run stops as a duplicate');
});
