// Tests for server-scan-rows.mjs.
//
//   node --test ci/server-scan-rows.test.mjs
//
// fixtures/version-map/server-scan-127004.json is what sr-aobscan-server.exe --json wrote for the 127004
// server exe (50 rows). The loader's own server header holds the same rows by hand; EXPECTED below is that
// header's kind, fp and rva for the six keys of ci/server-function-keys.txt the scanner finds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MapError, parseKeys } from './version-map.mjs';
import { serverMode } from './map-mode.mjs';
import { convertServerScan, scanRowsFile, summaryOf } from './server-scan-rows.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'server-scan-rows.mjs');
const KEYS_FILE = join(here, 'server-function-keys.txt');
const scanFixture = () => JSON.parse(readFileSync(join(here, 'fixtures', 'version-map', 'server-scan-127004.json'), 'utf8'));
const functionKeys = () => parseKeys(readFileSync(KEYS_FILE, 'utf8'), KEYS_FILE).functions;
const RESULT = { cl: 127004, imageStamp: '0x2E3595FF', imageSize: '0x0E2A8000', buildId: '25642172' };

const GO = 'ModLoader/GObjects (GUObjectArray.ObjObjects)';
// kind: 1 function start, 4 data, 6 any.
const EXPECTED = [
  { key: 'FName::AppendString', kind: 1, fp: 0, rva: 0x0142A250 },
  { key: 'GNames (NamePoolData)', kind: 4, fp: 0, rva: 0x0D2BD600 },
  { key: 'GWorld', kind: 4, fp: 0, rva: 0x0D50EE38 },
  { key: GO, kind: 6, fp: 0xD7B4F6BF, rva: 0x0D3A1A50 },
  { key: 'UMassSignalSubsystem::SignalEntity', kind: 1, fp: 0, rva: 0x05D7E6C0 },
  { key: 'UObject::ProcessEvent', kind: 1, fp: 0, rva: 0x016F4C00 },
];

const convert = (scan = scanFixture(), result = RESULT) => convertServerScan(scan, result, { functionKeys: functionKeys() });
// The fixture with one listed key's row changed (or dropped when `edit` returns null).
const edited = (key, edit) => {
  const scan = scanFixture();
  scan.patterns = scan.patterns.flatMap((r) => (r.key === key ? [edit(r)].filter(Boolean) : [r]));
  return scan;
};

test('the recorded 127004 scan makes the six rows of the hand-made header: kind, fp and rva', () => {
  const out = convert();
  assert.deepEqual(out.rows, EXPECTED);
  assert.deepEqual(out.notOk, []);
  assert.equal(out.skipped.length, 44, 'the 44 scanner-only rows are left out');
  assert.ok(out.skipped.every((k) => !functionKeys().has(k)));
});

test('the rows make the same server rows as the header, with no client feed', () => {
  const rows = scanRowsFile(convert().rows);
  const build = { cl: 127004, stamp: '0x2E3595FF', size: '0x0E2A8000', buildId: '25642172' };
  const out = serverMode(null, { build, layout: null, scan: rows.patterns });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.added, { builds: 1, fields: 0, functions: 6 });
  const got = out.map.functions.map((r) => ({ key: r.key, kind: r.kind, fp: r.fp, rva: r.rva })).sort((a, b) => (a.key < b.key ? -1 : 1));
  assert.deepEqual(got, EXPECTED);
  assert.ok(out.map.functions.every((r) => r.cl === 127004 && !r.absent && r.pattern === null));
});

test('a listed key that is MISSING, AMBIGUOUS or WRONGKIND gets no row and is listed', () => {
  const scan = scanFixture();
  const change = { 'UObject::ProcessEvent': { result: 'MISSING', matches: 0 }, GWorld: { result: 'AMBIGUOUS', matches: 3 }, 'FName::AppendString': { result: 'WRONGKIND', matches: 1 } };
  scan.patterns = scan.patterns.map((r) => ({ ...r, ...(change[r.key] ?? {}) }));
  const out = convert(scan);
  assert.deepEqual(out.rows.map((r) => r.key), EXPECTED.map((r) => r.key).filter((k) => !(k in change)));
  assert.deepEqual(out.notOk.map((n) => [n.key, n.result, n.matches]), [
    ['FName::AppendString', 'WRONGKIND', 1], ['GWorld', 'AMBIGUOUS', 3], ['UObject::ProcessEvent', 'MISSING', 0],
  ]);
  const md = summaryOf(out, 127004);
  assert.match(md, /3 function and global rows/);
  assert.match(md, /no row: GWorld \(the scan result is AMBIGUOUS, 3 matches\)/);
  assert.match(md, /no row: UObject::ProcessEvent \(the scan result is MISSING, 0 matches\)/);
});

test('a missing or ambiguous row stays out of the header (the required-rows check sees the gap)', () => {
  const out = convert(edited('GWorld', (r) => ({ ...r, result: 'AMBIGUOUS', matches: 2 })));
  const build = { cl: 127004, stamp: '0x2E3595FF', size: '0x0E2A8000', buildId: '25642172' };
  const made = serverMode(null, { build, layout: null, scan: scanRowsFile(out.rows).patterns });
  assert.equal(made.map.functions.some((r) => r.key === 'GWorld'), false);
  assert.equal(made.added.functions, 5);
});

