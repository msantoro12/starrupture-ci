#!/usr/bin/env node
// Intake check for a pull request that adds or changes a plugin entry in the loader's mod-index/index.json.
//
//   node ci/mod-index-intake.mjs --index <pr index.json> [--base <base index.json>] [--summary <file>]
//
// The whole index first passes the rules of ci/mod-index.mjs (checkBody: page_url and download_url name one repository,
// and the rest); when it does not, that is one FAIL naming the entry. Checked then: every entry that is new or changed
// against --base (all entries without it). Per entry: the release asset is downloaded and read as
// DATA: its size and sha256 match the entry, and it is an x64 PE DLL whose export table has GetPluginInfo, PluginInit
// and PluginShutdown. The declared interface is read from the GetPluginInfo table on a best effort and only warns.
//
// STATIC ONLY. The downloaded bytes are parsed here and never loaded, run or handed to another program. Written for a
// plain pull_request job (read-only token, no secrets); never run it under pull_request_target.
//
// Output: one block per entry on stdout (PASS, FAIL or WARN, with the reason of each check) and, with --summary, the
// same as GitHub step-summary markdown appended to <file>. Exit 0 when nothing failed, 1 on any FAIL, 2 on a usage error.

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { isMain } from './layout-diff.mjs';
import { ModIndexError, checkBody, readIndex } from './mod-index.mjs';

export class IntakeError extends Error {}
const need = (cond, msg) => { if (!cond) throw new IntakeError(msg); };

// ---- download ------------------------------------------------------------------------------------------------------

export const ASSET_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
export const MAX_REDIRECTS = 5;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

// Downloads url as bytes: https only, redirects followed by hand and only to ASSET_HOSTS (the first URL must be
// github.com), no cookies or credentials, at most min(`size`, MAX_DOWNLOAD_BYTES) + 1 bytes read (one more than declared shows an overrun).
export async function fetchAsset(url, size, fetchFn = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const signal = AbortSignal.timeout(timeoutMs);
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u;
    try { u = new URL(target); } catch { throw new IntakeError(`not a URL: ${JSON.stringify(String(target).slice(0, 80))}`); }
    need(u.protocol === 'https:', `refusing a non-https URL (${u.protocol})`);
    need(!u.username && !u.password && !u.port, 'refusing a URL with user info or a port');
    need(hop === 0 ? u.hostname === 'github.com' : ASSET_HOSTS.includes(u.hostname), `refusing the host ${u.hostname}`);
    let res;
    // redirect: 'manual' relies on Node's fetch (undici) returning the real 3xx response, so Location can be checked.
    try {
      res = await fetchFn(u.href, { redirect: 'manual', headers: { 'user-agent': 'sr-mod-index-intake', accept: 'application/octet-stream' }, signal });
    } catch (e) { throw new IntakeError(`download failed: ${e.message}`); }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel();
      need(loc, `HTTP ${res.status} without a location`);
      try { target = new URL(loc, u).href; } catch { throw new IntakeError('redirect to a location that is not a URL'); }
      continue;
    }
    if (res.status !== 200) { await res.body?.cancel(); throw new IntakeError(`the download answered HTTP ${res.status}`); }
    const cap = Math.min(size, MAX_DOWNLOAD_BYTES) + 1;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > cap) { await res.body?.cancel(); throw new IntakeError(`the download is larger than download_size (${size} bytes)`); }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of res.body ?? []) {
        total += chunk.length;
        if (total > cap) throw new IntakeError(`the download is larger than download_size (${size} bytes)`);
        chunks.push(chunk);
      }
    } catch (e) {
      if (e instanceof IntakeError) throw e;
      throw new IntakeError(`download failed: ${e.message}`);
    }
    return Buffer.concat(chunks);
  }
  throw new IntakeError(`more than ${MAX_REDIRECTS} redirects`);
}

// ---- PE ------------------------------------------------------------------------------------------------------------

export const REQUIRED_EXPORTS = ['GetPluginInfo', 'PluginInit', 'PluginShutdown'];
export const OPTIONAL_EXPORTS = ['OnPluginLoadHooks', 'GetPluginWireInfo', 'PluginSetHostInfo'];
const MACHINE_X64 = 0x8664;
const IMAGE_FILE_DLL = 0x2000;
const PE32_PLUS = 0x20b;
const MAX_SECTIONS = 96;
const MAX_EXPORT_NAMES = 65536;
const MAX_NAME_LEN = 256;

