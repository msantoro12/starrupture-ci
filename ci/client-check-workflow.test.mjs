// Tests for the client check workflow's run inputs (.github/workflows/sr-client-check.yml).
//
//   node --test ci/client-check-workflow.test.mjs
//
// Reads the workflow as text: the Game SDK repository input, the plugin
// exclusion list and the dispatch-only test-autopilot switch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addBuild, addFunction, emit, emptyMap, exportFeed, parse, parseFeed } from './version-map.mjs';
import { firstLogError } from './pipeline-alert.mjs';
import { buildRecord } from './layout-store.mjs';

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
  assert.match(job('publish'), /if: \$\{\{ !cancelled\(\) && inputs\.test_autopilot != true && inputs\.proof_run != true && inputs\.publish == true && needs\.map-mode\.outputs\.test == 'false' && /);
  assert.ok(!/workflow_ref/.test(jobIf('publish')), 'the publish input is the one switch: no inference from who called');
  const ap = JSON.parse(readFileSync(join(here, '..', 'state', 'autopilot.json'), 'utf8'));
  assert.ok(ap.enabled === false || (ap.enabled === true && ap.paths.every((p) => p === 'M')), 'autopilot is off or limited to the map-feed path M');
});

test('publish lock: a test run never reaches the release key, whatever state/autopilot.json says', () => {
  const mm = job('map-mode');
  // The chain states explicitly whether it is a test: the dispatch input, its own flag or the decision.
  assert.match(mm, /\n {6}test: \$\{\{ steps\.chain\.outputs\.test \}\}\n/);
  assert.match(mm, /TEST_INPUT: \$\{\{ inputs\.test_autopilot == true \|\| inputs\.proof_run == true \}\}/);
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
  assert.ok(mm.includes('elif [ -f res/layout-reference.json ]; then base=(--base res/layout-reference.json)\n'));
  assert.ok(mm.includes('elif [ "$PROOF" = true ] || { [ "$FIRST_PUBLISH" = true ] && [ "$MAPPED" = true ]; }; then base=(--base res/layout-target.json); echo '), 'only a proof run, or a first publish of a CL the header maps, takes the build as its own reference');
  assert.ok(mm.includes('\n          else echo "field-rows: no reference layout'));
  assert.ok(mm.includes('--next res/layout-target.json "${base[@]}" "${missing[@]}"'));
  assert.ok(!/--base res\/layout-reference\.json \\\n/.test(mm), '--base is never passed unconditionally');
  assert.ok(mm.includes('if [ "$fr" -ne 0 ] && [ "$fr" -ne 3 ]; then echo "::error::field-rows failed (exit $fr)'));
  assert.ok(mm.includes('exit "$fr"; fi'));
  assert.ok(mm.indexOf('field-rows failed') < mm.indexOf('decide.mjs --repo'), 'the job fails before decide runs without a report');
});

test('alert: a failed job or a HOLD other than "nothing new" opens or updates one issue per branch', () => {
  const a = job('alert');
  assert.match(a, /needs: \[build, plugin-plan, check, map-mode, publish, push-loader, candidate-loader, rig-branch, rig-other, rig-gate, feed-plan, feed-loader, rig-feed, rig-feed-other, feed-loader-cleanup, feed-gate\]/);
  assert.match(a, /if: \$\{\{ always\(\) && inputs\.branch && inputs\.branch != 'expiry-only' && inputs\.refresh_layout != true \}\}/);
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
  assert.match(watch.slice(watch.indexOf('  client-check:\n')), /permissions:\n\s+contents: write\n\s+pull-requests: write\n\s+issues: write.*\n\s+actions: write.*\n\s+checks: read/);
});

