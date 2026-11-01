// Fixture tests for decide.mjs: every decision path and every fail-closed case.
// Run: node --test ci/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, LIMITS, SDK_GLOBALS } from './decide.mjs';

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

test('shipped state/autopilot.json is the safe default', () => {
  const ap = JSON.parse(readFileSync(join(here, '..', 'state', 'autopilot.json'), 'utf8'));
  assert.equal(ap.enabled, false);
  assert.deepEqual(ap.paths, ['M']);
  assert.equal(ap.max_releases_per_day, 2);
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
