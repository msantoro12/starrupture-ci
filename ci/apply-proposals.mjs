#!/usr/bin/env node
// Applies sr-aobscan --suggest proposals to a plugin's source, at each
// pattern's registration site, so the client check can build the result and
// scan it again on both builds.
//
//   node ci/apply-proposals.mjs offsets --native ci/native-keys.txt --plugin X --source <checkout> --target layout-target.json [--reference layout-reference.json] [--target-public true] > offsets.json
//   node ci/apply-proposals.mjs select --scan plugin-X.json [--offsets offsets.json] --min-confidence high --target-public false > plan.json
//   node ci/apply-proposals.mjs apply  --source <checkout> --plan plan.json [--dry-run] > applied.json
//   node ci/apply-proposals.mjs verdict --applied applied.json --target scan.json [--reference scan.json] [--offsets-after offsets.json]
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
// offsets is the same idea for the numbers a plugin reads at a fixed offset
// (see "fixed offsets in the source" below): it compares each with the PDB of
// the checked build and, where one new constant is right for every build that
// matters, plans the rewrite that apply carries out.
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
  const hasReference = !!(scan.suggest && scan.suggest.reference && scan.suggest.reference === 'mapped');
  const rows = [];
  const skipped = [];
  for (const row of scan.patterns || []) {
    if (!row.recorded || row.result === 'OK') continue;
    if (!row.suggest) { skipped.push({ name: row.name, call: row.call, result: row.result, status: 'skipped', reason: 'no proposal' }); continue; }
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

// The follow offset a scan request variable carries, read from the statements
// after its pattern is assigned (up to the Resolve call that takes it).
// after is the text from the end of the pattern expression, base its index.
function requestFollow(after, v, base) {
  const call = after.search(new RegExp(`Resolve\\s*\\([^;]*&\\s*${v}\\b`));
  const window = call < 0 ? after.slice(0, 1500) : after.slice(0, call);
  const flagsFollow = new RegExp(`\\b${v}\\.flags\\s*[|]?=[^;]*PLUGIN_SCAN_FLAG_FOLLOW_REL32`).test(window);
  const f = new RegExp(`\\b${v}\\.followRel32At\\s*=\\s*${NUM}\\s*;`).exec(window);
  const at = f ? base + f.index + f[0].indexOf(f[1]) : -1;
  return {
    follow: flagsFollow && f ? follow(parseNum(f[1])) : -1,
    span: f ? { start: at, end: at + f[1].length, text: f[1] } : null,
  };
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
  const decl = /(?:^|\n)([ \t]*)((?:(?:static|inline|constexpr)\s+)*const\s+char\s*\*\s*(?:const\s+)?)([A-Za-z_]\w*)\s*=\s*$/.exec(before);
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
    const rf = requestFollow(after, member[1], lit.end);
    return { form: 'request', variable: member[1], followRel32At: rf.follow, followSpan: rf.span };
  }
  return { form: 'other', followRel32At: -1 };
}

// ---- where the follow offset lives when the pattern's own site does not say ----
//
// A pattern is often declared once, as a named constant, and handed to a
// request elsewhere: `req.pattern = NS::NAME;` with the follow offset set a few
// statements on, or `ResolveCalleeOf(self, scanner, "hook", NAME, CALL_OFFSET)`
// where a helper builds the request. The follow offset is then in the use, not
// in the declaration. These functions read it from each use of the constant, so
// a row whose scan recorded a follow offset can be matched to the use that
// carries it, and the offset edited in place when the new pattern needs another.
// A use that is not one of these two shapes is ignored (never guessed at).

function splitArgs(text, open) {
  // Arguments of the call whose '(' is at open: [{ start, end }] trimmed; end is the index of the ')'.
  const args = [];
  let depth = 0;
  let start = open + 1;
  const push = (end) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    args.push({ start: s, end: e });
  };
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { i++; while (i < text.length && text[i] !== '"' && text[i] !== '\n') { if (text[i] === '\\') i++; i++; } continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { push(i); return { args, close: i }; }
      depth--;
    } else if (c === ',' && depth === 0) { push(i); start = i + 1; }
    else if (c === ';' && depth === 0) return null;
  }
  return null;
}

