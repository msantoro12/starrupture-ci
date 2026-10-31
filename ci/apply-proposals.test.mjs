import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRows, applyPlan, lexLiterals, commitMessage, isPattern, verdictOf, parseNativeKeys, checkOffsets } from './apply-proposals.mjs';

const OLD_A = '48 89 5C 24 ?? 48 89 6C 24 ?? 56 57 41 56 48 83 EC ?? 48 8B F9 48 8B 89';
const NEW_A = '48 8B C8 E8 ?? ?? ?? ?? 0F B6 D8 88 9F ?? ?? 00 00';
const OLD_B = '40 53 57 48 81 EC ?? ?? ?? ?? 48 8B DA 48 8B F9 48 85 D2 75 ?? 32 C0';
const NEW_B = '40 53 55 56 48 81 EC 90 00 00 00 48 8B DA 48 8B F1';
const OLD_W = '40 53 48 83 EC ?? 48 8B 81 ?? ?? ?? ?? 48 8B D9 48 85 C0 75 ?? E8 ?? ?? ?? ?? 48 8B C8';
const NEW_W = '40 53 48 83 EC 50 48 8B 81 A8 00 00 00 48 8B D9 48 85 C0 75 ?? E8 ?? ?? ?? ?? 48 8B C8';

function row(name, pattern, suggest, extra = {}) {
  return { call: 'Resolve', name, kind: 'function', required: false, recorded: true, result: 'MISSING', pattern, matches: 0, suggest, ...extra };
}
function sug(proposal, { confidence = 'high', keeps = true, ref = true } = {}) {
  const s = { located: ref ? 'reference' : 'renamed', confidence, rva: '0x7488CB0', proposals: [{ followRel32At: -1, resultOffset: 0, uniqueOnTarget: true, ...proposal }] };
  if (ref) { s.referenceRva = '0x745C7E0'; s.referenceKeepsCurrent = keeps; }
  return s;
}
const scanWithRef = (patterns) => ({ suggest: { reference: 'mapped' }, patterns });

const BC_SOURCE = [
  '#pragma once',
  'namespace AOB',
  '{',
  '\tstruct FunctionPattern',
  '\t{',
  '\t\tconst char* pattern;',
  '\t\tint followRel32At = -1;',
  '\t};',
  '',
  '\t// Class::Function  A::GetThing',
  '\tconstexpr const char* GetThing =',
  `\t\t"${OLD_A}";`,
  '',
  '\t// Class::Function  B::Check',
  '\tconstexpr const char* Check =',
  `\t\t"${OLD_B.slice(0, 30)}"`,
  `\t\t"${OLD_B.slice(30)}";`,
  '}',
  '',
].join('\n');

test('isPattern accepts AOB strings only', () => {
  assert.ok(isPattern(OLD_A));
  assert.ok(!isPattern('48 8b'));
  assert.ok(!isPattern('48  8B'));
  assert.ok(!isPattern('48 8B "'));
});

test('lexLiterals joins adjacent literals across lines and comments, skips comments', () => {
  const lits = lexLiterals('a = "AB " /* x "no" */ "CD"; // "skip"\nb = \'"\'; c = "E";');
  assert.deepEqual(lits.map((l) => l.value), ['AB CD', 'E']);
});

test('select: both-builds replace, new-build add, confidence and reference gates', () => {
  const scan = scanWithRef([
    row('A::GetThing', OLD_A, sug({ pattern: NEW_A, followRel32At: 3, uniqueOnReference: true })),
    row('B::Check', OLD_B, sug({ pattern: NEW_B, uniqueOnReference: false })),
    row('C::Low', OLD_W, sug({ pattern: NEW_W, uniqueOnReference: true }, { confidence: 'medium' })),
    row('D::Lost', OLD_W, sug({ pattern: NEW_W, uniqueOnReference: false }, { keeps: false })),
    { ...row('E::Fine', OLD_W, undefined), result: 'OK' },
  ]);
  const plan = selectRows(scan, { minConfidence: 'high' });
  assert.deepEqual(plan.rows.map((r) => [r.name, r.category, r.new.followRel32At]), [['A::GetThing', 'replace', 3], ['B::Check', 'add', -1]]);
  assert.deepEqual(plan.skipped.map((r) => r.name), ['C::Low', 'D::Lost']);
  assert.match(plan.skipped[0].reason, /below high/);
  assert.equal(selectRows(scan, { minConfidence: 'medium' }).rows.length, 3);
});

