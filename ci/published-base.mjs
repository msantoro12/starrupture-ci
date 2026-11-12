#!/usr/bin/env node
// published-base.mjs: take the published version map as part of the base, and check that a new
// feed lost none of it. The one place the workflow does this (map mode, the check job's carry scan
// and the publish job call it); the work itself is version-map.mjs import-published and
// check-preserve.
//
//   node ci/published-base.mjs take <header> --report <file> [--dir <dir>] [--first-publish true] [--check-report <file>]
//       Fetches version-map-client.v1.txt from the vmap-feed release of $GH_REPO (3 tries, 5 s and
//       15 s apart), verifies its signature and adds every build line and row the header lacks.
//       --check-report: the report an earlier job wrote for the same run; when it says hold (or is
//       missing or unreadable) that hold stands and nothing is fetched again.
//       --first-publish true: no release, or no file on it, is not a hold (a first publish has no
//       published file to take).
//   node ci/published-base.mjs preserve <feed> --published <file> --report <file>
//       Every build line and row of <file> must be in <feed> unchanged.
//
// Both write a report, { "ok": true, "step": ..., "note": ... } or { "ok": false, "step": ...,
// "reasons": [...] }, and exit 0 (ok), 3 (hold: the report says why) or 2 (usage or an unexpected
// error, no report). A hold is never a pass: the caller stops the run on the reduced header, and
// `decide.mjs hold --report` turns the report into the decision. The retired and changed lists are
// ci/retired-rows.txt and ci/changed-rows.txt next to this file.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const VERSION_MAP = join(here, 'version-map.mjs');
const LISTS = ['--retired', join(here, 'retired-rows.txt'), '--changed', join(here, 'changed-rows.txt')];

export const RELEASE = 'vmap-feed';
export const FEED_ASSET = 'version-map-client.v1.txt';
export const EXIT_OK = 0;
export const EXIT_HOLD = 3;
export const EXIT_ERROR = 2;
const BACKOFF_MS = [5000, 15000];
const ROWS_SHOWN = 20;

const clip = (s, n = 300) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 3)}...` : s; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const gh = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
};

// What `gh` says about the release and its file, with retries. Returns { file }, { absent: why } (the
// release or the file is not there: an answer, not a failure) or { error: why } (could not be read).
export async function fetchPublished({ dir, repo = process.env.GH_REPO, run = gh, sleep = wait, backoff = BACKOFF_MS } = {}) {
  if (!repo) throw new Error('GH_REPO is not set');
  let last = '';
  for (let i = 0; i <= backoff.length; i++) {
    if (i > 0) await sleep(backoff[i - 1]);
    const rel = run(['api', `repos/${repo}/releases/tags/${RELEASE}`]);
    if (rel.status !== 0) {
      if (/HTTP 404/.test(rel.stderr)) return { absent: `the ${RELEASE} release does not exist` };
      last = `cannot read the ${RELEASE} release: ${clip(rel.stderr)}`;
      continue;
    }
    let assets;
    try { assets = JSON.parse(rel.stdout).assets ?? []; } catch { last = `the ${RELEASE} release answer is not JSON`; continue; }
    if (!assets.some((a) => a.name === FEED_ASSET)) return { absent: `the ${RELEASE} release has no ${FEED_ASSET}` };
    mkdirSync(dir, { recursive: true });
    const dl = run(['release', 'download', RELEASE, '--repo', repo, '--pattern', FEED_ASSET, '--dir', dir, '--clobber']);
    const file = join(dir, FEED_ASSET);
    if (dl.status !== 0) { last = `cannot download ${FEED_ASSET}: ${clip(dl.stderr)}`; continue; }
    if (!existsSync(file) || statSync(file).size === 0) { last = `${FEED_ASSET} downloaded empty`; continue; }
    return { file };
  }
  return { error: last, tries: backoff.length + 1 };
}

// version-map.mjs <cmd> with the lists; returns { code, err }. extra: more arguments (tests only).
function versionMap(cmd, file, published, extra = []) {
  const r = spawnSync(process.execPath, [VERSION_MAP, cmd, file, '--published', published, ...LISTS, ...extra], { encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? 2, err: (r.stderr ?? '') + (r.error ? String(r.error.message) : '') };
}

// The summary line of version-map's stderr, and the row lines under it (two spaces, capped by the tool).
function parts(err) {
  const lines = err.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
  const rows = lines.filter((l) => l.startsWith('  ')).map((l) => l.trim());
  const head = lines.find((l) => !l.startsWith('  ')) ?? '';
  return { head: head.replace(/^version-map: (hold: |refused: )?/, ''), rows };
}

const hold = (step, ...reasons) => ({ ok: false, step, reasons });

// Judges one version-map.mjs answer: ok, or the hold that says why. Anything but 0 is a hold; there is
// no code that lets the run go on.
function judge(step, what, { code, err }, okNote) {
  if (code === 0) return { ok: true, step, note: okNote(err) };
  const { head, rows } = parts(err);
  if (code === 4) return hold(step, `published base: the published file's signature was refused (${clip(head)}); ${what} did not run`, ...rows);
  if (code === 3) return hold(step, `published base: ${clip(head, 400)}`, ...rows);
  return hold(step, `published base: ${what} could not run (exit ${code}): ${clip(head || err)}`);
}

