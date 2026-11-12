#!/usr/bin/env node
// The alert parts that sr-client-check.yml and sr-watch.yml share: why the jobs of a run
// failed, and the one alert issue per title (label pipeline-alert, assigned to the owner).
//
//   node ci/pipeline-alert.mjs causes --repo <owner/name> --run <id> --out <file.jsonl> [--tries <n>]
//   node ci/pipeline-alert.mjs outside --causes <file.jsonl> --owner <login> --run-url <url> --out <file.md>
//   node ci/pipeline-alert.mjs raise --title <title> --body-file <file.md> --owner <login>
//
// causes: one JSON line per failed job of the run that can fail it (not the planner data extract),
// { id, name, step, error }. `step` is the first failed step (jobs API) and `error` its first error line other than "Process completed with exit
// code N". It comes from the job's failure annotations, which exist as soon as the step emits
// them, then from the `##[error]` lines of the job log. A job log can still be missing seconds
// after the job ended, so an unread log is fetched again, up to --tries times (default 6), 10 s
// apart. Best effort: a call that fails leaves the field blank and says why on stderr.
// outside: the alert body for the failed jobs that are not part of a client check (the jobs
// sr-watch runs itself and the compile check, sr-build-all.yml). No such job, no file.
// raise: comments on the open issue with that exact title, or opens it.
//
// Exit codes: 0 done; 2 usage error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isMain } from './layout-diff.mjs';

const EXIT_CODE_LINE = /^Process completed with exit code \d+\.?$/;

// The first "##[error]" line of a job log, without its timestamp, preferring a real message over
// the runner's closing "Process completed with exit code N".
export function firstLogError(text) {
  const errs = String(text ?? '').replace(/^﻿/, '').split('\n')
    .map((l) => l.replace(/\r$/, '').replace(/^\S+Z /, ''))
    .filter((l) => l.startsWith('##[error]'))
    .map((l) => l.slice(9).trim());
  return errs.find((l) => !EXIT_CODE_LINE.test(l)) ?? errs[0] ?? '';
}

// The first failure annotation with a real message (check-runs annotations API rows).
export function firstAnnotationError(rows) {
  const msgs = (Array.isArray(rows) ? rows : [])
    .filter((a) => a && a.annotation_level === 'failure' && typeof a.message === 'string')
    .map((a) => a.message.replace(/\s+/g, ' ').trim());
  return msgs.find((m) => !EXIT_CODE_LINE.test(m)) ?? '';
}

// A job's error line: the annotation, else the log, else the bare exit-code line if that is all there is.
export function jobError(annotations, logText) {
  return firstAnnotationError(annotations) || firstLogError(logText);
}

const clip = (s, n = 300) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
};

// 'step "X": first error', or whichever half is known.
export function causeText(job) {
  const step = job?.step ? `step "${job.step}"` : '';
  const err = job?.error ? clip(job.error) : '';
  return step && err ? `${step}: ${err}` : step || err;
}

// The watcher's planner data extract job. It cannot fail the run (continue-on-error in sr-watch.yml), so it is no cause of an alert.
export const EXTRACT_JOB_NAME = 'planner data extract';