test('select: without a reference only a public target may replace', () => {
  const scan = { suggest: { reference: 'none' }, patterns: [row('A::GetThing', OLD_A, sug({ pattern: NEW_W }, { ref: false, confidence: 'medium' }))] };
  assert.equal(selectRows(scan, { minConfidence: 'medium', targetPublic: false }).rows.length, 0);
  const plan = selectRows(scan, { minConfidence: 'medium', targetPublic: true });
  assert.equal(plan.rows[0].category, 'replace');
  assert.equal(plan.rows[0].why, 'the checked build is the public one');
});

function bcPlan() {
  return selectRows(scanWithRef([
    row('A::GetThing', OLD_A, sug({ pattern: NEW_A, followRel32At: 3, uniqueOnReference: true })),
    row('B::Check', OLD_B, sug({ pattern: NEW_B, uniqueOnReference: false })),
  ]));
}

test('apply: declarations become FunctionPattern lists; nothing else changes', () => {
  const { changed, rows } = applyPlan(new Map([['aob_patterns.h', BC_SOURCE]]), bcPlan());
  assert.deepEqual(rows.map((r) => r.status), ['applied', 'applied']);
  const want = BC_SOURCE
    .replace(`\tconstexpr const char* GetThing =\n\t\t"${OLD_A}";`,
      `\tconstexpr FunctionPattern GetThing[] = {\n\t\t{ "${NEW_A}", 3 },\n\t};`)
    .replace(`\tconstexpr const char* Check =\n\t\t"${OLD_B.slice(0, 30)}"\n\t\t"${OLD_B.slice(30)}";`,
      `\tconstexpr FunctionPattern Check[] = {\n\t\t{ "${OLD_B}" },\n\t\t{ "${NEW_B}" },\n\t};`);
  assert.equal(changed.get('aob_patterns.h'), want);
});

test('apply: an existing list keeps the matching candidate and the new one, or collapses on replace', () => {
  const src = `\tconstexpr FunctionPattern Check[] = {\n\t\t{ "${OLD_W}" },\n\t\t{ "${OLD_B}" },\n\t};\nstruct FunctionPattern;\n`;
  const add = applyPlan(new Map([['p.h', src]]), selectRows(scanWithRef([row('B::Check', OLD_B, sug({ pattern: NEW_B, uniqueOnReference: false }))])));
  assert.equal(add.changed.get('p.h'), `\tconstexpr FunctionPattern Check[] = {\n\t\t{ "${OLD_B}" },\n\t\t{ "${NEW_B}" },\n\t};\nstruct FunctionPattern;\n`);
  const rep = applyPlan(new Map([['p.h', src]]), selectRows(scanWithRef([row('B::Check', OLD_B, sug({ pattern: NEW_B, followRel32At: 24, uniqueOnReference: true }))])));
  assert.equal(rep.changed.get('p.h'), `\tconstexpr FunctionPattern Check[] = {\n\t\t{ "${NEW_B}", 24 },\n\t};\nstruct FunctionPattern;\n`);
});

test('apply: without FunctionPattern a follow change or a second pattern is skipped, a plain replace is not', () => {
  const src = BC_SOURCE.replace(/\tstruct FunctionPattern[\s\S]*?\t};\n/, '');
  const { changed, rows } = applyPlan(new Map([['aob_patterns.h', src]]), bcPlan());
  assert.deepEqual(rows.map((r) => r.status), ['skipped', 'skipped']);
  assert.equal(changed.size, 0);
  const plain = selectRows(scanWithRef([row('A::GetThing', OLD_A, sug({ pattern: NEW_W, uniqueOnReference: true }))]));
  assert.equal(applyPlan(new Map([['aob_patterns.h', src]]), plain).changed.get('aob_patterns.h'), src.replace(`"${OLD_A}"`, `"${NEW_W}"`));
});

