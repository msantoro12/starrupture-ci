// Tests for the client test rig workflow (.github/workflows/sr-client-rig.yml) and its scripts.
//
//   node --test ci/client-rig-workflow.test.mjs
//
// Reads the workflow and the scripts as text: who can trigger the rig, where the Steam
// login is visible, what happens before the upload, what the run leaves on the runner,
// and that the rig never reads the loader's update manifest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const wf = read('.github', 'workflows', 'sr-client-rig.yml');
const launch = read('ci', 'client-rig-launch.ps1');
const setup = read('ci', 'client-rig-set.ps1');
const verdictPs = read('ci', 'verdict.ps1');

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
  // Leg C2: the plugins of other authors with a newer release than the reviewed one, for the check's alert.
  assert.match(wf, /\n {6}review:\n {8}description: .*\n {8}value: \$\{\{ jobs\.rig\.outputs\.review \}\}/);
  assert.match(wf, /\n {6}review: \$\{\{ steps\.res\.outputs\.review \}\}/);
  assert.ok(indexOfStep('res') >= 0, 'the step that writes review has the id the job output reads');
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

test('candidate layouts: the game folder, and the pipeline\'s own flat plugin artifacts', () => {
  // A root file is dwmapi.dll, one of the loader's files, or a plugin; anything else root-level is refused.
  assert.match(setup, /\$LoaderFiles = @\('StarRupture-ModLoader-Core\.dll', 'StarRupture-ImGui\.dll', 'StarRupture-ModLoader-Updater\.exe'\)/);
  assert.match(setup, /if \(\$rel -notmatch '\/'\)/);
  assert.match(setup, /ModLoader\/Plugins\/\$rel/);
  assert.match(setup, /a root file must be dwmapi\.dll, one of the loader's files, a plugin DLL or build metadata/);
  assert.match(setup, /Candidate metadata ignored: \$rel/);
  // Resolve and Install read the layout through the same function, and every overlaid DLL still needs an expect.
  assert.match(setup, /function Get-CandidateFiles\(\[string\]\$Dir\)/);
  assert.equal(setup.match(/\(Get-CandidateFiles |= Get-CandidateFiles /g)?.length, 2, 'used by Resolve and Install');
  assert.match(setup, /add Name=version for each to expect/);
  // The workflow's builds really are flat: sr-build-all uploads one plugin DLL per artifact.
  const build = read('.github', 'workflows', 'sr-build-all.yml');
  assert.match(build, /path: build\/Client Release\/Plugins\/\$\{\{ matrix\.dll \}\}/);
});

// Runs the script's own Get-CandidateFiles over a folder holding the named root files.
function candidateFiles(names) {
  const dir = mkdtempSync(join(tmpdir(), 'rig-cand-'));
  try {
    for (const n of names) writeFileSync(join(dir, n), 'x');
    const fn = setup.match(/^function Get-CandidateFiles[\s\S]*?\n}\n/m)[0];
    const files = setup.match(/^\$LoaderFiles = .*$/m)[0];
    const script = `$ErrorActionPreference = 'Stop'\n${files}\n${fn}\n'FILES=' + ((Get-CandidateFiles '${dir}' | ForEach-Object { $_.Rel }) -join ',')`;
    for (const exe of ['pwsh', 'powershell']) {
      const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
      if (!r.error) return r;
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('candidate root metadata is ignored and logged; unknown executables are refused', (t) => {
  const ok = candidateFiles(['build.json', 'Codex.dll']);
  if (!ok) return t.skip('no PowerShell on this machine');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Candidate metadata ignored: build\.json/);
  assert.match(ok.stdout, /^FILES=Codex\.dll$/m);
  const bad = candidateFiles(['foo.exe', 'Codex.dll']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /candidate holds 'foo\.exe' at its root/);
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
  // A restore key may bring back other tags' files: the fetch keeps exactly the plan's files.
  assert.match(setup, /Files from other releases removed from the cache folder/);
  // The key follows the upload: the asset's id and its digest (or upload time) are in it, the id is
  // in the cached file's path, and the API's digest is checked on a cached file and a download.
  assert.match(setup, /#\$\(\$_\.id\):\$\(if \(\$_\.digest\) \{ \$_\.digest \} else \{ \$_\.updated \}\)/);
  assert.match(setup, /\$\(\$Item\.repo\)\\\$\(\$Item\.tag\)\\\$\(\$Item\.id\)/);
  assert.match(setup, /does not match the digest the release gives/);
  assert.match(setup, /Cached \$\(\$d\.name\) does not match the release's digest/);
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

test('firewall: a block rule for every exe in the install, derived from it, each one verified', () => {
  assert.match(launch, /function Get-InstallExes\(\[string\]\$Dir\) \{\n.*-Recurse -File -Force -Filter \*\.exe/);
  assert.match(launch, /\$exes = Get-InstallExes \$InstallDir/);
  assert.match(launch, /Enable-Firewall \$exes\n/);
  assert.match(launch, /function Enable-Firewall\(\[string\[\]\]\$Programs\)/);
  // The game and the updater must be in the derived list, or the launch stops.
  assert.match(launch, /foreach \(\$must in \$script:exe, \$script:updater\)/);
  // Each rule is read back, program path included.
  assert.match(launch, /Get-NetFirewallApplicationFilter/);
  assert.match(launch, /\$filter\.Program -ne \$prog/);
  // No hand list of program names in the firewall code.
  const fw = launch.slice(launch.indexOf('function Enable-Firewall'), launch.indexOf('function Reset-GameState'));
  assert.ok(!/CrashReportClient|\.exe'/.test(fw), 'the rule set is not a list of names');
  assert.match(launch, /Get-InstallExes \$inst/, 'the helper is exercised by -Check');
});

test('persona: read from what Steam wrote, and a run that cannot tell holds back everything from the logs', () => {
  assert.match(launch, /function Get-Personas\(/);
  assert.match(launch, /loginusers\.vdf/);
  assert.match(launch, /localconfig\.vdf/);
  // Read after the game is stopped and Steam has shut down, before the logs are scrubbed into out/.
  const at = (re) => launch.search(re);
  assert.ok(at(/\n {4}Stop-Game\n {4}# Steam writes the persona[^\n]*\n {4}Stop-Steam\n/) > 0, 'Steam is stopped after the game');
  assert.ok(at(/Stop-Steam\n[\s\S]*\$persona = Read-Personas/) > 0 && at(/\$persona = Read-Personas[\s\S]*Scrub \(Read-Shared \$p\)/) > 0);
  assert.match(launch, /if \(-not \$persona\.Known\) \{ Set-Hold /);
  assert.match(launch, /rig-hold\.txt/);
  assert.match(launch, /Add-Secret \$n -Gate/);
  // The gate refuses to pass on a hold, the upload needs the gate, the last step says why.
  const gate = step('Leak gate');
  assert.match(gate, /\$hold = Join-Path \$env:RUNNER_TEMP 'rig-hold\.txt'\n\s+if \(Test-Path -LiteralPath \$hold\) \{[^\n]*exit 1 \}/);
  assert.ok(gate.indexOf('rig-hold.txt') < gate.indexOf('$user ='), 'checked before anything else');
  assert.match(steps[indexOfStep('upload')], /if: always\(\) && steps\.leak\.outcome == 'success'/);
  const final = step('Outputs and result');
  assert.match(final, /\$hold = Join-Path \$env:RUNNER_TEMP 'rig-hold\.txt'/);
  assert.ok(final.indexOf('Test-Path -LiteralPath $hold') < final.indexOf("$env:LEAK -eq 'failure'"), 'a hold is reported before a leak');
  // No new secret: the only secrets are still the two login ones.
  assert.deepEqual([...new Set([...wf.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort(), ['STEAM_CI_LOGIN_CACHE', 'STEAM_CI_USERNAME']);
});

test('nothing from the logs is published before the leak gate', () => {
  const leak = indexOfStep('leak');
  // No step ahead of the gate writes the job summary or prints the verdict's files.
  steps.slice(0, leak + 1).forEach((s) => {
    assert.ok(!/GITHUB_STEP_SUMMARY/.test(s), `${nameOf(s)}: no summary before the leak gate`);
    assert.ok(!/verdict\.txt|summary\.md|verdict\.json/.test(s.replace(/^ {8}run: \.\/ci\/verdict\.ps1 .*$/m, '')), `${nameOf(s)}: does not print the verdict files`);
  });
  // The scripts that handle logs never write the summary; the verdict does so only in server mode.
  for (const [name, text] of [['launch', launch], ['set', setup]]) assert.ok(!/GITHUB_STEP_SUMMARY/.test(text), `${name}: no summary`);
  assert.match(verdictPs, /if \(\$Client\) \{ \[System\.IO\.File\]::WriteAllText\(\(Join-Path \$OutDir 'summary\.md'\)/);
  assert.match(verdictPs, /elseif \(\$env:GITHUB_STEP_SUMMARY\) \{ \$md -join/);
  assert.equal(verdictPs.match(/-FilePath \$env:GITHUB_STEP_SUMMARY/g)?.length, 1, 'only the server branch writes it');
  // After the gate, only the last step publishes, and only when the gate passed.
  const publishers = steps.filter((s) => /GITHUB_STEP_SUMMARY/.test(s)).map(nameOf);
  assert.deepEqual(publishers, ['Outputs and result']);
  const final = step('Outputs and result');
  assert.match(final, /\(Test-Path -LiteralPath \$vj\) -and \$env:LEAK -eq 'success'\) \{\n[^}]*\$publish = \$true/);
  assert.match(final, /if \(\$publish\) \{[\s\S]*out\/verdict\.txt[\s\S]*out\/summary\.md/);
  assert.ok(final.indexOf('out/summary.md') > final.indexOf('$publish = $true'));
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
  const files = [...upload.matchAll(/^\s+out\/([\w.-]+)$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(files, ['autoupdate.log', 'boot.json', 'dll-hashes.json', 'modloader.log', 'proxy.log', 'set.json', 'verdict.json', 'verdict.txt']);
  // Named files, and the one wildcard the compat reports need (their names carry the build).
  assert.match(upload, /^\s+out\/compat-report-\*\.json$/m);
  assert.ok(!/path: out\/?\s*\n/.test(upload) && !/\*/.test(upload.slice(upload.indexOf('path:')).replace('out/compat-report-*.json', '')), 'named files, no other wildcard');
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
  assert.match(c, /Remove-Item -LiteralPath 'HKCU:\\Software\\Valve' -Recurse -Force/);
  assert.match(c, /Filter steam_appid\.txt/);
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
  // A compat report is judged by its contents: the launch keeps the file, the upload carries it, the set carries uiOffInitFailure.
  assert.ok(v.includes('compat-report-'));
  assert.match(launch, /foreach \(\$f in \$compatFiles\) \{ \[IO\.File\]::WriteAllText\(\(Join-Path \$OutDir \$f\.Name\), \(Scrub/);
  assert.match(setup, /\$row\.uiOffInitFailure = \$_\.uiOffInitFailure/);
  assert.ok(v.includes('uiOffInitFailure'));
});

test('the rig is in the node test line', () => {
  assert.match(read('.github', 'workflows', 'sr-node-tests.yml'), /node --test [^\n]*ci\/client-rig-workflow\.test\.mjs/);
});

// ---- Leg B3: MiniMap, the tenth plugin, from its author's repo ----

const names = JSON.parse(read('ci', 'plugin-names.json'));
// Leg C2: MiniMap is another author's plugin, so the rig runs it only at this reviewed release.
const PIN_TAG = 'v1.2.0';
const PIN_HEX = '7d1ec9264b763e13519fa211c9409ff9655c8fd40357cdf285e2a7614e0d43e1';

test('rig set: ten plugins, MiniMap from its author with the version form it logs, pinned to a reviewed release', () => {
  assert.equal(names.length, 10);
  assert.deepEqual(names.map((p) => p.Name).sort(), ['BetterCheats', 'BetterDrone', 'CameraControls', 'Codex', 'Compass', 'MiniMap', 'ProductionViewer', 'RuptureTimer', 'WAILA', 'WaveOptimiser']);
  const m = names.find((p) => p.Name === 'MiniMap');
  assert.deepEqual(m, { Name: 'MiniMap', Repo: 'StarRupture-Plugin-MiniMap', LogName: 'MiniMap', Asset: 'MiniMap', Owner: 'LetMeInside', StripV: true, UiOffInitFailure: 'MiniMap: atlas texture interface initialization failed', Pin: { Tag: PIN_TAG, Digest: `sha256:${PIN_HEX}` } });
  // The other nine keep the rig's owner and Latest: no owner, no pin.
  for (const p of names.filter((x) => x.Name !== 'MiniMap')) {
    assert.ok(!('Owner' in p) && !('StripV' in p) && !('Pin' in p) && !('UiOffInitFailure' in p), `${p.Name}: unchanged`);
  }
  // Every plugin whose owner is neither the rig's nor the loader's author has a pin.
  for (const p of names.filter((x) => x.Owner && !['msantoro12', 'AlienXAXS'].includes(x.Owner))) assert.ok(p.Pin?.Tag && /^sha256:[0-9a-f]{64}$/.test(p.Pin.Digest), `${p.Name} is pinned`);
  assert.match(setup, /the ten plugins/);
  assert.ok(!/one of the nine/.test(setup), 'the script no longer counts nine');
});

test('rig set: docs say ten and name the MiniMap source repo', () => {
  const readme = read('.github', 'sr-pipeline', 'README.md');
  assert.match(readme, /LetMeInside\/StarRupture-Plugin-MiniMap/);
  assert.match(readme, /ten plugins/);
  assert.ok(!/one of the nine/.test(readme), 'no "one of the nine" left');
  assert.match(wf, /MiniMap/, 'the tags input lists MiniMap');
});

// Runs Resolve with a stand-in releases API: every repo has a Latest release holding the
// client DLL beside a zip and a manifest (MiniMap's real layout), the loader its client zip.
// minimapLatest is the tag /latest names for MiniMap, minimapDigest the digest of its client DLL
// on every release, plugins the plugin-names.json the script reads (default: the repository's).
function resolveWithMock(args, { minimapLatest = PIN_TAG, minimapDigest = PIN_HEX, plugins = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rig-res-'));
  try {
    const plan = join(dir, 'plan.json');
    const uris = join(dir, 'uris.txt');
    const wrapper = join(dir, 'run.ps1');
    const out = join(dir, 'github-output.txt');
    // A copy of the script beside its own names file, so a test can change the names.
    const tool = join(dir, 'tool');
    mkdirSync(tool);
    copyFileSync(join(here, 'client-rig-set.ps1'), join(tool, 'client-rig-set.ps1'));
    writeFileSync(join(tool, 'plugin-names.json'), JSON.stringify(plugins ?? names));
    writeFileSync(wrapper, [
      "$ErrorActionPreference = 'Stop'",
      `$names = Get-Content -LiteralPath '${join(tool, 'plugin-names.json')}' -Raw | ConvertFrom-Json`,
      'function Invoke-RestMethod { param($Headers, $Uri, $TimeoutSec)',
      `  Add-Content -LiteralPath '${uris}' -Value $Uri`,
      '  if ($Uri -notmatch \'/repos/([^/]+)/([^/]+)/releases/(latest|tags/(.+))$\') { throw "unexpected $Uri" }',
      `  $repo = $Matches[2]; $tag = if ($Matches[4]) { $Matches[4] } elseif ($repo -eq 'StarRupture-Plugin-MiniMap') { '${minimapLatest}' } else { 'v1.0.0' }`,
      '  $p = $names | Where-Object { $_.Repo -eq $repo }',
      `  $digest = if ($repo -eq 'StarRupture-Plugin-MiniMap') { 'sha256:${minimapDigest}' } else { 'sha256:' + ('a' * 64) }`,
      '  $assets = if ($p) { @(@{ name = "$($p.Asset)-Client.dll"; id = 11; browser_download_url = "https://x/$repo/$($p.Asset)-Client.dll"; digest = $digest; updated_at = \'t\' }, @{ name = "$($p.Asset)-v1.zip"; id = 12; browser_download_url = \'https://x/z\'; updated_at = \'t\' }, @{ name = \'manifest.json\'; id = 13; browser_download_url = \'https://x/m\'; updated_at = \'t\' }) } else { @(@{ name = \'StarRupture-ModLoader-Client-1.zip\'; id = 21; browser_download_url = \'https://x/loader.zip\'; updated_at = \'t\' }) }',
      '  return [pscustomobject]@{ tag_name = $tag; assets = @($assets | ForEach-Object { [pscustomobject]$_ }) }',
      '}',
      `$env:GITHUB_OUTPUT = '${out}'`,
      `& '${join(tool, 'client-rig-set.ps1')}' -Mode Resolve -PlanPath '${plan}' ${args}`,
      'exit $LASTEXITCODE',
    ].join('\n'));
    for (const exe of ['pwsh', 'powershell']) {
      const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { encoding: 'utf8', windowsHide: true });
      if (r.error) continue;
      let planJson = null;
      try { planJson = JSON.parse(readFileSync(plan, 'utf8').replace(/^﻿/, '')); } catch { /* no plan on a failed run */ }
      let seen = [];
      try { seen = readFileSync(uris, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* none */ }
      let outputs = '';
      try { const b = readFileSync(out); outputs = b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le').slice(1) : b.toString('utf8'); } catch { /* none */ } // Windows PowerShell 5.1 writes UTF-16 with >>; pwsh on the runner writes UTF-8
      return { r, plan: planJson, uris: seen, outputs, text: `${r.stdout}\n${r.stderr}` };
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MINIMAP_LATEST_URL = 'https://api.github.com/repos/LetMeInside/StarRupture-Plugin-MiniMap/releases/latest';
const MINIMAP_PIN_URL = `https://api.github.com/repos/LetMeInside/StarRupture-Plugin-MiniMap/releases/tags/${PIN_TAG}`;

test('rig set: Resolve gives ten plugins, MiniMap from LetMeInside at its pinned release, its DLL picked, its logged version without the v', (t) => {
  const out = resolveWithMock('-Branch public');
  if (!out) return t.skip('no PowerShell on this machine');
  assert.equal(out.r.status, 0, out.text);
  assert.equal(out.plan.plugins.length, 10);
  const m = out.plan.plugins.find((p) => p.name === 'MiniMap');
  assert.equal(m.tag, PIN_TAG);
  assert.equal(m.expect, '1.2.0', 'the log prints 1.2.0 for the tag v1.2.0');
  assert.equal(m.logName, 'MiniMap');
  assert.equal(m.dll, 'MiniMap.dll');
  assert.equal(m.expectRefused, false, 'refused on public is a fail');
  // Its init needs the UI layer the rig turns off: the data comes from plugin-names.json, and no other plugin has it.
  assert.equal(m.uiOffInitFailure, 'MiniMap: atlas texture interface initialization failed');
  assert.deepEqual(out.plan.plugins.filter((p) => p.uiOffInitFailure).map((p) => p.name), ['MiniMap']);
  assert.equal(m.asset.name, 'MiniMap-Client.dll', 'the client DLL, not the zip or the manifest');
  // The pinned release is fetched by its tag; Latest is only asked about, to see whether a newer one waits.
  assert.ok(out.uris.includes(MINIMAP_PIN_URL), out.uris.join('\n'));
  assert.ok(out.uris.includes('https://api.github.com/repos/AlienXAXS/StarRupture-Plugin-Codex/releases/latest'));
  assert.ok(!out.uris.some((u) => /StarRupture-Plugin-Codex\/releases\/tags/.test(u)), 'the nine owner and AlienX plugins resolve Latest, not a tag');
  assert.ok(!out.uris.some((u) => /AlienXAXS\/StarRupture-Plugin-MiniMap/.test(u)), 'MiniMap is not looked up under the rig owner');
  // The other nine are as before: the tag is what the log must show.
  for (const p of out.plan.plugins.filter((x) => x.name !== 'MiniMap')) assert.equal(p.expect, 'v1.0.0', `${p.name} keeps the tag`);
  // The cache key covers MiniMap's asset id and the reviewed digest, which is what the download is checked against.
  const dl = out.plan.downloads.find((d) => d.repo === 'StarRupture-Plugin-MiniMap');
  assert.equal(dl.id, '11');
  assert.equal(dl.digest, PIN_HEX);
  // Latest is the pinned release: nothing waits for review.
  assert.deepEqual(out.plan.review, []);
  assert.match(out.outputs, /^review=$/m);
});

test('rig set: a newer MiniMap release is reported for review and never run, and the other plugins are unaffected', (t) => {
  const out = resolveWithMock('-Branch public', { minimapLatest: 'v1.3.0', minimapDigest: PIN_HEX });
  if (!out) return t.skip('no PowerShell on this machine');
  assert.equal(out.r.status, 0, out.text);
  // Still the pinned release: same tag, same digest, same asset, fetched by its tag.
  const m = out.plan.plugins.find((p) => p.name === 'MiniMap');
  assert.equal(m.tag, PIN_TAG);
  assert.equal(m.expect, '1.2.0');
  assert.equal(out.plan.downloads.find((d) => d.repo === 'StarRupture-Plugin-MiniMap').digest, PIN_HEX);
  assert.ok(out.uris.includes(MINIMAP_PIN_URL) && out.uris.includes(MINIMAP_LATEST_URL), out.uris.join('\n'));
  // The newer tag is the review item: in the plan, the step output and a loud workflow line.
  assert.deepEqual(out.plan.review, ['MiniMap=v1.3.0']);
  assert.match(out.outputs, /^review=MiniMap=v1\.3\.0$/m);
  assert.match(out.text, /::warning title=New release waiting for review::new MiniMap release v1\.3\.0 waiting for review/);
  // The run is not blocked and the cache key does not move with the unreviewed release.
  const same = resolveWithMock('-Branch public');
  assert.equal(out.plan.cacheKey, same.plan.cacheKey);
  assert.equal(out.plan.plugins.length, 10);
});

test('rig set: the pinned tag with another digest fails, and says why', (t) => {
  const out = resolveWithMock('-Branch public', { minimapDigest: 'b'.repeat(64) });
  if (!out) return t.skip('no PowerShell on this machine');
  assert.notEqual(out.r.status, 0, 'a swapped asset is a failed run, not a warning');
  assert.match(out.text, /MiniMap v1\.2\.0: the release's MiniMap-Client\.dll has the digest sha256:b{64}, not the reviewed sha256:7d1ec9264b763e13519fa211c9409ff9655c8fd40357cdf285e2a7614e0d43e1/);
  assert.equal(out.plan, null, 'no plan is written, so nothing runs');
});

test('rig set: a plugin of another author without a reviewed pin, or with a malformed one, is refused', (t) => {
  const withMiniMap = (change) => names.map((p) => (p.Name === 'MiniMap' ? change(p) : p));
  const without = resolveWithMock('-Branch public', { plugins: withMiniMap(({ Pin, ...rest }) => rest) });
  if (!without) return t.skip('no PowerShell on this machine');
  assert.notEqual(without.r.status, 0);
  assert.match(without.text, /MiniMap is another author's plugin \(LetMeInside\), and the rig runs it only at a reviewed release: add a Pin/);
  assert.ok(!without.uris.some((u) => /StarRupture-Plugin-MiniMap/.test(u)), 'refused before any release is read');
  const badTag = resolveWithMock('-Branch public', { plugins: withMiniMap((p) => ({ ...p, Pin: { ...p.Pin, Tag: 'v1.2.0; calc' } })) });
  assert.notEqual(badTag.r.status, 0);
  assert.match(badTag.text, /the Pin tag 'v1\.2\.0; calc' is not a release tag/);
  for (const digest of ['sha256:abc', `sha256:${PIN_HEX.toUpperCase()}`, PIN_HEX, 'sha1:' + PIN_HEX]) {
    const bad = resolveWithMock('-Branch public', { plugins: withMiniMap((p) => ({ ...p, Pin: { ...p.Pin, Digest: digest } })) });
    assert.notEqual(bad.r.status, 0, digest);
    assert.match(bad.text, /the Pin digest '.*' is not sha256:<64 lower-case hex digits>/, digest);
  }
  // The nine of the rig owner and AlienX need no pin (they resolve Latest, as before).
  assert.equal(resolveWithMock('-Branch public').r.status, 0);
});

test('rig set: expect_refused MiniMap is accepted for the test branch, and a tag override can only name the reviewed release', (t) => {
  const out = resolveWithMock(`-Branch public_test_branch -ExpectRefused 'MiniMap' -Tags 'MiniMap=${PIN_TAG}'`);
  if (!out) return t.skip('no PowerShell on this machine');
  assert.equal(out.r.status, 0, out.text);
  const m = out.plan.plugins.find((p) => p.name === 'MiniMap');
  assert.equal(m.expectRefused, true);
  assert.equal(m.tag, PIN_TAG);
  assert.equal(m.expect, '1.2.0');
  assert.ok(out.uris.includes(MINIMAP_PIN_URL), out.uris.join('\n'));
  // Another tag for a third-party plugin is an error, however it is asked for.
  const other = resolveWithMock("-Branch public -Tags 'MiniMap=v1.1.0'");
  assert.notEqual(other.r.status, 0);
  assert.match(other.text, /tags names MiniMap=v1\.1\.0, but MiniMap is another author's plugin: the rig runs only its reviewed release v1\.2\.0/);
  assert.ok(!other.uris.some((u) => /MiniMap\/releases\/tags\/v1\.1\.0/.test(u)), 'the unreviewed tag is never fetched');
  // A tag for a plugin of the rig's owners still works.
  const codex = resolveWithMock("-Branch public -Tags 'Codex=v0.9.0'");
  assert.equal(codex.r.status, 0, codex.text);
  assert.ok(codex.uris.includes('https://api.github.com/repos/AlienXAXS/StarRupture-Plugin-Codex/releases/tags/v0.9.0'));
});

test('rig artifact: its name carries the branch, the candidate and the run, so two rigs of one run do not collide', () => {
  assert.match(wf, /\n {6}ARTIFACT_NAME: sr-client-rig-\$\{\{ inputs\.branch \}\}-\$\{\{ inputs\.candidate_artifact \|\| 'release' \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\n/);
  assert.match(step('Upload the scrubbed logs'), /name: \$\{\{ env\.ARTIFACT_NAME \}\}/);
  assert.equal(wf.match(/ARTIFACT_NAME:/g)?.length, 1, 'one definition, read by the upload and the final step');
});
