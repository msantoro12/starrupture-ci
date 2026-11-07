// Tests for map-mode.mjs.
//
//   node --test ci/map-mode.test.mjs
//
// The loader fixture (fixtures/version-map/loader.h) is the header map mode
// writes into; CL-128786 is its newest build and CL-130000 is the new one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addFunction, emit, exportFeed, parse, parseFeed, parseKeys } from './version-map.mjs';
import { kindOf, mapMode, tupleOf } from './map-mode.mjs';
import { selectRows } from './apply-proposals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'map-mode.mjs');
const header = () => readFileSync(join(here, 'fixtures', 'version-map', 'loader.h'), 'utf8').replace(/\r\n/g, '\n');

const PE = 'BetterCheats/AActor::ProcessEvent caller';
const GO = 'ModLoader/GObjects (GUObjectArray.ObjObjects)';
const BC = 'UCrBuildingComponent::GetPlacementResourceConditionResult';
const SF = 'UCrSomething::Function';
const FP_A = 0x2d1ac6ae;
const FP_B = 0xb3405899;
const FP_C = 0x0badf00d;
const FP_GO = 0x1c4d2e3f;

const BUILD = { stamp: '0x6B000001', size: '0x0A430000', source: 'public_test_branch 26300000' };

// A harness row that resolved.
const ok = (key, kind, rva, extra = {}) => ({
  key, kind, result: 'OK', rva: `0x${rva.toString(16)}`, pattern: `48 8B ${(rva & 0xff).toString(16).toUpperCase().padStart(2, '0')} ??`,
  fp: isScopedKind(kind) ? FP_A : 0, ...extra,
});
const isScopedKind = (k) => [2, 3, 5, 6, 'infunction', 'code', 'vtable', 'any'].includes(k);
const failed = (key, kind, extra = {}) => ({ key, kind, result: 'MISSING', pattern: '40 53 ??', fp: isScopedKind(kind) ? FP_A : 0, ...extra });
const release = (tag, rank, rows, extra = {}) => ({ tag, rank, rows, ...extra });

// Everything the fixture tracks, resolved on CL-130000.
function base() {
  return {
    schema: 1,
    cl: 130000,
    build: BUILD,
    components: [
      { owner: 'ModLoader', releases: [release('v1.22.1', 'current', [
        ok('GWorld', 'data', 0xe30000, { followRipDispAt: 0, required: true }),
        ok(GO, 'any', 0x8e5000, { fp: FP_GO, followRipDispAt: 0 }),
        ok(BC, 'function', 0x1a30000),
      ])] },
      { owner: 'BetterCheats', releases: [
        release('v0.23.0', 'current', [ok(PE, 'infunction', 0xc03000, { fp: FP_A }), ok(SF, 'function', 0x1b10000)]),
        release('v0.22.0', 'previous', [ok(PE, 'infunction', 0xc03000, { fp: FP_A })]),
      ] },
    ],
  };
}

const rowsOf = (text) => parse(text).functions;
const find = (text, key, fp, cl = 130000) => rowsOf(text).find((r) => r.key === key && r.fp === fp && r.cl === cl);

test('kinds read as numbers or as the harness names them', () => {
  assert.equal(kindOf('data'), 4);
  assert.equal(kindOf('any'), 6);
  assert.equal(kindOf('infunction'), 2);
  assert.equal(kindOf(5), 5);
  assert.throws(() => kindOf('bogus'), /not a PluginScanKind/);
  assert.throws(() => kindOf(7), /not a PluginScanKind/);
});

test('a resolved key becomes a locator row, per fp for a scoped key', () => {
  const out = mapMode(header(), base());
  assert.deepEqual(out.problems, []);
  const gw = find(out.text, 'GWorld', 0);
  assert.equal(gw.kind, 4);
  assert.equal(gw.followRipDispAt, 0);
  assert.equal(gw.rva, 0xe30000);
  const go = find(out.text, GO, FP_GO);
  assert.equal(go.kind, 6);
  assert.equal(go.absent, false);
  assert.equal(find(out.text, PE, FP_A).rva, 0xc03000);
  assert.equal(parse(out.text).builds.find((b) => b.cl === 130000).source, BUILD.source);
});

test('a re-anchored scoped key gets two row sets, one per fp', () => {
  const input = base();
  input.components[1].releases[1] = release('v0.22.0', 'previous', [ok(PE, 'infunction', 0xc03000, { fp: FP_C, pattern: '48 8B 05 ?? ?? ?? ??' })]);
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  assert.ok(find(out.text, PE, FP_A));
  assert.ok(find(out.text, PE, FP_C));
  assert.equal(find(out.text, PE, FP_C).absent, false);
});

test('a previous release that cannot place a scoped key gets an absent row under its fp', () => {
  const input = base();
  input.components[1].releases[1] = release('v0.22.0', 'previous', [failed(PE, 'infunction', { fp: FP_C })]);
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  const a = find(out.text, PE, FP_C);
  assert.equal(a.absent, true);
  assert.equal(a.kind, 2);
});

test('a failed row takes the suggester proposal when it is unique and high confidence', () => {
  const input = base();
  input.components[1].releases[0].rows[1] = failed(SF, 'function', {
    suggest: { confidence: 'high', rva: '0x1b22000', proposals: [{ pattern: '48 8B C8 E8 ?? ?? ?? ??', followRel32At: 3, followRipDispAt: -1, resultOffset: 0, uniqueOnTarget: true }] },
  });
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  const r = find(out.text, SF, 0);
  assert.equal(r.absent, false);
  assert.equal(r.pattern, '48 8B C8 E8 ?? ?? ?? ??');
  assert.equal(r.followRel32At, 3);
  assert.equal(r.rva, 0x1b22000);
});

test('a proposal that follows a rip displacement is written as such', () => {
  const input = base();
  input.components[0].releases[0].rows[0] = failed('GWorld', 'data', {
    suggest: { confidence: 'high', rva: '0xe31000', proposals: [{ pattern: '48 8B 1D ?? ?? ?? ?? 48 85 DB', followRel32At: -1, followRipDispAt: 3, resultOffset: 0, uniqueOnTarget: true }] },
  });
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  assert.equal(find(out.text, 'GWorld', 0).followRipDispAt, 3);
});

test('a proposal below high confidence or not unique is not written; the key is absent for its owners', () => {
  const input = base();
  input.components[1].releases[0].rows[1] = failed(SF, 'function', {
    suggest: { confidence: 'medium', rva: '0x1b22000', proposals: [{ pattern: '48 8B C8', followRel32At: -1, resultOffset: 0, uniqueOnTarget: true }] },
  });
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  const a = find(out.text, SF, 0);
  assert.equal(a.absent, true);
  assert.deepEqual(a.owners, ['BetterCheats']);
});

