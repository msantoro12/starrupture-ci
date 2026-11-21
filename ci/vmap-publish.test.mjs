// Tests for vmap-publish.sh, the publish routine of the version object map, with a fake `gh` that keeps the releases in a folder:
// which file it publishes, which history key it writes, and that it stays on the target release it is given.
//
//   node --test ci/vmap-publish.test.mjs
//
// The verify phase needs a feed signed with the release key (k2), which no test holds; it is read in the workflow tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LF = (s) => s.replace(/\r\n/g, '\n');
const fwd = (p) => p.replaceAll('\\', '/');
const hasBash = spawnSync('bash', ['-c', 'true'], { windowsHide: true }).status === 0;

// A `gh` function that logs every call and keeps uploaded files under $FAKE_GH_STORE/<release>/.
const FAKE_GH = `gh() {
  echo "gh $*" >> "$FAKE_GH_LOG"
  case "$1 $2" in
    "release view")
      case "$*" in *--json*) echo true ;; esac
      return 0 ;;
    "release create") return 0 ;;
    "release upload")
      rel="$3"; shift 3
      mkdir -p "$FAKE_GH_STORE/$rel"
      for f in "$@"; do case "$f" in --*) ;; *) cp "$f" "$FAKE_GH_STORE/$rel/" ;; esac; done
      return 0 ;;
    "release download")
      rel="$3"; pat=""; dir=""; shift 3
      while [ $# -gt 0 ]; do case "$1" in --pattern) pat="$2"; shift ;; --dir) dir="$2"; shift ;; esac; shift; done
      mkdir -p "$dir"
      cp "$FAKE_GH_STORE/$rel/$pat" "$dir/"
      return $? ;;
  esac
  echo "unexpected gh call: $*" >&2
  return 1
}
`;

