#!/usr/bin/env node
// Compare Dumper-7 struct layouts between two game builds.
//
//   node ci/layout-diff.mjs tsv <Assertions.inl> [--out layout.tsv]
//   node ci/layout-diff.mjs diff <old> <new> [--used used-classes.txt] [--out report.json]
//   node ci/layout-diff.mjs synthesize <oldClient> <oldServer> <newServer>
//                                      [--out newClient.tsv] [--check <realNewClient>]
//   (`--synthesize` is accepted in place of `synthesize`)
//
// <old>, <new> and the synthesize inputs are Dumper-7 `Assertions.inl` files or
// the TSV this script writes. No dependencies.
//
// TSV columns: class, member, offset, size. A member row carries its offset
// (hex) and an empty size. Each class also has two pseudo-members:
//   @size   offset empty, size = sizeof(class)
//   @align  offset empty, size = alignof(class)
//
// `diff` exit codes: 0 no used class changed, 3 at least one did, 2 parse or
// usage error. Without --used every class counts as used, so any change exits 3.
// A class present in only one of the two files counts as changed.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// True when the module at `moduleUrl` is the script node was started with. Both
// sides go through realpath, so a symlink or junction to the script still runs it.
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

export const EXIT_OK = 0;
export const EXIT_USED_CHANGED = 3;
export const EXIT_ERROR = 2;

export class ParseError extends Error {}

const SIZE = '@size';
const ALIGN = '@align';

const RE_ALIGN = /^static_assert\(alignof\((.+)\) == 0x([0-9A-Fa-f]+), "Wrong alignment on .*"\);( \\)?$/;
const RE_SIZE = /^static_assert\(sizeof\((.+)\) == 0x([0-9A-Fa-f]+), "Wrong size on .*"\);( \\)?$/;
const RE_OFFSET = /^static_assert\(offsetof\((.+), ([A-Za-z0-9_]+)\) == 0x([0-9A-Fa-f]+), "Member '.*' has a wrong offset!"\);( \\)?$/;
const RE_IGNORED = /^(\/\/|\/\*|\*|#pragma|SDK_NAMESPACE_START|#define DUMPER7_ASSERTS_\S+ \\$)/;

// A layout is a Map<class, Map<member, number>>; @size and @align are members.
function setValue(layout, cls, member, value, where) {
  let members = layout.get(cls);
  if (!members) layout.set(cls, (members = new Map()));
  const prev = members.get(member);
  if (prev !== undefined && prev !== value) {
    throw new ParseError(`${where}: conflicting duplicate ${cls}.${member} (${prev} vs ${value})`);
  }
  members.set(member, value);
}

export function parseAssertions(text, label = 'input') {
  const layout = new Map();
  let sawEnd = false;
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '').trim();
    if (line === '') continue;
    const where = `${label}:${i + 1}`;
    let m;
    if (line.startsWith('static_assert(')) {
      if ((m = RE_OFFSET.exec(line))) setValue(layout, m[1], m[2], parseInt(m[3], 16), where);
      else if ((m = RE_SIZE.exec(line))) setValue(layout, m[1], SIZE, parseInt(m[2], 16), where);
      else if ((m = RE_ALIGN.exec(line))) setValue(layout, m[1], ALIGN, parseInt(m[2], 16), where);
      else throw new ParseError(`${where}: unrecognised static_assert: ${line.slice(0, 120)}`);
    } else if (line === 'SDK_NAMESPACE_END') {
      sawEnd = true;
    } else if (!RE_IGNORED.test(line)) {
      throw new ParseError(`${where}: unrecognised line: ${line.slice(0, 120)}`);
    }
  }
  if (!sawEnd) throw new ParseError(`${label}: SDK_NAMESPACE_END missing (truncated file?)`);
  if (layout.size === 0) throw new ParseError(`${label}: no classes found`);
  for (const [cls, members] of layout) {
    if (!members.has(SIZE)) throw new ParseError(`${label}: class ${cls} has no sizeof assertion`);
  }
  return layout;
}

