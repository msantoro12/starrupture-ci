#!/usr/bin/env node
// The decision of sr-mod-index-auto.yml: has the loader's mod index changed since the last signed publish, and may that
// workflow start the live publish (sr-mod-index.yml) for it. The workflow only gathers the inputs and acts on the
// verdict; everything that decides is here, so it can be tested.
//
//   node ci/mod-index-auto.mjs plan --index <index.json> --live <mod-index.v1.txt> --runs <runs.json> [--summary <file>] [--output <file>]
//
// The values the run gathered come in the environment, never in the command line, and are checked here:
//   LOADER_SHA                  the full commit id of the loader's main the index was read by (40 lowercase hex)
//   INDEX_STATE                 present | missing     whether mod-index/index.json exists at that commit
//   LIVE_STATE                  present | missing     whether the live vmap-feed release holds mod-index.v1.txt
//   MOD_INDEX_AUTO_PUBLISH      the repository variable; only the exact string `true` switches publishing on
//   DRY_RUN                     `false` only for a run that may dispatch; anything else, unset included, is a dry run
// --index, --live and --runs name files; a file is read only when its state says it exists. --runs is the answer of
// GET /repos/<repo>/actions/workflows/sr-mod-index.yml/runs.
//
// The verdict is one of
//   skip      nothing to do: the live index is the one on main, or main has no index yet
//   report    something to say and no dispatch: a difference while the switch is off, no live mod index to compare with
//             (the first live publish is by hand), a run already going, or two failed dispatched runs in a row
//   dispatch  start the live publish for exactly this commit
//   fail      the run goes red and nothing is dispatched: the index fails the signer's own checks, the live file cannot
//             be read, or an input is not what it must be
// Only `dispatch` ever leads to a write, and only when every check passed. --output receives `action=` and `sha=`, both
// from fixed sets (the sha only when it is 40 lowercase hex), and `stopped=true|false`: true while the two-failure stop holds,
// which the workflow turns into one alert issue. The summary is markdown with every text that came from the
// index or a downloaded file made printable ASCII without anything that makes a link, tag, emphasis or table cell.
// Exit codes: 0 skip, report or dispatch; 1 fail; 2 usage error or an unreadable input.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isMain } from './layout-diff.mjs';
import { bodyOf, buildModIndex, readIndex } from './mod-index.mjs';
import { md } from './mod-index-intake.mjs';

export const MAX_FAILURES = 2;
export const RUN_TITLE_PREFIX = 'SR mod index ';
const FULL_SHA = /^[0-9a-f]{40}$/;
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'stale']);
const MAX_LISTED = 30;

export class AutoError extends Error {}

// ---- the difference ----------------------------------------------------------------------------------------------

// One name per entry: its id when it has a unique non-empty string one, else its place in the list.
function names(list) {
  const seen = new Map();
  for (const e of list) if (typeof e?.id === 'string' && e.id !== '') seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
  return list.map((e, i) => (typeof e?.id === 'string' && e.id !== '' && seen.get(e.id) === 1 ? e.id : `#${i + 1}`));
}

const parseList = (text) => { try { const v = JSON.parse(text); return Array.isArray(v) ? v : null; } catch { return null; } };

// What differs between two index bodies, by entry name: { added, removed, changed: [{ id, keys }], before, after }.
// null when either is not a JSON array.
export function diffIndex(liveBody, newBody) {
  const a = parseList(liveBody);
  const b = parseList(newBody);
  if (!a || !b) return null;
  const an = names(a);
  const bn = names(b);
  const before = new Map(an.map((n, i) => [n, a[i]]));
  const after = new Map(bn.map((n, i) => [n, b[i]]));
  const added = bn.filter((n) => !before.has(n));
  const removed = an.filter((n) => !after.has(n));
  const changed = [];
  for (const [id, now] of after) {
    if (!before.has(id)) continue;
    const was = before.get(id);
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const keys = isObj(was) && isObj(now)
      ? [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]))
      : [];
    changed.push({ id, keys });
  }
  return { added, removed, changed, before: a.length, after: b.length };
}

const listed = (ids) => {
  const shown = ids.slice(0, MAX_LISTED).map((s) => `\`${md(s)}\``).join(', ');
  return ids.length > MAX_LISTED ? `${shown} and ${ids.length - MAX_LISTED} more` : shown;
};

