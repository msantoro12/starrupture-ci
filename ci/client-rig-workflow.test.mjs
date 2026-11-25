// Tests for the client test rig workflow (.github/workflows/sr-client-rig.yml) and its scripts.
//
//   node --test ci/client-rig-workflow.test.mjs
//
// Reads the workflow and the scripts as text: who can trigger the rig, where the Steam
// login is visible, what happens before the upload, what the run leaves on the runner,
// and that the rig never reads the loader's update manifest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const wf = read('.github', 'workflows', 'sr-client-rig.yml');
const launch = read('ci', 'client-rig-launch.ps1');
const setup = read('ci', 'client-rig-set.ps1');
const verdictPs = read('ci', 'verdict.ps1');
// The leak gate and the cleanup are scripts shared with sr-data-extract.yml.
const leakGate = read('ci', 'leak-gate.ps1');
const cleanupPs = read('ci', 'steam-cleanup.ps1');

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
  const want = ['branch', 'tags', 'candidate_run_id', 'candidate_artifact', 'expect', 'expect_refused', 'expect_decline', 'known_cls', 'remove_plugins'];
  // The feed inputs name an artifact of the calling run: a dispatch has none, so only a call takes them.
  const feedInputs = ['feed_artifact', 'feed_seq', 'feed_cl'];
  // live_feed is a dispatch input only: a call passes a feed artifact instead.
  assert.deepEqual(names(dispatch), [...want, 'live_feed']);
  assert.deepEqual(names(call), [...want, ...feedInputs]);
  assert.match(dispatch, /branch:\n(?:.*\n)*?\s+default: public\n/);
  for (const n of [...want.slice(1), ...feedInputs]) assert.match(call, new RegExp(`${n}:\\n(?:.*\\n)*?\\s+default: ''`), `${n} defaults to empty`);
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

test('launch: steamcmd branch verified, firewall, app id, args, and the retry rule', () => {
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
  assert.match(step('Leak gate'), /\.\/ci\/leak-gate\.ps1 -Path out -AllowMissing\n\s+exit \$LASTEXITCODE$/);
  assert.match(leakGate, /\$hold = Join-Path \$env:RUNNER_TEMP 'rig-hold\.txt'\nif \(Test-Path -LiteralPath \$hold\) \{[^\n]*exit 1 \}/);
  assert.ok(leakGate.indexOf('rig-hold.txt') < leakGate.indexOf('$user ='), 'checked before anything else');
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
  // Named files, and the wildcards: the compat reports and the feature dump (their names carry the build) and the
  // attempt1 evidence folder (the files in it are named by the launch, and the leak gate reads them).
  assert.match(upload, /^\s+out\/compat-report-\*\.json$/m);
  assert.match(upload, /^\s+out\/attempt1\/\*$/m);
  // The loader's feature dump, one file per game build (the plugin catalog leg of the client check reads it).
  assert.match(upload, /^\s+out\/declared-features-\*\.v1\.txt$/m);
  assert.ok(!/path: out\/?\s*\n/.test(upload) && !/\*/.test(upload.slice(upload.indexOf('path:')).replace('out/compat-report-*.json', '').replace('out/declared-features-*.v1.txt', '').replace('out/attempt1/*', '')), 'named files, no other wildcard');
  // The gate scans what would be uploaded, for the account name, the login values and the IDs.
  const gate = step('Leak gate');
  assert.match(gate, /\.\/ci\/leak-gate\.ps1 -Path out -AllowMissing\n\s+exit \$LASTEXITCODE$/);
  assert.match(leakGate, /Get-ChildItem -LiteralPath \$root -Recurse -File/);
  assert.match(leakGate, /7656119\\d\{10\}\|\\\[U:1:\\d\+\\\]/);
  assert.match(leakGate, /rig-gate-terms\.txt/);
  assert.match(leakGate, /if \(\$bad\) \{ exit 1 \}/);
  assert.match(gate, /\n {8}if: always\(\) && steps\.gate\.outcome == 'success'/);
});

