#!/usr/bin/env node
// CI checks for the PluginInfo tail (version-map step 29, design R3).
//
//   node ci/tail-check.mjs migrated --used <keys.txt> --keys <keys.txt>... [--checks <list>] [--engine <list>] --source <file>...
//   node ci/tail-check.mjs build-cl --build-cl <build_cl.txt> --basic <Basic.hpp> --map <header>
//
// migrated: a plugin that declares PLUGIN_MAP_MIGRATED says every game-class
// member it reads is a per-build field, a check or size row, or an engine member
// that stays compile-time. This lists every member of the plugin's used set (the
// output of `layout-table.mjs keys` on its sources, one `Class` or `Class::Member`
// per line) that none of those cover, and fails (exit 3) if the plugin declares
// the flag and any is left. A plugin that does not declare the flag is not held
// to it. Bare class keys (a class's size) are not required to be covered here:
// only members are.
//   --keys    the plugin's key lists (ci/VERSION-MAP.md): `native` and `field`
//             lines are its per-build fields
//   --checks  its check and size rows, one `Class::Member` or `Class` per line
//   --engine  the engine-prefix list: a `Class` covers all its members, a
//             `Class::Member` covers that member
//   --source  the files that can hold the PluginInfo initializer; the flag counts
//             when PLUGIN_MAP_MIGRATED appears outside a comment
//
// build-cl: the Game-SDK's build_cl.txt must name a CL in the loader map's build
// table, and the dump's Offsets:: (Basic.hpp) must equal the map's rows for that
// CL: GObjects and AppendString are enforced; GNames and GWorld are compared and
// reported, because the SDK's values for them differ from the engine's by design.
//
// Exit codes: 0 pass, 3 a check failed, 2 usage or malformed input.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EXIT_ERROR, EXIT_OK, EXIT_VIOLATION, MapError, parse, parseKeys, unionKeys } from './version-map.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hex = (n) => '0x' + n.toString(16).toUpperCase();

const lines = (text) => text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);

// True when PLUGIN_MAP_MIGRATED appears in the code, not in a comment or a string.
export function declaresMigrated(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  return /\bPLUGIN_MAP_MIGRATED\b/.test(code);
}

// The members of `used` that no cover reaches, sorted.
export function uncovered({ used, fields, checks, engine }) {
  const covered = new Set([...fields, ...checks, ...engine]);
  const engineClasses = new Set([...engine].filter((k) => !k.includes('::')));
  return [...used].filter((k) => k.includes('::') && !covered.has(k) && !engineClasses.has(k.slice(0, k.indexOf('::')))).sort(cmp);
}

export function checkMigrated({ sources, used, keys, checks = [], engine = [] }) {
  const declared = sources.some(declaresMigrated);
  const fields = new Set([...keys.native.keys(), ...keys.fields]);
  const left = uncovered({ used: new Set(used), fields, checks: new Set(checks), engine: new Set(engine) });
  const problems = declared ? left.map((k) => `${k}: read by the plugin, but not a field, a check row or an engine member; the plugin declares PLUGIN_MAP_MIGRATED`) : [];
  return { declared, uncovered: left, problems };
}

// `constexpr int32 Name = 0x...;` in Basic.hpp's Offsets namespace.
export function readOffsets(text) {
  const out = {};
  for (const name of ['GObjects', 'AppendString', 'GNames', 'GWorld']) {
    const m = new RegExp(`constexpr\\s+int32\\s+${name}\\s*=\\s*(0x[0-9A-Fa-f]+)`).exec(text);
    if (m) out[name] = parseInt(m[1], 16);
  }
  return out;
}

const GLOBAL_KEYS = {
  GObjects: { key: 'ModLoader/GObjects (GUObjectArray.ObjObjects)', enforced: true },
  AppendString: { key: 'FName::AppendString', enforced: true },
  GNames: { key: 'GNames (NamePoolData)', enforced: false },
  GWorld: { key: 'GWorld', enforced: false },
};