export function layoutToTsv(layout) {
  const out = [];
  for (const cls of [...layout.keys()].sort()) {
    const members = layout.get(cls);
    out.push(`${cls}\t${ALIGN}\t\t${members.get(ALIGN) ?? ''}`);
    out.push(`${cls}\t${SIZE}\t\t${members.get(SIZE)}`);
    const names = [...members.keys()].filter((k) => k !== SIZE && k !== ALIGN);
    // Keep Dumper's declaration order out of it: sort by offset, then name.
    names.sort((a, b) => members.get(a) - members.get(b) || (a < b ? -1 : a > b ? 1 : 0));
    for (const n of names) out.push(`${cls}\t${n}\t0x${members.get(n).toString(16).toUpperCase().padStart(6, '0')}\t`);
  }
  return out.join('\n') + '\n';
}

export function parseTsv(text, label = 'input') {
  const layout = new Map();
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line === '') continue;
    const f = line.split('\t');
    const where = `${label}:${i + 1}`;
    if (f.length !== 4 || f[0] === '' || f[1] === '') throw new ParseError(`${where}: expected 4 tab-separated columns`);
    const [cls, member, off, size] = f;
    const raw = member === SIZE || member === ALIGN ? size : off;
    if (!/^(0x[0-9A-Fa-f]+|\d+)$/.test(raw)) throw new ParseError(`${where}: bad number '${raw}'`);
    setValue(layout, cls, member, Number(raw), where);
  }
  if (layout.size === 0) throw new ParseError(`${label}: no rows`);
  for (const [cls, members] of layout) {
    if (!members.has(SIZE)) throw new ParseError(`${label}: class ${cls} has no @size row`);
  }
  return layout;
}

export function loadLayout(path) {
  const text = readFileSync(path, 'utf8');
  return /\.tsv$/i.test(path) ? parseTsv(text, path) : parseAssertions(text, path);
}

// ---- used-class filter -----------------------------------------------------

export function parseUsedList(text) {
  const names = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    names.add(line.replace(/^(::)?(SDK::)?/, ''));
  }
  return names;
}

// A used name U selects class C when C is U, a namespace-qualified U
// (`Ns::U`) or something nested inside U (`U::FNested`). Deliberately wide:
// over-matching costs a HOLD, under-matching ships corrupt memory.
export function matchUsed(used, classNames) {
  const matched = new Map(); // class -> used name that selected it
  const unmatched = [];
  const all = [...classNames];
  for (const u of used) {
    let hit = false;
    for (const c of all) {
      if (c === u || c.endsWith('::' + u) || c.startsWith(u + '::')) {
        if (!matched.has(c)) matched.set(c, u);
        hit = true;
      }
    }
    if (!hit) unmatched.push(u);
  }
  return { matched, unmatched: unmatched.sort() };
}

// ---- diff ------------------------------------------------------------------

function classDeltas(o, n) {
  const deltas = [];
  const keys = new Set([...(o ? o.keys() : []), ...(n ? n.keys() : [])]);
  for (const k of [...keys].sort()) {
    const a = o?.get(k);
    const b = n?.get(k);
    if (a === b) continue;
    const type = k === SIZE ? 'size' : k === ALIGN ? 'align' : a === undefined ? 'added' : b === undefined ? 'removed' : 'offset';
    deltas.push({ member: k, type, old: a ?? null, new: b ?? null });
  }
  return deltas;
}

// Every class in either layout; a class missing on one side is changed.
export function diffLayouts(oldL, newL) {
  const changed = new Map(); // class -> { kind, deltas }
  for (const cls of new Set([...oldL.keys(), ...newL.keys()])) {
    const o = oldL.get(cls);
    const n = newL.get(cls);
    const kind = !o ? 'added' : !n ? 'removed' : 'changed';
    const deltas = classDeltas(o, n);
    if (deltas.length > 0 || kind !== 'changed') changed.set(cls, { kind, deltas });
  }
  return changed;
}

