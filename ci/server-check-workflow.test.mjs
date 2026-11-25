// Tests for the server check and its publish leg (.github/workflows/sr-server-check.yml), its call in
// sr-watch.yml and its key lists (ci/server-keys.txt, ci/server-function-keys.txt).
//
//   node --test ci/server-check-workflow.test.mjs
//
// Reads the files as text, the way the other workflow tests do: the scanner and the layout check hold no secret,
// download the server anonymously and upload only their result files; the one job that holds the release key
// writes the vmap-feed-rehearsal prerelease unless the `live` dispatch input is set, and sr-watch cannot set it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { addBuild, addField, addFunction, emit, emptyMap } from './version-map.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const wf = read('.github', 'workflows', 'sr-server-check.yml');
const watch = read('.github', 'workflows', 'sr-watch.yml');
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const call = section(wf, '  workflow_call:\n', '  workflow_dispatch:\n');
const dispatch = section(wf, '  workflow_dispatch:\n', '\npermissions:');
// A job runs to the next job key (two-space indent) or the end of the file.
const job = (text, name) => {
  const rest = text.slice(text.indexOf(`\n  ${name}:\n`) + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const windows = job(wf, 'server-scanner') + job(wf, 'server-layout');
const map = job(wf, 'server-map');
const publish = job(wf, 'server-publish');
const runSteps = (text) => [
  ...[...text.matchAll(/\n( +)run: \|\n((?:\1 .*\n|\n)*)/g)].map((m) => m[2]),
  ...[...text.matchAll(/\n +run: (?!\|).*/g)].map((m) => m[0]),
];
const stepOf = (text, name) => {
  const at = text.indexOf(`- name: ${name}\n`);
  assert.ok(at > 0, `step "${name}" exists`);
  const next = text.indexOf('\n      - ', at + 1);
  return text.slice(at, next < 0 ? undefined : next);
};

test('triggers: workflow_call and workflow_dispatch, each with buildid and rehearsal; live on dispatch only', () => {
  const on = section(wf, '\non:\n', '\npermissions:');
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):\n/gm)].map((m) => m[1]), ['workflow_call', 'workflow_dispatch']);
  for (const s of [call, dispatch]) {
    assert.match(s, /buildid:\n(?:.*\n)*?\s+type: string\n\s+default: ''/);
    assert.match(s, /rehearsal:\n(?:.*\n)*?\s+type: boolean\n\s+default: false/);
  }
  assert.match(dispatch, /\n {6}live:\n(?:.*\n)*?\s+type: boolean\n\s+default: false\n/, 'live: a boolean, off by default');
  assert.ok(!/\blive:/.test(call), 'a workflow_call caller cannot set live: it is not an input there');
  assert.ok(!/pull_request|schedule:|push:/.test(on), 'no trigger a stranger can pull');
});

