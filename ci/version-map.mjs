#!/usr/bin/env node
// The versioned function and field map: one generated, data-only header,
// version_map.generated.h, in two flavours.
//
// - The loader's map is the central one. It holds the locators of every tracked
//   component's keys on every game build in its build table, and export-feed
//   writes it out as the feed that players' loaders fetch between releases.
// - A plugin's map holds the plugin's own rows for its built CL (kBuiltCL) only.
//   Every other build is the loader map's.
//
// The header is the only copy of the data: this tool parses it, changes the
// parsed map and writes it back, and refuses any header that is not exactly
// what it would write itself.
//
//   node ci/version-map.mjs init <header> --flavour plugin|loader --built-cl <CL>
//   node ci/version-map.mjs add-build <header> --cl <CL> --stamp <hex> --size <hex> --source <text>
//   node ci/version-map.mjs add-function <header> --key <key> --cl <CL> --rva <hex>
//        (--pattern <aob> | --rva-only) [--result-offset <n>] [--follow-rel32-at <n>]
//        [--follow-rip-disp-at <n>] [--kind <1-6> [--fp <hex>]]   (--kind: loader map only, and needed there)
//   node ci/version-map.mjs add-absent <header> --key <key> --cl <CL> --kind <1-6>
//        (--fp <hex> | --owners <owner>[,<owner>...])
//   node ci/version-map.mjs add-field <header> --key <key> --cl <CL> --offset <hex> --size <hex>
//        [--mask <hex>] [--member <name>]
//   node ci/version-map.mjs replace-build <header> --cl <CL> --stamp <hex> --size <hex> --source <text>
//   node ci/version-map.mjs remove-key <header> --key <key>
//   node ci/version-map.mjs prune <header> --keep <CL>[,<CL>...]
//   node ci/version-map.mjs check <header> [--keys <keys.txt>]...
//   node ci/version-map.mjs export-feed <header> --out <file>
//
// init writes an empty map; it refuses to overwrite a file.
// add-build, add-function, add-absent and add-field add one row. A row that is
// already there with the same values changes nothing; one with other values is
// an error, so a run never rewrites what an earlier run verified. The one
// exception is an absent row (loader map only: CI could not place the key on
// that build): a verified add-function replaces it, add-absent never replaces a
// verified row, and add-absent onto an absent row of a global key adds its owners.
// replace-build records a new exe for a CL already in the table (the same CL
// rebuilt) and drops every row of that CL, so each is verified again on the new
// exe. remove-key drops a key's rows on every build (a key the code no longer
// has). prune keeps the builds listed and drops every other build with all its rows.
// check reads the header (any header off the format fails) and, with --keys,
// applies the coverage rule over the union of the key lists given.
// export-feed writes the loader map as the feed: tab-separated, LF, unsigned.
//
// Exit codes: 0 ok; 3 check found a violation; 2 usage, parse or conflict error.
// The format, the feed and the keys file are documented in ci/VERSION-MAP.md.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPattern } from './apply-proposals.mjs';
import { isMain } from './layout-diff.mjs';

export const FORMAT_VERSION = 2;
export const FEED_FORMAT = 1;
export const FEED_MAX_BYTES = 512 * 1024;
export const EXIT_OK = 0;
export const EXIT_VIOLATION = 3;
export const EXIT_ERROR = 2;
export const FLAVOURS = ['plugin', 'loader'];

// PluginScanKind; the loader's PatternKind uses the same numbers. FUNCTION_START
// and DATA read a global key, which names one game symbol; the others read a
// scoped key, <owner>/<hook>, bound to the request it was verified with by fp.
export const KIND = { FUNCTION_START: 1, IN_FUNCTION: 2, CODE: 3, DATA: 4, VTABLE: 5, ANY: 6 };
export const isGlobalKind = (kind) => kind === KIND.FUNCTION_START || kind === KIND.DATA;

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
const isText = (s) => typeof s === 'string' && RE_TEXT.test(s);
// A PluginInfo name or ModLoader: it goes before the '/' of a scoped key and
// into an absent row's comma-separated owner list. Not '-', which the feed
// writes for no owners.
const isOwner = (s) => isText(s) && s !== '-' && !/[,/]/.test(s);
const isScopedKey = (key) => {
  const at = key.indexOf('/');
  return at > 0 && isOwner(key.slice(0, at)) && isText(key.slice(at + 1));
};

