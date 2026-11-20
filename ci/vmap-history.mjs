#!/usr/bin/env node
// The release history of the version object map (vmap-history.json on the vmap-feed release): what was
// released, by version identity, and the attempts the chain has spent on a CL.
//
//   { "releases": { "ModLoader:130045": { "repo": "ModLoader", "cl": "130045", "at": "<ISO time>", "seq": 1795109742 } },
//     "attempts": { "130045": [ { "run": "123", "outcome": "rejected", "at": "<ISO time>" } ] } }
//
// One entry per version identity, the repo and the CL: a second release of the same CL replaces the entry
// (the newest seq wins, and it names the seq it replaced in `supersedes`). The old shape, an array of
// entries, is read as well and written back keyed; an array that lists one identity twice is refused by
// the readers (ci/decide.mjs) and collapsed to the newest seq by the writers below.
//
// attempts[cl] counts what the chain itself rejected: a run that reached a decision and held. A run that died
// before one (cancelled, a lost runner, a failed download) is an `infra` record at most and never counts. A
// reset record (sr-watch's retry_cl input, a hand dispatch) starts the count again for that one CL. A bare
// number, the old shape, is read as that many rejected attempts.
//
//   node ci/vmap-history.mjs record --history f --repo ModLoader --cl 130045 --seq 1795109742 --out f
//        [--at <ISO time>] [--supersedes <seq>]
//   node ci/vmap-history.mjs retry --history f --cl 130045 --actor <login> --run <id> --out f [--note f]
//   node ci/vmap-history.mjs check --history f      (exit 2 when one version is listed twice)
//
// Both read the history strictly (a duplicate JSON key, or an entry under the wrong key, stops them) and write
// it keyed. Exit 0 ok, 2 refused or a usage error.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCl = (v) => typeof v === 'string' && /^[1-9][0-9]{0,8}$/.test(v);
const isSeq = (v) => Number.isSafeInteger(v) && v > 0;
export const OUTCOMES = Object.freeze(['rejected', 'infra']);

export const historyKey = (repo, cl) => `${repo}:${cl}`;

// The keys that occur twice in one JSON object of the text, which JSON.parse folds into the last one.
export function findDuplicateJsonKeys(text) {
  const dups = [];
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '{') stack.push(new Set());
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const literal = text.slice(i, j + 1);
      i = j;
      const keys = stack[stack.length - 1];
      let k = i + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (keys && text[k] === ':') {
        let key = literal;
        try { key = JSON.parse(literal); } catch { /* the parse of the whole text refuses it */ }
        if (keys.has(key)) dups.push(key);
        keys.add(key);
      }
    }
    i++;
  }
  return dups;
}

// loadJson's shape ({ ok, value } or { ok: false, error }) for a history file, refusing a JSON object that names a key twice.
export function loadHistory(file) {
  if (typeof file !== 'string' || file === '') return { ok: false, error: 'no file given' };
  let text;
  try {
    text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    return { ok: false, error: `cannot read ${file}: ${e.code || e.message}` };
  }
  const dups = findDuplicateJsonKeys(text);
  if (dups.length > 0) return { ok: false, error: `history: the key ${JSON.stringify(dups[0])} occurs twice in ${file}` };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: `cannot read ${file}: ${e.message}` };
  }
}

function checkEntry(r) {
  if (!isObj(r) || typeof r.repo !== 'string' || r.repo === '' || !isCl(r.cl) || (r.seq !== undefined && !isSeq(r.seq))) return 'history: malformed release entry';
  return null;
}

function checkAttempts(attempts) {
  for (const [cl, a] of Object.entries(attempts)) {
    if (!isCl(cl)) return 'history: attempts entry is malformed';
    if (Number.isInteger(a) && a >= 0) continue;
    const ok = Array.isArray(a) && a.every((x) => isObj(x) && (x.reset === true || (typeof x.run === 'string' && OUTCOMES.includes(x.outcome))));
    if (!ok) return 'history: attempts entry is malformed';
  }
  return null;
}

