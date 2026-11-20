// Tests for vmap-history.mjs: the keyed release history of the version object map.
//
//   node --test ci/vmap-history.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countedAttempts, findDuplicateJsonKeys, historyKey, listReleases, loadHistory, readHistory, recordAttempt, retryCl, serializeHistory, upsertRelease,
} from './vmap-history.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'vmap-history.mjs');
const AT = '2026-11-19T12:00:00Z';
const entry = (cl, seq, repo = 'ModLoader', extra = {}) => ({ repo, cl, at: AT, seq, ...extra });
const empty = () => ({ releases: {}, attempts: {} });
const dir = () => mkdtempSync(join(tmpdir(), 'vmap-history-'));
const cli = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true });

test('the same version identity written twice leaves one entry, with the newest seq', () => {
  let h = upsertRelease(empty(), entry('130045', 1795109176));
  h = upsertRelease(h, entry('130045', 1795109742, 'ModLoader', { supersedes: 1795109176 }));
  assert.deepEqual(Object.keys(h.releases), ['ModLoader:130045']);
  assert.equal(h.releases['ModLoader:130045'].seq, 1795109742);
  assert.equal(h.releases['ModLoader:130045'].supersedes, 1795109176);
  // the older seq written after the newer one does not replace it
  assert.equal(upsertRelease(h, entry('130045', 1795109176)).releases['ModLoader:130045'].seq, 1795109742);
  // another CL, and another repo's entry for the same CL, are other identities
  h = upsertRelease(h, entry('130046', 1795110000));
  h = upsertRelease(h, entry('130045', 1795110001, 'WAILA'));
  assert.deepEqual(Object.keys(h.releases).sort(), ['ModLoader:130045', 'ModLoader:130046', 'WAILA:130045']);
  assert.equal(listReleases(h).length, 3);
  assert.equal(historyKey('ModLoader', '130045'), 'ModLoader:130045');
});

test('an upsert refuses an entry that is not one', () => {
  assert.throws(() => upsertRelease(empty(), { repo: 'ModLoader', cl: 'abc', seq: 1 }), /malformed release entry/);
  assert.throws(() => upsertRelease(empty(), { repo: 'ModLoader', cl: '1' }), /needs the seq/);
});

test('the old array history migrates: read keyed, written back keyed, attempts kept', () => {
  const old = { releases: [entry('127004', 1792000000), entry('127999', 1793000000)], attempts: { 127999: 1 } };
  const got = readHistory(old);
  assert.equal(got.ok, true);
  assert.equal(got.migrated, true);
  assert.deepEqual(Object.keys(got.history.releases), ['ModLoader:127004', 'ModLoader:127999']);
  assert.deepEqual(got.history.attempts, { 127999: 1 });
  assert.equal(countedAttempts(got.history, '127999'), 1);
  const text = serializeHistory(got.history);
  const back = JSON.parse(text);
  assert.equal(Array.isArray(back.releases), false);
  assert.equal(readHistory(back).migrated, false);
  assert.deepEqual(readHistory(back).history, got.history);
  // a history with no entry at all migrates too
  assert.deepEqual(readHistory({ releases: [], attempts: {} }).history, empty());
});

test('a history that lists one identity twice is refused by readers and collapsed to the newest seq by writers', () => {
  const twice = { releases: [entry('130045', 1795109176), entry('130045', 1795109742)], attempts: {} };
  assert.match(readHistory(twice).error, /ModLoader CL-130045 is listed twice/);
  const fixed = readHistory(twice, { collapse: true });
  assert.equal(fixed.ok, true);
  assert.deepEqual(Object.keys(fixed.history.releases), ['ModLoader:130045']);
  assert.equal(fixed.history.releases['ModLoader:130045'].seq, 1795109742);
  // in either order
  assert.equal(readHistory({ releases: [...twice.releases].reverse(), attempts: {} }, { collapse: true }).history.releases['ModLoader:130045'].seq, 1795109742);
});

test('a malformed history is refused', () => {
  for (const bad of [null, [], 'x', {}, { releases: 'none' }, { releases: [], attempts: [] }, { releases: [null] }, { releases: [{ repo: 7, cl: '1' }] },
    { releases: [entry('abc', 1)] }, { releases: [entry('1', 0)] }, { releases: {}, attempts: { 1: 'two' } }, { releases: {}, attempts: { 1: -1 } },
    { releases: {}, attempts: { 1: [{ run: '1', outcome: 'cancelled' }] } }, { releases: {}, attempts: { abc: 1 } },
    { releases: { 'ModLoader:1': entry('2', 1) } }]) {
    assert.equal(readHistory(bad).ok, false, JSON.stringify(bad));
  }
});

