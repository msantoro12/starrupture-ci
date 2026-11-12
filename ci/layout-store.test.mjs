import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { emit, exportFeed, parse } from './version-map.mjs';
import { renderHeader } from './layout-table.mjs';
import { PUBLISHED, SCHEMA, SDK_TABLES, assetName, buildRecord, main, readRecord, referenceFor, sameLayout } from './layout-store.mjs';

const HEADER = readFileSync(new URL('./fixtures/version-map/loader.h', import.meta.url), 'utf8');
// The fixture header: built for CL-127004, whose build row is public build 25646882.
const BUILT = { cl: 127004, buildid: '25646882', stamp: 1760600498, size: 171909120 };
const SHA = 'a'.repeat(64);

const entry = (key, offset) => ({ key, result: 'OK', offset, size: 8, boolMask: 0 });
const KEYS = [entry('ACrCrafter::CraftComponent', 1752), entry('AFoo::Bar', 16), entry('AFoo::Baz', 24), entry('UWorld::GameState', 0x120)];

const result = (over = {}) => ({
  download: { betaKey: 'public', installed: true, buildid: BUILT.buildid },
  checks: { exe: { cl: String(BUILT.cl), sha256: SHA.toUpperCase(), productVersion: '1.0.0.0-CL-127004' } },
  ...over,
});
const scanner = (over = {}) => ({ exe: { cl: BUILT.cl, imageStamp: BUILT.stamp, imageSize: BUILT.size, ...over } });
const layoutText = (keys = KEYS) => JSON.stringify({ keys });
const make = (over = {}) => buildRecord({ result: result(), scanner: scanner(), layoutText: layoutText(), run: 99, workflowSha: 'f'.repeat(40), at: '2026-11-11T00:00:00Z', ...over });

const BOT = { login: 'github-actions[bot]', type: 'Bot' };
const releaseFor = (text, over = {}) => ({ assets: [{ name: assetName(BUILT.cl), size: Buffer.byteLength(text), uploader: BOT, ...over }] });
const FIELDS = new Set(KEYS.map((k) => k.key));

function ref(over = {}) {
  const text = over.recordText !== undefined ? over.recordText : JSON.stringify(make(), null, 2) + '\n';
  return referenceFor({
    headerText: HEADER, recordText: text, release: over.release ?? releaseFor(text ?? ''), targetCl: BUILT.cl, targetSha256: SHA, fields: FIELDS, ...over.args,
  });
}
const refuses = (over, re) => assert.throws(() => ref(over), re);

// ---- record ------------------------------------------------------------------

test('record: an installed public build becomes a record keyed by its CL and exe', () => {
  const r = make();
  assert.equal(r.schema, SCHEMA);
  assert.equal(r.cl, 127004);
  assert.equal(r.buildid, '25646882');
  assert.equal(r.branch, 'public');
  assert.equal(r.exeSha256, SHA);
  assert.equal(r.imageStamp, BUILT.stamp);
  assert.equal(r.imageSize, BUILT.size);
  assert.deepEqual(r.keys.map((k) => k.key), ['ACrCrafter::CraftComponent', 'AFoo::Bar', 'AFoo::Baz', 'UWorld::GameState']);
});

test('record: refuses a build that is not an installed public one', () => {
  assert.throws(() => make({ result: result({ download: { betaKey: 'beta', installed: true, buildid: '1' } }) }), /only an installed public build/);
  assert.throws(() => make({ result: result({ download: { betaKey: 'public', installed: false, buildid: '1' } }) }), /only an installed public build/);
  assert.throws(() => make({ result: result({ download: { betaKey: 'public', installed: true, buildid: '' } }) }), /no Steam build id/);
});

test('record: refuses a missing or malformed exe hash, CL or image identity', () => {
  assert.throws(() => make({ result: result({ checks: { exe: { cl: '127004', sha256: 'abc' } } }) }), /no exe sha256/);
  assert.throws(() => make({ result: result({ checks: { exe: { cl: '', sha256: SHA } } }) }), /exe.cl/);
  assert.throws(() => make({ scanner: scanner({ cl: 128000 }) }), /measured CL-128000/);
  assert.throws(() => make({ scanner: { exe: undefined } }), /no exe section/);
  assert.throws(() => make({ scanner: scanner({ imageSize: 0 }) }), /imageSize/);
  assert.throws(() => make({ layoutText: layoutText([]) }), /no keys/);
  assert.throws(() => make({ layoutText: 'nope' }), /not JSON/);
});

const stored = (record, over = {}) => { const text = JSON.stringify(record); return { text, release: releaseFor(text, over) }; };

