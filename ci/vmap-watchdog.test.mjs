// Tests for vmap-watchdog.mjs.
//
//   node --test ci/vmap-watchdog.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lag, MAX_LAG_SECONDS, seqOf } from './vmap-watchdog.mjs';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'vmap-watchdog.mjs');
const feed = (seq) => `format\t1\nseq\t${seq}\nbuild\t1\t0x1\t0x1\tx\nsig\tk1\tAAAA\n`;

test('reads the seq of a signed feed and nothing else', () => {
  assert.equal(seqOf(feed(1800000000), 'f'), 1800000000);
  assert.throws(() => seqOf('seq\t5\nformat\t1\n', 'f'), /not a signed feed/);
  assert.throws(() => seqOf('format\t1\nseq\t05\n', 'f'), /not a signed feed/);
});

test('current, at the limit, lagging and no feed on Latest', () => {
  const S = 1800000000;
  assert.equal(lag(S, S).lagging, false);
  assert.equal(lag(S, S - MAX_LAG_SECONDS).lagging, false);
  assert.equal(lag(S, S - MAX_LAG_SECONDS - 1).lagging, true);
  assert.equal(lag(S, S + 5).lagging, false);
  assert.match(lag(S, null).message, /no feed/);
  assert.equal(lag(S, S - 61, 60).lagging, true);
});

test('the command line exits 0 and 3, and 2 on bad input (a staged lag)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vmap-watchdog-'));
  const f = (name, seq) => { const p = join(dir, name); writeFileSync(p, feed(seq)); return p; };
  const run = (...a) => spawnSync(process.execPath, [TOOL, 'check', ...a], { encoding: 'utf8', windowsHide: true });
  const signed = f('signed.txt', 1800010000);
  assert.equal(run('--signed', signed, '--published', f('cur.txt', 1800009000)).status, 0);
  const staged = run('--signed', signed, '--published', f('old.txt', 1800000000));
  assert.equal(staged.status, 3);
  assert.match(staged.stdout, /behind/);
  assert.equal(run('--signed', signed, '--published', '-').status, 3);
  assert.equal(run('--signed', signed, '--published', join(dir, 'missing.txt')).status, 2);
  assert.equal(run('--signed', signed).status, 2);
});

// The workflow runs the watchdog once for each version object map asset.
const wf = readFileSync(join(dirname(TOOL), '..', '.github', 'workflows', 'vmap-watchdog.yml'), 'utf8').replace(/\r\n/g, '\n');
const bash = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find(existsSync) : 'bash';

test('the workflow runs for the client, the server and the mod index asset, each leg on its own', () => {
  assert.match(wf, /strategy:\n\s+fail-fast: false\n\s+matrix:\n\s+include:\n\s+- asset: version-map-client\.v1\.txt\n\s+title: The version-map feed on the loader's Latest release is behind\n\s+- asset: version-map-server\.v1\.txt\n\s+title: The server version object map on the loader's Latest release is behind\n\s+- asset: mod-index\.v1\.txt\n\s+title: The signed mod index on the loader's Latest release is behind\n/);
  assert.match(wf, /FEED_ASSET: \$\{\{ matrix\.asset \}\}\n\s+ISSUE_TITLE: \$\{\{ matrix\.title \}\}\n/);
});

test('a server asset not yet published exits cleanly and opens no issue', () => {
  const step = wf.slice(wf.indexOf('      - name: Fetch both feeds'), wf.indexOf('      - name: Compare'));
  const script = step.slice(step.indexOf('run: |\n') + 7).replace(/^ {10}/gm, '');
  assert.match(wf, /- name: Compare\n\s+id: compare\n\s+if: steps\.fetch\.outputs\.signed == 'true'/);
  assert.match(wf, /- name: Open an issue\n\s+if: steps\.compare\.outputs\.lagging == 'true'/);
  const dir = mkdtempSync(join(tmpdir(), 'vmap-watchdog-wf-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // gh finds no asset on the vmap-feed release; any call is recorded.
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "$*" >> "$RUNNER_TEMP/calls.log"\ncase "$1 $2" in "release download") exit 1 ;; esac\nexit 0\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const out = join(dir, 'out.txt');
  writeFileSync(out, '');
  const r = spawnSync(bash, ['-c', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: out, GITHUB_REPOSITORY: 'o/r', LOADER_REPO: 'o/l', FEED_ASSET: 'version-map-server.v1.txt', PATH: bin + delimiter + process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, 'utf8').trim(), 'signed=false');
  const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
  assert.equal(calls.length, 1, 'only the signed download was tried');
  assert.ok(calls[0].includes('--pattern version-map-server.v1.txt'));
  assert.ok(!existsSync(join(dir, 'message.txt')));
});
