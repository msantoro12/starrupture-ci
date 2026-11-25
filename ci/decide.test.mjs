// Fixture tests for decide.mjs: every decision path and every fail-closed case.
// Run: node --test ci/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAutopilot, checkAutopilotSwitch, checkCandidateChange, checkCovered, checkIdentity, checkReleaseLimits, decide, expectedRefusals, holdFor, loaderRefusal, LIMITS, SDK_GLOBALS, servedDifference } from './decide.mjs';
import { addBuild, emit, emptyMap, exportFeed, parse, parseSignedFeedRows } from './version-map.mjs';
import { nextSeq } from './vmap-sign.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ok = (value) => ({ ok: true, value });
// The layout-diff report shape (PR #3): changedUsed rows carry the class name.
const layout = (...classes) => ({ changedUsedClasses: classes.length, changedUsed: classes.map((c) => ({ class: c })) });

const aobRow = (name, result = 'OK', required = true) => ({ name, kind: 'function', required, result, matches: result === 'OK' ? 1 : 0, ...(result === 'OK' ? { rva: '0x1A2B3C0', sdkRva: '0x1A2B3C0' } : {}) });
const globalRows = () => SDK_GLOBALS.map((n) => aobRow(n));
// By default every scan carries the four SDK global rows; pass noGlobals to leave them out.
function aob(rows, { noGlobals = false } = {}) {
  if (!noGlobals) rows = [...rows, ...globalRows()];
  const failing = rows.filter((r) => r.required && r.result !== 'OK').length;
  return { target: 'client', imageSize: 1000, summary: { total: rows.length, ok: rows.filter((r) => r.result === 'OK').length, missing: 0, ambiguous: 0, other: 0, requiredFailing: failing }, patterns: rows };
}

// A fully clean set of inputs; each test changes one thing.
function base(over = {}) {
  return {
    repo: 'ModLoader',
    autopilot: ok({ schema: 1, enabled: true, paths: ['M', 'B'] }),
    g1: ok({ ok: true }),
    g2: ok({ ok: true }),
    g3: ok({ ok: true, cl: '127999', previousCl: '127004' }),
    g4: ok(aob([aobRow('GetWorld'), aobRow('SpawnActor'), aobRow('Optional', 'OK', false)])),
    g5: ok(layout()),
    plugins: ok({ status: 'pass', plugins: [{ name: 'BetterCheats', verdict: 'PASS' }, { name: 'WAILA', verdict: 'GAME-CALL' }] }),
    history: ok({ releases: [], attempts: {} }),
    ...over,
  };
}
const holds = (r, re) => {
  assert.equal(r.decision, 'HOLD');
  assert.equal(r.ship, false);
  if (re) assert.match(r.reasons.join(' | '), re);
};

// ------------------------------------------------------------ decision paths

// Safe means: off, or on for the map-feed path "M" only (it publishes the signed feed, nothing else).
const autopilotIsSafe = (ap) => ap.enabled === false
  || (ap.enabled === true && Array.isArray(ap.paths) && ap.paths.every((p) => p === 'M'));

test('shipped state/autopilot.json is off or limited to the map-feed path M', () => {
  const ap = JSON.parse(readFileSync(join(here, '..', 'state', 'autopilot.json'), 'utf8'));
  assert.ok(autopilotIsSafe(ap), JSON.stringify(ap));
});

test('autopilot safe-state check: enabled with only M passes, any other path fails', () => {
  assert.ok(autopilotIsSafe({ enabled: false, paths: ['M'] }));
  assert.ok(autopilotIsSafe({ enabled: true, paths: ['M'] }));
  assert.ok(!autopilotIsSafe({ enabled: true, paths: ['M', 'B'] }));
});

test('M: map-only change ships', () => {
  const r = decide(base());
  assert.equal(r.decision, 'M');
  assert.equal(r.path, 'M');
  assert.equal(r.ship, true);
  assert.equal(r.cl, '127999');
  assert.deepEqual(r.reasons, []);
});

test('M: a non-required pattern miss still ships, with a note', () => {
  const r = decide(base({ g4: ok(aob([aobRow('GetWorld'), aobRow('Optional', 'MISSING', false)])) }));
  assert.equal(r.decision, 'M');
  assert.match(r.notes.join(' '), /Optional/);
});

test('B: a required pattern miss routes to auto-fix', () => {
  const r = decide(base({ g4: ok(aob([aobRow('GetWorld'), aobRow('SpawnActor', 'MISSING')])) }));
  assert.equal(r.decision, 'B');
  assert.equal(r.ship, true);
  assert.match(r.notes.join(' '), /SpawnActor \(MISSING\)/);
});

test('B: an ambiguous required pattern counts as a miss', () => {
  const r = decide(base({ g4: ok(aob([aobRow('SpawnActor', 'AMBIGUOUS')])) }));
  assert.equal(r.decision, 'B');
});

test('C: a used class moved is HOLD with path C, even with every path enabled', () => {
  const r = decide(base({
    autopilot: ok({ enabled: true, paths: ['M', 'B', 'C'] }),
    g5: ok(layout('UInventoryComponent')),
  }));
  holds(r, /path C held until shadow mode is proven/);
  assert.equal(r.path, 'C');
});

test('C wins over B when both a pattern missed and a class moved', () => {
  const r = decide(base({
    g4: ok(aob([aobRow('SpawnActor', 'MISSING')])),
    g5: ok(layout('UFoo')),
  }));
  holds(r);
  assert.equal(r.path, 'C');
});

test('HOLD: autopilot disabled', () => {
  const r = decide(base({ autopilot: ok({ enabled: false, paths: ['M'] }) }));
  holds(r, /disabled/);
  assert.equal(r.path, 'M', 'the would-be path is still reported');
});

test('HOLD: path not enabled in autopilot.paths', () => {
  const rB = decide(base({
    autopilot: ok({ enabled: true, paths: ['M'] }),
    g4: ok(aob([aobRow('SpawnActor', 'MISSING')])),
  }));
  holds(rB, /path B is not enabled/);
  const rM = decide(base({ autopilot: ok({ enabled: true, paths: [] }) }));
  holds(rM, /path M is not enabled/);
});

test('HOLD: G1 or G2 not ok', () => {
  holds(decide(base({ g1: ok({ ok: false }) })), /G1/);
  holds(decide(base({ g2: ok({ ok: false }) })), /G2/);
});

// ------------------------------------------------------------ SDK globals

test('SDK globals: all four re-resolved and verified is the precondition for M', () => {
  assert.deepEqual([...SDK_GLOBALS], ['GObjects', 'GNames', 'AppendString', 'GWorld']);
  assert.equal(decide(base()).decision, 'M');
  const prefixed = SDK_GLOBALS.map((n) => aobRow(`Offsets::${n.toLowerCase()}`));
  assert.equal(decide(base({ g4: ok(aob(prefixed, { noGlobals: true })) })).decision, 'M');
});

test('SDK globals: the client scan names them with a prefix and a note, as sr-aobscan does', () => {
  const named = ['GObjects (GUObjectArray.ObjObjects)', 'GNames (NamePoolData)', 'FName::AppendString', 'GWorld'].map((n) => aobRow(n, 'OK', false));
  named[0].sdkRva = '0xE359240';
  const r = decide(base({ g4: ok(aob(named, { noGlobals: true })) }));
  assert.equal(r.decision, 'M');
  assert.match(r.notes.join(), /GObjects 0xE359240 -> 0x1A2B3C0/);
});

// ------------------------------------------------------------ moved layouts and the field rows

const fieldsReport = (over = {}) => ({ written: true, cl: 127999, added: 3, absent: [{ key: 'UFoo::Gone' }], covered: ['UBar', 'UFoo'], notes: [], problems: [], ...over });

test('M: used classes that moved ship when the field rows settle every one', () => {
  const r = decide(base({ g5: ok(layout('UFoo', 'UBar')), fields: ok(fieldsReport()) }));
  assert.equal(r.decision, 'M');
  assert.deepEqual(r.reasons, []);
  assert.match(r.notes.join(), /2 used class\(es\) changed layout, every one settled by the field rows/);
  assert.match(r.notes.join(), /1 member\(s\) gone on CL-127999, each an absent row/);
});

test('C: a moved used class the field rows do not settle holds, naming it', () => {
  const g5 = ok(layout('UFoo', 'UBaz'));
  holds(decide(base({ g5, fields: ok(fieldsReport()) })), /1 used class\(es\) changed layout and no field row settles them \(UBaz\)/);
  holds(decide(base({ g5 })), /no field-rows report was given/);
  holds(decide(base({ g5, fields: ok(fieldsReport({ written: false, problems: ['native UFoo::X: required'] })) })), /not written: native UFoo::X: required/);
  holds(decide(base({ g5: ok(layout('UFoo')), fields: ok(fieldsReport({ cl: 127004 })) })), /for CL-127004, not CL-127999/);
  holds(decide(base({ g5, fields: { ok: false, error: 'cannot read f: ENOENT' } })), /ENOENT/);
  assert.equal(decide(base({ g5 })).path, 'C');
  // With nothing moved, a refused field-rows run still holds: the native rows are missing.
  const refused = decide(base({ fields: ok(fieldsReport({ cl: 127999, written: false, problems: ['native UFoo::X: not found'] })) }));
  holds(refused, /field rows: the field rows were not written: native UFoo::X/);
  assert.equal(refused.path, 'M');
});

test('SDK globals: a scan without them (today registry) is HOLD, never M', () => {
  const r = decide(base({ g4: ok(aob([aobRow('GetWorld'), aobRow('SpawnActor')], { noGlobals: true })) }));
  holds(r, /SDK global offsets not resolved/);
  assert.equal(r.path, null);
  for (const k of SDK_GLOBALS) assert.match(r.reasons.join(), new RegExp(`${k}: no pattern`));
});

for (const key of SDK_GLOBALS) {
  test(`SDK globals: ${key} absent, duplicated, lookalike or without an RVA is HOLD; optional is fine`, () => {
    const others = SDK_GLOBALS.filter((n) => n !== key).map((n) => aobRow(n));
    const run = (extra) => decide(base({ g4: ok(aob([...others, ...extra], { noGlobals: true })) }));
    holds(run([]), new RegExp(`${key}: no pattern`));
    assert.equal(run([aobRow(key, 'OK', false)]).decision, 'M', 'the client scan marks the globals optional');
    holds(run([aobRow(key), aobRow(key)]), /2 pattern rows/);
    holds(run([aobRow(`${key}Cache`), aobRow(`My${key}`)]), new RegExp(`${key}: no pattern`));
    for (const rva of [undefined, '', '0x', 'zz', null]) {
      const row = aobRow(key);
      if (rva === undefined) delete row.rva; else row.rva = rva;
      holds(run([row]), /no resolved RVA/);
    }
  });

  test(`SDK globals: ${key} not matching is HOLD, and a moved offset is a note`, () => {
    const others = SDK_GLOBALS.filter((n) => n !== key).map((n) => aobRow(n));
    const run = (row, ap) => decide(base({ ...(ap ? { autopilot: ap } : {}), g4: ok(aob([...others, row], { noGlobals: true })) }));
    for (const result of ['MISSING', 'AMBIGUOUS']) {
      const r = run(aobRow(key, result));
      holds(r, /SDK global/);
      assert.ok(r.reasons.join().includes(`${key}: did not resolve (${result})`));
      assert.equal(r.path, null, 'never routed to B or M');
    }
    // even with every path enabled
    holds(run(aobRow(key, 'MISSING'), ok({ enabled: true, paths: ['M', 'B', 'C'] })), /SDK global/);
    // a moved offset is a note: the map row carries the new value
    const moved = aobRow(key); moved.rva = '0x1A2B3D0';
    const rm = run(moved);
    assert.equal(rm.decision, 'M');
    assert.ok(rm.notes.join().includes(`${key} 0x1A2B3C0 -> 0x1A2B3D0`), rm.notes.join());
    // ...on path M only: a would-be B ships no map rows, so it holds
    const rb = decide(base({ g4: ok(aob([...others, moved, aobRow('SpawnActor', 'MISSING')], { noGlobals: true })) }));
    holds(rb, new RegExp(`SDK global offsets moved, which only path M carries: ${key} 0x1A2B3C0 -> 0x1A2B3D0`));
    assert.equal(rb.path, 'B');
    assert.ok(!rb.notes.join().includes('SDK global offsets moved'));
    // equal values written differently are equal, and give no note
    const same = aobRow(key); same.rva = '0x01a2b3c0'; same.sdkRva = '0X1A2B3C0';
    const rs = run(same);
    assert.equal(rs.decision, 'M');
    assert.ok(!rs.notes.join().includes('SDK global offsets moved'));
    // no baked offset to compare with is fine
    for (const bad of [undefined, null, '', '0x', 'zz', 5, '1A2B3C0']) {
      const row = aobRow(key);
      if (bad === undefined) delete row.sdkRva; else row.sdkRva = bad;
      assert.equal(run(row).decision, 'M');
    }
    const zero = aobRow(key); zero.rva = '0x0'; zero.sdkRva = '0x0';
    holds(run(zero), /no resolved RVA/);
  });
}

test('SDK globals: unverified globals also block a would-be C and a would-be B', () => {
  const noG = (rows) => ok(aob(rows, { noGlobals: true }));
  holds(decide(base({ g4: noG([aobRow('SpawnActor', 'MISSING')]) })), /SDK global/);
  holds(decide(base({ g4: noG([aobRow('GetWorld')]), g5: ok(layout('UFoo')) })), /SDK global/);
});

// ------------------------------------------------------------ fail closed

const BAD_JSON = { ok: false, error: 'cannot read x: ENOENT' };

test('fail closed: autopilot unreadable or malformed', () => {
  holds(decide(base({ autopilot: BAD_JSON })), /autopilot/);
  holds(decide(base({ autopilot: ok(null) })), /autopilot/);
  holds(decide(base({ autopilot: ok([]) })), /autopilot/);
  holds(decide(base({ autopilot: ok({ paths: ['M'] }) })), /enabled is not a boolean/);
  holds(decide(base({ autopilot: ok({ enabled: 'true', paths: ['M'] }) })), /enabled is not a boolean/);
  holds(decide(base({ autopilot: ok({ enabled: 1, paths: ['M'] }) })), /enabled is not a boolean/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: 'M' }) })), /paths/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['M', 'Z'] }) })), /paths/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['M'], error: 'stale' }) })), /error/);
});

test('the autopilot file carries no per-day knob: the old key is ignored, a file without it is whole', () => {
  assert.equal(decide(base({ autopilot: ok({ enabled: true, paths: ['M'] }) })).decision, 'M');
  assert.equal(decide(base({ autopilot: ok({ enabled: true, paths: ['M'], max_releases_per_day: 0 }) })).decision, 'M');
  assert.equal(LIMITS.maxReleasesPerDay, undefined);
  assert.equal(LIMITS.minGapMinutes, undefined);
});

for (const gate of ['g1', 'g2', 'g3', 'g4', 'g5', 'plugins', 'history']) {
  test(`fail closed: ${gate} missing, unreadable, not an object, or reporting an error`, () => {
    holds(decide(base({ [gate]: undefined })));
    holds(decide(base({ [gate]: BAD_JSON })), /ENOENT/);
    holds(decide(base({ [gate]: ok(null) })), /not a JSON object/);
    holds(decide(base({ [gate]: ok([1]) })), /not a JSON object/);
    holds(decide(base({ [gate]: ok({ ...base()[gate].value, error: 'engine crashed' }) })), /error/);
  });
}

test('fail closed: ok must be exactly true', () => {
  for (const bad of [false, 'true', 1, null, undefined]) {
    holds(decide(base({ g1: ok({ ok: bad }) })));
    holds(decide(base({ g2: ok({ ok: bad }) })));
    holds(decide(base({ g3: ok({ ok: bad, cl: '127999', previousCl: '127004' }) })));
    holds(decide(base({ g5: ok({ ...layout(), ok: bad }) })));
  }
});