test('apply: WAILA-style static declaration with spaces keeps its layout and CRLF', () => {
  const src = `    static constexpr const char* kPattern =\r\n        "${OLD_W}";\r\n`;
  const plan = selectRows(scanWithRef([{ ...row('W::Get', OLD_W, sug({ pattern: NEW_W, uniqueOnReference: true })), result: 'AMBIGUOUS', matches: 2 }]));
  assert.equal(applyPlan(new Map([['w.cpp', src]]), plan).changed.get('w.cpp'), `    static constexpr const char* kPattern =\r\n        "${NEW_W}";\r\n`);
  const add = selectRows(scanWithRef([row('W::Get', OLD_W, sug({ pattern: NEW_W, uniqueOnReference: false }))]));
  const listed = applyPlan(new Map([['w.cpp', src + 'struct FunctionPattern {};\r\n']]), add).changed.get('w.cpp');
  assert.equal(listed, `    static constexpr FunctionPattern kPattern[] = {\r\n        { "${OLD_W}" },\r\n        { "${NEW_W}" },\r\n    };\r\nstruct FunctionPattern {};\r\n`);
});

test('apply: a request-member site changes its pattern and its follow offset in place', () => {
  const OLD_M = '48 8D 97 30 03 00 00 48 8D 4C 24 58 E8 ?? ?? ?? ?? 83 BC 24';
  const NEW_M = '48 8B D0 48 8D 8D ?? 02 00 00 E8 ?? ?? ?? ?? 48 8B 9D ?? 02 00 00';
  const src = [
    '        PluginScanRequest req = PLUGIN_SCAN_REQUEST_INIT;',
    '        req.hookName = "X::Get";',
    '        req.pattern =',
    `            "${OLD_M.slice(0, 33)}"`,
    `            "${OLD_M.slice(33)}";`,
    '        req.kind = PLUGIN_SCAN_FUNCTION_START;',
    '        req.flags = PLUGIN_SCAN_FLAG_FOLLOW_REL32;',
    '        req.followRel32At = 0x0C;',
    '        a = scanner->Resolve(self, &req);',
    '        other.followRel32At = 0x0C;',
    '',
  ].join('\n');
  const plan = selectRows(scanWithRef([row('X::Get', OLD_M, sug({ pattern: NEW_M, followRel32At: 10, uniqueOnReference: true }), { followRel32At: 12 })]));
  const { changed, rows } = applyPlan(new Map([['f.cpp', src]]), plan);
  assert.equal(rows[0].status, 'applied');
  assert.equal(changed.get('f.cpp'), src
    .replace(`"${OLD_M.slice(0, 33)}"\n            "${OLD_M.slice(33)}"`, `"${NEW_M}"`)
    .replace('req.followRel32At = 0x0C;', 'req.followRel32At = 0x0A;'));
  const wrong = selectRows(scanWithRef([row('X::Get', OLD_M, sug({ pattern: NEW_M, followRel32At: 10, uniqueOnReference: true }), { followRel32At: 7 })]));
  assert.match(applyPlan(new Map([['f.cpp', src]]), wrong).rows[0].reason, /follows rel32 at 12/);
});

test('apply: a pattern found twice, or not at all, is skipped; two rows on one site are both skipped', () => {
  const twice = `const char* a = "${OLD_A}";\nconst char* b = "${OLD_A}";\n`;
  const plan = selectRows(scanWithRef([row('A::GetThing', OLD_A, sug({ pattern: NEW_W, uniqueOnReference: true }))]));
  assert.match(applyPlan(new Map([['x.cpp', twice]]), plan).rows[0].reason, /2 times/);
  assert.match(applyPlan(new Map([['x.cpp', '// nothing\n']]), plan).rows[0].reason, /not in the source/);
  const listSrc = `constexpr FunctionPattern L[] = {\n\t{ "${OLD_A}" },\n\t{ "${OLD_B}" },\n};\nstruct FunctionPattern;\n`;
  const both = selectRows(scanWithRef([
    row('A', OLD_A, sug({ pattern: NEW_W, uniqueOnReference: false })),
    row('B', OLD_B, sug({ pattern: NEW_B, uniqueOnReference: false })),
  ]));
  const res = applyPlan(new Map([['l.h', listSrc]]), both);
  assert.deepEqual(res.rows.map((r) => r.status), ['skipped', 'skipped']);
  assert.equal(res.changed.size, 0);
});

