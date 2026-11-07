#!/usr/bin/env node
// PTR staging, dry-run form (version-map step 45, design R5 "PTR staging").
//
//   node ci/staging.mjs stage --build <build.json> --index <staged.json> [--branches <file>] [--out <plan.json>]
//   node ci/staging.mjs rederive --branches <branches.json> --out <staged.json>
//   node ci/staging.mjs target --repo <owner/name> --plan <stage-plan.json>      (the allowlist check alone)
//   node ci/staging.mjs push --repo <owner/name> --plan <stage-plan.json> --build <build.json> --header <file> \
//        --checkout <dir> --run-id <id> --run-attempt <n>      (the push job of sr-client-check.yml only)
//
// A beta build that passed the chain is staged: its map rows sit on the loader
// fork's `auto/update-<CL>` (a newer build at the same CL gets `-<run>`, so
// nothing is force-pushed), the commit message carries the record, and
// state/staged.json is the readable index of those branches. The index holds
// pointers only; the rows live in the header.
//
// A build first seen on `public` is pushed the same way (its rows need a candidate
// loader and a rig run too) but is not staged: there is no beta to promote it from,
// so it gets a record naming only the public exe and no entry in the index.
//
// Nothing is signed or published while a CL is test-only. That is built in, not
// promised: stage() is handed only the two effects it may use, pushBranch and
// writeIndex, and no function in this file reaches signing, the feed or a
// release. A test hands it effects that fail on anything else.
//
// <build.json>:
//   { cl, branch, buildid, productVersion, exeSha256, imageStamp, size, run,
//     scans: [{ exe, buildid, ok }],          // the beta exe AND the public exe (public: just that one)
//     repo: { sha, tree, verdict } }          // the loader fork's data commit
// <branches.json> (rederive): [{ ref, sha, tree, message }], the fork's
// `auto/update-*` branches with their commit messages.
//
// Planning and pushing are separate on purpose. `stage` runs in the keyless
// map-mode job: its pushBranch effect only records the push in the plan
// (`done: false`). `push` is the real effect, run by the one job that holds the
// loader fork's deploy key (environment fork-push, SR_DEPLOYKEY_MODLOADER): it
// cuts the branch from the loader commit the chain read the header from, adds
// one commit that changes only the generated version-map header, and pushes it
// to the allowlisted repo and branch pattern below, with the key in
// GIT_SSH_COMMAND. Never a tag, never a force, never another branch. A branch
// that already holds the same tree is left alone; one that holds another tree
// is not touched, and the push goes to a run-id suffixed name (as auto-apply does).
//
// Exit codes: 0 staged or pushed, 3 refused, 2 usage or malformed input.

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LOADER_REPO = 'StarRupture-ModLoader';
// The only repository the push job may write to, the only branches it may write
// (auto/update-<CL>, optionally with a run id and attempt) and the only file it changes.
export const PUSH_REPOS = ['msantoro12/StarRupture-ModLoader'];
export const PUSH_BRANCH = /^auto\/update-[0-9]+(-[0-9]+){0,2}$/;
export const HEADER_PATH = 'StarRupture-ModLoader-Core/hooks/game/version_map.generated.h';
const RECORD_KEY = 'Staging-Record: ';

export class StagingError extends Error {}

const need = (cond, msg) => { if (!cond) throw new StagingError(msg); };
const isCl = (v) => Number.isInteger(v) && v > 0;

// The record a staged branch's commit message carries.
export function makeRecord(b) {
  need(b && typeof b === 'object', 'the build description is not an object');
  need(isCl(b.cl), 'build: cl is not a positive integer');
  need(typeof b.branch === 'string' && b.branch !== '', 'build: no Steam branch');
  need(/^\d+$/.test(String(b.buildid)), 'build: buildid is not numeric');
  need(/^[0-9a-f]{64}$/.test(String(b.exeSha256 ?? '')), 'build: exeSha256 is not a sha256');
  need(typeof b.imageStamp === 'string' && /^0x[0-9a-fA-F]+$/.test(b.imageStamp), 'build: imageStamp is not hex');
  need(Number.isInteger(b.size) && b.size > 0, 'build: size is not a positive integer');
  need(Number.isInteger(b.run) && b.run >= 0, 'build: run is not a non-negative integer');
  need(Array.isArray(b.scans), 'build: no scans');
  // Both exes must pass: the public pass proves the new rows cannot hurt current players.
  // A build of public has just the one exe.
  for (const exe of new Set([b.branch, 'public'])) {
    const s = b.scans.find((x) => x?.exe === exe);
    need(s, `build: no scan on the ${exe} exe`);
    need(s.ok === true, `build: the scan on the ${exe} exe did not pass`);
  }
  need(b.repo && typeof b.repo.sha === 'string' && typeof b.repo.tree === 'string' && typeof b.repo.verdict === 'string' && b.repo.verdict !== '', 'build: repo needs sha, tree and verdict');
  return {
    CL: b.cl, branch: b.branch, buildid: Number(b.buildid), productVersion: b.productVersion ?? null,
    exeSha256: b.exeSha256, imageStamp: b.imageStamp, size: b.size, run: b.run,
    verdicts: { [LOADER_REPO]: b.repo.verdict },
    verifiedOn: b.scans.filter((s) => s.exe === b.branch || s.exe === 'public').map((s) => `${s.exe} ${s.buildid}`).sort(),
  };
}

