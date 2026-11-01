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
import { fieldRows, keysFromCheck } from './field-rows.mjs';

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
field UCrOld::Removed
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

test('a reflected key that only the reference build resolves gets an absent row, not a guess', () => {
  const out = fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: base() });
  assert.deepEqual(out.absent.map((p) => p.key), ['UCrOld::Removed']);
  assert.equal(row(out.text, 'UCrOld::Removed'), undefined);
  assert.deepEqual(parse(out.text).absentFields, [{ key: 'UCrOld::Removed', cl: 130000 }]);
  assert.ok(out.covered.includes('UCrOld') && out.covered.includes('ACrCrafter'));
  assert.ok(!out.covered.includes('UCrSomething'), 'nothing of it moved');
});

test('a native key the new build does not have gets an absent row; a required one is refused', () => {
  const n = next().map((e) => (e.key === 'UCrGameInstance::ServerSessionName' ? { key: e.key, result: 'NOMEMBER' } : e));
  const out = fieldRows(header(), { cl: 130000, keys: keys(), next: n, base: base() });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.absent.map((p) => p.key), ['UCrGameInstance::ServerSessionName', 'UCrOld::Removed']);
  assert.equal(row(out.text, 'UCrGameInstance::ServerSessionName'), undefined);
  const req = unionKeys([parseKeys(KEYS.replace('0x290 0x10 0x00', '0x290 0x10 0x00 required').replace('field UCrOld::Removed', 'field UCrOld::Removed required'))]);
  const held = fieldRows(header(), { cl: 130000, keys: req, next: n, base: base() });
  assert.equal(held.text, null);
  assert.ok(held.problems.some((p) => p.startsWith('native UCrGameInstance::ServerSessionName') && p.includes('required')));
  assert.ok(held.problems.some((p) => p.startsWith('field UCrOld::Removed') && p.includes('required')));
});

test('the client check key list: native-keys.txt lines with built values and required, plus the plain layout keys', () => {
  const k = keysFromCheck(
    'P UCrGameInstance::ServerSessionName\nQ UCrGameInstance::ServerSessionName required\nP FTransform::Translation 0x20 0x18 0x00 a.cpp:x~@,\n',
    'FTransform::Translation\nUCrGameInstance::ServerSessionName\nACrCrafter::CraftComponent\nACrCrafter\n');
  assert.deepEqual([...k.native.keys()].sort(), ['FTransform::Translation', 'UCrGameInstance::ServerSessionName']);
  assert.equal(k.native.get('FTransform::Translation').size, 0x18);
  assert.ok(k.requiredFields.has('UCrGameInstance::ServerSessionName'));
  assert.deepEqual([...k.fields].sort(), ['ACrCrafter', 'ACrCrafter::CraftComponent']);
  assert.throws(() => keysFromCheck('P FTransform::Translation 0x20 0x18 0x00\nQ FTransform::Translation 0x20 0x20 0x00\n', ''), /two different built values/);
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
