// Fixture tests for decide.mjs: every decision path and every fail-closed case.
// Run: node --test ci/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, expectedRefusals, loaderRefusal, LIMITS, SDK_GLOBALS } from './decide.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-10-29T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
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
    now: NOW,
    autopilot: ok({ schema: 1, enabled: true, paths: ['M', 'B'], max_releases_per_day: 2 }),
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
  || (ap.enabled === true && Array.isArray(ap.paths) && ap.paths.every((p) => p === 'M')
    && Number.isInteger(ap.max_releases_per_day) && ap.max_releases_per_day > 0 && ap.max_releases_per_day <= 2);

test('shipped state/autopilot.json is off or limited to the map-feed path M', () => {
  const ap = JSON.parse(readFileSync(join(here, '..', 'state', 'autopilot.json'), 'utf8'));
  assert.ok(autopilotIsSafe(ap), JSON.stringify(ap));
});

test('autopilot safe-state check: enabled with only M passes, any other path fails', () => {
  assert.ok(autopilotIsSafe({ enabled: false, paths: ['M'], max_releases_per_day: 2 }));
  assert.ok(autopilotIsSafe({ enabled: true, paths: ['M'], max_releases_per_day: 2 }));
  assert.ok(!autopilotIsSafe({ enabled: true, paths: ['M', 'B'], max_releases_per_day: 2 }));
  assert.ok(!autopilotIsSafe({ enabled: true, paths: ['M'], max_releases_per_day: 0 }));
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
    autopilot: ok({ enabled: true, paths: ['M', 'B', 'C'], max_releases_per_day: 2 }),
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
  const r = decide(base({ autopilot: ok({ enabled: false, paths: ['M'], max_releases_per_day: 2 }) }));
  holds(r, /disabled/);
  assert.equal(r.path, 'M', 'the would-be path is still reported');
});

test('HOLD: path not enabled in autopilot.paths', () => {
  const rB = decide(base({
    autopilot: ok({ enabled: true, paths: ['M'], max_releases_per_day: 2 }),
    g4: ok(aob([aobRow('SpawnActor', 'MISSING')])),
  }));
  holds(rB, /path B is not enabled/);
  const rM = decide(base({ autopilot: ok({ enabled: true, paths: [], max_releases_per_day: 2 }) }));
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
    holds(run(aobRow(key, 'MISSING'), ok({ enabled: true, paths: ['M', 'B', 'C'], max_releases_per_day: 2 })), /SDK global/);
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
  holds(decide(base({ autopilot: ok({ paths: ['M'], max_releases_per_day: 2 }) })), /enabled is not a boolean/);
  holds(decide(base({ autopilot: ok({ enabled: 'true', paths: ['M'], max_releases_per_day: 2 }) })), /enabled is not a boolean/);
  holds(decide(base({ autopilot: ok({ enabled: 1, paths: ['M'], max_releases_per_day: 2 }) })), /enabled is not a boolean/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: 'M', max_releases_per_day: 2 }) })), /paths/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['M', 'Z'], max_releases_per_day: 2 }) })), /paths/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['M'] }) })), /max_releases_per_day/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['M'], max_releases_per_day: '2' }) })), /max_releases_per_day/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['M'], max_releases_per_day: -1 }) })), /max_releases_per_day/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['M'], max_releases_per_day: 1.5 }) })), /max_releases_per_day/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['M'], max_releases_per_day: 2, error: 'stale' }) })), /error/);
});

test('fail closed: max_releases_per_day 0 blocks everything', () => {
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['M'], max_releases_per_day: 0 }) })), /rate limit/);
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

test('fail closed: missing repo name or clock', () => {
  holds(decide(base({ repo: undefined })), /repo name/);
  holds(decide(base({ now: NaN })), /clock/);
});

// ------------------------------------------------------------ rate limits

const rel = (min, repo = 'ModLoader', cl = '127004') => ({ repo, cl, at: ago(min) });

test('rate limit: one release per CL per repo', () => {
  holds(decide(base({ history: ok({ releases: [rel(60 * 30, 'ModLoader', '127999')], attempts: {} }) })), /already released for CL-127999/);
  // the same CL in another repo does not count
  assert.equal(decide(base({ history: ok({ releases: [rel(60 * 30, 'Waila', '127999')], attempts: {} }) })).decision, 'M');
});

test('rate limit: at most 2 releases per repo in 24 h', () => {
  holds(decide(base({ history: ok({ releases: [rel(60), rel(120)], attempts: {} }) })), /2 ModLoader releases in the last 24 h/);
  assert.equal(decide(base({ history: ok({ releases: [rel(60), rel(60 * 25)], attempts: {} }) })).decision, 'M');
  assert.equal(decide(base({ history: ok({ releases: [rel(60), rel(120, 'Waila')], attempts: {} }) })).decision, 'M');
});

test('rate limit: the autopilot cap can lower but never raise the design cap', () => {
  const one = ok({ enabled: true, paths: ['M'], max_releases_per_day: 1 });
  holds(decide(base({ autopilot: one, history: ok({ releases: [rel(60)], attempts: {} }) })), /limit 1/);
  const five = ok({ enabled: true, paths: ['M'], max_releases_per_day: 5 });
  holds(decide(base({ autopilot: five, history: ok({ releases: [rel(60), rel(120)], attempts: {} }) })), /limit 2/);
  assert.equal(LIMITS.maxReleasesPerDay, 2);
});