function layoutStats(layout) {
  let rows = 0;
  for (const m of layout.values()) rows += m.size;
  return { classes: layout.size, rows };
}

const LAYOUT_TYPES = new Set(['offset', 'size', 'align']);

// A class whose size, alignment or a surviving member's offset moved: the
// "layout changed" measure of the design (628 / 0 / 300 on the client dumps).
// Added or removed members alone, and classes that appear or vanish, are
// counted separately but still make a used class "changed".
const layoutMoved = (c) => c.kind === 'changed' && c.deltas.some((d) => LAYOUT_TYPES.has(d.type));

export function buildReport(oldL, newL, used, labels = {}) {
  const changed = diffLayouts(oldL, newL);
  const count = (kind) => [...changed.values()].filter((c) => c.kind === kind).length;
  const universe = new Set([...oldL.keys(), ...newL.keys()]);
  const filter = used ? matchUsed(used, universe) : null;
  const entry = (cls, usedAs, c) => ({ class: cls, usedAs, kind: c.kind, layoutMoved: layoutMoved(c), deltas: c.deltas });
  const changedUsed = [];
  if (filter) {
    for (const [cls, usedAs] of filter.matched) {
      const c = changed.get(cls);
      if (c) changedUsed.push(entry(cls, usedAs, c));
    }
  } else {
    for (const [cls, c] of changed) changedUsed.push(entry(cls, null, c));
  }
  changedUsed.sort((a, b) => (a.class < b.class ? -1 : 1));
  return {
    old: { file: labels.old ?? null, ...layoutStats(oldL) },
    new: { file: labels.new ?? null, ...layoutStats(newL) },
    changedClasses: changed.size,
    layoutChangedClasses: [...changed.values()].filter(layoutMoved).length,
    changedByKind: { changed: count('changed'), added: count('added'), removed: count('removed') },
    changedClassNames: [...changed.keys()].sort(),
    used: filter
      ? { requested: used.size, matchedClasses: filter.matched.size, unmatchedNames: filter.unmatched }
      : null,
    changedUsedClasses: changedUsed.length,
    layoutChangedUsedClasses: changedUsed.filter((c) => c.layoutMoved).length,
    changedUsed,
  };
}

// ---- synthesis: newClient = newServer + (oldClient - oldServer) ------------

export function synthesizeClient(oldClient, oldServer, newServer) {
  const out = new Map();
  const put = (cls, member, value) => {
    let m = out.get(cls);
    if (!m) out.set(cls, (m = new Map()));
    m.set(member, value);
  };
  for (const cls of new Set([...oldClient.keys(), ...oldServer.keys(), ...newServer.keys()])) {
    const oc = oldClient.get(cls);
    const os = oldServer.get(cls);
    const ns = newServer.get(cls);
    if (os && !oc) continue; // server-only class
    if (oc && !os) {
      // Client-only class: no server delta exists, carry it over unchanged.
      for (const [k, v] of oc) put(cls, k, v);
      continue;
    }
    if (!ns) continue; // gone from the server
    // New class on the server (neither old side has it): assume shared.
    // Shared class: apply the old client-vs-server delta row by row.
    for (const [k, v] of ns) {
      if (oc && os) {
        const c = oc.get(k);
        const s = os.get(k);
        if (s !== undefined && c === undefined) continue; // server-only member
        if (s === undefined) { put(cls, k, v); continue; } // new member
        put(cls, k, v + (c - s));
      } else {
        put(cls, k, v);
      }
    }
    // Client-only members of a shared class: nothing in the server says where
    // they went, so keep the old value.
    if (oc && os) for (const [k, v] of oc) if (!os.has(k)) put(cls, k, v);
  }
  return out;
}