test('apply is deterministic and commitMessage states CL, patterns and confidence', () => {
  const a = applyPlan(new Map([['aob_patterns.h', BC_SOURCE]]), bcPlan());
  const b = applyPlan(new Map([['aob_patterns.h', BC_SOURCE]]), bcPlan());
  assert.equal(a.changed.get('aob_patterns.h'), b.changed.get('aob_patterns.h'));
  const msg = commitMessage({ rows: a.rows }, { cl: '128786', referenceCl: '127004' });
  const [subject, blank] = msg.split('\n');
  assert.equal(subject, 'Update patterns for CL-128786');
  assert.ok(subject.length < 60);
  assert.equal(blank, '');
  assert.match(msg, /CL-127004/);
  assert.match(msg, new RegExp(`now ${NEW_A.replace(/[?]/g, '\\?')} \\(call at \\+3\\)`));
  assert.match(msg, /Added as a second pattern .*Confidence high\./);
  assert.doesNotMatch(msg, /Co-Authored-By|Claude/i);
});

test('verdict: FIXED, PARTIAL, NO-FIX and FAILED', () => {
  const applied = {
    hasReference: true,
    skipped: [],
    rows: [
      { name: 'A::GetThing', call: 'Resolve', status: 'applied', category: 'replace', rva: '0x7488CB0', referenceRva: '0x745C7E0',
        old: { pattern: OLD_A, followRel32At: -1 }, new: { pattern: NEW_A, followRel32At: 3 } },
      { name: 'B::Check', call: 'Resolve', status: 'applied', category: 'add', rva: '0x74E2050', referenceRva: '0x74B0000',
        old: { pattern: OLD_B, followRel32At: -1 }, new: { pattern: NEW_B, followRel32At: -1 } },
    ],
  };
  const rec = (name, result, rva, pattern) => ({ call: 'Resolve', name, recorded: true, result, rva, pattern });
  const target = { verdict: 'PASS', patterns: [rec('A::GetThing', 'OK', '0x7488cb0', NEW_A), rec('B::Check', 'OK', '0x74E2050', NEW_B), rec('C::Other', 'OK', '0x1', OLD_W)] };
  const reference = { verdict: 'PASS', patterns: [rec('A::GetThing', 'OK', '0x745C7E0', NEW_A), rec('B::Check', 'OK', '0x74B0000', OLD_B), rec('C::Other', 'OK', '0x2', OLD_W)] };
  assert.equal(verdictOf(applied, { target, reference }).verdict, 'FIXED');

  // The add row's public side must still resolve through the current pattern.
  const refNew = { ...reference, patterns: reference.patterns.map((p) => (p.name === 'B::Check' ? { ...p, pattern: NEW_B } : p)) };
  assert.equal(verdictOf(applied, { target, reference: refNew }).verdict, 'FAILED');
  // A different function on either build fails it.
  const moved = { ...target, patterns: target.patterns.map((p) => (p.name === 'A::GetThing' ? { ...p, rva: '0x7488CC0' } : p)) };
  assert.equal(verdictOf(applied, { target: moved, reference }).verdict, 'FAILED');
  // The public build regressing fails it, and so does a missing public scan.
  const broken = { verdict: 'FAIL', patterns: reference.patterns.map((p) => (p.name === 'C::Other' ? { ...p, result: 'MISSING' } : p)) };
  assert.equal(verdictOf(applied, { target, reference: broken }).verdict, 'FAILED');
  assert.equal(verdictOf(applied, { target }).verdict, 'FAILED');

  // A skipped row that still fails makes it PARTIAL; any other failure does not.
  const withSkip = { ...applied, skipped: [{ name: 'D::Skipped', status: 'skipped', reason: 'confidence medium is below high' }] };
  const failingSkip = { verdict: 'FAIL', patterns: [...target.patterns, rec('D::Skipped', 'MISSING', undefined, OLD_W)] };
  assert.equal(verdictOf(withSkip, { target: failingSkip, reference }).verdict, 'PARTIAL');
  const failingOther = { verdict: 'FAIL', patterns: target.patterns.map((p) => (p.name === 'C::Other' ? { ...p, result: 'MISSING' } : p)) };
  assert.equal(verdictOf(withSkip, { target: failingOther, reference }).verdict, 'FAILED');
  // Partial coverage is never FIXED.
  assert.equal(verdictOf(applied, { target: { ...target, verdict: 'GAME-CALL' }, reference }).verdict, 'FAILED');

  // A public target has no reference to check.
  const pub = { hasReference: false, skipped: [], rows: [applied.rows[0]] };
  assert.equal(verdictOf(pub, { target }).verdict, 'FIXED');
  assert.equal(verdictOf({ hasReference: false, skipped: [], rows: [{ ...applied.rows[0], status: 'skipped' }] }, { target }).verdict, 'NO-FIX');
});

