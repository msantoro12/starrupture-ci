// Tests for the server check (.github/workflows/sr-server-check.yml), its call in sr-watch.yml and its
// key list (ci/server-keys.txt).
//
//   node --test ci/server-check-workflow.test.mjs
//
// Reads the files as text, the way the other workflow tests do: the check holds no secret, downloads the
// server anonymously, uploads only its three result files, and a failure of it reaches the alert job.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('triggers: workflow_call and workflow_dispatch, each with buildid and rehearsal, and nothing else', () => {
  const on = section(wf, '\non:\n', '\npermissions:');
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):\n/gm)].map((m) => m[1]), ['workflow_call', 'workflow_dispatch']);
  for (const s of [call, dispatch]) {
    assert.match(s, /buildid:\n(?:.*\n)*?\s+type: string\n\s+default: ''/);
    assert.match(s, /rehearsal:\n(?:.*\n)*?\s+type: boolean\n\s+default: false/);
  }
  assert.ok(!/pull_request|schedule:|push:/.test(on), 'no trigger a stranger can pull');
});

test('trust: no secret, no environment, contents: read only, and an owner allow list for the repositories it builds', () => {
  assert.ok(!/secrets\./.test(wf) && !/\n\s+secrets:/.test(wf) && !wf.includes('inherit'), 'no secret in or passed to it');
  assert.ok(!/\n\s+environment:/.test(wf), 'no environment');
  assert.match(wf, /\npermissions: \{\}\n/);
  for (const name of ['server-scanner', 'server-layout']) assert.match(job(wf, name), /\n {4}permissions:\n {6}contents: read\n/, `${name}: contents: read`);
  assert.ok(!/(?:pull-requests|issues|actions|checks|id-token|packages):/.test(wf), 'asks for no other permission');
  const build = job(wf, 'server-scanner');
  assert.ok(build.includes("'^(msantoro12|AlienXAXS)/StarRupture-ModLoader$'") && build.includes('is not allowed'));
  assert.ok((wf.match(/persist-credentials: false/g) ?? []).length === (wf.match(/uses: actions\/checkout@/g) ?? []).length, 'no checkout keeps the token');
});

test('no run block takes an expression: every input reaches a script through env', () => {
  const blocks = [...wf.matchAll(/\n( +)run: \|\n((?:\1 .*\n|\n)*)/g)].map((m) => m[2]);
  const oneLiners = [...wf.matchAll(/\n +run: (?!\|).*/g)].map((m) => m[0]);
  assert.equal(blocks.length + oneLiners.length, 9, 'every run step was found');
  for (const r of [...blocks, ...oneLiners]) assert.ok(!r.includes('${{'), r.split('\n').find((l) => l.includes('${{')));
  assert.match(wf, /\n {4}env:\n {6}EXPECTED_BUILDID: \$\{\{ inputs\.buildid \}\}\n {6}SCANNER_SHA256: \$\{\{ needs\.server-scanner\.outputs\.scanner_sha256 \}\}\n/);
});

test('shells and status functions: every step with run names pwsh, and a status function sits only in an if', () => {
  const steps = wf.split(/\n {6}- /).slice(1);
  for (const s of steps) if (/\n {8}run:|^run:/.test(s)) assert.match(s, /\n {8}shell: pwsh\n/, s.split('\n')[0]);
  for (const line of wf.split('\n')) if (/\b(?:cancelled|always|failure|success)\(\)/.test(line)) assert.match(line, /^\s+if: /, line);
});

