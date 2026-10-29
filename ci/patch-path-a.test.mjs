// Fixture tests for patch-path-a.mjs: patch generation, the G0 diff policy, and
// `git apply --check` on fresh clones. Set SR_LIVE=1 to also run against the
// real AlienXAXS/StarRupture-ModLoader main (needs network, read-only).
// Run: node --test ci/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generate, checkPatch, verifySha256, sha256Hex, replaceCl, notesLine, cleanTitle,
  CL_FILE, VERSION_FILE, NOTES_FILE, MAX_CHANGED_LINES,
} from './patch-path-a.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliFile = join(here, 'patch-path-a.mjs');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

const CPP = [
  '#include "version_check.h"',
  '',
  '#ifndef MODLOADER_BUILD_TAG',
  '#define MODLOADER_BUILD_TAG "dev"',
  '#endif',
  '',
  'static constexpr wchar_t kRequiredVersionSuffix[] = L"CL-127004";',
  '',
  '// uses L"CL-127004" in a comment, which must stay',
  'bool Check() { return true; }',
  '',
].join('\n');

// A small repo shaped like the loader: LF blobs, a tag, a notes file.
function fixtureRepo({ cpp = CPP, notes = 'Old note one\nOld note two\n', version, tag = 'v1.22.1', extra = {} } = {}) {
  const dir = tmp('fixture-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  const put = (p, data) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), data); };
  put(CL_FILE, cpp);
  put(NOTES_FILE, notes);
  put('README.md', 'readme\n');
  put('.github/workflows/release.yml', 'name: release\n');
  if (version !== undefined) put(VERSION_FILE, version);
  for (const [p, d] of Object.entries(extra)) put(p, d);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  if (tag) git(dir, 'tag', tag);
  return dir;
}

// Clone fresh, then run `git apply --check` there. Returns the clone path.
function applyCheckOnFreshClone(srcDir, patchFile, autocrlf) {
  const dest = join(tmp('fresh-clone-'), 'c');
  git(tmpdir(), 'clone', '-q', '-c', `core.autocrlf=${autocrlf}`, srcDir, dest);
  git(dest, 'apply', '--check', patchFile);
  return dest;
}

const gen = (repo, over = {}) => generate({ repo, cl: '127999', title: 'Fake Update', outDir: join(tmp('out-'), 'patches'), ...over });

// ------------------------------------------------------------ generation

test('generate: CL line, version and notes, applies on a fresh clone', () => {
  const repo = fixtureRepo();
  const r = gen(repo);
  assert.equal(r.cl, '127999');
  assert.equal(r.previousCl, '127004');
  assert.equal(r.version, '1.22.2');
  assert.deepEqual([...r.files].sort(), [CL_FILE, NOTES_FILE, VERSION_FILE].sort());
  const patch = readFileSync(r.patch);
  assert.equal(r.sha256, sha256Hex(patch));
  assert.equal(readFileSync(`${r.patch}.sha256`, 'utf8'), `${r.sha256}  ModLoader.patch\n`);
  assert.ok(verifySha256(patch, readFileSync(`${r.patch}.sha256`, 'utf8')));

  for (const autocrlf of ['false', 'true']) {
    const clone = applyCheckOnFreshClone(repo, r.patch, autocrlf);
    git(clone, 'apply', r.patch);
    const cpp = readFileSync(join(clone, CL_FILE), 'utf8').replace(/\r\n/g, '\n');
    assert.match(cpp, /kRequiredVersionSuffix\[\] = L"CL-127999";/);
    assert.match(cpp, /uses L"CL-127004" in a comment/, 'the comment is not touched');
    assert.equal(readFileSync(join(clone, VERSION_FILE), 'utf8').trim(), '1.22.2');
    assert.equal(readFileSync(join(clone, NOTES_FILE), 'utf8').replace(/\r\n/g, '\n'), 'Supports game build CL-127999 (Fake Update)\n');
  }
});

test('generate: changes nothing in the checkout', () => {
  const repo = fixtureRepo();
  const before = git(repo, 'count-objects', '-v');
  gen(repo);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'count-objects', '-v'), before, 'no objects written to the repo');
  assert.equal(existsSync(join(repo, VERSION_FILE)), false);
});

