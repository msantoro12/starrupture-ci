// Tests for the client check workflow's run inputs (.github/workflows/sr-client-check.yml).
//
//   node --test ci/client-check-workflow.test.mjs
//
// Reads the workflow as text: the Game SDK repository input, the plugin
// exclusion list and the dispatch-only test-autopilot switch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  assert.match(job('publish'), /if: \$\{\{ !cancelled\(\) && inputs\.publish == true && inputs\.test_autopilot != true && needs\.map-mode\.outputs\.test == 'false' && /);
  const ap = JSON.parse(readFileSync(join(here, '..', 'state', 'autopilot.json'), 'utf8'));
  assert.ok(ap.enabled === false || (ap.enabled === true && ap.paths.every((p) => p === 'M')), 'autopilot is off or limited to the map-feed path M');
});

test('publish lock: a test run never reaches the release key, whatever state/autopilot.json says', () => {
  const mm = job('map-mode');
  // The chain states explicitly whether it is a test: the dispatch input, its own flag or the decision.
  assert.match(mm, /\n {6}test: \$\{\{ steps\.chain\.outputs\.test \}\}\n/);
  assert.match(mm, /TEST_INPUT: \$\{\{ inputs\.test_autopilot == true \}\}/);
  assert.ok(mm.includes(`is_test="$(node -p "String(process.env.TEST_INPUT === 'true' || process.env.TEST_AUTOPILOT === 'true' || JSON.parse(require('fs').readFileSync('decision.json','utf8')).test === true)")"\n          echo "test=$is_test" >> "$GITHUB_OUTPUT"`));
  const pub = job('publish');
  assert.match(pub, /needs\.map-mode\.outputs\.test == 'false'/, 'the job needs an explicit non-test run');
  // A second lock in the job: the input and the chain's own marks, before anything is signed.
  const lock = pub.slice(pub.indexOf('- name: Refuse a test run'), pub.indexOf('- name: Sign with the release key'));
  assert.ok(lock.length > 40, 'the lock step comes before the signing step');
  assert.ok(lock.includes('[ "$TEST_INPUT" = false ] || { echo "::error::a test run never publishes"; exit 2; }'));
  assert.ok(lock.includes('d.test !== undefined || d.wouldBe !== undefined || p.test !== undefined'));
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
  assert.match(a, /needs: \[build, plugin-plan, check, map-mode, publish\]/);
  assert.match(a, /if: \$\{\{ always\(\) && inputs\.branch && inputs\.branch != 'expiry-only' \}\}/);
  assert.match(a, /permissions:\n\s+contents: read\n\s+issues: write/);
  assert.ok(a.includes('/^G3: CL-[0-9]+ is not newer than CL-[0-9]+$/'), 'nothing new is the G3 reason');
  assert.ok(a.includes('result === "failure"'));
  assert.ok(a.includes('gh issue create --title "$title" --body-file alert.md'));
  assert.ok(a.includes('gh issue comment "$number" --body-file alert.md'));
  // The caller's ceiling must grant issues: write, or GitHub rejects the call.
  const watch = readFileSync(join(here, '..', '.github', 'workflows', 'sr-watch.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(watch.slice(watch.indexOf('  client-check:\n')), /permissions:\n\s+contents: write\n\s+pull-requests: write\n\s+issues: write/);
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
  assert.match(job('map-mode'), /if: \$\{\{ !cancelled\(\) && inputs\.map_mode == true && needs\.check\.result == 'success' \}\}/);
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
