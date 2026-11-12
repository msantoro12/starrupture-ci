// Tests for ci/symbol-lookup.mjs.
//
//   node --test ci/symbol-lookup.test.mjs
//
// The pure parts (the inputs, the PDB listing, the name matching, the address arithmetic, the
// output) run on text and bytes built here. The lookup runs on a made-up install: an exe with a
// section table, a PDB stand-in and a manifest, with the PDB dump and the undecorator replaced.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BYTES, MAX_BYTES, MAX_LISTED, artifactName, buildResult, clOf, createPublicsParser, findPdbutil, hex8, hexBytes,
  locate, lookup, matchKind, parseBranch, parseBytes, parseManifest, parseSymbol, readPublics, readSections, renderSummary,
  renderText, templateMatches, undecorate,
} from './symbol-lookup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'symbol-lookup.mjs');

// ---- the inputs --------------------------------------------------------------------------------

test('parseSymbol: a name, or a qualified name, and nothing else', () => {
  assert.deepEqual(parseSymbol('LoadPackageAsync'), { text: 'LoadPackageAsync', parts: ['LoadPackageAsync'] });
  assert.deepEqual(parseSymbol('  FStreamableManager::RequestAsyncLoad '), { text: 'FStreamableManager::RequestAsyncLoad', parts: ['FStreamableManager', 'RequestAsyncLoad'] });
  assert.deepEqual(parseSymbol('_x1').parts, ['_x1']);
  for (const bad of ['', '   ', '1abc', 'a b', 'a;b', 'a|b', 'a&b', 'a$(x)', 'a`b`', 'a"b', "a'b", 'a\nb', 'a\r\nb', 'a::', '::a', 'a:::b', 'a:b', 'a-b', 'a.b', 'a<b>', 'a%0Ab', '${{ secrets.X }}', '../x', 'a\\b', 'é', 'x'.repeat(201)]) {
    assert.throws(() => parseSymbol(bad), /symbol must be/, JSON.stringify(bad));
  }
  assert.throws(() => parseSymbol(undefined), /symbol must be/);
  assert.equal(parseSymbol('x'.repeat(200)).text.length, 200);
});

test('parseSymbol: a rejected value is shown as one quoted, shortened line', () => {
  try {
    parseSymbol(`a\n::error::injected ${'z'.repeat(100)}`);
    assert.fail('should throw');
  } catch (e) {
    assert.ok(!e.message.includes('\n'));
    assert.ok(e.message.includes('\\n'));
    assert.ok(e.message.length < 200);
  }
});

test('parseBytes: blank is the default, over the cap is the cap, anything else is refused', () => {
  assert.equal(parseBytes(''), DEFAULT_BYTES);
  assert.equal(parseBytes(undefined), DEFAULT_BYTES);
  assert.equal(parseBytes(' 32 '), 32);
  assert.equal(parseBytes('1'), 1);
  assert.equal(parseBytes('256'), MAX_BYTES);
  assert.equal(parseBytes('257'), MAX_BYTES);
  assert.equal(parseBytes('9999'), MAX_BYTES);
  for (const bad of ['0', '-1', '1.5', '1e3', 'abc', '12345', '0x10', '1;2', '10\n20']) assert.throws(() => parseBytes(bad), /bytes must be/, bad);
});

test('parseBranch: letters, digits and underscore only', () => {
  assert.equal(parseBranch('public'), 'public');
  assert.equal(parseBranch(' public_test_branch '), 'public_test_branch');
  for (const bad of ['', 'a b', 'a-b', 'a/b', 'a;b', '$(x)', 'a\nb', 'x'.repeat(65)]) assert.throws(() => parseBranch(bad), /branch must be/, JSON.stringify(bad));
});

test('artifactName: no colon, so the upload accepts it', () => {
  assert.equal(artifactName('public', 'LoadPackageAsync'), 'symbol-lookup-public-LoadPackageAsync');
  assert.equal(artifactName('public', 'A::B'), 'symbol-lookup-public-A.B');
  assert.ok(!artifactName('public', 'A::B::C').includes(':'));
});

// ---- the name matching -------------------------------------------------------------------------

const P = (s) => s.split('::');

test('matchKind: a free or member function of that name, or a template, by the decorated prefix', () => {
  // A free function and a member of some class both start ?Name@.
  assert.equal(matchKind('?LoadPackageAsync@@YAXPEAUFName@@@Z', P('LoadPackageAsync')), 'function');
  assert.equal(matchKind('?LoadPackageAsync@UE@@SAHXZ', P('LoadPackageAsync')), 'function');
  assert.equal(matchKind('??$LoadPackageAsync@H@@YAXXZ', P('LoadPackageAsync')), 'template');
  // Another name that only begins with the same letters, or merely contains the name.
  assert.equal(matchKind('?LoadPackageAsyncFoo@@YAXXZ', P('LoadPackageAsync')), null);
  assert.equal(matchKind('?DoLoadPackageAsync@@YAXXZ', P('LoadPackageAsync')), null);
  assert.equal(matchKind('??$LoadPackageAsyncFoo@H@@YAXXZ', P('LoadPackageAsync')), null);
  assert.equal(matchKind('??0LoadPackageAsync@@QEAA@XZ', P('LoadPackageAsync')), null, 'a constructor is not the function');
  assert.equal(matchKind('_LoadPackageAsync', P('LoadPackageAsync')), null);
  assert.equal(matchKind('LoadPackageAsync', P('LoadPackageAsync')), null);
  assert.equal(matchKind('?x@@3HA', P('LoadPackageAsync')), null);
});

