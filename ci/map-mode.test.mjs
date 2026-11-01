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
import { parse, parseKeys } from './version-map.mjs';
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
