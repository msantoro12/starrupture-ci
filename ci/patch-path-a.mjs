#!/usr/bin/env node
// patch-path-a.mjs: build the Path A (CL-only) patch for StarRupture-ModLoader.
//
//   node ci/patch-path-a.mjs --repo <checkout> --cl 127999 --title "<Steam news title>" \
//       [--out patches] [--latest 1.22.1] [--base <sha prefix>]
//   node ci/patch-path-a.mjs --check <patch> [--sha256 <hex or file>] [--max-lines 60] [--allow <path>]...
//
// Generate mode edits three things and writes <out>/ModLoader.patch plus
// <out>/ModLoader.patch.sha256:
//   - the required CL suffix in StarRupture-ModLoader-Core/core/version_check.cpp
//   - the `version` file, set to the next patch version
//   - UPDATE_NOTES.txt, replaced by one line: Supports game build CL-xxxxx (<title>)
// The patch is built from the blobs at HEAD in a throwaway index and object
// directory. The checkout's working tree and object store are never written.
//
// Check mode is the G0 diff policy: allowlisted files only, at most 60 changed
// lines, nothing but plain edits of regular files, and the content of each Path A
// file pinned to the one edit it may carry (the CL suffix, the version number, the
// one notes line). The target repo runs the same check again before applying.
// Exit 0 = policy ok, 1 = rejected, 2 = usage.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CL_FILE = 'StarRupture-ModLoader-Core/core/version_check.cpp';
export const VERSION_FILE = 'version';
export const NOTES_FILE = 'UPDATE_NOTES.txt';
export const PATH_A_ALLOWLIST = Object.freeze([CL_FILE, VERSION_FILE, NOTES_FILE]);
export const MAX_CHANGED_LINES = 60;

// What each Path A file may contain after the edit. Matched per line, ignoring a trailing CR.
const CL_LINE = /^static\s+constexpr\s+wchar_t\s+kRequiredVersionSuffix\[\]\s*=\s*L"CL-([1-9][0-9]{0,8})";$/;
const VERSION_LINE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const NOTES_LINE = /^Supports game build CL-[1-9][0-9]{0,8}( \([\x20-\x7e]{1,120}\))?$/;
const noCr = (l) => l.replace(/\r$/, '');

// Content pinning for one parsed file. `f.addedLines` / `f.removedLines` hold the lines without their +/- marker.
function pinContent(f, errors) {
  const add = f.addedLines.map(noCr);
  const rem = f.removedLines.map(noCr);
  if (f.path === CL_FILE) {
    if (add.length !== 1 || rem.length !== 1) { errors.push(`${f.path}: expected exactly one removed and one added line, got ${rem.length} and ${add.length}`); return; }
    const o = CL_LINE.exec(rem[0]);
    const n = CL_LINE.exec(add[0]);
    if (!o || !n) errors.push(`${f.path}: changed lines are not the kRequiredVersionSuffix definition`);
    else if (Number(n[1]) <= Number(o[1])) errors.push(`${f.path}: CL-${n[1]} is not newer than CL-${o[1]}`);
    else if (add[0].replace(n[1], '#') !== rem[0].replace(o[1], '#')) errors.push(`${f.path}: the line changed in more than the CL number`);
  } else if (f.path === VERSION_FILE) {
    if (add.length !== 1 || !VERSION_LINE.test(add[0])) errors.push(`${f.path}: expected one added x.y.z line`);
    if (rem.some((l) => !VERSION_LINE.test(l))) errors.push(`${f.path}: removed line is not x.y.z`);
  } else if (f.path === NOTES_FILE) {
    if (add.length !== 1 || !NOTES_LINE.test(add[0])) errors.push(`${f.path}: expected one added "Supports game build CL-n (title)" line of printable ASCII`);
  }
}

// ---------------------------------------------------------------- G0 policy

