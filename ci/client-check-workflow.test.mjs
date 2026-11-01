// Tests for the client check workflow's run inputs (.github/workflows/sr-client-check.yml).
//
//   node --test ci/client-check-workflow.test.mjs
//
// Reads the workflow as text: the Game SDK repository input, the plugin
// exclusion list and the dispatch-only test-autopilot switch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wf = readFileSync(join(here, '..', '.github', 'workflows', 'sr-client-check.yml'), 'utf8').replace(/\r\n/g, '\n');
const section = (start, end) => wf.slice(wf.indexOf(start), wf.indexOf(end, wf.indexOf(start)));
const call = section('  workflow_call:\n', '  workflow_dispatch:\n');
const dispatch = section('  workflow_dispatch:\n', '  schedule:\n');
// A job runs to the next job key (two-space indent) or the end of the file.
const job = (name) => {
  const rest = wf.slice(wf.indexOf(`\n  ${name}:\n`) + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

test('game_sdk_repo: both triggers default to the upstream repository, and the plan allows the same owners as the Plugin SDK', () => {
  for (const s of [call, dispatch]) assert.match(s, /game_sdk_repo:\n(?:.*\n)*?\s+default: 'AlienXAXS\/StarRupture-Game-SDK'/);
  assert.match(job('plugin-plan'), /\$env:GAME_SDK_REPO -notmatch '\^\(msantoro12\|AlienXAXS\)\/StarRupture-Game-SDK\$'/);
  assert.match(wf, /repository: \$\{\{ inputs\.game_sdk_repo \}\}\n\s+ref: \$\{\{ inputs\.game_sdk_ref \}\}/);
  assert.ok(!/Get-Source 'AlienXAXS\/StarRupture-Game-SDK'/.test(wf), 'every later checkout reads the repository plugin.json records');
  assert.match(wf, /gameSdkRepo = \$env:GAME_SDK_REPO/);
  for (const name of ['plugin-plan', 'plugins']) assert.equal(job(name).match(/^\s+GAME_SDK_REPO: /gm)?.length, 1, `${name}: GAME_SDK_REPO set once`);
});

test('plugin_exclude: a name leaves that plugin out, and a name that is in neither list is an error', () => {
  for (const s of [call, dispatch]) assert.match(s, /plugin_exclude:\n(?:.*\n)*?\s+default: ''/);
  const plan = job('plugin-plan');
  assert.match(plan, /\$list = \[Collections\.Generic\.List\[object\]\]@\(\$list \| Where-Object \{ \$_\.name -notin \$exclude \}\)/);
  assert.match(plan, /throw "plugin_exclude names '\$x', which is not in plugins or plugin_manifests"/);
  assert.ok(plan.indexOf('-notin $exclude') < plan.indexOf('Group-Object'), 'excluded before the duplicate check and the matrix');
});

test('rule 3: the plugin build skips the check, its own step reports per plugin, and only a migrated plugin is held, alone', () => {
  const plugins = job('plugins');
  const step = plugins.slice(plugins.indexOf('- name: Check rule 3'), plugins.indexOf('- name: Upload the plugin'));
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /rule3-check\.mjs/);
  assert.ok(step.includes('--plugin $env:NAME --sdk game-sdk\\Client\\SDK --source plugin --mode auto --json out\\rule3.json'), 'scans the plugin checkout against the Client SDK, writing out\\rule3.json');
  const build = plugins.indexOf('/p:Rule3Check=false');
  assert.ok(build > 0 && build < plugins.indexOf('- name: Check rule 3') && plugins.indexOf('- name: Check rule 3') < plugins.indexOf('- name: Upload the plugin'), 'build without the check, then the check, then the upload');
  const check = job('check');
  assert.ok(check.includes("$r3.status -eq 'fail' -and $r.verdict -in 'PASS', 'NONE', 'GAME-CALL', 'FAIL'"), 'only a failing (migrated) plugin gets the verdict');
  assert.ok(check.includes("$r.verdict = 'RULE3'"));
  assert.ok(check.includes("$r3.status -eq 'findings'"), 'a plugin that is not migrated is only reported');
  assert.match(readFileSync(join(here, 'decide.mjs'), 'utf8'), /const PLUGIN_HELD = new Set\(\['REFUSED', 'RULE3', /);
});

test('B5: one plugin that fails to fetch, check out or build never fails the plugins job or holds the others', () => {
  const plugins = job('plugins');
  const step = (name) => {
    const at = plugins.indexOf(`- name: ${name}\n`);
    assert.ok(at > 0, name);
    const next = plugins.indexOf('\n      - name:', at + 1);
    return plugins.slice(at, next < 0 ? undefined : next);
  };
  for (const name of ['Fetch the released plugin', 'Check out the plugin', 'Check out the Plugin SDK', 'Check out the Game SDK',
    "Check out the loader's plugin interface", 'Build the plugin (Client Release)']) {
    assert.match(step(name), /\n        continue-on-error: true\n/, `${name} cannot fail the job`);
  }
  assert.match(step('Upload the plugin'), /if: hashFiles\('out\/plugin\.json'\) != ''/, 'no plugin.json, no artifact, and no failing upload');
  assert.match(step('Upload the plugin'), /if-no-files-found: error/);
  assert.match(step('Note a plugin that did not build'), /if: hashFiles\('out\/plugin\.json'\) == ''/);
  assert.match(plugins, /fail-fast: false/);
  // The missing artifact is graded per plugin in the check job, and the G1 gate is the loader build alone.
  assert.ok(job('check').includes("$r.verdict = if ($p.source -eq 'release') { 'FETCH-FAILED' } else { 'BUILD-FAILED' }"));
  const mm = job('map-mode');
  assert.ok(!/PLUGINS_RESULT/.test(mm), 'the plugins job result is not a gate');
  assert.match(mm, /put\("g1\.json", \{ ok: process\.env\.BUILD_RESULT === "success" \}\);/);
});

test('test_autopilot: dispatch only, refused with publish on, never publishable, and the publish job skips it', () => {
  assert.match(dispatch, /test_autopilot:\n\s+description: .*never publishes.*\n\s+type: boolean\n\s+default: false/);
  assert.ok(!call.includes('test_autopilot'), 'sr-watch calls the workflow and cannot pass it');
  assert.match(job('plugin-plan'), /throw 'test_autopilot needs map_mode on and publish off: a test run never publishes'/);
  const mm = job('map-mode');
  assert.match(mm, /TEST_AUTOPILOT: \$\{\{ inputs\.test_autopilot == true && inputs\.publish != true && contains\(github\.workflow_ref, '\/\.github\/workflows\/sr-client-check\.yml@'\) \}\}/);
  assert.match(mm, /\[ "\$TEST_AUTOPILOT" = true \] && \[ "\$decision" = HOLD \] && \[ "\$would" = M \]/);
  assert.match(mm, /const ok = process\.env\.TEST_AUTOPILOT !== "true" && !p\.test && /);
  assert.match(mm, /--uses res\/layout-uses\.txt/);
  assert.match(job('publish'), /if: \$\{\{ !cancelled\(\) && inputs\.publish == true && inputs\.test_autopilot != true && /);
  assert.match(readFileSync(join(here, '..', 'state', 'autopilot.json'), 'utf8'), /"enabled": false/);
});