// Parses buf as a PE image without running anything. Every read is bounds-checked; a malformed file throws IntakeError.
// Returns { machine, isDll, imageBase, exports: Map(name -> rva|null), rvaToOffset }.
export function parsePe(buf) {
  const bad = (what) => new IntakeError(`not a valid PE file: ${what}`);
  const at = (off, len) => { if (!Number.isSafeInteger(off) || off < 0 || len < 0 || off + len > buf.length) throw bad('a field points outside the file'); return off; };
  const u16 = (o) => buf.readUInt16LE(at(o, 2));
  const u32 = (o) => buf.readUInt32LE(at(o, 4));

  at(0, 64);
  if (buf.readUInt16LE(0) !== 0x5a4d) throw bad('no MZ signature');
  const pe = u32(0x3c);
  if (u32(pe) !== 0x00004550) throw bad('no PE signature');
  const machine = u16(pe + 4);
  const sectionCount = u16(pe + 6);
  const optSize = u16(pe + 20);
  const characteristics = u16(pe + 22);
  const opt = pe + 24;
  if (u16(opt) !== PE32_PLUS) throw bad('not a PE32+ (64-bit) optional header');
  const imageBase = buf.readBigUInt64LE(at(opt + 24, 8));
  const dirCount = u32(opt + 108);
  if (dirCount < 1 || dirCount > 16 || optSize < 112 + dirCount * 8) throw bad('the data directory table is malformed');
  const exportRva = u32(opt + 112);
  const exportSize = u32(opt + 116);

  if (sectionCount < 1 || sectionCount > MAX_SECTIONS) throw bad(`${sectionCount} sections`);
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const s = opt + optSize + i * 40;
    sections.push({ virtualSize: u32(s + 8), va: u32(s + 12), rawSize: u32(s + 16), rawPtr: u32(s + 20) });
  }
  // The file offset of an RVA inside the raw data of a section; -1 when no section holds it.
  const rvaToOffset = (rva) => {
    for (const s of sections) {
      if (rva >= s.va && rva - s.va < s.rawSize && rva - s.va < (s.virtualSize || s.rawSize)) {
        const off = s.rawPtr + (rva - s.va);
        return off < buf.length ? off : -1;
      }
    }
    return -1;
  };

  const exports = new Map();
  if (exportRva !== 0) {
    const dir = rvaToOffset(exportRva);
    if (dir < 0) throw bad('the export directory is outside the sections');
    const functionCount = u32(at(dir, 40) + 20);
    const nameCount = u32(dir + 24);
    const functions = rvaToOffset(u32(dir + 28));
    const names = rvaToOffset(u32(dir + 32));
    const ordinals = rvaToOffset(u32(dir + 36));
    if (nameCount > MAX_EXPORT_NAMES) throw bad(`${nameCount} export names`);
    if (nameCount > 0) {
      if (functions < 0 || names < 0 || ordinals < 0) throw bad('an export table is outside the sections');
      at(names, nameCount * 4);
      at(ordinals, nameCount * 2);
    }
    for (let i = 0; i < nameCount; i++) {
      const nameOff = rvaToOffset(u32(names + i * 4));
      if (nameOff < 0) throw bad('an export name is outside the sections');
      const end = buf.indexOf(0, nameOff);
      if (end < 0 || end - nameOff > MAX_NAME_LEN) throw bad('an export name is not terminated or is too long');
      const ordinal = u16(ordinals + i * 2);
      if (ordinal >= functionCount) throw bad('an export ordinal is outside the function table');
      const fn = u32(at(functions, functionCount * 4) + ordinal * 4);
      // An address inside the export directory is a forwarder string, not code.
      const forwarded = fn >= exportRva && fn < exportRva + exportSize;
      exports.set(buf.toString('latin1', nameOff, end), forwarded ? null : fn);
    }
  }
  return { machine, isDll: (characteristics & IMAGE_FILE_DLL) !== 0, imageBase, exports, rvaToOffset };
}

// Text of a plugin's own strings goes to logs and markdown: only a short plain subset is shown.
function plainString(buf, off) {
  if (off < 0) return null;
  const end = buf.indexOf(0, off);
  if (end < 0 || end - off === 0 || end - off > 64) return null;
  const s = buf.toString('latin1', off, end);
  return /^[A-Za-z0-9 ._+-]+$/.test(s) ? s : null;
}

