#!/usr/bin/env node
// Polls Steam build ids for the StarRupture client and dedicated server and
// compares them with the recorded state. No dependencies (Node 18+ fetch).
//
//   node poll-steam.mjs --state <steam.json> --out-dir <dir> [--force]
//
// <steam.json> is the baseline checked out from main. The updated state is
// written only on a real build id change or a first-time seed.
// Writes <out-dir>/pr-title.txt, pr-branch.txt and pr-body.md when the run
// should raise an alert. Sets these step outputs when GITHUB_OUTPUT is set:
//   changed=true|false   alert wanted (real change, or --force)
//   dirty=true|false     state file was rewritten
//   client_matrix=<json> client branches for sr-client-check.yml, as
//                        [{"branch":"public","buildid":"..."}]: the changed
//                        ones, or every recorded one on a forced run; []
//                        when there is no alert
//
// Failure policy: an API problem never raises an alert. Each request is
// retried; an app that still fails is skipped for this run and its recorded
// state is left alone. The script exits 0 in that case and says so in the
// log, as a ::warning annotation, and in the job summary.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const APPS = [
  // branches: null means "every branch the API lists without a password": a second
  // beta is tracked the day it appears, as the dedicated server's branches are.
  { id: '1631270', name: 'StarRupture', short: 'client', branches: null },
  { id: '3809400', name: 'StarRupture Dedicated Server', short: 'server', branches: null },
];
const NEWS_APP = '1631270';
const ATTEMPTS = 3;
const BACKOFF_MS = [5000, 20000];

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const statePath = opt('--state');
const outDir = opt('--out-dir');
const force = args.includes('--force');
if (!statePath || !outDir) {
  console.error('usage: poll-steam.mjs --state <steam.json> --out-dir <dir> [--force]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warn = (msg) => console.log(`::warning::${msg}`);

async function fetchJson(url, check) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'sr-pipeline-watch', Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return check(json);
    } catch (e) {
      lastErr = e;
      console.log(`  attempt ${attempt}/${ATTEMPTS} failed for ${url}: ${e.message}`);
      if (attempt < ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1]);
    }
  }
  throw lastErr;
}

// api.steamcmd.net answers 200 with an empty or partial body when its own
// upstream (Steam) hiccups, so a 200 is not enough: the shape is validated.
async function fetchBranches(app) {
  const url = `${process.env.SR_STEAMCMD_API || 'https://api.steamcmd.net'}/v1/info/${app.id}`;
  return fetchJson(url, (j) => {
    if (j.status !== 'success') throw new Error(`status=${j.status}`);
    const raw = j.data?.[app.id]?.depots?.branches;
    if (!raw || typeof raw !== 'object') throw new Error('no depots.branches in response');
    if (!raw.public) throw new Error("no 'public' branch in response");
    const out = {};
    for (const [name, v] of Object.entries(raw)) {
      if (app.branches && !app.branches.includes(name)) continue;
      if (v?.pwdrequired === '1' || v?.pwdrequired === 1) continue; // not ours to track
      if (!/^\d+$/.test(String(v?.buildid ?? ''))) throw new Error(`branch '${name}' has no numeric buildid`);
      const tu = Number.parseInt(v.timeupdated, 10);
      out[name] = { buildid: String(v.buildid), timeupdated: Number.isFinite(tu) ? tu : null };
    }
    return out;
  });
}

async function fetchNewestNews() {
  const url = `${process.env.SR_NEWS_API || 'https://api.steampowered.com'}/ISteamNews/GetNewsForApp/v2/?appid=${NEWS_APP}&count=5&maxlength=1`;
  try {
    return await fetchJson(url, (j) => {
      const items = j.appnews?.newsitems;
      if (!Array.isArray(items) || items.length === 0) throw new Error('no news items');
      return items.reduce((a, b) => (b.date > a.date ? b : a));
    });
  } catch (e) {
    console.log(`  news lookup failed (not fatal): ${e.message}`);
    return null;
  }
}

function loadState() {
  if (!existsSync(statePath)) return { schema: 1, apps: {} };
  const s = JSON.parse(readFileSync(statePath, 'utf8'));
  s.apps ??= {};
  return s;
}

const iso = (sec) => (sec ? new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : 'unknown');

const state = loadState();
const changes = [];
const failed = [];
const seeded = [];
let dirty = false;

for (const app of APPS) {
  console.log(`Polling ${app.name} (${app.id})`);
  let current;
  try {
    current = await fetchBranches(app);
  } catch (e) {
    failed.push(`${app.name}: ${e.message}`);
    warn(`Steam poll for ${app.name} (${app.id}) failed after ${ATTEMPTS} attempts (${e.message}); skipping it this run, state unchanged.`);
    continue;
  }
  const known = state.apps[app.id];
  if (!known) {
    // First sight of this app: record it, never alert on the baseline.
    state.apps[app.id] = { name: app.name, branches: current };
    seeded.push(app.name);
    dirty = true;
    continue;
  }
  known.branches ??= {};
  for (const [branch, cur] of Object.entries(current)) {
    const prev = known.branches[branch];
    if (prev && prev.buildid === cur.buildid) continue;
    if (prev && cur.timeupdated != null && prev.timeupdated != null && cur.timeupdated < prev.timeupdated) {
      // A different build id with an OLDER branch timestamp is a stale cache
      // answer, not a rollback (a rollback re-stamps the branch).
      warn(`${app.name}/${branch}: build ${cur.buildid} has an older timestamp than recorded ${prev.buildid}; treating as a stale API answer.`);
      continue;
    }
    changes.push({ app, branch, was: prev?.buildid ?? null, now: cur.buildid, timeupdated: cur.timeupdated });
    known.branches[branch] = cur;
    dirty = true;
  }
}

