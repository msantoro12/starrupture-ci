// Tests for vmap-watchdog.mjs.
//
//   node --test ci/vmap-watchdog.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lag, MAX_LAG_SECONDS, seqOf } from './vmap-watchdog.mjs';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'vmap-watchdog.mjs');
const feed = (seq) => `format\t1\nseq\t${seq}\nbuild\t1\t0x1\t0x1\tx\nsig\tk1\tAAAA\n`;

test('reads the seq of a signed feed and nothing else', () => {
  assert.equal(seqOf(feed(1800000000), 'f'), 1800000000);
  assert.throws(() => seqOf('seq\t5\nformat\t1\n', 'f'), /not a signed feed/);
  assert.throws(() => seqOf('format\t1\nseq\t05\n', 'f'), /not a signed feed/);
});

test('current, at the limit, lagging and no feed on Latest', () => {
  const S = 1800000000;
  assert.equal(lag(S, S).lagging, false);
  assert.equal(lag(S, S - MAX_LAG_SECONDS).lagging, false);
  assert.equal(lag(S, S - MAX_LAG_SECONDS - 1).lagging, true);
  assert.equal(lag(S, S + 5).lagging, false);
  assert.match(lag(S, null).message, /no feed/);
  assert.equal(lag(S, S - 61, 60).lagging, true);
});

test('the command line exits 0 and 3, and 2 on bad input (a staged lag)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vmap-watchdog-'));
  const f = (name, seq) => { const p = join(dir, name); writeFileSync(p, feed(seq)); return p; };
  const run = (...a) => spawnSync(process.execPath, [TOOL, 'check', ...a], { encoding: 'utf8', windowsHide: true });
  const signed = f('signed.txt', 1800010000);
  assert.equal(run('--signed', signed, '--published', f('cur.txt', 1800009000)).status, 0);
  const staged = run('--signed', signed, '--published', f('old.txt', 1800000000));
  assert.equal(staged.status, 3);
  assert.match(staged.stdout, /behind/);
  assert.equal(run('--signed', signed, '--published', '-').status, 3);
  assert.equal(run('--signed', signed, '--published', join(dir, 'missing.txt')).status, 2);
  assert.equal(run('--signed', signed).status, 2);
});
