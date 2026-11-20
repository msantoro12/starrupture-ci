// Tests for supersede-note.mjs, the alert issue's line for a second release of a CL.
//
//   node --test ci/supersede-note.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supersedeNote } from './supersede-note.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const history = { releases: [{ repo: 'ModLoader', cl: 129402, at: '2026-11-19T10:00:00.000Z', seq: 1763500000 }], attempts: {} };
const args = { decision: { decision: 'M', cl: 129402, supersedes: 1763500000 }, history, actor: 'msantoro12', run: '9001', seq: 1763504000 };

test('the line names what it replaces, who started the run, the run id and the new seq', () => {
  assert.equal(supersedeNote(args), '**second release of CL-129402** (supersede, started by msantoro12): it replaces seq 1763500000, our release of 2026-11-19T10:00:00.000Z; run 9001, new seq 1763504000');
});

test('an ordinary release has no line, and a decision that is not a second release has none', () => {
  assert.equal(supersedeNote({ ...args, decision: { decision: 'M', cl: 129402 } }), null);
  assert.equal(supersedeNote({ ...args, decision: { decision: 'M', cl: 129402, supersedes: '1763500000' } }), null);
  assert.equal(supersedeNote({ ...args, decision: null }), null);
});

test('a history that does not hold the release still gives the line, without the date', () => {
  const line = supersedeNote({ ...args, history: null });
  assert.equal(line, '**second release of CL-129402** (supersede, started by msantoro12): it replaces seq 1763500000; run 9001, new seq 1763504000');
});

test('the alert wording uses no rate limit, per day, 24 h or gap words', () => {
  assert.doesNotMatch(supersedeNote(args), /rate limit|per day|24 ?h|gap/i);
});

test('the command line writes the alert list for a supersede and nothing for an ordinary release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'supersede-note-'));
  const run = (decision) => {
    writeFileSync(join(dir, 'decision.json'), JSON.stringify(decision));
    writeFileSync(join(dir, 'history.json'), JSON.stringify(history));
    const out = join(dir, `out-${Math.random().toString(36).slice(2)}.json`);
    const r = spawnSync(process.execPath, [join(here, 'supersede-note.mjs'), '--decision', join(dir, 'decision.json'), '--history', join(dir, 'history.json'), '--actor', 'msantoro12', '--run', '9001', '--seq', '1763504000', '--out', out], { encoding: 'utf8', windowsHide: true });
    return { r, out };
  };
  const second = run({ decision: 'M', cl: 129402, supersedes: 1763500000 });
  assert.equal(second.r.status, 0, second.r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(second.out, 'utf8')), { alerts: [`- ${supersedeNote(args)}`] });
  const plain = run({ decision: 'M', cl: 129402 });
  assert.equal(plain.r.status, 0);
  assert.equal(existsSync(plain.out), false, 'an ordinary release writes no file');
  const bad = spawnSync(process.execPath, [join(here, 'supersede-note.mjs'), '--decision', join(dir, 'decision.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(bad.status, 2);
});
