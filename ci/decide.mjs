#!/usr/bin/env node
// decide.mjs: turn the gate results for one game build into a release path.
//
//   node ci/decide.mjs --repo ModLoader --autopilot state/autopilot.json \
//       --g1 g1.json --g2 g2.json --g3 g3.json --g4 g4.json --g5 g5.json --plugins plugins.json \
//       [--fields field-rows.json] --history history.json [--now 2026-10-29T12:00:00Z] [--out decision.json]
//       [--other-cl 129402]
//
// Prints the decision as JSON on stdout. Exit codes: 0 = path M (map-only update: the
// rows go into the loader's map and ship as a signed feed), 10 = path B (auto-fix of
// a plugin's patterns), 1 = HOLD, 2 = usage error. Anything else, including a crash,
// means do not ship.
//
// Decision table (the first row that applies wins):
//   autopilot unreadable, malformed or enabled != true  -> HOLD (see --candidate and --test-autopilot below)
//   a gate result missing, unreadable, malformed, or reporting an error -> HOLD
//   G1 compile or G2 interface not ok                    -> HOLD
//   a plugin that is unverified or the loader would refuse -> that plugin is held alone, the rest proceed
//     (judged against the candidate map; the decision lists the plugins the loader refuses on
//     this build as `expectRefused`, the client rig's expect_refused input; see checkPlugins)
//   --other-cl N, the CL the OTHER Steam branch runs: the decision also lists `expectRefusedOther`,
//     the plugins the loader's own rule predicts refused on that CL (the other branch's rig input;
//     see expectedRefusals). Nothing else reads it: a CL the pipeline cannot name is not passed,
//     and the list is then empty, so every refusal on that branch is unexpected and fails the rig.
//   G3 CL not a forward CL (equal or lower than before)  -> HOLD
//   GObjects, GNames, AppendString or GWorld not resolved (G4 scan) -> HOLD, no path
//   a used class moved (G5 usedChanged non-empty) and the field rows do not
//     settle every one of them (--fields)                -> HOLD, path C (held until shadow mode is proven)
//   a field-rows report given and not written cleanly    -> HOLD (a gone key not marked
//     optional, a class size change, a native key not found)
//   a required pattern missed (G4 requiredFailing > 0)   -> B, if autopilot.paths has B
//   everything clean                                     -> M, if autopilot.paths has M
//   an SDK global moved (rva != sdkRva) on a path but M  -> HOLD (on M it is a note)
//   chosen path not in autopilot.paths                   -> HOLD
//   rate limit hit (section 8 of the design)             -> HOLD
//
// --candidate (the unattended map-mode chain, which never publishes): a disabled
// autopilot holds PUBLISHING only. The decision is still HOLD with the reason
// "autopilot is disabled (enabled is not true)", and `wouldBe` names the path every
// other check reached, so the caller can tell "only the autopilot holds" (wouldBe M)
// from a real hold (wouldBe HOLD). The caller then builds the candidate (feed, stage,
// push) but nothing of it is publishable: the decision is not M. An unreadable or
// malformed autopilot file, and every other HOLD reason, hold as always.
// --test-autopilot is the same for a dispatched test run and also marks the result `test`.
//
// Gate result shapes:
//   G1, G2: { "ok": true }                         ("error": "..." or ok != true means HOLD)
//   G3:     { "ok": true, "cl": "127999", "previousCl": "127004" }   previousCl = the CL the source requires today
//   G4:     the raw `sr-aobscan --json` output of the CLIENT exe (target "client"). The
//           client check alone decides: a dedicated server build, when one exists for the
//           CL, is scanned for information only and is never a gate. G4 must hold one
//           row each for GObjects, GNames, AppendString and GWorld (an optional "X::"
//           prefix and " (...)" suffix on the name are fine; the client scan marks them
//           optional, so "required" is not read). A matched row carries its resolved "rva" and may carry "sdkRva",
//           the offset the SDK (Basic.hpp Offsets::) bakes in today. They differ after a game
//           update; only path M ships the new value (as a map row), so a difference is
//           a note on M and a HOLD on any other path.
//   G5:     the `layout-diff.mjs diff --used ...` report: { "changedUsedClasses": n, "changedUsed": [{ "class": "UFoo" }, ...] }
//   plugins: the client check's plugin verdicts (result.json `plugins`): { "status": "pass",
//           "plugins": [{ "name": "WAILA", "verdict": "PASS" }, ...] }. Every plugin must be
//           PASS, NONE (no load hooks) or GAME-CALL (partial coverage: a note) are updated;
//           FAIL is updated and degraded. Any other verdict (CRASH, ERROR, BUILD-FAILED,
//           FETCH-FAILED, REFUSED, RULE3, OFFSETS, OFFSETS-UNCHECKED) holds that plugin alone
//           on its last release; the others proceed (checkPlugins). The status must agree
//           with the rows.
//   fields: the `field-rows.mjs write --report` report for the same CL: { "written": true,
//           "cl": 128786, "covered": ["UFoo", ...], "absent": [{ "key": "UFoo::Gone", "owners": [...] }],
//           "problems": [] }. When it was written with no problems and covers every class G5
//           lists, the moved layouts ship as map rows (or absent rows for keys marked
//           optional, which the plugins fall back on) and the path stays M.
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
  if (v.target !== 'client') return { error: `G4: scan target is ${JSON.stringify(v.target)}, expected "client" (the client check decides; a server scan is never a gate)` };
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
// from the new exe: one pattern row each in the G4 scan, matched (OK) with a
// non-zero resolved "rva". Absent, duplicated or unmatched is a HOLD. A resolved value that differs from the SDK's baked "sdkRva" is listed as
// moved: a note on path M, a HOLD on any other (see decide()).
const hexValue = (v) => (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? BigInt(v) : null);

