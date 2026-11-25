// Tests for ci/mod-index-intake.mjs. No network: the download layer takes an injected fetch, and every PE here is built
// in this file as bytes. Nothing is ever loaded or run.
//
//   node --test ci/mod-index-intake.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IntakeError, checkAsset, fetchAsset, main, parsePe, readDeclaredInterface, renderMarkdown, renderText, runIntake, selectEntries } from './mod-index-intake.mjs';

const SCRIPT = fileURLToPath(new URL('./mod-index-intake.mjs', import.meta.url));
const IMAGE_BASE = 0x180000000n;
const SECTION_VA = 0x1000;
const SECTION_RAW = 0x200;
const SECTION_SIZE = 0x600;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// A minimal x64 DLL: one section holding the GetPluginInfo stub (lea rax,[rip+disp32]; ret), the PluginInfo table,
// two strings and the export directory.
function buildPe({ machine = 0x8664, characteristics = 0x2022, exports = ['GetPluginInfo', 'PluginInit', 'PluginShutdown'], stub = true, interfaceVersion = 73 } = {}) {
  const b = Buffer.alloc(SECTION_RAW + SECTION_SIZE);
  const rva = (x) => SECTION_VA + x;
  const at = (x) => SECTION_RAW + x;
  b.writeUInt16LE(0x5a4d, 0);
  b.writeUInt32LE(0x40, 0x3c);
  b.writeUInt32LE(0x4550, 0x40);
  b.writeUInt16LE(machine, 0x44);
  b.writeUInt16LE(1, 0x46);
  b.writeUInt16LE(240, 0x54);
  b.writeUInt16LE(characteristics, 0x56);
  const opt = 0x58;
  b.writeUInt16LE(0x20b, opt);
  b.writeBigUInt64LE(IMAGE_BASE, opt + 24);
  b.writeUInt32LE(16, opt + 108);
  b.writeUInt32LE(rva(0x200), opt + 112);
  b.writeUInt32LE(0x100, opt + 116);
  const sec = opt + 240;
  b.write('.all', sec);
  b.writeUInt32LE(SECTION_SIZE, sec + 8);
  b.writeUInt32LE(SECTION_VA, sec + 12);
  b.writeUInt32LE(SECTION_SIZE, sec + 16);
  b.writeUInt32LE(SECTION_RAW, sec + 20);
  // GetPluginInfo stub at 0: lea rax,[rip + (0x40 - 7)] ; ret
  if (stub) { b.set([0x48, 0x8d, 0x05], at(0)); b.writeInt32LE(0x40 - 7, at(3)); b[at(7)] = 0xc3; } else b.fill(0x90, at(0), at(8));
  b[at(0x10)] = 0xc3;
  b[at(0x20)] = 0xc3;
  // PluginInfo table at 0x40
  b.writeBigUInt64LE(IMAGE_BASE + BigInt(rva(0x100)), at(0x40));
  b.writeBigUInt64LE(IMAGE_BASE + BigInt(rva(0x110)), at(0x48));
  b.writeInt32LE(interfaceVersion, at(0x40 + 32));
  b.writeInt32LE(2, at(0x40 + 36));
  b.write('TestPlugin\0', at(0x100), 'latin1');
  b.write('1.2.3\0', at(0x110), 'latin1');
  // export directory at 0x200: functions at 0x240, names at 0x260, ordinals at 0x280, name text at 0x290
  b.writeUInt32LE(exports.length, at(0x200 + 20));
  b.writeUInt32LE(exports.length, at(0x200 + 24));
  b.writeUInt32LE(rva(0x240), at(0x200 + 28));
  b.writeUInt32LE(rva(0x260), at(0x200 + 32));
  b.writeUInt32LE(rva(0x280), at(0x200 + 36));
  let text = 0x290;
  exports.forEach((name, i) => {
    b.writeUInt32LE(rva(name === 'GetPluginInfo' ? 0 : 0x10), at(0x240 + i * 4));
    b.writeUInt32LE(rva(text), at(0x260 + i * 4));
    b.writeUInt16LE(i, at(0x280 + i * 2));
    b.write(`${name}\0`, at(text), 'latin1');
    text += name.length + 1;
  });
  return b;
}
const EXPORT_DIR = SECTION_RAW + 0x200;
const pe = (opts) => buildPe(opts);
const reason = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };

test('parsePe reads machine, DLL flag and the export names of a valid x64 DLL', () => {
  const p = parsePe(pe());
  assert.equal(p.machine, 0x8664);
  assert.equal(p.isDll, true);
  assert.deepEqual([...p.exports.keys()], ['GetPluginInfo', 'PluginInit', 'PluginShutdown']);
});

test('parsePe: x86 machine and a non-DLL are read, not crashed on', () => {
  assert.equal(parsePe(pe({ machine: 0x14c })).machine, 0x14c);
  assert.equal(parsePe(pe({ characteristics: 0x0022 })).isDll, false);
});

test('parsePe refuses truncated and malformed files without throwing anything else', () => {
  const good = pe();
  for (const cut of [0, 10, 63, 0x44, 0x60, 0x150, 0x200, SECTION_RAW + 0x205]) assert.throws(() => parsePe(good.subarray(0, cut)), IntakeError, `cut at ${cut}`);
  const noMz = Buffer.from(good); noMz.writeUInt16LE(0x1234, 0);
  assert.match(reason(() => parsePe(noMz)), /MZ/);
  const noPe = Buffer.from(good); noPe.writeUInt32LE(0, 0x40);
  assert.match(reason(() => parsePe(noPe)), /PE signature/);
  const lfanew = Buffer.from(good); lfanew.writeUInt32LE(0xfffffff0, 0x3c);
  assert.match(reason(() => parsePe(lfanew)), /outside the file/);
  const pe32 = Buffer.from(good); pe32.writeUInt16LE(0x10b, 0x58);
  assert.match(reason(() => parsePe(pe32)), /PE32\+/);
  const sections = Buffer.from(good); sections.writeUInt16LE(5000, 0x46);
  assert.match(reason(() => parsePe(sections)), /5000 sections/);
});

test('parsePe: an export RVA or name table outside the file or sections is a failure', () => {
  const dirRva = Buffer.from(pe()); dirRva.writeUInt32LE(0x900000, 0x58 + 112);
  assert.match(reason(() => parsePe(dirRva)), /export directory is outside/);
  const names = Buffer.from(pe()); names.writeUInt32LE(0x900000, EXPORT_DIR + 32);
  assert.match(reason(() => parsePe(names)), /outside the sections/);
  const oneName = Buffer.from(pe()); oneName.writeUInt32LE(0x900000, SECTION_RAW + 0x260);
  assert.match(reason(() => parsePe(oneName)), /export name is outside/);
  const count = Buffer.from(pe()); count.writeUInt32LE(0x7fffffff, EXPORT_DIR + 24);
  assert.match(reason(() => parsePe(count)), /export names/);
  const ord = Buffer.from(pe()); ord.writeUInt16LE(99, SECTION_RAW + 0x280);
  assert.match(reason(() => parsePe(ord)), /ordinal/);
  const open = Buffer.from(pe()); open.fill(0x41, SECTION_RAW + 0x290, open.length);
  assert.match(reason(() => parsePe(open)), /not terminated/);
});

test('parsePe: zero exports and no export directory give an empty table', () => {
  assert.equal(parsePe(pe({ exports: [] })).exports.size, 0);
  const none = Buffer.from(pe()); none.writeUInt32LE(0, 0x58 + 112);
  assert.equal(parsePe(none).exports.size, 0);
});

test('readDeclaredInterface decodes the lea-rax-ret stub and the PluginInfo table', () => {
  const bytes = pe();
  assert.deepEqual(readDeclaredInterface(bytes, parsePe(bytes)), { interfaceVersion: 73, pluginTarget: 2, name: 'TestPlugin', version: '1.2.3' });
});