export function renderDiff(diff) {
  if (!diff) return ['The two bodies could not be compared entry by entry (one is not a JSON array).'];
  const lines = [`Live: ${diff.before} entries. Loader main: ${diff.after} entries.`];
  if (diff.added.length) lines.push(`- added (${diff.added.length}): ${listed(diff.added)}`);
  if (diff.removed.length) lines.push(`- removed (${diff.removed.length}): ${listed(diff.removed)}`);
  if (diff.changed.length) {
    const rows = diff.changed.slice(0, MAX_LISTED).map((c) => `\`${md(c.id)}\`${c.keys.length ? ` (${c.keys.slice(0, 20).map((k) => md(k)).join(', ')})` : ''}`);
    lines.push(`- changed (${diff.changed.length}): ${rows.join(', ')}${diff.changed.length > MAX_LISTED ? ` and ${diff.changed.length - MAX_LISTED} more` : ''}`);
  }
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) lines.push('- the entries are the same; the bytes differ (order or formatting)');
  return lines;
}

// ---- the runs ----------------------------------------------------------------------------------------------------

// From the answer of the workflow's runs API: how many runs of sr-mod-index.yml are not finished, and how many
// dispatched runs in a row, newest first, ended without success. A dispatched run is one whose title carries a full
// commit id as its loader_ref (see run-name there), whatever the commit; the first success ends the count.
export function summariseRuns(json) {
  const runs = json?.workflow_runs;
  if (!Array.isArray(runs)) throw new AutoError('the runs list is not an answer of the workflow runs API');
  const titled = new RegExp(`^${RUN_TITLE_PREFIX}[0-9a-f]{40}$`);
  const newestFirst = (a, b) => (Date.parse(b?.created_at) || 0) - (Date.parse(a?.created_at) || 0);
  let inFlight = 0;
  let failures = 0;
  let counting = true;
  for (const r of [...runs].sort(newestFirst)) {
    if (r?.status !== 'completed') inFlight++;
    else if (counting && r.event === 'workflow_dispatch' && titled.test(r.display_title)) {
      if (FAILED.has(r.conclusion)) failures++;
      else if (r.conclusion === 'success') counting = false;
    }
  }
  return { inFlight, failures };
}

// ---- the decision ------------------------------------------------------------------------------------------------

// i: { sha, variable, dryRun, indexState, indexBody, liveState, liveBody, liveError, signerError, inFlight, failures }
// Returns { action: 'skip' | 'report' | 'dispatch' | 'fail', reason, detail, diff, stopped }; stopped is true only for the
// two-failure stop. reason is fixed text of this file;
// detail is text that came from the index or a downloaded file (an error message that names an entry) and is only ever
// shown cleaned. Fails closed: anything not named below as a reason to dispatch is not one, and only the last line
// returns `dispatch`.
export function decide(i) {
  const out = (action, reason, diff = null, detail = '', stopped = false) => ({ action, reason, detail, diff, stopped });
  if (typeof i?.sha !== 'string' || !FULL_SHA.test(i.sha)) return out('fail', 'the loader commit is not a full commit id');
  if (i.indexState !== 'present' && i.indexState !== 'missing') return out('fail', 'the state of the index on main is not known');
  if (i.indexState === 'missing') return out('skip', 'index not on main yet: the loader has no mod-index/index.json at that commit');
  if (i.liveState !== 'present' && i.liveState !== 'missing') return out('fail', 'the state of the live mod index is not known');
  if (i.liveState === 'missing') return out('report', 'no live mod index has been published yet; the first live publish is a manual decision, so nothing is dispatched');
  if (typeof i.indexBody !== 'string') return out('fail', 'the index on main could not be read', null, i.signerError ?? '');
  if (i.liveError) return out('fail', 'the live mod index could not be read', null, i.liveError);
  if (typeof i.liveBody !== 'string') return out('fail', 'the live mod index could not be read');
  if (i.liveBody === i.indexBody) return out('skip', 'up to date: the live mod index carries the index on main byte for byte');
  const diff = diffIndex(i.liveBody, i.indexBody);
  if (i.signerError) return out('fail', 'the index on main fails the signer checks', diff, i.signerError);
  if (i.dryRun === true) return out('report', 'dry run: nothing is dispatched', diff);
  if (i.variable !== 'true') return out('report', 'automatic publishing is off (the variable MOD_INDEX_AUTO_PUBLISH is not `true`): nothing is dispatched', diff);
  if (!Number.isInteger(i.inFlight) || !Number.isInteger(i.failures) || i.inFlight < 0 || i.failures < 0) return out('fail', 'the recent runs of sr-mod-index.yml could not be counted', diff);
  if (i.inFlight > 0) return out('report', `a run of sr-mod-index.yml is already queued or going (${i.inFlight}): nothing is dispatched`, diff);
  if (i.failures >= MAX_FAILURES) return out('report', `STOPPED: the last ${i.failures} dispatched runs failed; nothing more is dispatched until one succeeds. Look at those runs, or dispatch by hand once the cause is fixed`, diff, '', true);
  return out('dispatch', 'the index on main differs from the live one, passes the signer\'s checks, and no run is going: dispatching the live publish for this commit', diff);
}

