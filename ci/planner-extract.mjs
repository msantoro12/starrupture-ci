#!/usr/bin/env node
// Starts the planner data extract (sr-data-extract.yml) for the builds that need one.
//
//   node ci/planner-extract.mjs --repo <owner/name> --branches <a,b> --owner <login> \
//        [--pin-file ci/data/extractor-ref.txt] [--poll-script .github/sr-pipeline/poll-steam.mjs] [--dry-run]
//
// For each Steam branch it reads the branch's current build id, decides with decide() whether that
// build needs an extract, and dispatches at most ONE extract per run, from main. The same code serves
// the watcher after its update chain and on every poll, so the rules live here and nowhere else.
//
// A build needs an extract when all of these hold (the first one that does not ends the decision):
//   - the planner repository has no tag srdata-<branch>-<buildid> and no srdata-failed-<branch>-<buildid>
//     (published, verified unchanged, or handled by the planner's own gate);
//   - starrupture-ci holds no successful artifact sr-data-<branch>-<buildid>;
//   - no extract run for that branch and build is queued or going.
// Then, in this order:
//   - two or more failed runs for the build: raise the alert issue once and stop trying;
//   - something that uses the Steam session (the client check, the client rig, an extract) is queued or
//     going: wait for a later run, so nothing already waiting for the session is ever replaced;
//   - the last failed run for the build ended less than 6 hours ago: wait.
//
// Runs of one build are told apart by their title: sr-data-extract.yml names a dispatched run
// "SR data extract <branch> <buildid>".
//
// The cancel command (node ci/planner-extract.mjs cancel --repo <owner/name> [--wait-seconds N]) is for
// the watcher's poll, when a build change starts the update chain: an extract that is queued or going
// would hold the Steam session and the sr-client-rig group the chain needs, so every such extract run
// is cancelled and the command waits (bounded) until they have ended. It never fails: a cancel that is
// refused, a listing that cannot be read or a run that will not end is a warning, and the chain goes on.
// A cancelled run is neither a failure nor a reason to wait: the next reconcile starts the build again.
//
// --dry-run prints each decision and changes nothing (no dispatch, no issue, no cancel).
// Exit codes: 0 done (always, for cancel); 1 something could not be read or done (an input, the dispatch or the alert call); 2 usage error.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMain } from './layout-diff.mjs';
import { raise } from './pipeline-alert.mjs';

export const PLANNER_REPO = 'https://github.com/GoodStuffSoftware/star-rupture-planner';
export const BACKOFF_HOURS = 6;
export const MAX_FAILURES = 2;
const IN_FLIGHT = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'stale']);
const RUN_TITLE = /^SR data extract (\S+) (\d+)$/;

export const alertTitle = (branch, buildid) => `SR data extract: ${branch} ${buildid} needs attention`;

// The branch and build id a run was started for, from its title; null for any other run.
export function runTarget(title) {
  const m = RUN_TITLE.exec(String(title ?? ''));
  return m ? { branch: m[1], buildid: m[2] } : null;
}

const forBuild = (runs, branch, buildid) => (Array.isArray(runs) ? runs : []).filter((r) => {
  if (!r || r.event === 'pull_request') return false;
  const t = runTarget(r.title);
  return t && t.branch === branch && t.buildid === buildid;
});

// The runs for this build that ended in failure, oldest first.
export const failuresOf = (runs, branch, buildid) => forBuild(runs, branch, buildid)
  .filter((r) => r.status === 'completed' && FAILED.has(r.conclusion))
  .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));