test('scanner: built Client Release like the client check, and the check refuses any other hash', () => {
  const build = job(wf, 'server-scanner');
  assert.ok(build.includes('/p:Configuration="Client Release"') && build.includes('tools\\AobScan\\AobScan.vcxproj'));
  assert.match(build, /sparse-checkout: tools\/AobScan/);
  assert.match(build, /scanner_sha256: \$\{\{ steps\.hash\.outputs\.sha256 \}\}/);
  const check = job(wf, 'server-layout');
  assert.match(check, /needs: server-scanner/);
  assert.ok(check.includes('is not the one server-scanner made'));
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

test('layout: the committed key list is the one scanned and the one uploaded, and a failing key is a warning', () => {
  const check = job(wf, 'server-layout');
  assert.ok(check.includes('Copy-Item ci\\server-keys.txt out\\layout-keys.txt'));
  assert.ok(check.includes('& scanner\\sr-aobscan-client.exe $env:EXE_PATH --layout out\\layout-keys.txt --json > out\\server-layout.json'));
  assert.ok(check.includes('          exit 0\n'), 'the scanner exit code is judged by the result step, not by the runner');
  assert.ok(check.includes('elseif ([int]$env:LAYOUT_EXIT -notin 0, 1)'), 'exit 0 and 1 pass, anything else, a crash included, fails');
  assert.ok(check.includes('$summary.failing -gt 0') && check.includes('::warning title=Layout keys::'));
});

test('result: server-result.json carries the identity, and only three files are uploaded', () => {
  const check = job(wf, 'server-layout');
  for (const k of ['schema        = 1', 'buildId', 'cl            =', 'imageStamp', 'imageSize', 'exeSha256', 'pdbName', 'scannerSha256', 'keyCount', 'layoutRows', 'layoutExit']) {
    assert.ok(check.includes(k), k);
  }
  const up = check.slice(check.lastIndexOf('- name: Upload the result'));
  assert.match(up, /name: server-check-\$\{\{ steps\.dl\.outputs\.build_id \|\| inputs\.buildid \}\}\n/);
  const paths = up.slice(up.indexOf('path: |\n') + 8, up.indexOf('if-no-files-found')).split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(paths, ['out/server-result.json', 'out/server-layout.json', 'out/layout-keys.txt']);
  assert.ok(!/upload-artifact[^\n]*\n(?:.*\n)*?\s+path: .*(?:install_dir|srds|\.pdb|\.exe)/.test(check), 'no game file, PDB or log leaves the runner');
  assert.ok(check.includes('GITHUB_STEP_SUMMARY'));
});

test('text: no second Steam branch named, no attribution line, version object map and not the feed', () => {
  assert.ok(!wf.includes('public_test_branch'), 'no second branch named');
  assert.ok(!/Co-Authored|Generated with/.test(wf));
  assert.ok(!/\bthe feed\b/i.test(wf), 'version object map, not the feed');
});

test('sr-watch: the server-check job calls the workflow per matrix entry with no secret and contents: read only', () => {
  const j = job(watch, 'server-check');
  assert.match(j, /\n {4}name: server-check \(\$\{\{ matrix\.branch \}\}\)\n/);
  assert.match(j, /\n {4}needs: poll\n/);
  assert.ok(j.includes("if: needs.poll.outputs.changed == 'true' && needs.poll.outputs.skip != 'true' && startsWith(needs.poll.outputs.server_matrix, '[{')"));
  assert.match(j, /fail-fast: false\n\s+max-parallel: 1\n\s+matrix:\n\s+include: \$\{\{ fromJSON\(needs\.poll\.outputs\.server_matrix\) \}\}/);
  assert.match(j, /\n {4}permissions:\n {6}contents: read\n {4}uses: \.\/\.github\/workflows\/sr-server-check\.yml\n/);
  assert.match(j, /with:\n\s+buildid: \$\{\{ matrix\.buildid \}\}\n\s+rehearsal: \$\{\{ inputs\.rehearsal == true \}\}\n/);
  assert.ok(!/secrets:|secrets\.|inherit/.test(j), 'nothing secret is passed to it');
  assert.match(watch, /server_matrix: \$\{\{ steps\.poll\.outputs\.server_matrix \}\}/);
});

test('job names: neither job ends in a name the client check alert looks up (check, build-scanner), so a failed server job is never quoted as a client cause', () => {
  const client = read('.github', 'workflows', 'sr-client-check.yml');
  const names = [...wf.matchAll(/\n {2}([a-z][\w-]*):\n {4}name: (.*)\n/g)].map((m) => m[2]);
  assert.deepEqual(names, ['server-scanner', 'server-layout']);
  for (const n of names) assert.ok(!new RegExp(`\\n {2}${n}:\\n`).test(client), `${n} is not a job of the client check`);
  for (const n of ['check', 'build-scanner']) assert.ok(!names.some((x) => x === n || x.endsWith(` / ${n}`)));
});

test('sr-watch: the extract and the client chain do not wait for the server check, and it has its own concurrency group', () => {
  assert.match(job(watch, 'planner-extract'), /\n {4}needs: \[poll, client-check\]\n/);
  assert.ok(!/needs:.*server-check/.test(job(watch, 'client-check')));
  assert.ok(wf.includes('group: sr-server-check\n') && !wf.includes('sr-client-rig') && !wf.includes('sr-watch\n'));
  assert.ok(!watch.slice(watch.indexOf('\n  planner-extract:\n')).includes('server-check'));
});

test('ci/server-keys.txt: one key per line, a class or Class::Member, no duplicate', () => {
  const lines = read('ci', 'server-keys.txt').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.ok(lines.length >= 100, `${lines.length} keys`);
  assert.equal(new Set(lines).size, lines.length, 'no key twice');
  for (const k of lines) assert.match(k, /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?$/, k);
  assert.ok(lines.some((k) => !k.includes('::')) && lines.some((k) => k.includes('::')), 'class sizes and members both');
});