test('generate: the same input gives byte-identical output', () => {
  const repo = fixtureRepo();
  assert.equal(gen(repo).sha256, gen(repo).sha256);
});

test('generate: the patch passes the G0 policy and touches exactly three files', () => {
  const r = gen(fixtureRepo());
  const p = checkPatch(readFileSync(r.patch, 'latin1'));
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.ok(p.changedLines <= MAX_CHANGED_LINES);
});

test('generate: version is one patch above the newest tag', () => {
  const repo = fixtureRepo({ tag: 'v1.22.1' });
  git(repo, 'tag', 'v1.9.9');
  git(repo, 'tag', 'v1.22.0');
  git(repo, 'tag', 'not-a-version');
  assert.equal(gen(repo).version, '1.22.2');
});

test('generate: --latest overrides the tags', () => {
  assert.equal(gen(fixtureRepo(), { latest: '2.0.7' }).version, '2.0.8');
});

test('generate: an existing higher version file is the base', () => {
  assert.equal(gen(fixtureRepo({ version: '1.23.0\n' })).version, '1.23.1');
  const lower = fixtureRepo({ version: '1.20.0\n' });
  assert.equal(gen(lower).version, '1.22.2');
});

test('generate: with no tag, no version file and no --latest it refuses', () => {
  assert.throws(() => gen(fixtureRepo({ tag: null })), /no release tag/);
});

test('generate: an invalid --latest is refused', () => {
  assert.throws(() => gen(fixtureRepo(), { latest: 'abc' }), /not x\.y\.z/);
});

test('generate: CLs that are not newer or not numbers are refused', () => {
  const repo = fixtureRepo();
  assert.throws(() => gen(repo, { cl: '127004' }), /not newer/);
  assert.throws(() => gen(repo, { cl: '100' }), /not newer/);
  assert.throws(() => gen(repo, { cl: 'CL-127999' }), /digits/);
  assert.throws(() => gen(repo, { cl: '127999; rm -rf /' }), /digits/);
  assert.throws(() => gen(repo, { cl: '' }), /digits/);
  assert.throws(() => gen(repo, { cl: '1234567890' }), /digits/);
  assert.throws(() => gen(repo, { cl: '0127999' }), /no leading zero/);
  assert.throws(() => gen(repo, { cl: '0' }), /no leading zero/);
});

test('generate: no CL line, or two CL lines, is refused', () => {
  assert.throws(() => gen(fixtureRepo({ cpp: 'int x;\n' })), /found 0/);
  assert.throws(() => gen(fixtureRepo({ cpp: CPP + CPP.split('\n').find((l) => l.startsWith('static')) + '\n' })), /found 2/);
  assert.throws(() => replaceCl('static constexpr wchar_t kRequiredVersionSuffix[] = L"CL-9";', '8'), /not newer/);
});

test('generate: a dirty or wrongly based checkout is refused', () => {
  const repo = fixtureRepo();
  writeFileSync(join(repo, 'README.md'), 'edited\n');
  assert.throws(() => gen(repo), /not clean/);
  const repo2 = fixtureRepo();
  writeFileSync(join(repo2, 'stray.txt'), 'x');
  assert.throws(() => gen(repo2), /not clean/);
  const repo3 = fixtureRepo();
  assert.throws(() => gen(repo3, { base: 'deadbeef' }), /expected deadbeef/);
  assert.throws(() => gen(repo3, { base: '' }), /expected /);
  const head = git(repo3, 'rev-parse', 'HEAD').trim();
  assert.equal(gen(repo3, { base: head.slice(0, 8) }).base, head);
});