test('a global key some owner resolved is a locator, not absent, whoever failed', () => {
  const input = base();
  input.components.push({ owner: 'WAILA', releases: [release('v0.20.0', 'current', [failed(SF, 'function')])] });
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  assert.equal(find(out.text, SF, 0).absent, false);
});

test('two keys naming one function are refused, and the message names both', () => {
  const input = base();
  input.components[1].releases[0].rows.push(ok('UCrOther::Alias', 'function', 0x1b30000, { symbolRva: 0x1b30000 }));
  input.components[1].releases[0].rows[1] = ok(SF, 'function', 0x1b30000, { symbolRva: 0x1b30000 });
  const out = mapMode(header(), input);
  assert.equal(out.text, null);
  assert.equal(out.problems.length, 1);
  assert.match(out.problems[0], /UCrOther::Alias and UCrSomething::Function name one symbol/);
});

test('a global key that lands off the start of its symbol is refused', () => {
  const input = base();
  input.components[1].releases[0].rows[1] = ok(SF, 'function', 0x1b10010, { symbolRva: 0x1b10000 });
  const out = mapMode(header(), input);
  assert.equal(out.text, null);
  assert.match(out.problems[0], /UCrSomething::Function: lands at 0x1B10010, off the start of its symbol \(0x1B10000\)/i);
});

test('a function key with no symbol is written with a note that its symbol checks did not run', () => {
  const out = mapMode(header(), base());
  assert.deepEqual(out.problems, []);
  assert.ok(out.notes.some((n) => n.startsWith(`${SF}: no symbol for 0x1B10000`)));
  assert.ok(!out.notes.some((n) => n.startsWith('GWorld:')));
});

test('one key resolving to two addresses is refused', () => {
  const input = base();
  input.components.push({ owner: 'WAILA', releases: [release('v0.20.0', 'current', [ok(SF, 'function', 0x1b10100)])] });
  const out = mapMode(header(), input);
  assert.equal(out.text, null);
  assert.match(out.problems[0], /UCrSomething::Function: resolves to 0x1B10000 and 0x1B10100/i);
});

test('two request tuples sharing one fp under one key are refused, and the message names the key', () => {
  const input = base();
  input.components[1].releases[1] = release('v0.22.0', 'previous', [ok(PE, 'infunction', 0xc03000, { fp: FP_A, pattern: '48 8B 05 ?? ?? ?? ??', resultOffset: -4 })]);
  const out = mapMode(header(), input);
  assert.equal(out.text, null);
  assert.equal(out.problems.length, 1);
  assert.ok(out.problems[0].startsWith(PE));
  assert.match(out.problems[0], /share fp 0x2D1AC6AE/);
});

test('the same request seen by two releases is one tuple', () => {
  assert.equal(tupleOf({ kind: 2, pattern: 'A B', resultOffset: 0, followRel32At: -1 }), tupleOf({ kind: 2, pattern: 'A B', followRipDispAt: -1 }));
  assert.notEqual(tupleOf({ kind: 2, pattern: 'A B' }), tupleOf({ kind: 3, pattern: 'A B' }));
});

test('a scoped row without an fp, and a global row with one, are refused', () => {
  let input = base();
  input.components[1].releases[0].rows[0] = ok(PE, 'infunction', 0xc03000, { fp: 0 });
  assert.match(mapMode(header(), input).problems[0], /no fp; the harness must print one/);
  input = base();
  input.components[1].releases[0].rows[1] = ok(SF, 'function', 0x1b10000, { fp: FP_A });
  assert.match(mapMode(header(), input).problems[0], /global row .* carries fp/);
});

test('a required loader key with no locator under the newest release is refused; the previous release may lack one', () => {
  let input = base();
  input.components[0].releases[0].rows[1] = failed(GO, 'any', { fp: FP_GO, required: true });
  let out = mapMode(header(), input);
  assert.equal(out.text, null);
  assert.match(out.problems[0], /required key ModLoader\/GObjects .* has no locator on CL-130000 under the newest release/);

  input = base();
  input.components[0].releases.push(release('v1.21.0', 'previous', [failed(GO, 'any', { fp: FP_B, required: true })]));
  out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  assert.equal(find(out.text, GO, FP_B).absent, true);
});

test('a required global key with no locator is refused', () => {
  const input = base();
  input.components[0].releases[0].rows[0] = failed('GWorld', 'data', { required: true });
  const out = mapMode(header(), input);
  assert.equal(out.text, null);
  assert.match(out.problems[0], /required key GWorld has no locator on CL-130000/);
});

test('a loader release that predates fingerprints gets no scoped rows, and says so', () => {
  const input = base();
  input.components[0].releases.push(release('v1.20.0', 'previous', [failed(GO, 'any', { fp: 0 })], { fpAware: false }));
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  assert.ok(out.notes.some((n) => n.includes('v1.20.0') && n.includes('predates fingerprints')));
  assert.equal(rowsOf(out.text).filter((r) => r.key === GO && r.cl === 130000).length, 1);
});

test('row sets whose fp neither the current nor the previous release carries are pruned', () => {
  const out = mapMode(header(), base());
  assert.deepEqual(out.problems, []);
  assert.equal(rowsOf(header()).filter((r) => r.key === PE && r.fp === FP_B).length, 2);
  assert.equal(rowsOf(out.text).filter((r) => r.key === PE && r.fp === FP_B).length, 0);
  assert.equal(rowsOf(out.text).filter((r) => r.key === PE && r.fp === FP_A).length, 3);
  assert.equal(out.pruned, 2);
});

test('without the previous release scanned, no row set of that owner is pruned', () => {
  const input = base();
  input.components[1].releases.pop(); // BetterCheats: current only, as the client check feeds it today
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  assert.equal(out.pruned, 0);
  // The previous release may still read FP_B on every CL it ran on.
  assert.equal(rowsOf(out.text).filter((r) => r.key === PE && r.fp === FP_B).length, 2);
  assert.ok(find(out.text, PE, FP_A));
});

test('rows of a component that is not tracked are left for the pattern path, not written', () => {
  const input = base();
  input.components.push({ owner: 'MiniMap', tracked: false, releases: [release('v1.2.0', 'current', [
    failed('MiniMap/SplinePayload::GetSplineActorData', 'function'),
    ok('MiniMap/Other', 'function', 0x777000),
  ])] });
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.patches, [{ owner: 'MiniMap', tag: 'v1.2.0', key: 'MiniMap/SplinePayload::GetSplineActorData', result: 'MISSING' }]);
  assert.ok(!rowsOf(out.text).some((r) => r.key.startsWith('MiniMap/')));
});

