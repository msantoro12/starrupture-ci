// Tests for ci/scan-gate.ps1 (which plugin DLLs may reach sr-aobscan --plugin) and the steps of
// sr-client-check.yml that use it. The PowerShell runs for real; the scanner is a stand-in.
//
//   node --test ci/scan-gate.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedRefusals } from './decide.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gate = join(here, 'scan-gate.ps1');
const wfDir = join(here, '..', '.github', 'workflows');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const wf = read(join(wfDir, 'sr-client-check.yml'));
const NAMES = JSON.parse(read(join(here, 'plugin-names.json')));
const PIN = NAMES.find((n) => n.Name === 'PersistentIdFix').Pin;
const HEX = PIN.Digest.slice('sha256:'.length);

const powershell = ['pwsh', 'powershell'].find((exe) => spawnSync(exe, ['-NoProfile', '-Command', '1'], { windowsHide: true }).status === 0);
const ps = { skip: !powershell };
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const runPs = (dir, lines) => {
  const file = join(dir, 'run.ps1');
  writeFileSync(file, '\ufeff' + ["$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest", ...lines].join('\n'));
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const scratch = () => mkdtempSync(join(tmpdir(), 'scan-gate-'));
const put = (dir, rel, text = 'MZ') => {
  const file = join(dir, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};
// A junction on Windows (no rights needed), a directory symlink elsewhere.
const junction = (target, path) => symlinkSync(target, path, 'junction');

// The run block of a named step.
const runOf = (name) => {
  const at = wf.indexOf(`- name: ${name}\n`);
  assert.ok(at >= 0, `step "${name}" exists`);
  const next = wf.indexOf('\n      - ', at + 1);
  const m = wf.slice(at, next).match(/\n {8}run: \|\n((?: {10}.*\n?|\n)+)/);
  assert.ok(m, `step "${name}" has a run block`);
  return m[1].replace(/^ {10}/gm, '');
};

const OWN = 'msantoro12/StarRupture-Plugin-Foo';
const THIRD = 'AlienXAXS/StarRupture-Plugin-WAILA';

test('gate: only a DLL built here from our repositories or the nine AlienXAXS plugins may be scanned', ps, () => {
  const cases = [
    ['build', OWN, true], ['build', THIRD, true], ['build', 'GoodStuffSoftware/sr-bestbuilder', true],
    ['release', OWN, false], ['release', THIRD, false], ['hosted', THIRD, false], ['', OWN, false], ['Build', OWN, false],
    ['build', 'LetMeInside/StarRupture-Plugin-MiniMap', false], ['build', 'AlienXAXS/StarRupture-Plugin-MiniMap', false],
    ['build', 'AlienXAXS/StarRupture-Plugin-WAILA-evil', false], ['build', 'alienxaxs/StarRupture-Plugin-WAILA', false],
    ['build', 'GoodStuffSoftware/other', false], ['build', `evil/${OWN}`, false], ['build', `${OWN}/x`, false],
  ];
  const out = runPs(scratch(), [
    `. ${q(gate)}`,
    ...cases.map(([source, repo]) => `if (Get-ScanRefusal ${q(source)} ${q(repo)}) { 'refused' } else { 'allowed' }`),
  ]).trim().split(/\r?\n/);
  assert.deepEqual(out, cases.map(([, , ok]) => (ok ? 'allowed' : 'refused')));
});

test('gate: at the scanner call, a path, junction or link cannot bring in a DLL from outside this build', ps, () => {
  const dir = scratch();
  const built = join(dir, 'build');
  const good = put(dir, 'build/Client Release/Plugins/Good.dll');
  const downloaded = put(dir, 'downloads/Evil.dll');
  const sibling = put(dir, 'build-evil/Evil.dll');
  junction(join(dir, 'downloads'), join(built, 'linked'));
  junction(join(dir, 'downloads'), join(dir, 'linkedroot'));
  const cases = {
    good: ['build', OWN, good, built],
    release: ['release', OWN, good, built],
    otherAuthor: ['build', 'LetMeInside/StarRupture-Plugin-MiniMap', good, built],
    missing: ['build', OWN, join(built, 'None.dll'), built],
    empty: ['build', OWN, '', built],
    noRoot: ['build', OWN, good, ''],
    folder: ['build', OWN, join(built, 'Client Release'), built],
    outside: ['build', OWN, downloaded, built],
    dotdot: ['build', OWN, `${built}/../downloads/Evil.dll`, built],
    sibling: ['build', OWN, sibling, built],
    junction: ['build', OWN, join(built, 'linked', 'Evil.dll'), built],
    rootIsJunction: ['build', OWN, join(dir, 'linkedroot', 'Evil.dll'), join(dir, 'linkedroot')],
  };
  // A file symlink needs a right a Windows account may lack; the case runs where it can be made.
  try {
    symlinkSync(downloaded, join(built, 'Link.dll'), 'file');
    cases.fileLink = ['build', OWN, join(built, 'Link.dll'), built];
  } catch (e) {
    assert.equal(e.code, 'EPERM');
  }
  const out = runPs(dir, [
    `. ${q(gate)}`,
    ...Object.entries(cases).map(([k, a]) => `try { Assert-ScanAllowed ${a.map(q).join(' ')}; '${k}=allowed' } catch { '${k}=' + $_.Exception.Message }`),
  ]);
  const got = Object.fromEntries(out.trim().split(/\r?\n/).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(got.good, 'allowed');
  for (const k of Object.keys(cases).filter((x) => x !== 'good')) assert.match(got[k], /^not scanned: gated/, k);
  assert.match(got.junction, /junction or link/);
  assert.match(got.rootIsJunction, /junction or link/);
});

test('pinned facts: every committed Facts names the digest its Pin names', () => {
  const withFacts = NAMES.filter((n) => n.Pin?.Facts);
  assert.ok(withFacts.length > 0);
  for (const n of withFacts) assert.equal(n.Pin.Facts.Digest, n.Pin.Digest, `${n.Name}: Pin.Facts are for another DLL; replace or delete them with the Pin`);
});

test('pinned facts: only for exactly the reviewed DLL; a mismatch, no digest or no Facts declares nothing', ps, () => {
  const dir = scratch();
  const write = (name, pin) => put(dir, name, JSON.stringify([{ Name: 'PersistentIdFix', Pin: pin }]));
  const names = join(here, 'plugin-names.json');
  const cases = {
    match: [names, 'PersistentIdFix', PIN.Tag, HEX],
    otherDigest: [names, 'PersistentIdFix', PIN.Tag, 'b'.repeat(64)],
    noDigest: [names, 'PersistentIdFix', PIN.Tag, ''],
    prefixed: [names, 'PersistentIdFix', PIN.Tag, PIN.Digest],
    otherTag: [names, 'PersistentIdFix', 'v9.9.9', HEX],
    unknown: [names, 'Nobody', PIN.Tag, HEX],
    noFacts: [write('nofacts.json', { Tag: PIN.Tag, Digest: PIN.Digest }), 'PersistentIdFix', PIN.Tag, HEX],
    partial: [write('partial.json', { ...PIN, Facts: { InterfaceVersion: 75 } }), 'PersistentIdFix', PIN.Tag, HEX],
    // The pin moved to a new DLL and the old DLL's facts stayed behind.
    bumped: [write('bumped.json', { ...PIN, Digest: `sha256:${'b'.repeat(64)}` }), 'PersistentIdFix', PIN.Tag, 'b'.repeat(64)],
    factsNoDigest: [write('olddigest.json', { ...PIN, Facts: { ...PIN.Facts, Digest: undefined } }), 'PersistentIdFix', PIN.Tag, HEX],
    textFlag: [write('flag.json', { ...PIN, Facts: { ...PIN.Facts, Migrated: 'false' } }), 'PersistentIdFix', PIN.Tag, HEX],
  };
  const out = runPs(dir, [
    `. ${q(gate)}`,
    ...Object.entries(cases).map(([k, a]) => `'${k}=' + (ConvertTo-Json -Compress -Depth 4 -InputObject (Get-PinnedFacts ${a.map(q).join(' ')}))`),
  ]);
  const got = Object.fromEntries(out.trim().split(/\r?\n/).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.deepEqual(JSON.parse(got.match), {
    plugin: { interfaceVersion: PIN.Facts.InterfaceVersion, gameBuild: PIN.Facts.GameBuild },
    rule3: { migrated: false }, factsFrom: PIN.Facts.ObservedIn,
  });
  for (const k of Object.keys(cases).filter((x) => x !== 'match')) assert.match(got[k], /^(null)?$/, k);
});

test('rig set step: every row is marked gated, and only the reviewed DLL carries facts decide can judge', ps, () => {
  const dir = scratch();
  mkdirSync(join(dir, 'ci-gate', 'ci'), { recursive: true });
  mkdirSync(join(dir, 'ci-rig', 'ci'), { recursive: true });
  copyFileSync(gate, join(dir, 'ci-gate', 'ci', 'scan-gate.ps1'));
  copyFileSync(join(here, 'plugin-names.json'), join(dir, 'ci-rig', 'ci', 'plugin-names.json'));
  const rows = (digest) => {
    put(dir, 'rig-plan.json', JSON.stringify({ plugins: [
      { name: 'PersistentIdFix', tag: PIN.Tag, asset: { name: 'a.dll', digest } },
      { name: 'WAILA', tag: 'v1.0.0', asset: { name: 'b.dll', digest: 'c'.repeat(64) } },
      { name: 'Odd', tag: 'bad tag;', asset: { name: 'c.dll', digest: '' } },
    ] }));
    runPs(dir, [`$env:RUNNER_TEMP = ${q(dir)}; $env:BRANCH = 'public'`, runOf("Record the rig's plugin set (not scanned)")]);
    return JSON.parse(read(join(dir, 'out', 'rig-plugins.json')).replace(/^\ufeff/, ''));
  };
  const hit = rows(HEX);
  assert.equal(hit.tags, `PersistentIdFix=${PIN.Tag} WAILA=v1.0.0`);
  assert.deepEqual(hit.plugins.map((p) => [p.name, p.gated, 'plugin' in p]), [['PersistentIdFix', true, true], ['WAILA', true, false], ['Odd', true, false]]);
  assert.ok(hit.plugins.every((p) => p.error.startsWith('not scanned: gated')));
  assert.deepEqual(expectedRefusals(hit.plugins, 130045), ['PersistentIdFix']);
  assert.deepEqual(expectedRefusals(hit.plugins, 127004), [], 'it loads on the build it was made on');
  const miss = rows('b'.repeat(64));
  assert.deepEqual(expectedRefusals(miss.plugins, 130045), []);
});

test('check step: a gated plugin is graded NOT-SCANNED and never reaches the scanner', ps, () => {
  const dir = scratch();
  mkdirSync(join(dir, 'out'));
  const dll = put(dir, 'plugins/plugin-public-Foo/Foo.dll', 'built');
  const planted = put(dir, 'plugins/plugin-public-MiniMap/MiniMap.dll', 'downloaded');
  const meta = (file) => JSON.stringify({ ref: 'main', sha: 'a'.repeat(40), dll: file.split(/[\\/]/).pop(), sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  put(dir, 'plugins/plugin-public-Foo/plugin.json', meta(dll));
  put(dir, 'plugins/plugin-public-MiniMap/plugin.json', meta(planted));
  // Built in the check job (not hosted): the scanned DLL is the one in that build's output folder.
  const local = put(dir, 'third/Codex/src/build/Client Release/Plugins/Codex.dll', 'built here');
  put(dir, 'plugins/plugin-public-Codex/Codex.dll', 'built here');
  put(dir, 'plugins/plugin-public-Codex/plugin.json', meta(local));
  const entry = (name, source, repo, hosted = false) => ({ name, source, repo, ref: 'main', release: '', hosted });
  const plan = [
    entry('MiniMap', 'release', 'LetMeInside/StarRupture-Plugin-MiniMap'),
    entry('Other', 'build', 'someone/StarRupture-Plugin-Other'),
    entry('WAILA', 'build', THIRD),
    entry('Foo', 'build', OWN, true),
    entry('Codex', 'build', 'AlienXAXS/StarRupture-Plugin-Codex'),
  ];
  const step = runOf("Check the plugins' patterns");
  const from = step.indexOf('$results = foreach');
  const last = 'foreach ($r in $results) { "$($r.name): $($r.verdict)" }';
  assert.ok(from > 0 && step.indexOf(last) > from);
  runPs(dir, [
    `. ${q(gate)}`,
    `$env:RUNNER_TEMP = ${q(dir)}; $env:BRANCH = 'public'; $env:PLAN = ${q(JSON.stringify(plan))}`,
    `function Invoke-FakeScanner { Add-Content -LiteralPath ${q(join(dir, 'scanned.txt'))} -Value ($args -join ' '); $global:LASTEXITCODE = 2 }`,
    "$scanner = 'Invoke-FakeScanner'; $suggest = @(); $exe = [pscustomobject]@{ FullName = 'game.exe' }",
    step.slice(from, step.indexOf(last)),
  ]);
  const out = JSON.parse(read(join(dir, 'out', 'plugins.json')).replace(/^\ufeff/, ''));
  assert.equal(out.status, 'fail', 'never silently green');
  assert.deepEqual(out.plugins.map((p) => [p.name, p.verdict]), [['MiniMap', 'NOT-SCANNED'], ['Other', 'NOT-SCANNED'], ['WAILA', 'BUILD-FAILED'], ['Foo', 'ERROR'], ['Codex', 'ERROR']]);
  const scanned = read(join(dir, 'scanned.txt')).trim().split('\n');
  assert.equal(scanned.length, 2);
  assert.match(scanned[0], /Foo\.dll/);
  assert.match(scanned[1], /third.Codex.src.build.Client Release.Plugins.Codex\.dll/, 'not the copy folder');
});

test('workflows: every sr-aobscan --plugin call is right behind the gate, on the same DLL', () => {
  const calls = [];
  for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    const lines = read(join(wfDir, f)).split('\n');
    lines.forEach((line, i) => {
      const m = /^\s*& .*--plugin (\$[\w[\]0.]+?)(?:\.FullName)? --json/.exec(line);
      if (!m) return;
      calls.push(`${f}:${m[1]}`);
      const step = lines.slice(0, i).map((l) => /^ {6}- /.test(l)).lastIndexOf(true);
      const before = lines.slice(step, i);
      const at = before.map((l) => l.trim().startsWith('Assert-ScanAllowed ')).lastIndexOf(true);
      assert.ok(at > 0, `${f}:${i + 1}: Assert-ScanAllowed comes first, in the same step`);
      assert.ok(before[at].includes(` ${m[1]}`), `${f}:${i + 1}: it checks the DLL that is scanned`);
      assert.ok(before.some((l) => l.trim() === '. .\\ci-gate\\ci\\scan-gate.ps1'), `${f}:${i + 1}: the step loads the gate`);
      assert.ok(!before.slice(at + 1).some((l) => /^\s*\$dll\s*=/.test(l)), `${f}:${i + 1}: the DLL is not changed after the check`);
    });
    // No other spelling of a scanner call with a plugin.
    for (const l of lines.filter((x) => /\$scanner\b.*--plugin/.test(x))) assert.match(l, /^\s*& \$scanner .*--plugin \$[\w[\]0.]+ --json/);
  }
  assert.deepEqual(calls.sort(), ['sr-client-check.yml:$dll', 'sr-client-check.yml:$dll', 'sr-client-check.yml:$dll[0]']);
});

test('workflows: no downloaded DLL is fetched for a scan, and a committed DLL cannot pass as a built one', () => {
  const get = runOf("Get the other authors' plugins");
  assert.ok(!get.includes('$p.asset'), 'no release asset is downloaded');
  assert.ok(get.indexOf('if (Get-ScanRefusal $p.source $p.repo) { continue }') > 0);
  assert.ok(get.indexOf('if (Get-ScanRefusal $p.source $p.repo) { continue }') < get.indexOf('$sha = Get-Source'));
  const rig = runOf("Record the rig's plugin set (not scanned)");
  assert.ok(!/\$scanner|Invoke-WebRequest|rig-dl/.test(rig));
  assert.ok(!/-Mode Fetch|D:\\rig-dl/.test(wf), 'the check job downloads no rig release DLL');
  assert.equal(wf.split('the source already holds a DLL in its build output folder').length - 1, 6, 'every build whose DLL is scanned: plugins, three key-source recipes, the check job, autofix');
  // In each of the hosted ones the refusal comes before msbuild runs.
  for (const name of ['Build the plugin (Client Release)', 'Build the key source (Client Release)', 'Build the key-scan build (Client Release)', 'Build the key source on the Plugin SDK root (Client Release)']) {
    const run = runOf(name);
    const at = run.indexOf('the source already holds a DLL in its build output folder');
    assert.ok(at > 0 && at < run.search(/^\s*msbuild /m), name);
  }
  const check = wf.slice(wf.indexOf('\n  check:\n'), wf.indexOf('\n  layout-store:\n'));
  const checkout = check.indexOf('- name: Check out the scan gate\n');
  assert.ok(checkout > 0 && checkout < check.indexOf(". .\\ci-gate\\ci\\scan-gate.ps1"));
  assert.ok(!existsSync(join(here, 'scan-gate.allow')), 'no allow list outside the script');
});