// Parses a unified git diff strictly and returns { ok, errors, files, changedLines }.
// Anything it does not understand is an error: only plain edits of regular
// files (and new regular files) pass.
export function checkPatch(text, { allow = PATH_A_ALLOWLIST, maxLines = MAX_CHANGED_LINES, pin = true } = {}) {
  const errors = [];
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    return { ok: false, errors: [`max lines must be a positive integer, got ${maxLines}`], files: [], changedLines: 0 };
  }
  const files = [];
  let changed = 0;
  const allowed = new Set(allow);
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) errors.push('patch is empty');

  const safePath = (p) => /^[A-Za-z0-9._\/-]+$/.test(p) && !p.split('/').some((s) => s === '' || s === '.' || s === '..');
  let i = 0;
  while (i < lines.length) {
    const head = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i]);
    if (!head) { errors.push(`line ${i + 1}: expected a "diff --git" header`); break; }
    const [, aPath, bPath] = head;
    const file = { path: bPath, isNew: false, added: 0, removed: 0, addedLines: [], removedLines: [] };
    i++;
    if (aPath !== bPath) errors.push(`${bPath}: rename or copy (${aPath} -> ${bPath})`);
    if (!safePath(bPath)) errors.push(`${bPath}: unsafe path`);
    if (!allowed.has(bPath)) errors.push(`${bPath}: not on the allowlist`);
    if (files.some((f) => f.path === bPath)) errors.push(`${bPath}: appears twice`);

    // Extended headers up to the --- line.
    let sawMinus = false;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const l = lines[i];
      if (/^new file mode 100644$/.test(l)) file.isNew = true;
      else if (/^index [0-9a-f]+\.\.[0-9a-f]+( 100644)?$/.test(l)) { /* ok */ }
      else if (l === `--- a/${bPath}` && !file.isNew) sawMinus = true;
      else if (l === '--- /dev/null' && file.isNew) sawMinus = true;
      else if (l === `+++ b/${bPath}` && sawMinus) { i++; break; }
      else { errors.push(`${bPath}: disallowed header "${l.slice(0, 80)}"`); i++; continue; }
      i++;
    }
    if (!sawMinus) errors.push(`${bPath}: no text diff (binary, mode-only or empty change)`);

    // Hunks, counted by their declared lengths, as git apply itself reads them.
    let hunks = 0;
    while (i < lines.length && lines[i].startsWith('@@')) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
      if (!h) { errors.push(`${bPath}: malformed hunk header`); i++; break; }
      let oldLeft = h[2] === undefined ? 1 : Number(h[2]);
      let newLeft = h[4] === undefined ? 1 : Number(h[4]);
      hunks++; i++;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith('\\'))) {
        const l = lines[i];
        if (l.startsWith('\\')) { i++; continue; }
        const c = l[0];
        if (c === ' ') { oldLeft--; newLeft--; }
        else if (c === '-') { oldLeft--; file.removed++; file.removedLines.push(l.slice(1)); }
        else if (c === '+') { newLeft--; file.added++; file.addedLines.push(l.slice(1)); }
        else { errors.push(`${bPath}: unexpected line inside hunk`); break; }
        i++;
      }
      if (oldLeft !== 0 || newLeft !== 0) errors.push(`${bPath}: hunk length does not match its header`);
    }
    if (hunks === 0) errors.push(`${bPath}: no hunks`);
    changed += file.added + file.removed;
    if (pin) pinContent(file, errors);
    files.push(file);
  }
  if (changed > maxLines) errors.push(`${changed} changed lines, limit is ${maxLines}`);
  return { ok: errors.length === 0, errors, files: files.map((f) => f.path), changedLines: changed };
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// `expected` is a 64-char hex digest or the text of a .sha256 file ("<hex>  name").
export function verifySha256(buf, expected) {
  const m = /^\s*([0-9a-fA-F]{64})\b/.exec(expected);
  return m !== null && m[1].toLowerCase() === sha256Hex(buf);
}

// ---------------------------------------------------------------- git helpers

