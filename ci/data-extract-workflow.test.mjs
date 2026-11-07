// Tests for the data-extract workflow (.github/workflows/sr-data-extract.yml) and for how the
// client rig relates to it.
//
//   node --test ci/data-extract-workflow.test.mjs
//
// Reads the workflows and the launch script as text: the rig never runs a payload, the
// pull_request trigger reaches only the secret-free build job, the Steam job is never started
// by a pull request, and the payload path is checked before anything is installed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const extract = read('.github', 'workflows', 'sr-data-extract.yml');
const rig = read('.github', 'workflows', 'sr-client-rig.yml');
// The launch script without its comment lines: a call that is commented out must not count.
const launch = read('ci', 'client-rig-launch.ps1').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const noComments = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const at = extract.indexOf('\njobs:\n');
const header = noComments(extract.slice(0, at));
const jobs = noComments(extract.slice(at));
const buildAt = jobs.indexOf('\n  build:\n');
const extractAt = jobs.indexOf('\n  extract:\n');
assert.ok(buildAt >= 0 && extractAt > buildAt, 'the workflow has a build job, then an extract job');
const buildJob = jobs.slice(buildAt, extractAt);
const extractJob = jobs.slice(extractAt);

test('the client rig workflow never passes -PayloadScript', () => {
  assert.ok(!/-Payload/i.test(rig), 'sr-client-rig.yml must not pass -PayloadScript (or an abbreviation of it)');
  assert.match(rig, /client-rig-launch\.ps1/, 'the rig still runs the launch script');
});

test('only the data-extract workflow passes -PayloadScript, and only in its extract job', () => {
  assert.ok(!/PayloadScript/.test(buildJob), 'the build job does not launch anything');
  assert.match(extractJob, /-Phase Launch [^\n]*-PayloadScript \.\/ci\/data\/dump-usmap\.ps1/);
  assert.equal(extractJob.match(/-PayloadScript/g).length, 1, 'one launch with a payload');
});

test('the launch script checks the payload path against the workspace before anything runs', () => {
  assert.match(launch, /function Resolve-PayloadScript\b/);
  assert.match(launch, /Resolve-PayloadScript \$PayloadScript \$env:GITHUB_WORKSPACE/);
  // The call sits inside the try, ahead of the Install / Launch switch.
  const call = launch.indexOf('Resolve-PayloadScript $PayloadScript $env:GITHUB_WORKSPACE');
  const sw = launch.indexOf('switch ($Phase)');
  assert.ok(call > 0 && sw > call, 'resolved before the phase runs');
  assert.ok(launch.lastIndexOf('\ntry {', call) > launch.lastIndexOf('\nfunction ', call), 'inside the try block');
  // The validator refuses what the owner named: URLs, paths outside the workspace, links.
  const fn = launch.slice(launch.indexOf('function Resolve-PayloadScript'), launch.indexOf('function Find-GameDialog'));
  assert.match(fn, /\[A-Za-z\]\[A-Za-z0-9\+\.-\]\+:/, 'a URL scheme is refused');
  assert.match(fn, /StartsWith\(\$base \+/, 'a path outside the workspace is refused');
  assert.match(fn, /LinkType/, 'a link is refused');
  assert.match(fn, /ReparsePoint/, 'a junction or symlink in a parent directory is refused');
  assert.match(fn, /\.ps1/, 'only a .ps1 is accepted');
  // And the -Check run exercises it.
  assert.match(launch, /the payload path '\$bad' was accepted/);
  assert.match(launch, /a path through a junction was accepted/);
});

test('triggers: pull_request only for the build-only check, never pull_request_target or push', () => {
  const on = header.slice(header.indexOf('\non:\n'), header.indexOf('\npermissions:'));
  assert.match(on, /\n {2}pull_request:\n/);
  assert.match(on, /\n {2}workflow_dispatch:\n/);
  assert.match(on, /\n {2}workflow_call:\n/);
  for (const bad of ['pull_request_target', 'push', 'schedule', 'workflow_run', 'issue_comment']) {
    assert.ok(!new RegExp(`\\n {2}${bad}:`).test(on), `no ${bad} trigger`);
  }
  assert.match(on, /pull_request:\n {4}paths:\n(?: {6}- .*\n)+/, 'the pull_request trigger is path-filtered');
});

test('permissions: contents read for the whole workflow, nothing wider anywhere', () => {
  assert.match(header, /\npermissions:\n {2}contents: read\n/);
  const grants = [...jobs.matchAll(/^ +permissions:\n((?: {6,}[a-z-]+: .*\n)+)/gm)].flatMap((m) => m[1].trim().split('\n').map((l) => l.trim()));
  assert.ok(grants.length > 0);
  for (const g of grants) assert.equal(g, 'contents: read', `job grant ${g}`);
  assert.ok(!/^ +[a-z-]+: (write|write-all)\s*$/m.test(header + jobs), 'no write grant');
});

test('the Steam job is never started by a pull request, on top of the environment rule', () => {
  const head = extractJob.slice(0, extractJob.indexOf('\n    steps:\n'));
  assert.match(head, /\n {4}if: github\.event_name != 'pull_request' && !inputs\.build_only\n/);
  assert.match(head, /\n {4}environment: steam-client\n/);
  assert.match(head, /\n {4}needs: build\n/);
  assert.ok(!/\n {4}environment:/.test(buildJob), 'the build job has no environment');
});

test('the build job (the one a pull request runs) reads no secret and no secret reaches it', () => {
  const head = header + buildJob;
  assert.ok(!/\bsecrets\./.test(head), 'no secrets.* expression above the extract job');
  assert.ok(!/\bsecrets:\s*inherit/.test(head), 'no secrets: inherit');
  assert.ok(!/STEAM_(USER|CACHE|CI_)/.test(buildJob), 'no Steam login name in the build job');
  assert.ok(!/\bGITHUB_TOKEN\b|github\.token/.test(buildJob), 'no token passed to the build job');
  assert.ok(!/\bsecrets\b/.test(buildJob.replace(/#.*$/gm, '')), 'the build job never names the secrets context');
  // The secrets are read only in the extract job, and only for the login-holding steps.
  assert.ok(/\bsecrets\.STEAM_CI_LOGIN_CACHE\b/.test(extractJob));
  // Every checkout drops its credentials.
  const checkouts = buildJob.match(/actions\/checkout@/g).length;
  assert.equal(buildJob.match(/persist-credentials: false/g).length, checkouts);
});

test('the extractor runs only after a successful cleanup', () => {
  const s = extractJob.split('\n      - ').find((x) => x.startsWith('name: Run the extractor\n'));
  assert.ok(s, 'the extractor step exists');
  assert.match(s, /\n {8}if: always\(\) && steps\.usmap\.outputs\.ok == 'true' && steps\.cleanup\.outcome == 'success'\n/);
  assert.ok(extractJob.indexOf('id: cleanup') < extractJob.indexOf('id: extract'), 'cleanup comes first');
});

test('the build steps that compile pinned sources have a timeout', () => {
  for (const name of ['Build Dumper-7', 'Build the extractor']) {
    const s = buildJob.split('\n      - ').find((x) => x.startsWith(`name: ${name}\n`));
    assert.ok(s, `step ${name} exists`);
    assert.match(s, /\n {8}timeout-minutes: \d+\n/, `${name} has a step timeout`);
  }
  assert.match(buildJob, /\n {4}timeout-minutes: \d+\n/, 'the build job has a timeout');
});
