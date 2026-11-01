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
