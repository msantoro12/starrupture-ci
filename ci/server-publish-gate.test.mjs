// Tests for the server file's publish gate (ci/server-publish-gate.mjs).
//
//   node --test ci/server-publish-gate.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportFeed } from './version-map.mjs';
import { LOADER_TABLES, blobId, gateReasons, loadTables, main, parseTable, scannedExe } from './server-publish-gate.mjs';

const source = readFileSync(LOADER_TABLES[0].path, 'utf8').replaceAll('\r\n', '\n');
const tables = loadTables();
const [real] = tables;
const OWN = { cl: 127004, stamp: 0x2E3595FF, size: 0x0E2A8000 };
const REBUILT = { ...OWN, stamp: 0x11111111 };
const NEW_CL = { cl: 135000, stamp: 0x22222222, size: 0x0F000000 };

const builtIn = (exe) => ({
  functions: real.functions.map((r) => ({ ...r, cl: exe.cl, owners: null })),
  fields: real.fields.map((r) => ({ ...r, cl: exe.cl })),
});
const feedFor = (exe, { functions = [], fields = [] } = {}) => exportFeed({
  flavour: 'server', builtCL: null, absentFields: [],
  builds: [{ cl: exe.cl, stamp: exe.stamp, size: exe.size, source: 'server steam_build 1' }],
  functions, fields,
});
const NEW_FIELD = { key: 'UZed::NewMember', cl: OWN.cl, offset: 0x10, size: 8, mask: 0, member: null };
const judge = (exe, rows, against = tables) => gateReasons(feedFor(exe, rows), exe, against);

test('table: the vendored v1.27.0 table is read whole, the last row of every array included', () => {
  assert.deepEqual([real.ref, real.builds.length, real.functions.length, real.fields.length, real.absentFields.length], ['v1.27.0', 1, 30, 110, 0]);
  assert.deepEqual(real.builds[0], OWN);
  assert.deepEqual(real.fields.at(-1), { key: 'UWorld::UnpausedTimeSeconds', cl: 127004, offset: 0x840, size: 8, mask: 0, member: null });
  const last = '{ 127004, 0x840, 0x8, 0x00, nullptr },\n}};';
  assert.ok(source.includes(last));
  assert.deepEqual(parseTable(source.replace(last, '{ 127004, 0x840, 0x8, 0x00, nullptr }\n}};')).fields, parseTable(source).fields);
});

test('table: refused when the rows read cannot be trusted', () => {
  const last = '\t{ 127004, 0x840, 0x8, 0x00, nullptr },\n';
  assert.throws(() => parseTable(source.replace(last, '')), /109 rows read, 110 declared/);
  assert.throws(() => parseTable(source.replace(last, '\tROW(127004),\n')), /not a FieldRow record/);
  assert.throws(() => parseTable(source.replace('{ "UWorld::UnpausedTimeSeconds", 109, 1 },', '{ "UWorld::UnpausedTimeSeconds", 108, 1 },')), /already named/);
  assert.throws(() => parseTable(source.replace('kServerFieldRows = {{', 'kOtherRows = {{')), /found 0 times/);
});

test('table: an unreadable or edited file is refused; a CRLF checkout is not an edit', () => {
  assert.equal(blobId(source.replaceAll('\n', '\r\n')), LOADER_TABLES[0].blob);
  assert.throws(() => loadTables([{ ...LOADER_TABLES[0], path: join(tmpdir(), 'no-such-table.h') }]), /ENOENT/);
  assert.throws(() => loadTables([{ ...LOADER_TABLES[0], blob: '0'.repeat(40) }]), /is not the v1\.27\.0 table/);
  assert.throws(() => loadTables([]), /no built-in table/);
});

test('scanned exe: an unknown build, stamp or size is refused', () => {
  const good = { cl: 127004, imageStamp: '0x2E3595FF', imageSize: '0x0E2A8000' };
  assert.deepEqual(scannedExe(good), OWN);
  for (const [name, bad] of [['cl', { cl: 0 }], ['cl', { cl: null }], ['stamp', { imageStamp: '' }], ['stamp', { imageStamp: '0x00000000' }], ['size', { imageSize: undefined }]]) {
    assert.throws(() => scannedExe({ ...good, ...bad }), new RegExp(`${name} is unknown`));
  }
});