function need(ok, message) {
  if (!ok) throw new MapError(message);
}

// ---- The model --------------------------------------------------------------
//
// { flavour, builtCL (null: a feed),
//   builds:    [{ cl, stamp, size, source }],
//   functions: [{ key, kind, fp, cl, absent, pattern (null: RVA-only), resultOffset,
//                 followRel32At, followRipDispAt, rva, owners }],
//   fields:    [{ key, cl, member (null: not renamed), offset, size, mask }] }
//
// A function row's image stamp and size are its build's, so the model keeps them
// in the build table only. A plugin map's function rows have kind 0, fp 0, no
// absent row and no owners, and followRipDispAt -1: those are the loader's.
// A loader row is identified by (key, fp, CL): a scoped key has one row set per
// fp, a global key has fp 0. An absent row has no locator; a global one lists
// the owners whose requests CI tested, sorted.

export function emptyMap(flavour, builtCL) {
  const map = { flavour, builtCL, builds: [], functions: [], fields: [] };
  validate(map);
  return map;
}

const rowName = (r) => `${r.key}${r.fp ? ` (fp ${hex8(r.fp)})` : ''} @ CL-${r.cl}`;
const fnId = (r) => `${r.key}\n${r.fp}\n${r.cl}`;
const fieldId = (r) => `${r.key}\n${r.cl}`;

