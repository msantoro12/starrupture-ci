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

// The legs of a check follow the branches Steam lists now, from .github/sr-pipeline/rig-branches.json.
test('a client branch Steam no longer lists is neither checked nor paired, and its recorded entry is left alone', async () => {
  // public_test_branch is recorded (build 110) but Steam lists only public now.
  const gone = { [CLIENT]: { public: branch(101, 1010) }, [SERVER]: serverInfo };
  const r = await withApi(gone, (base) => run(base, recorded));
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(JSON.parse(r.outputs.client_matrix), [{ branch: 'public', buildid: '101', other_buildid: '' }]);
  // Read-only: a partial answer must not forget a real branch, so the recorded entry stays.
  assert.equal(r.state.apps[CLIENT].branches.public_test_branch.buildid, '110');
  // A forced run lists only what Steam lists now, and the alert body names no vanished branch.
  const forced = await withApi(gone, (base) => run(base, recorded, ['--force']));
  assert.deepEqual(JSON.parse(forced.outputs.client_matrix), [{ branch: 'public', buildid: '101', other_buildid: '' }]);
  assert.ok(!/public_test_branch/.test(forced.file('pr-body.md')), 'a branch Steam does not list is not in the update PR');
  // Both listed: the same as before (each is the other's pair, with the current ids).
  const both = await withApi({ [CLIENT]: { public: branch(101, 1010), public_test_branch: branch(111, 1110) }, [SERVER]: serverInfo }, (base) => run(base, recorded));
  assert.deepEqual(JSON.parse(both.outputs.client_matrix), [{ branch: 'public', buildid: '101', other_buildid: '111' }, { branch: 'public_test_branch', buildid: '111', other_buildid: '101' }]);
});

function runOther(base, pair, dir = null) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [dir ? join(dir, 'poll-steam.mjs') : SCRIPT, '--other-branch', pair], {
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

test('--other-branch prints the other rigged branch Steam lists now and its build id, or an empty line when there is none', async () => {
  const both = { [CLIENT]: { public: branch(101, 1010), public_test_branch: branch(111, 1110) }, [SERVER]: serverInfo };
  assert.equal((await withApi(both, (base) => runOther(base, 'public'))).stdout, 'public_test_branch 111\n');
  assert.equal((await withApi(both, (base) => runOther(base, 'public_test_branch'))).stdout, 'public 101\n');
  // One listed: no other branch. Success, an empty answer.
  const one = await withApi({ [CLIENT]: { public: branch(101, 1010) }, [SERVER]: serverInfo }, (base) => runOther(base, 'public'));
  assert.equal(one.code, 0, one.stderr);
  assert.equal(one.stdout, '\n');
  // A branch the list does not name is never the other one, whatever Steam lists.
  const extra = await withApi({ [CLIENT]: { public: branch(101, 1010), beta_two: branch(120, 1200) }, [SERVER]: serverInfo }, (base) => runOther(base, 'public'));
  assert.equal(extra.stdout, '\n');
});

test('--other-branch fails closed when the API does not answer, with nothing on stdout', { timeout: 60000 }, async () => {
  const r = await withApi({}, (base) => runOther(base, 'public'));
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /could not read the live branches of StarRupture: HTTP 404/);
});

test('adding a branch to rig-branches.json is all it takes to rig it: the poll pairs it and puts it in the matrix, nothing else changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pollsteam-list-'));
  writeFileSync(join(dir, 'poll-steam.mjs'), readFileSync(SCRIPT, 'utf8'));
  const list = JSON.parse(readFileSync(join(here, '..', '.github', 'sr-pipeline', 'rig-branches.json'), 'utf8'));
  writeFileSync(join(dir, 'rig-branches.json'), JSON.stringify([...list, 'v.9.9.9_new']));
  const info = { [CLIENT]: { public: branch(101, 1010), 'v.9.9.9_new': branch(130, 1300) }, [SERVER]: serverInfo };
  // Steam lists only public and the new branch: the added branch is the other one of public.
  const r = await withApi(info, (base) => runOther(base, 'public', dir));
  assert.equal(r.stdout, 'v.9.9.9_new 130\n');
  assert.equal((await withApi(info, (base) => runOther(base, 'v.9.9.9_new', dir))).stdout, 'public 101\n');
});

test('--rehearsal: the public build Steam lists now goes through unchanged, and the state file is never written', async () => {
  const info = { [CLIENT]: { public: branch(100, 1000), public_test_branch: branch(110, 1100) }, [SERVER]: serverInfo };
  // Nothing changed: without the flag the poll is quiet, with it public goes through alone.
  const quiet = await withApi(info, (base) => run(base, recorded));
  assert.equal(quiet.outputs.changed, 'false');
  assert.equal(quiet.outputs.client_matrix, '[]');
  const r = await withApi(info, (base) => run(base, recorded, ['--rehearsal']));
  assert.equal(r.code, 0, r.log);
  assert.equal(r.outputs.changed, 'true');
  assert.deepEqual(JSON.parse(r.outputs.client_matrix), [{ branch: 'public', buildid: '100', other_buildid: '110' }]);
  assert.equal(r.outputs.dirty, 'false');
  assert.deepEqual(r.state, recorded, 'the state file is what it was');
  // A build that moved: the rehearsal takes the one listed now and still writes nothing.
  const moved = await withApi({ [CLIENT]: { public: branch(101, 1010), public_test_branch: branch(111, 1110) }, [SERVER]: serverInfo }, (base) => run(base, recorded, ['--rehearsal']));
  assert.deepEqual(JSON.parse(moved.outputs.client_matrix), [{ branch: 'public', buildid: '101', other_buildid: '111' }]);
  assert.equal(moved.outputs.dirty, 'false');
  assert.deepEqual(moved.state, recorded);
});

test('--rehearsal: Steam not listing public now means nothing goes through', async () => {
  const info = { [CLIENT]: { public_test_branch: branch(110, 1100) }, [SERVER]: serverInfo };
  const r = await withApi(info, (base) => run(base, recorded, ['--rehearsal']));
  assert.equal(r.outputs.changed, 'false');
  assert.equal(r.outputs.client_matrix, '[]');
  assert.deepEqual(r.state, recorded);
});