test('record: the same exe again adds keys and keeps the stored ones; another exe is refused', () => {
  const first = make();
  const more = make({ layoutText: layoutText([...KEYS, entry('AFoo::New', 40)]), existing: stored(first) });
  assert.deepEqual(more.keys.map((k) => k.key), ['ACrCrafter::CraftComponent', 'AFoo::Bar', 'AFoo::Baz', 'AFoo::New', 'UWorld::GameState']);
  const fewer = make({ layoutText: layoutText([KEYS[0]]), existing: stored(more) });
  assert.equal(fewer.keys.length, 5, 'a later run with fewer keys loses none');
  assert.throws(() => make({ result: result({ checks: { exe: { cl: '127004', sha256: 'b'.repeat(64) } } }), existing: stored(first) }), /another exe.*exeSha256/);
  assert.throws(() => make({ result: result({ download: { betaKey: 'public', installed: true, buildid: '1' } }), existing: stored(first) }), /another exe.*buildid/);
  assert.throws(() => make({ scanner: scanner({ imageStamp: 1 }), existing: stored(first) }), /another exe.*imageStamp/);
  assert.throws(() => make({ layoutText: layoutText([entry('AFoo::Bar', 99)]), existing: stored(first) }), /another result for AFoo::Bar/);
  assert.throws(() => make({ layoutText: layoutText([{ ...entry('AFoo::Bar', 16), size: 4 }]), existing: stored(first) }), /another result for AFoo::Bar/);
});

test('record: a stored asset an Actions job did not upload is not carried forward', () => {
  const first = make();
  assert.throws(() => make({ existing: stored(first, { uploader: { login: 'someone', type: 'User' } }) }), /uploaded by someone \(User\).*not trusted/);
  assert.throws(() => make({ existing: stored(first, { uploader: null }) }), /uploaded by unknown/);
  assert.throws(() => make({ existing: { text: JSON.stringify(first), release: { assets: [] } } }), /lists no layout-CL-127004.json/);
  assert.throws(() => make({ existing: stored(first, { size: 5 }) }), /not the asset the release lists/);
});

test('record: sameLayout tells a run that adds nothing from one that adds a key', () => {
  const first = make();
  assert.equal(sameLayout(readRecord(JSON.stringify(first)), make({ run: 100, at: '2026-12-01T00:00:00Z', existing: stored(first) })), true);
  assert.equal(sameLayout(readRecord(JSON.stringify(first)), make({ layoutText: layoutText([...KEYS, entry('AFoo::New', 40)]), existing: stored(first) })), false);
});

// ---- reference ---------------------------------------------------------------

test('reference: a record of the built CL, bound to the header build and uploaded by the Actions bot, is the base', () => {
  const out = ref();
  assert.equal(out.cl, 127004);
  assert.deepEqual(out.keys.map((k) => k.key), ['ACrCrafter::CraftComponent', 'AFoo::Bar', 'AFoo::Baz', 'UWorld::GameState']);
});

test('reference: accepts a record whose upload was long ago (nothing about the recorded run is looked up)', () => {
  const text = JSON.stringify({ ...make(), run: 1, workflowSha: '0'.repeat(40), at: '2020-01-01T00:00:00Z' });
  assert.equal(ref({ recordText: text, release: releaseFor(text) }).cl, 127004);
});

test('reference: refuses a release asset uploaded by anyone but the Actions bot', () => {
  const text = JSON.stringify(make());
  refuses({ recordText: text, release: releaseFor(text, { uploader: { login: 'someone', type: 'User' } }) }, /uploaded by someone \(User\).*not trusted/);
  refuses({ recordText: text, release: releaseFor(text, { uploader: { login: 'github-actions[bot]', type: 'User' } }) }, /not trusted/);
  refuses({ recordText: text, release: releaseFor(text, { uploader: { login: 'other[bot]', type: 'Bot' } }) }, /not trusted/);
  refuses({ recordText: text, release: releaseFor(text, { uploader: null }) }, /uploaded by unknown/);
});

test('reference: refuses a release that does not list the asset, or lists another size', () => {
  const text = JSON.stringify(make());
  refuses({ recordText: text, release: { assets: [] } }, /lists no layout-CL-127004.json/);
  refuses({ recordText: text, release: {} }, /lists no layout-CL-127004.json/);
  refuses({ recordText: text, release: releaseFor(text, { size: 5 }) }, /not the asset the release lists/);
});

test('reference: refuses when nothing is stored for the built CL', () => {
  refuses({ recordText: null, release: { assets: [] } }, /no stored layout for CL-127004.*has no layout-CL-127004.json/);
});

test('reference: says so when the asset is listed but could not be downloaded', () => {
  refuses({ recordText: null, release: releaseFor('x') }, /layout-CL-127004.json is listed on release vmap-layouts but could not be downloaded/);
});

test('reference: refuses a record for an older or a newer CL than the header was built for', () => {
  for (const cl of [126000, 128786]) {
    const text = JSON.stringify({ ...make(), cl });
    refuses({ recordText: text, release: releaseFor(text) }, new RegExp(`stored layout is for CL-${cl}, the header was built for CL-127004`));
  }
});