test('the result does not depend on the order of the input, and a second run changes nothing', () => {
  const a = base();
  const b = base();
  b.components.reverse();
  for (const c of b.components) c.releases.reverse();
  const one = mapMode(header(), a);
  const two = mapMode(header(), b);
  assert.deepEqual(one.problems, []);
  assert.equal(one.text, two.text);
  const again = mapMode(one.text, a);
  assert.deepEqual(again.problems, []);
  assert.equal(again.text, one.text);
  assert.equal(again.added, 0);
});

test('a different verified row for the same key, fp and CL is refused; the header is not changed', () => {
  const first = mapMode(header(), base());
  const input = base();
  input.components[1].releases[0].rows[1] = ok(SF, 'function', 0x1b10040);
  const out = mapMode(first.text, input);
  assert.equal(out.text, null);
  assert.match(out.problems[0], /UCrSomething::Function @ CL-130000: the map already has a different function row/);
});

test('a verified row replaces an earlier absent one', () => {
  const input = base();
  input.components[1].releases[0].rows[1] = failed(SF, 'function');
  const first = mapMode(header(), input);
  assert.equal(find(first.text, SF, 0).absent, true);
  const second = mapMode(first.text, base());
  assert.deepEqual(second.problems, []);
  assert.equal(find(second.text, SF, 0).absent, false);
});

test('a new CL needs its build; a known one must match it', () => {
  const noBuild = base();
  delete noBuild.build;
  assert.match(mapMode(header(), noBuild).problems[0], /CL-130000 is not in the build table and the input has no build/);
  const known = base();
  known.cl = 128786;
  known.build = BUILD;
  assert.match(mapMode(header(), known).problems[0], /CL-128786 is already in the build table with another exe/);
});

test('remeasure measures a known CL again, only when asked', () => {
  const known = base();
  known.cl = 128786;
  known.build = BUILD;
  assert.match(mapMode(header(), known).problems[0], /already in the build table with another exe/);
  const again = mapMode(header(), known, { remeasure: true });
  assert.deepEqual(again.problems, []);
  const text = again.text;
  assert.ok(parse(text, 'the header').builds.some((b) => b.cl === 128786 && b.source === BUILD.source));
  assert.deepEqual(mapMode(text, known).problems, []);
  assert.deepEqual(mapMode(header(), base(), { remeasure: true }).problems, []);
});

test('a pattern row with rva 0 (scan the pattern, it must match once) survives map mode, a remeasure and the feed', () => {
  const key = 'ACrAPHelperActorCustom::CheckMainMeshCollision';
  const seeded = parse(header(), 'the header');
  addFunction(seeded, { key, kind: 1, cl: 127004, pattern: '40 55 53 56 57 41 55 48 8D AC 24 ?? ?? ?? ??', rva: 0 });
  const text = emit(seeded);
  const rva0 = (t, cl = 127004) => parse(t, 'the header').functions.filter((r) => r.rva === 0 && !r.absent && r.cl === cl);
  assert.equal(rva0(text).length, 1, 'the seeded row parses back');
  assert.equal(emit(parse(text, 'the header')), text, 'parse and emit keep it byte for byte');
  const added = mapMode(text, base());
  assert.deepEqual(added.problems, []);
  assert.deepEqual(rva0(added.text), rva0(text), 'a new CL leaves it alone');
  const known = base();
  known.cl = 128786;
  const again = mapMode(text, known, { remeasure: true });
  assert.deepEqual(again.problems, []);
  assert.deepEqual(rva0(again.text), rva0(text), 'a remeasure of another CL leaves it alone');
  const feed = exportFeed(parse(added.text, 'the header'));
  assert.ok(feed.split('\n').some((l) => l.startsWith(`function\t${key}\t`) && l.endsWith('\t0x00000000') && l.includes('\t127004\t')), 'the feed carries it with rva 0');
  assert.equal(exportFeed(parseFeed(feed)), feed, 'and reads it back unchanged');
});

test('the coverage rule runs over the written map when a key list is given', () => {
  const keys = parseKeys([
    `function ${PE}`, 'function GWorld', `function ${GO}`, `function ${BC}`, `function ${SF}`,
    'field ACrCharacterPlayerBase::ADSMoveSpeed', 'field ACrCrafter::CraftComponent', 'field UCrSomething::bFlag',
  ].join('\n'));
  const good = mapMode(header(), base(), { keys: [keys] });
  assert.deepEqual(good.problems, []);
  assert.ok(good.text);
  const input = base();
  input.components[1].releases[0].rows.pop();
  const bad = mapMode(header(), input, { keys: [keys] });
  assert.equal(bad.text, null);
  assert.ok(bad.problems.some((p) => p === `coverage: no function row for ${SF} on CL-130000`));
});

test('a plugin map is refused, and a malformed input is an error', () => {
  const plugin = readFileSync(join(here, 'fixtures', 'version-map', 'plugin.h'), 'utf8').replace(/\r\n/g, '\n');
  assert.throws(() => mapMode(plugin, base()), /writes the loader map/);
  assert.throws(() => mapMode(header(), { schema: 2 }), /not schema 1/);
  const input = base();
  input.components[1].releases[0].rank = 'newest';
  assert.throws(() => mapMode(header(), input), /rank must be current or previous/);
});

test('the command line writes the header in place and a report; a refusal leaves the header alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mapmode-'));
  const h = join(dir, 'version_map.generated.h');
  const inp = join(dir, 'in.json');
  const rep = join(dir, 'report.json');
  writeFileSync(h, header());
  writeFileSync(inp, JSON.stringify(base()));
  let r = spawnSync(process.execPath, [TOOL, 'write', h, '--input', inp, '--report', rep], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rows added, 2 pruned/);
  assert.equal(JSON.parse(readFileSync(rep, 'utf8')).written, true);
  assert.ok(find(readFileSync(h, 'utf8'), 'GWorld', 0));

  const bad = base();
  bad.components[1].releases[0].rows[1] = ok(SF, 'function', 0x1b10040);
  writeFileSync(inp, JSON.stringify(bad));
  const before = readFileSync(h, 'utf8');
  r = spawnSync(process.execPath, [TOOL, 'write', h, '--input', inp, '--report', rep], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /^refused: /m);
  assert.equal(readFileSync(h, 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(rep, 'utf8')).written, false);

  r = spawnSync(process.execPath, [TOOL, 'write', h], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 2);
  r = spawnSync(process.execPath, [TOOL, 'write', h, '--input', join(dir, 'missing.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 2);
});

test('the pattern path does not write a rip-displacement proposal into a plugin source', () => {
  const scan = {
    suggest: { reference: 'mapped' },
    patterns: [{
      name: 'X::Y', call: 'A', recorded: true, result: 'MISSING', pattern: '40 53 ??', followRel32At: -1,
      suggest: { confidence: 'high', proposals: [{ pattern: '48 8B 1D ?? ?? ?? ?? 48 85 DB', followRel32At: -1, followRipDispAt: 3, resultOffset: 0, uniqueOnTarget: true, uniqueOnReference: true }] },
    }],
  };
  const plan = selectRows(scan, {});
  assert.equal(plan.rows.length, 0);
  assert.match(plan.skipped[0].reason, /follows a rip displacement/);
  scan.patterns[0].suggest.proposals[0].followRipDispAt = -1;
  assert.equal(selectRows(scan, {}).rows.length, 1);
});

// ---- assemble: the harness JSON becomes the input -----------------------------

import { assemble } from './map-mode.mjs';

function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mapmode-asm-'));
  for (const [name, doc] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(doc));
  return dir;
}

