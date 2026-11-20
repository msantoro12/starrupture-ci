// Tests for ci/pr-covers.mjs (does an open game-update PR already hold the build ids this poll found).
//
//   node --test ci/pr-covers.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changesAgainst, covers } from './pr-covers.mjs';

const CLIENT = '1631270';
const SERVER = '3809400';
// A state file: client = { branch: [buildid, timeupdated] }, server likewise.
const state = (client, server = { public: [25642172, 1791183334] }) => ({
  schema: 1,
  apps: {
    [CLIENT]: { name: 'StarRupture', branches: Object.fromEntries(Object.entries(client).map(([b, [id, t]]) => [b, { buildid: String(id), timeupdated: t }])) },
    [SERVER]: { name: 'StarRupture Dedicated Server', branches: Object.fromEntries(Object.entries(server).map(([b, [id, t]]) => [b, { buildid: String(id), timeupdated: t }])) },
  },
});

// Main's recorded state, and what Steam listed on the day the update PR opened and now.
const baseline = state({ public: [25646882, 1], public_test_branch: [26271156, 2] });
const prHead = state({ public: [26750759, 10], public_test_branch: [26271156, 2], other: [26781824, 11] });

test('the same ids with other timeupdated stamps are covered', () => {
  const polled = state({ public: [26750759, 99], public_test_branch: [26271156, 98], other: [26781824, 97] });
  assert.equal(covers(baseline, polled, prHead), true);
});

test('a different build id on a changed branch is not covered', () => {
  const polled = state({ public: [26800000, 99], public_test_branch: [26271156, 2], other: [26781824, 11] });
  assert.equal(covers(baseline, polled, prHead), false);
});

test('a new build on a branch the PR does not hold is not covered', () => {
  const polled = state({ public: [26750759, 10], public_test_branch: [26461198, 20], other: [26781824, 11] });
  assert.equal(covers(baseline, polled, prHead), false);
  // And a branch that appears is a change the PR does not hold.
  assert.equal(covers(baseline, state({ public: [26750759, 10], fresh: [27000000, 30] }), prHead), false);
});

test('the order Steam lists the branches in does not matter', () => {
  const a = state({ other: [26781824, 11], public: [26750759, 10], public_test_branch: [26271156, 2] });
  assert.equal(covers(baseline, a, prHead), true);
  assert.deepEqual(changesAgainst(baseline, a), changesAgainst(baseline, prHead));
});

test('a branch missing from this poll does not break coverage', () => {
  // Steam answered without one branch: the poll keeps the recorded id for it, so it is no change.
  const polled = state({ public: [26750759, 10], public_test_branch: [26271156, 2] });
  assert.equal(covers(baseline, polled, prHead), true);
});

test('the server app counts like a client branch', () => {
  const base = baseline;
  const head = state({ public: [26750759, 10] }, { public: [25700000, 5] });
  assert.equal(covers(base, state({ public: [26750759, 10] }, { public: [25700000, 6] }), head), true);
  assert.equal(covers(base, state({ public: [26750759, 10] }, { public: [25700001, 6] }), head), false);
});

test('a poll with no change against the baseline is not covered (nothing to skip on)', () => {
  assert.equal(covers(baseline, baseline, prHead), false);
});

test('changesAgainst lists only the entries that differ from the baseline, as strings', () => {
  assert.deepEqual(changesAgainst(baseline, prHead), { [`${CLIENT}:public`]: '26750759', [`${CLIENT}:other`]: '26781824' });
});

// ---- the command line

const script = join(dirname(fileURLToPath(import.meta.url)), 'pr-covers.mjs');
const cli = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'prcovers-'));
  const args = [script];
  for (const [flag, content] of Object.entries(files)) {
    const path = join(dir, flag + '.json');
    if (content !== null) writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    args.push(`--${flag}`, path);
  }
  return spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
};

test('cli: exit 0 when covered, 1 when not', () => {
  const polled = state({ public: [26750759, 99], public_test_branch: [26271156, 2], other: [26781824, 11] });
  const covered = cli({ baseline, polled, 'pr-head': prHead });
  assert.equal(covered.status, 0, covered.stderr);
  const not = cli({ baseline, polled: state({ public: [26800000, 1] }), 'pr-head': prHead });
  assert.equal(not.status, 1, not.stderr);
});

test('cli: a PR head file that is missing, empty or not JSON is not covered, with exit 2 and a message', () => {
  const polled = state({ public: [26750759, 10] });
  for (const bad of [null, '', 'not json', '[]', '{"schema":1}']) {
    const r = cli({ baseline, polled, 'pr-head': bad });
    assert.equal(r.status, 2, `${JSON.stringify(bad)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Cannot read the pr-head state/);
  }
});
