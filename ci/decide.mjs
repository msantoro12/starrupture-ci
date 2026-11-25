#!/usr/bin/env node
// decide.mjs: turn the gate results for one game build into a release path.
//
//   node ci/decide.mjs --repo ModLoader --autopilot state/autopilot.json \
//       --g1 g1.json --g2 g2.json --g3 g3.json --g4 g4.json --g5 g5.json --plugins plugins.json \
//       [--fields field-rows.json] --history history.json [--out decision.json]
//       [--other-cl 129402 | --other-unmapped "public runs build 123"] [--rig-plugins rig-plugins.json]
//       [--first-publish] [--rehearsal]
//       [--loader-header version_map.generated.h --published version-map-client.v1.txt [--buildid 123]] [--supersede <seq>]
//
//   node ci/decide.mjs identity --repo ModLoader --cl 129402 [--buildid 123] [--loader-header f] [--published f] [--feed f]
//       [--supersede <seq> --history f] --report identity.json
//       (the version identity check on its own: the chain runs it on the candidate feed, the publish job on the feed it is
//       about to sign. Writes { ok, reasons }; exit 0 ok, 3 hold, 2 usage.)
//
//   node ci/decide.mjs hold --report published-base.json [--decision decision.json] [--repo ModLoader] [--cl 129402] [--out decision.json]
//       (the published file could not be the base, or a published row was lost: the decision is HOLD with those
//       reasons first; given --decision, that decision's own reasons follow. Exit 0, 2 on a usage error.)
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
//     (judged against the candidate map)
//   --rig-plugins f, the facts of the DLLs the client rig will run (the check's rig-plugins.json:
//     the released plugins and the reviewed ones of other authors, not the builds judged above): the
//     decision lists the plugins the loader refuses on this build as `expectRefused`, the rig's
//     expect_refused input for the branch this check is for. Computed from those DLLs only, by the
//     same loader rule (see loaderRefusal). Without the file, or for a DLL whose facts could not be
//     read, nothing is declared, so a refusal of it fails the rig loudly.
//   --other-cl N, the CL the OTHER Steam branch runs: the decision also lists `expectRefusedOther`,
//     the plugins the loader's own rule predicts refused on that CL for the same DLLs (the other
//     branch's rig input; see expectedRefusals). Nothing else reads it: a CL the pipeline cannot name
//     is not passed, and the list is then empty, so every refusal on that branch is unexpected and
//     fails the rig.
//   --other-unmapped "<branch> runs build <id>", the other Steam branch's build when the candidate map has no
//     row for it (so no CL to give --other-cl): the decision lists `expectDeclineOther: true`, the
//     other branch's rig input expect_decline, and a note naming the expectation. The rig then passes
//     if the loader declines cleanly there (the version-mismatch line, no plugin loaded, no crash,
//     the game still running) or boots on the newest known build's checked values (loader v1.26.0 and
//     later; ci/verdict.ps1 -Client) and fails otherwise. Not with --other-cl.
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
//   release limit hit (section 8 of the design; a proof run skips the once-per-CL limit only) -> HOLD
//   --loader-header and --published given (a run that can publish): a CL or build that the released loader's
//     header or the published version object map already holds is not released again -> HOLD. A proof run, a
//     first publish, a rehearsal and a test run skip this. There is no clock in any of these checks: a release
//     is stopped by what was released and what is served, never by how long ago it was (owner, 2026-11-19).
//   --supersede <seq> (a hand dispatch of sr-watch only): a second release of an already released CL, when our own
//     release was bad. The seq must be the one the published file serves now and the history must hold a
//     release of this CL signed with it. It lifts the already-released reasons for that CL (the once-per-CL
//     limit and the two checks above) and nothing else; the candidate must still change what is served
//     (the `identity` subcommand), and every other gate and limit stands.
//
// --candidate (the unattended map-mode chain, which never publishes): a disabled
// autopilot holds PUBLISHING only. The decision is still HOLD with the reason
// "autopilot is disabled (enabled is not true)", and `wouldBe` names the path every
// other check reached, so the caller can tell "only the autopilot holds" (wouldBe M)
// from a real hold (wouldBe HOLD). The caller then builds the candidate (feed, stage,
// push) but nothing of it is publishable: the decision is not M. An unreadable or
// malformed autopilot file, and every other HOLD reason, hold as always.
// --test-autopilot is the same for a dispatched test run and also marks the result `test`.
// --first-publish (the dispatch-only first publish of the feed, never with --test-autopilot): for
// that one run the autopilot is taken as on for path M and state/autopilot.json is not consulted,
// and G3 accepts a CL that is not newer than the header's (the header already maps it) when the G3 result says "firstPublish":
// true as well. Neither half does anything alone. The file is never written. The result carries
// `firstPublish`. Every other gate, the plugin verdicts and the release limits apply as always.
// --rehearsal (sr-watch's hand-started rehearsal, never with --test-autopilot or --first-publish): the
// already-released checks are not applied, so a build that is already released can go through
// the whole chain; every other reason, the autopilot included, holds as always. The result carries
// `rehearsal`, and the publish job signs it only for a run that is a rehearsal itself.
//
// Gate result shapes:
//   G1, G2: { "ok": true }                         ("error": "..." or ok != true means HOLD)
//   G3:     { "ok": true, "cl": "127999", "previousCl": "127004" }   previousCl = the CL the source requires today
//           ("proof": true, an owner's proof run only: it re-runs a CL the header already maps, which the
//           client check verified, so any CL passes, and the once-per-CL limit is skipped for it, no other
//           limit; "firstPublish": true counts only together with
//           --first-publish: the header already maps the CL this run publishes, so it is not newer)
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
// History (what was released), keyed by version identity, one entry per repo and CL (ci/vmap-history.mjs
// holds the shape, the writers and the tolerant read of the old array shape):
//   { "releases": { "ModLoader:127004": { "repo": "ModLoader", "cl": "127004", "at": "<ISO time>", "seq": 1792000000 } },
//     "attempts": { "<cl>": [{ "run": "<id>", "outcome": "rejected" | "infra" }, { "reset": true, ... }] } }
// Only "rejected" attempts count toward maxAttemptsPerCl, and a reset record starts the count again. A history
// that names one identity twice, or one JSON key twice, is refused.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildIdOf, feedDelta, parse, parseFeed, parseSignedFeedRows } from './version-map.mjs';
import { countedAttempts, loadHistory, readHistory } from './vmap-history.mjs';