const loaderScan = {
  patterns: [
    { name: 'GWorld', key: 'GWorld', kind: 'data', required: true, result: 'OK', rva: '0xE30000', symbolRva: '0xE30000', pattern: '48 8B 05 ?? ?? ?? ??', followRel32At: -1, followRipDispAt: 0, siteArithmetic: 0, fp: '0x00000000' },
    { name: 'Spare', key: 'ModLoader/Spare', kind: 'any', required: false, result: 'MISSING', pattern: '40 53 ??', fp: '0x0BADF00D', suggest: { confidence: 'high', rva: '0x8E5000', proposals: [{ pattern: '48 8B', uniqueOnTarget: true, followRipDispAt: 0 }] } },
  ],
};
const pluginScan = {
  plugin: { name: 'BetterCheats' },
  patterns: [
    { call: 'Resolve', name: PE, key: PE, kind: 'infunction', required: true, result: 'OK', rva: '0xC03000', pattern: '48 8B 05 ?? ?? ?? ?? 48 85 C0 74 ??', fp: '0x2D1AC6AE', resultOffset: 0 },
    { call: 'ResolveRequired', name: 'legacy', kind: 'any', required: true, result: 'OK', rva: '0x1000', pattern: '48 89' },
  ],
};

test('assemble turns harness rows into the input, keeping only map requests', () => {
  const dir = scratch({ 'loader.json': loaderScan, 'bc.json': pluginScan });
  const input = assemble({
    cl: 130000, build: BUILD,
    scans: [
      { owner: 'ModLoader', tag: 'v1.22.1', rank: 'current', file: 'loader.json' },
      { owner: 'BetterCheats', tag: 'v0.23.0', rank: 'current', file: 'bc.json' },
    ],
  }, dir);
  assert.equal(input.schema, 1);
  const [loader, bc] = input.components;
  assert.equal(loader.owner, 'ModLoader');
  assert.equal(loader.releases[0].rows.length, 2);
  assert.equal(loader.releases[0].rows[0].required, true);
  assert.equal(loader.releases[0].rows[0].symbolRva, '0xE30000');
  assert.equal(bc.releases[0].rows.length, 1, 'the legacy call has no key');
  assert.equal(bc.releases[0].rows[0].required, false, 'only the loader requires');
  // And map mode accepts it.
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  assert.ok(find(out.text, PE, FP_A));
});

test('assemble refuses a scan of another plugin, an empty spec and a non-harness file', () => {
  const dir = scratch({ 'bc.json': pluginScan, 'junk.json': { hello: 1 } });
  assert.throws(() => assemble({ cl: 1, scans: [{ owner: 'WAILA', tag: 'v1', rank: 'current', file: 'bc.json' }] }, dir), /not "WAILA"/);
  assert.throws(() => assemble({ cl: 1, scans: [] }, dir), /no scans/);
  assert.throws(() => assemble({ cl: 1, scans: [{ owner: 'WAILA', tag: 'v1', rank: 'current', file: 'junk.json' }] }, dir), /no patterns array/);
});

