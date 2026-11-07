// Tests for the client check workflow's run inputs (.github/workflows/sr-client-check.yml).
//
//   node --test ci/client-check-workflow.test.mjs
//
// Reads the workflow as text: the Game SDK repository input, the plugin
// exclusion list and the dispatch-only test-autopilot switch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
  // A held candidate (decision not M) counts as a test as far as publishing goes.
  assert.ok(mm.includes(`is_test="$(node -p "const d = JSON.parse(require('fs').readFileSync('decision.json','utf8')); String(process.env.TEST_INPUT === 'true' || process.env.TEST_AUTOPILOT === 'true' || d.test === true || (d.candidate === true && d.decision !== 'M'))")"\n          echo "test=$is_test" >> "$GITHUB_OUTPUT"`));
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
  const plugins = ['WAILA', 'RuptureTimer', 'BetterCheats'].map((n) => `msantoro12/StarRupture-Plugin-${n}@gss/plugin-work`).join(' ')
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
  assert.match(j, /needs\.map-mode\.result == 'success' && needs\.map-mode\.outputs\.staged == 'true' && inputs\.test_autopilot != true && inputs\.loader_repo == 'msantoro12\/StarRupture-ModLoader'/);
  assert.match(j, /\n {4}outputs:\n {6}branch: \$\{\{ steps\.push\.outputs\.branch \}\}\n {6}sha: \$\{\{ steps\.push\.outputs\.sha \}\}\n/);
  assert.ok(!/continue-on-error/.test(j), 'no step of the push job may fail quietly');
  // The key is read by name, in two steps only, and no other secret is touched.
  assert.equal(j.match(/secrets\.[A-Z_]+/g).join(' '), 'secrets.SR_DEPLOYKEY_MODLOADER secrets.SR_DEPLOYKEY_MODLOADER');
  // The key check comes first, before anything is fetched.
  assert.ok(j.indexOf('- name: Check the deploy key') < j.indexOf('- name: Check out the push tool'));
  // Pushes go through staging.mjs push: no git push, tag or force in the workflow.
  assert.ok(!/git (-C \S+ )?push|--force|--tags|refs\/tags/.test(j));
  assert.ok(j.includes('node tool/ci/staging.mjs target --repo "$LOADER_REPO" --plan chain/stage-plan.json'));
  assert.ok(j.indexOf('staging.mjs target') < j.indexOf('- name: Commit the header and push the branch'), 'the allowlist runs before the key is written');
  assert.match(j, /repository: msantoro12\/StarRupture-ModLoader\n\s+ref: \$\{\{ steps\.base\.outputs\.sha \}\}/, 'the checkout is the fork at the commit the rows were read from, not a moving ref');
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
  assert.match(j, /ref: \$\{\{ inputs\.scanner_ref \}\}\n\s+path: scanner-src\n\s+sparse-checkout: tools\/AobScan\n/);
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
