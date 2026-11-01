#!/usr/bin/env node
// Map mode: writes what a game update changes into the loader's version map,
// instead of into each plugin's source.
//
//   node ci/map-mode.mjs write <header> --input <observations.json> [--keys <keys.txt>]... [--report <file>]
//
// The header is the loader's version_map.generated.h. The input is what the
// runner collected for one new build (see ci/MAP-MODE.md for the shape): for
// every tracked component (the loader included), the scan of its current and of
// its previous released DLL on that build, a row per map request with the key,
// the kind, the fingerprint the harness printed, the result and the address, and
// the suggester's proposal for each row that failed.
//
// The writer adds, for the new CL:
//   - a locator row for every key that resolved (global: one row; scoped: one
//     per fp), taking the request's own pattern when it resolved and the
//     suggester's proposal (unique on the build, high confidence) when it did not;
//   - an absent row where neither gives a locator;
//   - nothing for a component that is not tracked: its proposals are listed
//     under `patches`, for the pattern path (select / apply) to turn into a
//     source patch, as before.
// It prunes the row sets of fps that neither the current nor the previous
// release of the owner still carries.
//
// It refuses, writing nothing and exiting 3, when
//   - two keys name one symbol, or one key lands on two addresses, or a global
//     key lands off the start of a symbol (the runner's symbol table, passed as
//     the rva of the symbol's start, never its name);
//   - two different request tuples share one fp under one key;
//   - a required key (the loader's) has no locator under the newest release's fp;
//   - the map already holds a different verified row for a key, fp and CL;
//   - a key list is given and the written map breaks its coverage rule.
// The same input on the written result changes nothing, and the result is
// byte-identical for any order of the input.
//
// Exit codes: 0 written; 3 refused; 2 usage or malformed input.
//
// TODO(step 26, needs the owner): the push of auto/update-<CL> to the loader
// fork needs a deploy key and an `auto/**` ruleset there. Credential setup is not
// done by this tool; the checklist is in ci/MAP-MODE.md.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EXIT_ERROR, EXIT_OK, EXIT_VIOLATION, KIND, MapError, addAbsent, addBuild, addFunction, checkMap, emit, isGlobalKind, parse, parseKeys, unionKeys,
} from './version-map.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hex8 = (n) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');
const hex = (n) => '0x' + n.toString(16).toUpperCase();

const KIND_NAMES = {
  function: KIND.FUNCTION_START, 'function-start': KIND.FUNCTION_START, functionstart: KIND.FUNCTION_START,
  infunction: KIND.IN_FUNCTION, 'in-function': KIND.IN_FUNCTION,
  code: KIND.CODE, data: KIND.DATA, vtable: KIND.VTABLE, any: KIND.ANY,
};

export function kindOf(v) {
  if (Number.isInteger(v) && v >= 1 && v <= 6) return v;
  const k = typeof v === 'string' ? KIND_NAMES[v.toLowerCase()] : undefined;
  if (!k) throw new MapError(`kind ${JSON.stringify(v)} is not a PluginScanKind (1-6, or function, infunction, code, data, vtable, any)`);
  return k;
}

function numberOf(v, what, { lo = 0, hi = 0xffffffff } = {}) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^(0[xX][0-9A-Fa-f]+|\d+)$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < lo || n > hi) throw new MapError(`${what} ${JSON.stringify(v)} is not a number in ${lo}..${hi}`);
  return n;
}

// A scan row or a suggester proposal, as a locator: what a map row holds.
const locator = (r) => ({
  pattern: r.pattern,
  resultOffset: r.resultOffset ?? 0,
  followRel32At: r.followRel32At ?? -1,
  followRipDispAt: r.followRipDispAt ?? -1,
});

// The request a row came from, as one string. Two requests with one fp must
// have the same tuple, or the fingerprint does not tell them apart.
export const tupleOf = (r) =>
  [r.kind, r.pattern ?? '', r.resultOffset ?? 0, r.followRel32At ?? -1, r.followRipDispAt ?? -1, r.siteArithmetic ?? 0].join('|');

const CONFIDENCE = { low: 1, medium: 2, high: 3 };

