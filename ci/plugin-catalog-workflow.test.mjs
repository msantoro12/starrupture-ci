// Tests for the plugin catalog workflow (.github/workflows/sr-plugin-catalog.yml): who can start it, which release it
// writes, which key it signs with, and that no step names the live release without the live gate.
//
//   node --test ci/plugin-catalog-workflow.test.mjs
//
// Reads the file as text, the way the server check's workflow tests do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const wf = read('.github', 'workflows', 'sr-plugin-catalog.yml');
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const call = section(wf, '  workflow_call:\n', '  workflow_dispatch:\n');
const dispatch = section(wf, '  workflow_dispatch:\n', '\npermissions:');
const stepOf = (name) => {
  const at = wf.indexOf(`- name: ${name}\n`);
  assert.ok(at > 0, `step "${name}" exists`);
  const next = wf.indexOf('\n      - ', at + 1);
  return wf.slice(at, next < 0 ? undefined : next);
};
const runSteps = [
  ...[...wf.matchAll(/\n( +)run: \|\n((?:\1 .*\n|\n)*)/g)].map((m) => m[2]),
  ...[...wf.matchAll(/\n +run: (?!\|).*/g)].map((m) => m[0]),
];

test('triggers: workflow_call and workflow_dispatch only, each with catalog_json; live on dispatch only', () => {
  const on = section(wf, '\non:\n', '\npermissions:');
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):\n/gm)].map((m) => m[1]), ['workflow_call', 'workflow_dispatch']);
  for (const s of [call, dispatch]) assert.match(s, /catalog_json:\n(?:.*\n)*?\s+type: string\n\s+required: true\n/, 'catalog_json: a required string');
  assert.match(dispatch, /\n {6}live:\n(?:.*\n)*?\s+type: boolean\n\s+default: false\n/, 'live: a boolean, off by default');
  assert.ok(!/\blive:/.test(call), 'a workflow_call caller cannot set live: it is not an input there');
  assert.ok(!/pull_request|schedule:|push:/.test(on), 'no trigger a stranger can pull, no schedule, no push');
});

test('live: needs this workflow as the top-level run, a dispatch and live true, then main; nothing else reads the live input', () => {
  const flag = "LIVE: ${{ contains(github.workflow_ref, '/.github/workflows/sr-plugin-catalog.yml@') && github.event_name == 'workflow_dispatch' && inputs.live == true }}";
  assert.ok(wf.includes(`      ${flag}\n`), 'LIVE needs this workflow as the top-level run, a dispatch and live true');
  assert.equal((wf.match(/inputs\.live/g) ?? []).length, 1, 'no other expression reads the live input');
  const gate = stepOf('Refuse a live publish that is not allowed');
  assert.ok(gate.includes("if: ${{ env.LIVE == 'true' }}\n") && gate.includes('"$GITHUB_REF" = refs/heads/main') && gate.includes('exit 2'));
  assert.ok(wf.indexOf('Refuse a live publish') < wf.indexOf('Choose the live release'), 'refused before the live target is chosen');
  assert.ok(wf.indexOf('Refuse a live publish') < wf.indexOf('Sign with the release key'), 'refused before the release key is used');
  assert.ok(!/(?:vmap-sign\.mjs|plugin-catalog-publish\.sh)[^\n]*\bvmap-feed\b/.test(wf), 'no script call names the live release; the choose step does');
});

test('default target is the rehearsal prerelease; the live release is named only by the live-gated steps and the read-only ones', () => {
  assert.match(wf, /\n {6}STAGING_RELEASE: vmap-feed-rehearsal\n/);
  const live = stepOf('Choose the live release');
  assert.ok(live.includes("if: ${{ env.LIVE == 'true' }}\n") && live.includes('TARGET=vmap-feed"') && live.includes('KIND=live'));
  const stage = stepOf('Choose the staging prerelease');
  assert.ok(stage.includes("if: ${{ env.LIVE != 'true' }}\n") && stage.includes('TARGET=$STAGING_RELEASE') && stage.includes('KIND=staging'));
  assert.ok(!/vmap-feed(?!-)/.test(stage), 'the staging choice never names the live release');
  // Every line that names the live release, comments aside, is the dispatch input's text, the gate's message, the live choice or a read-only API call.
  const allowed = [/^description: /, /^echo "This run publishes to the LIVE vmap-feed release\."$/, /^echo "TARGET=vmap-feed" >> "\$GITHUB_ENV"$/, /^gh api "repos\/\$GH_REPO\/releases\/tags\/vmap-feed" --jq /];
  const naming = wf.split('\n').map((l) => l.trim()).filter((l) => /vmap-feed(?!-rehearsal)/.test(l) && !l.startsWith('#'));
  assert.equal(naming.length, 5, naming.join('\n'));
  for (const l of naming) assert.ok(allowed.some((re) => re.test(l)), l);
  assert.ok(!/gh release (upload|create|edit|delete)|git push|--clobber/.test(wf), 'every write goes through ci/plugin-catalog-publish.sh');
  const pub = stepOf('Publish the catalog');
  assert.ok(pub.includes('plugin-catalog-publish.sh publish "$TARGET" "$KIND"') && !/if:/.test(pub), 'one publish call, for whichever target was chosen');
  assert.equal((wf.match(/plugin-catalog-publish\.sh (?:last-seq|publish) /g) ?? []).length, 2);
  assert.ok(wf.indexOf('Choose the staging prerelease') < wf.indexOf('Publish the catalog'));
});

