#!/usr/bin/env node
// Field rows from the PDBs, into the loader's version map (version-map step 28).
//
//   node ci/field-rows.mjs write <header> --cl <CL> --next <layout.json> [--base <layout.json>]
//        --keys <keys.txt>... [--report <file>]
//
// <next> and <base> are `sr-aobscan --layout --json` reports of the new build and
// of the reference build (the one players run today), over the same key list; the
// keys lists are the tracked components' (ci/VERSION-MAP.md). For the new CL it
// writes, through the header's own add-field rule:
//   - a row for every `native` key (a member the game does not reflect): its
//     offset, size and bool mask on the new build, found by the key's own text;
//   - a row for every `field` key (reflected) whose offset, size or mask differs
//     between the reference and the new build. Reflection gives the live offset on
//     any build, so a row only records the move.
// A reflected key that resolves on the reference build only (removed, or renamed)
// is not guessed: it is listed under `partial` and the run is PARTIAL. A rename
// guess is low confidence by design, and only a person or the SDK dump settles it.
//
// A native key that does not resolve on the new build is refused (exit 3): the
// loader fails closed on a native member it has no row for.
//
// `FTransform::Translation` and `::Scale3D` keep the size the key list was built
// with: the PDB sizes them as the 32-byte SIMD register, reflection describes an
// FVector, and the plugin's size check is against the reflected one (review N2).
//
// Logs and the report hold keys and numbers only: PDB member names, types and
// neighbours never leave the scanner, and the key text is the component's own.
//
// Exit codes: 0 written (PARTIAL or not: read `partial`), 3 refused (header
// untouched), 2 usage or malformed input.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ParseError } from './layout-diff.mjs';
import { diffLayoutReports, parseLayoutReport, selectKeys } from './layout-table.mjs';
import { EXIT_ERROR, EXIT_OK, EXIT_VIOLATION, MapError, addField, emit, parse, parseKeys, unionKeys } from './version-map.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hex = (n) => '0x' + n.toString(16).toUpperCase();

// Keys whose PDB size is the SIMD register and not the reflected size.
export const REFLECTED_SIZE_KEYS = new Set(['FTransform::Translation', 'FTransform::Scale3D']);

const rowOf = (key, cl, f) => ({ key, cl, offset: f.offset, size: f.size, mask: f.boolMask ?? 0 });

// Plans the rows. next/base: arrays of { key, result, offset?, size?, boolMask? }.
// Returns { problems, rows, partial, notes }.
export function planFieldRows(keys, next, base, cl) {
  const problems = [];
  const notes = [];
  const rows = [];
  const partial = [];
  const natives = [...keys.native.keys()].sort(cmp);
  const fields = [...keys.fields].sort(cmp);

  const nextBy = new Map(next.map((k) => [k.key, k]));
  for (const key of natives) {
    const n = nextBy.get(key);
    if (!n) { problems.push(`native ${key}: the new build's report has no entry`); continue; }
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
  }

  if (fields.length) {
    if (!base) problems.push('reflected field keys are listed but no --base report was given to find what moved');
    else {
      let diff;
      try { diff = diffLayoutReports(selectKeys(base, fields, '--base'), selectKeys(next, fields, '--next')); } catch (e) { problems.push(e.message); }
      if (diff) {
        for (const m of [...diff.moved, ...diff.changed]) {
          if (REFLECTED_SIZE_KEYS.has(m.key)) { notes.push(`${m.key}: PDB size is the register's; no row`); continue; }
          if (!Number.isInteger(m.next.offset)) { problems.push(`${m.key}: the new report gives no offset`); continue; }
          rows.push(rowOf(m.key, cl, m.next));
        }
        for (const m of diff.missing) partial.push({ key: m.key, why: 'resolves on the reference build only (removed or renamed)' });
        for (const u of diff.unresolved) notes.push(`${u.key}: resolves on neither build; reflection decides`);
        partial.sort((a, b) => cmp(a.key, b.key));
      }
    }
  }
  rows.sort((a, b) => cmp(a.key, b.key));
  return { problems, rows, partial, notes };
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
  }
  return { text: problems.length ? null : emit(out), added, problems, partial: plan.partial, notes: plan.notes };
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
  if (cmd !== 'write' || !header || !o.cl || !o.next || !o.keys.length || !/^\d+$/.test(o.cl)) {
    process.stderr.write('usage: field-rows.mjs write <header> --cl <CL> --next <layout.json> [--base <layout.json>] --keys <keys.txt>... [--report <file>]\n');
    return EXIT_ERROR;
  }
  try {
    const keys = unionKeys(o.keys.map((p) => parseKeys(readFileSync(p, 'utf8'), p)));
    const next = parseLayoutReport(readFileSync(o.next, 'utf8'), o.next);
    const base = o.base ? parseLayoutReport(readFileSync(o.base, 'utf8'), o.base) : null;
    const out = fieldRows(readFileSync(header, 'utf8'), { cl: Number(o.cl), keys, next, base });
    const report = { written: !!out.text, added: out.added, partial: out.partial, notes: out.notes, problems: out.problems };
    if (o.report) writeFileSync(o.report, JSON.stringify(report, null, 2) + '\n');
    if (!out.text) {
      for (const p of out.problems) process.stderr.write(`refused: ${p}\n`);
      return EXIT_VIOLATION;
    }
    writeFileSync(header, out.text);
    process.stdout.write(`field-rows: ${out.added} rows added${out.partial.length ? `, PARTIAL: ${out.partial.length} reflected keys need a person (${out.partial.map((p) => p.key).join(', ')})` : ''}\n`);
    return EXIT_OK;
  } catch (e) {
    if (!(e instanceof MapError) && !(e instanceof ParseError) && e.code !== 'ENOENT') throw e;
    process.stderr.write(`field-rows: ${e.message}\n`);
    return EXIT_ERROR;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