// The best proposal that is safe to write as a locator: unique on the new build,
// high confidence, with the address it locates.
function proposalOf(row) {
  const s = row.suggest;
  if (!s || (CONFIDENCE[s.confidence] || 0) < CONFIDENCE.high || !s.rva) return null;
  const p = (s.proposals || []).find((q) => q.uniqueOnTarget === true && typeof q.pattern === 'string' && (q.resultOffset ?? 0) === 0);
  if (!p) return null;
  return { ...locator({ ...p, followRipDispAt: p.followRipDispAt ?? -1 }), rva: numberOf(s.rva, 'suggest.rva'), symbolRva: s.symbolRva === undefined ? null : numberOf(s.symbolRva, 'suggest.symbolRva') };
}

// ---- The observations ---------------------------------------------------------

// Every row of the input as { owner, rank, fpAware, tracked, ... }, normalized
// and in a fixed order. Throws MapError on a malformed input.
export function readObservations(input) {
  if (!input || input.schema !== 1) throw new MapError('the input is not schema 1');
  const cl = numberOf(input.cl, 'cl', { lo: 1 });
  const rows = [];
  const patches = [];
  const owners = new Set();
  for (const c of input.components || []) {
    if (typeof c.owner !== 'string' || !c.owner || /[,/\s]/.test(c.owner)) throw new MapError(`owner ${JSON.stringify(c.owner)} is not a plugin name`);
    if (owners.has(c.owner)) throw new MapError(`owner ${c.owner} is given twice`);
    owners.add(c.owner);
    for (const rel of c.releases || []) {
      if (!['current', 'previous'].includes(rel.rank)) throw new MapError(`${c.owner} ${rel.tag}: rank must be current or previous`);
      for (const r of rel.rows || []) {
        const where = `${c.owner} ${rel.tag} ${JSON.stringify(r.key)}`;
        if (typeof r.key !== 'string' || !r.key) throw new MapError(`${where}: a row has no key`);
        const row = {
          owner: c.owner, tracked: c.tracked !== false, rank: rel.rank, fpAware: rel.fpAware !== false, tag: rel.tag,
          key: r.key, kind: kindOf(r.kind), fp: r.fp === undefined ? 0 : numberOf(r.fp, `${where}: fp`),
          ok: r.result === 'OK', result: r.result, required: r.required === true,
          pattern: r.pattern ?? null, resultOffset: r.resultOffset ?? 0, followRel32At: r.followRel32At ?? -1,
          followRipDispAt: r.followRipDispAt ?? -1, siteArithmetic: r.siteArithmetic ?? 0,
          rva: r.rva === undefined ? null : numberOf(r.rva, `${where}: rva`),
          symbolRva: r.symbolRva === undefined || r.symbolRva === null ? null : numberOf(r.symbolRva, `${where}: symbolRva`),
          proposal: proposalOf(r),
        };
        if (row.ok && (row.rva === null || row.pattern === null)) throw new MapError(`${where}: an OK row needs its pattern and rva`);
        if (!row.tracked) { if (!row.ok) patches.push({ owner: c.owner, tag: rel.tag, key: r.key, result: r.result }); continue; }
        rows.push(row);
      }
    }
  }
  const order = (a, b) => cmp(a.key, b.key) || a.fp - b.fp || (a.owner === 'ModLoader' ? 0 : 1) - (b.owner === 'ModLoader' ? 0 : 1) || cmp(a.owner, b.owner) || (a.rank === 'current' ? 0 : 1) - (b.rank === 'current' ? 0 : 1);
  rows.sort(order);
  patches.sort((a, b) => cmp(a.owner, b.owner) || cmp(a.key, b.key));
  return { cl, rows, patches };
}

// ---- The plan -----------------------------------------------------------------

