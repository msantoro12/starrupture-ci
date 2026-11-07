// Tests for the loader repository input of the build-all workflow (.github/workflows/sr-build-all.yml).
//
//   node --test ci/build-all-workflow.test.mjs
//
// Reads the workflow as text: the loader_repo input, its default, the allowlist
// that fails the job early, and that the loader checkouts use it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wf = readFileSync(join(here, '..', '.github', 'workflows', 'sr-build-all.yml'), 'utf8').replace(/\r\n/g, '\n');
const section = (start, end) => wf.slice(wf.indexOf(start), wf.indexOf(end, wf.indexOf(start)));
const call = section('  workflow_call:\n', '  schedule:\n');
const dispatch = section('  workflow_dispatch:\n', '  workflow_call:\n');
const job = (name) => {
  const rest = wf.slice(wf.indexOf(`\n  ${name}:\n`) + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

test('loader_repo: an optional input on dispatch and call, blank by default', () => {
  for (const s of [call, dispatch]) assert.match(s, /loader_repo:\n(?:.*\n)*?\s+type: string\n\s+default: ''/);
});

test('loader_repo: blank resolves to the old expression, MOD_OWNER or AlienXAXS plus StarRupture-ModLoader', () => {
  assert.match(wf, /LOADER_REPO: \$\{\{ inputs\.loader_repo \|\| format\('\{0\}\/StarRupture-ModLoader', vars\.MOD_OWNER \|\| 'AlienXAXS'\) \}\}/);
  assert.match(wf, /OWNER: \$\{\{ vars\.MOD_OWNER \|\| 'AlienXAXS' \}\}/);
});

test('loader_repo: the allowlist fails both loader-checkout jobs before the checkout', () => {
  for (const name of ['interface', 'loader']) {
    const j = job(name);
    const check = j.indexOf('- name: Check the loader repository');
    assert.ok(check >= 0, `${name}: has the check`);
    assert.ok(check < j.indexOf('actions/checkout'), `${name}: check runs before the checkout`);
    const body = j.slice(check, j.indexOf('actions/checkout'));
    assert.match(body, /''\|msantoro12\/StarRupture-ModLoader\|AlienXAXS\/StarRupture-ModLoader\) ;;/);
    assert.match(body, /\*\) echo "::error::loader_repo .* is not allowed.*exit 1/);
  }
});

test('loader_repo: every loader checkout and the compiled-in feed use it, none the bare owner', () => {
  assert.ok(!/repository: \$\{\{ env\.OWNER \}\}\/StarRupture-ModLoader/.test(wf));
  assert.equal(wf.match(/repository: \$\{\{ env\.LOADER_REPO \}\}\n\s+ref: \$\{\{ inputs\.loader_branch \|\| 'main' \}\}/g)?.length, 2);
  assert.match(wf, /MANIFEST_URL: .*\$\{\{ env\.LOADER_REPO \}\}\/releases/);
});

test('loader_branch: documented as accepting a full commit sha, and the loader job logs the repo and HEAD', () => {
  assert.match(dispatch, /loader_branch:\n\s+description: 'ModLoader branch or full commit sha'/);
  const j = job('loader');
  const at = j.indexOf('- name: Log what was checked out');
  assert.ok(at > j.indexOf('actions/checkout'));
  assert.match(j.slice(at), /echo "Loader \$LOADER_REPO at \$\(git rev-parse HEAD\)"/);
});