// Best effort, static: GetPluginInfo is expected to be `lea rax,[rip+disp32]; ret` and to return a PluginInfo table
// (plugin_interface.h: name, version, author, description pointers; int interfaceVersion at 32; int pluginTarget at 36). Returns { interfaceVersion, pluginTarget, name, version } or
// null when anything is not exactly as expected. Nothing is executed: the bytes of the stub are only compared.
export function readDeclaredInterface(buf, pe) {
  const rva = pe.exports.get('GetPluginInfo');
  if (rva == null) return null;
  const code = pe.rvaToOffset(rva);
  if (code < 0 || code + 8 > buf.length) return null;
  if (buf[code] !== 0x48 || buf[code + 1] !== 0x8d || buf[code + 2] !== 0x05 || buf[code + 7] !== 0xc3) return null;
  const table = pe.rvaToOffset(rva + 7 + buf.readInt32LE(code + 3));
  if (table < 0 || table + 40 > buf.length) return null;
  const pointerText = (o) => {
    const rel = buf.readBigUInt64LE(o) - pe.imageBase;
    return rel > 0n && rel < 0xffffffffn ? plainString(buf, pe.rvaToOffset(Number(rel))) : null;
  };
  return { interfaceVersion: buf.readInt32LE(table + 32), pluginTarget: buf.readInt32LE(table + 36), name: pointerText(table), version: pointerText(table + 8) };
}

// ---- one entry -----------------------------------------------------------------------------------------------------

const PASS = 'PASS';
const FAIL = 'FAIL';
const WARN = 'WARN';
const INFO = 'INFO';

// Runs the checks that need the asset: returns an array of { level, text }.
export async function checkAsset(e, fetchFn = fetch) {
  const out = [];
  let bytes;
  try { bytes = await fetchAsset(e.download_url, e.download_size, fetchFn); } catch (err) {
    return [{ level: FAIL, text: `release asset: ${err.message}` }];
  }
  out.push({ level: PASS, text: 'release asset downloaded' });
  const sha = createHash('sha256').update(bytes).digest('hex');
  out.push(bytes.length === e.download_size ? { level: PASS, text: `size ${bytes.length} bytes matches download_size` } : { level: FAIL, text: `size is ${bytes.length} bytes, download_size says ${e.download_size}` });
  out.push(sha === e.download_sha256 ? { level: PASS, text: 'sha256 matches download_sha256' } : { level: FAIL, text: `sha256 is ${sha}, download_sha256 says ${e.download_sha256}` });
  let pe;
  try { pe = parsePe(bytes); } catch (err) { out.push({ level: FAIL, text: err.message }); return out; }
  out.push(pe.machine === MACHINE_X64 ? { level: PASS, text: 'x64 image' } : { level: FAIL, text: `machine is 0x${pe.machine.toString(16)}, not x64 (0x8664)` });
  out.push(pe.isDll ? { level: PASS, text: 'DLL flag set' } : { level: FAIL, text: 'not a DLL (IMAGE_FILE_DLL is not set)' });
  const missing = REQUIRED_EXPORTS.filter((n) => pe.exports.get(n) == null); // a forwarded export has no code here
  out.push(missing.length === 0 ? { level: PASS, text: `exports ${REQUIRED_EXPORTS.join(', ')}` } : { level: FAIL, text: `missing required exports: ${missing.join(', ')}` });
  const optional = OPTIONAL_EXPORTS.filter((n) => pe.exports.has(n));
  if (optional.length > 0) out.push({ level: INFO, text: `optional exports: ${optional.join(', ')}` });
  const declared = readDeclaredInterface(bytes, pe);
  if (declared === null) out.push({ level: WARN, text: 'interface not read: GetPluginInfo is not the expected simple stub' });
  else out.push({ level: INFO, text: `declares interface ${declared.interfaceVersion}, target ${declared.pluginTarget}${declared.name ? `, name ${declared.name}` : ''}${declared.version ? `, version ${declared.version}` : ''}` });
  return out;
}

// ---- selection and report ------------------------------------------------------------------------------------------

// The entries of the PR index that are new or differ from the base entry with the same id (all when base is null).
export function selectEntries(list, baseList) {
  const baseById = new Map((baseList ?? []).filter((b) => typeof b?.id === 'string').map((b) => [b.id, JSON.stringify(b)]));
  return list.map((entry, index) => ({ entry, index })).filter(({ entry }) => baseList == null || typeof entry?.id !== 'string' || baseById.get(entry.id) !== JSON.stringify(entry));
}

