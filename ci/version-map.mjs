#!/usr/bin/env node
// The versioned function and field map: one generated, data-only header per
// component, version_map.generated.h, holding the locators of that component's
// own keys on every game build in its build table. The loader and each plugin
// carry their own. The header is the only copy of the data: this tool parses it,
// changes the parsed map and writes it back, and refuses any header that is not
// exactly what it would write itself.
//
//   node ci/version-map.mjs init <header> --flavour plugin|loader --built-cl <CL>
//   node ci/version-map.mjs add-build <header> --cl <CL> --stamp <hex> --size <hex> --source <text>
//   node ci/version-map.mjs add-function <header> --key <key> --cl <CL> --rva <hex>
//        (--pattern <aob> | --rva-only) [--result-offset <n>] [--follow-rel32-at <n>]
//        [--follow-rip-disp-at <n>]
//   node ci/version-map.mjs add-field <header> --key <key> --cl <CL> --offset <hex> --size <hex>
//        [--mask <hex>] [--member <name>]
//   node ci/version-map.mjs replace-build <header> --cl <CL> --stamp <hex> --size <hex> --source <text>
//   node ci/version-map.mjs remove-key <header> --key <key>
//   node ci/version-map.mjs prune <header> --keep <CL>[,<CL>...]
//   node ci/version-map.mjs check <header> [--keys <keys.txt>]
//
// init writes an empty map; it refuses to overwrite a file.
// add-build, add-function and add-field add one row. A row that is already there
// with the same values changes nothing; one with other values is an error, so a
// run never rewrites what an earlier run verified.
// replace-build records a new exe for a CL already in the table (the same CL
// rebuilt) and drops every row of that CL, so each is verified again on the new
// exe. remove-key drops a key's rows on every build (a key the code no longer
// has). prune keeps the builds listed and drops every other build with all its rows.
// check reads the header (any header off the format fails) and, with --keys,
// applies the coverage rule: every build has a row for every function key and
// every native field key, and the map holds no key the component does not use.
//
// Exit codes: 0 ok; 3 check found a violation; 2 usage, parse or conflict error.
// The format and the keys file are documented in ci/VERSION-MAP.md.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isPattern } from './apply-proposals.mjs';
import { isMain } from './layout-diff.mjs';

export const FORMAT_VERSION = 1;
export const EXIT_OK = 0;
export const EXIT_VIOLATION = 3;
export const EXIT_ERROR = 2;
export const FLAVOURS = ['plugin', 'loader'];

export class MapError extends Error {}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hex8 = (n) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');
const hex = (n) => '0x' + n.toString(16).toUpperCase();
const hex2 = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

// Text that goes into a C string literal or a // comment as is: printable ASCII
// without '"' or '\', and no leading or trailing space.
const RE_TEXT = /^[\x21\x23-\x5B\x5D-\x7E](?:[\x20\x21\x23-\x5B\x5D-\x7E]*[\x21\x23-\x5B\x5D-\x7E])?$/;
const RE_MEMBER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const U32 = 0xffffffff;
const I32_MIN = -0x80000000;
const I32_MAX = 0x7fffffff;
const MAX_ROWS = 0xffff; // Index::first and ::count are uint16_t

const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

function need(ok, message) {
  if (!ok) throw new MapError(message);
}

// ---- The model --------------------------------------------------------------
//
// { flavour, builtCL,
//   builds:    [{ cl, stamp, size, source }],
//   functions: [{ key, cl, pattern (null: RVA-only), resultOffset, followRel32At, followRipDispAt, rva }],
//   fields:    [{ key, cl, member (null: not renamed), offset, size, mask }] }
//
// A function row's image stamp and size are its build's, so the model keeps them
// in the build table only. followRipDispAt is the loader's (its global keys) and
// is -1 in a plugin map.

export function emptyMap(flavour, builtCL) {
  const map = { flavour, builtCL, builds: [], functions: [], fields: [] };
  validate(map);
  return map;
}

const rowName = (r) => `${r.key} @ CL-${r.cl}`;

