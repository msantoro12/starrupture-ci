// Tests for field-rows.mjs.
//
//   node --test ci/field-rows.test.mjs
//
// The header is the loader fixture with CL-130000 added as a build; the layout
// reports are made up and carry no real member.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addBuild, emit, parse, parseKeys, unionKeys } from './version-map.mjs';
import { fieldRows, keysFromCheck, parseUses } from './field-rows.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'field-rows.mjs');

function header() {
  const map = parse(readFileSync(join(here, 'fixtures', 'version-map', 'loader.h'), 'utf8').replace(/\r\n/g, '\n'));
  addBuild(map, { cl: 130000, stamp: 0x6b000001, size: 0x0a430000, source: 'public_test_branch 26300000' });
  return emit(map);
}

const KEYS = `
native UCrGameInstance::ServerSessionName 0x290 0x10 0x00
native UCrEnviroWaveTimerSubsystem::bPause 0x83 0x1 0xFF
native FTransform::Translation 0x20 0x18 0x00
field ACrCrafter::CraftComponent
field UCrSomething::bFlag
field UCrOld::Removed optional
`;
const keys = () => unionKeys([parseKeys(KEYS)]);

const ent = (key, offset, size, boolMask = 0) => ({ key, result: 'OK', offset, size, boolMask });
const gone = (key) => ({ key, result: 'MISSING' });

// Reference (127004) and new (130000) builds of the same key list.
const base = () => [
  ent('UCrGameInstance::ServerSessionName', 0x290, 0x10),
  ent('UCrEnviroWaveTimerSubsystem::bPause', 0x83, 1, 0xff),
  ent('FTransform::Translation', 0x20, 0x20),
  ent('ACrCrafter::CraftComponent', 0x6d8, 8),
  ent('UCrSomething::bFlag', 0x565, 1, 0x10),
  ent('UCrOld::Removed', 0x40, 8),
];
const next = () => [
  ent('UCrGameInstance::ServerSessionName', 0x298, 0x10),
  ent('UCrEnviroWaveTimerSubsystem::bPause', 0x83, 1, 0xff),
  ent('FTransform::Translation', 0x20, 0x20),
  ent('ACrCrafter::CraftComponent', 0x6e0, 8),
  ent('UCrSomething::bFlag', 0x565, 1, 0x10),
  gone('UCrOld::Removed'),
];

const fields = (text) => parse(text).fields.filter((r) => r.cl === 130000);
const row = (text, key) => fields(text).find((r) => r.key === key);

test('every native key gets a row, and a reflected key that moved gets one too', () => {
  const out = fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: base() });
  assert.deepEqual(out.problems, []);
  assert.equal(row(out.text, 'UCrGameInstance::ServerSessionName').offset, 0x298);
  assert.equal(row(out.text, 'UCrEnviroWaveTimerSubsystem::bPause').size, 1);
  assert.equal(row(out.text, 'UCrEnviroWaveTimerSubsystem::bPause').mask, 0xff);
  assert.equal(row(out.text, 'ACrCrafter::CraftComponent').offset, 0x6e0, 'moved');
  assert.equal(row(out.text, 'UCrSomething::bFlag'), undefined, 'same: reflection gives it live');
  assert.equal(out.added, 4);
});

test('an optional reflected key that only the reference build resolves gets an absent row, not a guess', () => {
  const out = fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: base() });
  assert.deepEqual(out.absent.map((p) => p.key), ['UCrOld::Removed']);
  assert.equal(row(out.text, 'UCrOld::Removed'), undefined);
  assert.deepEqual(parse(out.text).absentFields, [{ key: 'UCrOld::Removed', cl: 130000 }]);
  assert.ok(out.covered.includes('UCrOld') && out.covered.includes('ACrCrafter'));
  assert.ok(!out.covered.includes('UCrSomething'), 'nothing of it moved');
});