test('fail closed: G3 CL', () => {
  holds(decide(base({ g3: ok({ ok: true }) })), /cl is missing/);
  holds(decide(base({ g3: ok({ ok: true, cl: '127999' }) })), /previousCl/);
  holds(decide(base({ g3: ok({ ok: true, cl: '0127999', previousCl: '127004' }) })), /cl is missing/);
  holds(decide(base({ g3: ok({ ok: true, cl: 'CL-127999' }) })), /cl is missing/);
  holds(decide(base({ g3: ok({ ok: true, cl: 127999 }) })), /cl is missing/);
  holds(decide(base({ g3: ok({ ok: true, cl: '127004', previousCl: '127004' }) })), /not newer/);
  holds(decide(base({ g3: ok({ ok: true, cl: '120000', previousCl: '127004' }) })), /not newer/);
  holds(decide(base({ g3: ok({ ok: true, cl: '127999', previousCl: 'x' }) })), /previousCl/);
});

test('G3 proof: an owner\'s proof run passes a CL already mapped, the built one or an older one', () => {
  assert.equal(decide(base({ g3: ok({ ok: true, cl: '127004', previousCl: '127004', proof: true }) })).decision, 'M');
  assert.equal(decide(base({ g3: ok({ ok: true, cl: '127004', previousCl: '129402', proof: true }) })).decision, 'M');
  // Only the boolean: anything else is not a proof run.
  for (const proof of ['true', 1, false, null]) holds(decide(base({ g3: ok({ ok: true, cl: '127004', previousCl: '127004', proof }) })), /not newer/);
});

test('first publish: it passes a CL that is not newer and skips the autopilot, only with the flag and the G3 mark together', () => {
  const g3 = (over = {}) => ok({ ok: true, cl: '127004', previousCl: '127004', firstPublish: true, ...over });
  const off = ok({ schema: 1, enabled: false, paths: ['M'] });
  // The bypass is the run's own: the flag and the mark, with the autopilot off and the CL not newer.
  const fp = decide(base({ firstPublish: true, g3: g3(), autopilot: off }));
  assert.equal(fp.decision, 'M');
  assert.equal(fp.firstPublish, true);
  // The mark without the flag, or the flag without the mark, bypasses nothing.
  holds(decide(base({ g3: g3() })), /not newer/);
  holds(decide(base({ firstPublish: true, g3: g3({ firstPublish: undefined }) })), /not newer/);
  for (const firstPublish of ['true', 1, false, null]) holds(decide(base({ firstPublish: true, g3: g3({ firstPublish }) })), /not newer/);
  // Without the flag the autopilot still holds a run.
  holds(decide(base({ g3: ok({ ok: true, cl: '127999', previousCl: '127004' }), autopilot: off })), /autopilot/);
  // The rest of the gates apply as always: a failed check or a missing G3 still holds it.
  holds(decide(base({ firstPublish: true, g3: g3(), autopilot: off, g1: ok({ ok: false }) })), /./);
  holds(decide(base({ firstPublish: true, g3: g3(), autopilot: off, g4: ok(aob([aobRow('GetWorld', 'MISSING')])) })), /./);
  // Never a test run.
  holds(decide(base({ firstPublish: true, testAutopilot: true, g3: g3() })), /never a test run/);
});

test('fail closed: G4 must be a consistent client scan; a server scan is never the gate', () => {
  const good = aob([aobRow('GetWorld')]);
  holds(decide(base({ g4: ok({ ...good, target: 'server' }) })), /expected "client"/);
  holds(decide(base({ g4: ok({ ...good, target: undefined }) })), /expected "client"/);
  holds(decide(base({ g4: ok({ ...good, patterns: [], summary: { total: 0, requiredFailing: 0 } }) })), /no patterns/);
  holds(decide(base({ g4: ok({ ...good, summary: undefined }) })), /summary/);
  holds(decide(base({ g4: ok({ ...good, summary: { ...good.summary, requiredFailing: 1 } }) })), /disagrees/);
  holds(decide(base({ g4: ok({ ...good, summary: { ...good.summary, total: 9 } }) })), /disagrees/);
  // A summary that hides a missed required pattern must not turn a B into an M.
  const liar = aob([aobRow('GetWorld'), aobRow('SpawnActor', 'MISSING')]);
  liar.summary.requiredFailing = 0;
  holds(decide(base({ g4: ok(liar) })), /disagrees/);
  holds(decide(base({ g4: ok({ ...good, patterns: [{ name: 'x' }] }) })), /malformed/);
  holds(decide(base({ g4: ok({ ...good, patterns: [{ name: 'x', result: 'OK', required: 'yes' }] }) })), /malformed/);
});

test('fail closed: G5 must be a consistent layout-diff report', () => {
  holds(decide(base({ g5: ok({ ok: true }) })), /not a layout-diff report/);
  holds(decide(base({ g5: ok({ ok: true, changedUsedClasses: 0 }) })), /not a layout-diff report/);
  holds(decide(base({ g5: ok({ ok: true, changedUsedClasses: 'none', changedUsed: [] }) })), /not a layout-diff report/);
  holds(decide(base({ g5: ok({ ok: true, changedUsedClasses: 0, changedUsed: 'none' }) })), /not a layout-diff report/);
  holds(decide(base({ g5: ok({ ok: true, changedUsedClasses: 1, changedUsed: [{}] }) })), /need a class name/);
  holds(decide(base({ g5: ok({ ok: true, changedUsedClasses: 1, changedUsed: [{ class: '' }] }) })), /need a class name/);
  holds(decide(base({ g5: ok({ ok: true, changedUsedClasses: 1, changedUsed: ['UFoo'] }) })), /need a class name/);
  // a count that hides a changed class must not turn a C into an M
  holds(decide(base({ g5: ok({ ok: true, changedUsedClasses: 0, changedUsed: [{ class: 'UFoo' }] }) })), /disagrees/);
  holds(decide(base({ g5: ok({ ok: true, changedUsedClasses: 2, changedUsed: [{ class: 'UFoo' }] }) })), /disagrees/);
});

test('fail closed: missing repo name', () => {
  holds(decide(base({ repo: undefined })), /repo name/);
});

// ------------------------------------------------------------ release limits (no clock)

// A history entry: the repo, the CL and the seq it was signed with. `at` is only a record.
const rel = (cl = '127004', repo = 'ModLoader', seq = undefined) => ({ repo, cl, at: '2026-10-28T00:00:00Z', ...(seq === undefined ? {} : { seq }) });
const hist = (...releases) => ok({ releases, attempts: {} });

test('release limits: one release per CL per repo', () => {
  holds(decide(base({ history: hist(rel('127999')) })), /already released for CL-127999/);
  // the same CL in another repo does not count
  assert.equal(decide(base({ history: hist(rel('127999', 'Waila')) })).decision, 'M');
});

test('release limits: no reason carries the old rate-limit words', () => {
  const r = decide(base({ history: hist(rel('127999')) }));
  assert.deepEqual(r.reasons, ['ModLoader already released for CL-127999']);
  const b = decide(base({ g4: ok(aob([aobRow('SpawnActor', 'MISSING')])), history: ok({ releases: [], attempts: { 127999: 2 } }) }));
  assert.deepEqual(b.reasons, ['2 auto-fix attempts already used for CL-127999 (limit 2)']);
  for (const text of [...r.reasons, ...b.reasons]) assert.doesNotMatch(text, /rate limit|per day|24 h|gap|minutes/i);
});

