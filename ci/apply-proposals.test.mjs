import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRows, applyPlan, lexLiterals, commitMessage, isPattern } from './apply-proposals.mjs';

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
