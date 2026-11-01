#!/usr/bin/env node
// decide.mjs: turn the gate results for one game build into a release path.
//
//   node ci/decide.mjs --repo ModLoader --autopilot state/autopilot.json \
//       --g1 g1.json --g2 g2.json --g3 g3.json --g4 g4.json --g5 g5.json \
//       --history history.json [--now 2026-10-29T12:00:00Z] [--out decision.json]
//
// Prints the decision as JSON on stdout. Exit codes: 0 = path M (map-only update: the
// rows go into the loader's map and ship as a signed feed), 10 = path B (auto-fix of
// a plugin's patterns), 1 = HOLD, 2 = usage error. Anything else, including a crash,
// means do not ship.
//
// Decision table (the first row that applies wins):
//   autopilot unreadable, malformed or enabled != true  -> HOLD
//   a gate result missing, unreadable, malformed, or reporting an error -> HOLD
//   G1 compile or G2 interface not ok                    -> HOLD
//   G3 CL not a forward CL (equal or lower than before)  -> HOLD
//   GObjects, GNames, AppendString or GWorld not resolved (G4 scan) -> HOLD, no path
//   a used class moved (G5 usedChanged non-empty)        -> HOLD, path C (held until shadow mode is proven)
//   a required pattern missed (G4 requiredFailing > 0)   -> B, if autopilot.paths has B
//   everything clean                                     -> M, if autopilot.paths has M
//   an SDK global moved (rva != sdkRva) on a path but M  -> HOLD (on M it is a note)
//   chosen path not in autopilot.paths                   -> HOLD
//   rate limit hit (section 8 of the design)             -> HOLD
//
// Gate result shapes:
//   G1, G2: { "ok": true }                         ("error": "..." or ok != true means HOLD)
//   G3:     { "ok": true, "cl": "127999", "previousCl": "127004" }   previousCl = the CL the source requires today
//   G4:     the raw `sr-aobscan --json` output of the SERVER exe. It must hold one required
//           row each for GObjects, GNames, AppendString and GWorld (an optional "X::" prefix
//           on the name is fine). A matched row carries its resolved "rva" and may carry "sdkRva",
//           the offset the SDK (Basic.hpp Offsets::) bakes in today. They differ after a game
//           update; only path M ships the new value (as a map row), so a difference is
//           a note on M and a HOLD on any other path.
//   G5:     the `layout-diff.mjs diff --used ...` report: { "changedUsedClasses": n, "changedUsed": [{ "class": "UFoo" }, ...] }
// History (rate limits):
//   { "releases": [{ "repo": "ModLoader", "cl": "127004", "at": "<ISO time>" }],
//     "attempts": { "<cl>": <Claude attempts so far> } }

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Section 8 limits. The autopilot file can only lower the daily cap.
export const LIMITS = Object.freeze({
  maxReleasesPerDay: 2,
  minGapMinutes: 30,
  maxAttemptsPerCl: 2,
  maxReleasesPerClPerRepo: 1,
});
const VALID_PATHS = ['M', 'B', 'C'];
export const SDK_GLOBALS = Object.freeze(['GObjects', 'GNames', 'AppendString', 'GWorld']);
const DAY_MS = 24 * 60 * 60 * 1000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCl = (v) => typeof v === 'string' && /^[1-9][0-9]{0,8}$/.test(v);

// Reads one JSON input. Never throws: a failure becomes { ok: false, error }.
export function loadJson(file) {
  if (typeof file !== 'string' || file === '') return { ok: false, error: 'no file given' };
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
  } catch (e) {
    return { ok: false, error: `cannot read ${file}: ${e.code || e.message}` };
  }
}

// Every gate result goes through this first. Returns an error string or null.
function checkEnvelope(name, loaded) {
  if (!loaded || loaded.ok !== true) return `${name}: ${loaded?.error || 'result missing'}`;
  const v = loaded.value;
  if (!isObj(v)) return `${name}: result is not a JSON object`;
  if (v.error !== undefined && v.error !== null && v.error !== false && v.error !== '') {
    return `${name}: gate reported an error: ${String(v.error).slice(0, 200)}`;
  }
  return null;
}

