// Tests for plugin-catalog-publish.sh, the publish routine of the signed plugin catalog, with a fake `gh` that keeps
// the releases in a folder: no history is needed, a file that is not a signed catalog is never uploaded, the seq
// must rise above the target's own, and only the target release is written.
//
//   node --test ci/plugin-catalog-publish.test.mjs
//
// The copy of the scripts the routine runs has its two trusted public keys swapped for keys made here, so a
// catalog signed in the test verifies the way a k1 (TEST) or k2 (release) catalog does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_KEYS, signFeed } from './vmap-sign.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LF = (s) => s.replace(/\r\n/g, '\n');
const fwd = (p) => p.replaceAll('\\', '/');
const hasBash = spawnSync('bash', ['-c', 'true'], { windowsHide: true }).status === 0;
const ASSET = 'plugin-catalog.v1.txt';
const NOW = Math.floor(Date.now() / 1000);

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), hex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
};
const K1 = pair();
const K2 = pair();
const unsignedCatalog = LF(readFileSync(join(here, 'fixtures', 'plugin-catalog', 'catalog-unsigned.txt'), 'utf8'));
const catalog = (key, keyId, seq) => signFeed(unsignedCatalog, key.pem, { keyId, kind: 'catalog', seq, now: NOW }).text;

// A `gh` function that logs every call and keeps releases as folders under $FAKE_GH_STORE/<release>/.
const FAKE_GH = `gh() {
  echo "gh $*" >> "$FAKE_GH_LOG"
  case "$1 $2" in
    "release view")
      rel="$3"
      [ -d "$FAKE_GH_STORE/$rel" ] || { echo "release not found" >&2; return 1; }
      case "$*" in
        *isPrerelease*) echo true ;;
        *--json*) [ -f "$FAKE_GH_STORE/$rel/plugin-catalog.v1.txt" ] && echo true || echo false ;;
      esac
      return 0 ;;
    "release create") mkdir -p "$FAKE_GH_STORE/$3"; return 0 ;;
    "release upload")
      rel="$3"; shift 3
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

// A work directory laid out as the job has it: tool/ci (this folder's scripts, trusting the test keys) and, per
// test, the signed catalog. There is no vmap-history.json anywhere.
function work() {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-publish-'));
  const p = (...parts) => join(dir, ...parts);
  cpSync(here, p('tool', 'ci'), { recursive: true, filter: (src) => !/[\\/]fixtures([\\/]|$)/.test(src) && !/\.test\.mjs$/.test(src) });
  const signer = readFileSync(p('tool', 'ci', 'vmap-sign.mjs'), 'utf8');
  assert.ok(signer.includes(PUBLIC_KEYS.k1.hex) && signer.includes(PUBLIC_KEYS.k2.hex));
  writeFileSync(p('tool', 'ci', 'vmap-sign.mjs'), signer.replace(PUBLIC_KEYS.k1.hex, K1.hex).replace(PUBLIC_KEYS.k2.hex, K2.hex));
  writeFileSync(p('fake-gh.sh'), FAKE_GH);
  writeFileSync(p('summary.md'), '');
  const store = (...parts) => p('store', ...parts);
  // A release already on the fake host, with a catalog on it (or none).
  const release = (name, text) => { mkdirSync(store(name), { recursive: true }); if (text !== undefined) writeFileSync(store(name, ASSET), text); };
  return { dir, p, store, release, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(w, args, env = {}) {
  const r = spawnSync('bash', ['-c', 'source "$1"; export -f gh; shift; exec bash "$@"', '_', fwd(w.p('fake-gh.sh')), 'tool/ci/plugin-catalog-publish.sh', ...args], {
    cwd: w.dir,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GH_REPO: 'o/r', GITHUB_STEP_SUMMARY: fwd(w.p('summary.md')), FAKE_GH_LOG: fwd(w.p('gh.log')), FAKE_GH_STORE: fwd(w.p('store')), ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: existsSync(w.p('gh.log')) ? readFileSync(w.p('gh.log'), 'utf8') : '' };
}
const writes = (log) => log.split('\n').filter((l) => /^gh release (upload|create|edit|delete)/.test(l));

test('a first staged publish needs no history: the prerelease is made, the catalog goes up and verifies as seq N', { skip: !hasBash }, () => {
  const w = work();
  try {
    writeFileSync(w.p(ASSET), catalog(K1, 'k1', NOW - 100));
    assert.ok(!existsSync(w.p('vmap-history.json')));
    let r = run(w, ['last-seq', 'vmap-feed-rehearsal', 'staging']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '0', 'no release yet: the last seq is 0');
    r = run(w, ['publish', 'vmap-feed-rehearsal', 'staging']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(readFileSync(w.store('vmap-feed-rehearsal', ASSET), 'utf8'), readFileSync(w.p(ASSET), 'utf8'));
    assert.match(r.stdout, new RegExp(`ok seq=${NOW - 100} key=k1 TEST-KEY`));
    assert.match(r.log, /gh release create vmap-feed-rehearsal --prerelease --latest=false/);
    assert.match(readFileSync(w.p('summary.md'), 'utf8'), /Rehearsal: staged the plugin catalog on vmap-feed-rehearsal \(prerelease\): seq \d+.* The live release was not written\./);
    r = run(w, ['last-seq', 'vmap-feed-rehearsal', 'staging']);
    assert.equal(r.stdout.trim(), String(NOW - 100), 'the next last seq is the published one');
    // Every gh call names the staging release; the live one is never named.
    assert.ok(!/ vmap-feed( |$)/.test(r.log), r.log);
    assert.ok(!existsSync(w.store('vmap-feed')));
  } finally { w.done(); }
});

test('the seq must rise above the target\'s own seq: an equal or lower one is refused, a higher one replaces', { skip: !hasBash }, () => {
  const w = work();
  try {
    const held = catalog(K1, 'k1', NOW - 50);
    w.release('vmap-feed-rehearsal', held);
    for (const seq of [NOW - 50, NOW - 60]) {
      writeFileSync(w.p(ASSET), catalog(K1, 'k1', seq));
      const r = run(w, ['publish', 'vmap-feed-rehearsal', 'staging']);
      assert.equal(r.status, 2, r.stdout);
      assert.match(r.stderr + r.stdout, new RegExp(`seq ${seq} does not rise above the seq ${NOW - 50}`));
      assert.deepEqual(writes(r.log), [], 'nothing uploaded');
      assert.equal(readFileSync(w.store('vmap-feed-rehearsal', ASSET), 'utf8'), held);
    }
    const next = catalog(K1, 'k1', NOW - 40);
    writeFileSync(w.p(ASSET), next);
    const r = run(w, ['publish', 'vmap-feed-rehearsal', 'staging']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(readFileSync(w.store('vmap-feed-rehearsal', ASSET), 'utf8'), next);
    assert.match(r.log, /gh release upload vmap-feed-rehearsal plugin-catalog\.v1\.txt --clobber/);
  } finally { w.done(); }
});

test('a file that is not a signed plugin catalog is refused before any upload: a version map, an unsigned file, a changed byte, a wrong key', { skip: !hasBash }, () => {
  const w = work();
  try {
    w.release('vmap-feed-rehearsal');
    const good = catalog(K1, 'k1', NOW - 100);
    const feedText = LF(readFileSync(join(here, 'fixtures', 'version-map', 'loader.feed.txt'), 'utf8'));
    const bad = {
      'a signed version map': signFeed(feedText, K1.pem, { keyId: 'k1', now: NOW, seq: NOW - 100 }).text,
      'an unsigned catalog': unsignedCatalog,
      'a changed byte in a title': good.replace('Block tooltip', 'Block tooltiq'),
      'a catalog signed with another key': signFeed(unsignedCatalog, pair().pem, { keyId: 'k1', kind: 'catalog', now: NOW, seq: NOW - 100 }).text,
      'a catalog of 0 bytes': '',
    };
    for (const [what, text] of Object.entries(bad)) {
      writeFileSync(w.p(ASSET), text);
      const r = run(w, ['publish', 'vmap-feed-rehearsal', 'staging']);
      assert.equal(r.status, 2, `${what}: ${r.stdout}`);
      assert.match(r.stderr + r.stdout, /does not verify as a signed plugin catalog/, what);
      assert.deepEqual(writes(r.log), [], `${what}: nothing uploaded`);
    }
    assert.ok(!existsSync(w.store('vmap-feed-rehearsal', ASSET)));
  } finally { w.done(); }
});

test('a catalog on the target that does not verify stops the routine: its seq is unknown and it is not replaced', { skip: !hasBash }, () => {
  const w = work();
  try {
    w.release('vmap-feed-rehearsal', 'not a catalog\n');
    writeFileSync(w.p(ASSET), catalog(K1, 'k1', NOW - 100));
    for (const phase of ['last-seq', 'publish']) {
      const r = run(w, [phase, 'vmap-feed-rehearsal', 'staging']);
      assert.equal(r.status, 2, phase);
      assert.match(r.stderr, /does not verify, so its seq is unknown/);
    }
    assert.equal(readFileSync(w.store('vmap-feed-rehearsal', ASSET), 'utf8'), 'not a catalog\n');
  } finally { w.done(); }
});

test('live: the release key only, to the release vmap-feed only; the first publish never replaces a catalog, a later one does', { skip: !hasBash }, () => {
  const w = work();
  try {
    w.release('vmap-feed');
    // A catalog signed with the TEST key never goes live.
    writeFileSync(w.p(ASSET), catalog(K1, 'k1', NOW - 100));
    let r = run(w, ['publish', 'vmap-feed', 'live']);
    assert.equal(r.status, 2, r.stdout);
    assert.deepEqual(writes(r.log), []);
    // The release key: the first publish has no --clobber.
    writeFileSync(w.p(ASSET), catalog(K2, 'k2', NOW - 100));
    r = run(w, ['publish', 'vmap-feed', 'live']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(writes(r.log), ['gh release upload vmap-feed plugin-catalog.v1.txt']);
    assert.match(readFileSync(w.p('summary.md'), 'utf8'), /Published the plugin catalog to vmap-feed: seq \d+, release key k2/);
    // The next one rises above it and replaces it.
    writeFileSync(w.p(ASSET), catalog(K2, 'k2', NOW - 90));
    rmSync(w.p('gh.log'));
    r = run(w, ['publish', 'vmap-feed', 'live']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(writes(r.log), ['gh release upload vmap-feed plugin-catalog.v1.txt --clobber']);
  } finally { w.done(); }
});

test('the target and the kind must agree, and a live release that does not exist is not created', { skip: !hasBash }, () => {
  const w = work();
  try {
    writeFileSync(w.p(ASSET), catalog(K1, 'k1', NOW - 100));
    for (const args of [['publish', 'vmap-feed', 'staging'], ['publish', 'vmap-feed-rehearsal', 'live'], ['last-seq', 'vmap-feed', 'staging'], ['publish', 'vmap-feed'], ['publish', '', 'staging'], ['push', 'x', 'live']]) {
      const r = run(w, args);
      assert.equal(r.status, 2, args.join(' '));
      assert.equal(r.log, '', `${args.join(' ')}: no gh call`);
    }
    writeFileSync(w.p(ASSET), catalog(K2, 'k2', NOW - 100));
    const r = run(w, ['publish', 'vmap-feed', 'live']);
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /the live release vmap-feed does not exist/);
    assert.deepEqual(writes(r.log), []);
  } finally { w.done(); }
});