// A work directory laid out as the jobs have it: tool/ci (this folder's scripts), the live history, the chain decision and the signed feed.
function work(asset) {
  const dir = mkdtempSync(join(tmpdir(), 'vmap-publish-'));
  const p = (...parts) => join(dir, ...parts);
  cpSync(here, p('tool', 'ci'), { recursive: true, filter: (src) => !/[\\/]fixtures([\\/]|$)/.test(src) && !/\.test\.mjs$/.test(src) });
  mkdirSync(p('live'));
  mkdirSync(p('chain'));
  writeFileSync(p('live', 'vmap-history.json'), JSON.stringify({ releases: {}, attempts: {} }));
  writeFileSync(p('chain', 'decision.json'), JSON.stringify({ cl: 127004 }));
  // The sig line is a placeholder: the routine's unique check reads rows, and the verify phase is not run here.
  const feed = LF(readFileSync(join(here, 'fixtures', 'version-map', 'server.feed.txt'), 'utf8')).replace('\n', '\nseq\t1761900000\n') + 'sig\tk2\tAAAA\n';
  writeFileSync(p(asset), feed);
  writeFileSync(p('fake-gh.sh'), FAKE_GH);
  writeFileSync(p('summary.md'), '');
  return { dir, p, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(w, args, env = {}) {
  const r = spawnSync('bash', ['-c', 'source "$1"; export -f gh; shift; exec bash "$@"', '_', fwd(w.p('fake-gh.sh')), 'tool/ci/vmap-publish.sh', ...args], {
    cwd: w.dir,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env, GH_REPO: 'o/r', CHAIN_SEQ: '1761900000', FIRST_PUBLISH: '', ACTOR: 'a', RUN_ID: '1',
      GITHUB_STEP_SUMMARY: fwd(w.p('summary.md')), FAKE_GH_LOG: fwd(w.p('gh.log')), FAKE_GH_STORE: fwd(w.p('store')), ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: existsSync(w.p('gh.log')) ? readFileSync(w.p('gh.log'), 'utf8') : '' };
}

const SERVER = { VMAP_ASSET: 'version-map-server.v1.txt', VMAP_HISTORY_REPO: 'ModLoaderServer' };

test('the server pair: the history entry is ModLoaderServer:<CL>, and the staged feed and history go to the staging release only', { skip: !hasBash }, () => {
  const w = work('version-map-server.v1.txt');
  try {
    let r = run(w, ['entry'], SERVER);
    assert.equal(r.status, 0, r.stderr);
    const history = JSON.parse(readFileSync(w.p('vmap-history.json'), 'utf8'));
    assert.deepEqual(Object.keys(history.releases), ['ModLoaderServer:127004']);
    assert.equal(history.releases['ModLoaderServer:127004'].seq, 1761900000);

    r = run(w, ['feed', 'vmap-feed-rehearsal', 'staging'], SERVER);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(existsSync(w.p('store', 'vmap-feed-rehearsal', 'version-map-server.v1.txt')), 'the server file is on the staging release');
    assert.ok(!existsSync(w.p('store', 'vmap-feed-rehearsal', 'version-map-client.v1.txt')), 'the client file is not');
    assert.match(readFileSync(w.p('summary.md'), 'utf8'), /If the staged feed \(seq 1761900000\) is up on vmap-feed-rehearsal/);

    // The verify phase is skipped (no k2 here): the copy it would download stands in, then the history phase runs.
    mkdirSync(w.p('published'));
    writeFileSync(w.p('published', 'version-map-server.v1.txt'), readFileSync(w.p('version-map-server.v1.txt')));
    r = run(w, ['history', 'vmap-feed-rehearsal', 'staging'], SERVER);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const stored = JSON.parse(readFileSync(w.p('store', 'vmap-feed-rehearsal', 'vmap-history.json'), 'utf8'));
    assert.deepEqual(Object.keys(stored.releases), ['ModLoaderServer:127004']);
    assert.match(readFileSync(w.p('summary.md'), 'utf8'), /Rehearsal: staged the feed on vmap-feed-rehearsal \(prerelease\): seq 1761900000.* The live release was not written\./);

    // Every gh call names the staging release; the live one is never named.
    const writes = r.log.split('\n').filter((l) => /^gh release (upload|create|edit|delete)/.test(l));
    assert.ok(writes.length > 0);
    assert.ok(!/ vmap-feed( |$)/.test(r.log), r.log);
    assert.ok(!existsSync(w.p('store', 'vmap-feed')));
  } finally { w.done(); }
});

test('the client pair is the default: the client file and the ModLoader key', { skip: !hasBash }, () => {
  const w = work('version-map-client.v1.txt');
  try {
    let r = run(w, ['entry']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(w.p('vmap-history.json'), 'utf8')).releases), ['ModLoader:127004']);
    r = run(w, ['feed', 'vmap-feed-rehearsal', 'staging']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(existsSync(w.p('store', 'vmap-feed-rehearsal', 'version-map-client.v1.txt')));
    assert.ok(!existsSync(w.p('store', 'vmap-feed-rehearsal', 'version-map-server.v1.txt')));
  } finally { w.done(); }
});

test('a file and a history repo that are not a pair stop the routine before any gh call', { skip: !hasBash }, () => {
  const w = work('version-map-server.v1.txt');
  try {
    for (const env of [
      { VMAP_ASSET: 'version-map-server.v1.txt' },
      { VMAP_HISTORY_REPO: 'ModLoaderServer' },
      { VMAP_ASSET: 'version-map-client.v1.txt', VMAP_HISTORY_REPO: 'ModLoaderServer' },
      { VMAP_ASSET: 'version-map-server.v1.txt', VMAP_HISTORY_REPO: 'ModLoader' },
      { VMAP_ASSET: 'vmap-history.json', VMAP_HISTORY_REPO: 'ModLoader' },
      { VMAP_ASSET: '../version-map-server.v1.txt', VMAP_HISTORY_REPO: 'ModLoaderServer' },
    ]) {
      for (const phase of [['entry'], ['feed', 'vmap-feed', 'live']]) {
        const r = run(w, phase, env);
        assert.equal(r.status, 2, `${JSON.stringify(env)} ${phase[0]}: ${r.stderr}`);
        assert.match(r.stderr, /name no known pair/);
        assert.equal(r.log, '', 'no gh call');
      }
    }
    assert.ok(!existsSync(w.p('vmap-history.json')), 'nothing was written');
  } finally { w.done(); }
});
