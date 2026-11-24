#!/usr/bin/env node
// The signed plugin catalog: which plugins exist at which version, and on which
// game builds each of their features is off. The in-game admin tool reads it.
// This module is the ONE place that knows the catalog grammar (agreed with the
// Loader agent); a grammar change is an edit here and in its tests.
//
// UTF-8, LF, TAB-separated, no escaping, no blank or comment lines:
//   format<TAB>1                                  the version map's envelope
//   seq<TAB><n>                                   added by the signer
//   kind<TAB>plugin-catalog                       required; same keys sign the version map, so this line
//                                                 keeps one file from verifying as the other
//   plugin<TAB><name><TAB><version>
//   feature<TAB><plugin><TAB><id><TAB><off><TAB><title>   after its plugin row
//   sig<TAB><keyId><TAB><base64>                  added by the signer, last
// off: `-` (on everywhere), `*` (off on every build) or a comma list of game CLs, digits only.
// Limits (the whole file is refused on any breach): name and id [A-Za-z0-9_-]{1,64};
// version [0-9A-Za-z._+-]{1,32}; title 1 to 80 UTF-8 bytes, no control characters;
// file at most 256 KiB, 200 plugins, 2000 feature rows; a plugin or (plugin, id) twice,
// compared without regard to case; a feature row before its plugin row; an unknown
// row type or a wrong field count. Rows are written sorted by plugin, then id.
//
// JSON input for `build` (what the rig produces from the loader's feature dump):
//   {"plugins":[{"name":"WAILA","version":"1.2.3","features":[
//      {"id":"tooltip","title":"Block tooltip","off":[127004,"130045"]}]}]}
// off is "-", "*" or an array of CL numbers or digit strings (sorted, duplicates dropped).
//
//   node ci/plugin-catalog.mjs build <in.json> --out <unsigned.txt>
//
// Signing and verifying: ci/vmap-sign.mjs with --kind catalog.

import { readFileSync, writeFileSync } from 'node:fs';
import { isMain } from './layout-diff.mjs';

export const CATALOG_FORMAT_LINE = 'format\t1';
export const CATALOG_KIND_LINE = 'kind\tplugin-catalog';
export const CATALOG_MAX_BYTES = 256 * 1024;
export const MAX_PLUGINS = 200;
export const MAX_FEATURES = 2000;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^[0-9A-Za-z._+-]{1,32}$/;
const CL = /^[0-9]+$/;

export class CatalogError extends Error {}
const need = (cond, msg) => { if (!cond) throw new CatalogError(msg); };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function checkTitle(t, what) {
  need(typeof t === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(t), `${what}: the title has a control character or is not text`);
  const n = Buffer.byteLength(t);
  need(n >= 1 && n <= 80, `${what}: the title is ${n} bytes, not 1 to 80`);
  return t;
}
function checkOff(off, what) {
  need(typeof off === 'string' && (off === '-' || off === '*' || (off.split(',').every((c) => CL.test(c)))), `${what}: off ${JSON.stringify(off)} is not -, * or a comma list of CL numbers`);
  if (off === '-' || off === '*') return off;
  need(new Set(off.split(',')).size === off.split(',').length, `${what}: off lists a CL twice`);
  return off;
}