export function validate(map) {
  need(FLAVOURS.includes(map.flavour), `flavour must be plugin or loader, not ${map.flavour}`);
  need(isInt(map.builtCL, 1, U32), `built CL ${map.builtCL} is not a CL`);
  const builds = new Set();
  for (const b of map.builds) {
    need(isInt(b.cl, 1, U32), `build CL ${b.cl} is not a CL`);
    need(!builds.has(b.cl), `build CL-${b.cl} is listed twice`);
    builds.add(b.cl);
    need(isInt(b.stamp, 0, U32) && isInt(b.size, 1, U32), `build CL-${b.cl}: the stamp and the image size must be 32-bit, the size not 0`);
    need(typeof b.source === 'string' && RE_TEXT.test(b.source), `build CL-${b.cl}: the source must be printable ASCII without quotes or backslashes`);
  }
  const rows = (list, what) => {
    need(list.length <= MAX_ROWS, `more than ${MAX_ROWS} ${what} rows`);
    const seen = new Set();
    for (const r of list) {
      need(typeof r.key === 'string' && RE_TEXT.test(r.key), `${what} key ${JSON.stringify(r.key)} must be printable ASCII without quotes or backslashes`);
      need(builds.has(r.cl), `${rowName(r)}: CL-${r.cl} is not in the build table`);
      const id = `${r.key}\n${r.cl}`;
      need(!seen.has(id), `${rowName(r)}: two ${what} rows`);
      seen.add(id);
    }
  };
  rows(map.functions, 'function');
  rows(map.fields, 'field');
  for (const r of map.functions) {
    need(r.pattern === null || isPattern(r.pattern), `${rowName(r)}: the pattern must be IDA style, upper-case hex bytes and ?? separated by single spaces`);
    need(isInt(r.resultOffset, I32_MIN, I32_MAX), `${rowName(r)}: result offset ${r.resultOffset} is not a 32-bit integer`);
    need(isInt(r.followRel32At, -1, I32_MAX), `${rowName(r)}: follow-rel32-at must be -1 or an offset into the match`);
    need(isInt(r.followRipDispAt, -1, I32_MAX), `${rowName(r)}: follow-rip-disp-at must be -1 or an offset into the match`);
    need(map.flavour === 'loader' || r.followRipDispAt === -1, `${rowName(r)}: follow-rip-disp-at is the loader's only`);
    need(r.followRel32At === -1 || r.followRipDispAt === -1, `${rowName(r)}: a row follows a rel32 or a rip displacement, not both`);
    need(isInt(r.rva, 0, U32), `${rowName(r)}: rva ${r.rva} is not 32-bit`);
    need(r.pattern !== null || r.rva !== 0, `${rowName(r)}: an RVA-only row needs an rva`);
  }
  for (const r of map.fields) {
    need(r.member === null || (typeof r.member === 'string' && RE_MEMBER.test(r.member)), `${rowName(r)}: member ${JSON.stringify(r.member)} is not an identifier`);
    need(isInt(r.offset, 0, I32_MAX), `${rowName(r)}: offset ${r.offset} is not a member offset`);
    need(isInt(r.size, 1, U32), `${rowName(r)}: size ${r.size} is not a member size`);
    need(isInt(r.mask, 0, 0xff), `${rowName(r)}: bool mask ${r.mask} is not one byte`);
    need(r.mask === 0 || r.size === 1, `${rowName(r)}: a bool mask needs size 1`);
  }
}

const byKeyThenCL = (a, b) => cmp(a.key, b.key) || a.cl - b.cl;

// ---- Writing ----------------------------------------------------------------

function array(type, name, lines) {
  if (!lines.length) return [`inline constexpr std::array<${type}, 0> ${name} = {};`];
  return [`inline constexpr std::array<${type}, ${lines.filter((l) => !l.startsWith('\t//')).length}> ${name} = {{`, ...lines, '}};'];
}