test('release limits: a release is judged by its CL, never by its age', () => {
  for (const at of ['2026-10-29T11:59:59Z', '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 'yesterday', undefined]) {
    const mk = (cl) => ok({ releases: [{ repo: 'ModLoader', cl, ...(at === undefined ? {} : { at }) }], attempts: {} });
    holds(decide(base({ history: mk('127999') })), /already released for CL-127999/);
    assert.equal(decide(base({ history: mk('126000') })).decision, 'M');
  }
  // Releases of other CLs, as many as you like and as close together as you like, hold nothing.
  assert.equal(decide(base({ history: hist(rel('126001'), rel('126002'), rel('126003'), rel('126004')) })).decision, 'M');
  // No clock reaches the decision, the promote gate or the autopilot file.
  assert.equal(Object.hasOwn(base(), 'now'), false);
  const code = (f) => readFileSync(join(here, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code('decide.mjs'), /\bDate\b|nowMs|minGap|maxReleasesPerDay|maxPerDay|max_releases_per_day/);
  assert.doesNotMatch(code('promote.mjs'), /minGap|maxReleasesPerDay|maxPerDay|max_releases_per_day|DAY_MS/);
});

test('release limits: a proof run skips the once-per-CL reason and no other', () => {
  const proof = ok({ ok: true, cl: '127004', previousCl: '127004', proof: true });
  const published = hist(rel('127004'));
  // A build already published: a proof run does not hold for it and decides as it does for a build that never was.
  const r = decide(base({ g3: proof, history: published }));
  assert.equal(r.decision, 'M');
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r, decide(base({ g3: proof, history: hist() })));
  // The same history for a run that is not a proof run still holds, with the same words.
  const plain = decide(base({ g3: ok({ ok: true, cl: '127004', previousCl: '126000' }), history: published }));
  holds(plain);
  assert.deepEqual(plain.reasons, ['ModLoader already released for CL-127004']);
  // Only the boolean marks a proof run.
  for (const mark of ['true', 1, false, null]) holds(decide(base({ g3: ok({ ok: true, cl: '127004', previousCl: '126000', proof: mark }), history: published })), /already released for CL-127004/);
  // The attempts limit applies to a proof run as ever.
  const missB = ok(aob([aobRow('SpawnActor', 'MISSING')]));
  holds(decide(base({ g3: proof, g4: missB, history: ok({ releases: [], attempts: { 127004: 2 } }) })), /2 auto-fix attempts/);
  // A proof run is not judged by what is already served either: it republishes nothing.
  const served = vmap({ builds: [bld(127004)] });
  assert.equal(decide(base({ g3: proof, history: published, coverage: { buildid: '12700400', loaderMap: served, publishedMap: served } })).decision, 'M');
  // The workflow decides a proof run with the candidate flag: wouldBe M, nothing different on a published build.
  const cand = decide(base({ g3: proof, candidate: true, history: published }));
  assert.equal(cand.decision, 'M');
  assert.equal(cand.wouldBe, 'M');
  assert.equal(cand.candidate, true);
  assert.deepEqual(cand.reasons, []);
});

test('release limits: checkReleaseLimits skips the once-per-CL reason only with proofRun', () => {
  const args = { historyLoaded: hist(rel('127004')), repo: 'ModLoader', cl: '127004', path: 'M' };
  assert.deepEqual(checkReleaseLimits(args), ['ModLoader already released for CL-127004']);
  assert.deepEqual(checkReleaseLimits({ ...args, proofRun: false }), ['ModLoader already released for CL-127004']);
  assert.deepEqual(checkReleaseLimits({ ...args, proofRun: true }), []);
});

test('release limits: a rehearsal skips the once-per-CL reason and the version identity checks, and no other', () => {
  const g3 = ok({ ok: true, cl: '127999', previousCl: '127004' });
  const published = hist(rel('127999'));
  const served = vmap({ builds: [bld(127999)] });
  const coverage = { buildid: '12799900', loaderMap: served, publishedMap: served };
  // The build is already released and served: without the flag it holds; with it nothing does.
  holds(decide(base({ g3, history: published, coverage })), /already released for CL-127999/);
  const r = decide(base({ g3, history: published, coverage, rehearsal: true }));
  assert.equal(r.decision, 'M');
  assert.deepEqual(r.reasons, []);
  assert.equal(r.rehearsal, true);
  assert.match(r.notes.join(' | '), /rehearsal: the already-released checks were not applied; the version object map goes to the staging release only/);
  // Only a rehearsal carries the mark; the same inputs without it never do.
  assert.equal(decide(base({ g3, history: hist() })).rehearsal, undefined);
  // Only the boolean flag counts.
  for (const flag of ['true', 1, null, undefined]) holds(decide(base({ g3, history: published, rehearsal: flag })), /already released for CL-127999/);
  // The attempts limit applies to a rehearsal as ever, and so does every gate.
  holds(decide(base({ g3, rehearsal: true, g4: ok(aob([aobRow('SpawnActor', 'MISSING')])), history: ok({ releases: [], attempts: { 127999: 2 } }) })), /2 auto-fix attempts/);
  holds(decide(base({ g3, history: published, rehearsal: true, g1: ok({ ok: false }) })), /./);
  holds(decide(base({ g3, history: published, rehearsal: true, g2: ok({ ok: false }) })), /./);
  holds(decide(base({ g3, history: published, rehearsal: true, autopilot: ok({ schema: 1, enabled: false, paths: ['M'] }) })), /./);
  // Never with a test run or a first publish.
  holds(decide(base({ g3, history: published, rehearsal: true, testAutopilot: true })), /never a test run or a first publish/);
  holds(decide(base({ g3, history: published, rehearsal: true, firstPublish: true })), /never a test run or a first publish/);
});

test('release limits: checkReleaseLimits skips the once-per-CL reason only with rehearsal', () => {
  const args = { historyLoaded: hist(rel('127004')), repo: 'ModLoader', cl: '127004', path: 'M' };
  assert.equal(checkReleaseLimits(args).length, 1);
  assert.equal(checkReleaseLimits({ ...args, rehearsal: false }).length, 1);
  assert.deepEqual(checkReleaseLimits({ ...args, rehearsal: true }), []);
  // the attempts limit is not skipped
  const capped = { ...args, path: 'B', historyLoaded: ok({ releases: [rel('127004')], attempts: { 127004: 2 } }) };
  assert.match(checkReleaseLimits({ ...capped, rehearsal: true }).join(), /auto-fix attempts/);
  assert.match(checkReleaseLimits({ ...capped, secondRelease: true }).join(), /auto-fix attempts/);
});

test('cli: --rehearsal decides M on an already-released build and writes the mark; without it the same files HOLD', () => {
  const files = cliFiles({ history: { releases: [rel('127999')], attempts: {} } });
  const plain = runCli(files);
  assert.equal(plain.status, 1);
  assert.match(plain.out.reasons.join(' | '), /already released for CL-127999/);
  const r = runCli(files, ['--rehearsal']);
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.equal(r.out.decision, 'M');
  assert.equal(r.out.rehearsal, true);
  assert.notEqual(runCli(files, ['--rehearsal', '--test-autopilot']).status, 0);
  assert.notEqual(runCli(files, ['--rehearsal', '--first-publish']).status, 0);
});

// ------------------------------------------------------------ version identity

// Small version object maps in the parsers' shape (parse for a header, parseFeed for a feed): builds and rows.
const bld = (cl, source = `public ${cl}00`) => ({ cl, stamp: 0x11111111, size: 0x01000000, source });
const frow = (key, cl, rva = 0x5500) => ({ key, kind: 1, fp: 0, cl, absent: false, pattern: 'AA 55', resultOffset: 0, followRel32At: -1, followRipDispAt: -1, rva, owners: null });
const vmap = ({ builds = [], functions = [], fields = [] } = {}) => ({ flavour: 'loader', builtCL: null, builds, functions, fields, absentFields: [] });

test('identity: checkCovered holds a CL or a build the released loader or the published version object map holds', () => {
  const has = (cl, source) => vmap({ builds: [bld(cl, source)] });
  const none = vmap();
  assert.deepEqual(checkCovered({ cl: '127999', buildid: '5', loaderMap: none, publishedMap: none }), []);
  assert.deepEqual(checkCovered({ cl: '127999' }), []);
  assert.deepEqual(checkCovered({ cl: '127999', loaderMap: null, publishedMap: null }), []);
  assert.deepEqual(checkCovered({ cl: '127999', loaderMap: has(127999), publishedMap: none }), ['the released loader version object map already holds CL-127999']);
  assert.deepEqual(checkCovered({ cl: '127999', publishedMap: has(127999), loaderMap: none }), ['the published version object map already holds CL-127999']);
  assert.equal(checkCovered({ cl: '127999', loaderMap: has(127999), publishedMap: has(127999) }).length, 2);
  // The same Steam build under another CL label is covered too.
  assert.match(checkCovered({ cl: '128000', buildid: '777', publishedMap: has(127999, 'public 777') }).join(), /already holds CL-128000 \(build 777\)/);
  assert.deepEqual(checkCovered({ cl: '128000', buildid: '778', publishedMap: has(127999, 'public 777') }), []);
  assert.deepEqual(checkCovered({ cl: '128000', buildid: '', publishedMap: has(127999, 'public 777') }), []);
  // A map that could not be read holds.
  assert.match(checkCovered({ cl: '127999', publishedMap: { error: 'bad signature' } }).join(), /published version object map could not be read: bad signature/);
  assert.match(checkCovered({ cl: '127999', loaderMap: { error: 'no header' } }).join(), /released loader version object map could not be read/);
});

test('identity: secondRelease lifts only the already-holds reasons, never an unreadable map', () => {
  const served = vmap({ builds: [bld(127999)] });
  assert.deepEqual(checkCovered({ cl: '127999', loaderMap: served, publishedMap: served, secondRelease: true }), []);
  assert.equal(checkCovered({ cl: '127999', loaderMap: { error: 'x' }, publishedMap: served, secondRelease: true }).length, 1);
});

test('identity: servedDifference and checkCandidateChange name a publish that changes nothing', () => {
  const published = vmap({ builds: [bld(130000)], functions: [frow('A', 130000)] });
  const same = vmap({ builds: [bld(130000)], functions: [frow('A', 130000)] });
  assert.equal(servedDifference(same, published, 130000).differs, false);
  assert.match(checkCandidateChange({ candidate: same, published, cl: '130000' }).join(), /changes nothing served for CL-130000 .* so there is nothing to publish/);
  // a new build line
  assert.equal(servedDifference(vmap({ builds: [bld(130000), bld(130001)], functions: [frow('A', 130000)] }), published, 130001).differs, true);
  // a new row, a changed row and a dropped row each differ
  const added = vmap({ builds: [bld(130000)], functions: [frow('A', 130000), frow('B', 130000)] });
  assert.deepEqual(servedDifference(added, published, 130000).added, ['function B (fp 0x00000000)']);
  const changed = vmap({ builds: [bld(130000)], functions: [frow('A', 130000, 0x6600)] });
  assert.deepEqual(servedDifference(changed, published, 130000).changed, ['function A (fp 0x00000000)']);
  const dropped = vmap({ builds: [bld(130000)], functions: [] });
  assert.deepEqual(servedDifference(dropped, published, 130000).removed, ['function A (fp 0x00000000)']);
  for (const c of [added, changed, dropped]) assert.deepEqual(checkCandidateChange({ candidate: c, published, cl: '130000' }), []);
  // rows of another CL do not count for this one
  assert.equal(servedDifference(vmap({ builds: [bld(130000), bld(130001)], functions: [frow('A', 130000)] }), published, 130000).differs, false);
  // not given: not judged; unreadable: holds
  assert.deepEqual(checkCandidateChange({ candidate: null, published, cl: '130000' }), []);
  assert.deepEqual(checkCandidateChange({ candidate: same, published: null, cl: '130000' }), []);
  assert.match(checkCandidateChange({ candidate: { error: 'bad feed' }, published, cl: '130000' }).join(), /could not be read: bad feed/);
});

test('identity: decide holds a CL the released loader or the published version object map already holds', () => {
  const served = vmap({ builds: [bld(127999, 'public 4242')] });
  const none = vmap();
  const run = (coverage, over = {}) => decide(base({ coverage: { buildid: '4242', ...coverage }, ...over }));
  assert.equal(run({ loaderMap: none, publishedMap: none }).decision, 'M');
  holds(run({ loaderMap: served, publishedMap: none }), /the released loader version object map already holds CL-127999 \(build 4242\)/);
  holds(run({ loaderMap: none, publishedMap: served }), /the published version object map already holds CL-127999/);
  holds(run({ loaderMap: none, publishedMap: { error: 'unreadable' } }), /could not be read/);
  // by build id alone: another CL label for the same Steam build
  holds(decide(base({ coverage: { buildid: '4242', loaderMap: vmap({ builds: [bld(120000, 'public 4242')] }), publishedMap: none } })), /already holds CL-127999/);
  // no coverage given: the history alone judges
  assert.equal(decide(base()).decision, 'M');
  // A run that cannot publish is not judged by it: a test run, a first publish, a proof run.
  const covered = { loaderMap: served, publishedMap: served };
  assert.equal(run(covered, { testAutopilot: true }).wouldBe, 'M');
  assert.equal(run(covered, { testAutopilot: true }).reasons.length, 0);
  assert.equal(run(covered, { firstPublish: true, g3: ok({ ok: true, cl: '127999', previousCl: '127999', firstPublish: true }) }).decision, 'M');
  assert.equal(run(covered, { g3: ok({ ok: true, cl: '127999', previousCl: '127004', proof: true }) }).decision, 'M');
});

test('identity: checkIdentity gives the reasons for a candidate and the seq a supersede replaces', () => {
  const published = vmap({ builds: [bld(130000)], functions: [frow('A', 130000)] });
  const history = hist(rel('130000', 'ModLoader', 1761900001));
  const changed = vmap({ builds: [bld(130000)], functions: [frow('A', 130000, 0x6600)] });
  const same = vmap({ builds: [bld(130000)], functions: [frow('A', 130000)] });
  const args = { repo: 'ModLoader', cl: '130000', buildid: '13000000', loaderMap: vmap(), publishedMap: published, historyLoaded: history };
  const sup = { seq: '1761900001', liveSeq: '1761900001' };
  // without the input: already held, whatever the candidate
  assert.match(checkIdentity({ ...args, candidate: changed }).reasons.join(), /published version object map already holds CL-130000/);
  // with the input and a changed candidate: accepted
  assert.deepEqual(checkIdentity({ ...args, candidate: changed, supersede: sup }), { reasons: [], supersedes: 1761900001 });
  // with the input and an identical candidate: rejected
  const identical = checkIdentity({ ...args, candidate: same, supersede: sup });
  assert.match(identical.reasons.join(), /changes nothing served for CL-130000/);
  assert.equal(identical.supersedes, 1761900001);
  // a seq that is not the live one, not in the history, or not a seq: rejected, and the CL stays held
  for (const bad of [{ seq: '1761900000', liveSeq: '1761900001' }, { seq: '1761900001', liveSeq: '1761900002' }, { seq: '1761900001', liveSeq: null }, { seq: 'latest', liveSeq: '1761900001' }, { seq: '0', liveSeq: '0' }, { seq: '1761900001 ', liveSeq: '1761900001' }]) {
    const r = checkIdentity({ ...args, candidate: changed, supersede: bad });
    assert.equal(r.supersedes, null, JSON.stringify(bad));
    assert.match(r.reasons.join(' | '), /supersede.*already holds CL-130000|already holds CL-130000.*supersede/s, JSON.stringify(bad));
  }
  // the named seq must be a release of THIS CL of THIS repo
  for (const other of [hist(rel('129999', 'ModLoader', 1761900001)), hist(rel('130000', 'Waila', 1761900001)), hist(rel('130000', 'ModLoader'))]) {
    assert.match(checkIdentity({ ...args, historyLoaded: other, candidate: changed, supersede: sup }).reasons.join(), /not a ModLoader release of CL-130000 in the release history/);
  }
  // a history that cannot be read holds
  assert.match(checkIdentity({ ...args, historyLoaded: { ok: false, error: 'cannot read h' }, candidate: changed, supersede: sup }).reasons.join(), /cannot read h/);
});

// What the chain does for one trigger of a CL on a state of what is released and what is served: decide (before
// the build, with the maps the release must not already be in) and the identity check of the candidate feed (after
// it). Nothing here has a time: the history entries carry one and no check reads it.
const AT = '2026-10-29T12:00:00Z';
function chain(state, cl, { supersede, rva = 0x5500, over = {}, previousCl = '127004' } = {}) {
  const buildid = `${cl}00`;
  const d = decide(base({ g3: ok({ ok: true, cl: String(cl), previousCl }), history: ok(state.history), coverage: { buildid, loaderMap: state.loader, publishedMap: state.published }, ...(supersede ? { supersede } : {}), ...over }));
  const candidate = vmap({
    builds: [...state.published.builds.filter((b) => b.cl !== cl), bld(cl)],
    functions: [...state.published.functions.filter((r) => r.cl !== cl), frow('Test::MapOnly', cl, rva)],
  });
  const id = checkIdentity({ repo: 'ModLoader', cl: String(cl), buildid, loaderMap: state.loader, publishedMap: state.published, candidate, supersede, historyLoaded: ok(state.history) });
  return { d, id, candidate };
}
const publish = (state, cl, candidate, seq) => {
  state.published = candidate;
  state.history = { ...state.history, releases: [...state.history.releases, { repo: 'ModLoader', cl: String(cl), at: AT, seq }] };
};
const freshState = () => ({ loader: vmap({ builds: [bld(127004)] }), published: vmap({ builds: [bld(127004)] }), history: { releases: [], attempts: {} } });

test('loop: a same-CL trigger repeated right after a publish, with no time gap, stops by version identity', () => {
  const state = freshState();
  const first = chain(state, 130000);
  assert.equal(first.d.decision, 'M');
  assert.deepEqual(first.id.reasons, []);
  publish(state, 130000, first.candidate, 1761900001);
  const seen = [];
  for (let n = 1; n <= 12; n++) {
    const t = chain(state, 130000);
    holds(t.d, /already released for CL-130000/);
    assert.match(t.d.reasons.join(' | '), /the published version object map already holds CL-130000/);
    assert.match(t.id.reasons.join(' | '), /the published version object map already holds CL-130000/);
    seen.push(t.d.decision);
  }
  assert.deepEqual(seen, Array(12).fill('HOLD'));
  // The loader's own change merges: its header holds the CL too, and the trigger still holds.
  state.loader = vmap({ builds: [bld(127004), bld(130000)] });
  for (let n = 1; n <= 12; n++) {
    const t = chain(state, 130000);
    holds(t.d, /the released loader version object map already holds CL-130000/);
    assert.notEqual(t.id.reasons.length, 0);
  }
  // Nothing is locked for good: the next CL goes through, and its seq rises.
  const next = chain(state, 130001);
  assert.equal(next.d.decision, 'M');
  assert.deepEqual(next.id.reasons, []);
  assert.ok(nextSeq(1761900001, 1761900001) > 1761900001);
});

test('loop: a trigger after a failed publish stops by version identity, whichever half was written', () => {
  // The upload went out and the history write failed: the published file holds the CL, the history does not.
  const served = freshState();
  const cand = chain(served, 130000).candidate;
  served.published = cand;
  for (let n = 1; n <= 12; n++) {
    const t = chain(served, 130000);
    holds(t.d, /the published version object map already holds CL-130000/);
    assert.ok(!/already released for/.test(t.d.reasons.join(' | ')), 'the history is empty: only the published file stops it');
    assert.notEqual(t.id.reasons.length, 0);
  }
  // The history was written and the upload failed: the history holds the release, the published file does not.
  const recorded = freshState();
  recorded.history = { releases: [{ repo: 'ModLoader', cl: '130000', at: AT, seq: 1761900001 }], attempts: {} };
  for (let n = 1; n <= 12; n++) holds(chain(recorded, 130000).d, /already released for CL-130000/);
  // Nothing served and nothing recorded is not a release: a retry may go, and releases once.
  const nothing = freshState();
  for (let n = 1; n <= 3; n++) assert.equal(chain(nothing, 130000).d.decision, 'M');
  publish(nothing, 130000, chain(nothing, 130000).candidate, 1761900001);
  assert.equal(chain(nothing, 130000).d.decision, 'HOLD');
});

test('loop: the attempts limit stands beside the version identity', () => {
  const state = freshState();
  state.history.attempts = { 130000: 2 };
  const missB = { g4: ok(aob([aobRow('SpawnActor', 'MISSING')])) };
  holds(chain(state, 130000, { over: missB }).d, /2 auto-fix attempts already used for CL-130000 \(limit 2\)/);
});

test('supersede: accepted with the input and a changed candidate, rejected without it or with an identical candidate', () => {
  const state = freshState();
  const first = chain(state, 130000);
  publish(state, 130000, first.candidate, 1761900001);
  state.loader = vmap({ builds: [bld(127004), bld(130000)] }); // the loader header has the CL too, as it does after the loader's change merges
  const sup = { seq: '1761900001', liveSeq: '1761900001' };
  // accepted: the owner asks for a second release and the candidate changed a row
  const ok2 = chain(state, 130000, { supersede: sup, rva: 0x6600 });
  assert.equal(ok2.d.decision, 'M');
  assert.equal(ok2.d.supersedes, 1761900001);
  assert.match(ok2.d.notes.join(' | '), /supersede: a second release of CL-130000, replacing the release served now \(seq 1761900001\)/);
  assert.deepEqual(ok2.id, { reasons: [], supersedes: 1761900001 });
  // rejected without the input, even with a changed candidate
  const plain = chain(state, 130000, { rva: 0x6600 });
  holds(plain.d, /already released for CL-130000/);
  assert.notEqual(plain.id.reasons.length, 0);
  assert.equal(plain.d.supersedes, undefined);
  // rejected with the input and an identical candidate: the decision before the build cannot see the candidate, the check after it does
  const same = chain(state, 130000, { supersede: sup });
  assert.match(same.id.reasons.join(' | '), /the candidate version object map changes nothing served for CL-130000/);
  // the second release publishes with a seq that rises
  publish(state, 130000, ok2.candidate, nextSeq(1761900001, 1761900001));
  assert.equal(state.history.releases.at(-1).seq, 1761900002);
});

// A loader header as the loader writes it, and what the workflow reads from it for G3: kBuiltCL (the client check's
// "previous_cl" step parses it). Once the loader's change for a CL has merged, the header's built CL is that CL.
const headerBuiltFor = (cl) => {
  const map = emptyMap('loader', cl);
  addBuild(map, bld(cl));
  const parsed = parse(emit(map));
  return { loader: parsed, previousCl: String(parsed.builtCL) };
};

test('supersede: G3 lets it through once the loader header already holds the CL (its kBuiltCL), and only with a changed candidate', () => {
  const state = freshState();
  publish(state, 130000, chain(state, 130000).candidate, 1761900001);
  const header = headerBuiltFor(130000);
  assert.equal(header.previousCl, '130000');
  state.loader = header.loader; // the loader's change for CL-130000 has merged: its header is built for the CL
  const sup = { seq: '1761900001', liveSeq: '1761900001' };
  // without a supersede: held by G3 (the header's built CL is the CL)
  const plain = chain(state, 130000, { previousCl: header.previousCl, rva: 0x6600 });
  holds(plain.d, /G3: CL-130000 is not newer than CL-130000/);
  assert.equal(plain.d.supersedes, undefined);
  // with a supersede and a changed candidate: accepted, and the notes say what was lifted
  const sup2 = chain(state, 130000, { previousCl: header.previousCl, supersede: sup, rva: 0x6600 });
  assert.equal(sup2.d.decision, 'M', sup2.d.reasons.join(' | '));
  assert.equal(sup2.d.supersedes, 1761900001);
  assert.deepEqual(sup2.id, { reasons: [], supersedes: 1761900001 });
  // with a supersede and an identical candidate: the decision cannot see the candidate, the identity check after the build rejects it
  const same = chain(state, 130000, { previousCl: header.previousCl, supersede: sup });
  assert.match(same.id.reasons.join(' | '), /the candidate version object map changes nothing served for CL-130000/);
  // a supersede that names a seq that is not live is no way around G3 either
  holds(chain(state, 130000, { previousCl: header.previousCl, supersede: { seq: '1761900000', liveSeq: '1761900001' }, rva: 0x6600 }).d, /G3: CL-130000 is not newer than CL-130000/);
  holds(chain(state, 130000, { previousCl: header.previousCl, supersede: { seq: '1761900001', liveSeq: '1761900001' }, rva: 0x6600, over: { history: ok({ releases: [], attempts: {} }) } }).d, /G3: CL-130000 is not newer than CL-130000/);
  // it lifts the already-released holds only: the attempts limit, a failed gate and a disabled autopilot still hold, and so does a CL older than the header's
  state.history.attempts = { 130000: 2 };
  const missB = { g4: ok(aob([aobRow('SpawnActor', 'MISSING')])) };
  holds(chain(state, 130000, { previousCl: header.previousCl, supersede: sup, rva: 0x6600, over: missB }).d, /2 auto-fix attempts already used for CL-130000/);
  state.history.attempts = {};
  holds(chain(state, 130000, { previousCl: header.previousCl, supersede: sup, rva: 0x6600, over: { g1: ok({ ok: false }) } }).d, /G1/);
  holds(chain(state, 130000, { previousCl: header.previousCl, supersede: sup, rva: 0x6600, over: { autopilot: ok({ schema: 1, enabled: false, paths: ['M'] }) } }).d, /disabled/);
  holds(chain(state, 130000, { previousCl: '130001', supersede: sup, rva: 0x6600 }).d, /G3: CL-130000 is not newer than CL-130001/);
});

test('supersede: decide refuses it when the seq is wrong, not released, or the run is not an ordinary publish', () => {
  const history = hist(rel('127999', 'ModLoader', 1761900001));
  const served = vmap({ builds: [bld(127999)] });
  const coverage = { buildid: '12799900', loaderMap: served, publishedMap: served };
  const run = (supersede, over = {}) => decide(base({ history, coverage, supersede, ...over }));
  assert.equal(run({ seq: '1761900001', liveSeq: '1761900001' }).decision, 'M');
  holds(run({ seq: '1761900000', liveSeq: '1761900001' }), /supersede names seq 1761900000, but the live published version object map is seq 1761900001/);
  holds(run({ seq: '1761900001', liveSeq: null }), /seq of the live published version object map was not given/);
  holds(run({ seq: '1761900001', liveSeq: '1761900001' }, { history: hist(rel('127999', 'ModLoader', 1761900009)) }), /not a ModLoader release of CL-127999/);
  holds(run({ seq: '1761900001', liveSeq: '1761900001' }, { history: hist() }), /not a ModLoader release of CL-127999/);
  holds(run({ seq: '', liveSeq: '1' }), /is not a seq/);
  // Never with a test run, a first publish or a rehearsal.
  for (const flag of ['testAutopilot', 'firstPublish', 'rehearsal']) holds(run({ seq: '1761900001', liveSeq: '1761900001' }, { [flag]: true }), /a supersede is only for an ordinary publishing run/);
  // It lifts the already-released hold and nothing else: a failed gate, a disabled autopilot, the attempts limit and an unreadable map all still hold.
  const sup = { seq: '1761900001', liveSeq: '1761900001' };
  holds(run(sup, { g1: ok({ ok: false }) }), /G1/);
  holds(run(sup, { autopilot: ok({ schema: 1, enabled: false, paths: ['M'] }) }), /disabled/);
  holds(run(sup, { g4: ok(aob([aobRow('SpawnActor', 'MISSING')])), history: ok({ releases: [rel('127999', 'ModLoader', 1761900001)], attempts: { 127999: 2 } }) }), /2 auto-fix attempts/);
  holds(run(sup, { coverage: { ...coverage, publishedMap: { error: 'unreadable' } } }), /could not be read/);
  // The named seq has to be a release of this very CL: another CL stays held.
  holds(run(sup, { g3: ok({ ok: true, cl: '128000', previousCl: '127999' }), history }), /not a ModLoader release of CL-128000/);
});

test('cli: --supersede is read from the flags and the live seq from the published file', () => {
  const s = idScratch();
  const published = s.w('published.txt', K1_LF);
  const history = s.w('history.json', JSON.stringify({ releases: [{ repo: 'ModLoader', cl: '127999', at: AT, seq: 1761900000 }], attempts: {} }));
  const files = cliFiles({ history: JSON.parse(readFileSync(history, 'utf8')) });
  // The fixture's published file holds neither CL-127999 nor build 4242: a plain trigger passes; the build id of CL-128786 holds it.
  assert.equal(runCli(files, ['--published', published, '--buildid', '4242']).status, 1, 'the history already holds the CL');
  const sup = runCli(files, ['--published', published, '--buildid', '4242', '--supersede', '1761900000']);
  assert.equal(sup.status, 0, JSON.stringify(sup.out));
  assert.equal(sup.out.decision, 'M');
  assert.equal(sup.out.supersedes, 1761900000);
  const wrong = runCli(files, ['--published', published, '--buildid', '4242', '--supersede', '1761900005']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.out.reasons.join(' | '), /supersede names seq 1761900005, but the live published version object map is seq 1761900000/);
  // A build the published file holds is covered unless a supersede names the live release.
  const byBuild = runCli(cliFiles({ history: { releases: [], attempts: {} } }), ['--published', published, '--buildid', '2']);
  assert.equal(byBuild.status, 1);
  assert.match(byBuild.out.reasons.join(' | '), /the published version object map already holds CL-127999 \(build 2\)/);
  // A given option that cannot be read is a hold, never a pass.
  assert.equal(runCli(files, ['--published', join(s.dir, 'missing.txt')]).status, 1);
  // A supersede with no published file has no live seq to compare with.
  const noLive = runCli(files, ['--loader-header', s.w('loader.h', LOADER_LF), '--supersede', '1761900000']);
  assert.equal(noLive.status, 1);
  assert.match(noLive.out.reasons.join(' | '), /seq of the live published version object map was not given/);
});

test('cli: an empty --buildid is a usage error for both commands, never a build match that was skipped', () => {
  const s = idScratch();
  const published = s.w('published.txt', K1_LF);
  const files = cliFiles();
  const r = runCli(files, ['--published', published, '--buildid', '']);
  assert.equal(r.status, 2, 'decide');
  const id = runIdentity(s, ['--cl', '140000', '--buildid', '', '--published', published]);
  assert.equal(id.status, 2, 'identity');
  assert.match(id.stderr, /--buildid is empty: the run has no build id/);
  assert.equal(runIdentity(s, ['--cl', '140000', '--buildid', 'abc', '--published', published]).status, 2, 'not a number');
});

test('cli: a --now is not read', () => {
  const r = runCli(cliFiles(), ['--now', 'not a date']);
  assert.equal(r.status, 0);
  assert.equal(r.out.decision, 'M');
});

// The identity subcommand, on the loader's own fixtures: loader.h (CL-127004 and CL-128786) and the signed
// TEST-key file (CL-128786 and CL-130001, seq 1761900000).
const LF = (s) => s.replace(/\r\n/g, '\n');
const LOADER_LF = LF(readFileSync(join(here, 'fixtures', 'version-map', 'loader.h'), 'utf8'));
const K1_LF = LF(readFileSync(join(here, 'fixtures', 'vmap-sign', 'test-feed-k1.txt'), 'utf8'));
function idScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'identity-'));
  return { dir, w: (name, text) => { writeFileSync(join(dir, name), text); return join(dir, name); } };
}
function runIdentity(s, flags, repo = 'ModLoader') {
  const report = join(s.dir, 'identity.json');
  const r = spawnSync(process.execPath, [cli, 'identity', '--repo', repo, ...flags, '--report', report], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, report: r.status === 2 ? null : JSON.parse(readFileSync(report, 'utf8')) };
}
// The candidate feed for the fixtures: the published rows with one edit.
function candidateText(edit) {
  const m = parseSignedFeedRows(K1_LF);
  edit(m);
  return exportFeed(m);
}

