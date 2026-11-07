// Tests for the Steam login wiring of the called workflows (sr-client-check.yml and
// sr-client-rig.yml) and of every workflow that calls them.
//
//   node --test ci/called-login.test.mjs
//
// Reads the workflows as text. The login is an environment secret of steam-client; a
// called job sees it only when its caller passes it, and an unpassed one reads as empty
// with no error. So every caller passes it by name, the called workflows require it,
// and a missing login fails loudly with its cause instead of skipping green.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const wfDir = join(here, '..', '.github', 'workflows');
const workflows = Object.fromEntries(readdirSync(wfDir).filter((n) => n.endsWith('.yml')).map((n) => [n, read('.github', 'workflows', n)]));
const check = workflows['sr-client-check.yml'];
const rig = workflows['sr-client-rig.yml'];
const SECRETS = ['STEAM_CI_USERNAME', 'STEAM_CI_LOGIN_CACHE'];
const CALLED = ['sr-client-check.yml', 'sr-client-rig.yml'];

// A job runs to the next job key (two-space indent) or the end of the file.
const jobs = (wf) => wf.slice(wf.indexOf('\njobs:\n') + 7).split(/\n(?= {2}[a-z][\w-]*:\n)/);
const job = (wf, name) => {
  const j = jobs(wf).find((x) => x.startsWith(`  ${name}:\n`));
  assert.ok(j, `job ${name} exists`);
  return j;
};
const step = (j, name) => {
  const at = j.indexOf(`- name: ${name}\n`);
  assert.ok(at > 0, `step "${name}" exists`);
  const next = j.indexOf('\n      - ', at + 1);
  return j.slice(at, next < 0 ? undefined : next);
};
const callSection = (wf) => {
  const at = wf.indexOf('\n  workflow_call:\n');
  const rest = wf.slice(at + 1);
  const next = rest.slice(1).search(/\n {2}[a-z_]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const passesByName = (text, name) => new RegExp(`\\n {6}${name}: \\$\\{\\{ secrets\\.${name} \\}\\}\\n`).test(text + '\n');

test('every caller of the client check or the rig passes both Steam secrets by name', () => {
  const callers = [];
  for (const [file, wf] of Object.entries(workflows)) {
    for (const j of jobs(wf)) {
      const m = j.match(/\n {4}uses: \.\/\.github\/workflows\/(sr-client-check|sr-client-rig)\.yml\n/);
      if (!m) continue;
      callers.push(`${file}:${j.match(/^ {2}([\w-]+):/)[1]}`);
      const secrets = j.slice(j.indexOf('\n    secrets:\n'));
      assert.ok(j.includes('\n    secrets:\n'), `${file}: the call has a secrets: block`);
      for (const name of SECRETS) assert.ok(passesByName(secrets, name), `${file}: passes ${name} by name`);
    }
  }
  assert.ok(callers.includes('sr-watch.yml:client-check'), `sr-watch calls the client check (found: ${callers.join(', ')})`);
});

test('the rig call example in the README passes both Steam secrets by name', () => {
  const readme = read('.github', 'sr-pipeline', 'README.md');
  const example = readme.slice(readme.indexOf('    uses: ./.github/workflows/sr-client-rig.yml'), readme.indexOf('```', readme.indexOf('    uses: ./.github/workflows/sr-client-rig.yml')));
  for (const name of SECRETS) assert.ok(passesByName(example, name), `README example passes ${name}`);
  assert.ok(!/Without a saved login the check is skipped, green/.test(readme), 'the README no longer describes a green skip');
  assert.match(readme, /gh workflow run sr-watch\.yml --ref main -f force=true/);
});

test('both called workflows declare the Steam secrets as required, and read them only in their steam-client job', () => {
  for (const file of CALLED) {
    const call = callSection(workflows[file]);
    for (const name of SECRETS) {
      assert.match(call, new RegExp(`\\n {6}${name}:\\n {8}description: [^\\n]+\\n {8}required: true\\n`), `${file}: ${name} required`);
    }
    for (const j of jobs(workflows[file])) {
      if (!/secrets\.STEAM_CI_/.test(j)) continue;
      assert.match(j, /\n {4}environment: steam-client\n/, `${file}: a job that reads the login runs in steam-client`);
    }
  }
});

test('sr-watch passes the login, the TEST key, the loader fork key and nothing else; no inherit, no release or plugin fork key', () => {
  const j = job(workflows['sr-watch.yml'], 'client-check');
  const secrets = j.slice(j.indexOf('\n    secrets:\n') + 1).trimEnd().split('\n').slice(1).map((l) => l.trim().split(':')[0]);
  assert.deepEqual(secrets.sort(), [...SECRETS, 'VMAP_SIGN_KEY_TEST', 'SR_DEPLOYKEY_MODLOADER'].sort());
  assert.ok(!/secrets: inherit/.test(workflows['sr-watch.yml']));
  assert.ok(!/\n {6}publish:/.test(j), 'publish is not passed');
});

test('client check: a missing login fails the check job with its cause, never a green skip', () => {
  const gate = step(job(check, 'check'), 'Check the Steam login secrets are set');
  assert.match(gate, /HAS_LOGIN: \$\{\{ secrets\.STEAM_CI_LOGIN_CACHE != '' && secrets\.STEAM_CI_USERNAME != '' \}\}/);
  assert.match(gate, /CALLED: \$\{\{ !contains\(github\.workflow_ref, '\/\.github\/workflows\/sr-client-check\.yml@'\) \}\}/);
  assert.match(gate, /reached the called check empty/);
  assert.match(gate, /status = 'no-login'/);
  assert.match(gate, /::error title=No Steam login::/);
  assert.match(gate, /Set-Content out\\result\.json[^\n]*\n {10}exit 1\n?$/);
  assert.ok(!/\n {8}if:/.test(gate), 'the gate always runs');
  assert.ok(!/status = 'skipped'/.test(check) && !/Client check skipped/.test(check), 'no skipped status is left');
  assert.match(step(job(check, 'check'), 'Upload the result'), /\n {8}if: always\(\)\n/, 'the no-login result is still uploaded');
});

test('rig: a missing login on a call names the caller wiring', () => {
  const gate = rig.slice(rig.indexOf('- name: Check the Steam login secrets are set'), rig.indexOf('\n      - ', rig.indexOf('- name: Check the Steam login secrets are set') + 1));
  assert.match(gate, /CALLED: \$\{\{ !contains\(github\.workflow_ref, '\/\.github\/workflows\/sr-client-rig\.yml@'\) \}\}/);
  assert.match(gate, /reached the called rig empty/);
  assert.match(gate, /exit 1/);
});

test('report and alert state the real cause, and say how to check the build again', () => {
  const report = job(check, 'report');
  assert.ok(!/No Steam login is configured for CI/.test(report), 'the old setup text is gone');
  assert.match(report, /if \(\$status -eq 'no-login'\) \{\n\s+\$md\.Add\("The client build was not checked: \$\(\$r\.reason\)\."\)/);
  assert.match(report, /if \(\$env:CHECK_RESULT -ne 'success'\)[\s\S]*gh workflow run sr-watch\.yml --ref main -f force=true/);
  const alert = job(check, 'alert');
  assert.match(step(alert, 'Download the check result'), /name: client-check-\$\{\{ inputs\.branch \}\}\n\s+path: res/);
  assert.match(alert, /if \(e\.CHECK_RESULT === "failure"\) lines\.push\("  - cause: " \+ \(r\?\.reason/);
  assert.match(alert, /gh workflow run sr-watch\.yml --ref main -f force=true/);
});

test('map mode: runs only on a successful check, and names the cause when there is no scanner result', () => {
  const mm = job(check, 'map-mode');
  assert.match(mm, /\n {4}if: \$\{\{ !cancelled\(\) && inputs\.map_mode == true && needs\.check\.result == 'success' \}\}\n/);
  const write = step(mm, 'Write the update into the header');
  const guard = write.indexOf('if [ ! -f res/scanner.json ]; then');
  assert.ok(guard > 0, 'guards the scanner result');
  assert.ok(guard < write.indexOf('res/scanner.json"'), 'before the scan list names it');
  assert.ok(guard < write.indexOf("readFileSync('res/result.json','utf8')).download"), 'before anything else reads the results');
  assert.match(write.slice(guard), /::error title=No scanner result::[^\n]*\n {12}exit 2\n/);
});

test('sr-watch: an already proposed build is skipped, and the force dispatch that checks it again is named', () => {
  const wf = workflows['sr-watch.yml'];
  assert.match(wf, /# Same build already proposed: do not re-alert or rebuild\. A failed\n\s+# check is run again by a dispatch with force/);
  assert.match(wf, /if \[ -n "\$number" \] && \[ "\$branch" = "\$want" \] && \[ "\$FORCE" != "true" \]; then/);
});