// The jobs of a client check are listed as "client-check (<branch>) / <job>"; they have their own alert.
export const inClientCheck = (name) => /^client-check \(/.test(String(name ?? ''));

export function outsideBody(jobs, { owner, runUrl }) {
  const mine = (Array.isArray(jobs) ? jobs : []).filter((j) => j && typeof j.name === 'string' && !inClientCheck(j.name));
  if (!mine.length) return null;
  const lines = mine.flatMap((j) => {
    const c = causeText(j);
    return [`- job **${j.name}** failed`, ...(c ? [`  - cause: ${c}`] : [])];
  });
  return [`@${owner} [run](${runUrl}) of the update chain.`, '', ...lines, '',
    'The watcher does not check a build again while its update PR is open; once the cause is fixed: `gh workflow run sr-watch.yml --ref main -f force=true`.'].join('\n') + '\n';
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const tryGh = (args, what) => {
  try { return gh(args); } catch (e) { console.error(`${what}: ${String(e.stderr || e.message).trim().split('\n')[0]}`); return null; }
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function collectCauses({ repo, run, tries = 6, wait = 10000, call = tryGh }) {
  const listed = call(['api', `repos/${repo}/actions/runs/${run}/jobs?per_page=100`, '--paginate',
    '--jq', '.jobs[] | select(.conclusion == "failure") | {id, name, step: ([.steps[] | select(.conclusion == "failure")][0].name // "")}'], 'jobs list');
  const jobs = String(listed ?? '').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((j) => j.name !== EXTRACT_JOB_NAME);
  for (const j of jobs) {
    const ann = call(['api', `repos/${repo}/check-runs/${j.id}/annotations`], `annotations of job ${j.id}`);
    let rows = [];
    try { rows = JSON.parse(ann ?? '[]'); } catch {}
    j.error = firstAnnotationError(rows);
    for (let i = 0; !j.error && i < tries; i++) {
      if (i) await pause(wait);
      const log = call(['api', `repos/${repo}/actions/jobs/${j.id}/logs`], `log of job ${j.id}, try ${i + 1}`);
      if (log) { j.error = firstLogError(log); break; }
    }
  }
  return jobs;
}

// The search is fuzzy, so the open issue is the one whose title matches exactly (jq reads env.TITLE).
export function raise({ title, bodyFile, owner, call = gh }) {
  process.env.TITLE = title;
  call(['label', 'create', 'pipeline-alert', '--color', 'B60205', '--description', 'A pipeline run or a game-update PR needs the owner', '--force']);
  const number = String(call(['issue', 'list', '--state', 'open', '--search', `${title} in:title`, '--json', 'number,title',
    '--jq', '[.[] | select(.title == env.TITLE)][0].number // empty']) ?? '').trim();
  if (/^\d+$/.test(number)) {
    call(['issue', 'comment', number, '--body-file', bodyFile]);
    call(['issue', 'edit', number, '--add-label', 'pipeline-alert', '--add-assignee', owner]);
    return Number(number);
  }
  call(['issue', 'create', '--title', title, '--body-file', bodyFile, '--label', 'pipeline-alert', '--assignee', owner]);
  return null;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

if (isMain(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  let a;
  try {
    a = args(rest);
    const need = { causes: ['repo', 'run', 'out'], outside: ['causes', 'owner', 'run-url', 'out'], raise: ['title', 'body-file', 'owner'] }[cmd];
    if (!need) throw new Error(`unknown command ${cmd ?? '(none)'}`);
    for (const k of need) if (!a[k]) throw new Error(`--${k} is required`);
  } catch (e) {
    console.error(`${e.message}\nusage: pipeline-alert.mjs causes --repo r --run id --out f [--tries n] | outside --causes f --owner o --run-url u --out f | raise --title t --body-file f --owner o`);
    process.exit(2);
  }
  if (cmd === 'causes') {
    const jobs = await collectCauses({ repo: a.repo, run: a.run, tries: a.tries ? Number(a.tries) : 6 });
    writeFileSync(a.out, jobs.map((j) => JSON.stringify(j) + '\n').join(''));
    for (const j of jobs) console.log(`${j.name}: ${causeText(j) || '(no cause read)'}`);
  } else if (cmd === 'outside') {
    const jobs = existsSync(a.causes) ? readFileSync(a.causes, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
    const md = outsideBody(jobs, { owner: a.owner, runUrl: a['run-url'] });
    if (md) writeFileSync(a.out, md);
    console.log(md ? md : 'No failed job outside the client check.');
  } else {
    raise({ title: a.title, bodyFile: a['body-file'], owner: a.owner });
  }
}