test('a JSON key that occurs twice is found, and a file that has one is refused', () => {
  assert.deepEqual(findDuplicateJsonKeys('{"a":1,"b":2}'), []);
  assert.deepEqual(findDuplicateJsonKeys('{"releases":{"ModLoader:1":{"cl":"1"},"ModLoader:1":{"cl":"1"}},"attempts":{}}'), ['ModLoader:1']);
  // the same key in two objects is not a duplicate; a value or an array item that looks like a key is not one
  assert.deepEqual(findDuplicateJsonKeys('{"a":{"x":1},"b":{"x":2},"c":["x","x"],"d":"x","e":"x"}'), []);
  assert.deepEqual(findDuplicateJsonKeys('{"a":"say \\"b\\":1","b":2}'), []);
  assert.deepEqual(findDuplicateJsonKeys('{"a":[{"k":1},{"k":2}]}'), []);
  assert.deepEqual(findDuplicateJsonKeys('{"a":[{"k":1,"k":2}]}'), ['k']);
  const d = dir();
  writeFileSync(join(d, 'dup.json'), '{"releases":{"ModLoader:1":{"repo":"ModLoader","cl":"1"},"ModLoader:1":{"repo":"ModLoader","cl":"1"}},"attempts":{}}');
  assert.match(loadHistory(join(d, 'dup.json')).error, /"ModLoader:1" occurs twice/);
  writeFileSync(join(d, 'ok.json'), serializeHistory(upsertRelease(empty(), entry('1', 5))));
  assert.equal(loadHistory(join(d, 'ok.json')).ok, true);
  assert.equal(loadHistory(join(d, 'missing.json')).ok, false);
  writeFileSync(join(d, 'bad.json'), '{');
  assert.equal(loadHistory(join(d, 'bad.json')).ok, false);
});

test('only a rejected attempt counts: a run that died before a decision does not', () => {
  let h = empty();
  h = recordAttempt(h, '127999', { run: '1', outcome: 'infra' });
  h = recordAttempt(h, '127999', { run: '2', outcome: 'infra' });
  h = recordAttempt(h, '127999', { run: '3', outcome: 'infra' });
  assert.equal(countedAttempts(h, '127999'), 0);
  h = recordAttempt(h, '127999', { run: '4', outcome: 'rejected' });
  assert.equal(countedAttempts(h, '127999'), 1);
  assert.equal(h.attempts['127999'].length, 4);
  assert.equal(countedAttempts(h, '120000'), 0);
  assert.throws(() => recordAttempt(h, '127999', { run: '5', outcome: 'cancelled' }), /rejected or infra/);
  // a bare number, the old shape, counts as that many rejected ones and keeps counting when a record is added
  const legacy = { releases: {}, attempts: { 127999: 1 } };
  assert.equal(countedAttempts(legacy, '127999'), 1);
  assert.equal(countedAttempts(recordAttempt(legacy, '127999', { run: '9', outcome: 'rejected' }), '127999'), 2);
});

test('retry resets the count of one CL and no other, and records who and which run', () => {
  let h = empty();
  for (const cl of ['127999', '128000']) for (const run of ['1', '2']) h = recordAttempt(h, cl, { run, outcome: 'rejected' });
  assert.equal(countedAttempts(h, '127999'), 2);
  const { history: after, cleared } = retryCl(h, '127999', { actor: 'owner', run: '77', at: AT });
  assert.equal(cleared, 2);
  assert.equal(countedAttempts(after, '127999'), 0);
  assert.equal(countedAttempts(after, '128000'), 2);
  assert.deepEqual(after.attempts['128000'], h.attempts['128000']);
  const last = after.attempts['127999'].at(-1);
  assert.deepEqual([last.reset, last.actor, last.run, last.cleared], [true, 'owner', '77', 2]);
  // the earlier records stay, and what is rejected after the reset counts again
  assert.equal(after.attempts['127999'].length, 3);
  const again = recordAttempt(after, '127999', { run: '80', outcome: 'rejected' });
  assert.equal(countedAttempts(again, '127999'), 1);
  // a legacy number is cleared too
  assert.equal(countedAttempts(retryCl({ releases: {}, attempts: { 5: 2 } }, '5', { actor: 'o', run: '1' }).history, '5'), 0);
  // the releases are not touched
  assert.deepEqual(after.releases, h.releases);
  assert.throws(() => retryCl(h, 'abc', { actor: 'o', run: '1' }), /not a CL/);
  assert.throws(() => retryCl(h, '1', { actor: '', run: '1' }), /actor/);
});