// One build. Inputs, all plain data:
//   branch, buildid, now (ms)
//   tags       tag names of the planner repository (without refs/tags/)
//   artifacts  [{ name, expired, runConclusion }] artifacts of starrupture-ci called sr-data-<branch>-<buildid>
//   runs       [{ title, status, conclusion, event, updatedAt, url }] runs of sr-data-extract.yml
//   groupBusy  true when any run that uses the Steam session is queued or going
//   alertRaised  true when the alert issue for this build exists (open or closed)
// Returns { action: 'start' | 'alert' | 'none' | 'wait', why, failures }.
export function decide({ branch, buildid, now, tags = [], artifacts = [], runs = [], groupBusy = false, alertRaised = false }) {
  const tagSet = new Set(tags);
  const failed = failuresOf(runs, branch, buildid);
  const out = (action, why) => ({ action, why, failures: failed.length });
  if (tagSet.has(`srdata-${branch}-${buildid}`)) return out('none', `the planner has tag srdata-${branch}-${buildid}`);
  if (tagSet.has(`srdata-failed-${branch}-${buildid}`)) return out('none', `the planner has tag srdata-failed-${branch}-${buildid}`);
  const name = `sr-data-${branch}-${buildid}`;
  if (artifacts.some((a) => a.name === name && !a.expired && a.runConclusion === 'success')) return out('none', `artifact ${name} is there`);
  if (forBuild(runs, branch, buildid).some((r) => IN_FLIGHT.has(r.status))) return out('none', 'an extract run for this build is queued or going');
  if (failed.length >= MAX_FAILURES) {
    return alertRaised ? out('none', `failed ${failed.length} times; the alert is already raised`) : out('alert', `failed ${failed.length} times`);
  }
  if (groupBusy) return out('wait', 'a run that uses the Steam session is queued or going');
  if (failed.length) {
    const last = Date.parse(failed[failed.length - 1].updatedAt);
    const next = last + BACKOFF_HOURS * 3600 * 1000;
    if (now < next) return { ...out('wait', `the last failure ended less than ${BACKOFF_HOURS} hours ago`), retryAt: new Date(next).toISOString() };
  }
  return out('start', failed.length ? `retry after ${failed.length} failure` : 'no extract for this build');
}

// Every branch of the run, in the order given. Only the first build that needs a start gets it: the
// next waits for a later run, so two dispatches never queue behind each other in the Steam group.
export function plan({ builds, ...shared }) {
  let started = false;
  return builds.map((b) => {
    const d = decide({ ...shared, branch: b.branch, buildid: b.buildid, artifacts: b.artifacts, alertRaised: b.alertRaised });
    if (d.action !== 'start') return { ...b, ...d };
    if (started) return { ...b, ...d, action: 'wait', why: 'one extract is started per run; the next poll takes this one' };
    started = true;
    return { ...b, ...d };
  });
}

export function alertBody({ owner, branch, buildid, pin, failed, repo }) {
  return [`@${owner} the planner data extract for build ${buildid} of branch ${branch} has failed ${failed.length} times, so it is not tried again. Each try downloads about 46 GB and holds the Steam session.`,
    '',
    ...failed.map((r) => `- failed run: ${r.url}`),
    '',
    `Once the cause is fixed, start it by hand: \`gh workflow run sr-data-extract.yml -R ${repo} --ref main -f branch=${branch} -f buildid=${buildid} -f extractor_ref=${pin} -f build_only=false\``].join('\n') + '\n';
}

// The reconcile itself. `io` carries every outside effect, so a test can watch them.
export async function reconcile({ repo, branches, owner, pin, dryRun = false, now = Date.now(), io, log = console.log }) {
  if (!/^[0-9a-f]{40}$/.test(pin)) throw new Error('the extractor pin must be a full commit sha (40 hex characters)');
  const tags = io.tags();
  const runs = io.runs();
  const groupBusy = io.groupBusy();
  const builds = [];
  for (const branch of branches) {
    const buildid = io.liveBuildid(branch);
    if (!/^\d{1,12}$/.test(String(buildid ?? ''))) { log(`${branch}: the current build id could not be read; skipped`); continue; }
    const failures = failuresOf(runs, branch, buildid).length;
    builds.push({ branch, buildid, artifacts: io.artifacts(`sr-data-${branch}-${buildid}`), alertRaised: failures >= MAX_FAILURES ? io.alertRaised(alertTitle(branch, buildid)) : false });
  }
  const decisions = plan({ builds, now, tags, runs, groupBusy });
  for (const d of decisions) {
    log(`${d.branch} ${d.buildid}: ${d.action} (${d.why})${d.retryAt ? `, next try ${d.retryAt}` : ''}`);
    if (dryRun) continue;
    if (d.action === 'start') io.dispatch({ branch: d.branch, buildid: d.buildid, pin });
    if (d.action === 'alert') io.raiseAlert({ title: alertTitle(d.branch, d.buildid), body: alertBody({ owner, branch: d.branch, buildid: d.buildid, pin, failed: failuresOf(runs, d.branch, d.buildid), repo }) });
  }
  return decisions;
}