// Decides, per (key, fp), the row to write, and every reason to refuse. No map
// is touched. Returns { problems, ops, live, notes }.
export function planRows(rows, { cl }) {
  const problems = [];
  const notes = [];
  const kinds = new Map();
  const groups = new Map(); // key \n fp -> rows
  const live = new Map(); // scoped key -> Set of fps carried by a current or previous release
  const tuples = new Map(); // key \n fp -> Map<tuple, first row>

  for (const r of rows) {
    const scoped = !isGlobalKind(r.kind);
    if (scoped && !r.key.includes('/')) problems.push(`${r.key}: kind ${r.kind} reads a scoped key, <owner>/<hook>`);
    if (!scoped && r.key.includes('/')) problems.push(`${r.key}: kind ${r.kind} reads a global key, which has no '/'`);
    if (scoped && r.fpAware === false) { notes.push(`${r.owner} ${r.tag}: predates fingerprints; no rows written for ${r.key}`); continue; }
    if (scoped && r.fp === 0) { problems.push(`${r.key}: a scoped row from ${r.owner} ${r.tag} has no fp; the harness must print one`); continue; }
    if (!scoped && r.fp !== 0) { problems.push(`${r.key}: a global row from ${r.owner} ${r.tag} carries fp ${hex8(r.fp)}`); continue; }
    if (kinds.has(r.key) && kinds.get(r.key) !== r.kind) problems.push(`${r.key}: rows of kind ${kinds.get(r.key)} and kind ${r.kind}; a key has one kind`);
    kinds.set(r.key, r.kind);
    const id = `${r.key}\n${r.fp}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
    if (scoped) {
      if (!live.has(r.key)) live.set(r.key, new Set());
      live.get(r.key).add(r.fp);
      if (!tuples.has(id)) tuples.set(id, new Map());
      const t = tupleOf(r);
      if (!tuples.get(id).has(t)) tuples.get(id).set(t, r);
    }
  }
  for (const [id, byTuple] of tuples) {
    if (byTuple.size > 1) {
      const [key, fp] = id.split('\n');
      problems.push(`${key}: ${byTuple.size} different request tuples share fp ${hex8(Number(fp))}: ${[...byTuple.values()].map((r) => `${r.owner} ${r.tag}`).join(', ')}`);
    }
  }

  const ops = [];
  for (const id of [...groups.keys()].sort()) {
    const g = groups.get(id);
    const { key, kind, fp } = g[0];
    const scoped = !isGlobalKind(kind);
    const resolved = g.filter((r) => r.ok);
    const addresses = new Set(resolved.map((r) => r.rva));
    if (addresses.size > 1) {
      problems.push(`${key}: resolves to ${[...addresses].sort((a, b) => a - b).map(hex).join(' and ')} on CL-${cl}; one key names one address`);
      continue;
    }
    if (resolved.length) {
      const r = resolved[0];
      ops.push({ type: 'function', key, kind, fp, ...locator(r), rva: r.rva, symbolRva: resolved.map((x) => x.symbolRva).find((s) => s !== null) ?? null, from: `${r.owner} ${r.tag}` });
      continue;
    }
    const proposals = g.filter((r) => r.proposal).map((r) => ({ ...r.proposal, owner: r.owner, tag: r.tag }));
    const spread = new Set(proposals.map((p) => p.rva));
    if (spread.size > 1) { problems.push(`${key}: the proposals locate ${[...spread].sort((a, b) => a - b).map(hex).join(' and ')} on CL-${cl}`); continue; }
    if (proposals.length) {
      const p = proposals[0];
      ops.push({ type: 'function', key, kind, fp, pattern: p.pattern, resultOffset: 0, followRel32At: p.followRel32At, followRipDispAt: p.followRipDispAt, rva: p.rva, symbolRva: p.symbolRva, from: `proposal for ${p.owner} ${p.tag}` });
      continue;
    }
    const required = g.some((r) => r.required);
    const newest = g.some((r) => r.rank === 'current');
    if (required && (!scoped || newest)) {
      problems.push(`required key ${key}${fp ? ` (fp ${hex8(fp)})` : ''} has no locator on CL-${cl}${scoped ? ' under the newest release' : ''}: ${g.map((r) => `${r.owner} ${r.tag} ${r.result}`).join(', ')}`);
      continue;
    }
    ops.push({ type: 'absent', key, kind, fp, owners: scoped ? null : [...new Set(g.map((r) => r.owner))].sort(cmp) });
  }

  // One key, one symbol (global keys only: a scoped row names a site).
  const globals = ops.filter((o) => o.type === 'function' && isGlobalKind(o.kind));
  for (const o of globals) {
    if (o.symbolRva !== null && o.symbolRva !== o.rva) problems.push(`${o.key}: lands at ${hex(o.rva)}, off the start of its symbol (${hex(o.symbolRva)})`);
  }
  const bySymbol = new Map();
  for (const o of globals.filter((x) => x.symbolRva !== null)) {
    if (!bySymbol.has(o.symbolRva)) bySymbol.set(o.symbolRva, []);
    bySymbol.get(o.symbolRva).push(o.key);
  }
  for (const [sym, keys] of [...bySymbol].sort((a, b) => a[0] - b[0])) {
    if (keys.length > 1) problems.push(`keys ${keys.slice().sort(cmp).join(' and ')} name one symbol (${hex(sym)}); a symbol has one key`);
  }
  return { problems, ops, live, notes };
}

// ---- Writing ------------------------------------------------------------------

// Applies the plan to a clone of the map. Returns { map, added, pruned, problems }.
export function writeRows(map, input) {
  const { cl, rows, patches } = readObservations(input);
  const plan = planRows(rows, { cl });
  const problems = [...plan.problems];
  if (map.flavour !== 'loader') throw new MapError('map mode writes the loader map; this header is a plugin map');
  const next = parse(emit(map), 'the header');
  if (!next.builds.some((b) => b.cl === cl)) {
    const b = input.build;
    if (!b) problems.push(`CL-${cl} is not in the build table and the input has no build (stamp, size, source)`);
    else {
      try { addBuild(next, { cl, stamp: numberOf(b.stamp, 'build.stamp'), size: numberOf(b.size, 'build.size', { lo: 1 }), source: b.source }); } catch (e) { problems.push(e.message); }
    }
  } else if (input.build) {
    const old = next.builds.find((b) => b.cl === cl);
    if (old.stamp !== numberOf(input.build.stamp, 'build.stamp') || old.size !== numberOf(input.build.size, 'build.size', { lo: 1 }) || old.source !== input.build.source) {
      problems.push(`CL-${cl} is already in the build table with another exe or source`);
    }
  }
  if (problems.length) return { map: null, added: 0, pruned: 0, problems, patches, notes: plan.notes };

  let added = 0;
  for (const op of plan.ops) {
    try {
      if (op.type === 'function') {
        if (addFunction(next, { key: op.key, kind: op.kind, fp: op.fp, cl, pattern: op.pattern, resultOffset: op.resultOffset, followRel32At: op.followRel32At, followRipDispAt: op.followRipDispAt, rva: op.rva })) added++;
      } else if (addAbsent(next, { key: op.key, kind: op.kind, fp: op.fp, cl, owners: op.owners })) added++;
    } catch (e) {
      if (!(e instanceof MapError)) throw e;
      problems.push(e.message);
    }
  }
  // A set whose fp neither the current nor the previous release carries is dropped.
  const before = next.functions.length;
  next.functions = next.functions.filter((r) => !plan.live.has(r.key) || r.fp === 0 || plan.live.get(r.key).has(r.fp));
  const pruned = before - next.functions.length;
  if (problems.length) return { map: null, added: 0, pruned: 0, problems, patches, notes: plan.notes };
  return { map: next, added, pruned, problems, patches, notes: plan.notes };
}

// The header text, or the reasons it was refused. keys: parsed key lists.
export function mapMode(headerText, input, { keys = [] } = {}) {
  const map = parse(headerText, 'the header');
  const out = writeRows(map, input);
  if (out.map && keys.length) {
    const left = checkMap(out.map, unionKeys(keys));
    if (left.length) return { ...out, map: null, text: null, problems: left.map((l) => `coverage: ${l}`) };
  }
  return { ...out, text: out.map ? emit(out.map) : null };
}

// ---- Assembling the input from the harness -----------------------------------

// One harness row (`sr-aobscan --json`, registry or --plugin) as an input row, or
// null when it is not a map request (a raw scan or a legacy hookName+pattern
// call prints no key). Only the loader's own rows are required: a plugin whose
// required pattern fails is the plugin check's verdict, not a reason to refuse
// the map.
function harnessRow(r, owner) {
  if (typeof r.key !== 'string' || !r.key) return null;
  const row = { key: r.key, kind: r.kind, result: r.result, required: owner === 'ModLoader' && r.required === true };
  for (const f of ['fp', 'rva', 'symbolRva', 'pattern', 'resultOffset', 'followRel32At', 'followRipDispAt', 'siteArithmetic', 'suggest']) {
    if (r[f] !== undefined) row[f] = r[f];
  }
  return row;
}

// spec: { cl, build, source, scans: [{ owner, tracked, tag, rank, fpAware, file }] },
// file being a harness JSON, read relative to `dir`. The CL and the build's stamp
// and size are the registry scan's `exe` block when the spec does not give them;
// `source` is the build's origin text (`public_test_branch 26271156`). Returns the
// schema 1 input.
export function assemble(spec, dir) {
  if (!spec || !Array.isArray(spec.scans) || !spec.scans.length) throw new MapError('the spec has no scans');
  const components = new Map();
  let exe = null;
  for (const s of spec.scans) {
    if (typeof s.owner !== 'string' || typeof s.file !== 'string') throw new MapError('a scan needs an owner and a file');
    const scan = JSON.parse(readFileSync(resolve(dir, s.file), 'utf8').replace(/^﻿/, ''));
    const name = scan.plugin?.name;
    if (s.owner !== 'ModLoader' && name !== undefined && name !== s.owner) throw new MapError(`${s.file} is the scan of plugin ${JSON.stringify(name)}, not ${JSON.stringify(s.owner)}`);
    if (scan.exe && s.owner === 'ModLoader') exe = scan.exe;
    if (!Array.isArray(scan.patterns)) throw new MapError(`${s.file} has no patterns array (not an sr-aobscan --json output?)`);
    if (!components.has(s.owner)) components.set(s.owner, { owner: s.owner, tracked: s.tracked !== false, releases: [] });
    const c = components.get(s.owner);
    if (c.tracked !== (s.tracked !== false)) throw new MapError(`${s.owner} is both tracked and not`);
    c.releases.push({ tag: s.tag, rank: s.rank, fpAware: s.fpAware !== false, rows: scan.patterns.map((r) => harnessRow(r, s.owner)).filter(Boolean) });
  }
  const input = { schema: 1, cl: spec.cl ?? exe?.cl, components: [...components.values()] };
  if (spec.build) input.build = spec.build;
  else if (exe && spec.source) input.build = { stamp: exe.imageStamp, size: exe.imageSize, source: spec.source };
  return input;
}

// ---- Command line -------------------------------------------------------------

export function main(argv) {
  const [cmd, header, ...rest] = argv;
  const o = { keys: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k?.startsWith('--') || rest[i + 1] === undefined) { process.stderr.write(`map-mode: bad argument ${k}\n`); return EXIT_ERROR; }
    if (k === '--keys') o.keys.push(rest[i + 1]);
    else o[k.slice(2)] = rest[i + 1];
  }
  if (cmd === 'assemble' && header && o.out) {
    try {
      const input = assemble(JSON.parse(readFileSync(header, 'utf8').replace(/^﻿/, '')), dirname(resolve(header)));
      writeFileSync(o.out, JSON.stringify(input, null, 2) + '\n');
      return EXIT_OK;
    } catch (e) {
      if (!(e instanceof MapError) && !(e instanceof SyntaxError) && e.code !== 'ENOENT') throw e;
      process.stderr.write(`map-mode: ${e.message}\n`);
      return EXIT_ERROR;
    }
  }
  if (cmd !== 'write' || !header || !o.input) {
    process.stderr.write('usage: map-mode.mjs write <header> --input <observations.json> [--keys <keys.txt>]... [--report <file>]\n'
      + '       map-mode.mjs assemble <scans.json> --out <observations.json>\n');
    return EXIT_ERROR;
  }
  try {
    const input = JSON.parse(readFileSync(o.input, 'utf8').replace(/^﻿/, ''));
    const keys = o.keys.map((p) => parseKeys(readFileSync(p, 'utf8'), p));
    const out = mapMode(readFileSync(header, 'utf8'), input, { keys });
    const report = { written: !!out.map, added: out.added ?? 0, pruned: out.pruned ?? 0, problems: out.problems, notes: out.notes ?? [], patches: out.patches ?? [] };
    if (o.report) writeFileSync(o.report, JSON.stringify(report, null, 2) + '\n');
    if (!out.map) {
      for (const p of out.problems) process.stderr.write(`refused: ${p}\n`);
      return EXIT_VIOLATION;
    }
    writeFileSync(header, out.text);
    process.stdout.write(`map-mode: ${report.added} rows added, ${report.pruned} pruned, ${report.patches.length} untracked rows left for the pattern path\n`);
    return EXIT_OK;
  } catch (e) {
    if (!(e instanceof MapError) && !(e instanceof SyntaxError) && e.code !== 'ENOENT') throw e;
    process.stderr.write(`map-mode: ${e.message}\n`);
    return EXIT_ERROR;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