function checkSdkGlobals(rows) {
  const problems = [];
  const moved = [];
  for (const key of SDK_GLOBALS) {
    const hits = rows.filter((p) => p.name.replace(/ \(.*\)$/, '').replace(/^.*::/, '').toLowerCase() === key.toLowerCase());
    if (hits.length === 0) { problems.push(`${key}: no pattern in the scan, so the offset is not re-resolved`); continue; }
    if (hits.length > 1) { problems.push(`${key}: ${hits.length} pattern rows, expected one`); continue; }
    const row = hits[0];
    if (row.result !== 'OK') problems.push(`${key}: did not resolve (${row.result})`);
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

// The plugin verdicts of the client check, per plugin. Returns { error } or
// { list, wholeHold, partial }:
//   PASS, NONE, GAME-CALL  updated
//   FAIL                   updated, degraded: a pattern it resolves is missing,
//                          the loader turns that request off
//   FAIL + exception code held, this plugin only (owner's rule): a plugin that crashes in the
//                          check (0xC0000005 or any exception code) stays on its last release.
//                          Not when the scanner says the stop was its own one-entry hooks table
//                          (HARNESS_LIMIT): that is the harness, and the plugin degrades as FAIL does.
//                          Never the probe's planned stop (PLANNED_STOP): the probe ends PluginInit
//                          there on purpose and prints the same 0xC0000005 for a plugin that passes
//   FAIL + planned stop    judged against the CANDIDATE map: a refusal for a row the candidate
//                          supplies (the field rows, `fields.rows`) is settled and holds nothing. What
//                          the candidate does not fix (a pattern that is not OK, a refusal for a
//                          key it has no row for) holds that plugin alone, on its last release
//   a plugin the loader refuses on this CL (loaderRefusal)
//                          held, this plugin only, whatever the scan says: the loader frees it at
//                          load, before it scans, so a missing pattern or a degrade is moot and
//                          no patch or row from the suggester can change it
//   REFUSED                held, this plugin only: it cannot load on the new CL
//                          (interface version, or no built CL), whatever the map
//                          says; it goes to the rebuild path
//   RULE3                  held, this plugin only: it declares PLUGIN_MAP_MIGRATED but reads
//                          game-class members directly (tools/rule3-check.mjs in the Plugin SDK).
//                          Never a whole hold: the other plugins and the loader are unaffected
//   CRASH, ERROR,          held, this plugin only (vmap review B5): it crashed, did not build or
//   BUILD-FAILED,          could not be fetched, or was not verified (a fixed offset that differs
//   FETCH-FAILED,          from the PDB, or could not be checked). It stays on its last release,
//   OFFSETS,               which the loader refuses on the new CL like REFUSED, and every other
//   OFFSETS-UNCHECKED      plugin proceeds
//   anything else          (a verdict this file does not know) holds the whole update
const PLUGIN_OK = new Set(['PASS', 'NONE', 'GAME-CALL']);
const PLUGIN_DEGRADED = new Set(['FAIL']);
const PLUGIN_HELD = new Set(['REFUSED', 'RULE3', 'CRASH', 'ERROR', 'BUILD-FAILED', 'FETCH-FAILED', 'OFFSETS', 'OFFSETS-UNCHECKED']);
const EXCEPTION_CODE = /0x[cC][0-9a-fA-F]{7}\b|\bexception\s+0x[0-9a-fA-F]+/;
const NO_ROW = /refused: no row for CL-\d+/;
const HARNESS_LIMIT = /outside the one table it was given/;
// The scanner's own words for the probe ending PluginInit when it reached for a hook the probe
// does not provide. The code in brackets is that planned stop, not a fault of the plugin.
const PLANNED_STOP_SRC = 'the probe ended PluginInit there, as planned, when it reached for a hook the probe does not provide(?: \\(0x[0-9a-fA-F]+\\))?';
const plannedStop = (p) => typeof p.note === 'string' && new RegExp(PLANNED_STOP_SRC).test(p.note);
function crashedInCheck(p) {
  const text = [p.note, p.crash, p.summary, p.error].filter((x) => typeof x === 'string').join(' ').replace(new RegExp(PLANNED_STOP_SRC, 'g'), '');
  return EXCEPTION_CODE.test(text) && !HARNESS_LIMIT.test(text);
}

// The loader's rule for a plugin on a build other than the one its SDK came from, as
// VersionMap::OffBuildRefusal and ReadPluginGameBuild do it (StarRupture-ModLoader
// memory_scanner/version_map.cpp; called from plugins/plugin_manager.cpp at DLL load, before
// OnPluginLoadHooks): a plugin is judged against the build it was made on. Interface v70 and v71
// have no game-build tail, so they count as built on CL-127004; a v72 or newer plugin names its
// build (gameBuiltCL). Off that build the loader refuses the plugin, unless it is at least
// interface v72 and declares PLUGIN_MAP_MIGRATED.
//   interface version, build  the scanner's `plugin` block: { interfaceVersion, gameBuild: "CL-127004"
//                             or "CL-127004 (none declared)" }
//   migrated flag             not in the scan output. The plugin build job's rule3.json carries it
//                             (rule3.migrated), for plugins built here; a released DLL has none. And
//                             the scanner runs the loader's own check at the start of its probe and
//                             puts the refusal in `note` ("Needs an update to run on CL-N: ..."). That is
//                             the loader's own answer, used when the fields above cannot say (a v72+
//                             plugin of a released DLL, whose flag is not visible).
// Returns the plain reason, or null when the loader lets it load (or the fields cannot say).
const LEGACY_PLUGIN_CL = 127004;
const FIRST_MAP_INTERFACE = 72;
const LOADER_NOTE = /^Needs an update to run on CL-(\d+): (.+?)(?:, so it would read this game's data|$)/;
export function loaderRefusal(p, cl) {
  const running = Number(cl);
  if (!isObj(p) || cl === null || cl === undefined || !Number.isInteger(running) || running <= 0) return null;
  return refusalFromFields(p, running) ?? refusalFromNote(p, running);
}

function refusalFromNote(p, running) {
  const note = typeof p.note === 'string' ? LOADER_NOTE.exec(p.note) : null;
  return note && Number(note[1]) === running ? `${note[2].replace(/\.$/, '')}, needs its author's update` : null;
}

function refusalFromFields(p, running) {
  const info = p.plugin;
  if (!isObj(info) || !Number.isInteger(info.interfaceVersion)) return null;
  const v = info.interfaceVersion;
  const named = /^CL-(\d+)/.exec(String(info.gameBuild ?? ''));
  const declared = v >= FIRST_MAP_INTERFACE && named !== null && !/none declared/.test(String(info.gameBuild));
  const built = v < FIRST_MAP_INTERFACE || !named ? LEGACY_PLUGIN_CL : Number(named[1]);
  const migrated = v >= FIRST_MAP_INTERFACE && isObj(p.rule3) && typeof p.rule3.migrated === 'boolean' ? p.rule3.migrated : null;
  if (migrated === true && !declared) return "it declares PLUGIN_MAP_MIGRATED but names no game build, needs its author's update";
  if (built === running) return null;
  if (v < FIRST_MAP_INTERFACE) return `plugin interface v${v}, needs its author's update`;
  if (migrated === false) return "it does not declare PLUGIN_MAP_MIGRATED, needs its author's update";
  return null;
}

// The plugins the loader's own rule predicts refused on a build the check did not scan: the
// OTHER Steam branch's current CL. Plugin metadata (interface version, the build it was made on,
// the migrated flag where known) does not depend on the branch, so the rows of this check's scan
// are judged with loaderRefusal against that CL. What is specific to the scanned build (the
// scanner's REFUSED verdict, a probe note about another CL) says nothing here: loaderRefusal
// reads a note only for the CL it names. A plugin whose fields cannot say is not listed, so a
// refusal the rule does not predict stays unexpected and fails the rig.
export function expectedRefusals(rows, cl) {
  if (!Array.isArray(rows)) return [];
  const names = rows.filter((p) => isObj(p) && typeof p.name === 'string' && p.name !== '' && loaderRefusal(p, cl)).map((p) => p.name);
  return [...new Set(names)].sort();
}

function checkPlugins(loaded, rowKeys = new Set(), cl = null) {
  const bad = checkEnvelope('plugins', loaded);
  if (bad) return { error: bad };
  const v = loaded.value;
  if (!Array.isArray(v.plugins)) return { error: 'plugins: no plugins list (the client check wrote no verdicts)' };
  if (v.plugins.some((p) => !isObj(p) || typeof p.name !== 'string' || p.name === '' || typeof p.verdict !== 'string' || p.verdict === '')) {
    return { error: 'plugins: a row needs a name and a verdict' };
  }
  const failing = v.plugins.filter((p) => !PLUGIN_OK.has(p.verdict));
  if ((v.status === 'pass') !== (failing.length === 0)) return { error: `plugins: status ${JSON.stringify(v.status)} disagrees with the verdicts` };
  const why = (p) => `${p.verdict}${p.note ? ` (${String(p.note).slice(0, 120)})` : ''}`;
  const list = v.plugins.map((p) => {
    const e = { name: p.name, verdict: p.verdict, status: 'updated', degraded: [], reasons: [] };
    const refusal = p.verdict === 'REFUSED' ? null : loaderRefusal(p, cl);
    if (refusal || p.verdict === 'REFUSED') e.refusedByLoader = true;
    if (refusal && (PLUGIN_OK.has(p.verdict) || PLUGIN_DEGRADED.has(p.verdict))) {
      // The loader frees such a plugin at load, before it scans: what the scan found is moot,
      // and the suggester's patch for another author's plugin stays a patch, never a map row.
      e.status = 'held';
      e.heldAlone = true;
      e.reasons.push(`refused by the loader on CL-${cl}: ${refusal}`);
    } else if (PLUGIN_DEGRADED.has(p.verdict)) {
      // What the candidate map does not fix. A request refused for lack of a row on this CL
      // is settled when map mode wrote that row (the players get the compiled map plus these rows).
      const unsettled = [];
      const seen = new Set();
      const add = (key, severity, text, noRow) => { if (!seen.has(key)) { seen.add(key); unsettled.push({ key, severity, why: text, noRow }); } };
      for (const r of Array.isArray(p.patterns) ? p.patterns : []) {
        if (isObj(r) && r.recorded && r.result !== 'OK') add(String(r.name), r.required === false ? 'low' : 'high', `pattern ${r.result}`, false);
      }
      for (const f of Array.isArray(p.failures) ? p.failures : []) {
        if (!isObj(f)) continue;
        const key = String(f.name);
        const noRow = NO_ROW.test(String(f.detail ?? ''));
        if (noRow && rowKeys.has(key)) continue;
        add(key, f.required === false ? 'low' : 'high', String(f.detail ?? 'refused').slice(0, 160), noRow);
      }
      const listed = Array.isArray(p.failures) && p.failures.length > 0;
      if (crashedInCheck(p)) {
        e.status = 'held';
        e.heldAlone = true;
        e.reasons.push(`crashed in the check, stays on its last release: ${why(p)}`);
      } else if (plannedStop(p) && (unsettled.length > 0 || !listed)) {
        // The probe's planned stop is a pass; what is left is the candidate's gap, or a FAIL
        // nothing explains. Either way the loader refuses the plugin, so it is held alone.
        e.status = 'held';
        e.heldAlone = true;
        const first = unsettled[0];
        e.reasons.push(!first ? "FAIL with no failure listed after the probe's planned stop, stays on its last release"
          : first.noRow ? `refused: required key ${first.key} has no map row, stays on its last release`
            : `refused: ${first.key}: ${first.why}, stays on its last release`);
      } else {
        e.degraded.push(...unsettled.map(({ key, severity, why: text }) => ({ key, severity, why: text })));
        // Nothing left to name: the verdict was only the probe's planned stop, or
        // the refusals map mode settled. With no failures listed, say so.
        if (!e.degraded.length && !listed) e.degraded.push({ key: '(a pattern)', severity: 'high', why: HARNESS_LIMIT.test(String(p.note ?? '')) ? 'FAIL with no failure listed' : why(p) });
      }
    } else if (PLUGIN_HELD.has(p.verdict)) {
      e.status = 'held';
      e.heldAlone = true;
      e.reasons.push(p.verdict === 'RULE3'
        ? `declares PLUGIN_MAP_MIGRATED but reads game members directly, stays on its last release: ${why(p)}`
        : p.verdict === 'REFUSED'
          ? `cannot load on the new CL: ${why(p)}; rebuild path`
          : `not verified on the new CL, stays on its last release: ${why(p)}`);
    } else if (!PLUGIN_OK.has(p.verdict)) {
      e.status = 'held';
      e.reasons.push(why(p));
    }
    return e;
  });
  return {
    list,
    wholeHold: v.plugins.filter((p) => !PLUGIN_OK.has(p.verdict) && !PLUGIN_DEGRADED.has(p.verdict) && !PLUGIN_HELD.has(p.verdict)).map((p) => `${p.name} ${why(p)}`),
    partial: v.plugins.filter((p) => p.verdict === 'GAME-CALL').map((p) => p.name),
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

// The field rows settle a moved used class when the report is for this CL, was
// written with no problems, and lists the class as covered. Returns the classes
// it does not settle (all of them when the report is unusable) and why.
function checkFields(loaded, cl, classes) {
  if (loaded === undefined) return { uncovered: classes, why: 'no field-rows report was given' };
  const bad = checkEnvelope('fields', loaded);
  if (bad) return { uncovered: classes, why: bad };
  const v = loaded.value;
  if (v.written !== true || !Array.isArray(v.problems) || v.problems.length > 0 || !Array.isArray(v.covered)) {
    const n = Array.isArray(v.problems) ? v.problems.length : 0;
    const first = n ? `: ${String(v.problems[0]).slice(0, 200)}${n > 1 ? ` (and ${n - 1} more)` : ''}` : '';
    return { uncovered: classes, why: `the field rows were not written${first}` };
  }
  if (String(v.cl) !== cl) return { uncovered: classes, why: `the field-rows report is for CL-${v.cl}, not CL-${cl}` };
  const covered = new Set(v.covered);
  const uncovered = classes.filter((c) => !covered.has(c));
  const absent = (Array.isArray(v.absent) ? v.absent : []).filter(isObj)
    .map((a) => `${a.key}${Array.isArray(a.owners) && a.owners.length ? ` (${a.owners.join(', ')})` : ''}`);
  return { uncovered, why: uncovered.length ? 'no field row settles them' : null, absent };
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

// inputs: { repo, now (ms), autopilot, g1, g2, g3, g4, g5, plugins, fields?, history }, each a loadJson()
// result, testAutopilot (a dispatched test run: the decision is still HOLD while autopilot is disabled,
// and `wouldBe` says what it would be with autopilot on) and candidate (the unattended chain: the same,
// without the `test` mark).
export function decide(inputs) {
  const reasons = [];
  const notes = [];
  let disabled = false;
  let perPlugin = [];
  const fail = (msg) => reasons.push(msg);
  const out = (decision, path, cl) => {
    const r = {
      decision, path, cl: cl ?? null, repo: inputs.repo ?? null, ship: decision === 'M' || decision === 'B',
      reasons, notes, plugins: perPlugin,
      pluginsOk: perPlugin.length > 0 && perPlugin.every((p) => p.status === 'updated' || p.heldAlone === true),
      // The plugins the loader refuses on this build, sorted: the client rig's expect_refused input.
      expectRefused: perPlugin.filter((p) => p.refusedByLoader === true).map((p) => p.name).sort(),
    };
    // The other branch's build: the same rule on that CL (--other-cl). On the very CL this check
    // scanned, the scanned verdicts apply too, so the two lists are then the same.
    if (inputs.otherCl !== undefined && inputs.otherCl !== null) {
      r.otherCl = Number(inputs.otherCl);
      r.expectRefusedOther = r.otherCl === Number(cl) ? r.expectRefused : expectedRefusals(inputs.plugins?.value?.plugins, r.otherCl);
    }
    if (inputs.testAutopilot || inputs.candidate) {
      if (inputs.testAutopilot) r.test = true;
      else r.candidate = true;
      r.wouldBe = decision;
      if (disabled) {
        r.decision = 'HOLD';
        r.ship = false;
        r.reasons = ['autopilot is disabled (enabled is not true)', ...reasons];
      }
    }
    return r;
  };

  if (typeof inputs.repo !== 'string' || inputs.repo === '') fail('repo name missing');
  if (!Number.isFinite(inputs.now)) fail('clock value invalid');

  const ap = checkAutopilot(inputs.autopilot);
  if (ap.error) fail(ap.error);
  else if (!ap.enabled && (inputs.testAutopilot || inputs.candidate)) disabled = true;
  else if (!ap.enabled) fail('autopilot is disabled (enabled is not true)');

  const g1 = checkSimpleGate('G1 compile', inputs.g1);
  const g2 = checkSimpleGate('G2 interface', inputs.g2);
  const g3 = checkG3(inputs.g3);
  const g4 = checkG4(inputs.g4);
  const g5 = checkG5(inputs.g5);
  const plugins = checkPlugins(inputs.plugins, new Set(Array.isArray(inputs.fields?.value?.rows) ? inputs.fields.value.rows : []), g3.cl);
  for (const g of [g1, g2, g3, g4, g5, plugins]) if (g.error) fail(g.error);

  // Without a usable gate picture there is no path to name.
  if (g3.error || g4.error || g5.error || g1.error || g2.error || plugins.error) return out('HOLD', null, g3.cl);

  // Per plugin: one plugin that is held or degraded never holds the others.
  perPlugin = plugins.list;
  const fieldsDegraded = isObj(inputs.fields?.value?.degraded) ? inputs.fields.value.degraded : {};
  for (const [owner, list] of Object.entries(fieldsDegraded)) {
    const e = perPlugin.find((p) => p.name === owner);
    const items = (Array.isArray(list) ? list : []).filter(isObj).map((d) => ({ key: String(d.key), severity: d.severity === 'low' ? 'low' : 'high', why: String(d.why ?? '') }));
    if (e) e.degraded.push(...items);
    else notes.push(`field rows degrade ${owner}, which has no verdict: ${items.map((d) => d.key).join(', ')}`);
  }
  if (plugins.wholeHold.length) fail(`${plugins.wholeHold.length} plugin(s) not verified on CL-${g3.cl}, which the loader cannot turn off: ${plugins.wholeHold.slice(0, 5).join('; ')}`);
  for (const p of perPlugin) {
    if (p.heldAlone) notes.push(`${p.name} held: ${p.reasons.join('; ')}`);
    else if (p.degraded.length) {
      const high = p.degraded.filter((d) => d.severity === 'high');
      notes.push(`${p.name} updated, degraded: ${p.degraded.map((d) => `${d.key} off`).join(', ')}${high.length ? ` (HIGH: ${high.length} required request(s) missing)` : ''}`);
    }
  }
  if (plugins.partial.length) notes.push(`plugin(s) only partly exercised offline (GAME-CALL): ${plugins.partial.join(', ')}`);

  // The four globals must be re-resolved from the new exe: the map rows carry them.
  if (g4.globalsError) {
    fail(g4.globalsError);
    return out('HOLD', null, g3.cl);
  }
  let path = 'M';
  const fields = g5.usedChanged.length > 0 ? checkFields(inputs.fields, g3.cl, g5.usedChanged) : null;
  if (fields && fields.uncovered.length > 0) {
    path = 'C';
    fail(`path C held until shadow mode is proven: ${fields.uncovered.length} used class(es) changed layout and ${fields.why} (${fields.uncovered.slice(0, 5).join(', ')})`);
  } else if (g4.missed.length > 0) {
    path = 'B';
    notes.push(`required pattern(s) missed: ${g4.missed.join(', ')}`);
  }
  // The native members get their rows from the same run: a report that was given
  // and not written cleanly holds whatever moved.
  const fieldsRun = inputs.fields === undefined ? null : checkFields(inputs.fields, g3.cl, []);
  if (fieldsRun?.why) fail(`field rows: ${fieldsRun.why}`);
  if (fields && fields.uncovered.length === 0) {
    notes.push(`${g5.usedChanged.length} used class(es) changed layout, every one settled by the field rows: ${g5.usedChanged.slice(0, 5).join(', ')}`);
  }
  if (fieldsRun && !fieldsRun.why && fieldsRun.absent.length) {
    notes.push(`${fieldsRun.absent.length} member(s) gone on CL-${g3.cl}, each an absent row, so the plugin named turns that feature off: ${fieldsRun.absent.slice(0, 5).join(', ')}`);
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

// --other-cl is a plain CL number; anything else is a usage error, never a guess.
function otherClOf(text) {
  if (!/^[1-9][0-9]{0,9}$/.test(String(text))) throw new Error(`--other-cl is not a CL number: ${text}`);
  return Number(text);
}

function main() {
  let args;
  try {
    const argv = process.argv.slice(2);
    args = parseArgs(argv.filter((a) => a !== '--test-autopilot' && a !== '--candidate'));
    args.testAutopilot = argv.includes('--test-autopilot');
    args.candidate = argv.includes('--candidate');
    if (args['other-cl'] !== undefined) args.otherCl = otherClOf(args['other-cl']);
  } catch (e) {
    console.error(`${e.message}\nusage: decide.mjs --repo <name> --autopilot f --g1 f --g2 f --g3 f --g4 f --g5 f --plugins f [--fields f] --history f [--now iso] [--out f] [--other-cl n] [--test-autopilot | --candidate]`);
    process.exit(2);
  }
  let result;
  try {
    const now = args.now === undefined ? Date.now() : Date.parse(args.now);
    result = decide({
      repo: args.repo, now, testAutopilot: args.testAutopilot, candidate: args.candidate,
      autopilot: loadJson(args.autopilot),
      g1: loadJson(args.g1), g2: loadJson(args.g2), g3: loadJson(args.g3),
      g4: loadJson(args.g4), g5: loadJson(args.g5), plugins: loadJson(args.plugins), history: loadJson(args.history),
      ...(args.fields === undefined ? {} : { fields: loadJson(args.fields) }),
      ...(args.otherCl === undefined ? {} : { otherCl: args.otherCl }),
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