// Rows grouped by key, each group under a `// key` line; and the index over them.
function grouped(rows, render) {
  const lines = [];
  const index = [];
  let n = 0;
  for (const r of rows) {
    if (!index.length || index[index.length - 1].key !== r.key) {
      index.push({ key: r.key, first: n, count: 0 });
      lines.push(`\t// ${r.key}`);
    }
    index[index.length - 1].count++;
    lines.push(`\t${render(r)},`);
    n++;
  }
  return { lines, index: index.map((i) => `\t{ "${i.key}", ${i.first}, ${i.count} },`) };
}

export function emit(map) {
  validate(map);
  const plugin = map.flavour === 'plugin';
  const builds = [...map.builds].sort((a, b) => a.cl - b.cl);
  const build = new Map(builds.map((b) => [b.cl, b]));
  const str = (s) => (s === null ? 'nullptr' : `"${s}"`);
  const fn = grouped([...map.functions].sort(byKeyThenCL), (r) => {
    const b = build.get(r.cl);
    const head = `{ ${r.cl}, ${hex8(b.stamp)}, ${hex8(b.size)}, ${str(r.pattern)}, `;
    return plugin
      ? `${head}${r.followRel32At >= 0 ? 'PLUGIN_SCAN_FLAG_FOLLOW_REL32' : 'PLUGIN_SCAN_FLAG_NONE'}, ${r.resultOffset}, ${r.followRel32At}, ${hex8(r.rva)} }`
      : `${head}${r.resultOffset}, ${r.followRel32At}, ${r.followRipDispAt}, ${hex8(r.rva)} }`;
  });
  const fd = grouped([...map.fields].sort(byKeyThenCL), (r) => `{ ${r.cl}, ${hex(r.offset)}, ${hex(r.size)}, ${hex2(r.mask)}, ${str(r.member)} }`);
  const out = [
    '// Generated by starrupture-ci ci/version-map.mjs. Do not edit by hand.',
    '// Format: ci/VERSION-MAP.md in starrupture-ci.',
    '#pragma once',
    '#include <array>',
    '#include <cstdint>',
    ...(plugin ? ['#include "plugin_interface.h"'] : []),
    '',
    'namespace VersionMap',
    '{',
    `inline constexpr uint32_t kFormatVersion = ${FORMAT_VERSION};`,
    `inline constexpr uint32_t kBuiltCL = ${map.builtCL};`,
    '',
    'struct Build { uint32_t gameCL, imageStamp, imageSize; const char* source; };',
    'struct Index { const char* key; uint16_t first, count; };',
    ...(plugin
      ? []
      : [
          'struct FunctionRow { uint32_t gameCL, imageStamp, imageSize; const char* pattern; int32_t resultOffset, followRel32At, followRipDispAt; uint32_t rva; };',
          'struct FieldRow { uint32_t gameCL; int32_t offset; uint32_t size; uint8_t boolMask; const char* member; };',
        ]),
    '',
    ...array('Build', 'kBuilds', builds.map((b) => `\t{ ${b.cl}, ${hex8(b.stamp)}, ${hex8(b.size)}, "${b.source}" },`)),
    '',
    ...array(plugin ? 'PluginScanCandidate' : 'FunctionRow', 'kFunctionRows', fn.lines),
    '',
    ...array(plugin ? 'PluginFieldCandidate' : 'FieldRow', 'kFieldRows', fd.lines),
    '',
    ...array('Index', 'kFunctions', fn.index),
    '',
    ...array('Index', 'kFields', fd.index),
    '}',
    '',
  ];
  return out.join('\n');
}

// ---- Reading ----------------------------------------------------------------