// ---- follow offsets that live in the use of a pattern, not at its literal ----

const HELPER = [
  'static uintptr_t ResolveCalleeOf(IPluginSelf* self, IPluginHookScanner* scanner,',
  '    const char* hookName, const char* pattern, int32_t callOffset)',
  '{',
  '    PluginScanRequest req = PLUGIN_SCAN_REQUEST_INIT;',
  '    req.hookName      = hookName;',
  '    req.pattern       = pattern;',
  '    req.flags         = PLUGIN_SCAN_FLAG_OPTIONAL | PLUGIN_SCAN_FLAG_FOLLOW_REL32;',
  '    req.followRel32At = callOffset;',
  '    return scanner->Resolve(self, &req);',
  '}',
  '',
].join('\n');
const OLD_M = '48 8D 97 30 03 00 00 48 8D 4C 24 58 E8 ?? ?? ?? ?? 83 BC 24';
const NEW_M = '48 8B D0 48 8D 8D ?? 02 00 00 E8 ?? ?? ?? ?? 48 8B 9D ?? 02 00 00';

test('apply: a follow offset kept in a header constant and passed through a helper is edited in place', () => {
  const header = [
    'namespace Sig',
    '{',
    '    static const char* Fn =',
    `        "${OLD_M}";`,
    '    static constexpr unsigned CallOffset = 0x2F;',
    '}',
    '',
  ].join('\n');
  const cpp = HELPER + 'void R() {\n    a = ResolveCalleeOf(self, scanner, "X::Get", Sig::Fn, static_cast<int32_t>(Sig::CallOffset));\n}\n';
  const files = () => new Map([['sig.h', header], ['r.cpp', cpp]]);
  const plan = (follow, refUnique = true) => selectRows(scanWithRef([row('X::Get', OLD_M, sug({ pattern: NEW_M, followRel32At: follow, uniqueOnReference: refUnique }), { followRel32At: 47 })]));

  // Same call offset: the literal alone changes.
  const same = applyPlan(files(), plan(47));
  assert.equal(same.rows[0].status, 'applied');
  assert.equal(same.changed.get('sig.h'), header.replace(OLD_M, NEW_M));
  assert.ok(!same.changed.has('r.cpp'));

  // A new call offset: the number in the header changes with the literal, formatted like the old one.
  const moved = applyPlan(files(), plan(45));
  assert.equal(moved.rows[0].status, 'applied');
  assert.equal(moved.changed.get('sig.h'), header.replace(OLD_M, NEW_M).replace('0x2F', '0x2D'));

  // A second pattern for the new build cannot be a list when a request uses the constant.
  const added = applyPlan(files(), plan(45, false));
  assert.equal(added.rows[0].status, 'skipped');
  assert.match(added.rows[0].reason, /pattern list/);
  assert.equal(added.changed.size, 0);

  // The scan recorded another offset than the use passes: skipped, not guessed.
  const other = applyPlan(files(), selectRows(scanWithRef([row('X::Get', OLD_M, sug({ pattern: NEW_M, followRel32At: 45, uniqueOnReference: true }), { followRel32At: 12 })])));
  assert.equal(other.rows[0].status, 'skipped');
});

