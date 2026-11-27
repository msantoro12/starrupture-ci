#!/usr/bin/env node
// server-scan-rows.mjs: the function and global rows of a new server build, from the loader's own
// server scanner. `sr-aobscan-server.exe <server exe> --json` reports every address the loader looks
// up (about fifty rows); a server file carries only the keys of ci/server-function-keys.txt. This
// turns the report into the scan rows `map-mode.mjs server --scan` writes into the server header.
//
//   node ci/server-scan-rows.mjs <server-scan.json> --result <server-result.json> --keys <server-function-keys.txt>
//        --out <server-scan-rows.json> [--summary <markdown file>] [--name-check <file>]
//   node ci/server-scan-rows.mjs live-check <name check file>     (exit 2 unless every OK row was name checked)
//
// Name check: a scanner that has it gives each row `viaCall` (the address was reached by following a call
// site) and `nameMatch` (true: the exe's PDB has the key's qualified name at exactly that rva; false: it
// does not; null: no PDB, an unreadable one, or not a function row). A row with nameMatch false gets no row,
// and a viaCall row gets one only with nameMatch true. A dropped key is a key with no row like any other.
// A scanner without the fields drops nothing, but its rows are not published live: --name-check records
// the listed OK rows that lack them, and live-check refuses that record.
//
// It refuses (exit 2, nothing written) a report that is not the server's, one made from another exe
// than the one server-result.json describes (CL, PE stamp and image size must all match), a listed
// key found twice, and an OK row with no address. A listed key whose row is not OK (MISSING,
// AMBIGUOUS, WRONGKIND, BADREQUEST) or whose kind is not one a server file takes gets no row and is
// listed in the summary: the required-rows check in sr-server-check.yml decides whether that stops
// the build. Rows of keys outside the list are left out (`skipped`).

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { kindOf, numberOf } from './map-mode.mjs';
import { EXIT_ERROR, EXIT_OK, KIND, MapError, SERVER_SCOPED_KEY, isGlobalKind, parseKeys } from './version-map.mjs';

const hex8 = (n) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');
const hex = (n) => '0x' + n.toString(16).toUpperCase();
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The scan report's exe against the result of the exe read from the install: the same exe, or no rows.
function checkExe(scan, result) {
  if (scan?.target !== 'server') {
    throw new MapError(`the scan report is not the server's (target ${JSON.stringify(scan?.target)}, wanted "server"): it was made by a scanner without the Server Release rows`);
  }
  const exe = scan.exe ?? {};
  const want = {
    cl: numberOf(result?.cl, 'server-result.json cl', { lo: 1 }),
    imageStamp: numberOf(result?.imageStamp, 'server-result.json imageStamp', { lo: 1 }),
    imageSize: numberOf(result?.imageSize, 'server-result.json imageSize', { lo: 1 }),
  };
  const got = {
    cl: numberOf(exe.cl, 'the scan report exe.cl', { lo: 1 }),
    imageStamp: numberOf(exe.imageStamp, 'the scan report exe.imageStamp', { lo: 1 }),
    imageSize: numberOf(exe.imageSize, 'the scan report exe.imageSize', { lo: 1 }),
  };
  const same = want.cl === got.cl && want.imageStamp === got.imageStamp && want.imageSize === got.imageSize;
  if (!same) {
    const show = (x) => `CL-${x.cl}, stamp ${hex8(x.imageStamp)}, size ${hex8(x.imageSize)}`;
    throw new MapError(`the scan report is for another exe than the server being checked (report: ${show(got)}; server: ${show(want)})`);
  }
}

// Why a row fails the name check, or null. A field of another type is refused: it cannot be judged.
function nameDrop(r) {
  if (r.viaCall !== undefined && typeof r.viaCall !== 'boolean') throw new MapError(`${r.key}: viaCall must be true or false`);
  if (![undefined, null, true, false].includes(r.nameMatch)) throw new MapError(`${r.key}: nameMatch must be true, false or null`);
  if (r.nameMatch === false) return "dropped: the PDB does not have the key's name at this address";
  if (r.viaCall === true && r.nameMatch !== true) return 'dropped: reached through a call site and no PDB name confirms it';
  return null;
}