test('generate: a CRLF source file keeps its line ends', () => {
  const crlf = CPP.replace(/\n/g, '\r\n');
  const repo = fixtureRepo({ cpp: crlf });
  const r = gen(repo);
  const patch = readFileSync(r.patch, 'latin1');
  assert.match(patch, /\+static constexpr wchar_t kRequiredVersionSuffix\[\] = L"CL-127999";\r\n/);
  const clone = applyCheckOnFreshClone(repo, r.patch, 'false');
  git(clone, 'apply', r.patch);
  assert.equal(readFileSync(join(clone, CL_FILE), 'latin1'), crlf.replace('CL-127004";\r\n\r\n//', 'CL-127999";\r\n\r\n//'));
});

test('generate: a notes file stored with CRLF stays CRLF', () => {
  const r = gen(fixtureRepo({ notes: 'old\r\nolder\r\n' }));
  assert.match(readFileSync(r.patch, 'latin1'), /\+Supports game build CL-127999 \(Fake Update\)\r\n/);
});

test('generate: the existing notes are replaced by exactly one line', () => {
  const repo = fixtureRepo({ notes: 'a\nb\nc\nd\n' });
  const r = gen(repo);
  applyCheckOnFreshClone(repo, r.patch, 'false');
  const p = readFileSync(r.patch, 'latin1');
  assert.equal((p.match(/^\+Supports game build/gm) || []).length, 1);
  assert.equal((p.match(/^-[abcd]$/gm) || []).length, 4);
});

test('notes: titles are cleaned to one plain ASCII line', () => {
  assert.equal(notesLine('1', 'Patch 0.3\nSupports game build CL-1 (evil)'), 'Supports game build CL-1 (Patch 0.3 Supports game build CL-1 (evil))');
  assert.equal(cleanTitle('A – B “quoted” ‘x’ é中'), 'A - B "quoted" \'x\'');
  assert.equal(notesLine('1', ''), 'Supports game build CL-1');
  assert.equal(notesLine('1', undefined), 'Supports game build CL-1');
  assert.equal(notesLine('1', '   \n\t '), 'Supports game build CL-1');
  assert.equal(cleanTitle('x'.repeat(500)).length, 120);
  const r = gen(fixtureRepo(), { title: 'Line one\r\nLine two\u0000' });
  const added = readFileSync(r.patch, 'latin1').split('\n').filter((l) => l.startsWith('+Supports'));
  assert.deepEqual(added, ['+Supports game build CL-127999 (Line one Line two)']);
});