// ---- cancelling extracts when a build change starts the chain ---------------------------------

// The extract runs that hold or wait for the Steam session: queued or going, started for a build
// (a title that names a branch and build id) and not a pull-request run. A build-only run has no
// such title and never takes the session.
export const cancelPlan = (runs) => (Array.isArray(runs) ? runs : [])
  .filter((r) => r && r.id != null && r.event !== 'pull_request' && IN_FLIGHT.has(r.status) && runTarget(r.title))
  .map((r) => r.id);

// Cancel every such run, then wait until they have ended, for at most `waitSeconds`. Never throws.
// Each call to GitHub is tried up to three times, five seconds apart: one transient error must not
// leave the extract holding the Steam session in front of the chain.
export async function cancelExtracts({ io, dryRun = false, waitSeconds = 240, intervalSeconds = 15, sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), log = console.log }) {
  const tried = async (fn) => {
    for (let n = 1; ; n++) {
      try { return fn(); } catch (e) { if (n === 3) throw e; await sleep(5); }
    }
  };
  let ids;
  try { ids = cancelPlan(await tried(() => io.runs())); } catch (e) { log(`warning: the extract runs could not be listed, nothing cancelled (${String(e.message).split('\n')[0]})`); return { cancelled: [], ended: false }; }
  if (!ids.length) { log('no extract run is queued or going'); return { cancelled: [], ended: true }; }
  if (dryRun) { log(`would cancel extract run(s) ${ids.join(', ')}`); return { cancelled: ids, ended: true }; }
  const cancelled = [];
  for (const id of ids) {
    try { await tried(() => io.cancel(id)); cancelled.push(id); log(`cancel requested for extract run ${id}`); } catch (e) { log(`warning: extract run ${id} could not be cancelled (${String(e.message).split('\n')[0]})`); }
  }
  if (!cancelled.length) return { cancelled, ended: false };
  for (let waited = 0; ; waited += intervalSeconds) {
    let left;
    try { left = ((await tried(() => io.runs())) ?? []).filter((r) => cancelled.includes(r.id) && IN_FLIGHT.has(r.status)); } catch (e) { log(`warning: the extract runs could not be listed while waiting (${String(e.message).split('\n')[0]})`); return { cancelled, ended: false }; }
    if (!left.length) { log('the cancelled extract run(s) have ended'); return { cancelled, ended: true }; }
    if (waited + intervalSeconds > waitSeconds) { log(`warning: extract run(s) ${left.map((r) => r.id).join(', ')} still going after ${waitSeconds} seconds; the chain goes on`); return { cancelled, ended: false }; }
    await sleep(intervalSeconds);
  }
}

// ---- the command line: the real effects ------------------------------------------------------

