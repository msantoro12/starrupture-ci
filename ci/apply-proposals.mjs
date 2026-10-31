#!/usr/bin/env node
// Applies sr-aobscan --suggest proposals to a plugin's source, at each
// pattern's registration site, so the client check can build the result and
// scan it again on both builds.
//
//   node ci/apply-proposals.mjs select --scan plugin-X.json --min-confidence high --target-public false > plan.json
//   node ci/apply-proposals.mjs apply  --source <checkout> --plan plan.json [--dry-run] > applied.json
//   node ci/apply-proposals.mjs message --applied applied.json --cl 128786 [--reference-cl 127004]
//
// select picks, per failing recorded row, the proposal that is safe for the
// build players have now:
//   replace  the proposal is unique on both builds, or the checked build is
//            the public one (no other build to keep working);
//   add      it is unique on the new build only and the public build still
//            resolves the current pattern: the site becomes a pattern list,
//            current pattern first (FunctionPattern, BetterCheats style).
// Anything else is skipped with the reason.
//
// apply edits only the string literals (and, for a list or a call-site
// follow, the declaration that holds them) of the rows it applies. A row is
// skipped rather than guessed at when its pattern is not exactly one literal
// sequence in the source, or the site cannot express the change.
// Deterministic: the same source and plan give the same bytes, which is what
// lets the push job re-create and compare the tree that was built and scanned.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const PATTERN_RX = /^(?:[0-9A-F]{2}|\?\?)(?: (?:[0-9A-F]{2}|\?\?))*$/;
const RANK = { low: 1, medium: 2, high: 3 };
const SOURCE_EXT = /\.(?:h|hh|hpp|hxx|inl|ipp|c|cc|cpp|cxx)$/i;
const SKIP_DIRS = new Set(['.git', 'build', 'bin', 'obj', 'x64', '.vs', 'packages', 'node_modules']);
const NUM = '(-?(?:0[xX][0-9A-Fa-f]+|\\d+))';

export function isPattern(s) {
  return typeof s === 'string' && PATTERN_RX.test(s);
}

function follow(v) {
  return Number.isInteger(v) && v >= 0 ? v : -1;
}

// ---- select ----------------------------------------------------------------

export function selectRows(scan, { minConfidence = 'high', targetPublic = false } = {}) {
  if (!RANK[minConfidence]) throw new Error(`bad --min-confidence ${minConfidence}`);
  const hasReference = !!(scan.suggest && scan.suggest.reference && scan.suggest.reference !== 'none');
  const rows = [];
  const skipped = [];
  for (const row of scan.patterns || []) {
    if (!row.recorded || row.result === 'OK' || !row.suggest) continue;
    const s = row.suggest;
    const base = { name: row.name, call: row.call, result: row.result, confidence: s.confidence || '', located: s.located || '' };
    const skip = (reason) => skipped.push({ ...base, status: 'skipped', reason });
    if ((RANK[s.confidence] || 0) < RANK[minConfidence]) { skip(`confidence ${s.confidence || 'none'} is below ${minConfidence}`); continue; }
    if ((row.resultOffset || 0) !== 0) { skip('the request has a resultOffset; not supported'); continue; }
    if (!isPattern(row.pattern)) { skip('the current pattern is not a plain AOB string'); continue; }
    const props = (s.proposals || []).filter((q) => isPattern(q.pattern) && (q.resultOffset || 0) === 0 && q.uniqueOnTarget);
    let pick = null;
    let category = '';
    let why = '';
    if ((pick = props.find((q) => q.uniqueOnReference === true))) {
      category = 'replace'; why = 'unique on both builds';
    } else if (!hasReference && targetPublic && (pick = props[0])) {
      category = 'replace'; why = 'the checked build is the public one';
    } else if (hasReference && s.referenceKeepsCurrent === true && (pick = props[0])) {
      category = 'add'; why = 'unique on the new build; the public build keeps the current pattern';
    }
    if (!pick) {
      skip(!props.length ? 'no proposal is unique on the checked build'
        : !hasReference ? 'no public build to check the proposal against'
        : 'no proposal keeps the public build working');
      continue;
    }
    rows.push({
      ...base,
      category,
      why,
      old: { pattern: row.pattern, followRel32At: follow(row.followRel32At) },
      new: { pattern: pick.pattern, followRel32At: follow(pick.followRel32At) },
      rva: s.rva || '',
      referenceRva: s.referenceRva || '',
    });
  }
  return { schema: 1, minConfidence, targetPublic, hasReference, rows, skipped };
}

// ---- lexing ----------------------------------------------------------------

