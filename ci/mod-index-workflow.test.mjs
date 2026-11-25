// Tests for the mod index workflow (.github/workflows/sr-mod-index.yml) and its leg in sr-watch.yml: who can start it,
// which release it writes, which key it signs with, what ends it green without a publish, and that the leg cannot hold
// or fail the game-update chain.
//
//   node --test ci/mod-index-workflow.test.mjs
//
// Reads the files as text, the way ci/plugin-catalog-workflow.test.mjs does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOADER_REPO } from './mod-index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const wf = read('.github', 'workflows', 'sr-mod-index.yml');
const watch = read('.github', 'workflows', 'sr-watch.yml');
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const call = section(wf, '  workflow_call:\n', '  workflow_dispatch:\n');
const dispatch = section(wf, '  workflow_dispatch:\n', '\npermissions:');
const stepIn = (text, name) => {
  const at = text.indexOf(`- name: ${name}\n`);
  assert.ok(at > 0, `step "${name}" exists`);
  const next = text.indexOf('\n      - ', at + 1);
  return text.slice(at, next < 0 ? undefined : next);
};
const jobText = (name) => {
  const at = wf.indexOf(`\n  ${name}:\n`);
  assert.ok(at > 0, `job ${name} exists`);
  const next = wf.slice(at + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? wf.slice(at) : wf.slice(at, at + 1 + next);
};
const gateJob = jobText('loader-ref');
const loaderJob = jobText('loader-check');
const pubJob = jobText('mod-index-publish');
const stepOf = (name) => stepIn(wf, name);
// A job runs to the next job key (two-space indent) or the end of the file.
const watchJob = (name) => {
  const rest = watch.slice(watch.indexOf(`\n  ${name}:\n`) + 1);
  assert.ok(watch.includes(`\n  ${name}:\n`), `job ${name} exists`);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const runSteps = [
  ...[...wf.matchAll(/\n( +)run: \|\n((?:\1 .*\n|\n)*)/g)].map((m) => m[2]),
  ...[...wf.matchAll(/\n +run: (?!\|).*/g)].map((m) => m[0]),
];

test('triggers: workflow_call and workflow_dispatch only; loader_ref on both, live on dispatch only', () => {
  const on = section(wf, '\non:\n', '\npermissions:');
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):\n/gm)].map((m) => m[1]), ['workflow_call', 'workflow_dispatch']);
  for (const [name, part] of [['call', call], ['dispatch', dispatch]]) {
    assert.match(part, /\n {6}loader_ref:\n(?:.*\n)*?\s+type: string\n\s+required: false\n\s+default: main\n/, `loader_ref: an optional string, default main, on a ${name}`);
  }
  assert.match(dispatch, /\n {6}live:\n(?:.*\n)*?\s+type: boolean\n\s+default: false\n/, 'live: a boolean, off by default');
  assert.ok(!/\blive:/.test(call), 'a workflow_call caller cannot set live: it is not an input there');
  assert.ok(!/pull_request|schedule:|push:/.test(on), 'no trigger a stranger can pull, no schedule, no push');
});