function git(cwd, args, { env, input } = {}) {
  return execFileSync('git', args, {
    cwd, input, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
const gitText = (cwd, args, opt) => git(cwd, args, opt).toString('utf8').trim();

function parseSemver(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const cmpSemver = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// ---------------------------------------------------------------- generate

// Cleans a Steam news title into one plain-ASCII line of player-facing text
// (the notes file is read by tools with different default encodings).
export function cleanTitle(title) {
  return String(title ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function notesLine(cl, title) {
  const t = cleanTitle(title);
  return t === '' ? `Supports game build CL-${cl}` : `Supports game build CL-${cl} (${t})`;
}

// Swaps the CL in the one line that holds it. Operates on latin1 so every other byte survives.
export function replaceCl(source, newCl) {
  const re = /^(static\s+constexpr\s+wchar_t\s+kRequiredVersionSuffix\[\]\s*=\s*L")CL-(\d+)(";)/gm;
  const hits = [...source.matchAll(re)];
  if (hits.length !== 1) throw new Error(`expected exactly one kRequiredVersionSuffix line in ${CL_FILE}, found ${hits.length}`);
  const oldCl = hits[0][2];
  if (Number(newCl) <= Number(oldCl)) throw new Error(`CL-${newCl} is not newer than the source's CL-${oldCl}`);
  return { text: source.replace(re, `$1CL-${newCl}$3`), oldCl };
}

export function generate({ repo, cl, title, outDir, latest, base }) {
  if (!/^[1-9][0-9]{0,8}$/.test(String(cl))) throw new Error('--cl must be 1-9 digits with no leading zero');
  cl = String(cl);
  const top = gitText(repo, ['rev-parse', '--show-toplevel']);
  const head = gitText(top, ['rev-parse', 'HEAD']);
  if (base !== undefined && (base === '' || !head.startsWith(base))) throw new Error(`checkout is at ${head}, expected ${base}`);
  if (gitText(top, ['status', '--porcelain']) !== '') throw new Error('checkout is not clean');

  const blob = (p) => git(top, ['cat-file', 'blob', `HEAD:${p}`]).toString('latin1');
  const has = (p) => { try { git(top, ['cat-file', '-e', `HEAD:${p}`]); return true; } catch { return false; } };

  const { text: newSource, oldCl } = replaceCl(blob(CL_FILE), cl);

  // Next patch version: one above the newest of the latest release tag and any version file.
  let top_ = latest ? parseSemver(latest) : null;
  if (latest && !top_) throw new Error(`--latest "${latest}" is not x.y.z`);
  if (!latest) {
    for (const t of gitText(top, ['tag', '-l', 'v*']).split('\n')) {
      const v = parseSemver(t);
      if (v && (!top_ || cmpSemver(v, top_) > 0)) top_ = v;
    }
  }
  if (has(VERSION_FILE)) {
    const v = parseSemver(blob(VERSION_FILE));
    if (v && (!top_ || cmpSemver(v, top_) > 0)) top_ = v;
  }
  if (!top_) throw new Error('no release tag or version file to bump from; pass --latest x.y.z');
  const version = `${top_[0]}.${top_[1]}.${top_[2] + 1}`;

  // Keep the notes file's own line ending (the repo stores LF).
  const oldNotes = has(NOTES_FILE) ? blob(NOTES_FILE) : '';
  const eol = oldNotes.includes('\r\n') ? '\r\n' : '\n';
  const edits = [
    { path: CL_FILE, data: Buffer.from(newSource, 'latin1') },
    { path: VERSION_FILE, data: Buffer.from(`${version}\n`) },
    { path: NOTES_FILE, data: Buffer.from(notesLine(cl, title) + eol) },
  ];

  const tmp = mkdtempSync(join(tmpdir(), 'path-a-'));
  try {
    const gitDir = resolve(top, gitText(top, ['rev-parse', '--git-common-dir']));
    mkdirSync(join(tmp, 'objects'));
    const env = {
      GIT_INDEX_FILE: join(tmp, 'index'),
      GIT_OBJECT_DIRECTORY: join(tmp, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDir, 'objects'),
    };
    git(top, ['read-tree', 'HEAD'], { env });
    for (const e of edits) {
      const mode = (() => {
        const l = gitText(top, ['ls-tree', 'HEAD', '--', e.path]);
        return l ? l.split(/\s/)[0] : '100644';
      })();
      const oid = gitText(top, ['hash-object', '-w', '--no-filters', '--stdin'], { env, input: e.data });
      git(top, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${e.path}`], { env });
    }
    const patch = git(top, ['-c', 'core.quotepath=false', 'diff', '--cached', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '-U3', 'HEAD'], { env });

    const policy = checkPatch(patch.toString('latin1'));
    if (!policy.ok) throw new Error(`G0 diff policy rejected the generated patch:\n  ${policy.errors.join('\n  ')}`);

    // Prove it applies to HEAD, using a fresh index so the checkout stays untouched.
    git(top, ['read-tree', 'HEAD'], { env });
    git(top, ['apply', '--check', '--cached', '-'], { env, input: patch });

    mkdirSync(outDir, { recursive: true });
    const patchFile = join(outDir, 'ModLoader.patch');
    writeFileSync(patchFile, patch);
    const digest = sha256Hex(patch);
    writeFileSync(`${patchFile}.sha256`, `${digest}  ModLoader.patch\n`);
    return { patch: patchFile, sha256: digest, cl, previousCl: oldCl, version, base: head, files: policy.files, changedLines: policy.changedLines, notes: notesLine(cl, title) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const a = { allow: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k.startsWith('--') || i + 1 >= argv.length) throw new Error(`bad argument: ${k}`);
    if (k === '--allow') a.allow.push(argv[i + 1]);
    else a[k.slice(2)] = argv[i + 1];
  }
  return a;
}

function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`${e.message}\nusage: patch-path-a.mjs --repo <dir> --cl <n> --title <text> [--out dir] [--latest x.y.z] [--base sha]\n       patch-path-a.mjs --check <patch> [--sha256 hex|file] [--max-lines n] [--allow path]...`);
    process.exit(2);
  }
  try {
    if (a.check) {
      const buf = readFileSync(a.check);
      const errors = [];
      if (a.sha256 !== undefined) {
        const expected = /^\s*[0-9a-fA-F]{64}\b/.test(a.sha256) || !existsSync(a.sha256) ? a.sha256 : readFileSync(a.sha256, 'utf8');
        if (!verifySha256(buf, expected)) errors.push('sha256 does not match');
      }
      let maxLines = MAX_CHANGED_LINES;
      if (a['max-lines'] !== undefined) {
        if (!/^[1-9][0-9]*$/.test(a['max-lines'])) { console.error('--max-lines must be a positive integer'); process.exit(2); }
        maxLines = Number(a['max-lines']);
      }
      const r = checkPatch(buf.toString('latin1'), { allow: a.allow.length ? a.allow : PATH_A_ALLOWLIST, maxLines });
      errors.push(...r.errors);
      console.log(JSON.stringify({ ok: errors.length === 0, errors, files: r.files, changedLines: r.changedLines }, null, 2));
      process.exit(errors.length === 0 ? 0 : 1);
    }
    if (!a.repo || !a.cl) throw new Error('--repo and --cl are required');
    const r = generate({ repo: a.repo, cl: a.cl, title: a.title, outDir: a.out || 'patches', latest: a.latest, base: a.base });
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error(`patch-path-a: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