test('readDeclaredInterface gives null when the stub is not the expected pattern', () => {
  const bytes = pe({ stub: false });
  assert.equal(readDeclaredInterface(bytes, parsePe(bytes)), null);
  const far = pe(); far.writeInt32LE(0x7ffffff0, SECTION_RAW + 3);
  assert.equal(readDeclaredInterface(far, parsePe(far)), null);
  const noExport = pe({ exports: ['PluginInit'] });
  assert.equal(readDeclaredInterface(noExport, parsePe(noExport)), null);
});

// ---- asset checks ----------------------------------------------------------------------------------------------

const URL0 = 'https://github.com/o/r/releases/download/v1/x.dll';
const entryFor = (bytes, extra = {}) => ({ id: 'x', page_url: 'https://github.com/o/r', download_url: URL0, download_sha256: sha(bytes), download_size: bytes.length, ...extra });
const serve = (bytes) => async () => new Response(bytes, { status: 200 });
const levels = (checks) => checks.map((c) => `${c.level}`);
const failTexts = (checks) => checks.filter((c) => c.level === 'FAIL').map((c) => c.text);

test('checkAsset passes a valid plugin and reads the interface', async () => {
  const bytes = pe();
  const checks = await checkAsset(entryFor(bytes), serve(bytes));
  assert.deepEqual(failTexts(checks), []);
  assert.ok(checks.some((c) => c.level === 'INFO' && /interface 73/.test(c.text)));
  assert.ok(!levels(checks).includes('WARN'));
});

test('checkAsset: a plugin whose interface cannot be read warns and still passes', async () => {
  const bytes = pe({ stub: false });
  const checks = await checkAsset(entryFor(bytes), serve(bytes));
  assert.deepEqual(failTexts(checks), []);
  assert.ok(checks.some((c) => c.level === 'WARN' && /interface not read/.test(c.text)));
});

test('checkAsset fails on a sha256 mismatch and on a size mismatch', async () => {
  const bytes = pe();
  assert.match(failTexts(await checkAsset(entryFor(bytes, { download_sha256: 'a'.repeat(64) }), serve(bytes)))[0], /sha256 is/);
  const short = await checkAsset(entryFor(bytes, { download_size: bytes.length + 10 }), serve(bytes));
  assert.match(failTexts(short)[0], /size is/);
});

test('checkAsset fails an x86 image, a non-DLL, a missing export and zero exports', async () => {
  const cases = [[{ machine: 0x14c }, /not x64/], [{ characteristics: 0x0022 }, /not a DLL/], [{ exports: ['GetPluginInfo', 'PluginInit'] }, /missing required exports: PluginShutdown/], [{ exports: [] }, /missing required exports: GetPluginInfo, PluginInit, PluginShutdown/]];
  for (const [opts, re] of cases) {
    const bytes = pe(opts);
    assert.match(failTexts(await checkAsset(entryFor(bytes), serve(bytes))).join(' '), re);
  }
});

test('checkAsset reports a malformed PE as a failure', async () => {
  const bytes = pe().subarray(0, 100);
  assert.match(failTexts(await checkAsset(entryFor(bytes), serve(bytes)))[0], /not a valid PE/);
});

test('checkAsset lists the optional exports as info', async () => {
  const bytes = pe({ exports: ['GetPluginInfo', 'PluginInit', 'PluginShutdown', 'OnPluginLoadHooks'] });
  const checks = await checkAsset(entryFor(bytes), serve(bytes));
  assert.ok(checks.some((c) => c.level === 'INFO' && /OnPluginLoadHooks/.test(c.text)));
});

// ---- download layer --------------------------------------------------------------------------------------------