test('rate limit: releases at least 30 minutes apart', () => {
  holds(decide(base({ history: ok({ releases: [rel(29)], attempts: {} }) })), /30 minutes/);
  assert.equal(decide(base({ history: ok({ releases: [rel(31)], attempts: {} }) })).decision, 'M');
});

test('rate limit: a future-dated release counts as recent', () => {
  holds(decide(base({ history: ok({ releases: [rel(-600)], attempts: {} }) })), /30 minutes/);
});

test('rate limit: at most 2 Claude attempts per CL, B only', () => {
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

test('fail closed: malformed history', () => {
  holds(decide(base({ history: ok({}) })), /malformed/);
  holds(decide(base({ history: ok({ releases: 'none', attempts: {} }) })), /malformed/);
  holds(decide(base({ history: ok({ releases: [{ repo: 'ModLoader', cl: '1', at: 'yesterday' }], attempts: {} }) })), /malformed release/);
  holds(decide(base({ history: ok({ releases: [{ repo: 'ModLoader', cl: 'abc', at: ago(500) }], attempts: {} }) })), /malformed release/);
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
  const args = ['--repo', 'ModLoader', '--now', new Date(NOW).toISOString()];
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
  const r = runCli(cliFiles({ autopilot: { schema: 1, enabled: false, paths: ['M'], max_releases_per_day: 2 } }));
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
  const c = runCli(cliFiles({ autopilot: { schema: 1, enabled: true, paths: ['M', 'B', 'C'], max_releases_per_day: 2 }, g5: layout('UFoo') }));
  assert.equal(c.status, 1);
  assert.equal(c.out.path, 'C');
  const g = runCli(cliFiles({ g4: aob([aobRow('GetWorld')], { noGlobals: true }) }));
  assert.equal(g.status, 1);
  assert.match(g.out.reasons.join(), /SDK global/);
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

test('cli: an unparseable --now cannot turn into a release', () => {
  const r = runCli(cliFiles(), ['--now', 'not a date']);
  assert.equal(r.status, 1);
  assert.equal(r.out.decision, 'HOLD');
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
  const autopilot = ok({ schema: 1, enabled: false, paths: ['M'], max_releases_per_day: 2 });
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

const apOff = ok({ schema: 1, enabled: false, paths: ['M'], max_releases_per_day: 2 });
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
  blocked(g({ history: ok({ releases: [{ repo: 'ModLoader', cl: '127999', at: ago(60 * 30) }], attempts: {} }) }), /already released for CL-127999/);
  blocked(g({ fields: ok({ written: false, cl: 127999, added: 0, absent: [], covered: [], notes: [], problems: ['field UFoo::Core: gone'] }) }), /field rows/);
  blocked(g({ autopilot: ok({ schema: 1, enabled: false, paths: ['B'], max_releases_per_day: 2 }) }), /path M is not enabled in autopilot\.paths/);
});

test('candidate: an unreadable or malformed autopilot file is never excused', () => {
  for (const autopilot of [{ ok: false, error: 'cannot read' }, ok({ schema: 1, enabled: 'no', paths: ['M'], max_releases_per_day: 2 }), ok({ schema: 1, enabled: false, paths: ['X'], max_releases_per_day: 2 })]) {
    const r = decide(base({ autopilot, candidate: true }));
    assert.equal(r.decision, 'HOLD');
    assert.equal(r.wouldBe, 'HOLD');
  }
});

test('cli: --candidate with a disabled autopilot exits 1 (HOLD) and names the M it would take', () => {
  const r = runCli(cliFiles({ autopilot: { schema: 1, enabled: false, paths: ['M'], max_releases_per_day: 2 } }), ['--candidate']);
  assert.equal(r.status, 1);
  assert.equal(r.out.decision, 'HOLD');
  assert.equal(r.out.wouldBe, 'M');
  assert.equal(r.out.candidate, true);
  assert.equal(r.out.ship, false);
  const hold = runCli(cliFiles({ autopilot: { schema: 1, enabled: false, paths: ['M'], max_releases_per_day: 2 }, g2: { ok: false } }), ['--candidate']);
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

// ------------------------------------------------------------ map run 3 (CL-129402, test branch)
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
// for CL-127004: refused on CL-129402 (the test branch), loaded on CL-127004 (public).

const PUBLIC_CL = { g3: ok({ ok: true, cl: '127004', previousCl: '126000' }) };
const v = (name, interfaceVersion, gameBuild, extra = {}) => ({ name, verdict: 'PASS', plugin: { interfaceVersion, gameBuild, hasLoadHooks: true }, ...extra });

test('other branch: a public check while the test branch is on CL-129402 declares MiniMap for the other rig', () => {
  const r = decide(run3Inputs({ ...PUBLIC_CL, otherCl: 129402 }));
  assert.deepEqual(r.expectRefused, [], 'nothing is refused on the build this check is for');
  assert.deepEqual(r.expectRefusedOther, ['MiniMap']);
  assert.equal(r.otherCl, 129402);
  // BetterCheats (migrated) is not listed: only what the loader predicts.
  assert.ok(!r.expectRefusedOther.includes('BetterCheats'));
});

test('other branch: a test-branch check declares nothing for public, where MiniMap loads', () => {
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

// ------------------------------------------------------------ live run 1 (run 42393906454, CL-129402, test branch)
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