test('the command line records a release keyed, collapses a repeated one and names what it replaced', () => {
  const d = dir();
  const file = join(d, 'h.json');
  // an old array history that already holds the CL twice, as the live one did
  writeFileSync(file, JSON.stringify({ releases: [entry('130045', 1795109176), entry('130045', 1795109742), entry('130001', 1790000000)], attempts: {} }));
  let r = cli(['record', '--history', file, '--repo', 'ModLoader', '--cl', '130046', '--seq', '1795200000', '--at', AT, '--out', join(d, 'out.json')]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(readFileSync(join(d, 'out.json'), 'utf8'));
  assert.deepEqual(Object.keys(out.releases), ['ModLoader:130001', 'ModLoader:130045', 'ModLoader:130046']);
  assert.equal(out.releases['ModLoader:130045'].seq, 1795109742);
  // a second release of a CL: one entry, the newest seq, the replaced seq named
  r = cli(['record', '--history', join(d, 'out.json'), '--repo', 'ModLoader', '--cl', '130046', '--seq', '1795300000', '--supersedes', '1795200000', '--out', join(d, 'out2.json')]);
  assert.equal(r.status, 0, r.stderr);
  const out2 = JSON.parse(readFileSync(join(d, 'out2.json'), 'utf8'));
  assert.equal(Object.keys(out2.releases).length, 3);
  assert.deepEqual([out2.releases['ModLoader:130046'].seq, out2.releases['ModLoader:130046'].supersedes], [1795300000, 1795200000]);
  // the same file is rewritten byte for byte when nothing changes order
  assert.equal(readFileSync(join(d, 'out2.json'), 'utf8'), serializeHistory(out2));
});

test('the command line refuses what it cannot read, and a history with a repeated JSON key', () => {
  const d = dir();
  const bad = join(d, 'bad.json');
  writeFileSync(bad, '{"releases":{"ModLoader:1":{"repo":"ModLoader","cl":"1","seq":5},"ModLoader:1":{"repo":"ModLoader","cl":"1","seq":6}},"attempts":{}}');
  let r = cli(['record', '--history', bad, '--repo', 'ModLoader', '--cl', '2', '--seq', '9', '--out', join(d, 'o.json')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /occurs twice/);
  r = cli(['record', '--history', join(d, 'nope.json'), '--repo', 'ModLoader', '--cl', '2', '--seq', '9', '--out', join(d, 'o.json')]);
  assert.equal(r.status, 2);
  r = cli(['record', '--history', bad, '--repo', 'ModLoader', '--cl', 'abc', '--seq', '9', '--out', join(d, 'o.json')]);
  assert.equal(r.status, 2);
  r = cli(['retry', '--history', bad, '--cl', '1', '--actor', 'a', '--run', '1', '--out', join(d, 'o.json')]);
  assert.equal(r.status, 2);
});

test('retry reads strictly: an old array history that lists one version twice is refused, not folded', () => {
  const d = dir();
  const file = join(d, 'h.json');
  writeFileSync(file, JSON.stringify({ releases: [entry('130045', 1795109176), entry('130045', 1795109742)], attempts: { 130045: 2 } }));
  const r = cli(['retry', '--history', file, '--cl', '130045', '--actor', 'owner', '--run', '9', '--out', join(d, 'o.json')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CL-130045 is listed twice/);
  assert.ok(!existsSync(join(d, 'o.json')), 'nothing is written');
  // record still folds the same file (the repair path)
  const ok = cli(['record', '--history', file, '--repo', 'ModLoader', '--cl', '130046', '--seq', '1795200000', '--out', join(d, 'o.json')]);
  assert.equal(ok.status, 0, ok.stderr);
});

test('record refuses a seq below the one already stored for that version, and writes nothing', () => {
  const d = dir();
  const file = join(d, 'h.json');
  writeFileSync(file, JSON.stringify({ releases: { 'ModLoader:130045': entry('130045', 1795109742) }, attempts: {} }));
  let r = cli(['record', '--history', file, '--repo', 'ModLoader', '--cl', '130045', '--seq', '1795109176', '--out', join(d, 'o.json')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already recorded at seq 1795109742, above the new seq 1795109176/);
  assert.ok(!existsSync(join(d, 'o.json')));
  // the same seq or a higher one is written
  r = cli(['record', '--history', file, '--repo', 'ModLoader', '--cl', '130045', '--seq', '1795109742', '--out', join(d, 'o.json')]);
  assert.equal(r.status, 0, r.stderr);
});

test('the retry command resets one CL, writes the line for the alert issue and leaves the other CLs alone', () => {
  const d = dir();
  const file = join(d, 'h.json');
  writeFileSync(file, JSON.stringify({ releases: [], attempts: { 127999: [{ run: '1', outcome: 'rejected' }, { run: '2', outcome: 'rejected' }], 128000: 2 } }));
  const r = cli(['retry', '--history', file, '--cl', '127999', '--actor', 'owner', '--run', '55', '--out', file, '--note', join(d, 'note.json')]);
  assert.equal(r.status, 0, r.stderr);
  const h = readHistory(JSON.parse(readFileSync(file, 'utf8'))).history;
  assert.equal(countedAttempts(h, '127999'), 0);
  assert.equal(countedAttempts(h, '128000'), 2);
  const note = JSON.parse(readFileSync(join(d, 'note.json'), 'utf8'));
  assert.equal(note.alerts.length, 1);
  assert.match(note.alerts[0], /attempts reset for CL-127999.*started by owner.*2 counted attempt\(s\) cleared for this run's decision.*run 55.*records the reset only if this run publishes.*Only CL-127999 was reset/);
  // no CL named, or one that is not a CL: refused, the file is not written
  assert.equal(cli(['retry', '--history', file, '--actor', 'owner', '--run', '55', '--out', file]).status, 2);
  assert.equal(cli(['retry', '--history', file, '--cl', '0', '--actor', 'owner', '--run', '55', '--out', file]).status, 2);
});

test('check: the command line refuses a history that lists one version twice, in an array or as a repeated key, and accepts a keyed one', () => {
  const d = dir();
  const write = (name, text) => { writeFileSync(join(d, name), text); return join(d, name); };
  assert.equal(cli(['check', '--history', write('ok.json', serializeHistory(upsertRelease(empty(), entry('130045', 1795109742))))]).status, 0);
  assert.equal(cli(['check', '--history', write('old.json', JSON.stringify({ releases: [{ repo: 'ModLoader', cl: '130045', seq: 1 }], attempts: {} }))]).status, 0, 'the old array shape reads');
  const arr = cli(['check', '--history', write('arr.json', JSON.stringify({ releases: [{ repo: 'ModLoader', cl: '130045', seq: 1795109176 }, { repo: 'ModLoader', cl: '130045', seq: 1795109742 }], attempts: {} }))]);
  assert.equal(arr.status, 2);
  const key = cli(['check', '--history', write('key.json', '{"releases":{"ModLoader:130045":{"repo":"ModLoader","cl":"130045","seq":1},"ModLoader:130045":{"repo":"ModLoader","cl":"130045","seq":2}},"attempts":{}}')]);
  assert.equal(key.status, 2);
  assert.equal(cli(['check', '--history', join(d, 'missing.json')]).status, 2, 'unreadable refuses');
});

test('the pre-dedupe live history (CL 130045 twice): check names it and refuses; record collapses it to the newest seq and the result passes check', () => {
  const d = dir();
  const original = { releases: [
    { repo: 'ModLoader', cl: '127004', at: '2026-11-09T04:11:58.583Z', seq: 1794194330 },
    { repo: 'ModLoader', cl: '130045', at: '2026-11-19T17:26:22.387Z', seq: 1795109176 },
    { repo: 'ModLoader', cl: '130045', at: '2026-11-19T17:36:00.818Z', seq: 1795109742 },
  ], attempts: {} };
  const file = join(d, 'original.json');
  writeFileSync(file, JSON.stringify(original));
  const named = cli(['check', '--history', file]);
  assert.equal(named.status, 2);
  assert.match(named.stderr, /ModLoader CL-130045 is listed twice/);
  const out = join(d, 'out.json');
  assert.equal(cli(['record', '--history', file, '--repo', 'ModLoader', '--cl', '130046', '--seq', '1795200000', '--at', AT, '--out', out]).status, 0);
  const next = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(next.releases), ['ModLoader:127004', 'ModLoader:130045', 'ModLoader:130046']);
  assert.equal(next.releases['ModLoader:130045'].seq, 1795109742, 'the newest seq stays');
  assert.equal(cli(['check', '--history', out]).status, 0);
});