test('fetchAsset follows redirects to allowed hosts and returns the bytes', async () => {
  const calls = [];
  const fetchFn = async (u, init) => {
    calls.push([u, init.redirect, init.credentials]);
    if (u.startsWith('https://github.com/')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/a/b?sig=1' } });
    return new Response(Buffer.from('abc'), { status: 200 });
  };
  assert.equal((await fetchAsset(URL0, 3, fetchFn)).toString(), 'abc');
  assert.deepEqual(calls.map((c) => c.slice(1)), [['manual', 'omit'], ['manual', 'omit']]);
});

test('fetchAsset refuses a redirect to another host, to http, with a port, and too many hops', async () => {
  const redirectTo = (location) => async () => new Response(null, { status: 302, headers: { location } });
  for (const [loc, re] of [['https://evil.example/x.dll', /refusing the host evil.example/], ['http://objects.githubusercontent.com/x', /non-https/], ['https://objects.githubusercontent.com:8443/x', /port/], ['https://user@objects.githubusercontent.com/x', /user info/]]) {
    await assert.rejects(fetchAsset(URL0, 3, redirectTo(loc)), re);
  }
  const loop = async () => new Response(null, { status: 302, headers: { location: 'https://github.com/o/r/releases/download/v1/y.dll' } });
  await assert.rejects(fetchAsset(URL0, 3, loop), /redirects/);
});

test('fetchAsset refuses a first URL that is not https://github.com', async () => {
  await assert.rejects(fetchAsset('http://github.com/o/r/releases/download/v1/x.dll', 3, serve(Buffer.from('abc'))), /non-https/);
  await assert.rejects(fetchAsset('https://objects.githubusercontent.com/x', 3, serve(Buffer.from('abc'))), /refusing the host/);
  await assert.rejects(fetchAsset('not a url', 3, serve(Buffer.from('abc'))), /not a URL/);
});

test('fetchAsset stops a body larger than download_size and a Content-Length that says so', async () => {
  const big = async () => new Response(Buffer.alloc(50), { status: 200 });
  await assert.rejects(fetchAsset(URL0, 10, big), /larger than download_size/);
  const claims = async () => new Response(Buffer.alloc(3), { status: 200, headers: { 'content-length': '999999' } });
  await assert.rejects(fetchAsset(URL0, 10, claims), /larger than download_size/);
  assert.equal((await fetchAsset(URL0, 10, async () => new Response(Buffer.alloc(10), { status: 200 }))).length, 10);
});

test('fetchAsset reports a 404, a network error and a redirect without a location', async () => {
  await assert.rejects(fetchAsset(URL0, 3, async () => new Response('', { status: 404 })), /HTTP 404/);
  await assert.rejects(fetchAsset(URL0, 3, async () => { throw new Error('boom'); }), /download failed: boom/);
  await assert.rejects(fetchAsset(URL0, 3, async () => new Response(null, { status: 302 })), /without a location/);
});

test('checkAsset turns a download failure into one FAIL line', async () => {
  const bytes = pe();
  const checks = await checkAsset(entryFor(bytes), async () => new Response('', { status: 404 }));
  assert.deepEqual(levels(checks), ['FAIL']);
});

// ---- selection and the whole run -------------------------------------------------------------------------------

const withIndex = (entries) => `${JSON.stringify(entries, null, 2)}\n`;

test('selectEntries: new and changed entries only, all without a base', () => {
  const a = { id: 'a', page_url: 'p' };
  const b = { id: 'b', page_url: 'p' };
  const bChanged = { id: 'b', page_url: 'q' };
  const c = { id: 'c' };
  assert.deepEqual(selectEntries([a, b, c], null).map((s) => s.entry.id), ['a', 'b', 'c']);
  assert.deepEqual(selectEntries([a, bChanged, c], [a, b]).map((s) => s.entry.id), ['b', 'c']);
  assert.deepEqual(selectEntries([a, b], [a, b]), []);
});

test('runIntake: a good entry passes, a changed bad one fails, an untouched bad one is not looked at', async () => {
  const good = pe();
  const bad = pe({ machine: 0x14c });
  const files = { 'good.dll': good, 'bad.dll': bad };
  const fetchFn = async (u) => new Response(files[u.split('/').pop()], { status: 200 });
  const eGood = { id: 'good', page_url: 'https://github.com/o/r', download_url: 'https://github.com/o/r/releases/download/v1/good.dll', download_sha256: sha(good), download_size: good.length };
  const eBad = { id: 'bad', page_url: 'https://github.com/o/r', download_url: 'https://github.com/o/r/releases/download/v1/bad.dll', download_sha256: sha(bad), download_size: bad.length };
  const eOld = { id: 'old', page_url: 'https://github.com/o/r', download_url: 'https://github.com/o/r/releases/download/v1/missing.dll', download_sha256: 'a'.repeat(64), download_size: 5 };
  const report = await runIntake(withIndex([eOld, eGood, eBad]), withIndex([eOld]), fetchFn);
  assert.equal(report.failed, true);
  assert.deepEqual(report.results.map((r) => [r.who, r.status]), [['entry 2 (good)', 'PASS'], ['entry 3 (bad)', 'FAIL']]);
  assert.equal(report.checked, 2);
  const text = renderText(report);
  assert.match(text, /^PASS entry 2 \(good\)$/m);
  assert.match(text, /^FAIL entry 3 \(bad\)$/m);
  assert.match(renderMarkdown(report), /\| entry 3 \(bad\) \| FAIL \| FAIL: machine is 0x14c/);
});

test('runIntake: an entry with no download passes with a note, a bad entry never reaches the network', async () => {
  let fetched = 0;
  const fetchFn = async () => { fetched++; return new Response('', { status: 404 }); };
  const noDownload = { id: 'n', page_url: 'https://github.com/o/r' };
  const otherRepo = { id: 'o', page_url: 'https://github.com/o/other', download_url: URL0, download_sha256: 'a'.repeat(64), download_size: 5 };
  const alone = await runIntake(withIndex([noDownload]), null, fetchFn);
  assert.deepEqual(alone.results.map((r) => [r.status, r.checks.at(-1).text]), [['PASS', 'no download to check']]);
  const report = await runIntake(withIndex([noDownload, otherRepo]), null, fetchFn);
  assert.deepEqual(report.results.map((r) => r.status), ['FAIL']);
  assert.match(report.results[0].checks[0].text, /entry 2 \(o\): download_url must belong to the repository page_url names/);
  assert.equal(fetched, 0);
});

test('runIntake: an index the signer would refuse is one FAIL', async () => {
  const report = await runIntake('not json\n', null, serve(Buffer.alloc(0)));
  assert.equal(report.failed, true);
  assert.match(report.results[0].checks[0].text, /not valid JSON/);
});

test('output never lets text from the index start a workflow command', async () => {
  const report = { results: [{ who: 'entry 1', status: 'FAIL', checks: [{ level: 'FAIL', text: '::error::x\nsecond' }] }] };
  assert.doesNotMatch(renderText(report), /^\s*::/m);
  assert.doesNotMatch(renderText(report), /::/);
});

// ---- CLI -------------------------------------------------------------------------------------------------------

test('CLI: usage errors exit 2, an index with a failing entry exits 1, a clean index exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'intake-'));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(run().status, 2);
  assert.equal(run('--index').status, 2);
  assert.equal(run('--bogus', 'x').status, 2);
  assert.equal(run('--index', join(dir, 'missing.json')).status, 2);
  const clean = join(dir, 'clean.json');
  writeFileSync(clean, withIndex([{ id: 'n', page_url: 'https://github.com/o/r' }]));
  const summary = join(dir, 'summary.md');
  const ok = run('--index', clean, '--summary', summary);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(summary, 'utf8'), /Mod index intake check/);
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, withIndex([{ id: 'b', page_url: 'https://github.com/o/r', download_url: 'http://example.com/x.dll', download_sha256: 'a'.repeat(64), download_size: 5 }]));
  assert.equal(run('--index', broken).status, 1);
});

test('main returns 0 for an index with nothing new against its base', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'intake-'));
  const f = join(dir, 'i.json');
  writeFileSync(f, withIndex([{ id: 'n', page_url: 'https://github.com/o/r' }]));
  assert.equal(await main(['--index', f, '--base', f]), 0);
});