export function validate(map, { feed = false } = {}) {
  need(FLAVOURS.includes(map.flavour), `flavour must be plugin or loader, not ${map.flavour}`);
  if (feed) need(map.flavour === 'loader' && map.builtCL === null, 'a feed is a loader map without a built CL');
  else need(isInt(map.builtCL, 1, U32), `built CL ${map.builtCL} is not a CL`);
  const plugin = map.flavour === 'plugin';
  const builds = new Set();
  for (const b of map.builds) {
    need(isInt(b.cl, 1, U32), `build CL ${b.cl} is not a CL`);
    need(!builds.has(b.cl), `build CL-${b.cl} is listed twice`);
    builds.add(b.cl);
    need(!plugin || b.cl === map.builtCL, `build CL-${b.cl}: a plugin map holds its built CL-${map.builtCL} only; the loader's map holds every other build`);
    need(isInt(b.stamp, 0, U32) && isInt(b.size, 1, U32), `build CL-${b.cl}: the stamp and the image size must be 32-bit, the size not 0`);
    need(isText(b.source), `build CL-${b.cl}: the source must be printable ASCII without quotes or backslashes`);
  }
  const rows = (list, what, id) => {
    need(list.length <= MAX_ROWS, `more than ${MAX_ROWS} ${what} rows`);
    const seen = new Set();
    for (const r of list) {
      need(isText(r.key), `${what} key ${JSON.stringify(r.key)} must be printable ASCII without quotes or backslashes`);
      need(builds.has(r.cl), `${rowName(r)}: CL-${r.cl} is not in the build table`);
      need(!seen.has(id(r)), `${rowName(r)}: two ${what} rows`);
      seen.add(id(r));
    }
  };
  rows(map.functions, 'function', fnId);
  rows(map.fields, 'field', fieldId);
  const kinds = new Map();
  for (const r of map.functions) {
    need(r.pattern === null || isPattern(r.pattern), `${rowName(r)}: the pattern must be IDA style, upper-case hex bytes and ?? separated by single spaces`);
    need(isInt(r.resultOffset, I32_MIN, I32_MAX), `${rowName(r)}: result offset ${r.resultOffset} is not a 32-bit integer`);
    need(isInt(r.followRel32At, -1, I32_MAX), `${rowName(r)}: follow-rel32-at must be -1 or an offset into the match`);
    need(isInt(r.followRipDispAt, -1, I32_MAX), `${rowName(r)}: follow-rip-disp-at must be -1 or an offset into the match`);
    need(r.followRel32At === -1 || r.followRipDispAt === -1, `${rowName(r)}: a row follows a rel32 or a rip displacement, not both`);
    need(isInt(r.rva, 0, U32), `${rowName(r)}: rva ${r.rva} is not 32-bit`);
    if (plugin) {
      need(r.kind === 0 && r.fp === 0 && r.absent === false && r.owners === null, `${rowName(r)}: kinds, fingerprints and absent rows are the loader map's only`);
      need(r.followRipDispAt === -1, `${rowName(r)}: follow-rip-disp-at is the loader's only`);
    } else {
      need(isInt(r.kind, 1, 6), `${rowName(r)}: kind ${r.kind} is not a PluginScanKind (1-6)`);
      need((kinds.get(r.key) ?? r.kind) === r.kind, `${r.key}: rows of kind ${kinds.get(r.key)} and kind ${r.kind}; a key has one kind`);
      kinds.set(r.key, r.kind);
      if (isGlobalKind(r.kind)) {
        need(!r.key.includes('/'), `${rowName(r)}: kind ${r.kind} reads a global key, which has no '/'`);
        need(r.fp === 0, `${rowName(r)}: a global row has no fp`);
      } else {
        need(isScopedKey(r.key), `${rowName(r)}: kind ${r.kind} reads a scoped key, <owner>/<hook>`);
        need(isInt(r.fp, 1, U32), `${rowName(r)}: a scoped row needs the fp of the request it was verified with, and an fp is never 0`);
      }
      need(typeof r.absent === 'boolean', `${rowName(r)}: absent must be true or false`);
    }
    if (r.absent) {
      need(r.pattern === null && r.rva === 0 && r.resultOffset === 0 && r.followRel32At === -1 && r.followRipDispAt === -1, `${rowName(r)}: an absent row has no pattern, rva or offsets`);
      if (isGlobalKind(r.kind)) {
        need(Array.isArray(r.owners) && r.owners.length > 0 && r.owners.every((o, i) => isOwner(o) && (i === 0 || cmp(r.owners[i - 1], o) < 0)),
          `${rowName(r)}: a global absent row lists the owners whose requests CI tested, sorted, each once`);
      } else {
        need(r.owners === null, `${rowName(r)}: a scoped absent row binds the requests with its fp and lists no owners`);
      }
    } else {
      need(r.owners === null, `${rowName(r)}: only a global absent row lists owners`);
      need(r.pattern !== null || r.rva !== 0, `${rowName(r)}: an RVA-only row needs an rva`);
    }
  }
  for (const r of map.fields) {
    need(r.member === null || (typeof r.member === 'string' && RE_MEMBER.test(r.member)), `${rowName(r)}: member ${JSON.stringify(r.member)} is not an identifier`);
    need(isInt(r.offset, 0, I32_MAX), `${rowName(r)}: offset ${r.offset} is not a member offset`);
    need(isInt(r.size, 1, U32), `${rowName(r)}: size ${r.size} is not a member size`);
    need(isInt(r.mask, 0, 0xff), `${rowName(r)}: bool mask ${r.mask} is not one byte`);
    need(r.mask === 0 || r.size === 1, `${rowName(r)}: a bool mask needs size 1`);
  }
}