// Every run of adjacent string literals (whitespace and comments between them
// are allowed, as in C++), with its span and concatenated value.
export function lexLiterals(text) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"') {
      const prev = text[i - 1] || '';
      if (prev === 'R' && !/[A-Za-z0-9_]/.test(text[i - 2] || '')) {
        // Raw string: never a pattern site, skip it whole.
        const open = text.indexOf('(', i);
        const delim = open < 0 ? '' : text.slice(i + 1, open);
        const e = open < 0 ? -1 : text.indexOf(')' + delim + '"', open);
        flush();
        i = e < 0 ? n : e + delim.length + 2;
        continue;
      }
      let j = i + 1;
      let val = '';
      while (j < n && text[j] !== '"' && text[j] !== '\n') {
        if (text[j] === '\\') { val += text.slice(j, j + 2); j += 2; continue; }
        val += text[j]; j++;
      }
      const end = j + 1;
      if (!cur) cur = { start: i, end, value: '', parts: 0 };
      cur.value += val; cur.end = end; cur.parts++;
      i = end;
      continue;
    }
    if (c === "'") {
      flush();
      if (/[0-9A-Fa-f]/.test(text[i - 1] || '')) { i++; continue; } // digit separator
      let j = i + 1;
      while (j < n && text[j] !== "'" && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
      i = j + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    flush();
    i++;
  }
  flush();
  return out;
}

// ---- sites -----------------------------------------------------------------

function lineStart(text, at) {
  return text.lastIndexOf('\n', at - 1) + 1;
}

function parseNum(s) {
  return /^-?0[xX]/.test(s) ? parseInt(s, 16) : parseInt(s, 10);
}

// constexpr FunctionPattern NAME[] = { { "..." }, { "...", N }, };
function findLists(text) {
  const lists = [];
  const rx = /^([ \t]*)((?:(?:static|inline)\s+)*constexpr\s+FunctionPattern\s+([A-Za-z_]\w*)\s*\[\s*\]\s*=\s*)\{/gm;
  let m;
  while ((m = rx.exec(text))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let j = open;
    let close = -1;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (ch === '"') { const e = text.indexOf('"', j + 1); j = e < 0 ? text.length : e; continue; }
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { close = j; break; }
    }
    if (close < 0) continue;
    const semi = /^\s*;/.exec(text.slice(close + 1));
    if (!semi) continue;
    const body = text.slice(open + 1, close);
    const elements = [];
    const erx = new RegExp(`\\{\\s*((?:"[^"\\n]*"\\s*)+)(?:,\\s*${NUM}\\s*)?\\}`, 'g');
    let e;
    while ((e = erx.exec(body))) {
      const lits = lexLiterals(e[1]);
      elements.push({
        pattern: lits.map((l) => l.value).join(''),
        followRel32At: e[2] === undefined ? -1 : follow(parseNum(e[2])),
        start: open + 1 + e.index,
        end: open + 1 + e.index + e[0].length,
      });
    }
    lists.push({
      indent: m[1],
      qualifiers: m[2].replace(/FunctionPattern[\s\S]*$/, '').replace(/\s+/g, ' '),
      name: m[3],
      declStart: m.index + m[1].length,
      declEnd: close + 1 + semi[0].length,
      bodyStart: open,
      bodyEnd: close,
      elements,
    });
  }
  return lists;
}

export function classifySite(text, lit) {
  for (const list of findLists(text)) {
    if (lit.start > list.bodyStart && lit.end <= list.bodyEnd) {
      const el = list.elements.find((x) => lit.start >= x.start && lit.end <= x.end);
      if (!el) return { form: 'other', followRel32At: -1 };
      return { form: 'list', list, element: el, followRel32At: el.followRel32At };
    }
  }
  const before = text.slice(Math.max(0, lit.start - 400), lit.start);
  const after = text.slice(lit.end);
  const endsStatement = /^\s*;/.exec(after);
  const decl = /(?:^|\n)([ \t]*)((?:(?:static|inline)\s+)*constexpr\s+const\s+char\s*\*\s*(?:const\s+)?)([A-Za-z_]\w*)\s*=\s*$/.exec(before);
  if (decl && endsStatement) {
    const declStart = lit.start - before.length + decl.index + (decl[0].startsWith('\n') ? 1 : 0) + decl[1].length;
    return {
      form: 'declaration',
      indent: decl[1],
      qualifiers: decl[2].replace(/const\s+char[\s\S]*$/, '').replace(/\s+/g, ' '),
      name: decl[3],
      declStart,
      declEnd: lit.end + endsStatement[0].length,
      followRel32At: -1,
    };
  }
  const member = /(?:^|\n)[ \t]*([A-Za-z_]\w*)\.pattern\s*=\s*$/.exec(before);
  if (member && endsStatement) {
    const v = member[1];
    const call = after.search(new RegExp(`Resolve\\s*\\([^;]*&\\s*${v}\\b`));
    const window = call < 0 ? after.slice(0, 1500) : after.slice(0, call);
    const flagsFollow = new RegExp(`\\b${v}\\.flags\\s*[|]?=[^;]*PLUGIN_SCAN_FLAG_FOLLOW_REL32`).test(window);
    const f = new RegExp(`\\b${v}\\.followRel32At\\s*=\\s*${NUM}\\s*;`).exec(window);
    const followAt = f ? lit.end + f.index + f[0].indexOf(f[1]) : -1;
    return {
      form: 'request',
      variable: v,
      followRel32At: flagsFollow && f ? follow(parseNum(f[1])) : -1,
      followSpan: f ? { start: followAt, end: followAt + f[1].length, text: f[1] } : null,
    };
  }
  return { form: 'other', followRel32At: -1 };
}

