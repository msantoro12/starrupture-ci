// Tests for the rows mode of the engine test (.github/workflows/engine-test.yml).
//
//   node --test ci/engine-test-workflow.test.mjs
//
// Reads the workflow as text: the modes build, vanilla and full keep their conditions, rows
// mode builds the loader with the TEST key define, seeds the signed server file as the
// loader's cache before the boot, and adds the "rows served" arguments to the verdict, and
// nothing in the workflow publishes or uploads the file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wf = readFileSync(join(here, '..', '.github', 'workflows', 'engine-test.yml'), 'utf8').replace(/\r\n/g, '\n');
const jobs = (name) => {
  const rest = wf.slice(wf.indexOf(`\n  ${name}:\n`) + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const step = (job, name) => {
  const at = job.indexOf(`      - name: ${name}\n`);
  assert.ok(at >= 0, `step "${name}" exists`);
  const rest = job.slice(at + 1);
  const next = rest.search(/\n {6}- name: /);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const build = jobs('build');
const engine = jobs('engine');

test('modes: build, vanilla and full are still offered, full is the default, rows is added', () => {
  assert.match(wf, /mode:\n\s+description: 'build \| vanilla \| full \| rows'\n\s+type: choice\n\s+options: \[build, vanilla, full, rows\]\n\s+default: full\n/);
});

test('modes: the build and boot conditions of build, vanilla and full are unchanged', () => {
  assert.match(build, /\n {4}if: \$\{\{ inputs\.mode != 'vanilla' \}\}\n/);
  assert.match(engine, /if: \$\{\{ !cancelled\(\) && inputs\.mode != 'build' && \(needs\.build\.result == 'success' \|\| \(inputs\.mode == 'vanilla' && needs\.build\.result == 'skipped'\)\) \}\}/);
  // The vanilla boot has no loader and the G3 gate is full mode's: rows mode adds nothing to either.
  assert.match(step(engine, 'Gate G3, server exe ProductVersion against the loader\'s required CL'), /if: \$\{\{ inputs\.mode == 'full' \}\}\n/);
  for (const name of ['Download our build outputs', 'Install the loader and WAILA', 'Offline pattern scan of the server exe']) {
    assert.match(step(engine, name), /if: \$\{\{ inputs\.mode == 'full' \|\| inputs\.mode == 'rows' \}\}\n/, name);
  }
  assert.match(step(engine, 'Verdict'), /if: \$\{\{ \(inputs\.mode == 'full' \|\| inputs\.mode == 'rows'\) && !cancelled\(\) \}\}\n/);
});

test('rows inputs: the file URL, the least row count and the optional keys, all strings with safe defaults', () => {
  assert.match(wf, /rows_url:\n(?:\s+description: .*\n)\s+type: string\n\s+default: ''\n/);
  assert.match(wf, /rows_expect:\n(?:\s+description: .*\n)\s+type: string\n\s+default: '1'\n/);
  assert.match(wf, /rows_keys:\n(?:\s+description: .*\n)\s+type: string\n\s+default: ''\n/);
});

test('rows build: the TEST key define is set only in rows mode, through CL, and the build log proves cl.exe read it', () => {
  const s = step(build, 'Build loader Server Release');
  assert.match(s, /\n {10}CL: \$\{\{ inputs\.mode == 'rows' && '\/DVMAP_TRUST_TEST_KEY \/Bt\+' \|\| '' \}\}\n/);
  assert.equal(wf.split('/DVMAP_TRUST_TEST_KEY').length - 1, 1, 'the define is written once');
  assert.match(s, /\/flp:LogFile=/);
  const check = step(build, 'Check the TEST key define reached the compiler');
  assert.match(check, /if: \$\{\{ inputs\.mode == 'rows' \}\}\n/);
  assert.match(check, /version_feed\\\.cpp/);
  assert.match(check, /c1xx\\\.dll/);
  // Only the loader build sets it: the scanner and the plugin build do not.
  assert.equal(build.split('CL: ').length - 1, 1);
});

test('rows seed: runs in rows mode only, after the install and before the boot, and copies the file byte for byte as the server cache', () => {
  const s = step(engine, 'Seed the signed server rows as the loader\'s cache');
  assert.match(s, /\n {8}if: \$\{\{ inputs\.mode == 'rows' \}\}\n/);
  assert.ok(engine.indexOf('- name: Install the loader and WAILA') < engine.indexOf('- name: Seed the signed') && engine.indexOf('- name: Seed the signed') < engine.indexOf('- name: Boot the server headless'));
  assert.match(s, /-notmatch '\^https:\/\//, 'https only');
  assert.match(s, /\\ModLoader\\version-map-server\.v1\.cache/);
  assert.match(s, /Copy-Item -LiteralPath \$tmp -Destination \$cache/);
  assert.match(s, /Get-FileHash -LiteralPath \$cache[^\n]*-ne \$sha\) \{ throw 'the seeded cache is not byte for byte/);
  // The file is judged before it is seeded: format line, seq, signature line, and a build line for the exe's CL.
  assert.match(s, /"format`t1"/);
  assert.match(s, /'\^seq\\t/);
  assert.match(s, /'\^sig\\t\(k\[12\]\)\\t'/);
  assert.match(s, /has no build line for the server exe's CL/);
  for (const o of ['rows_seq', 'rows_key', 'rows_cl']) assert.ok(s.includes(`"${o}=$`), o);
});

test('rows verdict: the rows arguments are passed in rows mode only, from the seed step', () => {
  const s = step(engine, 'Verdict');
  assert.match(s, /ROWS_SEQ: \$\{\{ steps\.rows\.outputs\.rows_seq \}\}/);
  assert.match(s, /ROWS_KEY: \$\{\{ steps\.rows\.outputs\.rows_key \}\}/);
  assert.match(s, /ROWS_CL: \$\{\{ steps\.rows\.outputs\.rows_cl \}\}/);
  assert.match(s, /if \(\$env:MODE -eq 'rows'\) \{\n\s+\$rows = @\{ ExpectRows = \[int\]\$env:ROWS_EXPECT; ExpectedCl = \$env:ROWS_CL; ExpectSeq = \$env:ROWS_SEQ; ExpectKey = \$env:ROWS_KEY \}/);
  assert.match(s, /-ReadyRegex \$env:READY_REGEX @rows\n/);
});

test('rows mode publishes nothing: read-only token, no release or upload of the seeded file', () => {
  assert.match(wf, /\npermissions:\n {2}contents: read\n/);
  assert.ok(!/gh release|gh api|action-gh-release|softprops|vmap-feed|releases\/upload/.test(wf.replace(/#.*\n/g, '\n').replace(/'rows_url'[^\n]*\n/g, '')), 'no release step');
  // The only artifacts are our build outputs and the trimmed logs; the seeded file stays in RUNNER_TEMP.
  const uploads = [...wf.matchAll(/upload-artifact@[^\n]*\n\s+with:\n\s+name: ([^\n]+)\n/g)].map((m) => m[1]);
  assert.deepEqual(uploads, ['engine-test-build', 'engine-test-logs-${{ inputs.mode }}']);
  assert.match(step(engine, 'Seed the signed server rows as the loader\'s cache'), /Join-Path \$env:RUNNER_TEMP 'version-map-server\.staged\.txt'/);
});