const byCL = (a, b) => a.cl - b.cl;
const byKeyThenCL = (a, b) => cmp(a.key, b.key) || a.cl - b.cl;
const byKeyFpCL = (a, b) => cmp(a.key, b.key) || a.fp - b.fp || a.cl - b.cl;

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
  const builds = [...map.builds].sort(byCL);
  const build = new Map(builds.map((b) => [b.cl, b]));
  const str = (s) => (s === null ? 'nullptr' : `"${s}"`);
  const fn = grouped([...map.functions].sort(byKeyFpCL), (r) => {
    const b = build.get(r.cl);
    const head = `{ ${r.cl}, ${hex8(b.stamp)}, ${hex8(b.size)}, `;
    return plugin
      ? `${head}${str(r.pattern)}, ${r.followRel32At >= 0 ? 'PLUGIN_SCAN_FLAG_FOLLOW_REL32' : 'PLUGIN_SCAN_FLAG_NONE'}, ${r.resultOffset}, ${r.followRel32At}, ${hex8(r.rva)} }`
      : `${head}${r.kind}, ${hex8(r.fp)}, ${r.absent}, ${str(r.pattern)}, ${r.resultOffset}, ${r.followRel32At}, ${r.followRipDispAt}, ${hex8(r.rva)}, ${str(r.owners && r.owners.join(','))} }`;
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
          'struct FunctionRow { uint32_t gameCL, imageStamp, imageSize; int32_t kind; uint32_t fp; bool absent; const char* pattern; int32_t resultOffset, followRel32At, followRipDispAt; uint32_t rva; const char* owners; };',
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
const RE_FN_LOADER = new RegExp(`^\\t\\{ (\\d+), 0x[0-9A-F]{8}, 0x[0-9A-F]{8}, (\\d+), 0x([0-9A-F]{8}), (true|false), ${STR}, (-?\\d+), (-?\\d+), (-?\\d+), 0x([0-9A-F]{8}), ${STR} \\},$`);
const RE_FIELD = new RegExp(`^\\t\\{ (\\d+), 0x([0-9A-F]+), 0x([0-9A-F]+), 0x([0-9A-F]{2}), ${STR} \\},$`);
const unquote = (s) => (s === 'nullptr' ? null : s.slice(1, -1));

// Names the first line where `text` differs from what the tool writes.
function sameText(canonical, text, where, what) {
  if (canonical === text) return;
  const want = canonical.split('\n');
  const lines = text.split('\n');
  let i = 0;
  while (i < want.length && i < lines.length && want[i] === lines[i]) i++;
  throw new MapError(`${where}:${i + 1}: not in the form version-map.mjs writes ${what}; expected ${JSON.stringify(want[i] ?? '<end of file>')}, found ${JSON.stringify(lines[i] ?? '<end of file>')}`);
}

function written(write, map, where) {
  try {
    return write(map);
  } catch (e) {
    if (e instanceof MapError) throw new MapError(`${where}: ${e.message}`);
    throw e;
  }
}

// Reads a header this tool wrote. The rows are read loosely and the result is then
// written back: anything that differs from the input, by one byte, is an error
// naming the first line that differs. So a header is accepted only in exactly the
// form emit() gives it: sorted, grouped, indexed and counted. CRLF line ends, which
// a Windows checkout may give, read as LF.
export function parse(text, where = 'header') {
  text = text.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const plugin = lines.includes('#include "plugin_interface.h"');
  const map = { flavour: plugin ? 'plugin' : 'loader', builtCL: 0, builds: [], functions: [], fields: [] };
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
      if (!(m = (plugin ? RE_FN_PLUGIN : RE_FN_LOADER).exec(line))) return;
      need(key !== null, `${at}: a function row before its // key line`);
      const owners = plugin ? null : unquote(m[10]);
      map.functions.push(plugin
        ? { key, kind: 0, fp: 0, cl: Number(m[1]), absent: false, pattern: unquote(m[2]), resultOffset: Number(m[3]), followRel32At: Number(m[4]), followRipDispAt: -1, rva: parseInt(m[5], 16), owners: null }
        : {
            key, kind: Number(m[2]), fp: parseInt(m[3], 16), cl: Number(m[1]), absent: m[4] === 'true', pattern: unquote(m[5]),
            resultOffset: Number(m[6]), followRel32At: Number(m[7]), followRipDispAt: Number(m[8]), rva: parseInt(m[9], 16), owners: owners === null ? null : owners.split(','),
          });
    } else if (section === 'kFieldRows' && (m = RE_FIELD.exec(line))) {
      need(key !== null, `${at}: a field row before its // key line`);
      map.fields.push({ key, cl: Number(m[1]), offset: parseInt(m[2], 16), size: parseInt(m[3], 16), mask: parseInt(m[4], 16), member: unquote(m[5]) });
    }
  });
  sameText(written(emit, map, where), text, where, 'a header');
  return map;
}

// ---- Changing the map -------------------------------------------------------

const same = (row, other) => JSON.stringify(row) === JSON.stringify({ ...row, ...other });