test('reference: refuses a record that is not the header build (build id, stamp, size)', () => {
  for (const [field, value, re] of [['buildid', '1', /Steam build id 25646882 in the table, 1 measured/], ['imageStamp', 5, /another image stamp or size/], ['imageSize', 7, /another image stamp or size/]]) {
    const text = JSON.stringify({ ...make(), [field]: value });
    refuses({ recordText: text, release: releaseFor(text) }, re);
  }
});

test('reference: for the same CL the exe sha256 must be the stored one', () => {
  refuses({ args: { targetSha256: 'c'.repeat(64) } }, /stored for the exe aaaaaaaaaaaa, the build scanned now has cccccccccccc/);
  refuses({ args: { targetSha256: undefined } }, /no sha256/);
  // A later CL has another exe by definition: the sha is not compared.
  assert.equal(ref({ args: { targetCl: 128786, targetSha256: 'c'.repeat(64) } }).cl, 127004);
});

// A record of KEYS and the first `stored` of `listed` keys Q::k0, Q::k1, ...; the reader gets all `listed` as the keys now listed.
const lacking = (listed, stored) => {
  const names = Array.from({ length: listed }, (_, i) => `Q::k${i}`);
  const text = JSON.stringify(make({ layoutText: layoutText([...KEYS, ...names.slice(0, stored).map((k) => entry(k, 8))]) }), null, 2) + '\n';
  return { recordText: text, release: releaseFor(text), args: { fields: new Set(names) } };
};

test('reference: a record that lacks a few reflected keys now listed is still the base, and lists them', () => {
  const one = ref({ args: { fields: new Set([...FIELDS, 'Z::a']) } });
  assert.deepEqual(one.missing, ['Z::a']);
  assert.equal(one.keys.length, 4);
  const ten = Array.from({ length: 10 }, (_, i) => `Y::k${i}`);
  const out = ref({ args: { fields: new Set([...FIELDS, ...ten]) } });
  assert.deepEqual(out.missing, [...ten].sort());
  assert.deepEqual(ref().missing, []);
});

test('reference: more than 10 missing keys, and more than 1 in 20 of those listed, refuses and names the first ones', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => `Y::k${i}`);
  refuses({ args: { fields: new Set([...FIELDS, ...eleven]) } }, /no entry for 11 reflected keys \(Y::k0, Y::k1, Y::k10, Y::k2, Y::k3, \+6 more\) now listed, more than the 10 always allowed and more than 1 in 20 of the 15 listed/);
});

test('reference: the cap is 5% of the listed keys, never below 10', () => {
  assert.equal(ref(lacking(300, 285)).missing.length, 15, '15 of 300 is exactly 5%');
  refuses(lacking(300, 284), /no entry for 16 reflected keys .* of the 300 listed/);
  assert.equal(ref(lacking(100, 90)).missing.length, 10, '10 of 100 is over 5% and still allowed');
  refuses(lacking(100, 89), /no entry for 11 reflected keys/);
  assert.equal(ref(lacking(2000, 1900)).missing.length, 100, '100 of 2000 is exactly 5%');
  refuses(lacking(2000, 1899), /no entry for 101 reflected keys/);
});

// ---- cross-check against the header's field rows ------------------------------

const hrow = (key, offset, size, mask = 0) => ({ key, cl: BUILT.cl, offset, size, mask, member: null });
// The fixture header with its CL-127004 field rows replaced by `rows`.
const headerWith = (rows) => {
  const map = parse(HEADER);
  map.fields = [...map.fields.filter((r) => r.cl !== BUILT.cl), ...rows];
  return emit(map);
};
const rec = (keys) => { const text = JSON.stringify(make({ layoutText: layoutText(keys) }), null, 2) + '\n'; return { recordText: text, release: releaseFor(text) }; };
const RECS = [entry('AFoo::Bar', 16), { key: 'UCrBig', result: 'OK', size: 0x40 }, { key: 'FTransform::Translation', result: 'OK', offset: 0x20, size: 0x20, boolMask: 0 },
  { key: 'UCrFlag::bOn', result: 'OK', offset: 0x565, size: 1, boolMask: 0x10 }];
const HROWS = [hrow('AFoo::Bar', 16, 8), hrow('UCrBig', 0, 0x40), hrow('FTransform::Translation', 0x20, 0x18), hrow('UCrFlag::bOn', 0x565, 1, 0x10)];
const cross = (rows, recs = RECS, over = {}) => ref({ ...rec(recs), args: { headerText: headerWith(rows), fields: new Set(), ...over } });
const swap = (key, patch) => RECS.map((k) => (k.key === key ? { ...k, ...patch } : k));

test('cross-check: equal data passes, the register size exception is honoured, a header key the record lacks is ignored', () => {
  assert.equal(cross(HROWS).cl, 127004);
  assert.equal(cross([...HROWS, hrow('AFoo::NotInRecord', 8, 8)]).cl, 127004);
});