test('cli: generate prints a summary and writes the files', () => {
  const repo = fixtureRepo();
  const out = join(tmp('cli-out-'), 'patches');
  const r = spawnSync(process.execPath, [cliFile, '--repo', repo, '--cl', '127999', '--title', 'Fake', '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.sha256, sha256Hex(readFileSync(join(out, 'ModLoader.patch'))));
  const chk = spawnSync(process.execPath, [cliFile, '--check', join(out, 'ModLoader.patch'), '--sha256', join(out, 'ModLoader.patch.sha256')], { encoding: 'utf8', windowsHide: true });
  assert.equal(chk.status, 0, chk.stdout);
  const bad = spawnSync(process.execPath, [cliFile, '--repo', repo, '--cl', '1', '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not newer/);
});

// ------------------------------------------------------------ G0 policy

const file = (path, add, del = []) => {
  const old = del.length;
  const body = [...del.map((l) => `-${l}`), ...add.map((l) => `+${l}`)];
  return [
    `diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`,
    `@@ -1,${old} +1,${add.length} @@`, ...body,
  ].join('\n') + '\n';
};
const newFile = (path, lines) => [
  `diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..2222222', '--- /dev/null', `+++ b/${path}`,
  `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`),
].join('\n') + '\n';
// Structural cases pass arbitrary content, so they switch content pinning off.
const loose = (t, o = {}) => checkPatch(t, { pin: false, ...o });
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`);

test('G0: plain edits to allowlisted files pass', () => {
  assert.equal(loose(file(CL_FILE, ['b'], ['a'])).ok, true);
  assert.equal(loose(newFile(VERSION_FILE, ['1.2.3'])).ok, true);
  assert.equal(loose(file(CL_FILE, ['b'], ['a']) + newFile(NOTES_FILE, ['n'])).ok, true);
});

test('G0: a file outside the allowlist is rejected', () => {
  for (const p of ['.github/workflows/release.yml', 'README.md', 'StarRupture-ModLoader-Core/core/init_thread.cpp', 'Version', 'version/x', 'a/version']) {
    const r = loose(file(p, ['x'], ['y']));
    assert.equal(r.ok, false, p);
    assert.match(r.errors.join(), /allowlist/, p);
  }
});

test('G0: one bad file among good ones rejects the patch', () => {
  const r = loose(file(CL_FILE, ['b'], ['a']) + file('.github/workflows/release.yml', ['x'], ['y']));
  assert.equal(r.ok, false);
});

test('G0: the 60-line limit counts additions plus removals', () => {
  assert.equal(loose(newFile(NOTES_FILE, lines(60))).ok, true);
  const r61 = loose(newFile(NOTES_FILE, lines(61)));
  assert.equal(r61.ok, false);
  assert.match(r61.errors.join(), /61 changed lines/);
  assert.equal(loose(file(NOTES_FILE, lines(30), lines(30))).ok, true);
  assert.equal(loose(file(NOTES_FILE, lines(31), lines(30))).ok, false);
  // the limit is across files
  assert.equal(loose(newFile(NOTES_FILE, lines(31)) + newFile(VERSION_FILE, lines(30))).ok, false);
  assert.equal(loose(newFile(NOTES_FILE, lines(11)), { maxLines: 10 }).ok, false);
});

test('G0: lines starting with "++" or "--" inside a hunk are counted as content', () => {
  const r = loose(file(NOTES_FILE, ['++ plus', '--- dashes'], ['-- old']));
  assert.equal(r.ok, true, r.errors.join());
  assert.equal(r.changedLines, 3);
});

test('G0: renames, copies, deletes, mode changes, symlinks, binaries are rejected', () => {
  const rename = `diff --git a/${NOTES_FILE} b/${VERSION_FILE}\nsimilarity index 100%\nrename from ${NOTES_FILE}\nrename to ${VERSION_FILE}\n`;
  assert.equal(loose(rename).ok, false);
  const del = `diff --git a/${NOTES_FILE} b/${NOTES_FILE}\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/${NOTES_FILE}\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`;
  assert.equal(loose(del).ok, false);
  const mode = `diff --git a/${CL_FILE} b/${CL_FILE}\nold mode 100644\nnew mode 100755\n`;
  assert.equal(loose(mode).ok, false);
  const modeAndEdit = `diff --git a/${CL_FILE} b/${CL_FILE}\nold mode 100644\nnew mode 100755\nindex 1111111..2222222\n--- a/${CL_FILE}\n+++ b/${CL_FILE}\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.equal(loose(modeAndEdit).ok, false);
  const exec = `diff --git a/${VERSION_FILE} b/${VERSION_FILE}\nnew file mode 100755\nindex 0000000..2222222\n--- /dev/null\n+++ b/${VERSION_FILE}\n@@ -0,0 +1 @@\n+x\n`;
  assert.equal(loose(exec).ok, false);
  const link = `diff --git a/${VERSION_FILE} b/${VERSION_FILE}\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/${VERSION_FILE}\n@@ -0,0 +1 @@\n+../../etc/passwd\n`;
  assert.equal(loose(link).ok, false);
  const bin = `diff --git a/${VERSION_FILE} b/${VERSION_FILE}\nnew file mode 100644\nindex 0000000..2222222\nGIT binary patch\nliteral 3\nKcmZ?\n`;
  assert.equal(loose(bin).ok, false);
  const bin2 = `diff --git a/${VERSION_FILE} b/${VERSION_FILE}\nindex 1111111..2222222 100644\nBinary files a/${VERSION_FILE} and b/${VERSION_FILE} differ\n`;
  assert.equal(loose(bin2).ok, false);
});

test('G0: paths that escape or hide are rejected', () => {
  for (const p of ['../version', 'a/../version', './version', 'version ', '"version"']) {
    const t = file('version', ['x'], ['y']).replaceAll('version', p);
    assert.equal(loose(t).ok, false, p);
  }
  // a/ and b/ names that disagree
  const mismatch = file(NOTES_FILE, ['x'], ['y']).replace(`+++ b/${NOTES_FILE}`, `+++ b/${VERSION_FILE}`);
  assert.equal(loose(mismatch).ok, false);
  const mismatch2 = file(NOTES_FILE, ['x'], ['y']).replace(`diff --git a/${NOTES_FILE} b/${NOTES_FILE}`, `diff --git a/${VERSION_FILE} b/${NOTES_FILE}`);
  assert.equal(loose(mismatch2).ok, false);
});

test('G0: malformed or smuggling patches are rejected', () => {
  assert.equal(loose('').ok, false);
  assert.equal(loose('\n').ok, false);
  assert.equal(loose('just some text\n').ok, false);
  // hunk header claims 1 line, body carries 3: extra lines would otherwise slip past the count
  const lie = `diff --git a/${NOTES_FILE} b/${NOTES_FILE}\nindex 1..2 100644\n--- a/${NOTES_FILE}\n+++ b/${NOTES_FILE}\n@@ -1 +1 @@\n-a\n+b\n+c\n+d\n`;
  assert.equal(loose(lie).ok, false);
  // hunk claims more lines than present
  const short = `diff --git a/${NOTES_FILE} b/${NOTES_FILE}\nindex 1..2 100644\n--- a/${NOTES_FILE}\n+++ b/${NOTES_FILE}\n@@ -1,3 +1,3 @@\n-a\n+b\n`;
  assert.equal(loose(short).ok, false);
  // trailing garbage after a valid patch
  assert.equal(loose(file(NOTES_FILE, ['b'], ['a']) + 'garbage\n').ok, false);
  // same file twice
  assert.equal(loose(file(NOTES_FILE, ['b'], ['a']) + file(NOTES_FILE, ['c'], ['b'])).ok, false);
  // header-only entry for another file hidden before real content
  assert.equal(loose(`diff --git a/README.md b/README.md\n` + file(NOTES_FILE, ['b'], ['a'])).ok, false);
  // a header with CR
  assert.equal(loose(file(NOTES_FILE, ['b'], ['a']).replace(`+++ b/${NOTES_FILE}`, `+++ b/${NOTES_FILE}\r`)).ok, false);
  // an unknown extended header
  assert.equal(loose(file(NOTES_FILE, ['b'], ['a']).replace('index', 'weird')).ok, false);
});

test('G0: "\\ No newline" markers are accepted', () => {
  const t = `diff --git a/${NOTES_FILE} b/${NOTES_FILE}\nindex 1..2 100644\n--- a/${NOTES_FILE}\n+++ b/${NOTES_FILE}\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n`;
  assert.equal(loose(t).ok, true);
});


// ---- content pinning

const clPatch = (oldCl, newCl, over = {}) => file(CL_FILE,
  [over.add ?? `static constexpr wchar_t kRequiredVersionSuffix[] = L"CL-${newCl}";`],
  [over.del ?? `static constexpr wchar_t kRequiredVersionSuffix[] = L"CL-${oldCl}";`]);
const pinErrors = (t) => checkPatch(t).errors.join(' | ');

test('G0 pin: the CL file may only swap the CL number to a higher one', () => {
  assert.equal(checkPatch(clPatch('127004', '127999')).ok, true);
  assert.match(pinErrors(clPatch('127999', '127004')), /not newer/);
  assert.match(pinErrors(clPatch('127004', '127004')), /not newer/);
  assert.match(pinErrors(clPatch('127004', '0127999')), /not the kRequiredVersionSuffix/);
  assert.match(pinErrors(clPatch('127004', '1234567890')), /not the kRequiredVersionSuffix/);
  assert.match(pinErrors(file(CL_FILE, ['int x;'], ['int y;'])), /not the kRequiredVersionSuffix/);
  assert.match(pinErrors(clPatch('1', '2', { add: 'static constexpr wchar_t kRequiredVersionSuffix[] = L"CL-2"; system("x");' })), /not the kRequiredVersionSuffix/);
  const two = file(CL_FILE, ['// c', 'static constexpr wchar_t kRequiredVersionSuffix[] = L"CL-2";'], ['static constexpr wchar_t kRequiredVersionSuffix[] = L"CL-1";']);
  assert.match(pinErrors(two), /exactly one removed and one added/);
  assert.match(pinErrors(newFile(CL_FILE, ['x'])), /exactly one removed and one added/);
  const crlf = clPatch('127004', '127999').replace(/^([+-]static.*)$/gm, '$1\r');
  assert.equal(checkPatch(crlf).ok, true);
});

test('G0 pin: the version file takes one x.y.z line', () => {
  assert.equal(checkPatch(file(VERSION_FILE, ['1.22.2'], ['1.22.1'])).ok, true);
  assert.equal(checkPatch(newFile(VERSION_FILE, ['1.22.2'])).ok, true);
  for (const bad of ['1.22', '1.22.2-rc1', 'v1.22.2', '1.22.2 && x', '01.22.2', '']) {
    assert.match(pinErrors(file(VERSION_FILE, [bad], ['1.22.1'])), /expected one added x\.y\.z/, bad);
  }
  assert.match(pinErrors(file(VERSION_FILE, ['1.22.2', '1.22.3'], ['1.22.1'])), /expected one added/);
  assert.match(pinErrors(file(VERSION_FILE, ['1.22.2'], ['payload'])), /removed line is not x\.y\.z/);
});

test('G0 pin: the notes file takes one "Supports game build" line of printable ASCII', () => {
  for (const l of ['Supports game build CL-127999 (Fake Update)', 'Supports game build CL-127999']) {
    assert.equal(checkPatch(file(NOTES_FILE, [l], ['old', 'older'])).ok, true, l);
  }
  for (const bad of ['Hello', 'Supports game build CL-1 (x) extra', 'Supports game build CL-01', 'Supports game build CL-1 ()',
    'Supports game build CL-1 (caf\u00e9)', 'Supports game build CL-1 (' + 'x'.repeat(121) + ')']) {
    assert.match(pinErrors(file(NOTES_FILE, [bad], ['old'])), /expected one added "Supports game build/, bad);
  }
  assert.match(pinErrors(file(NOTES_FILE, ['Supports game build CL-1', 'Supports game build CL-2'], ['old'])), /expected one added/);
  assert.match(pinErrors(file(NOTES_FILE, [], ['old'])), /expected one added/);
});

test('G0 pin: pin:false skips the content rules but keeps the structural ones', () => {
  assert.equal(checkPatch(file(NOTES_FILE, ['anything'], ['old']), { pin: false }).ok, true);
  assert.equal(checkPatch(file('README.md', ['anything'], ['old']), { pin: false }).ok, false);
});

test('G0: maxLines must be a positive integer', () => {
  const p = file(NOTES_FILE, ['Supports game build CL-1'], ['old']);
  for (const bad of [NaN, 0, -1, 1.5, '10', Infinity, null]) {
    const r = checkPatch(p, { maxLines: bad });
    assert.equal(r.ok, false, String(bad));
    assert.match(r.errors.join(), /positive integer/);
  }
  assert.equal(checkPatch(p, { maxLines: 2 }).ok, true);
  assert.equal(checkPatch(p, { maxLines: 1 }).ok, false);
});

test('G0: sha256 verification', () => {
  const buf = Buffer.from('patch body');
  const hex = sha256Hex(buf);
  assert.equal(verifySha256(buf, hex), true);
  assert.equal(verifySha256(buf, `${hex}  ModLoader.patch\n`), true);
  assert.equal(verifySha256(buf, hex.toUpperCase()), true);
  assert.equal(verifySha256(buf, `${'0'.repeat(64)}  x`), false);
  assert.equal(verifySha256(buf, hex.slice(1)), false);
  assert.equal(verifySha256(buf, ''), false);
  assert.equal(verifySha256(Buffer.from('patch body!'), hex), false);
});

test('cli --check: rejects a tampered patch, a wrong sha256 and a policy violation', () => {
  const r = gen(fixtureRepo());
  const run = (args) => spawnSync(process.execPath, [cliFile, '--check', ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(run([r.patch]).status, 0);
  assert.equal(run([r.patch, '--sha256', r.sha256]).status, 0);
  assert.equal(run([r.patch, '--sha256', '0'.repeat(64)]).status, 1);
  const tampered = join(tmp('tamper-'), 'ModLoader.patch');
  writeFileSync(tampered, readFileSync(r.patch, 'latin1').replace('Fake Update', 'Fake Updatf'), 'latin1');
  const t = run([tampered, '--sha256', `${r.patch}.sha256`]);
  assert.equal(t.status, 1);
  assert.match(t.stdout, /sha256 does not match/);
  const bad = join(tmp('bad-'), 'x.patch');
  writeFileSync(bad, file('.github/workflows/release.yml', ['x'], ['y']));
  assert.equal(run([bad]).status, 1);
  assert.equal(run([bad, '--allow', '.github/workflows/release.yml']).status, 0, 'an explicit allowlist is honoured');
  assert.equal(run([join(tmp('none-'), 'missing.patch')]).status, 1, 'a missing file is a rejection');
  assert.equal(run([r.patch, '--max-lines', '12']).status, 0);
  assert.equal(run([r.patch, '--max-lines', '2']).status, 1);
  for (const bad of ['abc', '0', '-5', '1.5', '']) assert.equal(run([r.patch, '--max-lines', bad]).status, 2, '--max-lines ' + bad);
  const edited = join(tmp('pin-'), 'x.patch');
  writeFileSync(edited, readFileSync(r.patch, 'latin1').replace('+Supports game build', '+Hello world, see'), 'latin1');
  assert.equal(run([edited]).status, 1, 'a notes line that is not the pinned shape is rejected');
});

// ------------------------------------------------------------ live

test('live: patch against the real loader main applies on a fresh clone', { skip: process.env.SR_LIVE !== '1' }, () => {
  const dest = join(tmp('live-'), 'loader');
  execFileSync('git', ['clone', '-q', 'https://github.com/AlienXAXS/StarRupture-ModLoader.git', dest], { windowsHide: true });
  const head = git(dest, 'rev-parse', 'HEAD').trim();
  const out = join(tmp('live-out-'), 'patches');
  const r = generate({ repo: dest, cl: '999999', title: 'Fake live test build', outDir: out });
  assert.equal(r.base, head);
  assert.equal(r.previousCl.length > 0, true);
  console.log(`live: base ${head} previous CL-${r.previousCl} -> CL-${r.cl}, version ${r.version}, ${r.changedLines} changed lines, sha256 ${r.sha256}`);
  for (const autocrlf of ['false', 'true']) {
    const fresh = join(tmp('live-fresh-'), 'c');
    git(tmpdir(), 'clone', '-q', '-c', `core.autocrlf=${autocrlf}`, dest, fresh);
    const res = spawnSync('git', ['apply', '--check', '-v', r.patch], { cwd: fresh, encoding: 'utf8', windowsHide: true });
    console.log(`live: git apply --check (autocrlf=${autocrlf}) exit ${res.status}\n${res.stderr}`);
    assert.equal(res.status, 0);
  }
});