function addRow(list, row, what, id) {
  const old = list.find((r) => id(r) === id(row));
  if (!old) {
    list.push(row);
    return true;
  }
  need(same(old, row), `${rowName(row)}: the map already has a different ${what} row; a verified row is never rewritten`);
  return false;
}

export function addBuild(map, b) {
  const old = map.builds.find((x) => x.cl === b.cl);
  if (old) {
    need(old.stamp === b.stamp && old.size === b.size && old.source === b.source, `build CL-${b.cl} is already in the table with other values`);
    return false;
  }
  map.builds.push(b);
  validate(map);
  return true;
}

// A verified row. In the loader map it replaces an absent row for the same key,
// fp and CL: CI has now placed the key there.
export function addFunction(map, r) {
  const loader = map.flavour === 'loader';
  need(loader || (r.kind === undefined && r.fp === undefined), 'a plugin map has no kinds or fingerprints (--kind, --fp)');
  const row = {
    key: r.key, kind: loader ? r.kind : 0, fp: r.fp ?? 0, cl: r.cl, absent: false, pattern: r.pattern,
    resultOffset: r.resultOffset ?? 0, followRel32At: r.followRel32At ?? -1, followRipDispAt: r.followRipDispAt ?? -1, rva: r.rva, owners: null,
  };
  const at = map.functions.findIndex((x) => fnId(x) === fnId(row));
  let added = true;
  if (at >= 0 && map.functions[at].absent) {
    need(map.functions[at].kind === row.kind, `${rowName(row)}: the absent row there has kind ${map.functions[at].kind}; a key has one kind`);
    map.functions[at] = row;
  } else {
    added = addRow(map.functions, row, 'function', fnId);
  }
  validate(map);
  return added;
}

// CI could not place the key on this build. A global key's absent row binds the
// owners listed (adding one again adds its owners); a scoped key's binds the
// requests with its fp. It never replaces a verified row.
export function addAbsent(map, r) {
  need(map.flavour === 'loader', "absent rows are the loader map's only");
  const owners = r.owners == null ? null : [...new Set(r.owners)].sort(cmp);
  const row = { key: r.key, kind: r.kind, fp: r.fp ?? 0, cl: r.cl, absent: true, pattern: null, resultOffset: 0, followRel32At: -1, followRipDispAt: -1, rva: 0, owners };
  const at = map.functions.findIndex((x) => fnId(x) === fnId(row));
  let added = true;
  if (at < 0) map.functions.push(row);
  else {
    const old = map.functions[at];
    need(old.absent, `${rowName(row)}: the map has a verified row there; an absent row never replaces one`);
    need(old.kind === row.kind, `${rowName(row)}: the absent row there has kind ${old.kind}; a key has one kind`);
    const next = { ...row, owners: old.owners && owners ? [...new Set([...old.owners, ...owners])].sort(cmp) : owners };
    if (same(old, next)) added = false;
    else map.functions[at] = next;
  }
  validate(map);
  return added;
}