test('trust: the scanner and the layout check hold no secret; the TEST key is read only by server-map, the release key only by server-publish, in environment vmap-sign', () => {
  assert.ok(!/secrets\.(?!VMAP_SIGN_KEY(?:_TEST)?\b)/.test(wf) && !wf.includes('inherit'), 'no secret but the two signing keys, no inherit');
  assert.deepEqual([...wf.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]), ['VMAP_SIGN_KEY_TEST', 'VMAP_SIGN_KEY'], 'each key is read once');
  assert.ok(map.includes('VMAP_SIGN_KEY_TEST: ${{ secrets.VMAP_SIGN_KEY_TEST }}') && !/secrets\.VMAP_SIGN_KEY\b/.test(map), 'server-map reads the TEST key only');
  assert.ok(publish.includes('VMAP_SIGN_KEY: ${{ secrets.VMAP_SIGN_KEY }}') && !/VMAP_SIGN_KEY_TEST|key-id k1|allow-test-key/.test(publish), 'server-publish reads the release key only');
  assert.ok(!/secrets\.|\n\s+environment:/.test(windows), 'no secret and no environment in the scanner or the layout check');
  assert.ok(!/\n\s+environment:/.test(map), 'the map job runs in no environment (the TEST key is a repository secret, as in the client check)');
  assert.deepEqual([...wf.matchAll(/\n\s+environment: (.*)/g)].map((m) => m[1]), ['vmap-sign']);
  assert.match(publish, /\n {4}environment: vmap-sign\n/);
  assert.ok(!/key-id k2/.test(map) && !/--key-id k1/.test(publish), 'k1 only in the map job, k2 only in the publish job');
  assert.match(wf, /\npermissions: \{\}\n/);
  for (const name of ['server-scanner', 'server-layout', 'server-map']) assert.match(job(wf, name), /\n {4}permissions:\n {6}contents: read\n/, `${name}: contents: read`);
  assert.match(publish, /\n {4}permissions:\n {6}contents: write\n/, 'server-publish: contents: write (the upload)');
  assert.ok(!/(?:pull-requests|issues|actions|checks|id-token|packages):/.test(wf), 'asks for no other permission');
  const build = job(wf, 'server-scanner');
  assert.ok(build.includes("'^(msantoro12|AlienXAXS)/StarRupture-ModLoader$'") && build.includes('is not allowed'));
  assert.ok((wf.match(/persist-credentials: false/g) ?? []).length === (wf.match(/uses: actions\/checkout@/g) ?? []).length, 'no checkout keeps the token');
  // The job that holds the key checks out this repository's scripts only: no loader, no scanner, no input-named repository.
  assert.ok(!/repository:/.test(map + publish), 'the map and publish jobs take no other repository');
  assert.ok(!/\$\{\{ inputs\./.test((map + publish).replace(/LIVE: .*\n|REHEARSAL: .*\n|SCANNER_DEFAULTS: .*\n/g, '')), 'an input reaches those jobs through nothing but the three flags');
  const dflt = (name) => wf.match(new RegExp(`      ${name}:\\n(?:        .*\\n)*?        default: '([^']*)'`))[1];
  const sd = publish.match(/SCANNER_DEFAULTS: (.*)\n/)[1];
  for (const n of ['loader_repo', 'loader_ref', 'scanner_repo', 'scanner_ref']) assert.ok(sd.includes(`inputs.${n} == '${dflt(n)}'`), `a live run compares ${n} with its dispatch default`);
  assert.match(stepOf(publish, 'Refuse a live publish that is not allowed'), /SCANNER_DEFAULTS" = true/);
  // No override by default, on either trigger, and a live run takes none.
  const refOf = (t) => t.match(/      scanner_ref:
(?:        .*
)*?        default: '([^']*)'/)[1];
  assert.deepEqual([refOf(call), refOf(dispatch), sd.match(/inputs.scanner_ref == '([^']*)'/)[1]], ['', '', ''], 'both defaults and the SCANNER_DEFAULTS pin are blank');
  assert.ok(!/ || /.test(sd), 'every SCANNER_DEFAULTS condition must hold: no alternative');
  const scanner = job(wf, 'server-scanner');
  assert.match(stepOf(scanner, 'Check out tools/AobScan'), /
 {8}if: ${{ inputs.scanner_ref != '' }}
/, 'a blank ref is never checked out (it would take the default branch)');
  const pick = stepOf(scanner, 'Pick the scanner');
  assert.ok(!/
 {8}if:/.test(pick) && pick.includes('SCANNER_REF: ${{ inputs.scanner_ref }}'), 'the pick always runs and reads the ref through env');
});

test('no run block takes an expression: every input and output reaches a script through env', () => {
  assert.equal(runSteps(windows).length, 11, 'every run step of the Windows jobs was found');
  assert.equal(runSteps(map).length, 12, 'every run step of server-map was found');
  assert.equal(runSteps(publish).length, 9, 'every run step of server-publish was found');
  for (const r of runSteps(wf)) assert.ok(!r.includes('${{'), r.split('\n').find((l) => l.includes('${{')));
  assert.match(wf, /\n {4}env:\n {6}EXPECTED_BUILDID: \$\{\{ inputs\.buildid \}\}\n {6}SCANNER_SHA256: \$\{\{ needs\.server-scanner\.outputs\.scanner_sha256 \}\}\n {6}SERVER_SCANNER_SHA256: \$\{\{ needs\.server-scanner\.outputs\.server_scanner_sha256 \}\}\n/);
});

test('shells and status functions: the Windows jobs name pwsh, the Ubuntu jobs run bash, and a status function sits only in an if', () => {
  const steps = windows.split(/\n {6}- /).slice(1);
  for (const s of steps) if (/\n {8}run:|^run:/.test(s)) assert.match(s, /\n {8}shell: pwsh\n/, s.split('\n')[0]);
  for (const j of [map, publish]) {
    assert.match(j, /\n {4}runs-on: ubuntu-latest\n/);
    assert.ok(!/shell:/.test(j), 'the default shell on Ubuntu is bash');
    assert.ok(!/\bpwsh\b|Get-|\$env:/.test(j), 'no PowerShell in a bash job');
  }
  for (const line of wf.split('\n')) if (/\b(?:cancelled|always|failure|success)\(\)/.test(line)) assert.match(line, /^\s+if: /, line);
});

test('scanner: built Client Release (layout) and Server Release (address scan) from one tree, and the check refuses any other hash for either', () => {
  const build = job(wf, 'server-scanner');
  assert.ok(build.includes('/p:Configuration="Client Release"') && build.includes('tools\\AobScan\\AobScan.vcxproj'));
  assert.ok(build.includes('/p:Configuration="Server Release"'), 'the address scanner is built Server Release');
  assert.ok(build.includes('loader/build/tools/sr-aobscan-client.exe\n            loader/build/tools/sr-aobscan-server.exe'), 'both exes are uploaded');
  assert.match(build, /server_scanner_sha256: \$\{\{ steps\.hash\.outputs\.server_sha256 \}\}/);
  assert.match(build, /sparse-checkout: tools\/AobScan/);
  assert.match(build, /scanner_sha256: \$\{\{ steps\.hash\.outputs\.sha256 \}\}/);
  const check = job(wf, 'server-layout');
  assert.match(check, /needs: server-scanner/);
  assert.ok(check.includes('is not the one server-scanner made'));
  assert.ok(check.includes('sr-aobscan-server.exe hash $s is not the one server-scanner made'), 'the server scanner is hash-checked too');
});

test('download: the unchanged anonymous script, public branch only, with no login, key or argument', () => {
  const check = job(wf, 'server-layout');
  assert.ok(check.includes('run: ./ci/download-server.ps1\n'), 'no argument: the script defaults to the public branch');
  assert.ok(!/steamcmd|STEAM_|\+login|-beta/i.test(wf), 'no Steam login in this workflow');
  const dl = read('ci', 'download-server.ps1');
  assert.ok(dl.includes('+login anonymous') && !/-beta/.test(dl), 'the script it calls is anonymous and public only');
  assert.match(check, /INSTALL_DIR: \$\{\{ steps\.dl\.outputs\.install_dir \}\}/);
  assert.ok(wf.includes("'StarRuptureServerEOS-Win64-Shipping.exe'") && wf.includes("ChangeExtension($exe.FullName, '.pdb')"), 'the exe and the PDB beside it');
});

test('identity: CL from ProductVersion, PE stamp and image size as hex strings, exe SHA-256', () => {
  const check = job(wf, 'server-layout');
  assert.ok(check.includes("$pv -notmatch 'CL-(\\d+)$'"));
  assert.ok(check.includes('$fs.Position = 0x3C') && check.includes('$fs.Position = $pe + 8') && check.includes('$fs.Position = $pe + 24 + 56'), 'TimeDateStamp at +8, SizeOfImage at +56 of the optional header');
  assert.ok(check.includes("'0x{0:X8}' -f $stamp") && check.includes("'0x{0:X8}' -f $size"));
  assert.ok(check.includes('Get-FileHash -LiteralPath $exe.FullName -Algorithm SHA256'));
  assert.ok(check.includes('::warning::The watcher saw build'), 'a build id that differs from the installed one is a warning, not a failure');
});

test('scan: the server exe is scanned by the Server Release scanner through env only, exit 0 and 1 are judged by the result step, and its JSON is uploaded', () => {
  const check = job(wf, 'server-layout');
  const scan = stepOf(check, 'Scan the server exe for the function and global addresses');
  assert.ok(scan.includes('& scanner\\sr-aobscan-server.exe $env:EXE_PATH --json > out\\server-scan.json'));
  assert.ok(!scan.slice(scan.indexOf('run: |')).includes('${{'), 'no expression inside the run block');
  assert.ok(scan.includes('EXE_PATH: ${{ steps.exe.outputs.exe_path }}') && scan.includes('          exit 0\n'), 'the exit code is judged by the result step');
  assert.ok(check.includes('elseif ([int]$env:SCAN_EXIT -notin 0, 1)'), 'exit 0 and 1 pass, anything else fails');
  assert.ok(check.includes('SCAN_EXIT: ${{ steps.scan.outputs.exit_code }}'));
  assert.ok(check.includes("'no server-scan.json'") && check.includes('server-scan.json is not JSON'));
  assert.ok(check.indexOf('- name: Scan the server exe') < check.indexOf('- name: Write the result'), 'the scan runs before the result step');
});

test('layout: the committed key list is the one scanned and the one uploaded, and a failing key is a warning', () => {
  const check = job(wf, 'server-layout');
  assert.ok(check.includes('Copy-Item ci\\server-keys.txt out\\layout-keys.txt'));
  assert.ok(check.includes('& scanner\\sr-aobscan-client.exe $env:EXE_PATH --layout out\\layout-keys.txt --json > out\\server-layout.json'));
  assert.ok(check.includes('          exit 0\n'), 'the scanner exit code is judged by the result step, not by the runner');
  assert.ok(check.includes('elseif ([int]$env:LAYOUT_EXIT -notin 0, 1)'), 'exit 0 and 1 pass, anything else, a crash included, fails');
  assert.ok(check.includes('$summary.failing -gt 0') && check.includes('::warning title=Layout keys::'));
});

test('result: server-result.json carries the identity, only four files are uploaded, and the build id is handed on', () => {
  const check = job(wf, 'server-layout');
  for (const k of ['schema        = 1', 'buildId', 'cl            =', 'imageStamp', 'imageSize', 'exeSha256', 'pdbName', 'scannerSha256', 'serverScannerSha256', 'keyCount', 'layoutRows', 'layoutExit', 'scanExit']) {
    assert.ok(check.includes(k), k);
  }
  const up = check.slice(check.lastIndexOf('- name: Upload the result'));
  assert.match(up, /name: server-check-\$\{\{ steps\.dl\.outputs\.build_id \|\| inputs\.buildid \}\}\n/);
  const paths = up.slice(up.indexOf('path: |\n') + 8, up.indexOf('if-no-files-found')).split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(paths, ['out/server-result.json', 'out/server-layout.json', 'out/layout-keys.txt', 'out/server-scan.json']);
  assert.ok(!/upload-artifact[^\n]*\n(?:.*\n)*?\s+path: .*(?:install_dir|srds|\.pdb|\.exe)/.test(check), 'no game file, PDB or log leaves the runner');
  assert.ok(check.includes('GITHUB_STEP_SUMMARY'));
  assert.match(check, /\n {4}outputs:\n {6}build_id: \$\{\{ steps\.dl\.outputs\.build_id \}\}\n/, 'the installed build id is what the next jobs name the artifact by');
});

test('server build alert: a new server build raises one issue per build id through the shared raise, and a server-only PR gets the stale timer', () => {
  const poll = watch.slice(watch.indexOf('\n  poll:\n'), watch.indexOf('\n  build:\n'));
  const step = section(poll, '      - name: Alert on a new server build\n', '      # The build was skipped because');
  assert.ok(step.length > 0, 'the step exists in the poll job, before the stale-PR step');
  assert.match(step, /if: steps\.poll\.outputs\.changed == 'true' && steps\.pr\.outputs\.skip != 'true' && inputs\.rehearsal != true && startsWith\(steps\.poll\.outputs\.server_matrix, '\[\{'\)/);
  assert.ok(step.includes('SERVER_MATRIX: ${{ steps.poll.outputs.server_matrix }}'));
  assert.ok(step.includes('node ci/pipeline-alert.mjs raise --title "SR watch: new dedicated server build $id" --body-file "$RUNNER_TEMP/server-build.md" --owner "$OWNER"'));
  assert.match(step, /a new dedicated server build, \$id,/);
  assert.match(step, /in rehearsal: the live path is closed/);
  assert.match(step, /server headers dump is manual until a server dump leg exists/);
  assert.ok(!/test.branch/i.test(step), 'no mention of the test branch');
  assert.ok(!step.slice(step.indexOf('run: |')).includes('${{'), 'no expression inside the run block');
  const stale = section(poll, '      - name: Alert on a stale game-update PR\n', '      # A planner data extract');
  assert.ok(stale.includes('SERVER_MATRIX: ${{ steps.poll.outputs.server_matrix }}'));
  assert.ok(stale.includes('JSON.parse(e.SERVER_MATRIX)'));
  assert.ok(stale.includes('"server_" + x.branch'));
});

test('server-map: the version object map header from the result, on the verified published base, and a measurement it cannot place stops it', () => {
  assert.match(map, /\n {4}needs: server-layout\n/);
  assert.ok(map.includes('name: server-check-${{ needs.server-layout.outputs.build_id }}'), 'the artifact the layout job made');
  assert.match(map, /\n {4}concurrency:\n {6}group: sr-server-map\n {6}cancel-in-progress: false\n/);
  const header = stepOf(map, 'Write the build line, the layout rows and the scan rows into a server header');
  assert.ok(header.includes('map-mode.mjs server out/server.h') && header.includes('--layout chk/server-layout.json'));
  assert.ok(header.includes('--scan out/server-scan-rows.json'), 'the function and global rows come from the converted scan');
  assert.ok(!/--client-feed|--base/.test(header), 'no client feed and no unverified base: the signed base is taken by published-base');
  const conv = stepOf(map, 'Make the function and global rows from the scan');
  assert.ok(conv.includes('server-scan-rows.mjs chk/server-scan.json --result chk/server-result.json --keys tool/ci/server-function-keys.txt') && conv.includes('--out out/server-scan-rows.json'));
  assert.ok(conv.includes('>> "$GITHUB_STEP_SUMMARY"'), 'the converter summary is appended to the job summary');
  assert.ok(map.indexOf('- name: Make the function and global rows from the scan') < map.indexOf('- name: Write the build line'), 'the rows are made before the header step reads them');
  const take = stepOf(map, 'Take the published server file as the base');
  assert.ok(take.includes('published-base.mjs take out/server.h --asset version-map-server.v1.txt'), 'the verified base (the signature is checked before a row is used)');
  assert.ok(take.includes('exit 2'), 'a hold stops the job');
  const field = stepOf(map, 'Check every layout key has a row');
  assert.ok(field.includes('map-mode.mjs complete out/server.h') && field.includes('--keys tool/ci/server-keys.txt'));
  assert.ok(field.includes('|| { echo "::error::') && field.includes('exit 2'), 'a key with no row fails the job');
  const fn = stepOf(map, 'Report the function and global keys with no row yet');
  assert.ok(fn.includes('--keys tool/ci/server-function-keys.txt') && fn.includes('case "$code" in 0|3) ;;'), 'reported only: a gap is not a failure, a crash is');
  const exp = stepOf(map, 'Export the server file and check it keeps every published line');
  assert.ok(exp.includes('version-map.mjs export-feed out/server.h --out out/server.feed.txt --server'));
  assert.ok(exp.includes('published-base.mjs preserve out/server.feed.txt --published published-base/version-map-server.v1.txt'));
  assert.ok(map.indexOf('Take the published server file') < map.indexOf('Check every layout key') && map.indexOf('Check every layout key') < map.indexOf('Export the server file'));
  const live = stepOf(map, 'Read what the live release holds (read only)');
  assert.ok(live.includes('first_publish=$first') && live.includes("a.name === 'version-map-server.v1.txt'"), 'a first server file is the only run without a base');
  assert.ok(live.includes('--pattern vmap-history.json --dir live') && live.includes('the vmap-feed release holds a server file and no vmap-history.json'), 'the history is read, never started again from nothing');
  const lastSeq = stepOf(map, "Read the published server file's seq");
  assert.ok(lastSeq.includes('vmap-sign.mjs verify published-base/version-map-server.v1.txt | sed -n'), "the server file's own last seq, from a verified file");
  const ident = stepOf(map, 'Check the version identity of the new server file');
  assert.ok(ident.includes("if: ${{ env.REHEARSAL != 'true' }}\n") && ident.includes('decide.mjs identity --repo ModLoaderServer') && ident.includes('--history live/vmap-history.json') && ident.includes('exit 2'), 'identity unless a rehearsal; a hold fails the job');
  const dry = stepOf(map, 'Sign with the TEST key as a dry run and record the seq');
  assert.ok(dry.includes('vmap-sign.mjs next-seq --last-seq "$LAST_SEQ"') && dry.includes('--key-id k1 --key-env VMAP_SIGN_KEY_TEST') && dry.includes('verify out/server.test-signed.txt --allow-test-key'), 'the chain seq above the server last seq, signed with k1 and verified');
  assert.ok(dry.includes('out/server-chain.json') && dry.includes('[ -n "$VMAP_SIGN_KEY_TEST" ]'));
  assert.ok(map.indexOf('Export the server file') < map.indexOf('Check the version identity') && map.indexOf('Check the version identity') < map.indexOf('Sign with the TEST key'));
  assert.ok(!/gh release (upload|create|edit|delete)|git push/.test(map), 'the map job writes nothing outside its runner');
  const up = map.slice(map.lastIndexOf('- name: Upload the server map result'));
  assert.ok(up.includes('name: server-map-${{ needs.server-layout.outputs.build_id }}') && up.includes('out/server.h') && up.includes('out/server.feed.txt') && up.includes('out/server-chain.json'));
  assert.ok(!/test-signed/.test(up), 'the TEST-signed file is not kept');
  assert.ok(!/\.exe|\.pdb|install_dir/.test(up), 'no game file leaves the runner');
});

test('server-publish: staging by default, the live release only with the live input; the live release is read before and after', () => {
  assert.match(publish, /\n {4}needs: \[server-layout, server-map\]\n/);
  assert.match(publish, /\n {4}concurrency:\n {6}group: vmap-publish\n {6}cancel-in-progress: false\n/);
  // The one flag: a hand dispatch of this workflow itself, with the live input true. A call from sr-watch has another workflow_ref.
  const flag = "LIVE: ${{ contains(github.workflow_ref, '/.github/workflows/sr-server-check.yml@') && github.event_name == 'workflow_dispatch' && inputs.live == true }}";
  assert.ok(publish.includes(`      ${flag}\n`), 'LIVE needs this workflow as the top-level run, a dispatch and live true');
  assert.equal((wf.match(/inputs\.live/g) ?? []).length, 1, 'no other expression reads the live input');
  assert.ok(publish.includes('      STAGING_RELEASE: vmap-feed-rehearsal\n'));
  assert.ok(publish.includes('      VMAP_ASSET: version-map-server.v1.txt\n') && publish.includes('      VMAP_HISTORY_REPO: ModLoaderServer\n'), 'the server file and the ModLoaderServer history key, through the shared routine');
  assert.ok(!/gh release (upload|create|edit|delete)|git push|--clobber/.test(wf), 'every write goes through ci/vmap-publish.sh');
  // Every step that can name the live release carries the LIVE condition; the staging ones carry its opposite.
  const live = [...publish.matchAll(/vmap-publish\.sh (\w+) vmap-feed live/g)].map((m) => m[1]);
  assert.deepEqual(live, ['feed', 'verify', 'history'], 'the three live phases, once each');
  for (const [name, phase] of [['Publish the server file to the live release', 'feed'], ['Verify the published server file', 'verify'], ['Publish the history to the live release', 'history']]) {
    const s = stepOf(publish, name);
    assert.ok(s.includes("if: ${{ env.LIVE == 'true' }}\n"), `${name}: only when LIVE`);
    assert.ok(s.includes(`vmap-publish.sh ${phase} vmap-feed live`));
  }
  assert.ok(!/vmap-feed (?:live|staging)/.test(stepOf(publish, 'Upload to the staging prerelease')), 'the staging step never names the live release');
  const stage = stepOf(publish, 'Upload to the staging prerelease');
  assert.ok(stage.includes("if: ${{ env.LIVE != 'true' }}\n"));
  for (const phase of ['feed', 'verify', 'history']) assert.ok(stage.includes(`vmap-publish.sh ${phase} "$STAGING_RELEASE" staging`));
  assert.equal((publish.match(/vmap-publish\.sh (?:feed|verify|history) /g) ?? []).length, 6, 'no other phase call');
  // The live gate: never with a rehearsal, never off main.
  const gate = stepOf(publish, 'Refuse a live publish that is not allowed');
  assert.ok(gate.includes("if: ${{ env.LIVE == 'true' }}\n") && gate.includes('"$GITHUB_REF" = refs/heads/main') && gate.includes('"$REHEARSAL" != true'));
  assert.ok(publish.indexOf('Refuse a live publish') < publish.indexOf('Sign with the release key'), 'refused before the key is used');
  // A run without live: the live assets are read before the signing and after the upload, and must be equal.
  const before = stepOf(publish, 'Read the live release');
  assert.ok(before.includes('live-assets.before.json') && before.includes('.assets[] | [.name, .id, .updated_at, .size]'));
  const after = stepOf(publish, 'Check the live release did not move');
  assert.ok(after.includes("if: ${{ env.LIVE != 'true' }}\n") && after.includes('cmp -s live-assets.before.json live-assets.after.json') && after.includes('exit 2'));
  assert.ok(publish.indexOf('Upload to the staging prerelease') < publish.indexOf('Check the live release did not move'));
});

test('server-publish: its own seq, the release key k2, the shared routine for the history, and the checks before the key is used', () => {
  const seq = stepOf(publish, 'Check the seq and the server file before signing');
  assert.ok(seq.includes("chain/server-chain.json','utf8')).seq") && seq.includes('[ "$seq" -gt "$last_seq" ]'), "the chain's seq (made above the server file's own last seq), read again against the live server file");
  assert.ok(!/next-seq/.test(publish), 'the chain makes the seq, the publish job only checks it');
  assert.ok(seq.includes('cmp -s chain/server.feed.txt feed.again.txt'), 'the file to sign is the one the map job staged');
  assert.ok(seq.includes('published-base.mjs preserve chain/server.feed.txt --published live/version-map-server.v1.txt'), 'every published line is held, read again now');
  assert.ok(seq.includes('decide.mjs identity --repo ModLoaderServer') && seq.includes('--history live/vmap-history.json'), 'the version identity, read again against the live file');
  assert.ok(seq.indexOf('if [ "$REHEARSAL" != true ]; then') < seq.indexOf('decide.mjs identity'), 'a rehearsal re-runs a CL on purpose and is not judged');
  const read = stepOf(publish, 'Read the live release');
  assert.ok(read.includes("vmap-sign.mjs verify live/version-map-server.v1.txt | sed -n 's/^ok seq=\\([0-9]*\\) .*/\\1/p'"), 'the last seq is read from a verified server file');
  assert.ok(read.includes('the history is never rebuilt from nothing') && read.includes('"releases":{},"attempts":{}'), 'a history is started only with the first server file');
  const sign = stepOf(publish, 'Sign with the release key and verify');
  assert.match(sign, /\n {10}VMAP_SIGN_KEY: \$\{\{ secrets\.VMAP_SIGN_KEY \}\}\n/);
  assert.ok(sign.includes('[ -n "$VMAP_SIGN_KEY" ]'));
  assert.ok(sign.includes('vmap-sign.mjs sign chain/server.feed.txt --out version-map-server.v1.txt --key-id k2 --last-seq "$last_seq" --seq "$CHAIN_SEQ"'));
  assert.ok(sign.includes('vmap-sign.mjs verify version-map-server.v1.txt --last-seq "$last_seq" --expect-seq "$CHAIN_SEQ"'));
  assert.ok(sign.includes('bash tool/ci/vmap-publish.sh entry'));
  assert.ok(!/echo .*\$VMAP_SIGN_KEY|printenv|\benv\b *\|/.test(wf), 'the key is never printed');
  const chain = stepOf(publish, 'Download the server map result');
  assert.ok(chain.includes('name: server-map-${{ needs.server-layout.outputs.build_id }}'));
});

test('text: no second Steam branch named, no attribution line, version object map and not the feed', () => {
  assert.ok(!wf.includes('public_test_branch'), 'no second branch named');
  assert.ok(!/Co-Authored|Generated with/.test(wf));
  assert.ok(!/\bthe feed\b/i.test(wf), 'version object map, not the feed');
});

test('sr-watch: the server-check job calls the workflow per matrix entry with the two signing keys by name and no live input', () => {
  const j = job(watch, 'server-check');
  assert.match(j, /\n {4}name: server-check \(\$\{\{ matrix\.branch \}\}\)\n/);
  assert.match(j, /\n {4}needs: poll\n/);
  assert.ok(j.includes("if: needs.poll.outputs.changed == 'true' && needs.poll.outputs.skip != 'true' && startsWith(needs.poll.outputs.server_matrix, '[{')"));
  assert.match(j, /fail-fast: false\n\s+max-parallel: 1\n\s+matrix:\n\s+include: \$\{\{ fromJSON\(needs\.poll\.outputs\.server_matrix\) \}\}/);
  assert.match(j, /\n {4}permissions:\n {6}contents: write\n {4}uses: \.\/\.github\/workflows\/sr-server-check\.yml\n/, 'contents: write is the ceiling of the called signing job');
  assert.match(j, /with:\n\s+buildid: \$\{\{ matrix\.buildid \}\}\n\s+rehearsal: \$\{\{ inputs\.rehearsal == true \}\}\n/);
  assert.match(j, /\n {4}secrets:\n {6}VMAP_SIGN_KEY_TEST: \$\{\{ secrets\.VMAP_SIGN_KEY_TEST \}\}\n {6}VMAP_SIGN_KEY: \$\{\{ secrets\.VMAP_SIGN_KEY \}\}\n/);
  assert.ok(!/inherit|secrets\.(?!VMAP_SIGN_KEY(?:_TEST)?\b)/.test(j), 'nothing but the two signing keys is passed');
  assert.ok(!/^ +live:/m.test(j) && !/\binputs\.live\b/.test(watch), 'sr-watch does not pass live, and declares no such input');
  assert.ok(!/secrets: inherit/.test(watch));
  assert.match(watch, /server_matrix: \$\{\{ steps\.poll\.outputs\.server_matrix \}\}/);
});

test('job names: none ends in a name the client check alert looks up (check, build-scanner), so a failed server job is never quoted as a client cause', () => {
  const client = read('.github', 'workflows', 'sr-client-check.yml');
  const names = [...wf.matchAll(/\n {2}([a-z][\w-]*):\n {4}name: (.*)\n/g)].map((m) => m[2]);
  assert.deepEqual(names, ['server-scanner', 'server-layout', 'server-map', 'server-publish']);
  for (const n of names) assert.ok(!new RegExp(`\\n {2}${n}:\\n`).test(client), `${n} is not a job of the client check`);
  for (const n of ['check', 'build-scanner']) assert.ok(!names.some((x) => x === n || x.endsWith(` / ${n}`)));
});

test('sr-watch: the extract and the client chain do not wait for the server check, and the download has its own concurrency group', () => {
  assert.match(job(watch, 'planner-extract'), /\n {4}needs: \[poll, client-check\]\n/);
  assert.ok(!/needs:.*server-check/.test(job(watch, 'client-check')));
  assert.ok(wf.includes('group: sr-server-check\n') && !wf.includes('sr-client-rig') && !wf.includes('sr-watch\n'));
  assert.ok(!watch.slice(watch.indexOf('\n  planner-extract:\n')).includes('server-check'));
  // The publish job shares the client chain's group (one vmap-history.json); the map job writes nothing shared and keeps its own.
  assert.ok(read('.github', 'workflows', 'sr-client-check.yml').includes('group: vmap-publish\n') && !wf.includes('group: vmap-map-mode'));
});

test('ci/server-keys.txt: one key per line, a class or Class::Member, no duplicate', () => {
  const lines = read('ci', 'server-keys.txt').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.ok(lines.length >= 100, `${lines.length} keys`);
  assert.equal(new Set(lines).size, lines.length, 'no key twice');
  for (const k of lines) assert.match(k, /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?$/, k);
  assert.ok(lines.some((k) => !k.includes('::')) && lines.some((k) => k.includes('::')), 'class sizes and members both');
});

test('ci/server-function-keys.txt: function lines only, no duplicate, the three globals, and map-mode complete reads it', () => {
  const lines = read('ci', 'server-function-keys.txt').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.ok(lines.length >= 29, `${lines.length} keys`);
  assert.equal(new Set(lines).size, lines.length, 'no key twice');
  for (const l of lines) assert.match(l, /^function \S.*\S$/, l);
  const keys = lines.map((l) => l.slice('function '.length));
  for (const g of ['GWorld', 'GNames (NamePoolData)', 'ModLoader/GObjects (GUObjectArray.ObjObjects)']) assert.ok(keys.includes(g), g);
  const layout = new Set(read('ci', 'server-keys.txt').split('\n').map((l) => l.trim()));
  assert.ok(!keys.some((k) => layout.has(k)), 'a key is either a layout key or a function key');
  // The command reads the file as the server's map job does: every key is a gap on a header with no function rows (exit 3), none unreadable (exit 2).
  const r = spawnSync(process.execPath, [join(here, 'map-mode.mjs'), 'complete', join(here, 'fixtures', 'version-map', 'server.h'), '--cl', '127004', '--keys', join(here, 'server-function-keys.txt')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 3, r.stderr + r.stdout);
  assert.match(r.stdout + r.stderr, new RegExp(`of ${keys.length} keys have no CL-127004 row`));
});

// ---- The loader's required rows (ci/server-required-rows.txt) ----

const LOADER_FIELDS = ['ACrCrafter::CraftComponent', 'UWorld::GameState', 'UWorld::LineBatchers', 'UWorld::NetDriver'];
const LOADER_GLOBALS = ['ModLoader/GObjects (GUObjectArray.ObjObjects)', 'FName::AppendString', 'GWorld'];

test('ci/server-required-rows.txt: the loader\'s four field keys and three SDK globals (no GNames), and the layout and function lists carry the keys the scans make', () => {
  const lines = read('ci', 'server-required-rows.txt').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.deepEqual(lines, [...LOADER_FIELDS.map((k) => `field ${k}`), ...LOADER_GLOBALS.map((k) => `function ${k}`)]);
  const layout = read('ci', 'server-keys.txt').split('\n').map((l) => l.trim());
  for (const k of LOADER_FIELDS) assert.ok(layout.includes(k), `${k} is a layout key`);
  const functions = read('ci', 'server-function-keys.txt').split('\n').filter((l) => l.startsWith('function ')).map((l) => l.slice('function '.length));
  for (const k of LOADER_GLOBALS) assert.ok(functions.includes(k), `${k} is a function key`);
});

test('server-map: the required-rows step runs after the layout check, skips the baseline CL, names the missing keys, and server-publish needs server-map', () => {
  const step = stepOf(map, "Check the server file carries the loader's rows");
  assert.ok(map.indexOf("- name: Check the server file carries the loader's rows") > map.indexOf('- name: Check every layout key has a row'));
  assert.ok(map.indexOf("- name: Check the server file carries the loader's rows") < map.indexOf('- name: Sign with the TEST key as a dry run'));
  assert.match(step, /BASELINE_CL: '127004'/);
  assert.match(step, /--keys tool\/ci\/server-required-rows\.txt/);
  assert.match(step, /server build \$CL is missing loader rows: .*; the server would start with its plugins off/);
  assert.ok(!/continue-on-error/.test(step), 'a miss fails the job');
  assert.match(publish, /needs\.server-map\.result == 'success'/);
});

test('required rows: a header with all seven passes; one missing two names them and exits 3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'required-rows-'));
  try {
    const cl = 130000;
    const make = (skip) => {
      const m = emptyMap('server', 127004);
      addBuild(m, { cl, stamp: 1, size: 2, source: 'server steam_build 1' });
      for (const k of LOADER_FIELDS.filter((x) => !skip.includes(x))) addField(m, { key: k, cl, offset: 8, size: 8, mask: 0 });
      for (const k of LOADER_GLOBALS.filter((x) => !skip.includes(x))) addFunction(m, k.includes('/') ? { key: k, kind: 6, fp: 0x12345678, cl, pattern: null, rva: 0x1000 } : { key: k, kind: 1, fp: 0, cl, pattern: null, rva: 0x1000 });
      return emit(m);
    };
    const run = (text) => {
      const file = join(dir, `h${text.length}.h`);
      writeFileSync(file, text);
      return spawnSync(process.execPath, [join(here, 'map-mode.mjs'), 'complete', file, '--cl', String(cl), '--keys', join(here, 'server-required-rows.txt')], { encoding: 'utf8', windowsHide: true });
    };
    const ok = run(make([]));
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.match(ok.stdout, /all 7 keys have a CL-130000 row/);
    const bad = run(make(['UWorld::LineBatchers', 'GWorld']));
    assert.equal(bad.status, 3, bad.stderr + bad.stdout);
    assert.match(bad.stderr, /missing: GWorld\n/);
    assert.match(bad.stderr, /missing: UWorld::LineBatchers\n/);
    assert.match(bad.stdout, /^2 of 7 keys have no CL-130000 row/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
