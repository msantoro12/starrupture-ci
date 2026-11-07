// Every `run` step on a Windows runner names its shell.
//
//   node --test ci/workflow-shells.test.mjs
//
// A Windows runner runs an undeclared `run` block in pwsh. The steps here are written for one
// shell or the other, and a bash block run by pwsh fails to parse (a `case ... esac` broke both
// loader builds of the compile check this way). So each `run` step of a Windows job says
// `shell:`, unless the job sets `defaults.run.shell`; a composite action's steps always do
// (GitHub requires it there). Reads the files as text, the way the other workflow tests do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// The steps of a block of YAML whose step items start at `indent` spaces: { line, name, run, shell }.
function stepsAt(lines, indent) {
  const steps = [];
  const item = new RegExp(`^ {${indent}}- `);
  // A key of the step: on its own line, or on the item line itself ("- run: ...").
  const key = (k) => new RegExp(`^ {${indent}}(?:- | {2})${k}:`);
  let s = null;
  lines.forEach(({ text, n }) => {
    if (item.test(text)) {
      s = { line: n, name: (/name:\s*(.*)$/.exec(text) ?? [])[1] ?? text.trim(), run: false, shell: false };
      steps.push(s);
      if (key('run').test(text)) s.run = true;
      if (key('shell').test(text)) s.shell = true;
      return;
    }
    if (!s) return;
    if (text.trim() !== '' && !text.startsWith(' '.repeat(indent + 1))) { s = null; return; }
    if (key('run').test(text)) s.run = true;
    if (key('shell').test(text)) s.shell = true;
  });
  return steps;
}

// The jobs of a workflow: { name, windows, defaultShell, steps }.
export function workflowJobs(text) {
  const lines = text.split('\n').map((t, i) => ({ text: t, n: i + 1 }));
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l.text));
  if (start < 0) return [];
  const jobs = [];
  let cur = null;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l.text)) break;
    const m = /^ {2}([\w-]+):\s*$/.exec(l.text);
    if (m) { cur = { name: m[1], lines: [] }; jobs.push(cur); continue; }
    if (cur) cur.lines.push(l);
  }
  return jobs.map((j) => {
    const body = j.lines.map((l) => l.text).join('\n');
    const runsOn = (/^ {4}runs-on:\s*(.*)$/m.exec(body) ?? [])[1] ?? '';
    return {
      name: j.name,
      // An expression (a matrix os) counts as Windows when the job names a Windows runner anywhere.
      windows: /windows/i.test(runsOn) || (/\$\{\{/.test(runsOn) && /windows/i.test(body)),
      defaultShell: /^ {4}defaults:\n {6}run:\n(?: {8}.*\n)*? {8}shell:/m.test(body + '\n'),
      steps: stepsAt(j.lines, 6),
    };
  });
}

const workflowDir = join(root, '.github', 'workflows');
const workflows = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));
const actionsDir = join(root, '.github', 'actions');
const actions = existsSync(actionsDir)
  ? readdirSync(actionsDir).flatMap((d) => ['action.yml', 'action.yaml'].map((f) => join(actionsDir, d, f)).filter(existsSync))
  : [];

test('shells: every run step of a Windows job declares its shell', () => {
  const missing = [];
  let windowsJobs = 0;
  for (const f of workflows) {
    for (const j of workflowJobs(read(join(workflowDir, f)))) {
      if (!j.windows) continue;
      windowsJobs++;
      if (j.defaultShell) continue;
      for (const s of j.steps) if (s.run && !s.shell) missing.push(`${f}:${s.line} job ${j.name}, step "${s.name}"`);
    }
  }
  assert.ok(windowsJobs >= 4, `found ${windowsJobs} Windows jobs; the parser lost them`);
  assert.deepEqual(missing, [], 'add `shell: bash` or `shell: pwsh` to these steps');
});

test('shells: every run step of a composite action declares its shell', () => {
  assert.ok(actions.length >= 1, 'found the composite actions');
  const missing = [];
  for (const f of actions) {
    const lines = read(f).split('\n').map((t, i) => ({ text: t, n: i + 1 }));
    const start = lines.findIndex((l) => /^ {2}steps:\s*$/.test(l.text));
    for (const s of stepsAt(lines.slice(start + 1), 4)) if (s.run && !s.shell) missing.push(`${f}:${s.line} step "${s.name}"`);
  }
  assert.deepEqual(missing, []);
});

test('shells: the parser sees a bash block with no shell on a Windows job', () => {
  const wf = [
    'jobs:', '  a:', '    runs-on: windows-latest', '    steps:',
    '      - name: Bare', '        run: |', '          case "$X" in', '            *) ;;', '          esac',
    '      - name: Declared', '        shell: bash', '        run: echo ok',
    '      - run: echo inline',
    '      - uses: actions/checkout@v7', '  b:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo linux',
    '  c:', '    runs-on: windows-latest', '    defaults:', '      run:', '        shell: bash', '    steps:', '      - run: echo set',
    '  d:', '    strategy:', '      matrix:', '        os: [ubuntu-latest, windows-latest]', '    runs-on: ${{ matrix.os }}', '    steps:', '      - run: echo matrix',
  ].join('\n');
  const jobs = workflowJobs(wf);
  assert.deepEqual(jobs.map((j) => [j.name, j.windows, j.defaultShell]), [['a', true, false], ['b', false, false], ['c', true, true], ['d', true, false]]);
  assert.deepEqual(jobs[0].steps.map((s) => [s.name, s.run, s.shell]), [['Bare', true, false], ['Declared', true, true], ['- run: echo inline', true, false], ['- uses: actions/checkout@v7', false, false]]);
  assert.deepEqual(jobs[3].steps.map((s) => s.run && !s.shell), [true]);
  // The loader job of the compile check as it was on main at 7b355d4: its first step had no shell.
  const before = ['jobs:', '  loader:', '    runs-on: windows-latest', '    steps:', '      - name: Check the loader repository', '        run: |', '          case "$LOADER_REPO_INPUT" in', '          esac'].join('\n');
  assert.deepEqual(workflowJobs(before)[0].steps.filter((s) => s.run && !s.shell).map((s) => s.name), ['Check the loader repository']);
});