function listSource({ indent, qualifiers, name, elements, eol }) {
  const unit = indent.includes(' ') && !indent.includes('\t') ? '    ' : '\t';
  const lines = [`${qualifiers.trim()} FunctionPattern ${name}[] = {`];
  for (const e of elements) {
    lines.push(`${indent}${unit}{ "${e.pattern}"${e.followRel32At >= 0 ? `, ${e.followRel32At}` : ''} },`);
  }
  lines.push(`${indent}};`);
  return lines.join(eol);
}

function formatLike(original, value) {
  if (/^0[xX]/.test(original)) {
    const digits = original.length - 2;
    const hex = value.toString(16).toUpperCase().padStart(digits, '0');
    return original.slice(0, 2) + (original.slice(2) === original.slice(2).toLowerCase() && /[a-f]/.test(original) ? hex.toLowerCase() : hex);
  }
  return String(value);
}

// One edit for one row at one site, or a reason it cannot be made.
function planEdit(text, lit, site, row, { hasFunctionPattern, eol }) {
  if (site.followRel32At !== row.old.followRel32At) {
    return { reason: `the site follows rel32 at ${site.followRel32At}, the scan recorded ${row.old.followRel32At}` };
  }
  const sameFollow = row.new.followRel32At === row.old.followRel32At;
  const literal = { start: lit.start, end: lit.end, text: `"${row.new.pattern}"` };
  if (row.category === 'replace') {
    if (site.form === 'list') {
      return { edits: [{ start: site.list.declStart, end: site.list.declEnd,
        text: listSource({ ...site.list, elements: [row.new], eol }) }] };
    }
    if (sameFollow) return { edits: [literal] };
    if (site.form === 'declaration') {
      if (!hasFunctionPattern) return { reason: 'the new pattern follows a call, and the source has no FunctionPattern to declare that' };
      return { edits: [{ start: site.declStart, end: site.declEnd,
        text: listSource({ ...site, elements: [row.new], eol }) }] };
    }
    if (site.form === 'request' && site.followSpan && row.old.followRel32At >= 0 && row.new.followRel32At >= 0) {
      return { edits: [literal, { start: site.followSpan.start, end: site.followSpan.end,
        text: formatLike(site.followSpan.text, row.new.followRel32At) }] };
    }
    return { reason: 'the follow offset changes and this site cannot express it' };
  }
  // add: keep the current pattern first, then the new one.
  if (site.form === 'list') {
    return { edits: [{ start: site.list.declStart, end: site.list.declEnd,
      text: listSource({ ...site.list, elements: [site.element, row.new], eol }) }] };
  }
  if (site.form === 'declaration') {
    if (!hasFunctionPattern) return { reason: 'a second pattern for the new build needs a FunctionPattern list, which the source does not have' };
    return { edits: [{ start: site.declStart, end: site.declEnd,
      text: listSource({ ...site, elements: [row.old, row.new], eol }) }] };
  }
  return { reason: 'a second pattern for the new build needs a pattern list at this site' };
}

export function listSources(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name.toLowerCase())) walk(p); }
      else if (SOURCE_EXT.test(name)) files.push(p);
    }
  };
  walk(dir);
  return files;
}