test('assemble runs from the command line', () => {
  const dir = scratch({ 'loader.json': loaderScan, 'spec.json': { cl: 130000, build: BUILD, scans: [{ owner: 'ModLoader', tag: 'v1.22.1', rank: 'current', file: 'loader.json' }] } });
  const run = spawnSync(process.execPath, [TOOL, 'assemble', join(dir, 'spec.json'), '--out', join(dir, 'in.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'in.json'), 'utf8')).components[0].releases[0].rows.length, 2);
});

test('assemble takes the CL and the build from the registry scan exe block', () => {
  const dir = scratch({ 'loader.json': { ...loaderScan, exe: { cl: 130000, imageStamp: '0x6B000001', imageSize: '0x0A430000' } } });
  const input = assemble({ source: BUILD.source, scans: [{ owner: 'ModLoader', tag: 'v1.22.1', rank: 'current', file: 'loader.json' }] }, dir);
  assert.equal(input.cl, 130000);
  assert.deepEqual(input.build, BUILD);
});

// The CL-128786 MainMenuWidget case: the map already holds a verified row and
// the scan reports another pattern text at the same address.
test('an unchanged verified row is kept when key, kind, fp, CL, address and exe all match', () => {
  const first = mapMode(header(), base());
  const before = find(first.text, SF, 0);
  const input = base();
  input.components[1].releases[0].rows[1] = ok(SF, 'function', 0x1b10000, { pattern: '48 8D 6C 24 ?? 48 81 EC' });
  const out = mapMode(first.text, input);
  assert.deepEqual(out.problems, []);
  assert.equal(out.text, first.text, 'the header is byte-identical');
  assert.deepEqual(find(out.text, SF, 0), before);
  assert.ok(out.notes.some((n) => n.startsWith(`${SF}: kept the verified CL-130000 row`)));
});

test('a verified row with another pattern is still refused when the address, kind or exe differs', () => {
  const first = mapMode(header(), base());
  const other = { pattern: '48 8D 6C 24 ?? 48 81 EC' };
  const moved = base();
  moved.components[1].releases[0].rows[1] = ok(SF, 'function', 0x1b10040, other);
  assert.match(mapMode(first.text, moved).problems.join(' | '), /UCrSomething::Function @ CL-130000: the map already has a different function row/);
  const kind = base();
  kind.components[1].releases[0].rows[1] = ok(SF, 'code', 0x1b10000, { ...other, fp: 0 });
  assert.equal(mapMode(first.text, kind).text, null);
  const noBuild = base();
  delete noBuild.build;
  noBuild.components[1].releases[0].rows[1] = ok(SF, 'function', 0x1b10000, other);
  assert.match(mapMode(first.text, noBuild).problems.join(' | '), /the map already has a different function row/);
  const exe = base();
  exe.build = { ...BUILD, stamp: '0x6B000002' };
  exe.components[1].releases[0].rows[1] = ok(SF, 'function', 0x1b10000, other);
  assert.match(mapMode(first.text, exe).problems.join(' | '), /already in the build table with another exe/);
});

test('a known CL is the same build when only the label differs', () => {
  const known = base();
  known.cl = 128786;
  const same = { stamp: '0x6A1B2C3D', size: '0x0A412000' };
  known.build = { ...same, source: 'steam_build 26271156' };
  assert.ok(!mapMode(header(), known).problems.some((p) => /already in the build table/.test(p)));
  known.build = { ...same, source: 'public_test_branch 26271156' };
  assert.ok(!mapMode(header(), known).problems.some((p) => /already in the build table/.test(p)));
});

test('a known CL with another build id, stamp or size holds; an unparseable label holds with a message', () => {
  const known = base();
  known.cl = 128786;
  const same = { stamp: '0x6A1B2C3D', size: '0x0A412000' };
  known.build = { ...same, source: 'steam_build 26271157' };
  assert.match(mapMode(header(), known).problems[0], /Steam build id 26271156 in the table, 26271157 measured/);
  known.build = { stamp: '0x6A1B2C3E', size: same.size, source: 'steam_build 26271156' };
  assert.match(mapMode(header(), known).problems[0], /another image stamp or size/);
  known.build = { stamp: same.stamp, size: '0x0A412001', source: 'steam_build 26271156' };
  assert.match(mapMode(header(), known).problems[0], /another image stamp or size/);
  known.build = { ...same, source: 'steam_build' };
  assert.match(mapMode(header(), known).problems[0], /no Steam build id/);
});

test('an OK row without a pattern refuses the write and the message names the key, the CL and why', () => {
  const input = base();
  input.components[1].releases[0].rows.push(ok(`${SF}`, 'function', 0x123000, { pattern: undefined }));
  assert.throws(() => mapMode(header(), input), (e) => e.message.includes(JSON.stringify(SF)) && e.message.includes('CL-130000') && /gives no pattern/.test(e.message));
});

// ---- carried rows and the completeness check ----------------------------------

import { completeness } from './map-mode.mjs';

const carryScratch = (carryRows) => {
  const dir = scratch({
    'loader.json': { patterns: [loaderScan.patterns[0]] },
    'carry.json': { kind: 'carry', cl: 130000, rows: carryRows },
  });
  writeFileSync(join(dir, 'base.h'), header());
  return { dir, spec: { cl: 130000, build: BUILD, scans: [{ owner: 'ModLoader', tag: 'v1.22.1', rank: 'current', file: 'loader.json' }], carry: { file: 'carry.json', header: 'base.h' } } };
};
// A report entry as the scanner writes it: the kind and fp of the key, and the locator that was tried.
const KEY_KIND = { [BC]: [1, 0], [SF]: [1, 0], [PE]: [2, FP_A], GWorld: [4, 0], [GO]: [6, FP_GO] };
const entry = (key, fromCL, result, extra = {}) => ({
  key, fromCL, matches: result === 'match' ? 1 : result === 'none' ? 0 : 2, rva: '0x1339290', result,
  kind: KEY_KIND[key][0], fp: `0x${KEY_KIND[key][1].toString(16).toUpperCase().padStart(8, '0')}`,
  pattern: '48 89 5C 24 ?? 55 56 57 48 8D AC 24', resultOffset: 0, followRel32At: -1, followRipDispAt: -1, ...extra,
});
// The entry of a key with no pattern row to try.
const noRow = (key, extra = {}) => entry(key, null, 'none', { rva: null, pattern: '', reason: 'no locator to carry: no row has a pattern', ...extra });

test('a carried match is a present row with the locator the scanner tried', () => {
  const { dir, spec } = carryScratch([entry(BC, 127004, 'match')]);
  const out = mapMode(header(), assemble(spec, dir));
  assert.deepEqual(out.problems, []);
  const row = find(out.text, BC, 0);
  assert.equal(row.absent, false);
  assert.equal(row.rva, 0x1339290);
  assert.equal(row.pattern, '48 89 5C 24 ?? 55 56 57 48 8D AC 24');
});

test('a carried match copies the site and follow extras of the entry', () => {
  const { dir, spec } = carryScratch([
    entry(PE, 128786, 'match', { pattern: '?? ?? 48 85 C0', resultOffset: -4, followRipDispAt: 3 }),
    entry(SF, 127004, 'match', { pattern: '40 53 ??', resultOffset: 6, followRel32At: 1 }),
  ]);
  const out = mapMode(header(), assemble(spec, dir));
  assert.deepEqual(out.problems, []);
  const site = find(out.text, PE, FP_A);
  assert.deepEqual([site.kind, site.pattern, site.resultOffset, site.followRel32At, site.followRipDispAt], [2, '?? ?? 48 85 C0', -4, -1, 3]);
  const fn = find(out.text, SF, 0);
  assert.deepEqual([fn.kind, fn.fp, fn.pattern, fn.resultOffset, fn.followRel32At, fn.followRipDispAt], [1, 0, '40 53 ??', 6, 1, -1]);
});

test('a scoped key is carried per fp: the fp with a pattern is present, the one without is absent', () => {
  const { dir, spec } = carryScratch([entry(PE, 128786, 'match', { followRipDispAt: 3 }), noRow(PE, { fp: `0x${FP_B.toString(16)}` })]);
  const out = mapMode(header(), assemble(spec, dir));
  assert.deepEqual(out.problems, []);
  assert.equal(find(out.text, PE, FP_A).followRipDispAt, 3);
  const gone = find(out.text, PE, FP_B);
  assert.equal(gone.absent, true);
  assert.equal(gone.owners, null, 'a scoped absent row lists no owners');
});

test('a null fromCL is an absent row with the reason "no pattern row", on the owners the earlier rows name', () => {
  const { dir, spec } = carryScratch([noRow(SF)]);
  const input = assemble(spec, dir);
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  const row = find(out.text, SF, 0);
  assert.equal(row.absent, true);
  assert.deepEqual(row.owners, ['BetterCheats', 'WAILA']);
  assert.ok(out.notes.some((n) => n.startsWith(`${SF}:`) && n.endsWith('absent on CL-130000, no pattern row')), out.notes.join('\n'));
  assert.deepEqual(out.absences, []);
});

test('a null fromCL on a global key no earlier row names an owner for is report-only', () => {
  const { dir, spec } = carryScratch([noRow(BC)]);
  const out = mapMode(header(), assemble(spec, dir));
  assert.deepEqual(out.problems, []);
  assert.equal(find(out.text, BC, 0), undefined, 'no row is written');
  assert.deepEqual(out.absences.map((a) => [a.key, a.fromCL]), [[BC, null]]);
  assert.match(out.absences[0].reason, /^no pattern row; no earlier row names an owner/);
});

test('the owners of the entry are the owners of the absent row, sorted, and win over the earlier rows', () => {
  const { dir, spec } = carryScratch([entry(SF, 127004, 'none', { reason: 'no hit', owners: 'WAILA,Codex,WAILA' }), entry(BC, 127004, 'ambiguous', { reason: '2 hits', owners: 'Codex' })]);
  const out = mapMode(header(), assemble(spec, dir));
  assert.deepEqual(out.problems, []);
  assert.deepEqual(find(out.text, SF, 0).owners, ['Codex', 'WAILA'], 'the earlier rows would have said BetterCheats,WAILA');
  assert.deepEqual(find(out.text, BC, 0).owners, ['Codex'], 'and a key with no earlier owner is no longer report-only');
  assert.deepEqual(out.absences, []);
});

test('a carried absent row copies the owners the earlier rows name, with the reason as a note', () => {
  const { dir, spec } = carryScratch([entry(SF, 127004, 'none', { reason: 'no hit' })]);
  const out = mapMode(header(), assemble(spec, dir));
  assert.deepEqual(out.problems, []);
  const row = find(out.text, SF, 0);
  assert.equal(row.absent, true);
  assert.deepEqual(row.owners, ['BetterCheats', 'WAILA'], 'the owners of the earlier absent row');
  assert.ok(out.notes.some((n) => n.startsWith(`${SF}:`) && n.includes('no hit')));
  assert.deepEqual(out.absences, []);
});

test('a carried absent key whose earlier rows name no owner gets no row, only a report entry', () => {
  const { dir, spec } = carryScratch([entry(BC, 127004, 'ambiguous', { reason: '2 hits' })]);
  const input = assemble(spec, dir);
  assert.equal(input.absences.length, 1);
  assert.equal(input.absences[0].key, BC);
  assert.match(input.absences[0].reason, /2 hits/);
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  assert.equal(find(out.text, BC, 0), undefined, 'no row is written');
  assert.deepEqual(out.absences, input.absences);
});

test('a match that is not unique is a report-only absence', () => {
  const { dir, spec } = carryScratch([entry(BC, 127004, 'match', { matches: 2 })]);
  const out = mapMode(header(), assemble(spec, dir));
  assert.equal(find(out.text, BC, 0), undefined);
  assert.match(out.absences[0].reason, /2 matches/);
});

test('the placeholder owner Carry appears nowhere', () => {
  const { dir, spec } = carryScratch([entry(SF, 127004, 'none'), entry(BC, 127004, 'none'), entry(PE, 128786, 'match')]);
  const input = assemble(spec, dir);
  const out = mapMode(header(), input);
  assert.ok(!input.components.some((c) => c.owner === 'Carry'));
  assert.ok(!/Carry/.test(out.text));
  assert.ok(!/Carry/.test(JSON.stringify(out.absences)) && !out.notes.some((n) => /Carry/.test(n)));
});

test('a fresh scan row beats a carried row for the same key', () => {
  const { dir, spec } = carryScratch([entry('GWorld', 128786, 'match', { rva: '0x999' }), entry(BC, 127004, 'match')]);
  const input = assemble(spec, dir);
  assert.equal(input.components.flatMap((c) => c.releases).filter((r) => r.tag === '128786').flatMap((r) => r.rows).some((r) => r.key === 'GWorld'), false);
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  assert.equal(find(out.text, 'GWorld', 0).rva, 0xe30000);
});

test('without a carry input assemble is unchanged', () => {
  const { dir, spec } = carryScratch([entry(BC, 127004, 'match')]);
  const { carry, ...plain } = spec;
  const input = assemble(plain, dir);
  assert.deepEqual(input.components.map((c) => c.owner), ['ModLoader']);
});

test('a carry report for another CL or of another kind is refused', () => {
  const { dir, spec } = carryScratch([]);
  writeFileSync(join(dir, 'carry.json'), JSON.stringify({ kind: 'carry', cl: 1, rows: [] }));
  assert.throws(() => assemble(spec, dir), /not CL-130000/);
  writeFileSync(join(dir, 'carry.json'), JSON.stringify({ kind: 'scan', rows: [] }));
  assert.throws(() => assemble(spec, dir), /not a carry report/);
});

test('a malformed carry report fails loudly, naming the file and the key', () => {
  const refused = (rows, pattern) => {
    const { dir, spec } = carryScratch(rows);
    assert.throws(() => assemble(spec, dir), pattern);
  };
  const { kind, ...noKind } = entry(BC, 127004, 'match');
  const { fp, ...noFp } = entry(BC, 127004, 'match');
  refused([noKind], /carry\.json: UCrBuildingComponent.*no kind or fp/);
  refused([noFp], /no kind or fp/);
  refused([entry(BC, 127004, 'match', { kind: 'bogus' })], /not a PluginScanKind/);
  refused([entry(BC, 127004, 'match', { fp: 'zz' })], /fp "zz" is not a number/);
  refused([entry(BC, 127004, 'maybe')], /result "maybe" is not match, none or ambiguous/);
  refused([entry(BC, undefined, 'none')], /fromCL undefined is not a number/);
  refused([entry(BC, null, 'match')], /a match names no fromCL/);
  refused([entry(BC, 127004, 'match', { pattern: '' })], /a match without a pattern/);
  refused([entry(BC, 127004, 'match', { rva: null })], /a match without an rva/);
  refused([entry(BC, 127004, 'match', { followRel32At: '3' })], /followRel32At "3" is not an integer/);
  refused([entry(SF, 127004, 'none', { owners: ['Codex'] })], /owners \["Codex"\] is not a comma-separated string/);
  refused([{ fromCL: 127004 }], /an entry has no key/);
  const { dir, spec } = carryScratch([]);
  writeFileSync(join(dir, 'carry.json'), JSON.stringify({ kind: 'carry', cl: 130000 }));
  assert.throws(() => assemble(spec, dir), /not a carry report/);
  writeFileSync(join(dir, 'carry.json'), '{ "kind": "carry", "rows": [');
  assert.throws(() => assemble(spec, dir), /carry\.json is not JSON/);
  writeFileSync(join(dir, 'carry.json'), 'null');
  assert.throws(() => assemble(spec, dir), /not a carry report/);
});

test('a missing or unreadable carry report stops assemble from the command line, with a message', () => {
  const { dir, spec } = carryScratch([]);
  const { carry, ...plain } = spec;
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(plain));
  const run = (carryFile) => spawnSync(process.execPath, [TOOL, 'assemble', join(dir, 'spec.json'), '--out', join(dir, 'in.json'), '--carry', carryFile, '--base', join(dir, 'base.h')], { encoding: 'utf8', windowsHide: true });
  const missing = run(join(dir, 'nope.json'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^map-mode: .*nope\.json/);
  writeFileSync(join(dir, 'bad.json'), '<html>');
  const bad = run(join(dir, 'bad.json'));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /bad\.json is not JSON/);
  const noBase = spawnSync(process.execPath, [TOOL, 'assemble', join(dir, 'spec.json'), '--out', join(dir, 'in.json'), '--carry', join(dir, 'carry.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(noBase.status, 2);
  assert.match(noBase.stderr, /--carry needs --base/);
});

test('completeness lists the keys with an earlier row and none on the CL', () => {
  const before = completeness(parse(header()), 130000);
  assert.equal(before.missing.length, 5, 'PE, GWorld, GObjects, BC and SF');
  assert.match(before.line, /^5 of 5 function keys have no CL-130000 row/);
  const { dir, spec } = carryScratch([entry(PE, 128786, 'match'), entry(GO, 128786, 'none'), entry(BC, 127004, 'match'), entry(SF, 127004, 'none')]);
  const out = mapMode(header(), assemble(spec, dir));
  const after = completeness(parse(out.text), 130000, out.absences);
  assert.deepEqual(after.missing, [], after.line);
});

test('the gate counts a report-only absence and fails without it', () => {
  const { dir, spec } = carryScratch([entry(PE, 128786, 'match'), entry(GO, 128786, 'none'), entry(BC, 127004, 'none'), entry(SF, 127004, 'none')]);
  const out = mapMode(header(), assemble(spec, dir));
  assert.deepEqual(out.absences.map((a) => a.key), [BC]);
  assert.deepEqual(completeness(parse(out.text), 130000).missing, [BC], 'without the report the key is missing');
  assert.deepEqual(completeness(parse(out.text), 130000, out.absences).missing, []);
  writeFileSync(join(dir, 'new.h'), out.text);
  const bare = spawnSync(process.execPath, [TOOL, 'complete', join(dir, 'new.h'), '--cl', '130000'], { encoding: 'utf8', windowsHide: true });
  assert.equal(bare.status, 3);
  writeFileSync(join(dir, 'w.json'), JSON.stringify({ written: true, absences: out.absences }));
  const withReport = spawnSync(process.execPath, [TOOL, 'complete', join(dir, 'new.h'), '--cl', '130000', '--report', join(dir, 'w.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(withReport.status, 0, withReport.stdout + withReport.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'w.json'), 'utf8')).missing, []);
});

test('complete exits 3 on a gap and 0 when there is none, from the command line', () => {
  const dir = scratch({});
  writeFileSync(join(dir, 'h.h'), header());
  const run = spawnSync(process.execPath, [TOOL, 'complete', join(dir, 'h.h'), '--cl', '130000'], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 3);
  assert.match(run.stdout, /5 of 5 function keys have no CL-130000 row/);
  const done = spawnSync(process.execPath, [TOOL, 'complete', join(dir, 'h.h'), '--cl', '128786'], { encoding: 'utf8', windowsHide: true });
  assert.equal(done.status, 0, done.stdout);
});

test('assemble --carry --base runs from the command line', () => {
  const { dir, spec } = carryScratch([entry(BC, 127004, 'match')]);
  const { carry, ...plain } = spec;
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(plain));
  const run = spawnSync(process.execPath, [TOOL, 'assemble', join(dir, 'spec.json'), '--out', join(dir, 'in.json'), '--carry', join(dir, 'carry.json'), '--base', join(dir, 'base.h')], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(JSON.parse(readFileSync(join(dir, 'in.json'), 'utf8')).components.some((c) => c.owner === 'ModLoader' && c.releases.some((r) => r.tag === '127004')));
});

// ---- key sources never gate ---------------------------------------------------
//
// From run 42412572050 (CL-129402): the released WaveOptimiser asks for
// UCrMassEnviroWaveSubsystem::AddEntitiesToWave / RemoveEntitiesFromWave, the fork's
// gss/plugin-work (a stale branch) for UCrWaveSubsystem::*; both resolve to the same
// two functions.

const WAVE_ADD = { rva: 0x76b59b0, pattern: '48 89 5C 24 ?? 48 89 54 24 ?? 48 89 4C 24 ?? 55 56 57 41 54 41 55 41 56 41 57 48 8D 6C 24 ?? 48 81 EC ?? ?? ?? ?? 48 8B DA' };
const WAVE_REMOVE = { rva: 0x76d7fd0, pattern: '48 89 5C 24 ?? 55 56 57 41 54 41 55 41 56 41 57 48 8D 6C 24 ?? 48 81 EC ?? ?? ?? ?? 48 8B 05 ?? ?? ?? ?? 48 33 C4 48 89 45 ?? 48 8B DA 48 89 54 24' };
const FORK = 'msantoro12/StarRupture-Plugin-WaveOptimiser@gss/plugin-work';
const FORK_SHA = 'c0ffee0123456789abcdef0123456789abcdef01';
const FORK_WHO = `key source ${FORK} (${FORK_SHA.slice(0, 12)}, checked the branch, not an installed DLL)`;
const waveRow = (key, w) => ok(key, 'function', w.rva, { pattern: w.pattern, symbolRva: w.rva });

function withWave({ released = true, fork = [['UCrWaveSubsystem::AddEntitiesToWave', WAVE_ADD], ['UCrWaveSubsystem::RemoveEntitiesFromWave', WAVE_REMOVE]] } = {}) {
  const input = base();
  const releases = [];
  if (released) {
    releases.push(release('current', 'current', [
      waveRow('UCrMassEnviroWaveSubsystem::AddEntitiesToWave', WAVE_ADD),
      waveRow('UCrMassEnviroWaveSubsystem::RemoveEntitiesFromWave', WAVE_REMOVE),
    ]));
  }
  releases.push(release(FORK, 'current', fork.map(([k, w]) => waveRow(k, w)), { keySource: true, commit: FORK_SHA }));
  input.components.push({ owner: 'WaveOptimiser', releases });
  return input;
}

test('key source: a stale fork key on the symbol of a released key is dropped with a note and an alert, and the map is written', () => {
  const out = mapMode(header(), withWave());
  assert.deepEqual(out.problems, []);
  assert.notEqual(out.text, null);
  for (const k of ['UCrMassEnviroWaveSubsystem::AddEntitiesToWave', 'UCrMassEnviroWaveSubsystem::RemoveEntitiesFromWave']) assert.ok(find(out.text, k, 0), k);
  for (const k of ['UCrWaveSubsystem::AddEntitiesToWave', 'UCrWaveSubsystem::RemoveEntitiesFromWave']) assert.equal(find(out.text, k, 0), undefined, `${k} gets no row`);
  assert.deepEqual(out.alerts, [
    `${FORK_WHO}: asks for UCrWaveSubsystem::AddEntitiesToWave at 0x76B59B0, which the released map names UCrMassEnviroWaveSubsystem::AddEntitiesToWave; that branch is stale`,
    `${FORK_WHO}: asks for UCrWaveSubsystem::RemoveEntitiesFromWave at 0x76D7FD0, which the released map names UCrMassEnviroWaveSubsystem::RemoveEntitiesFromWave; that branch is stale`,
  ]);
  assert.ok(out.notes.some((n) => n.startsWith('UCrWaveSubsystem::AddEntitiesToWave: asked for by key source') && n.includes('UCrMassEnviroWaveSubsystem::AddEntitiesToWave')));
});

test('key source: the same input without the flag (two plan plugins) still refuses, naming both keys', () => {
  const input = withWave();
  delete input.components[2].releases[1].keySource;
  const out = mapMode(header(), input);
  assert.equal(out.text, null);
  assert.equal(out.problems.length, 2);
  assert.match(out.problems[0], /UCrMassEnviroWaveSubsystem::AddEntitiesToWave and UCrWaveSubsystem::AddEntitiesToWave name one symbol \(0x76B59B0\)/);
});

test('key source: two plan keys and a source key on one symbol still refuse; so do two source keys alone', () => {
  const input = withWave();
  input.components[1].releases[0].rows.push(waveRow('UCrOther::Alias', WAVE_ADD));
  const three = mapMode(header(), input);
  assert.equal(three.text, null);
  assert.match(three.problems[0], /UCrMassEnviroWaveSubsystem::AddEntitiesToWave and UCrOther::Alias and UCrWaveSubsystem::AddEntitiesToWave name one symbol/);
  const alone = mapMode(header(), withWave({ released: false, fork: [['UCrWaveSubsystem::AddEntitiesToWave', WAVE_ADD], ['UCrOther::Alias', WAVE_ADD]] }));
  assert.equal(alone.text, null);
  assert.match(alone.problems[0], /UCrOther::Alias and UCrWaveSubsystem::AddEntitiesToWave name one symbol/);
});

test('key source: a key only the source asks for, on a symbol of its own, still gets its row', () => {
  const out = mapMode(header(), withWave({ released: false }));
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.alerts, []);
  assert.ok(find(out.text, 'UCrWaveSubsystem::AddEntitiesToWave', 0));
});

test('key source: assemble marks the release, and the alerts reach the report and survive complete', () => {
  const dir = scratch({ 'loader.json': loaderScan, 'bc.json': pluginScan, 'bc-fork.json': pluginScan });
  const input = assemble({ cl: 130000, build: BUILD, scans: [
    { owner: 'ModLoader', tag: 'v1.22.1', rank: 'current', file: 'loader.json' },
    { owner: 'BetterCheats', tag: 'current', rank: 'current', file: 'bc.json' },
    { owner: 'BetterCheats', tag: FORK, rank: 'current', keySource: true, file: 'bc-fork.json' },
  ] }, dir);
  const bc = input.components.find((c) => c.owner === 'BetterCheats');
  assert.deepEqual(bc.releases.map((r) => r.keySource), [undefined, true]);
  // The report file holds the alerts, and complete keeps them.
  const wdir = scratch({});
  const withAlert = withWave();
  writeFileSync(join(wdir, 'in.json'), JSON.stringify(withAlert));
  writeFileSync(join(wdir, 'h.h'), header());
  const w = spawnSync(process.execPath, [TOOL, 'write', join(wdir, 'h.h'), '--input', join(wdir, 'in.json'), '--report', join(wdir, 'r.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.equal(JSON.parse(readFileSync(join(wdir, 'r.json'), 'utf8')).alerts.length, 2);
  spawnSync(process.execPath, [TOOL, 'complete', join(wdir, 'h.h'), '--cl', '130000', '--report', join(wdir, 'r.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(readFileSync(join(wdir, 'r.json'), 'utf8')).alerts.length, 2);
});

test('key source: a dropped key that an earlier build has a row for is accounted for in absences, so complete still passes', () => {
  const seeded = parse(header(), 'the header');
  addFunction(seeded, { key: 'UCrWaveSubsystem::AddEntitiesToWave', kind: 1, cl: 128786, pattern: WAVE_ADD.pattern, rva: WAVE_ADD.rva });
  const out = mapMode(emit(seeded), withWave());
  assert.deepEqual(out.problems, []);
  assert.equal(find(out.text, 'UCrWaveSubsystem::AddEntitiesToWave', 0), undefined);
  assert.deepEqual(out.absences.map((a) => a.key), ['UCrWaveSubsystem::AddEntitiesToWave', 'UCrWaveSubsystem::RemoveEntitiesFromWave']);
  const done = completeness(parse(out.text, 'the header'), 130000, out.absences);
  assert.deepEqual(done.missing, []);
});

test('key source: a dropped key whose old pattern lands inside the symbol does not refuse the write', () => {
  const input = withWave({ fork: [['UCrWaveSubsystem::AddEntitiesToWave', { ...WAVE_ADD, rva: WAVE_ADD.rva + 0x20 }]] });
  input.components[2].releases[1].rows[0].symbolRva = '0x' + WAVE_ADD.rva.toString(16);
  const out = mapMode(header(), input);
  assert.deepEqual(out.problems, []);
  assert.equal(out.alerts.length, 1);
  // A plan plugin's key off the start of its symbol still refuses.
  const plan = withWave({ released: false, fork: [] });
  plan.components[2].releases.push(release('current', 'current', [ok('UCrPlan::Inside', 'function', WAVE_ADD.rva + 0x20, { symbolRva: '0x' + WAVE_ADD.rva.toString(16) })]));
  assert.match(mapMode(header(), plan).problems[0], /UCrPlan::Inside: lands at 0x76B59D0, off the start of its symbol/);
});
