#!/usr/bin/env node
// Field rows from the PDBs, into the loader's version map (version-map step 28).
//
//   node ci/field-rows.mjs write <header> --cl <CL> --next <layout.json> [--base <layout.json>]
//        (--keys <keys.txt>... | --native-keys <native-keys.txt> --layout-keys <list> [--uses <uses.txt>])
//        [--report <file>]
//
// <next> and <base> are `sr-aobscan --layout --json` reports of the new build and
// of the reference build (the one players run today), over the same key list; the
// keys lists are the tracked components' (ci/VERSION-MAP.md), or, as the client
// check has them, ci/native-keys.txt plus the plain key list the layout reports
// were read with (a key there that is not native is a reflected field). For the
// new CL it writes, through the header's own add-field rule:
//   - a row for every `native` key (a member the game does not reflect): its
//     offset, size and bool mask on the new build, found by the key's own text;
//   - a row for every `field` key (reflected) whose offset, size or mask differs
//     between the reference and the new build. Reflection gives the live offset on
//     any build, so a row only records the move.
//
// The gate is per plugin, and only over what that plugin requests. The uses
// file (`--uses`, from `layout-table.mjs gen --uses-out`) says, per component,
// which keys it has (`key`), which members it requests (`request`, a field
// request in its code), which it looks up by name on first use (`lazy`, a
// PluginLazyField: optional) and which classes it depends on the whole size of
// (`size <Class> check|compiled`). ModLoader is the loader itself.
//
// A key the new build does not have (the scanner says NOMEMBER or NOTYPE for a
// native key, or a reflected key resolves on the reference build only) never
// holds a plugin: it gets an absent row (no row on that CL), the loader turns
// that one request off, and the plugin is reported degraded: high severity for
// a required request, low for an optional one (an `optional` key-list line, or
// a lazy lookup). A key no plugin requests or looks up is a note. A key the
// loader itself reads is refused (exit 3): every plugin depends on the loader.
// A rename is not guessed. A native key the report has no entry for, or that
// does not resolve for any other reason, is refused: a row that is not
// verified never ships.
//
// A class whose size changed: a note when no component depends on its whole
// size. A plugin that checks the size (SR_SIZE_CHECK) has that request turned
// off by the loader on this build: degraded, high. A component that uses the
// compiled size without a check (sizeof, an array of it by value, a copy) is
// refused: the loader cannot see the change, so that plugin would misread every
// element after the first, and nothing in the map can turn it off. Without a
// uses file every class is taken to be used by its compiled size. A class that
// is gone degrades every plugin that has a key in it.
//
// The report's `covered` lists every class with a key that has a row or an
// absent row, a register-sized key, or a change only notes cover: decide.mjs
// checks the used classes that moved against it. `degraded` lists, per plugin,
// what turns off on the new CL ({ key, severity, why }).
//
// `FTransform::Translation` and `::Scale3D` keep the size the key list was built
// with: the PDB sizes them as the 32-byte SIMD register, reflection describes an
// FVector, and the plugin's size check is against the reflected one (review N2).
//
// Logs and the report hold keys and numbers only: PDB member names, types and
// neighbours never leave the scanner, and the key text is the component's own.
//
// Exit codes: 0 written (read `absent` and `degraded`), 3 refused (header
// untouched; the report lists every problem), 2 usage or malformed input.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ParseError } from './layout-diff.mjs';
import { diffLayoutReports, parseLayoutReport, selectKeys } from './layout-table.mjs';
import { parseNativeKeys } from './apply-proposals.mjs';
import { EXIT_ERROR, EXIT_OK, EXIT_VIOLATION, MapError, addAbsentField, addField, emit, parse, parseKeys, unionKeys } from './version-map.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hex = (n) => '0x' + n.toString(16).toUpperCase();

// Keys whose PDB size is the SIMD register and not the reflected size.
export const REFLECTED_SIZE_KEYS = new Set(['FTransform::Translation', 'FTransform::Scale3D']);

// What the scanner says of a member, or a class, the build does not have.
export const GONE = new Set(['NOMEMBER', 'NOTYPE']);

// The loader's own component name in the uses file and in native-keys.txt.
export const LOADER = 'ModLoader';

const rowOf = (key, cl, f) => ({ key, cl, offset: f.offset, size: f.size, mask: f.boolMask ?? 0 });
const classOf = (key) => key.split('::')[0];
const memberOf = (key) => key.split('::')[1];