const exec = (cmd, args, env) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
const jsonLines = (text) => String(text ?? '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

export function realIo({ repo, owner, pollScript, plannerRepo = PLANNER_REPO }) {
  const gh = (args, env) => exec('gh', args, env);
  return {
    tags: () => exec('git', ['ls-remote', '--tags', plannerRepo, 'refs/tags/srdata-*'])
      .split('\n').map((l) => l.split('\t')[1]).filter(Boolean).map((r) => r.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '')),
    runs: () => jsonLines(gh(['api', `repos/${repo}/actions/workflows/sr-data-extract.yml/runs?per_page=100`, '--jq',
      '.workflow_runs[] | {id, title: .display_title, status, conclusion, event, updatedAt: .updated_at, url: .html_url}'])),
    cancel: (id) => gh(['run', 'cancel', String(id), '-R', repo]),
    // The same look the layout refresh makes before it takes the session (sr-layout-refresh.yml, job idle).
    groupBusy: () => ['queued', 'in_progress', 'waiting', 'pending', 'requested'].some((status) =>
      gh(['api', `repos/${repo}/actions/runs?status=${status}&per_page=100`, '--jq',
        '.workflow_runs[] | select(.event != "pull_request") | select(.path | test("sr-(client-check|client-rig|data-extract)[.]yml")) | .html_url']).trim() !== ''),
    liveBuildid: (branch) => { try { return exec('node', [pollScript, '--live-buildid', branch]).trim(); } catch (e) { console.log(`${branch}: ${String(e.stderr || e.message).trim().split('\n')[0]}`); return ''; } },
    artifacts: (name) => jsonLines(gh(['api', `repos/${repo}/actions/artifacts?name=${name}&per_page=100`, '--jq',
      '.artifacts[] | {name, expired, run: .workflow_run.id}'])).map((a) => ({
      name: a.name, expired: a.expired, runConclusion: a.expired ? '' : gh(['api', `repos/${repo}/actions/runs/${a.run}`, '--jq', '.conclusion']).trim(),
    })),
    alertRaised: (title) => gh(['issue', 'list', '-R', repo, '--state', 'all', '--search', `${title} in:title`, '--json', 'title',
      '--jq', '[.[] | select(.title == env.TITLE)] | length'], { TITLE: title }).trim() !== '0',
    dispatch: ({ branch, buildid, pin }) => gh(['workflow', 'run', 'sr-data-extract.yml', '-R', repo, '--ref', 'main',
      '-f', `branch=${branch}`, '-f', `buildid=${buildid}`, '-f', `extractor_ref=${pin}`, '-f', 'build_only=false']),
    raiseAlert: ({ title, body }) => {
      const file = join(mkdtempSync(join(tmpdir(), 'planner-extract-')), 'alert.md');
      writeFileSync(file, body);
      raise({ title, bodyFile: file, owner, call: (a) => gh(a[0] === 'label' || a[0] === 'issue' ? [...a, '-R', repo] : a) });
    },
  };
}

function parseArgs(argv) {
  const out = { dryRun: false, cancel: argv[0] === 'cancel' };
  for (let i = out.cancel ? 1 : 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') { out.dryRun = true; continue; }
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[++i];
  }
  for (const k of out.cancel ? ['repo'] : ['repo', 'branches', 'owner']) if (!out[k]) throw new Error(`--${k} is required`);
  return out;
}

// Warnings go to the run page as annotations, so they are seen without opening the log.
const annotated = (line) => console.log(/^warning: /.test(line) ? `::warning title=Planner data extract::${line.slice(9)}` : line);

if (isMain(import.meta.url)) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`${e.message}\nusage: planner-extract.mjs --repo <owner/name> --branches <a,b> --owner <login> [--pin-file f] [--poll-script f] [--dry-run]\n       planner-extract.mjs cancel --repo <owner/name> [--wait-seconds N] [--dry-run]`);
    process.exit(2);
  }
  if (a.cancel) {
    // Never fails: the chain this runs in front of must not stop for it.
    try { await cancelExtracts({ io: realIo({ repo: a.repo }), dryRun: a.dryRun, waitSeconds: Number(a['wait-seconds'] ?? 240) || 0, log: annotated }); } catch (e) { annotated(`warning: the extract cancel stopped early (${String(e.message).split('\n')[0]})`); }
  } else {
    try {
      const pin = readFileSync(a['pin-file'] ?? 'ci/data/extractor-ref.txt', 'utf8').trim();
      const io = realIo({ repo: a.repo, owner: a.owner, pollScript: a['poll-script'] ?? '.github/sr-pipeline/poll-steam.mjs' });
      await reconcile({ repo: a.repo, branches: a.branches.split(',').filter(Boolean), owner: a.owner, pin, dryRun: a.dryRun, io });
    } catch (e) {
      const why = String(e.stderr || e.message).trim().split('\n')[0];
      console.error(`planner-extract: ${why}`);
      console.log(`::error title=Planner data extract::${why}`);
      process.exitCode = 1;
    }
  }
}