function checkSimpleGate(name, loaded) {
  const bad = checkEnvelope(name, loaded);
  if (bad) return { error: bad };
  if (loaded.value.ok !== true) return { error: `${name}: gate did not pass (ok is not true)` };
  return {};
}

function checkG3(loaded) {
  const bad = checkEnvelope('G3', loaded);
  if (bad) return { error: bad };
  const v = loaded.value;
  if (v.ok !== true) return { error: 'G3: gate did not pass (ok is not true)' };
  if (!isCl(v.cl)) return { error: 'G3: cl is missing or not a plain number' };
  if (!isCl(v.previousCl)) return { error: 'G3: previousCl is missing or not a plain number' };
  if (Number(v.cl) <= Number(v.previousCl)) {
    return { error: `G3: CL-${v.cl} is not newer than CL-${v.previousCl}` };
  }
  return { cl: v.cl };
}

// G4 is the raw AobScan JSON. Do not trust its summary: recompute from the rows.
function checkG4(loaded) {
  const bad = checkEnvelope('G4', loaded);
  if (bad) return { error: bad };
  const v = loaded.value;
  if (v.target !== 'server') return { error: `G4: scan target is ${JSON.stringify(v.target)}, expected "server"` };
  if (!Array.isArray(v.patterns) || v.patterns.length === 0) return { error: 'G4: no patterns were scanned' };
  if (!isObj(v.summary)) return { error: 'G4: summary missing' };
  const missed = [];
  const softMissed = [];
  for (const p of v.patterns) {
    if (!isObj(p) || typeof p.name !== 'string' || typeof p.result !== 'string' || typeof p.required !== 'boolean') {
      return { error: 'G4: malformed pattern row' };
    }
    if (p.result !== 'OK') (p.required ? missed : softMissed).push(`${p.name} (${p.result})`);
  }
  const s = v.summary;
  if (s.total !== v.patterns.length || s.requiredFailing !== missed.length) {
    return { error: 'G4: summary disagrees with the pattern rows' };
  }
  return { missed, softMissed, ...checkSdkGlobals(v.patterns) };
}

// The SDK dumps hard-code the exe offsets of GObjects, GNames, AppendString and
// GWorld, and they move on every game patch. The loader's map carries the new
// values and hands them to the plugins, so an update needs all four re-resolved
// from the new exe: one required pattern row each in the G4 scan, matched (OK)
// with a non-zero resolved "rva". Absent, optional, duplicated or unmatched is a
// HOLD. A resolved value that differs from the SDK's baked "sdkRva" is listed as
// moved: a note on path M, a HOLD on any other (see decide()).
const hexValue = (v) => (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? BigInt(v) : null);

function checkSdkGlobals(rows) {
  const problems = [];
  const moved = [];
  for (const key of SDK_GLOBALS) {
    const hits = rows.filter((p) => p.name.replace(/^.*::/, '').toLowerCase() === key.toLowerCase());
    if (hits.length === 0) { problems.push(`${key}: no pattern in the scan, so the offset is not re-resolved`); continue; }
    if (hits.length > 1) { problems.push(`${key}: ${hits.length} pattern rows, expected one`); continue; }
    const row = hits[0];
    if (!row.required) problems.push(`${key}: pattern is not required`);
    else if (row.result !== 'OK') problems.push(`${key}: did not resolve (${row.result})`);
    else {
      const rva = hexValue(row.rva);
      const baked = hexValue(row.sdkRva);
      if (rva === null || rva === 0n) problems.push(`${key}: matched but no resolved RVA`);
      else if (baked !== null && rva !== baked) moved.push(`${key} ${row.sdkRva} -> ${row.rva}`);
    }
  }
  return {
    globalsError: problems.length ? `SDK global offsets not resolved: ${problems.join('; ')}` : null,
    globalsMoved: moved,
  };
}