test('lines: every line must carry the scanned exe, with one build line', () => {
  assert.deepEqual(judge(OWN, { fields: [NEW_FIELD] }), []);
  const good = feedFor(OWN, { ...builtIn(OWN) });
  const refused = (text, pattern) => assert.match(gateReasons(text, OWN, tables).join('\n'), pattern);
  refused(feedFor(REBUILT, { fields: [NEW_FIELD] }), /line 2: not the scanned exe's build, stamp and size.*0x11111111/);
  refused(feedFor({ ...OWN, size: 0x0F000000 }), /line 2: not the scanned exe/);
  refused(good.replace('0x2E3595FF\t0x0E2A8000\t1', '0x11111111\t0x0E2A8000\t1'), /line 3: not the scanned exe.*function/);
  refused(`${good}field\tUZed::Other\t135000\t0x10\t0x8\t0x00\t-\n`, /not the scanned exe.*135000/);
  refused(good.replace('\nfunction', '\nbuild\t135000\t0x22222222\t0x0F000000\tserver steam_build 2\nfunction'), /line 3: not the scanned exe[\s\S]*2 build lines/);
  refused(good.replace('\nfunction', '\nbuild\t127004\t0x2E3595FF\t0x0E2A8000\tagain\nfunction'), /2 build lines/);
  refused(`${good}vtable\tx\n`, /not a build, function, absent or field line/);
  refused('format\t1\n', /0 build lines/);
});

test('same exe: built-in rows repeated exactly and new names pass', () => {
  const rows = builtIn(OWN);
  assert.deepEqual(judge(OWN, { functions: rows.functions, fields: [...rows.fields, NEW_FIELD] }), []);
});

test('same exe: a built-in name with another value, fingerprint or kind is refused by name', () => {
  const rows = builtIn(OWN);
  const field = rows.fields.at(-1);
  assert.match(judge(OWN, { fields: [{ ...field, offset: field.offset + 8 }] }).join('\n'), /^field UWorld::UnpausedTimeSeconds: differs from the v1\.27\.0 built-in row/);
  assert.match(judge(OWN, { fields: [{ ...field, member: 'Other' }] }).join('\n'), /UnpausedTimeSeconds/);
  const global = rows.functions.find((r) => r.fp === 0);
  assert.match(judge(OWN, { functions: [{ ...global, rva: global.rva + 16 }] }).join('\n'), /^function .*differs from/);
  const scoped = rows.functions.find((r) => r.fp !== 0);
  assert.match(judge(OWN, { functions: [{ ...scoped, fp: scoped.fp + 1 }] }).join('\n'), /GObjects.*differs from/);
  assert.match(judge(OWN, { functions: [{ ...global, kind: global.kind === 1 ? 4 : 1 }] }).join('\n'), /^function .*differs from/);
});

test('same exe: filling a name the table marks absent is refused', () => {
  const marked = [{ ...real, absentFields: [{ key: NEW_FIELD.key, cl: OWN.cl }] }];
  assert.match(judge(OWN, { fields: [NEW_FIELD] }, marked).join('\n'), /field UZed::NewMember: differs from/);
});

test('rebuilt exe: every built-in field must be replaced; address-only function rows need not be', () => {
  const rows = builtIn(REBUILT);
  assert.deepEqual(judge(REBUILT, { fields: rows.fields.map((r) => ({ ...r, offset: r.offset + 8 })) }), []);
  assert.deepEqual(judge(REBUILT, { fields: rows.fields.slice(0, -1) }),
    ["field UWorld::UnpausedTimeSeconds: the v1.27.0 built-in row is not replaced, so it would be served from the old exe's measurements"]);
});

test('rebuilt exe: a built-in pattern or absent function row must be replaced under its own fingerprint', () => {
  const fields = builtIn(REBUILT).fields;
  const row = { key: 'ModLoader/Site', cl: OWN.cl, kind: 3, fp: 5, absent: false, pattern: '48 8B', resultOffset: 0, followRel32At: -1, followRipDispAt: -1, rva: 0x1000, owners: null };
  for (const builtRow of [row, { ...row, pattern: null, absent: true }]) {
    const patterned = [{ ...real, functions: [...real.functions, builtRow] }];
    assert.match(judge(REBUILT, { fields }, patterned).join('\n'), /function ModLoader\/Site \(fp 0x00000005\).*not replaced/);
  }
  const patterned = [{ ...real, functions: [row] }];
  assert.match(gateReasons(feedFor(REBUILT, { fields }), REBUILT, patterned).join('\n'), /ModLoader\/Site/);
});

test('another build number: no built-in row is for that exe, so nothing is compared', () => {
  assert.deepEqual(judge(NEW_CL, { fields: [{ ...real.fields[0], cl: NEW_CL.cl, offset: 0x999 }] }), []);
});

test('every listed table is judged', () => {
  const other = { ...real, ref: 'v9.9.9', fields: [{ ...NEW_FIELD, offset: 0x20 }] };
  assert.match(judge(OWN, { fields: [NEW_FIELD] }, [real, other]).join('\n'), /v9\.9\.9/);
});

test('command: exit 0 passes, 3 refuses naming the row, 2 when it cannot judge', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, text) => { writeFileSync(join(dir, name), text); return join(dir, name); };
  const result = put('server-result.json', '﻿{"cl":127004,"imageStamp":"0x2E3595FF","imageSize":"0x0E2A8000"}');
  const said = [];
  t.mock.method(process.stdout, 'write', (s) => { said.push(String(s)); return true; });
  const field = builtIn(OWN).fields[0];
  const codes = [
    main([put('good.txt', feedFor(OWN, { fields: [field] })), '--result', result]),
    main([put('bad.txt', feedFor(OWN, { fields: [{ ...field, size: 4 }] })), '--result', result]),
    main([put('broken.txt', `${feedFor(OWN)}field\tA::B\t127004\t16\t0x8\t0x00\t-\n`), '--result', result]),
    main([join(dir, 'good.txt'), '--result', put('empty.json', '{}')]),
    main([join(dir, 'good.txt'), '--result', result], [{ ...LOADER_TABLES[0], path: join(dir, 'gone.h') }]),
  ];
  t.mock.restoreAll();
  assert.deepEqual(codes, [0, 3, 2, 2, 2]);
  assert.match(said.join(''), /::error::server publish gate: field ACrGameStateBase::WaveTimerActor: differs/);
});
