#!/usr/bin/env node
// server-publish-gate.mjs: refuses a server version map file that a released loader without the
// same-exe binding could misread. Runs on the final file before any signing key is read. The rules,
// and how to retire the gate, are in VERSION-MAP.md ("The publish gate").
//
//   node ci/server-publish-gate.mjs <server feed> --result <server-result.json>
//
// Exit 0: the file may be signed. Exit 3: refused, each broken rule printed. Exit 2: a usage error,
// or a file, result or built-in table that cannot be read. Anything but 0 stops the publish.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT_ERROR, EXIT_OK, EXIT_VIOLATION, parseFeed } from './version-map.mjs';

// The server table of every released loader without the binding, copied byte for byte from its tag.
// `blob` is `git rev-parse <ref>:StarRupture-ModLoader-Core/hooks/game/version_map.server.h` there.
export const LOADER_TABLES = [
  { ref: 'v1.27.0', blob: 'f3e6f13b22736a36553d0cc7cfca2a597401cf03', path: join(dirname(fileURLToPath(import.meta.url)), 'data', 'loader-server-table', 'v1.27.0', 'version_map.server.h') },
];

// The git blob id of a text, with a checkout's CRLF undone.
export function blobId(text) {
  const body = Buffer.from(text.replaceAll('\r\n', '\n'));
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

const NUM = String.raw`(-?\d+|0x[0-9A-F]+)`;
const STR = String.raw`(nullptr|"[^"\\]*")`;
const KEY = String.raw`"([^"\\]+)"`;
// A record may end its line with a comment, and the last one of an array needs no comma.
const record = (...cells) => new RegExp(String.raw`^\{ ${cells.join(', ')} \},?(?:\s*//.*)?$`);
const SHAPES = {
  kServerBuilds: ['Build', record(NUM, NUM, NUM, STR)],
  kServerFunctionRows: ['FunctionRow', record(NUM, NUM, NUM, NUM, NUM, '(true|false)', STR, NUM, NUM, NUM, NUM, STR)],
  kServerFieldRows: ['FieldRow', record(NUM, NUM, NUM, NUM, STR)],
  kServerFunctions: ['Index', record(KEY, NUM, NUM)],
  kServerFields: ['Index', record(KEY, NUM, NUM)],
  kServerAbsentFields: ['AbsentField', record(KEY, NUM)],
};

// One std::array of the table: every line is a comment or one whole record, and there are exactly
// as many records as the array declares.
function readArray(text, name) {
  const [type, shape] = SHAPES[name];
  const found = [...text.matchAll(new RegExp(String.raw`^inline constexpr std::array<${type}, (\d+)> ${name} = (?:\{\}|\{\{\n([\s\S]*?)\n\}\});$`, 'gm'))];
  if (found.length !== 1) throw new Error(`${name}: found ${found.length} times, expected once`);
  const rows = [];
  for (const raw of (found[0][2] ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) continue;
    const m = shape.exec(line);
    if (!m) throw new Error(`${name}: a line that is not a ${type} record: ${line}`);
    rows.push(m.slice(1));
  }
  if (rows.length !== Number(found[0][1])) throw new Error(`${name}: ${rows.length} rows read, ${found[0][1]} declared`);
  return rows;
}

const str = (s) => (s === 'nullptr' ? null : s.slice(1, -1));

// Rows by key, as the loader's CompiledMap reads them: through the index arrays, which must name
// every row exactly once.
function indexed(text, indexName, rowsName, make) {
  const rows = readArray(text, rowsName);
  const out = new Array(rows.length);
  for (const [key, first, count] of readArray(text, indexName)) {
    for (let n = Number(first); n < Number(first) + Number(count); n++) {
      if (n >= rows.length || out[n]) throw new Error(`${indexName}: ${key} names row ${n} of ${rowsName}, which is ${n >= rows.length ? 'past the end' : 'already named'}`);
      out[n] = { key, ...make(rows[n]) };
    }
  }
  const unnamed = rows.findIndex((_, n) => !out[n]);
  if (unnamed >= 0) throw new Error(`${indexName}: no entry names row ${unnamed} of ${rowsName}`);
  return out;
}

export function parseTable(source) {
  const text = source.replaceAll('\r\n', '\n');
  const table = {
    builds: readArray(text, 'kServerBuilds').map(([cl, stamp, size]) => ({ cl: Number(cl), stamp: Number(stamp), size: Number(size) })),
    functions: indexed(text, 'kServerFunctions', 'kServerFunctionRows', ([cl, , , kind, fp, absent, pattern, ro, r32, rip, rva, owners]) => ({
      cl: Number(cl), kind: Number(kind), fp: Number(fp), absent: absent === 'true', pattern: str(pattern),
      resultOffset: Number(ro), followRel32At: Number(r32), followRipDispAt: Number(rip), rva: Number(rva), owners: str(owners),
    })),
    fields: indexed(text, 'kServerFields', 'kServerFieldRows', ([cl, offset, size, mask, member]) => ({
      cl: Number(cl), offset: Number(offset), size: Number(size), mask: Number(mask), member: str(member),
    })),
    absentFields: readArray(text, 'kServerAbsentFields').map(([key, cl]) => ({ key, cl: Number(cl) })),
  };
  if (!table.builds.length || !table.fields.length || !table.functions.length) throw new Error('the table holds no build, function or field rows');
  return table;
}

export function loadTables(tables = LOADER_TABLES) {
  if (!tables.length) throw new Error('no built-in table is listed');
  return tables.map(({ ref, blob, path }) => {
    const text = readFileSync(path, 'utf8');
    if (blobId(text) !== blob) throw new Error(`${path} is not the ${ref} table (blob ${blobId(text)}, expected ${blob})`);
    return { ref, ...parseTable(text) };
  });
}

// The scanned exe, as the server check wrote it from the exe's own PE header and version resource.
export function scannedExe(result) {
  const hex = (v) => (/^0x[0-9A-F]{8}$/.test(String(v)) ? Number(v) : 0);
  const exe = { cl: /^[1-9]\d*$/.test(String(result?.cl)) ? Number(result.cl) : 0, stamp: hex(result?.imageStamp), size: hex(result?.imageSize) };
  for (const [name, value] of Object.entries(exe)) {
    if (!value) throw new Error(`the scanned exe's ${name} is unknown (server-result.json)`);
  }
  return exe;
}

const hex8 = (v) => `0x${v.toString(16).toUpperCase().padStart(8, '0')}`;

// Rule 1: one build line, and every line carries the scanned exe's build, and its time stamp and
// image size where the line has them. Read from the raw lines, so each offender is named. The
// columns are [CL, stamp, size].
const COLUMNS = { build: [1, 2, 3], function: [3, 4, 5], absent: [3, 4, 5], field: [2] };
function lineReasons(text, exe) {
  const want = [String(exe.cl), hex8(exe.stamp), hex8(exe.size)];
  const reasons = [];
  let builds = 0;
  text.split('\n').forEach((line, i) => {
    if (i === 0 || line === '') return;
    const f = line.split('\t');
    if (!Object.hasOwn(COLUMNS, f[0])) return void reasons.push(`line ${i + 1}: not a build, function, absent or field line: ${JSON.stringify(line)}`);
    if (f[0] === 'build') builds++;
    if (COLUMNS[f[0]].some((col, n) => f[col] !== want[n])) {
      reasons.push(`line ${i + 1}: not the scanned exe's build, stamp and size (CL-${want.join(' ')}): ${JSON.stringify(line)}`);
    }
  });
  if (builds !== 1) reasons.push(`the file has ${builds} build lines, expected exactly one for CL-${exe.cl}`);
  return reasons;
}

const FUNCTION_VALUES = ['fp', 'kind', 'absent', 'pattern', 'resultOffset', 'followRel32At', 'followRipDispAt', 'rva', 'owners'];
const FIELD_VALUES = ['offset', 'size', 'mask', 'member'];
const same = (a, b, values) => values.every((v) => String(a[v] ?? '') === String(b[v] ?? ''));

// Rules 2 and 3, against one loader's table, for a file whose lines all passed rule 1.
function tableReasons(feed, table, exe) {
  const own = table.builds.find((b) => b.cl === exe.cl);
  if (!own) return [];
  const here = (rows) => rows.filter((r) => r.cl === exe.cl);
  const functions = here(table.functions);
  const fields = here(table.fields);
  const reasons = [];
  if (own.stamp === exe.stamp && own.size === exe.size) {
    // Rule 2: on the table's own exe, a built-in name may only be repeated exactly.
    const names = new Set([...functions, ...fields, ...here(table.absentFields)].map((r) => r.key));
    for (const [type, rows, builtIn, values] of [['function', feed.functions, functions, FUNCTION_VALUES], ['field', feed.fields, fields, FIELD_VALUES]]) {
      for (const r of rows) {
        if (names.has(r.key) && !builtIn.some((b) => b.key === r.key && same(r, b, values))) {
          reasons.push(`${r.absent ? 'absent' : type} ${r.key}${type === 'function' ? ` (fp ${hex8(r.fp)})` : ''}: differs from the ${table.ref} built-in row for this exe, or the loader has no such row for that name`);
        }
      }
    }
    return reasons;
  }
  // Rule 3: on a rebuilt exe of the table's build, the file replaces every built-in row the loader
  // could still serve. An address-only function row is left out: the loader tries it on its own exe
  // only (v1.27.0 version_map.cpp, Select: tryExact skips it and the agreement step passes over it).
  for (const b of fields) {
    if (!feed.fields.some((r) => r.key === b.key)) reasons.push(`field ${b.key}: the ${table.ref} built-in row is not replaced, so it would be served from the old exe's measurements`);
  }
  for (const b of functions.filter((r) => r.absent || r.pattern !== null)) {
    if (!feed.functions.some((r) => r.key === b.key && r.fp === b.fp)) reasons.push(`function ${b.key} (fp ${hex8(b.fp)}): the ${table.ref} built-in row is not replaced, so it would be served on this exe`);
  }
  return reasons;
}

// Every broken rule, as text. Throws when the file cannot be read as a server feed.
export function gateReasons(text, exe, tables) {
  const reasons = lineReasons(text, exe);
  if (reasons.length) return reasons;
  const feed = parseFeed(text, 'server feed', { server: true });
  return tables.flatMap((table) => tableReasons(feed, table, exe));
}

export function main(argv, tables = LOADER_TABLES) {
  const [file, flag, result] = argv;
  if (argv.length !== 3 || flag !== '--result') {
    process.stderr.write('usage: server-publish-gate.mjs <server feed> --result <server-result.json>\n');
    return EXIT_ERROR;
  }
  let reasons;
  let exe;
  try {
    exe = scannedExe(JSON.parse(readFileSync(result, 'utf8').replace(/^﻿/, '')));
    reasons = gateReasons(readFileSync(file, 'utf8'), exe, loadTables(tables));
  } catch (e) {
    process.stdout.write(`::error::server publish gate: refused, it could not judge the file: ${e.message}\n`);
    return EXIT_ERROR;
  }
  if (reasons.length) {
    for (const r of reasons) process.stdout.write(`::error::server publish gate: ${r}\n`);
    process.stdout.write(`::error::server publish gate: refused, ${reasons.length} broken rule(s); nothing may be signed or uploaded\n`);
    return EXIT_VIOLATION;
  }
  process.stdout.write(`server publish gate: passed for CL-${exe.cl} stamp ${hex8(exe.stamp)} size ${hex8(exe.size)} against ${tables.map((t) => t.ref).join(', ')}\n`);
  return EXIT_OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