// Returns { rows: [{ key, kind, fp, rva }] by key, notOk: [{ key, result, matches, required, reason }], skipped: [key],
// unchecked: [listed OK key without both name check fields], nameChecked: there are listed OK rows and none is unchecked }.
// result: the parsed server-result.json; functionKeys: the Set of the `function` keys of ci/server-function-keys.txt.
export function convertServerScan(scan, result, { functionKeys }) {
  checkExe(scan, result);
  if (!Array.isArray(scan.patterns)) throw new MapError('the scan report has no patterns array');
  const out = { rows: [], notOk: [], skipped: [], unchecked: [], nameChecked: false };
  let judged = 0;
  const seen = new Set();
  for (const r of scan.patterns) {
    if (typeof r?.key !== 'string' || !r.key) continue;
    if (!functionKeys.has(r.key)) { out.skipped.push(r.key); continue; }
    if (seen.has(r.key)) throw new MapError(`${r.key}: the scan report has two rows for this key`);
    seen.add(r.key);
    const notOk = (reason) => out.notOk.push({ key: r.key, result: r.result, matches: r.matches, required: r.required === true, reason });
    if (r.result !== 'OK') { notOk(`the scan result is ${r.result}`); continue; }
    judged++;
    if (r.viaCall === undefined || r.nameMatch === undefined) out.unchecked.push(r.key);
    const drop = nameDrop(r);
    if (drop) { notOk(drop); continue; }
    const kind = kindOf(r.kind);
    // The same rule as the server header: global keys are function starts and data, the one scoped key is kind "any".
    if (!(isGlobalKind(kind) || (r.key === SERVER_SCOPED_KEY && kind === KIND.ANY))) { notOk(`kind ${r.kind} is not one a server file takes`); continue; }
    const rva = numberOf(r.rva, `${r.key}: rva`, { lo: 1 });
    const fp = numberOf(r.fp, `${r.key}: fp`);
    if (isGlobalKind(kind) && fp !== 0) throw new MapError(`${r.key}: a global row has fp 0, the scan report gives ${hex8(fp)}`);
    if (!isGlobalKind(kind) && fp === 0) throw new MapError(`${r.key}: the scoped row has no fp in the scan report`);
    out.rows.push({ key: r.key, kind, fp, rva });
  }
  out.rows.sort((a, b) => cmp(a.key, b.key));
  out.notOk.sort((a, b) => cmp(a.key, b.key));
  out.skipped.sort(cmp);
  out.unchecked.sort(cmp);
  out.nameChecked = judged > 0 && out.unchecked.length === 0;
  return out;
}

// The scan rows `map-mode.mjs server --scan` reads.
export const scanRowsFile = (rows) => ({
  patterns: rows.map((r) => ({ key: r.key, kind: r.kind, result: 'OK', fp: hex8(r.fp), rva: hex(r.rva) })),
});

// The job summary block: how many rows were made, and every listed key that was not.
export function summaryOf(conv, cl) {
  const lines = ['### Server scan rows', '', `- CL-${cl}: ${conv.rows.length} function and global rows from the scan; ${conv.skipped.length} other scan rows are not server file keys`];
  for (const n of conv.notOk) lines.push(`- no row: ${n.key} (${n.reason}${n.matches !== undefined ? `, ${n.matches} matches` : ''})`);
  return lines.join('\n') + '\n';
}

// A live publish takes only rows the scanner name checked. Returns why not, or null.
export function liveRefusal(check) {
  if (check?.nameChecked === true) return null;
  const keys = Array.isArray(check?.unchecked) && check.unchecked.length ? ` (no viaCall or nameMatch: ${check.unchecked.join(', ')})` : '';
  return `the server scan rows were not name checked${keys}; a live publish needs a scanner that checks names`;
}

function liveCheck(file) {
  let why;
  try {
    why = liveRefusal(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    why = `the name check record cannot be read: ${e.message}`;
  }
  if (!why) return EXIT_OK;
  process.stdout.write(`::error::${why}\n`);
  return EXIT_ERROR;
}

export function main(argv) {
  const [file, ...rest] = argv;
  if (file === 'live-check' && rest.length === 1) return liveCheck(rest[0]);
  const o = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) { process.stderr.write(`server-scan-rows: bad argument ${rest[i]}\n`); return EXIT_ERROR; }
    o[rest[i].slice(2)] = rest[i + 1];
  }
  if (!file || file.startsWith('--') || !o.result || !o.keys || !o.out) {
    process.stderr.write('usage: server-scan-rows.mjs <server-scan.json> --result <server-result.json> --keys <server-function-keys.txt> --out <rows.json> [--summary <file>] [--name-check <file>]\n       server-scan-rows.mjs live-check <name check file>\n');
    return EXIT_ERROR;
  }
  const json = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
  try {
    const result = json(o.result);
    const conv = convertServerScan(json(file), result, { functionKeys: parseKeys(readFileSync(o.keys, 'utf8'), o.keys).functions });
    writeFileSync(o.out, JSON.stringify(scanRowsFile(conv.rows), null, 2) + '\n');
    if (o['name-check']) writeFileSync(o['name-check'], JSON.stringify({ nameChecked: conv.nameChecked, unchecked: conv.unchecked }) + '\n');
    const md = summaryOf(conv, result.cl);
    if (o.summary) writeFileSync(o.summary, md);
    process.stdout.write(md.replace(/^### .*\n\n/, ''));
    return EXIT_OK;
  } catch (e) {
    if (!(e instanceof MapError) && !(e instanceof SyntaxError) && e.code !== 'ENOENT') throw e;
    process.stderr.write(`server-scan-rows: ${e.message}\n`);
    return EXIT_ERROR;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
