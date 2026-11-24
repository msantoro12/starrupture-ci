#!/usr/bin/env node
// Turns the loader's per-launch feature dumps (ModLoader\Logs\declared-features.v1.txt,
// one per live game build) into the JSON input of ci/plugin-catalog.mjs, and says whether
// the catalog rows differ from the published catalog.
//
// Dump: UTF-8, LF, TAB-separated.
//   format<TAB>1
//   kind<TAB>declared-features
//   game_cl<TAB><digits>   no leading zero, at most 10 digits
//   loader<TAB><version>
//   plugin<TAB><name><TAB><version>                         one per running plugin
//   feature<TAB><plugin><TAB><id><TAB>on|off<TAB><title>    after its plugin row
// on|off says whether the feature is on in the build that produced the dump.
//
//   node ci/catalog-from-dumps.mjs <dump>... --out <catalog-in.json>
//        [--published <published-plugin-catalog.v1.txt>] [--verdict <path>]
//
// With --published, prints `changed` or `unchanged` (rows compared, seq and signature
// ignored; a missing published file is `changed`) and writes it to --verdict. Exit 0 either way.
// An off list only ever holds game CLs whose dump says off; `*` is never written, since a dump
// cannot prove a feature off on a future build.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isMain } from './layout-diff.mjs';
import { buildCatalog, isCl, parseCatalog } from './plugin-catalog.mjs';

export class DumpError extends Error {}
const need = (cond, msg) => { if (!cond) throw new DumpError(msg); };
const NAME = /^[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^[0-9A-Za-z._+-]{1,32}$/;

export function parseDump(text) {
  need(typeof text === 'string' && !text.includes('\r'), 'the dump has a CR');
  const lines = text.split('\n');
  need(lines.pop() === '', 'the dump does not end in LF');
  const head = (i, key) => {
    const f = (lines[i] ?? '').split('\t');
    need(f.length === 2 && f[0] === key, `line ${i + 1}: expected ${key}<TAB>value`);
    return f[1];
  };
  need(head(0, 'format') === '1', 'the dump format is not 1');
  need(head(1, 'kind') === 'declared-features', 'the dump kind is not declared-features');
  const cl = head(2, 'game_cl');
  need(isCl(cl), `game_cl ${JSON.stringify(cl)} is not a CL number (digits, no leading zero, at most 10)`);
  const loader = head(3, 'loader');
  need(loader.length > 0, 'the loader version is empty');
  const byName = new Map(); // lower-case name -> plugin
  const seen = new Set();
  const plugins = [];
  for (let i = 4; i < lines.length; i++) {
    const f = lines[i].split('\t');
    const at = `line ${i + 1}`;
    if (f[0] === 'plugin') {
      need(f.length === 3, `${at}: a plugin row is plugin, name, version`);
      need(f[1].length <= 64 && NAME.test(f[1]), `${at}: bad plugin name ${JSON.stringify(f[1])}`);
      need(VERSION.test(f[2]), `${at}: bad version ${JSON.stringify(f[2])}`);
      need(!byName.has(f[1].toLowerCase()), `${at}: plugin ${f[1]} is listed twice`);
      const p = { name: f[1], version: f[2], features: [] };
      byName.set(f[1].toLowerCase(), p);
      plugins.push(p);
    } else if (f[0] === 'feature') {
      need(f.length === 5, `${at}: a feature row is feature, plugin, id, on|off, title`);
      const p = byName.get(f[1].toLowerCase());
      need(p && p.name === f[1], `${at}: feature ${f[2]} comes before its plugin row ${f[1]}`);
      need(ID.test(f[2]), `${at}: bad feature id ${JSON.stringify(f[2])}`);
      need(f[3] === 'on' || f[3] === 'off', `${at}: state ${JSON.stringify(f[3])} is not on or off`);
      need(f[4].length > 0, `${at}: empty title`);
      const key = `${p.name.toLowerCase()}\t${f[2].toLowerCase()}`;
      need(!seen.has(key), `${at}: feature ${p.name} ${f[2]} is listed twice`);
      seen.add(key);
      p.features.push({ id: f[2], state: f[3], title: f[4] });
    } else need(false, `${at}: unknown row type ${JSON.stringify(f[0])}`);
  }
  return { gameCl: cl, loader, plugins };
}

const clNum = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// dotted-numeric compare; a non-numeric segment compares as text
function cmpVersion(a, b) {
  const x = a.split('.'), y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? '0', q = y[i] ?? '0';
    const r = /^[0-9]+$/.test(p) && /^[0-9]+$/.test(q) ? clNum(p, q) : cmp(p, q);
    if (r) return r;
  }
  return 0;
}
const canon = (d) => JSON.stringify({
  l: d.loader,
  p: [...d.plugins].sort((a, b) => cmp(a.name, b.name)).map((p) => [p.name, p.version, [...p.features].sort((a, b) => cmp(a.id, b.id)).map((f) => [f.id, f.state, f.title])]),
});

