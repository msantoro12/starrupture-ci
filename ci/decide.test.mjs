// Fixture tests for decide.mjs: every decision path and every fail-closed case.
// Run: node --test ci/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, LIMITS } from './decide.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-10-29T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const ok = (value) => ({ ok: true, value });

const aobRow = (name, result = 'OK', required = true) => ({ name, kind: 'function', required, result, matches: result === 'OK' ? 1 : 0 });
function aob(rows) {
  const failing = rows.filter((r) => r.required && r.result !== 'OK').length;
  return { target: 'server', imageSize: 1000, summary: { total: rows.length, ok: rows.filter((r) => r.result === 'OK').length, missing: 0, ambiguous: 0, other: 0, requiredFailing: failing }, patterns: rows };
}

// A fully clean set of inputs; each test changes one thing.
function base(over = {}) {
  return {
    repo: 'ModLoader',
    now: NOW,
    autopilot: ok({ schema: 1, enabled: true, paths: ['A', 'B'], max_releases_per_day: 2 }),
    g1: ok({ ok: true }),
    g2: ok({ ok: true }),
    g3: ok({ ok: true, cl: '127999', previousCl: '127004' }),
    g4: ok(aob([aobRow('GetWorld'), aobRow('SpawnActor'), aobRow('Optional', 'OK', false)])),
    g5: ok({ ok: true, usedChanged: [] }),
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
  assert.deepEqual(ap.paths, ['A']);
  assert.equal(ap.max_releases_per_day, 2);
});

test('A: CL-only change ships', () => {
  const r = decide(base());
  assert.equal(r.decision, 'A');
  assert.equal(r.path, 'A');
  assert.equal(r.ship, true);
  assert.equal(r.cl, '127999');
  assert.deepEqual(r.reasons, []);
});

test('A: a non-required pattern miss still ships, with a note', () => {
  const r = decide(base({ g4: ok(aob([aobRow('GetWorld'), aobRow('Optional', 'MISSING', false)])) }));
  assert.equal(r.decision, 'A');
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
    autopilot: ok({ enabled: true, paths: ['A', 'B', 'C'], max_releases_per_day: 2 }),
    g5: ok({ ok: true, usedChanged: ['UInventoryComponent'] }),
  }));
  holds(r, /path C held until shadow mode is proven/);
  assert.equal(r.path, 'C');
});

test('C wins over B when both a pattern missed and a class moved', () => {
  const r = decide(base({
    g4: ok(aob([aobRow('SpawnActor', 'MISSING')])),
    g5: ok({ ok: true, usedChanged: ['UFoo'] }),
  }));
  holds(r);
  assert.equal(r.path, 'C');
});

test('HOLD: autopilot disabled', () => {
  const r = decide(base({ autopilot: ok({ enabled: false, paths: ['A'], max_releases_per_day: 2 }) }));
  holds(r, /disabled/);
  assert.equal(r.path, 'A', 'the would-be path is still reported');
});

test('HOLD: path not enabled in autopilot.paths', () => {
  const rB = decide(base({
    autopilot: ok({ enabled: true, paths: ['A'], max_releases_per_day: 2 }),
    g4: ok(aob([aobRow('SpawnActor', 'MISSING')])),
  }));
  holds(rB, /path B is not enabled/);
  const rA = decide(base({ autopilot: ok({ enabled: true, paths: [], max_releases_per_day: 2 }) }));
  holds(rA, /path A is not enabled/);
});

test('HOLD: G1 or G2 not ok', () => {
  holds(decide(base({ g1: ok({ ok: false }) })), /G1/);
  holds(decide(base({ g2: ok({ ok: false }) })), /G2/);
});

// ------------------------------------------------------------ fail closed

const BAD_JSON = { ok: false, error: 'cannot read x: ENOENT' };

test('fail closed: autopilot unreadable or malformed', () => {
  holds(decide(base({ autopilot: BAD_JSON })), /autopilot/);
  holds(decide(base({ autopilot: ok(null) })), /autopilot/);
  holds(decide(base({ autopilot: ok([]) })), /autopilot/);
  holds(decide(base({ autopilot: ok({ paths: ['A'], max_releases_per_day: 2 }) })), /enabled is not a boolean/);
  holds(decide(base({ autopilot: ok({ enabled: 'true', paths: ['A'], max_releases_per_day: 2 }) })), /enabled is not a boolean/);
  holds(decide(base({ autopilot: ok({ enabled: 1, paths: ['A'], max_releases_per_day: 2 }) })), /enabled is not a boolean/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: 'A', max_releases_per_day: 2 }) })), /paths/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['A', 'Z'], max_releases_per_day: 2 }) })), /paths/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['A'] }) })), /max_releases_per_day/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['A'], max_releases_per_day: '2' }) })), /max_releases_per_day/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['A'], max_releases_per_day: -1 }) })), /max_releases_per_day/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['A'], max_releases_per_day: 1.5 }) })), /max_releases_per_day/);
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['A'], max_releases_per_day: 2, error: 'stale' }) })), /error/);
});

test('fail closed: max_releases_per_day 0 blocks everything', () => {
  holds(decide(base({ autopilot: ok({ enabled: true, paths: ['A'], max_releases_per_day: 0 }) })), /rate limit/);
});

for (const gate of ['g1', 'g2', 'g3', 'g4', 'g5', 'history']) {
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
    holds(decide(base({ g3: ok({ ok: bad, cl: '127999' }) })));
    holds(decide(base({ g5: ok({ ok: bad, usedChanged: [] }) })));
  }
});