test('apply: a literal follow argument and a plain static declaration are understood', () => {
  const src = [
    `static const char* Pat = "${OLD_M}";`,
    HELPER,
    'void R() { a = ResolveCalleeOf(self, scanner, "X::Get", Pat, 0); }',
    '',
  ].join('\n');
  const res = applyPlan(new Map([['a.cpp', src]]), selectRows(scanWithRef([row('X::Get', OLD_M, sug({ pattern: NEW_M, followRel32At: 3, uniqueOnReference: true }), { followRel32At: 0 })])));
  assert.equal(res.rows[0].status, 'applied');
  assert.equal(res.changed.get('a.cpp'), src.replace(OLD_M, NEW_M).replace('"X::Get", Pat, 0)', '"X::Get", Pat, 3)'));
});

test('apply: rows that share one pattern declaration apply together when they edit it the same way', () => {
  const src = `static const char* Sig = "${OLD_M}";\nvoid R() { a = Resolve("A::One", Sig); b = Resolve("A::Two", Sig); }\n`;
  const rowFor = (name) => row(name, OLD_M, sug({ pattern: NEW_M, uniqueOnReference: true }));
  const same = applyPlan(new Map([['a.cpp', src]]), selectRows(scanWithRef([rowFor('A::One'), rowFor('A::Two')])));
  assert.deepEqual(same.rows.map((r) => r.status), ['applied', 'applied']);
  assert.equal(same.changed.get('a.cpp'), src.replace(OLD_M, NEW_M));
  // Different new patterns for one declaration: neither is applied.
  const other = row('A::Two', OLD_M, sug({ pattern: NEW_B, uniqueOnReference: true }));
  const clash = applyPlan(new Map([['a.cpp', src]]), selectRows(scanWithRef([rowFor('A::One'), other])));
  assert.deepEqual(clash.rows.map((r) => r.status), ['skipped', 'skipped']);
  assert.equal(clash.changed.size, 0);
});

// ---- fixed offsets ----------------------------------------------------------

const NATIVE = [
  '# comment',
  'Wave UObj::Alpha src/wave.cpp:kOff_Alpha~=~@;',
  'Wave UObj::Beta src/wave.cpp:\\+~@\\)',
  'Wave UObj::Gamma',
  'Other UObj::Delta other.h:kD~=~@;',
  '',
].join('\n');
const WAVE_CPP = [
  'constexpr int kOff_Alpha = 0x78;',
  'auto f = *(base + 0x08);',
  'auto g = *(base + 16);',
  '',
].join('\r\n');
const layoutReport = (rows) => ({ keys: rows.map(([key, offset, size = 4, boolMask = 0, result = 'OK']) => ({ key, result, offset, size, boolMask })) });
const ALPHA = 'UObj::Alpha';

test('native-keys: lines with and without an anchor parse; a bad anchor is an error naming the line', () => {
  const e = parseNativeKeys(NATIVE);
  assert.deepEqual(e.map((x) => `${x.plugin} ${x.key} ${x.anchor ? 'anchored' : 'plain'}`),
    ['Wave UObj::Alpha anchored', 'Wave UObj::Beta anchored', 'Wave UObj::Gamma plain', 'Other UObj::Delta anchored']);
  assert.throws(() => parseNativeKeys('P C::m src/a.cpp:no number here'), /line 1.*exactly one @/);
  assert.throws(() => parseNativeKeys('P C::m a.cpp:(x)=@'), /capture group/);
  assert.throws(() => parseNativeKeys('P C::m a.cpp'), /file-suffix/);
  assert.throws(() => parseNativeKeys('justone'), /malformed/);
});