// The newer of two entries of one identity: the higher seq, and the later one when neither has a seq or they are equal.
const newer = (a, b) => (isSeq(a.seq) && isSeq(b.seq) ? (b.seq >= a.seq ? b : a) : isSeq(a.seq) ? a : b);

// A history as the keyed shape, or a reason. value: the parsed JSON. collapse: an array that lists one identity
// twice is folded to the newest seq (the writers); without it that is refused (the readers).
// Returns { ok: true, history, migrated } with the releases keyed by `<repo>:<cl>`, or { ok: false, error }.
export function readHistory(value, { collapse = false } = {}) {
  if (!isObj(value)) return { ok: false, error: 'history: not a JSON object' };
  if (!(Array.isArray(value.releases) || isObj(value.releases)) || !isObj(value.attempts ?? {})) return { ok: false, error: 'history: malformed (need releases and attempts{})' };
  const releases = {};
  let migrated = false;
  if (Array.isArray(value.releases)) {
    migrated = true;
    for (const r of value.releases) {
      const bad = checkEntry(r);
      if (bad) return { ok: false, error: bad };
      const key = historyKey(r.repo, r.cl);
      if (Object.hasOwn(releases, key)) {
        if (!collapse) return { ok: false, error: `history: ${r.repo} CL-${r.cl} is listed twice; one entry per version identity` };
        releases[key] = newer(releases[key], r);
      } else releases[key] = r;
    }
  } else {
    for (const [key, r] of Object.entries(value.releases)) {
      const bad = checkEntry(r);
      if (bad) return { ok: false, error: bad };
      if (key !== historyKey(r.repo, r.cl)) return { ok: false, error: `history: the key ${JSON.stringify(key)} does not match its entry (${r.repo} CL-${r.cl})` };
      releases[key] = r;
    }
  }
  const attempts = value.attempts ?? {};
  const bad = checkAttempts(attempts);
  if (bad) return { ok: false, error: bad };
  return { ok: true, history: { releases, attempts }, migrated };
}

// The release entries of either shape, for a reader that only looks (the alert line): no validation.
export function listReleases(history) {
  const r = history?.releases;
  return Array.isArray(r) ? r : isObj(r) ? Object.values(r) : [];
}

// One release recorded: the identity's entry is replaced when this one is not older (the newest seq stays).
// entry: { repo, cl, seq, at?, supersedes? }. Returns a new history.
export function upsertRelease(history, entry) {
  const bad = checkEntry(entry);
  if (bad) throw new Error(bad);
  if (!isSeq(entry.seq)) throw new Error('history: a release needs the seq it was signed with');
  const key = historyKey(entry.repo, entry.cl);
  const old = history.releases[key];
  const next = old === undefined ? entry : newer(old, entry);
  return { ...history, releases: { ...history.releases, [key]: next } };
}

// What the chain itself rejected for one CL since the last reset. Infra records and anything older than a reset do not count.
export function countedAttempts(history, cl) {
  const a = history.attempts?.[cl];
  if (a === undefined) return 0;
  if (Number.isInteger(a)) return a;
  let n = 0;
  for (const x of a) {
    if (x.reset === true) n = 0;
    else if (x.outcome === 'rejected') n++;
  }
  return n;
}

const recordsOf = (history, cl) => {
  const a = history.attempts?.[cl];
  if (a === undefined) return [];
  return Number.isInteger(a) ? Array.from({ length: a }, () => ({ run: 'earlier', outcome: 'rejected' })) : a;
};

// One run's end for a CL. outcome 'rejected': the chain reached a decision and held, which counts. 'infra': the run
// died before a decision (cancelled, a lost runner, a failed download), which is recorded and never counts.
export function recordAttempt(history, cl, { run, outcome, at }) {
  if (!isCl(String(cl))) throw new Error(`history: ${cl} is not a CL`);
  if (!OUTCOMES.includes(outcome) || typeof run !== 'string' || run === '') throw new Error('history: an attempt needs a run id and an outcome of rejected or infra');
  return { ...history, attempts: { ...history.attempts, [cl]: [...recordsOf(history, cl), { run, outcome, ...(at ? { at } : {}) }] } };
}

