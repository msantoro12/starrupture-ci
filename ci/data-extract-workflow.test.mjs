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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
  // The one token use is the read-only job token, for the compare call on the public planner repo.
  const tokenSteps = buildJob.split('\n      - ').filter((s) => /\bGITHUB_TOKEN\b|github\.token/.test(s));
  assert.equal(tokenSteps.length, 1, 'one step is given the job token');
  assert.ok(tokenSteps[0].startsWith('name: Check the extractor is on planner main\n'), 'and it is the reachability check');
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

// ---- S1: the extractor must be reachable from planner main -------------------------------------

const stepOf = (job, name) => {
  const s = job.split('\n      - ').find((x) => x.startsWith(`name: ${name}\n`));
  assert.ok(s, `step ${name} exists`);
  return s;
};
// The text of a step's `run: |` block, de-indented.
const runBlock = (s) => s.slice(s.indexOf('run: |\n') + 'run: |\n'.length).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');

test('no default extractor sha for a run that holds the login; callers must pass one', () => {
  const dispatch = header.slice(header.indexOf('\n  workflow_dispatch:'), header.indexOf('\n  workflow_call:'));
  const call = header.slice(header.indexOf('\n  workflow_call:'));
  for (const [name, block] of [['dispatch', dispatch], ['call', call]]) {
    const inp = block.slice(block.indexOf('extractor_ref:'), block.indexOf('\n', block.indexOf('required:', block.indexOf('extractor_ref:'))) + 1 || undefined);
    assert.match(inp, /required: true/, `${name}: extractor_ref is required`);
    assert.ok(!/default:/.test(inp.split('\n').slice(0, 5).join('\n')), `${name}: extractor_ref has no default`);
  }
  // The only place a sha is written down is the pull-request compile check, guarded by the event.
  const shas = [...(buildJob + extractJob).matchAll(/'([0-9a-f]{40})'/g)].map((m) => m[1]);
  assert.deepEqual(shas, ['ffc6eebd98b589bc53942de29ef3e76bebda9521']);
  assert.match(buildJob, /EXTRACTOR_REF: \$\{\{ inputs\.extractor_ref \|\| \(github\.event_name == 'pull_request' && 'ffc6eebd98b589bc53942de29ef3e76bebda9521' \|\| ''\) \}\}/);
  assert.ok(!/ffc6eebd/.test(extractJob), 'the extract job never names a sha');
});

test('the build job checks the extractor against planner main, failing closed, before it checks it out', () => {
  const s = stepOf(buildJob, 'Check the extractor is on planner main');
  assert.match(s, /\n {8}if: env\.BUILD_ONLY != 'true'\n/, 'every run that can hold the login is checked');
  assert.match(s, /compare\/\$\(\$env:EXTRACTOR_REF\)\.\.\.main/, 'base is the sha, head is main');
  assert.match(s, /-notin 'identical', 'ahead'/, 'accepted: identical or ahead');
  assert.match(s, /\$LASTEXITCODE -ne 0 -or -not \$status\) \{ throw /, 'an API error stops the run');
  assert.ok(buildJob.indexOf('Check the extractor is on planner main') < buildJob.indexOf('Check out the extractor'), 'checked before checkout');
  assert.ok(buildJob.indexOf('Check the inputs') < buildJob.indexOf('Check the extractor is on planner main'));
});