test('cleanup: runs always, removes steamcmd, the Steam folder and the Steam profile, ahead of the verdict', () => {
  const cleanupStep = step('Remove Steam and the login from the runner');
  assert.match(cleanupStep, /\n {8}if: always\(\)\n/);
  assert.match(cleanupStep, /\.\/ci\/steam-cleanup\.ps1 -InstallDir \$env:INSTALL_DIR\n\s+exit \$LASTEXITCODE/);
  assert.ok(!/Stop-Service|Remove-Item/.test(cleanupStep), 'the cleanup is the shared script, not an inline copy');
  const c = cleanupPs;
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
  assert.ok(!/\bout\b/.test(c.replace(/#.*$/gm, '')));
});

test('cleanup: the rig runs both parts in one step; the login part is fatal, the folder part only warns', () => {
  const cleanupStep = step('Remove Steam and the login from the runner');
  assert.ok(!/-Phase/.test(cleanupStep), 'no -Phase: the default is login removal, then the folder');
  const c = cleanupPs.replace(/^\s*#.*$/gm, '');
  assert.match(c, /\[string\]\$Phase = 'All'|\[ValidateSet\('All', 'Login', 'Folder'\)\]\[string\]\$Phase = 'All'/);
  assert.match(c, /if \(-not \(Remove-Login\)\) \{[\s\S]*?exit 1/);
  assert.match(c, /if \(\$Phase -eq 'All'\) \{ Remove-Folder \}/);
  assert.match(c, /::warning::[^\n]*held by: /);
  assert.match(step('Outputs and result'), /CLEANUP -eq 'failure'/);
  // The rig's reason is the cleanup's own text (the item left and its holder) when the script wrote one.
  assert.match(step('Outputs and result'), /rig-cleanup-reason\.txt/);
  assert.match(c, /\$LoginRetrySec = 60/);
  assert.match(c, /\$FolderRetrySec = 60/);
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

// ---- Leg B3: MiniMap and PersistentIdFix, from their author's repos ----

const names = JSON.parse(read('ci', 'plugin-names.json'));
// Leg C2: MiniMap is another author's plugin, so the rig runs it only at this reviewed release.
const PIN_TAG = 'v1.3.1';
const PIN_HEX = '5d6e8f6dde78abaaed335041c69efab856409711507800a92b1fb4fca3b4764f';
const PID_TAG = 'v1.3.1';
const PID_HEX = 'f916120794660282f275a512aaea3f030998ddf7f8d4234d67482f6a3ced0126';
const THIRD_PARTY = ['MiniMap', 'PersistentIdFix'];

test('rig set: eleven plugins, MiniMap and PersistentIdFix from their author with the version form they log, pinned to a reviewed release', () => {
  assert.equal(names.length, 11);
  assert.deepEqual(names.map((p) => p.Name).sort(), ['BetterCheats', 'BetterDrone', 'CameraControls', 'Codex', 'Compass', 'MiniMap', 'PersistentIdFix', 'ProductionViewer', 'RuptureTimer', 'WAILA', 'WaveOptimiser']);
  const m = names.find((p) => p.Name === 'MiniMap');
  assert.deepEqual(m, { Name: 'MiniMap', Repo: 'StarRupture-Plugin-MiniMap', LogName: 'MiniMap', Asset: 'MiniMap', Owner: 'LetMeInside', StripV: true, UiOffInitFailure: 'MiniMap: atlas texture interface initialization failed', Pin: { Tag: PIN_TAG, Digest: `sha256:${PIN_HEX}` } });
  const pid = names.find((p) => p.Name === 'PersistentIdFix');
  assert.deepEqual(pid, { Name: 'PersistentIdFix', Repo: 'StarRupture-Plugin-PersistentIdFix', LogName: 'PersistentIdFix', Asset: 'PersistentIdFix', Owner: 'LetMeInside', StripV: true, UiOffInitFailure: 'PersistentIdFix: failed to initialize statistics UI', Pin: { Tag: PID_TAG, Digest: `sha256:${PID_HEX}`, Facts: { InterfaceVersion: 75, GameBuild: 'CL-127004 (none declared)', Migrated: false, ObservedIn: 'scan of this digest in client check runs 44538450666 (CL-130045) and 44113512685 (CL-129402)' } } });
  // The other nine keep the rig's owner and Latest: no owner, no pin.
  for (const p of names.filter((x) => !THIRD_PARTY.includes(x.Name))) {
    assert.ok(!('Owner' in p) && !('StripV' in p) && !('LoggedVersion' in p) && !('Pin' in p) && !('UiOffInitFailure' in p), `${p.Name}: unchanged`);
  }
  // Every plugin whose owner is neither the rig's nor the loader's author has a pin.
  for (const p of names.filter((x) => x.Owner && !['msantoro12', 'AlienXAXS'].includes(x.Owner))) assert.ok(p.Pin?.Tag && /^sha256:[0-9a-f]{64}$/.test(p.Pin.Digest), `${p.Name} is pinned`);
  assert.match(setup, /the eleven plugins/);
  assert.ok(!/one of the nine/.test(setup), 'the script no longer counts nine');
});

test('rig set: docs say eleven and name the MiniMap and PersistentIdFix source repos', () => {
  const readme = read('.github', 'sr-pipeline', 'README.md');
  assert.match(readme, /LetMeInside\/StarRupture-Plugin-MiniMap/);
  assert.match(readme, /LetMeInside\/StarRupture-Plugin-PersistentIdFix/);
  assert.match(readme, /eleven plugins/);
  assert.ok(!/one of the nine/.test(readme), 'no "one of the nine" left');
  assert.match(readme, /not one of the eleven is an extra plugin/);
  assert.ok(!/one of the ten/.test(readme), 'no "one of the ten" left');
  assert.match(wf, /MiniMap/, 'the tags input lists MiniMap');
  assert.match(wf, /PersistentIdFix/, 'the tags input lists PersistentIdFix');
});

// Runs Resolve with a stand-in releases API: every repo has a Latest release holding the
// client DLL beside a zip and a manifest (MiniMap's real layout), the loader its client zip.
// minimapLatest is the tag /latest names for MiniMap, minimapDigest the digest of its client DLL
// on every release, plugins the plugin-names.json the script reads (default: the repository's).
function resolveWithMock(args, { minimapLatest = PIN_TAG, minimapDigest = PIN_HEX, plugins = null, rigBranches = null } = {}) {
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
    copyFileSync(join(here, 'plugin-owners.json'), join(tool, 'plugin-owners.json'));
    // The list of rigged branches, where the script looks for it (beside ci/, under .github/sr-pipeline).
    mkdirSync(join(dir, '.github', 'sr-pipeline'), { recursive: true });
    writeFileSync(join(dir, '.github', 'sr-pipeline', 'rig-branches.json'), JSON.stringify(rigBranches ?? JSON.parse(readFileSync(join(here, '..', '.github', 'sr-pipeline', 'rig-branches.json'), 'utf8'))));
    writeFileSync(wrapper, [
      "$ErrorActionPreference = 'Stop'",
      `$names = Get-Content -LiteralPath '${join(tool, 'plugin-names.json')}' -Raw | ConvertFrom-Json`,
      'function Invoke-RestMethod { param($Headers, $Uri, $TimeoutSec)',
      `  Add-Content -LiteralPath '${uris}' -Value $Uri`,
      '  if ($Uri -notmatch \'/repos/([^/]+)/([^/]+)/releases/(latest|tags/(.+))$\') { throw "unexpected $Uri" }',
      `  $repo = $Matches[2]; $p = $names | Where-Object { $_.Repo -eq $repo }`,
      `  $tag = if ($Matches[4]) { $Matches[4] } elseif ($repo -eq 'StarRupture-Plugin-MiniMap') { '${minimapLatest}' } elseif ($p -and $p.PSObject.Properties['Pin']) { $p.Pin.Tag } else { 'v1.0.0' }`,
      `  $digest = if ($repo -eq 'StarRupture-Plugin-MiniMap') { 'sha256:${minimapDigest}' } elseif ($p -and $p.PSObject.Properties['Pin']) { $p.Pin.Digest } else { 'sha256:' + ('a' * 64) }`,
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

test('rig set: Resolve gives eleven plugins, MiniMap and PersistentIdFix from LetMeInside at their pinned releases, their DLLs picked, their logged versions without the v', (t) => {
  const out = resolveWithMock('-Branch public');
  if (!out) return t.skip('no PowerShell on this machine');
  assert.equal(out.r.status, 0, out.text);
  assert.equal(out.plan.plugins.length, 11);
  const pid = out.plan.plugins.find((p) => p.name === 'PersistentIdFix');
  assert.equal(pid.tag, PID_TAG);
  assert.equal(pid.expect, '1.3.1', 'the log prints 1.3.1 for the tag v1.3.1');
  assert.equal(pid.logName, 'PersistentIdFix');
  assert.equal(pid.dll, 'PersistentIdFix.dll');
  assert.equal(pid.asset.name, 'PersistentIdFix-Client.dll', 'the client DLL, not the zip or the manifest');
  assert.equal(pid.uiOffInitFailure, 'PersistentIdFix: failed to initialize statistics UI');
  assert.ok(out.uris.includes(`https://api.github.com/repos/LetMeInside/StarRupture-Plugin-PersistentIdFix/releases/tags/${PID_TAG}`), out.uris.join('\n'));
  assert.ok(!out.uris.some((u) => /AlienXAXS\/StarRupture-Plugin-PersistentIdFix/.test(u)), 'PersistentIdFix is not looked up under the rig owner');
  assert.equal(out.plan.downloads.find((d) => d.repo === 'StarRupture-Plugin-PersistentIdFix').digest, PID_HEX);
  const m = out.plan.plugins.find((p) => p.name === 'MiniMap');
  assert.equal(m.tag, PIN_TAG);
  assert.equal(m.expect, '1.3.1', 'the v1.3.1 DLL logs its real version, the tag minus v');
  assert.equal(m.logName, 'MiniMap');
  assert.equal(m.dll, 'MiniMap.dll');
  assert.equal(m.expectRefused, false, 'refused on public is a fail');
  // Its init needs the UI layer the rig turns off: the data comes from plugin-names.json, and no other plugin has it.
  assert.equal(m.uiOffInitFailure, 'MiniMap: atlas texture interface initialization failed');
  assert.deepEqual(out.plan.plugins.filter((p) => p.uiOffInitFailure).map((p) => p.name), ['MiniMap', 'PersistentIdFix']);
  assert.equal(m.asset.name, 'MiniMap-Client.dll', 'the client DLL, not the zip or the manifest');
  // The pinned release is fetched by its tag; Latest is only asked about, to see whether a newer one waits.
  assert.ok(out.uris.includes(MINIMAP_PIN_URL), out.uris.join('\n'));
  assert.ok(out.uris.includes('https://api.github.com/repos/AlienXAXS/StarRupture-Plugin-Codex/releases/latest'));
  assert.ok(!out.uris.some((u) => /StarRupture-Plugin-Codex\/releases\/tags/.test(u)), 'the nine owner and AlienX plugins resolve Latest, not a tag');
  assert.ok(!out.uris.some((u) => /AlienXAXS\/StarRupture-Plugin-MiniMap/.test(u)), 'MiniMap is not looked up under the rig owner');
  // The other nine are as before: the tag is what the log must show.
  for (const p of out.plan.plugins.filter((x) => !THIRD_PARTY.includes(x.name))) assert.equal(p.expect, 'v1.0.0', `${p.name} keeps the tag`);
  // The cache key covers MiniMap's asset id and the reviewed digest, which is what the download is checked against.
  const dl = out.plan.downloads.find((d) => d.repo === 'StarRupture-Plugin-MiniMap');
  assert.equal(dl.id, '11');
  assert.equal(dl.digest, PIN_HEX);
  // Latest is the pinned release: nothing waits for review.
  assert.deepEqual(out.plan.review, []);
  assert.match(out.outputs, /^review=$/m);
});

test('rig set: LoggedVersion, when a plugin names one, is the version the log must show; without it the tag minus v (StripV) or the tag stands', (t) => {
  const edit = (fn) => names.map((p) => fn(p));
  const find = (out, n) => out.plan.plugins.find((p) => p.name === n);
  // (a) The override is used when present, on a plugin that has StripV and on one that has not.
  const withOverride = resolveWithMock('-Branch public', { plugins: edit((p) => (p.Name === 'PersistentIdFix' ? { ...p, LoggedVersion: '1.3.0' } : p.Name === 'Codex' ? { ...p, LoggedVersion: '9.9.9' } : p)) });
  if (!withOverride) return t.skip('no PowerShell on this machine');
  assert.equal(withOverride.r.status, 0, withOverride.text);
  assert.equal(find(withOverride, 'PersistentIdFix').expect, '1.3.0', 'LoggedVersion beats the tag minus v');
  assert.equal(find(withOverride, 'PersistentIdFix').tag, PID_TAG, 'the tag fetched is unchanged');
  assert.equal(find(withOverride, 'Codex').expect, '9.9.9', 'LoggedVersion beats the plain tag');
  // The rig's own expect input still outranks it.
  const input = resolveWithMock("-Branch public -Expect 'Codex=v7.7.7'", { plugins: edit((p) => (p.Name === 'Codex' ? { ...p, LoggedVersion: '9.9.9' } : p)) });
  assert.equal(input.r.status, 0, input.text);
  assert.equal(find(input, 'Codex').expect, 'v7.7.7');
  // (b) Without LoggedVersion nothing changes: StripV drops the v, no StripV keeps the tag.
  const without = resolveWithMock('-Branch public', { plugins: edit(({ LoggedVersion, LoggedVersionNote, ...rest }) => rest) });
  assert.equal(without.r.status, 0, without.text);
  assert.equal(find(without, 'MiniMap').expect, '1.3.1');
  assert.equal(find(without, 'PersistentIdFix').expect, '1.3.1');
  assert.equal(find(without, 'Codex').expect, 'v1.0.0');
  // (c) The repository's names file: MiniMap's pinned v1.3.1 DLL logs 1.3.1, the tag minus v.
  const real = resolveWithMock('-Branch public');
  assert.equal(find(real, 'MiniMap').tag, PIN_TAG);
  assert.equal(find(real, 'MiniMap').expect, '1.3.1');
  assert.deepEqual(real.plan.plugins.filter((p) => p.name !== 'MiniMap' && names.find((n) => n.Name === p.name).LoggedVersion), [], 'only MiniMap has an override');
});

test('rig set: a newer MiniMap release is reported for review and never run, and the other plugins are unaffected', (t) => {
  const out = resolveWithMock('-Branch public', { minimapLatest: 'v1.4.0', minimapDigest: PIN_HEX });
  if (!out) return t.skip('no PowerShell on this machine');
  assert.equal(out.r.status, 0, out.text);
  // Still the pinned release: same tag, same digest, same asset, fetched by its tag.
  const m = out.plan.plugins.find((p) => p.name === 'MiniMap');
  assert.equal(m.tag, PIN_TAG);
  assert.equal(m.expect, '1.3.1');
  assert.equal(out.plan.downloads.find((d) => d.repo === 'StarRupture-Plugin-MiniMap').digest, PIN_HEX);
  assert.ok(out.uris.includes(MINIMAP_PIN_URL) && out.uris.includes(MINIMAP_LATEST_URL), out.uris.join('\n'));
  // The newer tag is the review item: in the plan, the step output and a loud workflow line.
  assert.deepEqual(out.plan.review, ['MiniMap=v1.4.0']);
  assert.match(out.outputs, /^review=MiniMap=v1.4.0$/m);
  assert.match(out.text, /::warning title=New release waiting for review::new MiniMap release v1.4.0 waiting for review/);
  // The run is not blocked and the cache key does not move with the unreviewed release.
  const same = resolveWithMock('-Branch public');
  assert.equal(out.plan.cacheKey, same.plan.cacheKey);
  assert.equal(out.plan.plugins.length, 11);
});

test('rig set: the pinned tag with another digest fails, and says why', (t) => {
  const out = resolveWithMock('-Branch public', { minimapDigest: 'b'.repeat(64) });
  if (!out) return t.skip('no PowerShell on this machine');
  assert.notEqual(out.r.status, 0, 'a swapped asset is a failed run, not a warning');
  assert.match(out.text, /MiniMap v1.3.1: the release's MiniMap-Client\.dll has the digest sha256:b{64}, not the reviewed sha256:5d6e8f6dde78abaaed335041c69efab856409711507800a92b1fb4fca3b4764f/);
  assert.equal(out.plan, null, 'no plan is written, so nothing runs');
});

test('rig set: a plugin of another author without a reviewed pin, or with a malformed one, is refused', (t) => {
  const withMiniMap = (change) => names.map((p) => (p.Name === 'MiniMap' ? change(p) : p));
  const without = resolveWithMock('-Branch public', { plugins: withMiniMap(({ Pin, ...rest }) => rest) });
  if (!without) return t.skip('no PowerShell on this machine');
  assert.notEqual(without.r.status, 0);
  assert.match(without.text, /MiniMap is another author's plugin \(LetMeInside\), and the rig runs it only at a reviewed release: add a Pin/);
  assert.ok(!without.uris.some((u) => /StarRupture-Plugin-MiniMap/.test(u)), 'refused before any release is read');
  const badTag = resolveWithMock('-Branch public', { plugins: withMiniMap((p) => ({ ...p, Pin: { ...p.Pin, Tag: 'v1.3.0; calc' } })) });
  assert.notEqual(badTag.r.status, 0);
  assert.match(badTag.text, /the Pin tag 'v1.3.0; calc' is not a release tag/);
  for (const digest of ['sha256:abc', `sha256:${PIN_HEX.toUpperCase()}`, PIN_HEX, 'sha1:' + PIN_HEX]) {
    const bad = resolveWithMock('-Branch public', { plugins: withMiniMap((p) => ({ ...p, Pin: { ...p.Pin, Digest: digest } })) });
    assert.notEqual(bad.r.status, 0, digest);
    assert.match(bad.text, /the Pin digest '.*' is not sha256:<64 lower-case hex digits>/, digest);
  }
  // The nine of the rig owner and AlienX need no pin (they resolve Latest, as before).
  assert.equal(resolveWithMock('-Branch public').r.status, 0);
});

test('rig set: GoodStuffSoftware is trusted for the repositories listed in ci/plugin-owners.json only (sr-bestbuilder), never for its others', (t) => {
  const entry = (Repo) => ({ Name: 'BestBuilder', Repo, LogName: 'Best Builder', Asset: 'BestBuilder', Owner: 'GoodStuffSoftware' });
  const ok = resolveWithMock('-Branch public', { plugins: [...names, entry('sr-bestbuilder')] });
  if (!ok) return t.skip('no PowerShell on this machine');
  assert.equal(ok.r.status, 0, ok.text);
  const bb = ok.plan.plugins.find((p) => p.name === 'BestBuilder');
  assert.equal(bb.tag, 'v1.0.0', 'run at its latest release, no Pin');
  assert.ok(ok.uris.includes('https://api.github.com/repos/GoodStuffSoftware/sr-bestbuilder/releases/latest'), ok.uris.join(' '));
  for (const repo of ['website', 'sr-perftuner', 'StarRupture-Plugin-BestBuilder']) {
    const bad = resolveWithMock('-Branch public', { plugins: [...names, { ...entry(repo), Name: 'Other', Asset: 'Other' }] });
    assert.notEqual(bad.r.status, 0, repo);
    assert.match(bad.text, /GoodStuffSoftware is trusted only for the repositories sr-bestbuilder/, repo);
    assert.ok(!bad.uris.some((u) => u.includes('/GoodStuffSoftware/')), `${repo}: refused before any release is read`);
  }
});

test('rig set: expect_refused MiniMap is accepted for the branch that runs CL-129402, and a tag override can only name the reviewed release', (t) => {
  const out = resolveWithMock(`-Branch public_test_branch -ExpectRefused 'MiniMap' -Tags 'MiniMap=${PIN_TAG}'`);
  if (!out) return t.skip('no PowerShell on this machine');
  assert.equal(out.r.status, 0, out.text);
  const m = out.plan.plugins.find((p) => p.name === 'MiniMap');
  assert.equal(m.expectRefused, true);
  assert.equal(m.tag, PIN_TAG);
  assert.equal(m.expect, '1.3.1');
  assert.ok(out.uris.includes(MINIMAP_PIN_URL), out.uris.join('\n'));
  // Another tag for a third-party plugin is an error, however it is asked for.
  const other = resolveWithMock("-Branch public -Tags 'MiniMap=v1.1.0'");
  assert.notEqual(other.r.status, 0);
  assert.match(other.text, /tags names MiniMap=v1\.1\.0, but MiniMap is another author's plugin: the rig runs only its reviewed release v1.3.1/);
  assert.ok(!other.uris.some((u) => /MiniMap\/releases\/tags\/v1\.1\.0/.test(u)), 'the unreviewed tag is never fetched');
  // A tag for a plugin of the rig's owners still works.
  const codex = resolveWithMock("-Branch public -Tags 'Codex=v0.9.0'");
  assert.equal(codex.r.status, 0, codex.text);
  assert.ok(codex.uris.includes('https://api.github.com/repos/AlienXAXS/StarRupture-Plugin-Codex/releases/tags/v0.9.0'));
});

test('rig set: expect_decline marks the plan, is only true or false, and cannot be asked for beside expect_refused', (t) => {
  const plain = resolveWithMock('-Branch public_test_branch');
  if (!plain) return t.skip('no PowerShell on this machine');
  assert.equal(plain.plan.expectDecline, false, 'a build the map has a row for is a boot, as before');
  assert.equal(resolveWithMock("-Branch public_test_branch -ExpectDecline 'false'").plan.expectDecline, false);
  const decline = resolveWithMock("-Branch public_test_branch -ExpectDecline 'true'");
  assert.equal(decline.r.status, 0, decline.text);
  assert.equal(decline.plan.expectDecline, true);
  const bad = resolveWithMock("-Branch public_test_branch -ExpectDecline 'yes'");
  assert.notEqual(bad.r.status, 0);
  assert.match(bad.text, /expect_decline is 'yes', not true or false/);
  const both = resolveWithMock("-Branch public_test_branch -ExpectDecline 'true' -ExpectRefused 'MiniMap'");
  assert.notEqual(both.r.status, 0);
  assert.match(both.text, /expect_decline and expect_refused exclude each other/);
});

test('rig set: known_cls goes into the plan with expect_decline only, as CL numbers', (t) => {
  const plain = resolveWithMock('-Branch public_test_branch');
  if (!plain) return t.skip('no PowerShell on this machine');
  assert.deepEqual(plain.plan.knownCls, [], 'nothing known is nothing declared');
  const ok = resolveWithMock("-Branch public_test_branch -ExpectDecline 'true' -KnownCls '127004 129402'");
  assert.equal(ok.r.status, 0, ok.text);
  assert.deepEqual(ok.plan.knownCls, [127004, 129402]);
  const alone = resolveWithMock("-Branch public_test_branch -KnownCls '127004'");
  assert.notEqual(alone.r.status, 0);
  assert.match(alone.text, /known_cls only goes with expect_decline/);
  const odd = resolveWithMock("-Branch public_test_branch -ExpectDecline 'true' -KnownCls '127004 abc'");
  assert.notEqual(odd.r.status, 0);
  assert.match(odd.text, /known_cls names 'abc', which is not a CL number/);
});

test('rig set: the branch must be one of the rig branches in .github/sr-pipeline/rig-branches.json, and adding a branch there is all it takes', (t) => {
  const listed = JSON.parse(readFileSync(join(here, '..', '.github', 'sr-pipeline', 'rig-branches.json'), 'utf8'));
  assert.ok(listed.includes('public') && listed.includes('public_test_branch') && listed.includes('v.0.3.5_for_ds'), 'today the list is public, the test branch and the second client branch');
  for (const b of listed) {
    const ok = resolveWithMock(`-Branch ${b}`);
    if (!ok) return t.skip('no PowerShell on this machine');
    assert.equal(ok.r.status, 0, ok.text);
    assert.equal(ok.plan.branch, b);
  }
  // A branch outside the list is refused, naming the list.
  const no = resolveWithMock('-Branch v.9.9.9_unlisted');
  assert.notEqual(no.r.status, 0);
  assert.match(no.text, /branch 'v\.9\.9\.9_unlisted' is not one of the rig branches \(public, public_test_branch, v\.0\.3\.5_for_ds\)/);
  // The same branch, added to the list and nothing else, is rigged.
  const added = resolveWithMock('-Branch v.9.9.9_unlisted', { rigBranches: [...listed, 'v.9.9.9_unlisted'] });
  assert.equal(added.r.status, 0, added.text);
  assert.equal(added.plan.branch, 'v.9.9.9_unlisted');
  // A branch that left the list is no longer accepted.
  assert.notEqual(resolveWithMock('-Branch public_test_branch', { rigBranches: ['public'] }).r.status, 0);
  // The Steam install step takes a dotted name too (it is only checked as a plain name before it reaches steamcmd).
  assert.ok(read('ci', 'client-rig-launch.ps1').includes("-notmatch '^[A-Za-z0-9_.]+$') { throw \"bad branch name '$Branch'\""));
});

test('rig workflow: expect_decline reaches the set step through the environment, not the script text', () => {
  assert.equal(wf.match(/\n {6}expect_decline:\n {8}description:/g)?.length, 2, 'declared by both triggers');
  assert.match(wf, /\n {6}EXPECT_DECLINE: \$\{\{ inputs\.expect_decline \}\}\n/);
  assert.ok(wf.includes('-ExpectDecline $env:EXPECT_DECLINE -KnownCls $env:KNOWN_CLS'));
  assert.equal(wf.match(/\n {6}known_cls:\n {8}description:/g)?.length, 2, 'declared by both triggers');
  assert.match(wf, /\n {6}KNOWN_CLS: \$\{\{ inputs\.known_cls \}\}\n/);
  assert.ok(!/-ExpectDecline \$\{\{/.test(wf), 'never interpolated into the command');
});

// The loader (v1.26.0 and later) logs these lines when it runs a build its version object map has no row for on the
// newest known build's values (core/version_check.cpp). An unmapped-build rig passes as a boot when it sees them, and
// as a clean decline when it does not; if the loader's wording moves, the verdict must move with it.
test('rig verdict: an unmapped build passes as a clean decline or as a fallback boot, on the loader\'s own lines', () => {
  for (const s of ["Trying the newest known build's values", 'Unknown game build:', 'is not in the version object map', 'Unknown-build session marked', 'Phase skipped:']) {
    assert.ok(verdictPs.includes(s), `verdict.ps1 matches the loader line "${s}"`);
  }
  assert.match(verdictPs, /\$fallback = \$unmapped -and/);
  assert.match(verdictPs, /if \(\$unmapped -and -not \$fallback\)/);
  assert.match(verdictPs, /VERSION MISMATCH/, 'the clean decline is still judged');
});

test('rig artifact: its name carries the branch, the candidate and the run, so two rigs of one run do not collide', () => {
  assert.match(wf, /\n {6}ARTIFACT_NAME: sr-client-rig-\$\{\{ inputs\.branch \}\}-\$\{\{ inputs\.candidate_artifact \|\| 'release' \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\n/);
  assert.match(step('Upload the scrubbed logs'), /name: \$\{\{ env\.ARTIFACT_NAME \}\}/);
  assert.equal(wf.match(/ARTIFACT_NAME:/g)?.length, 1, 'one definition, read by the upload and the final step');
});

// ---- the leak gate and the cleanup are shared scripts: run the gate for real ----------------------

// Runs ci/leak-gate.ps1 the way a workflow step does: the login in the environment, RUNNER_TEMP
// holding the hold and terms files. `files` maps a name under the scanned folder to its content.
function runGate(args, { files = null, hold = '', terms = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rig-gate-'));
  try {
    const out = join(dir, 'out');
    if (files) {
      mkdirSync(out);
      for (const [n, c] of Object.entries(files)) {
        mkdirSync(dirname(join(out, n)), { recursive: true });
        writeFileSync(join(out, n), c);
      }
    }
    if (hold) writeFileSync(join(dir, 'rig-hold.txt'), hold);
    if (terms) writeFileSync(join(dir, 'rig-gate-terms.txt'), terms);
    const vdf = '"Accounts"\n{\n\t"acct1"\n\t{\n\t\t"Token"\t\t"LONGSECRETTOKEN1234567890"\n\t}\n}\n';
    const env = { ...process.env, RUNNER_TEMP: dir, STEAM_USER: 'acct1', STEAM_CACHE: Buffer.from(vdf).toString('base64') };
    for (const exe of ['pwsh', 'powershell']) {
      const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-File', join(here, 'leak-gate.ps1'), '-Path', out, ...args], { encoding: 'utf8', env, windowsHide: true });
      if (!r.error) return { ...r, termsLeft: existsSync(join(dir, 'rig-gate-terms.txt')) };
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('leak gate, the rig\'s call: clean output passes; a missing folder passes only with -AllowMissing', (t) => {
  const ok = runGate(['-AllowMissing'], { files: { 'boot.json': '{"process_found":true}' } });
  if (!ok) return t.skip('no PowerShell on this machine');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /No account data in 1 file/);
  assert.equal(runGate(['-AllowMissing']).status, 0, 'no output folder is not a leak');
  assert.equal(runGate([]).status, 1, 'without -AllowMissing a missing folder fails');
});

test('leak gate, the rig\'s call: the name, a login value, an id and a recorded term each fail it', (t) => {
  if (!runGate(['-AllowMissing'])) return t.skip('no PowerShell on this machine');
  for (const [what, content] of [
    ['the account name', 'user ACCT1 signed in'],
    ['a long login value', 'x longsecrettoken1234567890 y'],
    ['a SteamID64', 'id 76561198000000001'],
    ['a SteamID3', 'id [U:1:39734273]'],
  ]) {
    const r = runGate(['-AllowMissing'], { files: { 'modloader.log': content } });
    assert.equal(r.status, 1, `${what} fails the gate`);
    assert.match(r.stdout, /::error::Account data found in modloader\.log/);
  }
  const term = runGate(['-AllowMissing'], { files: { 'a.log': 'persona Gamer One here' }, terms: 'Gamer One\n' });
  assert.equal(term.status, 1);
  assert.equal(term.termsLeft, false, 'the terms file is removed once read');
});

test('leak gate, the rig\'s call: a hold from the launch fails it before anything is read', (t) => {
  const r = runGate(['-AllowMissing'], { files: { 'a.log': 'fine' }, hold: 'The Steam persona name could not be determined.' });
  if (!r) return t.skip('no PowerShell on this machine');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::The Steam persona name could not be determined\./);
  assert.ok(!/No account data/.test(r.stdout));
});

test('leak gate, the rig\'s call: a secret-shaped value in an attempt1 file fails it; a clean attempt1 folder passes', (t) => {
  const clean = runGate(['-AllowMissing'], {
    files: {
      'boot.json': '{"process_found":true}',
      'attempt1/dialog.txt': 'Static=Application load error 6:0000065432 | Button=OK',
      'attempt1/steam-content_log.txt': '[2026-11-20 12:00:00] AppID 1631270 state changed : Fully Installed,',
    },
  });
  if (!clean) return t.skip('no PowerShell on this machine');
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /No account data in 3 file/, 'the gate reads the folder under out/');
  for (const [what, name, content] of [
    ['the account name in the dialog text', 'attempt1/dialog.txt', 'Steam Error: ACCT1 cannot start the game'],
    ['a login value in a Steam log', 'attempt1/steam-console_log.txt', '[2026-11-20 12:00:01] token longsecrettoken1234567890'],
    ['a SteamID64 in the game log', 'attempt1/game-StarRupture.log', 'LogOnline: user 76561198000000001'],
    ['a SteamID3 in the loader log', 'attempt1/modloader.log', 'owner [U:1:39734273]'],
  ]) {
    const r = runGate(['-AllowMissing'], { files: { 'boot.json': '{}', [name]: content } });
    assert.equal(r.status, 1, `${what} fails the gate`);
    const leaf = name.split('/').pop().replace('.', '\\.');
    assert.match(r.stdout, new RegExp(`::error::Account data found in ${leaf}`));
    assert.ok(!/longsecrettoken1234567890|76561198000000001/i.test(r.stdout), 'the gate does not print the value');
  }
  const persona = runGate(['-AllowMissing'], { files: { 'attempt1/steam-content_log.txt': 'persona Gamer One here' }, terms: 'Gamer One\n' });
  assert.equal(persona.status, 1, 'a persona the launch recorded fails the gate in attempt1');
});

test('attempt1 evidence: kept before the relaunch clears anything, only on the load error, never for the data extract', () => {
  const loop = launch.slice(launch.indexOf('$attempts = @()'), launch.indexOf('# Facts first, then the stop'));
  // The relaunch rule itself is unchanged.
  assert.match(loop, /for \(\$n = 1; \$n -le \(1 \+ \$MaxRelaunch\); \$n\+\+\) \{\n {8}\$last = Invoke-Attempt \$n\n {8}\$attempts \+= , \$last\n {8}if \(-not \$last\.load_error -or \$n -gt \$MaxRelaunch\) \{ break \}\n/);
  assert.match(launch, /\[int\]\$MaxRelaunch = 2/);
  // The capture sits after that check and before Stop-Game (the relaunch's Reset-GameState clears the logs and crash folders).
  const save = loop.indexOf('Save-AttemptEvidence $last');
  assert.ok(save > loop.indexOf('$n -gt $MaxRelaunch) { break }'), 'only when a relaunch follows');
  assert.ok(save < loop.indexOf('Stop-Game'), 'before the game is stopped');
  assert.match(loop, /if \(\$n -eq 1 -and -not \$PayloadScript\) \{ Save-AttemptEvidence \$last \}/);
  assert.equal(launch.match(/Save-AttemptEvidence \$last/g).length, 1);
  const reset = launch.slice(launch.indexOf('function Reset-GameState'), launch.indexOf('# ---- evidence of an attempt'));
  assert.match(reset, /Remove-Item/, 'the clearing the capture runs ahead of is still there');
  // The files are written after the persona is known, so the scrub covers it, and through Scrub.
  const write = launch.indexOf("Write-AttemptEvidence 'attempt1'");
  assert.ok(write > launch.indexOf('$persona = Read-Personas') && write < launch.indexOf('$boot = [ordered]@{'));
  assert.match(launch, /\(Scrub \$script:evidence\[\$k\]\)/);
  // Nothing about the verdict moved: boot.json's attempts, and the verdict never reads the folder.
  assert.match(launch, /attempts = @\(\$attempts \| ForEach-Object \{ \[ordered\]@\{ n = \$_\.n; seconds = \$_\.seconds; end = \$_\.end; steam_load_error = \$_\.load_error \} \}\)/);
  assert.ok(!/attempt1|Save-AttemptEvidence/i.test(verdictPs), 'verdict.ps1 does not read the attempt1 folder');
  assert.ok(!/Retry\s*=\s*1/.test(launch + setup), 'no retry setting');
  // The data extract (a payload) makes none: its upload and gate do not read out/.
  assert.ok(!/attempt1/.test(read('.github', 'workflows', 'sr-data-extract.yml').replace(/#.*$/gm, '')));
});

test('attempt1 evidence: a capture that fails is a log line, never a failed launch', () => {
  const block = launch.slice(launch.indexOf('# ---- evidence of an attempt'), launch.indexOf('function Stop-Game'));
  for (const fn of ['Save-AttemptEvidence', 'Write-AttemptEvidence']) {
    const body = block.slice(block.indexOf(`function ${fn}`));
    assert.match(body.slice(0, body.indexOf('\n}\n')), /\n {4}try \{[\s\S]*\} catch \{ Say "Attempt evidence: [^"]*" \}$/, `${fn} catches everything and says so`);
  }
  assert.match(block, /function Add-Evidence[^\n]*\n {4}try \{[^\n]*\n {4}catch \{ Say "Attempt evidence: /);
  assert.ok(!/\bthrow\b|Stop-With|Set-Reason|Set-Hold|exit \d/.test(block), 'the capture cannot stop the rig or hold the logs');
  assert.match(block, /Wait-Job -Job \$job -Timeout 20/, 'the UI Automation read is bounded');
});

test('attempt1 evidence: read-only on the dialog, no screenshot, only Steam and game processes', () => {
  const block = launch.slice(launch.indexOf('# ---- evidence of an attempt'), launch.indexOf('function Stop-Game'));
  const code = block.replace(/^\s*#.*$/gm, '');
  assert.ok(!/SendMessage|PostMessage|SendInput|keybd_event|mouse_event|SetCursorPos|SendKeys|SetForegroundWindow|ShowWindow|EnableWindow|CloseWindow|DestroyWindow|CloseMainWindow|BM_CLICK|WM_/i.test(code), 'no message, key or mouse call');
  assert.ok(!/InvokePattern|TogglePattern|SelectionItemPattern|ExpandCollapsePattern|WindowPattern|\.SetValue\(|\.Invoke\(|\.Select\(|\.Toggle\(|\.Close\(|SetFocus|DoDefaultAction/.test(code), 'only reading UI Automation patterns');
  assert.ok(!/Stop-Process|\.Kill\(|Start-Process|Remove-Item|Set-Content|Out-File/.test(code.replace(/Remove-Job[^\n]*/g, '').replace(/Stop-Job[^\n]*/g, '')), 'nothing is stopped, started or deleted');
  assert.ok(!/CopyFromScreen|PrintWindow|System\.Drawing|Screenshot|\.png|\.jpg|\.bmp/i.test(code), 'no screenshot');
  // Win32 calls the rig can make: enumerate and read, nothing else.
  const imports = [...launch.matchAll(/\[DllImport\("user32\.dll"[^\]]*\)\] static extern \w+ (\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['EnumChildWindows', 'EnumWindows', 'GetClassNameW', 'GetWindowTextW', 'GetWindowThreadProcessId', 'IsWindowVisible']);
  assert.match(code, /\$evidenceProcRx = '\^\(steam\|gameoverlayui\|StarRupture\|UnrealCEF\|CrashReport\|WerFault\)'/);
  assert.match(code, /\$p\.ProcessName -match \$evidenceProcRx/);
  // The Steam logs: an allowlist that leaves connection_log out.
  assert.match(code, /\$steamEvidenceLogs = @\('content_log\.txt', 'console_log\.txt', 'bootstrap_log\.txt', 'compat_log\.txt', 'gameprocess_log\.txt'\)/);
  assert.ok(!/connection_log/.test(code), 'the connection log is not kept');
});

test('attempt1 evidence: the helpers that cut the logs', (t) => {
  const fns = ['Get-Tail', 'Get-LogWindow'].map((n) => launch.match(new RegExp(`^function ${n}\\b[\\s\\S]*?\\n}\\n`, 'm'))[0]).join('\n');
  const script = `$ErrorActionPreference = 'Stop'\n${fns}\n` +
    "$log = \"[2026-11-20 12:00:00] before`n[2026-11-20 12:00:20] launch`r`ncontinued`n[2026-11-20 12:00:30] Application load error\"\n" +
    "'WIN=' + ((Get-LogWindow $log ([datetime]'2026-11-20 12:00:10')) -join '|')\n" +
    "'NONE=' + @(Get-LogWindow $log ([datetime]'2026-11-20 13:00:00')).Count\n" +
    "'CAP=' + @(Get-LogWindow $log ([datetime]'2026-11-20 11:00:00') 2).Count\n" +
    "'TAIL=' + ((Get-Tail \"a`nb`nc`nd\" 2) -join ',')";
  let r = null;
  for (const exe of ['pwsh', 'powershell']) {
    r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    if (!r.error) break;
  }
  if (!r || r.error) return t.skip('no PowerShell on this machine');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^WIN=\[2026-11-20 12:00:20\] launch\|continued\|\[2026-11-20 12:00:30\] Application load error$/m);
  assert.match(r.stdout, /^NONE=0$/m);
  assert.match(r.stdout, /^CAP=2$/m);
  assert.match(r.stdout, /^TAIL=c,d$/m);
});

test('leak gate, -Strict (the data extract): bytes, login-file names, and digit-bounded numeric terms', (t) => {
  if (!runGate(['-Strict'], { files: { 'x.json': '{}' } })) return t.skip('no PowerShell on this machine');
  // Binary content is scanned byte for byte.
  const bin = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe]), Buffer.from('76561198000000001'), Buffer.from([0, 1, 2])]);
  assert.equal(runGate(['-Strict'], { files: { 'icon.png': bin } }).status, 1, 'a SteamID64 inside a binary file');
  // A login-file name fails even with harmless content.
  for (const n of ['config.vdf', 'loginusers.vdf', 'ssfn1234567890', 'steam_appid.txt']) {
    assert.equal(runGate(['-Strict'], { files: { [n]: 'ok' } }).status, 1, `${n} is refused by name`);
  }
  // A digits-only term (an id32) matches on its own, not inside a longer number.
  const inside = runGate(['-Strict'], { files: { 'n.json': '{"v":91234567891}' }, terms: '123456789\n' });
  assert.equal(inside.status, 0, inside.stdout);
  const alone = runGate(['-Strict'], { files: { 'n.json': '{"v":123456789}' }, terms: '123456789\n' });
  assert.equal(alone.status, 1);
  // The same long number is a hit without -Strict: the rig's matching is unchanged.
  assert.equal(runGate(['-AllowMissing'], { files: { 'n.json': '{"v":91234567891}' }, terms: '123456789\n' }).status, 1);
  // The name and a clean file still behave as in the rig.
  assert.equal(runGate(['-Strict'], { files: { 'n.json': 'ACCT1' } }).status, 1);
  assert.equal(runGate(['-Strict'], { files: { 'n.json': '{"ok":true}' } }).status, 0);
});

// The data extract passes the gate an array of folders (stage and the SDK), as a workflow step does.
test('leak gate, several folders (the data extract): every folder is read, and a missing one fails', (t) => {
  const run = (files2, second = 'out2') => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-gate-'));
    try {
      const a = join(dir, 'out'); const b = join(dir, second);
      mkdirSync(a); writeFileSync(join(a, 'x.json'), '{}');
      if (files2) { mkdirSync(join(dir, 'out2')); for (const [n, c] of Object.entries(files2)) writeFileSync(join(dir, 'out2', n), c); }
      const vdf = '"Accounts"\n{\n\t"acct1"\n\t{\n\t\t"Token"\t\t"LONGSECRETTOKEN1234567890"\n\t}\n}\n';
      const env = { ...process.env, RUNNER_TEMP: dir, STEAM_USER: 'acct1', STEAM_CACHE: Buffer.from(vdf).toString('base64') };
      const cmd = `& '${join(here, 'leak-gate.ps1')}' -Path @('${a}', '${b}') -Strict; exit $LASTEXITCODE`;
      for (const exe of ['pwsh', 'powershell']) {
        const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', env, windowsHide: true });
        if (!r.error) return r;
      }
      return null;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const clean = run({ 'SDK.hpp': '#pragma once' });
  if (!clean) return t.skip('no PowerShell on this machine');
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /No account data in 2 file\(s\) under /);
  const leak = run({ 'SDK.hpp': '// signed in as ACCT1' });
  assert.equal(leak.status, 1, 'a hit in the second folder fails the gate');
  assert.match(leak.stdout, /::error::Account data found in SDK\.hpp/);
  assert.equal(run(null).status, 1, 'a second folder that does not exist fails without -AllowMissing');
});

test('feed run: the rig seeds a TEST-signed feed only, checks it before the install, and writes it where the loader reads its cache', () => {
  const byName = (n) => steps.find((s) => nameOf(s) === n);
  for (const n of ['Check the feed inputs', 'Download the feed', 'Check the feed']) assert.ok(byName(n), `step "${n}"`);
  const order = ['Check the feed inputs', 'Download the feed', 'Check the feed', 'Resolve the set'].map((n) => steps.findIndex((s) => nameOf(s) === n));
  assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `feed steps run before Resolve: ${order}`);
  const check = byName('Check the feed');
  assert.ok(check.includes('--allow-test-key') && check.includes('key=k1 TEST-KEY'), 'only the TEST key is accepted');
  assert.ok(!/VMAP_SIGN_KEY/.test(wf), 'the rig never holds the signing key');
  assert.ok(setup.includes('version-map-client.v1.cache'), 'seeded at the loader cache path');
  assert.match(verdictPs, /feed_applied/);
  assert.match(verdictPs, /feed_rows_used/);
});

// ---- live_feed: the feed players get, for a released loader or a candidate ----

const liveStepName = 'Download and check the live feed';
const liveStep = () => step(liveStepName);
const liveScript = () => {
  const lines = liveStep().split('\n');
  const body = lines.slice(lines.findIndex((l) => /^ {8}run: \|$/.test(l)) + 1);
  const end = body.findIndex((l) => l !== '' && !l.startsWith(' '.repeat(10)));
  return (end < 0 ? body : body.slice(0, end)).map((l) => l.slice(10)).join('\n');
};

test('live_feed: a boolean dispatch input, false by default, and not a call input', () => {
  const on = header.slice(header.indexOf('\non:\n'), header.indexOf('\npermissions:'));
  const dispatch = on.slice(on.indexOf('  workflow_dispatch:'), on.indexOf('  workflow_call:'));
  const call = on.slice(on.indexOf('  workflow_call:'), on.indexOf('    outputs:'));
  assert.match(dispatch, /\n {6}live_feed:\n(?: {8}.*\n)*? {8}type: boolean\n {8}default: false\n/);
  assert.ok(!/live_feed/.test(call), 'a caller passes a feed artifact, not live_feed');
  assert.match(wf, /\n {6}LIVE_FEED: \$\{\{ inputs\.live_feed \}\}\n/);
});

test('live_feed: the feed comes from the vmap-feed release and must verify with the release key k2 alone, failing closed', () => {
  const s = liveStep();
  const script = liveScript();
  assert.match(s, /\n {8}if: inputs\.live_feed == true\n/, 'runs only for live_feed');
  assert.match(s, /\n {8}id: live\n/);
  assert.match(script, /gh release download vmap-feed --repo "\$REPO" --pattern version-map-client\.v1\.txt --dir live-feed/);
  // The existing verifier, without its test-key flag, and an exact k2 answer.
  assert.match(script, /node ci\/vmap-sign\.mjs verify live-feed\/version-map-client\.v1\.txt 2>&1/);
  assert.ok(!script.includes('--allow-test-key') && !/TEST/.test(script.replace(/the test key/g, '')), 'the live step never accepts the test key');
  assert.match(script, /\^ok\\ seq=\(\[1-9\]\[0-9\]\{0,14\}\)\\ key=k2\$/);
  assert.match(script, /set -euo pipefail/);
  for (const m of ['could not be downloaded', 'has no version-map-client.v1.txt', 'does not verify', 'is not signed with the release key k2']) assert.ok(script.includes(m), `stops on: ${m}`);
  assert.match(script, /reason\(\) \{[^\n]*rig-reason\.txt[^\n]*exit 1; \}/);
  // The seq and the sha256 come from the verified file and go to the outputs, the log and the job summary.
  assert.match(script, /sha="\$\(sha256sum live-feed\/version-map-client\.v1\.txt/);
  assert.match(script, /echo "seq=\$seq" >> "\$GITHUB_OUTPUT"/);
  assert.match(script, /echo "sha256=\$sha" >> "\$GITHUB_OUTPUT"/);
  assert.match(script, /Live feed verified with the release key k2: seq \$seq, sha256 \$sha/);
  assert.ok(!/GITHUB_STEP_SUMMARY/.test(s), 'the job summary is written by the last step only; the verdict summary carries the seq and sha256');
  // It reads a public release with the job token; no secret, no signing key, no write.
  assert.ok(!/secrets\./.test(s) && !/VMAP_SIGN_KEY/.test(s), 'no secret and no signing key');
  assert.ok(!/gh release (upload|create|edit|delete)|vmap-sign\.mjs sign/.test(script), 'nothing is published or signed');
  assert.match(s, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  // The test key is accepted in exactly one place: the feed artifact check of a call.
  assert.equal(wf.match(/--allow-test-key/g).length, 1);
  assert.ok(step('Check the feed').includes('--allow-test-key'));
});

test('live_feed: the feed is checked before the resolve and seeded through the same script path, with no candidate needed', () => {
  const at = (n) => steps.findIndex((s) => nameOf(s) === n);
  assert.ok(at(liveStepName) > at('Check the feed') && at(liveStepName) < at('Resolve the set'), 'checked before Resolve and any download');
  for (const n of ['Resolve the set', 'Install the loader and plugins']) {
    const s = step(n);
    assert.match(s, /LIVE_FEED_SEQ: \$\{\{ steps\.live\.outputs\.seq \}\}/, `${n}: the seq of the verified file`);
    assert.match(s, /elseif \(\$env:LIVE_FEED_SEQ\) \{ \$feed = @\{ FeedFile = 'live-feed\/version-map-client\.v1\.txt'; FeedSeq = \$env:LIVE_FEED_SEQ; FeedLive = \$true \} \}/, `${n}: seeds the live feed`);
    assert.match(s, /\$cand = if \(Test-Path candidate\) \{ 'candidate' \} else \{ '' \}/, `${n}: a candidate stays optional`);
  }
  // The test-signed feed path is as before.
  assert.equal(wf.match(/if \(\$env:FEED_ARTIFACT\) \{ \$feed = @\{ FeedFile = 'feed\/feed\.test-signed\.txt'; FeedSeq = \$env:FEED_SEQ; FeedCl = \$env:FEED_CL \} \}/g).length, 2);
  assert.ok(!/candidate/.test(liveScript()), 'the live step does not look at a candidate');
  // The script records the seq and the sha256 of the cache file written, and the verdict reports them.
  assert.match(setup, /Seeded the feed cache with the live feed: seq \$\(\$plan\.feed\.seq\), sha256 \$seeded/);
  assert.match(setup, /live = \$true/);
  assert.match(verdictPs, /Live feed seeded: seq /);
  assert.match(verdictPs, /key k2\\\)/);
});

test('live_feed: false (and a call) leave the rig as it was: no live step runs, and the feed inputs behave as before', () => {
  assert.match(liveStep(), /if: inputs\.live_feed == true/);
  // The steps that take a feed do nothing extra without the live seq: the branch is an elseif behind the artifact one.
  assert.equal(wf.match(/elseif \(\$env:LIVE_FEED_SEQ\)/g).length, 2);
  // A call that passes a feed artifact still needs its candidate and the TEST key.
  assert.match(step('Check the feed inputs'), /a seeded feed needs the candidate loader that trusts it/);
  assert.match(step('Check the feed'), /key=k1 TEST-KEY/);
  // And the live step refuses to run beside a feed artifact.
  assert.match(liveScript(), /live_feed does not go with feed_artifact, feed_seq or feed_cl/);
});

// The live step run for real in bash with a stand-in gh, against the repository's own verifier: every way
// it can go wrong stops the rig with a reason and writes no seq.
const liveBash = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find(existsSync) : 'bash';
function runLiveStep({ gh, env = {} }) {
  if (!liveBash) return null;
  const dir = mkdtempSync(join(tmpdir(), 'rig-live-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/bash\n${gh}\n`, { mode: 0o755 });
    const script = liveScript().replace('node ci/vmap-sign.mjs', `node '${join(here, 'vmap-sign.mjs').replace(/\\/g, '/')}'`);
    writeFileSync(join(dir, 'step.sh'), script);
    const out = join(dir, 'github-output.txt');
    writeFileSync(out, '');
    const r = spawnSync(liveBash, ['step.sh'], {
      cwd: dir, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, PATH: join(dir, 'bin') + delimiter + process.env.PATH, RUNNER_TEMP: dir, GITHUB_OUTPUT: out, REPO: 'o/r', GH_TOKEN: 'x', FEED_ARTIFACT: '', FEED_SEQ: '', FEED_CL: '', ...env },
    });
    if (r.error) return null;
    let reason = '';
    try { reason = readFileSync(join(dir, 'rig-reason.txt'), 'utf8').trim(); } catch { /* none */ }
    return { r, reason, outputs: readFileSync(out, 'utf8'), text: `${r.stdout}\n${r.stderr}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('live_feed: the step stops, with a reason and no seq, when the download fails, the file is missing, or the feed does not verify', (t) => {
  const down = runLiveStep({ gh: 'echo "gh: boom" >&2; exit 1' });
  if (!down) return t.skip('no bash on this machine');
  assert.equal(down.r.status, 1, down.text);
  assert.match(down.reason, /could not be downloaded/);
  const empty = runLiveStep({ gh: 'exit 0' });
  assert.equal(empty.r.status, 1, empty.text);
  assert.match(empty.reason, /has no version-map-client\.v1\.txt/);
  // A file that is not a signed feed, and a feed whose last line is a signature that is not the release key's.
  const junk = runLiveStep({ gh: 'printf "format\\t1\\nseq\\t5\\nsig\\tk2\\t%s==\\n" "$(printf A%.0s {1..86})" > live-feed/version-map-client.v1.txt' });
  assert.equal(junk.r.status, 1, junk.text);
  assert.match(junk.reason, /does not verify: vmap-sign: refused/);
  assert.equal(junk.outputs, '', 'no seq on a refusal');
  const both = runLiveStep({ gh: 'exit 0', env: { FEED_ARTIFACT: 'a', FEED_SEQ: '1', FEED_CL: '2' } });
  assert.equal(both.r.status, 1, both.text);
  assert.match(both.reason, /live_feed does not go with/);
});

test('live_feed: the verifier accepts a k2 feed and refuses a test-key feed without the flag (the check the step relies on)', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { signFeed, verifyFeed, PUBLIC_KEYS } = await import('./vmap-sign.mjs');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const unsigned = 'format\t1\nbuild\t130045\t++Earth20+Kobalt-CL-130045\tx\n';
  const now = 1795109742;
  const k2 = signFeed(unsigned, pem, { keyId: 'k2', now });
  // The feed's own pair stands in for k2; the step's check is that the key is not a TEST key.
  const ok = verifyFeed(k2.text, { keys: { k2: { hex: raw, test: false } }, now });
  assert.deepEqual([ok.keyId, ok.test], ['k2', false]);
  const k1 = signFeed(unsigned, pem, { keyId: 'k1', now });
  const test = verifyFeed(k1.text, { keys: { k1: { hex: raw, test: true } }, now });
  assert.equal(test.test, true, 'a k1 feed is a TEST-key feed: the CLI refuses it without --allow-test-key');
  assert.equal(PUBLIC_KEYS.k1.test, true);
  assert.equal(PUBLIC_KEYS.k2.test, false);
});

test('rig set: Resolve takes a live feed with no candidate and no CL, records its seq and sha256 from the file, and refuses a seq or a CL it does not fit', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rig-livefeed-'));
  try {
    const feed = join(dir, 'version-map-client.v1.txt');
    const text = 'format\t1\nseq\t1795109742\nbuild\t130045\tx\ty\nsig\tk2\tAAAA\n';
    writeFileSync(feed, text);
    const sha = createHash('sha256').update(text).digest('hex');
    const ok = resolveWithMock(`-Branch public -FeedFile '${feed}' -FeedSeq 1795109742 -FeedLive`);
    if (!ok) return t.skip('no PowerShell on this machine');
    assert.equal(ok.r.status, 0, ok.text);
    assert.deepEqual(ok.plan.feed, { seq: 1795109742, sha256: sha, live: true });
    assert.equal(ok.plan.loader.overlaid, false, 'the released loader, no candidate');
    const wrongSeq = resolveWithMock(`-Branch public -FeedFile '${feed}' -FeedSeq 1795109743 -FeedLive`);
    assert.notEqual(wrongSeq.r.status, 0);
    assert.match(wrongSeq.text, /the live feed file carries 'seq\t1795109742', not seq 1795109743/);
    const withCl = resolveWithMock(`-Branch public -FeedFile '${feed}' -FeedSeq 1795109742 -FeedCl 130045 -FeedLive`);
    assert.notEqual(withCl.r.status, 0);
    assert.match(withCl.text, /a live feed takes no CL/);
    // Without -FeedLive nothing changed: a seeded feed still needs its candidate and its CL.
    const noCand = resolveWithMock(`-Branch public -FeedFile '${feed}' -FeedSeq 1795109742 -FeedCl 130045`);
    assert.notEqual(noCand.r.status, 0);
    assert.match(noCand.text, /a seeded feed needs the candidate loader that trusts it/);
    const noCl = resolveWithMock(`-Branch public -FeedFile '${feed}' -FeedSeq 1795109742`);
    assert.notEqual(noCl.r.status, 0);
    assert.match(noCl.text, /the feed file, its seq and its CL go together/);
    const plain = resolveWithMock('-Branch public');
    assert.equal(plain.plan.feed, null, 'no feed, no change');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
