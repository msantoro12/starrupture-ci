#!/usr/bin/env node
// PTR staging, dry-run form (version-map step 45, design R5 "PTR staging").
//
//   node ci/staging.mjs stage --build <build.json> --index <staged.json> [--branches <file>] [--out <plan.json>]
//   node ci/staging.mjs rederive --branches <branches.json> --out <staged.json>
//
// A beta build that passed the chain is staged: its map rows sit on the loader
// fork's `auto/update-<CL>` (a newer build at the same CL gets `-<run>`, so
// nothing is force-pushed), the commit message carries the record, and
// state/staged.json is the readable index of those branches. The index holds
// pointers only; the rows live in the header.
//
// Nothing is signed or published while a CL is test-only. That is built in, not
// promised: stage() is handed only the two effects it may use, pushBranch and
// writeIndex, and no function in this file reaches signing, the feed or a
// release. A test hands it effects that fail on anything else.
//
// <build.json>:
//   { cl, branch, buildid, productVersion, exeSha256, imageStamp, size, run,
//     scans: [{ exe, buildid, ok }],          // the beta exe AND the public exe
//     repo: { sha, tree, verdict } }          // the loader fork's data commit
// <branches.json> (rederive): [{ ref, sha, tree, message }], the fork's
// `auto/update-*` branches with their commit messages.
//
// TODO(step 26, needs the owner): the real pushBranch needs the loader fork's
// deploy key and the auto/** ruleset. Until then the command line records the
// push in the plan and writes only the index.
//
// Exit codes: 0 staged (plan written), 3 refused, 2 usage or malformed input.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LOADER_REPO = 'StarRupture-ModLoader';
const RECORD_KEY = 'Staging-Record: ';

export class StagingError extends Error {}

const need = (cond, msg) => { if (!cond) throw new StagingError(msg); };
const isCl = (v) => Number.isInteger(v) && v > 0;

// The record a staged branch's commit message carries.
export function makeRecord(b) {
  need(b && typeof b === 'object', 'the build description is not an object');
  need(isCl(b.cl), 'build: cl is not a positive integer');
  need(typeof b.branch === 'string' && b.branch !== '', 'build: no Steam branch');
  need(b.branch !== 'public', 'build: public is promoted, not staged');
  need(/^\d+$/.test(String(b.buildid)), 'build: buildid is not numeric');
  need(/^[0-9a-f]{64}$/.test(String(b.exeSha256 ?? '')), 'build: exeSha256 is not a sha256');
  need(typeof b.imageStamp === 'string' && /^0x[0-9a-fA-F]+$/.test(b.imageStamp), 'build: imageStamp is not hex');
  need(Number.isInteger(b.size) && b.size > 0, 'build: size is not a positive integer');
  need(Number.isInteger(b.run) && b.run >= 0, 'build: run is not a non-negative integer');
  need(Array.isArray(b.scans), 'build: no scans');
  // Both exes must pass: the public pass proves the new rows cannot hurt current players.
  for (const exe of [b.branch, 'public']) {
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
  const next = updateIndex(index, rec.CL, entryOf(rec, branch, build.repo.sha, build.repo.tree));
  effects.pushBranch({ repo: LOADER_REPO, branch, message });
  effects.writeIndex(next);
  return { repo: LOADER_REPO, branch, message, index: next };
}

// The index, rebuilt from the fork's branches (it is missing or stale after sr-watch rebuilds the PR branch).
export function rederive(branches) {
  let index = {};
  const recs = branches.map((b) => ({ b, rec: parseCommitRecord(b.message) }))
    .sort((x, y) => x.rec.CL - y.rec.CL || x.rec.run - y.rec.run);
  for (const { b, rec } of recs) index = updateIndex(index, rec.CL, entryOf(rec, b.ref, b.sha, b.tree));
  return index;
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
    if (cmd === 'rederive' && o.branches && o.out) {
      writeFileSync(o.out, JSON.stringify(rederive(readJson(o.branches)), null, 2) + '\n');
      return 0;
    }
  } catch (e) {
    if (!(e instanceof StagingError)) throw e;
    process.stderr.write(`refused: ${e.message}\n`);
    return 3;
  }
  process.stderr.write('usage: staging.mjs stage --build <f> --index <f> [--branches <f>] [--out <f>]\n       staging.mjs rederive --branches <f> --out <f>\n');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