const shown = (text) => md(String(text).slice(0, 300));

export function renderSummary(sha, verdict) {
  const lines = [`### Mod index auto publish: ${verdict.action}`, '', verdict.detail ? `${verdict.reason}: ${shown(verdict.detail)}` : verdict.reason];
  if (FULL_SHA.test(sha ?? '')) lines.push('', `Loader main read at \`${sha}\`.`);
  if (verdict.diff) lines.push('', ...renderDiff(verdict.diff));
  return `${lines.join('\n')}\n`;
}

// ---- the command -------------------------------------------------------------------------------------------------

function arg(a, name) {
  const at = a.indexOf(name);
  return at < 0 ? undefined : a[at + 1];
}

// Gathers the inputs of decide from the files and the environment named in the header.
export function readInputs(a, env) {
  const indexState = env.INDEX_STATE;
  const liveState = env.LIVE_STATE;
  const input = {
    sha: env.LOADER_SHA,
    variable: env.MOD_INDEX_AUTO_PUBLISH,
    dryRun: env.DRY_RUN !== 'false',
    indexState,
    liveState,
    signerError: null,
    liveError: null,
  };
  if (indexState === 'present') {
    try {
      input.indexBody = readIndex(arg(a, '--index'));
      buildModIndex(input.indexBody);
    } catch (e) { input.signerError = e.message; }
  }
  if (liveState === 'present') {
    try { input.liveBody = bodyOf(readFileSync(arg(a, '--live'), 'utf8')); } catch (e) { input.liveError = e.message; }
  }
  const runsFile = arg(a, '--runs');
  if (runsFile && existsSync(runsFile) && FULL_SHA.test(input.sha ?? '')) {
    const { inFlight, failures } = summariseRuns(JSON.parse(readFileSync(runsFile, 'utf8')));
    input.inFlight = inFlight;
    input.failures = failures;
  }
  return input;
}

export function main(argv, env = process.env) {
  const [cmd, ...a] = argv;
  if (cmd !== 'plan') throw new AutoError('usage: mod-index-auto.mjs plan --index <index.json> --live <mod-index.v1.txt> --runs <runs.json> [--summary <file>] [--output <file>]');
  const input = readInputs(a, env);
  const verdict = decide(input);
  const summary = renderSummary(input.sha, verdict);
  process.stdout.write(summary);
  const summaryFile = arg(a, '--summary');
  if (summaryFile) appendFileSync(summaryFile, `${summary}\n`);
  const outputFile = arg(a, '--output');
  if (outputFile) appendFileSync(outputFile, `action=${verdict.action}\nstopped=${verdict.stopped}\n${FULL_SHA.test(input.sha ?? '') ? `sha=${input.sha}\n` : ''}`);
  if (verdict.action === 'fail') process.stderr.write(`::error::${md(verdict.reason)}\n`);
  return verdict.action === 'fail' ? 1 : 0;
}

if (isMain(import.meta.url)) {
  new Promise((done) => done(main(process.argv.slice(2)))).then(
    (code) => { process.exitCode = code; },
    (e) => {
      process.stderr.write(`mod-index-auto: ${md(e.message)}\n`);
      process.exitCode = 2;
    },
  );
}