test('matchKind: a qualified name must match the scope, innermost scope first', () => {
  assert.equal(matchKind('?Tick@UWorld@@UEAAXM@Z', P('UWorld::Tick')), 'function');
  assert.equal(matchKind('?Tick@AActor@@UEAAXM@Z', P('UWorld::Tick')), null);
  assert.equal(matchKind('?Tick@UWorld@Inner@@UEAAXM@Z', P('Inner::UWorld::Tick')), 'function', 'the scopes are innermost first');
  assert.equal(matchKind('?Tick@UWorld@Inner@@UEAAXM@Z', P('UWorld::Inner::Tick')), null);
  assert.equal(matchKind('?Tick@Inner@Outer@@UEAAXM@Z', P('Outer::Inner::Tick')), 'function');
  assert.equal(matchKind('?Tick@UWorldX@@UEAAXM@Z', P('UWorld::Tick')), null);
});

test('templateMatches: judged on the undecorated text, scope included', () => {
  assert.equal(templateMatches('void __cdecl LoadPackageAsync<int>(int)', P('LoadPackageAsync')), true);
  assert.equal(templateMatches('public: void __thiscall UE::LoadPackageAsync<int>(int)', P('LoadPackageAsync')), true);
  assert.equal(templateMatches('void __cdecl DoLoadPackageAsync<int>(int)', P('LoadPackageAsync')), false);
  assert.equal(templateMatches('void __cdecl Other<int>(int)', P('LoadPackageAsync')), false);
  assert.equal(templateMatches('public: void __thiscall UWorld::Tick<float>(float)', P('UWorld::Tick')), true);
  assert.equal(templateMatches('public: void __thiscall AActor::Tick<float>(float)', P('UWorld::Tick')), false);
  assert.equal(templateMatches('', P('x')), false);
});

// ---- the PDB's public symbols ------------------------------------------------------------------

const DUMP = [
  'Summary for C:\\x\\game.pdb',
  '                  Mod Index: 1',
  '                  Publics',
  '============================================================',
  '  21480 | S_PUB32 [size = 56] `?LoadPackageAsync@@YAHPEAUFName@@@Z`',
  '          flags = code | function, addr = 0001:0012345',
  '  21536 | S_PUB32 [size = 48] `?LoadPackageAsync@UE@@SAHXZ`',
  '          flags = function, addr = 0002:0000016',
  '  21584 | S_PUB32 [size = 60] `??$LoadPackageAsync@H@@YAXH@Z`',
  '          flags = code, addr = 0001:0099999',
  '  21644 | S_PUB32 [size = 40] `?LoadPackageAsync@@3HA`',
  '          flags = none, addr = 0003:0000008',
  '  21684 | S_PUB32 [size = 40] `?Other@@YAXXZ`',
  '          flags = code | function, addr = 0001:0000100',
  '  21724 | S_PUB32 [size = 40] `?LoadPackageAsyncMore@@YAXXZ`',
  '          flags = code | function, addr = 0001:0000200',
  '  21764 | S_PUB32 [size = 40] `?LoadPackageAsync@@YAXXZ`',
  'a line the dump has that is not a record',
  '  21804 | S_PUB32 [size = 40] `?LoadPackageAsync@@YAXH@Z`',
  '          flags = code | function, addr = 0001:0000300',
].join('\n');

test('createPublicsParser: keeps the matching code symbols and counts every record', () => {
  const p = createPublicsParser(P('LoadPackageAsync'));
  for (const line of DUMP.split('\n')) p.feed(line);
  const { seen, matches } = p.result();
  assert.equal(seen, 8);
  assert.deepEqual(matches, [
    { decorated: '?LoadPackageAsync@@YAHPEAUFName@@@Z', kind: 'function', segment: 1, offset: 12345 },
    { decorated: '?LoadPackageAsync@UE@@SAHXZ', kind: 'function', segment: 2, offset: 16 },
    { decorated: '??$LoadPackageAsync@H@@YAXH@Z', kind: 'template', segment: 1, offset: 99999 },
    { decorated: '?LoadPackageAsync@@YAXH@Z', kind: 'function', segment: 1, offset: 300 },
  ]);
});

test('createPublicsParser: the offset is read as decimal, as the dump prints it', () => {
  const p = createPublicsParser(P('F'));
  p.feed('      1 | S_PUB32 [size = 40] `?F@@YAXXZ`');
  p.feed('          flags = code | function, addr = 0001:0000010');
  assert.equal(p.result().matches[0].offset, 10);
});

test('createPublicsParser: a record whose flags line is missing does not hang on to the next one', () => {
  const p = createPublicsParser(P('F'));
  p.feed('      1 | S_PUB32 [size = 40] `?F@@YAXXZ`');
  p.feed('      2 | S_PUB32 [size = 40] `?F@@YAXHZ`');
  p.feed('          flags = code, addr = 0001:0000020');
  assert.deepEqual(p.result().matches.map((m) => m.decorated), ['?F@@YAXHZ']);
});

