#!/usr/bin/env node
// List the Game-SDK classes our mods use, from the loader and plugin sources.
//
//   node ci/used-classes.mjs <source-dir>... [--known <Assertions.inl|.tsv>]...
//                            [--out used.txt] [--json report.json]
//
// What counts as a use:
//   * `SDK::X`, `SDK::Ns::X` and `SDK::X::Member`, anywhere (templates,
//     pointers, casts, using-aliases all contain the same token).
//   * `using SDK::X;`
//   * Unqualified names in a file that says `using namespace SDK;`, and inside
//     `namespace SDK { ... }` blocks (forward declarations).
//
// Limits: the match is by name and is not transitive. A member reached through
// a derived class but declared on a base class, an `auto` result, or a call on
// an instance whose type is never spelled out is not seen unless the owning
// class is named somewhere in the sources. Add such classes to the list by hand.
//
// Without --known an unqualified token is accepted when it looks like a UE type
// name (U/A/F/E/T/I/S + capital) and every prefix of an `SDK::` chain is listed:
// an over-approximation, which only costs unmatched names downstream. With
// --known (repeatable; pass the Client and Server Assertions.inl, or their
// TSVs) a name is kept only when it is a class in that layout, which gives the
// precise set. Comments and string literals are ignored.
//
// Output: one class name per line (`#` comments allowed), the format
// `layout-diff.mjs diff --used` reads.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isMain, loadLayout } from './layout-diff.mjs';

const SOURCE_EXT = /\.(cpp|cc|cxx|c|h|hpp|hxx|inl)$/i;
// Dumper's own output, vendored libraries, tests and build trees are not mod code.
const SKIP_DIRS = new Set([
  '.git', 'build', 'obj', 'x64', 'node_modules', 'StarRupture SDK', 'StarRupture-ImGui',
  'Tests', 'tests', 'out', 'bin',
]);

// Replace comments and string/char literals with spaces (newlines kept).
export function stripNonCode(src) {
  let out = '';
  const n = src.length;
  for (let i = 0; i < n; ) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
    } else if (c === 'R' && d === '"' && /[^A-Za-z0-9_]/.test(src[i - 1] ?? ' ')) {
      const open = src.indexOf('(', i + 2);
      const delim = open < 0 ? '' : src.slice(i + 2, open);
      const end = open < 0 ? -1 : src.indexOf(')' + delim + '"', open);
      const stop = end < 0 ? n : end + delim.length + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
    } else if (c === '"' || c === "'") {
      out += ' '; i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { out += ' '; i++; }
        out += ' '; i++;
      }
      if (i < n && src[i] === c) { out += ' '; i++; }
    } else {
      out += c; i++;
    }
  }
  return out;
}

// Text inside every `namespace SDK[::X] { ... }` block.
function sdkNamespaceBlocks(code) {
  const blocks = [];
  const re = /\bnamespace\s+SDK(?:::\w+)*\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
    }
    blocks.push(code.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return blocks;
}

const TYPE_LIKE = /^[UAFETIS][A-Z][A-Za-z0-9_]*$/;