function enclosingCall(text, start, end) {
  let depth = 0;
  for (let i = start - 1; i >= Math.max(0, start - 800); i--) {
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) {
        if (c !== '(') return null;
        const name = /([A-Za-z_]\w*)\s*$/.exec(text.slice(Math.max(0, i - 120), i));
        const parsed = name && splitArgs(text, i);
        if (!parsed) return null;
        const index = parsed.args.findIndex((a) => a.start === start && a.end === end);
        return index < 0 ? null : { fn: name[1], args: parsed.args, index, open: i };
      }
      depth--;
    } else if (c === ';' && depth === 0) return null;
  }
  return null;
}

function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { i++; while (i < text.length && text[i] !== '"' && text[i] !== '\n') { if (text[i] === '\\') i++; i++; } continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// The definition of a helper: its parameter names and the body that fills the request.
function findHelper(files, fn) {
  const rx = new RegExp(`(?:^|[\\s*&>])${fn}\\s*\\(([^;{}()]*)\\)\\s*(?:const\\s*)?\\{`, 'g');
  for (const [file, text] of files) {
    let m;
    while ((m = rx.exec(text))) {
      const open = m.index + m[0].length - 1;
      const close = matchBrace(text, open);
      if (close < 0) continue;
      const params = m[1].split(',').map((p) => (/([A-Za-z_]\w*)\s*(?:=.*)?$/.exec(p.trim()) || [])[1] || '');
      return { file, params, body: text.slice(open + 1, close), bodyStart: open + 1 };
    }
  }
  return null;
}

// The number a call argument stands for, with the span to edit: a literal, or a
// named constant declared once as `NAME = <number>;`, through a cast or not.
function numberOf(files, file, text, arg) {
  let s = arg.start;
  let e = arg.end;
  const cast = /^static_cast<[^>]*>\(\s*/.exec(text.slice(s, e));
  if (cast && text[e - 1] === ')') { s += cast[0].length; e--; while (e > s && /\s/.test(text[e - 1])) e--; }
  const body = text.slice(s, e);
  if (new RegExp(`^${NUM}$`).test(body)) return { file, span: { start: s, end: e, text: body } };
  const id = /^(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)$/.exec(body);
  if (!id) return null;
  const decl = new RegExp(`\\b${id[1]}\\s*=\\s*${NUM}\\s*;`, 'g');
  const found = [];
  for (const [f, t] of files) {
    let m;
    while ((m = decl.exec(t))) found.push({ file: f, span: { start: m.index + m[0].indexOf(m[1]), end: m.index + m[0].indexOf(m[1]) + m[1].length, text: m[1] } });
  }
  return found.length === 1 ? found[0] : null;
}

// The use whose pattern expression is text[start, end): { follow, span, file } or null.
function traceUse(files, file, text, start, end) {
  const before = text.slice(Math.max(0, start - 400), start);
  const after = text.slice(end);
  const member = /(?:^|\n)[ \t]*([A-Za-z_]\w*)\.pattern\s*=\s*$/.exec(before);
  if (member && /^\s*;/.test(after)) {
    const rf = requestFollow(after, member[1], end);
    return { follow: rf.follow, span: rf.span && { ...rf.span, file }, how: 'request' };
  }
  const call = enclosingCall(text, start, end);
  if (!call) return null;
  const helper = findHelper(files, call.fn);
  if (!helper || helper.params.length !== call.args.length) return null;
  const patternParam = /\.pattern\s*=\s*([A-Za-z_]\w*)\s*;/.exec(helper.body);
  if (!patternParam || helper.params.indexOf(patternParam[1]) !== call.index) return null;
  const followAssign = new RegExp(`\\.followRel32At\\s*=\\s*(?:static_cast<[^>]*>\\(\\s*)?([A-Za-z_]\\w*|${NUM})\\s*\\)?\\s*;`).exec(helper.body);
  if (!followAssign || !/FOLLOW_REL32/.test(helper.body)) return { follow: -1, span: null, how: 'call' };
  const j = helper.params.indexOf(followAssign[1]);
  if (j >= 0) {
    const n = numberOf(files, file, text, call.args[j]);
    return n && { follow: follow(parseNum(n.span.text)), span: { ...n.span, file: n.file }, how: 'call' };
  }
  if (new RegExp(`^${NUM}$`).test(followAssign[1])) {
    const at = helper.bodyStart + followAssign.index + followAssign[0].indexOf(followAssign[1]);
    return { follow: follow(parseNum(followAssign[1])), span: { start: at, end: at + followAssign[1].length, text: followAssign[1], file: helper.file }, how: 'call' };
  }
  return null;
}

// Every understood use of the named pattern constant declared at decl.
function traceUses(files, name, decl) {
  const uses = [];
  const rx = new RegExp(`(?:\\b[A-Za-z_]\\w*::)*\\b${name}\\b`, 'g');
  for (const [file, text] of files) {
    let m;
    while ((m = rx.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (file === decl.file && start >= decl.declStart && end <= decl.declEnd) continue;
      if (text.slice(lineStart(text, start), start).includes('//')) continue;
      const u = traceUse(files, file, text, start, end);
      if (u) uses.push(u);
    }
  }
  return uses;
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

// The follow offsets a site carries when they are not in the pattern's own
// literal: a request's followRel32At, or the uses of a named pattern constant.
function attachTrace(files, file, text, lit, site, row) {
  if (site.form === 'request') { site.followSpans = site.followSpan ? [site.followSpan] : []; return; }
  if (site.form === 'list' || row.old.followRel32At < 0) return;
  const uses = site.form === 'declaration'
    ? traceUses(files, site.name, { file, declStart: site.declStart, declEnd: site.declEnd })
    : [traceUse(files, file, text, lit.start, lit.end)].filter(Boolean);
  const hit = uses.filter((u) => u.follow === row.old.followRel32At);
  if (!hit.length) return;
  site.followRel32At = row.old.followRel32At;
  site.traced = true;
  const spans = new Map();
  for (const u of hit) if (u.span) spans.set(`${u.span.file || file}:${u.span.start}`, u.span);
  site.followSpans = [...spans.values()];
}

// One edit for one row at one site, or a reason it cannot be made.
function planEdit(text, lit, site, row, { hasFunctionPattern, eol }) {
  if (site.followRel32At !== row.old.followRel32At) {
    return { reason: `the site follows rel32 at ${site.followRel32At}, the scan recorded ${row.old.followRel32At}` };
  }
  const sameFollow = row.new.followRel32At === row.old.followRel32At;
  const literal = { start: lit.start, end: lit.end, text: `"${row.new.pattern}"` };
  const spans = site.followSpans || [];
  if (row.category === 'replace') {
    if (site.form === 'list') {
      return { edits: [{ start: site.list.declStart, end: site.list.declEnd,
        text: listSource({ ...site.list, elements: [row.new], eol }) }] };
    }
    if (sameFollow) return { edits: [literal] };
    if (spans.length && row.old.followRel32At >= 0 && row.new.followRel32At >= 0) {
      return { edits: [literal, ...spans.map((sp) => ({ file: sp.file, start: sp.start, end: sp.end,
        text: formatLike(sp.text, row.new.followRel32At) }))] };
    }
    if (site.traced) return { reason: 'the follow offset changes and the request that uses this pattern cannot express it' };
    if (site.form === 'declaration') {
      if (!hasFunctionPattern) return { reason: 'the new pattern follows a call, and the source has no FunctionPattern to declare that' };
      if (!/constexpr/.test(site.qualifiers)) return { reason: 'the new pattern follows a call, and this declaration is not constexpr' };
      return { edits: [{ start: site.declStart, end: site.declEnd,
        text: listSource({ ...site, elements: [row.new], eol }) }] };
    }
    return { reason: 'the follow offset changes and this site cannot express it' };
  }
  // add: keep the current pattern first, then the new one.
  if (site.form === 'list') {
    return { edits: [{ start: site.list.declStart, end: site.list.declEnd,
      text: listSource({ ...site.list, elements: [site.element, row.new], eol }) }] };
  }
  if (site.traced) return { reason: 'a second pattern for the new build needs a pattern list, and this pattern is used through a request' };
  if (site.form === 'declaration') {
    if (!hasFunctionPattern) return { reason: 'a second pattern for the new build needs a FunctionPattern list, which the source does not have' };
    if (!/constexpr/.test(site.qualifiers)) return { reason: 'a second pattern for the new build needs a FunctionPattern list, and this declaration is not constexpr' };
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
    attachTrace(files, file, text, lit, site, row);
    const key = `${file}@${site.form === 'list' ? site.list.declStart : site.declStart ?? lit.start}`;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const plan1 = planEdit(text, lit, site, row, { hasFunctionPattern, eol });
    Object.assign(r, { file: file.split(sep).join('/'), line: text.slice(0, lit.start).split('\n').length, site: site.form });
    if (plan1.reason) { Object.assign(r, { status: 'skipped', reason: plan1.reason }); continue; }
    const edits = plan1.edits.map((e) => ({ ...e, file: e.file || file }));
    const have = bySite.get(key);
    if (have) {
      // Two rows for one declaration (a pattern that two hooks share) are both
      // applied when they make the very same edit; otherwise neither is.
      if (!have.conflict && JSON.stringify(have.edits) === JSON.stringify(edits)) { r.status = 'applied'; have.results.push(r); continue; }
      for (const x of have.results) Object.assign(x, { status: 'skipped', reason: 'another row changes the same declaration' });
      have.edits = [];
      have.conflict = true;
      Object.assign(r, { status: 'skipped', reason: 'another row changes the same declaration' });
      continue;
    }
    r.status = 'applied';
    bySite.set(key, { results: [r], edits });
  }
  const offsets = applyOffsets(files, plan.offsets || []);
  const perFile = new Map();
  const add = (e) => { if (!perFile.has(e.file)) perFile.set(e.file, []); perFile.get(e.file).push(e); };
  for (const s of bySite.values()) if (!s.conflict) s.edits.forEach(add);
  offsets.edits.forEach(add);
  const out = new Map();
  for (const [file, all] of perFile) {
    const seen = new Set();
    const edits = all.filter((e) => { const k = `${e.start}:${e.end}:${e.text}`; return seen.has(k) ? false : (seen.add(k), true); })
      .sort((a, b) => b.start - a.start);
    for (let k = 1; k < edits.length; k++) if (edits[k].end > edits[k - 1].start) throw new Error(`overlapping edits in ${file}`);
    let t = files.get(file);
    for (const e of edits) t = t.slice(0, e.start) + e.text + t.slice(e.end);
    out.set(file, t);
  }
  return { changed: out, rows: results, offsets: offsets.results };
}

// ---- fixed offsets in the source ---------------------------------------------
//
// Some game members have no name in the Game-SDK, so a plugin reads them at a
// raw offset (`kOff_WaitingDuration = 0x78`). ci/native-keys.txt lists each
// one, and sr-client-check reads it from the PDB of every build it checks.
// A line may also carry an anchor that finds the number in the plugin source:
//
//   <plugin> <Class::Member> <file-suffix>:<regex>
//
// In the regex `@` stands for the number (hex or decimal) and `~` for `\s*`;
// the rest is a JavaScript regular expression with no other capture group. The
// anchor must match, on the line(s) that hold the offset, nothing but that
// number. Without an anchor the member is only compared between builds.
//
//   ok         the source reads the offset the checked build has.
//   patch      it does not, and one new constant is right for every build that
//              matters (the checked build is the public one, or the public
//              build has the same offset): apply rewrites the number.
//   split      the builds disagree and the source matches the public one: a
//              single constant cannot serve both, so a person decides.
//   wrong      the source matches neither build.
//   changed    the member's size or bool mask differs between the builds.
//   missing    the member is gone from the checked build (renamed or removed).
//   unanchored the anchor matches nothing in the source: the check is stale.
//
// Every state but ok fails the plugin; only patch is fixed by apply.

const OFFSET_VALUE = '(0[xX][0-9A-Fa-f]+|\\d+)';

function compileAnchor(anchor) {
  const c = anchor.indexOf(':');
  const file = c < 0 ? '' : anchor.slice(0, c).trim();
  const pattern = c < 0 ? '' : anchor.slice(c + 1).trim();
  if (!file || !pattern) throw new Error(`anchor '${anchor}' is not <file-suffix>:<regex>`);
  if ((pattern.match(/@/g) || []).length !== 1) throw new Error(`anchor '${anchor}' needs exactly one @ for the number`);
  const src = pattern.replace('@', OFFSET_VALUE).replace(/~/g, '\\s*');
  if (new RegExp(`${src}|`).exec('').length !== 2) throw new Error(`anchor '${anchor}' has a capture group besides @`);
  return { file, rx: new RegExp(src, 'gd') };
}

export function parseNativeKeys(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(\S+)\s+(\S+::\S+)(?:\s+(\S.*))?$/.exec(line);
    if (!m) throw new Error(`native-keys.txt line ${i + 1}: malformed '${raw}'`);
    const e = { plugin: m[1], key: m[2] };
    if (m[3]) {
      try { e.compiled = compileAnchor(m[3]); } catch (err) { throw new Error(`native-keys.txt line ${i + 1}: ${err.message}`); }
      e.anchor = m[3].trim();
    }
    entries.push(e);
  });
  return entries;
}

// Every place the anchor finds a number: { file (as in files), path, start, end, text, value, line }.
export function anchorSites(files, compiled) {
  const sites = [];
  for (const [file, text] of files) {
    const path = file.split(/[\\/]/).join('/');
    if (path !== compiled.file && !path.endsWith(`/${compiled.file}`)) continue;
    const rx = new RegExp(compiled.rx.source, 'gd');
    let m;
    while ((m = rx.exec(text))) {
      const [start, end] = m.indices[1];
      sites.push({ file, path, start, end, text: m[1], value: parseNum(m[1]), line: text.slice(0, start).split('\n').length });
      if (m[0] === '') rx.lastIndex++;
    }
  }
  return sites;
}

function layoutMember(report, key) {
  const k = (report?.keys || []).find((x) => x.key === key);
  if (!k) return null;
  return k.result === 'OK' ? { result: 'OK', offset: k.offset, size: k.size, boolMask: k.boolMask } : { result: k.result };
}

// target and reference are `sr-aobscan --layout` reports of the checked build
// and the public build (null when the checked build is the public one).
export function checkOffsets(files, entries, { target, reference = null, targetPublic = false }) {
  const results = [];
  for (const e of entries.filter((x) => x.compiled)) {
    const base = { key: e.key, anchor: e.anchor };
    const sites = anchorSites(files, e.compiled);
    if (!sites.length) { results.push({ ...base, state: 'unanchored', reason: `the anchor matches nothing in ${e.compiled.file}` }); continue; }
    const t = layoutMember(target, e.key);
    const r = reference ? layoutMember(reference, e.key) : null;
    for (const s of sites) {
      const row = { ...base, file: s.path, line: s.line, source: s.value, target: t, reference: r };
      const set = (state, reason, to) => results.push({ ...row, state, ...(reason ? { reason } : {}), ...(to === undefined ? {} : { to }) });
      if (!t || t.result !== 'OK') { set('missing', `${e.key} is ${t ? t.result : 'not in the layout report'} on the checked build`); continue; }
      const refOk = r && r.result === 'OK';
      if (refOk && (r.size !== t.size || r.boolMask !== t.boolMask)) { set('changed', `size or bool mask differs between the builds (public ${r.size}/${r.boolMask}, checked ${t.size}/${t.boolMask})`); continue; }
      if (s.value === t.offset) { set('ok'); continue; }
      if (targetPublic) { set('patch', '', t.offset); continue; }
      if (!reference) { set('wrong', 'the source offset is not the checked build\'s, and there is no public build to check a patch against'); continue; }
      if (!refOk) { set('wrong', `${e.key} does not resolve on the public build, so a patch cannot be checked against it`); continue; }
      if (r.offset === t.offset) { set('patch', '', t.offset); continue; }
      if (s.value === r.offset) { set('split', `the offset moved between the builds (public ${r.offset}, checked ${t.offset}) and the source reads the public one: one constant cannot serve both`); continue; }
      set('wrong', `the source offset matches neither build (public ${r.offset}, checked ${t.offset})`);
    }
  }
  const plan = [];
  for (const x of results) {
    if (x.state !== 'patch') continue;
    if (!plan.some((p) => p.key === x.key && p.anchor === x.anchor && p.old === x.source)) plan.push({ key: x.key, anchor: x.anchor, old: x.source, new: x.to });
  }
  const blocked = results.filter((x) => x.state !== 'ok' && x.state !== 'patch')
    .map((x) => ({ key: x.key, state: x.state, reason: x.reason }));
  const counts = {};
  for (const x of results) counts[x.state] = (counts[x.state] || 0) + 1;
  return { status: results.length ? (results.every((x) => x.state === 'ok') ? 'ok' : 'fail') : 'none', counts, results, plan, blocked };
}

// Rewrites the number at each site that reads plan.old to plan.new. Returns the
// edits (for applyPlan to merge with the pattern edits) and a status per entry.
export function applyOffsets(files, offsets) {
  const results = [];
  const edits = [];
  for (const o of offsets) {
    const r = { ...o };
    results.push(r);
    try {
      if (!Number.isInteger(o.old) || !Number.isInteger(o.new) || o.old < 0 || o.new < 0) throw new Error('malformed offset row');
      const sites = anchorSites(files, compileAnchor(o.anchor)).filter((s) => s.value === o.old);
      if (!sites.length) throw new Error(`the anchor finds no site that reads ${o.old}`);
      for (const s of sites) edits.push({ file: s.file, start: s.start, end: s.end, text: formatLike(s.text, o.new) });
      Object.assign(r, { status: 'applied', file: sites[0].path, line: sites[0].line });
    } catch (err) {
      Object.assign(r, { status: 'skipped', reason: err.message });
    }
  }
  return { results, edits };
}

// ---- verdict -----------------------------------------------------------------

function sameRva(a, b) {
  return /^0x[0-9a-f]+$/i.test(a || '') && /^0x[0-9a-f]+$/i.test(b || '') && BigInt(a) === BigInt(b);
}

// Whether the rebuilt plugin does what the plan says. target and reference are
// its sr-aobscan --plugin scans on the checked build and on the public build.
//   FIXED    every applied row resolves with its new pattern, on the checked
//            build at the RVA the proposal named and on the public build at
//            the RVA it resolves today; both scans PASS.
//   PARTIAL  the same, except that the checked build still fails rows that
//            were skipped, and only those.
//   NO-FIX   nothing was applied: there is nothing to build or push.
//   FAILED   anything else.
// A fixed offset that was rewritten (applied.offsets) counts as applied too:
// offsetsAfter is the offsets check of the rebuilt source, and every rewritten
// offset must read ok there. Offsets that cannot be patched keep failing the
// plugin and make the fix PARTIAL, like a pattern row that was skipped.
export function verdictOf(applied, { target = null, reference = null, offsetsAfter = null } = {}) {
  const rows = (applied.rows || []).filter((r) => r.status === 'applied');
  const offs = (applied.offsets || []).filter((r) => r.status === 'applied');
  const notApplied = new Set([...(applied.skipped || []), ...(applied.rows || []).filter((r) => r.status !== 'applied')].map((r) => r.name));
  const out = { verdict: 'FAILED', reasons: [], rows: [], offsets: [], skipped: [...notApplied].sort() };
  if (!rows.length && !offs.length) return { ...out, verdict: 'NO-FIX', reasons: ['no proposal was applied'] };
  if (rows.length && !target) return { ...out, reasons: ['the rebuilt plugin was not scanned on the checked build'] };
  if (rows.length && applied.hasReference && !reference) return { ...out, reasons: ['the rebuilt plugin was not scanned on the public build'] };
  if (offs.length && !offsetsAfter) return { ...out, reasons: ['the rebuilt source was not checked for its fixed offsets'] };
  const fail = (why) => out.reasons.push(why);
  const recorded = (scan) => (scan.patterns || []).filter((p) => p.recorded);
  const find = (scan, r) => recorded(scan).filter((p) => p.name === r.name && p.call === r.call);
  let stillFailing = [];
  let offsetsLeft = 0;

  if (rows.length) {

  for (const r of rows) {
    const v = { name: r.name, category: r.category };
    const t = find(target, r);
    v.target = t.length === 1 ? { result: t[0].result, rva: t[0].rva || '' } : { result: `${t.length} rows` };
    if (t.length !== 1 || t[0].result !== 'OK' || !sameRva(t[0].rva, r.rva) || t[0].pattern !== r.new.pattern) {
      fail(`${r.name}: on the checked build it is ${v.target.result} ${v.target.rva || ''}`.trim() + `, expected OK at ${r.rva} with the new pattern`);
    }
    if (applied.hasReference) {
      const q = find(reference, r);
      const want = r.category === 'add' ? r.old.pattern : r.new.pattern;
      v.reference = q.length === 1 ? { result: q[0].result, rva: q[0].rva || '' } : { result: `${q.length} rows` };
      if (q.length !== 1 || q[0].result !== 'OK' || !sameRva(q[0].rva, r.referenceRva) || q[0].pattern !== want) {
        fail(`${r.name}: on the public build it is ${v.reference.result} ${v.reference.rva || ''}`.trim() + `, expected OK at ${r.referenceRva} with the ${r.category === 'add' ? 'current' : 'new'} pattern`);
      }
    }
    out.rows.push(v);
  }
  stillFailing = recorded(target).filter((p) => p.result !== 'OK').map((p) => p.name);
  for (const n of stillFailing) if (!notApplied.has(n)) fail(`${n} fails on the checked build and was not a skipped row`);
  if (applied.hasReference) {
    for (const p of recorded(reference)) if (p.result !== 'OK') fail(`${p.name} fails on the public build (${p.result})`);
    if (reference.verdict !== 'PASS') fail(`the public build scans ${reference.verdict}`);
  }
  if (stillFailing.length ? target.verdict !== 'FAIL' : target.verdict !== 'PASS') fail(`the checked build scans ${target.verdict}`);
  }

  if (offsetsAfter) {
    const after = offsetsAfter.results || [];
    for (const o of offs) {
      const sites = after.filter((x) => x.key === o.key && x.anchor === o.anchor);
      const bad = sites.filter((x) => x.state !== 'ok');
      out.offsets.push({ key: o.key, old: o.old, new: o.new, after: sites.length ? (bad[0] || sites[0]).state : 'unanchored' });
      if (!sites.length) fail(`${o.key}: the rebuilt source has no site for it`);
      for (const x of bad) fail(`${o.key}: still ${x.state} after the rewrite${x.reason ? ` (${x.reason})` : ''}`);
    }
    const rewritten = new Set(offs.map((o) => `${o.key}\n${o.anchor}`));
    offsetsLeft = after.filter((x) => x.state !== 'ok' && !rewritten.has(`${x.key}\n${x.anchor}`)).length;
  }
  if (out.reasons.length) return out;
  return { ...out, verdict: stillFailing.length || offsetsLeft ? 'PARTIAL' : 'FIXED' };
}

// ---- commit message ----------------------------------------------------------

export function commitMessage(applied, { cl, referenceCl = '' }) {
  const rows = (applied.rows || []).filter((r) => r.status === 'applied');
  const offs = (applied.offsets || []).filter((r) => r.status === 'applied');
  const what = rows.length && offs.length ? 'patterns and offsets' : offs.length ? 'offsets' : 'patterns';
  const lines = [`Update ${what} for CL-${cl}`, ''];
  if (rows.length) {
    lines.push(referenceCl
      ? `Re-derived for client CL-${cl}. Built and scanned against CL-${cl} and the public client CL-${referenceCl}: on both, each hook changed here resolves uniquely, on CL-${cl} to the function the suggester located, and on the public client to the function it resolves to today.`
      : `Re-derived for client CL-${cl}, the public client. Built and scanned against it: each hook changed here resolves uniquely to the function the suggester located.`);
  }
  if (offs.length) {
    if (rows.length) lines.push('');
    lines.push(`${rows.length ? '' : `Re-derived for client CL-${cl}. `}Each fixed offset changed here is the one the PDB of ${referenceCl ? `CL-${cl} gives, and the public client has the same` : `CL-${cl} gives`}; the rebuilt source reads it.`);
  }
  for (const o of offs) {
    lines.push('', o.key, `  offset 0x${o.old.toString(16).toUpperCase()} -> 0x${o.new.toString(16).toUpperCase()} (${o.file}:${o.line})`);
  }
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
    // The offsets check of this plugin (the offsets command) rides in the plan,
    // so the push job re-creates the rewritten offsets with the pattern rows.
    if (o.offsets) {
      const found = readJson(o.offsets);
      plan.offsets = found.plan || [];
      plan.blockedOffsets = found.blocked || [];
    }
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return 0;
  }
  if (cmd === 'offsets') {
    // Reads the plugin's source (--source) against the layout reports of the
    // checked build (--target) and the public build (--reference, absent when
    // the checked build is the public one). Always prints a report; a layout
    // report that is missing is status 'unchecked', never a pass.
    const entries = parseNativeKeys(readFileSync(o.native, 'utf8')).filter((e) => e.plugin === o.plugin && e.compiled);
    if (!entries.length) { process.stdout.write(JSON.stringify({ plugin: o.plugin, status: 'none', counts: {}, results: [], plan: [], blocked: [] }, null, 2) + '\n'); return 0; }
    const files = new Map(listSources(o.source).map((p) => [relative(o.source, p), readFileSync(p, 'utf8')]));
    let target = null;
    let reference = null;
    try { target = o.target ? readJson(o.target) : null; } catch { target = null; }
    try { reference = o.reference ? readJson(o.reference) : null; } catch { reference = null; }
    if (!target || !Array.isArray(target.keys)) {
      const reason = 'the layout report of the checked build is missing, so the fixed offsets were not checked';
      process.stdout.write(JSON.stringify({ plugin: o.plugin, status: 'unchecked', reason, counts: {}, results: entries.map((e) => ({ key: e.key, anchor: e.anchor, state: 'unchecked', reason })), plan: [], blocked: entries.map((e) => ({ key: e.key, state: 'unchecked', reason })) }, null, 2) + '\n');
      return 0;
    }
    const report = checkOffsets(files, entries, { target, reference, targetPublic: o['target-public'] === 'true' });
    process.stdout.write(JSON.stringify({ plugin: o.plugin, ...report }, null, 2) + '\n');
    return 0;
  }
  if (cmd === 'apply') {
    const plan = readJson(o.plan);
    const files = new Map(listSources(o.source).map((p) => [relative(o.source, p), readFileSync(p, 'utf8')]));
    const { changed, rows, offsets } = applyPlan(files, plan);
    if (!o['dry-run']) for (const [f, t] of changed) writeFileSync(join(o.source, f), t, 'utf8');
    process.stdout.write(JSON.stringify({ ...plan, rows, offsets, changed: [...changed.keys()].map((f) => f.split(sep).join('/')).sort() }, null, 2) + '\n');
    return 0;
  }
  if (cmd === 'verdict') {
    const v = verdictOf(readJson(o.applied), { target: o.target ? readJson(o.target) : null, reference: o.reference ? readJson(o.reference) : null, offsetsAfter: o['offsets-after'] ? readJson(o['offsets-after']) : null });
    process.stdout.write(JSON.stringify(v, null, 2) + '\n');
    return 0;
  }
  if (cmd === 'message') {
    process.stdout.write(commitMessage(readJson(o.applied), { cl: o.cl, referenceCl: o['reference-cl'] || '' }));
    return 0;
  }
  process.stderr.write('usage: apply-proposals.mjs select|offsets|apply|verdict|message ...\n');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