const everyoneFailed = failed.length === APPS.length;
if (dirty) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

const alert = changes.length > 0 || (force && !everyoneFailed);
const CLIENT_APP = APPS[0].id;
const clientMatrix = !alert
  ? []
  : changes.length > 0
    ? changes.filter((c) => c.app.id === CLIENT_APP).map((c) => ({ branch: c.branch, buildid: c.now }))
    : Object.entries(state.apps[CLIENT_APP]?.branches ?? {}).map(([branch, v]) => ({ branch, buildid: v.buildid }));
const lines = [];
if (alert) {
  const news = await fetchNewestNews();
  let title;
  let rows;
  let branchName = null;
  if (changes.length > 0) {
    const c0 = changes[0];
    title = `Game build ${c0.now} on ${c0.branch}` + (changes.length > 1 ? ` (+${changes.length - 1} more)` : '');
    branchName = `game-update/${c0.app.short}-${c0.branch}-${c0.now}`;
    rows = changes.map((c) => `| ${c.app.name} | ${c.branch} | ${c.was ?? '(new branch)'} | ${c.now} | ${iso(c.timeupdated)} |`);
  } else {
    const all = APPS.flatMap((app) =>
      Object.entries(state.apps[app.id]?.branches ?? {}).map(([branch, v]) => ({ app, branch, ...v })),
    );
    title = 'Game update check (forced): ' + all.map((c) => `${c.app.short} ${c.branch} ${c.buildid}`).join(', ');
    rows = all.map((c) => `| ${c.app.name} | ${c.branch} | (forced run) | ${c.buildid} | ${iso(c.timeupdated)} |`);
  }
  const body = [
    changes.length > 0 ? 'Steam reports new build ids.' : 'Forced run: no build id changed; these are the recorded ids.',
    '',
    '| App | Branch | Was | Now | Branch updated (UTC) |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    news
      ? `Newest Steam news post: [${news.title}](${news.url}) (${iso(news.date)})`
      : 'Newest Steam news post: unavailable this run.',
    '',
    'A compile check of every component below is running; its per-component result will be posted as a comment on this pull request. When a client branch changed, an offline check of the new client build follows as its own comment. Merging this PR means the update is handled: it records the new build ids on main. It says whether the tree compiles, not whether the mods work in game.',
    '',
    '### Update checklist',
    '',
    'Release lines are always manual. Each needs the owner\'s OK and is versioned independently from the component\'s own version file.',
    '',
    '- [ ] **Loader (Client)**: compile check; offline check of the new client build (CL, pattern scan, SDK globals), posted as its own comment',
    '  - [ ] release: manual, needs owner\'s OK',
    '- [ ] **Loader (Server)**: compile check; pattern scan (placeholder, scan tool not available yet)',
    '  - [ ] release: manual, needs owner\'s OK',
    '- [ ] **BetterDrone**: rebuild against the current SDK',
    '  - [ ] release: manual, needs owner\'s OK',
    '- [ ] **BetterCheats**: rebuild against the current SDK',
    '  - [ ] release: manual, needs owner\'s OK',
    '- [ ] **WAILA**: rebuild against the current SDK',
    '  - [ ] release: manual, needs owner\'s OK',
    '- [ ] **Codex**: rebuild against the current SDK',
    '  - [ ] release: manual, needs owner\'s OK',
    '- [ ] **Game SDK**: SDK dump needed (manual)',
    '  - [ ] release: manual, needs owner\'s OK',
  ].join('\n');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'pr-title.txt'), title);
  writeFileSync(join(outDir, 'pr-branch.txt'), branchName ?? '');
  writeFileSync(join(outDir, 'pr-body.md'), body + '\n');
  lines.push(`Alert: ${title}`);
}

// Job summary + log
const summary = [
  '### Steam watch',
  ...APPS.map((a) => {
    const b = state.apps[a.id]?.branches ?? {};
    return `- ${a.name} (${a.id}): ` + (Object.entries(b).map(([n, v]) => `${n} ${v.buildid}`).join(', ') || 'no data');
  }),
  ...changes.map((c) => `- CHANGED ${c.app.name}/${c.branch}: ${c.was ?? 'new'} -> ${c.now}`),
  ...seeded.map((n) => `- Seeded baseline for ${n} (no alert)`),
  ...failed.map((f) => `- SKIPPED (API failure): ${f}`),
];
console.log(summary.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${alert}\ndirty=${dirty}\nclient_matrix=${JSON.stringify(clientMatrix)}\n`);
}
for (const l of lines) console.log(l);