// Returns [{ name, how }] for one file.
export function extractFromSource(src) {
  const code = stripNonCode(src);
  const found = [];
  // SDK::A, SDK::A::B, SDK::A::B::C. Every prefix is a candidate.
  const chain = /\bSDK\s*::\s*([A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*)/g;
  let m;
  while ((m = chain.exec(code))) {
    const parts = m[1].split(/\s*::\s*/);
    for (let k = 1; k <= parts.length; k++) found.push({ name: parts.slice(0, k).join('::'), how: 'qualified' });
    paramsStructs(parts, found);
  }
  const usingDecl = /\busing\s+SDK\s*::\s*([A-Za-z_]\w*)\s*;/g;
  while ((m = usingDecl.exec(code))) found.push({ name: m[1], how: 'using-decl' });

  const regions = sdkNamespaceBlocks(code).map((t) => ({ text: t, how: 'namespace-block' }));
  if (/\busing\s+namespace\s+SDK\b/.test(code)) regions.push({ text: code, how: 'using-namespace' });
  for (const { text, how } of regions) {
    // An identifier after `::` or `.`/`->` belongs to something else.
    const id = /(?<![\w:.>])([A-Za-z_]\w*)\b/g;
    let t;
    while ((t = id.exec(text))) found.push({ name: t[1], how, unqualified: true });
    const pair = /(?<![\w:.>])([A-Za-z_]\w*)\s*::\s*([A-Za-z_]\w*)/g;
    while ((t = pair.exec(text))) paramsStructs([t[1], t[2]], found);
  }
  return found;
}

// Calling `UFoo::Bar(...)` fills the parameter struct Dumper names `Foo_Bar`
// (reachable as `Params::Foo_Bar`); a layout change in it breaks the call just
// like a change in the class does. These names only resolve against --known.
function paramsStructs(parts, found) {
  if (parts[0] === 'Params' && parts.length > 1) {
    found.push({ name: parts[1], how: 'params-struct', derived: true });
  } else if (parts.length > 1) {
    found.push({ name: `${parts[0]}_${parts[1]}`, how: 'function-params', derived: true });
    found.push({ name: `${parts[0].slice(1)}_${parts[1]}`, how: 'function-params', derived: true });
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (SOURCE_EXT.test(name)) yield p;
  }
}

export function knownFilter(layouts) {
  const full = new Set();
  for (const l of layouts) for (const c of l.keys()) full.add(c);
  return (name) => full.has(name);
}

export function collectUsed(dirs, known = null) {
  const names = new Map(); // name -> { files:Set, how:Set }
  let files = 0;
  for (const root of dirs) {
    for (const file of walk(root)) {
      files++;
      const rel = relative(root, file).split(sep).join('/');
      const tag = `${root.split(/[\\/]/).filter(Boolean).pop()}/${rel}`;
      for (const { name, how, unqualified, derived } of extractFromSource(readFileSync(file, 'utf8'))) {
        if (known ? !known(name) : derived || (unqualified && !TYPE_LIKE.test(name))) continue;
        let e = names.get(name);
        if (!e) names.set(name, (e = { files: new Set(), how: new Set() }));
        e.files.add(tag);
        e.how.add(how);
      }
    }
  }
  return { names, files };
}

// Every name the sources use as a member: the identifier after `.`, `->` or
// `::`, and the member named in `offsetof(T, M)` (a read at a fixed offset).
// By name only, not tied to a class, so it over-approximates. Used by
// `layout-table.mjs gen --granularity 1` to keep only the rows a project reads.
export function collectMemberNames(dirs) {
  const names = new Set();
  for (const code of sources(dirs)) {
    for (const m of code.matchAll(/(?:\.|->|::)\s*([A-Za-z_]\w*)/g)) names.add(m[1]);
    for (const m of code.matchAll(/\boffsetof\s*\(\s*[^,()]+,\s*([A-Za-z_]\w*)/g)) names.add(m[1]);
  }
  return names;
}

// Every type the sources take `sizeof` or `alignof` of (`SDK::` and `const`
// dropped, `Ns::X` kept as written). Code that allocates, copies or strides
// over a class by value depends on its size, so `gen --granularity 1` keeps
// the size of those classes.
export function collectSizedNames(dirs) {
  const names = new Set();
  const re = /\b(?:sizeof|alignof)\s*\(\s*(?:(?:const|class|struct)\s+)*(?:::\s*)?(?:SDK\s*::\s*)?([A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*)\s*\)/g;
  for (const code of sources(dirs)) {
    for (const m of code.matchAll(re)) names.add(m[1].replace(/\s+/g, ''));
  }
  return names;
}

function* sources(dirs) {
  for (const root of dirs) for (const file of walk(root)) yield stripNonCode(readFileSync(file, 'utf8'));
}

function main(argv) {
  const dirs = [];
  const knownFiles = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--known') knownFiles.push(argv[++i]);
    else if (a === '--out' || a === '--json') opt[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else dirs.push(a);
  }
  if (dirs.length === 0) throw new Error('usage: used-classes.mjs <source-dir>... [--known <file>]... [--out f] [--json f]');
  const known = knownFiles.length ? knownFilter(knownFiles.map(loadLayout)) : null;
  const { names, files } = collectUsed(dirs, known);
  const sorted = [...names.keys()].sort();
  const text = `# SDK classes used by the scanned sources (${sorted.length} names, ${files} files, ${known ? 'filtered by --known' : 'unfiltered'})\n${sorted.join('\n')}\n`;
  if (opt.out) writeFileSync(opt.out, text);
  else process.stdout.write(text);
  if (opt.json) {
    const report = { files, count: sorted.length, filtered: !!known, classes: Object.fromEntries(sorted.map((n) => [n, { how: [...names.get(n).how].sort(), files: [...names.get(n).files].sort() }])) };
    writeFileSync(opt.json, JSON.stringify(report, null, 2) + '\n');
  }
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`used-classes: ${e.message}\n`);
    process.exitCode = 2;
  }
}
