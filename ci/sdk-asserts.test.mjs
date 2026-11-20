// Tests for ci/sdk-asserts.mjs, which comments out the Dumper-7 asserts MSVC cannot satisfy.
//
//   node --test ci/sdk-asserts.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commentOut, fixSdk, findUnbuildableAsserts } from './sdk-asserts.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// The three shapes from a real dump: empty base with a member at 0 (matches), the same with
// nothing in it (a tag), and a 1-byte base whose members start after it (builds, so it stays).
const HEADER = [
  '// ScriptStruct MassActors.MassActorFragment',
  '// 0x000B (0x000C - 0x0001)',
  'struct FMassActorFragment final : public FObjectWrapperFragment',
  '{',
  'public:',
  '\tTWeakObjectPtr<class AActor>                  Actor;                                             // 0x0000(0x0008)(Edit)',
  '\tuint8                                         Pad_8[0x4];                                        // 0x0008(0x0004)(Fixed)',
  '};',
  'DUMPER7_ASSERTS_FMassActorFragment;',
  '',
  '// ScriptStruct Chimera.CrAntennaLockedTag',
  '// 0x0000 (0x0001 - 0x0001)',
  'struct FCrAntennaLockedTag final : public FMassTag',
  '{',
  '};',
  'DUMPER7_ASSERTS_FCrAntennaLockedTag;',
  '',
  '// ScriptStruct AuCore.AuFloatDataProvider',
  '// 0x0007 (0x0008 - 0x0001)',
  'struct FAuFloatDataProvider final : public FAuDataProvider',
  '{',
  'public:',
  '\tuint8                                         Pad_0[0x1];                                        // 0x0001(0x0001)(Fixed)',
  '\tfloat                                         Value;                                             // 0x0004(0x0004)(Edit)',
  '};',
  'DUMPER7_ASSERTS_FAuFloatDataProvider;',
  '',
  '// ScriptStruct Chimera.Big',
  '// 0x0004 (0x0010 - 0x000C)',
  'struct FBig final : public FBase',
  '{',
  'public:',
  '\tint32                                         X;                                                 // 0x0000(0x0004)(Edit)',
  '};',
  'DUMPER7_ASSERTS_FBig;',
  '',
].join('\n');

test('only a struct with a 1-byte base and a member at 0x0000 is found', () => {
  assert.deepEqual(findUnbuildableAsserts(HEADER), [{ line: 9, name: 'FMassActorFragment' }]);
});

test('one line gets a // and nothing else changes', () => {
  const out = commentOut(HEADER, findUnbuildableAsserts(HEADER));
  const a = HEADER.split('\n');
  const b = out.split('\n');
  assert.equal(a.length, b.length);
  const changed = a.map((l, i) => (l === b[i] ? null : [i + 1, l, b[i]])).filter(Boolean);
  assert.deepEqual(changed, [[9, 'DUMPER7_ASSERTS_FMassActorFragment;', '//DUMPER7_ASSERTS_FMassActorFragment;']]);
});

test('a call that is already commented out is left alone, so a second run changes nothing', () => {
  const once = commentOut(HEADER, findUnbuildableAsserts(HEADER));
  assert.deepEqual(findUnbuildableAsserts(once), []);
});

test('CRLF files are matched and keep their CRLF', () => {
  const crlf = HEADER.replace(/\n/g, '\r\n');
  const found = findUnbuildableAsserts(crlf);
  assert.deepEqual(found, [{ line: 9, name: 'FMassActorFragment' }]);
  const out = commentOut(crlf, found);
  assert.equal(out, crlf.replace('\r\nDUMPER7_ASSERTS_FMassActorFragment;\r\n', '\r\n//DUMPER7_ASSERTS_FMassActorFragment;\r\n'));
});

test('an assert call for another name, or none, is not touched', () => {
  const other = HEADER.replace('DUMPER7_ASSERTS_FMassActorFragment;', 'DUMPER7_ASSERTS_FSomethingElse;');
  assert.deepEqual(findUnbuildableAsserts(other), []);
  assert.deepEqual(findUnbuildableAsserts(HEADER.replace('DUMPER7_ASSERTS_FMassActorFragment;\n', '')), []);
});

function sdkDir(files) {
  const root = mkdtempSync(join(tmpdir(), 'sdk-asserts-'));
  mkdirSync(join(root, 'SDK'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, 'SDK', name), content, 'latin1');
  return root;
}

test('fixSdk edits only *_structs.hpp, keeps the BOM and the CRLF, and reports file:line', () => {
  const body = '﻿#pragma once\r\n' + HEADER.replace(/\n/g, '\r\n');
  const root = sdkDir({ 'MassActors_structs.hpp': Buffer.from(body, 'utf8').toString('latin1'), 'MassActors_classes.hpp': HEADER });
  try {
    const before = readFileSync(join(root, 'SDK', 'MassActors_structs.hpp'));
    const changes = fixSdk(root);
    assert.deepEqual(changes, [{ file: 'SDK/MassActors_structs.hpp', line: 10, name: 'FMassActorFragment' }]);
    const after = readFileSync(join(root, 'SDK', 'MassActors_structs.hpp'));
    assert.equal(after.length, before.length + 2);
    assert.equal(after.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.equal(readFileSync(join(root, 'SDK', 'MassActors_classes.hpp'), 'latin1'), HEADER, 'a classes header is not read');
    assert.deepEqual(fixSdk(root), [], 'a second run finds nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('more matches than the cap fails and writes nothing', () => {
  const many = Array.from({ length: 4 }, (_, i) => HEADER.replaceAll('FMassActorFragment', `FMassActorFragment${i}`)).join('\n');
  const root = sdkDir({ 'A_structs.hpp': many });
  try {
    assert.throws(() => fixSdk(root, 3), /4 asserts match, more than the 3 expected/);
    assert.equal(readFileSync(join(root, 'SDK', 'A_structs.hpp'), 'latin1'), many);
    assert.equal(fixSdk(root, 4).length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a folder with no SDK dir or no structs headers fails instead of passing quietly', () => {
  const empty = mkdtempSync(join(tmpdir(), 'sdk-asserts-'));
  const noStructs = sdkDir({ 'A_classes.hpp': HEADER });
  try {
    assert.throws(() => fixSdk(empty), /does not exist/);
    assert.throws(() => fixSdk(noStructs), /no \*_structs\.hpp/);
  } finally { rmSync(empty, { recursive: true, force: true }); rmSync(noStructs, { recursive: true, force: true }); }
});

test('the command line prints each changed line and exits 0; over the cap it exits 1', () => {
  const root = sdkDir({ 'MassActors_structs.hpp': HEADER });
  try {
    const run = (...args) => spawnSync(process.execPath, [join(here, 'sdk-asserts.mjs'), ...args], { encoding: 'utf8', windowsHide: true });
    const over = run(root, '--max', '0');
    assert.equal(over.status, 1);
    assert.match(over.stderr, /::error title=sdk asserts::1 asserts match, more than the 0 expected/);
    const ok = run(root);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /commented out SDK\/MassActors_structs\.hpp:9 DUMPER7_ASSERTS_FMassActorFragment\n/);
    assert.match(ok.stdout, /sdk asserts: 1 commented out/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