test('cli identity: a new CL that changes what is served passes; one that is held, or changes nothing, does not', () => {
  const s = idScratch();
  const loader = s.w('loader.h', LOADER_LF);
  const published = s.w('published.txt', K1_LF);
  const add = (m) => { m.builds.push({ cl: 140000, stamp: 0x66666666, size: 0x06000000, source: 'public 27000000' }); m.functions.push(frow('Test::MapOnly', 140000)); };
  const fresh = s.w('fresh.txt', candidateText(add));
  const ok1 = runIdentity(s, ['--cl', '140000', '--buildid', '27000000', '--loader-header', loader, '--published', published, '--feed', fresh]);
  assert.equal(ok1.status, 0, ok1.stderr);
  assert.equal(ok1.report.ok, true);
  assert.equal(ok1.report.step, 'identity');
  // A publish that changes nothing: the candidate is the published rows.
  const identical = s.w('identical.txt', candidateText(() => {}));
  const none = runIdentity(s, ['--cl', '140000', '--buildid', '27000000', '--loader-header', loader, '--published', published, '--feed', identical]);
  assert.equal(none.status, 3);
  assert.match(none.report.reasons.join(' | '), /the candidate version object map changes nothing served for CL-140000/);
  // The published file already holds CL-130001, and the loader header already holds CL-127004.
  const held = runIdentity(s, ['--cl', '130001', '--loader-header', loader, '--published', published, '--feed', fresh]);
  assert.equal(held.status, 3);
  assert.match(held.report.reasons.join(' | '), /the published version object map already holds CL-130001/);
  const loaderHeld = runIdentity(s, ['--cl', '127004', '--loader-header', loader, '--published', published, '--feed', fresh]);
  assert.equal(loaderHeld.status, 3);
  assert.match(loaderHeld.report.reasons.join(' | '), /the released loader version object map already holds CL-127004/);
  // The Steam build id of CL-128786 covers a CL label that is new.
  const byBuild = runIdentity(s, ['--cl', '140000', '--buildid', '26271156', '--loader-header', loader, '--published', published, '--feed', fresh]);
  assert.equal(byBuild.status, 3);
  assert.match(byBuild.report.reasons.join(' | '), /already holds CL-140000 \(build 26271156\)/);
  // An unreadable file holds; a bad option is a usage error.
  assert.equal(runIdentity(s, ['--cl', '140000', '--published', join(s.dir, 'missing.txt'), '--feed', fresh]).status, 3);
  assert.equal(runIdentity(s, ['--cl', 'x']).status, 2);
  assert.equal(runIdentity(s, ['--cl', '140000', '--supersede', '1761900000']).status, 2, 'a supersede needs the history');
});

test('cli identity: a second release of a CL names the live seq and still has to change what is served', () => {
  const s = idScratch();
  const loader = s.w('loader.h', LOADER_LF);
  const published = s.w('published.txt', K1_LF);
  const history = s.w('history.json', JSON.stringify({ releases: [{ repo: 'ModLoader', cl: '130001', at: AT, seq: 1761900000 }], attempts: {} }));
  const changed = s.w('changed.txt', candidateText((m) => { m.fields[0].offset = 0x58; }));
  const identical = s.w('identical.txt', candidateText(() => {}));
  const base2 = ['--cl', '130001', '--loader-header', loader, '--published', published, '--history', history];
  // accepted: the input names the live release and the candidate changed a row
  const accepted = runIdentity(s, [...base2, '--feed', changed, '--supersede', '1761900000']);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.report.supersedes, 1761900000);
  // rejected: the input, an identical candidate
  const same = runIdentity(s, [...base2, '--feed', identical, '--supersede', '1761900000']);
  assert.equal(same.status, 3);
  assert.match(same.report.reasons.join(' | '), /changes nothing served for CL-130001/);
  // rejected: no input, a changed candidate
  const plain = runIdentity(s, [...base2, '--feed', changed]);
  assert.equal(plain.status, 3);
  assert.match(plain.report.reasons.join(' | '), /already holds CL-130001/);
  // rejected: an input that names a seq that is not the live one
  const stale = runIdentity(s, [...base2, '--feed', changed, '--supersede', '1761800000']);
  assert.equal(stale.status, 3);
  assert.match(stale.report.reasons.join(' | '), /supersede names seq 1761800000, but the live published version object map is seq 1761900000/);
});

// The dedicated server's file: the same check against the server asset (server steam_build labels, repo ModLoaderServer).
// The signature is verified by published-base.mjs before this reads the file, so the sig line here is only a placeholder.
const SERVER_LF = LF(readFileSync(join(here, 'fixtures', 'version-map', 'server.feed.txt'), 'utf8'));
const SERVER_SIGNED = SERVER_LF.replace('\n', '\nseq\t1761900000\n') + 'sig\tk1\tAAAA\n';
test('cli identity: the server file is judged like the client file: its build id is read from a server steam_build label, and its history key is ModLoaderServer', () => {
  const s = idScratch();
  const published = s.w('version-map-server.v1.txt', SERVER_SIGNED);
  const candidate = (edit) => {
    const m = parseSignedFeedRows(SERVER_SIGNED, 'x', { server: true });
    edit(m);
    return exportFeed(m);
  };
  const add = (m) => { m.builds.push({ cl: 140000, stamp: 0x66666666, size: 0x06000000, source: 'server steam_build 27000001' }); m.functions.push({ ...frow('Test::ServerOnly', 140000), pattern: null, resultOffset: 0, followRel32At: -1, followRipDispAt: -1, rva: 0x5500 }); };
  const fresh = s.w('fresh.txt', candidate(add));
  const ok = runIdentity(s, ['--cl', '140000', '--buildid', '27000001', '--published', published, '--feed', fresh], 'ModLoaderServer');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.report.ok, true);
  // The published server file already holds CL-127004, and the Steam build id of that row covers a CL label that is new.
  const held = runIdentity(s, ['--cl', '127004', '--published', published, '--feed', fresh], 'ModLoaderServer');
  assert.equal(held.status, 3);
  assert.match(held.report.reasons.join(' | '), /the published version object map already holds CL-127004/);
  const byBuild = runIdentity(s, ['--cl', '140000', '--buildid', '25642172', '--published', published, '--feed', fresh], 'ModLoaderServer');
  assert.equal(byBuild.status, 3);
  assert.match(byBuild.report.reasons.join(' | '), /already holds CL-140000 \(build 25642172\)/);
  // A candidate that is the published rows changes nothing.
  const identical = s.w('identical.txt', candidate(() => {}));
  const none = runIdentity(s, ['--cl', '140000', '--published', published, '--feed', identical], 'ModLoaderServer');
  assert.equal(none.status, 3);
  assert.match(none.report.reasons.join(' | '), /changes nothing served for CL-140000/);
  // A second release of CL-127004: the supersede is judged against the ModLoaderServer entry of the history, not the client's.
  const changed = s.w('changed.txt', candidate((m) => { m.fields[0].offset = 0x58; }));
  const base2 = ['--cl', '127004', '--published', published, '--feed', changed, '--supersede', '1761900000'];
  const mine = s.w('history.json', JSON.stringify({ releases: [{ repo: 'ModLoaderServer', cl: '127004', at: AT, seq: 1761900000 }], attempts: {} }));
  const accepted = runIdentity(s, [...base2, '--history', mine], 'ModLoaderServer');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.report.supersedes, 1761900000);
  const theirs = s.w('client-history.json', JSON.stringify({ releases: [{ repo: 'ModLoader', cl: '127004', at: AT, seq: 1761900000 }], attempts: {} }));
  const refused = runIdentity(s, [...base2, '--history', theirs], 'ModLoaderServer');
  assert.equal(refused.status, 3);
});

test('release limits: at most 2 Claude attempts per CL, B only', () => {
  const missB = ok(aob([aobRow('SpawnActor', 'MISSING')]));
  assert.equal(decide(base({ g4: missB, history: ok({ releases: [], attempts: { 127999: 1 } }) })).decision, 'B');
  holds(decide(base({ g4: missB, history: ok({ releases: [], attempts: { 127999: 2 } }) })), /2 auto-fix attempts/);
  holds(decide(base({ g4: missB, history: ok({ releases: [], attempts: { 127999: -1 } }) })), /attempts entry is malformed/);
  holds(decide(base({ g4: missB, history: ok({ releases: [], attempts: { 127999: 'two' } }) })), /attempts entry is malformed/);
  // attempts for another CL do not count
  assert.equal(decide(base({ g4: missB, history: ok({ releases: [], attempts: { 120000: 9 } }) })).decision, 'B');
  // path M does not use the attempts counter
  assert.equal(decide(base({ history: ok({ releases: [], attempts: { 127999: 9 } }) })).decision, 'M');
});

test('release limits: a run that died before a decision (infra) is not an attempt', () => {
  const missB = ok(aob([aobRow('SpawnActor', 'MISSING')]));
  const run = (records) => decide(base({ g4: missB, history: ok({ releases: {}, attempts: { 127999: records } }) }));
  const rejected = (n) => ({ run: String(n), outcome: 'rejected' });
  const infra = (n) => ({ run: String(n), outcome: 'infra' });
  // cancelled, lost-runner and download-failure runs are recorded and never counted, however many there are
  assert.equal(run([infra(1), infra(2), infra(3), infra(4)]).decision, 'B');
  // one rejected run and any number of infra runs: one attempt used, one left
  assert.equal(run([rejected(1), infra(2), infra(3)]).decision, 'B');
  // two rejected runs stop it, with infra runs between them or not
  holds(run([rejected(1), rejected(2)]), /2 auto-fix attempts already used for CL-127999 \(limit 2\)/);
  holds(run([rejected(1), infra(2), rejected(3), infra(4)]), /2 auto-fix attempts already used for CL-127999 \(limit 2\)/);
  // the old shape, a bare number, still counts as that many rejected attempts
  holds(decide(base({ g4: missB, history: ok({ releases: [], attempts: { 127999: 2 } }) })), /2 auto-fix attempts/);
  // a record that is neither is malformed
  holds(run([{ run: '1', outcome: 'cancelled' }]), /attempts entry is malformed/);
});