test('the workflow is honest about the secrets: trust comes from the reachability check', () => {
  assert.ok(!/no secret in reach/i.test(extract), 'no claim that no secret is in reach');
  assert.match(extract, /# TRUST\./);
  assert.match(extract, /stay\n# in its memory for the whole job/);
});

// ---- S2: a re-run of only the failed extract job ------------------------------------------------

test('the tools artifact is named by the run id alone and handed on as a build output', () => {
  assert.ok(!/run_attempt/.test(extract), 'no attempt number in any name');
  assert.match(buildJob, /TOOLS_ARTIFACT: sr-data-tools-\$\{\{ github\.run_id \}\}\n/);
  assert.match(buildJob, /tools_artifact: \$\{\{ steps\.pins\.outputs\.tools_artifact \}\}/);
  assert.match(extractJob, /TOOLS_ARTIFACT: \$\{\{ needs\.build\.outputs\.tools_artifact \}\}/);
  assert.match(extractJob, /EXTRACTOR_REF: \$\{\{ needs\.build\.outputs\.extractor_ref \}\}/);
  assert.match(extractJob, /DUMPER7_COMMIT: \$\{\{ needs\.build\.outputs\.dumper7_commit \}\}/);
  // A re-run of all jobs uploads the same name again: replace it.
  assert.match(stepOf(buildJob, 'Hand the binaries to the extract job'), /overwrite: true/);
});

// ---- S3: a Steam sign-in failure has its own status ---------------------------------------------

test('login failures leave a marker in the launch script and surface as login-failed', () => {
  assert.match(launch, /function Stop-WithLogin\b/);
  assert.match(launch, /rig-login-failed\.txt/);
  for (const m of ['Steam rejected the saved CI login', 'Steam asked for a Guard code', 'The Steam client did not sign in', 'Steam rate-limited the CI login']) {
    assert.match(launch, new RegExp(`Stop-WithLogin [^\\n]*${m}`), `${m} is a login failure`);
  }
  assert.match(extract, /ok \| login-failed \| usmap-failed \| extract-failed/);
  assert.match(extract, /ok, login-failed, usmap-failed or extract-failed/);
});

// Runs the "Outputs and result" step for a made-up state; returns its status output and exit code.
function finalStatus({ login = false, boot = null, usmapOk = '', upload = '', stage = '' }) {
  const dir = mkdtempSync(join(tmpdir(), 'sr-final-'));
  try {
    const temp = join(dir, 'tmp');
    const work = join(dir, 'work');
    mkdirSync(temp);
    mkdirSync(join(work, 'out'), { recursive: true });
    if (login) writeFileSync(join(temp, 'rig-login-failed.txt'), 'login');
    if (boot !== null) writeFileSync(join(work, 'out', 'boot.json'), JSON.stringify(boot));
    const outFile = join(dir, 'output.txt');
    writeFileSync(outFile, '');
    const env = { ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), BUILDID: '123', STAGE_STATUS: stage, USMAP_OK: usmapOk, UPLOAD: upload };
    const script = runBlock(stepOf(extractJob, 'Outputs and result'));
    writeFileSync(join(dir, 'step.ps1'), script);
    for (const exe of ['pwsh', 'powershell']) {
      const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-File', join(dir, 'step.ps1')], { encoding: 'utf8', env, cwd: work, windowsHide: true });
      if (r.error) continue;
      // Windows PowerShell 5.1 appends UTF-16; pwsh 7 (the runner's) appends UTF-8.
      const raw = readFileSync(outFile);
      const written = (raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')).replace(/\r|﻿/g, '');
      const status = /^status=(.*)$/m.exec(written)?.[1];
      return { code: r.status, status, out: r.stdout + r.stderr, written: readFileSync(outFile, 'utf8') };
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the status step: login-failed, usmap-failed, extract-failed, ok, and empty before the game started', (t) => {
  const probe = finalStatus({});
  if (!probe) return t.skip('no PowerShell on this machine');
  assert.equal(probe.status, '', 'nothing happened: empty');
  assert.equal(probe.code, 1);
  // A sign-in failure is its own status, whatever else is on disk.
  assert.equal(finalStatus({ login: true }).status, 'login-failed');
  assert.equal(finalStatus({ login: true, boot: { process_found: true } }).status, 'login-failed');
  // The game ran but no usmap: usmap-failed (evidence: boot.json saw the process).
  assert.equal(finalStatus({ boot: { process_found: true }, usmapOk: 'false' }).status, 'usmap-failed');
  // Launch failed before the game started (no process seen): empty, not usmap-failed.
  assert.equal(finalStatus({ boot: { process_found: false }, usmapOk: 'false' }).status, '');
  // A usmap, then the upload or the extractor failing.
  assert.equal(finalStatus({ boot: { process_found: true }, usmapOk: 'true', upload: 'failure', stage: 'ok' }).status, 'extract-failed');
  assert.equal(finalStatus({ boot: { process_found: true }, usmapOk: 'true', upload: 'success', stage: 'extract-failed' }).status, 'extract-failed');
  const ok = finalStatus({ boot: { process_found: true }, usmapOk: 'true', upload: 'success', stage: 'ok' });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.code, 0);
});

// ---- S4: one cleanup and one leak gate, shared with the rig -------------------------------------

test('the rig and the data extract call the same cleanup and leak-gate scripts', () => {
  for (const [name, wfText] of [['rig', rig], ['extract', extract]]) {
    assert.match(wfText, /\.\/ci\/steam-cleanup\.ps1 -InstallDir \$env:INSTALL_DIR/, `${name}: cleanup script`);
    assert.match(wfText, /\.\/ci\/leak-gate\.ps1 -Path (out -AllowMissing|stage -Strict)/, `${name}: leak-gate script`);
    assert.ok(!/Stop-Service|HKCU:\\Software\\Valve|rig-gate-terms/.test(noComments(wfText)), `${name}: no inline copy of either`);
  }
  assert.match(extract, /leak-gate\.ps1 -Path stage -Strict/, 'the extract uses the strict mode');
  assert.ok(!/-Strict/.test(rig), 'the rig keeps its own matching');
  const pr = header.slice(header.indexOf('pull_request:'), header.indexOf('workflow_dispatch:'));
  assert.match(pr, /- ci\/steam-cleanup\.ps1/);
  assert.match(pr, /- ci\/leak-gate\.ps1/);
});
