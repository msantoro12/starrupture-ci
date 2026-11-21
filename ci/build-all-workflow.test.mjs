// Tests for the loader repository input of the build-all workflow (.github/workflows/sr-build-all.yml).
//
//   node --test ci/build-all-workflow.test.mjs
//
// Reads the workflow as text: the loader_repo input, its default, the allowlist
// that fails the job early, and that the loader checkouts use it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wf = readFileSync(join(here, '..', '.github', 'workflows', 'sr-build-all.yml'), 'utf8').replace(/\r\n/g, '\n');
const section = (start, end) => wf.slice(wf.indexOf(start), wf.indexOf(end, wf.indexOf(start)));
const call = section('  workflow_call:\n', '  schedule:\n');
const dispatch = section('  workflow_dispatch:\n', '  workflow_call:\n');
const job = (name) => {
  const rest = wf.slice(wf.indexOf(`\n  ${name}:\n`) + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

test('loader_repo: an optional input on dispatch and call, blank by default', () => {
  for (const s of [call, dispatch]) assert.match(s, /loader_repo:\n(?:.*\n)*?\s+type: string\n\s+default: ''/);
});

test('loader_repo: blank resolves to the old expression, MOD_OWNER or AlienXAXS plus StarRupture-ModLoader', () => {
  assert.match(wf, /LOADER_REPO: \$\{\{ inputs\.loader_repo \|\| format\('\{0\}\/StarRupture-ModLoader', vars\.MOD_OWNER \|\| 'AlienXAXS'\) \}\}/);
  assert.match(wf, /OWNER: \$\{\{ vars\.MOD_OWNER \|\| 'AlienXAXS' \}\}/);
});

test('loader_repo: the allowlist fails both loader-checkout jobs before the checkout', () => {
  for (const name of ['interface', 'loader']) {
    const j = job(name);
    const check = j.indexOf('- name: Check the loader repository');
    assert.ok(check >= 0, `${name}: has the check`);
    assert.ok(check < j.indexOf('actions/checkout'), `${name}: check runs before the checkout`);
    const body = j.slice(check, j.indexOf('actions/checkout'));
    assert.match(body, /''\|msantoro12\/StarRupture-ModLoader\|AlienXAXS\/StarRupture-ModLoader\) ;;/);
    assert.match(body, /\*\) echo "::error::loader_repo .* is not allowed.*exit 1/);
  }
});

test('loader_repo: every loader checkout and the compiled-in feed use it, none the bare owner', () => {
  assert.ok(!/repository: \$\{\{ env\.OWNER \}\}\/StarRupture-ModLoader/.test(wf));
  assert.equal(wf.match(/repository: \$\{\{ env\.LOADER_REPO \}\}\n\s+ref: \$\{\{ inputs\.loader_branch \|\| 'main' \}\}/g)?.length, 2);
  assert.match(wf, /manifest_url: .*\$\{\{ env\.LOADER_REPO \}\}\/releases/);
});

test('loader_branch: documented as accepting a full commit sha, and the loader job logs the repo and HEAD', () => {
  assert.match(dispatch, /loader_branch:\n\s+description: 'ModLoader branch or full commit sha'/);
  const j = job('loader');
  const at = j.indexOf('- name: Log what was checked out');
  assert.ok(at > j.indexOf('actions/checkout'));
  assert.match(j.slice(at), /echo "Loader \$LOADER_REPO at \$\(git rev-parse HEAD\)"/);
});

test('the loader build steps are the shared action, which the candidate job of the client check uses too', () => {
  const j = job('loader');
  assert.ok(j.indexOf('actions/checkout') < j.indexOf('- name: Check out the build action'), 'the action is checked out after the loader (the loader checkout cleans the workspace)');
  assert.match(j, /- name: Check out the build action\n\s+uses: actions\/checkout@[^\n]+\n\s+with:\n\s+path: ci-actions\n\s+sparse-checkout: \.github\/actions\n/);
  assert.match(j, /uses: \.\/ci-actions\/\.github\/actions\/build-loader\n\s+with:\n\s+configuration: \$\{\{ matrix\.config \}\}\n\s+build_tag: ci-\$\{\{ github\.run_number \}\}\n/);
  assert.ok(!/msbuild /.test(j), 'no msbuild call is left in the loader job');
  const action = readFileSync(join(here, '..', '.github', 'actions', 'build-loader', 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
  for (const arg of ['/p:Configuration="$env:CONFIGURATION"', '/p:Platform=x64', '/p:PostBuildEventUseInBuild=false', '/p:ModLoaderBuildTag="$env:BUILD_TAG"', '/p:AutoUpdateManifestUrl="$env:MANIFEST_URL"', '/m', '/p:CL_MP=true', '/nodeReuse:false']) {
    assert.ok(action.includes(arg), `the action passes ${arg}`);
  }
  assert.match(action, /microsoft\/setup-msbuild@[0-9a-f]{40}/);
  const client = readFileSync(join(here, '..', '.github', 'workflows', 'sr-client-check.yml'), 'utf8');
  assert.ok(client.includes('uses: ./ci-actions/.github/actions/build-loader'), 'the candidate job builds with it');
});

test('plugin job: a Server Release build runs only for a plugin whose solution has the configuration', () => {
  const j = job('plugin');
  const detect = j.indexOf('- name: Look for a Server Release configuration');
  assert.ok(detect > j.indexOf('- name: Read the plugin version'), 'the check runs after the version step');
  assert.ok(detect < j.indexOf('- name: Build Client Release'), 'and before the builds, so the client build is untouched');
  assert.match(j.slice(detect), /id: server\n\s+shell: pwsh\n\s+run: \|\n(?:.*\n)*?\s+\$has = Select-String -Path "\$\{\{ matrix\.sln \}\}" -SimpleMatch 'Server Release\|x64' -Quiet\n(?:.*\n)*?\s+"present=/);
  const step = j.slice(j.indexOf('- name: Build Server Release'), j.indexOf('- name: Upload server build'));
  assert.match(step, /if: \$\{\{ !cancelled\(\) && steps\.server\.outputs\.present == 'true' \}\}/);
  for (const arg of ['/p:Configuration="Server Release"', '/p:Platform=x64', '/p:PostBuildEventUseInBuild=false', '/p:ModLoaderBuildTag="$env:BUILD_TAG"', '/p:GameSDKRoot="${{ github.workspace }}\\game-sdk"', '/p:PluginSDKInclude="${{ github.workspace }}\\plugin-sdk\\include"']) {
    assert.ok(step.includes(arg), `the server build passes ${arg}`);
  }
  assert.ok(!/continue-on-error/.test(j), 'a failing server build fails the job like the client build does');
  assert.match(j, /- name: Upload server build\n\s+if: \$\{\{ steps\.server\.outputs\.present == 'true' \}\}\n\s+uses: actions\/upload-artifact@[^\n]+\n\s+with:\n\s+name: \$\{\{ matrix\.name \}\}-server\n\s+path: build\/Server Release\/Plugins\/\$\{\{ matrix\.dll \}\}\n/);
});

test('plugin job: the client build and its artifact are as before', () => {
  const j = job('plugin');
  assert.match(j, /- name: Build Client Release\n\s+shell: pwsh\n\s+env:\n\s+BUILD_TAG: \$\{\{ steps\.ver\.outputs\.build_tag \}\}\n\s+run: \|\n\s+msbuild "\$\{\{ matrix\.sln \}\}" `\n\s+\/p:Configuration="Client Release" `/);
  assert.match(j, /- name: Upload build\n\s+uses: actions\/upload-artifact@[^\n]+\n\s+with:\n\s+name: \$\{\{ matrix\.name \}\}\n\s+path: build\/Client Release\/Plugins\/\$\{\{ matrix\.dll \}\}\n/);
});

test('only the Server Release leg compiles in the server version map URL, from the loader repository like the manifest URL', () => {
  const j = job('loader');
  assert.match(j, /- name: loader-client\n\s+config: Client Release\n\s+manifest: manifest-client\.json\n\s+- name: loader-server\n\s+config: Server Release\n\s+manifest: manifest-server\.json\n\s+vmap_server_feed: version-map-server\.v1\.txt\n/);
  assert.equal(j.match(/vmap_server_feed\b/g)?.length, 3, 'one matrix key (server entry), used twice in the one expression');
  assert.match(j, /vmap_server_feed_url: \$\{\{ matrix\.vmap_server_feed && format\('\{0\}\/\{1\}\/releases\/latest\/download\/\{2\}', github\.server_url, env\.LOADER_REPO, matrix\.vmap_server_feed\) \|\| '' \}\}\n/);
  const action = readFileSync(join(here, '..', '.github', 'actions', 'build-loader', 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(action, /vmap_server_feed_url:\n(?:.*\n)*?\s+default: ''/);
  assert.ok(action.includes('/p:VmapServerFeedUrl=$($env:VMAP_SERVER_FEED_URL)'), 'passed as VmapServerFeedUrl');
  assert.ok(action.includes('if ($env:VMAP_SERVER_FEED_URL)'), 'only when set');
  assert.ok(!/VmapServerFeedUrl/.test(wf), 'the workflow itself never passes it to the client leg');
});
