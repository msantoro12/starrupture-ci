// Looks a function name up in a game build's PDB and lists every overload: its decorated
// name, its undecorated signature, its address (RVA and file offset), its section and the
// leading bytes read from the exe, so a byte pattern can be cut and the right overload chosen.
// Run by .github/workflows/sr-symbol-lookup.yml; the Steam download and cleanup are the other
// jobs' scripts (ci/client-rig-launch.ps1, ci/steam-cleanup.ps1).
//
//   node ci/symbol-lookup.mjs check   validate the inputs (SYMBOL, BYTES, BRANCH), write the step outputs
//   node ci/symbol-lookup.mjs tools   find llvm-pdbutil and check the undecorator, before any login
//   node ci/symbol-lookup.mjs run     look the symbol up in the install (INSTALL_DIR) and write OUT_DIR
//
// The symbol is data: it is validated against a strict pattern and read from the environment,
// never put on a command line. The PDB's public symbols are listed with
// `llvm-pdbutil dump -publics` (decorated name, flags, section:offset in decimal); the
// undecorated signature comes from dbghelp (ci/symbol-undecorate.ps1); the address is the
// section's virtual address plus the offset, and the file offset comes from the exe's section
// headers. A function matches when its decorated name starts with ?Name@ (a free function or a
// member function of any class) or ??$Name@ (a function template); a qualified symbol
// (Class::Name) must also match the scope. Exit codes: 0 done (a "no match" is a result), 1 failed.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './layout-diff.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_BYTES = 64;
export const MAX_BYTES = 256;
export const MAX_LISTED = 500;
const SYMBOL_RX = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/;
const BRANCH_RX = /^[A-Za-z0-9_]{1,64}$/;

// ---- inputs ---------------------------------------------------------------------------------

// A function name of letters, digits and underscore, optionally qualified with ::.
export function parseSymbol(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 200 || !SYMBOL_RX.test(s)) {
    throw new Error(`symbol must be letters, digits and underscore, optionally qualified with :: (got ${JSON.stringify(s.slice(0, 60))})`);
  }
  return { text: s, parts: s.split('::') };
}

// The number of leading bytes: blank is the default, more than the cap is the cap.
export function parseBytes(text) {
  const s = String(text ?? '').trim();
  if (s === '') return DEFAULT_BYTES;
  if (!/^\d{1,4}$/.test(s) || Number(s) < 1) throw new Error(`bytes must be a number from 1 to ${MAX_BYTES} (got ${JSON.stringify(s.slice(0, 20))})`);
  return Math.min(Number(s), MAX_BYTES);
}

export function parseBranch(text) {
  const s = String(text ?? '').trim();
  if (!BRANCH_RX.test(s)) throw new Error(`branch must be letters, digits and underscore (got ${JSON.stringify(s.slice(0, 60))})`);
  return s;
}

// Artifact names cannot hold ':'.
export const artifactName = (branch, symbol) => `symbol-lookup-${branch}-${symbol.replaceAll('::', '.')}`;

// ---- the PDB's public symbols -----------------------------------------------------------------

// 'function' for ?Name@<scopes>@, 'template' for ??$Name@, null for anything else. A decorated
// name lists its scopes innermost first: Class::Name is ?Name@Class@@...
export function matchKind(decorated, parts) {
  const name = parts[parts.length - 1];
  const scopes = parts.slice(0, -1).reverse();
  if (decorated.startsWith(`?${name}@${scopes.map((s) => `${s}@`).join('')}`)) return 'function';
  if (decorated.startsWith(`??$${name}@`)) return 'template';
  return null;
}

// A template's scope sits behind its arguments in the decorated name, so it is judged on the
// undecorated text: Qualified::Name followed by the template argument list.
export const templateMatches = (undecorated, parts) =>
  new RegExp(`(?:^|[^A-Za-z0-9_])${parts.join('::')}<`).test(undecorated);

const HEADER_RX = /^\s*\d+ \| S_PUB32 \[size = \d+\] `(.+)`\s*$/;
const FLAGS_RX = /^\s*flags = (.*), addr = (\d+):(\d+)\s*$/;