// The owner's reset of one CL's count (sr-watch's retry_cl): a record naming who, which run and how many it cleared.
// No other CL is touched. Returns { history, cleared }.
export function retryCl(history, cl, { actor, run, at }) {
  if (!isCl(String(cl))) throw new Error(`history: ${cl} is not a CL`);
  if (typeof actor !== 'string' || actor === '' || typeof run !== 'string' || run === '') throw new Error('history: a reset needs the actor and the run');
  const cleared = countedAttempts(history, cl);
  const record = { reset: true, actor, run, cleared, ...(at ? { at } : {}) };
  return { history: { ...history, attempts: { ...history.attempts, [cl]: [...recordsOf(history, cl), record] } }, cleared };
}

// The file text: keys in a fixed order so equal histories are equal bytes.
export function serializeHistory(history) {
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ releases: sorted(history.releases), attempts: sorted(history.attempts) }, null, 1)}\n`;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) throw new Error(`bad argument: ${argv[i]}`);
    a[argv[i].slice(2)] = argv[i + 1];
  }
  return a;
}

const readOrThrow = (file) => {
  const loaded = loadHistory(file);
  if (!loaded.ok) throw new Error(loaded.error);
  const got = readHistory(loaded.value, { collapse: true });
  if (!got.ok) throw new Error(got.error);
  return got.history;
};

export function main(argv) {
  const usage = 'usage: vmap-history.mjs record --history f --repo R --cl N --seq S --out f [--at ISO] [--supersedes S] | retry --history f --cl N --actor <login> --run <id> --out f [--note f] | check --history f';
  try {
    const [cmd, ...rest] = argv;
    const a = parseArgs(rest);
    if (cmd === 'check') {
      // Strict read, no folding: a history that lists one version twice is refused (the shared publish routine runs this before any upload).
      if (!a.history) throw new Error(usage);
      const loaded = loadHistory(a.history);
      if (!loaded.ok) throw new Error(loaded.error);
      const got = readHistory(loaded.value);
      if (!got.ok) throw new Error(got.error);
      process.stdout.write(`${Object.keys(got.history.releases).length} release(s), none listed twice\n`);
      return 0;
    }
    if (!a.history || !a.out || !isCl(a.cl ?? '')) throw new Error(usage);
    const history = readOrThrow(a.history);
    if (cmd === 'record') {
      if (!a.repo || !/^[1-9][0-9]{0,15}$/.test(a.seq ?? '')) throw new Error(usage);
      if (a.supersedes !== undefined && !/^[1-9][0-9]{0,15}$/.test(a.supersedes)) throw new Error(usage);
      const next = upsertRelease(history, { repo: a.repo, cl: a.cl, at: a.at ?? new Date().toISOString(), seq: Number(a.seq), ...(a.supersedes ? { supersedes: Number(a.supersedes) } : {}) });
      writeFileSync(a.out, serializeHistory(next));
      process.stdout.write(`recorded ${a.repo} CL-${a.cl} at seq ${a.seq}; ${Object.keys(next.releases).length} release(s) in the history\n`);
      return 0;
    }
    if (cmd === 'retry') {
      if (!a.actor || !a.run) throw new Error(usage);
      const { history: next, cleared } = retryCl(history, a.cl, { actor: a.actor, run: a.run, at: new Date().toISOString() });
      writeFileSync(a.out, serializeHistory(next));
      const line = `**attempts reset for CL-${a.cl}** (retry_cl, started by ${a.actor}): ${cleared} counted attempt(s) cleared; run ${a.run}. Only CL-${a.cl} was reset`;
      if (a.note) writeFileSync(a.note, `${JSON.stringify({ alerts: [`- ${line}`] }, null, 2)}\n`);
      process.stdout.write(`${line.replace(/\*\*/g, '')}\n`);
      return 0;
    }
    throw new Error(usage);
  } catch (e) {
    process.stderr.write(`vmap-history: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
