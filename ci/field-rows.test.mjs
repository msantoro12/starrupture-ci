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
import { addBuild, emit, exportFeed, parse, parseFeed, parseKeys, unionKeys } from './version-map.mjs';
import { fieldRows, keysFromCheck, parseUses, LOADER_FIELD_KEYS } from './field-rows.mjs';

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

test('the loader field keys get a row on a new CL even when they did not move; other unmoved keys do not', () => {
  const k = unionKeys([parseKeys(KEYS + 'field UWorld::GameState\nfield UWorld::LineBatchers\nfield UWorld::NetDriver\n')]);
  const same = [ent('UWorld::GameState', 0x1b0, 8), ent('UWorld::LineBatchers', 0xf0, 0x20), ent('UWorld::NetDriver', 0x38, 8)];
  const out = fieldRows(header(), { cl: 130000, keys: k, next: [...next(), ...same], base: [...base(), ...same] });
  assert.deepEqual(out.problems, []);
  assert.deepEqual([...LOADER_FIELD_KEYS].sort(), ['ACrCrafter::CraftComponent', 'UWorld::GameState', 'UWorld::LineBatchers', 'UWorld::NetDriver']);
  for (const key of LOADER_FIELD_KEYS) assert.ok(row(out.text, key), `${key} has a row`);
  assert.equal(row(out.text, 'UWorld::LineBatchers').offset, 0xf0);
  assert.equal(row(out.text, 'UWorld::LineBatchers').size, 0x20);
  assert.equal(row(out.text, 'UCrSomething::bFlag'), undefined, 'a plugin key that did not move still gets none');
  assert.equal(out.added, 7);
  const twice = fieldRows(out.text, { cl: 130000, keys: k, next: [...next(), ...same], base: [...base(), ...same] });
  assert.equal(twice.added, 0);
  assert.deepEqual(twice.problems, []);
});

test('a loader field key that resolves on neither build is refused', () => {
  const k = unionKeys([parseKeys(KEYS + 'field UWorld::NetDriver\n')]);
  const out = fieldRows(header(), { cl: 130000, keys: k, next: [...next(), gone('UWorld::NetDriver')], base: [...base(), gone('UWorld::NetDriver')] });
  assert.equal(out.text, null);
  assert.match(out.problems.join('\n'), /UWorld::NetDriver: the loader reads it/);
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

test('a class whose size changed and is read live (SR_SIZE) is a note; a check beside it still degrades, a compiled use beside it is still refused', () => {
  const k = unionKeys([parseKeys(KEYS + 'field ACrCrafter\n')]);
  const b = [...base(), ent('ACrCrafter', null, 0x70)];
  const n = [...next(), ent('ACrCrafter', null, 0x78)];
  const live = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('P key ACrCrafter\nP size ACrCrafter live\n') });
  assert.deepEqual(live.problems, []);
  assert.equal(live.degraded.P, undefined, 'a live read is not turned off');
  assert.ok(live.notes.some((x) => x === 'class ACrCrafter: its size changed (0x70 -> 0x78); P reads its size live from the running game'));
  assert.ok(live.covered.includes('ACrCrafter'));
  const mixed = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('P size ACrCrafter live\nQ size ACrCrafter check\n') });
  assert.deepEqual(mixed.problems, []);
  assert.deepEqual(mixed.degraded.Q.map((d) => [d.key, d.severity]), [['ACrCrafter', 'high']]);
  assert.equal(mixed.degraded.P, undefined);
  const compiled = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('P size ACrCrafter live\nQ size ACrCrafter compiled\n') });
  assert.equal(compiled.text, null);
  assert.ok(compiled.problems.some((p) => p.includes('and Q uses its compiled size with no SR_SIZE_CHECK')));
  const same = fieldRows(header(), { cl: 130000, keys: k, next: [...next(), ent('ACrCrafter', null, 0x70)], base: b, uses: parseUses('P size ACrCrafter live\n') });
  assert.deepEqual(same.problems, []);
});