// Takes the published file as the base of `header` (written in place only when nothing conflicts).
export async function takeBase({ header, dir, firstPublish = false, checkReport, extraArgs = [], ...deps }) {
  if (checkReport !== undefined) {
    let earlier = null;
    try { earlier = JSON.parse(readFileSync(checkReport, 'utf8')); } catch { /* handled below */ }
    if (!earlier || typeof earlier.ok !== 'boolean') return hold('import', 'published base: the check job left no readable result for the published file (its step did not run or wrote nothing), so the base was not taken');
    if (!earlier.ok) return hold('import', ...(Array.isArray(earlier.reasons) && earlier.reasons.length ? earlier.reasons : ['published base: the check job held and gave no reason']));
  }
  const got = await fetchPublished({ dir, ...deps });
  if (got.absent) {
    if (firstPublish) return { ok: true, step: 'import', note: `${got.absent}; a first publish has no published file to take` };
    return hold('import', `published base: ${got.absent}, and this run is not a first publish, so there is no published file to take as the base`);
  }
  if (got.error) return hold('import', `published base: the published file could not be fetched after ${got.tries} tries (${got.error}); the header was not changed`);
  return judge('import', 'the import', versionMap('import-published', header, got.file, extraArgs),
    (err) => clip(err.split('\n').filter(Boolean).pop() ?? 'imported'));
}

// The new feed must hold every published line unchanged (retired and changed rows excepted).
export function preserveFeed({ feed, published, extraArgs = [] }) {
  if (!existsSync(published)) return hold('preserve', `published base: the published file ${published} is not there, so the new feed cannot be compared with it`);
  return judge('preserve', 'the comparison with the published file', versionMap('check-preserve', feed, published, extraArgs),
    (err) => clip(err.trim() || 'every published line is in the new feed'));
}

function parseArgs(argv) {
  const a = { pos: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { a.pos.push(argv[i]); continue; }
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

const USAGE = 'usage: published-base.mjs take <header> --report f [--dir d] [--first-publish true] [--check-report f]\n'
  + '       published-base.mjs preserve <feed> --published f --report f';

export async function main(argv, deps = {}) {
  let report;
  try {
    const [cmd, ...rest] = argv;
    const a = parseArgs(rest);
    if (!a.report || a.pos.length !== 1 || (cmd !== 'take' && cmd !== 'preserve')) throw new Error(USAGE);
    if (cmd === 'take') report = await takeBase({ header: a.pos[0], dir: a.dir ?? 'published-base', firstPublish: a['first-publish'] === 'true', checkReport: a['check-report'], ...deps });
    else {
      if (!a.published) throw new Error(USAGE);
      report = preserveFeed({ feed: a.pos[0], published: a.published, ...deps });
    }
    writeFileSync(a.report, `${JSON.stringify(report, null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`published-base: ${e.message}\n`);
    return EXIT_ERROR;
  }
  if (report.ok) {
    process.stdout.write(`published base: ${report.step}: ${report.note}\n`);
    return EXIT_OK;
  }
  for (const r of report.reasons.slice(0, ROWS_SHOWN + 1)) process.stderr.write(`${r}\n`);
  return EXIT_HOLD;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