// Section 8 limits. None of them reads a clock: a release is stopped by what was released and what is served
// (the version identity), never by how long ago it was (owner, 2026-11-19).
export const LIMITS = Object.freeze({
  maxAttemptsPerCl: 2,
  maxReleasesPerClPerRepo: 1,
});
const VALID_PATHS = ['M', 'B', 'C'];
export const SDK_GLOBALS = Object.freeze(['GObjects', 'GNames', 'AppendString', 'GWorld']);

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

// supersede: the run carries a supersede input. G3 then does not hold a CL that equals previousCl (the loader's
// header already maps it, which is how a CL stands once the loader's change for it has merged): it is returned as
// notNewer, and decide() holds it unless the supersede passes its own checks. A CL older than previousCl holds as ever.
function checkG3(loaded, { firstPublish = false, supersede = false } = {}) {
  const bad = checkEnvelope('G3', loaded);
  if (bad) return { error: bad };
  const v = loaded.value;
  if (v.ok !== true) return { error: 'G3: gate did not pass (ok is not true)' };
  if (!isCl(v.cl)) return { error: 'G3: cl is missing or not a plain number' };
  if (!isCl(v.previousCl)) return { error: 'G3: previousCl is missing or not a plain number' };
  const bypass = v.proof === true || (firstPublish && v.firstPublish === true);
  if (!bypass && Number(v.cl) <= Number(v.previousCl)) {
    const why = `G3: CL-${v.cl} is not newer than CL-${v.previousCl}`;
    if (supersede && Number(v.cl) === Number(v.previousCl)) return { cl: v.cl, proof: false, notNewer: why };
    return { error: why };
  }
  return { cl: v.cl, proof: v.proof === true };
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
//   NOT-SCANNED            held, this plugin only: its DLL may not reach the scanner
//                          (ci/scan-gate.ps1), so it was never run and nothing says it works
//   anything else          (a verdict this file does not know) holds the whole update
const PLUGIN_OK = new Set(['PASS', 'NONE', 'GAME-CALL']);
const PLUGIN_DEGRADED = new Set(['FAIL']);
const PLUGIN_HELD = new Set(['REFUSED', 'RULE3', 'CRASH', 'ERROR', 'BUILD-FAILED', 'FETCH-FAILED', 'OFFSETS', 'OFFSETS-UNCHECKED', 'NOT-SCANNED']);
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
// are judged with loaderRefusal against that CL. A probe note about another CL says nothing
// here: loaderRefusal reads a note only for the CL it names. The scanner's REFUSED verdict counts
// on every CL: it means the interface version is outside the range of the loader the scanner was
// built from (sr-aobscan plugin_scan.cpp), which is the candidate loader both rigs run, whatever
// the build. A plugin whose fields cannot say is not listed, so a refusal the rule does not
// predict stays unexpected and fails the rig.
export function expectedRefusals(rows, cl) {
  if (!Array.isArray(rows) || !Number.isInteger(Number(cl)) || Number(cl) <= 0) return [];
  const names = rows.filter((p) => isObj(p) && typeof p.name === 'string' && p.name !== '' && (p.verdict === 'REFUSED' || loaderRefusal(p, cl))).map((p) => p.name);
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
        // The probe's planned stop is a pass; what is left is a shortfall of the candidate, or a FAIL
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
        : p.verdict === 'NOT-SCANNED'
          ? `not scanned: gated, so nothing is known about it on the new CL: ${why(p)}`
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
  return { enabled: v.enabled, paths: v.paths };
}

// The switch alone, read by the publish job right before it signs. That job runs the workflow code of the commit
// it was dispatched from but reads state/autopilot.json from main as it is at that moment, so the file can be a
// newer or older shape than the code expects (a field added or removed since: rehearsal run 44658336245 stopped
// on a field a later change had removed). Only what the switch means is read: `enabled` must be exactly true, and a
// `paths` list, when the file has one, must be a list that includes M. Every other field, known or not, is ignored.
// Fail closed on what it does read: no boolean, or a paths list that is not a list or lacks M, stops the job.
export function checkAutopilotSwitch(loaded) {
  const bad = checkEnvelope('autopilot', loaded);
  if (bad) return { error: bad };
  const v = loaded.value;
  if (typeof v.enabled !== 'boolean') return { error: 'autopilot: enabled is not a boolean' };
  if (v.paths !== undefined && !Array.isArray(v.paths)) return { error: 'autopilot: paths is not a list' };
  return { enabled: v.enabled, pathM: v.paths === undefined || v.paths.includes('M') };
}

// The history's releases of one repo, or a reason. A release carries its repo, its CL and, from the first
// publish on, the seq it was signed with; the time it is stamped with is a record and never read here.
// Fail closed on a history that lists one version identity twice (readHistory refuses it); the old array shape is read as well.
function releasesOf(historyLoaded, repo) {
  const bad = checkEnvelope('history', historyLoaded);
  if (bad) return { error: bad };
  const got = readHistory(historyLoaded.value);
  if (!got.ok) return { error: got.error };
  const mine = Object.values(got.history.releases).filter((r) => r.repo === repo).map((r) => ({ cl: r.cl, seq: r.seq }));
  return { mine, history: got.history };
}

// The owner's explicit way to a second release of a CL when our own release was bad (sr-watch's supersede
// input, a hand dispatch only). It names the release being replaced by its seq, and the name must be true:
// that seq is the one the live published version object map carries, and the history holds a release of
// this CL signed with it. It lifts the already-released hold for that CL and nothing else; the candidate must
// still change what is served (checkCandidateChange), and every other limit and gate stands.
// Returns { ok: true, seq } or { error }.
export function checkSupersede({ historyLoaded, repo, cl, supersede, liveSeq }) {
  const named = typeof supersede === 'string' ? supersede : String(supersede);
  if (!/^[1-9][0-9]{0,15}$/.test(named)) return { error: `supersede: ${JSON.stringify(supersede)} is not a seq` };
  const seq = Number(named);
  const live = liveSeq === undefined || liveSeq === null ? NaN : Number(liveSeq);
  if (!Number.isSafeInteger(live)) return { error: 'supersede: the seq of the live published version object map was not given' };
  if (live !== seq) return { error: `supersede names seq ${seq}, but the live published version object map is seq ${live}: only the release that is served now can be replaced` };
  const got = releasesOf(historyLoaded, repo);
  if (got.error) return { error: got.error };
  if (!got.mine.some((r) => r.cl === cl && r.seq === seq)) return { error: `supersede names seq ${seq}, which is not a ${repo} release of CL-${cl} in the release history` };
  return { ok: true, seq };
}

// Returns a list of reasons the release limits forbid a release of this CL.
// secondRelease: a release of a CL that is already released is allowed (checkSupersede passed, or promote's
// owner-dispatched roll-forward): only the one-release-per-CL limit is lifted, the others stand.
// proofRun: the owner's proof run re-runs a CL that is already released, so the same one reason is
// skipped for it; it never publishes, and the attempts limit applies to it as ever.
// rehearsal: a hand-started run on a build that is already released, which publishes only to the staging
// release: the one-per-CL limit is skipped (it counts toward nothing), and the attempts limit applies as ever.
export function checkReleaseLimits({ historyLoaded, repo, cl, path, secondRelease = false, proofRun = false, rehearsal = false }) {
  const got = releasesOf(historyLoaded, repo);
  if (got.error) return [got.error];
  const reasons = [];
  const sameCl = got.mine.filter((r) => r.cl === cl).length;
  if (!secondRelease && !proofRun && !rehearsal && sameCl >= LIMITS.maxReleasesPerClPerRepo) reasons.push(`${repo} already released for CL-${cl}`);
  if (path === 'B') {
    // Only what the chain itself rejected counts; a run that died before a decision (infra) and anything before the owner's reset does not.
    const n = countedAttempts(got.history, cl);
    if (n >= LIMITS.maxAttemptsPerCl) reasons.push(`${n} auto-fix attempts already used for CL-${cl} (limit ${LIMITS.maxAttemptsPerCl})`);
  }
  return reasons;
}

// What a version object map (the loader's header, or the published file) already holds for a CL or for the
// Steam build that carries it.
const holdsBuild = (map, cl, buildid) => (map.builds ?? []).some((b) => b.cl === Number(cl) || (buildid !== undefined && buildid !== null && buildid !== '' && buildIdOf(b.source) === String(buildid)));

// Version identity, before anything is built: a CL (or build) that the released loader's version object map or
// the published one already holds is not released again. "The released loader" is the header at loader_ref
// (default AlienX's main), read at the commit the run scanned: what the loader's main holds, not a release tag.
// Rows merged into main ahead of the feed publish therefore hold that CL's publish until a supersede or a later CL.
// loaderMap and publishedMap are version-map.mjs's parse and parseFeed output, null when that map is not to be judged (a run that cannot publish, a first
// publish) or { error } when it could not be read, which holds. secondRelease (checkSupersede passed) lifts
// this "already released" reason for both maps, and only this one.
export function checkCovered({ cl, buildid, loaderMap = null, publishedMap = null, secondRelease = false }) {
  const reasons = [];
  for (const [what, map] of [['the released loader', loaderMap], ['the published', publishedMap]]) {
    if (map === null || map === undefined) continue;
    if (map.error) reasons.push(`${what} version object map could not be read: ${map.error}`);
    else if (!secondRelease && holdsBuild(map, cl, buildid)) reasons.push(`${what} version object map already holds CL-${cl}${buildid ? ` (build ${buildid})` : ''}`);
  }
  return reasons;
}

// What a candidate feed changes for one CL against the published file. Both are parseFeed's shape. Differs
// when the candidate has a build line or a row for the CL that the published one lacks or holds other
// content for, or lacks a row the published one holds for it (one ci/retired-rows.txt lets go).
export function servedDifference(candidate, published, cl) {
  const n = Number(cl);
  const { added, changed } = feedDelta(candidate, published, n);
  const removed = feedDelta(published, candidate, n).added;
  return { differs: added.length + changed.length + removed.length > 0, added, changed, removed };
}

// A publish has to change what is served for its CL: an identical candidate is a hold, not a release.
export function checkCandidateChange({ candidate, published, cl }) {
  if (candidate === null || candidate === undefined || published === null || published === undefined) return [];
  if (candidate.error || published.error) return [`the candidate or the published version object map could not be read: ${candidate.error ?? published.error}`];
  if (servedDifference(candidate, published, cl).differs) return [];
  return [`the candidate version object map changes nothing served for CL-${cl} (no new build line, no new or changed row, none dropped), so there is nothing to publish`];
}

// The version identity of one release, whole: what the released loader and the published file already hold,
// and what the candidate feed changes against the published file. The one function the decision (before the
// build: no candidate yet) and the publish job (after it: with the candidate) both call. supersede
// ({ seq, liveSeq }, a hand dispatch's input) is judged here too, so a second release of a CL is allowed only
// when it names the release that is live. Returns { reasons, supersedes } (supersedes: the seq replaced, or null).
export function checkIdentity({ repo, cl, buildid, loaderMap = null, publishedMap = null, candidate = null, supersede, historyLoaded }) {
  const reasons = [];
  let supersedes = null;
  if (supersede !== undefined && supersede !== null && supersede !== '') {
    const s = checkSupersede({ historyLoaded, repo, cl: String(cl), supersede: supersede.seq, liveSeq: supersede.liveSeq });
    if (s.error) reasons.push(s.error);
    else supersedes = s.seq;
  }
  reasons.push(...checkCovered({ cl, buildid, loaderMap, publishedMap, secondRelease: supersedes !== null }));
  reasons.push(...checkCandidateChange({ candidate, published: publishedMap, cl }));
  return { reasons, supersedes };
}

// inputs: { repo, autopilot, g1, g2, g3, g4, g5, plugins, fields?, rigPlugins?, history }, each a loadJson()
// result, coverage? ({ buildid, loaderMap, publishedMap }: the version object maps a release must not already be in),
// supersede? ({ seq, liveSeq }: a second release of a CL, see checkSupersede), testAutopilot (a dispatched test run: the decision is still HOLD while autopilot is disabled,
// and `wouldBe` says what it would be with autopilot on) and candidate (the unattended chain: the same,
// without the `test` mark).
export function decide(inputs) {
  const reasons = [];
  const notes = [];
  let disabled = false;
  let perPlugin = [];
  let supersedes = null;
  const fail = (msg) => reasons.push(msg);
  // The facts of the DLLs the rig will run. Anything but a list of rows means none were read.
  const rigRows = inputs.rigPlugins?.ok === true && Array.isArray(inputs.rigPlugins.value?.plugins) ? inputs.rigPlugins.value.plugins : null;
  const out = (decision, path, cl) => {
    if (rigRows === null) notes.push(`rig plugins: the facts of the DLLs the rig runs were not read (${inputs.rigPlugins === undefined ? 'no file given' : inputs.rigPlugins.error ?? 'no plugins list'}); no refusal is declared for the rig`);
    else {
      const unread = rigRows.filter((p) => !isObj(p) || !isObj(p.plugin) || !Number.isInteger(p.plugin.interfaceVersion)).map((p) => (isObj(p) && typeof p.name === 'string' ? p.name : '?'));
      if (unread.length) notes.push(`rig plugins: no facts for ${unread.join(', ')}; no refusal is declared for ${unread.length === 1 ? 'it' : 'them'}, so a refusal fails the rig`);
    }
    const r = {
      decision, path, cl: cl ?? null, repo: inputs.repo ?? null, ship: decision === 'M' || decision === 'B',
      reasons, notes, plugins: perPlugin,
      pluginsOk: perPlugin.length > 0 && perPlugin.every((p) => p.status === 'updated' || p.heldAlone === true),
      // The DLLs the rig runs that the loader refuses on this build, sorted: the client rig's expect_refused
      // input. From the rig's own DLLs (--rig-plugins), never from the plugin builds judged in perPlugin.
      expectRefused: rigRows === null ? [] : expectedRefusals(rigRows, cl),
    };
    if (inputs.firstPublish) r.firstPublish = true;
    if (inputs.rehearsal) {
      r.rehearsal = true;
      notes.push('rehearsal: the already-released checks were not applied; the version object map goes to the staging release only');
    }
    if (supersedes !== null) {
      r.supersedes = supersedes;
      notes.push(`supersede: a second release of CL-${cl}, replacing the release served now (seq ${supersedes}); only the already-released checks were lifted`);
    }
    // The other branch's build: the same rule on that CL (--other-cl). On the very CL this check
    // scanned, the scanned verdicts apply too, so the two lists are then the same.
    if (inputs.otherCl !== undefined && inputs.otherCl !== null) {
      r.otherCl = Number(inputs.otherCl);
      r.expectRefusedOther = r.otherCl === Number(cl) ? r.expectRefused : rigRows === null ? [] : expectedRefusals(rigRows, r.otherCl);
    }
    // The other branch's build is not in the candidate map: the loader has nothing to run it with, so it must decline.
    if (inputs.otherUnmapped !== undefined && inputs.otherUnmapped !== null) {
      r.expectDeclineOther = true;
      notes.push(`${inputs.otherUnmapped}, not in this candidate map: expects a clean decline (the version-mismatch line, no plugin loaded, no crash, the game still running)`);
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

  // The first publish stands in for the autopilot on this one run: path M only, the file not read.
  if (inputs.firstPublish && inputs.testAutopilot) fail('a first publish is never a test run');
  if (inputs.rehearsal && (inputs.firstPublish || inputs.testAutopilot)) fail('a rehearsal is never a test run or a first publish');
  const supersedeGiven = inputs.supersede !== undefined && inputs.supersede !== null;
  if (supersedeGiven && (inputs.testAutopilot || inputs.firstPublish || inputs.rehearsal)) fail('a supersede is only for an ordinary publishing run, never a test run, a first publish or a rehearsal');
  const ap = inputs.firstPublish ? { enabled: true, paths: ['M'] } : checkAutopilot(inputs.autopilot);
  if (ap.error) fail(ap.error);
  else if (!ap.enabled && (inputs.testAutopilot || inputs.candidate)) disabled = true;
  else if (!ap.enabled) fail('autopilot is disabled (enabled is not true)');

  const g1 = checkSimpleGate('G1 compile', inputs.g1);
  const g2 = checkSimpleGate('G2 interface', inputs.g2);
  const g3 = checkG3(inputs.g3, { firstPublish: inputs.firstPublish === true, supersede: supersedeGiven });
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

  // A second release of an already released CL: only with a supersede that names the release served now.
  if (supersedeGiven) {
    const s = checkSupersede({ historyLoaded: inputs.history, repo: inputs.repo, cl: g3.cl, supersede: inputs.supersede.seq, liveSeq: inputs.supersede.liveSeq });
    if (s.error) fail(s.error);
    else supersedes = s.seq;
  }
  // G3's own already-released hold (the loader's header maps this CL) is lifted by the same supersede and by nothing else.
  if (g3.notNewer !== undefined && supersedes === null) fail(g3.notNewer);
  checkReleaseLimits({
    historyLoaded: inputs.history, repo: inputs.repo, cl: g3.cl, path, secondRelease: supersedes !== null,
    proofRun: g3.proof === true, rehearsal: inputs.rehearsal === true,
  }).forEach(fail);
  // Version identity: a CL or build that the released loader or the published version object map already holds is
  // not released again. Given for a run that can publish only; a proof run, a rehearsal, a first publish and a test
  // run re-run a CL that is already covered, and none of them publishes to players.
  if (inputs.coverage !== undefined && g3.proof !== true && !inputs.rehearsal && !inputs.firstPublish && !inputs.testAutopilot) {
    checkCovered({ cl: g3.cl, buildid: inputs.coverage.buildid, loaderMap: inputs.coverage.loaderMap, publishedMap: inputs.coverage.publishedMap, secondRelease: supersedes !== null }).forEach(fail);
  }

  if (reasons.length > 0) return out('HOLD', path, g3.cl);
  return out(path, path, g3.cl);
}

// A decision a published-base problem turns into a HOLD (ci/published-base.mjs). The reasons come first.
// decision: the decision decide wrote, when there is one (the preserve check runs after it); without it
// the hold stands alone (the published file could not be taken as the base, so decide did not run).
export function holdFor(reasons, { decision = null, repo = null, cl = null } = {}) {
  const base = decision ?? { path: null, cl, repo, reasons: [], notes: [], plugins: [], pluginsOk: false, expectRefused: [] };
  return { ...base, decision: 'HOLD', ship: false, reasons: [...reasons, ...(base.reasons ?? [])] };
}

// decide.mjs hold --report f [--decision f] [--repo name] [--cl n] [--out f]: the report is the one
// ci/published-base.mjs wrote ({ ok: false, reasons: [...] }).
function holdMain(argv) {
  try {
    const a = parseArgs(argv);
    const report = JSON.parse(readFileSync(a.report, 'utf8'));
    const reasons = Array.isArray(report.reasons) ? report.reasons.filter((r) => typeof r === 'string' && r) : [];
    if (report.ok !== false || reasons.length === 0) throw new Error(`${a.report} holds no reason to hold`);
    const decision = a.decision === undefined ? null : JSON.parse(readFileSync(a.decision, 'utf8'));
    if (a.cl !== undefined && !/^[1-9][0-9]{0,9}$/.test(a.cl)) throw new Error(`--cl is not a CL number: ${a.cl}`);
    const cl = a.cl === undefined ? null : Number(a.cl);
    const text = JSON.stringify(holdFor(reasons, { decision, repo: a.repo ?? null, cl }), null, 2) + '\n';
    if (a.out) writeFileSync(a.out, text);
    process.stdout.write(text);
    process.exit(0);
  } catch (e) {
    console.error(`${e.message}\nusage: decide.mjs hold --report f [--decision f] [--repo name] [--cl n] [--out f]`);
    process.exit(2);
  }
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

// --other-unmapped is a short plain label for the summary; it comes from the workflow, but nothing else is accepted.
function otherUnmappedOf(text) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,79}$/.test(String(text))) throw new Error(`--other-unmapped is not a plain label: ${text}`);
  return String(text);
}

// The seq of a signed feed file (its second line), or null.
function seqOf(bytes) {
  const m = /^seq\t([1-9][0-9]*)$/.exec(bytes.toString('utf8').split('\n')[1] ?? '');
  return m ? m[1] : null;
}

// The version object maps the identity check reads, from files: --loader-header (the released loader's header),
// --published (the signed published file: its rows, and its seq for a supersede) and --feed (the candidate feed
// export-feed wrote). A file that cannot be read or parsed is { error }, which holds; an option not given is null.
// The published file's signature is verified by published-base.mjs in the same run before this reads it.
function readMaps(a) {
  const attempt = (fn) => { try { return fn(); } catch (e) { return { error: String(e.message).replace(/\s+/g, ' ').slice(0, 240) }; } };
  const published = a.published === undefined ? null : attempt(() => readFileSync(a.published));
  return {
    loaderMap: a['loader-header'] === undefined ? null : attempt(() => parse(readFileSync(a['loader-header'], 'utf8'), 'the released loader header')),
    publishedMap: published === null ? null : published.error ? published : attempt(() => parseSignedFeedRows(published, 'the published version object map')),
    candidate: a.feed === undefined ? null : attempt(() => parseFeed(readFileSync(a.feed, 'utf8'), 'the candidate feed')),
    liveSeq: published === null || published.error ? null : seqOf(published),
  };
}

// --supersede <seq> (empty: none) with the live seq the published file carries.
function supersedeOf(a, maps) {
  if (a.supersede === undefined || a.supersede === '') return undefined;
  return { seq: a.supersede, liveSeq: maps.liveSeq };
}

// --buildid is optional, but when it is given it must be a build id: an empty one is a usage error (the run has no build
// id, and a check that skipped the build match for it would hold less than the caller thinks), for both commands.
function checkBuildId(a) {
  if (a.buildid === undefined) return;
  if (a.buildid === '') throw new Error('--buildid is empty: the run has no build id, so the build cannot be matched against what is served');
  if (!/^[0-9]+$/.test(a.buildid)) throw new Error(`--buildid is not a build id: ${a.buildid}`);
}

// decide.mjs identity --repo R --cl N [--buildid B] [--loader-header f] [--published f] [--feed f]
//     [--supersede S --history f] --report f
// The version identity check on its own (the publish job's re-check, and the chain's check of the candidate feed):
// writes { ok, step: 'identity', reasons }, the report `decide.mjs hold --report` turns into a decision. Exit 0 ok,
// 3 hold, 2 usage.
function identityMain(argv) {
  try {
    const a = parseArgs(argv);
    if (!a.repo || !/^[1-9][0-9]{0,8}$/.test(a.cl ?? '') || !a.report) throw new Error('missing --repo, --cl or --report');
    checkBuildId(a);
    const maps = readMaps(a);
    const supersede = supersedeOf(a, maps);
    if (supersede !== undefined && a.history === undefined) throw new Error('--supersede needs --history');
    const { reasons, supersedes } = checkIdentity({
      repo: a.repo, cl: a.cl, buildid: a.buildid, loaderMap: maps.loaderMap, publishedMap: maps.publishedMap, candidate: maps.candidate,
      supersede, historyLoaded: a.history === undefined ? undefined : loadHistory(a.history),
    });
    const report = reasons.length ? { ok: false, step: 'identity', reasons } : { ok: true, step: 'identity', note: `CL-${a.cl} is not yet served and the candidate changes what is served${supersedes === null ? '' : ` (supersedes seq ${supersedes})`}`, supersedes };
    writeFileSync(a.report, `${JSON.stringify(report, null, 2)}\n`);
    for (const r of reasons) process.stderr.write(`${r}\n`);
    if (report.ok) process.stdout.write(`identity: ${report.note}\n`);
    process.exit(report.ok ? 0 : 3);
  } catch (e) {
    console.error(`${e.message}\nusage: decide.mjs identity --repo <name> --cl <n> [--buildid <id>] [--loader-header f] [--published f] [--feed f] [--supersede <seq> --history f] --report f`);
    process.exit(2);
  }
}

function main() {
  if (process.argv[2] === 'hold') holdMain(process.argv.slice(3));
  if (process.argv[2] === 'identity') identityMain(process.argv.slice(3));
  let args;
  try {
    const argv = process.argv.slice(2);
    args = parseArgs(argv.filter((a) => a !== '--test-autopilot' && a !== '--candidate' && a !== '--first-publish' && a !== '--rehearsal'));
    args.testAutopilot = argv.includes('--test-autopilot');
    args.candidate = argv.includes('--candidate');
    args.firstPublish = argv.includes('--first-publish');
    args.rehearsal = argv.includes('--rehearsal');
    if (args['other-cl'] !== undefined) args.otherCl = otherClOf(args['other-cl']);
    if (args['other-unmapped'] !== undefined) args.otherUnmapped = otherUnmappedOf(args['other-unmapped']);
    checkBuildId(args);
    if (args.otherCl !== undefined && args.otherUnmapped !== undefined) throw new Error('--other-cl and --other-unmapped exclude each other');
  } catch (e) {
    console.error(`${e.message}\nusage: decide.mjs --repo <name> --autopilot f --g1 f --g2 f --g3 f --g4 f --g5 f --plugins f [--fields f] --history f [--out f] [--other-cl n | --other-unmapped label] [--rig-plugins f] [--test-autopilot | --candidate] [--first-publish] [--rehearsal] [--loader-header f --published f [--buildid id]] [--supersede seq]`);
    process.exit(2);
  }
  let result;
  try {
    const maps = args['loader-header'] === undefined && args.published === undefined ? null : readMaps(args);
    const supersede = supersedeOf(args, maps ?? readMaps(args));
    result = decide({
      repo: args.repo, testAutopilot: args.testAutopilot, candidate: args.candidate, firstPublish: args.firstPublish, rehearsal: args.rehearsal,
      ...(maps === null ? {} : { coverage: { buildid: args.buildid, loaderMap: maps.loaderMap, publishedMap: maps.publishedMap } }),
      ...(supersede === undefined ? {} : { supersede }),
      autopilot: loadJson(args.autopilot),
      g1: loadJson(args.g1), g2: loadJson(args.g2), g3: loadJson(args.g3),
      g4: loadJson(args.g4), g5: loadJson(args.g5), plugins: loadJson(args.plugins), history: loadHistory(args.history),
      ...(args.fields === undefined ? {} : { fields: loadJson(args.fields) }),
      ...(args['rig-plugins'] === undefined ? {} : { rigPlugins: loadJson(args['rig-plugins']) }),
      ...(args.otherCl === undefined ? {} : { otherCl: args.otherCl }),
      ...(args.otherUnmapped === undefined ? {} : { otherUnmapped: args.otherUnmapped }),
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