test('keys: both targets sign with the release key (as the server map staging does), read once, in one step', () => {
  assert.deepEqual([...wf.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]), ['VMAP_SIGN_KEY'], 'one secret, read once');
  assert.ok(!wf.includes('inherit'));
  assert.ok(!/VMAP_SIGN_KEY_TEST|allow-test-key|key-id k1/.test(wf), 'no test key anywhere');
  const rel = stepOf('Sign with the release key and verify');
  assert.ok(!rel.includes('if:') && rel.includes('VMAP_SIGN_KEY: ${{ secrets.VMAP_SIGN_KEY }}'));
  assert.ok(rel.includes('--kind catalog --out plugin-catalog.v1.txt --key-id k2 --last-seq "$last_seq" --seq "$seq"'));
  assert.ok(rel.includes('verify plugin-catalog.v1.txt --kind catalog --last-seq "$last_seq" --expect-seq "$seq"'));
  assert.ok(!/echo .*\$VMAP_SIGN_KEY|printenv|\benv\b *\|/.test(wf), 'a key is never printed');
  assert.match(wf, /\n {4}environment: vmap-sign\n/);
  assert.deepEqual([...wf.matchAll(/\n\s+environment: (.*)/g)].map((m) => m[1]), ['vmap-sign']);
});

test('seq: its own, read from the target release before signing, then raised; the build comes first and takes the repository file only', () => {
  const order = ['Build the unsigned catalog', 'Read the seq on the target release', 'Sign with the release key and verify', 'Publish the catalog', 'Check the live release did not move'].map((n) => wf.indexOf(`- name: ${n}\n`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'build, read seq, sign, publish, check');
  assert.ok(order.every((i) => i > 0));
  assert.ok(stepOf('Build the unsigned catalog').includes('node tool/ci/plugin-catalog.mjs build "tool/$CATALOG_JSON" --out catalog.unsigned.txt'));
  assert.ok(stepOf('Build the unsigned catalog').includes("''|/*|*..*|*\\\\*"), 'an absolute path, a parent path or a backslash is refused');
  assert.ok(stepOf('Read the seq on the target release').includes('plugin-catalog-publish.sh last-seq "$TARGET" "$KIND" > last-seq.txt'));
  for (const name of ['Sign with the release key and verify']) {
    const s = stepOf(name);
    assert.ok(s.includes('seq="$(node tool/ci/vmap-sign.mjs next-seq --last-seq "$last_seq")"'), name);
    assert.ok(!/vmap-history|vmap-publish\.sh/.test(s), 'the catalog has no history');
  }
  assert.ok(!/vmap-history|vmap-publish\.sh/.test(wf.replace(/#.*\n/g, '')), 'no history file and not the version map routine');
});

test('the live release is read before and after; a staging run leaves it equal, a live run changes only the catalog asset', () => {
  const before = stepOf('Read the live release');
  assert.ok(before.includes('live-assets.before.json') && before.includes('.assets[] | [.name, .id, .updated_at, .size]'));
  const after = stepOf('Check the live release did not move');
  assert.ok(after.includes('live-assets.after.json') && after.includes('cmp -s a.json b.json') && after.includes('exit 2'));
  assert.ok(after.includes('select(.[0] != "plugin-catalog.v1.txt")'), 'a live run may change the catalog asset');
  assert.ok(after.includes('if [ "$KIND" = live ]; then'), 'a staging run compares the whole list');
  assert.ok(wf.indexOf('- name: Read the live release') < wf.indexOf('- name: Publish the catalog'));
});

test('trust and shape: no secret but the two keys, contents: write in the one job, no input in a run block, no other repository', () => {
  assert.match(wf, /\npermissions: \{\}\n/);
  assert.match(wf, /\n {4}permissions:\n {6}contents: write\n/);
  assert.ok(!/(?:pull-requests|issues|actions|checks|id-token|packages):/.test(wf), 'asks for no other permission');
  assert.match(wf, /\n {4}concurrency:\n {6}group: vmap-publish\n {6}cancel-in-progress: false\n/);
  assert.equal((wf.slice(wf.indexOf('\njobs:\n')).match(/\n {2}[a-z][\w-]*:\n/g) ?? []).length, 1, 'one job');
  assert.ok(runSteps.length >= 8, 'every run step was found');
  for (const r of runSteps) assert.ok(!r.includes('${{'), r.split('\n').find((l) => l.includes('${{')));
  assert.ok((wf.match(/persist-credentials: false/g) ?? []).length === (wf.match(/uses: actions\/checkout@/g) ?? []).length, 'no checkout keeps the token');
  assert.ok(!/repository:/.test(wf), 'no other repository is checked out');
  assert.match(wf, /\n {6}CATALOG_JSON: \$\{\{ inputs\.catalog_json \}\}\n/, 'the input reaches the scripts through env');
  assert.match(wf, /\n {4}runs-on: ubuntu-latest\n/);
  assert.ok(!/shell:|\bpwsh\b|Get-|\$env:/.test(wf), 'bash only');
  for (const line of wf.split('\n')) if (/\b(?:cancelled|always|failure|success)\(\)/.test(line)) assert.match(line, /^\s+if: /, line);
});

test('text: no attribution line, version object map wording, and no other workflow calls this one yet', () => {
  assert.ok(!/Co-Authored|Generated with/.test(wf));
  assert.ok(!/\bthe feed\b/i.test(wf), 'version object map, not the feed');
  for (const f of readdirSync(join(here, '..', '.github', 'workflows')).filter((n) => n.endsWith('.yml') && n !== 'sr-plugin-catalog.yml')) {
    assert.ok(!read('.github', 'workflows', f).includes('sr-plugin-catalog.yml'), `${f} does not call or dispatch it`);
  }
});