test('offsets: ok, patch, split, wrong, changed, missing and unanchored are told apart', () => {
  const files = new Map([['src\\wave.cpp', WAVE_CPP]]);
  const all = parseNativeKeys(NATIVE).filter((e) => e.plugin === 'Wave' && e.compiled);
  const alpha = all.filter((e) => e.key === ALPHA);
  const ok = checkOffsets(files, all, { target: layoutReport([[ALPHA, 0x78], ['UObj::Beta', 8]]) });
  assert.equal(ok.results.find((r) => r.key === ALPHA).state, 'ok');
  // The Beta anchor finds two sites; only the one that reads 8 is right.
  assert.deepEqual(ok.results.filter((r) => r.key === 'UObj::Beta').map((r) => [r.source, r.state]), [[8, 'ok'], [16, 'wrong']]);
  assert.equal(ok.status, 'fail');

  // The checked build is the public one: any difference is patchable.
  const pub = checkOffsets(files, alpha, { target: layoutReport([[ALPHA, 0x80]]), targetPublic: true });
  assert.deepEqual(pub.plan, [{ key: ALPHA, anchor: 'src/wave.cpp:kOff_Alpha~=~@;', old: 0x78, new: 0x80 }]);
  assert.equal(pub.status, 'fail');
  assert.deepEqual(pub.blocked, []);

  // A test build where the member moved: the source reads the public offset, so one constant cannot serve both.
  const split = checkOffsets(files, alpha, { target: layoutReport([[ALPHA, 0x80]]), reference: layoutReport([[ALPHA, 0x78]]) });
  assert.equal(split.results[0].state, 'split');
  assert.deepEqual(split.plan, []);
  assert.equal(split.blocked[0].state, 'split');
  // Wrong on both builds with the same offset: patchable.
  const both = checkOffsets(files, alpha, { target: layoutReport([[ALPHA, 0x90]]), reference: layoutReport([[ALPHA, 0x90]]) });
  assert.equal(both.results[0].state, 'patch');
  assert.equal(both.plan[0].new, 0x90);
  // Matching neither build.
  assert.equal(checkOffsets(files, alpha, { target: layoutReport([[ALPHA, 0x90]]), reference: layoutReport([[ALPHA, 0xA0]]) }).results[0].state, 'wrong');
  // Not public and nothing to compare with: not patchable.
  assert.equal(checkOffsets(files, alpha, { target: layoutReport([[ALPHA, 0x90]]) }).results[0].state, 'wrong');
  // Size changed between builds, even at the same offset.
  assert.equal(checkOffsets(files, alpha, { target: layoutReport([[ALPHA, 0x78, 8]]), reference: layoutReport([[ALPHA, 0x78, 4]]) }).results[0].state, 'changed');
  // Gone from the checked build, and an anchor that finds nothing.
  assert.equal(checkOffsets(files, alpha, { target: layoutReport([[ALPHA, 0, 0, 0, 'NOMEMBER']]) }).results[0].state, 'missing');
  assert.equal(checkOffsets(new Map([['src\\wave.cpp', 'nothing\n']]), alpha, { target: layoutReport([[ALPHA, 0x78]]) }).results[0].state, 'unanchored');
  assert.equal(checkOffsets(new Map(), alpha, { target: layoutReport([[ALPHA, 0x78]]) }).status, 'fail');
});