// The uses file: `<component> key <key>`, `<component> request <Class::Member>`,
// `<component> lazy <Member>`, `<component> size <Class> check|compiled`.
export function parseUses(text, where = 'uses') {
  const uses = { owners: new Map(), requests: new Map(), lazy: new Map(), size: new Map() };
  const add = (map, k, v) => { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(v); };
  text.replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(\S+)\s+(key|request|lazy|size)\s+(\S+)(?:\s+(check|compiled))?$/.exec(line);
    if (!m || (m[2] === 'size') !== (m[4] !== undefined)) throw new MapError(`${where}:${i + 1}: expected "<component> key|request|lazy <name>" or "<component> size <Class> check|compiled"`);
    const [, comp, kind, name, how] = m;
    if (kind === 'key') add(uses.owners, name, comp);
    else if (kind === 'request') add(uses.requests, comp, name);
    else if (kind === 'lazy') add(uses.lazy, comp, name);
    else {
      if (!uses.size.has(name)) uses.size.set(name, new Map());
      const per = uses.size.get(name);
      if (per.get(comp) !== 'check') per.set(comp, how);
    }
  });
  return uses;
}

// Plans the rows. next/base: arrays of { key, result, offset?, size?, boolMask? };
// uses: parseUses() or null. Returns { problems, rows, absent, covered, notes, degraded }.
export function planFieldRows(keys, next, base, cl, uses = null) {
  const problems = [];
  const notes = [];
  const rows = [];
  const absent = [];
  const covered = new Set();
  const degraded = new Map();
  const optional = keys.optionalFields ?? new Set();
  const optionalBy = keys.optionalBy ?? new Map();
  const natives = [...keys.native.keys()].sort(cmp);
  const fields = [...keys.fields].sort(cmp);
  const ownersOf = (key) => [...new Set([...(keys.owners?.get(key) ?? []), ...(uses?.owners.get(key) ?? [])])].sort(cmp);
  const degrade = (owner, key, severity, why) => {
    if (!degraded.has(owner)) degraded.set(owner, []);
    degraded.get(owner).push({ key, severity, why });
  };

  // Who needs a key, and how: { loader, required: [owners], optional: [owners] }.
  // A native key is a request of every plugin whose native-keys.txt line lists
  // it; a reflected key, of every plugin whose code requests it. Without a
  // uses file every owner is taken to request it.
  const demand = (key) => {
    const d = { loader: false, required: [], optional: [] };
    const owners = ownersOf(key);
    for (const o of owners) {
      if (o === LOADER) { d.loader = true; continue; }
      const native = keys.owners?.get(key)?.includes(o);
      const requested = native || !uses || uses.requests.get(o)?.has(key);
      const lazy = uses?.lazy.get(o)?.has(memberOf(key));
      if (requested && !(optionalBy.get(key)?.has(o) || (optional.has(key) && !native))) d.required.push(o);
      else if (requested || lazy) d.optional.push(o);
    }
    if (!owners.length) (optional.has(key) ? d.optional : d.required).push('?');
    return d;
  };

  const gone = (key, kind, why) => {
    const d = demand(key);
    if (d.loader) { problems.push(`${kind} ${key}: ${why}; the loader itself reads it, so every plugin depends on it`); return; }
    if (!d.required.length && !d.optional.length) {
      notes.push(`${key}: ${why}; no plugin requests it (${ownersOf(key).join(', ')} only names it)`);
      covered.add(classOf(key));
      return;
    }
    const severity = d.required.length ? 'high' : 'low';
    absent.push({ key, why, severity, owners: [...d.required, ...d.optional].sort(cmp) });
    for (const o of d.required) degrade(o, key, 'high', why);
    for (const o of d.optional) degrade(o, key, 'low', `${why} (optional)`);
    covered.add(classOf(key));
  };

  const nextBy = new Map(next.map((k) => [k.key, k]));
  for (const key of natives) {
    const n = nextBy.get(key);
    if (!n) { problems.push(`native ${key}: the new build's report has no entry`); continue; }
    if (GONE.has(n.result)) { gone(key, 'native', `not on the new build (${n.result})`); continue; }
    if (n.result !== 'OK') { problems.push(`native ${key}: not found on the new build (${n.result}); an unverified row never ships`); continue; }
    let size = n.size;
    if (REFLECTED_SIZE_KEYS.has(key)) {
      const built = keys.native.get(key);
      if (!built) { problems.push(`native ${key}: the PDB sizes it as a register; the key list must give the built size (offset size mask)`); continue; }
      if (built.size !== n.size) notes.push(`${key}: kept the built size ${hex(built.size)}, not the PDB's ${hex(n.size)}`);
      size = built.size;
    }
    if (!Number.isInteger(n.offset)) { problems.push(`native ${key}: the report gives no offset`); continue; }
    rows.push(rowOf(key, cl, { offset: n.offset, size, boolMask: n.boolMask }));
    covered.add(classOf(key));
  }

  // A class key whose size changed (see the header comment).
  const resized = (m) => {
    const change = `its size changed (${hex(m.base.size)} -> ${hex(m.next.size)})`;
    const per = uses ? uses.size.get(m.key) ?? new Map() : new Map(ownersOf(m.key).map((o) => [o, 'compiled']));
    if (!uses && !per.size) per.set('?', 'compiled');
    const compiled = [...per].filter(([, how]) => how === 'compiled').map(([o]) => o).sort(cmp);
    const checked = [...per].filter(([, how]) => how === 'check').map(([o]) => o).sort(cmp);
    if (compiled.length) {
      problems.push(`class ${m.key}: ${change}, and ${compiled.join(', ')} use${compiled.length === 1 ? 's' : ''} its compiled size with no SR_SIZE_CHECK (sizeof, an array of it by value, or a copy): the loader cannot see the change, so that code misreads it; add SR_SIZE_CHECK(${m.key}) so the loader turns those requests off instead`);
      return;
    }
    for (const o of checked) degrade(o, m.key, 'high', `${change}; SR_SIZE_CHECK(${m.key}) fails, so the loader turns that request off`);
    if (!checked.length) notes.push(`class ${m.key}: ${change}; no plugin depends on its whole size`);
    covered.add(m.key);
  };

  if (fields.length) {
    if (!base) problems.push('reflected field keys are listed but no --base report was given to find what moved');
    else {
      let diff;
      try { diff = diffLayoutReports(selectKeys(base, fields, '--base'), selectKeys(next, fields, '--next')); } catch (e) { problems.push(e.message); }
      if (diff) {
        for (const m of [...diff.moved, ...diff.changed]) {
          if (REFLECTED_SIZE_KEYS.has(m.key)) { notes.push(`${m.key}: PDB size is the register's; no row`); covered.add(classOf(m.key)); continue; }
          if (!m.key.includes('::')) { resized(m); continue; }
          if (!Number.isInteger(m.next.offset)) { problems.push(`${m.key}: the new report gives no offset`); continue; }
          rows.push(rowOf(m.key, cl, m.next));
          covered.add(classOf(m.key));
        }
        for (const m of diff.missing) {
          if (m.key.includes('::')) { gone(m.key, 'field', 'resolves on the reference build only (removed or renamed)'); continue; }
          // A class that is gone: its member keys get their absent rows above;
          // every plugin with a key in it loses what it reads from it.
          const owners = ownersOf(m.key);
          if (owners.includes(LOADER)) { problems.push(`class ${m.key}: not on the new build; the loader itself reads it, so every plugin depends on it`); continue; }
          for (const o of owners.length ? owners : ['?']) degrade(o, m.key, 'high', 'the class is not on the new build');
          covered.add(m.key);
        }
        for (const u of diff.unresolved) notes.push(`${u.key}: resolves on neither build; reflection decides`);
      }
    }
  }
  rows.sort((a, b) => cmp(a.key, b.key));
  absent.sort((a, b) => cmp(a.key, b.key));
  const byOwner = Object.fromEntries([...degraded].sort((a, b) => cmp(a[0], b[0])).map(([o, list]) => [o, list.sort((a, b) => cmp(a.key, b.key))]));
  return { problems, rows, absent, covered: [...covered].sort(cmp), notes, degraded: byOwner };
}

