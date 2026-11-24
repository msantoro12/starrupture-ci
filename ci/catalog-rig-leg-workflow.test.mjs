// Tests for the plugin catalog leg of the client check (the catalog-plan and catalog jobs of
// .github/workflows/sr-client-check.yml): when each job runs, what it reads, that it publishes only to the
// rehearsal prerelease through sr-plugin-catalog.yml and never sets `live`.
//
//   node --test ci/catalog-rig-leg-workflow.test.mjs
//
// Reads the workflows as text, the way ci/client-check-workflow.test.mjs does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const wf = read('.github', 'workflows', 'sr-client-check.yml');
const catalogWf = read('.github', 'workflows', 'sr-plugin-catalog.yml');
// A job runs to the next job key (two-space indent) or the end of the file.
const job = (name) => {
  const rest = wf.slice(wf.indexOf(`\n  ${name}:\n`) + 1);
  assert.ok(rest.length > 0 && wf.includes(`\n  ${name}:\n`), `job ${name} exists`);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const plan = job('catalog-plan');
const publishJob = job('catalog');
const stepOf = (j, name) => {
  const at = j.indexOf(`- name: ${name}\n`);
  assert.ok(at > 0, `step "${name}" exists`);
  const next = j.indexOf('\n      - ', at + 1);
  return j.slice(at, next < 0 ? undefined : next);
};
const jobIf = (j) => j.match(/\n {4}if: (\$\{\{ .* \}\})\n/)[1];
// The same expression subset ci/client-check-workflow.test.mjs evaluates: && || ! == != and string literals.
const evalExpr = (expr, ctx) => {
  const js = expr.replace(/^\$\{\{ /, '').replace(/ \}\}$/, '')
    .replace(/!cancelled\(\)/g, 'true')
    .replace(/needs\.([\w-]+)\./g, 'needs["$1"].')
    .replace(/!=/g, '!==').replace(/([^=!<>])==(?!=)/g, '$1===');
  return new Function('needs', 'inputs', `return (${js});`)(ctx.needs, ctx.inputs);
};
const okNeeds = () => ({
  'map-mode': { result: 'success', outputs: { test: 'false' } },
  publish: { result: 'success', outputs: {} },
  'rig-branch': { result: 'success', outputs: { verdict: 'PASS', artifact: 'sr-client-rig-public-x-1-1' } },
  'rig-other': { result: 'success', outputs: { verdict: 'PASS', artifact: 'sr-client-rig-public_test_branch-x-1-1' } },
});
const okInputs = () => ({ publish: true, test_autopilot: false, proof_run: false, branch: 'public' });

test('catalog-plan runs for a public, publish-on, non-test run whose public rig passed, and for nothing else', () => {
  const run = (needs, inputs) => evalExpr(jobIf(plan), { needs, inputs });
  assert.equal(run(okNeeds(), okInputs()), true);
  assert.equal(run({ ...okNeeds(), publish: { result: 'skipped', outputs: {} } }, okInputs()), true, 'a feed that was not published (held) does not stop the catalog');
  assert.equal(run({ ...okNeeds(), 'rig-other': { result: 'skipped', outputs: {} } }, okInputs()), true, 'no second rig is fine');
  assert.equal(run({ ...okNeeds(), 'rig-other': { result: 'failure', outputs: { verdict: 'FAIL', artifact: '' } } }, okInputs()), true, 'a failed second rig only leaves its dump out');
  const no = (needs, inputs, why) => assert.equal(run(needs, inputs), false, why);
  no(okNeeds(), { ...okInputs(), branch: 'public_test_branch' }, 'public only');
  no(okNeeds(), { ...okInputs(), publish: false }, 'publish off');
  no(okNeeds(), { ...okInputs(), test_autopilot: true }, 'a test run');
  no(okNeeds(), { ...okInputs(), proof_run: true }, 'a proof run');
  no({ ...okNeeds(), 'map-mode': { result: 'success', outputs: { test: 'true' } } }, okInputs(), 'map-mode marks it a test run');
  no({ ...okNeeds(), 'map-mode': { result: 'skipped', outputs: {} } }, okInputs(), 'no chain');
  no({ ...okNeeds(), publish: { result: 'failure', outputs: {} } }, okInputs(), 'the feed publish failed');
  no({ ...okNeeds(), 'rig-branch': { result: 'success', outputs: { verdict: 'FAIL' } } }, okInputs(), 'the public rig failed');
  no({ ...okNeeds(), 'rig-branch': { result: 'failure', outputs: { verdict: 'PASS' } } }, okInputs(), 'the public rig job failed');
  no({ ...okNeeds(), 'rig-branch': { result: 'skipped', outputs: {} } }, okInputs(), 'the public rig did not run');
  assert.match(job('catalog-plan'), /\n {4}needs: \[map-mode, publish, rig-branch, rig-other\]\n/);
});

test('catalog runs only when the plan says changed; it calls the catalog workflow with the audit artifact, the key by name and no live', () => {
  const run = (plan) => evalExpr(jobIf(publishJob), { needs: { 'catalog-plan': plan }, inputs: {} });
  assert.equal(run({ result: 'success', outputs: { state: 'changed' } }), true);
  for (const state of ['unchanged', 'skip', '']) assert.equal(run({ result: 'success', outputs: { state } }), false, `state "${state}"`);
  assert.equal(run({ result: 'failure', outputs: { state: 'changed' } }), false);
  assert.equal(run({ result: 'skipped', outputs: {} }), false);
  assert.match(publishJob, /\n {4}needs: \[catalog-plan\]\n/);
  assert.match(publishJob, /\n {4}uses: \.\/\.github\/workflows\/sr-plugin-catalog\.yml\n/);
  assert.match(publishJob, /\n {4}with:\n {6}catalog_artifact: \$\{\{ needs\.catalog-plan\.outputs\.artifact \}\}\n/);
  assert.match(publishJob, /\n {4}secrets:\n {6}VMAP_SIGN_KEY: \$\{\{ secrets\.VMAP_SIGN_KEY \}\}\n/);
  assert.ok(!/inherit/.test(publishJob), 'secrets by name');
  assert.ok(!/\blive\b/.test(publishJob.replace(/#.*\n/g, '')), 'the live input is never set (a call cannot reach it)');
  assert.match(publishJob, /\n {4}permissions:\n {6}contents: write\n/);
});

test('catalog-plan reads this run\'s rig artifacts, the rehearsal prerelease only, and keeps the audit copy for 14 days', () => {
  assert.match(plan, /\n {4}permissions:\n {6}contents: read\n/);
  assert.ok(!/contents: write/.test(plan), 'the plan writes nothing to the repository');
  const reads = [...plan.matchAll(/name: \$\{\{ (needs\.[\w-]+\.outputs\.artifact) \}\}\n\s+path: (rigs\/\w+)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(reads, [['needs.rig-branch.outputs.artifact', 'rigs/branch'], ['needs.rig-other.outputs.artifact', 'rigs/other']]);
  assert.match(stepOf(plan, 'Download the logs of the rig of the other branch'), /if: \$\{\{ needs\.rig-other\.result == 'success' && needs\.rig-other\.outputs\.verdict == 'PASS' && /);
  assert.ok(!/run-id|github-token/.test(plan), 'artifacts of this run only');
  assert.match(plan, /\n {6}STAGING_RELEASE: vmap-feed-rehearsal\n/);
  const pubStep = stepOf(plan, 'Read the catalog the rehearsal prerelease holds');
  assert.ok(pubStep.includes('gh release view "$STAGING_RELEASE"') && pubStep.includes('gh release download "$STAGING_RELEASE" --pattern plugin-catalog.v1.txt'));
  assert.ok(!/vmap-feed(?!-rehearsal)/.test(plan.replace(/#.*\n/g, '')), 'the live release is not named');
  assert.ok(!/gh release (upload|create|edit|delete)|gh api|git push|--clobber.*upload/.test(plan), 'the plan only reads');
  const build = stepOf(plan, 'Build the catalog input and compare');
  assert.ok(build.includes('node tool/ci/catalog-from-dumps.mjs dumps/* --out catalog-in.json --published published/plugin-catalog.v1.txt --verdict verdict.txt --expect-plugins tool/ci/plugin-names.json'));
  const up = stepOf(plan, 'Upload the dumps and the catalog input');
  assert.ok(up.includes('name: catalog-input-${{ inputs.branch }}') && up.includes('retention-days: 14'));
  for (const f of ['dumps/', 'catalog-in.json', 'verdict.txt', 'notes.txt']) assert.ok(new RegExp(`\\n\\s+${f.replace('.', '\\.')}\\n`).test(up), `${f} is in the audit copy`);
  assert.match(up, /if: \$\{\{ steps\.plan\.outputs\.state == 'changed' \|\| steps\.plan\.outputs\.state == 'unchanged' \}\}/);
  assert.match(plan, /AUDIT_ARTIFACT: catalog-input-\$\{\{ inputs\.branch \}\}/);
  assert.ok(build.includes('echo "artifact=$AUDIT_ARTIFACT"'), 'the call is handed the artifact the audit copy is uploaded as');
});

test('no dump ends the plan green with a note and no publish; a generator refusal fails it', () => {
  const build = stepOf(plan, 'Build the catalog input and compare');
  assert.match(build, /DUMP_COUNT: \$\{\{ steps\.dumps\.outputs\.count \}\}/);
  assert.ok(build.includes('if [ "$DUMP_COUNT" = 0 ]; then') && build.includes('echo "state=skip" >> "$GITHUB_OUTPUT"') && /state=skip[\s\S]*?\n\s+exit 0\n\s+fi/.test(build), 'no dump: state skip, exit 0');
  assert.ok(build.includes('No dump:'), 'the note says why');
  assert.ok(build.includes('|| { cat generator.err >&2; exit 2; }'), 'a refused dump set (same CL, different content) fails the job');
  assert.ok(build.includes('changed|unchanged) ;;') && build.includes('exit 2'), 'only changed or unchanged is accepted');
  const published = stepOf(plan, 'Read the catalog the rehearsal prerelease holds');
  assert.match(published, /if: \$\{\{ steps\.dumps\.outputs\.count != '0' \}\}/, 'no dump: nothing is read');
  assert.match(stepOf(plan, 'Upload the dumps and the catalog input'), /steps\.plan\.outputs\.state == 'changed'/);
});

test('no new trigger, no input in a run block, pinned actions, and the plan is not an alert input', () => {
  const on = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\npermissions: {}'));
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):\n/gm)].map((m) => m[1]), ['workflow_call', 'workflow_dispatch', 'schedule'], 'the triggers are the same as before this leg');
  for (const [name, j] of [['catalog-plan', plan]]) {
    for (const m of j.matchAll(/\n( +)run: \|\n((?:\1 .*\n|\n)*)/g)) assert.ok(!m[2].includes('${{'), `${name}: ${m[2].split('\n').find((l) => l.includes('${{'))}`);
    for (const m of j.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${name}: ${m[1]} is pinned to a sha`);
    assert.ok(!/persist-credentials: true/.test(j));
  }
  assert.ok((plan.match(/persist-credentials: false/g) ?? []).length === (plan.match(/uses: actions\/checkout@/g) ?? []).length);
  assert.ok(!/\[[^\]]*catalog-plan[^\]]*\]/.test(job('alert').match(/\n {4}needs: .*\n/)[0]), 'the alert does not need the catalog leg');
  assert.ok(!/Co-Authored|Generated with/.test(plan + publishJob));
  const callers = wf.match(/uses: \.\/\.github\/workflows\/sr-plugin-catalog\.yml/g) ?? [];
  assert.equal(callers.length, 1, 'one call of the catalog workflow');
});
