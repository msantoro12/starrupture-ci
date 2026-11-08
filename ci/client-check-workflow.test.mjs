// Tests for the client check workflow's run inputs (.github/workflows/sr-client-check.yml).
//
//   node --test ci/client-check-workflow.test.mjs
//
// Reads the workflow as text: the Game SDK repository input, the plugin
// exclusion list and the dispatch-only test-autopilot switch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addBuild, emit, emptyMap } from './version-map.mjs';
import { firstLogError } from './pipeline-alert.mjs';
import { parsePublicBuilds } from './public-builds.mjs';

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

test('plugin_exclude: a name leaves that plugin out, and a name that is not in plugins is an error', () => {
  for (const s of [call, dispatch]) assert.match(s, /plugin_exclude:\n(?:.*\n)*?\s+default: ''/);
  const plan = job('plugin-plan');
  assert.match(plan, /\$list = \[Collections\.Generic\.List\[object\]\]@\(\$list \| Where-Object \{ \$_\.name -notin \$exclude \}\)/);
  assert.match(plan, /throw "plugin_exclude names '\$x', which is not in plugins"/);
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
  for (const name of ['Check out the plugin', 'Check out the Plugin SDK', 'Check out the Game SDK',
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
  assert.match(mm, /import \{ isPublishable \} from "\.\/tool\/ci\/promote\.mjs";/);
  assert.match(mm, /const ok = isPublishable\(p, \{ testRun: process\.env\.IS_TEST === "false" \? false : true, branch: process\.env\.BRANCH \}\);/);
  assert.match(mm, /--uses res\/layout-uses\.txt/);
  assert.match(job('publish'), /if: \$\{\{ !cancelled\(\) && inputs\.test_autopilot != true && \(inputs\.publish == true \|\| !contains\(github\.workflow_ref, '\/\.github\/workflows\/sr-client-check\.yml@'\)\) && needs\.map-mode\.outputs\.test == 'false' && /);
  const ap = JSON.parse(readFileSync(join(here, '..', 'state', 'autopilot.json'), 'utf8'));
  assert.ok(ap.enabled === false || (ap.enabled === true && ap.paths.every((p) => p === 'M')), 'autopilot is off or limited to the map-feed path M');
});

test('publish lock: a test run never reaches the release key, whatever state/autopilot.json says', () => {
  const mm = job('map-mode');
  // The chain states explicitly whether it is a test: the dispatch input, its own flag or the decision.
  assert.match(mm, /\n {6}test: \$\{\{ steps\.chain\.outputs\.test \}\}\n/);
  assert.match(mm, /TEST_INPUT: \$\{\{ inputs\.test_autopilot == true \}\}/);
  // A held candidate (decision not M) counts as a test as far as publishing goes.
  assert.ok(mm.includes(`is_test="$(node -p "const d = JSON.parse(require('fs').readFileSync('decision.json','utf8')); String(process.env.TEST_INPUT === 'true' || process.env.TEST_AUTOPILOT === 'true' || d.test === true || (d.candidate === true && d.decision !== 'M'))")"\n          echo "test=$is_test" >> "$GITHUB_OUTPUT"`));
  const pub = job('publish');
  assert.match(pub, /needs\.map-mode\.outputs\.test == 'false'/, 'the job needs an explicit non-test run');
  // A second lock in the job: the input and the chain's own marks, before anything is signed.
  const lock = pub.slice(pub.indexOf('- name: Refuse a test run'), pub.indexOf('- name: Sign with the release key'));
  assert.ok(lock.length > 40, 'the lock step comes before the signing step');
  assert.ok(lock.includes('[ "$TEST_INPUT" = false ] || { echo "::error::a test run never publishes"; exit 2; }'));
  // The unattended chain's own M carries wouldBe M; a test run, a held decision or a test plan is refused.
  assert.ok(lock.includes('d.test !== undefined || (d.wouldBe !== undefined && !ownM) || p.test !== undefined'));
  assert.ok(lock.includes('const ownM = d.decision === "M" && d.wouldBe === "M";'));
  assert.ok(!/VMAP_SIGN_KEY/.test(lock), 'the lock step does not read the key');
  assert.ok(pub.indexOf('- name: Refuse a test run') < pub.indexOf('vmap-sign.mjs sign'), 'locked before signing');
});

test('field-rows: a missing reference layout is never named, and only a refusal (exit 3) is survivable', () => {
  const mm = job('map-mode');
  assert.ok(mm.includes('if [ -f res/layout-reference.json ]; then base=(--base res/layout-reference.json); else echo '));
  assert.ok(mm.includes('--next res/layout-target.json "${base[@]}"'));
  assert.ok(!/--base res\/layout-reference\.json \\\n/.test(mm), '--base is never passed unconditionally');
  assert.ok(mm.includes('if [ "$fr" -ne 0 ] && [ "$fr" -ne 3 ]; then echo "::error::field-rows failed (exit $fr)'));
  assert.ok(mm.includes('exit "$fr"; fi'));
  assert.ok(mm.indexOf('field-rows failed') < mm.indexOf('decide.mjs --repo'), 'the job fails before decide runs without a report');
});

test('alert: a failed job or a HOLD other than "nothing new" opens or updates one issue per branch', () => {
  const a = job('alert');
  assert.match(a, /needs: \[build, plugin-plan, check, record-public, map-mode, publish, push-loader, candidate-loader, rig-branch, rig-other, rig-gate\]/);
  assert.match(a, /if: \$\{\{ always\(\) && inputs\.branch && inputs\.branch != 'expiry-only' \}\}/);
  assert.match(a, /permissions:\n\s+contents: read\n\s+issues: write/);
  assert.ok(a.includes('/^G3: CL-[0-9]+ is not newer than CL-[0-9]+$/'), 'nothing new is the G3 reason');
  assert.ok(a.includes('result === "failure"'));
  assert.ok(a.includes('node ci/pipeline-alert.mjs raise --title "SR map mode: $BRANCH needs attention" --body-file alert.md --owner "$OWNER"'));
  assert.ok(a.includes('node ci/pipeline-alert.mjs causes --repo "$GH_REPO" --run "$RUN_ID" --out failed-jobs.jsonl'));
  // The failure annotations hold the first error line as soon as the step emits it.
  assert.match(a, /\n\s+checks: read\s/);
  assert.ok(a.indexOf('Check out the alert script') < a.indexOf('Read why the jobs failed'));
  // The caller's ceiling must grant issues: write, or GitHub rejects the call.
  const watch = readFileSync(join(here, '..', '.github', 'workflows', 'sr-watch.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(watch.slice(watch.indexOf('  client-check:\n')), /permissions:\n\s+contents: write\n\s+pull-requests: write\n\s+issues: write.*\n\s+actions: read.*\n\s+checks: read/);
});

test('build label: the map-mode step labels a build "steam_build <build id>" and never names the branch', () => {
  const step = wf.slice(wf.indexOf('      - name: Write the update into the header'));
  const line = step.split('\n').find((l) => l.includes('scans.json", JSON.stringify('));
  assert.ok(line, 'the step writes scans.json');
  assert.match(line, /source: "steam_build " \+ process\.argv\[1\]/);
  assert.ok(!/BRANCH|branch/.test(line), 'the label is built from the build id only');
  assert.ok(!/source: [^,]*test_branch/.test(wf), 'no workflow step labels a build with the test branch');
});

// ---- New builds: map mode measures what the loader does not run on yet ----

// The gate lines of the check step, run for real: the version gate's verdicts in, the
// check's fail flag and new-build flag out. Skipped where no PowerShell is installed.
const powershell = ['pwsh', 'powershell'].find((exe) => spawnSync(exe, ['-NoProfile', '-Command', '1'], { windowsHide: true }).status === 0);
const gateSnippet = () => {
  const text = job('check');
  const from = text.indexOf('          $newBuild = ');
  const to = text.indexOf('\n', text.indexOf('          $fail = ', from));
  assert.ok(from > 0 && to > from, 'the check step decides newBuild and fail');
  return text.slice(from, to);
};
const runGate = ({ mapMode, gates, pv, scanCode = 0 }) => {
  const script = [
    "$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest",
    `$env:MAP_MODE = '${mapMode}'`,
    `$gates = [Collections.Generic.List[bool]]::new(); foreach ($g in @(${gates.map((g) => (g ? '$true' : '$false')).join(',')})) { $gates.Add($g) }`,
    '$clOk = $gates.Count -gt 0 -and -not ($gates -contains $false)',
    `$pv = '${pv}'; $scanCode = ${scanCode}`,
    gateSnippet(),
    'Write-Output "newBuild=$newBuild fail=$fail"',
  ].join('\n');
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const NEW = '++Earth20+Kobalt-PTR2-CL-129402';

test('new build: with map mode on, a version gate that says no is a new build and the check passes', { skip: !powershell }, () => {
  assert.equal(runGate({ mapMode: 'true', gates: [false], pv: NEW }), 'newBuild=True fail=False');
  assert.equal(runGate({ mapMode: 'true', gates: [true, false], pv: NEW }), 'newBuild=True fail=False');
});

test('new build: with map mode off the same build still fails the check', { skip: !powershell }, () => {
  assert.equal(runGate({ mapMode: 'false', gates: [false], pv: NEW }), 'newBuild=False fail=True');
  assert.equal(runGate({ mapMode: '', gates: [false], pv: NEW }), 'newBuild=False fail=True');
});

test('new build: a supported build is not a new build, and no other gate is excused by one', { skip: !powershell }, () => {
  assert.equal(runGate({ mapMode: 'true', gates: [true], pv: NEW }), 'newBuild=False fail=False');
  assert.equal(runGate({ mapMode: 'true', gates: [false], pv: NEW, scanCode: 1 }), 'newBuild=True fail=True', 'a failing pattern scan still fails');
  assert.equal(runGate({ mapMode: 'true', gates: [], pv: NEW }), 'newBuild=False fail=True', 'no version gate found still fails');
  assert.equal(runGate({ mapMode: 'true', gates: [false], pv: '1.0.0.0' }), 'newBuild=False fail=True', 'a ProductVersion without a CL still fails');
});

test('new build: the check step reads map_mode, records the flag and keeps the other gates failing', () => {
  const check = job('check');
  const scan = check.slice(check.indexOf('      - name: Check the client build'), check.indexOf('      # Plugin code never runs'));
  assert.match(scan, /\n {10}MAP_MODE: \$\{\{ inputs\.map_mode \}\}\n/);
  assert.ok(scan.includes('$fail = ((-not $clOk) -and (-not $newBuild)) -or ($scanCode -ne 0)'), 'the scan exit code is not excused');
  assert.ok(scan.includes('clOk = $clOk; newBuild = $newBuild;'), 'checks.json records the new build next to clOk');
  assert.ok(scan.includes('if ($scanCode -ne 0) { Write-Host "::error::sr-aobscan exit code'));
  assert.ok(scan.includes('if ($fail) { exit 1 }'));
  // The exe gate sits before the version gate and is untouched by it.
  assert.ok(scan.includes("throw 'no *-Win64-Shipping.exe in the install'"));
  assert.match(check, /elseif \(\$ck\.fail\) \{ 'fail' \}\n\s+elseif \(\$ck\.exe\.newBuild\) \{ 'new-build' \}/, 'a failing check is never reported as a new build');
});

test('new build: map mode runs after a passing check only, so a real gate failure still blocks it', () => {
  assert.match(job('map-mode'), /if: \$\{\{ !cancelled\(\) && inputs\.map_mode == true && needs\.check\.result == 'success' && \(needs\.record-public\.result == 'success' \|\| needs\.record-public\.result == 'skipped'\) \}\}/);
  assert.match(job('map-mode'), /put\("g2\.json", \{ ok: r\.checks\?\.fail === false \}\);/, 'G2 still reads the fail flag of the check');
});

test('new build: the PR comment and the alert name it "new build, measured by map mode", not a failure', () => {
  const report = job('report');
  assert.ok(report.includes("if ($status -eq 'new-build') {"));
  assert.ok(report.includes('**New build, measured by map mode.**'));
  assert.ok(report.includes("elseif ($ck.exe.newBuild) { '**new build** (not supported yet; map mode measures it)' }"));
  assert.ok(report.includes("else { '**MISMATCH**' }"), 'with map mode off the mismatch is still shown');
  const alert = job('alert');
  assert.ok(alert.includes('r?.status === "new-build"'));
  assert.ok(alert.includes('measured by map mode: the loader does not run on it yet'));
  assert.ok(alert.includes('this is not a failure'));
});

test('map step: plugins that report another name than their repo (Waila, AxRuptureTimer) are tracked', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const script = wf.match(/node -e '\n(\s+const fs = require\("fs"\);\n[\s\S]*?)\n\s+' "\$buildid"/)[1];
  const dir = mkdtempSync(join(tmpdir(), 'map-step-'));
  mkdirSync(join(dir, 'res'));
  mkdirSync(join(dir, 'tool', 'ci'), { recursive: true });
  copyFileSync(join(here, 'plugin-names.json'), join(dir, 'tool', 'ci', 'plugin-names.json'));
  writeFileSync(join(dir, 'res', 'scanner.json'), '{}');
  for (const n of ['Waila', 'AxRuptureTimer', 'BetterCheats', 'MiniMap']) writeFileSync(join(dir, 'res', `plugin-${n}.json`), JSON.stringify({ plugin: { name: n } }));
  const plugins = ['WAILA', 'RuptureTimer', 'BetterCheats'].map((n) => `AlienXAXS/StarRupture-Plugin-${n}@main`).join(' ')
    + ' LetMeInside/StarRupture-Plugin-MiniMap@latest-release';
  const r = spawnSync(process.execPath, ['-e', script, '1'], { cwd: dir, env: { ...process.env, PLUGINS: plugins, LOADER_REF: 'v1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const scans = JSON.parse(readFileSync(join(dir, 'scans.json'), 'utf8')).scans;
  const tracked = Object.fromEntries(scans.map((s) => [s.owner, s.tracked]));
  assert.deepEqual(tracked, { ModLoader: true, AxRuptureTimer: true, BetterCheats: true, MiniMap: true, Waila: true });
});

// ------------------------------------------------------------ candidate chain and the loader push

const watch = readFileSync(join(here, '..', '.github', 'workflows', 'sr-watch.yml'), 'utf8').replace(/\r\n/g, '\n');
// The run block of a named step, as the shell receives it.
const runOf = (j, name) => {
  const at = j.indexOf(`- name: ${name}\n`);
  assert.ok(at >= 0, `step "${name}" exists`);
  const next = j.indexOf('\n      - ', at + 1);
  const stepText = j.slice(at, next < 0 ? undefined : next);
  const m = stepText.match(/\n {8}run: \|\n((?: {10}.*\n?|\n)+)/);
  assert.ok(m, `step "${name}" has a run block`);
  return m[1].replace(/^ {10}/gm, '');
};
// Git's bash on Windows (never the WSL launcher in System32), plain bash elsewhere.
const bash = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find(existsSync) : 'bash';

test('candidate: a disabled autopilot holds publishing only; the chain still exports, signs, stages and plans', () => {
  const mm = job('map-mode');
  assert.match(mm, /\n {6}CANDIDATE: \$\{\{ inputs\.map_mode == true && inputs\.publish != true && inputs\.test_autopilot != true \}\}\n/);
  assert.ok(mm.includes('[ "$CANDIDATE" = true ] && test_flag=(--candidate)'));
  // The chain runs on past a HOLD that only the autopilot caused, and stops on any other.
  assert.ok(mm.includes('elif [ "$CANDIDATE" = true ] && [ "$decision" = HOLD ] && [ "$would" = M ]; then'));
  assert.ok(mm.includes('elif [ "$decision" != M ]; then echo "decide: $decision (exit $d); nothing exported or signed"; exit 0; fi'));
  assert.ok(mm.indexOf('elif [ "$CANDIDATE" = true ]') < mm.indexOf('version-map.mjs export-feed'), 'the candidate check comes before the export');
  // The held plan is a test plan: marked, and never publishable.
  assert.ok(mm.includes('promote_flag=(--test-autopilot)'));
  assert.ok(mm.includes('--out promote-plan.json "${promote_flag[@]}"'));
  // Publish stays out of reach while the decision is HOLD, and a candidate never runs with publish on.
  const pub = job('publish');
  assert.match(pub, /needs\.map-mode\.outputs\.decision == 'M'/);
  assert.match(pub, /needs\.map-mode\.outputs\.test == 'false'/);
  assert.match(pub, /inputs\.publish == true/);
  assert.ok(!/CANDIDATE|candidate/.test(pub.replace(/^ *#.*$/gm, '')), 'the publish job knows nothing of the candidate path');
  assert.ok(!/\n {6}publish:/.test(watch.slice(watch.indexOf('  client-check:\n'))), 'sr-watch never passes publish');
});

test('push-loader: the key, the environment and the target are named, and the allowlist runs before the key is used', () => {
  const j = job('push-loader');
  assert.match(j, /\n {4}environment: fork-push\n/);
  assert.match(j, /\n {4}permissions:\n {6}contents: read\n/);
  assert.match(j, /\n {4}needs: \[map-mode\]\n/);
  assert.match(j, /\n {4}if: \$\{\{ !cancelled\(\) && needs\.map-mode\.result == 'success' && needs\.map-mode\.outputs\.staged == 'true' && inputs\.test_autopilot != true \}\}\n/);
  assert.ok(!/inputs\.loader_repo ==/.test(j), 'the base repository does not decide whether the push runs: the target is always the fork');
  assert.match(j, /\n {4}outputs:\n {6}branch: \$\{\{ steps\.push\.outputs\.branch \}\}\n {6}sha: \$\{\{ steps\.push\.outputs\.sha \}\}\n/);
  assert.ok(!/continue-on-error/.test(j), 'no step of the push job may fail quietly');
  // The key is read by name, in two steps only, and no other secret is touched.
  assert.equal(j.match(/secrets\.[A-Z_]+/g).join(' '), 'secrets.SR_DEPLOYKEY_MODLOADER secrets.SR_DEPLOYKEY_MODLOADER');
  // The key check comes first, before anything is fetched.
  assert.ok(j.indexOf('- name: Check the deploy key') < j.indexOf('- name: Check out the push tool'));
  // Pushes go through staging.mjs push: no git push, tag or force in the workflow.
  assert.ok(!/git (-C \S+ )?push|--force|--tags|refs\/tags/.test(j));
  assert.ok(j.includes('node tool/ci/staging.mjs target --repo "$PUSH_REPO" --plan chain/stage-plan.json'));
  assert.match(j, /\n {6}PUSH_REPO: msantoro12\/StarRupture-ModLoader\n/, 'the one repository the job writes to is the fork');
  assert.ok(j.includes('staging.mjs push --repo "$PUSH_REPO"'));
  assert.ok(j.indexOf('staging.mjs target') < j.indexOf('- name: Commit the header and push the branch'), 'the allowlist runs before the key is written');
  // The base is the repository the rows were read from (AlienX's released line), never the fork, at that exact commit.
  assert.match(j, /repository: \$\{\{ inputs\.loader_repo \}\}\n\s+ref: \$\{\{ steps\.base\.outputs\.sha \}\}\n\s+path: loader\n(?:\s+#.*\n)*\s+fetch-depth: 0\n/, 'the checkout is loader_repo at the commit the rows were read from, not a moving ref, with its whole history');
  assert.ok(!/repository: msantoro12\/StarRupture-ModLoader/.test(j), 'the fork is never checked out as the base');
  // The map-mode job tells the push job when there is something to push.
  assert.match(job('map-mode'), /\n {6}staged: \$\{\{ steps\.chain\.outputs\.staged \}\}\n/);
  assert.ok(job('map-mode').includes('echo "staged=true" >> "$GITHUB_OUTPUT"'));
  // The secret is declared by the called workflow (not required: the job explains its absence) and passed by name by sr-watch.
  assert.match(call, /\n {6}SR_DEPLOYKEY_MODLOADER:\n {8}description: [^\n]+\n {8}required: false\n/);
  assert.ok(watch.includes('      SR_DEPLOYKEY_MODLOADER: ${{ secrets.SR_DEPLOYKEY_MODLOADER }}\n'));
});

test('push-loader: with the secret empty the first step exits 1 and names the secret and the environment', { skip: !bash }, () => {
  const script = runOf(job('push-loader'), 'Check the deploy key');
  for (const key of [undefined, '']) {
    const env = { ...process.env, GITHUB_REPOSITORY: 'msantoro12/starrupture-ci' };
    if (key === undefined) delete env.DEPLOY_KEY; else env.DEPLOY_KEY = key;
    const r = spawnSync(bash, ['-c', script], { encoding: 'utf8', env, windowsHide: true });
    assert.equal(r.status, 1, `exit code for ${JSON.stringify(key)}: ${r.stderr}`);
    assert.match(r.stdout, /::error title=Loader deploy key missing::/);
    assert.match(r.stdout, /SR_DEPLOYKEY_MODLOADER/);
    assert.match(r.stdout, /environment fork-push of msantoro12\/starrupture-ci/);
  }
  const ok = spawnSync(bash, ['-c', script], { encoding: 'utf8', env: { ...process.env, DEPLOY_KEY: 'x' }, windowsHide: true });
  assert.equal(ok.status, 0, 'a set key passes the check');
});

// ------------------------------------------------------------ leg B1: candidate loader, loader and scanner tests

const stepsOf = (j) => [...j.matchAll(/\n {6}- name: ([^\n]+)\n/g)].map((m) => m[1]);
const stepText = (j, name) => {
  const at = j.indexOf(`- name: ${name}\n`);
  assert.ok(at >= 0, `step "${name}" exists`);
  const next = j.indexOf('\n      - ', at + 1);
  return j.slice(at, next < 0 ? undefined : next);
};

test('candidate-loader: builds the commit push-loader pushed, with a keyless job, and fails the chain when it cannot', () => {
  const j = job('candidate-loader');
  assert.match(j, /\n {4}needs: \[push-loader\]\n/);
  assert.match(j, /\n {4}if: \$\{\{ !cancelled\(\) && needs\.push-loader\.result == 'success' \}\}\n/);
  assert.match(j, /\n {4}runs-on: windows-latest\n/);
  assert.match(j, /\n {4}permissions:\n {6}contents: read\n/);
  assert.ok(!/\n {4}environment:/.test(j), 'no environment');
  assert.ok(!/secrets\./.test(j.replace(/^ *#.*$/gm, '')), 'no secret is read');
  assert.ok(!/continue-on-error/.test(j), 'no step may fail quietly');
  // The commit is the output of push-loader, in a checkout of the fork only, and the checkout is verified.
  assert.match(j, /LOADER_SHA: \$\{\{ needs\.push-loader\.outputs\.sha \}\}/);
  assert.match(j, /repository: msantoro12\/StarRupture-ModLoader\n\s+ref: \$\{\{ needs\.push-loader\.outputs\.sha \}\}\n(?:.*\n)*?\s+submodules: recursive\n/);
  assert.match(runOf(j, 'Check it is that commit'), /git rev-parse HEAD[\s\S]*-ne \$env:LOADER_SHA\) \{ throw/);
  assert.match(runOf(j, 'Name the build'), /-notmatch '\^\[0-9a-f\]\{40\}\$'\) \{ throw/);
  // The same shared build action as sr-build-all, Client Release, checked out after the loader.
  const order = stepsOf(j);
  assert.ok(order.indexOf('Check out the loader at the pushed commit') < order.indexOf('Check out the build action'));
  const build = stepText(j, 'Build Client Release');
  assert.match(build, /uses: \.\/ci-actions\/\.github\/actions\/build-loader\n\s+with:\n\s+configuration: Client Release\n\s+build_tag: \$\{\{ steps\.tag\.outputs\.tag \}\}\n/);
  assert.ok(!/msbuild .*StarRupture-ModLoader\.sln/.test(j), 'the solution build lives in the action only');
});

test('candidate-loader: runs VersionMapTests and LayoutCheckTests on that commit before anything is uploaded', () => {
  const j = job('candidate-loader');
  const order = stepsOf(j);
  const at = (n) => order.indexOf(n);
  assert.ok(at('Build Client Release') < at('VersionMapTests') && at('VersionMapTests') < at('LayoutCheckTests') && at('LayoutCheckTests') < at('Check the build') && at('Check the build') < at('Upload the candidate'));
  for (const [name, proj, exe] of [['VersionMapTests', 'VersionMapTests', 'version_map_tests'], ['LayoutCheckTests', 'LayoutCheckTests', 'layout_check_tests']]) {
    const run = runOf(j, name);
    assert.ok(run.includes(`msbuild "Tests\\${proj}\\${proj}.vcxproj" /p:Configuration="Client Release" /p:Platform=x64`), `${name}: built from its project file`);
    assert.ok(run.includes(`& "build\\tests\\${exe}.exe"`), `${name}: the test exe is run`);
    assert.equal(run.match(/if \(\$LASTEXITCODE -ne 0\) \{ throw /g)?.length, 2, `${name}: the build and the run both throw on a nonzero exit`);
  }
  // Both tests report even when the first fails; the checks and the upload only run when everything passed.
  assert.match(stepText(j, 'LayoutCheckTests'), /\n {8}if: \$\{\{ !cancelled\(\) \}\}\n/);
  for (const n of ['VersionMapTests', 'Check the build', 'Upload the candidate', 'Name the candidate']) assert.ok(!/\n {8}if:/.test(stepText(j, n)), `${n}: runs only when every step before it passed`);
});

test('candidate-loader: the artifact is a rig candidate (flat dwmapi.dll and ModLoader/*.dll, no plugins, a name the rig accepts)', () => {
  const j = job('candidate-loader');
  const up = stepText(j, 'Upload the candidate');
  assert.match(up, /name: \$\{\{ env\.ARTIFACT \}\}\n/);
  assert.match(up, /path: \|\n {12}build\/Client Release\/dwmapi\.dll\n {12}build\/Client Release\/ModLoader\/\*\.dll\n {10}if-no-files-found: error\n/);
  assert.ok(!/Plugins/.test(up.replace(/^ *#.*$/gm, '')), 'no plugin DLL is uploaded');
  // The same two paths sr-build-all uploads as loader-client, which the rig already takes.
  const buildAll = readFileSync(join(here, '..', '.github', 'workflows', 'sr-build-all.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(buildAll.includes('build/${{ matrix.config }}/dwmapi.dll\n            build/${{ matrix.config }}/ModLoader/*.dll'));
  // One live artifact per name in the run: the name carries the branch, so two calls of one run never collide, and it is a plain name for the rig.
  assert.match(j, /ARTIFACT: loader-candidate-\$\{\{ inputs\.branch \}\}\n/);
  for (const branch of ['public', 'public_test_branch']) assert.match(`loader-candidate-${branch}`, /^[A-Za-z0-9._-]{1,100}$/);
  assert.ok(!/loader-client\b/.test(j.replace(/^ *#.*$/gm, '')), 'it does not reuse the name sr-build-all uploads in the same run');
  // The rig takes only a candidate whose layout it knows; the same script that checks it.
  const rig = readFileSync(join(here, 'client-rig-set.ps1'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(rig, /\$LoaderFiles = @\('StarRupture-ModLoader-Core\.dll'/);
  assert.ok(rig.includes("if ($rel -ieq 'dwmapi.dll') { $kind = 'loader' }"));
  assert.ok(rig.includes("elseif ($rel -imatch '^ModLoader/') {\n            if ($rel -imatch '\\.(dll|exe)$') { $kind = 'loader' }"));
});

test('candidate-loader: the version it names is the string the loader logs and the verdict script compares', () => {
  const j = job('candidate-loader');
  const name = runOf(j, 'Name the build');
  assert.ok(name.includes('"tag=cand-$($env:GITHUB_RUN_ID)-$($env:LOADER_SHA.Substring(0, 7))"'));
  // A made-up run id and commit through the same shape.
  const tag = `cand-${42380000001}-${'0123456789abcdef'.slice(0, 7)}`;
  // The rig's expect grammar (Name=value) takes it as it is.
  const rig = readFileSync(join(here, 'client-rig-set.ps1'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(rig.includes("'^([A-Za-z0-9_.-]+)=([A-Za-z0-9][A-Za-z0-9._+-]*)$'"), 'the grammar this test applies');
  assert.match(`Loader=${tag}`, /^([A-Za-z0-9_.-]+)=([A-Za-z0-9][A-Za-z0-9._+-]*)$/);
  // The verdict script reads the tag from the loader's [init] line: "[init] Build: <MODLOADER_BUILD_TAG> (client), PID <n>".
  const verdict = readFileSync(join(here, 'verdict.ps1'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(verdict.includes("'\\[init\\] Build: (.+?) \\(client\\), PID'"), 'the regex this test applies');
  const m = `[2026-11-07 12:00:00] [INFO] [init] Build: ${tag} (client), PID 4242`.match(/\[init\] Build: (.+?) \(client\), PID/);
  assert.equal(m[1], tag);
  assert.ok(verdict.includes("($logLoader -ceq $loaderExpect)"), 'compared exactly, case-sensitive');
  // The job outputs the string both ways and checks it is compiled into the DLL before it uploads.
  assert.match(j, /outputs:\n {6}artifact: \$\{\{ steps\.out\.outputs\.artifact \}\}\n {6}version: \$\{\{ steps\.out\.outputs\.version \}\}\n {6}expect: \$\{\{ steps\.out\.outputs\.expect \}\}\n {6}sha: \$\{\{ steps\.out\.outputs\.sha \}\}\n/);
  const out = runOf(j, 'Name the candidate');
  assert.ok(out.includes('"version=$($env:TAG)"') && out.includes('"expect=Loader=$($env:TAG)"'));
  const check = runOf(j, 'Check the build');
  assert.ok(check.includes("Contains($env:TAG, [StringComparison]::Ordinal)") && check.includes('StarRupture-ModLoader-Core.dll'));
});

test('build-scanner: the scanner branch\'s ObservedTests are built and run against the loader checkout, and a failure fails the job', () => {
  const j = job('build');
  const order = stepsOf(j);
  const at = (n) => order.indexOf(n);
  const name = "Build and run the scanner's tests (ObservedTests)";
  assert.ok(at('Read the required CL and the SDK offsets') < at(name), 'after the scanner source is copied into the loader tree');
  assert.ok(at('Build sr-aobscan (Client Release)') < at(name) && at(name) < at('Hash the scanner') && at(name) < at('Upload the scanner'), 'before the scanner is handed on');
  const step = stepText(j, name);
  assert.match(step, /\n {8}working-directory: loader\n/);
  assert.ok(!/continue-on-error|\n {8}if:/.test(step), 'it always runs and cannot fail quietly');
  const run = runOf(j, name);
  assert.ok(run.includes('msbuild "tools\\AobScan\\ObservedTests\\ObservedTests.vcxproj"') && run.includes('/p:Configuration="Client Release"'));
  assert.ok(run.includes('& "build\\tests\\observed_tests.exe"'));
  assert.equal(run.match(/if \(\$LASTEXITCODE -ne 0\) \{ throw /g)?.length, 2, 'the build and the run both throw on a nonzero exit');
  // The checkouts it uses are the inputs the scan uses: the scanner source from scanner_ref, the loader at loader_ref.
  assert.match(j, /repository: \$\{\{ inputs\.scanner_repo \}\}\n\s+ref: \$\{\{ inputs\.scanner_ref \}\}\n\s+path: scanner-src\n\s+sparse-checkout: tools\/AobScan\n/);
  assert.match(j, /ref: \$\{\{ inputs\.loader_ref \}\}\n\s+path: loader\n/);
});

test('public: a build first seen on public is staged too, so it is pushed and gets a candidate', () => {
  const mm = job('map-mode');
  assert.ok(!/if \[ "\$BRANCH" != public \]; then\n\s+node tool\/ci\/staging\.mjs stage/.test(mm), 'the stage step is not skipped for public');
  const stage = mm.indexOf('node tool/ci/staging.mjs stage --build build.json --index staged.json --out stage-plan.json');
  assert.ok(stage > 0);
  assert.ok(mm.indexOf('echo "staged=true" >> "$GITHUB_OUTPUT"') > stage);
  // A public scan is recorded once: the reference build is the public exe only for a beta branch.
  assert.ok(mm.includes('if (r.reference?.status === "used" && process.env.BRANCH !== "public") scans.push('));
  // push-loader has no branch condition either.
  assert.ok(!/inputs\.branch/.test(job('push-loader').match(/\n {4}if: [^\n]+\n/)[0]));
  // A public build reaches the candidate job through push-loader.
  assert.match(job('candidate-loader'), /needs: \[push-loader\]/);
});

test('loader key: only push-loader reads it, in the fork-push environment; it is declared by the call and passed by name by sr-watch', () => {
  const readers = [...wf.matchAll(/\n {2}([a-z][\w-]*):\n/g)].map((m) => m[1]).filter((n) => /secrets\.SR_DEPLOYKEY_MODLOADER/.test(job(n)));
  assert.deepEqual(readers, ['push-loader']);
  assert.match(job('push-loader'), /\n {4}environment: fork-push\n/);
  assert.match(call, /\n {6}SR_DEPLOYKEY_MODLOADER:\n {8}description: [^\n]+\n {8}required: false\n/);
  // Same mechanism as the Steam login (called-login.test.mjs): the calling job has no environment of its own and passes the secret by name.
  const caller = watch.slice(watch.indexOf('  client-check:\n'));
  assert.ok(!/\n {4}environment:/.test(caller), 'the calling job sets no environment');
  assert.ok(caller.includes('\n      SR_DEPLOYKEY_MODLOADER: ${{ secrets.SR_DEPLOYKEY_MODLOADER }}\n'));
  assert.ok(!/secrets: inherit/.test(watch));
  // The push job's if names no secret, so a missing key reaches the first step, which fails with the cause.
  assert.ok(!/secrets\./.test(job('push-loader').match(/\n {4}if: [^\n]+\n/)[0]));
});

// ------------------------------------------------------------ leg B2: expected refusals per branch

test('expect_refused: the map-mode job outputs the plugins the loader refuses on the branch\'s build, before the chain can stop', () => {
  const mm = job('map-mode');
  assert.match(mm, /\n {6}expect_refused: \$\{\{ steps\.chain\.outputs\.expect_refused \}\}\n/);
  const at = mm.indexOf('expect_refused="$(node -p');
  assert.ok(at > 0, 'the step reads decision.json');
  // Set right after the decision is read, ahead of the exit 0 that ends a chain whose decision is not M.
  assert.ok(at > mm.indexOf('echo "decision=$decision"') && at < mm.indexOf('nothing exported or signed'));
  assert.ok(mm.includes('echo "expect_refused=$expect_refused" >> "$GITHUB_OUTPUT"'));
  // A rig input is never fed to a shell: the value is checked against the rig's name grammar first.
  assert.ok(mm.includes("grep -Eq '^[A-Za-z0-9_.-]+( [A-Za-z0-9_.-]+)*$'"));
});

test('expect_refused: the step turns decision.json into the rig input (names separated by spaces, empty when none)', { skip: !bash }, () => {
  const mm = job('map-mode');
  const start = mm.indexOf('          expect_refused="$(node -p');
  const end = mm.indexOf('\n', mm.indexOf('echo "expect_refused=$expect_refused"')) + 1;
  const snippet = mm.slice(start, end).replace(/^ {10}/gm, '');
  assert.ok(snippet.length > 100);
  const run = (decision) => {
    const dir = mkdtempSync(join(tmpdir(), 'expect-refused-'));
    writeFileSync(join(dir, 'decision.json'), JSON.stringify(decision));
    const r = spawnSync(bash, ['-c', snippet], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, BRANCH: 'public_test_branch', GITHUB_OUTPUT: join(dir, 'out.txt') } });
    return { status: r.status, out: existsSync(join(dir, 'out.txt')) ? readFileSync(join(dir, 'out.txt'), 'utf8') : '' };
  };
  assert.deepEqual(run({ decision: 'HOLD', expectRefused: ['MiniMap'] }), { status: 0, out: 'expect_refused=MiniMap\n' });
  assert.equal(run({ decision: 'M', expectRefused: ['Codex', 'MiniMap'] }).out, 'expect_refused=Codex MiniMap\n');
  assert.equal(run({ decision: 'M', expectRefused: [] }).out, 'expect_refused=\n');
  assert.equal(run({ decision: 'HOLD' }).out, 'expect_refused=\n', 'a decision written before the list existed');
  const bad = run({ decision: 'M', expectRefused: ['Mini Map; rm'] });
  assert.equal(bad.status, 2);
  assert.equal(bad.out, '');
});

// ------------------------------------------------------------ leg B3: the client rig is a required gate

// Evaluates a job's `if: ${{ ... }}` with the expression syntax these workflows use (a JS subset:
// && || ! == != and string literals), against fake needs and inputs.
const jobIf = (name) => job(name).match(/\n {4}if: (\$\{\{ .* \}\})\n/)[1];
const SR_WATCH_REF = 'msantoro12/starrupture-ci/.github/workflows/sr-watch.yml@refs/heads/main';
const contains = (a, b) => String(a).includes(String(b));
const evalExpr = (expr, ctx) => {
  const inner = expr.replace(/^\$\{\{ /, '').replace(/ \}\}$/, '');
  const js = inner
    .replace(/!cancelled\(\)|always\(\)/g, 'true')
    .replace(/needs\.([\w-]+)\./g, 'needs["$1"].')
    .replace(/!=/g, '!==').replace(/([^=!<>])==(?!=)/g, '$1===');
  return new Function('needs', 'inputs', 'github', 'contains', `return (${js});`)(ctx.needs, ctx.inputs, ctx.github ?? { workflow_ref: SR_WATCH_REF }, contains);
};
const okNeeds = () => ({
  'map-mode': { result: 'success', outputs: { test: 'false', decision: 'M', publishable: 'true', staged: 'true', expect_refused: '' } },
  'candidate-loader': { result: 'success', outputs: { artifact: 'loader-candidate-public', version: 'cand-1-abcdef0', expect: 'Loader=cand-1-abcdef0', sha: 'a'.repeat(40) } },
  'rig-branch': { result: 'success', outputs: { verdict: 'PASS', reason: 'All 40 checks passed', artifact: 'sr-client-rig-public-x-1-1' } },
  'rig-other': { result: 'success', outputs: { verdict: 'PASS', reason: 'All 40 checks passed', artifact: 'sr-client-rig-public_test_branch-x-1-1' } },
  check: { result: 'success', outputs: {} },
});
const okInputs = () => ({ publish: true, test_autopilot: false, branch: 'public', loader_repo: 'AlienXAXS/StarRupture-ModLoader', map_mode: true });
// The `with:` and `secrets:` maps of a call job, as written (values are the raw expressions).
const mapOf = (j, key) => {
  const at = j.indexOf(`\n    ${key}:\n`);
  assert.ok(at >= 0, `${key}: block exists`);
  const out = {};
  for (const line of j.slice(at + 1).split('\n').slice(1)) {
    const m = line.match(/^ {6}(\w+): (.*)$/);
    if (!m) break;
    out[m[1]] = m[2];
  }
  return out;
};
const RIG_JOBS = ['rig-branch', 'rig-other'];

test('rig gate: two jobs call the reusable rig, with the keyless call shape (no runner, no environment, both Steam secrets by name)', () => {
  for (const n of RIG_JOBS) {
    const j = job(n);
    assert.match(j, /\n {4}uses: \.\/\.github\/workflows\/sr-client-rig\.yml\n/, `${n} calls the rig`);
    assert.ok(!/\n {4}(runs-on|environment|steps|continue-on-error):/.test(j), `${n}: a call job has no runner, environment, steps or continue-on-error`);
    assert.match(j, /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n/, `${n}: the rig's own permissions`);
    assert.deepEqual(mapOf(j, 'secrets'), { STEAM_CI_USERNAME: '${{ secrets.STEAM_CI_USERNAME }}', STEAM_CI_LOGIN_CACHE: '${{ secrets.STEAM_CI_LOGIN_CACHE }}' }, `${n}: both secrets by name, nothing else`);
    assert.ok(!/secrets: inherit/.test(j));
    assert.match(j, /\n {4}needs: \[map-mode, candidate-loader/, `${n} needs the map job and the candidate loader`);
  }
  // The rig is called twice in the file, by these two jobs.
  assert.equal(wf.match(/uses: \.\/\.github\/workflows\/sr-client-rig\.yml/g)?.length, 2);
});

test('rig gate: the second rig follows the first, even when the first fails (the rig keeps one pending run per group)', () => {
  assert.match(job('rig-branch'), /\n {4}needs: \[map-mode, candidate-loader\]\n/);
  assert.match(job('rig-other'), /\n {4}needs: \[map-mode, candidate-loader, rig-branch\]\n/);
  const n = okNeeds();
  assert.equal(evalExpr(jobIf('rig-branch'), { needs: n, inputs: okInputs() }), true);
  assert.equal(evalExpr(jobIf('rig-other'), { needs: n, inputs: okInputs() }), true);
  // The first rig failed, was cancelled or skipped: the second still runs.
  for (const result of ['failure', 'cancelled', 'skipped']) {
    n['rig-branch'] = { result, outputs: { verdict: result === 'failure' ? 'FAIL' : '' } };
    assert.equal(evalExpr(jobIf('rig-other'), { needs: n, inputs: okInputs() }), true, `second rig runs after a first that is ${result}`);
  }
  // No candidate loader or no map job: neither runs (nothing to test).
  for (const dead of ['map-mode', 'candidate-loader']) {
    const m = okNeeds();
    m[dead].result = 'skipped';
    for (const r of RIG_JOBS) assert.equal(evalExpr(jobIf(r), { needs: m, inputs: okInputs() }), false, `${r} does not run when ${dead} was skipped`);
  }
  // The queue is the rig's own concurrency group; the call jobs add none.
  assert.ok(!/concurrency:\n {6}group: sr-client-rig/.test(wf), 'the call jobs add no group of their own');
});

test('rig gate: the candidate, the run id and the expect come from candidate-loader; the tags the check read; no extra inputs', () => {
  const a = mapOf(job('rig-branch'), 'with');
  const b = mapOf(job('rig-other'), 'with');
  assert.deepEqual(Object.keys(a).sort(), ['branch', 'candidate_artifact', 'candidate_run_id', 'expect', 'expect_refused', 'tags']);
  assert.deepEqual(Object.keys(b).sort(), ['branch', 'candidate_artifact', 'candidate_run_id', 'expect', 'expect_refused', 'tags']);
  for (const w of [a, b]) {
    assert.equal(w.candidate_run_id, '${{ github.run_id }}');
    assert.equal(w.candidate_artifact, '${{ needs.candidate-loader.outputs.artifact }}');
    assert.equal(w.expect, '${{ needs.candidate-loader.outputs.expect }}');
    // The releases the check read and declared the refusals for: both rigs run exactly these (empty: each repo's Latest release, nothing declared).
    assert.equal(w.tags, '${{ needs.map-mode.outputs.rig_tags }}');
  }
  assert.ok(!/remove_plugins/.test(job('rig-branch') + job('rig-other')));
});

test('rig gate: the first rig runs on the branch of this check, the second on the other one', () => {
  assert.equal(mapOf(job('rig-branch'), 'with').branch, '${{ inputs.branch }}');
  const other = mapOf(job('rig-other'), 'with').branch;
  for (const [mine, theirs] of [['public', 'public_test_branch'], ['public_test_branch', 'public']]) {
    assert.equal(evalExpr(other, { needs: okNeeds(), inputs: { branch: mine } }), theirs, `${mine} -> ${theirs}`);
  }
  // The job name follows the same rule, so the Actions list says which branch each rig is.
  assert.match(job('rig-branch'), /\n {4}name: client rig \(\$\{\{ inputs\.branch \}\}\)\n/);
  assert.equal(job('rig-other').match(/\n {4}name: client rig \((\$\{\{ .* \}\})\)\n/)[1], other);
});

test('rig gate: each rig declares the refusals the loader rule predicts for the build ITS branch runs, and the rule is written down', () => {
  assert.equal(mapOf(job('rig-branch'), 'with').expect_refused, '${{ needs.map-mode.outputs.expect_refused }}');
  assert.equal(mapOf(job('rig-other'), 'with').expect_refused, '${{ needs.map-mode.outputs.expect_refused_other }}');
  const comment = wf.slice(wf.indexOf('  # ---- Client rig: the candidate loader'), wf.indexOf('\n  rig-branch:\n')).replace(/\n\s*#\s*/g, ' ');
  assert.match(comment, /rig-other\s+the other Steam branch[^.]*the refusals the loader's own rule predicts for THAT branch's current build/);
  assert.match(comment, /any refusal it does not predict is a fail/);
  const readme = readFileSync(join(here, '..', '.github', 'sr-pipeline', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(readme, /the loader's own rule predicts for the other branch's current build/);
  assert.match(readme, /any refusal the rule does not predict is a fail/);
  assert.ok(!/the other branch gets no `expect_refused`/.test(readme), 'the old rule is gone');
});

test('rig gate: publish needs both rigs with result success and verdict PASS, and every old condition still applies', () => {
  assert.match(job('publish'), /\n {4}needs: \[check, map-mode, rig-branch, rig-other\]\n/);
  const run = (mut = () => {}, inputs = okInputs(), github = undefined) => {
    const n = okNeeds();
    mut(n);
    return evalExpr(jobIf('publish'), { needs: n, inputs, github });
  };
  assert.equal(run(), true, 'both rigs pass: it runs');
  for (const r of RIG_JOBS) {
    assert.equal(run((n) => { n[r] = { result: 'failure', outputs: { verdict: 'FAIL' } }; }), false, `${r} FAIL`);
    assert.equal(run((n) => { n[r] = { result: 'skipped', outputs: { verdict: '' } }; }), false, `${r} skipped is not a pass`);
    assert.equal(run((n) => { n[r] = { result: 'cancelled', outputs: { verdict: '' } }; }), false, `${r} cancelled`);
    assert.equal(run((n) => { n[r].outputs.verdict = ''; }), false, `${r} success without a verdict`);
    assert.equal(run((n) => { n[r].outputs.verdict = 'FAIL'; }), false, `${r} success result with a FAIL verdict`);
    assert.equal(run((n) => { n[r] = { result: 'failure', outputs: { verdict: 'PASS' } }; }), false, `${r} a failed job is not a pass whatever it says`);
  }
  // The old conditions are all still there.
  // sr-watch's chain publishes without the input; a direct dispatch is a dry run unless it asks to publish.
  const direct = { workflow_ref: 'msantoro12/starrupture-ci/.github/workflows/sr-client-check.yml@refs/heads/main' };
  assert.equal(run(() => {}, { ...okInputs(), publish: false }), true, 'sr-watch calls the check with publish off and it publishes');
  assert.equal(run(() => {}, { ...okInputs(), publish: false }, direct), false, 'a direct dispatch without publish is a dry run');
  assert.equal(run(() => {}, { ...okInputs(), publish: true }, direct), true, 'a direct dispatch with publish on publishes');
  assert.equal(run(() => {}, { ...okInputs(), test_autopilot: true }), false, 'test run');
  assert.equal(run(() => {}, { ...okInputs(), branch: 'public_test_branch' }), false, 'only public publishes');
  assert.equal(run((n) => { n['map-mode'].outputs.decision = 'HOLD'; }), false, 'a HOLD decision (autopilot off)');
  assert.equal(run((n) => { n['map-mode'].outputs.publishable = 'false'; }), false);
  assert.equal(run((n) => { n['map-mode'].outputs.test = 'true'; }), false);
});

test('rig gate: the promote step only writes a plan, so the publish job is the one gate', () => {
  // promote.mjs plan runs inside map-mode and uploads nothing; the one job that signs with the release key or writes the feed is publish.
  assert.ok(job('map-mode').includes('promote.mjs plan'));
  assert.ok(!/promote\.mjs (apply|publish|run)/.test(wf));
  const writers = [...wf.matchAll(/\n {2}([a-z][\w-]*):\n/g)].map((m) => m[1]).filter((n) => /gh release upload|vmap-sign\.mjs sign [^\n]*--key-id k2/.test(job(n)));
  assert.deepEqual(writers, ['publish']);
});

test('rig gate: a rig failure fails the chain visibly (the gate job is red unless both pass), and the autopilot stays untouched', () => {
  const g = job('rig-gate');
  assert.match(g, /\n {4}needs: \[map-mode, candidate-loader, rig-branch, rig-other\]\n/);
  assert.match(g, /process\.exit\(1\)/);
  assert.ok(!/continue-on-error/.test(g));
  // It runs for what the chain staged and pushed (push-loader's cue), also when a rig failed or never ran.
  const cond = (needs, inputs) => evalExpr(jobIf('rig-gate'), { needs, inputs });
  assert.equal(cond(okNeeds(), okInputs()), true);
  const failed = okNeeds();
  failed['rig-branch'] = { result: 'failure', outputs: { verdict: 'FAIL' } };
  failed['rig-other'] = { result: 'skipped', outputs: {} };
  assert.equal(cond(failed, okInputs()), true, 'a failed first rig still gets a gate verdict');
  const notStaged = okNeeds();
  notStaged['map-mode'].outputs.staged = 'false';
  assert.equal(cond(notStaged, okInputs()), false, 'nothing staged: nothing to test');
  assert.equal(cond(okNeeds(), { ...okInputs(), test_autopilot: true }), false, 'a test run pushes nothing');
  assert.equal(cond(okNeeds(), { ...okInputs(), loader_repo: 'msantoro12/StarRupture-ModLoader' }), true, 'the base repository does not matter: what is staged is always pushed to the fork');
  // The autopilot decides publishing only; the rig runs either way (a HOLD with the autopilot off is still a candidate).
  assert.ok(!/state\/autopilot/.test(wf.slice(wf.indexOf('  rig-branch:'), wf.indexOf('  alert:'))));
});

test('rig gate: the summary carries both verdicts, reasons and the logs artifact, and the job exits 1 unless both pass', { skip: !bash }, () => {
  const g = job('rig-gate');
  const head = '        run: |\n';
  const script = g.slice(g.indexOf(head) + head.length).replace(/^ {10}/gm, '');
  const base = {
    RUN_URL: 'https://github.com/o/r/actions/runs/7', DECISION: 'HOLD', PUBLISHABLE: 'false', CANDIDATE_RESULT: 'success', CANDIDATE_VERSION: 'cand-7-abcdef0', CANDIDATE_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
    BRANCH_NAME: 'public_test_branch', BRANCH_RESULT: 'success', BRANCH_VERDICT: 'PASS', BRANCH_REASON: 'All 41 checks passed', BRANCH_ARTIFACT: 'sr-client-rig-public_test_branch-cand-7-1', BRANCH_EXPECT_REFUSED: 'MiniMap',
    OTHER_NAME: 'public', OTHER_RESULT: 'success', OTHER_VERDICT: 'PASS', OTHER_REASON: 'All 41 checks passed', OTHER_ARTIFACT: 'sr-client-rig-public-cand-7-1',
  };
  const run = (over = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-gate-'));
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    const r = spawnSync(bash, ['-c', script], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...base, ...over, GITHUB_STEP_SUMMARY: summary } });
    return { status: r.status, out: r.stdout, md: readFileSync(summary, 'utf8') };
  };
  const ok = run();
  assert.equal(ok.status, 0);
  assert.match(ok.md, /### Client rig gate: PASS/);
  assert.match(ok.md, /Decision HOLD, not publishable\. Candidate loader cand-7-abcdef0 \(loader commit abcdef0\)/);
  assert.match(ok.md, /\*\*public_test_branch\*\*: PASS - All 41 checks passed\. Must be refused here: MiniMap\./);
  assert.match(ok.md, /\*\*public\*\*: PASS - All 41 checks passed\. No refusals expected: its current build must keep working/);
  // The other rig's declared refusals are named, with the rule that any other refusal fails.
  assert.match(run({ OTHER_EXPECT_REFUSED: 'MiniMap' }).md, /\*\*public\*\*: PASS - All 41 checks passed\. Must be refused here \(the loader rule for the build this branch runs\): MiniMap\. Any other refusal is a fail\./);
  assert.match(ok.md, /artifact `sr-client-rig-public-cand-7-1` of https:\/\/github\.com\/o\/r\/actions\/runs\/7/);
  const bad = run({ OTHER_RESULT: 'failure', OTHER_VERDICT: 'FAIL', OTHER_REASON: 'plugin_not_refused_MiniMap: FOUND' });
  assert.equal(bad.status, 1);
  assert.match(bad.md, /### Client rig gate: FAIL/);
  assert.match(bad.md, /\*\*public\*\*: FAIL - plugin_not_refused_MiniMap: FOUND/);
  assert.match(bad.out, /::error title=Client rig gate::public did not pass; the feed is not published\./);
  // A rig that never ran for a staged candidate is not a pass.
  const skipped = run({ BRANCH_RESULT: 'skipped', BRANCH_VERDICT: '', BRANCH_REASON: '', BRANCH_ARTIFACT: '', CANDIDATE_RESULT: 'failure' });
  assert.equal(skipped.status, 1);
  assert.match(skipped.md, /\*\*public_test_branch\*\*: did not run - candidate loader job: failure/);
  assert.match(skipped.md, /no logs artifact/);
  const cancelled = run({ OTHER_RESULT: 'cancelled', OTHER_VERDICT: '', OTHER_REASON: '' });
  assert.equal(cancelled.status, 1);
  assert.match(cancelled.md, /\*\*public\*\*: cancelled/);
  // A success result with a verdict that is not PASS fails too.
  assert.equal(run({ BRANCH_VERDICT: '' }).status, 1);
  // No expected refusals says so.
  assert.match(run({ BRANCH_EXPECT_REFUSED: '' }).md, /No refusals expected\./);
});

test('rig gate: the nested call fits its callers (permissions ceiling, depth, main-only environment)', () => {
  const caller = watch.slice(watch.indexOf('  client-check:\n'));
  const grants = (text) => Object.fromEntries([...text.matchAll(/ {6}([a-z-]+): (read|write)\b/g)].map((m) => [m[1], m[2]]));
  const ceiling = grants(caller.match(/\n {4}permissions:\n((?: {6}[a-z-]+: .*\n)+)/)[1]);
  assert.equal(ceiling.actions, 'read', "sr-watch grants the rig its actions: read (a nested call is checked against the top caller)");
  for (const n of RIG_JOBS) {
    const asked = grants(job(n).match(/\n {4}permissions:\n((?: {6}[a-z-]+: .*\n)+)/)[1]);
    for (const [k, v] of Object.entries(asked)) assert.ok(ceiling[k] === v || (v === 'read' && ceiling[k] === 'write'), `${n}: ${k}: ${v} fits sr-watch's ceiling`);
  }
  // sr-watch -> sr-client-check -> sr-client-rig: the rig itself calls nothing, and its one environment serves main only.
  const rig = readFileSync(join(here, '..', '.github', 'workflows', 'sr-client-rig.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!/\n {4}uses: /.test(rig));
  assert.match(rig, /\n {4}environment: steam-client\n/);
});

// ------------------------------------------------------------ leg C1: loud alerts, the stale update PR, the plugin fork keys

// The alert job's two bash steps, run for real: the step's run block in a temp directory, with the
// files the earlier steps leave (res/, chain/, failed-jobs.jsonl, logs/) and the env GitHub would set.
const ALERT_ENV = {
  BRANCH: 'public_test_branch', BUILDID: '26461198', OWNER: 'msantoro12', RUN_ID: '9', GH_REPO: 'o/r', PR: '26',
  RUN_URL: 'https://github.com/o/r/actions/runs/9',
  BUILD_RESULT: 'success', PLAN_RESULT: 'success', CHECK_RESULT: 'success', MAP_MODE_RESULT: 'success', PUBLISH_RESULT: 'skipped',
  STAGED_EXPECTED: 'true', PUSH_RESULT: 'success', CANDIDATE_RESULT: 'success', RIG_GATE_RESULT: 'success',
  BRANCH_RIG_NAME: 'public_test_branch', BRANCH_RIG_RESULT: 'success', BRANCH_RIG_VERDICT: 'PASS', BRANCH_RIG_REASON: 'All 41 checks passed', BRANCH_RIG_ARTIFACT: 'sr-client-rig-public_test_branch-1',
  OTHER_RIG_NAME: 'public', OTHER_RIG_RESULT: 'success', OTHER_RIG_VERDICT: 'PASS', OTHER_RIG_REASON: 'All 41 checks passed', OTHER_RIG_ARTIFACT: 'sr-client-rig-public-1',
};
const AUTOPILOT_HOLD = 'autopilot is disabled (enabled is not true)';
const HOLD_ONLY_AUTOPILOT = { decision: 'HOLD', cl: 129402, candidate: true, wouldBe: 'M', reasons: [AUTOPILOT_HOLD] };
// A fake `gh`: logs every call, answers from files in its own directory. Nothing leaves the temp directory.
const FAKE_GH = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DIR/calls.log"
reply() { [ -f "$FAKE_DIR/$1" ] && cat "$FAKE_DIR/$1"; return 0; }
case "$1 $2" in
  "pr list") reply pr.json ;;
  "pr view") case "$*" in *title*) echo "Game build 26461198 on public_test_branch" ;; *) reply pr-chain-labels.txt ;; esac ;;
  "issue list") reply issue-number.txt ;;
  "api repos/"*) case "$2" in */comments) reply comment-times.txt ;; *) reply issue-body-time.txt ;; esac ;;
esac
exit 0
`;
const runBash = (script, { cwd, env, files = {} }) => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  const bin = join(cwd, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  return spawnSync(bash, ['-c', script], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env, FAKE_DIR: cwd, RUNNER_TEMP: cwd, PATH: bin + delimiter + process.env.PATH } });
};
const calls = (dir) => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
const alertRun = ({ env = {}, result, decision, jobs = [], logs = {}, noChain = false, extra = {} } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'alert-'));
  const files = { 'out.txt': '', ...extra };
  if (result) files['res/result.json'] = result;
  if (decision) files['chain/decision.json'] = decision;
  else if (!noChain) files['chain/map-mode-report.json'] = {};
  // ci/pipeline-alert.mjs causes writes each failed job with its first error line, read here from the log given.
  if (jobs.length) files['failed-jobs.jsonl'] = jobs.map((j) => JSON.stringify(logs[j.id] === undefined ? j : { ...j, error: firstLogError(logs[j.id]) })).join('\n') + '\n';
  const script = runOf(job('alert'), 'Work out what needs attention');
  const r = runBash(script, { cwd: dir, env: { ...ALERT_ENV, ...env, GITHUB_OUTPUT: join(dir, 'out.txt') }, files });
  const read = (n) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : null);
  const outputs = Object.fromEntries((read('out.txt') ?? '').split('\n').filter(Boolean).map((l) => l.split('=')));
  return { status: r.status, stderr: r.stderr, outputs, md: read('alert.md'), ready: read('ready.md') };
};
const goodDecision = { decision: 'M', cl: 129402 };

test('alert (leg C1): a run in which every job and gate passed raises nothing, and is marked passed', { skip: !bash }, () => {
  const a = alertRun({ decision: goodDecision });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.md, null);
  assert.deepEqual(a.outputs, { alert: 'false', passed: 'true', ready: 'false' });
});

test('alert (leg C1): a failed job is a line with its cause, from the check result, the jobs API and the first error line of its log', { skip: !bash }, () => {
  // check: the reason its result.json recorded.
  const noLogin = alertRun({ env: { CHECK_RESULT: 'failure', MAP_MODE_RESULT: 'skipped', STAGED_EXPECTED: 'false' }, result: { status: 'no-login', reason: 'the Steam login secrets reached the called check empty' } });
  assert.equal(noLogin.outputs.alert, 'true');
  assert.match(noLogin.md, /- job \*\*check\*\* failed\n  - cause: no Steam login \(status no-login\): the Steam login secrets reached the called check empty/);
  // check: no result artifact at all, and a failed step from the jobs API.
  const noResult = alertRun({
    env: { CHECK_RESULT: 'failure', MAP_MODE_RESULT: 'skipped', STAGED_EXPECTED: 'false' },
    jobs: [{ id: 11, name: 'client-check (public_test_branch) / check', step: 'Download the client build' }],
    logs: { 11: '﻿2026-11-07T13:29:38.4Z group\n2026-11-07T13:29:43.8Z ##[error]steamcmd exited 5: login failed\n2026-11-07T13:29:43.9Z ##[error]Process completed with exit code 1.\n' },
  });
  assert.match(noResult.md, /- job \*\*check\*\* failed\n  - cause: no check result artifact; step "Download the client build": steamcmd exited 5: login failed/);
  // The job of the other branch's matrix entry is not mistaken for this one.
  const other = alertRun({ env: { CHECK_RESULT: 'failure', MAP_MODE_RESULT: 'skipped', STAGED_EXPECTED: 'false' }, jobs: [{ id: 12, name: 'client-check (public) / check', step: 'Not this one' }, { id: 13, name: 'client-check (public_test_branch) / check', step: 'This one' }] });
  assert.match(other.md, /step "This one"/);
  assert.ok(!/Not this one/.test(other.md));
  // map mode: names the failing step and says when its artifact is missing.
  const mm = alertRun({
    env: { MAP_MODE_RESULT: 'failure', STAGED_EXPECTED: 'false' }, noChain: true,
    jobs: [{ id: 21, name: 'map mode', step: 'Write the update into the header' }],
    logs: { 21: '2026-11-07T13:29:43.8Z ##[error]map mode refused the update (exit 2); see the log and map-mode-report.json\n2026-11-07T13:29:43.9Z ##[error]Process completed with exit code 2.\n' },
  });
  assert.match(mm.md, /- job \*\*map mode\*\* failed\n  - the map-mode artifact is missing/);
  assert.match(mm.md, /cause: step "Write the update into the header": map mode refused the update \(exit 2\)/);
  // With the artifact there, the missing-artifact line is not written.
  const mm2 = alertRun({ env: { MAP_MODE_RESULT: 'failure', STAGED_EXPECTED: 'false' }, jobs: [{ id: 21, name: 'map mode', step: 'Export' }] });
  assert.ok(!/artifact is missing/.test(mm2.md));
  // The others: build-scanner, plugin-plan, publish.
  for (const [env, name] of [[{ BUILD_RESULT: 'failure' }, 'build-scanner'], [{ PLAN_RESULT: 'failure' }, 'plugin-plan'], [{ PUBLISH_RESULT: 'failure' }, 'publish the feed']]) {
    assert.match(alertRun({ env, decision: goodDecision }).md, new RegExp(`- job \\*\\*${name}\\*\\* failed`), name);
  }
  // Every alert names the owner, so GitHub notifies him.
  assert.match(noLogin.md, /^@msantoro12 branch `public_test_branch`, build 26461198, \[run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/9\)\./);
});

test('alert (leg C1): a check that did not run (status skipped or no-login) is a line even when the check job succeeded', { skip: !bash }, () => {
  const skipped = alertRun({ result: { status: 'skipped', reason: 'no Steam login is configured' }, decision: goodDecision });
  assert.equal(skipped.outputs.alert, 'true');
  assert.equal(skipped.outputs.passed, 'false');
  assert.match(skipped.md, /- client check \*\*did not run\*\* \(status skipped\): no Steam login is configured/);
  const noLogin = alertRun({ result: { status: 'no-login', reason: 'environment steam-client has no STEAM_CI_USERNAME' }, decision: goodDecision });
  assert.match(noLogin.md, /- client check \*\*did not run\*\* \(status no-login\): environment steam-client has no STEAM_CI_USERNAME/);
  // A skipped result without a reason still says so.
  assert.match(alertRun({ result: { status: 'skipped' }, decision: goodDecision }).md, /\(status skipped\): no reason recorded/);
  // A normal pass and a new build are not.
  assert.equal(alertRun({ result: { status: 'pass' }, decision: goodDecision }).outputs.alert, 'false');
});

test('alert (leg C1): a new build is information in an alert, never an alert by itself', { skip: !bash }, () => {
  const result = { status: 'new-build', checks: { exe: { cl: 129402, productVersion: '1.0.0.129402', requiredCl: 'no row' } } };
  assert.deepEqual(alertRun({ result, decision: goodDecision }).outputs, { alert: 'false', passed: 'true', ready: 'false' });
  const withFault = alertRun({ result, decision: goodDecision, env: { PUBLISH_RESULT: 'failure' } });
  assert.match(withFault.md, /New build \*\*CL-129402\*\* \(1\.0\.0\.129402\), measured by map mode: the loader does not run on it yet \(no row\); this is not a failure\./);
});

test('alert (leg C1): a HOLD is a line with its reasons, except "nothing new" and the autopilot switch alone', { skip: !bash }, () => {
  const held = alertRun({ decision: { decision: 'HOLD', cl: 129402, reasons: ['G4: 2 required patterns missed', 'G5: 3 used classes changed'] } });
  assert.equal(held.outputs.alert, 'true');
  assert.match(held.md, /- decide: \*\*HOLD\*\* on CL-129402\n  - G4: 2 required patterns missed\n  - G5: 3 used classes changed/);
  assert.equal(alertRun({ decision: { decision: 'HOLD', cl: 129402, reasons: ['G3: CL-129402 is not newer than CL-129402'] } }).outputs.alert, 'false');
  // The autopilot switch beside another reason is still an alert, and lists both.
  const both = alertRun({ decision: { decision: 'HOLD', cl: 129402, candidate: true, reasons: [AUTOPILOT_HOLD, 'G1 compile: failed'] } });
  assert.equal(both.outputs.alert, 'true');
  assert.match(both.md, /  - autopilot is disabled \(enabled is not true\)\n  - G1 compile: failed/);
  // No decision from a map-mode job that succeeded.
  assert.match(alertRun({ noChain: true }).md, /map mode finished without a decision \(and the map-mode artifact is missing\)/);
});

test('alert (leg C1): a HOLD whose only reason is "autopilot is disabled", every gate and job passing, raises no issue and writes the ready note', { skip: !bash }, () => {
  const a = alertRun({ decision: HOLD_ONLY_AUTOPILOT });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.md, null, 'no alert.md, so the issue step is skipped');
  assert.deepEqual(a.outputs, { alert: 'false', passed: 'true', ready: 'true' });
  assert.equal(a.ready, '<!-- sr-ready-held:public_test_branch -->\n**Ready, publish held (autopilot off).** CL-129402 on `public_test_branch`: every gate and job passed, [run](https://github.com/o/r/actions/runs/9).\n');
  assert.equal(a.ready.trim().split('\n').length - 1, 1, 'one line besides the marker');
  // A test run (dispatch) says nothing on a PR.
  assert.equal(alertRun({ decision: { ...HOLD_ONLY_AUTOPILOT, test: true, candidate: undefined } }).outputs.ready, 'false');
  // With the autopilot as the only decide reason but a job failing, it is an alert and no note.
  const failing = alertRun({ decision: HOLD_ONLY_AUTOPILOT, env: { CANDIDATE_RESULT: 'failure', BRANCH_RIG_RESULT: 'skipped', BRANCH_RIG_VERDICT: '', BRANCH_RIG_REASON: '', OTHER_RIG_RESULT: 'skipped', OTHER_RIG_VERDICT: '', OTHER_RIG_REASON: '', RIG_GATE_RESULT: 'failure' } });
  assert.equal(failing.outputs.alert, 'true');
  assert.equal(failing.ready, null);
  // The step that opens the issue runs only for an alert.
  assert.match(step(job('alert'), 'Open or update the issue'), /\n {8}if: steps\.what\.outputs\.alert == 'true'\n/);
});

test('alert (leg C1): a missing or failed push, a failed candidate build or test, and a rig that did not pass are lines with the cause', { skip: !bash }, () => {
  const push = alertRun({
    decision: HOLD_ONLY_AUTOPILOT,
    env: { PUSH_RESULT: 'failure', CANDIDATE_RESULT: 'skipped', RIG_GATE_RESULT: 'failure', BRANCH_RIG_RESULT: 'skipped', BRANCH_RIG_VERDICT: '', BRANCH_RIG_REASON: '', OTHER_RIG_RESULT: 'skipped', OTHER_RIG_VERDICT: '', OTHER_RIG_REASON: '' },
    jobs: [{ id: 31, name: 'client-check (public_test_branch) / push the map rows to the loader fork', step: 'Check the deploy key' }],
    logs: { 31: '2026-11-07T13:29:43.8Z ##[error]Loader deploy key missing: the secret SR_DEPLOYKEY_MODLOADER is not set\n' },
  });
  assert.match(push.md, /- the staged map rows were \*\*not pushed\*\* to the loader fork \(push-loader failed\)\n  - cause: step "Check the deploy key": Loader deploy key missing/);
  assert.match(push.md, /- \*\*client rig gate\*\* failed/);
  assert.match(push.md, /  - rig public_test_branch: did not run - candidate loader job: skipped/);
  // A push that never ran although the chain staged is a missing push.
  const skipped = alertRun({ decision: HOLD_ONLY_AUTOPILOT, env: { PUSH_RESULT: 'skipped', CANDIDATE_RESULT: 'skipped' } });
  assert.match(skipped.md, /\(push-loader ended skipped\)\n  - cause: a job before it did not finish/);
  // Nothing staged (or a test run): no push is expected, so none is missing.
  assert.equal(alertRun({ decision: goodDecision, env: { STAGED_EXPECTED: 'false', PUSH_RESULT: 'skipped', CANDIDATE_RESULT: 'skipped', RIG_GATE_RESULT: 'skipped', BRANCH_RIG_RESULT: 'skipped', OTHER_RIG_RESULT: 'skipped', BRANCH_RIG_VERDICT: '', OTHER_RIG_VERDICT: '' } }).outputs.alert, 'false');
  // The candidate build or its tests.
  const cand = alertRun({
    decision: HOLD_ONLY_AUTOPILOT, env: { CANDIDATE_RESULT: 'failure', RIG_GATE_RESULT: 'failure', BRANCH_RIG_RESULT: 'skipped', BRANCH_RIG_VERDICT: '', BRANCH_RIG_REASON: '', OTHER_RIG_RESULT: 'skipped', OTHER_RIG_VERDICT: '', OTHER_RIG_REASON: '' },
    jobs: [{ id: 32, name: 'client-check (public_test_branch) / candidate loader', step: 'Run VersionMapTests' }],
    logs: { 32: '2026-11-07T13:30:00.0Z ##[error]VersionMapTests: 2 failed\n' },
  });
  assert.match(cand.md, /- the \*\*candidate loader\*\* did not build and pass its tests \(candidate-loader failed\)\n  - cause: step "Run VersionMapTests": VersionMapTests: 2 failed/);
  // A rig FAIL carries its verdict reason and logs artifact; the other rig passing is not listed.
  const rig = alertRun({ decision: HOLD_ONLY_AUTOPILOT, env: { RIG_GATE_RESULT: 'failure', OTHER_RIG_RESULT: 'failure', OTHER_RIG_VERDICT: 'FAIL', OTHER_RIG_REASON: 'plugin_not_refused_MiniMap: FOUND' } });
  assert.match(rig.md, /- \*\*client rig gate\*\* failed: the feed is published only when both rigs pass\n  - rig public: FAIL - plugin_not_refused_MiniMap: FOUND \(logs: artifact sr-client-rig-public-1\)\n/);
  assert.ok(!/rig public_test_branch/.test(rig.md));
  // A rig job that ended success without a PASS verdict is not a pass, and neither is a cancelled one.
  assert.match(alertRun({ decision: HOLD_ONLY_AUTOPILOT, env: { BRANCH_RIG_VERDICT: '' , BRANCH_RIG_REASON: '' } }).md, /rig public_test_branch: success - no verdict; see the rig job/);
  assert.match(alertRun({ decision: HOLD_ONLY_AUTOPILOT, env: { OTHER_RIG_RESULT: 'cancelled', OTHER_RIG_VERDICT: '', OTHER_RIG_REASON: '' } }).md, /rig public: cancelled - no verdict/);
  // A failed gate job alone (rigs fine) is still a line.
  assert.match(alertRun({ decision: HOLD_ONLY_AUTOPILOT, env: { RIG_GATE_RESULT: 'failure' } }).md, /- \*\*client rig gate\*\* failed/);
});

// The issue steps run ci/pipeline-alert.mjs, which calls gh itself: only where node finds the fake gh first
// (not on Windows, where node cannot run the fake's shebang and would reach the real gh).
const withAlertScript = (dir) => {
  mkdirSync(join(dir, 'ci'), { recursive: true });
  for (const f of ['pipeline-alert.mjs', 'layout-diff.mjs']) cpSync(join(here, f), join(dir, 'ci', f));
  return dir;
};
const fakeGhReachable = !!bash && process.platform !== 'win32';

test('alert (leg C1): the issue is labelled pipeline-alert and assigned to the owner on create; a re-alert comments on the open issue', { skip: !fakeGhReachable }, () => {
  const script = runOf(job('alert'), 'Open or update the issue');
  const dir = withAlertScript(mkdtempSync(join(tmpdir(), 'alert-issue-')));
  const created = runBash(script, { cwd: dir, env: ALERT_ENV, files: { 'alert.md': 'x' } });
  assert.equal(created.status, 0, created.stderr);
  const c = calls(dir);
  assert.ok(c.includes('label create pipeline-alert --color B60205 --description A pipeline run or a game-update PR needs the owner --force'), c.join('\n'));
  assert.ok(c.includes('issue create --title SR map mode: public_test_branch needs attention --body-file alert.md --label pipeline-alert --assignee msantoro12'), c.join('\n'));
  assert.ok(!c.some((l) => l.startsWith('issue comment')));
  // An open issue for the branch: comment on that one, and make sure it is labelled and assigned.
  const dir2 = withAlertScript(mkdtempSync(join(tmpdir(), 'alert-issue-')));
  const again = runBash(script, { cwd: dir2, env: ALERT_ENV, files: { 'alert.md': 'x', 'issue-number.txt': '27\n' } });
  assert.equal(again.status, 0, again.stderr);
  const c2 = calls(dir2);
  assert.ok(c2.includes('issue comment 27 --body-file alert.md'), c2.join('\n'));
  assert.ok(c2.includes('issue edit 27 --add-label pipeline-alert --add-assignee msantoro12'), c2.join('\n'));
  assert.ok(!c2.some((l) => l.startsWith('issue create')));
  // The lookup is by exact title.
  assert.ok(c2.some((l) => l.startsWith('issue list --state open --search SR map mode: public_test_branch needs attention in:title')));
});

test('alert (leg C1): the PR gets the chain-passed label after a clean run, loses it after an alert, and one ready note that is edited in place', { skip: !bash }, () => {
  const s = step(job('alert'), 'Mark the pull request');
  assert.match(s, /\n {8}if: \$\{\{ !cancelled\(\) && steps\.what\.outcome == 'success' && inputs\.pr != '' \}\}\n/);
  const script = runOf(job('alert'), 'Mark the pull request');
  const run = (env, files = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'alert-pr-'));
    const r = runBash(script, { cwd: dir, env: { ...ALERT_ENV, ...env }, files: { 'ready.md': 'note\n', ...files } });
    assert.equal(r.status, 0, r.stderr);
    return calls(dir);
  };
  const passed = run({ ALERT: 'false', PASSED: 'true', READY: 'false' });
  assert.ok(passed.includes('pr edit 26 --add-label chain-passed-public_test_branch'), passed.join('\n'));
  assert.ok(passed.some((l) => l.startsWith('label create chain-passed-public_test_branch ')));
  assert.ok(!passed.some((l) => l.startsWith('pr comment') || l.includes('PATCH')));
  const alerted = run({ ALERT: 'true', PASSED: 'false', READY: 'false' });
  assert.ok(alerted.includes('pr edit 26 --remove-label chain-passed-public_test_branch'), alerted.join('\n'));
  // Nothing alerted but not passed (no decision, map mode off): the label is left as it was.
  const neither = run({ ALERT: 'false', PASSED: 'false', READY: 'false' });
  assert.ok(!neither.some((l) => l.startsWith('pr edit')));
  // The ready note: a new comment, or the existing marked one edited.
  const fresh = run({ ALERT: 'false', PASSED: 'true', READY: 'true' });
  assert.ok(fresh.includes('pr comment 26 --body-file ready.md'), fresh.join('\n'));
  const edited = run({ ALERT: 'false', PASSED: 'true', READY: 'true' }, { 'comment-times.txt': '555\n' });
  assert.ok(edited.includes('api -X PATCH repos/o/r/issues/comments/555 -F body=@ready.md'), edited.join('\n'));
  assert.ok(!edited.some((l) => l.startsWith('pr comment')));
});

// ---- sr-watch: the stale game-update PR

// A step of a job, as written.
const step = (j, name) => {
  const at = j.indexOf(`- name: ${name}\n`);
  assert.ok(at >= 0, `step "${name}" exists`);
  const next = j.indexOf('\n      - ', at + 1);
  return j.slice(at, next < 0 ? undefined : next);
};

const NOW = Date.parse('2026-11-07T20:00:00Z') / 1000;
const hoursAgo = (h) => new Date((NOW - h * 3600) * 1000).toISOString().replace('.000Z', 'Z');
const staleRun = ({ ageH, labels = [], matrix = '[{"branch":"public","buildid":"1"},{"branch":"public_test_branch","buildid":"2"}]', issue, issueBodyTime, commentTimes, noPr = false }) => {
  const dir = mkdtempSync(join(tmpdir(), 'stale-'));
  const pr = { number: 26, headRefName: 'game-update/client-public_test_branch-26461198', title: 'Game build 26461198 on public_test_branch', createdAt: hoursAgo(ageH), labels: ['game-update', ...labels].map((name) => ({ name })) };
  const files = {};
  if (!noPr) files['pr.json'] = JSON.stringify(pr);
  if (issue) files['issue-number.txt'] = `${issue}\n`;
  if (issueBodyTime) files['issue-body-time.txt'] = `${issueBodyTime}\n`;
  if (commentTimes) files['comment-times.txt'] = commentTimes.join('\n') + '\n';
  const script = runOf(poll, 'Alert on a stale game-update PR');
  const r = runBash(script, { cwd: dir, env: { MATRIX: matrix, STALE_HOURS: '6', OWNER: 'msantoro12', GH_REPO: 'o/r', NOW_EPOCH: String(NOW), GITHUB_SERVER_URL: 'https://github.com' }, files });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const c = calls(dir);
  const body = existsSync(join(dir, 'stale.md')) ? readFileSync(join(dir, 'stale.md'), 'utf8') : null;
  return { calls: c, creates: c.filter((l) => l.startsWith('issue create')), comments: c.filter((l) => l.startsWith('issue comment')), edits: c.filter((l) => l.startsWith('issue edit')), body, out: r.stdout };
};
const watchJob = (name) => {
  const rest = watch.slice(watch.indexOf(`\n  ${name}:\n`) + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const poll = watchJob('poll');

test('stale PR (leg C1): the step runs on the skip path only, and the poll job may write issues', () => {
  const s = step(poll, 'Alert on a stale game-update PR');
  assert.match(s, /\n {8}if: steps\.pr\.outputs\.skip == 'true'\n/);
  assert.match(poll, /\n {4}permissions:\n(?: {6}.*\n)*? {6}issues: write/);
  assert.match(s, /STALE_HOURS: '6'/);
  assert.match(s, /MATRIX: \$\{\{ steps\.poll\.outputs\.client_matrix \}\}/);
  // It comes after the PR step, whose skip path it reads.
  assert.ok(poll.indexOf('- name: Alert on a stale game-update PR') > poll.indexOf('- name: Open or update the game-update PR'));
  // A refreshed PR drops its chain-passed labels, so the old pass does not stand for the new build.
  assert.match(poll, /select\(startswith\("chain-passed-"\)\)[\s\S]*--remove-label "\$l"/);
});

test('stale PR (leg C1): a game-update PR open over 6 hours without the chain-passed label opens the branch alert issue, labelled and assigned', { skip: !bash }, () => {
  const r = staleRun({ ageH: 7 });
  assert.equal(r.creates.length, 2, r.calls.join('\n'));
  assert.ok(r.creates.includes('issue create --title SR map mode: public needs attention --body-file ' + r.calls.find((l) => l.startsWith('issue create')).split('--body-file ')[1].split(' --label')[0] + ' --label pipeline-alert --assignee msantoro12'), r.creates.join('\n'));
  assert.ok(r.creates.some((l) => l.startsWith('issue create --title SR map mode: public_test_branch needs attention')));
  assert.ok(r.calls.some((l) => l.startsWith('label create pipeline-alert ')));
  assert.match(r.body, /^<!-- sr-stale-pr:26 -->\n@msantoro12 game-update PR #26 \(Game build 26461198 on public_test_branch\) has been open 7 hours and the client chain has not passed for `public_test_branch`: the PR has no `chain-passed-public_test_branch` label\./);
  assert.match(r.body, /gh workflow run sr-watch\.yml --ref main -f force=true/);
});

test('stale PR (leg C1): under 6 hours, with every chain-passed label, with no client branch, or with no open PR it raises nothing', { skip: !bash }, () => {
  const none = (r, why) => { assert.ok(!r.calls.some((l) => l.startsWith('issue ') && !l.startsWith('issue list')), `${why}: ${r.calls.join('\n')}`); assert.ok(!r.calls.some((l) => l.startsWith('label create')), why); };
  none(staleRun({ ageH: 5.5 }), 'under 6 hours');
  none(staleRun({ ageH: 30, labels: ['chain-passed-public', 'chain-passed-public_test_branch'] }), 'both branches passed');
  none(staleRun({ ageH: 30, matrix: '[]' }), 'no client branch, nothing to pass');
  none(staleRun({ ageH: 30, matrix: '' }), 'no matrix');
  none(staleRun({ ageH: 30, noPr: true }), 'no open update PR');
  // Exactly the limit counts as stale.
  assert.equal(staleRun({ ageH: 6 }).creates.length, 2);
});

test('stale PR (leg C1): only the branch that has not passed is raised', { skip: !bash }, () => {
  const r = staleRun({ ageH: 12, labels: ['chain-passed-public'] });
  assert.equal(r.creates.length, 1);
  assert.match(r.creates[0], /SR map mode: public_test_branch needs attention/);
});

test('stale PR (leg C1): at most once per 6 hours, by the marker in the issue body or a comment', { skip: !bash }, () => {
  // Raised 2 hours ago (a comment): nothing now.
  const recent = staleRun({ ageH: 30, matrix: '[{"branch":"public","buildid":"1"}]', issue: 40, commentTimes: [hoursAgo(20), hoursAgo(2)] });
  assert.equal(recent.comments.length, 0, recent.calls.join('\n'));
  assert.equal(recent.creates.length, 0);
  assert.match(recent.out, /Already raised for public/);
  // Raised 7 hours ago: a new comment on the same issue, labelled and assigned again.
  const old = staleRun({ ageH: 30, matrix: '[{"branch":"public","buildid":"1"}]', issue: 40, commentTimes: [hoursAgo(7)] });
  assert.equal(old.comments.length, 1);
  assert.match(old.comments[0], /^issue comment 40 --body-file /);
  assert.deepEqual(old.edits, ['issue edit 40 --add-label pipeline-alert --add-assignee msantoro12']);
  assert.equal(old.creates.length, 0);
  // The issue this step opened (marker in the body) counts as the last raise.
  assert.equal(staleRun({ ageH: 30, matrix: '[{"branch":"public","buildid":"1"}]', issue: 40, issueBodyTime: hoursAgo(1) }).comments.length, 0);
  // An open issue with no marker anywhere (the alert job's own) gets a comment right away.
  const plain = staleRun({ ageH: 30, matrix: '[{"branch":"public","buildid":"1"}]', issue: 40 });
  assert.equal(plain.comments.length, 1);
  // Just inside and just outside the window.
  assert.equal(staleRun({ ageH: 30, matrix: '[{"branch":"public","buildid":"1"}]', issue: 40, commentTimes: [hoursAgo(5.9)] }).comments.length, 0);
  assert.equal(staleRun({ ageH: 30, matrix: '[{"branch":"public","buildid":"1"}]', issue: 40, commentTimes: [hoursAgo(6.1)] }).comments.length, 1);
});

// ---- the plugin fork deploy keys

const FORK_KEYS = ['BETTERCHEATS', 'BETTERDRONE', 'WAILA', 'CODEX', 'COMPASS', 'PRODUCTIONVIEWER', 'RUPTURETIMER', 'WAVEOPTIMISER', 'CAMERACONTROLS'].map((n) => `SR_DEPLOYKEY_${n}`);

test('plugin keys (leg C1): sr-watch passes the nine fork keys by name; the client check declares them (not required); only auto-apply reads them', () => {
  const caller = watch.slice(watch.indexOf('  client-check:\n'));
  for (const k of FORK_KEYS) {
    assert.ok(caller.includes(`\n      ${k}: \${{ secrets.${k} }}\n`) || caller.endsWith(`\n      ${k}: \${{ secrets.${k} }}`), `sr-watch passes ${k} by name`);
    assert.match(call, new RegExp(`\\n {6}${k}:\\n {8}description: [^\\n]+\\n {8}required: false\\n`), `${k} is declared, not required`);
  }
  assert.ok(!/secrets: inherit/.test(watch));
  // The auto-apply job names exactly these nine and no other key.
  const names = [...new Set(job('auto-apply').match(/secrets\.[A-Z_]+/g))].map((x) => x.slice(8)).sort();
  assert.deepEqual(names, [...FORK_KEYS].sort());
  // No other job reads a fork key, and the release key stays out of both.
  for (const n of [...wf.slice(wf.indexOf('\njobs:\n')).matchAll(/\n {2}([a-z][\w-]*):\n/g)].map((m) => m[1]).filter((x) => x !== 'auto-apply')) {
    const body = job(n).replace(/^ *#.*$/gm, '');
    assert.ok(!FORK_KEYS.some((k) => body.includes(k)), `${n} does not read a plugin fork key`);
  }
  assert.ok(!/VMAP_SIGN_KEY:/.test(call) && !/VMAP_SIGN_KEY:/.test(caller));
  // The nine are the ones the auto-apply name check admits.
  const allowed = job('auto-apply').match(/\^\(([A-Za-z|]+)\)\$/)[1].split('|').map((n) => `SR_DEPLOYKEY_${n.toUpperCase()}`).sort();
  assert.deepEqual(allowed, [...FORK_KEYS].sort());
});

// ------------------------------------------------------------ leg C2: expected refusals on the other branch, pinned third-party plugins

const OTHER_STEP_FROM = '          other_branch=public; [ "$BRANCH" = public ] && other_branch=public_test_branch\n';
const otherStep = () => {
  const mm = job('map-mode');
  const start = mm.indexOf(OTHER_STEP_FROM);
  const end = mm.indexOf('\n', mm.indexOf("its rig expects no refusals\"; fi", start)) + 1;
  assert.ok(start > 0 && end > start, 'the step that finds the other branch\'s CL exists');
  return mm.slice(start, end).replace(/^ {10}/gm, '');
};

test('other branch: map-mode finds the other branch\'s CL, hands it to decide, and outputs the rig input before the chain can stop', () => {
  const mm = job('map-mode');
  assert.match(mm, /\n {6}expect_refused_other: \$\{\{ steps\.chain\.outputs\.expect_refused_other \}\}\n/);
  assert.match(mm, /\n {6}OTHER_BUILDID: \$\{\{ inputs\.other_buildid \}\}\n/);
  const find = mm.indexOf(OTHER_STEP_FROM);
  const decideAt = mm.indexOf('node tool/ci/decide.mjs');
  assert.ok(find > 0 && find < decideAt, 'the CL is found before decide runs');
  assert.match(mm.slice(decideAt, decideAt + 500), /"\$\{test_flag\[@\]\}" "\$\{other_flag\[@\]\}"/);
  const out = mm.indexOf('echo "expect_refused_other=$expect_refused_other" >> "$GITHUB_OUTPUT"');
  assert.ok(out > mm.indexOf('echo "expect_refused=$expect_refused"') && out < mm.indexOf('nothing exported or signed'), 'set ahead of the exit that ends a chain whose decision is not M');
  assert.ok(mm.includes("grep -Eq '^[A-Za-z0-9_.-]+( [A-Za-z0-9_.-]+)*$'"));
  // The watcher hands the id over, from the poll; both triggers of the check declare the input.
  assert.match(watch, /\n {6}other_buildid: \$\{\{ matrix\.other_buildid \}\}\n/);
  assert.match(call, /\n {6}other_buildid:\n {8}description: [^\n]*\n {8}type: string\n {8}default: ''\n/);
  assert.match(dispatch, /\n {6}other_buildid:\n {8}description: [^\n]*\n {8}type: string\n {8}default: ''\n/);
});

test('other branch: the CL comes from the watcher\'s build id through the candidate map\'s build rows, else from the recorded state', { skip: !bash }, () => {
  const header = (() => {
    const m = emptyMap('loader', 127004);
    addBuild(m, { cl: 127004, stamp: 1, size: 2, source: 'public 25646882' });
    addBuild(m, { cl: 129402, stamp: 3, size: 4, source: 'steam_build 26271156' });
    return emit(m);
  })();
  const run = ({ branch, otherBuildid = '', state = { apps: { 1631270: { branches: { public: { buildid: '25646882' }, public_test_branch: { buildid: '26271156' } } } } } }) => {
    const dir = mkdtempSync(join(tmpdir(), 'other-cl-'));
    cpSync(here, join(dir, 'tool', 'ci'), { recursive: true, filter: (src) => !/[\\/]fixtures([\\/]|$)/.test(src) });
    mkdirSync(join(dir, 'tool', 'state'), { recursive: true });
    if (state) writeFileSync(join(dir, 'tool', 'state', 'steam.json'), JSON.stringify(state));
    writeFileSync(join(dir, 'version_map.generated.h'), header);
    const script = `set -euo pipefail\nheader=version_map.generated.h\n${otherStep()}\nprintf 'cl=[%s] flag=[%s] id=[%s]\\n' "$other_cl" "\${other_flag[*]}" "$other_buildid"`;
    const r = spawnSync(bash, ['-c', script], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, BRANCH: branch, OTHER_BUILDID: otherBuildid } });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  // A public check, the watcher saw the test branch on build 26271156 (CL-129402).
  const a = run({ branch: 'public', otherBuildid: '26271156' });
  assert.equal(a.status, 0, a.err);
  assert.match(a.out, /cl=\[129402\] flag=\[--other-cl 129402\] id=\[26271156\]/);
  assert.match(a.out, /public_test_branch runs build 26271156 = CL-129402/);
  // A test-branch check without the input: public's recorded build is the id, and its row is CL-127004.
  const b = run({ branch: 'public_test_branch' });
  assert.equal(b.status, 0, b.err);
  assert.match(b.out, /cl=\[127004\] flag=\[--other-cl 127004\] id=\[25646882\]/);
  // The input wins over the recorded state.
  assert.match(run({ branch: 'public', otherBuildid: '25646882' }).out, /cl=\[127004\]/);
  // A build the map has never measured, a non-number and a missing state name no CL: nothing is declared.
  for (const odd of [{ otherBuildid: '999' }, { otherBuildid: 'not-a-build' }, { otherBuildid: '', state: null }, { otherBuildid: '', state: {} }]) {
    const r = run({ branch: 'public', ...odd });
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /cl=\[\] flag=\[\]/, JSON.stringify(odd));
    assert.match(r.out, /::notice title=Other branch unknown::public_test_branch build/);
  }
});

test('other branch: the step turns decision.json into the other rig\'s input, and refuses a name outside the rig\'s grammar', { skip: !bash }, () => {
  const mm = job('map-mode');
  const start = mm.indexOf('          expect_refused_other="$(node -p');
  const end = mm.indexOf('\n', mm.indexOf('Loader refuses on CL::expected refusals on $other_branch')) + 1;
  assert.ok(start > 0 && end > start);
  const snippet = mm.slice(start, end).replace(/^ {10}/gm, '');
  const run = (decision) => {
    const dir = mkdtempSync(join(tmpdir(), 'expect-other-'));
    writeFileSync(join(dir, 'decision.json'), JSON.stringify(decision));
    const r = spawnSync(bash, ['-c', `other_branch=public_test_branch; other_cl=129402\n${snippet}`], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_OUTPUT: join(dir, 'out.txt') } });
    return { status: r.status, out: existsSync(join(dir, 'out.txt')) ? readFileSync(join(dir, 'out.txt'), 'utf8') : '', log: r.stdout };
  };
  const a = run({ decision: 'HOLD', expectRefused: [], expectRefusedOther: ['MiniMap'] });
  assert.deepEqual([a.status, a.out], [0, 'expect_refused_other=MiniMap\n']);
  assert.match(a.log, /expected refusals on public_test_branch \(CL-129402\): MiniMap/);
  assert.equal(run({ decision: 'M', expectRefusedOther: ['Codex', 'MiniMap'] }).out, 'expect_refused_other=Codex MiniMap\n');
  assert.equal(run({ decision: 'M', expectRefusedOther: [] }).out, 'expect_refused_other=\n');
  assert.equal(run({ decision: 'M', expectRefused: ['MiniMap'] }).out, 'expect_refused_other=\n', 'no prediction for the other branch means nothing is declared there');
  const bad = run({ decision: 'M', expectRefusedOther: ['Mini Map; rm'] });
  assert.deepEqual([bad.status, bad.out], [2, '']);
});

test('other branch: a plugin the rule does not predict is never declared, and the rig verdict still fails it', () => {
  // The workflow feeds the rig exactly decide\'s list: nothing is added by hand, nothing is read from a name list.
  const mm = job('map-mode');
  assert.ok(!/expect_refused_other="[A-Za-z]/.test(mm), 'no literal plugin name in the output');
  assert.ok(!/MiniMap/.test(otherStep()), 'the CL step names no plugin');
  // verdict.ps1: a refusal line for a plugin whose expectRefused is false fails plugin_not_refused_<plugin>;
  // ci/test-verdict.ps1 (refused_not_loaded, refused_plugin_unlisted) runs that.
  const verdict = readFileSync(join(here, 'verdict.ps1'), 'utf8');
  assert.match(verdict, /Add-Check "plugin_not_refused_\$\(\$s\.Repo\)"/);
  assert.match(verdict, /Add-Check 'no_unexpected_refusal'/);
});

test('review alert: a pinned plugin with a newer release is a loud line, deduplicated, and it neither fails the chain nor withholds the passed mark', { skip: !bash }, () => {
  const line = (n, t) => `- new ${n} release ${t} waiting for review: the rig still runs the reviewed release; review the new one, then update its Pin in \`ci/plugin-names.json\``;
  const a = alertRun({ decision: goodDecision, env: { BRANCH_RIG_REVIEW: 'MiniMap=v1.3.0', OTHER_RIG_REVIEW: 'MiniMap=v1.3.0' } });
  assert.equal(a.status, 0, a.stderr);
  assert.ok(a.md.includes(line('MiniMap', 'v1.3.0') + '\n'), a.md);
  assert.equal(a.md.split(line('MiniMap', 'v1.3.0')).length, 2, 'once, though both rigs reported it');
  assert.match(a.md, /^@msantoro12 branch `public_test_branch`/);
  // Loud: an alert is raised. Not a failure: the chain still counts as passed.
  assert.deepEqual(a.outputs, { alert: 'true', passed: 'true', ready: 'false' });
  // Two plugins, and tokens outside the grammar are dropped.
  const b = alertRun({ decision: goodDecision, env: { BRANCH_RIG_REVIEW: 'MiniMap=v1.3.0 Other=2.0.0 bad;rm=1 =x', OTHER_RIG_REVIEW: '' } });
  assert.ok(b.md.includes(line('MiniMap', 'v1.3.0')) && b.md.includes(line('Other', '2.0.0')));
  assert.ok(!b.md.includes('bad;rm') && !b.md.includes('=x'), b.md);
  // A real problem next to it still fails the chain (passed false) and keeps its own line.
  const c = alertRun({ decision: goodDecision, env: { BRANCH_RIG_REVIEW: 'MiniMap=v1.3.0', OTHER_RIG_RESULT: 'failure', OTHER_RIG_VERDICT: 'FAIL', OTHER_RIG_REASON: 'plugin_not_refused_MiniMap: FOUND', RIG_GATE_RESULT: 'failure' } });
  assert.deepEqual(c.outputs, { alert: 'true', passed: 'false', ready: 'false' });
  assert.match(c.md, /client rig gate\*\* failed/);
  assert.ok(c.md.includes(line('MiniMap', 'v1.3.0')));
  // With the autopilot off and everything passing, the ready note is still written beside the review line.
  const d = alertRun({ decision: HOLD_ONLY_AUTOPILOT, env: { BRANCH_RIG_REVIEW: 'MiniMap=v1.3.0' } });
  assert.deepEqual(d.outputs, { alert: 'true', passed: 'true', ready: 'true' });
  assert.match(d.ready, /Ready, publish held/);
  // No review output, no line.
  assert.equal(alertRun({ decision: goodDecision, env: { BRANCH_RIG_REVIEW: '', OTHER_RIG_REVIEW: '' } }).outputs.alert, 'false');
});

test('review alert: the alert job reads the review output of both rigs', () => {
  const al = job('alert');
  assert.match(al, /\n {6}BRANCH_RIG_REVIEW: \$\{\{ needs\.rig-branch\.outputs\.review \}\}\n/);
  assert.match(al, /\n {6}OTHER_RIG_REVIEW: \$\{\{ needs\.rig-other\.outputs\.review \}\}\n/);
});

// ------------------------------------------------------------ fix round: the plan reads the pins, the rig's DLLs are read, publish is not wired

// The plan step, run for real under Windows PowerShell with stand-ins for the releases API and git: the
// step's run block beside a tool/ci/plugin-names.json, and the outputs GitHub would collect.
const PLAN_NAMES = JSON.parse(readFileSync(join(here, 'plugin-names.json'), 'utf8'));
const MINIMAP = PLAN_NAMES.find((n) => n.Name === 'MiniMap');
const PIN_TAG = MINIMAP.Pin.Tag;
const PIN_DIGEST = MINIMAP.Pin.Digest;
const MINIMAP_REPO = 'LetMeInside/StarRupture-Plugin-MiniMap';
// latest: the tag the API names as MiniMap's newest release. pinDigest: the digest its assets carry at the pinned tag.
// pinAssets: 'client' (the client DLL beside a zip), 'zip' (no DLL) or 'two' (two client DLLs).
const planRun = ({ plugins, names = PLAN_NAMES, latest = 'v1.3.0', pinDigest = PIN_DIGEST, pinAssets = 'client' }) => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-'));
  mkdirSync(join(dir, 'tool', 'ci'), { recursive: true });
  writeFileSync(join(dir, 'tool', 'ci', 'plugin-names.json'), JSON.stringify(names));
  writeFileSync(join(dir, 'plan.ps1'), '\ufeff' + runOf(job('plugin-plan'), 'Check the plugin list'));
  const out = join(dir, 'github-output.txt');
  const uris = join(dir, 'uris.txt');
  const assets = {
    client: "@(@{ name = 'MiniMap-Client.dll'; state = 'uploaded'; digest = $digest; browser_download_url = \"https://github.com/$owner/$repo/releases/download/$tag/MiniMap-Client.dll\" }, @{ name = 'MiniMap-v1.zip'; state = 'uploaded'; browser_download_url = \"https://github.com/$owner/$repo/releases/download/$tag/MiniMap-v1.zip\" })",
    zip: "@(@{ name = 'MiniMap-v1.zip'; state = 'uploaded'; browser_download_url = \"https://github.com/$owner/$repo/releases/download/$tag/MiniMap-v1.zip\" })",
    two: "@(@{ name = 'Foo-Client.dll'; state = 'uploaded'; digest = $digest; browser_download_url = \"https://github.com/$owner/$repo/releases/download/$tag/MiniMap-Client.dll\" }, @{ name = 'Other-Client.dll'; state = 'uploaded'; digest = $digest; browser_download_url = \"https://github.com/$owner/$repo/releases/download/$tag/Other-Client.dll\" })",
  }[pinAssets];
  writeFileSync(join(dir, 'run.ps1'), '\ufeff' + [
    "$ErrorActionPreference = 'Stop'",
    'function Invoke-RestMethod { param($Headers, $Uri, $TimeoutSec)',
    `  Add-Content -LiteralPath '${uris}' -Value $Uri`,
    "  if ($Uri -notmatch '/repos/([^/]+)/([^/]+)/releases/(latest|tags/(.+))$') { throw \"unexpected $Uri\" }",
    '  $owner = $Matches[1]; $repo = $Matches[2]',
    "  if ($repo -eq 'StarRupture-Plugin-MiniMap') {",
    `    $tag = if ($Matches[4]) { $Matches[4] } else { '${latest}' }`,
    `    $digest = if ($tag -ceq '${PIN_TAG}') { '${pinDigest}' } else { 'sha256:' + ('b' * 64) }`,
    `    $assets = ${assets}`,
    '  } else {',
    "    $tag = 'v2.0.0'",
    "    $assets = @(@{ name = \"$repo-Client.dll\"; state = 'uploaded'; digest = 'sha256:' + ('c' * 64); browser_download_url = \"https://github.com/$owner/$repo/releases/download/$tag/$repo-Client.dll\" })",
    '  }',
    '  [pscustomobject]@{ tag_name = $tag; assets = @($assets | ForEach-Object { [pscustomobject]$_ }) }',
    '}',
    // The tag's commit: one line for the ref asked about.
    'function git { $global:LASTEXITCODE = 0; ("a" * 40) + [char]9 + $args[2] }',
    `$env:GITHUB_OUTPUT = '${out}'`,
    "$env:GH_TOKEN = 'x'; $env:PLUGIN_SDK_REPO = 'AlienXAXS/StarRupture-Plugin-SDK'; $env:GAME_SDK_REPO = 'AlienXAXS/StarRupture-Game-SDK'",
    "$env:EXCLUDE = ''; $env:TEST_AUTOPILOT = 'false'; $env:PUBLISH = 'false'; $env:MAP_MODE = 'true'",
    `$env:PLUGINS = '${plugins}'`,
    `Set-Location '${dir}'`,
    "& (Join-Path (Get-Location) 'plan.ps1')",
  ].join('\n'));
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'run.ps1')], { encoding: 'utf8', windowsHide: true });
  const read = (f) => {
    if (!existsSync(f)) return '';
    const b = readFileSync(f);
    return b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le').slice(1) : b.toString('utf8'); // Windows PowerShell 5.1 writes UTF-16 with >>
  };
  const outputs = Object.fromEntries(read(out).split(/\r?\n/).filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { r, text: `${r.stdout}\n${r.stderr}`, outputs, matrix: outputs.matrix ? JSON.parse(outputs.matrix) : null, uris: read(uris).split(/\r?\n/).filter(Boolean) };
};
const PLAN_PLUGINS = `${MINIMAP_REPO}@latest-release AlienXAXS/StarRupture-Plugin-WAILA@latest-release`;
const planEntry = (p, name) => p.matrix.find((e) => e.name === name);

test('B1 plan: a plugin of another author is the reviewed release (tag and digest), a newer one is only reported', { skip: !powershell }, () => {
  const p = planRun({ plugins: PLAN_PLUGINS });
  assert.equal(p.r.status, 0, p.text);
  const m = planEntry(p, 'MiniMap');
  assert.equal(m.release, PIN_TAG, 'scanned at the Pin, not at the newest release (v1.3.0)');
  assert.equal(m.ref, PIN_TAG);
  assert.equal(m.source, 'release');
  assert.equal(m.error, '');
  assert.equal(m.dll, 'MiniMap-Client.dll', 'the rig\'s pick: the client DLL, not the zip');
  assert.equal(m.asset, `https://github.com/${MINIMAP_REPO}/releases/download/${PIN_TAG}/MiniMap-Client.dll`);
  assert.equal(m.assetSha256, PIN_DIGEST.slice('sha256:'.length), 'the reviewed digest is the one the download is compared with');
  assert.ok(p.uris.includes(`https://api.github.com/repos/${MINIMAP_REPO}/releases/tags/${PIN_TAG}`), p.uris.join('\n'));
  assert.equal(p.outputs.review, 'MiniMap=v1.3.0');
  // The plugins of the trusted owners still follow their latest release.
  const w = planEntry(p, 'WAILA');
  assert.equal(w.release, 'v2.0.0');
  assert.ok(p.uris.includes('https://api.github.com/repos/AlienXAXS/StarRupture-Plugin-WAILA/releases/latest'));
  assert.ok(!p.uris.some((u) => /WAILA\/releases\/tags\//.test(u)));
});

test('B1 plan: no newer release, no review line', { skip: !powershell }, () => {
  const p = planRun({ plugins: PLAN_PLUGINS, latest: PIN_TAG });
  assert.equal(p.r.status, 0, p.text);
  assert.equal(p.outputs.review, '');
  assert.equal(planEntry(p, 'MiniMap').release, PIN_TAG);
});

test('B1 plan: a pinned release whose DLL changed, has no client DLL, or has two never runs, and is never built from source', { skip: !powershell }, () => {
  const changed = planRun({ plugins: PLAN_PLUGINS, pinDigest: 'sha256:' + 'd'.repeat(64) });
  assert.equal(changed.r.status, 0, changed.text);
  const m = planEntry(changed, 'MiniMap');
  assert.match(m.error, /digest/);
  assert.match(m.error, /changed after review/);
  assert.deepEqual([m.dll, m.asset, m.assetSha256], ['', '', ''], 'nothing to scan');
  assert.notEqual(m.source, 'build', 'a reviewed release is never built from source');
  assert.equal(planEntry(changed, 'WAILA').error, '', 'the other plugins are not affected');
  for (const pinAssets of ['zip', 'two']) {
    const p = planRun({ plugins: PLAN_PLUGINS, pinAssets });
    assert.equal(p.r.status, 0, p.text);
    const e = planEntry(p, 'MiniMap');
    assert.match(e.error, /client DLL assets \(exactly one is needed\)/, pinAssets);
    assert.notEqual(e.source, 'build', pinAssets);
    assert.equal(e.asset, '', pinAssets);
  }
});

test('B1 plan: another author\'s plugin without a usable Pin is not fetched at all, and only @latest-release is allowed for it', { skip: !powershell }, () => {
  const strip = (pin) => PLAN_NAMES.map((n) => (n.Name === 'MiniMap' ? (pin === undefined ? Object.fromEntries(Object.entries(n).filter(([k]) => k !== 'Pin')) : { ...n, Pin: pin }) : n));
  for (const [what, names] of [['no Pin', strip(undefined)], ['a bad digest', strip({ Tag: PIN_TAG, Digest: 'sha256:abc' })], ['a bad tag', strip({ Tag: '../x', Digest: PIN_DIGEST })]]) {
    const p = planRun({ plugins: PLAN_PLUGINS, names });
    assert.equal(p.r.status, 0, `${what}: ${p.text}`);
    const m = planEntry(p, 'MiniMap');
    assert.notEqual(m.error, '', what);
    assert.match(m.error, /Pin/, what);
    assert.equal(m.asset, '', what);
    assert.ok(!p.uris.some((u) => u.includes('StarRupture-Plugin-MiniMap')), `${what}: no release of it was read: ${p.uris}`);
  }
  // A branch or a commit of another author's plugin would be built and run next to the login.
  const branch = planRun({ plugins: `${MINIMAP_REPO}@main` });
  assert.notEqual(branch.r.status, 0);
  assert.match(branch.text.replace(/\s+/g, ' '), /allowed only as owner\/repo@latest-release, which is its reviewed release/);
});

test('B1 plan: the job reads the pins from the repository, with a read-only token, and outputs the review list', () => {
  const j = job('plugin-plan');
  assert.match(j, /\n {4}permissions:\n {6}contents: read\n/);
  assert.match(j, /\n {6}review: \$\{\{ steps\.plan\.outputs\.review \}\}\n/);
  const co = stepText(j, 'Check out the plugin pins');
  assert.ok(co.includes('path: tool') && co.includes('sparse-checkout: ci/plugin-names.json') && co.includes('persist-credentials: false'));
  assert.ok(j.indexOf('- name: Check out the plugin pins') < j.indexOf('- name: Check the plugin list'), 'the pins are there before the plan reads them');
  const al = job('alert');
  assert.match(al, /\n {6}PLAN_REVIEW: \$\{\{ needs\.plugin-plan\.outputs\.review \}\}\n/);
  assert.ok(al.includes('[e.PLAN_REVIEW, e.BRANCH_RIG_REVIEW, e.OTHER_RIG_REVIEW]'));
});

test('B1 alert: a newer release the plan saw raises the review line once, though the rigs saw it too', { skip: !bash }, () => {
  const a = alertRun({ decision: goodDecision, env: { PLAN_REVIEW: 'MiniMap=v1.3.0', BRANCH_RIG_REVIEW: 'MiniMap=v1.3.0', OTHER_RIG_REVIEW: 'MiniMap=v1.3.0' } });
  assert.equal(a.status, 0, a.stderr);
  const line = '- new MiniMap release v1.3.0 waiting for review';
  assert.equal(a.md.split(line).length, 2, a.md);
  const b = alertRun({ decision: goodDecision, env: { PLAN_REVIEW: 'MiniMap=v1.3.0' } });
  assert.ok(b.md.includes(line), 'the plan alone is enough');
  assert.deepEqual(b.outputs, { alert: 'true', passed: 'true', ready: 'false' });
});

// ---- S1: the DLLs the rig runs are read by the check job and decide declares the refusals from them

test('S1 check: the rig\'s own set is resolved, fetched through the rig\'s cache and read before the layouts', () => {
  const j = job('check');
  const names = ['Check out the rig\'s set script', 'Resolve the rig\'s plugin set', 'Restore the rig\'s release files', 'Download what the cache lacks', 'Save the rig\'s release files', 'Read the rig\'s plugin DLLs'];
  const at = names.map((n) => j.indexOf(`- name: ${n}\n`));
  assert.ok(at.every((x, i) => x > 0 && (i === 0 || x > at[i - 1])), `in this order: ${at}`);
  assert.ok(at[5] < j.indexOf('# ---- Layouts from the PDBs'), 'before the layout steps');
  // The rig's own script and its names file, from this repository.
  const tool = stepText(j, names[0]);
  assert.ok(tool.includes('ci/client-rig-set.ps1') && tool.includes('ci/plugin-names.json') && tool.includes('persist-credentials: false'));
  const res = stepText(j, names[1]);
  assert.ok(res.includes('-Mode Resolve -Branch $env:BRANCH -Owner $env:MOD_OWNER'));
  assert.ok(res.includes("MOD_OWNER: ${{ vars.MOD_OWNER || 'AlienXAXS' }}"), 'the rig\'s default owner');
  assert.ok(!res.includes('-Tags'), 'the check resolves what the rig would resolve with no tags');
  // The same cache the rig uses: path and key (the cache version depends on the path).
  const rig = readFileSync(join(here, '..', '.github', 'workflows', 'sr-client-rig.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(rig.includes('DOWNLOAD_DIR: D:\\rig-dl') && rig.includes('key: sr-client-rig-dl-${{ steps.res.outputs.key }}'));
  const restore = stepText(j, names[2]);
  assert.ok(restore.includes('path: D:\\rig-dl') && restore.includes('key: sr-client-rig-dl-${{ steps.rigset.outputs.key }}') && restore.includes('restore-keys: sr-client-rig-dl-'));
  assert.ok(stepText(j, names[3]).includes('-Mode Fetch'));
  assert.ok(stepText(j, names[4]).includes('key: sr-client-rig-dl-${{ steps.rigset.outputs.key }}'));
  // Each step may fail without failing the check: the facts are then unknown and nothing is declared.
  for (const n of names.slice(0, 4).concat(names[5])) assert.match(stepText(j, n), /continue-on-error: true/, n);
});

test('S1 check: each DLL is read with the scanner, and one that cannot be read gets an error row, never a guess', () => {
  const run = runOf(job('check'), 'Read the rig\'s plugin DLLs');
  assert.ok(run.includes('$SCANNER_SHA256') || run.includes('$env:SCANNER_SHA256'), 'the scanner is the verified one');
  assert.ok(run.includes('--plugin $file --json'));
  assert.ok(run.includes("$e.asset.digest -and (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() -ne $e.asset.digest"), 'the file is the digest the release gives');
  assert.ok(run.includes("throw \"sr-aobscan could not read its plugin facts (exit $code)\""));
  assert.ok(run.includes('$r.error = $_.Exception.Message'), 'a failed read is an error row');
  assert.ok(run.includes('out\\rig-plugins.json') && !/out\\plugin-/.test(run), 'not named like a scan of the build: map mode reads every out/plugin-*.json');
  assert.ok(job('check').includes('out/rig-plugins.json\n          if-no-files-found: warn'), 'in the artifact map mode downloads');
});

const rigChain = () => {
  const mm = job('map-mode');
  const start = mm.indexOf('          rig_flag=()\n');
  const end = mm.indexOf('echo "rig_tags=$rig_tags" >> "$GITHUB_OUTPUT"\n', start) + 'echo "rig_tags=$rig_tags" >> "$GITHUB_OUTPUT"\n'.length;
  assert.ok(start > 0 && end > start, 'map mode reads the rig facts before decide');
  return mm.slice(start, end).replace(/^ {10}/gm, '');
};

test('S1 map mode: decide gets the rig facts, and both rigs the resolved tags', { skip: !bash }, () => {
  const mm = job('map-mode');
  assert.match(mm, /\n {6}rig_tags: \$\{\{ steps\.chain\.outputs\.rig_tags \}\}\n/);
  assert.ok(mm.indexOf('rig_flag=(--rig-plugins res/rig-plugins.json)') < mm.indexOf('node tool/ci/decide.mjs'), 'before decide');
  assert.match(mm.slice(mm.indexOf('node tool/ci/decide.mjs'), mm.indexOf('node tool/ci/decide.mjs') + 600), /"\$\{other_flag\[@\]\}" "\$\{rig_flag\[@\]\}"/);
  for (const rig of RIG_JOBS) assert.match(job(rig), /\n {6}tags: \$\{\{ needs\.map-mode\.outputs\.rig_tags \}\}\n/, `${rig} runs the releases the check read`);
  const run = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-chain-'));
    for (const [n, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, n)), { recursive: true }); writeFileSync(join(dir, n), c); }
    const r = spawnSync(bash, ['-c', `set -euo pipefail\n${rigChain()}\necho "flag=[\${rig_flag[*]}] tags=[$rig_tags]"`], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_OUTPUT: join(dir, 'out.txt') } });
    return { status: r.status, out: r.stdout, err: r.stderr, outputs: existsSync(join(dir, 'out.txt')) ? readFileSync(join(dir, 'out.txt'), 'utf8') : '' };
  };
  const good = run({ 'res/rig-plugins.json': JSON.stringify({ tags: 'Codex=v1.0.0 MiniMap=v1.2.0', plugins: [] }) });
  assert.equal(good.status, 0, good.err);
  assert.match(good.out, /flag=\[--rig-plugins res\/rig-plugins\.json\] tags=\[Codex=v1\.0\.0 MiniMap=v1\.2\.0\]/);
  assert.equal(good.outputs, 'rig_tags=Codex=v1.0.0 MiniMap=v1.2.0\n');
  // With the BOM Windows PowerShell writes.
  assert.match(run({ 'res/rig-plugins.json': '\ufeff' + JSON.stringify({ tags: 'Codex=v1.0.0', plugins: [] }) }).out, /tags=\[Codex=v1\.0\.0\]/);
  // No file: nothing is declared, nothing is passed to the rigs, and it is said so.
  const none = run({});
  assert.equal(none.status, 0, none.err);
  assert.match(none.out, /flag=\[\] tags=\[\]/);
  assert.match(none.out, /::notice title=Rig plugins unknown::/);
  assert.equal(none.outputs, 'rig_tags=\n');
  // A tags value outside the rig's grammar stops the chain.
  const bad = run({ 'res/rig-plugins.json': JSON.stringify({ tags: 'Codex=v1.0.0; rm -rf', plugins: [] }) });
  assert.equal(bad.status, 2);
  assert.match(bad.out, /::error::the rig's tags are not Name=tag pairs/);
});

// ---- S2: an enabled autopilot publishes nothing on the unattended path, and the summary says so

test('S2 summary: no decision says publishing is not wired any more', () => {
  const mm = job('map-mode');
  const start = mm.indexOf("          node -e '\n            const d = JSON.parse(require(\"fs\").readFileSync(\"decision.json\"");
  const end = mm.indexOf("\n          '\n", start);
  assert.ok(start > 0 && end > start, 'the summary script exists');
  const script = mm.slice(start, end).replace(/^ {10}node -e '\n/, '').replace(/^ {12}/gm, '');
  const run = (decision) => {
    const dir = mkdtempSync(join(tmpdir(), 'summary-'));
    writeFileSync(join(dir, 'decision.json'), JSON.stringify({ plugins: [], reasons: [], notes: [], ...decision }));
    const r = spawnSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, 'summary.md') } });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(join(dir, 'summary.md'), 'utf8');
  };
  const SAID = /not wired/;
  // Autopilot on: the candidate chain decides M and the publish job takes it from there.
  assert.ok(!SAID.test(run({ decision: 'M', cl: 129402, candidate: true, wouldBe: 'M' })));
  // Autopilot off: HOLD, which says the autopilot holds it.
  const held = run({ decision: 'HOLD', cl: 129402, candidate: true, wouldBe: 'M', reasons: [AUTOPILOT_HOLD] });
  assert.ok(!SAID.test(held));
  assert.match(held, /publish held; would be M/);
  assert.ok(!SAID.test(run({ decision: 'M', cl: 129402 })));
  assert.ok(!SAID.test(run({ decision: 'HOLD', cl: 129402, test: true, wouldBe: 'M', reasons: [AUTOPILOT_HOLD] })));
  assert.ok(!/not wired/.test(job('map-mode')));
});

test('S2 docs: the autopilot is the one switch for publishing, and the deploy key setup is step 26', () => {
  for (const f of [join(here, 'MAP-MODE.md'), join(here, '..', '.github', 'sr-pipeline', 'README.md')]) {
    const text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');
    assert.ok(!/publish not wired on the unattended path/.test(text), `${f}: the old "not wired" line is gone`);
    assert.ok(!/needs the publish wiring/.test(text), f);
    assert.match(text, /autopilot (is )?(disabled|off)[^.]*publish(ing)? (is )?(skipped|held)|publish skipped/i, f);
    assert.match(text, /step 26/, f);
  }
});

// ---- N2: "ready, publish held" only for a chain that staged a candidate and ran the rigs

test('N2 alert: a dispatch with publish on that the autopilot held (no candidate) is not "ready"', { skip: !bash }, () => {
  const a = alertRun({ decision: { decision: 'HOLD', cl: 129402, reasons: [AUTOPILOT_HOLD] }, env: { STAGED_EXPECTED: 'false', CANDIDATE_RESULT: 'skipped', RIG_GATE_RESULT: 'skipped' } });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.outputs.ready, 'false');
  assert.equal(a.ready, null, 'no ready note is written');
  // The candidate chain's hold is still ready.
  assert.equal(alertRun({ decision: HOLD_ONLY_AUTOPILOT }).outputs.ready, 'true');
});

// ------------------------------------------------------------ the bases are the released line

const DEFAULT_PLUGINS = ['BetterCheats', 'BetterDrone', 'WAILA', 'Codex', 'Compass', 'ProductionViewer', 'RuptureTimer', 'WaveOptimiser', 'CameraControls']
  .map((n) => `AlienXAXS/StarRupture-Plugin-${n}@main`).join(' ') + ' LetMeInside/StarRupture-Plugin-MiniMap@latest-release';
const defaultOf = (section, input) => section.match(new RegExp(`\\n {6}${input}:\\n(?: {8}description: [^\\n]*\\n)? {8}type: string\\n {8}default: '([^']*)'\\n`))?.[1];

test('bases: both triggers default to AlienX main for the loader, both SDKs and the nine plugins; only the scanner overlay is the fork\'s', () => {
  for (const [name, section] of [['workflow_call', call], ['workflow_dispatch', dispatch]]) {
    assert.equal(defaultOf(section, 'loader_repo'), 'AlienXAXS/StarRupture-ModLoader', name);
    assert.equal(defaultOf(section, 'loader_ref'), 'main', name);
    assert.equal(defaultOf(section, 'plugin_sdk_repo'), 'AlienXAXS/StarRupture-Plugin-SDK', name);
    assert.equal(defaultOf(section, 'plugin_sdk_ref'), 'main', name);
    assert.equal(defaultOf(section, 'game_sdk_repo'), 'AlienXAXS/StarRupture-Game-SDK', name);
    assert.equal(defaultOf(section, 'game_sdk_ref'), 'main', name);
    assert.equal(defaultOf(section, 'plugins'), DEFAULT_PLUGINS, name);
    // The scanner overlay: tools/AobScan only, from the fork's scanner branch.
    assert.equal(defaultOf(section, 'scanner_repo'), 'msantoro12/StarRupture-ModLoader', name);
    assert.equal(defaultOf(section, 'scanner_ref'), 'ci/aobscan', name);
  }
});

test('bases: no workflow, script or doc reads a default base from the stale gss work branches', () => {
  const ci = join(here, '..', '.github');
  const texts = {
    'sr-client-check.yml': wf, 'sr-watch.yml': watch,
    'sr-build-all.yml': readFileSync(join(ci, 'workflows', 'sr-build-all.yml'), 'utf8'),
    'engine-test.yml': readFileSync(join(ci, 'workflows', 'engine-test.yml'), 'utf8'),
    'sr-client-rig.yml': readFileSync(join(ci, 'workflows', 'sr-client-rig.yml'), 'utf8'),
    'README.md': readFileSync(join(ci, 'sr-pipeline', 'README.md'), 'utf8'),
    'MAP-MODE.md': readFileSync(join(here, 'MAP-MODE.md'), 'utf8'),
  };
  // The key sources name the plugins' work branch on purpose (they are built for their keys, not read as a base): the
  // key_sources inputs, the two key source jobs and the "Key sources" section of MAP-MODE.md are the one place it appears.
  const withoutKeySources = (t) => t.replace(/\r\n/g, '\n')
    .replace(/^ {6}key_sources:\n(?: {8}.*\n)+/gm, '')
    .replace(/^ {2}# ---- Key sources:[\s\S]*?(?=^ {2}# ---- Job A:)/m, '')
    .replace(/^## Key sources\n[\s\S]*?(?=^## |(?![\s\S]))/m, '');
  for (const [name, text] of Object.entries(texts)) assert.ok(!/gss\/(loader|plugin|sdk)-work/.test(withoutKeySources(text)), `${name} still names a gss work branch`);
  // The nine default plugins are AlienX's, every one a branch ref, so plugin-plan resolves each to a commit before any plugin code runs.
  const entries = defaultOf(call, 'plugins').split(' ');
  assert.equal(entries.length, 10);
  assert.equal(entries.filter((e) => /^AlienXAXS\/StarRupture-Plugin-[A-Za-z]+@main$/.test(e)).length, 9);
});

test('bases: the scanner repository is on the same allowlist as the loader, and the scanner is the only thing taken from it', () => {
  const j = job('build');
  assert.match(j, /\$env:SCANNER_REPO -notmatch '\^\(msantoro12\|AlienXAXS\)\/StarRupture-ModLoader\$'/);
  assert.ok(j.indexOf('SCANNER_REPO -notmatch') < j.indexOf('- name: Check out the loader'), 'checked before anything is fetched');
  // The loader (patterns, SDK, header) is loader_repo@loader_ref; the scanner overlay is the other checkout, sparse.
  assert.match(j, /repository: \$\{\{ inputs\.loader_repo \}\}\n\s+ref: \$\{\{ inputs\.loader_ref \}\}\n\s+path: loader\n\s+submodules: recursive\n/);
  assert.match(j, /repository: \$\{\{ inputs\.scanner_repo \}\}\n\s+ref: \$\{\{ inputs\.scanner_ref \}\}\n\s+path: scanner-src\n\s+sparse-checkout: tools\/AobScan\n/);
});

test('bases: map-mode reads the header at the commit the scanner was built from, and refuses a different one', { skip: !bash }, () => {
  assert.match(job('build'), /\n {6}loader_sha: \$\{\{ steps\.read\.outputs\.loader_sha \}\}\n/);
  const mm = job('map-mode');
  assert.match(mm, /repository: \$\{\{ inputs\.loader_repo \}\}\n\s+ref: \$\{\{ needs\.build\.outputs\.loader_sha \}\}\n\s+path: loader\n/);
  assert.ok(!/ref: \$\{\{ inputs\.loader_ref \}\}/.test(mm), 'the header is not read at a moving branch');
  // The guard, run for real against a repository whose HEAD is and is not the scanned commit.
  const guard = runOf(mm, 'Write the update into the header').split('\n').filter((l) => /read_sha|SCANNED_LOADER_SHA/.test(l)).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'bases-'));
  const git = (...a) => spawnSync('git', ['-C', join(dir, 'loader'), ...a], { encoding: 'utf8', windowsHide: true });
  mkdirSync(join(dir, 'loader'));
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'a');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const run = (sha) => spawnSync(bash, ['-c', guard + '\necho passed'], { cwd: dir, encoding: 'utf8', env: { ...process.env, SCANNED_LOADER_SHA: sha }, windowsHide: true });
  const ok = run(head);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /passed/);
  for (const other of ['', '0'.repeat(40)]) {
    const bad = run(other);
    assert.equal(bad.status, 2, `exit for ${JSON.stringify(other)}`);
    assert.match(bad.stdout, /::error::the header was read at [0-9a-f]{40}, not at the loader commit the scanner was built from/);
  }
});

test('bases: auto-apply cuts the plugin fork\'s branch from the plugin repository the plan named (AlienX main), and pushes to the fork', () => {
  const j = job('auto-apply');
  // The commit must be the one plugin-plan resolved, on AlienX's repository or the fork's, and the checkout is that repository.
  assert.ok(j.includes('(.repo == "AlienXAXS/StarRupture-Plugin-" + $n or .repo == "msantoro12/StarRupture-Plugin-" + $n)'));
  assert.ok(j.includes('[ "${planned#* }" = "$SHA" ]'));
  assert.ok(j.includes('echo "repo=${planned% *}" >> "$GITHUB_OUTPUT"'));
  assert.match(j, /- name: Check the work item\n\s+id: item\n/);
  assert.match(j, /repository: \$\{\{ steps\.item\.outputs\.repo \}\}\n\s+ref: \$\{\{ matrix\.sha \}\}\n\s+path: plugin\n(?:\s+#.*\n)*\s+fetch-depth: 0\n/);
  assert.ok(!/repository: msantoro12\/StarRupture-Plugin/.test(j), 'the fork is not the base');
  // The push target is still the owner's fork of that plugin, over ssh, with that fork's key.
  assert.ok(j.includes('url="git@github.com:msantoro12/StarRupture-Plugin-$NAME.git"'));
  // The check job only lists a fix for the nine, from either owner's repository.
  assert.ok(job('check').includes("$p.repo -match '^(msantoro12|AlienXAXS)/StarRupture-Plugin-(BetterCheats|BetterDrone|WAILA|Codex|Compass|ProductionViewer|RuptureTimer|WaveOptimiser|CameraControls)$'"));
  // The report looks for the pushed branch on the fork, not on the repository the commit was read from.
  assert.ok(job('report').includes('$fork = "msantoro12/$($Matches[2])"'));
  assert.ok(job('report').includes('git ls-remote "https://github.com/$fork"'));
});

test('native-keys: the layout step accepts every line of ci/native-keys.txt and the size line form, and rejects a malformed one', () => {
  const m = /if \(\$line -cnotmatch '([^']+)' -and \$line -cnotmatch '([^']+)'\) \{ throw "native-keys\.txt: malformed line/.exec(wf);
  assert.ok(m, 'the step checks a member form and a size form');
  const [member, size] = [new RegExp(m[1]), new RegExp(m[2])];
  const ok = (line) => member.test(line) || size.test(line);
  const real = readFileSync(join(here, 'native-keys.txt'), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.ok(real.length > 30);
  for (const line of real) assert.ok(ok(line), line);
  for (const line of ['P FMassQuery', 'P FMassQuery size', 'P FMassQuery optional', 'P FMassQuery size optional']) assert.ok(ok(line), line);
  for (const line of ['P FMassQuery optional size', 'P FMassQuery 0x1', 'P FMassQuery size x', 'justone']) assert.ok(!ok(line), line);
  // The key the step lists for the plugin is the class name alone for a size line.
  assert.equal(size.exec('P FMassQuery size optional')[2], 'FMassQuery');
});

// ---- Carried rows: the carry scan in the check job, assemble and the completeness gate in map mode ----

test('carry: the check job scans the base header against the new exe after the login cache is gone, and reports from the JSON', () => {
  const c = job('check');
  const names = stepsOf(c);
  const at = (n) => names.indexOf(n);
  const CARRY = "Carry the version map's keys onto this build";
  assert.ok(at(CARRY) > 0, 'the carry step exists');
  assert.ok(at('Remove the login cache from the runner') < at('Check out the base header'), 'the header comes after the cleanup');
  assert.ok(at('Check the client build') < at('Check out the base header') && at('Check out the base header') < at(CARRY));
  assert.ok(at(CARRY) < at('Download the plugins'));
  const gate = "steps.scan.outcome == 'success' && steps.cleanup.outcome == 'success' && inputs.map_mode == true";
  assert.equal(c.split(`if: ${gate}\n`).length - 1, 2, 'both steps run only in map mode, after a passing scan');
  // The header is the one the candidate is cut from: the scanned loader commit, data only.
  assert.match(c, /repository: \$\{\{ inputs\.loader_repo \}\}\n\s+ref: \$\{\{ needs\.build\.outputs\.loader_sha \}\}\n\s+path: base-loader\n\s+sparse-checkout: StarRupture-ModLoader-Core\/hooks\/game\/version_map\.generated\.h\n\s+sparse-checkout-cone-mode: false\n\s+persist-credentials: false\n/);
  const run = runOf(c, CARRY);
  assert.ok(run.includes("$scanArgs = @($exe.FullName, '--carry', '--map', $map, '--cl', $cl)"));
  assert.ok(run.includes("$map = 'base-loader\\StarRupture-ModLoader-Core\\hooks\\game\\version_map.generated.h'"));
  assert.ok(run.includes('& $scanner @scanArgs > out\\carry.json 2> out\\carry.txt'));
  assert.ok(run.includes('(Get-FileHash $scanner -Algorithm SHA256).Hash.ToLowerInvariant() -ne $env:SCANNER_SHA256'), 'runs the scanner build-scanner made');
  // A test run measures a CL the header holds rows for: only then are that CL's rows left out.
  assert.ok(run.includes("if ($env:TEST_AUTOPILOT -eq 'true') { $scanArgs += @('--ignore-cl', $cl) }"));
  assert.match(c, /TEST_AUTOPILOT: \$\{\{ inputs\.test_autopilot == true && inputs\.publish != true && contains\(github\.workflow_ref, '\/\.github\/workflows\/sr-client-check\.yml@'\) \}\}/);
  // The scanner exits 0 whenever a report is written: the step reads the report, not the code.
  assert.ok(run.includes("-and $report.kind -eq 'carry'") && run.includes('[string]$report.cl -eq $cl'));
  assert.ok(!/if \(\$code -ne 0\)|\$LASTEXITCODE -ne 0/.test(run), 'the exit code decides nothing');
  assert.match(run, /::error title=Carry scan::sr-aobscan --carry wrote no carry report for CL-\$cl \(exit \$code\)[^"]*"\n\s+exit 1/);
  // It reaches the map-mode job through the check's artifact.
  assert.match(c, /out\/scanner\.json\n\s+out\/carry\.json\n/);
});

// The head and the tail of the map-mode write step, run for real.
const writeStep = () => runOf(job('map-mode'), 'Write the update into the header').split('\n');
const between = (lines, from, to) => lines.slice(lines.findIndex((l) => l.startsWith(from)), lines.findIndex((l) => l.startsWith(to))).join('\n');
const carryDir = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'carrywf-'));
  cpSync(here, join(dir, 'tool', 'ci'), { recursive: true });
  const h = join(dir, 'loader', 'StarRupture-ModLoader-Core', 'hooks', 'game');
  mkdirSync(h, { recursive: true });
  cpSync(join(here, 'fixtures', 'version-map', 'loader.h'), join(h, 'version_map.generated.h'));
  mkdirSync(join(dir, 'res'));
  writeFileSync(join(dir, 'res', 'loader.json'), JSON.stringify({ patterns: [] }));
  writeFileSync(join(dir, 'scans.json'), JSON.stringify({ cl: 130000, build: { stamp: '0x6B000001', size: '0x0A430000', source: 'public 1' }, scans: [{ owner: 'ModLoader', tracked: true, tag: 'v1', rank: 'current', file: 'res/loader.json' }] }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};

test('carry: map mode assembles with the carry report against the unwritten header, and stops loudly without a good one', { skip: !bash }, () => {
  const head = between(writeStep(), 'header=loader/', 'echo "loader_sha=');
  assert.ok(head.includes('assemble scans.json --out observations.json --carry carry.json --base "$header"'));
  const run = (files) => {
    const dir = carryDir(files);
    const r = spawnSync(bash, ['-c', `set -euo pipefail\n${head}\necho assembled`], { cwd: dir, encoding: 'utf8', windowsHide: true });
    return { dir, r };
  };
  const good = run({ 'res/carry.json': JSON.stringify({ kind: 'carry', cl: 130000, summary: {}, rows: [] }) });
  assert.equal(good.r.status, 0, good.r.stdout + good.r.stderr);
  assert.ok(existsSync(join(good.dir, 'observations.json')) && existsSync(join(good.dir, 'carry.json')), 'the report is kept beside the other map-mode files');

  const missing = run({});
  assert.equal(missing.r.status, 2);
  assert.match(missing.r.stdout, /::error::the check job wrote no carry\.json/);
  assert.ok(!existsSync(join(missing.dir, 'observations.json')));

  for (const [what, text, cause] of [
    ['not JSON', '<html>', /::error::map mode could not assemble the input: map-mode: .*carry\.json is not JSON/],
    ['another kind', JSON.stringify({ kind: 'scan', rows: [] }), /::error::map mode could not assemble the input: map-mode: .*not a carry report/],
    ['another CL', JSON.stringify({ kind: 'carry', cl: 1, rows: [] }), /::error::map mode could not assemble the input: map-mode: .*not CL-130000/],
    ['an entry without a kind', JSON.stringify({ kind: 'carry', cl: 130000, rows: [{ key: 'GWorld', fromCL: 128786, result: 'none' }] }), /::error::map mode could not assemble the input: map-mode: .*GWorld: the entry has no kind or fp/],
  ]) {
    const bad = run({ 'res/carry.json': text });
    assert.equal(bad.r.status, 2, what);
    assert.match(bad.r.stdout, cause, what);
    assert.ok(!bad.r.stdout.includes('assembled'), what);
  }
});

test('carry: the completeness gate fails the job with the one-line cause as the error annotation', { skip: !bash }, () => {
  const lines = writeStep();
  // A refusal of the write leaves before the gate runs.
  const refuse = lines.findIndex((l) => l.includes('map mode refused the update'));
  assert.ok(lines[refuse].includes('exit "$status"; fi'));
  const start = lines.findIndex((l) => l.startsWith('cl="$(node -p'));
  assert.ok(refuse < start);
  const tail = lines.slice(start).join('\n');
  assert.ok(tail.includes('complete "$header" --cl "$cl" --report map-mode-report.json'));
  const run = (cl) => {
    const dir = carryDir({ 'observations.json': JSON.stringify({ cl }), 'map-mode-report.json': JSON.stringify({ written: true, absences: [] }) });
    const header = 'loader/StarRupture-ModLoader-Core/hooks/game/version_map.generated.h';
    const r = spawnSync(bash, ['-c', `set -euo pipefail\nheader=${header}\n${tail}`], { cwd: dir, encoding: 'utf8', windowsHide: true });
    return { dir, r };
  };
  // CL-130000 has no row for any of the fixture's five keys: exit 3 and the cause on the annotation.
  const gap = run(130000);
  assert.equal(gap.r.status, 3, gap.r.stdout + gap.r.stderr);
  assert.match(gap.r.stdout, /\n::error::5 of 5 function keys have no CL-130000 row: [^\n]+\n$/);
  assert.match(gap.r.stderr, /missing: GWorld/);
  const report = JSON.parse(readFileSync(join(gap.dir, 'map-mode-report.json'), 'utf8'));
  assert.equal(report.missing.length, 5, 'the result is merged into the write report');
  assert.equal(report.written, true);
  // CL-128786 has a row for each: nothing to say.
  const whole = run(128786);
  assert.equal(whole.r.status, 0, whole.r.stdout + whole.r.stderr);
  assert.ok(!whole.r.stdout.includes('::error'));
  assert.match(whole.r.stdout, /^all 5 function keys with an earlier row have a CL-128786 row/);
  // Any other failure of the check is an annotation too, not a bare exit code.
  assert.ok(tail.includes('echo "::error::the completeness check failed (exit $complete); see the log"'));
});

test('carry: map mode uploads carry.json with its other files, and the gate runs before decide', () => {
  const mm = job('map-mode');
  assert.match(mm, /path: \|\n\s+version_map\.generated\.h\n\s+map-mode-report\.json\n\s+carry\.json\n\s+observations\.json\n/);
  assert.ok(mm.indexOf('assemble scans.json') < mm.indexOf('map-mode.mjs write "$header"') && mm.indexOf('map-mode.mjs write "$header"') < mm.indexOf('map-mode.mjs complete "$header"'));
  assert.ok(mm.indexOf('map-mode.mjs complete "$header"') < mm.indexOf('- name: Decide, export, sign, stage and plan the promotion'), 'the gate runs before decide');
});

// ---- Key sources: fork builds scanned for map keys only ----------------------------------------------------

const KEY_NINE = ['BetterCheats', 'BetterDrone', 'WAILA', 'Codex', 'Compass', 'ProductionViewer', 'RuptureTimer', 'WaveOptimiser', 'CameraControls'];
const KEY_PIN = 'bfd12a08506a494a89d07a139e734c96101abbff';
const HEX40 = 'a'.repeat(40);
// The node program of a step's `node -e '...'` run block.
const nodeScriptOf = (j, name) => runOf(j, name).match(/node -e '\n([\s\S]*)\n'\s*$/)[1];

test('key sources: both triggers default to the nine work branches and the pinned MiniMap key-scan build', () => {
  const want = [...KEY_NINE.map((n) => `msantoro12/StarRupture-Plugin-${n}@gss/plugin-work`), `msantoro12/StarRupture-Plugin-MiniMap@ci/hosted-build:${KEY_PIN}`];
  for (const s of [call, dispatch]) assert.deepEqual(defaultOf(s, 'key_sources').split(' '), want);
});

const keyPlan = (env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'key-plan-'));
  const script = nodeScriptOf(job('key-sources-plan'), 'Check the key source list');
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: dir, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, KEY_SOURCES: defaultOf(call, 'key_sources'), PLUGIN_SDK_REPO: 'AlienXAXS/StarRupture-Plugin-SDK', GAME_SDK_REPO: 'AlienXAXS/StarRupture-Game-SDK', LOADER_REPO: 'msantoro12/StarRupture-ModLoader', ...env },
  });
  const file = join(dir, 'key-sources-unresolved.json');
  return { r, dir, entries: r.status === 0 ? JSON.parse(readFileSync(file, 'utf8')) : null };
};

test('key sources: the default list is accepted, MiniMap gets its key-scan recipe and the others the standard build', () => {
  const { r, entries } = keyPlan();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(entries.length, 10);
  const mini = entries.find((e) => e.name === 'MiniMap');
  assert.deepEqual([mini.recipe, mini.pin, mini.branch, mini.tag, mini.component], ['keyscan', KEY_PIN, 'ci/hosted-build', 'msantoro12/StarRupture-Plugin-MiniMap@ci/hosted-build', 'MiniMap@ci/hosted-build']);
  assert.equal(mini.pluginSdkRepo, 'AlienXAXS/StarRupture-Plugin-SDK');
  assert.equal(mini.pluginSdkRef, 'd66217e63aeb80917656800c42a1a107e3be238d');
  for (const e of entries.filter((x) => x !== mini)) {
    assert.deepEqual([e.recipe, e.branch, e.pin, e.repo], ['standard', 'gss/plugin-work', '', `msantoro12/StarRupture-Plugin-${e.name}`]);
    assert.equal(e.tag, `${e.repo}@gss/plugin-work`);
  }
  assert.equal(keyPlan({ KEY_SOURCES: '' }).entries.length, 0);
});

test('key sources: only msantoro12 plugin repositories, branch names, and a commit pin unless it is one of the nine on the work branch', () => {
  const refused = [
    ['AlienXAXS/StarRupture-Plugin-BetterCheats@gss/plugin-work', /is not msantoro12\/StarRupture-Plugin-/],
    ['LetMeInside/StarRupture-Plugin-MiniMap@latest-release', /is not msantoro12\/StarRupture-Plugin-/],
    ['msantoro12/StarRupture-ModLoader@gss/plugin-work', /is not msantoro12\/StarRupture-Plugin-/],
    ['msantoro12/StarRupture-Plugin-BetterCheats@gss/plugin-work;echo', /is not msantoro12\/StarRupture-Plugin-/],
    ['msantoro12/StarRupture-Plugin-Codex@gss/plugin-work:abc123', /is not msantoro12\/StarRupture-Plugin-/],
    [`msantoro12/StarRupture-Plugin-Codex@gss/plugin-work:${HEX40.toUpperCase()}`, /is not msantoro12\/StarRupture-Plugin-/],
    ['msantoro12/StarRupture-Plugin-Other@gss/plugin-work', /has no commit pin/],
    ['msantoro12/StarRupture-Plugin-BetterCheats@main', /has no commit pin/],
    ['msantoro12/StarRupture-Plugin-BetterCheats@feat/x', /has no commit pin/],
    [`msantoro12/StarRupture-Plugin-Other@refs/pull/12/head:${HEX40}`, /is not a branch name/],
    [`msantoro12/StarRupture-Plugin-Other@pull/12/head:${HEX40}`, /is not a branch name/],
    [`msantoro12/StarRupture-Plugin-Other@a..b:${HEX40}`, /is not a branch name/],
    ['msantoro12/StarRupture-Plugin-Codex@gss/plugin-work msantoro12/StarRupture-Plugin-Codex@gss/plugin-work', /more than once/],
  ];
  for (const [list, why] of refused) {
    const { r } = keyPlan({ KEY_SOURCES: list });
    assert.equal(r.status, 1, `${list} is refused`);
    assert.match(r.stdout, /^::error title=Key sources::/m, list);
    assert.match(r.stdout, why, list);
  }
  // A pinned commit makes any branch of a plugin repository acceptable; the nine need no pin on the work branch.
  const { r, entries } = keyPlan({ KEY_SOURCES: `msantoro12/StarRupture-Plugin-Other@feat/x:${HEX40} msantoro12/StarRupture-Plugin-Codex@gss/plugin-work` });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(entries.map((e) => [e.name, e.pin, e.recipe]), [['Other', HEX40, 'standard'], ['Codex', '', 'standard']]);
  // The repositories the build is made from are on the plugin plan's allowlist too.
  for (const env of [{ PLUGIN_SDK_REPO: 'evil/StarRupture-Plugin-SDK' }, { GAME_SDK_REPO: 'evil/StarRupture-Game-SDK' }, { LOADER_REPO: 'evil/StarRupture-ModLoader' }]) {
    assert.equal(keyPlan(env).r.status, 1, JSON.stringify(env));
  }
});

// git ls-remote and gh api, answered from FAKE ({ heads: { "<repo> <ref>": sha }, compare: { "<repo> <pin>": status } }).
const FAKE_TOOLS = `const cp = require('child_process');
cp.execFileSync = (cmd, args) => {
  const f = JSON.parse(process.env.FAKE);
  if (cmd === 'git' && args[0] === 'ls-remote') {
    const repo = args[1].replace('https://github.com/', '');
    const sha = f.heads[repo + ' ' + args[2]];
    return sha ? sha + '\\t' + args[2] + '\\n' : '';
  }
  if (cmd === 'gh' && args[0] === 'api') {
    const m = /^repos\\/(.+)\\/compare\\/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$/.exec(args[1]);
    const status = m && f.compare[m[1] + ' ' + m[2]];
    if (!status) throw new Error('404 not found');
    return status + '\\n';
  }
  throw new Error('unexpected ' + cmd);
};
`;
const keyResolve = (list, fake) => {
  const { r: planned, dir } = keyPlan({ KEY_SOURCES: list });
  assert.equal(planned.status, 0, planned.stdout);
  const tools = join(dir, 'fake-tools.cjs');
  writeFileSync(tools, FAKE_TOOLS);
  const out = join(dir, 'github-output');
  writeFileSync(out, '');
  const script = nodeScriptOf(job('key-sources-plan'), 'Resolve the branches to commits');
  const r = spawnSync(process.execPath, ['-r', tools, '-e', script], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, FAKE: JSON.stringify(fake), GITHUB_OUTPUT: out } });
  const o = readFileSync(out, 'utf8');
  return { r, any: /^any=(.*)$/m.exec(o)?.[1], matrix: /^matrix=(.*)$/m.exec(o) ? JSON.parse(/^matrix=(.*)$/m.exec(o)[1]) : null };
};

test('key sources: a branch is resolved to its commit before any code runs, and a pin must lie in the branch', () => {
  const head = 'b'.repeat(40);
  const repo = 'msantoro12/StarRupture-Plugin-Codex';
  const unpinned = `${repo}@gss/plugin-work`;
  const fake = { heads: { [`${repo} refs/heads/gss/plugin-work`]: head }, compare: {} };
  let x = keyResolve(unpinned, fake);
  assert.equal(x.r.status, 0, x.r.stdout + x.r.stderr);
  assert.equal(x.any, 'true');
  assert.deepEqual([x.matrix[0].sha, x.matrix[0].name], [head, 'Codex']);
  assert.ok(!('pin' in x.matrix[0]));
  assert.match(x.r.stdout, new RegExp(`^::notice title=Key source Codex::${repo}@gss/plugin-work = ${head}$`, 'm'), 'the resolved commit is logged');
  // A pin is the branch's head, or a commit in its history.
  const pinned = `${repo}@gss/plugin-work:${HEX40}`;
  x = keyResolve(pinned, { ...fake, compare: { [`${repo} ${HEX40}`]: 'ahead' } });
  assert.equal(x.r.status, 0, x.r.stdout);
  assert.equal(x.matrix[0].sha, HEX40);
  assert.match(x.r.stdout, /\(pinned; the branch is at b{40}\)/);
  x = keyResolve(`${repo}@gss/plugin-work:${head}`, fake);
  assert.equal(x.matrix[0].sha, head);
  // A commit only another ref carries (a pull request), or one ahead of the branch, is refused.
  for (const status of ['diverged', 'behind']) {
    x = keyResolve(pinned, { ...fake, compare: { [`${repo} ${HEX40}`]: status } });
    assert.equal(x.r.status, 1, status);
    assert.match(x.r.stdout, /^::error title=Key sources::.*is not in the history of the branch/m);
  }
  x = keyResolve(pinned, fake);
  assert.equal(x.r.status, 1, 'an unknown commit');
  assert.match(x.r.stdout, /cannot compare the pin/);
  x = keyResolve(unpinned, { heads: {}, compare: {} });
  assert.equal(x.r.status, 1);
  assert.match(x.r.stdout, /has no branch gss\/plugin-work/);
  x = keyResolve('', fake);
  assert.deepEqual([x.r.status, x.any, x.matrix], [0, 'false', []]);
});

test('key sources: built in jobs of their own with no secret and no environment, never uploaded as a plugin', () => {
  for (const name of ['key-sources-plan', 'key-sources']) {
    const j = job(name);
    assert.ok(!/secrets\./.test(j), `${name}: no secret`);
    assert.ok(!/^ {4}environment:/m.test(j), `${name}: no environment`);
    assert.match(j, /^ {4}permissions:\n {6}contents: read\n/m, name);
    assert.ok(!/pull_request|issue|github\.event/.test(j), `${name}: nothing from an issue or a pull request`);
    assert.ok(!/persist-credentials: true/.test(j), name);
  }
  const j = job('key-sources');
  assert.match(j, /^ {4}needs: key-sources-plan\n/m);
  assert.match(j, /ref: \$\{\{ matrix\.sha \}\}/, 'the resolved commit, not the branch');
  assert.match(j, /fail-fast: false/);
  // The artifact is keysrc-*, which the check job's `plugin-<branch>-*` pattern does not match, and it holds a DLL for one day.
  const up = j.match(/uses: actions\/upload-artifact@[^\n]*\n {8}with:\n {10}name: ([^\n]+)\n/);
  assert.equal(up[1], 'keysrc-${{ inputs.branch }}-${{ matrix.name }}');
  assert.ok(!up[1].startsWith('plugin-'));
  assert.match(j, /retention-days: 1/);
  assert.ok(!/gh release|softprops|action-gh-release|--clobber/.test(j), 'never published');
  // The MiniMap build: key-scan only, on the SDK the plan names, and refused unless it carries the -keyscan version.
  const mini = runOf(j, 'Build the key-scan build (Client Release)');
  assert.match(mini, /\/p:MiniMapKeyScanOnly=true/);
  assert.match(mini, /\/p:StarRupturePluginSDKRoot=/);
  assert.match(mini, /-keyscan/);
  assert.match(j, /- name: Build the key-scan build[^\n]*\n {8}if: matrix\.recipe == 'keyscan'/);
  assert.match(j, /- name: Build the key source \(Client Release\)\n {8}if: matrix\.recipe == 'standard'/);
});

test('key sources: nothing but the scan, the layout keys and the scans builder reads them', () => {
  // Comments are not read: the one above the key source jobs sits at the end of the job before them in the text.
  const mentions = (text) => /key-?sources?|keysrc/i.test(text.replace(/^ *#.*\r?\n/gm, ''));
  // Every other job and every other step of the check and map-mode jobs: no mention.
  for (const name of ['build', 'plugin-plan', 'plugins', 'publish', 'push-loader', 'candidate-loader', 'rig-branch', 'rig-other', 'rig-gate', 'alert', 'auto-apply', 'report', 'expiry']) {
    assert.ok(!mentions(job(name)), `${name} does not read the key sources`);
  }
  // Comments are not read: the one above a step belongs to the step before it in the text.
  const stepsOf = (j) => j.split(/\n(?= {6}- name: )/).map((t) => [t.match(/^ *- name: (.+)$/m)?.[1], t.replace(/^ *#.*\n/gm, '')]);
  const allowed = {
    check: ['Download the key sources', 'Scan the key sources', 'Read the used layouts from the PDBs', 'Upload the result'],
    'map-mode': ['Require the key sources', 'Write the update into the header'],
  };
  for (const [name, ok] of Object.entries(allowed)) {
    const j = job(name);
    const named = stepsOf(j).filter(([, t]) => mentions(t)).map(([n]) => n);
    // `needs` and the comment above the job are not steps; only steps are compared here.
    for (const n of named) assert.ok(ok.includes(n) || n === undefined, `${name}: step "${n}" reads the key sources`);
  }
  // The steps that decide, stage, gate the rig, grade the plugins or build the rig's set name no key source.
  for (const [j, n] of [['check', "Check the plugins' patterns"], ['check', "Resolve the rig's plugin set"], ['check', "Read the rig's plugin DLLs"], ['check', 'Write the result'], ['map-mode', 'Decide, export, sign, stage and plan the promotion']]) {
    const text = stepsOf(job(j)).find(([x]) => x === n)?.[1];
    assert.ok(text !== undefined, `${j}: step "${n}" exists`);
    assert.ok(!mentions(text), `${j}: "${n}" does not read the key sources`);
  }
  // The scans reach map mode only through the one artifact, under names no plugin glob matches.
  const up = job('check').match(/name: client-check-\$\{\{ inputs\.branch \}\}\n {10}path: \|\n((?: {12}.*\n)+)/)[1];
  assert.match(up, /^ {12}out\/keysrc\.json$/m);
  assert.match(up, /^ {12}out\/keysrc-\*\.json$/m);
  assert.ok(!/plugin-\*/.test('out/keysrc.json out/keysrc-*.json'), 'not a plugin-* scan');
  // The released plugins and the key sources are separate lists: the plan's matrix feeds the scan, plugins.json is the plugin check's alone.
  assert.ok(!/needs\.key-sources/.test(runOf(job('check'), "Check the plugins' patterns")));
  const scan = stepsOf(job('check')).find(([x]) => x === 'Scan the key sources')[1];
  assert.match(scan, /out\\keysrc\.json/);
  assert.ok(!/plugins\.json|rig-plugins|rule3/.test(scan), 'it writes no plugins.json, rig set or rule 3 result');
  const lay = runOf(job('check'), 'Read the used layouts from the PDBs');
  assert.match(lay, /component = \$s\.component; stem = \$stem/, 'a component of its own');
  assert.match(lay, /\$components\.Add\('ModLoader'\)/);
  assert.ok(!/\$components\.Add\(\$s\./.test(lay) && !/\$components\.Add\(\$k/.test(lay), 'never in the components layout.json and its gate read');
});

test('key sources: a failing one stops map mode with its cause, a clean list does not', () => {
  const gate = runOf(job('map-mode'), 'Require the key sources');
  assert.match(job('map-mode'), /^ {4}needs: \[build, plugins, check, key-sources-plan, key-sources, record-public\]$/m);
  const run = (env, keysrc) => {
    const dir = mkdtempSync(join(tmpdir(), 'key-gate-'));
    mkdirSync(join(dir, 'res'));
    if (keysrc) writeFileSync(join(dir, 'res', 'keysrc.json'), JSON.stringify({ sources: keysrc }));
    return spawnSync(bash, ['-c', gate], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, KEY_PLAN: 'success', KEY_ANY: 'true', KEY_BUILD: 'success', ...env } });
  };
  const good = { name: 'Codex', tag: 'msantoro12/StarRupture-Plugin-Codex@gss/plugin-work', sha: HEX40, status: 'ok', layout: 'ok', keys: 7 };
  let r = run({}, [good]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Codex@gss\/plugin-work a{40}: 7 keyed requests/);
  r = run({ KEY_ANY: 'false', KEY_BUILD: 'skipped' }, null);
  assert.equal(r.status, 0, 'no key sources listed');
  const stops = [
    [{ KEY_PLAN: 'failure' }, [good], /key source list was refused/],
    [{ KEY_BUILD: 'failure' }, [good], /a key source did not build/],
    [{}, null, /recorded no key source result/],
    [{}, [{ ...good, status: 'failed', error: 'it did not build (no artifact)' }], /Key source msantoro12\/StarRupture-Plugin-Codex@gss\/plugin-work::it did not build/],
    [{}, [{ ...good, layout: 'failed: gen failed' }], /its keys were not read: failed: gen failed/],
    [{}, [{ ...good, layout: undefined }], /layout step stopped before the key sources/],
  ];
  for (const [env, keysrc, why] of stops) {
    r = run(env, keysrc);
    assert.equal(r.status, 2, `${JSON.stringify(env)} ${why}`);
    assert.match(r.stdout, /^::error title=Key source/m);
    assert.match(r.stdout, why);
  }
  // It runs before anything is written into the header.
  const m = job('map-mode');
  assert.ok(m.indexOf('- name: Require the key sources') < m.indexOf('- name: Write the update into the header'));
});

test('key sources: the scans builder adds the sources after the released scans, tracked, tagged with their repo and branch', async () => {
  const { assemble, readObservations, planRows } = await import('./map-mode.mjs');
  const script = wf.match(/node -e '\n(\s+const fs = require\("fs"\);\n[\s\S]*?)\n\s+' "\$buildid"/)[1];
  const dir = mkdtempSync(join(tmpdir(), 'key-scans-'));
  mkdirSync(join(dir, 'res'));
  mkdirSync(join(dir, 'tool', 'ci'), { recursive: true });
  copyFileSync(join(here, 'plugin-names.json'), join(dir, 'tool', 'ci', 'plugin-names.json'));
  const row = (key, rva, extra = {}) => ({ key, kind: 'infunction', result: 'OK', rva: `0x${rva.toString(16)}`, pattern: '48 8B 05 ?? ?? ?? ??', fp: '0x2D1AC6AE', resultOffset: 0, ...extra });
  const put = (f, doc) => writeFileSync(join(dir, 'res', f), JSON.stringify(doc));
  put('scanner.json', { exe: { cl: 129402, imageStamp: '0x6B000001', imageSize: '0x0A430000' }, patterns: [] });
  // Waila is released (plugins names WAILA) and a key source: both ask for Shared/Hook (one address), the key source also for Only/Fork.
  put('plugin-Waila.json', { plugin: { name: 'Waila' }, patterns: [row('Waila/Shared', 0x1000)] });
  put('keysrc-WAILA.json', { plugin: { name: 'Waila' }, patterns: [row('Waila/Shared', 0x1000), row('Waila/Only', 0x2000, { fp: '0x0BADF00D' })] });
  // MiniMap: not released here (nothing scanned), only the key-scan build; Codex: a source that failed, so it left no scan.
  put('keysrc-MiniMap.json', { plugin: { name: 'MiniMap' }, patterns: [row('MiniMap/Free', 0x3000, { fp: '0x11111111' })] });
  const tag = (n, b) => `msantoro12/StarRupture-Plugin-${n}@${b}`;
  put('keysrc.json', { sources: [
    { name: 'WAILA', tag: tag('WAILA', 'gss/plugin-work'), sha: 'a'.repeat(40), status: 'ok' },
    { name: 'MiniMap', tag: tag('MiniMap', 'ci/hosted-build'), sha: 'b'.repeat(40), status: 'ok' },
    { name: 'Codex', tag: tag('Codex', 'gss/plugin-work'), status: 'failed', error: 'x' },
    { name: '../evil', tag: 'x', status: 'ok' },
  ] });
  const r = spawnSync(process.execPath, ['-e', script, '129402'], { cwd: dir, env: { ...process.env, PLUGINS: 'AlienXAXS/StarRupture-Plugin-WAILA@main', LOADER_REF: 'v1' }, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const scans = JSON.parse(readFileSync(join(dir, 'scans.json'), 'utf8')).scans;
  assert.deepEqual(scans.map((s) => [s.owner, s.tracked, s.tag, s.rank, s.file]), [
    ['ModLoader', true, 'v1', 'current', 'res/scanner.json'],
    ['Waila', true, 'current', 'current', 'res/plugin-Waila.json'],
    ['Waila', true, tag('WAILA', 'gss/plugin-work'), 'current', 'res/keysrc-WAILA.json'],
    ['MiniMap', true, tag('MiniMap', 'ci/hosted-build'), 'current', 'res/keysrc-MiniMap.json'],
  ]);
  // Only the key sources are marked, so map mode can tell a key that must not gate from a plan plugin's.
  assert.deepEqual(scans.map((s) => s.keySource), [undefined, undefined, true, true]);
  assert.deepEqual(scans.map((s) => s.commit), [undefined, undefined, 'a'.repeat(40), 'b'.repeat(40)]);
  // One component per plugin name: a key both ask for is one row, supplied by the released scan; a key only the source asks for gets a row too.
  const input = assemble(JSON.parse(readFileSync(join(dir, 'scans.json'), 'utf8')), dir);
  assert.deepEqual(input.components.map((c) => [c.owner, c.releases.map((x) => x.tag)]), [
    ['ModLoader', ['v1']], ['Waila', ['current', tag('WAILA', 'gss/plugin-work')]], ['MiniMap', [tag('MiniMap', 'ci/hosted-build')]],
  ]);
  const plan = planRows(readObservations(input).rows, { cl: 129402 });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.ops.map((o) => [o.key, o.from]).sort(), [
    ['MiniMap/Free', `MiniMap ${tag('MiniMap', 'ci/hosted-build')}`],
    ['Waila/Only', `Waila ${tag('WAILA', 'gss/plugin-work')}`],
    ['Waila/Shared', 'Waila current'],
  ]);
  // Without the file nothing changes: the scans are the released ones.
  rmSync(join(dir, 'res', 'keysrc.json'));
  assert.equal(spawnSync(process.execPath, ['-e', script, '129402'], { cwd: dir, env: { ...process.env, PLUGINS: 'AlienXAXS/StarRupture-Plugin-WAILA@main', LOADER_REF: 'v1' }, encoding: 'utf8', windowsHide: true }).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'scans.json'), 'utf8')).scans.map((s) => s.owner), ['ModLoader', 'Waila']);
});

test('key sources: the alert job lists the alert lines of the map writers, loudly, without failing the chain', { skip: !bash }, () => {
  const line1 = 'key source msantoro12/StarRupture-Plugin-WaveOptimiser@gss/plugin-work (c0ffee012345, checked the branch, not an installed DLL): asks for UCrWaveSubsystem::AddEntitiesToWave at 0x76B59B0, which the released map names UCrMassEnviroWaveSubsystem::AddEntitiesToWave; that branch is stale';
  const line2 = 'key source msantoro12/StarRupture-Plugin-MiniMap@ci/hosted-build (c0ffee012345, checked the branch, not an installed DLL): compiles the size of ACrGameStateBase, which changed on CL-129402; that build needs SR_SIZE_CHECK or live';
  const NL = String.fromCharCode(10);
  const a = alertRun({ decision: goodDecision, extra: { 'chain/map-mode-report.json': { alerts: [line1, 7] }, 'chain/field-rows.json': { alerts: [line2] } } });
  assert.equal(a.status, 0, a.stderr);
  assert.ok(a.md.includes(`- ${line1}${NL}`) && a.md.includes(`- ${line2}${NL}`), a.md);
  // Loud, not a failure: the chain still counts as passed.
  assert.deepEqual(a.outputs, { alert: 'true', passed: 'true', ready: 'false' });
  // No alerts, no line; a report without the field is fine.
  assert.equal(alertRun({ decision: goodDecision, extra: { 'chain/field-rows.json': { rows: [] } } }).outputs.alert, 'false');
});

test('key sources: no program in a node -e block closes its single quotes early (an apostrophe in a comment would)', () => {
  let n = 0;
  for (let at = wf.indexOf("node -e '"); at >= 0; at = wf.indexOf("node -e '", at + 1)) {
    const end = wf.indexOf("'", at + "node -e '".length);
    // The program ends at a quote that closes the argument: end of line, or the shell arguments that follow it.
    assert.match(wf.slice(end + 1, end + 40), /^(?: "\$\w+")*[ \t]*\n/, `the node -e program at offset ${at} ends early, at: ${wf.slice(end - 40, end + 20)}`);
    n++;
  }
  assert.ok(n >= 8, `${n} programs checked`);
});

// ------------------------------------------------------------ publish bundle B1b: unattended publish, public only, one seq

const apPath = join(here, '..', 'state', 'autopilot.json');
const sh = (cmd, cwd, env = {}) => spawnSync(bash, ['-c', cmd], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });

test('publish gates (unattended): the public run of sr-watch publishes on its own only when every gate holds, and the order of the gates is stated', () => {
  const pub = job('publish');
  const ifLine = jobIf('publish');
  const run = (mut = () => {}, inputs = { ...okInputs(), publish: false }, github = undefined) => {
    const n = okNeeds();
    mut(n);
    return evalExpr(ifLine, { needs: n, inputs, github });
  };
  assert.equal(run(), true, 'sr-watch, public, M, publishable, both rigs PASS: publishes with no input');
  // Each gate alone stops it.
  assert.equal(run(() => {}, { ...okInputs(), publish: false, branch: 'public_test_branch' }), false, 'a test-branch run never publishes');
  assert.equal(run((n) => { n['map-mode'].outputs.decision = 'HOLD'; n['map-mode'].outputs.publishable = 'false'; n['map-mode'].outputs.test = 'true'; }), false, 'autopilot off: HOLD, a held candidate counts as a test, publish skipped');
  assert.equal(run((n) => { n['map-mode'].outputs.decision = 'HOLD'; }), false, 'a HOLD alone');
  assert.equal(run((n) => { n['map-mode'].outputs.publishable = 'false'; }), false, 'promote says not publishable');
  assert.equal(run((n) => { n['rig-other'].outputs.verdict = 'FAIL'; }), false, 'a rig fail');
  assert.equal(run(() => {}, { ...okInputs(), publish: false, test_autopilot: true }), false, 'a test_autopilot run');
  // The release key sits in the vmap-sign environment of this job only, and the job holds no other secret.
  assert.match(pub, /\n {4}environment: vmap-sign\n/);
  assert.deepEqual([...new Set([...pub.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))], ['VMAP_SIGN_KEY']);
  const holders = [...wf.matchAll(/\n {2}([a-z][\w-]*):\n/g)].map((m) => m[1]).filter((n) => /secrets\.VMAP_SIGN_KEY(?!_TEST)/.test(job(n)));
  assert.deepEqual(holders, ['publish']);
  // sr-watch still passes no release key.
  assert.ok(!/VMAP_SIGN_KEY:/.test(watch.slice(watch.indexOf('  client-check:\n'))), 'sr-watch passes the TEST key only');
  // The gates are written down in the order they apply, and the old "not wired" wording is gone.
  const head = wf.slice(wf.indexOf('# ---- Publish: the feed signed with the release key'), wf.indexOf('\n  publish:\n'));
  const at = ['run is for public', 'sr-watch runs, or a dispatch with the publish input on', 'decide chose M', 'publishable', 'both client rigs'].map((t) => head.indexOf(t));
  assert.ok(at.every((i) => i > 0) && at.every((v, i) => i === 0 || v > at[i - 1]), `gate order in the comment: ${at}`);
  assert.ok(!/publish not wired/.test(wf));
  // The switch is state/autopilot.json, and it stays off in this change.
  assert.equal(JSON.parse(readFileSync(apPath, 'utf8')).enabled, false);
});

test('publish gates: the autopilot off means a HOLD and a skipped publish, the chain still stages (decide --candidate)', () => {
  const ap = JSON.parse(readFileSync(apPath, 'utf8'));
  assert.equal(ap.enabled, false);
  // decide reads the file the job reads, and a disabled autopilot is a HOLD whose only reason is the autopilot.
  const mm = job('map-mode');
  assert.ok(mm.includes('--autopilot tool/state/autopilot.json'));
  assert.ok(mm.includes('echo "decision=$decision" >> "$GITHUB_OUTPUT"'));
  const n = okNeeds();
  n['map-mode'].outputs.decision = 'HOLD';
  assert.equal(evalExpr(jobIf('publish'), { needs: n, inputs: { ...okInputs(), publish: false } }), false);
  // The held chain's plan is a test plan, so it is never publishable whatever else is true.
  assert.ok(mm.includes('promote_flag=(--test-autopilot)'));
});

test('record-public: only a public run, not a test run, appends; its if and its script both say so', () => {
  const j = job('record-public');
  assert.match(j, /\n {4}needs: \[check\]\n/);
  assert.match(j, /\n {4}permissions:\n {6}contents: write\n/);
  const ifRecord = jobIf('record-public');
  const run = (inputs, check = 'success') => evalExpr(ifRecord, { needs: { check: { result: check, outputs: {} } }, inputs });
  assert.equal(run({ map_mode: true, branch: 'public' }), true);
  assert.equal(run({ map_mode: true, branch: 'public_test_branch' }), false, 'never from a test-branch run');
  assert.equal(run({ map_mode: true, branch: 'public', test_autopilot: true }), false, 'never from a test run');
  assert.equal(run({ map_mode: false, branch: 'public' }), false);
  assert.equal(run({ map_mode: true, branch: 'public' }, 'failure'), false);
  assert.equal(run({ map_mode: true, branch: 'public' }, 'skipped'), false);
  // It commits that one file and nothing else, to main, never by force.
  const script = runOf(j, 'Add the build to the list');
  assert.ok(script.includes('[ "$BRANCH" = public ] || { echo "::error::only a run for public records a public build"; exit 2; }'));
  assert.deepEqual([...script.matchAll(/git add ([^\n]+)/g)].map((m) => m[1]), ['state/public-builds.json']);
  assert.deepEqual([...script.matchAll(/git push ([^\n;]+)/g)].map((m) => m[1].replace(/\s*then.*/, '')), ['origin HEAD:main']);
  assert.ok(!/--force|-f |\+HEAD|git commit [^\n]*-a/.test(script));
  assert.match(script, /git commit --quiet -m "Record public build \$buildid \(CL-\$cl\)"/);
  assert.ok(!/Co-Authored-By/i.test(script));
  // Map mode waits for it, and does not run when it failed: fail closed.
  const mmIf = jobIf('map-mode');
  const mmRun = (record) => evalExpr(mmIf, { needs: { check: { result: 'success', outputs: {} }, 'record-public': { result: record, outputs: {} } }, inputs: { map_mode: true } });
  assert.equal(mmRun('success'), true);
  assert.equal(mmRun('skipped'), true, 'a test-branch run skips the record job and still maps');
  assert.equal(mmRun('failure'), false);
  assert.equal(mmRun('cancelled'), false);
  // A list that moved is read from main after the record job, not from the commit the run started on.
  assert.match(job('map-mode'), /- name: Check out the public builds list\n {8}uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}ref: main\n {10}path: pub\n/);
  // The alert names it.
  assert.ok(job('alert').includes('record-public'));
  assert.ok(job('alert').includes('["record the public build", "record the public build", e.RECORD_RESULT]'));
});

// A local "origin" with a main branch that holds the tool and the list, and a clone to run the record step in.
const recordFixture = ({ list = readFileSync(join(here, '..', 'state', 'public-builds.json'), 'utf8'), result = { checks: { exe: { cl: 129999 } }, download: { buildid: '26500000' } }, reject = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'record-public-'));
  const git = (cwd, ...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(seed, 'init', '--quiet', '--initial-branch=main');
  mkdirSync(join(seed, 'ci'));
  mkdirSync(join(seed, 'state'));
  for (const f of ['public-builds.mjs', 'layout-diff.mjs']) copyFileSync(join(here, f), join(seed, 'ci', f));
  writeFileSync(join(seed, 'state', 'public-builds.json'), list);
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '--quiet', 'origin', 'main');
  if (reject) {
    writeFileSync(join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "refused by the test" >&2\nexit 1\n');
    chmodSync(join(origin, 'hooks', 'pre-receive'), 0o755);
  }
  const work = join(root, 'work');
  git(root, 'clone', '--quiet', origin, work);
  mkdirSync(join(work, 'res'));
  if (result) writeFileSync(join(work, 'res', 'result.json'), JSON.stringify(result));
  const out = join(root, 'out.txt');
  const summary = join(root, 'summary.md');
  writeFileSync(out, '');
  writeFileSync(summary, '');
  return { work, origin, out, summary, git };
};
const runRecord = (fx, branch = 'public') => {
  const script = runOf(job('record-public'), 'Add the build to the list');
  return sh(script, fx.work, { BRANCH: branch, GITHUB_OUTPUT: fx.out, GITHUB_STEP_SUMMARY: fx.summary });
};

test('record-public script: a new public build is appended on main, one file, plain message; the same build twice adds nothing', { skip: !bash }, () => {
  const fx = recordFixture();
  const before = fx.git(fx.origin, 'rev-list', '--count', 'main');
  const r = runRecord(fx);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(fx.out, 'utf8'), /appended=true/);
  assert.equal(Number(fx.git(fx.origin, 'rev-list', '--count', 'main')), Number(before) + 1);
  assert.equal(fx.git(fx.origin, 'log', '-1', '--format=%s', 'main'), 'Record public build 26500000 (CL-129999)');
  assert.equal(fx.git(fx.origin, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main'), 'state/public-builds.json', 'one file');
  assert.ok(!/Co-Authored-By/i.test(fx.git(fx.origin, 'log', '-1', '--format=%B', 'main')));
  const list = parsePublicBuilds(fx.git(fx.origin, 'show', 'main:state/public-builds.json'));
  assert.equal(list.builds.at(-1).cl, 129999);
  assert.equal(list.builds.at(-1).buildid, '26500000');
  assert.match(list.builds.at(-1).firstSeen, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(readFileSync(fx.summary, 'utf8'), /recorded CL-129999/);
  // The same build again: nothing new on main.
  writeFileSync(fx.out, '');
  const again = runRecord(fx);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(readFileSync(fx.out, 'utf8'), /appended=false/);
  assert.equal(Number(fx.git(fx.origin, 'rev-list', '--count', 'main')), Number(before) + 1);
});

test('record-public script: a test-branch run, a run with no exe, a damaged list and a refused push never leave a changed list (fail closed)', { skip: !bash }, () => {
  // A test-branch run: refused, nothing pushed.
  let fx = recordFixture();
  let r = runRecord(fx, 'public_test_branch');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /only a run for public records a public build/);
  assert.equal(fx.git(fx.origin, 'rev-list', '--count', 'main'), '1');
  // No exe measured: nothing to record, and no failure here (map mode stops on the missing scan itself).
  fx = recordFixture({ result: { status: 'skipped' } });
  r = runRecord(fx);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(fx.out, 'utf8'), /appended=false/);
  assert.equal(fx.git(fx.origin, 'rev-list', '--count', 'main'), '1');
  // A list that is off the format: the step fails and pushes nothing.
  fx = recordFixture({ list: '{"not":"a list"}' });
  r = runRecord(fx);
  assert.notEqual(r.status, 0);
  assert.equal(fx.git(fx.origin, 'rev-list', '--count', 'main'), '1');
  // Main refuses the push: three tries, then the step fails.
  fx = recordFixture({ reject: true });
  r = runRecord(fx);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /could not push the list to main after 3 tries/);
  assert.equal(fx.git(fx.origin, 'rev-list', '--count', 'main'), '1');
});

test('one seq: next-seq runs once, in the chain, and the TEST signature, the promote plan and the check of the TEST feed all get it', () => {
  const mm = job('map-mode');
  assert.equal(mm.match(/vmap-sign\.mjs next-seq/g)?.length, 1);
  assert.ok(mm.includes('seq="$(node tool/ci/vmap-sign.mjs next-seq --last-seq "$last_seq")"'));
  assert.ok(mm.includes('echo "seq=$seq" >> "$GITHUB_OUTPUT"'));
  assert.match(mm, /\n {6}seq: \$\{\{ steps\.chain\.outputs\.seq \}\}\n/);
  assert.ok(mm.includes('vmap-sign.mjs sign feed.txt --out feed.test-signed.txt --key-id k1 --key-env VMAP_SIGN_KEY_TEST --last-seq "$last_seq" --seq "$seq"'));
  assert.ok(mm.includes('vmap-sign.mjs verify feed.test-signed.txt --allow-test-key --last-seq "$last_seq" --expect-seq "$seq"'));
  assert.ok(mm.includes('--history history.json --last-seq "$last_seq" --seq "$seq" --now'));
  assert.ok(mm.indexOf('next-seq') < mm.indexOf('decide.mjs --repo'), 'computed before anything uses it');
  // Nothing recomputes it: no other next-seq, and no sign or plan without --seq anywhere in the file.
  assert.equal(wf.match(/vmap-sign\.mjs next-seq/g)?.length, 1);
  const signs = [...wf.matchAll(/node tool\/ci\/vmap-sign\.mjs sign [^\n]*/g)];
  const plans = [...wf.matchAll(/node tool\/ci\/promote\.mjs plan [^\n]*\n[^\n]*/g)];
  assert.equal(signs.length, 2, 'the TEST signature and the release signature');
  assert.equal(plans.length, 1);
  for (const m of signs) assert.ok(/--seq "\$(seq|CHAIN_SEQ)"/.test(m[0]), m[0]);
  for (const m of plans) assert.ok(/--seq "\$seq"/.test(m[0]), m[0]);
  // The publish job carries the chain's number, never a new one, into the signature, the check and the history.
  const pub = job('publish');
  assert.match(pub, /CHAIN_SEQ: \$\{\{ needs\.map-mode\.outputs\.seq \}\}/);
  assert.ok(pub.includes('--key-id k2 --last-seq "$last_seq" --seq "$CHAIN_SEQ"'));
  assert.ok(pub.includes('verify version-map-client.v1.txt --last-seq "$last_seq" --expect-seq "$CHAIN_SEQ"'));
  assert.ok(pub.includes('seq: Number(process.env.CHAIN_SEQ)'));
  assert.ok(pub.includes('verify published/version-map-client.v1.txt --expect-seq "$CHAIN_SEQ"'));
  assert.ok(!/next-seq/.test(pub));
});

test('public only: every export-feed in the workflow carries --public-builds, and the chain reports the CLs it left out', () => {
  const exports = [...wf.matchAll(/node tool\/ci\/version-map\.mjs export-feed [^\n]*/g)].map((m) => m[0]);
  assert.equal(exports.length, 2, 'the chain exports the staged feed; the publish job cuts it again to compare');
  for (const e of exports) assert.match(e, /--public-builds pub\/state\/public-builds\.json/, e);
  const mm = job('map-mode');
  assert.ok(mm.indexOf('export-feed') < mm.indexOf('--key-id k1'), 'exported public-only before it is signed');
  // The export step: a refusal stops the chain.
  assert.ok(mm.includes('[ "$export_status" -eq 0 ] || { echo "::error::the public-only feed export was refused'));
  // Public's own CL must be in the feed.
  assert.ok(mm.includes('is the build public runs, but it is not on the public builds list'));
});

test('public only: the step summary names each CL the export left out', { skip: !bash }, () => {
  const mm = job('map-mode');
  const start = mm.indexOf('          node -e \'\n            const fs = require("fs");\n            const left =');
  const end = mm.indexOf("\n          '\n", start);
  assert.ok(start > 0 && end > start);
  const script = mm.slice(start, end).replace(/^ {10}node -e '\n/, '').replace(/^ {12}/gm, '');
  const run = (err) => {
    const dir = mkdtempSync(join(tmpdir(), 'export-summary-'));
    writeFileSync(join(dir, 'export.err'), err);
    const r = spawnSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, 's.md') } });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(join(dir, 's.md'), 'utf8');
  };
  const left = run('left out CL-129402, not on public: 4 rows (1 build, 1 function, 2 field)\nleft out CL-128786, not on public: 2 rows (1 build, 1 function)\npublic export: 2 CLs left out\n');
  assert.match(left, /Feed export: public CLs only/);
  assert.match(left, /- left out CL-129402, not on public: 4 rows/);
  assert.match(left, /- left out CL-128786, not on public: 2 rows/);
  assert.ok(!/every CL in the header is on public/.test(left));
  assert.match(run('public export: 0 CLs left out\n'), /no CL left out/);
});

// The publish job's steps, run against stubs: gh, the signer and the exporter write what they are asked and log their arguments.
const publishFixture = ({ liveSeq = 100, chainSeq = '200', planSeq = null, exportText = 'FEED\n', feedText = 'FEED\n', publishedKey = 'k2', publishedSeq = undefined, release = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-job-'));
  mkdirSync(join(dir, 'tool', 'ci'), { recursive: true });
  mkdirSync(join(dir, 'chain'));
  mkdirSync(join(dir, 'pub', 'state'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'pub', 'state', 'public-builds.json'), '[]');
  writeFileSync(join(dir, 'chain', 'feed.txt'), feedText);
  writeFileSync(join(dir, 'chain', 'version_map.generated.h'), '');
  writeFileSync(join(dir, 'chain', 'promote-plan.json'), JSON.stringify({ action: 'normal-flow', seq: planSeq }));
  writeFileSync(join(dir, 'chain', 'decision.json'), JSON.stringify({ decision: 'M', cl: 129999, candidate: true, wouldBe: 'M' }));
  writeFileSync(join(dir, 'chain', 'history.json'), JSON.stringify({ releases: [], attempts: {} }));
  writeFileSync(join(dir, 'tool', 'ci', 'vmap-sign.mjs'), `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync('calls.log', 'vmap-sign ' + a.join(' ') + '\\n');
const opt = (n) => a[a.indexOf('--' + n) + 1];
if (a[0] === 'sign') writeFileSync(opt('out'), readFileSync(a[1], 'utf8') + 'signed seq ' + opt('seq') + '\\n');
if (a[0] === 'verify') {
  const live = a[1].startsWith('live/');
  const seq = live ? ${liveSeq} : ${publishedSeq ?? 'Number(opt("expect-seq"))'};
  const key = live ? 'k2' : '${publishedKey}';
  if (!live && opt('expect-seq') !== undefined && Number(opt('expect-seq')) !== seq) { console.error('refused: wrong seq'); process.exit(3); }
  console.log('ok seq=' + seq + ' key=' + key);
}
`);
  writeFileSync(join(dir, 'tool', 'ci', 'version-map.mjs'), `import { appendFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync('calls.log', 'version-map ' + a.join(' ') + '\\n');
writeFileSync(a[a.indexOf('--out') + 1], ${JSON.stringify(exportText)});
`);
  writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/bash
printf 'gh %s\\n' "$*" >> calls.log
case "$1 $2" in
  "api repos/"*) ${release ? 'echo "{}"; exit 0' : 'echo "gh: Not Found (HTTP 404)" >&2; exit 1'} ;;
  "release download") dest=""; while [ $# -gt 0 ]; do [ "$1" = "--dir" ] && dest="$2"; shift; done; mkdir -p "$dest"; if [ "$dest" = live ]; then echo LIVE > live/version-map-client.v1.txt; else cp version-map-client.v1.txt vmap-history.json "$dest"/; [ -n "$TAMPER" ] && echo x >> "$dest"/vmap-history.json; fi ;;
esac
exit 0
`);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  return { dir, chainSeq };
};
const runPublishStep = (fx, step, env = {}) => sh(runOf(job('publish'), step), fx.dir, { PATH: join(fx.dir, 'bin') + delimiter + process.env.PATH, GH_REPO: 'o/r', GH_TOKEN: 'x', CHAIN_SEQ: fx.chainSeq, VMAP_SIGN_KEY: 'k', GITHUB_STEP_SUMMARY: join(fx.dir, 'summary.md'), ...env });
const callsOf = (dir) => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);

test('publish job: the chain seq must still rise above the live seq, the plan must agree, and the feed must be the one the list allows now', { skip: !bash }, () => {
  const step = 'Check the seq and the feed before signing';
  let fx = publishFixture();
  let r = runPublishStep(fx, step);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(fx.dir, 'last-seq.txt'), 'utf8').trim(), '100');
  assert.ok(callsOf(fx.dir).some((c) => /^version-map export-feed chain\/version_map\.generated\.h --out feed\.again\.txt --public-builds pub\/state\/public-builds\.json$/.test(c)), 'cut again against the list');
  // The plan states the same seq: fine.
  fx = publishFixture({ planSeq: 200 });
  assert.equal(runPublishStep(fx, step).status, 0);
  // Another publish landed: the chain seq no longer rises above the live one. Nothing is signed.
  fx = publishFixture({ liveSeq: 200 });
  r = runPublishStep(fx, step);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /no longer rises above the published seq 200.*nothing was signed/);
  // The plan states another seq than the chain.
  fx = publishFixture({ planSeq: 201 });
  r = runPublishStep(fx, step);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /promote plan states seq 201, not the chain seq 200/);
  // No seq from the chain at all.
  for (const bad of ['', '0', 'abc', '2 00']) {
    fx = publishFixture({ chainSeq: bad });
    assert.equal(runPublishStep(fx, step).status, 2, `seq '${bad}'`);
  }
  // The list moved since the chain staged: the feed differs, so the chain is stale.
  fx = publishFixture({ exportText: 'OTHER FEED\n' });
  r = runPublishStep(fx, step);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /differs from the feed the public builds list on main allows now/);
  // No release yet is seq 0.
  fx = publishFixture({ release: false });
  r = runPublishStep(fx, step);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(fx.dir, 'last-seq.txt'), 'utf8').trim(), '0');
});

test('publish job: signs with the chain seq, records it in the history, uploads, then verifies the published copy (signature, seq, sha256)', { skip: !bash }, () => {
  const fx = publishFixture();
  writeFileSync(join(fx.dir, 'last-seq.txt'), '100\n');
  let r = runPublishStep(fx, 'Sign with the release key, verify, publish');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = callsOf(fx.dir);
  assert.ok(c.includes('vmap-sign sign chain/feed.txt --out version-map-client.v1.txt --key-id k2 --last-seq 100 --seq 200'), c.join('\n'));
  assert.ok(c.includes('vmap-sign verify version-map-client.v1.txt --last-seq 100 --expect-seq 200'));
  assert.ok(c.some((l) => /^gh release upload vmap-feed version-map-client\.v1\.txt vmap-history\.json --clobber$/.test(l)));
  const history = JSON.parse(readFileSync(join(fx.dir, 'vmap-history.json'), 'utf8'));
  assert.deepEqual(history.releases.map((x) => [x.repo, x.cl, x.seq]), [['ModLoader', 129999, 200]]);
  // A missing release key stops before anything is signed.
  const nokey = publishFixture();
  writeFileSync(join(nokey.dir, 'last-seq.txt'), '100\n');
  r = runPublishStep(nokey, 'Sign with the release key, verify, publish', { VMAP_SIGN_KEY: '' });
  assert.equal(r.status, 2);
  assert.deepEqual(callsOf(nokey.dir).filter((l) => l.startsWith('vmap-sign sign')), []);
  // The published copy is checked.
  r = runPublishStep(fx, 'Verify what was published');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok seq=200 key=k2/);
  assert.match(r.stdout, /version-map-client\.v1\.txt sha256 [0-9a-f]{64}/);
  assert.match(readFileSync(join(fx.dir, 'summary.md'), 'utf8'), /Published the feed: seq 200, release key k2, sha256 [0-9a-f]{64}/);
  assert.equal(runPublishStep(fx, 'Verify what was published', { TAMPER: '1' }).status, 2, 'a published file that differs from the signed one fails');
  const wrongKey = publishFixture({ publishedKey: 'k1' });
  writeFileSync(join(wrongKey.dir, 'last-seq.txt'), '100\n');
  assert.equal(runPublishStep(wrongKey, 'Sign with the release key, verify, publish').status, 0);
  r = runPublishStep(wrongKey, 'Verify what was published');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /not seq 200 signed with the release key k2/);
  // A signer that wrote another seq than the chain's fails at the first verify, before anything is uploaded.
  const wrongSeq = publishFixture({ publishedSeq: 199 });
  writeFileSync(join(wrongSeq.dir, 'last-seq.txt'), '100\n');
  assert.notEqual(runPublishStep(wrongSeq, 'Sign with the release key, verify, publish').status, 0);
  assert.ok(!callsOf(wrongSeq.dir).some((l) => l.startsWith('gh release upload')));
});

test('publish job: the lock accepts the chain\'s own M and refuses a test run, a held candidate and a test plan', { skip: !bash }, () => {
  const lock = (decision, plan = { action: 'normal-flow', seq: null }, testInput = 'false') => {
    const fx = publishFixture();
    writeFileSync(join(fx.dir, 'chain', 'decision.json'), JSON.stringify(decision));
    writeFileSync(join(fx.dir, 'chain', 'promote-plan.json'), JSON.stringify(plan));
    return runPublishStep(fx, 'Refuse a test run', { TEST_INPUT: testInput }).status;
  };
  assert.equal(lock({ decision: 'M', cl: 1, candidate: true, wouldBe: 'M' }), 0, 'the unattended chain with the autopilot on');
  assert.equal(lock({ decision: 'M', cl: 1 }), 0, 'a dispatch with publish on');
  assert.equal(lock({ decision: 'HOLD', cl: 1, candidate: true, wouldBe: 'M' }), 2, 'held by the autopilot');
  assert.equal(lock({ decision: 'M', cl: 1, test: true, wouldBe: 'M' }), 2, 'a test run');
  assert.equal(lock({ decision: 'M', cl: 1, candidate: true, wouldBe: 'M' }, { action: 'normal-flow', test: true }), 2, 'a test plan');
  assert.equal(lock({ decision: 'M', cl: 1, candidate: true, wouldBe: 'M' }, undefined, 'true'), 2, 'the test input');
});
