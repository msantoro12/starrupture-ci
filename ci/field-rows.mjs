#!/usr/bin/env node
// Field rows from the PDBs, into the loader's version map (version-map step 28).
//
//   node ci/field-rows.mjs write <header> --cl <CL> --next <layout.json> [--base <layout.json>]
//        (--keys <keys.txt>... | --native-keys <native-keys.txt> --layout-keys <list>)
//        [--report <file>]
//
// <next> and <base> are `sr-aobscan --layout --json` reports of the new build and
// of the reference build (the one players run today), over the same key list; the
// keys lists are the tracked components' (ci/VERSION-MAP.md), or, as the client
// check has them, ci/native-keys.txt plus the plain key list the layout reports
// were read with (a key there that is not native is a reflected field). For the
// new CL it
// writes, through the header's own add-field rule:
//   - a row for every `native` key (a member the game does not reflect): its
//     offset, size and bool mask on the new build, found by the key's own text;
//   - a row for every `field` key (reflected) whose offset, size or mask differs
//     between the reference and the new build. Reflection gives the live offset on
//     any build, so a row only records the move.
// A key the new build does not have (the scanner says NOMEMBER or NOTYPE for a
// native key, or a reflected key resolves on the reference build only) gets an
// absent row: no row on that CL, so the loader refuses that one request and the
// plugin takes its fallback. A rename is not guessed. A key the key list marks
// `required` is refused instead (exit 3), and so is a native key the report has
// no entry for or does not resolve for any other reason.
//
// The report's `covered` lists every class with a key that has a row, an absent
// row, or a move settled otherwise (a class size, a register-sized key):
// decide.mjs checks the used classes that moved against it.
//
// `FTransform::Translation` and `::Scale3D` keep the size the key list was built
// with: the PDB sizes them as the 32-byte SIMD register, reflection describes an
// FVector, and the plugin's size check is against the reflected one (review N2).
//
// Logs and the report hold keys and numbers only: PDB member names, types and
// neighbours never leave the scanner, and the key text is the component's own.
//
// Exit codes: 0 written (read `absent` for the fallbacks), 3 refused (header
// untouched), 2 usage or malformed input.

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

const rowOf = (key, cl, f) => ({ key, cl, offset: f.offset, size: f.size, mask: f.boolMask ?? 0 });
const classOf = (key) => key.split('::')[0];