test('parseUses: live is a size use; one component using a class several ways keeps check over compiled over live', () => {
  const u = parseUses('P size X live\nP size X compiled\nP size X live\nQ size X check\nQ size X live\nR size X live\n');
  assert.deepEqual([...u.size.get('X')], [['P', 'compiled'], ['Q', 'check'], ['R', 'live']]);
  assert.throws(() => parseUses('P size X sometimes\n'), /check\|compiled\|live/);
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

test('a native key missing from the report: absent when only optional plugins ask, refused otherwise', () => {
  const n = next().filter((e) => e.key !== 'UCrGameInstance::ServerSessionName');
  const req = fieldRows(header(), { cl: 130000, keys: keys(), next: n, base: base() });
  assert.equal(req.text, null);
  assert.ok(req.problems.some((p) => p.includes('has no entry')));
  const opt = unionKeys([parseKeys(KEYS.replace('0x290 0x10 0x00', '0x290 0x10 0x00 optional'))]);
  const out = fieldRows(header(), { cl: 130000, keys: opt, next: n, base: base() });
  assert.deepEqual(out.problems, []);
  assert.ok(out.absent.some((a) => a.key === 'UCrGameInstance::ServerSessionName' && a.severity === 'low'));
  assert.ok(row(out.text, 'UCrEnviroWaveTimerSubsystem::bPause'), 'the other rows are still written');
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

test('with no reference layout and a reason, the refusal names the reason', () => {
  const reason = 'no stored layout for CL-127004 (release vmap-layouts has no layout-CL-127004.json)';
  const out = fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: null, baseMissing: reason });
  assert.equal(out.text, null);
  assert.deepEqual(out.problems, [`no reference layout to find what moved: ${reason}`]);
  // A reference that exists wins over the reason, and keys that need no reference are not refused for lack of one.
  assert.deepEqual(fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: base(), baseMissing: reason }).problems, []);
  const nativeOnly = unionKeys([parseKeys('native UCrGameInstance::ServerSessionName 0x290 0x10 0x00\n')]);
  assert.deepEqual(fieldRows(header(), { cl: 130000, keys: nativeOnly, next: next(), base: null, baseMissing: reason }).problems, []);
});

test('a run with a stored reference adds rows for the new CL only and leaves every older row as it was', () => {
  const before = parse(header());
  const out = fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: base(), baseMissing: null });
  assert.deepEqual(out.problems, []);
  const after = parse(out.text);
  const older = (m) => ({ fields: m.fields.filter((r) => r.cl !== 130000), functions: m.functions, builds: m.builds });
  assert.deepEqual(older(after), older(before));
  assert.equal(after.fields.filter((r) => r.cl === 130000).length, out.added);
  assert.ok(out.added > 0);
});

test('the command line takes --base-missing and refuses with the reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fieldrows-'));
  const w = (name, doc) => { writeFileSync(join(dir, name), typeof doc === 'string' ? doc : JSON.stringify(doc)); return join(dir, name); };
  const h = w('v.h', header());
  const run = spawnSync(process.execPath, [TOOL, 'write', h, '--cl', '130000', '--next', w('n.json', { keys: next() }), '--base-missing', 'nothing stored',
    '--keys', w('k.txt', KEYS), '--report', join(dir, 'r.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 3);
  assert.match(run.stderr, /refused: no reference layout to find what moved: nothing stored/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')).written, false);
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

// ---- class-key rows: a struct's own size, one per build ---------------------

test('a class-key row for every requested size, with the size unchanged: offset 0, the new build\'s size, mask 0, on every run', () => {
  const k = unionKeys([parseKeys(KEYS + 'field ACrCrafter\n')]);
  const b = [...base(), ent('ACrCrafter', null, 0x70)];
  const n = [...next(), ent('ACrCrafter', null, 0x70)];
  for (const how of ['check', 'live', 'compiled']) {
    const out = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses(`P key ACrCrafter\nP size ACrCrafter ${how}\n`) });
    assert.deepEqual(out.problems, []);
    assert.deepEqual(row(out.text, 'ACrCrafter'), { key: 'ACrCrafter', cl: 130000, member: null, offset: 0, size: 0x70, mask: 0 }, how);
    assert.ok(out.rows.includes('ACrCrafter'));
  }
  const unused = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('P key ACrCrafter\nP key ACrCrafter::CraftComponent\n') });
  assert.equal(row(unused.text, 'ACrCrafter'), undefined, 'a size nobody requests gets no row');
  const noUses = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b });
  assert.equal(row(noUses.text, 'ACrCrafter'), undefined, 'without a uses file nothing says which sizes are requested');
});

test('a class-key row for a changed size carries the new size; the note, degraded and refused outcomes stay', () => {
  const k = unionKeys([parseKeys(KEYS + 'field ACrCrafter\n')]);
  const b = [...base(), ent('ACrCrafter', null, 0x70)];
  const n = [...next(), ent('ACrCrafter', null, 0x78)];
  const live = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('P size ACrCrafter live\n') });
  assert.equal(row(live.text, 'ACrCrafter').size, 0x78);
  assert.ok(live.notes.some((x) => x.startsWith('class ACrCrafter: its size changed (0x70 -> 0x78); P reads')));
  assert.equal(live.degraded.P, undefined);
  const checked = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('P size ACrCrafter check\n') });
  assert.equal(row(checked.text, 'ACrCrafter').size, 0x78);
  assert.deepEqual(checked.degraded.P.map((d) => [d.key, d.severity]), [['ACrCrafter', 'high']]);
  const compiled = fieldRows(header(), { cl: 130000, keys: k, next: n, base: b, uses: parseUses('P size ACrCrafter compiled\n') });
  assert.equal(compiled.text, null, 'a compiled-size use is still refused, and no row ships');
});