// buildCl: the text of build_cl.txt; basic: the text of Basic.hpp; map: the loader map.
export function checkBuildCl({ buildCl, basic, map }) {
  const problems = [];
  const notes = [];
  const t = buildCl.trim();
  if (!/^\d+$/.test(t)) return { cl: null, problems: [`build_cl.txt holds ${JSON.stringify(t.slice(0, 40))}, not one CL number`], notes };
  const cl = Number(t);
  if (!map.builds.some((b) => b.cl === cl)) return { cl, problems: [`build_cl.txt names CL-${cl}, which is not in the map's build table`], notes };
  const offsets = readOffsets(basic);
  for (const [name, { key, enforced }] of Object.entries(GLOBAL_KEYS)) {
    if (offsets[name] === undefined) { problems.push(`Basic.hpp has no Offsets::${name}`); continue; }
    const located = map.functions.filter((r) => r.key === key && r.cl === cl && !r.absent);
    if (!located.length) { (enforced ? problems : notes).push(`${key} has no locator on CL-${cl} to compare Offsets::${name} (${hex(offsets[name])}) with`); continue; }
    const wrong = located.filter((r) => r.rva !== offsets[name]);
    if (wrong.length) {
      const msg = `Offsets::${name} is ${hex(offsets[name])}, the map's ${key} on CL-${cl} is ${[...new Set(located.map((r) => hex(r.rva)))].join(' and ')}`;
      (enforced ? problems : notes).push(enforced ? `${msg}: build_cl.txt names the wrong CL for this dump, or the dump is stale` : `${msg} (by design for ${name}; not enforced)`);
    }
  }
  return { cl, problems, notes };
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  const o = { keys: [], source: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k?.startsWith('--') || rest[i + 1] === undefined) { process.stderr.write(`tail-check: bad argument ${k}\n`); return EXIT_ERROR; }
    if (k === '--keys' || k === '--source') o[k.slice(2)].push(rest[i + 1]);
    else o[k.slice(2)] = rest[i + 1];
  }
  const read = (p) => readFileSync(p, 'utf8');
  try {
    if (cmd === 'migrated' && o.used && o.keys.length && o.source.length) {
      const r = checkMigrated({
        sources: o.source.map(read), used: lines(read(o.used)), keys: unionKeys(o.keys.map((p) => parseKeys(read(p), p))),
        checks: o.checks ? lines(read(o.checks)) : [], engine: o.engine ? lines(read(o.engine)) : [],
      });
      if (!r.declared) process.stdout.write(`tail-check: the plugin does not declare PLUGIN_MAP_MIGRATED; ${r.uncovered.length} used members are not covered\n`);
      for (const p of r.problems) process.stderr.write(`FAIL ${p}\n`);
      if (r.declared && !r.problems.length) process.stdout.write('tail-check: PLUGIN_MAP_MIGRATED declared, every used member is covered\n');
      return r.problems.length ? EXIT_VIOLATION : EXIT_OK;
    }
    if (cmd === 'build-cl' && o['build-cl'] && o.basic && o.map) {
      const r = checkBuildCl({ buildCl: read(o['build-cl']), basic: read(o.basic), map: parse(read(o.map), 'the map') });
      for (const n of r.notes) process.stdout.write(`note: ${n}\n`);
      for (const p of r.problems) process.stderr.write(`FAIL ${p}\n`);
      if (!r.problems.length) process.stdout.write(`tail-check: build_cl.txt CL-${r.cl} matches the dump's Offsets::\n`);
      return r.problems.length ? EXIT_VIOLATION : EXIT_OK;
    }
  } catch (e) {
    if (!(e instanceof MapError) && e.code !== 'ENOENT') throw e;
    process.stderr.write(`tail-check: ${e.message}\n`);
    return EXIT_ERROR;
  }
  process.stderr.write('usage: tail-check.mjs migrated --used <f> --keys <f>... [--checks <f>] [--engine <f>] --source <f>...\n'
    + '       tail-check.mjs build-cl --build-cl <build_cl.txt> --basic <Basic.hpp> --map <header>\n');
  return EXIT_ERROR;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