test('a gone key that is not marked optional is an absent row too, at high severity: the plugin is degraded, never held', () => {
  const req = unionKeys([parseKeys(KEYS.replace('field UCrOld::Removed optional', 'field UCrOld::Removed'))]);
  const out = fieldRows(header(), { cl: 130000, keys: req, next: next(), base: base() });
  assert.deepEqual(out.problems, []);
  assert.notEqual(out.text, null);
  assert.deepEqual(out.absent.map((a) => [a.key, a.severity]), [['UCrOld::Removed', 'high']]);
  assert.deepEqual(parse(out.text).absentFields, [{ key: 'UCrOld::Removed', cl: 130000 }]);
  assert.deepEqual(Object.keys(out.degraded), ['?'], 'a --keys list names no owner');
  const opt = fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: base() });
  assert.deepEqual(opt.absent.map((a) => [a.key, a.severity]), [['UCrOld::Removed', 'low']]);
});

test('a native key the new build does not have gets an absent row: high unless it is optional', () => {
  const n = next().map((e) => (e.key === 'UCrGameInstance::ServerSessionName' ? { key: e.key, result: 'NOMEMBER' } : e));
  const out = fieldRows(header(), { cl: 130000, keys: keys(), next: n, base: base() });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.absent.map((a) => [a.key, a.severity]), [['UCrGameInstance::ServerSessionName', 'high'], ['UCrOld::Removed', 'low']]);
  assert.equal(row(out.text, 'UCrGameInstance::ServerSessionName'), undefined, 'no row ships for it');
  const opt = unionKeys([parseKeys(KEYS.replace('0x290 0x10 0x00', '0x290 0x10 0x00 optional'))]);
  const low = fieldRows(header(), { cl: 130000, keys: opt, next: n, base: base() });
  assert.deepEqual(low.absent.map((a) => [a.key, a.severity]), [['UCrGameInstance::ServerSessionName', 'low'], ['UCrOld::Removed', 'low']]);
});

test('a class whose size changed: a note when nothing depends on its size, degraded with SR_SIZE_CHECK, refused on a compiled-size use', () => {
  const k = unionKeys([parseKeys(KEYS + 'field ACrCrafter\n')]);
  const b = [...base(), ent('ACrCrafter', null, 0x70)];
  const n = [...next(), ent('ACrCrafter', null, 0x78)];
  const strict = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b });
  assert.equal(strict.text, null, 'without a uses file every class is taken to be used by its compiled size');
  assert.ok(strict.problems.some((p) => p.startsWith('class ACrCrafter: its size changed (0x70 -> 0x78)') && p.includes('SR_SIZE_CHECK(ACrCrafter)')));
  const unused = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('P key ACrCrafter\nP key ACrCrafter::CraftComponent\n') });
  assert.deepEqual(unused.problems, []);
  assert.ok(unused.notes.some((x) => x === 'class ACrCrafter: its size changed (0x70 -> 0x78); no plugin depends on its whole size'));
  assert.ok(unused.covered.includes('ACrCrafter'));
  const checked = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('P key ACrCrafter\nP size ACrCrafter check\nQ key ACrCrafter\n') });
  assert.deepEqual(checked.problems, []);
  assert.deepEqual(checked.degraded.P.map((d) => [d.key, d.severity]), [['ACrCrafter', 'high']]);
  assert.equal(checked.degraded.Q, undefined, 'Q does not depend on the size');
  const compiled = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('P size ACrCrafter check\nQ size ACrCrafter compiled\n') });
  assert.equal(compiled.text, null);
  assert.ok(compiled.problems.some((p) => p.includes('and Q uses its compiled size with no SR_SIZE_CHECK')));
  const same = fieldRows(header(), { cl: 130000, keys: k, next: [...next(), ent('ACrCrafter', null, 0x70)], base: b });
  assert.deepEqual(same.problems, []);
});

