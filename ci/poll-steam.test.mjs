// Tests for .github/sr-pipeline/poll-steam.mjs (version-map step 44).
//
//   node --test ci/poll-steam.test.mjs
//
// The script runs as a child process against a local stand-in for the Steam info
// API (SR_STEAMCMD_API, SR_NEWS_API): no network, no Steam login.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '.github', 'sr-pipeline', 'poll-steam.mjs');

const branch = (buildid, timeupdated, extra = {}) => ({ buildid: String(buildid), timeupdated: String(timeupdated), ...extra });
const CLIENT = '1631270';
const SERVER = '3809400';

// info: { [appid]: { [branch]: {...} } } served as the steamcmd.net v1/info answer.
async function withApi(info, fn) {
  const server = createServer((req, res) => {
    const m = /\/v1\/info\/(\d+)/.exec(req.url);
    res.setHeader('content-type', 'application/json');
    if (m && info[m[1]]) res.end(JSON.stringify({ status: 'success', data: { [m[1]]: { depots: { branches: info[m[1]] } } } }));
    else if (req.url.includes('GetNewsForApp')) res.end(JSON.stringify({ appnews: { newsitems: [{ title: 'Patch', url: 'https://example.invalid/n', date: 1760000000 }] } }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

function run(base, state, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'pollsteam-'));
  const statePath = join(dir, 'steam.json');
  if (state) writeFileSync(statePath, JSON.stringify(state));
  const out = join(dir, 'out');
  const ghOut = join(dir, 'gh-output.txt');
  writeFileSync(ghOut, '');
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, '--state', statePath, '--out-dir', out, ...extraArgs], {
      env: { ...process.env, SR_STEAMCMD_API: base, SR_NEWS_API: base, GITHUB_OUTPUT: ghOut, GITHUB_STEP_SUMMARY: join(dir, 'summary.md') },
      windowsHide: true,
    });
    let log = '';
    p.stdout.on('data', (d) => { log += d; });
    p.stderr.on('data', (d) => { log += d; });
    p.on('close', (code) => {
      const outputs = Object.fromEntries(readFileSync(ghOut, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      resolve({ code, log, outputs, state: JSON.parse(readFileSync(statePath, 'utf8')), file: (n) => readFileSync(join(out, n), 'utf8') });
    });
  });
}

const recorded = {
  schema: 1,
  apps: {
    [CLIENT]: { name: 'StarRupture', branches: { public: { buildid: '100', timeupdated: 1000 }, public_test_branch: { buildid: '110', timeupdated: 1100 } } },
    [SERVER]: { name: 'StarRupture Dedicated Server', branches: { public: { buildid: '200', timeupdated: 2000 } } },
  },
};
const serverInfo = { public: branch(200, 2000) };

test('a second client beta is tracked the day it appears and goes to the client matrix', async () => {
  const info = {
    [CLIENT]: { public: branch(100, 1000), public_test_branch: branch(110, 1100), beta_two: branch(120, 1200) },
    [SERVER]: serverInfo,
  };
  const r = await withApi(info, (base) => run(base, recorded));
  assert.equal(r.code, 0, r.log);
  assert.equal(r.outputs.changed, 'true');
  assert.deepEqual(JSON.parse(r.outputs.client_matrix), [{ branch: 'beta_two', buildid: '120', other_buildid: '100' }]);
  assert.equal(r.state.apps[CLIENT].branches.beta_two.buildid, '120');
  assert.equal(r.file('pr-branch.txt'), 'game-update/client-beta_two-120');
  assert.match(r.file('pr-body.md'), /\| StarRupture \| beta_two \| \(new branch\) \| 120 \|/);
});

test('a password-protected branch is not tracked, and an unchanged poll raises no alert', async () => {
  const info = {
    [CLIENT]: { public: branch(100, 1000), public_test_branch: branch(110, 1100), insiders: branch(300, 3000, { pwdrequired: '1' }) },
    [SERVER]: serverInfo,
  };
  const r = await withApi(info, (base) => run(base, recorded));
  assert.equal(r.code, 0, r.log);
  assert.equal(r.outputs.changed, 'false');
  assert.equal(r.outputs.client_matrix, '[]');
  assert.equal(r.state.apps[CLIENT].branches.insiders, undefined);
});

test('a forced run lists every recorded client branch, the second beta included', async () => {
  const state = structuredClone(recorded);
  state.apps[CLIENT].branches.beta_two = { buildid: '120', timeupdated: 1200 };
  const info = { [CLIENT]: { public: branch(100, 1000), public_test_branch: branch(110, 1100), beta_two: branch(120, 1200) }, [SERVER]: serverInfo };
  const r = await withApi(info, (base) => run(base, state, ['--force']));
  assert.equal(r.outputs.changed, 'true');
  assert.deepEqual(JSON.parse(r.outputs.client_matrix).map((m) => m.branch), ['public', 'public_test_branch', 'beta_two']);
});

test('a stale answer on the second beta is ignored', async () => {
  const state = structuredClone(recorded);
  state.apps[CLIENT].branches.beta_two = { buildid: '120', timeupdated: 1200 };
  const info = { [CLIENT]: { public: branch(100, 1000), public_test_branch: branch(110, 1100), beta_two: branch(119, 1150) }, [SERVER]: serverInfo };
  const r = await withApi(info, (base) => run(base, state));
  assert.equal(r.outputs.changed, 'false');
  assert.equal(r.state.apps[CLIENT].branches.beta_two.buildid, '120');
  assert.match(r.log, /stale API answer/);
});

test('the client matrix names the build id of the other client branch, public and the other branch being each other', async () => {
  const info = {
    [CLIENT]: { public: branch(101, 1010), public_test_branch: branch(111, 1110) },
    [SERVER]: serverInfo,
  };
  const r = await withApi(info, (base) => run(base, recorded));
  assert.equal(r.code, 0, r.log);
  const m = JSON.parse(r.outputs.client_matrix);
  // Both moved: each check gets the OTHER branch's new id, as of this poll.
  assert.deepEqual(m, [{ branch: 'public', buildid: '101', other_buildid: '111' }, { branch: 'public_test_branch', buildid: '111', other_buildid: '101' }]);
  // Only the other branch moved: public's recorded id is its current one.
  const one = await withApi({ [CLIENT]: { public: branch(100, 1000), public_test_branch: branch(111, 1110) }, [SERVER]: serverInfo }, (base) => run(base, recorded));
  assert.deepEqual(JSON.parse(one.outputs.client_matrix), [{ branch: 'public_test_branch', buildid: '111', other_buildid: '100' }]);
  // A forced run carries it for every recorded branch.
  const forced = await withApi({ [CLIENT]: { public: branch(100, 1000), public_test_branch: branch(110, 1100) }, [SERVER]: serverInfo }, (base) => run(base, recorded, ['--force']));
  assert.deepEqual(JSON.parse(forced.outputs.client_matrix), [{ branch: 'public', buildid: '100', other_buildid: '110' }, { branch: 'public_test_branch', buildid: '110', other_buildid: '100' }]);
  // No other client branch recorded: the id is empty, never missing.
  const solo = structuredClone(recorded);
  delete solo.apps[CLIENT].branches.public_test_branch;
  const alone = await withApi({ [CLIENT]: { public: branch(105, 1050) }, [SERVER]: serverInfo }, (base) => run(base, solo));
  assert.deepEqual(JSON.parse(alone.outputs.client_matrix), [{ branch: 'public', buildid: '105', other_buildid: '' }]);
});

// --live-buildid <branch>: one branch's current id, from the API, nothing recorded.
function runLive(base, liveBranch) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, '--live-buildid', liveBranch], {
      env: { ...process.env, SR_STEAMCMD_API: base, SR_NEWS_API: base },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('--live-buildid prints the live id of the branch alone, ignoring any recorded state', async () => {
  const info = { [CLIENT]: { public: branch(101, 1010), public_test_branch: branch(111, 1110) }, [SERVER]: serverInfo };
  const r = await withApi(info, (base) => runLive(base, 'public_test_branch'));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '111\n');
  const other = await withApi(info, (base) => runLive(base, 'public'));
  assert.equal(other.stdout, '101\n');
});

test('--live-buildid fails closed when the branch is not listed, naming it, with nothing on stdout', async () => {
  const info = { [CLIENT]: { public: branch(101, 1010) }, [SERVER]: serverInfo };
  const r = await withApi(info, (base) => runLive(base, 'public_test_branch'));
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /could not read the live build id of StarRupture\/public_test_branch: Steam lists no open branch 'public_test_branch'/);
});

test('--live-buildid fails closed when the API does not answer, after the poll\'s retries', { timeout: 60000 }, async () => {
  const r = await withApi({}, (base) => runLive(base, 'public'));
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /attempt 3\/3 failed/);
  assert.match(r.stderr, /could not read the live build id of StarRupture\/public: HTTP 404/);
});