const RE_ARRAY = /^inline constexpr std::array<\w+, \d+> (k\w+) = \{\{?\}?;?$/;
const RE_BUILTCL = /^inline constexpr uint32_t kBuiltCL = (\d+);$/;
const RE_BUILD = /^\t\{ (\d+), 0x([0-9A-F]{8}), 0x([0-9A-F]{8}), "([^"\\]*)" \},$/;
const RE_KEY = /^\t\/\/ (.*)$/;
const STR = '(nullptr|"[^"\\\\]*")';
const RE_FN_PLUGIN = new RegExp(`^\\t\\{ (\\d+), 0x[0-9A-F]{8}, 0x[0-9A-F]{8}, ${STR}, PLUGIN_SCAN_FLAG_(?:NONE|FOLLOW_REL32), (-?\\d+), (-?\\d+), 0x([0-9A-F]{8}) \\},$`);
const RE_FN_LOADER = new RegExp(`^\\t\\{ (\\d+), 0x[0-9A-F]{8}, 0x[0-9A-F]{8}, ${STR}, (-?\\d+), (-?\\d+), (-?\\d+), 0x([0-9A-F]{8}) \\},$`);
const RE_FIELD = new RegExp(`^\\t\\{ (\\d+), 0x([0-9A-F]+), 0x([0-9A-F]+), 0x([0-9A-F]{2}), ${STR} \\},$`);
const unquote = (s) => (s === 'nullptr' ? null : s.slice(1, -1));

// Reads a header this tool wrote. The rows are read loosely and the result is then
// written back: anything that differs from the input, by one byte, is an error
// naming the first line that differs. So a header is accepted only in exactly the
// form emit() gives it: sorted, grouped, indexed and counted. CRLF line ends, which
// a Windows checkout may give, read as LF.
export function parse(text, where = 'header') {
  text = text.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const map = { flavour: lines.includes('#include "plugin_interface.h"') ? 'plugin' : 'loader', builtCL: 0, builds: [], functions: [], fields: [] };
  let section = null;
  let key = null;
  lines.forEach((line, i) => {
    let m;
    const at = `${where}:${i + 1}`;
    if ((m = RE_BUILTCL.exec(line))) map.builtCL = Number(m[1]);
    else if ((m = RE_ARRAY.exec(line))) [section, key] = [m[1], null];
    else if (line === '}};') section = null;
    else if ((section === 'kFunctionRows' || section === 'kFieldRows') && (m = RE_KEY.exec(line))) key = m[1];
    else if (section === 'kBuilds' && (m = RE_BUILD.exec(line))) {
      map.builds.push({ cl: Number(m[1]), stamp: parseInt(m[2], 16), size: parseInt(m[3], 16), source: m[4] });
    } else if (section === 'kFunctionRows') {
      if (!(m = (map.flavour === 'plugin' ? RE_FN_PLUGIN : RE_FN_LOADER).exec(line))) return;
      need(key !== null, `${at}: a function row before its // key line`);
      const plugin = map.flavour === 'plugin';
      map.functions.push({
        key, cl: Number(m[1]), pattern: unquote(m[2]), resultOffset: Number(m[3]), followRel32At: Number(m[4]),
        followRipDispAt: plugin ? -1 : Number(m[5]), rva: parseInt(plugin ? m[5] : m[6], 16),
      });
    } else if (section === 'kFieldRows' && (m = RE_FIELD.exec(line))) {
      need(key !== null, `${at}: a field row before its // key line`);
      map.fields.push({ key, cl: Number(m[1]), offset: parseInt(m[2], 16), size: parseInt(m[3], 16), mask: parseInt(m[4], 16), member: unquote(m[5]) });
    }
  });
  let canonical;
  try {
    canonical = emit(map);
  } catch (e) {
    if (e instanceof MapError) throw new MapError(`${where}: ${e.message}`);
    throw e;
  }
  if (canonical !== text) {
    const want = canonical.split('\n');
    let i = 0;
    while (i < want.length && i < lines.length && want[i] === lines[i]) i++;
    throw new MapError(`${where}:${i + 1}: not in the form version-map.mjs writes; expected ${JSON.stringify(want[i] ?? '<end of file>')}, found ${JSON.stringify(lines[i] ?? '<end of file>')}`);
  }
  return map;
}

// ---- Changing the map -------------------------------------------------------

function addRow(list, row, what) {
  const same = list.find((r) => r.key === row.key && r.cl === row.cl);
  if (!same) {
    list.push(row);
    return true;
  }
  need(JSON.stringify(same) === JSON.stringify({ ...same, ...row }), `${rowName(row)}: the map already has a different ${what} row; a verified row is never rewritten`);
  return false;
}