// Reads the text of `llvm-pdbutil dump -publics` one line at a time. Each record is two lines:
//    12345 | S_PUB32 [size = 56] `?Name@@YAXXZ`
//            flags = code | function, addr = 0001:0012345        (section 1-based, offset decimal)
// Only a record whose name matches and that is code is kept; `seen` counts every record.
export function createPublicsParser(parts) {
  let seen = 0;
  let pending = null;
  const matches = [];
  return {
    feed(line) {
      if (pending) {
        const f = FLAGS_RX.exec(line);
        const record = pending;
        pending = null;
        if (f) {
          if (/\b(?:function|code)\b/.test(f[1])) matches.push({ decorated: record.decorated, kind: record.kind, segment: Number(f[2]), offset: Number(f[3]) });
          return;
        }
      }
      const h = HEADER_RX.exec(line);
      if (!h) return;
      seen++;
      const kind = matchKind(h[1], parts);
      if (kind) pending = { decorated: h[1], kind };
    },
    result: () => ({ seen, matches }),
  };
}

// Runs llvm-pdbutil and feeds its output to the parser as it arrives (the dump is hundreds of MB).
export async function readPublics(pdbutil, pdb, parts, { spawnFn = spawn, timeoutMs = 30 * 60 * 1000 } = {}) {
  const child = spawnFn(pdbutil, ['dump', '-publics', pdb], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const parser = createPublicsParser(parts);
  let err = '';
  child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => resolve(code)); });
  done.catch(() => {});
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) parser.feed(line);
    const code = await done;
    if (code !== 0) throw new Error(`llvm-pdbutil exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`);
  } finally {
    clearTimeout(timer);
  }
  const r = parser.result();
  if (r.seen === 0) throw new Error('llvm-pdbutil listed no public symbols; the PDB could not be read');
  return r;
}

// ---- the exe's sections, addresses and bytes ------------------------------------------------

// The section table of a PE file (needs the first bytes of the file). Sections are 1-based, in
// file order, the way a PDB's section:offset counts them.
export function readSections(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error('the exe has no MZ header');
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x4550) throw new Error('the exe has no PE signature');
  const count = buf.readUInt16LE(pe + 6);
  const first = pe + 24 + buf.readUInt16LE(pe + 20);
  if (count === 0 || first + count * 40 > buf.length) throw new Error('the exe\'s section table is not in its header bytes');
  const sections = [];
  for (let i = 0; i < count; i++) {
    const o = first + i * 40;
    sections.push({
      index: i + 1,
      name: buf.toString('latin1', o, o + 8).replace(/\0[\s\S]*$/, ''),
      virtualSize: buf.readUInt32LE(o + 8),
      virtualAddress: buf.readUInt32LE(o + 12),
      rawSize: buf.readUInt32LE(o + 16),
      rawPointer: buf.readUInt32LE(o + 20),
    });
  }
  return sections;
}

// Section number and offset (from the PDB) to the RVA, the file offset (null when the offset lies
// past the section's data in the file) and how many bytes of it the file holds, up to `want`.
export function locate(sections, segment, offset, want) {
  const s = sections[segment - 1];
  if (!s) throw new Error(`the PDB names section ${segment}, the exe has ${sections.length}`);
  const inFile = offset < s.rawSize;
  return {
    section: s,
    rva: s.virtualAddress + offset,
    fileOffset: inFile ? s.rawPointer + offset : null,
    available: inFile ? Math.min(want, s.rawSize - offset) : 0,
  };
}

export const hexBytes = (buf) => [...buf].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
export const hex8 = (n) => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;

// ---- the build --------------------------------------------------------------------------------

// The build id and the branch Steam mounted, from steamapps/appmanifest_<app>.acf.
export function parseManifest(text) {
  const mounted = /"MountedConfig"\s*\{([^{}]*)\}/.exec(text)?.[1] ?? '';
  return { buildid: /"buildid"\s+"(\d+)"/.exec(text)?.[1] ?? '', betaKey: /"BetaKey"\s+"([^"]*)"/.exec(mounted)?.[1] ?? '' };
}

export const clOf = (productVersion) => /CL-(\d+)/.exec(String(productVersion ?? ''))?.[1] ?? '';

// ---- the result -------------------------------------------------------------------------------

export function buildResult({ symbol, branch, bytes, build, exe, pdb, seen, matches, listed }) {
  return {
    schema: 1,
    status: matches.length ? 'ok' : 'no-match',
    symbol,
    branch,
    build,
    exe,
    pdb,
    publicSymbolsRead: seen,
    bytesRequested: bytes,
    matchCount: matches.length,
    listedCount: listed.length,
    matches: listed,
  };
}