const statusOf = (checks) => (checks.some((c) => c.level === FAIL) ? FAIL : checks.some((c) => c.level === WARN) ? WARN : PASS);
// Text that came from the index or from a downloaded file is printable ASCII on one line. It cannot start a workflow
// command: every output line begins with a fixed prefix (PASS, FAIL, WARN, INFO, or two spaces and a level).
const clean = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');
// In markdown a stranger's text also loses everything that makes a link, image, tag, emphasis or table cell.
const md = (s) => clean(s).replace(/[\[\]()<>*_`!~#&|\\]/g, '?');

// Pool of n workers over items; results keep the order of items.
async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}

// Returns { results: [{ who, status, checks }], failed }. body: the PR index text, baseBody: the base index text or null.
export async function runIntake(body, baseBody, fetchFn = fetch, concurrency = 2) {
  try { checkBody(body); } catch (e) {
    return { results: [{ who: 'index', status: FAIL, checks: [{ level: FAIL, text: e.message }] }], failed: true };
  }
  const list = JSON.parse(body);
  let baseList = null;
  if (baseBody != null) { try { baseList = JSON.parse(baseBody); } catch { baseList = null; } }
  if (!Array.isArray(baseList)) baseList = null;
  const picked = selectEntries(list, baseList);
  const results = await pool(picked, concurrency, async ({ entry, index }) => {
    const who = `entry ${index + 1}${typeof entry.id === 'string' && entry.id !== '' ? ` (${entry.id})` : ''}`;
    // checkBody has passed: the entry rules hold and download_url is a release asset of the repository page_url names.
    const checks = [{ level: PASS, text: 'entry rules; page_url and download_url name the same repository' }];
    if (entry.download_url === undefined) checks.push({ level: INFO, text: 'no download to check' });
    else {
      try { checks.push(...await checkAsset(entry, fetchFn)); } catch (e) { checks.push({ level: FAIL, text: `internal error while checking the asset: ${e.message}` }); }
    }
    return { who, status: statusOf(checks), checks };
  });
  return { results, failed: results.some((r) => r.status === FAIL), checked: picked.length, total: list.length };
}

export function renderText({ results, checked, total }) {
  const lines = [];
  if (checked !== undefined) lines.push(`checked ${checked} of ${total} entries`);
  for (const r of results) {
    lines.push(`${r.status} ${clean(r.who)}`);
    for (const c of r.checks) lines.push(`  ${c.level} ${clean(c.text)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderMarkdown({ results, checked, total }) {
  const rows = results.map((r) => `| ${md(r.who)} | ${r.status} | ${r.checks.filter((c) => c.level !== PASS).map((c) => `${c.level}: ${md(c.text)}`).join('<br>') || 'all checks passed'} |`);
  return `### Mod index intake check\n\n${checked === undefined ? '' : `Checked ${checked} of ${total} entries (new or changed).\n\n`}| Entry | Result | Notes |\n| --- | --- | --- |\n${rows.join('\n')}\n`;
}

export async function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--index', '--base', '--summary'].includes(argv[i]) || argv[i + 1] === undefined || opts[argv[i]] !== undefined) throw new IntakeError('usage: mod-index-intake.mjs --index <index.json> [--base <base index.json>] [--summary <file>]');
    opts[argv[i]] = argv[i + 1];
  }
  if (opts['--index'] === undefined) throw new IntakeError('usage: mod-index-intake.mjs --index <index.json> [--base <base index.json>] [--summary <file>]');
  let report;
  try {
    const body = readIndex(opts['--index']);
    // The base only narrows the work: when it cannot be read, every entry is checked.
    let baseBody = null;
    if (opts['--base'] !== undefined) { try { baseBody = readIndex(opts['--base']); } catch { baseBody = null; } }
    report = await runIntake(body, baseBody);
  } catch (e) {
    if (!(e instanceof ModIndexError) && !['ENOENT', 'ERR_ENCODING_INVALID_ENCODED_DATA'].includes(e.code)) throw e;
    // A deleted or unreadable index in the pull request is a result for the contributor, not a crash.
    const why = e.code === 'ENOENT' ? `${opts['--index']} does not exist (was the file deleted?)` : e.message;
    report = { results: [{ who: 'index', status: FAIL, checks: [{ level: FAIL, text: why }] }], failed: true };
  }
  process.stdout.write(renderText(report));
  if (opts['--summary'] !== undefined) appendFileSync(opts['--summary'], renderMarkdown(report));
  return report.failed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  new Promise((done) => done(main(process.argv.slice(2)))).then(
    (code) => { process.exitCode = code; },
    (e) => {
      process.stderr.write(`mod-index-intake: ${e instanceof IntakeError || e instanceof ModIndexError ? e.message : `unexpected error: ${e.message}`}\n`);
      process.exitCode = 2;
    },
  );
}