// files: Map of relative path -> text. Returns the new texts and per-row status.
export function applyPlan(files, plan) {
  const hasFunctionPattern = [...files.values()].some((t) => /\bstruct\s+FunctionPattern\b/.test(t));
  const lexed = new Map([...files].map(([f, t]) => [f, lexLiterals(t)]));
  const results = [];
  const bySite = new Map();
  for (const row of plan.rows || []) {
    const r = { ...row };
    results.push(r);
    if (!isPattern(row.old?.pattern) || !isPattern(row.new?.pattern) || !['replace', 'add'].includes(row.category)) {
      Object.assign(r, { status: 'skipped', reason: 'malformed plan row' });
      continue;
    }
    const hits = [];
    for (const [f, lits] of lexed) for (const l of lits) if (l.value === row.old.pattern) hits.push({ file: f, lit: l });
    if (hits.length !== 1) {
      Object.assign(r, { status: 'skipped', reason: hits.length ? `the pattern appears ${hits.length} times in the source` : 'the pattern is not in the source' });
      continue;
    }
    const { file, lit } = hits[0];
    const text = files.get(file);
    const site = classifySite(text, lit);
    const key = `${file}@${site.form === 'list' ? site.list.declStart : site.declStart ?? lit.start}`;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const plan1 = planEdit(text, lit, site, row, { hasFunctionPattern, eol });
    Object.assign(r, { file: file.split(sep).join('/'), line: text.slice(0, lit.start).split('\n').length, site: site.form });
    if (plan1.reason) { Object.assign(r, { status: 'skipped', reason: plan1.reason }); continue; }
    if (bySite.has(key)) {
      Object.assign(r, { status: 'skipped', reason: 'another row changes the same declaration' });
      const other = bySite.get(key);
      Object.assign(other.result, { status: 'skipped', reason: 'another row changes the same declaration' });
      other.edits = [];
      continue;
    }
    r.status = 'applied';
    bySite.set(key, { result: r, file, edits: plan1.edits });
  }
  const out = new Map();
  for (const [file, text] of files) {
    const edits = [...bySite.values()].filter((s) => s.file === file && s.result.status === 'applied').flatMap((s) => s.edits)
      .sort((a, b) => b.start - a.start);
    if (!edits.length) continue;
    for (let k = 1; k < edits.length; k++) if (edits[k].end > edits[k - 1].start) throw new Error(`overlapping edits in ${file}`);
    let t = text;
    for (const e of edits) t = t.slice(0, e.start) + e.text + t.slice(e.end);
    out.set(file, t);
  }
  return { changed: out, rows: results };
}

// ---- commit message ----------------------------------------------------------

export function commitMessage(applied, { cl, referenceCl = '' }) {
  const rows = (applied.rows || []).filter((r) => r.status === 'applied');
  const lines = [`Update patterns for CL-${cl}`, ''];
  lines.push(referenceCl
    ? `Re-derived for client CL-${cl}. Built and scanned against CL-${cl} and the public client CL-${referenceCl}: each pattern resolves to the function it named before on both.`
    : `Re-derived for client CL-${cl}, the public client. Built and scanned against it: each pattern resolves to the function it named before.`);
  for (const r of rows) {
    lines.push('', r.name);
    lines.push(r.category === 'replace'
      ? `  Replaced (${r.why}). Confidence ${r.confidence}.`
      : `  Added as a second pattern (${r.why}). Confidence ${r.confidence}.`);
    if (r.category === 'replace') lines.push(`  was ${r.old.pattern}${r.old.followRel32At >= 0 ? ` (call at +${r.old.followRel32At})` : ''}`);
    lines.push(`  ${r.category === 'replace' ? 'now' : 'new'} ${r.new.pattern}${r.new.followRel32At >= 0 ? ` (call at +${r.new.followRel32At})` : ''}`);
  }
  return lines.join('\n') + '\n';
}

// ---- CLI -------------------------------------------------------------------

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (k === 'dry-run') { o[k] = true; continue; }
    o[k] = argv[++i];
  }
  return o;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const o = args(rest);
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
  if (cmd === 'select') {
    const plan = selectRows(readJson(o.scan), { minConfidence: o['min-confidence'] || 'high', targetPublic: o['target-public'] === 'true' });
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return 0;
  }
  if (cmd === 'apply') {
    const plan = readJson(o.plan);
    const files = new Map(listSources(o.source).map((p) => [relative(o.source, p), readFileSync(p, 'utf8')]));
    const { changed, rows } = applyPlan(files, plan);
    if (!o['dry-run']) for (const [f, t] of changed) writeFileSync(join(o.source, f), t, 'utf8');
    process.stdout.write(JSON.stringify({ ...plan, rows, changed: [...changed.keys()].map((f) => f.split(sep).join('/')).sort() }, null, 2) + '\n');
    return 0;
  }
  if (cmd === 'message') {
    process.stdout.write(commitMessage(readJson(o.applied), { cl: o.cl, referenceCl: o['reference-cl'] || '' }));
    return 0;
  }
  process.stderr.write('usage: apply-proposals.mjs select|apply|message ...\n');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