test('a size row comes from the new build\'s layout report, not the reference\'s; a class the build does not resolve gets none', () => {
  const k = unionKeys([parseKeys(KEYS + 'field ACrCrafter\n')]);
  const uses = parseUses('P size ACrCrafter live\n');
  const b = [...base(), ent('ACrCrafter', null, 0x70)];
  const out = fieldRows(header(), { cl: 130000, keys: k, next: [...next(), ent('ACrCrafter', null, 0x90)], base: b, uses });
  assert.equal(row(out.text, 'ACrCrafter').size, 0x90);
  const none = fieldRows(header(), { cl: 130000, keys: k, next: [...next(), gone('ACrCrafter')], base: [...base(), gone('ACrCrafter')], uses });
  assert.deepEqual(none.problems, []);
  assert.equal(row(none.text, 'ACrCrafter'), undefined);
  assert.ok(none.notes.some((x) => x === 'class ACrCrafter: no size row, the new build reports MISSING'));
  // A size use of a class the report has no entry for is a broken input, not a skipped row.
  const missing = fieldRows(header(), { cl: 130000, keys: keys(), next: next(), base: base(), uses });
  assert.equal(missing.text, null);
  assert.ok(missing.problems.some((p) => p.startsWith('class ACrCrafter: a component requests its size, and the new build\'s report has no entry')));
});

test('a class-key row goes through the same add-field rule: a second run adds nothing, a different earlier row is refused', () => {
  const k = unionKeys([parseKeys(KEYS + 'field ACrCrafter\n')]);
  const uses = parseUses('P size ACrCrafter live\n');
  const b = [...base(), ent('ACrCrafter', null, 0x70)];
  const once = fieldRows(header(), { cl: 130000, keys: k, next: [...next(), ent('ACrCrafter', null, 0x70)], base: b, uses });
  const twice = fieldRows(once.text, { cl: 130000, keys: k, next: [...next(), ent('ACrCrafter', null, 0x70)], base: b, uses });
  assert.equal(twice.text, once.text);
  const clash = fieldRows(once.text, { cl: 130000, keys: k, next: [...next(), ent('ACrCrafter', null, 0x78)], base: b, uses });
  assert.equal(clash.text, null);
  assert.ok(clash.problems.some((p) => p.includes('ACrCrafter')));
});

test('the header and the feed carry a class-key row like a member row, and the feed parses back', () => {
  const k = unionKeys([parseKeys(KEYS + 'field ACrCrafter\n')]);
  const b = [...base(), ent('ACrCrafter', null, 0x70)];
  const out = fieldRows(header(), { cl: 130000, keys: k, next: [...next(), ent('ACrCrafter', null, 0x78)], base: b, uses: parseUses('P size ACrCrafter live\n') });
  assert.match(out.text, /^\t\/\/ ACrCrafter\n\t\{ 130000, 0x0, 0x78, 0x00, nullptr \},$/m);
  const feed = exportFeed(parse(out.text));
  assert.match(feed, /^field\tACrCrafter\t130000\t0x0\t0x78\t0x00\t-$/m);
  assert.deepEqual(parseFeed(feed).fields.find((r) => r.key === 'ACrCrafter' && r.cl === 130000), { key: 'ACrCrafter', cl: 130000, member: null, offset: 0, size: 0x78, mask: 0 });
});