test('live: needs this workflow as the top-level run, a dispatch and live true, then main; nothing else reads the live input', () => {
  const flag = "LIVE: ${{ contains(github.workflow_ref, '/.github/workflows/sr-mod-index.yml@') && github.event_name == 'workflow_dispatch' && inputs.live == true }}";
  assert.ok(wf.includes(`      ${flag}\n`), 'LIVE needs this workflow as the top-level run, a dispatch and live true');
  assert.equal((wf.match(/inputs\.live/g) ?? []).length, 1, 'no other expression reads the live input');
  const gate = stepOf('Refuse a live publish that is not allowed');
  assert.ok(gate.includes("if: ${{ env.LIVE == 'true' }}\n") && gate.includes('"$GITHUB_REF" = refs/heads/main') && gate.includes('exit 2'));
  const head = stepOf('Require the current head of main for a live signature');
  assert.ok(head.includes("if: ${{ env.LIVE == 'true' }}\n") && head.includes('node tool/ci/mod-index.mjs loader-head "$LOADER_SHA"') && head.includes('set -euo pipefail') && !head.includes('||'), 'a live run signs only the commit that is the tip of main now, no fall-through');
  assert.ok(!/LOADER_REF/.test(pubJob), 'the signing job reads the loader only by the checked commit id');
  assert.ok(pubJob.indexOf('- name: Check the loader commit again') < pubJob.indexOf('- name: Require the current head') && pubJob.indexOf('- name: Require the current head') < pubJob.indexOf('- name: Take the loader'), 'the head is checked after the ref check and before anything is read');
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
  const allowed = [/^description: /, /^echo "This run publishes to the LIVE vmap-feed release\."$/, /^echo "TARGET=vmap-feed" >> "\$GITHUB_ENV"$/, /^gh api "repos\/\$GH_REPO\/releases\/tags\/vmap-feed" --jq /];
  const naming = wf.split('\n').map((l) => l.trim()).filter((l) => /vmap-feed(?!-rehearsal)/.test(l) && !l.startsWith('#'));
  assert.equal(naming.length, 5, naming.join('\n'));
  for (const l of naming) assert.ok(allowed.some((re) => re.test(l)), l);
  assert.ok(!/gh release (upload|create|edit|delete)|git push|--clobber/.test(wf), 'every write goes through ci/plugin-catalog-publish.sh');
  const pub = stepOf('Publish the mod index');
  assert.ok(pub.includes('plugin-catalog-publish.sh publish "$TARGET" "$KIND" mod-index'), 'one publish call, for whichever target was chosen, for the mod index');
  assert.equal((wf.match(/plugin-catalog-publish\.sh (?:last-seq|publish) /g) ?? []).length, 2);
  assert.ok(![...wf.matchAll(/plugin-catalog-publish\.sh (?:last-seq|publish) [^\n]*/g)].some((m) => !m[0].includes(' mod-index')), 'every routine call names the mod-index kind');
  assert.ok(wf.indexOf('Choose the staging prerelease') < wf.indexOf('Publish the mod index'));
});

test('keys: both targets sign with the release key, read once, in one step', () => {
  assert.deepEqual([...wf.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]), ['VMAP_SIGN_KEY'], 'one secret, read once');
  assert.ok(!wf.includes('inherit'));
  assert.ok(!/VMAP_SIGN_KEY_TEST|allow-test-key|key-id k1/.test(wf), 'no test key anywhere');
  assert.equal((wf.match(/vmap-sign\.mjs sign /g) ?? []).length, 1, 'one sign step');
  const rel = stepOf('Sign with the release key and verify');
  assert.ok(rel.includes("if: ${{ env.STATE == 'go' }}") && rel.includes('VMAP_SIGN_KEY: ${{ secrets.VMAP_SIGN_KEY }}'));
  assert.ok(rel.includes('sign mod-index.unsigned.txt --kind mod-index --out mod-index.v1.txt --key-id k2 --last-seq "$last_seq" --seq "$seq"'));
  assert.ok(rel.includes('verify mod-index.v1.txt --kind mod-index --last-seq "$last_seq" --expect-seq "$seq"'));
  assert.ok(!/echo .*\$VMAP_SIGN_KEY|printenv|\benv\b *\|/.test(wf), 'a key is never printed');
  assert.match(pubJob, /\n {4}environment: vmap-sign\n/);
  assert.deepEqual([...wf.matchAll(/\n\s+environment: (.*)/g)].map((m) => m[1]), ['vmap-sign']);
});