test('per plugin, only what it requests: a request is high, a lazy lookup low, a name match a note; the loader holds everything', () => {
  const k = keysFromCheck('', 'UCrOld::Removed\nUCrOld\n');
  const b = [ent('UCrOld', null, 0x50), ent('UCrOld::Removed', 0x40, 8)];
  const n = [ent('UCrOld', null, 0x50), gone('UCrOld::Removed')];
  const run = (uses) => fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses(uses) });
  const req = run('A key UCrOld::Removed\nA request UCrOld::Removed\nB key UCrOld::Removed\nB lazy Removed\nC key UCrOld::Removed\n');
  assert.deepEqual(req.problems, []);
  assert.deepEqual(req.absent, [{ key: 'UCrOld::Removed', why: 'resolves on the reference build only (removed or renamed)', severity: 'high', owners: ['A', 'B'] }]);
  assert.deepEqual(Object.keys(req.degraded), ['A', 'B'], 'C only names it');
  assert.equal(req.degraded.A[0].severity, 'high');
  assert.equal(req.degraded.B[0].severity, 'low');
  const lazy = run('B key UCrOld::Removed\nB lazy Removed\n');
  assert.equal(lazy.absent[0].severity, 'low');
  const named = run('C key UCrOld::Removed\n');
  assert.deepEqual([named.absent, named.degraded, named.problems], [[], {}, []]);
  assert.ok(named.notes.some((x) => x.startsWith('UCrOld::Removed: resolves on the reference build only') && x.includes('no plugin requests it')));
  const loader = run('ModLoader key UCrOld::Removed\nA key UCrOld::Removed\nA request UCrOld::Removed\n');
  assert.equal(loader.text, null);
  assert.ok(loader.problems.some((p) => p.includes('the loader itself reads it')));
});

test('a class that is gone degrades every plugin with a key in it, and holds when the loader reads it', () => {
  const k = keysFromCheck('', 'UCrOld\nUCrOld::Removed\n');
  const b = [ent('UCrOld', null, 0x50), ent('UCrOld::Removed', 0x40, 8)];
  const n = [{ key: 'UCrOld', result: 'NOTYPE' }, { key: 'UCrOld::Removed', result: 'NOTYPE' }];
  const out = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('A key UCrOld\nA key UCrOld::Removed\nA request UCrOld::Removed\n') });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.degraded.A.map((d) => [d.key, d.severity]), [['UCrOld', 'high'], ['UCrOld::Removed', 'high']]);
  const held = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('ModLoader key UCrOld\n') });
  assert.equal(held.text, null);
  assert.throws(() => parseUses('A size UCrOld\n'), /expected/);
});

test('the client check key list: native-keys.txt lines with built values and optional, plus the plain layout keys', () => {
  const k = keysFromCheck(
    'P UCrGameInstance::ServerSessionName optional\nQ UCrGameInstance::ServerSessionName\nP UCrX::Y optional\nP FTransform::Translation 0x20 0x18 0x00 a.cpp:x~@,\n',
    'FTransform::Translation\nUCrGameInstance::ServerSessionName\nACrCrafter::CraftComponent\nACrCrafter\nUCrX::Y\n');
  assert.deepEqual([...k.native.keys()].sort(), ['FTransform::Translation', 'UCrGameInstance::ServerSessionName', 'UCrX::Y']);
  assert.equal(k.native.get('FTransform::Translation').size, 0x18);
  assert.ok(!k.optionalFields.has('UCrGameInstance::ServerSessionName'), 'Q has no fallback');
  assert.ok(k.optionalFields.has('UCrX::Y'));
  assert.deepEqual(k.owners.get('UCrGameInstance::ServerSessionName'), ['P', 'Q']);
  assert.deepEqual([...k.fields].sort(), ['ACrCrafter', 'ACrCrafter::CraftComponent']);
  assert.throws(() => keysFromCheck('P FTransform::Translation 0x20 0x18 0x00\nQ FTransform::Translation 0x20 0x20 0x00\n', ''), /two different built values/);
  const gone = fieldRows(header(), { cl: 130000, keys: keysFromCheck('P UCrGameInstance::ServerSessionName\n', ''), next: [{ key: 'UCrGameInstance::ServerSessionName', result: 'NOMEMBER' }], base: null });
  assert.deepEqual(gone.problems, []);
  assert.deepEqual(gone.degraded, { P: [{ key: 'UCrGameInstance::ServerSessionName', severity: 'high', why: 'not on the new build (NOMEMBER)' }] });
});