test('apply: a planned offset is rewritten like the number it replaces, with pattern rows, and only where it reads the old value', () => {
  const sig = `static const char* S = "${OLD_M}";\n`;
  const files = () => new Map([['src\\wave.cpp', WAVE_CPP], ['sig.cpp', sig]]);
  const plan = {
    ...selectRows(scanWithRef([row('X::Get', OLD_M, sug({ pattern: NEW_M, uniqueOnReference: true }))])),
    offsets: [
      { key: ALPHA, anchor: 'src/wave.cpp:kOff_Alpha~=~@;', old: 0x78, new: 0x80 },
      { key: 'UObj::Beta', anchor: 'src/wave.cpp:\\+~@\\)', old: 8, new: 0x0C },
      { key: 'UObj::Gone', anchor: 'src/wave.cpp:kNothing~=~@;', old: 1, new: 2 },
      { key: 'UObj::Stale', anchor: 'src/wave.cpp:kOff_Alpha~=~@;', old: 0x10, new: 0x20 },
    ],
  };
  const res = applyPlan(files(), plan);
  assert.deepEqual(res.offsets.map((o) => o.status), ['applied', 'applied', 'skipped', 'skipped']);
  assert.match(res.offsets[3].reason, /reads 16/);
  assert.equal(res.rows[0].status, 'applied');
  assert.equal(res.changed.get('src\\wave.cpp'), WAVE_CPP.replace('0x78', '0x80').replace('+ 0x08)', '+ 0x0C)'));
  assert.equal(res.changed.get('sig.cpp'), sig.replace(OLD_M, NEW_M));
  // Again from the same input: the same bytes.
  assert.deepEqual([...applyPlan(files(), plan).changed], [...res.changed]);
  // Offsets alone are a fix.
  const only = applyPlan(files(), { rows: [], skipped: [], offsets: plan.offsets.slice(0, 1) });
  assert.equal(only.changed.size, 1);
});

test('verdict and message: rewritten offsets must read ok on the rebuilt source; the rest keep it PARTIAL', () => {
  const applied = {
    hasReference: false, skipped: [], rows: [],
    offsets: [
      { key: ALPHA, anchor: 'a', old: 0x78, new: 0x80, status: 'applied', file: 'src/wave.cpp', line: 1 },
      { key: 'UObj::Beta', anchor: 'b', old: 1, new: 2, status: 'skipped', reason: 'x' },
    ],
  };
  const after = (...states) => ({ results: states.map(([key, anchor, state]) => ({ key, anchor, state })) });
  assert.equal(verdictOf(applied, { offsetsAfter: after([ALPHA, 'a', 'ok']) }).verdict, 'FIXED');
  // Other offsets still failing: PARTIAL.
  assert.equal(verdictOf(applied, { offsetsAfter: after([ALPHA, 'a', 'ok'], ['UObj::Beta', 'b', 'split']) }).verdict, 'PARTIAL');
  // The rewritten one is still not ok, or was never re-checked: FAILED.
  assert.equal(verdictOf(applied, { offsetsAfter: after([ALPHA, 'a', 'wrong']) }).verdict, 'FAILED');
  assert.equal(verdictOf(applied, { offsetsAfter: after(['UObj::Beta', 'b', 'ok']) }).verdict, 'FAILED');
  assert.equal(verdictOf(applied, {}).verdict, 'FAILED');
  assert.equal(verdictOf({ ...applied, offsets: [applied.offsets[1]] }, {}).verdict, 'NO-FIX');
  // A pattern row that was skipped and still fails keeps an offsets-only fix PARTIAL,
  // whether the rebuilt plugin's scan says so or there is no scan to say otherwise.
  const skippedRow = { rows: [{ name: 'PatB', status: 'skipped' }], skipped: [{ name: 'PatB' }] };
  const offsOnly = { ...applied, ...skippedRow, offsets: [applied.offsets[0]] };
  const rebuilt = (result) => ({ verdict: result === 'OK' ? 'PASS' : 'FAIL', patterns: [{ call: 'Resolve', name: 'PatB', recorded: true, result }] });
  assert.equal(verdictOf(offsOnly, { offsetsAfter: after([ALPHA, 'a', 'ok']) }).verdict, 'PARTIAL');
  assert.equal(verdictOf(offsOnly, { target: rebuilt('MISSING'), offsetsAfter: after([ALPHA, 'a', 'ok']) }).verdict, 'PARTIAL');
  assert.equal(verdictOf(offsOnly, { target: rebuilt('OK'), offsetsAfter: after([ALPHA, 'a', 'ok']) }).verdict, 'FIXED');
  const msg = commitMessage(applied, { cl: '128786' });
  assert.match(msg, /^Update offsets for CL-128786\n/);
  assert.match(msg, /UObj::Alpha\n {2}offset 0x78 -> 0x80 \(src\/wave\.cpp:1\)/);
  assert.ok(!msg.includes('UObj::Beta'));
});
