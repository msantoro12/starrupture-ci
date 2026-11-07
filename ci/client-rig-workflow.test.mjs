// Tests for the client test rig workflow (.github/workflows/sr-client-rig.yml) and its scripts.
//
//   node --test ci/client-rig-workflow.test.mjs
//
// Reads the workflow and the scripts as text: who can trigger the rig, where the Steam
// login is visible, what happens before the upload, what the run leaves on the runner,
// and that the rig never reads the loader's update manifest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const wf = read('.github', 'workflows', 'sr-client-rig.yml');
const launch = read('ci', 'client-rig-launch.ps1');
const setup = read('ci', 'client-rig-set.ps1');

// The steps of the one job, split at "      - " (six spaces), keyed by name or uses.
const jobText = wf.slice(wf.indexOf('\n    steps:\n') + 1);
const steps = jobText.split(/\n(?= {6}- )/).slice(1).map((s) => s.replace(/^ {6}- /, '').trimEnd());
const nameOf = (s) => s.match(/^name: (.*)$/m)?.[1] ?? s.match(/^uses: (\S+)/)?.[1]?.split('@')[0] ?? '';
const step = (name) => {
  const s = steps.find((x) => nameOf(x) === name);
  assert.ok(s, `step "${name}" exists`);
  return s;
};
const indexOfStep = (id) => {
  const at = steps.findIndex((x) => new RegExp(`^ {8}id: ${id}$`, 'm').test(x));
  assert.ok(at >= 0, `step id ${id} exists`);
  return at;
};
const header = wf.slice(0, wf.indexOf('\njobs:\n'));

test('triggers: dispatch and call only, no schedule, no pull request, one set of inputs', () => {
  const on = header.slice(header.indexOf('\non:\n'), header.indexOf('\npermissions:'));
  assert.match(on, /\n {2}workflow_dispatch:\n/);
  assert.match(on, /\n {2}workflow_call:\n/);
  for (const bad of ['schedule', 'pull_request', 'pull_request_target', 'push', 'workflow_run', 'issue_comment']) {
    assert.ok(!new RegExp(`\\n {2}${bad}:`).test(on), `no ${bad} trigger`);
  }
  const names = (s) => [...s.matchAll(/\n {6}([a-z_]+):\n {8}description:/g)].map((m) => m[1]);
  const dispatch = on.slice(on.indexOf('  workflow_dispatch:'), on.indexOf('  workflow_call:'));
  const call = on.slice(on.indexOf('  workflow_call:'), on.indexOf('    outputs:'));
  const want = ['branch', 'tags', 'candidate_run_id', 'candidate_artifact', 'expect', 'expect_refused', 'remove_plugins'];
  assert.deepEqual(names(dispatch), want);
  assert.deepEqual(names(call), want);
  assert.match(dispatch, /branch:\n(?:.*\n)*?\s+default: public\n/);
  for (const n of want.slice(1)) assert.match(call, new RegExp(`${n}:\\n(?:.*\\n)*?\\s+default: ''`), `${n} defaults to empty`);
});

test('workflow_call outputs: verdict, reason and artifact, from the job', () => {
  for (const o of ['verdict', 'reason', 'artifact']) {
    assert.match(wf, new RegExp(`\\n {6}${o}:\\n {8}description: .*\\n {8}value: \\$\\{\\{ jobs\\.rig\\.outputs\\.${o} \\}\\}`));
    assert.match(wf, new RegExp(`\\n {6}${o}: \\$\\{\\{ steps\\.final\\.outputs\\.${o} \\}\\}`));
  }
});

test('permissions: none at the top, contents and actions read on the one job', () => {
  assert.match(header, /\npermissions: \{\}\n/);
  assert.match(wf, /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n/);
  assert.equal(wf.match(/^ {4}permissions:/gm)?.length, 1);
  assert.equal(wf.match(/^ {2}[a-z][\w-]*:\n {4}name:/gm)?.length, 1, 'one job');
  assert.match(wf, /runs-on: windows-latest/);
});