test('FTransform::Translation keeps the built size, not the register size', () => {
  const out = fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: base() });
  const r = row(out.text, 'FTransform::Translation');
  assert.equal(r.size, 0x18);
  assert.ok(out.notes.some((n) => n.startsWith('FTransform::Translation: kept the built size 0x18')));
});

test('a native key the new build does not resolve is refused, and the header is not written', () => {
  const n = next().map((e) => (e.key === 'UCrGameInstance::ServerSessionName' ? gone(e.key) : e));
  const out = fieldRows(header(), { cl: 130000, keys: keys(), next: n, base: base() });
  assert.equal(out.text, null);
  assert.ok(out.problems.some((p) => p.includes('UCrGameInstance::ServerSessionName') && p.includes('not found on the new build')));
});

test('a second run adds nothing and a different earlier row is refused', () => {
  const once = fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: base() });
  const twice = fieldRows(once.text, { cl: 130000, keys: keys(), next: next(), base: base() });
  assert.equal(twice.added, 0);
  assert.equal(twice.text, once.text);
  const moved = next().map((e) => (e.key === 'UCrGameInstance::ServerSessionName' ? ent(e.key, 0x2a0, 0x10) : e));
  const clash = fieldRows(once.text, { cl: 130000, keys: keys(), next: moved, base: base() });
  assert.equal(clash.text, null);
  assert.ok(clash.problems.some((p) => p.includes('UCrGameInstance::ServerSessionName')));
});

test('the order of the reports does not change the result', () => {
  const a = fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: base() });
  const rev = (xs) => [...xs].reverse();
  const b = fieldRows(header(), { cl: 130000, keys: unionKeys([parseKeys(KEYS.split('\n').reverse().join('\n'))]), next: rev(next()), base: rev(base()) });
  assert.equal(b.text, a.text);
});

test('reflected keys without a reference report, and a CL not in the table, are refused', () => {
  const out = fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: null });
  assert.equal(out.text, null);
  assert.ok(out.problems.some((p) => p.includes('--base')));
  assert.throws(() => fieldRows(header(), { cl: 140000, keys: keys(), next: next(), base: base() }), /not in the build table/);
});

test('the command line writes the header and the report, and logs no member names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fieldrows-'));
  const w = (name, doc) => { writeFileSync(join(dir, name), typeof doc === 'string' ? doc : JSON.stringify(doc)); return join(dir, name); };
  const h = w('v.h', header());
  const run = spawnSync(process.execPath, [TOOL, 'write', h, '--cl', '130000', '--next', w('n.json', { keys: next() }), '--base', w('b.json', { keys: base() }),
    '--keys', w('k.txt', KEYS), '--report', join(dir, 'r.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /4 rows added, 1 absent \(UCrOld::Removed\)/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')).added, 4);
  assert.equal(row(readFileSync(h, 'utf8'), 'ACrCrafter::CraftComponent').offset, 0x6e0);
  const refused = spawnSync(process.execPath, [TOOL, 'write', h, '--cl', '130000', '--next', w('n2.json', { keys: [gone('UCrGameInstance::ServerSessionName')] }), '--keys', w('k2.txt', 'native UCrGameInstance::ServerSessionName\n')], { encoding: 'utf8', windowsHide: true });
  assert.equal(refused.status, 3);
});