export const commitMessage = (rec) => `Add map rows for CL-${rec.CL}\n\nStaged from ${rec.branch} ${rec.buildid}; not signed, not published.\n\n${RECORD_KEY}${JSON.stringify(rec)}\n`;

export function parseCommitRecord(message) {
  const line = String(message).split('\n').find((l) => l.startsWith(RECORD_KEY));
  need(line, 'commit message holds no staging record');
  let rec;
  try { rec = JSON.parse(line.slice(RECORD_KEY.length)); } catch { throw new StagingError('staging record is not JSON'); }
  need(isCl(rec?.CL) && typeof rec.exeSha256 === 'string', 'staging record is incomplete');
  return rec;
}

export function branchName(cl, existing = [], run) {
  const base = `auto/update-${cl}`;
  if (!existing.includes(base)) return base;
  const next = `${base}-${run}`;
  need(!existing.includes(next), `${next} already exists; a newer build needs a new run id`);
  return next;
}

const entryOf = (rec, ref, sha, tree) => ({
  branch: rec.branch, buildid: rec.buildid, productVersion: rec.productVersion, exeSha256: rec.exeSha256, imageStamp: rec.imageStamp,
  repos: { [LOADER_REPO]: { ref, sha, tree, verdict: rec.verdicts[LOADER_REPO] } },
  verifiedOn: rec.verifiedOn, run: rec.run, superseded: false,
});

// Puts the entry in; an older staged CL on the same Steam branch is superseded.
export function updateIndex(index, cl, entry) {
  const out = structuredClone(index ?? {});
  for (const [other, e] of Object.entries(out)) if (Number(other) < cl && e.branch === entry.branch) e.superseded = true;
  out[String(cl)] = entry;
  return Object.fromEntries(Object.entries(out).sort((a, b) => Number(a[0]) - Number(b[0])));
}

// effects: { pushBranch({repo, branch, message}), writeIndex(index) }
export function stage(build, { index, existingBranches = [], effects }) {
  const rec = makeRecord(build);
  const branch = branchName(rec.CL, existingBranches, rec.run);
  const message = commitMessage(rec);
  if (rec.branch === 'public') {
    // Pushed for the candidate build and the rig, but nothing to promote later: the index is left alone.
    effects.pushBranch({ repo: LOADER_REPO, branch, message });
    return { repo: LOADER_REPO, branch, message, index: structuredClone(index ?? {}) };
  }
  const next = updateIndex(index, rec.CL, entryOf(rec, branch, build.repo.sha, build.repo.tree));
  effects.pushBranch({ repo: LOADER_REPO, branch, message });
  effects.writeIndex(next);
  return { repo: LOADER_REPO, branch, message, index: next };
}

// The index, rebuilt from the fork's branches (it is missing or stale after sr-watch rebuilds the PR branch).
export function rederive(branches) {
  let index = {};
  // A record of a public build is no staged entry (see stage).
  const recs = branches.map((b) => ({ b, rec: parseCommitRecord(b.message) })).filter(({ rec }) => rec.branch !== 'public')
    .sort((x, y) => x.rec.CL - y.rec.CL || x.rec.run - y.rec.run);
  for (const { b, rec } of recs) index = updateIndex(index, rec.CL, entryOf(rec, b.ref, b.sha, b.tree));
  return index;
}

// The allowlist: the repo and the branch name a push may use. Throws StagingError.
export function checkTarget(repo, branch) {
  need(PUSH_REPOS.includes(repo), `${repo} is not a repository the push job writes to (allowed: ${PUSH_REPOS.join(', ')})`);
  need(typeof branch === 'string' && PUSH_BRANCH.test(branch), `${branch} is not a branch the push job writes (only auto/update-<CL>)`);
}