test('environment and queueing: steam-client, one session at a time, never cancelled', () => {
  assert.match(wf, /\n {4}environment: steam-client\n/);
  assert.match(wf, /\n {4}concurrency:\n {6}group: sr-client-rig\n {6}cancel-in-progress: false\n/);
});

test('secrets: only the steps that need the login see it, and never as an inline value', () => {
  const secretSteps = steps.filter((s) => /\$\{\{\s*secrets\./.test(s)).map(nameOf).sort();
  assert.deepEqual(secretSteps, [
    'Check the Steam login secrets are set',
    'Install the game client',
    'Launch the game client',
    'Leak gate',
  ].sort());
  assert.ok(!/secrets\./.test(header), 'no secret at workflow level');
  assert.ok(!/\n {4}env:\n(?: {6}.*\n)*? {6}[A-Z_]+: \$\{\{ secrets\./.test(wf), 'no secret in the job env');
  // Every use is an env entry, never inlined in a script or an action input.
  for (const s of steps) {
    for (const line of s.split('\n').filter((l) => /secrets\./.test(l))) {
      assert.match(line, /^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+( != '')?( && secrets\.[A-Z_]+ != '')? \}\}$/, line);
    }
  }
  // The two secrets only ever reach the scripts through STEAM_USER and STEAM_CACHE.
  for (const n of ['Install the game client', 'Launch the game client']) {
    assert.match(step(n), /STEAM_USER: \$\{\{ secrets\.STEAM_CI_USERNAME \}\}/);
    assert.match(step(n), /STEAM_CACHE: \$\{\{ secrets\.STEAM_CI_LOGIN_CACHE \}\}/);
  }
  assert.ok(!/inputs\./.test(step('Install the game client').replace(/^ {8}run:.*$/m, '')), 'no input in the step that holds the login');
});

test('missing login secrets fail the run with that reason, they do not skip green', () => {
  const gate = step('Check the Steam login secrets are set');
  assert.match(gate, /HAS_LOGIN: \$\{\{ secrets\.STEAM_CI_LOGIN_CACHE != '' && secrets\.STEAM_CI_USERNAME != '' \}\}/);
  assert.match(gate, /-ne 'true'[\s\S]*exit 1/);
  assert.match(gate, /rig-reason\.txt/);
  assert.ok(!/\n {8}if:/.test(gate), 'the gate always runs');
  assert.equal(indexOfStep('gate'), 0, 'first step');
  assert.ok(!/\bif:.*(secrets|HAS_LOGIN)/.test(wf.replace(/HAS_LOGIN: .*/g, '')), 'no step is skipped for missing secrets');
});

test('inputs reach scripts through env, never inlined in a script', () => {
  for (const s of steps) {
    const run = s.match(/\n {8}run: ([\s\S]*)$/)?.[1] ?? '';
    assert.ok(!/\$\{\{/.test(run), `${nameOf(s)}: no expression inside run`);
  }
  for (const n of ['BRANCH', 'TAGS', 'EXPECT', 'EXPECT_REFUSED', 'REMOVE_PLUGINS']) {
    assert.match(wf, new RegExp(`\\n {6}${n}: \\$\\{\\{ inputs\\.[a-z_]+ \\}\\}\\n`));
  }
});

test('candidate: this repository only, never a fork, run id and artifact together', () => {
  const check = step('Check the candidate run');
  assert.match(check, /if: inputs\.candidate_run_id != '' \|\| inputs\.candidate_artifact != ''/);
  assert.match(check, /go together/);
  assert.match(check, /repos\/\$env:REPO\/actions\/runs\/\$env:RUN_ID"/);
  assert.match(check, /\$head\.full_name -ne \$env:REPO -or \$head\.fork/);
  assert.match(check, /expired/);
  const dl = step("Download the candidate artifact");
  assert.match(dl, /run-id: \$\{\{ inputs\.candidate_run_id \}\}/);
  assert.ok(wf.indexOf('Check the candidate run') < wf.indexOf('download-artifact'), 'checked before downloaded');
  assert.ok(wf.indexOf('download-artifact') < wf.indexOf('- name: Resolve the set'), 'downloaded before the set is resolved');
  // The script refuses a bad candidate before any install: only the loader files, expect for every DLL.
  assert.match(setup, /dwmapi\.dll/);
  assert.match(setup, /reparse|ReparsePoint/i);
});

test('actions are pinned to a full sha', () => {
  const uses = [...wf.matchAll(/^\s+- uses: (\S+)|^\s+uses: (\S+)/gm)].map((m) => m[1] ?? m[2]);
  assert.ok(uses.length >= 5);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+(\/[\w.-]+)?@[0-9a-f]{40}$/, u);
  assert.match(step("actions/checkout"), /persist-credentials: false/);
});

test('release files: cached by repo and tag, no manifest anywhere in the rig', () => {
  assert.match(wf, /actions\/cache\/restore@[0-9a-f]{40}/);
  assert.match(wf, /actions\/cache\/save@[0-9a-f]{40}/);
  assert.match(wf, /key: sr-client-rig-dl-\$\{\{ steps\.res\.outputs\.key \}\}/);
  assert.match(setup, /Release assets downloaded in this run: /);
  assert.match(setup, /-Client\.dll/);
  assert.match(setup, /StarRupture-ModLoader-Client-/);
  // The loader's update manifest, by any name or address, is not in any file of the rig.
  const manifestUrl = /manifest\.json|[\w-]*manifest[\w.-]*\.(?:json|xml|txt)|raw\.githubusercontent|releases\/download\/[^\s'"]*manifest|update[-_]?feed/i;
  for (const [name, text] of [['workflow', wf], ['launch', launch], ['set', setup]]) {
    assert.ok(!manifestUrl.test(text), `${name}: no manifest URL`);
    assert.ok(!/https?:\/\/[^\s'"]*manifest/i.test(text), `${name}: no URL names a manifest`);
  }
});

test('the ini switches: no auto-update, INFO logging, no UI', () => {
  assert.match(launch, /function New-IniText \{ "\[AutoUpdate\]`r`nEnabled=0`r`n\[Logging\]`r`nLevel=INFO`r`n\[UI\]`r`nEnabled=0`r`n" \}/);
  assert.match(launch, /modloader\.ini/);
  assert.match(launch, /New-IniText/);
});

test('launch: steamcmd beta branch verified, firewall, app id, args, and the retry rule', () => {
  assert.match(launch, /-beta/);
  assert.match(launch, /BetaKey/);
  assert.match(launch, /New-NetFirewallRule[^\n]*-Direction Outbound -Action Block -Program/);
  assert.match(launch, /Set-NetFirewallProfile -Profile Domain, Private, Public -Enabled True/);
  assert.match(launch, /steam_appid\.txt/);
  assert.match(launch, /SteamAppId/);
  assert.match(launch, /-nullrhi -unattended -nosound -log/);
  assert.match(launch, /Application load error/);
  assert.match(launch, /\$MaxRelaunch = 2/);
  assert.match(launch, /Boot sequence finished/);
  assert.match(launch, /crash_dialog/);
  assert.match(launch, /dll-hashes\.json/);
  assert.match(launch, /boot\.json/);
});

test('hard limits: no emulator, stub strip, patching, ActiveProcess write or password', () => {
  for (const [name, text] of [['launch', launch], ['set', setup]]) {
    assert.ok(!/goldberg|\bgse\b|steamless|smartsteam|CreamAPI/i.test(text), `${name}: no emulator or stub stripper`);
    assert.ok(!/\+login\s+\S+\s+\S+/.test(text), `${name}: no steamcmd password login`);
    assert.ok(!/-password|STEAM_PASSWORD/i.test(text), `${name}: no password`);
  }
  for (const line of launch.split('\n').filter((l) => /ActiveProcess|\$activeKey/.test(l))) {
    assert.ok(!/Set-ItemProperty|New-ItemProperty|New-Item |Set-Content|reg add/i.test(line), `ActiveProcess is only read: ${line}`);
  }
  assert.ok(!/Set-ItemProperty[^\n]*ActiveProcess/.test(launch));
  assert.ok(!/steam_api64/i.test(launch.replace(/#.*$/gm, '')), 'steam_api64 is not touched');
});

test('order: verdict before upload, leak gate before upload, upload only when the gate passed', () => {
  const v = indexOfStep('verdict');
  const leak = indexOfStep('leak');
  const up = indexOfStep('upload');
  assert.ok(indexOfStep('launch') < v && v < leak && leak < up, 'launch, verdict, leak gate, upload');
  assert.match(step('Judge the launch'), /run: \.\/ci\/verdict\.ps1 -OutDir out -Client/);
  assert.match(step('Judge the launch'), /if: always\(\) && steps\.launch\.outcome == 'success'/);
  assert.match(step('Judge the launch'), /continue-on-error: true/);
  const upload = steps[up];
  assert.match(upload, /if: always\(\) && steps\.leak\.outcome == 'success'/);
  assert.match(upload, /retention-days: [1-7]\n/);
  const files = [...upload.matchAll(/^\s+out\/([\w.]+)$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(files, ['autoupdate.log', 'boot.json', 'modloader.log', 'proxy.log', 'set.json', 'verdict.json']);
  assert.ok(!/path: out\/?\s*\n/.test(upload) && !/\*/.test(upload.slice(upload.indexOf('path:'))), 'named files, no wildcard');
  // The gate scans what would be uploaded, for the account name, the login values and the IDs.
  const gate = step('Leak gate');
  assert.match(gate, /Get-ChildItem out -Recurse -File/);
  assert.match(gate, /7656119\\d\{10\}\|\\\[U:1:\\d\+\\\]/);
  assert.match(gate, /rig-gate-terms\.txt/);
  assert.match(gate, /if \(\$bad\) \{ exit 1 \}/);
  assert.match(gate, /if: always\(\) && steps\.gate\.outcome == 'success'|\n {8}if: always\(\) && steps\.gate\.outcome == 'success'/);
});

test('cleanup: runs always, removes steamcmd, the Steam folder and the Steam profile, ahead of the verdict', () => {
  const c = step('Remove Steam and the login from the runner');
  assert.match(c, /\n {8}if: always\(\)\n/);
  assert.match(c, /C:\\steamcmd/);
  assert.match(c, /Join-Path \$\{env:ProgramFiles\(x86\)\} 'Steam'/);
  assert.match(c, /Join-Path \$env:LOCALAPPDATA 'Steam'/);
  assert.match(c, /Stop-Process -Force/);
  assert.match(c, /StarRupture/);
  assert.match(c, /Steam Client Service/);
  assert.ok(indexOfStep('cleanup') > indexOfStep('launch') && indexOfStep('cleanup') < indexOfStep('verdict'));
  // The verdict only reads out/, which cleanup leaves alone.
  assert.ok(!/out\b/.test(c));
});

test('result: job fails on a failed verdict after the logs are uploaded, outputs always set', () => {
  const f = step('Outputs and result');
  assert.match(f, /\n {8}if: always\(\)\n/);
  for (const o of ['verdict', 'reason', 'artifact']) assert.match(f, new RegExp(`"${o}=`));
  assert.match(f, /if \(\$verdict -ne 'PASS'\) \{[^}]*exit 1 \}/);
  assert.match(f, /LEAK -eq 'failure'/);
  assert.match(f, /CLEANUP -eq 'failure'/);
  assert.ok(indexOfStep('upload') < indexOfStep('final'), 'the last step comes after the upload');
  assert.equal(indexOfStep('final'), steps.length - 1, 'last step');
});

test('verdict contract: the launch writes every file verdict.ps1 -Client reads', () => {
  const v = read('ci', 'verdict.ps1');
  for (const f of ['set.json', 'boot.json', 'dll-hashes.json', 'modloader.log', 'proxy.log', 'autoupdate.log']) {
    assert.ok(v.includes(f), `verdict.ps1 reads ${f}`);
    assert.ok(launch.includes(f) || setup.includes(f), `the rig writes ${f}`);
  }
  assert.match(setup, /set\.json/);
  assert.match(setup, /buildId/);
});

test('the rig is in the node test line', () => {
  assert.match(read('.github', 'workflows', 'sr-node-tests.yml'), /node --test [^\n]*ci\/client-rig-workflow\.test\.mjs/);
});