test('cross-check: a wrong offset, size or mask refuses and names the key with both values', () => {
  assert.throws(() => cross(HROWS, swap('AFoo::Bar', { offset: 24 })), /disagrees.*1 of 4 keys.*AFoo::Bar: header 0x10\/0x8\/0x0, record 0x18\/0x8\/0x0/);
  assert.throws(() => cross(HROWS, swap('AFoo::Bar', { size: 4 })), /AFoo::Bar: header 0x10\/0x8\/0x0, record 0x10\/0x4\/0x0/);
  assert.throws(() => cross(HROWS, swap('UCrFlag::bOn', { boolMask: 0x20 })), /UCrFlag::bOn: header 0x565\/0x1\/0x10, record 0x565\/0x1\/0x20/);
  assert.throws(() => cross(HROWS, swap('UCrBig', { size: 0x48 })), /UCrBig: header 0x0\/0x40\/0x0, record 0x0\/0x48\/0x0/);
  assert.throws(() => cross(HROWS, swap('UCrBig', { result: 'NOTYPE' })), /UCrBig: header 0x0\/0x40\/0x0, record NOTYPE/);
});

test('cross-check: many mismatches are counted and only the first few named', () => {
  const rows = Array.from({ length: 5 }, (_, i) => hrow(`X::k${i}`, 8, 8));
  const recs = rows.map((r) => entry(r.key, 16));
  assert.throws(() => cross(rows, recs), /5 of 5 keys.*X::k0.*X::k1.*X::k2.*\+2 more/);
});