test('a native-keys size line (<plugin> <Class> [size] [optional]) is a class-key row on every build, from the PDB size', () => {
  const lines = 'P FMassQuery size\nQ FMassQuery\nP FOptional size optional\n';
  const k = keysFromCheck(lines, 'FMassQuery\nFOptional\nACrCrafter::CraftComponent\n');
  assert.deepEqual([...k.native.keys()].sort(), ['FMassQuery', 'FOptional']);
  assert.deepEqual(k.owners.get('FMassQuery'), ['P', 'Q']);
  assert.deepEqual([...k.fields], ['ACrCrafter::CraftComponent'], 'a size line is not also a reflected key');
  assert.ok(k.optionalFields.has('FOptional') && !k.optionalFields.has('FMassQuery'));
  const rep = () => [ent('FMassQuery', null, 0x350), ent('FOptional', null, 8), ent('ACrCrafter::CraftComponent', 0x6e0, 8)];
  // The size is the same on both builds, and still gets its own row on the new one.
  const out = fieldRows(header(), { cl: 130000, keys: k, next: rep(), base: rep() });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(row(out.text, 'FMassQuery'), { key: 'FMassQuery', cl: 130000, member: null, offset: 0, size: 0x350, mask: 0 });
  assert.equal(row(out.text, 'FOptional').size, 8);
  assert.ok(out.covered.includes('FMassQuery'));
  // Gone on the new build: an absent row, high for a required line, low for an optional one.
  const goneNext = [{ key: 'FMassQuery', result: 'NOTYPE' }, { key: 'FOptional', result: 'NOTYPE' }, ent('ACrCrafter::CraftComponent', 0x6e0, 8)];
  const absent = fieldRows(header(), { cl: 130000, keys: k, next: goneNext, base: rep() });
  assert.deepEqual(absent.problems, []);
  assert.deepEqual(absent.absent.map((a) => [a.key, a.severity]), [['FMassQuery', 'high'], ['FOptional', 'low']]);
  // Not found for any other reason: refused, an unverified row never ships.
  const ambiguous = fieldRows(header(), { cl: 130000, keys: k, next: [{ key: 'FMassQuery', result: 'AMBIGUOUS' }, ent('FOptional', null, 8), ent('ACrCrafter::CraftComponent', 0x6e0, 8)], base: rep() });
  assert.equal(ambiguous.text, null);
  assert.ok(ambiguous.problems.some((p) => p.includes('FMassQuery') && p.includes('AMBIGUOUS')));
});