test('fail closed: G3 CL', () => {
  holds(decide(base({ g3: ok({ ok: true }) })), /cl is missing/);
  holds(decide(base({ g3: ok({ ok: true, cl: 'CL-127999' }) })), /cl is missing/);
  holds(decide(base({ g3: ok({ ok: true, cl: 127999 }) })), /cl is missing/);
  holds(decide(base({ g3: ok({ ok: true, cl: '127004', previousCl: '127004' }) })), /not newer/);
  holds(decide(base({ g3: ok({ ok: true, cl: '120000', previousCl: '127004' }) })), /not newer/);
  holds(decide(base({ g3: ok({ ok: true, cl: '127999', previousCl: 'x' }) })), /previousCl/);
});

test('fail closed: G4 must be a consistent server scan', () => {
  const good = aob([aobRow('GetWorld')]);
  holds(decide(base({ g4: ok({ ...good, target: 'client' }) })), /expected "server"/);
  holds(decide(base({ g4: ok({ ...good, target: undefined }) })), /expected "server"/);
  holds(decide(base({ g4: ok({ ...good, patterns: [], summary: { total: 0, requiredFailing: 0 } }) })), /no patterns/);
  holds(decide(base({ g4: ok({ ...good, summary: undefined }) })), /summary/);
  holds(decide(base({ g4: ok({ ...good, summary: { ...good.summary, requiredFailing: 1 } }) })), /disagrees/);
  holds(decide(base({ g4: ok({ ...good, summary: { ...good.summary, total: 9 } }) })), /disagrees/);
  // A summary that hides a missed required pattern must not turn a B into an A.
  const liar = aob([aobRow('GetWorld'), aobRow('SpawnActor', 'MISSING')]);
  liar.summary.requiredFailing = 0;
  holds(decide(base({ g4: ok(liar) })), /disagrees/);
  holds(decide(base({ g4: ok({ ...good, patterns: [{ name: 'x' }] }) })), /malformed/);
  holds(decide(base({ g4: ok({ ...good, patterns: [{ name: 'x', result: 'OK', required: 'yes' }] }) })), /malformed/);
});

test('fail closed: G5 usedChanged must be a list of names', () => {
  holds(decide(base({ g5: ok({ ok: true }) })), /usedChanged/);
  holds(decide(base({ g5: ok({ ok: true, usedChanged: 'none' }) })), /usedChanged/);
  holds(decide(base({ g5: ok({ ok: true, usedChanged: [1] }) })), /usedChanged/);
  holds(decide(base({ g5: ok({ ok: true, usedChanged: [''] }) })), /usedChanged/);
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
  assert.equal(decide(base({ history: ok({ releases: [rel(60 * 30, 'Waila', '127999')], attempts: {} }) })).decision, 'A');
});

test('rate limit: at most 2 releases per repo in 24 h', () => {
  holds(decide(base({ history: ok({ releases: [rel(60), rel(120)], attempts: {} }) })), /2 ModLoader releases in the last 24 h/);
  assert.equal(decide(base({ history: ok({ releases: [rel(60), rel(60 * 25)], attempts: {} }) })).decision, 'A');
  assert.equal(decide(base({ history: ok({ releases: [rel(60), rel(120, 'Waila')], attempts: {} }) })).decision, 'A');
});

test('rate limit: the autopilot cap can lower but never raise the design cap', () => {
  const one = ok({ enabled: true, paths: ['A'], max_releases_per_day: 1 });
  holds(decide(base({ autopilot: one, history: ok({ releases: [rel(60)], attempts: {} }) })), /limit 1/);
  const five = ok({ enabled: true, paths: ['A'], max_releases_per_day: 5 });
  holds(decide(base({ autopilot: five, history: ok({ releases: [rel(60), rel(120)], attempts: {} }) })), /limit 2/);
  assert.equal(LIMITS.maxReleasesPerDay, 2);
});

test('rate limit: releases at least 30 minutes apart', () => {
  holds(decide(base({ history: ok({ releases: [rel(29)], attempts: {} }) })), /30 minutes/);
  assert.equal(decide(base({ history: ok({ releases: [rel(31)], attempts: {} }) })).decision, 'A');
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
  // path A does not use the attempts counter
  assert.equal(decide(base({ history: ok({ releases: [], attempts: { 127999: 9 } }) })).decision, 'A');
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
  for (const k of ['autopilot', 'g1', 'g2', 'g3', 'g4', 'g5', 'history']) args.push(`--${k}`, names[k] ?? join(dir, `${k}-missing.json`));
  const r = spawnSync(process.execPath, [cli, ...args, ...extra], { encoding: 'utf8', windowsHide: true });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* leave null */ }
  return { status: r.status, out, dir };
}
const cliFiles = (over = {}) => {
  const b = base();
  const f = {};
  for (const k of ['autopilot', 'g1', 'g2', 'g3', 'g4', 'g5', 'history']) f[k] = b[k].value;
  return { ...f, ...over };
};

test('cli: exit 0 and a decision file for A', () => {
  const r = runCli(cliFiles(), []);
  assert.equal(r.status, 0);
  assert.equal(r.out.decision, 'A');
});

test('cli: exit 1 with HOLD for a disabled autopilot', () => {
  const r = runCli(cliFiles({ autopilot: { schema: 1, enabled: false, paths: ['A'], max_releases_per_day: 2 } }));
  assert.equal(r.status, 1);
  assert.equal(r.out.decision, 'HOLD');
});

test('cli: a missing file for any input is a HOLD', () => {
  for (const k of ['autopilot', 'g1', 'g2', 'g3', 'g4', 'g5', 'history']) {
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
  const r = runCli(cliFiles({ g1: '﻿{"ok":true}' }));
  assert.equal(r.out.decision, 'A');
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