test('cross-check: refuses when fewer than half of the header rows could be compared', () => {
  const more = (n) => Array.from({ length: n }, (_, i) => hrow(`M::k${i}`, 8, 8));
  assert.throws(() => cross([...HROWS, ...more(5)]), /entry for only 4 of the header's 9 field rows.*too few/);
  assert.equal(cross([...HROWS, ...more(4)]).cl, 127004, 'exactly half is enough');
});

test('cross-check: a header row for a renamed member is not compared and does not count', () => {
  const renamed = { ...hrow('AFoo::Old', 8, 8), member: 'Renamed' };
  assert.equal(cross([...HROWS, renamed], [...RECS, { key: 'AFoo::Old', result: 'NOMEMBER', size: 0 }]).cl, 127004);
});

// ---- cross-check against the published version map ------------------------------

// A published file as the publish job writes it: the export, a seq line after the format line and a sig line last.
const published = (rows) => {
  const map = parse(HEADER);
  map.builtCL = null;
  map.functions = [];
  map.fields = rows;
  const lines = exportFeed(map).split('\n');
  const text = [lines[0], 'seq\t1', ...lines.slice(1, -1), `sig\tk2\t${'A'.repeat(86)}==`, ''].join('\n');
  return { text, release: { assets: [{ name: PUBLISHED.asset, size: Buffer.byteLength(text), uploader: BOT }] } };
};
const listed = (text, over = {}) => ({ text, release: { assets: [{ name: PUBLISHED.asset, size: Buffer.byteLength(text), uploader: BOT, ...over }] } });
const wide = (pub, recs = RECS2) => ref({ ...rec(recs), args: { headerText: headerWith(HROWS), fields: new Set(), published: pub } });
const PROWS = [...HROWS, hrow('AFoo::Baz', 24, 8)];
const RECS2 = [...RECS, entry('AFoo::Baz', 24)];
const patched = (key, patch) => RECS2.map((k) => (k.key === key ? { ...k, ...patch } : k));

test('published cross-check: equal data passes with nothing skipped, and a row the record lacks is ignored', () => {
  assert.equal(wide(published(PROWS)).skipped, null);
  assert.equal(wide(published([...PROWS, hrow('AFoo::NotInRecord', 8, 8)])).skipped, null);
});

test('published cross-check: a wrong offset, size or mask in the record refuses and names the key', () => {
  const pub = published(PROWS);
  assert.throws(() => wide(pub, patched('AFoo::Baz', { offset: 32 })), /disagrees with the version map's field rows.*1 of 5 keys.*AFoo::Baz: version map 0x18\/0x8\/0x0, record 0x20\/0x8\/0x0/);
  assert.throws(() => wide(pub, patched('AFoo::Baz', { size: 4 })), /AFoo::Baz: version map 0x18\/0x8\/0x0, record 0x18\/0x4\/0x0/);
  const flagged = (mask) => [...RECS2, { key: 'UCrFlag2::bOn', result: 'OK', offset: 0x10, size: 1, boolMask: mask }];
  assert.throws(() => wide(published([...PROWS, hrow('UCrFlag2::bOn', 0x10, 1, 0x4)]), flagged(0x8)), /UCrFlag2::bOn: version map 0x10\/0x1\/0x4, record 0x10\/0x1\/0x8/);
});

test('published cross-check: a renamed member is not compared and does not count', () => {
  const renamed = { ...hrow('AFoo::Old', 8, 8), member: 'Renamed' };
  assert.equal(wide(published([...PROWS, renamed]), [...RECS2, { key: 'AFoo::Old', result: 'NOMEMBER', size: 0 }]).skipped, null);
});

test('published cross-check: fewer than half of its rows in the record refuses', () => {
  const more = Array.from({ length: 6 }, (_, i) => hrow(`M::k${i}`, 8, 8));
  assert.throws(() => wide(published([...PROWS, ...more])), /entry for only 5 of the version map's 11 field rows.*too few/);
});

test('published cross-check: a file that is absent, unreadable, without rows for the built CL or not the bot\'s is skipped with a reason, and the header still checks', () => {
  const good = published(PROWS);
  const skip = (pub, re) => { const r = wide(pub); assert.match(r.skipped, re); assert.equal(r.cl, 127004); };
  skip(null, /no published version map was given/);
  skip({ text: null, release: good.release }, /no version-map-client.v1.txt was downloaded from release vmap-feed/);
  skip({ ...good, release: null }, /release vmap-feed lists no version-map-client.v1.txt/);
  skip(listed(good.text, { uploader: { login: 'someone', type: 'User' } }), /uploaded by someone \(User\).*not trusted/);
  skip(listed(good.text, { size: 3 }), /not the asset the release lists/);
  skip(listed('not a version map\n'), /no seq or sig line/);
  skip(listed(good.text.replace('field\tAFoo::Bar\t127004', 'field\tAFoo::Bar\tx127004')), /^version-map-client.v1.txt: /);
  skip(published(PROWS.map((r) => ({ ...r, cl: 128786 }))), /has no field rows for CL-127004/);
  // The header's check does not depend on the published file: a bad record still refuses when the file is unusable.
  assert.throws(() => ref({ ...rec(swap('AFoo::Bar', { offset: 24 })), args: { headerText: headerWith(HROWS), fields: new Set(), published: { text: null, release: null } } }), /disagrees with the header's field rows/);
});

// ---- cross-check against the SDK tables -------------------------------------------

// A table as `layout-table.mjs gen` writes it for a run on another build: kBuiltCL is that build's, not the SDK's.
const trow = (member, offset, size, mask = 0) => ({ member, offset, size, mask });
const tclass = (name, rows = [], sizeOf = 0, kind = 1) => ({ name, sizeOf, alignOf: sizeOf ? 8 : 0, kind, path: '', rows });
const tableText = (classes, over = {}) => renderHeader({ cl: 129402, detail: 1, granularity: 2, classes, ...over });
const SDK_HEADER = (cl = 127004) => `#pragma once\n\n// StarRupture\n// 5.6.1-${cl}+++Earth20+Neon\n\n#include "SDK/Basic.hpp"\n`;
const TCLASSES = [
  tclass('AFoo', [trow('Bar', 16, 8), trow('Baz', 24, 8)]), tclass('UCrBig', [], 0x40, 2),
  tclass('UCrFlag', [trow('bOn', 0x565, 1, 0x10)]),
];
const sdkOf = (classes = TCLASSES, over = {}) => ({ header: SDK_HEADER(), tables: [{ name: 'table-A.h', text: tableText(classes) }], ...over });
const viaSdk = (sdk, recs = RECS2) => ref({ ...rec(recs), args: { headerText: headerWith([]), fields: new Set(), sdkTables: sdk } });
const skipsSdk = (sdk, re, recs) => { const r = viaSdk(sdk, recs); assert.match(r.sdkSkipped, re); assert.equal(r.sdkCompared, 0); assert.equal(r.cl, 127004); };

test('SDK cross-check: equal data passes and counts what it compared; a record key the table lacks (native, loader) is ignored', () => {
  const r = viaSdk(sdkOf());
  assert.equal(r.sdkSkipped, null);
  assert.equal(r.sdkCompared, 4, 'AFoo::Bar, AFoo::Baz, UCrBig and UCrFlag::bOn; FTransform::Translation is in the record only');
  assert.equal(viaSdk(sdkOf([...TCLASSES, tclass('AGone', [trow('NotInRecord', 8, 8)])])).sdkCompared, 4, 'a table key the record lacks is not compared');
});

test('SDK cross-check: a wrong offset, size, mask or class size in the record refuses and names the key with both values', () => {
  const sdk = sdkOf();
  assert.throws(() => viaSdk(sdk, patched('AFoo::Baz', { offset: 32 })), /disagrees with the SDK table's field rows.*1 of 4 keys.*AFoo::Baz: SDK table 0x18\/0x8\/0x0, record 0x20\/0x8\/0x0/);
  assert.throws(() => viaSdk(sdk, patched('AFoo::Baz', { size: 4 })), /AFoo::Baz: SDK table 0x18\/0x8\/0x0, record 0x18\/0x4\/0x0/);
  assert.throws(() => viaSdk(sdk, patched('UCrFlag::bOn', { boolMask: 0x20 })), /UCrFlag::bOn: SDK table 0x565\/0x1\/0x10, record 0x565\/0x1\/0x20/);
  assert.throws(() => viaSdk(sdk, patched('UCrBig', { size: 0x48 })), /UCrBig: SDK table 0x0\/0x40\/0x0, record 0x0\/0x48\/0x0/);
  assert.throws(() => viaSdk(sdk, patched('AFoo::Baz', { result: 'NOMEMBER' })), /AFoo::Baz: SDK table 0x18\/0x8\/0x0, record NOMEMBER/);
});

test('SDK cross-check: a class size of 0 and a member size of 0 mean unknown; a nested class name is a class', () => {
  const classes = [...TCLASSES, tclass('ASized', [trow('Unsized', 40, 0)]), tclass('FOuter::FInner', [], 0x10, 2)];
  const recs = [...RECS2, entry('ASized::Unsized', 40), { key: 'FOuter::FInner', result: 'OK', size: 0x10 }];
  assert.equal(viaSdk(sdkOf(classes), recs).sdkCompared, 6);
  assert.throws(() => viaSdk(sdkOf(classes), recs.map((k) => (k.key === 'ASized::Unsized' ? { ...k, offset: 48 } : k))), /ASized::Unsized: SDK table 0x28\/null\/0x0, record 0x30\/0x8\/0x0/);
  assert.throws(() => viaSdk(sdkOf(classes), recs.map((k) => (k.key === 'FOuter::FInner' ? { ...k, size: 0x18 } : k))), /FOuter::FInner: SDK table 0x0\/0x10\/0x0, record 0x0\/0x18\/0x0/);
});

test('SDK cross-check: fewer than half of the table rows in the record refuses', () => {
  const more = (n) => tclass('AMore', Array.from({ length: n }, (_, i) => trow(`k${i}`, 8 * i, 8)));
  assert.throws(() => viaSdk(sdkOf([...TCLASSES, more(5)])), /entry for only 4 of the SDK table's 9 field rows.*too few/);
  assert.equal(viaSdk(sdkOf([...TCLASSES, more(4)])).sdkCompared, 4, 'exactly half is enough');
});

test('SDK cross-check: without tables, with tables of another build or with unusable ones, it is skipped with a reason and never refuses', () => {
  const wrong = patched('AFoo::Baz', { offset: 32 });
  skipsSdk(null, /no SDK tables were given/, wrong);
  skipsSdk({ header: SDK_HEADER(), tables: [] }, /no table-\*\.h file was given/, wrong);
  skipsSdk(sdkOf(TCLASSES, { header: SDK_HEADER(129402) }), /describe CL-129402, the stored layout is CL-127004/, wrong);
  skipsSdk(sdkOf(TCLASSES, { header: null }), /sdk-header.txt is missing or names no SDK build/, wrong);
  skipsSdk(sdkOf(TCLASSES, { header: '// 5.6.1\n' }), /names no SDK build/, wrong);
  skipsSdk({ header: SDK_HEADER(), tables: [{ name: 'table-B.h', text: 'not a table' }] }, /table-B.h: kFormatVersion not found/, wrong);
  skipsSdk({ header: SDK_HEADER(), tables: [{ name: 'table-C.h', text: tableText(TCLASSES, { detail: 0 }) }] }, /table-C.h carries no sizes or masks/, wrong);
  // Skipping is for missing evidence only: the same wrong record is refused when the tables are there.
  assert.throws(() => viaSdk(sdkOf(), wrong), /disagrees with the SDK table's/);
});

test('SDK cross-check: tables of several plugins are merged; a blueprint class is left out; the header rows still check first', () => {
  const second = { name: 'table-B.h', text: tableText([tclass('AFoo', [trow('Bar', 16, 8)]), tclass('UBp_C', [trow('X', 1, 1)], 0, 4)]) };
  const sdk = sdkOf();
  assert.equal(viaSdk({ ...sdk, tables: [...sdk.tables, second] }).sdkCompared, 4, 'AFoo::Bar in both tables counts once, UBp_C is not a key');
  const conflicting = { name: 'table-B.h', text: tableText([tclass('AFoo', [trow('Bar', 20, 8)])]) };
  assert.throws(() => viaSdk({ ...sdk, tables: [...sdk.tables, conflicting] }), /AFoo::Bar: SDK table 0x14\/0x8\/0x0, record 0x10\/0x8\/0x0/);
  assert.throws(() => ref({ ...rec(swap('AFoo::Bar', { offset: 24 })), args: { headerText: headerWith(HROWS), fields: new Set(), sdkTables: sdk } }), /disagrees with the header's field rows/);
});

test('reference: refuses malformed records', () => {
  for (const bad of ['not json', '{}', JSON.stringify({ ...make(), schema: 2 }), JSON.stringify({ ...make(), exeSha256: 'zz' }),
    JSON.stringify({ ...make(), keys: 'x' }), JSON.stringify({ ...make(), keys: [{ key: 'A::b', result: 'OK' }] }), JSON.stringify({ ...make(), buildid: 'abc' })]) {
    assert.throws(() => ref({ recordText: bad, release: releaseFor(bad) }), /layout-CL-127004.json/, bad);
  }
  assert.throws(() => readRecord('{}'), /not a layout record/);
});

// ---- command line ------------------------------------------------------------

function inDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'layout-store-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return (name) => join(dir, name);
}

function run(argv) {
  let out = '';
  let err = '';
  const o = process.stdout.write;
  const e = process.stderr.write;
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
  let code;
  try { code = main(argv); } finally { process.stdout.write = o; process.stderr.write = e; }
  return { code, out, err };
}

test('command line: record writes the asset, reference writes the base report and refuses with exit 3', () => {
  const p = inDir({
    'result.json': JSON.stringify(result()), 'scanner.json': JSON.stringify(scanner()), 'layout.json': layoutText(),
    'native-keys.txt': '', 'layout-keys.txt': [...FIELDS].join('\n') + '\n', 'header.h': HEADER,
  });
  const rec = run(['record', '--out', p('rec.json'), '--result', p('result.json'), '--scanner', p('scanner.json'), '--layout', p('layout.json'), '--run', '7', '--sha', 'f'.repeat(40)]);
  assert.equal(rec.code, 0, rec.err);
  const text = readFileSync(p('rec.json'), 'utf8');
  writeFileSync(p('release.json'), JSON.stringify(releaseFor(text)));
  const args = ['reference', p('header.h'), '--record', p('rec.json'), '--release', p('release.json'), '--cl', '127004', '--sha256', SHA, '--native-keys', p('native-keys.txt'), '--layout-keys', p('layout-keys.txt'), '--out', p('base.json')];
  const ok = run(args);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(readFileSync(p('base.json'), 'utf8')).keys.length, 4);
  const gone = run(args.map((a) => (a === p('rec.json') ? p('missing.json') : a)));
  assert.equal(gone.code, 3);
  assert.match(gone.err, /listed on release vmap-layouts but could not be downloaded/);
  writeFileSync(p('empty.json'), JSON.stringify({ assets: [] }));
  const none = run(args.map((a) => (a === p('release.json') ? p('empty.json') : a === p('rec.json') ? p('missing.json') : a)));
  assert.equal(none.code, 3);
  assert.match(none.err, /no stored layout for CL-127004/);
  assert.equal(run(['bogus']).code, 2);
});

test('command line: --published names a directory; its file is cross-checked, and a missing one is skipped with one line', () => {
  const pub = published([hrow('ACrCrafter::CraftComponent', 1752, 8), hrow('AFoo::Bar', 16, 8)]);
  const text = JSON.stringify(make(), null, 2) + '\n';
  const p = inDir({ 'header.h': HEADER, 'rec.json': text, 'release.json': JSON.stringify(releaseFor(text)), 'native-keys.txt': '', 'layout-keys.txt': [...FIELDS].join('\n') + '\n' });
  const sub = mkdtempSync(join(tmpdir(), 'layout-store-pub-'));
  writeFileSync(join(sub, PUBLISHED.asset), pub.text);
  writeFileSync(join(sub, 'release.json'), JSON.stringify(pub.release));
  const args = ['reference', p('header.h'), '--record', p('rec.json'), '--release', p('release.json'), '--cl', '127004', '--sha256', SHA, '--native-keys', p('native-keys.txt'), '--layout-keys', p('layout-keys.txt'), '--out', p('base.json')];
  const ok = run([...args, '--published', sub]);
  assert.equal(ok.code, 0, ok.err);
  assert.doesNotMatch(ok.out, /skipped/);
  const none = run([...args, '--published', join(sub, 'nowhere')]);
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /wider cross-check against the published version map was skipped: no version-map-client.v1.txt was downloaded/);
  assert.match(run(args).out, /skipped: no published version map was given/);
  writeFileSync(join(sub, 'release.json'), 'not json');
  const bad = run([...args, '--published', sub]);
  assert.equal(bad.code, 0, bad.err);
  assert.match(bad.out, /skipped: release vmap-feed lists no version-map-client.v1.txt/, 'an unreadable release listing is a skip, not a refusal');
  writeFileSync(join(sub, 'release.json'), JSON.stringify(pub.release));
  writeFileSync(join(sub, PUBLISHED.asset), pub.text.replace('AFoo::Bar\t127004\t0x10', 'AFoo::Bar\t127004\t0x18'));
  assert.equal(run([...args, '--published', sub]).code, 3, 'a changed offset in the file refuses');
});

test('command line: --sdk-tables names a directory; its tables are cross-checked, and anything missing there is skipped with one line', () => {
  const text = JSON.stringify(make(), null, 2) + '\n';
  const p = inDir({ 'header.h': HEADER, 'rec.json': text, 'release.json': JSON.stringify(releaseFor(text)), 'native-keys.txt': '', 'layout-keys.txt': [...FIELDS].join('\n') + '\n' });
  const sub = mkdtempSync(join(tmpdir(), 'layout-store-sdk-'));
  const put = (name, body) => writeFileSync(join(sub, name), body);
  put(SDK_TABLES.header, SDK_HEADER());
  put('table-A.h', tableText([tclass('AFoo', [trow('Bar', 16, 8), trow('Baz', 24, 8)]), tclass('UWorld', [trow('GameState', 0x120, 8)])]));
  put('notes.txt', 'ignored');
  const args = ['reference', p('header.h'), '--record', p('rec.json'), '--release', p('release.json'), '--cl', '127004', '--sha256', SHA, '--native-keys', p('native-keys.txt'), '--layout-keys', p('layout-keys.txt'), '--out', p('base.json')];
  const ok = run([...args, '--sdk-tables', sub]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /the SDK tables agree with the stored layout on 3 keys/);
  assert.doesNotMatch(run(args).out, /SDK/, 'without the option nothing about it is printed');
  const none = run([...args, '--sdk-tables', join(sub, 'nowhere')]);
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /cross-check against the SDK tables was skipped: no table-\*\.h file was given/);
  put(SDK_TABLES.header, SDK_HEADER(129402));
  assert.match(run([...args, '--sdk-tables', sub]).out, /skipped: the SDK tables describe CL-129402/);
  put(SDK_TABLES.header, SDK_HEADER());
  put('table-A.h', tableText([tclass('AFoo', [trow('Bar', 20, 8), trow('Baz', 24, 8)])]));
  const bad = run([...args, '--sdk-tables', sub]);
  assert.equal(bad.code, 3, 'a changed offset in a table refuses');
  assert.match(bad.err, /AFoo::Bar: SDK table 0x14\/0x8\/0x0, record 0x10\/0x8\/0x0/);
});

test('command line: keys the stored layout lacks are written without a reference and named in one line', () => {
  const text = JSON.stringify(make(), null, 2) + '\n';
  const listed = [...FIELDS, 'Z::a', 'Z::b'];
  const p = inDir({ 'header.h': HEADER, 'rec.json': text, 'release.json': JSON.stringify(releaseFor(text)), 'native-keys.txt': '', 'layout-keys.txt': listed.join('\n') + '\n' });
  const args = ['reference', p('header.h'), '--record', p('rec.json'), '--release', p('release.json'), '--cl', '127004', '--sha256', SHA, '--native-keys', p('native-keys.txt'), '--layout-keys', p('layout-keys.txt'), '--out', p('base.json')];
  const out = run(args);
  assert.equal(out.code, 0, out.err);
  assert.equal(out.out.split('\n').filter((l) => /no entry for/.test(l)).length, 1);
  assert.match(out.out, /the stored layout has no entry for 2 reflected keys \(Z::a, Z::b\) now listed; their rows come from the new build/);
  assert.equal(JSON.parse(readFileSync(p('base.json'), 'utf8')).keys.length, 4);
});

test('command line: record against a stored asset writes nothing when it adds nothing, and refuses a hand upload', () => {
  const p = inDir({ 'result.json': JSON.stringify(result()), 'scanner.json': JSON.stringify(scanner()), 'layout.json': layoutText() });
  const base = ['record', '--out', p('rec.json'), '--result', p('result.json'), '--scanner', p('scanner.json'), '--layout', p('layout.json'), '--run', '8', '--sha', 'f'.repeat(40)];
  assert.equal(run(base).code, 0);
  const text = readFileSync(p('rec.json'), 'utf8');
  writeFileSync(p('stored.json'), text);
  writeFileSync(p('release.json'), JSON.stringify(releaseFor(text)));
  writeFileSync(p('hand.json'), JSON.stringify(releaseFor(text, { uploader: { login: 'someone', type: 'User' } })));
  const again = ['record', '--out', p('rec2.json'), ...base.slice(3), '--existing', p('stored.json')];
  const same = run([...again, '--release', p('release.json')]);
  assert.equal(same.code, 0, same.err);
  assert.match(same.out, /nothing to upload/);
  assert.throws(() => readFileSync(p('rec2.json')), /ENOENT/);
  const hand = run([...again, '--release', p('hand.json')]);
  assert.equal(hand.code, 3);
  assert.match(hand.err, /not trusted/);
  assert.equal(run(base.concat(['--existing', p('stored.json')])).code, 3, '--existing needs --release');
});