export function renderText(r) {
  const out = [
    `Symbol lookup: ${r.symbol}`,
    `Branch ${r.branch}, build ${r.build.buildid}, CL-${r.build.cl || '?'} (${r.build.productVersion || 'no product version'})`,
    `Exe ${r.exe.path}: ${r.exe.size} bytes, SHA-256 ${r.exe.sha256}`,
    `PDB ${r.pdb.name}: ${r.pdb.size} bytes, ${r.publicSymbolsRead} public symbols read`,
    '',
  ];
  if (!r.matchCount) {
    out.push(`No match: none of the ${r.publicSymbolsRead} public symbols is a function or member function named ${r.symbol}. This is a result, not a failure.`);
    return out.join('\n') + '\n';
  }
  out.push(`Matches: ${r.matchCount}${r.listedCount < r.matchCount ? ` (the first ${r.listedCount} are listed)` : ''}`, '');
  r.matches.forEach((m, i) => {
    out.push(`${i + 1}. ${m.undecorated || '(dbghelp could not undecorate this name)'}`,
      `   decorated  ${m.decorated}`,
      `   RVA ${m.rva}   file offset ${m.fileOffset ?? 'none (past the section data in the file)'}   section ${m.section.name} (${m.section.index})`,
      `   bytes (${m.bytesRead}) ${m.bytes}`, '');
  });
  return out.join('\n');
}

export function renderSummary(r) {
  const head = `### Symbol lookup: \`${r.symbol}\`\n\nbranch ${r.branch}, build ${r.build.buildid}, CL-${r.build.cl || '?'}; exe ${r.exe.size} bytes, SHA-256 \`${r.exe.sha256}\`; ${r.matchCount} match${r.matchCount === 1 ? '' : 'es'} among ${r.publicSymbolsRead} public symbols\n\n`;
  return `${head}\`\`\`\n${renderText(r)}\`\`\`\n`;
}

// ---- tools ------------------------------------------------------------------------------------

export function findPdbutil(env = process.env, exists = existsSync) {
  const dirs = [...String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean), join(env.ProgramFiles ?? 'C:\\Program Files', 'LLVM', 'bin')];
  for (const d of dirs) for (const n of ['llvm-pdbutil.exe', 'llvm-pdbutil']) if (exists(join(d, n))) return join(d, n);
  throw new Error('llvm-pdbutil was not found on PATH or in the LLVM folder of Program Files');
}

// Declarations for decorated names, from dbghelp through ci/symbol-undecorate.ps1, in order.
export function undecorate(names, { run = spawnSync, script = join(here, 'symbol-undecorate.ps1') } = {}) {
  if (!names.length) return [];
  const r = run('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { input: `${names.join('\n')}\n`, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`undecorating failed: ${r.error?.message ?? String(r.stderr ?? '').trim().split('\n')[0]}`);
  const lines = String(r.stdout).trim().split('\n');
  const parsed = JSON.parse(lines[lines.length - 1]);
  if (!Array.isArray(parsed) || parsed.length !== names.length) throw new Error('undecorating returned the wrong number of names');
  return parsed;
}

function productVersion(exe, run = spawnSync) {
  const r = run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:SYMBOL_LOOKUP_EXE).VersionInfo.ProductVersion'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, SYMBOL_LOOKUP_EXE: exe } });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

// ---- the lookup -------------------------------------------------------------------------------

function findExe(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'Engine') stack.push(p); } else if (e.name.endsWith('-Win64-Shipping.exe')) return p;
    }
  }
  throw new Error('no *-Win64-Shipping.exe in the install');
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function readAt(path, offset, length) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