// text: an unsigned, seq-only or signed catalog, ending in LF. Returns { seq, plugins }
// with seq null when there is no seq line. A trailing sig line is skipped (its
// signature is vmap-sign's to check).
export function parseCatalog(text) {
  need(Buffer.byteLength(text) <= CATALOG_MAX_BYTES, `the catalog is over ${CATALOG_MAX_BYTES} bytes`);
  need(!text.includes('\r'), 'the catalog has a CR');
  const lines = text.split('\n');
  need(lines.pop() === '', 'the catalog does not end in LF');
  need(lines[0] === CATALOG_FORMAT_LINE, `the first line is not ${JSON.stringify(CATALOG_FORMAT_LINE)}`);
  let i = 1;
  let seq = null;
  const sm = /^seq\t([1-9][0-9]*)$/.exec(lines[1] ?? '');
  if (sm) { seq = Number(sm[1]); i = 2; }
  need(lines[i] === CATALOG_KIND_LINE, `the kind line ${JSON.stringify(CATALOG_KIND_LINE)} is missing`);
  i++;
  if (lines.length > i && lines[lines.length - 1].startsWith('sig\t')) lines.pop();
  const plugins = new Map(); // lower-case name -> plugin
  const seen = new Set();
  let features = 0;
  for (; i < lines.length; i++) {
    const f = lines[i].split('\t');
    const at = `line ${i + 1}`;
    if (f[0] === 'plugin') {
      need(f.length === 3, `${at}: a plugin row is plugin, name, version`);
      need(NAME.test(f[1]), `${at}: plugin name ${JSON.stringify(f[1])} is not [A-Za-z0-9_-]{1,64}`);
      need(VERSION.test(f[2]), `${at}: version ${JSON.stringify(f[2])} is not [0-9A-Za-z._+-]{1,32}`);
      need(!plugins.has(f[1].toLowerCase()), `${at}: plugin ${f[1]} is listed twice`);
      need(plugins.size < MAX_PLUGINS, `the catalog has more than ${MAX_PLUGINS} plugins`);
      plugins.set(f[1].toLowerCase(), { name: f[1], version: f[2], features: [] });
    } else if (f[0] === 'feature') {
      need(f.length === 5, `${at}: a feature row is feature, plugin, id, off, title`);
      const p = [...plugins.values()].find((q) => q.name === f[1]);
      need(p, `${at}: feature ${f[2]} comes before its plugin row ${f[1]}`);
      need(NAME.test(f[2]), `${at}: feature id ${JSON.stringify(f[2])} is not [A-Za-z0-9_-]{1,64}`);
      const key = `${p.name.toLowerCase()}\t${f[2].toLowerCase()}`;
      need(!seen.has(key), `${at}: feature ${p.name} ${f[2]} is listed twice`);
      seen.add(key);
      need(++features <= MAX_FEATURES, `the catalog has more than ${MAX_FEATURES} feature rows`);
      p.features.push({ id: f[2], off: checkOff(f[3], `${at}`), title: checkTitle(f[4], at) });
    } else need(false, `${at}: unknown row type ${JSON.stringify(f[0])}`);
  }
  return { seq, plugins: [...plugins.values()] };
}

// input: the JSON object described above. Returns the unsigned catalog text.
export function buildCatalog(input) {
  need(input && Array.isArray(input.plugins), 'the input has no plugins array');
  const rows = [CATALOG_FORMAT_LINE, CATALOG_KIND_LINE];
  for (const p of [...input.plugins].sort((a, b) => cmp(a?.name, b?.name))) {
    rows.push(['plugin', p?.name, p?.version].join('\t'));
    for (const ft of [...(p?.features ?? [])].sort((a, b) => cmp(a?.id, b?.id))) {
      let off = ft?.off ?? '-';
      if (Array.isArray(off)) {
        const cls = [...new Set(off.map(String))];
        need(cls.every((c) => CL.test(c)), `feature ${p.name} ${ft.id}: off has a value that is not a CL number`);
        off = cls.length ? cls.sort((a, b) => Number(a) - Number(b) || cmp(a, b)).join(',') : '-';
      }
      rows.push(['feature', p.name, ft?.id, off, ft?.title].join('\t'));
    }
  }
  const text = `${rows.join('\n')}\n`;
  parseCatalog(text); // every limit, duplicates, order
  return text;
}

export function main(argv) {
  const [cmd, input, flag, out] = argv;
  need(cmd === 'build' && input && flag === '--out' && out && argv.length === 4, 'usage: plugin-catalog.mjs build <in.json> --out <unsigned.txt>');
  writeFileSync(out, buildCatalog(JSON.parse(readFileSync(input, 'utf8'))));
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`plugin-catalog: ${e.message}\n`);
    process.exitCode = 2;
  }
}