test('the loader ref gate: its own job before any loader code; every loader read is by its commit id; the signing job checks it again', () => {
  assert.match(gateJob, /\n {4}permissions:\n {6}contents: read\n/);
  assert.ok(!/needs:|environment:|secrets\.|contents\/|build-mod-index|continue-on-error|\bif:/.test(gateJob), 'the gate job needs no job, holds no secret, reads no loader file and always runs');
  assert.ok(gateJob.includes('LOADER_REF: ${{ inputs.loader_ref }}\n') && gateJob.includes('sha: ${{ steps.gate.outputs.sha }}\n'));
  assert.ok(stepOf('Resolve and check the loader ref').includes('set -euo pipefail\n          sha="$(node tool/ci/mod-index.mjs loader-ref "$LOADER_REF")"\n          echo "sha=$sha" >> "$GITHUB_OUTPUT"'));
  assert.match(loaderJob, /\n {4}needs: \[loader-ref\]\n/);
  for (const j of [loaderJob, pubJob]) {
    assert.ok(j.includes('LOADER_SHA: ${{ needs.loader-ref.outputs.sha }}\n'), 'the commit id comes from the gate job');
    assert.ok(j.includes(`LOADER_REPO: ${LOADER_REPO}\n`), 'the reads name the repository the gate checks');
  }
  const reads = wf.match(/contents\/[^"\n]*\?ref=[^"\n]*/g);
  assert.equal(reads.length, 3, 'index.json twice, the builder once');
  for (const r of reads) assert.ok(r.endsWith('?ref=$LOADER_SHA'), r);
  assert.ok(!/\$\{?LOADER_REF/.test(loaderJob), 'the loader job never reads by the input');
  assert.ok(stepOf("Read the loader's mod index").includes('[[ "$LOADER_SHA" =~ ^[0-9a-f]{40}$ ]] ||'), 'an empty ref would read the default branch');
  const again = stepOf('Check the loader commit again');
  assert.ok(again.includes('checked="$(node tool/ci/mod-index.mjs loader-ref "$LOADER_SHA")"') && again.includes('[ "$checked" = "$LOADER_SHA" ]') && again.includes('exit 2') && !/\bif:/.test(again));
  assert.ok(pubJob.indexOf('- name: Check the loader commit again') < pubJob.indexOf('- name: Take the loader'), 'checked before it is read');
  assert.ok(!/upload-artifact|download-artifact/.test(wf), 'no file passes between jobs');
  assert.deepEqual([...pubJob.matchAll(/needs\.([\w-]+)\.outputs\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`), ['loader-check.state', 'loader-ref.sha'], 'of the loader job the signing job reads only whether to run');
});

test('the loader repository: its code runs in its own job with no secret, no environment and a read-only token, last; no file of it reaches the signing job', () => {
  assert.match(loaderJob, /\n {6}LOADER_REPO: AlienXAXS\/StarRupture-ModLoader\n {6}LOADER_SHA: /);
  assert.ok(!/repository:/.test(wf), 'no other repository is checked out');
  assert.match(loaderJob, /\n {4}permissions:\n {6}contents: read\n/);
  assert.ok(!/environment:|secrets\.|VMAP_SIGN_KEY|uses: actions\/checkout/.test(loaderJob), 'the loader job has no environment, no secret and no checkout of this repository');
  assert.ok(!/inputs\.live|contents: write/.test(loaderJob));
  const idx = stepOf("Read the loader's mod index");
  assert.ok(idx.includes('contents/mod-index/index.json?ref=$LOADER_SHA') && idx.includes('application/vnd.github.raw+json'));
  const fetch = stepOf("Fetch the loader's builder");
  assert.ok(fetch.includes('contents/.github/vmap/build-mod-index.mjs?ref=$LOADER_SHA'));
  assert.ok(fetch.includes('HTTP 404') && fetch.includes('::notice::'), 'only a 404 means no loader builder, and it says so; any other error stops');
  const build = stepOf("Check the mod index with the loader's builder");
  assert.ok(build.includes('env -i PATH="$PATH" node loader-build/build-mod-index.mjs index.json --out loader-build/checked.txt'), "the loader's code runs with no environment of this job");
  const steps = [...loaderJob.matchAll(/\n {6}- (?:name|uses): (.*)/g)].map((m) => m[1]);
  assert.equal(steps[steps.length - 1], "Check the mod index with the loader's builder", "the loader's code is the last step of its job");
  assert.ok(!/loader-build|checked\.txt|build-mod-index/.test(pubJob), "the loader's builder and its output never reach the signing job");
  assert.ok(stepOf("Take the loader's mod index").includes('contents/mod-index/index.json?ref=$LOADER_SHA" > index.json'), 'the signing job reads index.json itself');
  const own = stepOf("Build the signer's input");
  assert.ok(own.includes('node tool/ci/mod-index.mjs build index.json --out mod-index.unsigned.txt') && own.includes('STATE=built'), "the signing job builds the signer's input itself from index.json");
  assert.ok(pubJob.indexOf('- name: Take the loader') < pubJob.indexOf("- name: Build the signer's input"));
  assert.match(pubJob, /\n {4}needs: \[loader-ref, loader-check\]\n {4}if: \$\{\{ needs\.loader-check\.outputs\.state == 'present' \}\}\n/);
});

test('a missing index.json at the ref ends green with a note; nothing after it runs', () => {
  const idx = stepOf("Read the loader's mod index");
  assert.ok(idx.includes('grep -q \'HTTP 404\' index.err') && idx.includes('state=missing') && idx.includes('GITHUB_STEP_SUMMARY'));
  assert.ok(!/exit 2/.test(idx.slice(idx.indexOf('HTTP 404'), idx.indexOf('else\n'))), 'the 404 branch does not fail');
  for (const n of ["Fetch the loader's builder", "Check the mod index with the loader's builder"]) {
    assert.match(stepOf(n), /\n\s+if: \$\{\{ steps\.read\.outputs\.state == 'present' \}\}\n/, `${n} runs only when the index exists`);
  }
  for (const n of ["Build the signer's input", 'Compare with the published mod index', 'Sign with the release key and verify', 'Publish the mod index', 'Check the live release did not move']) {
    if (n === "Build the signer's input") continue;
    assert.match(stepOf(n), /\n\s+if: \$\{\{ env\.STATE == '(?:built|go)' \}\}\n/, `${n} runs only past the missing-index stop`);
  }
});

test('an unchanged index ends green without signing or publishing; the published file is verified first', () => {
  const cmp = stepOf('Compare with the published mod index');
  assert.ok(cmp.includes("if: ${{ env.STATE == 'built' }}"));
  assert.ok(cmp.includes('plugin-catalog-publish.sh last-seq "$TARGET" "$KIND" mod-index > last-seq.txt'), 'the routine verifies the published file (verify --kind mod-index) and reads its seq');
  assert.ok(cmp.indexOf('last-seq') < cmp.indexOf('mod-index.mjs same'), 'verified before compared');
  assert.ok(cmp.includes('node tool/ci/mod-index.mjs same current/mod-index.v1.txt index.json'));
  assert.ok(cmp.includes('0)\n') && cmp.includes('STATE=unchanged') && cmp.includes('1) echo "STATE=go"') && cmp.includes('*) exit 2'), 'equal: unchanged; differs: go; unreadable: stop');
  assert.ok(cmp.includes('holds no mod index yet') && cmp.includes('STATE=go'), 'no published asset: publish');
  for (const n of ['Sign with the release key and verify', 'Publish the mod index', 'Check the live release did not move']) {
    assert.ok(stepOf(n).includes("if: ${{ env.STATE == 'go' }}"), `${n} runs only for a changed index`);
  }
  const order = ['Resolve and check the loader ref', "Read the loader's mod index", "Check the mod index with the loader's builder", 'Read the live release', "Build the signer's input", 'Compare with the published mod index', 'Sign with the release key and verify', 'Publish the mod index', 'Check the live release did not move'].map((n) => wf.indexOf(`- name: ${n}\n`));
  assert.ok(order.every((i) => i > 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'index read and checked, live assets read, built, compared, signed, published, live assets checked');
  assert.ok(!/vmap-history|vmap-publish\.sh/.test(wf.replace(/#.*\n/g, '')), 'no history file and not the version map routine');
});

test('the live release is read before and after; a staging run leaves it equal, a live run changes only the mod index asset', () => {
  const before = stepOf('Read the live release');
  assert.ok(before.includes('live-assets.before.json') && before.includes('.assets[] | [.name, .id, .updated_at, .size]'));
  const after = stepOf('Check the live release did not move');
  assert.ok(after.includes('live-assets.after.json') && after.includes('cmp -s a.json b.json') && after.includes('exit 2'));
  assert.ok(after.includes('select(.[0] != "mod-index.v1.txt")'), 'a live run may change the mod index asset');
  assert.ok(!after.includes('plugin-catalog.v1.txt'));
  assert.ok(after.includes('if [ "$KIND" = live ]; then'), 'a staging run compares the whole list');
  assert.ok(wf.indexOf('- name: Read the live release') < wf.indexOf('- name: Publish the mod index'));
});

test('trust and shape: contents: write in the signing job only, no input in a run block, no other repository', () => {
  assert.match(wf, /\npermissions: \{\}\n/);
  assert.match(pubJob, /\n {4}permissions:\n {6}contents: write\n/);
  assert.equal((wf.match(/contents: write/g) ?? []).length, 1, 'only the signing job writes');
  assert.ok(!/(?:pull-requests|issues|actions|checks|id-token|packages):/.test(wf), 'asks for no other permission');
  assert.match(pubJob, /\n {4}concurrency:\n {6}group: vmap-publish\n {6}cancel-in-progress: false\n/);
  assert.deepEqual([...wf.slice(wf.indexOf('\njobs:\n')).matchAll(/\n {2}([a-z][\w-]*):\n/g)].map((m) => m[1]), ['loader-ref', 'loader-check', 'mod-index-publish'], 'three jobs: the gate, the loader check, then the signing job');
  assert.ok(runSteps.length >= 8, 'every run step was found');
  for (const r of runSteps) assert.ok(!r.includes('${{'), r.split('\n').find((l) => l.includes('${{')));
  assert.ok((wf.match(/persist-credentials: false/g) ?? []).length === (wf.match(/uses: actions\/checkout@/g) ?? []).length, 'no checkout keeps the token');
  assert.match(wf, /\n {4}runs-on: ubuntu-latest\n/);
  assert.ok(!/shell:|\bpwsh\b|Get-|\$env:/.test(wf), 'bash only');
  for (const line of wf.split('\n')) if (/\b(?:cancelled|always|failure|success)\(\)/.test(line)) assert.match(line, /^\s+if: /, line);
});

test('text: no attribution line, version object map wording; only sr-watch.yml calls this workflow', () => {
  assert.ok(!/Co-Authored|Generated with/.test(wf));
  assert.ok(!/\bthe feed\b/i.test(wf), 'version object map, not the feed');
  for (const f of readdirSync(join(here, '..', '.github', 'workflows')).filter((n) => n.endsWith('.yml') && n !== 'sr-mod-index.yml' && n !== 'sr-watch.yml')) {
    assert.ok(!read('.github', 'workflows', f).includes('sr-mod-index.yml'), `${f} does not call or dispatch it`);
  }
  assert.equal((watch.match(/uses: .*sr-mod-index\.yml/g) ?? []).length, 1, 'sr-watch calls it once');
});

test('sr-watch leg: the existing poll only, a needs-free plan job that cannot fail the run, a call that never sets live, nothing waits for either', () => {
  assert.equal((watch.match(/\n {4}- cron: /g) ?? []).length, 1, 'no new schedule');
  assert.ok(/\n {2}schedule:\n {4}- cron: '7,37 \* \* \* \*'\n/.test(watch));
  assert.ok(!/\n {2}push:|\n {2}pull_request:/.test(watch), 'no push trigger');
  const plan = watchJob('mod-index-plan');
  assert.ok(!/\n {4}needs:/.test(plan), 'the plan job has no needs');
  assert.match(plan, /\n {4}continue-on-error: true\n/);
  assert.match(plan, /\n {4}permissions:\n {6}contents: read\n/);
  assert.ok(plan.includes('contents/mod-index/index.json?ref=main') && plan.includes('LOADER_REPO: AlienXAXS/StarRupture-ModLoader'));
  assert.ok(plan.includes('gh release download vmap-feed-rehearsal --pattern mod-index.v1.txt') && !/releases\/tags\/vmap-feed(?!-)|release download vmap-feed(?!-)/.test(plan), 'compared against the rehearsal prerelease only');
  assert.ok(plan.includes('node ci/mod-index.mjs same published/mod-index.v1.txt index.json') && plan.includes('state=none') && plan.includes('state=unchanged'));
  assert.ok(!/secrets\./.test(plan), 'the plan job holds no secret');
  const mod = watchJob('mod-index');
  assert.match(mod, /\n {4}needs: \[mod-index-plan\]\n/);
  assert.match(mod, /\n {4}if: \$\{\{ needs\.mod-index-plan\.outputs\.state == 'changed' \}\}\n/);
  assert.ok(mod.includes('uses: ./.github/workflows/sr-mod-index.yml'));
  assert.ok(!/\n {4}with:|live|loader_ref|continue-on-error/.test(mod), 'no live, no inputs, and no continue-on-error (a call job cannot carry it)');
  assert.match(mod, /\n {4}secrets:\n {6}VMAP_SIGN_KEY: \$\{\{ secrets\.VMAP_SIGN_KEY \}\}\n\n/, 'the secret, by name');
  assert.equal((mod.match(/secrets\./g) ?? []).length, 1, 'only one secret');
  assert.match(mod, /\n {4}permissions:\n {6}contents: write\n/);
  // Nothing waits for the leg: no other job lists it in needs, so it can hold neither the chain nor the alert job.
  const others = watch.replace(plan, '').replace(mod, '');
  assert.ok(!/mod-index/.test(others.replace(/#.*\n/g, '')), 'no other job names the leg');
  assert.ok(!/mod-index-plan|\bmod-index\b/.test(watchJob('alert').replace(/#.*\n/g, '')), 'the alert job does not read the leg');
  assert.ok(!/mod-index/.test(watchJob('planner-extract')));
});