function checkG5(loaded) {
  const bad = checkEnvelope('G5', loaded);
  if (bad) return { error: bad };
  const v = loaded.value;
  // The layout-diff report carries no ok flag of its own; a wrapper that adds one must set it true.
  if ('ok' in v && v.ok !== true) return { error: 'G5: gate did not pass (ok is not true)' };
  if (!Number.isInteger(v.changedUsedClasses) || !Array.isArray(v.changedUsed)) {
    return { error: 'G5: not a layout-diff report (changedUsedClasses / changedUsed missing)' };
  }
  if (v.changedUsed.some((c) => !isObj(c) || typeof c.class !== 'string' || c.class === '')) {
    return { error: 'G5: changedUsed rows need a class name' };
  }
  if (v.changedUsedClasses !== v.changedUsed.length) return { error: 'G5: changedUsedClasses disagrees with changedUsed' };
  return { usedChanged: v.changedUsed.map((c) => c.class) };
}

// Fail closed: only an exactly well-formed file with enabled === true passes.
export function checkAutopilot(loaded) {
  const bad = checkEnvelope('autopilot', loaded);
  if (bad) return { error: bad };
  const v = loaded.value;
  if (typeof v.enabled !== 'boolean') return { error: 'autopilot: enabled is not a boolean' };
  if (!Array.isArray(v.paths) || v.paths.some((p) => !VALID_PATHS.includes(p))) {
    return { error: 'autopilot: paths must be a list drawn from M, B, C' };
  }
  if (!Number.isInteger(v.max_releases_per_day) || v.max_releases_per_day < 0) {
    return { error: 'autopilot: max_releases_per_day is not a non-negative integer' };
  }
  return { enabled: v.enabled, paths: v.paths, maxPerDay: Math.min(v.max_releases_per_day, LIMITS.maxReleasesPerDay) };
}

// Returns a list of reasons the rate limits forbid a release now.
// rollForward: an owner-dispatched re-publish of a CL's feed (a newer seq that
// replaces a bad one); the one-per-CL limit does not apply, the others do.
export function checkRateLimits({ historyLoaded, repo, cl, path, nowMs, maxPerDay, rollForward = false }) {
  const bad = checkEnvelope('history', historyLoaded);
  if (bad) return [bad];
  const h = historyLoaded.value;
  if (!Array.isArray(h.releases) || !isObj(h.attempts ?? {})) return ['history: malformed (need releases[] and attempts{})'];
  const mine = [];
  for (const r of h.releases) {
    const at = isObj(r) && typeof r.at === 'string' ? Date.parse(r.at) : NaN;
    if (!isObj(r) || typeof r.repo !== 'string' || !isCl(r.cl) || Number.isNaN(at)) {
      return ['history: malformed release entry'];
    }
    if (r.repo === repo) mine.push({ cl: r.cl, at });
  }
  const reasons = [];
  const sameCl = mine.filter((r) => r.cl === cl).length;
  if (!rollForward && sameCl >= LIMITS.maxReleasesPerClPerRepo) reasons.push(`rate limit: ${repo} already released for CL-${cl}`);
  // A release dated in the future counts as recent, never as old.
  const lastDay = mine.filter((r) => nowMs - r.at < DAY_MS).length;
  if (lastDay >= maxPerDay) reasons.push(`rate limit: ${lastDay} ${repo} releases in the last 24 h (limit ${maxPerDay})`);
  const newest = mine.reduce((m, r) => Math.max(m, r.at), -Infinity);
  if (nowMs - newest < LIMITS.minGapMinutes * 60 * 1000) {
    reasons.push(`rate limit: last ${repo} release is less than ${LIMITS.minGapMinutes} minutes old`);
  }
  if (path === 'B') {
    const n = (h.attempts ?? {})[cl];
    if (n !== undefined && (!Number.isInteger(n) || n < 0)) return ['history: attempts entry is malformed'];
    if ((n ?? 0) >= LIMITS.maxAttemptsPerCl) reasons.push(`rate limit: ${n} auto-fix attempts already used for CL-${cl} (limit ${LIMITS.maxAttemptsPerCl})`);
  }
  return reasons;
}