// The header text with the rows added, or the reasons it was refused.
export function fieldRows(headerText, { cl, keys, next, base, uses = null }) {
  const map = parse(headerText, 'the header');
  if (map.flavour !== 'loader') throw new MapError('field rows go into the loader map; this header is a plugin map');
  if (!map.builds.some((b) => b.cl === cl)) throw new MapError(`CL-${cl} is not in the build table; add the build first (map-mode.mjs write, or version-map.mjs add-build)`);
  const plan = planFieldRows(keys, next, base, cl, uses);
  const problems = [...plan.problems];
  const out = parse(emit(map), 'the header');
  let added = 0;
  if (!problems.length) {
    for (const r of plan.rows) {
      try { if (addField(out, r)) added++; } catch (e) { if (!(e instanceof MapError)) throw e; problems.push(e.message); }
    }
    for (const a of plan.absent) {
      try { addAbsentField(out, { key: a.key, cl }); } catch (e) { if (!(e instanceof MapError)) throw e; problems.push(e.message); }
    }
  }
  return { text: problems.length ? null : emit(out), added, rows: plan.rows.map((r) => r.key), problems, absent: plan.absent, covered: plan.covered, notes: plan.notes, degraded: plan.degraded };
}

// The key list as the client check has it: ci/native-keys.txt (each plugin's
// native members, with built values and `optional` where a line gives them) and
// the plain list of keys the layout reports were read with. A key in both is
// native; any other key in the plain list is a reflected field. A native key is
// optional only when every plugin's line for it says so. The result also
// carries `owners` (the plugins whose lines list each native key) and
// `optionalBy` (the plugins whose line marks it optional).
export function keysFromCheck(nativeText, layoutText) {
  const natives = new Map();
  for (const e of parseNativeKeys(nativeText)) {
    const prev = natives.get(e.key);
    if (prev && prev.built && e.built && (prev.built.offset !== e.built.offset || prev.built.size !== e.built.size || prev.built.mask !== e.built.mask)) {
      throw new MapError(`native-keys.txt: ${e.key} is listed with two different built values`);
    }
    natives.set(e.key, {
      built: prev?.built ?? e.built,
      optional: (prev ? prev.optional : true) && e.optional === true,
      owners: [...new Set([...(prev?.owners ?? []), e.plugin])].sort(cmp),
      optionalBy: [...new Set([...(prev?.optionalBy ?? []), ...(e.optional ? [e.plugin] : [])])],
    });
  }
  const lines = [];
  for (const [key, e] of natives) lines.push(`native ${key}${e.built ? ` ${hex(e.built.offset)} ${hex(e.built.size)} ${hex(e.built.mask)}` : ''}${e.optional ? ' optional' : ''}`);
  const seen = new Set();
  for (const raw of layoutText.split(/\r?\n/)) {
    const key = raw.trim();
    if (!key || key.startsWith('#') || natives.has(key) || seen.has(key)) continue;
    seen.add(key);
    lines.push(`field ${key}`);
  }
  const keys = parseKeys(lines.join('\n') + '\n', 'native-keys.txt and the layout keys');
  keys.owners = new Map([...natives].map(([key, e]) => [key, e.owners]));
  keys.optionalBy = new Map([...natives].map(([key, e]) => [key, new Set(e.optionalBy)]));
  return keys;
}

