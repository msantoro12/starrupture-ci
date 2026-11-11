import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { emit, parse } from './version-map.mjs';
import { SCHEMA, assetName, buildRecord, main, readRecord, referenceFor, sameLayout } from './layout-store.mjs';

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

test('reference: refuses a record that lacks a reflected key now listed, naming the first ones', () => {
  const fields = new Set([...FIELDS, 'Z::a', 'Z::b']);
  refuses({ args: { fields } }, /no entry for 2 reflected keys now listed \(Z::a, Z::b\)/);
  const many = new Set([...FIELDS, ...Array.from({ length: 8 }, (_, i) => `Y::k${i}`)]);
  refuses({ args: { fields: many } }, /8 reflected keys.*\+3 more/);
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