const defaultGit = (args, { cwd } = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();

// The real effect. Cuts one commit from `checkout` (the loader commit the chain read the
// header from) that changes only HEADER_PATH, and pushes it as plan.branch, or as plan.branch
// with the run id when that branch exists with another tree. opts: { repo, plan, build, header,
// checkout, runId, runAttempt, url? }; git is replaceable for tests. Returns
// { branch, sha, tree, pushed }.
export function pushLoader(opts, git = defaultGit) {
  const { repo, plan, build, header, checkout, runId, runAttempt } = opts;
  need(plan && plan.repo === LOADER_REPO && typeof plan.branch === 'string' && typeof plan.message === 'string', 'the stage plan holds no loader branch and message');
  checkTarget(repo, plan.branch);
  need(/^[0-9]+$/.test(String(runId)) && /^[0-9]+$/.test(String(runAttempt)), 'run id and attempt must be numeric');
  need(build?.repo && /^[0-9a-f]{40}$/.test(String(build.repo.sha)) && /^[0-9a-f]{40}$/.test(String(build.repo.tree)), 'build.json names no loader commit and tree');
  const g = (...args) => git(args, { cwd: checkout });
  need(g('rev-parse', 'HEAD') === build.repo.sha, 'the checkout is not the loader commit the chain read the header from');
  need(g('rev-parse', 'HEAD^{tree}') === build.repo.tree, 'the checkout tree is not the one the chain read the header from');
  copyFileSync(header, `${checkout}/${HEADER_PATH}`);
  g('add', '--', HEADER_PATH);
  const changed = g('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  need(changed.length > 0, 'the candidate header equals the loader header; there are no rows to push');
  need(changed.length === 1 && changed[0] === HEADER_PATH, `the commit would change more than the header: ${changed.join(', ')}`);
  g('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-q', '-m', plan.message);
  const sha = g('rev-parse', 'HEAD');
  const tree = g('rev-parse', 'HEAD^{tree}');
  const url = opts.url ?? `git@github.com:${repo}.git`;
  // The plan's name first; a branch with another tree is never overwritten, so the next name carries the run.
  for (const branch of [plan.branch, `${plan.branch}-${runId}-${runAttempt}`]) {
    checkTarget(repo, branch);
    const existing = g('ls-remote', url, `refs/heads/${branch}`).split('\t')[0];
    if (existing) {
      g('fetch', '-q', '--depth', '1', url, `refs/heads/${branch}`);
      if (g('rev-parse', 'FETCH_HEAD^{tree}') === tree) return { branch, sha: existing, tree, pushed: false };
      continue;
    }
    g('push', '-q', '--no-tags', url, `HEAD:refs/heads/${branch}`);
    return { branch, sha, tree, pushed: true };
  }
  throw new StagingError(`${plan.branch} and its run-suffixed name both exist with other trees; nothing is pushed`);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')); } catch (e) { throw new StagingError(`${path}: ${e.message}`); }
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) { process.stderr.write(`staging: bad argument ${rest[i]}\n`); return 2; }
    o[rest[i].slice(2)] = rest[i + 1];
  }
  try {
    if (cmd === 'stage' && o.build && o.index) {
      const pushed = [];
      const plan = stage(readJson(o.build), {
        index: (() => { try { return readJson(o.index); } catch { return {}; } })(),
        existingBranches: o.branches ? readFileSync(o.branches, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [],
        effects: { pushBranch: (p) => pushed.push(p), writeIndex: (ix) => writeFileSync(o.index, JSON.stringify(ix, null, 2) + '\n') },
      });
      if (o.out) writeFileSync(o.out, JSON.stringify({ ...plan, pushed: pushed.map(({ repo, branch }) => ({ repo, branch, done: false })) }, null, 2) + '\n');
      process.stdout.write(`staging: would push ${plan.repo} ${plan.branch}; index now lists ${Object.keys(plan.index).length} CLs; nothing signed or published\n`);
      return 0;
    }
    if (cmd === 'target' && o.repo && o.plan) {
      checkTarget(o.repo, readJson(o.plan).branch);
      return 0;
    }
    if (cmd === 'push' && o.repo && o.plan && o.build && o.header && o.checkout && o['run-id'] && o['run-attempt']) {
      const r = pushLoader({ repo: o.repo, plan: readJson(o.plan), build: readJson(o.build), header: o.header, checkout: o.checkout, runId: o['run-id'], runAttempt: o['run-attempt'] });
      process.stderr.write(r.pushed ? `pushed ${r.branch} at ${r.sha} to ${o.repo}\n` : `${r.branch} already holds this tree at ${r.sha}; nothing to push\n`);
      process.stdout.write(`branch=${r.branch}\nsha=${r.sha}\n`);
      return 0;
    }
    if (cmd === 'rederive' && o.branches && o.out) {
      writeFileSync(o.out, JSON.stringify(rederive(readJson(o.branches)), null, 2) + '\n');
      return 0;
    }
  } catch (e) {
    if (!(e instanceof StagingError)) throw e;
    process.stderr.write(`refused: ${e.message}\n`);
    return 3;
  }
  process.stderr.write('usage: staging.mjs stage --build <f> --index <f> [--branches <f>] [--out <f>]\n       staging.mjs rederive --branches <f> --out <f>\n       staging.mjs target --repo <owner/name> --plan <f>\n       staging.mjs push --repo <owner/name> --plan <f> --build <f> --header <f> --checkout <dir> --run-id <n> --run-attempt <n>\n');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