// `io` replaces the three things that need a Windows runner: the PDB dump, dbghelp and the exe's
// version resource.
export async function lookup({ installDir, branch, symbol, bytes, appId = '1631270' }, io = {}) {
  const { text, parts } = symbol;
  const exe = findExe(installDir);
  const pdb = exe.replace(/\.exe$/i, '.pdb');
  if (!existsSync(pdb)) throw new Error(`no PDB next to ${relative(installDir, exe)}`);
  const manifest = parseManifest(readFileSync(join(installDir, 'steamapps', `appmanifest_${appId}.acf`), 'utf8'));
  if (!manifest.buildid || manifest.betaKey !== branch) throw new Error(`the install is build ${manifest.buildid || '?'} of branch ${JSON.stringify(manifest.betaKey)}, not branch ${branch}`);

  const sections = readSections(readAt(exe, 0, Math.min(statSync(exe).size, 1 << 20)));
  const found = await (io.readPublics ?? ((p) => readPublics(findPdbutil(), p, parts)))(pdb);
  const names = found.matches.map((m) => m.decorated);
  const declared = (io.undecorate ?? undecorate)(names);
  const all = found.matches
    .map((m, i) => ({ ...m, undecorated: declared[i] }))
    .filter((m) => m.kind === 'function' || templateMatches(m.undecorated, parts));
  const located = all.map((m) => ({ ...m, ...locate(sections, m.segment, m.offset, bytes) })).sort((a, b) => a.rva - b.rva || (a.decorated < b.decorated ? -1 : 1));
  const listed = located.slice(0, MAX_LISTED).map((m) => {
    const got = m.fileOffset === null ? Buffer.alloc(0) : readAt(exe, m.fileOffset, m.available);
    return {
      decorated: m.decorated,
      undecorated: m.undecorated,
      kind: m.kind,
      rva: hex8(m.rva),
      fileOffset: m.fileOffset === null ? null : hex8(m.fileOffset),
      section: { index: m.section.index, name: m.section.name },
      bytesRead: got.length,
      bytes: hexBytes(got),
    };
  });
  const pv = (io.productVersion ?? productVersion)(exe);
  return buildResult({
    symbol: text,
    branch,
    bytes,
    build: { buildid: manifest.buildid, cl: clOf(pv), productVersion: pv, betaKey: manifest.betaKey },
    exe: { path: relative(installDir, exe), size: statSync(exe).size, sha256: await sha256File(exe) },
    pdb: { name: relative(installDir, pdb), size: statSync(pdb).size },
    seen: found.seen,
    matches: located,
    listed,
  });
}

// ---- the command line -----------------------------------------------------------------------

const oneLine = (s) => String(s).replace(/\s+/g, ' ').slice(0, 400);

function fail(e) {
  console.log(`::error title=Symbol lookup::${oneLine(e.message)}`);
  process.exitCode = 1;
}

function setOutputs(pairs) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(''));
}

if (isMain(import.meta.url)) {
  const env = process.env;
  const cmd = process.argv[2];
  try {
    if (cmd === 'check') {
      const symbol = parseSymbol(env.SYMBOL);
      const bytes = parseBytes(env.BYTES);
      const branch = parseBranch(env.BRANCH);
      if (String(env.BYTES ?? '').trim() !== '' && bytes !== Number(env.BYTES)) console.log(`::notice title=Symbol lookup::bytes is capped at ${MAX_BYTES}`);
      setOutputs({ artifact_name: artifactName(branch, symbol.text), bytes });
      console.log(`symbol ${symbol.text}, branch ${branch}, ${bytes} bytes`);
    } else if (cmd === 'tools') {
      const pdbutil = findPdbutil();
      const v = spawnSync(pdbutil, ['--version'], { encoding: 'utf8', windowsHide: true });
      console.log(`${pdbutil}: ${String(v.stdout).trim().split('\n').find((l) => /version/i.test(l)) ?? 'version not printed'}`);
      const got = undecorate(['?Foo@@YAXH@Z'])[0];
      if (got !== 'void __cdecl Foo(int)') throw new Error(`dbghelp undecorated ?Foo@@YAXH@Z as ${JSON.stringify(got)}`);
      console.log(`dbghelp: ?Foo@@YAXH@Z is ${got}`);
    } else if (cmd === 'run') {
      const outDir = env.OUT_DIR || 'out';
      mkdirSync(outDir, { recursive: true });
      const symbol = parseSymbol(env.SYMBOL);
      const branch = parseBranch(env.BRANCH);
      try {
        const result = await lookup({ installDir: env.INSTALL_DIR, branch, symbol, bytes: parseBytes(env.BYTES) });
        writeFileSync(join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
        writeFileSync(join(outDir, 'result.txt'), renderText(result));
        if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(result));
        console.log(renderText(result));
      } catch (e) {
        writeFileSync(join(outDir, 'result.json'), `${JSON.stringify({ schema: 1, status: 'failed', symbol: symbol.text, branch, reason: oneLine(e.message) }, null, 2)}\n`);
        throw e;
      }
    } else {
      console.error('usage: symbol-lookup.mjs check | tools | run');
      process.exitCode = 2;
    }
  } catch (e) {
    fail(e);
  }
}