test('release limits: a retry reset starts the count again for its CL, and only for it', () => {
  const missB = ok(aob([aobRow('SpawnActor', 'MISSING')]));
  const rejected = (n) => ({ run: String(n), outcome: 'rejected' });
  const reset = { reset: true, actor: 'owner', run: '9', cleared: 2 };
  const run = (attempts) => decide(base({ g4: missB, history: ok({ releases: {}, attempts }) }));
  // two rejected, then the reset: the full allowance is back
  assert.equal(run({ 127999: [rejected(1), rejected(2), reset] }).decision, 'B');
  // what is rejected after the reset counts again
  assert.equal(run({ 127999: [rejected(1), rejected(2), reset, rejected(3)] }).decision, 'B');
  holds(run({ 127999: [rejected(1), rejected(2), reset, rejected(3), rejected(4)] }), /2 auto-fix attempts already used for CL-127999/);
  // a reset recorded for another CL leaves this one held
  holds(run({ 127999: [rejected(1), rejected(2)], 120000: [reset] }), /2 auto-fix attempts already used for CL-127999/);
});

test('history: the keyed shape and the old array shape read the same, and a repeated identity is refused', () => {
  const entry = { repo: 'ModLoader', cl: '127999', at: AT, seq: 1761900001 };
  const keyed = ok({ releases: { 'ModLoader:127999': entry }, attempts: {} });
  holds(decide(base({ history: keyed })), /already released for CL-127999/);
  holds(decide(base({ history: ok({ releases: [entry], attempts: {} }) })), /already released for CL-127999/);
  // another repo's entry for the same CL is another identity
  assert.equal(decide(base({ history: ok({ releases: { 'WAILA:127999': { ...entry, repo: 'WAILA' } }, attempts: {} }) })).decision, 'M');
  // one identity twice in the old shape (the 2026-11-19 duplicate of CL-130045): refused, never read as one of them
  holds(decide(base({ history: ok({ releases: [entry, { ...entry, seq: 1761900002 }], attempts: {} }) })), /ModLoader CL-127999 is listed twice/);
  // a key that does not name its entry
  holds(decide(base({ history: ok({ releases: { 'ModLoader:127000': entry }, attempts: {} }) })), /does not match its entry/);
});

test('fail closed: malformed history', () => {
  holds(decide(base({ history: ok({}) })), /malformed/);
  holds(decide(base({ history: ok({ releases: 'none', attempts: {} }) })), /malformed/);
  holds(decide(base({ history: ok({ releases: [{ repo: 'ModLoader', cl: 'abc', at: AT }], attempts: {} }) })), /malformed release/);
  holds(decide(base({ history: ok({ releases: [{ repo: 7, cl: '1', at: AT }], attempts: {} }) })), /malformed release/);
  for (const seq of ['1761900001', 0, -5, 1.5, null]) holds(decide(base({ history: ok({ releases: [{ repo: 'ModLoader', cl: '1', at: AT, seq }], attempts: {} }) })), /malformed release/);
  holds(decide(base({ history: ok({ releases: [null], attempts: {} }) })), /malformed release/);
  holds(decide(base({ history: ok({ releases: [], attempts: [] }) })), /malformed/);
});

// ------------------------------------------------------------ CLI

const cli = join(here, 'decide.mjs');
function runCli(files, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'decide-'));
  const names = {};
  for (const [k, v] of Object.entries(files)) {
    if (v === undefined) continue;
    names[k] = join(dir, `${k}.json`);
    writeFileSync(names[k], typeof v === 'string' ? v : JSON.stringify(v));
  }
  const args = ['--repo', 'ModLoader'];
  for (const k of ['autopilot', 'g1', 'g2', 'g3', 'g4', 'g5', 'plugins', 'history']) args.push(`--${k}`, names[k] ?? join(dir, `${k}-missing.json`));
  const r = spawnSync(process.execPath, [cli, ...args, ...extra], { encoding: 'utf8', windowsHide: true });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* leave null */ }
  return { status: r.status, out, dir };
}
// A rig-plugins.json (the check's facts of the DLLs the rig runs) with these rows; its path.
const rigFile = (plugins) => {
  const f = join(mkdtempSync(join(tmpdir(), 'decide-rig-')), 'rig-plugins.json');
  writeFileSync(f, JSON.stringify({ branch: 'public', tags: '', plugins }));
  return f;
};
const cliFiles = (over = {}) => {
  const b = base();
  const f = {};
  for (const k of ['autopilot', 'g1', 'g2', 'g3', 'g4', 'g5', 'plugins', 'history']) f[k] = b[k].value;
  return { ...f, ...over };
};

test('cli: exit 0 and a decision file for M', () => {
  const r = runCli(cliFiles(), []);
  assert.equal(r.status, 0);
  assert.equal(r.out.decision, 'M');
});

test('cli: exit 1 with HOLD for a disabled autopilot', () => {
  const r = runCli(cliFiles({ autopilot: { schema: 1, enabled: false, paths: ['M'] } }));
  assert.equal(r.status, 1);
  assert.equal(r.out.decision, 'HOLD');
});

test('cli: a missing file for any input is a HOLD', () => {
  for (const k of ['autopilot', 'g1', 'g2', 'g3', 'g4', 'g5', 'plugins', 'history']) {
    const r = runCli(cliFiles({ [k]: undefined }));
    assert.equal(r.status, 1, k);
    assert.equal(r.out.decision, 'HOLD', k);
    assert.match(r.out.reasons.join(' '), /cannot read/, k);
  }
});

test('cli: unparseable or empty JSON is a HOLD', () => {
  for (const bad of ['{not json', '', 'null', '"ok"']) {
    for (const k of ['autopilot', 'g3', 'g4']) {
      const r = runCli(cliFiles({ [k]: bad }));
      assert.equal(r.status, 1, `${k} <- ${JSON.stringify(bad)}`);
      assert.equal(r.out.decision, 'HOLD');
    }
  }
});

test('cli: a BOM in a JSON file is tolerated', () => {
  const r = runCli(cliFiles({ g1: String.fromCharCode(0xfeff) + '{"ok":true}' }));
  assert.equal(r.out.decision, 'M');
  assert.equal(r.status, 0);
});

test('cli: exit 10 for B, so a caller that only checks "zero" cannot ship an auto-fix as a CL-only', () => {
  const r = runCli(cliFiles({ g4: aob([aobRow('SpawnActor', 'MISSING')]) }));
  assert.equal(r.status, 10);
  assert.equal(r.out.decision, 'B');
});

test('cli: exit 1 for a path C hold and for an unverified SDK global', () => {
  const c = runCli(cliFiles({ autopilot: { schema: 1, enabled: true, paths: ['M', 'B', 'C'] }, g5: layout('UFoo') }));
  assert.equal(c.status, 1);
  assert.equal(c.out.path, 'C');
  const g = runCli(cliFiles({ g4: aob([aobRow('GetWorld')], { noGlobals: true }) }));
  assert.equal(g.status, 1);
  assert.match(g.out.reasons.join(), /SDK global/);
});

test('cli: --first-publish decides M with the autopilot file off and leaves that file untouched; without it the same files HOLD', () => {
  const off = { schema: 1, enabled: false, paths: ['M'] };
  const files = cliFiles({ autopilot: off, g3: { ok: true, cl: '127004', previousCl: '127004', firstPublish: true } });
  const plain = runCli(files);
  assert.equal(plain.status, 1);
  assert.equal(plain.out.decision, 'HOLD');
  const fp = runCli(files, ['--first-publish']);
  assert.equal(fp.status, 0);
  assert.equal(fp.out.decision, 'M');
  assert.equal(fp.out.firstPublish, true);
  assert.deepEqual(JSON.parse(readFileSync(join(fp.dir, 'autopilot.json'), 'utf8')), off, 'state/autopilot.json is read by nobody and written by nobody');
  // Never with a test run.
  assert.notEqual(runCli(files, ['--first-publish', '--test-autopilot']).status, 0);
});

test('cli: an input that is a directory is a HOLD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decide-dir-'));
  mkdirSync(join(dir, 'g1.json'));
  const r = spawnSync(process.execPath, [cli, '--repo', 'ModLoader', '--autopilot', dir, '--g1', join(dir, 'g1.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).decision, 'HOLD');
});

test('cli: bad usage exits 2, never 0', () => {
  const r = spawnSync(process.execPath, [cli, '--repo'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 2);
});


test('cli: --out writes the same decision', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'decide-out-')), 'decision.json');
  const r = runCli(cliFiles(), ['--out', out]);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), r.out);
});

// ------------------------------------------------------------ plugin verdicts and gone keys

test('M: one plugin that cannot load on the new CL is held alone; the rest are updated', () => {
  const plugins = ok({ status: 'fail', plugins: [{ name: 'BetterCheats', verdict: 'PASS' }, { name: 'WAILA', verdict: 'REFUSED', note: 'does not declare PLUGIN_MAP_MIGRATED' }] });
  const r = decide(base({ plugins }));
  assert.equal(r.decision, 'M');
  assert.equal(r.pluginsOk, true);
  assert.deepEqual(r.plugins.map((p) => [p.name, p.status]), [['BetterCheats', 'updated'], ['WAILA', 'held']]);
  assert.match(r.plugins[1].reasons[0], /cannot load on the new CL: REFUSED \(does not declare PLUGIN_MAP_MIGRATED\); rebuild path/);
  assert.match(r.notes.join(' '), /WAILA held/);
});

