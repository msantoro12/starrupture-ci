// Tests for the mod-index asset of plugin-catalog-publish.sh (fourth argument `mod-index`), with a fake `gh` that
// keeps the releases in a folder. The mod index has its own seq, a file that is not a signed mod index is never
// uploaded, and no other asset of the release is touched.
//
//   node --test ci/mod-index-publish.test.mjs
//
// The copy of the scripts the routine runs has its two trusted public keys swapped for keys made here. The catalog
// publish cases are in plugin-catalog-publish.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_KEYS, signFeed } from './vmap-sign.mjs';
import { buildModIndex } from './mod-index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fwd = (p) => p.replaceAll('\\', '/');
const hasBash = spawnSync('bash', ['-c', 'true'], { windowsHide: true }).status === 0;
const ASSET = 'mod-index.v1.txt';
const OTHER = 'plugin-catalog.v1.txt';
const NOW = Math.floor(Date.now() / 1000);
const INDEX = '{\n  "schema": 1,\n  "mods": []\n}\n';

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), hex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
};
const K1 = pair();
const K2 = pair();
const modIndex = (key, keyId, seq, body = INDEX) => signFeed(buildModIndex(body), key.pem, { keyId, kind: 'mod-index', seq, now: NOW }).text;

const FAKE_GH = `gh() {
  echo "gh $*" >> "$FAKE_GH_LOG"
  case "$1 $2" in
    "release view")
      rel="$3"
      [ -d "$FAKE_GH_STORE/$rel" ] || { echo "release not found" >&2; return 1; }
      case "$*" in
        *isPrerelease*) echo true ;;
        *--json*) [ -f "$FAKE_GH_STORE/$rel/mod-index.v1.txt" ] && echo true || echo false ;;
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

function work() {
  const dir = mkdtempSync(join(tmpdir(), 'mod-index-publish-'));
  const p = (...parts) => join(dir, ...parts);
  cpSync(here, p('tool', 'ci'), { recursive: true, filter: (src) => !/[\\/]fixtures([\\/]|$)/.test(src) && !/\.test\.mjs$/.test(src) });
  const signer = readFileSync(p('tool', 'ci', 'vmap-sign.mjs'), 'utf8');
  assert.ok(signer.includes(PUBLIC_KEYS.k1.hex) && signer.includes(PUBLIC_KEYS.k2.hex));
  writeFileSync(p('tool', 'ci', 'vmap-sign.mjs'), signer.replace(PUBLIC_KEYS.k1.hex, K1.hex).replace(PUBLIC_KEYS.k2.hex, K2.hex));
  writeFileSync(p('fake-gh.sh'), FAKE_GH);
  writeFileSync(p('summary.md'), '');
  const store = (...parts) => p('store', ...parts);
  const release = (name, files = {}) => { mkdirSync(store(name), { recursive: true }); for (const [n, t] of Object.entries(files)) writeFileSync(store(name, n), t); };
  return { dir, p, store, release, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(w, args) {
  const r = spawnSync('bash', ['-c', 'source "$1"; export -f gh; shift; exec bash "$@"', '_', fwd(w.p('fake-gh.sh')), 'tool/ci/plugin-catalog-publish.sh', ...args, 'mod-index'], {
    cwd: w.dir,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GH_REPO: 'o/r', GITHUB_STEP_SUMMARY: fwd(w.p('summary.md')), FAKE_GH_LOG: fwd(w.p('gh.log')), FAKE_GH_STORE: fwd(w.p('store')), },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: existsSync(w.p('gh.log')) ? readFileSync(w.p('gh.log'), 'utf8') : '' };
}
const writes = (log) => log.split('\n').filter((l) => /^gh release (upload|create|edit|delete)/.test(l));

test('a staged publish makes the prerelease, uploads only mod-index.v1.txt, and last-seq then reads its own seq', { skip: !hasBash }, () => {
  const w = work();
  try {
    writeFileSync(w.p(ASSET), modIndex(K1, 'k1', NOW - 100));
    let r = run(w, ['last-seq', 'vmap-feed-rehearsal', 'staging']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '0');
    r = run(w, ['publish', 'vmap-feed-rehearsal', 'staging']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(readFileSync(w.store('vmap-feed-rehearsal', ASSET), 'utf8'), readFileSync(w.p(ASSET), 'utf8'));
    assert.match(r.stdout, new RegExp(`ok seq=${NOW - 100} key=k1 TEST-KEY`));
    assert.match(readFileSync(w.p('summary.md'), 'utf8'), /Rehearsal: staged the mod index on vmap-feed-rehearsal \(prerelease\): seq \d+/);
    assert.equal(run(w, ['last-seq', 'vmap-feed-rehearsal', 'staging']).stdout.trim(), String(NOW - 100));
    assert.ok(!/ vmap-feed( |$)/.test(r.log), 'the live release is never named');
  } finally { w.done(); }
});

test('the other assets of the release are never read as the mod index and never written', { skip: !hasBash }, () => {
  const w = work();
  try {
    const other = 'plugin catalog bytes\n';
    w.release('vmap-feed-rehearsal', { [OTHER]: other, 'version-map-client.v1.txt': 'feed\n', [ASSET]: modIndex(K1, 'k1', NOW - 50) });
    writeFileSync(w.p(ASSET), modIndex(K1, 'k1', NOW - 40, '{\n  "schema": 2\n}\n'));
    const r = run(w, ['publish', 'vmap-feed-rehearsal', 'staging']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(writes(r.log), ['gh release upload vmap-feed-rehearsal mod-index.v1.txt --clobber']);
    assert.equal(readFileSync(w.store('vmap-feed-rehearsal', OTHER), 'utf8'), other);
    assert.equal(readFileSync(w.store('vmap-feed-rehearsal', 'version-map-client.v1.txt'), 'utf8'), 'feed\n');
    assert.ok(!r.log.includes(OTHER) && !r.log.includes('version-map-client'), r.log);
  } finally { w.done(); }
});

test('the seq must rise above the mod index\'s own seq; a catalog\'s seq on the release does not count', { skip: !hasBash }, () => {
  const w = work();
  try {
    w.release('vmap-feed-rehearsal', { [ASSET]: modIndex(K1, 'k1', NOW - 50) });
    for (const seq of [NOW - 50, NOW - 60]) {
      writeFileSync(w.p(ASSET), modIndex(K1, 'k1', seq));
      const r = run(w, ['publish', 'vmap-feed-rehearsal', 'staging']);
      assert.equal(r.status, 2, r.stdout);
      assert.match(r.stderr + r.stdout, new RegExp(`seq ${seq} does not rise above the seq ${NOW - 50}`));
      assert.deepEqual(writes(r.log), []);
    }
  } finally { w.done(); }
});

test('a file that is not a signed mod index is refused before any upload: a catalog, an unsigned file, a changed byte, a wrong key', { skip: !hasBash }, () => {
  const w = work();
  try {
    w.release('vmap-feed-rehearsal');
    const good = modIndex(K1, 'k1', NOW - 100);
    const catalogText = readFileSync(join(here, 'fixtures', 'plugin-catalog', 'catalog-unsigned.txt'), 'utf8').replace(/\r\n/g, '\n');
    const bad = {
      'a signed plugin catalog': signFeed(catalogText, K1.pem, { keyId: 'k1', kind: 'catalog', now: NOW, seq: NOW - 100 }).text,
      'an unsigned mod index': buildModIndex(INDEX),
      'a changed byte': good.replace('schema', 'schemb'),
      'another key': modIndex(pair(), 'k1', NOW - 100),
      'an empty file': '',
    };
    for (const [what, text] of Object.entries(bad)) {
      writeFileSync(w.p(ASSET), text);
      const r = run(w, ['publish', 'vmap-feed-rehearsal', 'staging']);
      assert.equal(r.status, 2, `${what}: ${r.stdout}`);
      assert.match(r.stderr + r.stdout, /does not verify as a signed mod index/, what);
      assert.deepEqual(writes(r.log), [], `${what}: nothing uploaded`);
    }
    // a catalog held on the target under the mod index's name stops last-seq
    w.release('vmap-feed-rehearsal', { [ASSET]: bad['a signed plugin catalog'] });
    const r = run(w, ['last-seq', 'vmap-feed-rehearsal', 'staging']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /the mod index on vmap-feed-rehearsal does not verify, so its seq is unknown/);
  } finally { w.done(); }
});

test('live: the release key only, to vmap-feed only; the first publish never replaces a mod index, a later one does', { skip: !hasBash }, () => {
  const w = work();
  try {
    w.release('vmap-feed', { [OTHER]: 'catalog\n' });
    writeFileSync(w.p(ASSET), modIndex(K1, 'k1', NOW - 100));
    let r = run(w, ['publish', 'vmap-feed', 'live']);
    assert.equal(r.status, 2, r.stdout);
    assert.deepEqual(writes(r.log), []);
    writeFileSync(w.p(ASSET), modIndex(K2, 'k2', NOW - 100));
    r = run(w, ['publish', 'vmap-feed', 'live']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(writes(r.log), ['gh release upload vmap-feed mod-index.v1.txt']);
    assert.match(readFileSync(w.p('summary.md'), 'utf8'), /Published the mod index to vmap-feed: seq \d+, release key k2/);
    writeFileSync(w.p(ASSET), modIndex(K2, 'k2', NOW - 90));
    rmSync(w.p('gh.log'));
    r = run(w, ['publish', 'vmap-feed', 'live']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(writes(r.log), ['gh release upload vmap-feed mod-index.v1.txt --clobber']);
    assert.equal(readFileSync(w.store('vmap-feed', OTHER), 'utf8'), 'catalog\n');
    // the target and the kind must agree; an unknown asset name is a usage error
    for (const args of [['publish', 'vmap-feed', 'staging'], ['publish', 'vmap-feed-rehearsal', 'live']]) {
      assert.equal(run(w, args).status, 2, args.join(' '));
    }
  } finally { w.done(); }
});