export function addBuild(map, b) {
  const same = map.builds.find((x) => x.cl === b.cl);
  if (same) {
    need(same.stamp === b.stamp && same.size === b.size && same.source === b.source, `build CL-${b.cl} is already in the table with other values`);
    return false;
  }
  map.builds.push(b);
  validate(map);
  return true;
}

export function addFunction(map, r) {
  const row = { key: r.key, cl: r.cl, pattern: r.pattern, resultOffset: r.resultOffset ?? 0, followRel32At: r.followRel32At ?? -1, followRipDispAt: r.followRipDispAt ?? -1, rva: r.rva };
  const added = addRow(map.functions, row, 'function');
  validate(map);
  return added;
}

export function addField(map, r) {
  const row = { key: r.key, cl: r.cl, member: r.member ?? null, offset: r.offset, size: r.size, mask: r.mask ?? 0 };
  const added = addRow(map.fields, row, 'field');
  validate(map);
  return added;
}

export function replaceBuild(map, b) {
  const old = map.builds.find((x) => x.cl === b.cl);
  need(old, `build CL-${b.cl} is not in the table; add-build adds a new one`);
  const before = map.functions.length + map.fields.length;
  Object.assign(old, b);
  map.functions = map.functions.filter((r) => r.cl !== b.cl);
  map.fields = map.fields.filter((r) => r.cl !== b.cl);
  validate(map);
  return before - map.functions.length - map.fields.length;
}

export function removeKey(map, key) {
  const before = { functions: map.functions.length, fields: map.fields.length };
  map.functions = map.functions.filter((r) => r.key !== key);
  map.fields = map.fields.filter((r) => r.key !== key);
  const n = { functions: before.functions - map.functions.length, fields: before.fields - map.fields.length };
  need(n.functions + n.fields > 0, `${key} has no rows`);
  return n;
}

export function prune(map, keep) {
  for (const cl of keep) need(map.builds.some((b) => b.cl === cl), `--keep CL-${cl} is not in the build table`);
  const kept = new Set(keep);
  const before = { builds: map.builds.length, functions: map.functions.length, fields: map.fields.length };
  map.builds = map.builds.filter((b) => kept.has(b.cl));
  map.functions = map.functions.filter((r) => kept.has(r.cl));
  map.fields = map.fields.filter((r) => kept.has(r.cl));
  return { builds: before.builds - map.builds.length, functions: before.functions - map.functions.length, fields: before.fields - map.fields.length };
}

// ---- The keys a component uses, and the coverage check ------------------------
//
// One key per line, '#' comments and blank lines skipped:
//   function <key>                         a hookName or a loader registry name
//   native <key> [<offset> <size> <mask>]  a native field; the values as built, in hex
//   field <key>                            a reflected field (rows only where it moved)

const RE_KEYLINE = /^(function|native|field) (.+?)(?: (0x[0-9A-Fa-f]+) (0x[0-9A-Fa-f]+) (0x[0-9A-Fa-f]+))?$/;

export function parseKeys(text, where = 'keys') {
  const keys = { functions: new Set(), native: new Map(), fields: new Set() };
  text.replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = RE_KEYLINE.exec(line);
    need(m && RE_TEXT.test(m[2]), `${where}:${i + 1}: expected "function <key>", "native <key> [<offset> <size> <mask>]" or "field <key>"`);
    const [, kind, key, off, size, mask] = m;
    need(kind === 'native' || off === undefined, `${where}:${i + 1}: built values are for native keys only`);
    need(!/ 0x[0-9A-Fa-f]+$/.test(key), `${where}:${i + 1}: built values are an offset, a size and a mask, all three`);
    if (off !== undefined) {
      const [o, n, b] = [off, size, mask].map((v) => parseInt(v, 16));
      need(isInt(o, 0, I32_MAX) && isInt(n, 1, U32) && isInt(b, 0, 0xff) && (b === 0 || n === 1), `${where}:${i + 1}: built values out of range (offset, size not 0, a one-byte mask only with size 1)`);
    }
    need(!keys.functions.has(key) && !keys.native.has(key) && !keys.fields.has(key), `${where}:${i + 1}: ${key} is listed twice`);
    if (kind === 'function') keys.functions.add(key);
    else if (kind === 'field') keys.fields.add(key);
    else keys.native.set(key, off === undefined ? null : { offset: parseInt(off, 16), size: parseInt(size, 16), mask: parseInt(mask, 16) });
  });
  return keys;
}