test('the command line writes class-key rows from --uses and from a native-keys size line, and logs only keys and numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fieldrows-size-'));
  const w = (name, doc) => { writeFileSync(join(dir, name), typeof doc === 'string' ? doc : JSON.stringify(doc)); return join(dir, name); };
  const h = w('v.h', header());
  const rep = [ent('ACrCrafter', null, 0x78), ent('FMassQuery', null, 0x350)];
  const run = spawnSync(process.execPath, [TOOL, 'write', h, '--cl', '130000', '--next', w('n.json', { keys: rep }), '--base', w('b.json', { keys: [ent('ACrCrafter', null, 0x70), ent('FMassQuery', null, 0x350)] }),
    '--native-keys', w('nk.txt', 'P FMassQuery size\n'), '--layout-keys', w('lk.txt', 'ACrCrafter\nFMassQuery\n'), '--uses', w('u.txt', 'P key ACrCrafter\nP size ACrCrafter live\n'),
    '--report', join(dir, 'r.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /2 rows added/);
  const text = readFileSync(h, 'utf8');
  assert.deepEqual([row(text, 'ACrCrafter').size, row(text, 'FMassQuery').size, row(text, 'FMassQuery').offset], [0x78, 0x350, 0]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')).rows, ['ACrCrafter', 'FMassQuery']);
});

// From run 42412572050 (CL-129402): MiniMap's key source (component MiniMap@ci/hosted-build) compiles the
// size of two classes whose size changed on the build.
const MM = 'MiniMap@ci/hosted-build';
const MM_TAG = 'msantoro12/StarRupture-Plugin-MiniMap@ci/hosted-build';
const MM_SHA = 'c0ffee0123456789abcdef0123456789abcdef01';
const MM_WHO = `key source ${MM_TAG} (${MM_SHA.slice(0, 12)}, checked the branch, not an installed DLL)`;
const SOURCES = new Map([[MM, { tag: MM_TAG, commit: MM_SHA }]]);
const RESIZED = `size ACrGameStateBase compiled\n`;
const resizedKeys = () => unionKeys([parseKeys('field ACrGameStateBase\nfield UCrEnviroWaveVisualsWorldSubsystem\n')]);
const resizedBase = () => [ent('ACrGameStateBase', null, 0xbc0), ent('UCrEnviroWaveVisualsWorldSubsystem', null, 0x1f0)];
const resizedNext = () => [ent('ACrGameStateBase', null, 0xc08), ent('UCrEnviroWaveVisualsWorldSubsystem', null, 0x208)];

test('key source: a compiled use of a changed class size is a note and an alert, the class-key size row is still written', () => {
  const uses = parseUses(`${MM} ${RESIZED}${MM} size UCrEnviroWaveVisualsWorldSubsystem compiled\n`);
  const out = fieldRows(header(), { cl: 130000, keys: resizedKeys(), next: resizedNext(), base: resizedBase(), uses, sources: SOURCES });
  assert.deepEqual(out.problems, []);
  assert.notEqual(out.text, null);
  assert.equal(row(out.text, 'ACrGameStateBase').size, 0xc08);
  assert.equal(row(out.text, 'UCrEnviroWaveVisualsWorldSubsystem').size, 0x208);
  assert.deepEqual(out.alerts, [
    `${MM_WHO}: compiles the size of ACrGameStateBase, which changed on CL-130000; that build needs SR_SIZE_CHECK or live`,
    `${MM_WHO}: compiles the size of UCrEnviroWaveVisualsWorldSubsystem, which changed on CL-130000; that build needs SR_SIZE_CHECK or live`,
  ]);
  assert.ok(out.notes.includes(`class ACrGameStateBase: its size changed (0xBC0 -> 0xC08); key source ${MM} compiles its size`));
  assert.ok(!out.notes.some((n) => n.includes('no plugin depends on its whole size')));
  assert.deepEqual(out.degraded, {}, 'the key source is not degraded: it is not a plan plugin');
});

test('key source: a plan plugin that compiles the size beside a key source is still refused, naming only the plan plugin', () => {
  const uses = parseUses(`${MM} ${RESIZED}MiniMap ${RESIZED}`);
  const out = fieldRows(header(), { cl: 130000, keys: resizedKeys(), next: resizedNext(), base: resizedBase(), uses });
  assert.equal(out.text, null);
  assert.equal(out.problems.length, 1);
  assert.match(out.problems[0], /^class ACrGameStateBase: its size changed \(0xBC0 -> 0xC08\), and MiniMap uses its compiled size with no SR_SIZE_CHECK/);
  assert.ok(!out.problems[0].includes(MM));
});

test('key source: a check or a live read from a key source is not an alert; the report carries the alerts from the command line', () => {
  const live = fieldRows(header(), { cl: 130000, keys: resizedKeys(), next: resizedNext(), base: resizedBase(), uses: parseUses(`${MM} size ACrGameStateBase live\n${MM} size UCrEnviroWaveVisualsWorldSubsystem check\n`) });
  assert.deepEqual(live.alerts, []);
  assert.deepEqual(live.degraded[MM].map((d) => d.key), ['UCrEnviroWaveVisualsWorldSubsystem']);
  const dir = mkdtempSync(join(tmpdir(), 'fr-ks-'));
  const w = (n, text) => writeFileSync(join(dir, n), text);
  w('h.h', header());
  w('native.txt', '');
  w('keys.txt', 'ACrGameStateBase\nUCrEnviroWaveVisualsWorldSubsystem\n');
  w('uses.txt', `${MM} ${RESIZED}`);
  w('keysrc.json', JSON.stringify({ sources: [{ name: 'MiniMap', tag: MM_TAG, sha: MM_SHA, status: 'ok' }, { name: 'Waila', tag: 'msantoro12/StarRupture-Plugin-WAILA@gss/plugin-work', sha: 'a'.repeat(40), status: 'ok' }] }));
  const layout = (a, b) => JSON.stringify({ keys: [ent('ACrGameStateBase', null, a), ent('UCrEnviroWaveVisualsWorldSubsystem', null, b)] });
  w('next.json', layout(0xc08, 0x208));
  w('base.json', layout(0xbc0, 0x1f0));
  const run = spawnSync(process.execPath, [TOOL, 'write', join(dir, 'h.h'), '--cl', '130000', '--next', join(dir, 'next.json'), '--base', join(dir, 'base.json'),
    '--native-keys', join(dir, 'native.txt'), '--layout-keys', join(dir, 'keys.txt'), '--uses', join(dir, 'uses.txt'), '--sources', join(dir, 'keysrc.json'), '--report', join(dir, 'r.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')).alerts, [`${MM_WHO}: compiles the size of ACrGameStateBase, which changed on CL-130000; that build needs SR_SIZE_CHECK or live`]);
});

// ---- MiniMap's building-picture members, BetterDrone's map matrix and Compass's engine reads ----
//
// The report is made up from what the PDBs of both builds were read to hold (the same offsets on the
// test build and on public; bMapMenuOpen's is invented). The keys come from the real ci/native-keys.txt.

const M1 = [
  ['MiniMap', 'UWorld::WorldType', 0x18a, 1, 0], ['MiniMap', 'UWorld::bIsWorldInitialized', 0x18b, 1, 0x40],
  ['MiniMap', 'UWorld::bActorsInitialized', 0x18c, 1, 0x80], ['MiniMap', 'UWorld::bIsTearingDown', 0x18d, 1, 0x20],
  ['MiniMap', 'UWorld::bBegunPlay', 0x18d, 1, 0x01], ['MiniMap', 'UWorld::bHasEverBeenInitialized', 0x18f, 1, 0x02],
  ['MiniMap', 'UEngine::WorldList', 0x11c8, 0x10, 0], ['MiniMap', 'FWorldContext::ThisCurrentWorld', 0x2c0, 8, 0],
  ['MiniMap', 'UTextureRenderTarget::bNeedsTwoCopies', 0x144, 1, 0x01],
  ['MiniMap', 'UCrElectricityGraphSubsystem::EntityManager', 0x290, 0x10, 0], ['MiniMap', 'UCrEntityGridSubsystem::EntityManager', 0xf0, 0x10, 0],
  ['MiniMap', 'UTickableWorldSubsystem::bInitialized', 0x38, 1, 0xff],
  ['MiniMap', 'UWorld::Scene', 0x258, 8, 0], ['MiniMap', 'UWorld::SubsystemCollection', 0x9f0, 0xc0, 0],
  ['MiniMap', 'FSubsystemCollectionBase::SubsystemMap', 0x8, 0x50, 0], ['MiniMap', 'FSubsystemCollectionBase::SubsystemArrayMap', 0x58, 0x50, 0],
  ['MiniMap', 'FSubsystemCollectionBase::Outer', 0xb0, 8, 0], ['MiniMap', 'FSubsystemCollectionBase::bPopulating', 0xb8, 1, 0xff],
  ['MiniMap', 'FSubsystemCollectionBase::bIterating', 0xb9, 1, 0xff], ['MiniMap', 'USubsystem::InternalOwningSubsystem', 0x28, 8, 0],
  ['MiniMap', 'UStruct::SuperStruct', 0x40, 8, 0], ['MiniMap', 'ULevel::Actors', 0xa0, 0x10, 0],
  ['MiniMap', 'FStreamingLevelsToConsider::LevelsToProcess', 0x10, 0x10, 0], ['MiniMap', 'FStreamingLevelsToConsider::StreamingLevelsBeingConsidered', 0x20, 4, 0],
  ['MiniMap', 'UActorComponent::OwnerPrivate', 0xa0, 8, 0], ['MiniMap', 'UActorComponent::WorldPrivate', 0xa8, 8, 0],
  ['MiniMap', 'UActorComponent::bRegistered', 0x94, 1, 0x01], ['MiniMap', 'UActorComponent::bRenderStateCreated', 0x94, 1, 0x02],
  ['MiniMap', 'UActorComponent::bHasBeenInitialized', 0x97, 1, 0x08], ['MiniMap', 'UActorComponent::bHasBegunPlay', 0x97, 1, 0x20],
  ['MiniMap', 'ULightComponent::SceneProxy', 0x340, 8, 0], ['MiniMap', 'ULightComponent::bAddedToSceneVisible', 0x3a0, 1, 0x01],
  ['MiniMap', 'AActor::bHasFinishedSpawning', 0x5c, 1, 0x01], ['MiniMap', 'AActor::bActorInitialized', 0x5c, 1, 0x02],
  ['MiniMap', 'AActor::ActorHasBegunPlay', null],
  ['BetterDrone', 'UCrUW_MapMenuMapArea::MapAreaMatrix', 0x500, 0x40, 0],
  ['Compass', 'UObject::ObjectFlags', 0x8, 4, 0], ['Compass', 'UObject::InternalIndex', 0xc, 4, 0], ['Compass', 'FUObjectItem::Flags', 0x8, 4, 0],
  ['Compass', 'UStreamableRenderAsset::NeverStream', 0xc0, 1, 0x01], ['Compass', 'UTexture::bAsyncResourceReleaseHasBeenStarted', 0x10c, 1, 0x04],
  ['Compass', 'ACrPlayerControllerBase::bMapMenuOpen', 0x7a1, 1, 0x01],
];
const m1Native = () => {
  const lines = readFileSync(join(here, 'native-keys.txt'), 'utf8').split(/\r?\n/).filter((l) => {
    const m = /^(\S+)\s+(\S+::\S+)/.exec(l);
    return m && M1.some(([p, k]) => p === m[1] && k === m[2]);
  });
  return keysFromCheck(lines.join('\n') + '\n', '');
};
const m1Report = () => M1.map(([, key, off, size, mask]) => (off === null ? { key, result: 'BITFIELD' } : ent(key, off, size, mask)));

test('M1: ci/native-keys.txt lists the 35 MiniMap members, BetterDrone\'s map matrix and Compass\'s reads; the first two are optional', () => {
  const keys = m1Native();
  assert.equal(M1.filter(([p]) => p === 'MiniMap').length, 35);
  assert.equal(keys.native.size, M1.length, 'every key of the table has a line');
  for (const [p, key] of M1.filter(([p]) => p === 'MiniMap' || p === 'BetterDrone')) {
    assert.ok(keys.optionalFields.has(key), `${p} ${key} is optional`);
    assert.deepEqual(keys.owners.get(key), [p]);
  }
});

test('M1: a map run writes a row for every one of them on the test build and on a public CL that is its own reference', () => {
  for (const cl of [130000, 127004]) {
    const out = fieldRows(header(), { cl, keys: m1Native(), next: m1Report(), base: null });
    assert.deepEqual(out.problems, [], `CL-${cl}`);
    const rows = parse(out.text).fields.filter((r) => r.cl === cl);
    for (const [p, key, off, size, mask] of M1.filter(([, , off]) => off !== null)) {
      const r = rows.find((x) => x.key === key);
      assert.ok(r, `${p} ${key} has a row on CL-${cl}`);
      assert.deepEqual([r.offset, r.size, r.mask], [off, size, mask], key);
    }
    assert.equal(out.added, M1.length - 1);
  }
});

test('M1: a member the PDB cannot describe (a two-bit enum) is an absent row that names the key and the answer, not a silent drop or a refusal', () => {
  const out = fieldRows(header(), { cl: 130000, keys: m1Native(), next: m1Report(), base: null });
  assert.deepEqual(out.problems, []);
  assert.equal(parse(out.text).fields.filter((r) => r.cl === 130000 && r.key === 'AActor::ActorHasBegunPlay').length, 0);
  assert.deepEqual(out.absent, [{ key: 'AActor::ActorHasBegunPlay', why: 'could not be read from the PDB (BITFIELD)', severity: 'low', owners: ['MiniMap'] }]);
  assert.deepEqual(out.degraded, { MiniMap: [{ key: 'AActor::ActorHasBegunPlay', severity: 'low', why: 'could not be read from the PDB (BITFIELD) (optional)' }] });
  assert.ok(parse(out.text).absentFields.some((r) => r.cl === 130000 && r.key === 'AActor::ActorHasBegunPlay'));
  // AMBIGUOUS is the same for an optional line; a plugin that requires the key still holds the map.
  const amb = m1Report().map((e) => (e.key === 'UWorld::Scene' ? { key: e.key, result: 'AMBIGUOUS' } : e));
  const ambOut = fieldRows(header(), { cl: 130000, keys: m1Native(), next: amb, base: null });
  assert.deepEqual(ambOut.problems, []);
  assert.ok(ambOut.absent.some((a) => a.key === 'UWorld::Scene' && a.why.includes('AMBIGUOUS')));
  const strict = keysFromCheck('MiniMap AActor::ActorHasBegunPlay optional\nOther AActor::ActorHasBegunPlay\n', '');
  const held = fieldRows(header(), { cl: 130000, keys: strict, next: [{ key: 'AActor::ActorHasBegunPlay', result: 'BITFIELD' }], base: null });
  assert.equal(held.text, null);
  assert.ok(held.problems.some((p) => p.includes('AActor::ActorHasBegunPlay') && p.includes('BITFIELD')));
});

test('M1: an optional native key the scanner was never asked for is named as such', () => {
  const out = fieldRows(header(), { cl: 130000, keys: m1Native(), next: m1Report().filter((e) => e.key !== 'ULevel::Actors'), base: null });
  assert.deepEqual(out.problems, []);
  assert.ok(out.absent.some((a) => a.key === 'ULevel::Actors' && a.why.includes('scanner was not asked')));
});

// ---- A loader line marked optional in native-keys.txt ----

const HEAP = 'FD3D12Resource::Heap';
const loaderKey = (lines) => keysFromCheck(lines, '');
const heapRun = (lines, result) => fieldRows(header(), { cl: 130000, keys: loaderKey(lines), next: [result], base: null });

test('a ModLoader optional native key that is NOMEMBER is an absent row and a low note, not a problem', () => {
  const out = heapRun(`ModLoader ${HEAP} optional\n`, { key: HEAP, result: 'NOMEMBER' });
  assert.deepEqual(out.problems, []);
  assert.ok(out.text, 'the header is still written');
  assert.deepEqual(out.absent, [{ key: HEAP, why: 'not on the new build (NOMEMBER)', severity: 'low', owners: ['ModLoader'] }]);
  assert.deepEqual(out.degraded, { ModLoader: [{ key: HEAP, severity: 'low', why: 'not on the new build (NOMEMBER) (optional)' }] });
  assert.ok(parse(out.text).absentFields.some((r) => r.cl === 130000 && r.key === HEAP));
  for (const result of ['NOTYPE', 'BITFIELD']) assert.deepEqual(heapRun(`ModLoader ${HEAP} optional\n`, { key: HEAP, result }).problems, [], result);
});

test('the same ModLoader key without optional still refuses', () => {
  const out = heapRun(`ModLoader ${HEAP}\n`, { key: HEAP, result: 'NOMEMBER' });
  assert.equal(out.text, null);
  assert.ok(out.problems.some((p) => p.includes(HEAP) && p.includes('the loader itself reads it')));
});

test('a ModLoader optional native key that resolves gets a field row', () => {
  const out = heapRun(`ModLoader ${HEAP} optional\n`, ent(HEAP, 0x30, 8, 0));
  assert.deepEqual(out.problems, []);
  const r = row(out.text, HEAP);
  assert.deepEqual([r.offset, r.size, r.mask], [0x30, 8, 0]);
});

test('a key the loader lists as optional and a plugin requires is still treated as the plugin\'s required key', () => {
  const lines = `ModLoader ${HEAP} optional\nP ${HEAP}\n`;
  // Gone on the new build: the required plugin is degraded at high severity, as for any required key.
  const gone = heapRun(lines, { key: HEAP, result: 'NOMEMBER' });
  assert.deepEqual(gone.problems, []);
  assert.equal(gone.absent[0].severity, 'high');
  assert.deepEqual(gone.absent[0].owners, ['ModLoader', 'P']);
  // Not readable, or not in the report: the required plugin holds the map.
  const unread = heapRun(lines, { key: HEAP, result: 'BITFIELD' });
  assert.equal(unread.text, null);
  assert.ok(unread.problems.some((p) => p.includes(HEAP) && p.includes('BITFIELD')));
  const unscanned = fieldRows(header(), { cl: 130000, keys: loaderKey(lines), next: [], base: null });
  assert.ok(unscanned.problems.some((p) => p.includes('has no entry')));
});

test('a ModLoader optional key the scanner was not asked for is an absent row, with or without a uses file', () => {
  const lines = `ModLoader ${HEAP} optional\n`;
  for (const uses of [null, parseUses(`ModLoader key ${HEAP}\n`)]) {
    const out = fieldRows(header(), { cl: 130000, keys: loaderKey(lines), next: [], base: null, uses });
    assert.deepEqual(out.problems, []);
    assert.ok(out.absent.some((a) => a.key === HEAP && a.severity === 'low' && a.why.includes('scanner was not asked')));
    const ok = fieldRows(header(), { cl: 130000, keys: loaderKey(lines), next: [ent(HEAP, 0x30, 8, 0)], base: null, uses });
    assert.deepEqual(ok.problems, []);
    assert.equal(row(ok.text, HEAP).offset, 0x30);
  }
});

test('a loader field key (LOADER_FIELD_KEYS) is still refused when missing, even with an optional ModLoader line', () => {
  const key = [...LOADER_FIELD_KEYS][0];
  const out = fieldRows(header(), { cl: 130000, keys: loaderKey(`ModLoader ${key} optional\n`), next: [{ key, result: 'NOMEMBER' }], base: null });
  assert.equal(out.text, null);
  assert.ok(out.problems.some((p) => p.includes(key) && p.includes('the loader itself reads it')));
});

test('ci/native-keys.txt lists the loader\'s two optional heap members', () => {
  const text = readFileSync(join(here, 'native-keys.txt'), 'utf8');
  const keys = keysFromCheck(text, '');
  for (const key of ['FD3D12Resource::Heap', 'FD3D12Heap::Heap']) {
    assert.deepEqual(keys.owners.get(key), ['ModLoader'], key);
    assert.ok(keys.optionalBy.get(key).has('ModLoader'), key);
    assert.ok(keys.optionalFields.has(key), key);
  }
});

test('a reflected key that only the new build resolves gets a row from the new values and a note; it holds nothing', () => {
  const k = unionKeys([parseKeys(KEYS + 'field UCrNew::Thing\nfield UCrNeither::Thing\n')]);
  const extra = (a, b) => [[...base(), a], [...next(), b]];
  const [bs, nx] = extra(gone('UCrNew::Thing'), ent('UCrNew::Thing', 0x48, 4));
  bs.push(gone('UCrNeither::Thing'));
  nx.push(gone('UCrNeither::Thing'));
  const out = fieldRows(header(), { cl: 130000, keys: k, next: nx, base: bs });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(row(out.text, 'UCrNew::Thing'), { key: 'UCrNew::Thing', cl: 130000, offset: 0x48, size: 4, mask: 0, member: null });
  assert.ok(out.notes.some((n) => n.startsWith('UCrNew::Thing: new on this build')));
  assert.equal(row(out.text, 'UCrNeither::Thing'), undefined, 'not OK on both builds: no row');
  assert.ok(out.notes.some((n) => n.startsWith('UCrNeither::Thing: resolves on neither build')));
  assert.equal(out.notes.filter((n) => n.startsWith('UCrNeither::Thing')).length, 1);
  assert.equal(out.added, 5);
});

test('a class key that only the new build resolves gets a note and no field row', () => {
  const k = unionKeys([parseKeys(KEYS + 'field UCrNewClass\n')]);
  const out = fieldRows(header(), { cl: 130000, keys: k, next: [...next(), ent('UCrNewClass', 0, 0x30)], base: [...base(), gone('UCrNewClass')] });
  assert.deepEqual(out.problems, []);
  assert.equal(row(out.text, 'UCrNewClass'), undefined);
  assert.ok(out.notes.some((n) => n.startsWith('UCrNewClass: new on this build')));
});