export function main(argv) {
  const [cmd, header, ...rest] = argv;
  const o = { keys: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k?.startsWith('--') || rest[i + 1] === undefined) { process.stderr.write(`field-rows: bad argument ${k}\n`); return EXIT_ERROR; }
    if (k === '--keys') o.keys.push(rest[i + 1]);
    else o[k.slice(2)] = rest[i + 1];
  }
  const fromCheck = o['native-keys'] !== undefined || o['layout-keys'] !== undefined;
  const keysOk = fromCheck ? !!(o['native-keys'] && o['layout-keys']) && !o.keys.length : o.keys.length > 0 && o.uses === undefined;
  if (cmd !== 'write' || !header || !o.cl || !o.next || !keysOk || !/^\d+$/.test(o.cl)) {
    process.stderr.write('usage: field-rows.mjs write <header> --cl <CL> --next <layout.json> [--base <layout.json>] (--keys <keys.txt>... | --native-keys <native-keys.txt> --layout-keys <list> [--uses <uses.txt>]) [--report <file>]\n');
    return EXIT_ERROR;
  }
  try {
    const keys = fromCheck
      ? keysFromCheck(readFileSync(o['native-keys'], 'utf8'), readFileSync(o['layout-keys'], 'utf8'))
      : unionKeys(o.keys.map((p) => parseKeys(readFileSync(p, 'utf8'), p)));
    const uses = o.uses ? parseUses(readFileSync(o.uses, 'utf8'), o.uses) : null;
    const next = parseLayoutReport(readFileSync(o.next, 'utf8'), o.next);
    const base = o.base ? parseLayoutReport(readFileSync(o.base, 'utf8'), o.base) : null;
    const out = fieldRows(readFileSync(header, 'utf8'), { cl: Number(o.cl), keys, next, base, uses });
    const report = { written: !!out.text, cl: Number(o.cl), added: out.added, rows: out.rows, absent: out.absent, degraded: out.degraded, covered: out.covered, notes: out.notes, problems: out.problems };
    if (o.report) writeFileSync(o.report, JSON.stringify(report, null, 2) + '\n');
    if (!out.text) {
      for (const p of out.problems) process.stderr.write(`refused: ${p}\n`);
      return EXIT_VIOLATION;
    }
    writeFileSync(header, out.text);
    process.stdout.write(`field-rows: ${out.added} rows added${out.absent.length ? `, ${out.absent.length} absent (${out.absent.map((p) => p.key).join(', ')})` : ''}\n`);
    for (const [owner, list] of Object.entries(out.degraded)) process.stdout.write(`field-rows: ${owner} degraded: ${list.map((d) => `${d.key} off (${d.severity})`).join(', ')}\n`);
    return EXIT_OK;
  } catch (e) {
    if (!(e instanceof MapError) && !(e instanceof ParseError) && e.code !== 'ENOENT') throw e;
    process.stderr.write(`field-rows: ${e.message}\n`);
    return EXIT_ERROR;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