// Compare a synthesized client with the real one. "Shared" rows exist in all
// four dumps (old/new, client/server), so the formula has everything it needs;
// rows missing from or extra in the synthesis are new or renamed on one side
// only (for example Dumper's hash-named FPropertyBag structs) and are counted,
// not judged.
export function compareSynthesis(synth, oldClient, oldServer, newServer, realClient) {
  const get = (l, c, k) => l.get(c)?.get(k);
  const r = { sharedRows: 0, sharedRowsExact: 0, movedRows: 0, movedRowsExact: 0, wrongRows: 0, missingRows: 0, extraRows: 0, samples: [] };
  for (const [cls, rm] of realClient) {
    for (const [k, real] of rm) {
      const got = get(synth, cls, k);
      const [oc, os, ns] = [get(oldClient, cls, k), get(oldServer, cls, k), get(newServer, cls, k)];
      if (got === undefined) { r.missingRows++; continue; }
      if (got !== real) { r.wrongRows++; if (r.samples.length < 5) r.samples.push(`${cls}.${k}: synthesized ${got}, real ${real}`); }
      if (oc !== undefined && os !== undefined && ns !== undefined) {
        const moved = oc !== os || os !== ns;
        r.sharedRows++;
        if (moved) r.movedRows++;
        if (got === real) { r.sharedRowsExact++; if (moved) r.movedRowsExact++; }
      }
    }
  }
  for (const [cls, sm] of synth) for (const k of sm.keys()) if (get(realClient, cls, k) === undefined) r.extraRows++;
  return r;
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--synthesize') pos.unshift('synthesize');
    else if (a.startsWith('--')) {
      const v = argv[++i];
      if (v === undefined) throw new ParseError(`missing value for ${a}`);
      opt[a.slice(2)] = v;
    } else pos.push(a);
  }
  return { pos, opt };
}

function emit(opt, text) {
  if (opt.out) writeFileSync(opt.out, text);
  else process.stdout.write(text);
}

export function main(argv) {
  const { pos, opt } = parseArgs(argv);
  const [cmd, ...args] = pos;
  const need = (n, usage) => {
    if (args.length !== n) throw new ParseError(`usage: layout-diff.mjs ${usage}`);
  };
  switch (cmd) {
    case 'tsv': {
      need(1, 'tsv <Assertions.inl> [--out layout.tsv]');
      emit(opt, layoutToTsv(loadLayout(args[0])));
      return EXIT_OK;
    }
    case 'diff': {
      need(2, 'diff <old> <new> [--used list.txt] [--out report.json]');
      const used = opt.used ? parseUsedList(readFileSync(opt.used, 'utf8')) : null;
      if (used && used.size === 0) throw new ParseError(`${opt.used}: used-class list is empty`);
      const report = buildReport(loadLayout(args[0]), loadLayout(args[1]), used, { old: args[0], new: args[1] });
      if (used && report.used.matchedClasses === 0) {
        throw new ParseError(`${opt.used}: none of the ${used.size} used names matches a class in either file`);
      }
      emit(opt, JSON.stringify(report, null, 2) + '\n');
      return report.changedUsedClasses > 0 ? EXIT_USED_CHANGED : EXIT_OK;
    }
    case 'synthesize': {
      need(3, 'synthesize <oldClient> <oldServer> <newServer> [--out newClient.tsv] [--check <realNewClient>]');
      const [oc, os, ns] = args.map(loadLayout);
      const synth = synthesizeClient(oc, os, ns);
      if (opt.check) {
        const result = compareSynthesis(synth, oc, os, ns, loadLayout(opt.check));
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        if (opt.out) writeFileSync(opt.out, layoutToTsv(synth));
        return result.wrongRows === 0 ? EXIT_OK : 1; // exit 1: the formula disagreed with the real dump
      }
      emit(opt, layoutToTsv(synth));
      return EXIT_OK;
    }
    default:
      throw new ParseError('usage: layout-diff.mjs tsv|diff|synthesize ... (see the header of this file)');
  }
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`layout-diff: ${e.message}\n`);
    process.exitCode = EXIT_ERROR;
  }
}