test('an OK row of a kind a server file does not take is listed, not written', () => {
  const out = convert(edited('GWorld', (r) => ({ ...r, kind: 'infunction' })));
  assert.deepEqual(out.rows.map((r) => r.key), EXPECTED.map((r) => r.key).filter((k) => k !== 'GWorld'));
  assert.match(out.notOk[0].reason, /kind infunction is not one a server file takes/);
  // The scoped key is kind any only: any other non-global kind under that key is not taken either.
  assert.equal(convert(edited(GO, (r) => ({ ...r, kind: 'code' }))).notOk[0].key, GO);
});

test('a report of another exe is refused: CL, PE stamp and image size must each match', () => {
  assert.throws(() => convert(scanFixture(), { ...RESULT, cl: 130000 }), /another exe than the server being checked.*CL-127004.*CL-130000/s);
  assert.throws(() => convert(scanFixture(), { ...RESULT, imageStamp: '0x2E3599AA' }), /another exe/);
  assert.throws(() => convert(scanFixture(), { ...RESULT, imageSize: '0x0E300000' }), /another exe/);
  const scan = scanFixture();
  scan.exe = { ...scan.exe, imageStamp: '0x2E3599AA' };
  assert.throws(() => convert(scan), MapError);
  // Hex case and padding do not matter, only the number does.
  assert.equal(convert(scanFixture(), { ...RESULT, imageStamp: '0x2e3595ff' }).rows.length, 6);
});

test('a report that has no server target is refused with a clear message', () => {
  const client = { ...scanFixture(), target: 'client' };
  assert.throws(() => convert(client), /not the server's \(target "client"/);
  const old = scanFixture();
  delete old.target;
  assert.throws(() => convert(old), /not the server's \(target undefined.*Server Release/s);
  assert.throws(() => convert({ target: 'server', exe: scanFixture().exe }), /no patterns array/);
  assert.throws(() => convert(null), MapError);
});

test('a listed key found twice, an OK row with no address and a wrong fp are refused', () => {
  const dup = scanFixture();
  dup.patterns.push(dup.patterns.find((r) => r.key === 'GWorld'));
  assert.throws(() => convert(dup), /GWorld: the scan report has two rows/);
  assert.throws(() => convert(edited('GWorld', (r) => ({ ...r, rva: undefined }))), /GWorld: rva/);
  assert.throws(() => convert(edited('GWorld', (r) => ({ ...r, rva: '0x0' }))), /GWorld: rva/);
  assert.throws(() => convert(edited('GWorld', (r) => ({ ...r, fp: '0x00000012' }))), /a global row has fp 0/);
  assert.throws(() => convert(edited(GO, (r) => ({ ...r, fp: '0x00000000' }))), /scoped row has no fp/);
});

// ---- the command ---------------------------------------------------------------------------------

const run = (dir, scanPath, resultObj = RESULT) => {
  const resultPath = join(dir, 'server-result.json');
  writeFileSync(resultPath, JSON.stringify(resultObj));
  const out = join(dir, 'rows.json');
  const summary = join(dir, 'summary.md');
  const r = spawnSync(process.execPath, [TOOL, scanPath, '--result', resultPath, '--keys', KEYS_FILE, '--out', out, '--summary', summary], { encoding: 'utf8', windowsHide: true });
  return { ...r, out, summary };
};
const fixturePath = join(here, 'fixtures', 'version-map', 'server-scan-127004.json');

test('command: writes the rows file and a summary the header step reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssr-'));
  const r = run(dir, fixturePath);
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(readFileSync(r.out, 'utf8'));
  assert.equal(rows.patterns.length, 6);
  assert.deepEqual(rows.patterns.find((p) => p.key === GO), { key: GO, kind: 6, result: 'OK', fp: '0xD7B4F6BF', rva: '0xD3A1A50' });
  assert.match(readFileSync(r.summary, 'utf8'), /^### Server scan rows\n\n- CL-127004: 6 function and global rows/);
  // The rows file goes into map-mode server unchanged.
  const h = join(dir, 'server.h');
  const m = spawnSync(process.execPath, [join(here, 'map-mode.mjs'), 'server', h, '--cl', '127004', '--stamp', '0x2E3595FF', '--size', '0x0E2A8000', '--build-id', '25642172', '--scan', r.out], { encoding: 'utf8', windowsHide: true });
  assert.equal(m.status, 0, m.stderr);
  assert.match(m.stdout, /6 function rows added/);
  assert.match(readFileSync(h, 'utf8'), /D7B4F6BF/i);
});

test('command: another exe, a client report, a missing file: exit 2 and no rows file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssr-'));
  const wrong = run(dir, fixturePath, { ...RESULT, cl: 130000 });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /server-scan-rows: the scan report is for another exe/);
  assert.equal(existsSync(wrong.out), false);
  const clientPath = join(dir, 'client.json');
  writeFileSync(clientPath, JSON.stringify({ ...scanFixture(), target: 'client' }));
  assert.equal(run(dir, clientPath).status, 2);
  assert.equal(run(dir, join(dir, 'nope.json')).status, 2);
  assert.equal(spawnSync(process.execPath, [TOOL], { encoding: 'utf8', windowsHide: true }).status, 2);
});