export function addField(map, r) {
  const row = { key: r.key, cl: r.cl, member: r.member ?? null, offset: r.offset, size: r.size, mask: r.mask ?? 0 };
  const added = addRow(map.fields, row, 'field', fieldId);
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

// ---- The feed -----------------------------------------------------------------
//
// The loader map as players' loaders fetch it: one record per line, fields
// separated by a tab, LF, unsigned (signing appends its own line later):
//   format  1
//   build     <cl> <stamp> <size> <source>
//   function  <key> <fp> <cl> <stamp> <size> <kind> <pattern|-> <resultOffset> <followRel32At> <followRipDispAt> <rva>
//   absent    <key> <fp> <cl> <stamp> <size> <kind> <owners|->
//   field     <key> <cl> <offset> <size> <mask> <member|->
// Builds sorted by CL; function and absent lines together by key, fp and CL
// (one exe per CL); field lines by key and CL. Numbers as in the header.

const FEED_COLUMNS = { build: 5, function: 12, absent: 8, field: 7 };

export function exportFeed(map) {
  need(map.flavour === 'loader', "export-feed reads the loader's map; a plugin map has no feed");
  validate(map, { feed: map.builtCL === null });
  const build = new Map(map.builds.map((b) => [b.cl, b]));
  const or = (s) => s ?? '-';
  const lines = [`format\t${FEED_FORMAT}`];
  for (const b of [...map.builds].sort(byCL)) lines.push(['build', b.cl, hex8(b.stamp), hex8(b.size), b.source].join('\t'));
  for (const r of [...map.functions].sort(byKeyFpCL)) {
    const head = [r.absent ? 'absent' : 'function', r.key, hex8(r.fp), r.cl, hex8(build.get(r.cl).stamp), hex8(build.get(r.cl).size), r.kind];
    lines.push((r.absent ? [...head, or(r.owners && r.owners.join(','))] : [...head, or(r.pattern), r.resultOffset, r.followRel32At, r.followRipDispAt, hex8(r.rva)]).join('\t'));
  }
  for (const r of [...map.fields].sort(byKeyThenCL)) lines.push(['field', r.key, r.cl, hex(r.offset), hex(r.size), hex2(r.mask), or(r.member)].join('\t'));
  const text = lines.join('\n') + '\n';
  need(Buffer.byteLength(text) <= FEED_MAX_BYTES, `the feed is ${Buffer.byteLength(text)} bytes, over the ${FEED_MAX_BYTES} the export allows (loaders cap it at 1 MiB)`);
  return text;
}

// Reads a feed export-feed wrote, strictly: loosely into the model, then
// exported again, and any byte of difference is an error naming the first line.
// No CRLF: the feed is bytes as signed, not a checkout.
export function parseFeed(text, where = 'feed') {
  const lines = text.split('\n');
  need(lines[0] === `format\t${FEED_FORMAT}`, `${where}:1: not a format ${FEED_FORMAT} feed; found ${JSON.stringify(lines[0])}`);
  const map = { flavour: 'loader', builtCL: null, builds: [], functions: [], fields: [] };
  const dec = (s) => (/^-?\d+$/.test(s) ? Number(s) : NaN);
  const hx = (s) => (/^0x[0-9A-F]+$/.test(s) ? parseInt(s, 16) : NaN);
  const orNull = (s) => (s === '-' ? null : s);
  lines.forEach((line, i) => {
    if (i === 0 || (i === lines.length - 1 && line === '')) return;
    const f = line.split('\t');
    need(Object.hasOwn(FEED_COLUMNS, f[0]) && f.length === FEED_COLUMNS[f[0]], `${where}:${i + 1}: not a feed line: ${JSON.stringify(line)}`);
    if (f[0] === 'build') map.builds.push({ cl: dec(f[1]), stamp: hx(f[2]), size: hx(f[3]), source: f[4] });
    else if (f[0] === 'field') map.fields.push({ key: f[1], cl: dec(f[2]), member: orNull(f[6]), offset: hx(f[3]), size: hx(f[4]), mask: hx(f[5]) });
    else {
      const row = { key: f[1], kind: dec(f[6]), fp: hx(f[2]), cl: dec(f[3]), absent: f[0] === 'absent' };
      const owners = f[0] === 'absent' ? orNull(f[7]) : null;
      map.functions.push(f[0] === 'absent'
        ? { ...row, pattern: null, resultOffset: 0, followRel32At: -1, followRipDispAt: -1, rva: 0, owners: owners === null ? null : owners.split(',') }
        : { ...row, pattern: orNull(f[7]), resultOffset: dec(f[8]), followRel32At: dec(f[9]), followRipDispAt: dec(f[10]), rva: hx(f[11]), owners: null });
    }
  });
  sameText(written(exportFeed, map, where), text, where, 'a feed');
  return map;
}

// ---- The keys the components use, and the coverage check ----------------------
//
// One key per line, '#' comments and blank lines skipped:
//   function <key>                         a hookName, a map key or a loader registry name
//   required <key>                         a function key the loader cannot run without
//   native <key> [<offset> <size> <mask>]  a native field; the values as built, in hex
//   field <key>                            a reflected field (rows only where it moved)

const RE_KEYLINE = /^(function|required|native|field) (.+?)(?: (0x[0-9A-Fa-f]+) (0x[0-9A-Fa-f]+) (0x[0-9A-Fa-f]+))?$/;

const emptyKeys = () => ({ functions: new Set(), required: new Set(), native: new Map(), fields: new Set(), at: new Map() });

export function parseKeys(text, where = 'keys') {
  const keys = emptyKeys();
  text.replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = RE_KEYLINE.exec(line);
    need(m && isText(m[2]), `${where}:${i + 1}: expected "function <key>", "required <key>", "native <key> [<offset> <size> <mask>]" or "field <key>"`);
    const [, kind, key, off, size, mask] = m;
    need(kind === 'native' || off === undefined, `${where}:${i + 1}: built values are for native keys only`);
    need(!/ 0x[0-9A-Fa-f]+$/.test(key), `${where}:${i + 1}: built values are an offset, a size and a mask, all three`);
    if (off !== undefined) {
      const [o, n, b] = [off, size, mask].map((v) => parseInt(v, 16));
      need(isInt(o, 0, I32_MAX) && isInt(n, 1, U32) && isInt(b, 0, 0xff) && (b === 0 || n === 1), `${where}:${i + 1}: built values out of range (offset, size not 0, a one-byte mask only with size 1)`);
    }
    need(!keys.at.has(key), `${where}:${i + 1}: ${key} is listed twice`);
    keys.at.set(key, { kind: kind === 'required' ? 'function' : kind, where: `${where}:${i + 1}` });
    if (kind === 'function' || kind === 'required') keys.functions.add(key);
    if (kind === 'required') keys.required.add(key);
    else if (kind === 'field') keys.fields.add(key);
    else if (kind === 'native') keys.native.set(key, off === undefined ? null : { offset: parseInt(off, 16), size: parseInt(size, 16), mask: parseInt(mask, 16) });
  });
  return keys;
}