// inputs: { repo, now (ms), autopilot, g1, g2, g3, g4, g5, history }, each gate a loadJson() result.
export function decide(inputs) {
  const reasons = [];
  const notes = [];
  const fail = (msg) => reasons.push(msg);
  const out = (decision, path, cl) => ({
    decision, path, cl: cl ?? null, repo: inputs.repo ?? null, ship: decision === 'M' || decision === 'B',
    reasons, notes,
  });

  if (typeof inputs.repo !== 'string' || inputs.repo === '') fail('repo name missing');
  if (!Number.isFinite(inputs.now)) fail('clock value invalid');

  const ap = checkAutopilot(inputs.autopilot);
  if (ap.error) fail(ap.error);
  else if (!ap.enabled) fail('autopilot is disabled (enabled is not true)');

  const g1 = checkSimpleGate('G1 compile', inputs.g1);
  const g2 = checkSimpleGate('G2 interface', inputs.g2);
  const g3 = checkG3(inputs.g3);
  const g4 = checkG4(inputs.g4);
  const g5 = checkG5(inputs.g5);
  for (const g of [g1, g2, g3, g4, g5]) if (g.error) fail(g.error);

  // Without a usable gate picture there is no path to name.
  if (g3.error || g4.error || g5.error || g1.error || g2.error) return out('HOLD', null, g3.cl);

  // The four globals must be re-resolved from the new exe: the map rows carry them.
  if (g4.globalsError) {
    fail(g4.globalsError);
    return out('HOLD', null, g3.cl);
  }
  let path = 'M';
  if (g5.usedChanged.length > 0) {
    path = 'C';
    fail(`path C held until shadow mode is proven: ${g5.usedChanged.length} used class(es) changed layout (${g5.usedChanged.slice(0, 5).join(', ')})`);
  } else if (g4.missed.length > 0) {
    path = 'B';
    notes.push(`required pattern(s) missed: ${g4.missed.join(', ')}`);
  }
  if (g4.softMissed.length > 0) notes.push(`non-required pattern(s) not OK: ${g4.softMissed.join(', ')}`);

  // Only path M ships new global values (as map rows); any other path would
  // ship the SDK's stale ones.
  if (g4.globalsMoved.length > 0) {
    if (path === 'M') notes.push(`SDK global offsets moved (the map carries the new values): ${g4.globalsMoved.join(', ')}`);
    else fail(`SDK global offsets moved, which only path M carries: ${g4.globalsMoved.join(', ')}`);
  }

  if (path === 'C') return out('HOLD', 'C', g3.cl);
  if (!ap.error && !ap.paths.includes(path)) fail(`path ${path} is not enabled in autopilot.paths`);

  const limited = checkRateLimits({
    historyLoaded: inputs.history, repo: inputs.repo, cl: g3.cl, path, nowMs: inputs.now,
    maxPerDay: ap.error ? 0 : ap.maxPerDay,
  });
  limited.forEach(fail);

  if (reasons.length > 0) return out('HOLD', path, g3.cl);
  return out(path, path, g3.cl);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) throw new Error(`bad argument: ${argv[i]}`);
    a[argv[i].slice(2)] = argv[i + 1];
  }
  return a;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: decide.mjs --repo <name> --autopilot f --g1 f --g2 f --g3 f --g4 f --g5 f --history f [--now iso] [--out f]`);
    process.exit(2);
  }
  let result;
  try {
    const now = args.now === undefined ? Date.now() : Date.parse(args.now);
    result = decide({
      repo: args.repo, now,
      autopilot: loadJson(args.autopilot),
      g1: loadJson(args.g1), g2: loadJson(args.g2), g3: loadJson(args.g3),
      g4: loadJson(args.g4), g5: loadJson(args.g5), history: loadJson(args.history),
    });
  } catch (e) {
    result = { decision: 'HOLD', path: null, cl: null, repo: args.repo ?? null, ship: false, reasons: [`internal error: ${e.message}`], notes: [] };
  }
  const text = JSON.stringify(result, null, 2) + '\n';
  if (args.out) writeFileSync(args.out, text);
  process.stdout.write(text);
  process.exit(result.decision === 'M' ? 0 : result.decision === 'B' ? 10 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