test('build label: the map-mode step labels a build "steam_build <build id>" and never names the branch', () => {
  const step = wf.slice(wf.indexOf('      - name: Write the update into the header'));
  const line = step.split('\n').find((l) => l.includes('scans.json", JSON.stringify('));
  assert.ok(line, 'the step writes scans.json');
  assert.match(line, /source: "steam_build " \+ process\.argv\[1\]/);
  assert.ok(!/BRANCH|branch/.test(line), 'the label is built from the build id only');
  assert.ok(!/source: [^,]*test_branch/.test(wf), 'no workflow step labels a build with a Steam branch');
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
  assert.match(job('map-mode'), /if: \$\{\{ !cancelled\(\) && inputs\.map_mode == true && inputs\.refresh_layout != true && needs\.check\.result == 'success' \}\}/);
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
  assert.match(mm, /\n {6}CANDIDATE: \$\{\{ inputs\.map_mode == true && inputs\.test_autopilot != true \}\}\n/);
  assert.ok(mm.includes('[ "$CANDIDATE" = true ] && test_flag=(--candidate)'));
  // The chain runs on past a HOLD that only the autopilot caused, and stops on any other.
  assert.ok(mm.includes('elif [ "$CANDIDATE" = true ] && [ "$decision" = HOLD ] && [ "$would" = M ]; then'));
  assert.ok(mm.includes('elif [ "$decision" != M ]; then echo "decide: $decision (exit $d); nothing exported or signed"; exit 0; fi'));
  assert.ok(mm.indexOf('elif [ "$CANDIDATE" = true ]') < mm.indexOf('version-map.mjs export-feed'), 'the candidate check comes before the export');
  // The held plan is a test plan: marked, and never publishable.
  assert.ok(mm.includes('promote_flag=(--test-autopilot)'));
  assert.ok(mm.includes('--out promote-plan.json "${promote_flag[@]}"'));
  // Publish stays out of reach while the decision is HOLD, though sr-watch passes publish on and the chain still stages.
  const pub = job('publish');
  assert.match(pub, /needs\.map-mode\.outputs\.decision == 'M'/);
  assert.match(pub, /needs\.map-mode\.outputs\.test == 'false'/);
  assert.match(pub, /inputs\.publish == true/);
  assert.ok(!/CANDIDATE|candidate/.test(pub.replace(/^ *#.*$/gm, '')), 'the publish job knows nothing of the candidate path');
  assert.match(watch.slice(watch.indexOf('  client-check:\n')), /\n {6}publish: true\n/, 'sr-watch passes publish explicitly');
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
  // A public scan is recorded once: the reference build is the public exe only for a branch other than public.
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
  return new Function('needs', 'inputs', 'github', 'contains', 'startsWith', `return (${js});`)(ctx.needs, ctx.inputs, ctx.github ?? { workflow_ref: SR_WATCH_REF }, contains, (a, b) => String(a).startsWith(b));
};
const okNeeds = () => ({
  'map-mode': { result: 'success', outputs: { test: 'false', decision: 'M', publishable: 'true', staged: 'true', expect_refused: '' } },
  'candidate-loader': { result: 'success', outputs: { artifact: 'loader-candidate-public', version: 'cand-1-abcdef0', expect: 'Loader=cand-1-abcdef0', sha: 'a'.repeat(40) } },
  'rig-branch': { result: 'success', outputs: { verdict: 'PASS', reason: 'All 40 checks passed', artifact: 'sr-client-rig-public-x-1-1' } },
  'rig-other': { result: 'success', outputs: { verdict: 'PASS', reason: 'All 40 checks passed', artifact: 'sr-client-rig-public_test_branch-x-1-1' } },
  'feed-gate': { result: 'success', outputs: { state: 'PASS', reason: '' } },
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
  // The rig is called four times in the file: these two jobs and the feed-path rig on each branch's build (rig-feed, rig-feed-other).
  assert.equal(wf.match(/uses: \.\/\.github\/workflows\/sr-client-rig\.yml/g)?.length, 4);
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
  assert.match(job('publish'), /\n {4}needs: \[check, map-mode, rig-branch, rig-other, feed-gate\]\n/);
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
  // The publish input is the one switch, for sr-watch (which passes it) and for a dispatch alike.
  const direct = { workflow_ref: 'msantoro12/starrupture-ci/.github/workflows/sr-client-check.yml@refs/heads/main' };
  assert.equal(run(() => {}, okInputs()), true, 'sr-watch passes publish on and it publishes');
  assert.equal(run(() => {}, { ...okInputs(), publish: false }), false, 'publish off is a dry run, whoever called');
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
  // layout-store uploads reference layouts to its own release and signs nothing (its tests are at the end of this file).
  assert.deepEqual(writers, ['layout-store', 'publish']);
  assert.ok(!/vmap-sign\.mjs/.test(job('layout-store')));
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
  assert.equal(ceiling.actions, 'write', "sr-watch grants actions: write (the cleanup job's; the rig's actions: read fits under it)");
  assert.equal(job('feed-loader-cleanup').match(/\n {4}permissions:\n((?: {6}[a-z-]+: .*\n)+)/)[1].trim(), 'actions: write', 'only the cleanup job asks for it');
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
  // The release key is declared and passed by name too, but no plugin job reads it (the publish job does, in the vmap-sign environment).
  assert.match(call, /\n {6}VMAP_SIGN_KEY:\n {8}description: [^\n]+\n {8}required: false\n/);
  assert.ok(caller.includes('\n      VMAP_SIGN_KEY: ${{ secrets.VMAP_SIGN_KEY }}\n'));
  // The nine are the ones the auto-apply name check admits.
  const allowed = job('auto-apply').match(/\^\(([A-Za-z|]+)\)\$/)[1].split('|').map((n) => `SR_DEPLOYKEY_${n.toUpperCase()}`).sort();
  assert.deepEqual(allowed, [...FORK_KEYS].sort());
});

// ------------------------------------------------------------ leg C2: expected refusals on the other branch, pinned third-party plugins

const OTHER_STEP_FROM = '          other_branch=public; [ "$BRANCH" = public ] && other_branch=public_test_branch\n';
const otherStep = () => {
  const mm = job('map-mode');
  const start = mm.indexOf(OTHER_STEP_FROM);
  const end = mm.indexOf('\n', mm.indexOf("its rig expects a clean decline\"; fi", start)) + 1;
  assert.ok(start > 0 && end > start, 'the step that finds the other branch\'s CL exists');
  return mm.slice(start, end).replace(/^ {10}/gm, '');
};

test('other branch: map-mode finds the other branch\'s CL, hands it to decide, and outputs the rig input before the chain can stop', () => {
  const mm = job('map-mode');
  assert.match(mm, /\n {6}expect_refused_other: \$\{\{ steps\.chain\.outputs\.expect_refused_other \}\}\n/);
  assert.match(mm, /\n {6}OTHER_BUILDID: \$\{\{ inputs\.other_buildid \}\}\n/);
  const find = mm.indexOf(OTHER_STEP_FROM);
  const decideAt = mm.indexOf('node tool/ci/decide.mjs --repo');
  assert.ok(find > 0 && find < decideAt, 'the CL is found before decide runs');
  assert.match(mm.slice(decideAt, decideAt + 500), /"\$\{test_flag\[@\]\}" "\$\{first_flag\[@\]\}" "\$\{other_flag\[@\]\}"/);
  const out = mm.indexOf('echo "expect_refused_other=$expect_refused_other" >> "$GITHUB_OUTPUT"');
  assert.ok(out > mm.indexOf('echo "expect_refused=$expect_refused"') && out < mm.indexOf('nothing exported or signed'), 'set ahead of the exit that ends a chain whose decision is not M');
  assert.ok(mm.includes("grep -Eq '^[A-Za-z0-9_.-]+( [A-Za-z0-9_.-]+)*$'"));
  // The watcher hands the id over, from the poll; both triggers of the check declare the input.
  assert.match(watch, /\n {6}other_buildid: \$\{\{ matrix\.other_buildid \}\}\n/);
  assert.match(call, /\n {6}other_buildid:\n {8}description: [^\n]*\n {8}type: string\n {8}default: ''\n/);
  assert.match(dispatch, /\n {6}other_buildid:\n {8}description: [^\n]*\n {8}type: string\n {8}default: ''\n/);
});

test('other branch: the CL comes from the dispatch input or a live Steam read through the candidate map\'s build rows; a build the map lacks is declared unmapped; an unreadable id stops the chain', { skip: !bash }, () => {
  const header = (() => {
    const m = emptyMap('loader', 127004);
    addBuild(m, { cl: 127004, stamp: 1, size: 2, source: 'public 25646882' });
    addBuild(m, { cl: 129402, stamp: 3, size: 4, source: 'steam_build 26271156' });
    return emit(m);
  })();
  // live: the id the poll's live read prints (the stub standing in for poll-steam.mjs), or null for a read that fails.
  const run = ({ branch, otherBuildid = '', live = null }) => {
    const dir = mkdtempSync(join(tmpdir(), 'other-cl-'));
    cpSync(here, join(dir, 'tool', 'ci'), { recursive: true, filter: (src) => !/[\\/]fixtures([\\/]|$)/.test(src) });
    mkdirSync(join(dir, 'tool', '.github', 'sr-pipeline'), { recursive: true });
    writeFileSync(join(dir, 'tool', '.github', 'sr-pipeline', 'poll-steam.mjs'), "console.error('live read: ' + process.argv.slice(2).join(' '));\nif (process.env.STUB_LIVE !== undefined) console.log(process.env.STUB_LIVE); else process.exit(1);\n");
    writeFileSync(join(dir, 'version_map.generated.h'), header);
    const script = `set -euo pipefail\nheader=version_map.generated.h\n${otherStep()}\nprintf 'cl=[%s] flag=[%s] id=[%s]\\n' "$other_cl" "\${other_flag[*]}" "$other_buildid"`;
    const env = { ...process.env, BRANCH: branch, OTHER_BUILDID: otherBuildid, GITHUB_OUTPUT: join(dir, 'out.txt') };
    delete env.STUB_LIVE;
    if (live !== null) env.STUB_LIVE = live;
    const r = spawnSync(bash, ['-c', script], { cwd: dir, encoding: 'utf8', windowsHide: true, env });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  // A public check, the watcher saw the other branch on build 26271156 (CL-129402): the input is used, Steam is not asked.
  const a = run({ branch: 'public', otherBuildid: '26271156' });
  assert.equal(a.status, 0, a.err);
  assert.match(a.out, /cl=\[129402\] flag=\[--other-cl 129402\] id=\[26271156\]/);
  assert.match(a.out, /the other branch runs build 26271156 = CL-129402/);
  assert.ok(!/live read/.test(a.err), 'an explicit other_buildid is never second-guessed');
  // A dispatch without the input reads the other branch's live id, as the watcher's poll does.
  const b = run({ branch: 'public_test_branch', live: '25646882' });
  assert.equal(b.status, 0, b.err);
  assert.match(b.out, /cl=\[127004\] flag=\[--other-cl 127004\] id=\[25646882\]/);
  assert.match(b.err, /live read: --live-buildid public$/m);
  // The input wins over the live read.
  assert.match(run({ branch: 'public', otherBuildid: '25646882', live: '26271156' }).out, /cl=\[127004\]/);
  // A build the candidate map has no row for: no CL, declared unmapped (decide then expects a clean decline).
  const c = run({ branch: 'public', otherBuildid: '999' });
  assert.equal(c.status, 0, c.err);
  assert.match(c.out, /cl=\[\] flag=\[--other-unmapped the other branch runs build 999\] id=\[999\]/);
  assert.match(c.out, /::notice title=Other branch not in the map::the other branch runs build 999, which has no row in the candidate map: its rig expects a clean decline/);
  assert.match(run({ branch: 'public', live: '26999999' }).out, /--other-unmapped the other branch runs build 26999999/);
  // Fails closed: a live read that fails, or prints no number, or an input that is no number, stops the chain.
  for (const odd of [{ live: null }, { live: '' }, { live: 'html' }, { otherBuildid: 'not-a-build' }]) {
    const r = run({ branch: 'public', ...odd });
    assert.equal(r.status, 2, JSON.stringify(odd));
    assert.match(r.out + r.err, /::error title=Other branch build id::(cannot read the live build id of the other Steam branch from Steam|the build id of the other Steam branch is not a number)/, JSON.stringify(odd));
    assert.ok(!/cl=\[/.test(r.out), 'no CL is declared after a failure');
  }
  // The id recorded on main (state/steam.json) is never the source: it names the build of the last merged update PR.
  assert.ok(!/steam\.json/.test(otherStep()), 'the recorded state is not read');
});

test('other branch: the step turns decision.json into the other rig\'s input, and refuses a name outside the rig\'s grammar', { skip: !bash }, () => {
  const mm = job('map-mode');
  const start = mm.indexOf('          expect_refused_other="$(node -p');
  const end = mm.indexOf('\n', mm.indexOf('Loader refuses on CL::expected refusals on the other branch')) + 1;
  assert.ok(start > 0 && end > start);
  const snippet = mm.slice(start, end).replace(/^ {10}/gm, '');
  const run = (decision) => {
    const dir = mkdtempSync(join(tmpdir(), 'expect-other-'));
    writeFileSync(join(dir, 'decision.json'), JSON.stringify(decision));
    const r = spawnSync(bash, ['-c', `other_branch=public_test_branch; other_cl=129402\n${snippet}`], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_OUTPUT: join(dir, 'out.txt') } });
    return { status: r.status, out: existsSync(join(dir, 'out.txt')) ? readFileSync(join(dir, 'out.txt'), 'utf8') : '', log: r.stdout };
  };
  const a = run({ decision: 'HOLD', expectRefused: [], expectRefusedOther: ['MiniMap'] });
  assert.deepEqual([a.status, a.out], [0, 'expect_refused_other=MiniMap\nexpect_decline_other=false\n']);
  assert.match(a.log, /expected refusals on the other branch \(CL-129402\): MiniMap/);
  assert.equal(run({ decision: 'M', expectRefusedOther: ['Codex', 'MiniMap'] }).out, 'expect_refused_other=Codex MiniMap\nexpect_decline_other=false\n');
  assert.equal(run({ decision: 'M', expectRefusedOther: [] }).out, 'expect_refused_other=\nexpect_decline_other=false\n');
  // A build the map has no row for: the other branch's rig is told to expect a clean decline.
  assert.equal(run({ decision: 'M', expectDeclineOther: true }).out, 'expect_refused_other=\nexpect_decline_other=true\n');
  assert.equal(run({ decision: 'M', expectRefused: ['MiniMap'] }).out, 'expect_refused_other=\nexpect_decline_other=false\n', 'no prediction for the other branch means nothing is declared there');
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
  const co = stepText(j, 'Check out the plan tools');
  assert.ok(co.includes('path: tool') && /sparse-checkout: \|\n\s+ci\n\s+\.github\/sr-pipeline\n/.test(co) && co.includes('persist-credentials: false'));
  assert.ok(j.indexOf('- name: Check out the plan tools') < j.indexOf('- name: Check the plugin list'), 'the pins are there before the plan reads them');
  assert.ok(j.indexOf('- name: Check out the plan tools') < j.indexOf('- name: Check a first publish'), 'the tools are there before the first-publish proof reads them');
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
  assert.ok(mm.indexOf('rig_flag=(--rig-plugins res/rig-plugins.json)') < mm.indexOf('node tool/ci/decide.mjs --repo'), 'before decide');
  assert.match(mm.slice(mm.indexOf('node tool/ci/decide.mjs --repo'), mm.indexOf('node tool/ci/decide.mjs --repo') + 600), /"\$\{other_flag\[@\]\}" "\$\{rig_flag\[@\]\}"/);
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

test('N2 alert: a hold that staged no candidate is not "ready"', { skip: !bash }, () => {
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
  assert.equal(c.split(`if: ${gate}\n`).length - 1, 1, 'the header checkout runs only in map mode, after a passing scan');
  // The carry step has the same gate and, with the published base switched on, also waits for a base that was taken.
  assert.ok(step(c, CARRY).includes(`if: ${gate} && steps.pbase.outputs.held != 'true'\n`));
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
  assert.match(mm, /path: \|\n\s+version_map\.generated\.h\n\s+map-mode-report\.json\n\s+alerts\.json\n\s+carry\.json\n\s+observations\.json\n/);
  assert.ok(mm.indexOf('assemble scans.json') < mm.indexOf('map-mode.mjs write "$header"') && mm.indexOf('map-mode.mjs write "$header"') < mm.indexOf('map-mode.mjs complete "$header"'));
  assert.ok(mm.indexOf('map-mode.mjs complete "$header"') < mm.indexOf('- name: Decide, export, sign, stage and plan the promotion'), 'the gate runs before decide');
});

// ---- Key sources: fork builds scanned for map keys only ----------------------------------------------------

const KEY_NINE = ['BetterCheats', 'BetterDrone', 'WAILA', 'Codex', 'Compass', 'ProductionViewer', 'RuptureTimer', 'WaveOptimiser', 'CameraControls'];
const KEY_PIN = '5bc7e08ce523194665f7173a16f57b9a15ab82b2';
const HEX40 = 'a'.repeat(40);
// The Plugin SDK the key sources build against: the one pin, in the workflow env (the Loader agent moves it with sr-update's).
const KEY_SDK = { repo: 'msantoro12/StarRupture-Plugin-SDK', ref: '52b48fcc1632f0b713695919c7ba7978111dc428' };
// The node program of a step's `node -e '...'` run block.
const nodeScriptOf = (j, name) => runOf(j, name).match(/node -e '\n([\s\S]*)\n'\s*$/)[1];

test('key sources: both triggers default to the nine work branches and the pinned MiniMap key-scan build', () => {
  const want = [...KEY_NINE.map((n) => `msantoro12/StarRupture-Plugin-${n}@gss/plugin-work`), `msantoro12/StarRupture-Plugin-MiniMap@feat/full-version-map:${KEY_PIN}`];
  for (const s of [call, dispatch]) assert.deepEqual(defaultOf(s, 'key_sources').split(' '), want);
});

const keyPlan = (env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'key-plan-'));
  const script = nodeScriptOf(job('key-sources-plan'), 'Check the key source list');
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: dir, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, KEY_SOURCES: defaultOf(call, 'key_sources'), KEY_SDK_REPO: KEY_SDK.repo, KEY_SDK_REF: KEY_SDK.ref, GAME_SDK_REPO: 'AlienXAXS/StarRupture-Game-SDK', LOADER_REPO: 'msantoro12/StarRupture-ModLoader', ...env },
  });
  const file = join(dir, 'key-sources-unresolved.json');
  return { r, dir, entries: r.status === 0 ? JSON.parse(readFileSync(file, 'utf8')) : null };
};

test('key sources: the default list is accepted, MiniMap gets its key-scan recipe and the others the standard build', () => {
  const { r, entries } = keyPlan();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(entries.length, 10);
  const mini = entries.find((e) => e.name === 'MiniMap');
  assert.deepEqual([mini.recipe, mini.pin, mini.branch, mini.tag, mini.component], ['keyscan', KEY_PIN, 'feat/full-version-map', 'msantoro12/StarRupture-Plugin-MiniMap@feat/full-version-map', 'MiniMap@feat/full-version-map']);
  assert.deepEqual([mini.pluginSdkRepo, mini.pluginSdkRef], [KEY_SDK.repo, KEY_SDK.ref], 'MiniMap builds on the pinned fork SDK too');
  for (const e of entries.filter((x) => x !== mini)) {
    assert.deepEqual([e.recipe, e.branch, e.pin, e.repo], ['standard', 'gss/plugin-work', '', `msantoro12/StarRupture-Plugin-${e.name}`]);
    assert.equal(e.tag, `${e.repo}@gss/plugin-work`);
    assert.deepEqual([e.pluginSdkRepo, e.pluginSdkRef], [KEY_SDK.repo, KEY_SDK.ref], `${e.name} builds on the pinned fork SDK`);
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
  // The game SDK and the loader the build is made from are on the plugin plan's allowlist too.
  for (const env of [{ GAME_SDK_REPO: 'evil/StarRupture-Game-SDK' }, { LOADER_REPO: 'evil/StarRupture-ModLoader' }]) {
    assert.equal(keyPlan(env).r.status, 1, JSON.stringify(env));
  }
});

test('key sources: the Plugin SDK pin is in one place, the workflow env, and every non-MiniMap source reads it', () => {
  // The values are written once, as the env of the workflow.
  assert.equal(wf.split(KEY_SDK.ref).length - 1, 1, 'the pinned commit appears once in the workflow');
  assert.equal(wf.split(KEY_SDK.repo).length - 1, 1, 'the pinned repository appears once in the workflow');
  assert.match(wf, new RegExp(`\\n  KEY_SDK_REPO: ${KEY_SDK.repo}\\n  KEY_SDK_REF: ${KEY_SDK.ref}\\n`));
  assert.match(wf, /^env:\n(?:  .*\n|\n)*  KEY_SDK_REF: /m, 'it is in the workflow-level env');
  // The plan hands it to each standard entry, and the build leg checks out whatever its plan entry names.
  assert.match(runOf(job('key-sources-plan'), 'Check the key source list'), /pluginSdkRepo: env\.KEY_SDK_REPO, pluginSdkRef: env\.KEY_SDK_REF/);
  const leg = job('key-sources');
  assert.match(leg, /repository: \$\{\{ matrix\.pluginSdkRepo \}\}\n\s+ref: \$\{\{ matrix\.pluginSdkRef \}\}/);
  assert.ok(!/KEY_SDK|StarRupture-Plugin-SDK/.test(leg.replace(/^ *#.*\n/gm, '').replace(/matrix\.pluginSdk\w+/g, '')), 'the build leg names no SDK of its own');
});

test('key sources: a key source that cannot build does not fail map mode (continue-on-error on the build jobs only)', () => {
  assert.match(job('key-sources'), /^ {4}continue-on-error: true$/m);
  assert.ok(!/^ {4}continue-on-error:/m.test(job('key-sources-plan')), 'a list that cannot be resolved still stops the run');
  // The plugin-plan builds are as they were: no job-level continue-on-error on them.
  for (const name of ['plugin-plan', 'plugins']) assert.ok(!/^ {4}continue-on-error: true$/m.test(job(name)), name);
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
    'map-mode': ['Settle the key sources', 'Write the update into the header'],
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

test('key sources: a failing one is named in the summary and as an alert line and map mode goes on; only an unresolved list stops it', { skip: !bash }, () => {
  const gate = runOf(job('map-mode'), 'Settle the key sources');
  assert.match(job('map-mode'), /^ {4}needs: \[build, plugins, check, key-sources-plan, key-sources\]$/m);
  const tag = 'msantoro12/StarRupture-Plugin-Codex@gss/plugin-work';
  const good = { name: 'Codex', tag, sha: HEX40, status: 'ok', layout: 'ok', keys: 7 };
  const plan = (...xs) => JSON.stringify(xs.map((x) => ({ name: x.name, tag: x.tag, sha: x.sha })));
  const run = (env, keysrc, sources = [good]) => {
    const dir = mkdtempSync(join(tmpdir(), 'key-gate-'));
    mkdirSync(join(dir, 'res'));
    if (keysrc) writeFileSync(join(dir, 'res', 'keysrc.json'), JSON.stringify({ sources: keysrc }));
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    const r = spawnSync(bash, ['-c', gate], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, KEY_PLAN: 'success', KEY_ANY: 'true', KEY_BUILD: 'success', PLAN: plan(...sources), GITHUB_STEP_SUMMARY: summary, ...env } });
    const alerts = existsSync(join(dir, 'alerts.json')) ? JSON.parse(readFileSync(join(dir, 'alerts.json'), 'utf8')).alerts : null;
    return { r, alerts, summary: readFileSync(summary, 'utf8') };
  };
  let x = run({}, [good]);
  assert.equal(x.r.status, 0, x.r.stdout + x.r.stderr);
  assert.match(x.r.stdout, /Codex@gss\/plugin-work a{40}: 7 keyed requests/);
  assert.deepEqual(x.alerts, []);
  assert.match(x.summary, /### Key sources/);
  x = run({ KEY_ANY: 'false', KEY_BUILD: 'skipped' }, null, []);
  assert.equal(x.r.status, 0, 'no key sources listed');
  // Each way a key source goes wrong is a warning, a line in the step summary and an alert line; none stops map mode.
  const fails = [
    [{ KEY_BUILD: 'failure' }, [{ ...good, status: 'failed', error: 'it did not build (no artifact)' }], /it did not build \(no artifact\); map mode went on/],
    [{}, [{ ...good, status: 'failed', error: 'sr-aobscan failed' }], /sr-aobscan failed/],
    [{}, [{ ...good, layout: 'failed: gen failed' }], /its keys were not read: failed: gen failed/],
    [{}, [{ ...good, layout: undefined }], /layout step stopped before the key sources/],
    [{}, null, /recorded no result for it/],
    [{}, [], /recorded no result for it/],
  ];
  for (const [env, keysrc, why] of fails) {
    x = run(env, keysrc);
    assert.equal(x.r.status, 0, `${JSON.stringify(env)} ${why}`);
    assert.match(x.r.stdout, /^::warning title=Key source msantoro12\/StarRupture-Plugin-Codex@gss\/plugin-work::/m);
    assert.equal(x.alerts.length, 1);
    const line = `key source ${tag} (${'a'.repeat(12)}, checked the branch, not an installed DLL): `;
    assert.ok(x.alerts[0].startsWith(line), x.alerts[0]);
    assert.match(x.alerts[0], why);
    assert.match(x.alerts[0], /map mode went on without the keys only it requests$/);
    assert.ok(x.summary.includes('- **FAILED** ' + x.alerts[0]), x.summary);
  }
  // A good source next to a failed one: only the failed one is an alert.
  const other = { name: 'WAILA', tag: 'msantoro12/StarRupture-Plugin-WAILA@gss/plugin-work', sha: 'b'.repeat(40) };
  x = run({}, [good, { ...other, status: 'failed', error: 'x', layout: 'ok' }], [good, other]);
  assert.equal(x.r.status, 0);
  assert.deepEqual(x.alerts.map((l) => /WAILA/.test(l)), [true]);
  assert.match(x.summary, /- msantoro12\/StarRupture-Plugin-Codex@gss\/plugin-work a{12}: 7 keyed requests/);
  // Only a key source list that was refused or could not be resolved stops map mode.
  x = run({ KEY_PLAN: 'failure' }, [good]);
  assert.equal(x.r.status, 2);
  assert.match(x.r.stdout, /^::error title=Key sources::the key source list was refused/m);
  // It runs before anything is written into the header.
  const m = job('map-mode');
  assert.ok(m.indexOf('- name: Settle the key sources') < m.indexOf('- name: Write the update into the header'));
  assert.ok(!m.includes('Require the key sources'), 'the step that failed map mode is gone');
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
  // MiniMap: not released here (nothing scanned), only the key-scan build; Codex: a source that failed, so it left no scan;
  // Compass: scanned, but its keys were not read, so its scan is left out of the map.
  put('keysrc-Compass.json', { plugin: { name: 'Compass' }, patterns: [row('Compass/Key', 0x4000, { fp: '0x22222222' })] });
  put('keysrc-MiniMap.json', { plugin: { name: 'MiniMap' }, patterns: [row('MiniMap/Free', 0x3000, { fp: '0x11111111' })] });
  const tag = (n, b) => `msantoro12/StarRupture-Plugin-${n}@${b}`;
  put('keysrc.json', { sources: [
    { name: 'WAILA', tag: tag('WAILA', 'gss/plugin-work'), sha: 'a'.repeat(40), status: 'ok', layout: 'ok' },
    { name: 'MiniMap', tag: tag('MiniMap', 'ci/hosted-build'), sha: 'b'.repeat(40), status: 'ok', layout: 'ok' },
    { name: 'Codex', tag: tag('Codex', 'gss/plugin-work'), status: 'failed', error: 'x' },
    { name: 'Compass', tag: tag('Compass', 'gss/plugin-work'), status: 'ok', layout: 'failed: gen failed' },
    { name: '../evil', tag: 'x', status: 'ok', layout: 'ok' },
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
  // A key source that failed to build reaches the issue through the map-mode job's alerts.json.
  const line3 = 'key source msantoro12/StarRupture-Plugin-Codex@gss/plugin-work (c0ffee012345, checked the branch, not an installed DLL): it did not build (no artifact); map mode went on without the keys only it requests';
  const k = alertRun({ decision: goodDecision, extra: { 'chain/alerts.json': { alerts: [line3] } } });
  assert.equal(k.status, 0, k.stderr);
  assert.ok(k.md.includes(`- ${line3}${NL}`), k.md);
  assert.deepEqual(k.outputs, { alert: 'true', passed: 'true', ready: 'false' });
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
  const run = (mut = () => {}, inputs = okInputs(), github = undefined) => {
    const n = okNeeds();
    mut(n);
    return evalExpr(ifLine, { needs: n, inputs, github });
  };
  assert.equal(run(), true, 'sr-watch (publish: true), public, M, publishable, both rigs PASS: publishes');
  assert.equal(run(() => {}, { ...okInputs(), publish: false }), false, 'the publish input off: a dry run');
  // Each gate alone stops it.
  assert.equal(run(() => {}, { ...okInputs(), branch: 'public_test_branch' }), false, 'a run for the other branch never publishes');
  assert.equal(run((n) => { n['map-mode'].outputs.decision = 'HOLD'; n['map-mode'].outputs.publishable = 'false'; n['map-mode'].outputs.test = 'true'; }), false, 'autopilot off: HOLD, a held candidate counts as a test, publish skipped');
  assert.equal(run((n) => { n['map-mode'].outputs.decision = 'HOLD'; }), false, 'a HOLD alone');
  assert.equal(run((n) => { n['map-mode'].outputs.publishable = 'false'; }), false, 'promote says not publishable');
  assert.equal(run((n) => { n['rig-other'].outputs.verdict = 'FAIL'; }), false, 'a rig fail');
  assert.equal(run(() => {}, { ...okInputs(), test_autopilot: true }), false, 'a test_autopilot run');
  // The release key sits in the vmap-sign environment of this job only, and the job holds no other secret.
  assert.match(pub, /\n {4}environment: vmap-sign\n/);
  assert.deepEqual([...new Set([...pub.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))], ['VMAP_SIGN_KEY']);
  const holders = [...wf.matchAll(/\n {2}([a-z][\w-]*):\n/g)].map((m) => m[1]).filter((n) => /secrets\.VMAP_SIGN_KEY(?!_TEST)/.test(job(n)));
  assert.deepEqual(holders, ['publish']);
  // sr-watch passes the release key by name (a called job reads an environment secret only that way); only the publish job reads it.
  assert.ok(watch.slice(watch.indexOf('  client-check:\n')).includes('\n      VMAP_SIGN_KEY: ${{ secrets.VMAP_SIGN_KEY }}\n'));
  // The gates are written down in the order they apply, and the old "not wired" wording is gone.
  const head = wf.slice(wf.indexOf('# ---- Publish: the feed signed with the release key'), wf.indexOf('\n  publish:\n'));
  const at = ['run is for public', 'the publish input is on', 'decide chose M', 'publishable', 'both client rigs'].map((t) => head.indexOf(t));
  assert.ok(at.every((i) => i > 0) && at.every((v, i) => i === 0 || v > at[i - 1]), `gate order in the comment: ${at}`);
  assert.ok(!/publish not wired/.test(wf));
  // The switch is state/autopilot.json, and it is on for path M only.
  const apOn = JSON.parse(readFileSync(apPath, 'utf8'));
  assert.deepEqual([apOn.enabled, apOn.paths], [true, ['M']]);
});

test('publish gates: the autopilot off means a HOLD and a skipped publish, the chain still stages (decide --candidate)', () => {
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

test('the feed carries every build: export-feed has no list option, runs once in the chain and once in the publish re-cut', () => {
  const exports = [...wf.matchAll(/node tool\/ci\/version-map\.mjs export-feed [^\n]*/g)].map((m) => m[0]);
  assert.equal(exports.length, 2, 'the chain exports the staged feed; the publish job cuts it again to compare');
  for (const e of exports) assert.ok(!/--public-builds/.test(e), e);
  assert.ok(!/public-builds|record-public|parsePublicBuilds/.test(wf), 'no public list anywhere in the workflow');
  const mm = job('map-mode');
  assert.ok(mm.indexOf('export-feed') < mm.indexOf('--key-id k1'), 'exported before it is signed');
  assert.ok(mm.includes('(every build in the header)'));
});

// The publish job's steps, run against stubs: gh, the signer and the exporter write what they are asked and log their arguments.
const publishFixture = ({ liveSeq = 100, chainSeq = '200', planSeq = null, exportText = 'FEED\n', feedText = 'FEED\n', publishedKey = 'k2', publishedSeq = undefined, release = true, feedAsset = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-job-'));
  mkdirSync(join(dir, 'tool', 'ci'), { recursive: true });
  mkdirSync(join(dir, 'chain'));
  mkdirSync(join(dir, 'bin'));
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
  writeFileSync(join(dir, 'tool', 'ci', 'published-base.mjs'), `import { appendFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync('calls.log', 'published-base ' + a.join(' ') + '\\n');
const code = Number(process.env.PRESERVE_EXIT ?? 0);
writeFileSync(a[a.indexOf('--report') + 1], JSON.stringify(code === 0 ? { ok: true, step: 'preserve', note: 'kept' } : { ok: false, step: 'preserve', reasons: ['published base: 2 published lines are missing from the new feed', 'function GWorld @ CL-127004: missing'] }));
process.exit(code);
`);
  writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/bash
printf 'gh %s\\n' "$*" >> calls.log
case "$1 $2" in
  "api repos/"*) ${release ? `echo '${JSON.stringify({ assets: feedAsset ? [{ name: 'version-map-client.v1.txt' }, { name: 'vmap-history.json' }] : [{ name: 'vmap-history.json' }] })}'; exit 0` : 'echo "gh: Not Found (HTTP 404)" >&2; exit 1'} ;;
  "release download") dest=""; while [ $# -gt 0 ]; do [ "$1" = "--dir" ] && dest="$2"; shift; done; mkdir -p "$dest"; if [ "$dest" = live ]; then echo LIVE > live/version-map-client.v1.txt; else cp version-map-client.v1.txt vmap-history.json "$dest"/; [ -n "$TAMPER" ] && echo x >> "$dest"/vmap-history.json; fi ;;
esac
exit 0
`);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  return { dir, chainSeq };
};
const runPublishStep = (fx, step, env = {}) => sh(runOf(job('publish'), step), fx.dir, { PATH: join(fx.dir, 'bin') + delimiter + process.env.PATH, GH_REPO: 'o/r', GH_TOKEN: 'x', CHAIN_SEQ: fx.chainSeq, FIRST_PUBLISH: 'false', PUBLISHED_BASE: 'false', VMAP_SIGN_KEY: 'k', GITHUB_STEP_SUMMARY: join(fx.dir, 'summary.md'), ...env });
const callsOf = (dir) => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);

test('publish job: the chain seq must still rise above the live seq, the plan must agree, and the feed must be the one the list allows now', { skip: !bash }, () => {
  const step = 'Check the seq and the feed before signing';
  let fx = publishFixture();
  let r = runPublishStep(fx, step);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(fx.dir, 'last-seq.txt'), 'utf8').trim(), '100');
  assert.ok(callsOf(fx.dir).some((c) => /^version-map export-feed chain\/version_map\.generated\.h --out feed\.again\.txt$/.test(c)), 'cut again from the chain header');
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
  assert.match(r.stdout, /differs from the export of the chain's header/);
  // No release yet is seq 0.
  fx = publishFixture({ release: false });
  r = runPublishStep(fx, step);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(fx.dir, 'last-seq.txt'), 'utf8').trim(), '0');
  // A release whose feed asset is missing (a partial upload left only the history) is no feed either: seq 0, and the run goes on.
  fx = publishFixture({ feedAsset: false });
  r = runPublishStep(fx, step);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(fx.dir, 'last-seq.txt'), 'utf8').trim(), '0');
  assert.ok(!callsOf(fx.dir).some((c) => /^gh release download/.test(c)), 'nothing is downloaded when there is no feed asset');
});

test('publish job: signs with the chain seq, records it in the history, uploads, then verifies the published copy (signature, seq, sha256)', { skip: !bash }, () => {
  const fx = publishFixture();
  writeFileSync(join(fx.dir, 'last-seq.txt'), '100\n');
  let r = runPublishStep(fx, 'Sign with the release key, verify, publish');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = callsOf(fx.dir);
  assert.ok(c.includes('vmap-sign sign chain/feed.txt --out version-map-client.v1.txt --key-id k2 --last-seq 100 --seq 200'), c.join('\n'));
  assert.ok(c.includes('vmap-sign verify version-map-client.v1.txt --last-seq 100 --expect-seq 200'));
  // History first: if the second upload fails, the history is not short of a feed that is live.
  const upHist = c.indexOf('gh release upload vmap-feed vmap-history.json --clobber');
  const upFeed = c.indexOf('gh release upload vmap-feed version-map-client.v1.txt --clobber');
  assert.ok(upHist >= 0 && upFeed > upHist, c.join('\n'));
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

// ------------------------------------------------------------ publish bundle B2: the feed-path rig gate

const feedIf = (name, needs, inputs) => evalExpr(jobIf(name), { needs, inputs });
const feedNeeds = (over = {}) => ({ ...okNeeds(), 'feed-plan': { result: 'success', outputs: { state: 'RUN' } }, 'feed-loader': { result: 'success', outputs: {} }, 'rig-feed': { result: 'success', outputs: { verdict: 'PASS' } }, ...over });

test('feed gate: publish needs the feed gate to end PASS or a named SKIP, and nothing else changes', () => {
  const run = (mut = () => {}) => { const n = okNeeds(); mut(n); return evalExpr(jobIf('publish'), { needs: n, inputs: okInputs() }); };
  assert.equal(run(), true, 'feed gate PASS');
  assert.equal(run((n) => { n['feed-gate'].outputs.state = 'SKIP'; }), true, 'feed gate SKIP (the feed adds and changes no row)');
  assert.equal(run((n) => { n['feed-gate'].outputs.state = 'FAIL'; }), false, 'FAIL');
  assert.equal(run((n) => { n['feed-gate'].outputs.state = ''; }), false, 'no state');
  assert.equal(run((n) => { n['feed-gate'] = { result: 'failure', outputs: { state: 'FAIL' } }; }), false, 'a failed gate job');
  assert.equal(run((n) => { n['feed-gate'] = { result: 'skipped', outputs: {} }; }), false, 'a skipped gate job is not a pass');
  assert.equal(run((n) => { n['feed-gate'] = { result: 'cancelled', outputs: { state: 'PASS' } }; }), false, 'a cancelled gate job');
  // The autopilot off: decide says HOLD, so publish is skipped whatever the feed gate says.
  assert.equal(run((n) => { n['map-mode'].outputs.decision = 'HOLD'; }), false, 'autopilot off: still no publish');
  assert.match(job('publish'), /\n {4}needs: \[check, map-mode, rig-branch, rig-other, feed-gate\]\n/);
});

test('feed gate: it runs on public only, for the candidates the rig gate covers, and the rig shares the Steam group', () => {
  for (const name of ['feed-plan', 'feed-gate']) {
    assert.equal(feedIf(name, feedNeeds(), okInputs()), true, `${name} runs on public`);
    assert.equal(feedIf(name, feedNeeds(), { ...okInputs(), branch: 'public_test_branch' }), false, `${name} never runs on public_test_branch`);
    assert.equal(feedIf(name, feedNeeds(), { ...okInputs(), test_autopilot: true }), false, `${name} skips a test_autopilot run`);
    assert.equal(feedIf(name, feedNeeds({ 'map-mode': { result: 'success', outputs: { staged: 'false' } } }), okInputs()), false, `${name} skips what the chain did not stage`);
  }
  assert.equal(feedIf('feed-loader', feedNeeds(), okInputs()), true);
  assert.equal(feedIf('feed-loader', feedNeeds({ 'feed-plan': { result: 'success', outputs: { state: 'SKIP' } } }), okInputs()), false, 'a skipped plan builds nothing');
  assert.equal(feedIf('rig-feed', feedNeeds(), okInputs()), true);
  assert.equal(feedIf('rig-feed', feedNeeds(), { ...okInputs(), branch: 'public_test_branch' }), false, 'the feed rig is public only');
  assert.equal(feedIf('rig-feed', feedNeeds({ 'feed-loader': { result: 'failure', outputs: {} } }), okInputs()), false, 'no rig without the build');
  // It runs after the candidate rigs, in the same Steam group (the called rig carries the group), with the same plugin set.
  const rf = job('rig-feed');
  assert.match(rf, /\n {4}needs: \[map-mode, feed-plan, feed-loader, rig-branch, rig-other\]\n/);
  assert.match(rf, /\n {4}uses: \.\/\.github\/workflows\/sr-client-rig\.yml\n/);
  assert.deepEqual(mapOf(rf, 'secrets'), { STEAM_CI_USERNAME: '${{ secrets.STEAM_CI_USERNAME }}', STEAM_CI_LOGIN_CACHE: '${{ secrets.STEAM_CI_LOGIN_CACHE }}' });
  const w = mapOf(rf, 'with');
  assert.equal(w.tags, '${{ needs.map-mode.outputs.rig_tags }}', 'the same plugin set as the candidate rig');
  assert.equal(w.expect_refused, '${{ needs.map-mode.outputs.expect_refused }}', 'the same refusals as the public candidate rig');
  assert.equal(w.feed_artifact, 'map-mode-${{ inputs.branch }}');
  const rig = readFileSync(join(here, '..', '.github', 'workflows', 'sr-client-rig.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(rig, /concurrency:\n {6}group: sr-client-rig\n/);
});

test('feed gate: the loader is built from the release tag with the define set in CL, and the build log must prove it', () => {
  const l = job('feed-loader');
  assert.match(l, /\n {10}CL: \/DVMAP_TRUST_TEST_KEY \/Bt\+\n/, 'the define comes from the CL variable of the build step');
  assert.match(l, /ref: \$\{\{ needs\.feed-plan\.outputs\.sha \}\}/, 'the release tag commit, no branch');
  assert.match(l, /log_file: \$\{\{ env\.MSBUILD_LOG \}\}/);
  const check = l.slice(l.indexOf('- name: Check the define reached the compiler'));
  assert.ok(check.includes('c1xx'), 'the /Bt+ timing line is required');
  assert.ok(check.includes('version_feed'), 'the file that reads the define must have been compiled');
  assert.ok((check.match(/throw '/g) ?? []).length >= 3, 'the step throws when the proof is missing');
  assert.ok(l.indexOf('- name: Check the define reached the compiler') < l.indexOf('- name: Upload the loader for the rig'), 'the proof comes before the upload');
  assert.match(l, /retention-days: 1/, 'a rig input kept one day');
  assert.ok(!/gh release|upload-release|softprops|git (apply|am)\b|sed -i/.test(l), 'not a release asset, no patch');
  assert.ok(!/secrets\./.test(l), 'the build job holds no secret');
  assert.ok(!/\n {4}environment:/.test(l));
});

test('feed gate: no job of the feed path, and not the rig, can reach the release signing key', () => {
  for (const n of ['feed-plan', 'feed-loader', 'rig-feed', 'feed-gate']) {
    assert.ok(!/VMAP_SIGN_KEY/.test(job(n)), `${n} has no signing key`);
    assert.ok(!/secrets\.(?!STEAM_CI_USERNAME|STEAM_CI_LOGIN_CACHE)/.test(job(n)), `${n} reads no secret but the Steam pair`);
  }
  const rig = readFileSync(join(here, '..', '.github', 'workflows', 'sr-client-rig.yml'), 'utf8');
  assert.ok(!/VMAP_SIGN_KEY/.test(rig));
  const holders = [...wf.matchAll(/\n {2}([a-z][\w-]*):\n/g)].map((m) => m[1]).filter((n) => /secrets\.VMAP_SIGN_KEY(?!_TEST)/.test(job(n)));
  assert.deepEqual(holders, ['publish']);
});

// The plan job's script, run against a fake `gh` and the fixture feed and header.
// The signed TEST feed of the fixtures, and a header that holds the loader fixture's rows plus the
// feed's rows for CL-130001 (edit changes each function row), for the feed-plan comparisons.
const feedFixtureText = () => readFileSync(join(here, 'fixtures', 'vmap-sign', 'test-feed-k1.txt'), 'utf8').replaceAll('\r\n', '\n');
const headerWithFeedRows = (edit = (r) => r) => {
  const lines = feedFixtureText().split('\n');
  const feed = parseFeed([lines[0], ...lines.slice(2, -2), ''].join('\n'), 'feed');
  const base = parse(readFileSync(join(here, 'fixtures', 'version-map', 'loader.h'), 'utf8'), 'loader.h');
  return emit({ ...base, builds: base.builds.concat(feed.builds.filter((b) => b.cl === 130001)), functions: base.functions.concat(feed.functions.map(edit)), fields: base.fields.concat(feed.fields) });
};
const feedPlanRun = ({ cl, withFeed = true, tag = 'v9.9.9', header = null, ref = '', publish = 'true', refSha = 'b'.repeat(40) }) => {
  const dir = mkdtempSync(join(tmpdir(), 'feedplan-'));
  mkdirSync(join(dir, 'tool', 'ci'), { recursive: true });
  for (const f of readdirSync(here).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) copyFileSync(join(here, f), join(dir, 'tool', 'ci', f));
  mkdirSync(join(dir, 'chain'), { recursive: true });
  if (withFeed) writeFileSync(join(dir, 'chain', 'feed.test-signed.txt'), feedFixtureText());
  writeFileSync(join(dir, 'chain', 'decision.json'), JSON.stringify({ decision: 'M', cl }));
  if (header === null) copyFileSync(join(here, 'fixtures', 'version-map', 'loader.h'), join(dir, 'header-fixture.h'));
  else writeFileSync(join(dir, 'header-fixture.h'), header);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/bash',
    'printf "%s\\n" "$*" >> "$FAKE_DIR/calls.log"',
    'case "$*" in',
    '  *git/ref/heads/*) [ -n "$FAKE_REF_SHA" ] || exit 1; echo "$FAKE_REF_SHA" ;;',
    `  *releases/latest*) echo ${tag} ;;`,
    '  *contents/*) cat "$FAKE_DIR/header-fixture.h" ;;',
    `  *commits/*) echo ${'a'.repeat(40)} ;;`,
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  const out = join(dir, 'out.txt');
  writeFileSync(out, '');
  const r = spawnSync(bash, ['-c', runOf(job('feed-plan'), 'Plan the feed-path rig')], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, FAKE_DIR: dir, FAKE_REF_SHA: refSha, GITHUB_OUTPUT: out, MOD_OWNER: 'AlienXAXS', SEQ: '1761900000', RIG_TAGS: '', FEED_LOADER_REF: ref, PUBLISH: publish, PATH: bin + delimiter + process.env.PATH } });
  const o = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const calls = existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stderr: r.stderr, calls, ...o };
};

test('feed gate: the plan fails on a missing feed or a feed without the CL, and skips only when the feed adds and changes no row', { skip: !bash }, () => {
  const missing = feedPlanRun({ cl: 130001, withFeed: false });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.state, 'FAIL');
  assert.match(missing.reason, /no TEST-signed feed/);
  const noCl = feedPlanRun({ cl: 999999 });
  assert.equal(noCl.state, 'FAIL');
  assert.match(noCl.reason, /carries no build row for CL-999999/);
  // Identical rows: the loader runs the same with or without the feed.
  const same = feedPlanRun({ cl: 130001, header: headerWithFeedRows() });
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.state, 'SKIP');
  assert.match(same.reason, /adds no row and changes no row for CL-130001 compared with the compiled map of v9\.9\.9/);
  assert.equal(same.cl, '130001');
  // Rows the compiled map lacks: the feed delivers them, so the rig runs.
  const added = feedPlanRun({ cl: 130001 });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.state, 'RUN');
  assert.match(added.reason, /adds 3 and changes 0 rows for CL-130001 compared with the compiled map of v9\.9\.9: adds build; adds field ATest::Native; adds function Test::MapOnly/);
  assert.equal(added.owner, 'AlienXAXS');
  assert.equal(added.tag, 'v9.9.9');
  assert.equal(added.cl, '130001');
  assert.equal(added.seq, '1761900000');
  assert.match(added.sha, /^a{40}$/);
  // Rows the compiled map holds with other values: the feed changes them, so the rig runs.
  const changed = feedPlanRun({ cl: 130001, header: headerWithFeedRows((r) => ({ ...r, rva: r.rva + 8 })) });
  assert.equal(changed.state, 'RUN');
  assert.match(changed.reason, /adds 0 and changes 1 rows for CL-130001.*changes function Test::MapOnly/);
  const build = feedPlanRun({ cl: 128786 });
  assert.equal(build.state, 'RUN', 'a CL the tag has, with another build stamp in the feed');
  assert.match(build.reason, /adds 0 and changes 1 rows for CL-128786.*changes build/);
});

test('feed gate: a proof run builds a branch of the owner fork; publish on, a bad name or an unresolvable branch fail the plan', { skip: !bash }, () => {
  const ok = feedPlanRun({ cl: 130001, ref: 'strip-rows', publish: 'false' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.state, 'RUN');
  assert.equal(ok.owner, 'msantoro12', 'the fork, whatever MOD_OWNER says');
  assert.equal(ok.tag, 'ref-bbbbbbbbbbbb');
  assert.equal(ok.sha, 'b'.repeat(40));
  assert.match(ok.calls, /repos\/msantoro12\/StarRupture-ModLoader\/git\/ref\/heads\/strip-rows/);
  assert.match(ok.calls, new RegExp('repos/msantoro12/StarRupture-ModLoader/contents/.*ref=' + 'b'.repeat(40)));
  assert.ok(!/AlienXAXS/.test(ok.calls), 'nothing of the upstream repository is read');
  assert.match(ok.reason, /compiled map of the branch strip-rows \(ref-bbbbbbbbbbbb\)/);
  // No ref: the Latest release, as before.
  assert.ok(!/git\/ref/.test(feedPlanRun({ cl: 130001 }).calls));
  const pub = feedPlanRun({ cl: 130001, ref: 'strip-rows', publish: 'true' });
  assert.equal(pub.state, 'FAIL');
  assert.match(pub.reason, /refused with publish on/);
  assert.ok(!/git\/ref/.test(pub.calls), 'refused before anything is resolved');
  for (const bad of ['-x', '.hidden', 'a..b', 'a//b', 'a/', 'a.lock', 'a.', 'a b', 'a;rm -rf x', 'a$(id)', 'x'.repeat(101)]) {
    const r = feedPlanRun({ cl: 130001, ref: bad, publish: 'false' });
    assert.equal(r.state, 'FAIL', `refused: ${bad}`);
    assert.match(r.reason, /not a plain branch name/, bad);
  }
  for (const good of ['strip-rows', 'feat/no-rows', 'v1.2_x']) assert.equal(feedPlanRun({ cl: 130001, ref: good, publish: 'false' }).state, 'RUN', good);
  const gone = feedPlanRun({ cl: 130001, ref: 'nope', publish: 'false', refSha: '' });
  assert.equal(gone.state, 'FAIL');
  assert.match(gone.reason, /cannot resolve the branch nope of msantoro12\/StarRupture-ModLoader/);
  const junk = feedPlanRun({ cl: 130001, ref: 'nope', publish: 'false', refSha: 'zz' });
  assert.equal(junk.state, 'FAIL');
  assert.match(junk.reason, /does not resolve to a commit/);
});

test('feed_loader_ref: a dispatch input only; sr-watch cannot set it; checked early and again by the plan; the build follows the plan\'s owner', () => {
  assert.match(dispatch, /\n {6}feed_loader_ref:\n {8}description: [^\n]*msantoro12\/StarRupture-ModLoader[^\n]*\n {8}type: string\n {8}default: ''\n/);
  assert.ok(!call.includes('feed_loader_ref'), 'a call cannot pass it');
  assert.ok(!watch.slice(watch.indexOf('  client-check:\n')).includes('feed_loader_ref'), 'the unattended chain never sets it');
  const plan = job('plugin-plan');
  assert.ok(plan.indexOf('- name: Check the feed-path loader ref') > 0 && plan.indexOf('- name: Check the feed-path loader ref') < plan.indexOf('- name: Check out the plan tools'), 'refused before any other step');
  // Both reads of the input take it only from a run of this workflow itself.
  for (const j of [plan, job('feed-plan')]) assert.match(j, /FEED_LOADER_REF: \$\{\{ contains\(github\.workflow_ref, '\/\.github\/workflows\/sr-client-check\.yml@'\) && inputs\.feed_loader_ref \|\| '' \}\}/);
  assert.ok(job('feed-loader').includes('repository: ${{ needs.feed-plan.outputs.owner }}/StarRupture-ModLoader'));
  assert.ok(job('feed-loader').includes('LOADER_OWNER: ${{ needs.feed-plan.outputs.owner }}'));
});

test('feed_loader_ref: the early step refuses publish on and any name that is not a plain branch', { skip: !bash }, () => {
  const script = runOf(job('plugin-plan'), 'Check the feed-path loader ref');
  const run = (ref, publish) => sh(script, tmpdir(), { FEED_LOADER_REF: ref, PUBLISH: publish });
  assert.equal(run('strip-rows', 'false').status, 0);
  assert.equal(run('feat/no-rows', 'false').status, 0);
  assert.equal(run('strip-rows', 'true').status, 2, 'publish on');
  for (const bad of ['-x', 'a..b', 'a//b', 'a/', 'a.lock', 'a.', 'a b', 'a;id']) assert.equal(run(bad, 'false').status, 2, bad);
  assert.match(step(job('plugin-plan'), 'Check the feed-path loader ref'), /\n {8}if: \$\{\{ inputs\.feed_loader_ref != '' \}\}\n/);
});

test('feed gate: feed-plan and feed-gate run on a failed upstream job but not on a cancelled run', () => {
  for (const n of ['feed-plan', 'feed-gate']) {
    assert.ok(jobIf(n).includes('!cancelled()'), n);
    assert.ok(!jobIf(n).includes('always()'), n);
  }
});

// ------------------------------------------------------------ the feed-path loader trusts the TEST key: deleted after use

test('feed-loader-cleanup: runs after the rig on every outcome once the loader was built, deletes the artifact and checks it is gone', { skip: !bash }, () => {
  const j = job('feed-loader-cleanup');
  assert.match(j, /\n {4}needs: \[feed-loader, rig-feed, rig-feed-other\]\n/);
  const at = (over) => evalExpr(jobIf('feed-loader-cleanup'), { needs: feedNeeds(over), inputs: okInputs() });
  assert.equal(at({}), true, 'the rig passed');
  assert.equal(at({ 'rig-feed': { result: 'failure', outputs: { verdict: 'FAIL' } } }), true, 'the rig failed');
  assert.equal(at({ 'rig-feed': { result: 'skipped', outputs: {} } }), true, 'the rig was skipped');
  assert.equal(at({ 'rig-feed': { result: 'cancelled', outputs: {} } }), true, 'the run was cancelled');
  assert.equal(at({ 'feed-loader': { result: 'failure', outputs: {} } }), true, 'the build failed after its upload');
  assert.equal(at({ 'feed-loader': { result: 'skipped', outputs: {} } }), false, 'nothing was built: nothing to delete');
  assert.match(j, /\n {4}permissions:\n {6}actions: write\n/);
  // The artifact it removes is the one the loader job uploads.
  const up = job('feed-loader');
  assert.ok(up.includes('ARTIFACT: loader-feed-${{ inputs.branch }}') && j.includes('ARTIFACT: loader-feed-${{ inputs.branch }}'));
  assert.ok(!j.includes('secrets.') && !j.includes('uses:'), 'no secret, no third-party action');
  const script = runOf(j, 'Delete the artifact and check it is gone');
  const run = (ids, left) => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'gh'), [
      '#!/bin/bash',
      'printf "%s\\n" "$*" >> "$FAKE_DIR/calls.log"',
      'case "$*" in',
      '  *DELETE*) ;;',
      '  *"artifacts | length"*) echo "$FAKE_LEFT" ;;',
      '  *paginate*) for i in $FAKE_IDS; do echo "$i"; done ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(join(dir, 'bin', 'gh'), 0o755);
    const r = sh(script, dir, { FAKE_DIR: dir, FAKE_IDS: ids, FAKE_LEFT: left, GH_REPO: 'o/r', RUN_ID: '9', ARTIFACT: 'loader-feed-public', PATH: join(dir, 'bin') + delimiter + process.env.PATH });
    const calls = existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : [];
    rmSync(dir, { recursive: true, force: true });
    return { status: r.status, calls, out: r.stdout + r.stderr };
  };
  const two = run('11 12', '0');
  assert.equal(two.status, 0, two.out);
  assert.deepEqual(two.calls.filter((l) => l.includes('DELETE')), ['api -X DELETE repos/o/r/actions/artifacts/11', 'api -X DELETE repos/o/r/actions/artifacts/12']);
  assert.equal(run('', '0').status, 0, 'no artifact (the build failed before the upload) is fine');
  const stuck = run('11', '1');
  assert.equal(stuck.status, 1, 'an artifact that is still there fails the job');
  assert.match(stuck.out, /still there/);
});

// ------------------------------------------------------------ publish: the autopilot is read again from main right before signing

const autopilotStepRun = (text) => {
  const dir = mkdtempSync(join(tmpdir(), 'apstep-'));
  mkdirSync(join(dir, 'tool', 'ci'), { recursive: true });
  for (const f of readdirSync(here).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) copyFileSync(join(here, f), join(dir, 'tool', 'ci', f));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$FAKE_DIR/calls.log"\n[ -f "$FAKE_DIR/ap.json" ] && cat "$FAKE_DIR/ap.json" || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }\n');
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  if (text !== null) writeFileSync(join(dir, 'ap.json'), typeof text === 'string' ? text : JSON.stringify(text));
  const r = sh(runOf(job('publish'), 'Check the autopilot is still on'), dir, { FAKE_DIR: dir, GH_REPO: 'o/r', PATH: join(dir, 'bin') + delimiter + process.env.PATH });
  const calls = existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout + r.stderr, calls };
};

test('publish job: it reads state/autopilot.json on main again right before signing, and stops unless the autopilot is on for path M', { skip: !bash }, () => {
  const pub = job('publish');
  assert.ok(pub.indexOf('- name: Check the autopilot is still on') > pub.indexOf('- name: Refuse a test run'), 'after the test-run lock');
  assert.ok(pub.indexOf('- name: Check the autopilot is still on') < pub.indexOf('- name: Sign with the release key'), 'before anything is signed');
  const on = { schema: 1, enabled: true, paths: ['M'], max_releases_per_day: 2 };
  const ok = autopilotStepRun(on);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.calls, /repos\/o\/r\/contents\/state\/autopilot\.json\?ref=main/);
  const off = autopilotStepRun({ ...on, enabled: false });
  assert.equal(off.status, 2);
  assert.match(off.out, /turned off on main while this chain ran; nothing was signed/);
  const noM = autopilotStepRun({ ...on, paths: ['B'] });
  assert.equal(noM.status, 2);
  assert.match(noM.out, /path M is no longer enabled/);
  assert.equal(autopilotStepRun({ schema: 1, enabled: true }).status, 2, 'a malformed file');
  assert.equal(autopilotStepRun('not json').status, 2, 'not JSON');
  const gone = autopilotStepRun(null);
  assert.equal(gone.status, 2, 'unreadable');
  assert.match(gone.out, /cannot read state\/autopilot\.json on main; nothing was signed/);
});

const feedJudgeRun = (env) => {
  const dir = mkdtempSync(join(tmpdir(), 'feedjudge-'));
  const out = join(dir, 'out.txt');
  writeFileSync(out, '');
  const r = spawnSync(bash, ['-c', runOf(job('feed-gate'), 'Judge the feed path')], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(dir, 'sum.md'), RUN_URL: 'https://x/run/1', TAG: 'v9.9.9', CL: '130001', SEQ: '1761900000', PLAN_RESULT: 'success', PLAN_STATE: 'RUN', LOADER_RESULT: 'success', RIG_RESULT: 'success', RIG_VERDICT: 'PASS', ...env } });
  const o = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, ...o };
};

test('feed gate: the judge passes only on a plan RUN, a built loader and a PASS verdict of the feed rig', { skip: !bash }, () => {
  assert.equal(feedJudgeRun({}).state, 'PASS');
  const skip = feedJudgeRun({ PLAN_STATE: 'SKIP', PLAN_REASON: 'CL-1 is already in the compiled map of v1' });
  assert.deepEqual([skip.status, skip.state], [0, 'SKIP']);
  assert.match(skip.reason, /already in the compiled map/);
  for (const env of [{ PLAN_STATE: 'FAIL', PLAN_REASON: 'no feed' }, { PLAN_RESULT: 'failure' }, { PLAN_STATE: '' }, { LOADER_RESULT: 'failure' }, { LOADER_RESULT: 'skipped' }, { RIG_RESULT: 'failure', RIG_VERDICT: 'FAIL', RIG_REASON: 'the loader did not apply the feed' }, { RIG_RESULT: 'skipped', RIG_VERDICT: '' }, { RIG_VERDICT: '' }]) {
    const r = feedJudgeRun(env);
    assert.deepEqual([r.status, r.state], [1, 'FAIL'], JSON.stringify(env));
  }
});

test('proof_run: a dispatch input only; sr-watch cannot set it; it never publishes and never pushes the plain branch', () => {
  assert.match(dispatch, /\n {6}proof_run:\n {8}description: [^\n]*never publishes[^\n]*\n {8}type: boolean\n {8}default: false\n/);
  assert.ok(!call.includes('proof_run'), 'a call cannot pass it');
  assert.ok(!watch.includes('proof_run'), 'the unattended chain never sets it');
  // publish: never for a proof run, even with every gate passed and publish on; the unattended chain is unchanged.
  const pub = (inputs) => evalExpr(jobIf('publish'), { needs: okNeeds(), inputs: { ...okInputs(), ...inputs } });
  assert.equal(pub({}), true);
  assert.equal(pub({ proof_run: true }), false);
  assert.match(job('publish'), /\n {6}TEST_INPUT: \$\{\{ inputs\.test_autopilot == true \|\| inputs\.proof_run == true \}\}\n/, 'the lock step refuses it too');
  // The chain marks it a test, so nothing it plans is publishable.
  const mm = job('map-mode');
  assert.match(mm, /\n {6}PROOF: \$\{\{ inputs\.proof_run == true \}\}\n/);
  assert.ok(mm.includes('put("g3.json", { ok: true, cl, previousCl, ...(process.env.PROOF === "true" ? { proof: true } : {}) , ...(process.env.FIRST_PUBLISH === "true" ? { firstPublish: true } : {}) });') || mm.includes('...(process.env.PROOF === "true" ? { proof: true } : {}), ...(process.env.FIRST_PUBLISH === "true" ? { firstPublish: true } : {}) });'));
  // The push: the run-suffixed name only.
  const push = job('push-loader');
  assert.match(push, /\n {6}PROOF: \$\{\{ inputs\.proof_run == true \|\| needs\.map-mode\.outputs\.first_publish == 'true' \}\}\n/);
  assert.ok(runOf(push, 'Commit the header and push the branch').includes('--run-attempt "$RUN_ATTEMPT" --proof "$PROOF" --first-publish "$FIRST_PUBLISH")'));
  // The rest of the chain runs for it as for the unattended chain: nothing else keys on proof_run.
  for (const name of ['push-loader', 'candidate-loader', 'rig-branch', 'rig-other', 'feed-plan', 'feed-loader', 'rig-feed', 'feed-gate', 'rig-gate']) assert.ok(!jobIf(name).includes('proof_run'), name);
});

test('proof_run: map mode refuses it on another branch, with publish on or with test_autopilot', { skip: !bash }, () => {
  const j = job('map-mode');
  assert.ok(j.indexOf('- name: Refuse a proof run that could publish') < j.indexOf('- name: Check out the map tool'), 'refused before anything else');
  assert.match(step(j, 'Refuse a proof run that could publish'), /\n {8}if: \$\{\{ inputs\.proof_run == true \}\}\n/);
  const script = runOf(j, 'Refuse a proof run that could publish');
  const run = (env) => sh(script, tmpdir(), { BRANCH: 'public', PUBLISH: 'false', TEST_RUN: 'false', ...env });
  assert.equal(run({}).status, 0);
  for (const env of [{ PUBLISH: 'true' }, { TEST_RUN: 'true' }, { BRANCH: 'public_test_branch' }]) {
    const r = run(env);
    assert.equal(r.status, 2, JSON.stringify(env));
    assert.match(r.stdout, /::error::proof_run needs branch public, publish off and test_autopilot off/);
  }
});

test('proof_run: the write step takes only a CL the header already maps', { skip: !bash }, () => {
  const lines = writeStep();
  const at = lines.findIndex((l) => l.startsWith('# Whether the header already maps this run'));
  const end = lines.findIndex((l, i) => i > at && l.startsWith('if [ "$PROOF" = true ] && [ "$mapped" != true ]'));
  const block = lines.slice(at, end + 1).join('\n');
  assert.ok(at > 0 && end > at && block.endsWith('; fi'));
  assert.ok(lines.indexOf('status=0') > at, 'checked before the header is written');
  const header = parse(readFileSync(join(here, 'fixtures', 'version-map', 'loader.h'), 'utf8'), 'fixture');
  const known = header.builds[0].cl;
  const run = (cl, proof) => {
    const dir = carryDir({ 'observations.json': JSON.stringify({ cl }) });
    const r = sh(`set -euo pipefail\nheader=loader/StarRupture-ModLoader-Core/hooks/game/version_map.generated.h\n${block}\necho checked`, dir, { PROOF: proof, GITHUB_OUTPUT: join(dir, 'out.txt') });
    r.mapped = existsSync(join(dir, 'out.txt')) ? readFileSync(join(dir, 'out.txt'), 'utf8').trim() : '';
    return r;
  };
  assert.equal(run(known, 'true').status, 0);
  assert.equal(run(known, 'false').mapped, 'mapped=true', 'the step reports a CL the header maps (a first publish builds on it)');
  assert.equal(run(999999, 'false').mapped, 'mapped=false');
  const unknown = run(999999, 'true');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stdout, /::error::proof_run re-runs a CL the loader already maps, and the header has no build row for CL-999999/);
  assert.equal(run(999999, 'false').status, 0, 'any other run is not checked here');
});

// ------------------------------------------------------------ first publish (dispatch-only, one publish)

test('first_publish: a dispatch input only; sr-watch and calls cannot set it; the chain mark needs every condition, the base included', () => {
  assert.match(dispatch, /\n {6}first_publish:\n {8}description: [^\n]*\n {8}type: boolean\n {8}default: false\n/);
  assert.ok(!call.includes('first_publish'), 'a call cannot pass it');
  assert.ok(!watch.includes('first_publish'), 'the unattended chain never sets it');
  const expr = job('map-mode').match(/\n {6}FIRST_PUBLISH: (\$\{\{ [^\n]*\}\})\n/)[1];
  const mark = (inputs, workflow_ref = 'msantoro12/starrupture-ci/.github/workflows/sr-client-check.yml@refs/heads/main') =>
    evalExpr(expr, { needs: {}, inputs: { first_publish: true, branch: 'public', map_mode: true, publish: true, proof_run: false, test_autopilot: false, loader_repo: 'msantoro12/StarRupture-ModLoader', loader_ref: 'auto/update-129402-55-1', ...inputs }, github: { workflow_ref } });
  assert.equal(mark({}), true);
  for (const off of [{ first_publish: false }, { first_publish: null }, { branch: 'public_test_branch' }, { map_mode: false }, { publish: false }, { proof_run: true }, { test_autopilot: true }, { loader_repo: 'AlienXAXS/StarRupture-ModLoader' }, { loader_ref: 'main' }, { loader_ref: '' }]) assert.equal(mark(off), false, JSON.stringify(off));
  assert.equal(mark({}, SR_WATCH_REF), false, 'a run called from sr-watch is never a first publish');
});

test('first_publish: map-mode and push-loader judge the base again, and a first_publish dispatch that is not one stops there', { skip: !bash }, () => {
  const refuse = job('map-mode');
  const script = runOf(refuse, 'Refuse a first publish that is not one');
  assert.match(step(refuse, 'Refuse a first publish that is not one'), /\n {8}if: \$\{\{ inputs\.first_publish == true \}\}\n/);
  const run = (script, env = {}) => sh(script, tmpdir(), { FIRST_PUBLISH: 'true', LOADER_REPO: 'msantoro12/StarRupture-ModLoader', PUSH_REPO: 'msantoro12/StarRupture-ModLoader', LOADER_REF: 'auto/update-129402-55-1', ...env });
  assert.equal(run(script).status, 0);
  assert.equal(run(script, { FIRST_PUBLISH: 'false' }).status, 2, 'the mark did not come out true');
  assert.equal(run(script, { LOADER_REPO: 'AlienXAXS/StarRupture-ModLoader' }).status, 2);
  for (const ref of ['main', 'auto/update-1-2', 'auto/update-1-2-3\nmain', 'auto/update-1-2-3\n::warning::x']) assert.equal(run(script, { LOADER_REF: ref }).status, 2, JSON.stringify(ref));
  const push = job('push-loader');
  const pushScript = runOf(push, 'Check the first-publish base');
  assert.match(step(push, 'Check the first-publish base'), /\n {8}if: \$\{\{ needs\.map-mode\.outputs\.first_publish == 'true' \}\}\n/);
  assert.ok(push.indexOf('- name: Check the first-publish base') < push.indexOf('- name: Check the deploy key'), 'before the deploy key is read');
  assert.equal(run(pushScript).status, 0);
  assert.equal(run(pushScript, { LOADER_REPO: 'AlienXAXS/StarRupture-ModLoader' }).status, 2);
  assert.equal(run(pushScript, { LOADER_REF: 'auto/update-1-2-3\nmain' }).status, 2);
});

test('first_publish: a refused one never reaches the Steam login, and a second one waits for the first', () => {
  assert.match(jobIf('check'), /\(inputs\.first_publish != true \|\| needs\.plugin-plan\.result == 'success'\)/);
  const check = job('check');
  assert.match(check, /\n {4}needs: \[[^\]]*plugin-plan[^\]]*\]\n/);
  const co = (inputs, planResult) => evalExpr(jobIf('check'), { needs: { build: { result: 'success' }, 'plugin-plan': { result: planResult } }, inputs: { branch: 'public', ...inputs } });
  assert.equal(co({ first_publish: true }, 'success'), true);
  assert.equal(co({ first_publish: true }, 'failure'), false, 'a first publish plugin-plan refused');
  assert.equal(co({ first_publish: false }, 'failure'), true, 'an ordinary run does not wait on it');
  // One group for every first publish, held for the whole run; any other run has its own.
  const group = wf.match(/\nconcurrency:\n {2}group: ([^\n]*)\n {2}cancel-in-progress: false\n/);
  assert.ok(group, 'a workflow-level concurrency group');
  assert.match(group[1], /inputs\.first_publish == true && 'sr-first-publish' \|\| format\('sr-run-\{0\}-\{1\}-\{2\}', github\.run_id, github\.run_attempt, inputs\.branch\)/);
});

test('first_publish: the plugin-plan step refuses what is not a first publish, a base outside the fork, a base without the other build\'s rows, and a feed that exists', { skip: !bash }, () => {
  const script = runOf(job('plugin-plan'), 'Check a first publish');
  assert.match(step(job('plugin-plan'), 'Check a first publish'), /\n {8}if: \$\{\{ inputs\.first_publish == true \}\}\n/);
  const header = (cls) => {
    const m = emptyMap('loader', 127004);
    addBuild(m, { cl: 127004, stamp: 1, size: 2, source: 'public 25646882' });
    if (cls.includes(129402)) addBuild(m, { cl: 129402, stamp: 3, size: 4, source: 'steam_build 26271156' });
    for (const cl of cls) addFunction(m, { key: 'K', kind: 1, cl, pattern: '48 ??', rva: 0x10 });
    return emit(m);
  };
  const both = header([127004, 129402]);
  const proofOnly = header([127004]);
  const run = (env = {}, { release = '404', base = both, live = '26271156' } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'first-publish-'));
    mkdirSync(join(dir, 'bin'));
    cpSync(here, join(dir, 'tool', 'ci'), { recursive: true, filter: (src) => !/[\\/]fixtures([\\/]|$)/.test(src) });
    mkdirSync(join(dir, 'tool', '.github', 'sr-pipeline'), { recursive: true });
    writeFileSync(join(dir, 'tool', '.github', 'sr-pipeline', 'poll-steam.mjs'), "console.error('live read: ' + process.argv.slice(2).join(' '));\nconsole.log(process.argv[3] === 'public' ? '25646882' : process.env.STUB_LIVE);\n");
    writeFileSync(join(dir, 'base.src'), base);
    writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/bash\nr="' + release + '"\nif [ "$2" = -H ]; then cat base.src; exit 0; fi\nif [ "$r" = 404 ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi\nif [ "$r" = feed ]; then echo \'{"assets":[{"name":"version-map-client.v1.txt"}]}\'; exit 0; fi\nif [ "$r" = empty ]; then echo \'{"assets":[]}\'; exit 0; fi\necho "gh: boom" >&2; exit 1\n');
    chmodSync(join(dir, 'bin', 'gh'), 0o755);
    return sh(script, dir, { PATH: join(dir, 'bin') + delimiter + process.env.PATH, BRANCH: 'public', MAP_MODE: 'true', PUBLISH: 'true', PROOF: 'false', TEST_RUN: 'false', LOADER_REPO: 'msantoro12/StarRupture-ModLoader', LOADER_REF: 'auto/update-129402-55-1', BUILDID: '', OTHER_BUILDID: '', STUB_LIVE: live, GH_TOKEN: 'x', GH_REPO: 'o/r', ...env });
  };
  const good = run();
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /The base holds 1 function rows for CL-129402/);
  assert.match(good.stderr, /live read: --live-buildid public_test_branch/, 'the other branch\'s live id is read when the dispatch names none');
  assert.equal(run({}, { release: 'empty' }).status, 0, 'a release without a feed');
  assert.equal(run({ OTHER_BUILDID: '26271156', BUILDID: '25646882' }, { live: '' }).status, 0, 'the inputs are used and Steam is not asked');
  for (const env of [{ BRANCH: 'public_test_branch' }, { MAP_MODE: 'false' }, { PUBLISH: 'false' }, { PROOF: 'true' }, { TEST_RUN: 'true' }]) {
    const r = run(env);
    assert.equal(r.status, 2, JSON.stringify(env));
    assert.match(r.stdout, /first_publish needs branch public, map_mode and publish on, proof_run and test_autopilot off/);
  }
  assert.equal(run({ LOADER_REPO: 'AlienXAXS/StarRupture-ModLoader' }).status, 2, 'only the fork');
  // The whole value must match: a newline cannot carry a second line past the pattern, and nothing is echoed back.
  for (const ref of ['main', 'auto/update-129402', 'auto/update-129402-55-1-x', 'feat/x', 'main\nauto/update-1-2-3', 'auto/update-1-2-3\n::warning::x', 'auto/update-1-2-3\n']) {
    const r = run({ LOADER_REF: ref });
    assert.equal(r.status, 2, JSON.stringify(ref));
    assert.ok(!r.stdout.includes('::warning::x'), 'the value is not echoed');
  }
  const have = run({}, { release: 'feed' });
  assert.equal(have.status, 2);
  assert.match(have.stdout, /vmap-feed release already carries a feed/);
  assert.equal(run({}, { release: 'err' }).status, 2, 'an unreadable release is not a 404');
  // B1: a base that has no rows for the other branch's live build (a proof-run branch of CL-127004 only) is refused, with the reason.
  const proof = run({}, { base: proofOnly });
  assert.equal(proof.status, 2);
  assert.match(proof.stdout, /first_publish is refused: the base branch has no build row for build 26271156, the build the other Steam branch runs now/);
  // A build row without function rows is no base either.
  const noRows = (() => { const m = parse(both, 'x'); m.functions = m.functions.filter((r) => r.cl !== 129402); return emit(m); })();
  const bare = run({}, { base: noRows });
  assert.equal(bare.status, 2);
  assert.match(bare.stdout, /holds no function rows for CL-129402/);
  // Both branches on one build: the feed would carry one build.
  const same = run({ OTHER_BUILDID: '25646882', BUILDID: '25646882' });
  assert.equal(same.status, 2);
  assert.match(same.stdout, /run the same build/);
  // An unreadable live id stops it too.
  assert.equal(run({}, { live: '' }).status, 2, 'no live id');
});

test('first_publish: map-mode proves the other build twice, before anything is exported and again on the signed feed', { skip: !bash }, () => {
  const mm = job('map-mode');
  const first = mm.indexOf('if [ "$FIRST_PUBLISH" = true ]; then\n            [ -n "$other_cl" ] ||');
  assert.ok(first > 0 && first < mm.indexOf('node tool/ci/version-map.mjs export-feed'), 'before the export');
  const second = mm.indexOf('[ -n "$other_cl" ] && [ "$other_cl" != "$cl" ] ||');
  assert.ok(second > mm.indexOf('feed.test-signed.txt'), 'again on the feed signed with the TEST key');
  assert.ok(mm.includes(`' "$cl" "$other_cl"`), 'the feed is checked for the other branch\'s CL, not the header\'s built CL (the same on every branch)');
  // The proof block, run against headers.
  const start = mm.indexOf('          if [ "$FIRST_PUBLISH" = true ]; then\n            [ -n "$other_cl" ] ||');
  const end = mm.indexOf('          fi\n', start) + '          fi\n'.length;
  const block = mm.slice(start, end).replace(/^ {10}/gm, '');
  const header = (cls) => {
    const m = emptyMap('loader', 127004);
    addBuild(m, { cl: 127004, stamp: 1, size: 2, source: 'public 25646882' });
    if (cls.includes(129402)) addBuild(m, { cl: 129402, stamp: 3, size: 4, source: 'steam_build 26271156' });
    for (const cl of cls) addFunction(m, { key: 'K', kind: 1, cl, pattern: '48 ??', rva: 0x10 });
    return emit(m);
  };
  const runWith = ({ cls, otherCl, cl = '127004' }) => {
    const dir = mkdtempSync(join(tmpdir(), 'first-proof-'));
    cpSync(here, join(dir, 'tool', 'ci'), { recursive: true, filter: (src) => !/[\\/]fixtures([\\/]|$)/.test(src) });
    writeFileSync(join(dir, 'h.h'), header(cls));
    return sh('set -euo pipefail\nheader=h.h\nother_buildid=26271156\nother_cl="' + otherCl + '"\ncl="' + cl + '"\n' + block + 'echo proved', dir, { FIRST_PUBLISH: 'true' });
  };
  assert.equal(runWith({ cls: [127004, 129402], otherCl: '129402' }).status, 0);
  const none = runWith({ cls: [127004], otherCl: '' });
  assert.equal(none.status, 2, 'a 127004-only proof branch has no row for the other build');
  assert.match(none.stdout, /first_publish is refused: the base header has no build row for build 26271156/);
  const same = runWith({ cls: [127004, 129402], otherCl: '127004' });
  assert.equal(same.status, 2);
  assert.match(same.stdout, /run the same CL-127004/);
  const bare = runWith({ cls: [127004], otherCl: '129402' });
  assert.equal(bare.status, 2);
  assert.match(bare.stdout, /holds no function rows for CL-129402/);
});

test('first_publish: the feed is uploaded without --clobber, so a feed that is there is never replaced; any other publish replaces it', { skip: !bash }, () => {
  const upload = (first) => {
    const fx = publishFixture();
    writeFileSync(join(fx.dir, 'last-seq.txt'), '0\n');
    const r = runPublishStep(fx, 'Sign with the release key, verify, publish', { FIRST_PUBLISH: first });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return callsOf(fx.dir).filter((c) => c.startsWith('gh release upload vmap-feed version-map-client.v1.txt'));
  };
  assert.deepEqual(upload('true'), ['gh release upload vmap-feed version-map-client.v1.txt']);
  assert.deepEqual(upload('false'), ['gh release upload vmap-feed version-map-client.v1.txt --clobber']);
});

test('first_publish: the publish job never reads the autopilot, refuses a chain mark that disagrees, and refuses when a feed is published', { skip: !bash }, () => {
  const pub = job('publish');
  assert.match(step(pub, 'Check the autopilot is still on'), /\n {8}if: \$\{\{ env\.FIRST_PUBLISH != 'true' \}\}\n/);
  assert.match(step(pub, 'Check that no feed is published yet'), /\n {8}if: \$\{\{ env\.FIRST_PUBLISH == 'true' \}\}\n/);
  const run = (decision, first) => {
    const fx = publishFixture();
    writeFileSync(join(fx.dir, 'chain', 'decision.json'), JSON.stringify(decision));
    return runPublishStep(fx, 'Refuse a test run', { TEST_INPUT: 'false', FIRST_PUBLISH: first }).status;
  };
  assert.equal(run({ decision: 'M', cl: 1, candidate: true, wouldBe: 'M', firstPublish: true }, 'true'), 0);
  assert.equal(run({ decision: 'M', cl: 1, candidate: true, wouldBe: 'M' }, 'true'), 2, 'a chain that was not a first publish');
  assert.equal(run({ decision: 'M', cl: 1, candidate: true, wouldBe: 'M', firstPublish: true }, 'false'), 2, 'a first-publish chain in an ordinary run');
  // The feed check: a stubbed gh that answers {} (a release, no assets) passes; one that finds the feed asset refuses.
  const feedStep = (assets) => {
    const fx = publishFixture();
    writeFileSync(join(fx.dir, 'bin', 'gh'), `#!/bin/bash\necho '${JSON.stringify({ assets })}'\nexit 0\n`);
    return runPublishStep(fx, 'Check that no feed is published yet', { FIRST_PUBLISH: 'true' });
  };
  assert.equal(feedStep([]).status, 0);
  const had = feedStep([{ name: 'version-map-client.v1.txt' }]);
  assert.equal(had.status, 2);
  assert.match(had.stdout, /already carries a feed; nothing was signed/);
});

test('feed gate: two legs, the CL the run checked and the CL of the other branch; any failed leg fails the gate, a skipped leg does not', { skip: !bash }, () => {
  const one = feedJudgeRun({ OTHER_STATE: 'RUN', OTHER_CL: '129402', OTHER_RIG_RESULT: 'success', OTHER_RIG_VERDICT: 'PASS' });
  assert.deepEqual([one.status, one.state], [0, 'PASS']);
  assert.match(one.reason, /CL-130001: .*CL-130001.*; CL-129402: .*CL-129402/);
  assert.ok(!/public/.test(one.reason), 'a leg is named by its CL, never by a Steam branch');
  const bad = feedJudgeRun({ OTHER_STATE: 'RUN', OTHER_CL: '129402', OTHER_RIG_RESULT: 'failure', OTHER_RIG_VERDICT: 'FAIL', OTHER_RIG_REASON: 'no rows for CL-129402' });
  assert.deepEqual([bad.status, bad.state], [1, 'FAIL']);
  assert.match(bad.reason, /CL-129402: no rows for CL-129402/);
  const skipped = feedJudgeRun({ OTHER_STATE: 'SKIP', OTHER_REASON: 'CL-129402 is already in the compiled map of v9.9.9' });
  assert.deepEqual([skipped.status, skipped.state], [0, 'PASS'], 'the checked leg passed, the other leg has nothing to test');
  const both = feedJudgeRun({ PLAN_STATE: 'SKIP', PLAN_REASON: 'a', OTHER_STATE: 'SKIP', OTHER_REASON: 'b' });
  assert.equal(both.state, 'SKIP');
  const failedPlan = feedJudgeRun({ OTHER_STATE: 'RUN', OTHER_RIG_RESULT: 'success', OTHER_RIG_VERDICT: 'PASS', RIG_RESULT: 'failure', RIG_VERDICT: 'FAIL' });
  assert.equal(failedPlan.state, 'FAIL', 'the other leg passing does not cover a failed first leg');
  const gate = job('feed-gate');
  assert.match(gate, /\n {4}needs: \[[^\]]*rig-feed-other[^\]]*\]\n/);
});

test('feed gate: the alert names a gate that did not pass and notes a skip', () => {
  const a = job('alert');
  assert.match(a, /FEED_GATE_RESULT: \$\{\{ needs\.feed-gate\.result \}\}/);
  assert.match(a, /FEED_EXPECTED: \$\{\{ needs\.map-mode\.result == 'success'[^}]*inputs\.branch == 'public' \}\}/);
  assert.ok(a.includes('feed-path rig gate** did not pass'));
  assert.ok(a.includes('Feed-path rig gate **skipped**'));
});

test('key sources: SR_KEY_SOURCE_BUILD is defined by the two key-source build steps and by no other build', () => {
  const code = wf.replace(/^ *#.*\n/gm, '');
  const steps = code.split(/\n {6}- /);
  const defining = steps.filter((s) => s.includes('SR_KEY_SOURCE_BUILD')).map((s) => s.match(/name: (.*)/)[1]);
  assert.deepEqual(defining, ['Build the key source (Client Release)', 'Build the key-scan build (Client Release)']);
  for (const s of steps.filter((x) => x.includes('SR_KEY_SOURCE_BUILD'))) assert.match(s, /\n {8}env:\n {10}CL: \/DSR_KEY_SOURCE_BUILD\n/);
  // Both steps are in the key-sources job, so no other job (candidate loader, plugins, scanner, rig) gets it.
  assert.equal(job('key-sources').replace(/^ *#.*\n/gm, '').split('SR_KEY_SOURCE_BUILD').length - 1, 2);
  assert.equal(code.split('SR_KEY_SOURCE_BUILD').length - 1, 2, 'no job-level or workflow-level define');
  // The key source carries a version that stands out in ModLoader.log.
  assert.match(runOf(job('key-sources'), 'Build the key source (Client Release)'), /\/p:ModLoaderBuildTag=keysource `/);
});

test('the keys step appends ModLoader\'s native keys to keys-ModLoader.txt, as it does for each plugin', () => {
  const loaderKeys = wf.indexOf("Invoke-Native 'keys (loader)'");
  const add = wf.indexOf("if ($native.ContainsKey('ModLoader')) { Add-Content \"$work\\keys-ModLoader.txt\" $native['ModLoader'] }");
  assert.ok(loaderKeys > 0 && add > loaderKeys, 'ModLoader keys are appended right after the loader key list is written');
  assert.ok(add < wf.indexOf("$components.Add('ModLoader')"));
  assert.ok(wf.includes('if ($native.ContainsKey($m.name)) { Add-Content "$work\\keys-$($m.name).txt" $native[$m.name] }'));
});

// ------------------------------------------------------------ the stored reference layout (public has no older build to scan)

test('layout-store: the writer job runs only for a successful public map-mode check on main, with the job token and no environment or secret', () => {
  const whole = job('layout-store');
  const j = whole.slice(0, whole.indexOf('\n\n  #') < 0 ? undefined : whole.indexOf('\n\n  #') + 1); // without the comment block of the next job
  const ifOf =(over = {}, github = { ref: 'refs/heads/main' }, needs = { check: { result: 'success' } }) =>
    evalExpr(jobIf('layout-store'), { needs, inputs: { map_mode: true, branch: 'public', ...over }, github });
  assert.equal(ifOf(), true);
  assert.equal(ifOf({ map_mode: false }), false, 'a check without map mode');
  assert.equal(ifOf({ branch: 'public_test_branch' }), false, 'only the public build is stored');
  assert.equal(ifOf({}, { ref: 'refs/heads/fix/x' }), false, 'a run of another branch');
  assert.equal(ifOf({}, { ref: 'refs/pull/5/merge' }), false, 'a pull request ref');
  assert.equal(ifOf({}, undefined, { check: { result: 'failure' } }), false, 'a failed check');
  assert.equal(ifOf({}, undefined, { check: { result: 'skipped' } }), false);
  assert.match(j, /\n {4}needs: \[check, key-sources-plan\]\n/);
  assert.match(j, /\n {4}permissions:\n {6}contents: write\n {4}[a-z]/, 'contents: write and no other permission');
  assert.ok(!/\n {4}environment:/.test(j), 'no environment');
  assert.ok(!/secrets\./.test(j), 'no secret');
  assert.match(j, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  // The only code it runs is this repository's ci/ at main; the only thing it writes is a layout asset of the vmap-layouts release.
  const checkouts = [...j.matchAll(/uses: actions\/checkout@[^\n]*\n {8}with:\n((?: {10}[^\n]*\n)+)/g)].map((m) => m[1]);
  assert.equal(checkouts.length, 1);
  assert.ok(!/repository:|ref:/.test(checkouts[0]), 'the default checkout: this repository at the run\'s ref (main)');
  assert.deepEqual([...j.matchAll(/gh release (?:upload|create|edit|delete) (\S+)( \S+)?/g)].map((m) => m[0]).filter((x) => !x.startsWith('gh release create')),
    ['gh release upload vmap-layouts "$name"']);
  assert.ok(j.includes('gh release upload vmap-layouts "$name" --clobber'), 'a new asset or an extended one');
  assert.deepEqual([...j.matchAll(/gh api (\S+)/g)].map((m) => m[1]), ['"repos/$GH_REPO/releases/tags/vmap-layouts"'], 'the only API call is a read of the release');
  assert.ok(!/gh api[^\n]*(-X|--method|-f |-F |--input)/.test(j));
  assert.ok(j.includes('gh release create vmap-layouts --latest=false'), 'the new release never becomes the repository\'s Latest');
  assert.ok(!/environment: vmap-sign|VMAP_SIGN_KEY/.test(j));
  assert.ok(!/layout-store/.test(job('alert')), 'a store problem is not an alert of the update chain');
  // No pull request trigger: a fork cannot start any run of this workflow.
  const triggers = wf.slice(0, wf.indexOf('\njobs:\n'));
  assert.ok(!/^ {2}pull_request(_target)?:/m.test(triggers));
});

test('layout-store: the writer extends a stored CL only with the same exe and an Actions upload, and never overwrites another', { skip: !bash }, () => {
  const script = runOf(job('layout-store'), 'Store the layout');
  assert.match(script, /--existing "stored\/\$name" --release stored\/release\.json/);
  assert.ok(!/download[^\n]*\|\| true/.test(script), 'a stored asset that cannot be downloaded fails the job');
  const BOT = { login: 'github-actions[bot]', type: 'Bot' };
  const fixtures = (sha) => ({
    'res/result.json': { download: { betaKey: 'public', installed: true, buildid: '25646882' }, checks: { exe: { cl: '127004', sha256: sha, productVersion: '1.0-CL-127004' } } },
    'res/scanner.json': { exe: { cl: 127004, imageStamp: 1760600498, imageSize: 171909120 } },
    'res/layout-target.json': { keys: [{ key: 'AFoo::Bar', result: 'OK', offset: 16, size: 8, boolMask: 0 }] },
  });
  const run = (sha, stored, o = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'lstore-'));
    const files = fixtures(sha);
    cpSync(here, join(dir, 'tool', 'ci'), { recursive: true });
    if (stored) files['stored-asset.json'] = stored;
    const listed = o.listed ?? Boolean(stored);
    files['release-api.json'] = { assets: listed ? [{ name: 'layout-CL-127004.json', size: Buffer.byteLength(stored ?? ''), uploader: o.uploader === undefined ? BOT : o.uploader }] : [] };
    // The fake release: `api` lists the stored asset, a download of `stored` gives it (or fails), a download into `verify` gives back what was uploaded (or something else).
    const gh = `#!/bin/bash
echo "$*" >> "$FAKE_DIR/calls.log"
if [ "$1" = api ]; then cat "$FAKE_DIR/release-api.json"; exit 0; fi
if [ "$1 $2" = "release view" ]; then exit 0; fi
if [ "$1 $2" = "release download" ]; then
  if [ "$7" = verify ]; then if [ -n "\${TAMPER:-}" ]; then echo '{}' > "$7/$5"; else cp "$FAKE_DIR/uploaded.json" "$7/$5"; fi; exit 0; fi
  if [ -n "\${FAIL_DOWNLOAD:-}" ] || [ ! -f "$FAKE_DIR/stored-asset.json" ]; then echo "gh: download failed" >&2; exit 1; fi
  cp "$FAKE_DIR/stored-asset.json" "$7/$5"; exit 0
fi
if [ "$1 $2" = "release upload" ]; then cp "$4" "$FAKE_DIR/uploaded.json" ; exit 0; fi
exit 1
`;
    for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content)); }
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'gh'), gh);
    chmodSync(join(dir, 'bin', 'gh'), 0o755);
    const r = spawnSync(bash, ['-c', script], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, FAKE_DIR: dir, GH_REPO: 'msantoro12/starrupture-ci', RUN_ID: '42', WORKFLOW_SHA: 'f'.repeat(40), PATH: join(dir, 'bin') + delimiter + process.env.PATH, ...(o.env ?? {}) } });
    return { r, dir, uploaded: existsSync(join(dir, 'uploaded.json')) ? JSON.parse(readFileSync(join(dir, 'uploaded.json'), 'utf8')) : null };
  };
  const first = run('a'.repeat(64));
  assert.equal(first.r.status, 0, first.r.stderr);
  assert.equal(first.uploaded.cl, 127004);
  assert.equal(first.uploaded.exeSha256, 'a'.repeat(64));
  assert.equal(first.uploaded.run, 42);
  assert.equal(first.uploaded.keys.length, 1);
  const again = run('a'.repeat(64), JSON.stringify({ ...first.uploaded, keys: [{ key: 'AFoo::Old', result: 'OK', offset: 8, size: 8, boolMask: 0 }] }));
  assert.equal(again.r.status, 0, again.r.stderr);
  assert.deepEqual(again.uploaded.keys.map((k) => k.key), ['AFoo::Bar', 'AFoo::Old'], 'the same exe: the older keys stay');
  const other = run('b'.repeat(64), JSON.stringify(first.uploaded));
  assert.notEqual(other.r.status, 0, 'another exe for a stored CL fails the job');
  assert.equal(other.uploaded, null, 'and nothing is uploaded');
  assert.match(other.r.stderr, /already stored for another exe/);
  assert.ok(calls(first.dir).some((l) => l.startsWith('release upload vmap-layouts layout-CL-127004.json --clobber')));
  // A stored asset that is not from an Actions job is not carried into a trusted one.
  const hand = run('a'.repeat(64), JSON.stringify(first.uploaded), { uploader: { login: 'someone', type: 'User' } });
  assert.notEqual(hand.r.status, 0);
  assert.equal(hand.uploaded, null);
  assert.match(hand.r.stderr, /not trusted/);
  // A listed asset that cannot be downloaded fails the job; it is not replaced by a record of this run alone.
  const broken = run('a'.repeat(64), JSON.stringify(first.uploaded), { env: { FAIL_DOWNLOAD: '1' } });
  assert.notEqual(broken.r.status, 0);
  assert.equal(broken.uploaded, null);
  // The same keys again: the stored asset stays as it is.
  const same = run('a'.repeat(64), JSON.stringify(first.uploaded));
  assert.equal(same.r.status, 0, same.r.stderr);
  assert.equal(same.uploaded, null);
  assert.match(same.r.stdout, /nothing to upload/);
  // An upload that does not read back the same fails the job.
  const tampered = run('a'.repeat(64), undefined, { env: { TAMPER: '1' } });
  assert.notEqual(tampered.r.status, 0);
  assert.match(tampered.r.stdout, /::error title=Layout store::.*is not the file that was uploaded/);
});

test('layout-store: a build the artifact does not describe fails the job, because Steam will not serve it again', { skip: !bash }, () => {
  const script = runOf(job('layout-store'), 'Store the layout');
  const dir = mkdtempSync(join(tmpdir(), 'lstore-'));
  const r = sh(script, dir, {});
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error title=Layout store::.*nothing is stored/);
});

test('stored_reference: a dispatch input only, and every condition is in the switch that reads the store', () => {
  assert.match(dispatch, /\n {6}stored_reference:\n {8}description: [^\n]*\n {8}type: boolean\n {8}default: false\n/);
  assert.ok(!call.includes('stored_reference'), 'a call cannot pass it');
  assert.ok(!watch.includes('stored_reference'), 'the unattended chain never sets it');
  const expr = job('map-mode').match(/\n {6}STORED_REFERENCE: (\$\{\{ [^\n]*\}\})\n/)[1];
  const dispatched = { workflow_ref: 'msantoro12/starrupture-ci/.github/workflows/sr-client-check.yml@refs/heads/main' };
  const on = (inputs, github = dispatched) => evalExpr(expr, { needs: {}, inputs: { stored_reference: true, branch: 'public_test_branch', map_mode: true, publish: false, proof_run: false, test_autopilot: true, ...inputs }, github });
  assert.equal(on({}), true);
  for (const off of [{ stored_reference: false }, { stored_reference: null }, { branch: 'public' }, { branch: 'expiry-only' }, { map_mode: false }, { publish: true }, { test_autopilot: false }, { proof_run: true }]) {
    assert.equal(on(off), false, JSON.stringify(off));
  }
  assert.equal(on({}, { workflow_ref: SR_WATCH_REF }), false, 'a run called from sr-watch');
  // The chain step reads the store for no other reason than the switch, or a public run with no other reference.
  const chain = runOf(job('map-mode'), 'Decide, export, sign, stage and plan the promotion');
  assert.ok(chain.includes('if [ "$STORED_REFERENCE" = true ]; then from_store\n'));
  assert.ok(chain.includes('elif [ "$BRANCH" = public ]; then from_store\n'));
  assert.equal(chain.match(/from_store$/gm)?.length, 2);
});

test('stored_reference: the plan guard and the map-mode lock refuse every run that is not a test run of another branch than public', { skip: !bash }, () => {
  const plan = job('plugin-plan');
  assert.match(step(plan, 'Check the stored reference'), /\n {8}if: \$\{\{ inputs\.stored_reference == true \}\}\n/);
  const guard = runOf(plan, 'Check the stored reference');
  const good = { DISPATCHED: 'true', BRANCH: 'public_test_branch', MAP_MODE: 'true', PUBLISH: 'false', PROOF: 'false', TEST_RUN: 'true' };
  assert.equal(sh(guard, tmpdir(), good).status, 0);
  for (const bad of [{ BRANCH: 'public' }, { PUBLISH: 'true' }, { TEST_RUN: 'false' }, { MAP_MODE: 'false' }, { PROOF: 'true' }, { DISPATCHED: 'false' }]) {
    const r = sh(guard, tmpdir(), { ...good, ...bad });
    assert.equal(r.status, 2, JSON.stringify(bad));
    assert.match(r.stdout, /::error::stored_reference needs/);
  }
  const mm = job('map-mode');
  assert.match(step(mm, 'Refuse a stored reference that is not a test run'), /\n {8}if: \$\{\{ inputs\.stored_reference == true \}\}\n/);
  const lock = runOf(mm, 'Refuse a stored reference that is not a test run');
  assert.equal(sh(lock, tmpdir(), { STORED_REFERENCE: 'true' }).status, 0);
  assert.equal(sh(lock, tmpdir(), { STORED_REFERENCE: 'false' }).status, 2, 'the switch did not come out true');
  assert.ok(mm.indexOf('- name: Refuse a stored reference that is not a test run') < mm.indexOf('- name: Download the scans'), 'before any artifact is read');
  // A refused run never reaches the Steam login.
  const co = (inputs, planResult) => evalExpr(jobIf('check'), { needs: { build: { result: 'success' }, 'plugin-plan': { result: planResult } }, inputs: { branch: 'public_test_branch', ...inputs } });
  assert.equal(co({ stored_reference: true }, 'success'), true);
  assert.equal(co({ stored_reference: true }, 'failure'), false);
  assert.equal(co({ stored_reference: false }, 'failure'), true, 'an ordinary run does not wait on it');
});

test('field rows: where the reference layout comes from, run against a stand-in for the release', { skip: !bash }, () => {
  const chain = runOf(job('map-mode'), 'Decide, export, sign, stage and plan the promotion');
  const block = chain.slice(chain.indexOf('base=()\n'), chain.indexOf('fr=0\n'));
  assert.ok(block.length > 200 && block.includes('from_store()'));
  const bot = { login: 'github-actions[bot]', type: 'Bot' };
  const sha = 'a'.repeat(64);
  const headerText = readFileSync(join(here, 'fixtures', 'version-map', 'loader.h'), 'utf8');
  const record = JSON.stringify(buildRecord({
    result: { download: { betaKey: 'public', installed: true, buildid: '25646882' }, checks: { exe: { cl: '127004', sha256: sha } } },
    scanner: { exe: { cl: 127004, imageStamp: 1760600498, imageSize: 171909120 } },
    layoutText: JSON.stringify({ keys: [{ key: 'ACrCrafter::CraftComponent', result: 'OK', offset: 1752, size: 8, boolMask: 0 }, { key: 'AFoo::Bar', result: 'OK', offset: 16, size: 8, boolMask: 0 }, { key: 'UWorld::GameState', result: 'OK', offset: 0x120, size: 8, boolMask: 0 }] }),
    run: 1, workflowSha: 'f'.repeat(40), at: '2026-11-11T00:00:00Z',
  }), null, 2) + '\n';
  const release = (uploader = bot, size = Buffer.byteLength(record)) => JSON.stringify({ assets: [{ name: 'layout-CL-127004.json', size, uploader }] });
  // The published version map as the publish job writes it, with the field rows of the stand-in record.
  const feedOf = (offset = 16) => {
    const map = parse(headerText);
    map.builtCL = null;
    map.functions = [];
    map.fields = [{ key: 'ACrCrafter::CraftComponent', cl: 127004, member: null, offset: 1752, size: 8, mask: 0 }, { key: 'AFoo::Bar', cl: 127004, member: null, offset, size: 8, mask: 0 }];
    const lines = exportFeed(map).split('\n');
    return [lines[0], 'seq\t1', ...lines.slice(1, -1), `sig\tk2\t${'A'.repeat(86)}==`, ''].join('\n');
  };
  const feedRelease = (feed, uploader = bot) => JSON.stringify({ assets: [{ name: 'version-map-client.v1.txt', size: Buffer.byteLength(feed), uploader }] });
  const run = ({ env = {}, release: rel = release(), asset = record, reference = false, feed = null, feedRel = feed === null ? null : feedRelease(feed) } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'refsel-'));
    cpSync(here, join(dir, 'tool', 'ci'), { recursive: true });
    mkdirSync(join(dir, 'res'), { recursive: true });
    writeFileSync(join(dir, 'version_map.generated.h'), headerText);
    writeFileSync(join(dir, 'res', 'result.json'), JSON.stringify({ checks: { exe: { sha256: 'c'.repeat(64) } } }));
    writeFileSync(join(dir, 'res', 'layout-keys.txt'), 'AFoo::Bar\nUWorld::GameState\n');
    if (reference) writeFileSync(join(dir, 'res', 'layout-reference.json'), '{"keys":[]}');
    if (rel !== null) writeFileSync(join(dir, 'release.json'), rel);
    if (asset !== null) writeFileSync(join(dir, 'asset.json'), asset);
    if (feed !== null) writeFileSync(join(dir, 'feed.txt'), feed);
    if (feedRel !== null) writeFileSync(join(dir, 'feed-release.json'), feedRel);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/bash
if [ "$1" = api ] && [[ "$2" == *vmap-feed ]]; then [ -f "$FAKE_DIR/feed-release.json" ] && { cat "$FAKE_DIR/feed-release.json"; exit 0; }; echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
if [ "$1 $2 $3" = "release download vmap-feed" ]; then [ -f "$FAKE_DIR/feed.txt" ] && cp "$FAKE_DIR/feed.txt" "$7/$5"; exit 0; fi
if [ "$1" = api ]; then [ -f "$FAKE_DIR/release.json" ] && { cat "$FAKE_DIR/release.json"; exit 0; }; echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
if [ "$1 $2" = "release download" ]; then [ -f "$FAKE_DIR/asset.json" ] && cp "$FAKE_DIR/asset.json" "$7/$5"; exit 0; fi
exit 1
`);
    chmodSync(join(dir, 'bin', 'gh'), 0o755);
    const script = `set -euo pipefail\nheader=version_map.generated.h\ncl=128786\n${block}\nprintf 'base:%s\\n' "\${base[@]}"\nprintf 'missing:%s\\n' "\${missing[@]}"\n`;
    const r = spawnSync(bash, ['-c', script], {
      cwd: dir, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, FAKE_DIR: dir, GH_REPO: 'msantoro12/starrupture-ci', PREVIOUS_CL: '127004', BRANCH: 'public', PROOF: 'false', FIRST_PUBLISH: 'false', MAPPED: 'false', STORED_REFERENCE: 'false', ...env, PATH: join(dir, 'bin') + delimiter + process.env.PATH },
    });
    const lines = r.stdout.split('\n');
    return { status: r.status, stderr: r.stderr, out: r.stdout, base: lines.filter((l) => l.startsWith('base:')).map((l) => l.slice(5)).filter(Boolean), missing: lines.filter((l) => l.startsWith('missing:')).map((l) => l.slice(8)).filter(Boolean), dir };
  };
  // Public, new build, nothing in the artifact to compare with: the stored layout of the built CL is the base.
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.base, ['--base', 'res/layout-stored.json']);
  assert.deepEqual(ok.missing, []);
  assert.equal(JSON.parse(readFileSync(join(ok.dir, 'res', 'layout-stored.json'), 'utf8')).keys.length, 3);
  // Every miss is a named reason and no base.
  const miss = (over, re) => {
    const r = run(over);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.base, []);
    assert.deepEqual(r.missing.length, 2, r.out);
    assert.equal(r.missing[0], '--base-missing');
    assert.match(r.missing[1], re);
  };
  miss({ release: null }, /release vmap-layouts could not be read: gh: Not Found \(HTTP 404\)/);
  miss({ asset: null }, /layout-CL-127004.json is listed on release vmap-layouts but could not be downloaded/);
  miss({ asset: null, release: JSON.stringify({ assets: [] }) }, /no stored layout for CL-127004/);
  miss({ release: release({ login: 'someone', type: 'User' }) }, /uploaded by someone \(User\).*not trusted/);
  miss({ release: release(bot, 3) }, /not the asset the release lists/);
  miss({ asset: record.replace('"cl": 127004', '"cl": 126000') }, /stored layout is for CL-126000, the header was built for CL-127004/);
  // The published version map widens the cross-check: used when it is the bot's upload, skipped with one line when it is not there.
  const wide = run({ feed: feedOf() });
  assert.deepEqual(wide.base, ['--base', 'res/layout-stored.json']);
  assert.doesNotMatch(wide.out, /skipped/);
  assert.match(run().out, /skipped: no version-map-client.v1.txt was downloaded from release vmap-feed/, 'no published file: skipped, the run goes on');
  assert.deepEqual(run().base, ['--base', 'res/layout-stored.json']);
  const notBot = run({ feed: feedOf(), feedRel: feedRelease(feedOf(), { login: 'someone', type: 'User' }) });
  assert.match(notBot.out, /skipped: version-map-client.v1.txt was uploaded by someone \(User\)/);
  assert.deepEqual(notBot.base, ['--base', 'res/layout-stored.json']);
  miss({ feed: feedOf(24) }, /disagrees with the version map's field rows.*AFoo::Bar: version map 0x18\/0x8\/0x0, record 0x10\/0x8\/0x0/);
  // A non-public check keeps its own comparison, and a proof run or a mapped first publish its self-reference.
  const other = { BRANCH: 'public_test_branch' };
  assert.deepEqual(run({ env: other, reference: true }).base, ['--base', 'res/layout-reference.json']);
  assert.deepEqual(run({ env: other }).base, []);
  assert.deepEqual(run({ env: other }).missing, [], 'no store read, no reason: field-rows keeps its old refusal');
  assert.deepEqual(run({ env: { PROOF: 'true' } }).base, ['--base', 'res/layout-target.json']);
  assert.deepEqual(run({ env: { FIRST_PUBLISH: 'true', MAPPED: 'true' } }).base, ['--base', 'res/layout-target.json']);
  // Public moves to a build the header already maps from the other Steam branch (R2): mapped alone, or a first publish of an unmapped CL, is not a self-reference.
  assert.deepEqual(run({ env: { MAPPED: 'true' } }).base, ['--base', 'res/layout-stored.json']);
  assert.deepEqual(run({ env: { FIRST_PUBLISH: 'true', MAPPED: 'false' } }).base, ['--base', 'res/layout-stored.json']);
  // The proof of the stored reference: the store, whatever the live public scan gave.
  const proof = run({ env: { ...other, STORED_REFERENCE: 'true' }, reference: true });
  assert.deepEqual(proof.base, ['--base', 'res/layout-stored.json']);
  assert.match(proof.out, /reference layout = stored CL-127004/);
  const proofMiss = run({ env: { ...other, STORED_REFERENCE: 'true' }, reference: true, asset: null });
  assert.deepEqual(proofMiss.base, [], 'a stored-reference run never falls back to the live scan');
  assert.equal(proofMiss.missing[0], '--base-missing');
});

// ------------------------------------------------------------ the daily layout refresh (refresh_layout, sr-layout-refresh.yml)

const refreshWf = readFileSync(join(here, '..', '.github', 'workflows', 'sr-layout-refresh.yml'), 'utf8').replace(/\r\n/g, '\n');
const refreshJob = (name) => {
  const rest = refreshWf.slice(refreshWf.indexOf(`\n  ${name}:\n`) + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const MAIN = { ref: 'refs/heads/main', workflow_ref: SR_WATCH_REF };
// Which jobs of the client check run for these inputs: every job's own `if` and needs, as GitHub reads them
// (a job without a status function also needs every job it needs to have succeeded), each run job succeeding.
const simulate = (inputs, github = MAIN) => {
  const names = [...wf.slice(wf.indexOf('\njobs:\n')).matchAll(/\n {2}([a-z][\w-]*):\n/g)].map((m) => m[1]);
  const outs = Object.fromEntries(Object.entries(okNeeds()).map(([k, v]) => [k, v.outputs]));
  Object.assign(outs, { check: { autofix: '[{"name":"x"}]' }, 'feed-plan': { state: 'RUN', other_state: 'RUN' }, 'key-sources-plan': { any: 'true' }, 'plugin-plan': { anyHosted: 'true' } });
  const res = {};
  for (let pass = 0; pass < names.length; pass += 1) {
    for (const n of names) {
      if (res[n]) continue;
      const j = job(n);
      const needs = (j.match(/\n {4}needs: (\[[^\]]*\]|[\w-]+)\n/)?.[1] ?? '').replace(/[[\]\s]/g, '').split(',').filter(Boolean);
      if (!needs.every((x) => res[x])) continue;
      const ifLine = j.match(/\n {4}if: (.*)\n/)?.[1];
      const statusFn = /always\(\)|!cancelled\(\)/.test(ifLine ?? '');
      const succeeded = needs.every((x) => res[x].result === 'success');
      const expr = ifLine && (ifLine.startsWith('${{') ? ifLine : `\${{ ${ifLine} }}`);
      const run = ifLine ? Boolean(evalExpr(expr, { needs: Object.fromEntries(needs.map((x) => [x, res[x]])), inputs, github })) && (statusFn || succeeded) : succeeded;
      res[n] = run ? { result: 'success', outputs: outs[n] ?? {} } : { result: 'skipped', outputs: {} };
    }
  }
  assert.deepEqual(names.filter((n) => !res[n]), [], 'every job resolved');
  return names.filter((n) => res[n].result === 'success').sort();
};
// What sr-layout-refresh.yml passes (the other inputs are not set), and what sr-watch passes.
const refreshInputs = () => ({ branch: 'public', map_mode: true, refresh_layout: true });

test('layout refresh: the new input is off by default on both triggers, and sr-watch does not pass it', () => {
  for (const s of [call, dispatch]) assert.match(s, /\n {6}refresh_layout:\n {8}description: [^\n]+\n {8}type: boolean\n {8}default: false\n/);
  assert.ok(!/refresh_layout/.test(watch), 'the watcher never refreshes');
});

test('layout refresh: it runs the check and the store job and no job after them', () => {
  // The simulation itself: a normal run of sr-watch's shape reaches the whole chain, the publish job included.
  const normal = simulate({ ...okInputs() });
  for (const n of ['map-mode', 'push-loader', 'candidate-loader', 'rig-branch', 'rig-other', 'rig-gate', 'feed-plan', 'feed-loader', 'rig-feed', 'feed-gate', 'publish', 'alert', 'report', 'auto-apply', 'layout-store']) {
    assert.ok(normal.includes(n), `a normal run reaches ${n}`);
  }
  assert.deepEqual(simulate(refreshInputs()), ['build', 'check', 'key-sources', 'key-sources-plan', 'layout-store', 'plugin-plan', 'plugins']);
  // Not the work of one switch alone: with the map job skipped, nothing that needs it can run either.
  const mm = job('map-mode');
  assert.match(mm, /\n {4}if: \$\{\{ !cancelled\(\) && inputs\.map_mode == true && inputs\.refresh_layout != true && needs\.check\.result == 'success' \}\}\n/);
  for (const n of ['push-loader', 'rig-gate', 'feed-plan', 'feed-gate', 'candidate-loader']) assert.match(job(n), /\n {4}needs: \[?[^\n]*(map-mode|push-loader)/, `${n} waits for the map job`);
});

test('layout refresh: the store job still runs for it on main, and the alert, report and auto-apply jobs do not', () => {
  const store = (over = {}, github = MAIN, needs = { check: { result: 'success' } }) => evalExpr(jobIf('layout-store'), { needs, inputs: { ...refreshInputs(), ...over }, github });
  assert.equal(store(), true);
  assert.equal(store({}, { ref: 'refs/heads/fix/x' }), false, 'not from another ref');
  assert.equal(store({}, MAIN, { check: { result: 'failure' } }), false, 'not after a failed check');
  // The store itself does not know about the refresh: it stores whatever a public map-mode check scanned. Only the step after it does.
  const storeCode = job('layout-store').replace(/^ *#.*\n/gm, '');
  assert.ok(!/refresh_layout/.test(storeCode.replace(/- name: Fail a refresh that left key sources out\n {8}if: .*\n/, '')), 'refresh_layout is read only by the last step\'s condition');
  assert.ok(storeCode.indexOf('- name: Fail a refresh that left key sources out') > storeCode.indexOf('- name: Store the layout'), 'after the store');
  assert.match(job('layout-store'), /\n {4}needs: \[check, key-sources-plan\]\n/);
  const needs = { build: { result: 'success' }, 'plugin-plan': { result: 'success' }, check: { result: 'success', outputs: { autofix: '[{"name":"x"}]' } }, 'auto-apply': { result: 'skipped' } };
  const all = new Proxy(needs, { get: (t, k) => t[k] ?? { result: 'skipped', outputs: {} } });
  for (const n of ['alert', 'report', 'auto-apply']) {
    const expr = (job(n).match(/\n {4}if: (.*)\n/)[1]).replace(/^(?!\$\{\{)(.*)$/, '${{ $1 }}');
    assert.equal(evalExpr(expr, { needs: all, inputs: okInputs() }), true, `${n} runs for a normal run`);
    assert.equal(evalExpr(expr, { needs: all, inputs: refreshInputs() }), false, `${n} is off for a refresh`);
  }
});

test('layout refresh: nothing on the publish path depends on it', () => {
  for (const n of ['publish', 'push-loader', 'candidate-loader', 'rig-branch', 'rig-other', 'rig-gate', 'feed-plan', 'feed-loader', 'rig-feed', 'rig-feed-other', 'feed-loader-cleanup', 'feed-gate', 'check']) {
    assert.ok(!/refresh_layout/.test(job(n).replace(/^ *#.*\n/gm, '').replace(/\n {4}if: .*\n/, '\n')), `${n} reads no refresh input`);
  }
  assert.ok(!/refresh_layout/.test(jobIf('publish')));
  assert.ok(!/refresh_layout/.test(jobIf('layout-store')), 'whether the store runs does not depend on it');
  // The only jobs that name it: the map job and the three that report on or push what it makes (and the plan's refusal).
  const naming = [...wf.slice(wf.indexOf('\njobs:\n')).matchAll(/\n {2}([a-z][\w-]*):\n/g)].map((m) => m[1]).filter((n) => /refresh_layout/.test(job(n).replace(/^ *#.*\n/gm, '')));
  assert.deepEqual(naming, ['plugin-plan', 'check', 'layout-store', 'map-mode', 'alert', 'auto-apply', 'report']);
});

test('layout refresh: the plan refuses it anywhere but a public map-mode check with every other switch off, before the Steam login', { skip: !bash }, () => {
  const plan = job('plugin-plan');
  const script = runOf(plan, 'Check the layout refresh');
  assert.match(plan, /- name: Check the layout refresh\n {8}if: \$\{\{ inputs\.refresh_layout == true \}\}\n/);
  const env = plan.slice(plan.indexOf('- name: Check the layout refresh'), plan.indexOf('- name: Check the stored reference'));
  for (const i of ['publish', 'proof_run', 'test_autopilot', 'first_publish', 'stored_reference']) assert.ok(env.includes(`inputs.${i} == true`), `${i} is one of the refused switches`);
  const run = (e) => spawnSync(bash, ['-c', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, BRANCH: 'public', MAP_MODE: 'true', OTHERS: 'false', ...e } });
  assert.equal(run({}).status, 0);
  for (const e of [{ BRANCH: 'public_test_branch' }, { BRANCH: 'expiry-only' }, { MAP_MODE: 'false' }, { OTHERS: 'true' }]) {
    const r = run(e);
    assert.equal(r.status, 2, JSON.stringify(e));
    assert.match(r.stdout, /refresh_layout needs branch public and map_mode on/);
  }
  // The check job waits for that verdict, as it does for the other refused runs.
  const needs = (plan_) => ({ build: { result: 'success' }, 'plugin-plan': { result: plan_ }, plugins: { result: 'skipped' }, 'key-sources-plan': { result: 'success' }, 'key-sources': { result: 'success' } });
  assert.equal(evalExpr(jobIf('check'), { needs: needs('success'), inputs: refreshInputs() }), true);
  assert.equal(evalExpr(jobIf('check'), { needs: needs('failure'), inputs: refreshInputs() }), false, 'a refused refresh never reaches the login');
  assert.equal(evalExpr(jobIf('check'), { needs: needs('failure'), inputs: okInputs() }), true, 'a normal run is judged as before');
});

test('refresh workflow: one daily schedule at a minute no other workflow uses, plus a manual start, main only, no pull request trigger', () => {
  const triggers = refreshWf.slice(refreshWf.indexOf('\non:\n'), refreshWf.indexOf('\npermissions:'));
  const crons = [...triggers.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(crons.length, 1);
  const [minute, hour, dom, month, dow] = crons[0].split(' ');
  assert.deepEqual([dom, month, dow], ['*', '*', '*'], 'every day');
  assert.match(minute, /^\d+$/);
  assert.match(hour, /^\d+$/);
  const taken = new Set([23, 53]); // the planner's minutes
  const dir = join(here, '..', '.github', 'workflows');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yml') && n !== 'sr-layout-refresh.yml')) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/- cron: '([^ ']+)/g)) for (const x of m[1].split(',')) taken.add(Number(x));
  }
  assert.ok([7, 37, 23, 53].every((x) => taken.has(x)), 'the watcher and the planner are in the list');
  assert.ok(!taken.has(Number(minute)), `minute ${minute} is free`);
  assert.match(triggers, /\n {2}workflow_dispatch:\n/);
  assert.ok(!/pull_request|push:/.test(triggers));
  assert.match(refreshWf, /\npermissions: \{\}\n/);
  assert.ok(!/environment:|secrets: inherit/.test(refreshWf.replace(/^ *#.*\n/gm, '')));
});

test('refresh workflow: it calls the client check for the public build in map mode with the refresh on, and nothing else', () => {
  const j = refreshJob('refresh');
  assert.match(j, /\n {4}uses: \.\/\.github\/workflows\/sr-client-check\.yml\n/);
  assert.deepEqual(mapOf(j, 'with'), { branch: 'public', map_mode: 'true', refresh_layout: 'true' });
  assert.deepEqual(mapOf(j, 'secrets'), { STEAM_CI_USERNAME: '${{ secrets.STEAM_CI_USERNAME }}', STEAM_CI_LOGIN_CACHE: '${{ secrets.STEAM_CI_LOGIN_CACHE }}' }, 'the Steam login by name and no other secret');
  assert.ok(!/\n {4}(runs-on|environment|steps):/.test(j), 'a call job has no runner, environment or steps');
  // Nothing wider than the caller sr-watch already uses for the same called workflow, and nothing it cannot give.
  const perms = (text) => text.match(/\n {4}permissions:\n((?: {6}\S[^\n]*\n)+)/)[1].split('\n').filter(Boolean).map((l) => l.trim().replace(/\s+#.*$/, ''));
  assert.deepEqual(perms(j), perms(watch.slice(watch.indexOf('  client-check:\n'))), 'the same ceiling as the watcher\'s call');
  assert.match(j, /\n {4}needs: idle\n {4}if: \$\{\{ needs\.idle\.outputs\.idle == 'true' \}\}\n/);
  assert.ok(!/gh workflow run|\n {6}ref:|gh api[^\n]*dispatches/.test(refreshWf.replace(/^ *#.*\n/gm, '')), 'it calls the check at its own ref, it does not dispatch it');
});

test('refresh workflow: it runs in the watcher\'s group so a poll and a refresh never sign in together, and nothing is cancelled', () => {
  const group = (text) => text.match(/\nconcurrency:\n {2}group: (\S+)\n {2}cancel-in-progress: (\S+)\n/).slice(1);
  assert.deepEqual(group(refreshWf), ['sr-watch', 'false']);
  assert.deepEqual(group(watch), group(refreshWf), 'the same group and the same cancel setting as the watcher');
  // The check job keeps its per-branch group too: a refresh of public queues behind a hand-started public check.
  const c = job('check');
  assert.match(c, /\n {4}concurrency:\n {6}group: sr-client-check-\$\{\{ inputs\.branch \}\}\n {6}cancel-in-progress: false\n/);
  assert.ok(!/cancel-in-progress: true/.test(wf + refreshWf + watch));
});

test('refresh workflow: it skips when a client check, the rig or the data extract has a run going or waiting, and otherwise goes on', { skip: !bash }, () => {
  const j = refreshJob('idle');
  assert.match(j, /\n {4}permissions:\n {6}actions: read\n {4}[a-z]/, 'it only reads the runs');
  const script = runOf(j, 'Look for a run that uses Steam');
  const pattern = new RegExp(script.match(/test\("([^"]+)"\)/)[1]);
  for (const p of ['.github/workflows/sr-client-check.yml@refs/heads/main', '.github/workflows/sr-client-rig.yml', '.github/workflows/sr-data-extract.yml']) assert.ok(pattern.test(p), p);
  for (const p of ['.github/workflows/sr-watch.yml', '.github/workflows/sr-layout-refresh.yml', '.github/workflows/sr-build-all.yml', '.github/workflows/sr-node-tests.yml', '.github/workflows/vmap-watchdog.yml']) assert.ok(!pattern.test(p), p);
  const run = (busy) => {
    const dir = mkdtempSync(join(tmpdir(), 'idle-'));
    mkdirSync(join(dir, 'bin'));
    const gh = '#!/bin/bash\necho "$*" >> "$FAKE_DIR/calls.log"\ns="${2#*status=}"; s="${s%%&*}"\n[ -f "$FAKE_DIR/$s.txt" ] && cat "$FAKE_DIR/$s.txt"\nexit 0\n';
    writeFileSync(join(dir, 'bin', 'gh'), gh);
    chmodSync(join(dir, 'bin', 'gh'), 0o755);
    for (const [status, text] of Object.entries(busy)) writeFileSync(join(dir, `${status}.txt`), text);
    writeFileSync(join(dir, 'out'), '');
    const r = spawnSync(bash, ['-c', script], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, FAKE_DIR: dir, GH_REPO: 'msantoro12/starrupture-ci', GITHUB_OUTPUT: join(dir, 'out'), PATH: join(dir, 'bin') + delimiter + process.env.PATH } });
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8');
    const out = readFileSync(join(dir, 'out'), 'utf8').trim();
    rmSync(dir, { recursive: true, force: true });
    return { r, calls, out };
  };
  const none = run({});
  assert.equal(none.r.status, 0);
  assert.equal(none.out, 'idle=true');
  for (const s of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) assert.ok(none.calls.includes(`status=${s}&`), `looks at ${s} runs`);
  for (const s of ['queued', 'in_progress', 'waiting']) {
    const busy = run({ [s]: 'SR client check https://github.com/x/y/actions/runs/1\n' });
    assert.equal(busy.r.status, 0, 'a skipped refresh is not a failure');
    assert.equal(busy.out, 'idle=false', `a ${s} run holds it back`);
    assert.match(busy.r.stdout, /::notice title=Layout refresh skipped::/);
  }
});

test('layout refresh: the run goes red when a planned key source left no keys, after the store has saved what it has', { skip: !bash }, () => {
  const store = job('layout-store');
  const script = runOf(store, 'Fail a refresh that left key sources out');
  assert.match(store, /- name: Fail a refresh that left key sources out\n {8}if: \$\{\{ inputs\.refresh_layout == true \}\}\n {8}env:\n {10}PLAN: \$\{\{ needs\.key-sources-plan\.outputs\.matrix \}\}\n/);
  const plan = JSON.stringify([{ name: 'BetterCheats', tag: 'BetterCheats@gss/plugin-work' }, { name: 'MiniMap', tag: 'MiniMap@feat/full-version-map' }]);
  const run = (sources, planText = plan) => {
    const dir = mkdtempSync(join(tmpdir(), 'keysrc-'));
    mkdirSync(join(dir, 'res'));
    if (sources) writeFileSync(join(dir, 'res', 'keysrc.json'), JSON.stringify({ sources }));
    const r = spawnSync(bash, ['-c', script], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, PLAN: planText } });
    rmSync(dir, { recursive: true, force: true });
    return r;
  };
  const ok = (name) => ({ name, status: 'ok', layout: 'ok', keys: 3 });
  assert.equal(run([ok('BetterCheats'), ok('MiniMap')]).status, 0, 'every planned source scanned and read');
  assert.equal(run(null, '').status, 0, 'no key sources planned, nothing to miss');
  assert.equal(run(null, '[]').status, 0);
  const noResult = run([ok('BetterCheats')]);
  assert.equal(noResult.status, 1, 'a planned source with no result (it did not build) fails the run');
  assert.match(noResult.stdout, /::error title=Layout refresh::key source MiniMap@feat\/full-version-map left its keys out/);
  assert.equal(run([ok('BetterCheats'), { name: 'MiniMap', status: 'failed', layout: '', keys: 0 }]).status, 1, 'a source that did not scan');
  assert.equal(run([ok('BetterCheats'), { name: 'MiniMap', status: 'ok', layout: 'no keys', keys: 0 }]).status, 1, 'a source whose keys were not read');
  assert.equal(run(null).status, 1, 'no keysrc.json at all while sources were planned');
});

// ------------------------------------------------------------ the published feed as part of the base (input published_base)

const WATCHERS = ['sr-watch.yml', 'sr-layout-refresh.yml', 'sr-keepalive.yml', 'vmap-watchdog.yml', 'sr-build-all.yml'];

test('published_base: a boolean that is off by default on both triggers; nothing that calls the check passes it', () => {
  for (const s of [call, dispatch]) assert.match(s, /\n {6}published_base:\n {8}description: [^\n]*\n {8}type: boolean\n {8}default: false\n/);
  for (const name of WATCHERS) {
    const text = readFileSync(join(here, '..', '.github', 'workflows', name), 'utf8');
    assert.ok(!text.includes('published_base'), `${name} does not pass it`);
  }
});

test('published_base: every step it adds is off with the switch, and the helper runs from the repository\'s own ci folder', () => {
  const steps = ['Check out the published-base tool', 'Take the published feed as the base'];
  const check = job('check');
  for (const name of steps) assert.match(step(check, name), /\n {8}if: [^\n]*inputs\.published_base == true\n/, name);
  assert.match(step(job('map-mode'), 'Take the published feed as the base'), /\n {8}if: \$\{\{ inputs\.published_base == true \}\}\n/);
  assert.match(step(check, 'Check out the published-base tool'), /path: ci-base\n\s+sparse-checkout: ci\n\s+persist-credentials: false/);
  // The same helper everywhere: the check job, map mode, the chain and the publish job.
  assert.ok(runOf(check, 'Take the published feed as the base').includes('node ci-base\\ci\\published-base.mjs take $header --report out\\published-base.json'));
  assert.ok(runOf(job('map-mode'), 'Take the published feed as the base').includes('node tool/ci/published-base.mjs take loader/StarRupture-ModLoader-Core/hooks/game/version_map.generated.h'));
  assert.ok(runOf(job('map-mode'), 'Decide, export, sign, stage and plan the promotion').includes('node tool/ci/published-base.mjs preserve feed.txt --published published/version-map-client.v1.txt --report preserve.json'));
  assert.ok(runOf(job('publish'), 'Check the seq and the feed before signing').includes('node tool/ci/published-base.mjs preserve chain/feed.txt --published live/version-map-client.v1.txt --report preserve.json'));
  // Both jobs that take the base can hold; the artifact carries the check job's report to map mode.
  assert.ok(check.includes('out/published-base.json'), 'the check job uploads its report');
  assert.ok(step(job('check'), 'Take the published feed as the base').includes('timeout-minutes: 5'));
});

test('published_base (check job): a hold is recorded and the carry scan is left out; any other failure fails the step', () => {
  const run = runOf(job('check'), 'Take the published feed as the base');
  assert.match(run, /\$code = \$LASTEXITCODE\nif \(\$code -eq 3\) \{\n\s+"held=true" >> \$env:GITHUB_OUTPUT\n[^\n]*::warning[^\n]*\n\s+exit 0\n\}\nif \(\$code -ne 0\) \{[^\n]*exit \$code \}\n"held=false" >> \$env:GITHUB_OUTPUT/);
  assert.match(step(job('check'), 'Take the published feed as the base'), /\n {8}shell: pwsh\n/);
  const names = stepsOf(job('check'));
  assert.ok(names.indexOf('Check out the base header') < names.indexOf('Take the published feed as the base') && names.indexOf('Take the published feed as the base') < names.indexOf("Carry the version map's keys onto this build"));
});

test('published_base (map mode): the base is taken before anything reads the header, a hold leaves the write out, the flags go with the switch', () => {
  const mm = job('map-mode');
  const names = stepsOf(mm);
  const at = (n) => names.indexOf(n);
  assert.ok(at('Download the scans') < at('Take the published feed as the base') && at('Take the published feed as the base') < at('Settle the key sources'), 'right after the downloads');
  assert.ok(at('Take the published feed as the base') < at('Write the update into the header') && at('Write the update into the header') < at('Decide, export, sign, stage and plan the promotion'));
  assert.match(step(mm, 'Write the update into the header'), /\n {8}if: \$\{\{ steps\.base\.outputs\.held != 'true' \}\}\n/);
  const take = runOf(mm, 'Take the published feed as the base');
  assert.ok(take.includes('--check-report res/published-base.json'), 'the check job\'s hold stands');
  assert.match(take, /if \[ "\$code" -eq 3 \]; then\n\s+echo "held=true" >> "\$GITHUB_OUTPUT"\n[^\n]*::warning[^\n]*\n\s+exit 0\nfi\n\[ "\$code" -eq 0 \] \|\| \{[^\n]*exit "\$code"; \}\necho "held=false" >> "\$GITHUB_OUTPUT"/);
  const write = runOf(mm, 'Write the update into the header');
  assert.ok(write.includes('published_flag=(--published published-base/version-map-client.v1.txt --retired tool/ci/retired-rows.txt)'));
  assert.ok(write.includes('[ "$PUBLISHED_BASE" = true ] && [ -f published-base/version-map-client.v1.txt ]'), 'only with the switch on');
  assert.ok(write.includes('"${published_flag[@]}"'));
  assert.match(mm, /\n {6}PUBLISHED_BASE: \$\{\{ inputs\.published_base == true \}\}\n/);
});

// The chain step: the early hold block and the preserve block, run against the real decide.mjs.
const chainRun = () => runOf(job('map-mode'), 'Decide, export, sign, stage and plan the promotion');
const chainBlock = (from, to) => {
  const run = chainRun();
  const a = run.indexOf(from);
  const b = run.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} ... ${to}`);
  return run.slice(a, b);
};

test('published_base (chain): a base that was not taken ends the chain in a HOLD that carries the reasons, before the feed is cut', { skip: !bash }, () => {
  const run = chainRun();
  assert.ok(run.indexOf('if [ "$BASE_HELD" = true ]; then') < run.indexOf('node tool/ci/decide.mjs --repo'), 'before decide');
  assert.match(job('map-mode'), /\n {10}BASE_HELD: \$\{\{ steps\.base\.outputs\.held \}\}\n/);
  const block = chainBlock('if [ "$BASE_HELD" = true ]; then', 'fi\n') + 'fi\n';
  const exec = (held) => {
    const dir = mkdtempSync(join(tmpdir(), 'chain-hold-'));
    mkdirSync(join(dir, 'tool', 'ci'), { recursive: true });
    copyFileSync(join(here, 'decide.mjs'), join(dir, 'tool', 'ci', 'decide.mjs'));
    writeFileSync(join(dir, 'published-base.json'), JSON.stringify({ ok: false, step: 'import', reasons: ['published base: the published file could not be fetched after 3 tries (x); the header was not changed'] }));
    const r = sh(`set -euo pipefail\ncl=129402\n${block}\necho reached-the-decide`, dir, { BASE_HELD: held, GITHUB_OUTPUT: join(dir, 'out.txt') });
    return { r, dir, out: existsSync(join(dir, 'out.txt')) ? readFileSync(join(dir, 'out.txt'), 'utf8') : '' };
  };
  const held = exec('true');
  assert.equal(held.r.status, 0, held.r.stderr);
  assert.ok(!held.r.stdout.includes('reached-the-decide'), 'the chain stops');
  assert.equal(held.out, 'decision=HOLD\npublishable=false\n');
  const d = JSON.parse(readFileSync(join(held.dir, 'decision.json'), 'utf8'));
  assert.deepEqual([d.decision, d.ship, d.repo, d.cl], ['HOLD', false, 'ModLoader', 129402]);
  assert.match(d.reasons[0], /^published base: the published file could not be fetched after 3 tries/);
  for (const free of ['false', '']) assert.ok(exec(free).r.stdout.includes('reached-the-decide'), `held='${free}' goes on`);
});

test('published_base (chain): the new feed is compared with the published file; a loss ends in a HOLD, a pass goes on, and the switch off or a first publish skips it', { skip: !bash }, () => {
  const run = chainRun();
  assert.ok(run.indexOf('version-map.mjs export-feed "$header" --out feed.txt') < run.indexOf('published-base.mjs preserve') && run.indexOf('published-base.mjs preserve') < run.indexOf('vmap-sign.mjs sign feed.txt'), 'after the export, before any signing');
  const block = chainBlock('if [ "$PUBLISHED_BASE" = true ] && [ "$FIRST_PUBLISH" != true ]; then', "node --input-type=module -e '\n  import { appendFileSync, readFileSync, statSync }");
  const exec = (env, exit) => {
    const dir = mkdtempSync(join(tmpdir(), 'chain-preserve-'));
    mkdirSync(join(dir, 'tool', 'ci'), { recursive: true });
    copyFileSync(join(here, 'decide.mjs'), join(dir, 'tool', 'ci', 'decide.mjs'));
    writeFileSync(join(dir, 'tool', 'ci', 'published-base.mjs'), `import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync('calls.log', process.argv.slice(2).join(' ') + '\\n');
const code = ${exit};
if (code !== 2) writeFileSync('preserve.json', JSON.stringify(code === 0 ? { ok: true, step: 'preserve', note: 'kept' } : { ok: false, step: 'preserve', reasons: ['published base: 2 published lines are missing from the new feed', 'function GWorld @ CL-127004: missing'] }));
process.exit(code);
`);
    writeFileSync(join(dir, 'decision.json'), JSON.stringify({ decision: 'M', ship: true, path: 'M', cl: 129402, repo: 'ModLoader', reasons: [], notes: [], plugins: [], pluginsOk: true, expectRefused: [] }));
    const r = sh(`set -euo pipefail\n${block}\necho reached-the-signing`, dir, { PUBLISHED_BASE: 'true', FIRST_PUBLISH: 'false', GITHUB_OUTPUT: join(dir, 'out.txt'), ...env });
    return { r, dir, out: existsSync(join(dir, 'out.txt')) ? readFileSync(join(dir, 'out.txt'), 'utf8') : '', calls: existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '' };
  };
  const lost = exec({}, 3);
  assert.equal(lost.r.status, 0, lost.r.stderr);
  assert.ok(!lost.r.stdout.includes('reached-the-signing'));
  assert.equal(lost.out, 'decision=HOLD\npublishable=false\n');
  assert.equal(lost.calls, 'preserve feed.txt --published published/version-map-client.v1.txt --report preserve.json\n');
  const d = JSON.parse(readFileSync(join(lost.dir, 'decision.json'), 'utf8'));
  assert.deepEqual([d.decision, d.ship, d.path], ['HOLD', false, 'M']);
  assert.deepEqual(d.reasons, ['published base: 2 published lines are missing from the new feed', 'function GWorld @ CL-127004: missing']);
  const kept = exec({}, 0);
  assert.equal(kept.r.status, 0);
  assert.ok(kept.r.stdout.includes('reached-the-signing'));
  assert.equal(kept.out, '');
  assert.equal(JSON.parse(readFileSync(join(kept.dir, 'decision.json'), 'utf8')).decision, 'M', 'the decision is not touched');
  // A helper that crashed (exit 2) is not a pass and not a HOLD: the step fails with its code.
  const crashed = exec({}, 2);
  assert.equal(crashed.r.status, 2);
  assert.match(crashed.r.stdout, /::error::published-base\.mjs exited 2/);
  assert.ok(!crashed.r.stdout.includes('reached-the-signing'));
  for (const env of [{ PUBLISHED_BASE: 'false' }, { FIRST_PUBLISH: 'true' }]) {
    const skipped = exec(env, 3);
    assert.equal(skipped.calls, '', JSON.stringify(env));
    assert.ok(skipped.r.stdout.includes('reached-the-signing'));
  }
});

test('published_base (publish job): the feed to sign is compared with the live file before the key is used; a loss fails the job and uploads nothing', { skip: !bash }, () => {
  const pub = job('publish');
  assert.match(pub, /\n {6}PUBLISHED_BASE: \$\{\{ inputs\.published_base == true \}\}\n/);
  const names = stepsOf(pub);
  const checkRun = runOf(pub, 'Check the seq and the feed before signing');
  assert.ok(checkRun.indexOf('cmp -s chain/feed.txt feed.again.txt') < checkRun.indexOf('published-base.mjs preserve'), 'after the feed is proved to be the chain\'s');
  assert.ok(names.indexOf('Check the seq and the feed before signing') < names.indexOf('Sign with the release key, verify, publish'));
  assert.ok(!runOf(pub, 'Sign with the release key, verify, publish').includes('published-base'), 'the check happens in the step before the key is read');
  const stepName = 'Check the seq and the feed before signing';
  const ran = (env, exit) => {
    const fx = publishFixture();
    return { fx, r: runPublishStep(fx, stepName, { PUBLISHED_BASE: 'true', PRESERVE_EXIT: String(exit), ...env }) };
  };
  const ok = ran({}, 0);
  assert.equal(ok.r.status, 0, ok.r.stdout + ok.r.stderr);
  assert.ok(callsOf(ok.fx.dir).includes('published-base preserve chain/feed.txt --published live/version-map-client.v1.txt --report preserve.json'), callsOf(ok.fx.dir).join('\n'));
  const lost = ran({}, 3);
  assert.equal(lost.r.status, 2);
  assert.match(lost.r.stdout, /::error::published base: 2 published lines are missing from the new feed\n::error::function GWorld @ CL-127004: missing\n::error::the feed to sign would lose or change a published row; nothing was signed or uploaded/);
  assert.ok(lost.r.stdout.startsWith('::error::published base: 2 published lines are missing from the new feed; function GWorld @ CL-127004: missing\n'), 'the alert reads only the first annotation, so it carries the first rows joined');
  assert.ok(!callsOf(lost.fx.dir).some((c) => /^vmap-sign sign|release upload/.test(c)), 'nothing signed, nothing uploaded');
  // Off, or a first publish: no comparison.
  for (const env of [{ PUBLISHED_BASE: 'false' }, { FIRST_PUBLISH: 'true' }]) {
    const skipped = ran({ ...env }, 3);
    assert.ok(!callsOf(skipped.fx.dir).some((c) => c.startsWith('published-base')), JSON.stringify(env));
  }
});