// Every violation of the coverage rule, one line each; [] when the map is complete.
export function checkMap(map, keys) {
  const out = [];
  const has = (list, key, cl) => list.find((r) => r.key === key && r.cl === cl);
  if (!map.builds.some((b) => b.cl === map.builtCL)) out.push(`the built CL-${map.builtCL} has no build row`);
  for (const key of new Set(map.functions.map((r) => r.key))) if (!keys.functions.has(key)) out.push(`orphan function key ${key}: the component does not resolve it`);
  for (const key of new Set(map.fields.map((r) => r.key))) if (!keys.native.has(key) && !keys.fields.has(key)) out.push(`orphan field key ${key}: the component does not use it`);
  for (const b of [...map.builds].sort((x, y) => x.cl - y.cl)) {
    for (const key of [...keys.functions].sort(cmp)) if (!has(map.functions, key, b.cl)) out.push(`no function row for ${key} on CL-${b.cl}`);
    for (const key of [...keys.native.keys()].sort(cmp)) if (!has(map.fields, key, b.cl)) out.push(`no native field row for ${key} on CL-${b.cl}`);
  }
  for (const [key, built] of [...keys.native].sort((x, y) => cmp(x[0], y[0]))) {
    const row = built && has(map.fields, key, map.builtCL);
    if (row && (row.offset !== built.offset || row.size !== built.size || row.mask !== built.mask)) {
      out.push(`native field ${key} on the built CL-${map.builtCL}: the row says ${hex(row.offset)}/${hex(row.size)}/${hex2(row.mask)}, the code was built with ${hex(built.offset)}/${hex(built.size)}/${hex2(built.mask)}`);
    }
  }
  return out;
}

// ---- Command line -----------------------------------------------------------

const FLAGS = new Set(['rva-only']);

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) pos.push(a);
    else if (FLAGS.has(a.slice(2))) opt[a.slice(2)] = true;
    else {
      need(i + 1 < argv.length, `missing value for ${a}`);
      opt[a.slice(2)] = argv[++i];
    }
  }
  return { pos, opt };
}

function num(opt, name, { required = false, fallback, hexOnly = false } = {}) {
  const v = opt[name];
  if (v === undefined) {
    need(!required, `--${name} is required`);
    return fallback;
  }
  const ok = hexOnly ? /^0x[0-9A-Fa-f]+$/.test(v) : /^(?:-?\d+|0x[0-9A-Fa-f]+)$/.test(v);
  need(ok, `--${name} ${v} is not ${hexOnly ? 'a hex number (0x...)' : 'a number'}`);
  return v.startsWith('0x') ? parseInt(v, 16) : Number(v);
}