// Plans the rows. next/base: arrays of { key, result, offset?, size?, boolMask? }.
// Returns { problems, rows, absent, covered, notes }.
export function planFieldRows(keys, next, base, cl) {
  const problems = [];
  const notes = [];
  const rows = [];
  const absent = [];
  const covered = new Set();
  const required = keys.requiredFields ?? new Set();
  const natives = [...keys.native.keys()].sort(cmp);
  const fields = [...keys.fields].sort(cmp);
  const gone = (key, kind, why) => {
    if (required.has(key)) { problems.push(`${kind} ${key}: ${why}, and the key list marks it required`); return; }
    absent.push({ key, why });
    covered.add(classOf(key));
  };

  const nextBy = new Map(next.map((k) => [k.key, k]));
  for (const key of natives) {
    const n = nextBy.get(key);
    if (!n) { problems.push(`native ${key}: the new build's report has no entry`); continue; }
    if (GONE.has(n.result)) { gone(key, 'native', `not on the new build (${n.result})`); continue; }
    if (n.result !== 'OK') { problems.push(`native ${key}: not found on the new build (${n.result}); the loader refuses a plugin without this row`); continue; }
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

  if (fields.length) {
    if (!base) problems.push('reflected field keys are listed but no --base report was given to find what moved');
    else {
      let diff;
      try { diff = diffLayoutReports(selectKeys(base, fields, '--base'), selectKeys(next, fields, '--next')); } catch (e) { problems.push(e.message); }
      if (diff) {
        for (const m of [...diff.moved, ...diff.changed]) {
          if (REFLECTED_SIZE_KEYS.has(m.key)) { notes.push(`${m.key}: PDB size is the register's; no row`); covered.add(classOf(m.key)); continue; }
          // A class key: the plugin reads (or checks) the size live, so no row.
          if (!m.key.includes('::')) { covered.add(m.key); continue; }
          if (!Number.isInteger(m.next.offset)) { problems.push(`${m.key}: the new report gives no offset`); continue; }
          rows.push(rowOf(m.key, cl, m.next));
          covered.add(classOf(m.key));
        }
        for (const m of diff.missing) gone(m.key, 'field', 'resolves on the reference build only (removed or renamed)');
        for (const u of diff.unresolved) notes.push(`${u.key}: resolves on neither build; reflection decides`);
      }
    }
  }
  rows.sort((a, b) => cmp(a.key, b.key));
  absent.sort((a, b) => cmp(a.key, b.key));
  return { problems, rows, absent, covered: [...covered].sort(cmp), notes };
}

// The header text with the rows added, or the reasons it was refused.
export function fieldRows(headerText, { cl, keys, next, base }) {
  const map = parse(headerText, 'the header');
  if (map.flavour !== 'loader') throw new MapError('field rows go into the loader map; this header is a plugin map');
  if (!map.builds.some((b) => b.cl === cl)) throw new MapError(`CL-${cl} is not in the build table; add the build first (map-mode.mjs write, or version-map.mjs add-build)`);
  const plan = planFieldRows(keys, next, base, cl);
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
  return { text: problems.length ? null : emit(out), added, problems, absent: plan.absent, covered: plan.covered, notes: plan.notes };
}

// The key list as the client check has it: ci/native-keys.txt (each plugin's
// native members, with built values and `required` where a line gives them) and
// the plain list of keys the layout reports were read with. A key in both is
// native; any other key in the plain list is a reflected field.
export function keysFromCheck(nativeText, layoutText) {
  const natives = new Map();
  for (const e of parseNativeKeys(nativeText)) {
    const prev = natives.get(e.key);
    if (prev && prev.built && e.built && (prev.built.offset !== e.built.offset || prev.built.size !== e.built.size || prev.built.mask !== e.built.mask)) {
      throw new MapError(`native-keys.txt: ${e.key} is listed with two different built values`);
    }
    natives.set(e.key, { built: prev?.built ?? e.built, required: !!(prev?.required || e.required) });
  }
  const lines = [];
  for (const [key, e] of natives) lines.push(`native ${key}${e.built ? ` ${hex(e.built.offset)} ${hex(e.built.size)} ${hex(e.built.mask)}` : ''}${e.required ? ' required' : ''}`);
  const seen = new Set();
  for (const raw of layoutText.split(/\r?\n/)) {
    const key = raw.trim();
    if (!key || key.startsWith('#') || natives.has(key) || seen.has(key)) continue;
    seen.add(key);
    lines.push(`field ${key}`);
  }
  return parseKeys(lines.join('\n') + '\n', 'native-keys.txt and the layout keys');
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
  const keysOk = fromCheck ? !!(o['native-keys'] && o['layout-keys']) && !o.keys.length : o.keys.length > 0;
  if (cmd !== 'write' || !header || !o.cl || !o.next || !keysOk || !/^\d+$/.test(o.cl)) {
    process.stderr.write('usage: field-rows.mjs write <header> --cl <CL> --next <layout.json> [--base <layout.json>] (--keys <keys.txt>... | --native-keys <native-keys.txt> --layout-keys <list>) [--report <file>]\n');
    return EXIT_ERROR;
  }
  try {
    const keys = fromCheck
      ? keysFromCheck(readFileSync(o['native-keys'], 'utf8'), readFileSync(o['layout-keys'], 'utf8'))
      : unionKeys(o.keys.map((p) => parseKeys(readFileSync(p, 'utf8'), p)));
    const next = parseLayoutReport(readFileSync(o.next, 'utf8'), o.next);
    const base = o.base ? parseLayoutReport(readFileSync(o.base, 'utf8'), o.base) : null;
    const out = fieldRows(readFileSync(header, 'utf8'), { cl: Number(o.cl), keys, next, base });
    const report = { written: !!out.text, cl: Number(o.cl), added: out.added, absent: out.absent, covered: out.covered, notes: out.notes, problems: out.problems };
    if (o.report) writeFileSync(o.report, JSON.stringify(report, null, 2) + '\n');
    if (!out.text) {
      for (const p of out.problems) process.stderr.write(`refused: ${p}\n`);
      return EXIT_VIOLATION;
    }
    writeFileSync(header, out.text);
    process.stdout.write(`field-rows: ${out.added} rows added${out.absent.length ? `, ${out.absent.length} absent (${out.absent.map((p) => p.key).join(', ')})` : ''}\n`);
    return EXIT_OK;
  } catch (e) {
    if (!(e instanceof MapError) && !(e instanceof ParseError) && e.code !== 'ENOENT') throw e;
    process.stderr.write(`field-rows: ${e.message}\n`);
    return EXIT_ERROR;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