test('M: a migrated plugin that reads game members directly is held alone (rule 3); the rest are updated', () => {
  const plugins = ok({ status: 'fail', plugins: [{ name: 'BetterCheats', verdict: 'PASS' },
    { name: 'WAILA', verdict: 'RULE3', note: '91 direct reads of game members, first WAILA/crafter_detector.cpp(116)' },
    { name: 'Compass', verdict: 'PASS' }] });
  const r = decide(base({ plugins }));
  assert.equal(r.decision, 'M');
  assert.equal(r.pluginsOk, true);
  assert.deepEqual(r.plugins.map((p) => [p.name, p.status]), [['BetterCheats', 'updated'], ['WAILA', 'held'], ['Compass', 'updated']]);
  assert.equal(r.plugins[1].heldAlone, true);
  assert.match(r.plugins[1].reasons[0], /declares PLUGIN_MAP_MIGRATED but reads game members directly, stays on its last release: RULE3 \(91 direct reads/);
  assert.match(r.notes.join(' '), /WAILA held/);
});

test('M: a plugin that crashes in the check is held alone; the rest proceed', () => {
  const plugins = ok({ status: 'fail', plugins: [{ name: 'BetterCheats', verdict: 'PASS' },
    { name: 'WaveOptimiser', verdict: 'FAIL', note: 'PluginInit crashed (exception 0xC0000005)' },
    { name: 'Compass', verdict: 'FAIL', note: 'DoThing stopped at 0xC0000094' },
    { name: 'WAILA', verdict: 'FAIL', patterns: [{ name: 'GetCargo', recorded: true, required: true, result: 'MISSING' }] }] });
  const r = decide(base({ plugins }));
  assert.equal(r.decision, 'M');
  assert.equal(r.pluginsOk, true);
  assert.deepEqual(r.plugins.map((p) => [p.name, p.status]), [['BetterCheats', 'updated'], ['WaveOptimiser', 'held'], ['Compass', 'held'], ['WAILA', 'updated']]);
  assert.match(r.plugins[1].reasons[0], /crashed in the check, stays on its last release/);
  assert.match(r.notes.join(' '), /WaveOptimiser held/);
});

test('M: a plugin refused for a key with no map row is held as refused, not as a crash', () => {
  const note = 'PluginInit took the Game-SDK globals; the probe ended PluginInit there, as planned, when it reached for a hook the probe does not provide (0xC0000005)';
  const plugins = ok({ status: 'fail', plugins: [
    { name: 'BetterCheats', verdict: 'FAIL', refused: true, note, failures: [{ name: 'UCrGameInstance::ServerSessionName', detail: 'refused: no row for CL-128786, and a native member has no other source' }] }] });
  const r = decide(base({ plugins }));
  assert.equal(r.plugins[0].status, 'held');
  assert.equal(r.plugins[0].reasons[0], 'refused: required key UCrGameInstance::ServerSessionName has no map row, stays on its last release');
  assert.doesNotMatch(r.notes.join(' '), /crashed/);
});

test('M: the scanner stopping on its own one-entry hooks table is the harness, not a plugin crash', () => {
  const plugins = ok({ status: 'fail', plugins: [{ name: 'WaveOptimiser', verdict: 'FAIL',
    note: 'PluginInit took the Game-SDK globals (it stopped at exception 0xC0000005, outside the one table it was given)' }] });
  const r = decide(base({ plugins }));
  assert.equal(r.plugins[0].status, 'updated');
  assert.equal(r.plugins[0].degraded.length, 1);
});

test('M: refusals for a missing row are settled by the rows map mode wrote; others name the key', () => {
  const note = 'PluginInit took the Game-SDK globals (it stopped at exception 0xC0000005, outside the one table it was given)';
  const noRow = 'refused: no row for CL-128786, and a native member has no other source';
  const plugins = ok({ status: 'fail', plugins: [
    { name: 'WaveOptimiser', verdict: 'FAIL', note, failures: [{ name: 'UMassEntitySubsystem::EntityManager', detail: noRow }] },
    { name: 'Compass', verdict: 'FAIL', note, failures: [{ name: 'UFoo::Bar', detail: noRow }] }] });
  const fields = ok({ written: true, cl: 127999, added: 1, rows: ['UMassEntitySubsystem::EntityManager'], absent: [], covered: [], notes: [], problems: [], degraded: {} });
  const r = decide(base({ plugins, fields }));
  assert.equal(r.pluginsOk, true);
  assert.deepEqual(r.plugins.map((p) => [p.name, p.status, p.degraded.map((d) => d.key)]),
    [['WaveOptimiser', 'updated', []], ['Compass', 'updated', ['UFoo::Bar']]]);
});

test('M: a plugin missing a required field or pattern is updated and degraded, not held', () => {
  const plugins = ok({ status: 'fail', plugins: [{ name: 'BetterCheats', verdict: 'PASS' },
    { name: 'WAILA', verdict: 'FAIL', patterns: [{ name: 'GetCargo', recorded: true, required: true, result: 'MISSING' }, { name: 'Extra', recorded: true, required: false, result: 'AMBIGUOUS' }, { name: 'Fine', recorded: true, required: true, result: 'OK' }] }] });
  const fields = ok({ written: true, cl: 127999, added: 0, absent: [{ key: 'UFoo::Gone', owners: ['BetterCheats'], severity: 'high' }], covered: ['UFoo'], notes: [], problems: [],
    degraded: { BetterCheats: [{ key: 'UFoo::Gone', severity: 'high', why: 'resolves on the reference build only' }] } });
  const r = decide(base({ g5: ok(layout('UFoo')), plugins, fields }));
  assert.equal(r.decision, 'M');
  assert.equal(r.pluginsOk, true);
  assert.deepEqual(r.plugins.map((p) => [p.name, p.status, p.degraded.map((d) => `${d.key}:${d.severity}`)]),
    [['BetterCheats', 'updated', ['UFoo::Gone:high']], ['WAILA', 'updated', ['GetCargo:high', 'Extra:low']]]);
  assert.match(r.notes.join(' '), /BetterCheats updated, degraded: UFoo::Gone off \(HIGH: 1 required request\(s\) missing\)/);
});

test('M: a plugin that crashed, did not build or was not verified is held alone; the rest proceed (B5)', () => {
  for (const verdict of ['CRASH', 'ERROR', 'BUILD-FAILED', 'FETCH-FAILED', 'OFFSETS', 'OFFSETS-UNCHECKED']) {
    const plugins = ok({ status: 'fail', plugins: [{ name: 'BetterCheats', verdict: 'PASS' }, { name: 'WAILA', verdict, note: 'it broke' },
      { name: 'Compass', verdict: 'PASS' }] });
    const r = decide(base({ plugins }));
    assert.equal(r.decision, 'M', verdict);
    assert.deepEqual(r.reasons, [], verdict);
    assert.equal(r.pluginsOk, true, verdict);
    assert.deepEqual(r.plugins.map((p) => [p.name, p.status, p.heldAlone === true]), [['BetterCheats', 'updated', false], ['WAILA', 'held', true], ['Compass', 'updated', false]], verdict);
    assert.match(r.plugins[1].reasons[0], new RegExp(`not verified on the new CL, stays on its last release: ${verdict} \\(it broke\\)`));
    assert.match(r.notes.join(' '), /WAILA held/);
  }
});

test('M: several plugins held for different reasons, one build failed; the loader alone still ships', () => {
  const plugins = ok({ status: 'fail', plugins: [{ name: 'BetterCheats', verdict: 'BUILD-FAILED' }, { name: 'WAILA', verdict: 'CRASH' },
    { name: 'Compass', verdict: 'RULE3', note: '3 direct reads' }, { name: 'Codex', verdict: 'REFUSED' }, { name: 'RuptureTimer', verdict: 'PASS' }] });
  const r = decide(base({ plugins }));
  assert.equal(r.decision, 'M');
  assert.equal(r.pluginsOk, true);
  assert.deepEqual(r.plugins.map((p) => p.status), ['held', 'held', 'held', 'held', 'updated']);
  const every = decide(base({ plugins: ok({ status: 'fail', plugins: [{ name: 'BetterCheats', verdict: 'BUILD-FAILED' }, { name: 'WAILA', verdict: 'BUILD-FAILED' }] }) }));
  assert.equal(every.decision, 'M', 'with every plugin held alone, the loader still ships');
});

test('HOLD: a verdict this file does not know, a loader request or a missing global still holds the whole update', () => {
  const plugins = ok({ status: 'fail', plugins: [{ name: 'BetterCheats', verdict: 'PASS' }, { name: 'WAILA', verdict: 'MYSTERY' }] });
  const r = decide(base({ plugins }));
  holds(r, /1 plugin\(s\) not verified on CL-127999, which the loader cannot turn off: WAILA MYSTERY/);
  assert.equal(r.pluginsOk, false);
  const fields = ok({ written: false, cl: 127999, added: 0, absent: [], covered: [], notes: [], problems: ['field UFoo::Core: resolves on the reference build only; the loader itself reads it, so every plugin depends on it'] });
  holds(decide(base({ g5: ok(layout('UFoo')), fields })), /the loader itself reads it/);
  holds(decide(base({ g4: ok(aob([aobRow('GetWorld')], { noGlobals: true })) })), /SDK global offsets not resolved/);
});

test('test autopilot: a disabled autopilot still holds, and wouldBe names the path it would take', () => {
  const autopilot = ok({ schema: 1, enabled: false, paths: ['M'] });
  const r = decide(base({ autopilot, testAutopilot: true }));
  holds(r, /autopilot is disabled/);
  assert.equal(r.wouldBe, 'M');
  assert.equal(r.test, true);
  assert.equal(r.reasons.length, 1);
  const real = decide(base({ autopilot }));
  holds(real, /autopilot is disabled/);
  assert.equal(real.wouldBe, undefined, 'only a test run says what it would be');
  const bad = decide(base({ autopilot, testAutopilot: true, g2: ok({ ok: false }) }));
  assert.equal(bad.wouldBe, 'HOLD');
});

// ------------------------------------------------------------ candidate (the unattended chain)

const apOff = ok({ schema: 1, enabled: false, paths: ['M'] });
const holdsOnlyForAutopilot = (r) => {
  holds(r, /autopilot is disabled/);
  assert.equal(r.wouldBe, 'M', 'every other check reached M, so only the autopilot holds');
  assert.equal(r.candidate, true);
  assert.equal(r.test, undefined, 'a candidate is not a dispatched test run');
  assert.equal(r.path, 'M');
  assert.deepEqual(r.reasons, ['autopilot is disabled (enabled is not true)']);
};

test('candidate: a disabled autopilot holds publishing only, and says so', () => {
  holdsOnlyForAutopilot(decide(base({ autopilot: apOff, candidate: true })));
  // Without the flag the same inputs say nothing of a path: the chain stops.
  const plain = decide(base({ autopilot: apOff }));
  holds(plain, /autopilot is disabled/);
  assert.equal(plain.wouldBe, undefined);
  assert.equal(plain.candidate, undefined);
});

test('candidate: an enabled autopilot decides as always, and the result is still not a test run', () => {
  const r = decide(base({ candidate: true }));
  assert.equal(r.decision, 'M');
  assert.equal(r.ship, true);
  assert.equal(r.test, undefined);
});

test('candidate: every other HOLD reason still blocks the candidate (wouldBe is not M)', () => {
  const g = (over) => decide(base({ autopilot: apOff, candidate: true, ...over }));
  const blocked = (r, re) => {
    holds(r, re);
    assert.equal(r.wouldBe, 'HOLD', 'the candidate does not continue');
    assert.match(r.reasons.join(' | '), /autopilot is disabled/, 'the autopilot reason is still listed');
  };
  blocked(g({ g1: ok({ ok: false }) }), /G1 compile/);
  blocked(g({ g2: ok({ ok: false }) }), /G2 interface/);
  blocked(g({ g3: ok({ ok: true, cl: '127004', previousCl: '127004' }) }), /G3/);
  blocked(g({ g4: ok(aob([aobRow('GetWorld')], { noGlobals: true })) }), /SDK global offsets not resolved/);
  blocked(g({ g5: ok(layout('UFoo')) }), /path C held/);
  blocked(g({ plugins: ok({ status: 'fail', plugins: [{ name: 'WAILA', verdict: 'MYSTERY' }] }) }), /not verified/);
  blocked(g({ history: ok({ releases: [{ repo: 'ModLoader', cl: '127999', at: AT }], attempts: {} }) }), /already released for CL-127999/);
  blocked(g({ fields: ok({ written: false, cl: 127999, added: 0, absent: [], covered: [], notes: [], problems: ['field UFoo::Core: gone'] }) }), /field rows/);
  blocked(g({ autopilot: ok({ schema: 1, enabled: false, paths: ['B'] }) }), /path M is not enabled in autopilot\.paths/);
});

test('candidate: an unreadable or malformed autopilot file is never excused', () => {
  for (const autopilot of [{ ok: false, error: 'cannot read' }, ok({ schema: 1, enabled: 'no', paths: ['M'] }), ok({ schema: 1, enabled: false, paths: ['X'] })]) {
    const r = decide(base({ autopilot, candidate: true }));
    assert.equal(r.decision, 'HOLD');
    assert.equal(r.wouldBe, 'HOLD');
  }
});

test('cli: --candidate with a disabled autopilot exits 1 (HOLD) and names the M it would take', () => {
  const r = runCli(cliFiles({ autopilot: { schema: 1, enabled: false, paths: ['M'] } }), ['--candidate']);
  assert.equal(r.status, 1);
  assert.equal(r.out.decision, 'HOLD');
  assert.equal(r.out.wouldBe, 'M');
  assert.equal(r.out.candidate, true);
  assert.equal(r.out.ship, false);
  const hold = runCli(cliFiles({ autopilot: { schema: 1, enabled: false, paths: ['M'] }, g2: { ok: false } }), ['--candidate']);
  assert.equal(hold.out.wouldBe, 'HOLD');
});

test('HOLD: plugin verdicts missing, malformed or with a status that disagrees', () => {
  const b = base();
  delete b.plugins;
  holds(decide(b), /plugins: result missing/);
  holds(decide(base({ plugins: ok({ status: 'pass' }) })), /no plugins list/);
  holds(decide(base({ plugins: ok({ status: 'pass', plugins: [{ name: 'X', verdict: 'FAIL' }] }) })), /disagrees with the verdicts/);
  holds(decide(base({ plugins: ok({ status: 'pass', plugins: [{ name: 'X' }] }) })), /a name and a verdict/);
});

test('M: a plugin that was not scanned (gated) is held alone and named; it neither blocks the update nor passes', () => {
  const plugins = ok({ status: 'fail', plugins: [{ name: 'BetterCheats', verdict: 'PASS' },
    { name: 'MiniMap', verdict: 'NOT-SCANNED', note: 'not scanned: gated (a downloaded DLL)' }] });
  const r = decide(base({ plugins }));
  assert.equal(r.decision, 'M');
  assert.equal(r.pluginsOk, true);
  assert.deepEqual(r.plugins.map((p) => [p.name, p.status, p.heldAlone === true]), [['BetterCheats', 'updated', false], ['MiniMap', 'held', true]]);
  assert.match(r.plugins[1].reasons[0], /^not scanned: gated, so nothing is known about it on the new CL/);
  assert.match(r.notes.join(' '), /MiniMap held/);
  holds(decide(base({ plugins: ok({ status: 'pass', plugins: plugins.value.plugins }) })), /disagrees with the verdicts/);
});

test('rig set not scanned: decide names the gated rows and declares only what stored facts show', () => {
  const stored = { name: 'PersistentIdFix', gated: true, error: 'not scanned: gated', plugin: { interfaceVersion: 75, gameBuild: 'CL-127004 (none declared)' }, rule3: { migrated: false } };
  const bare = { name: 'WAILA', gated: true, error: 'not scanned: gated' };
  const r = decide(base({ g3: ok({ ok: true, cl: '129402', previousCl: '127004' }), rigPlugins: ok({ branch: 'public', tags: '', plugins: [stored, bare] }) }));
  assert.deepEqual(r.expectRefused, ['PersistentIdFix']);
  const notes = r.notes.join(' | ');
  assert.match(notes, /rig plugins: not scanned: gated: PersistentIdFix, WAILA; the stored facts of the reviewed release are used for PersistentIdFix/);
  assert.match(notes, /rig plugins: no facts for WAILA; no refusal is declared for it, so a refusal fails the rig/);
});

test('M: GAME-CALL is a note, not a hold', () => {
  const r = decide(base());
  assert.equal(r.decision, 'M');
  assert.match(r.notes.join(' '), /partly exercised offline \(GAME-CALL\): WAILA/);
});

test('HOLD: a gone key not marked optional, or a class size change, never reaches M', () => {
  const fieldsReport = (problems) => ok({ written: false, cl: 127999, added: 0, absent: [], covered: [], notes: [], problems });
  holds(decide(base({ fields: fieldsReport(['field ACrAPHelper::SnappedActors: resolves on the reference build only (removed or renamed); the plugin that requests it is refused there, and no key list marks it optional']) })),
    /field rows: the field rows were not written: field ACrAPHelper::SnappedActors/);
  holds(decide(base({ g5: ok(layout('FCrPackageTransportConnectionData')), fields: fieldsReport(['class FCrPackageTransportConnectionData: its size changed (0x70 -> 0x78)', 'class FCrCraftingFragment: its size changed (0x80 -> 0xA0)']) })),
    /its size changed \(0x70 -> 0x78\).*\(and 1 more\)/);
});

test('M: a key gone on the new build is a note naming the plugin', () => {
  const fields = ok({ written: true, cl: 127999, added: 0, absent: [{ key: 'UFoo::Gone', owners: ['BetterCheats'] }], covered: ['UFoo'], notes: [], problems: [] });
  const r = decide(base({ g5: ok(layout('UFoo')), fields }));
  assert.equal(r.decision, 'M');
  assert.match(r.notes.join(' '), /1 member\(s\) gone on CL-127999, each an absent row.*UFoo::Gone \(BetterCheats\)/);
});

// ------------------------------------------------------------ map run 3 (CL-129402)
// The real probe files of the third map run: the per-plugin verdict rows of BetterCheats and MiniMap
// (the client check's plugins.json) and the field-rows report the same run wrote (the candidate map's rows).

const run3 = (name) => JSON.parse(readFileSync(join(here, 'fixtures', 'map-run3', name), 'utf8'));
const run3Plugin = (name) => run3('plugins.json').plugins.find((p) => p.name === name);
// The facts of the DLLs the rig runs (the check's rig-plugins.json); by default the rows the run-3 scans gave.
const rigOf = (plugins) => ok({ branch: 'public_test_branch', tags: '', plugins });
const run3Inputs = (over = {}) => base({
  g3: ok({ ok: true, cl: '129402', previousCl: '127004' }),
  plugins: ok({ status: 'fail', plugins: [run3Plugin('BetterCheats'), run3Plugin('MiniMap')] }),
  rigPlugins: rigOf([run3Plugin('BetterCheats'), run3Plugin('MiniMap')]),
  fields: ok(run3('field-rows.json')),
  ...over,
});
const entry = (r, name) => r.plugins.find((p) => p.name === name);

test('run 3: BetterCheats is judged against the candidate map, so its refused rows do not hold it', () => {
  const bc = run3Plugin('BetterCheats');
  // What the probe really reported: a FAIL whose note is the planned stop (0xC0000005) and 18 refusals, each for a row
  // the candidate map supplies.
  assert.equal(bc.verdict, 'FAIL');
  assert.match(bc.note, /as planned.*\(0xC0000005\)/);
  assert.equal(bc.failures.length, 18);
  const rows = new Set(run3('field-rows.json').rows);
  assert.ok(bc.failures.every((f) => /refused: no row for CL-129402/.test(f.detail) && rows.has(f.name)));
  const r = decide(run3Inputs());
  const e = entry(r, 'BetterCheats');
  assert.equal(e.status, 'updated');
  assert.equal(e.heldAlone, undefined);
  assert.deepEqual(e.reasons, []);
  // The one thing the candidate cannot give it is a row for a member the game removed (optional, low).
  assert.deepEqual(e.degraded.map((d) => `${d.key}:${d.severity}`), ['ACrAPHelper::SnappedActors:low']);
  assert.doesNotMatch(r.notes.join(' '), /BetterCheats held|crashed/);
});

test('run 3: the probe\'s planned stop (0xC0000005) is never a fault', () => {
  // With every refusal settled and nothing else listed, the code in the note alone neither holds nor degrades a plugin.
  const bc = run3Plugin('BetterCheats');
  const clean = ok({ ...run3('field-rows.json'), degraded: {}, absent: [] });
  const r = decide(run3Inputs({ plugins: ok({ status: 'fail', plugins: [bc] }), fields: clean }));
  assert.deepEqual([entry(r, 'BetterCheats').status, entry(r, 'BetterCheats').degraded], ['updated', []]);
  assert.doesNotMatch(JSON.stringify(r), /crashed in the check/);
  // A genuine fault is still a fault: the same code outside the planned-stop words.
  const crashed = decide(run3Inputs({ plugins: ok({ status: 'fail', plugins: [{ ...bc, note: 'PluginInit crashed (exception 0xC0000005)' }] }) }));
  assert.match(entry(crashed, 'BetterCheats').reasons[0], /crashed in the check/);
  const both = decide(run3Inputs({ plugins: ok({ status: 'fail', plugins: [{ ...bc, note: `${bc.note}; DoThing crashed with 0xC0000094` }] }) }));
  assert.match(entry(both, 'BetterCheats').reasons[0], /crashed in the check/);
});

test('run 3: BetterCheats is still held for what the candidate does not fix', () => {
  const rows = run3('field-rows.json');
  // A row the candidate lacks.
  const lacking = decide(run3Inputs({ fields: ok({ ...rows, rows: rows.rows.filter((k) => k !== 'UCrGameInstance::ServerSessionName') }) }));
  let e = entry(lacking, 'BetterCheats');
  assert.equal(e.status, 'held');
  assert.equal(e.heldAlone, true);
  assert.equal(e.reasons[0], 'refused: required key UCrGameInstance::ServerSessionName has no map row, stays on its last release');
  assert.doesNotMatch(lacking.notes.join(' '), /crashed/);
  assert.equal(lacking.pluginsOk, true, 'held alone: the rest still proceed');
  // A pattern still MISSING on the new build.
  const bc = run3Plugin('BetterCheats');
  const missing = { ...bc, patterns: [...bc.patterns, { name: 'UFoo::Bar', call: 'Resolve', kind: 'function', required: true, recorded: true, result: 'MISSING' }] };
  e = entry(decide(run3Inputs({ plugins: ok({ status: 'fail', plugins: [missing] }) })), 'BetterCheats');
  assert.equal(e.status, 'held');
  assert.match(e.reasons[0], /^refused: UFoo::Bar: pattern MISSING, stays on its last release$/);
  // A FAIL that nothing explains is not waved through either.
  e = entry(decide(run3Inputs({ plugins: ok({ status: 'fail', plugins: [{ ...bc, failures: [] }] }) })), 'BetterCheats');
  assert.equal(e.status, 'held');
  assert.match(e.reasons[0], /no failure listed/);
});

test('run 3: MiniMap (interface v70) is refused outright by the loader on CL-129402, not "updated, degraded"', () => {
  const mm = run3Plugin('MiniMap');
  assert.equal(mm.plugin.interfaceVersion, 70);
  assert.equal(mm.plugin.gameBuild, 'CL-127004 (none declared)');
  assert.equal(mm.patterns.some((p) => p.result === 'MISSING'), true, 'the probe saw a MISSING pattern, which is moot');
  const r = decide(run3Inputs());
  const e = entry(r, 'MiniMap');
  assert.equal(e.status, 'held');
  assert.equal(e.heldAlone, true);
  assert.deepEqual(e.degraded, [], 'no degrade, so no patch from the suggester is read as a row');
  assert.deepEqual(e.reasons, ["refused by the loader on CL-129402: plugin interface v70, needs its author's update"]);
  assert.match(r.notes.join(' '), /MiniMap held: refused by the loader on CL-129402: plugin interface v70, needs its author's update/);
  assert.doesNotMatch(r.notes.join(' '), /MiniMap updated, degraded/);
  assert.equal(r.pluginsOk, true, 'held alone: the rest still proceed');
  assert.equal(r.decision, 'M');
});

test('run 3: the plugins the loader refuses on the build are listed for the rig (expectRefused)', () => {
  assert.deepEqual(decide(run3Inputs()).expectRefused, ['MiniMap']);
  // The same plugin on public (CL-127004, the build it was made on): the loader lets it load, nothing is expected refused.
  const onPublic = decide(run3Inputs({ g3: ok({ ok: true, cl: '127004', previousCl: '126000' }) }));
  assert.deepEqual(onPublic.expectRefused, []);
  assert.notEqual(entry(onPublic, 'MiniMap').status, 'held');
  // BetterCheats alone: nothing refused.
  assert.deepEqual(decide(run3Inputs({ plugins: ok({ status: 'fail', plugins: [run3Plugin('BetterCheats')] }), rigPlugins: rigOf([run3Plugin('BetterCheats')]) })).expectRefused, []);
  // Held for another reason is not a loader refusal.
  const heldRows = [{ name: 'WAILA', verdict: 'CRASH' }, { name: 'Codex', verdict: 'PASS' }];
  const held = decide(base({ plugins: ok({ status: 'fail', plugins: heldRows }), rigPlugins: rigOf(heldRows) }));
  assert.deepEqual(held.expectRefused, []);
  // The scanner's own REFUSED verdict (interface outside the loader's range) is a loader refusal too.
  const refusedRows = [{ name: 'WAILA', verdict: 'REFUSED' }, { name: 'Codex', verdict: 'PASS' }];
  const refused = decide(base({ plugins: ok({ status: 'fail', plugins: refusedRows }), rigPlugins: rigOf(refusedRows) }));
  assert.deepEqual(refused.expectRefused, ['WAILA']);
});

test('the refusal follows the loader rule, not the plugin name', () => {
  const plugin = (interfaceVersion, gameBuild) => ({ name: 'Anything', verdict: 'PASS', plugin: { interfaceVersion, gameBuild, hasLoadHooks: true } });
  const r = (p, cl = 129402) => loaderRefusal(p, cl);
  // v70 and v71 carry no game-build tail: built on CL-127004 whatever the field says; refused on any other build, loaded on it.
  assert.equal(r(plugin(70, 'CL-127004 (none declared)')), "plugin interface v70, needs its author's update");
  assert.match(r(plugin(71, 'CL-129402')), /^plugin interface v71/);
  assert.equal(r(plugin(70, 'CL-127004 (none declared)'), 127004), null);
  // A PASS with every pattern OK is refused all the same: the loader refuses before it scans.
  const e = decide(base({ g3: ok({ ok: true, cl: '129402', previousCl: '127004' }), plugins: ok({ status: 'pass', plugins: [plugin(70, 'CL-127004 (none declared)')] }), rigPlugins: rigOf([plugin(70, 'CL-127004 (none declared)')]) }));
  assert.equal(entry(e, 'Anything').status, 'held');
  assert.deepEqual(e.expectRefused, ['Anything']);
  // v72 and newer: a plugin made for the running build loads...
  assert.equal(r(plugin(74, 'CL-129402')), null);
  // ...off it, only a plugin that declares PLUGIN_MAP_MIGRATED loads. The flag is rule3.migrated (plugins built here).
  assert.equal(r({ ...plugin(74, 'CL-127004'), rule3: { status: 'clean', findings: 0, migrated: true } }), null);
  assert.equal(r({ ...plugin(74, 'CL-127004'), rule3: { status: 'clean', findings: 0, migrated: false } }), "it does not declare PLUGIN_MAP_MIGRATED, needs its author's update");
  // A migrated plugin that names no build is refused whatever the running build.
  assert.match(r({ ...plugin(74, 'CL-127004 (none declared)'), rule3: { migrated: true } }, 127004), /names no game build/);
  // The flag is not visible (a released DLL): no claim from the fields, the loader's own words in the probe note decide.
  assert.equal(r(plugin(74, 'CL-127004')), null);
  const noted = { ...plugin(74, 'CL-127004'), note: "Needs an update to run on CL-129402: it does not declare PLUGIN_MAP_MIGRATED, so it would read this game's data where CL-127004 had it. It loads on CL-127004." };
  assert.equal(r(noted), "it does not declare PLUGIN_MAP_MIGRATED, needs its author's update");
  assert.equal(r(noted, 127004), null, "a note for another build is not this build's");
  // Nothing to read: no claim.
  assert.equal(r({ name: 'X', verdict: 'PASS' }), null);
  assert.equal(r(plugin(70, 'CL-127004'), null), null);
});

test("cli: the decision names the plugins the rig must expect refused, in the rig's input grammar", () => {
  const fieldsFile = join(mkdtempSync(join(tmpdir(), 'decide-fields-')), 'fields.json');
  writeFileSync(fieldsFile, JSON.stringify(run3('field-rows.json')));
  const rows = [run3Plugin('BetterCheats'), run3Plugin('MiniMap')];
  const r = runCli(cliFiles({ g3: { ok: true, cl: '129402', previousCl: '127004' }, plugins: { status: 'fail', plugins: rows } }), ['--fields', fieldsFile, '--rig-plugins', rigFile(rows)]);
  assert.deepEqual(r.out.expectRefused, ['MiniMap']);
  // client-rig-set.ps1 Read-Names: tokens of [A-Za-z0-9_.-] separated by space, comma or semicolon.
  assert.ok(r.out.expectRefused.every((n) => /^[A-Za-z0-9_.-]+$/.test(n)));
  // An early HOLD, with no plugin picture at all: the list is empty, never missing.
  assert.deepEqual(decide(base({ g1: { ok: false } })).expectRefused, []);
});

// ------------------------------------------------------------ leg C2: expected refusals on the other branch
// The rig of the other Steam branch declares what the loader's own rule predicts for the build that
// branch runs (--other-cl), from the plugin metadata this check scanned. MiniMap is interface v70, made
// for CL-127004: refused on CL-129402, loaded on CL-127004.

const PUBLIC_CL = { g3: ok({ ok: true, cl: '127004', previousCl: '126000' }) };
const v = (name, interfaceVersion, gameBuild, extra = {}) => ({ name, verdict: 'PASS', plugin: { interfaceVersion, gameBuild, hasLoadHooks: true }, ...extra });

test('other branch: a public check while the other branch is on CL-129402 declares MiniMap for the other rig', () => {
  const r = decide(run3Inputs({ ...PUBLIC_CL, otherCl: 129402 }));
  assert.deepEqual(r.expectRefused, [], 'nothing is refused on the build this check is for');
  assert.deepEqual(r.expectRefusedOther, ['MiniMap']);
  assert.equal(r.otherCl, 129402);
  // BetterCheats (migrated) is not listed: only what the loader predicts.
  assert.ok(!r.expectRefusedOther.includes('BetterCheats'));
});

test('other branch: a check of the other branch declares nothing for public, where MiniMap loads', () => {
  const r = decide(run3Inputs({ otherCl: 127004 }));
  assert.deepEqual(r.expectRefused, ['MiniMap'], 'refused on the build this check is for');
  assert.deepEqual(r.expectRefusedOther, [], 'public is strict: nothing is expected refused there');
  assert.equal(r.otherCl, 127004);
});

test('other branch: with no other CL the decision carries no prediction (strict: any refusal there fails)', () => {
  const r = decide(run3Inputs(PUBLIC_CL));
  assert.equal(r.expectRefusedOther, undefined);
  assert.equal(r.otherCl, undefined);
  assert.equal(decide(run3Inputs({ ...PUBLIC_CL, otherCl: null })).expectRefusedOther, undefined);
});

test('other branch: the same CL on both branches gives the same list as the check itself', () => {
  const r = decide(run3Inputs({ otherCl: 129402 }));
  assert.deepEqual(r.expectRefusedOther, r.expectRefused);
  // The scanner's own REFUSED verdict counts there, as it does for the check's CL.
  const refusedRows = [{ name: 'WAILA', verdict: 'REFUSED' }, { name: 'Codex', verdict: 'PASS' }];
  const refused = decide(base({ g3: ok({ ok: true, cl: '129402', previousCl: '127004' }), otherCl: 129402, plugins: ok({ status: 'fail', plugins: refusedRows }), rigPlugins: rigOf(refusedRows) }));
  assert.deepEqual(refused.expectRefusedOther, ['WAILA']);
});

test('rig on CL-130045: a v70 plugin is refused, one that declares CL-130045 is admitted, one built on CL-127004 whose flag is unknown is not predicted', () => {
  const rows = [
    v('MiniMap', 70, 'CL-127004 (none declared)'),
    v('Declares', 74, 'CL-130045', { rule3: { migrated: false } }),
    v('Migrated', 74, 'CL-129402', { rule3: { migrated: true } }),
    v('Plain', 74, 'CL-127004 (none declared)', { rule3: { migrated: false } }),
    v('NoBuild', 74, 'CL-127004 (none declared)', { rule3: { migrated: true } }),
    v('Unknown', 74, 'CL-127004'),
  ];
  assert.deepEqual(expectedRefusals(rows, 130045), ['MiniMap', 'NoBuild', 'Plain']);
  // The same plugins on their own build load.
  assert.deepEqual(expectedRefusals([v('MiniMap', 70, 'CL-127004 (none declared)'), v('Plain', 74, 'CL-127004 (none declared)', { rule3: { migrated: false } })], 127004), []);
});

test('other branch: the loader rule and the interface range predict a refusal; a probe note about the scanned build predicts none', () => {
  // A probe note is about the scanned CL (129402), not another build.
  const noted = v('Noted', 74, 'CL-129402', { note: "Needs an update to run on CL-129402: it does not declare PLUGIN_MAP_MIGRATED, so it would read this game's data where CL-127004 had it." });
  // REFUSED is the interface outside the candidate loader's range: both rigs run that loader, so it holds on any CL.
  const refused = { name: 'Refused', verdict: 'REFUSED', plugin: { interfaceVersion: 75, gameBuild: 'CL-129402' } };
  assert.deepEqual(expectedRefusals([noted, refused], 128000), ['Refused']);
  assert.deepEqual(expectedRefusals([refused], 0), [], 'no CL, no prediction');
  assert.deepEqual(expectedRefusals([noted], 129402), ['Noted'], 'its own CL: the loader note says so');
  // A v72+ plugin of unknown migrated flag, off its build: not predicted, so a refusal there stays unexpected.
  assert.deepEqual(expectedRefusals([v('Unknown', 74, 'CL-127004')], 129402), []);
  // The flag known (built here): predicted on the other build.
  assert.deepEqual(expectedRefusals([v('Plain', 74, 'CL-127004', { rule3: { migrated: false } }), v('Migrated', 74, 'CL-127004', { rule3: { migrated: true } })], 129402), ['Plain']);
  // v70/v71 are made for CL-127004 whatever they say.
  assert.deepEqual(expectedRefusals([v('Old70', 70, 'CL-127004 (none declared)'), v('Old71', 71, 'CL-129402')], 129402), ['Old70', 'Old71']);
  assert.deepEqual(expectedRefusals([v('Old70', 70, 'CL-127004 (none declared)')], 127004), []);
});

test('other branch: the list is sorted and unique, and junk rows or CLs predict nothing', () => {
  const rows = [v('Zed', 70, 'CL-127004'), v('Alpha', 70, 'CL-127004'), v('Zed', 70, 'CL-127004'), null, { verdict: 'PASS' }, { name: '', plugin: { interfaceVersion: 70 } }];
  assert.deepEqual(expectedRefusals(rows, 129402), ['Alpha', 'Zed']);
  assert.deepEqual(expectedRefusals(rows, 0), []);
  assert.deepEqual(expectedRefusals(rows, null), []);
  assert.deepEqual(expectedRefusals(undefined, 129402), []);
  assert.deepEqual(expectedRefusals({ plugins: rows }, 129402), []);
});

test('other branch: an early HOLD with no plugin picture still gives a list, never a crash', () => {
  const r = decide(base({ otherCl: 129402, plugins: { error: 'unreadable' } }));
  assert.equal(r.decision, 'HOLD');
  assert.deepEqual(r.expectRefusedOther, []);
});

test('cli: --other-cl puts the prediction in decision.json in the rig grammar, and a bad value is a usage error', () => {
  const fieldsFile = join(mkdtempSync(join(tmpdir(), 'decide-fields-')), 'fields.json');
  writeFileSync(fieldsFile, JSON.stringify(run3('field-rows.json')));
  const rows = [run3Plugin('BetterCheats'), run3Plugin('MiniMap')];
  const files = cliFiles({ g3: { ok: true, cl: '127004', previousCl: '126000' }, plugins: { status: 'fail', plugins: rows } });
  const r = runCli(files, ['--fields', fieldsFile, '--other-cl', '129402', '--rig-plugins', rigFile(rows)]);
  assert.deepEqual(r.out.expectRefusedOther, ['MiniMap']);
  assert.equal(r.out.otherCl, 129402);
  assert.ok(r.out.expectRefusedOther.every((n) => /^[A-Za-z0-9_.-]+$/.test(n)));
  assert.equal(runCli(files, ['--fields', fieldsFile, '--rig-plugins', rigFile(rows)]).out.expectRefusedOther, undefined);
  for (const bad of ['abc', '0', '-1', '12.5', '']) assert.equal(runCli(files, ['--other-cl', bad]).status, 2, `--other-cl ${JSON.stringify(bad)}`);
});

// The other branch runs a build the candidate map has no row for (--other-unmapped): its rig must see a clean decline.
test('other branch unmapped: the decision expects a clean decline there and says so in a note', () => {
  const r = decide(base({ otherUnmapped: 'public_test_branch runs build 123456' }));
  assert.equal(r.expectDeclineOther, true);
  assert.equal(r.otherCl, undefined);
  assert.equal(r.expectRefusedOther, undefined);
  assert.ok(r.notes.includes('public_test_branch runs build 123456, not in this candidate map: expects a clean decline (the version-mismatch line, no plugin loaded, no crash, the game still running)'), r.notes.join(' | '));
  // It changes nothing of the decision for this branch.
  const plain = decide(base());
  assert.equal(r.decision, plain.decision);
  assert.deepEqual(r.expectRefused, plain.expectRefused);
});

test('other branch mapped (or unnamed): no decline is expected', () => {
  assert.equal(decide(base({ otherCl: 127004 })).expectDeclineOther, undefined);
  assert.equal(decide(base()).expectDeclineOther, undefined);
  assert.equal(decide(base({ otherUnmapped: null })).expectDeclineOther, undefined);
});

test('other branch unmapped on a held decision still expects the decline', () => {
  const r = decide(base({ otherUnmapped: 'public runs build 77', g1: ok({ ok: false }) }));
  assert.equal(r.decision, 'HOLD');
  assert.equal(r.expectDeclineOther, true);
});

test('cli: --other-unmapped puts expectDeclineOther in decision.json, takes only a plain label and not with --other-cl', () => {
  const files = cliFiles({ g3: { ok: true, cl: '127004', previousCl: '126000' } });
  const r = runCli(files, ['--other-unmapped', 'public runs build 99']);
  assert.equal(r.out.expectDeclineOther, true);
  assert.match(r.out.notes.join(' '), /public runs build 99, not in this candidate map: expects a clean decline/);
  assert.equal(runCli(files).out.expectDeclineOther, undefined);
  for (const bad of ['', 'a;b', '$(x)', 'x'.repeat(81)]) assert.equal(runCli(files, ['--other-unmapped', bad]).status, 2, `--other-unmapped ${JSON.stringify(bad)}`);
  assert.equal(runCli(files, ['--other-unmapped', 'public runs build 99', '--other-cl', '127004']).status, 2);
});

// ------------------------------------------------------------ the refusals declared to a rig come from the DLLs it runs
// The rig runs the Latest released plugins and the pinned third-party ones, not the plugin builds the check
// judged (see rig-plugins.json). The same loader rule, applied to the facts of those very DLLs.

test('rig plugins: expect_refused is predicted from the rig\'s DLLs, not from the plugin builds the check judged', () => {
  // The work build of BetterDrone is v74 and loads; the released one the rig runs is still v70 and is refused on CL-129402.
  const work = [v('BetterDrone', 74, 'CL-129402', { rule3: { migrated: true } }), v('MiniMap', 70, 'CL-127004 (none declared)')];
  const released = [v('BetterDrone', 70, 'CL-127004 (none declared)'), v('MiniMap', 70, 'CL-127004 (none declared)')];
  const r = decide(base({ g3: ok({ ok: true, cl: '129402', previousCl: '127004' }), plugins: ok({ status: 'pass', plugins: work }), rigPlugins: rigOf(released), otherCl: 129402 }));
  assert.deepEqual(r.expectRefused, ['BetterDrone', 'MiniMap']);
  assert.deepEqual(r.expectRefusedOther, ['BetterDrone', 'MiniMap']);
  // The other way round: the work build is refused (old), the rig's release is made for the build and loads.
  const r2 = decide(base({ g3: ok({ ok: true, cl: '129402', previousCl: '127004' }), plugins: ok({ status: 'pass', plugins: [v('Codex', 70, 'CL-127004')] }), rigPlugins: rigOf([v('Codex', 74, 'CL-129402')]), otherCl: 127004 }));
  assert.deepEqual(r2.expectRefused, [], 'the released DLL loads: nothing declared');
  assert.deepEqual(r2.expectRefusedOther, []);
  assert.equal(entry(r2, 'Codex').status, 'held', 'the verdict on the work build is untouched');
});

test('rig plugins: the facts of one branch\'s DLLs give both rigs their lists, by the same rule on each CL', () => {
  const rows = [v('Old', 70, 'CL-127004 (none declared)'), v('Mapped', 74, 'CL-127004', { rule3: { migrated: true } }), v('Plain', 74, 'CL-127004', { rule3: { migrated: false } })];
  const onTest = decide(base({ g3: ok({ ok: true, cl: '129402', previousCl: '127004' }), rigPlugins: rigOf(rows), otherCl: 127004 }));
  assert.deepEqual(onTest.expectRefused, ['Old', 'Plain']);
  assert.deepEqual(onTest.expectRefusedOther, [], 'public: everything built for it loads');
  const onPublic = decide(base({ g3: ok({ ok: true, cl: '127004', previousCl: '126000' }), rigPlugins: rigOf(rows), otherCl: 129402 }));
  assert.deepEqual(onPublic.expectRefused, []);
  assert.deepEqual(onPublic.expectRefusedOther, ['Old', 'Plain']);
});

test('rig plugins: without the facts nothing is declared, and the decision says why', () => {
  const none = decide(run3Inputs({ rigPlugins: undefined, otherCl: 127004 }));
  assert.deepEqual(none.expectRefused, [], 'MiniMap is refused in the scan, but the rig\'s DLLs are unknown: never a guess');
  assert.deepEqual(none.expectRefusedOther, []);
  assert.match(none.notes.join(' '), /rig plugins: the facts of the DLLs the rig runs were not read \(no file given\)/);
  const unreadable = decide(run3Inputs({ rigPlugins: { ok: false, error: 'cannot read rig-plugins.json: ENOENT' } }));
  assert.deepEqual(unreadable.expectRefused, []);
  assert.match(unreadable.notes.join(' '), /cannot read rig-plugins\.json: ENOENT/);
  assert.deepEqual(decide(run3Inputs({ rigPlugins: ok({ plugins: 'x' }) })).expectRefused, []);
  // An early HOLD still carries the empty list.
  assert.deepEqual(decide(base({ g1: { ok: false } })).expectRefused, []);
});

test('rig plugins: a DLL whose facts could not be read is not declared, the others are', () => {
  const rows = [v('Old', 70, 'CL-127004'), { name: 'Broken', tag: 'v1', error: 'sr-aobscan could not read its plugin facts (exit 2)' }, { name: 'NoBlock', tag: 'v1' }];
  const r = decide(base({ g3: ok({ ok: true, cl: '129402', previousCl: '127004' }), rigPlugins: rigOf(rows) }));
  assert.deepEqual(r.expectRefused, ['Old']);
  assert.match(r.notes.join(' '), /rig plugins: no facts for Broken, NoBlock; no refusal is declared for them, so a refusal fails the rig/);
});

test('rig plugins: the scanner\'s REFUSED verdict (interface outside the candidate loader\'s range) counts on both branches', () => {
  const rows = [{ name: 'Far', verdict: 'REFUSED', plugin: { interfaceVersion: 99, gameBuild: 'CL-129402' } }];
  const r = decide(base({ g3: ok({ ok: true, cl: '129402', previousCl: '127004' }), rigPlugins: rigOf(rows), otherCl: 127004 }));
  assert.deepEqual(r.expectRefused, ['Far']);
  assert.deepEqual(r.expectRefusedOther, ['Far']);
});

test('cli: --rig-plugins feeds the lists, and a missing or broken file declares nothing', () => {
  const rows = [v('Old', 70, 'CL-127004')];
  const files = cliFiles({ g3: { ok: true, cl: '129402', previousCl: '127004' } });
  const good = runCli(files, ['--rig-plugins', rigFile(rows), '--other-cl', '127004']);
  assert.deepEqual(good.out.expectRefused, ['Old']);
  assert.deepEqual(good.out.expectRefusedOther, []);
  const missing = runCli(files, ['--rig-plugins', join(good.dir, 'nope.json')]);
  assert.deepEqual(missing.out.expectRefused, []);
  assert.match(missing.out.notes.join(' '), /cannot read/);
  const broken = join(good.dir, 'broken.json');
  writeFileSync(broken, '{ not json');
  assert.deepEqual(runCli(files, ['--rig-plugins', broken]).out.expectRefused, []);
  assert.deepEqual(runCli(files).out.expectRefused, [], 'no flag: no file given');
});

// ------------------------------------------------------------ live run 1 (run 42393906454, CL-129402)
// The real rig-plugins.json of that run: AlienX's Latest releases are interface v75, made on CL-127004, and the
// candidate loader (gss/loader-work) accepts [70, 74], so the scanner gave REFUSED for nine of them; MiniMap v1.2.0
// is v70, refused off CL-127004 by the loader's own rule.
const liveRig = JSON.parse(readFileSync(join(here, 'fixtures', 'live-run-1', 'rig-plugins.json'), 'utf8').replace(/^\uFEFF/, ''));
const NINE = ['BetterCheats', 'BetterDrone', 'CameraControls', 'Codex', 'Compass', 'ProductionViewer', 'RuptureTimer', 'WAILA', 'WaveOptimiser'];

test('live run 1: the facts are read as the scanner gave them, and all ten are refused on CL-129402', () => {
  for (const p of liveRig.plugins.filter((x) => NINE.includes(x.name))) {
    assert.equal(p.plugin.interfaceVersion, 75, p.name);
    assert.equal(p.plugin.gameBuild, 'CL-127004', p.name);
    assert.equal(p.verdict, 'REFUSED', p.name);
    assert.match(p.note, /^interface 75 is outside the loader's \[70, 74\]/, p.name);
  }
  const mini = liveRig.plugins.find((x) => x.name === 'MiniMap');
  assert.equal(mini.plugin.interfaceVersion, 70);
  assert.equal(loaderRefusal(mini, 129402), "plugin interface v70, needs its author's update");
  assert.deepEqual(expectedRefusals(liveRig.plugins, 129402), [...NINE, 'MiniMap'].sort());
});

test('live run 1: the other branch (public, CL-127004) expects the nine the candidate loader refuses by interface, not MiniMap', () => {
  // Before the fix the list was empty: rig-other would have failed on nine refusals nobody declared.
  assert.deepEqual(expectedRefusals(liveRig.plugins, 127004), NINE);
  const r = decide(base({ g3: ok({ ok: true, cl: '129402', previousCl: '127004' }), otherCl: 127004, rigPlugins: ok(liveRig) }));
  assert.deepEqual(r.expectRefused, [...NINE, 'MiniMap'].sort());
  assert.deepEqual(r.expectRefusedOther, NINE);
});

// The same plugins read by a candidate loader built on the released line (AlienX main), which accepts [70, 75]: the
// scanner no longer refuses the nine v75 releases, so only the loader's own off-build rule is left, and that rule
// refuses MiniMap v1.2.0 (v70, built on CL-127004) off CL-127004 and nothing else.
const releasedLineRig = {
  ...liveRig,
  plugins: liveRig.plugins.map((p) => (NINE.includes(p.name) ? { ...p, verdict: 'PASS', note: '' } : p)),
};

test('released line: with a loader that accepts [70, 75] the nine v75 plugins are not refused, and MiniMap is refused only off CL-127004', () => {
  assert.deepEqual(expectedRefusals(releasedLineRig.plugins, 129402), ['MiniMap']);
  assert.deepEqual(expectedRefusals(releasedLineRig.plugins, 127004), [], 'on its own build nothing is refused');
  const r = decide(base({ g3: ok({ ok: true, cl: '129402', previousCl: '127004' }), otherCl: 127004, rigPlugins: ok(releasedLineRig) }));
  assert.deepEqual(r.expectRefused, ['MiniMap']);
  assert.deepEqual(r.expectRefusedOther, []);
});

// ---- A published-base problem is a HOLD ----------------------------------------------------------

test('holdFor: the published-base reasons come first; a decision of M becomes HOLD and ships nothing', () => {
  const m = decide(base());
  assert.equal(m.decision, 'M');
  const h = holdFor(['published base: 2 published lines are missing from the new feed', 'function GWorld @ CL-127004: missing'], { decision: m });
  assert.equal(h.decision, 'HOLD');
  assert.equal(h.ship, false);
  assert.deepEqual(h.reasons.slice(0, 2), ['published base: 2 published lines are missing from the new feed', 'function GWorld @ CL-127004: missing']);
  assert.equal(h.cl, m.cl);
  assert.equal(m.decision, 'M', 'the decision it was given is not changed');
});

test('holdFor: a decision that already held keeps its own reasons after the new ones; without a decision it stands alone', () => {
  const held = decide(base({ g3: ok({ ok: true, cl: '129402', previousCl: '129402' }) }));
  assert.equal(held.decision, 'HOLD');
  const h = holdFor(['published base: the published file could not be fetched'], { decision: held });
  assert.deepEqual(h.reasons, ['published base: the published file could not be fetched', ...held.reasons]);
  const alone = holdFor(['published base: the published file could not be fetched'], { repo: 'ModLoader', cl: 129402 });
  assert.deepEqual([alone.decision, alone.ship, alone.repo, alone.cl, alone.reasons.length], ['HOLD', false, 'ModLoader', 129402, 1]);
});

test('decide.mjs hold: writes the HOLD decision from a published-base report, exit 0; a report without a reason is a usage error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decide-hold-'));
  const cli = join(here, 'decide.mjs');
  const report = join(dir, 'pb.json');
  const out = join(dir, 'decision.json');
  writeFileSync(report, JSON.stringify({ ok: false, step: 'import', reasons: ['published base: the file could not be fetched after 3 tries (x); the header was not changed'] }));
  let r = spawnSync(process.execPath, [cli, 'hold', '--report', report, '--repo', 'ModLoader', '--cl', '129402', '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual([d.decision, d.ship, d.repo, d.cl], ['HOLD', false, 'ModLoader', 129402]);
  assert.match(d.reasons[0], /^published base: the file could not be fetched/);
  // Held again on top of a decision: the decision's own fields stay.
  writeFileSync(out, JSON.stringify({ decision: 'M', ship: true, path: 'M', cl: 129402, repo: 'ModLoader', reasons: [], notes: ['n'], plugins: [], pluginsOk: true, expectRefused: [] }));
  r = spawnSync(process.execPath, [cli, 'hold', '--report', report, '--decision', out, '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const again = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual([again.decision, again.ship, again.path, again.notes], ['HOLD', false, 'M', ['n']]);
  writeFileSync(report, JSON.stringify({ ok: true, step: 'import', note: 'fine' }));
  r = spawnSync(process.execPath, [cli, 'hold', '--report', report, '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /holds no reason to hold/);
  r = spawnSync(process.execPath, [cli, 'hold', '--report', join(dir, 'nope.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 2);
});

// ------------------------------------------------------------ the publish job's read of the switch

// The publish job runs this commit's code against state/autopilot.json as main has it at that moment (rehearsal run 44658336245 stopped on a
// field a later change had removed). It reads the switch only, so a field added or removed since cannot stop a release the switch allows.
test('the switch read right before signing ignores every field but the switch', () => {
  // the shape this commit writes, an older one that still carries a removed field, and a newer one with a field this code never heard of
  for (const extra of [{}, { max_releases_per_day: 3 }, { max_releases_per_day: 'many', schema: 7, notes: ['x'] }, { somethingNew: { nested: true } }]) {
    assert.deepEqual(checkAutopilotSwitch(ok({ enabled: true, paths: ['M'], ...extra })), { enabled: true, pathM: true }, JSON.stringify(extra));
  }
  // checkAutopilot, the chain's own strict read of the same file, still takes only the shape it knows
  assert.equal(checkAutopilot(ok({ enabled: true, paths: ['M'], max_releases_per_day: 3 })).error, undefined);
  // a paths list that is absent or carries a path this code does not know: the switch alone decides, M must be in a list that is there
  assert.deepEqual(checkAutopilotSwitch(ok({ enabled: true })), { enabled: true, pathM: true });
  assert.deepEqual(checkAutopilotSwitch(ok({ enabled: true, paths: ['M', 'Z'] })), { enabled: true, pathM: true });
  assert.deepEqual(checkAutopilotSwitch(ok({ enabled: true, paths: ['B'] })), { enabled: true, pathM: false });
  assert.deepEqual(checkAutopilotSwitch(ok({ enabled: true, paths: [] })), { enabled: true, pathM: false });
  assert.deepEqual(checkAutopilotSwitch(ok({ enabled: false, paths: ['M'] })), { enabled: false, pathM: true });
  // fail closed on what it does read
  for (const bad of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }, { paths: ['M'] }, { enabled: true, paths: 'M' }, { enabled: true, paths: { M: true } }]) {
    assert.match(checkAutopilotSwitch(ok(bad)).error ?? '', /^autopilot: /, JSON.stringify(bad));
  }
  for (const bad of [null, [], 'x', 3]) assert.match(checkAutopilotSwitch(ok(bad)).error ?? '', /^autopilot: /);
  assert.match(checkAutopilotSwitch({ ok: false, error: 'cannot read' }).error, /^autopilot: cannot read/);
  assert.match(checkAutopilotSwitch(undefined).error, /^autopilot: /);
});