function only(opt, allowed, cmd) {
  for (const k of Object.keys(opt)) need(allowed.includes(k), `${cmd} takes no --${k}`);
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opt } = parseArgs(rest);
  need(pos.length === 1, 'usage: version-map.mjs init|add-build|add-function|add-field|replace-build|remove-key|prune|check <header> [options]; see the comment at the top of ci/version-map.mjs');
  const file = pos[0];
  const load = () => parse(readFileSync(file, 'utf8'), file);
  const save = (map, what) => {
    writeFileSync(file, emit(map));
    process.stderr.write(`version-map: ${file}: ${what}\n`);
  };
  if (cmd === 'init') {
    only(opt, ['flavour', 'built-cl'], cmd);
    need(!existsSync(file), `${file} exists; init writes a new map only`);
    save(emptyMap(opt.flavour, num(opt, 'built-cl', { required: true })), `new ${opt.flavour} map, built CL-${opt['built-cl']}`);
  } else if (cmd === 'add-build') {
    only(opt, ['cl', 'stamp', 'size', 'source'], cmd);
    const map = load();
    const b = { cl: num(opt, 'cl', { required: true }), stamp: num(opt, 'stamp', { required: true, hexOnly: true }), size: num(opt, 'size', { required: true, hexOnly: true }), source: opt.source };
    save(map, addBuild(map, b) ? `added build CL-${b.cl}` : `build CL-${b.cl} already there`);
  } else if (cmd === 'add-function') {
    only(opt, ['key', 'cl', 'rva', 'pattern', 'rva-only', 'result-offset', 'follow-rel32-at', 'follow-rip-disp-at'], cmd);
    need((opt.pattern === undefined) === (opt['rva-only'] === true), 'give --pattern <aob> or --rva-only, not both');
    const map = load();
    const r = {
      key: opt.key, cl: num(opt, 'cl', { required: true }), pattern: opt.pattern ?? null, rva: num(opt, 'rva', { required: true, hexOnly: true }),
      resultOffset: num(opt, 'result-offset', { fallback: 0 }), followRel32At: num(opt, 'follow-rel32-at', { fallback: -1 }), followRipDispAt: num(opt, 'follow-rip-disp-at', { fallback: -1 }),
    };
    save(map, addFunction(map, r) ? `added function row ${rowName(r)}` : `function row ${rowName(r)} already there`);
  } else if (cmd === 'add-field') {
    only(opt, ['key', 'cl', 'offset', 'size', 'mask', 'member'], cmd);
    const map = load();
    const r = { key: opt.key, cl: num(opt, 'cl', { required: true }), offset: num(opt, 'offset', { required: true, hexOnly: true }), size: num(opt, 'size', { required: true, hexOnly: true }), mask: num(opt, 'mask', { fallback: 0, hexOnly: true }), member: opt.member ?? null };
    save(map, addField(map, r) ? `added field row ${rowName(r)}` : `field row ${rowName(r)} already there`);
  } else if (cmd === 'replace-build') {
    only(opt, ['cl', 'stamp', 'size', 'source'], cmd);
    const map = load();
    const b = { cl: num(opt, 'cl', { required: true }), stamp: num(opt, 'stamp', { required: true, hexOnly: true }), size: num(opt, 'size', { required: true, hexOnly: true }), source: opt.source };
    save(map, `replaced build CL-${b.cl}; dropped its ${replaceBuild(map, b)} rows for re-verification`);
  } else if (cmd === 'remove-key') {
    only(opt, ['key'], cmd);
    const map = load();
    const n = removeKey(map, opt.key);
    save(map, `removed ${opt.key}: ${n.functions} function rows, ${n.fields} field rows`);
  } else if (cmd === 'prune') {
    only(opt, ['keep'], cmd);
    need(typeof opt.keep === 'string' && /^\d+(?:,\d+)*$/.test(opt.keep), '--keep takes a comma-separated list of CLs');
    const map = load();
    const n = prune(map, opt.keep.split(',').map(Number));
    save(map, `dropped ${n.builds} builds, ${n.functions} function rows, ${n.fields} field rows`);
  } else if (cmd === 'check') {
    only(opt, ['keys'], cmd);
    const map = load();
    const problems = opt.keys ? checkMap(map, parseKeys(readFileSync(opt.keys, 'utf8'), opt.keys)) : [];
    for (const p of problems) process.stdout.write(`${p}\n`);
    process.stdout.write(`${file}: ${map.builds.length} builds, ${map.functions.length} function rows, ${map.fields.length} field rows; ${opt.keys ? `${problems.length} coverage problems` : 'format only'}\n`);
    return problems.length ? EXIT_VIOLATION : EXIT_OK;
  } else {
    throw new MapError('usage: version-map.mjs init|add-build|add-function|add-field|replace-build|remove-key|prune|check <header> [options]');
  }
  return EXIT_OK;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`version-map: ${e.message}\n`);
    process.exitCode = EXIT_ERROR;
  }
}