// dumps: parsed dumps, one per live game build. Returns { input, warnings }.
export function mergeDumps(dumps) {
  const warnings = [];
  const byCl = new Map();
  for (const d of dumps) {
    const prior = byCl.get(d.gameCl);
    need(!prior || canon(prior) === canon(d), `two dumps for game CL ${d.gameCl} differ in content`);
    byCl.set(d.gameCl, d);
  }
  const ordered = [...byCl.values()].sort((a, b) => clNum(a.gameCl, b.gameCl)); // ascending CL
  const plugins = new Map(); // lower-case name -> { name, version, feats: Map }
  for (const d of ordered) {
    for (const p of d.plugins) {
      const k = p.name.toLowerCase();
      let e = plugins.get(k);
      if (!e) { e = { name: p.name, version: p.version, feats: new Map() }; plugins.set(k, e); }
      else {
        e.name = p.name; // the highest CL's spelling
        if (e.version !== p.version) {
          const hi = cmpVersion(p.version, e.version) > 0 ? p.version : e.version;
          warnings.push(`plugin ${p.name}: version differs between builds (${e.version} and ${p.version}); kept ${hi}`);
          e.version = hi;
        }
      }
      for (const f of p.features) {
        const fk = f.id.toLowerCase();
        let g = e.feats.get(fk);
        if (!g) { g = { id: f.id, title: f.title, off: new Set() }; e.feats.set(fk, g); }
        else if (g.title !== f.title) {
          warnings.push(`feature ${p.name} ${f.id}: title differs between builds; kept the one from game CL ${d.gameCl}`);
          g.title = f.title;
          g.id = f.id;
        }
        if (f.state === 'off') g.off.add(d.gameCl);
      }
    }
  }
  const out = [...plugins.values()].sort((a, b) => cmp(a.name, b.name)).map((e) => ({
    name: e.name,
    version: e.version,
    features: [...e.feats.values()].sort((a, b) => cmp(a.id, b.id)).map((g) => ({
      id: g.id, title: g.title, off: g.off.size ? [...g.off].sort(clNum) : '-',
    })),
  }));
  return { input: { plugins: out }, warnings };
}

// published: text of the published catalog, or null. Returns 'changed' or 'unchanged'.
export function verdict(input, published) {
  if (published == null) return 'changed';
  const fresh = buildCatalog(input);
  const old = buildCatalog({ plugins: parseCatalog(published).plugins });
  return fresh === old ? 'unchanged' : 'changed';
}

export function main(argv) {
  const dumps = [];
  let out, published, verdictPath;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--published' || a === '--verdict') {
      need(argv[i + 1] !== undefined, `${a} needs a value`);
      if (a === '--out') out = argv[++i]; else if (a === '--published') published = argv[++i]; else verdictPath = argv[++i];
    } else { need(!a.startsWith('--'), `unknown option ${a}`); dumps.push(a); }
  }
  need(dumps.length && out, 'usage: catalog-from-dumps.mjs <dump>... --out <catalog-in.json> [--published <file>] [--verdict <path>]');
  need(!verdictPath || published, '--verdict needs --published');
  const { input, warnings } = mergeDumps(dumps.map((f) => parseDump(readFileSync(f, 'utf8'))));
  buildCatalog(input); // every catalog limit, before anything is written
  writeFileSync(out, `${JSON.stringify(input, null, 2)}\n`);
  for (const w of warnings) process.stderr.write(`catalog-from-dumps: warning: ${w}\n`);
  if (published) {
    const v = verdict(input, existsSync(published) ? readFileSync(published, 'utf8') : null);
    process.stdout.write(`${v}\n`);
    if (verdictPath) writeFileSync(verdictPath, v);
  }
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`catalog-from-dumps: ${e.message}\n`);
    process.exitCode = 2;
  }
}