// The union of several components' key lists. A key may be in more than one (a
// global symbol two plugins use), but as one kind in all: a function key
// (required if any list says so), a native key with the same built values, or
// a field key.
export function unionKeys(lists) {
  const out = emptyKeys();
  const values = (v) => `${hex(v.offset)}/${hex(v.size)}/${hex2(v.mask)}`;
  for (const keys of lists) {
    for (const [key, at] of keys.at) {
      const was = out.at.get(key);
      if (!was) out.at.set(key, at);
      else need(was.kind === at.kind, `${key} is a ${was.kind} key at ${was.where} and a ${at.kind} key at ${at.where}`);
    }
    for (const key of keys.functions) out.functions.add(key);
    for (const key of keys.required) out.required.add(key);
    for (const key of keys.fields) out.fields.add(key);
    for (const [key, b] of keys.native) {
      const a = out.native.get(key);
      need(!a || !b || values(a) === values(b), `native ${key} is built as ${b && values(b)} at ${keys.at.get(key).where}, and as ${a && values(a)} in an earlier list`);
      if (!a) out.native.set(key, b);
    }
  }
  return out;
}

// Every violation of the coverage rule, one line each; [] when the map is complete.
// A function key needs a row on every build, a locator or absent; a scoped key
// one for every fp the map holds for it. A required global key may not be absent.
export function checkMap(map, keys) {
  const out = [];
  const has = (list, key, cl) => list.find((r) => r.key === key && r.cl === cl);
  const ids = new Set(map.functions.map(fnId));
  const fps = new Map();
  for (const r of map.functions) fps.set(r.key, [...new Set([...(fps.get(r.key) ?? []), r.fp])].sort((a, b) => a - b));
  if (!map.builds.some((b) => b.cl === map.builtCL)) out.push(`the built CL-${map.builtCL} has no build row`);
  for (const key of new Set(map.functions.map((r) => r.key))) if (!keys.functions.has(key)) out.push(`orphan function key ${key}: no key list has it`);
  for (const key of new Set(map.fields.map((r) => r.key))) if (!keys.native.has(key) && !keys.fields.has(key)) out.push(`orphan field key ${key}: no key list has it`);
  for (const b of [...map.builds].sort(byCL)) {
    for (const key of [...keys.functions].sort(cmp)) {
      if (!fps.has(key)) out.push(`no function row for ${key} on CL-${b.cl}`);
      else for (const fp of fps.get(key)) if (!ids.has(fnId({ key, fp, cl: b.cl }))) out.push(`no function row for ${key}${fp ? ` (fp ${hex8(fp)})` : ''} on CL-${b.cl}`);
    }
    for (const key of [...keys.native.keys()].sort(cmp)) if (!has(map.fields, key, b.cl)) out.push(`no native field row for ${key} on CL-${b.cl}`);
  }
  for (const key of [...keys.required].sort(cmp)) {
    for (const r of map.functions.filter((x) => x.key === key && x.absent && isGlobalKind(x.kind)).sort(byCL)) {
      out.push(`required key ${key} is absent on CL-${r.cl}: the loader needs a locator there`);
    }
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
const LISTS = new Set(['keys']);

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.slice(2);
    if (!a.startsWith('--')) pos.push(a);
    else if (FLAGS.has(name)) opt[name] = true;
    else {
      need(i + 1 < argv.length, `missing value for ${a}`);
      if (LISTS.has(name)) (opt[name] ??= []).push(argv[++i]);
      else {
        need(!(name in opt), `${a} is given twice`);
        opt[name] = argv[++i];
      }
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

const USAGE = 'usage: version-map.mjs init|add-build|add-function|add-absent|add-field|replace-build|remove-key|prune|check|export-feed <header> [options]; see the comment at the top of ci/version-map.mjs';

export function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opt } = parseArgs(rest);
  need(pos.length === 1, USAGE);
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
    only(opt, ['key', 'cl', 'rva', 'pattern', 'rva-only', 'result-offset', 'follow-rel32-at', 'follow-rip-disp-at', 'kind', 'fp'], cmd);
    need((opt.pattern === undefined) === (opt['rva-only'] === true), 'give --pattern <aob> or --rva-only, not both');
    const map = load();
    const r = {
      key: opt.key, cl: num(opt, 'cl', { required: true }), pattern: opt.pattern ?? null, rva: num(opt, 'rva', { required: true, hexOnly: true }),
      resultOffset: num(opt, 'result-offset', { fallback: 0 }), followRel32At: num(opt, 'follow-rel32-at', { fallback: -1 }), followRipDispAt: num(opt, 'follow-rip-disp-at', { fallback: -1 }),
      kind: num(opt, 'kind'), fp: num(opt, 'fp', { hexOnly: true }),
    };
    save(map, addFunction(map, r) ? `added function row ${rowName(r)}` : `function row ${rowName(r)} already there`);
  } else if (cmd === 'add-absent') {
    only(opt, ['key', 'cl', 'kind', 'fp', 'owners'], cmd);
    need(opt.owners === undefined || /^[^,]+(?:,[^,]+)*$/.test(opt.owners), '--owners takes a comma-separated list of owners');
    const map = load();
    const r = { key: opt.key, cl: num(opt, 'cl', { required: true }), kind: num(opt, 'kind', { required: true }), fp: num(opt, 'fp', { hexOnly: true }), owners: opt.owners?.split(',') ?? null };
    save(map, addAbsent(map, r) ? `added absent row ${rowName(r)}` : `absent row ${rowName(r)} already there`);
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
    const problems = opt.keys ? checkMap(map, unionKeys(opt.keys.map((f) => parseKeys(readFileSync(f, 'utf8'), f)))) : [];
    for (const p of problems) process.stdout.write(`${p}\n`);
    process.stdout.write(`${file}: ${map.builds.length} builds, ${map.functions.length} function rows, ${map.fields.length} field rows; ${opt.keys ? `${problems.length} coverage problems` : 'format only'}\n`);
    return problems.length ? EXIT_VIOLATION : EXIT_OK;
  } else if (cmd === 'export-feed') {
    only(opt, ['out'], cmd);
    need(typeof opt.out === 'string', '--out is required');
    const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    need(!same(resolve(opt.out), resolve(file)), '--out must not be the header');
    const text = exportFeed(load());
    writeFileSync(opt.out, text);
    process.stderr.write(`version-map: ${opt.out}: feed format ${FEED_FORMAT}, ${text.split('\n').length - 1} lines, ${Buffer.byteLength(text)} bytes\n`);
  } else {
    throw new MapError(USAGE);
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