function fakeChild(stdoutText, { code = 0, stderrText = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = Readable.from([Buffer.from(stdoutText)]);
  child.stderr = Readable.from(stderrText ? [Buffer.from(stderrText)] : []);
  child.kill = () => {};
  child.stdout.on('end', () => setImmediate(() => child.emit('close', code)));
  return child;
}

test('readPublics: feeds the dump through the parser and runs llvm-pdbutil on the PDB without a shell', async () => {
  let seenArgs;
  const spawnFn = (cmd, args, opts) => { seenArgs = { cmd, args, opts }; return fakeChild(DUMP); };
  const r = await readPublics('C:\\llvm\\llvm-pdbutil.exe', 'C:\\x\\game.pdb', P('LoadPackageAsync'), { spawnFn });
  assert.equal(r.seen, 8);
  assert.equal(r.matches.length, 4);
  assert.deepEqual(seenArgs.args, ['dump', '-publics', 'C:\\x\\game.pdb']);
  assert.ok(!seenArgs.opts.shell, 'no shell');
  assert.equal(seenArgs.opts.windowsHide, true);
});

test('readPublics: a failed tool run, or a dump with no records, is an error and never a "no match"', async () => {
  await assert.rejects(readPublics('x', 'p', P('F'), { spawnFn: () => fakeChild(DUMP, { code: 1, stderrText: 'boom: bad pdb\n' }) }), /exited with 1.*boom: bad pdb/);
  await assert.rejects(readPublics('x', 'p', P('F'), { spawnFn: () => fakeChild('nothing here\n') }), /no public symbols/);
  const failing = () => { const c = new EventEmitter(); c.stdout = Readable.from([]); c.stderr = Readable.from([]); c.kill = () => {}; setImmediate(() => c.emit('error', new Error('spawn ENOENT'))); return c; };
  await assert.rejects(readPublics('x', 'p', P('F'), { spawnFn: failing }), /ENOENT/);
});

// ---- the exe: sections, addresses, bytes ---------------------------------------------------------

// A PE header with the given sections: [{ name, virtualAddress, virtualSize, rawPointer, rawSize }].
function peHeader(sections, { optionalSize = 240 } = {}) {
  const pe = 0x80;
  const buf = Buffer.alloc(pe + 24 + optionalSize + sections.length * 40 + 16);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(pe, 0x3c);
  buf.writeUInt32LE(0x4550, pe);
  buf.writeUInt16LE(sections.length, pe + 6);
  buf.writeUInt16LE(optionalSize, pe + 20);
  sections.forEach((s, i) => {
    const o = pe + 24 + optionalSize + i * 40;
    buf.write(s.name, o, 8, 'latin1');
    buf.writeUInt32LE(s.virtualSize, o + 8);
    buf.writeUInt32LE(s.virtualAddress, o + 12);
    buf.writeUInt32LE(s.rawSize, o + 16);
    buf.writeUInt32LE(s.rawPointer, o + 20);
  });
  return buf;
}

const SECTIONS = [
  { name: '.text', virtualAddress: 0x1000, virtualSize: 0x2000, rawPointer: 0x400, rawSize: 0x1800 },
  { name: '.rdata', virtualAddress: 0x4000, virtualSize: 0x1000, rawPointer: 0x1c00, rawSize: 0x800 },
  { name: '.bss', virtualAddress: 0x6000, virtualSize: 0x4000, rawPointer: 0, rawSize: 0 },
];

test('readSections: reads the table in file order, 1-based, with names trimmed', () => {
  const s = readSections(peHeader(SECTIONS));
  assert.equal(s.length, 3);
  assert.deepEqual(s[0], { index: 1, name: '.text', virtualSize: 0x2000, virtualAddress: 0x1000, rawSize: 0x1800, rawPointer: 0x400 });
  assert.equal(s[1].name, '.rdata');
  assert.equal(s[2].index, 3);
});

test('readSections: refuses what is not a PE file', () => {
  assert.throws(() => readSections(Buffer.alloc(10)), /MZ/);
  const noPe = peHeader(SECTIONS);
  noPe.writeUInt32LE(0, 0x80);
  assert.throws(() => readSections(noPe), /PE signature/);
  assert.throws(() => readSections(peHeader([])), /section table/);
  assert.throws(() => readSections(peHeader(SECTIONS).subarray(0, 0x200 - 0x100)), /MZ|PE signature|section table/);
});

test('locate: RVA is the section address plus the offset; the file offset is the raw pointer plus the offset', () => {
  const s = readSections(peHeader(SECTIONS));
  const a = locate(s, 1, 0x10, 64);
  assert.equal(a.rva, 0x1010);
  assert.equal(a.fileOffset, 0x410);
  assert.equal(a.available, 64);
  assert.equal(a.section.name, '.text');
  const b = locate(s, 2, 0x20, 64);
  assert.equal(b.rva, 0x4020);
  assert.equal(b.fileOffset, 0x1c20);
});

test('locate: fewer bytes than asked at the end of the section data, none past it, none in a section with no data', () => {
  const s = readSections(peHeader(SECTIONS));
  const end = locate(s, 1, 0x1800 - 10, 64);
  assert.equal(end.available, 10);
  assert.equal(end.fileOffset, 0x400 + 0x1800 - 10);
  const past = locate(s, 1, 0x1800, 64);
  assert.equal(past.fileOffset, null);
  assert.equal(past.available, 0);
  assert.equal(past.rva, 0x2800);
  const bss = locate(s, 3, 4, 64);
  assert.equal(bss.fileOffset, null);
  assert.equal(bss.available, 0);
  assert.equal(bss.rva, 0x6004);
  assert.throws(() => locate(s, 4, 0, 1), /section 4, the exe has 3/);
  assert.throws(() => locate(s, 0, 0, 1), /section 0/);
});

test('hexBytes and hex8: upper-case pairs, eight digits', () => {
  assert.equal(hexBytes(Buffer.from([0x48, 0x89, 0x5c, 0x24, 0x08, 0x00, 0xff])), '48 89 5C 24 08 00 FF');
  assert.equal(hexBytes(Buffer.alloc(0)), '');
  assert.equal(hex8(0x1a2b), '0x00001A2B');
  assert.equal(hex8(0), '0x00000000');
  assert.equal(hex8(0x1234abcd), '0x1234ABCD');
});

// ---- the build -------------------------------------------------------------------------------

const ACF = `"AppState"
{
\t"appid"\t\t"1631270"
\t"buildid"\t\t"26461198"
\t"UserConfig"
\t{
\t\t"BetaKey"\t\t"other"
\t}
\t"MountedConfig"
\t{
\t\t"BetaKey"\t\t"public"
\t\t"language"\t\t"english"
\t}
}`;

test('parseManifest: the build id and the mounted branch, not the user config', () => {
  assert.deepEqual(parseManifest(ACF), { buildid: '26461198', betaKey: 'public' });
  assert.deepEqual(parseManifest('"AppState" { }'), { buildid: '', betaKey: '' });
});

test('clOf: the changelist out of the product version', () => {
  assert.equal(clOf('++Earth20+Neon-CL-123456'), '123456');
  assert.equal(clOf('1.0.0.0'), '');
  assert.equal(clOf(undefined), '');
});

// ---- the output ------------------------------------------------------------------------------

const BUILD = { buildid: '26461198', cl: '123456', productVersion: '++Earth20+Neon-CL-123456', betaKey: 'public' };
const EXE = { path: 'StarRupture\\Binaries\\Win64\\StarRuptureGameSteam-Win64-Shipping.exe', size: 123456789, sha256: 'ab'.repeat(32) };
const PDB = { name: 'StarRupture\\Binaries\\Win64\\StarRuptureGameSteam-Win64-Shipping.pdb', size: 2400000000 };
const listed = (n) => Array.from({ length: n }, (_, i) => ({
  decorated: `?F${i}@@YAXXZ`, undecorated: `void __cdecl F${i}(void)`, kind: 'function', rva: hex8(0x1000 + i), fileOffset: hex8(0x400 + i),
  section: { index: 1, name: '.text' }, bytesRead: 3, bytes: '48 89 5C',
}));

test('buildResult and renderText: a result with matches lists each one with its address and bytes', () => {
  const l = listed(2);
  const r = buildResult({ symbol: 'F', branch: 'public', bytes: 64, build: BUILD, exe: EXE, pdb: PDB, seen: 1000, matches: [1, 2], listed: l });
  assert.equal(r.status, 'ok');
  assert.equal(r.matchCount, 2);
  assert.equal(r.listedCount, 2);
  const text = renderText(r);
  assert.match(text, /Symbol lookup: F/);
  assert.match(text, /Branch public, build 26461198, CL-123456/);
  assert.match(text, new RegExp(`SHA-256 ${'ab'.repeat(32)}`));
  assert.match(text, /Matches: 2\n/);
  assert.match(text, /1\. void __cdecl F0\(void\)\n {3}decorated {2}\?F0@@YAXXZ\n {3}RVA 0x00001000 {3}file offset 0x00000400 {3}section \.text \(1\)\n {3}bytes \(3\) 48 89 5C/);
  assert.match(text, /2\. void __cdecl F1\(void\)/);
});

test('renderText: a name with no match is a result, said as one', () => {
  const r = buildResult({ symbol: 'Nope', branch: 'public', bytes: 64, build: BUILD, exe: EXE, pdb: PDB, seen: 1000, matches: [], listed: [] });
  assert.equal(r.status, 'no-match');
  assert.equal(r.matchCount, 0);
  const text = renderText(r);
  assert.match(text, /No match: none of the 1000 public symbols is a function or member function named Nope\. This is a result, not a failure\./);
  assert.ok(!/Matches:/.test(text));
});

test('renderText: says when the list is cut, and when a match has no bytes in the file', () => {
  const l = listed(1);
  l[0].fileOffset = null;
  l[0].bytesRead = 0;
  l[0].bytes = '';
  l[0].undecorated = '';
  const r = buildResult({ symbol: 'F', branch: 'public', bytes: 64, build: BUILD, exe: EXE, pdb: PDB, seen: 5, matches: new Array(900), listed: l });
  const text = renderText(r);
  assert.match(text, /Matches: 900 \(the first 1 are listed\)/);
  assert.match(text, /file offset none \(past the section data in the file\)/);
  assert.match(text, /dbghelp could not undecorate this name/);
});

test('renderSummary: a heading line and the text in a code block; no secret-shaped input is needed to make it', () => {
  const r = buildResult({ symbol: 'F', branch: 'public', bytes: 64, build: BUILD, exe: EXE, pdb: PDB, seen: 7, matches: [1], listed: listed(1) });
  const md = renderSummary(r);
  assert.match(md, /^### Symbol lookup: `F`\n/);
  assert.match(md, /1 match among 7 public symbols/);
  assert.equal(md.match(/```/g).length, 2);
});

// ---- the tools -------------------------------------------------------------------------------

test('findPdbutil: PATH first, then the LLVM folder of Program Files; an error when it is nowhere', () => {
  const have = (set) => (p) => set.has(p);
  const onPath = join('tools', 'llvm-pdbutil.exe');
  assert.equal(findPdbutil({ PATH: ['a', 'tools'].join(delimiter) }, have(new Set([onPath]))), onPath);
  const fallback = join('PF', 'LLVM', 'bin', 'llvm-pdbutil.exe');
  assert.equal(findPdbutil({ PATH: 'a', ProgramFiles: 'PF' }, have(new Set([fallback]))), fallback);
  assert.throws(() => findPdbutil({ PATH: 'a', ProgramFiles: 'PF' }, () => false), /llvm-pdbutil was not found/);
});

test('undecorate: names go in on standard input, never on a command line; the answer is the last line', () => {
  let call;
  const run = (cmd, args, opts) => { call = { cmd, args, opts }; return { status: 0, stdout: 'WARNING noise\n["void __cdecl A(int)",""]\n', stderr: '' }; };
  const names = ['?A@@YAXH@Z', '?B@@YAXXZ'];
  assert.deepEqual(undecorate(names, { run, script: 'x.ps1' }), ['void __cdecl A(int)', '']);
  assert.equal(call.opts.input, '?A@@YAXH@Z\n?B@@YAXXZ\n');
  assert.ok(!call.args.some((a) => a.includes('?A@')), 'no name on the command line');
  assert.ok(!call.opts.shell);
  assert.equal(call.opts.windowsHide, true);
  assert.deepEqual(undecorate([], { run: () => assert.fail('not called') }), []);
  assert.throws(() => undecorate(names, { run: () => ({ status: 1, stdout: '', stderr: 'bad\nmore' }) }), /undecorating failed: bad/);
  assert.throws(() => undecorate(names, { run: () => ({ status: 0, stdout: '["only one"]', stderr: '' }) }), /wrong number/);
  assert.throws(() => undecorate(names, { run: () => ({ error: new Error('ENOENT') }) }), /ENOENT/);
});

// ---- the lookup, on a made-up install ----------------------------------------------------------

function makeInstall({ betaKey = 'public', buildid = '26461198' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'symlook-'));
  const bin = join(dir, 'StarRupture', 'Binaries', 'Win64');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, 'Engine', 'Binaries', 'Win64'), { recursive: true });
  writeFileSync(join(dir, 'Engine', 'Binaries', 'Win64', 'Other-Win64-Shipping.exe'), 'not this one');
  mkdirSync(join(dir, 'steamapps'), { recursive: true });
  writeFileSync(join(dir, 'steamapps', 'appmanifest_1631270.acf'), ACF.replace('26461198', buildid).replace('"BetaKey"\t\t"public"', `"BetaKey"\t\t"${betaKey}"`));
  // File: header (0x400 bytes), then .text data (0x1800), then .rdata (0x800).
  const exe = Buffer.alloc(0x400 + 0x1800 + 0x800, 0xcc);
  peHeader(SECTIONS).copy(exe);
  for (let i = 0; i < 0x1800; i++) exe[0x400 + i] = i & 0xff;
  writeFileSync(join(bin, 'StarRuptureGameSteam-Win64-Shipping.exe'), exe);
  writeFileSync(join(bin, 'StarRuptureGameSteam-Win64-Shipping.pdb'), 'pdb');
  return dir;
}

const stubs = (matches, undecorated) => ({
  readPublics: async () => ({ seen: 4321, matches }),
  undecorate: (names) => names.map((n) => undecorated[n] ?? ''),
  productVersion: () => '++Earth20+Neon-CL-123456',
});

test('lookup: finds each overload, sorted by address, with its RVA, file offset, section and bytes', async () => {
  const dir = makeInstall();
  try {
    const matches = [
      { decorated: '?F@@YAXH@Z', kind: 'function', segment: 1, offset: 0x300 },
      { decorated: '?F@@YAXXZ', kind: 'function', segment: 1, offset: 0x100 },
      { decorated: '?F@C@@SAXXZ', kind: 'function', segment: 2, offset: 0x20 },
    ];
    const io = stubs(matches, { '?F@@YAXH@Z': 'void __cdecl F(int)', '?F@@YAXXZ': 'void __cdecl F(void)', '?F@C@@SAXXZ': 'public: static void __cdecl C::F(void)' });
    const r = await lookup({ installDir: dir, branch: 'public', symbol: parseSymbol('F'), bytes: 4 }, io);
    assert.equal(r.status, 'ok');
    assert.equal(r.matchCount, 3);
    assert.equal(r.publicSymbolsRead, 4321);
    assert.deepEqual(r.build, { buildid: '26461198', cl: '123456', productVersion: '++Earth20+Neon-CL-123456', betaKey: 'public' });
    assert.equal(r.exe.size, 0x400 + 0x1800 + 0x800);
    assert.match(r.exe.sha256, /^[0-9a-f]{64}$/);
    assert.equal(r.exe.path, join('StarRupture', 'Binaries', 'Win64', 'StarRuptureGameSteam-Win64-Shipping.exe'));
    assert.equal(r.pdb.size, 3);
    assert.deepEqual(r.matches.map((m) => m.undecorated), ['void __cdecl F(void)', 'void __cdecl F(int)', 'public: static void __cdecl C::F(void)']);
    const [a, b, c] = r.matches;
    assert.equal(a.rva, '0x00001100');
    assert.equal(a.fileOffset, '0x00000500');
    assert.deepEqual(a.section, { index: 1, name: '.text' });
    assert.equal(a.bytes, '00 01 02 03', 'bytes are the exe\'s own, from the file offset');
    assert.equal(a.bytesRead, 4);
    assert.equal(b.rva, '0x00001300');
    assert.equal(b.bytes, '00 01 02 03');
    assert.equal(c.rva, '0x00004020');
    assert.equal(c.fileOffset, '0x00001C20');
    assert.equal(c.bytes, 'CC CC CC CC');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lookup: bytes follow the request and stop at the end of the section data', async () => {
  const dir = makeInstall();
  try {
    const io = stubs([{ decorated: '?F@@YAXXZ', kind: 'function', segment: 1, offset: 0x1800 - 3 }], { '?F@@YAXXZ': 'void __cdecl F(void)' });
    const r = await lookup({ installDir: dir, branch: 'public', symbol: parseSymbol('F'), bytes: 64 }, io);
    assert.equal(r.matches[0].bytesRead, 3);
    assert.equal(r.matches[0].bytes.split(' ').length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lookup: a symbol in a section with no data in the file has an RVA and no file offset or bytes', async () => {
  const dir = makeInstall();
  try {
    const io = stubs([{ decorated: '?F@@3HA', kind: 'function', segment: 3, offset: 8 }], { '?F@@3HA': 'int F' });
    const r = await lookup({ installDir: dir, branch: 'public', symbol: parseSymbol('F'), bytes: 16 }, io);
    assert.equal(r.matches[0].rva, '0x00006008');
    assert.equal(r.matches[0].fileOffset, null);
    assert.equal(r.matches[0].bytes, '');
    assert.equal(r.matches[0].bytesRead, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lookup: a template is kept only when its undecorated name carries the scope; a plain match is kept as it is', async () => {
  const dir = makeInstall();
  try {
    const matches = [
      { decorated: '??$F@H@C@@QEAAXH@Z', kind: 'template', segment: 1, offset: 16 },
      { decorated: '??$F@H@D@@QEAAXH@Z', kind: 'template', segment: 1, offset: 32 },
      { decorated: '?F@C@@QEAAXXZ', kind: 'function', segment: 1, offset: 48 },
    ];
    const io = stubs(matches, { '??$F@H@C@@QEAAXH@Z': 'public: void __cdecl C::F<int>(int)', '??$F@H@D@@QEAAXH@Z': 'public: void __cdecl D::F<int>(int)', '?F@C@@QEAAXXZ': 'public: void __cdecl C::F(void)' });
    const r = await lookup({ installDir: dir, branch: 'public', symbol: parseSymbol('C::F'), bytes: 2 }, io);
    assert.deepEqual(r.matches.map((m) => m.decorated), ['??$F@H@C@@QEAAXH@Z', '?F@C@@QEAAXXZ']);
    assert.equal(r.matchCount, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lookup: no match is a result with a zero count', async () => {
  const dir = makeInstall();
  try {
    const r = await lookup({ installDir: dir, branch: 'public', symbol: parseSymbol('Nope'), bytes: 8 }, stubs([], {}));
    assert.equal(r.status, 'no-match');
    assert.equal(r.matchCount, 0);
    assert.deepEqual(r.matches, []);
    assert.equal(r.publicSymbolsRead, 4321);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lookup: lists at most MAX_LISTED, counts them all', async () => {
  const dir = makeInstall();
  try {
    const matches = Array.from({ length: MAX_LISTED + 25 }, (_, i) => ({ decorated: `?F@@YAXH${i}@Z`, kind: 'function', segment: 1, offset: i }));
    const r = await lookup({ installDir: dir, branch: 'public', symbol: parseSymbol('F'), bytes: 1 }, stubs(matches, {}));
    assert.equal(r.matchCount, MAX_LISTED + 25);
    assert.equal(r.listedCount, MAX_LISTED);
    assert.equal(r.matches.length, MAX_LISTED);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lookup: refuses an install of another branch, and one with no PDB', async () => {
  let dir = makeInstall({ betaKey: 'other_branch' });
  try {
    await assert.rejects(lookup({ installDir: dir, branch: 'public', symbol: parseSymbol('F'), bytes: 1 }, stubs([], {})), /build 26461198 of branch "other_branch", not branch public/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  dir = makeInstall();
  try {
    rmSync(join(dir, 'StarRupture', 'Binaries', 'Win64', 'StarRuptureGameSteam-Win64-Shipping.pdb'));
    await assert.rejects(lookup({ installDir: dir, branch: 'public', symbol: parseSymbol('F'), bytes: 1 }, stubs([], {})), /no PDB next to/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the command line --------------------------------------------------------------------------

function cli(args, env) {
  const dir = mkdtempSync(join(tmpdir(), 'symcli-'));
  const out = join(dir, 'github_output');
  writeFileSync(out, '');
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env } });
  const outputs = readFileSync(out, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { ...r, outputs };
}

test('check: valid inputs write the artifact name and the byte count to the step outputs', () => {
  const r = cli(['check'], { SYMBOL: 'LoadPackageAsync', BYTES: '64', BRANCH: 'public' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs, 'artifact_name=symbol-lookup-public-LoadPackageAsync\nbytes=64\n');
  const q = cli(['check'], { SYMBOL: 'A::B', BYTES: '', BRANCH: 'public_test_branch' });
  assert.equal(q.outputs, 'artifact_name=symbol-lookup-public_test_branch-A.B\nbytes=64\n');
});

test('check: bytes over the cap are capped with a notice', () => {
  const r = cli(['check'], { SYMBOL: 'F', BYTES: '5000', BRANCH: 'public' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /::notice title=Symbol lookup::bytes is capped at 256/);
  assert.match(r.outputs, /bytes=256\n/);
});

test('check: a bad input fails with one error line and writes nothing to the step outputs', () => {
  for (const env of [
    { SYMBOL: 'F; rm -rf /', BYTES: '64', BRANCH: 'public' },
    { SYMBOL: 'F\n::set-env name=X::y', BYTES: '64', BRANCH: 'public' },
    { SYMBOL: 'F', BYTES: '64\nfoo=bar', BRANCH: 'public' },
    { SYMBOL: 'F', BYTES: '64', BRANCH: 'public\nbar=baz' },
    { SYMBOL: '', BYTES: '64', BRANCH: 'public' },
  ]) {
    const r = cli(['check'], env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.equal(r.outputs, '', 'nothing written');
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `one line: ${JSON.stringify(r.stdout)}`);
    assert.match(lines[0], /^::error title=Symbol lookup::/);
  }
});

test('an unknown command is a usage error', () => {
  const r = cli(['nope'], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test('run: a failure still leaves a result.json that says failed, with the reason on one line', () => {
  const out = mkdtempSync(join(tmpdir(), 'symrun-'));
  try {
    const r = cli(['run'], { SYMBOL: 'F', BRANCH: 'public', BYTES: '8', OUT_DIR: join(out, 'o'), INSTALL_DIR: join(out, 'missing') });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^::error title=Symbol lookup::/);
    const j = JSON.parse(readFileSync(join(out, 'o', 'result.json'), 'utf8'));
    assert.equal(j.status, 'failed');
    assert.equal(j.symbol, 'F');
    assert.ok(!j.reason.includes('\n'));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// ---- the workflow text -------------------------------------------------------------------------

const wfDir = join(here, '..', '.github', 'workflows');
const wfRaw = readFileSync(join(wfDir, 'sr-symbol-lookup.yml'), 'utf8').replace(/\r\n/g, '\n');
const wf = wfRaw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
// The steps as { name, text }, split at the six-space dashes under steps:.
const steps = wf.slice(wf.indexOf('\n    steps:\n') + 12).split(/\n(?= {6}- )/).map((text) => ({ name: /name: (.*)/.exec(text)?.[1] ?? text.trim().split('\n')[0], text }));
const step = (name) => {
  const s = steps.find((x) => x.name === name);
  assert.ok(s, `step "${name}" exists`);
  return s.text;
};
const indexOfStep = (name) => steps.findIndex((x) => x.name === name);

test('workflow: dispatch only, read-only, no needs, called by nothing', () => {
  const on = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\npermissions:'));
  assert.match(on, /^\non:\n {2}workflow_dispatch:\n/);
  assert.ok(!/(pull_request|push|schedule|workflow_call|workflow_run|repository_dispatch)\s*:/.test(on), 'no other trigger');
  assert.match(wf, /\npermissions: \{\}\n/, 'nothing granted at the top');
  assert.match(wf, /\n {4}permissions:\n {6}contents: read\n/, 'the job reads the repository and nothing else');
  assert.ok(!/^\s+[\w-]+: (?:write|admin)\s*$/m.test(wf), 'no write permission is named');
  assert.ok(!/\n\s*needs:/.test(wf), 'no needs');
  assert.equal([...wf.slice(wf.indexOf('\njobs:\n')).matchAll(/\n {2}[a-z][\w-]*:\n/g)].length, 1, 'one job');
  for (const f of ['sr-client-check.yml', 'sr-client-rig.yml', 'sr-data-extract.yml', 'sr-watch.yml', 'sr-build-all.yml']) {
    const other = readFileSync(join(wfDir, f), 'utf8');
    assert.ok(!/sr-symbol-lookup/.test(other), `${f} does not call or start the lookup`);
  }
});

test('workflow: the Steam session is the rig\'s: environment steam-client, concurrency group sr-client-rig, never cancelled', () => {
  assert.match(wf, /\n {4}environment: steam-client\n/);
  assert.match(wf, /\n {4}concurrency:\n {6}group: sr-client-rig\n {6}cancel-in-progress: false\n/);
  assert.match(wf, /\n {4}runs-on: windows-latest\n/);
});

test('workflow: an input is data: it only ever reaches a step through env, never a run block', () => {
  for (const line of wf.split('\n')) {
    if (!/\$\{\{\s*(?:inputs|github\.event\.inputs)\./.test(line)) continue;
    assert.match(line, /^(?:run-name: .*|\s+[A-Z_]+: \$\{\{ inputs\.\w+ \}\})$/, `an input outside env: ${line.trim()}`);
  }
  for (const s of steps) {
    const run = s.text.includes('\n        run: ') ? s.text.slice(s.text.indexOf('\n        run: ')) : '';
    assert.ok(!/\$\{\{/.test(run), `${s.name}: no expression inside a run block`);
  }
  const check = step('Check the inputs');
  assert.match(check, /id: inputs\n/);
  assert.match(check, /run: node ci\/symbol-lookup\.mjs check\n?$/);
});

test('workflow: the artifact name and the byte count come from the checked values', () => {
  assert.match(step('Upload the result'), /name: \$\{\{ steps\.inputs\.outputs\.artifact_name \}\}/);
  assert.match(step('Look up the symbol'), /BYTES: \$\{\{ steps\.inputs\.outputs\.bytes \}\}/);
});

test('workflow: the Steam login is given to the install and the leak gate only, by name, and removed before the lookup reads the game', () => {
  const holders = steps.filter((s) => /secrets\./.test(s.text)).map((s) => s.name).sort();
  assert.deepEqual(holders, ['Check the Steam login secrets are set', 'Install the game client', 'Leak gate'].sort());
  assert.ok(!/secrets\.(?!STEAM_CI_USERNAME|STEAM_CI_LOGIN_CACHE)/.test(wf), 'no other secret');
  assert.ok(!/secrets: inherit|toJSON\(secrets\)|\bsecrets\[/.test(wf));
  assert.match(step('Install the game client'), /STEAM_USER: \$\{\{ secrets\.STEAM_CI_USERNAME \}\}\n {10}STEAM_CACHE: \$\{\{ secrets\.STEAM_CI_LOGIN_CACHE \}\}/);
  assert.ok(indexOfStep('Install the game client') < indexOfStep('Remove Steam and the login from the runner'));
  assert.ok(indexOfStep('Remove Steam and the login from the runner') < indexOfStep('Look up the symbol'));
  assert.match(step('Remove Steam and the login from the runner'), /\n {8}if: always\(\)\n/, 'removed on a failed or cancelled run too');
  assert.match(step('Remove Steam and the login from the runner'), /steam-cleanup\.ps1 -InstallDir \$env:INSTALL_DIR -Phase Login/);
  assert.match(step('Look up the symbol'), /\n {8}if: steps\.cleanup\.outcome == 'success'\n/, 'not run when the login stayed behind');
  assert.ok(!/STEAM_/.test(step('Look up the symbol')), 'no login in the lookup step');
});

test('workflow: the leak gate checks the folder before it is uploaded; the Steam folder is removed last, on any outcome', () => {
  assert.match(step('Leak gate'), /leak-gate\.ps1 -Path out -Strict/);
  assert.match(step('Leak gate'), /\n {8}if: always\(\) && steps\.lookup\.outcome != 'skipped'\n/);
  assert.match(step('Upload the result'), /\n {8}if: always\(\) && steps\.leak\.outcome == 'success'\n/);
  assert.match(step('Upload the result'), /path: out\n/);
  assert.match(step('Look up the symbol'), /OUT_DIR: out\n/);
  assert.ok(indexOfStep('Leak gate') < indexOfStep('Upload the result'));
  assert.equal(indexOfStep('Remove the Steam folder'), steps.length - 1);
  assert.match(step('Remove the Steam folder'), /\n {8}if: always\(\)\n/);
  assert.match(step('Remove the Steam folder'), /-Phase Folder\n/);
});

test('workflow: the tools and the helpers are checked before any login', () => {
  const checkAt = indexOfStep('Check the tools and the script helpers');
  assert.ok(checkAt > 0 && checkAt < indexOfStep('Install the game client'));
  const s = step('Check the tools and the script helpers');
  assert.match(s, /node ci\/symbol-lookup\.mjs tools/);
  assert.match(s, /symbol-undecorate\.ps1 -Check/);
  assert.match(s, /client-rig-launch\.ps1 -Check/);
  assert.ok(!/secrets\./.test(s));
});

test('workflow: every action is pinned to a commit, and no step runs a file from the downloaded game', () => {
  for (const m of wf.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
  assert.ok(!/\bInstallDir\b.*\.ps1|& \$env:INSTALL_DIR|Invoke-Expression|iex /i.test(wf));
});

test('workflow and scripts: no text names the non-default Steam branch, except the one value in the choice list', () => {
  const hits = wfRaw.split('\n').filter((l) => /test_branch|public_test/i.test(l));
  assert.deepEqual(hits.map((l) => l.trim()), ['- public_test_branch']);
  for (const f of ['symbol-lookup.mjs', 'symbol-undecorate.ps1']) assert.ok(!/test_branch|public_test/i.test(readFileSync(join(here, f), 'utf8')), f);
});

test('the Steam-busy checks count a lookup', () => {
  const layout = readFileSync(join(wfDir, 'sr-layout-refresh.yml'), 'utf8');
  assert.match(layout, /test\("sr-\(client-check\|client-rig\|data-extract\|symbol-lookup\)\[\.\]yml"\)/);
  assert.match(readFileSync(join(here, 'planner-extract.mjs'), 'utf8'), /STEAM_WORKFLOW = \/sr-\(client-check\|client-rig\|data-extract\|symbol-lookup\)\[\.\]yml\//);
});
