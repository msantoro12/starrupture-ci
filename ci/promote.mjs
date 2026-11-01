#!/usr/bin/env node
// Promotion of a staged PTR build when public flips, dry run only (version-map
// step 46, design R5 and section 7).
//
//   node ci/promote.mjs plan --index <staged.json> --public <public.json> --autopilot <autopilot.json>
//        --history <history.json> --last-seq <N> --now <ISO time> [--verify <verify.json>]
//        [--roll-forward] [--out <plan.json>]
//
// <public.json>: { buildid, exeSha256, cl }, the public build that just flipped
// and its exe's CL. <verify.json>: { ok }, the result of the re-scan or re-verify
// on the public exe; without it, or with ok not true, nothing is published. It
// is matched against state/staged.json:
//
//   same build id and exe sha256  -> re-scan on the public exe, then promote;
//                                    on failure the normal flow, no promotion
//   same CL, different exe        -> re-verify every key (rva check off, the stamp
//                                    differs); on failure the normal flow with the
//                                    staged exe as a second reference
//   different CL                  -> the normal new-CL flow, staged exe as a second
//                                    reference; nothing is promoted
//
// Promote = rebase the data commit onto the loader fork's tip, land it as a PR
// from the fork (merged once CI passes), export the feed, sign it, publish it
// under state/autopilot.json path "M" (fails closed; the daily cap counts
// publishes of the loader repo). A superseded staged CL is listed and skipped,
// never published. A staged CL that is not the public build stays staged.
//
// seq is max(now, last + 1) in UTC seconds, as the signer writes it. A publish
// counts against the daily cap and the gap; only an owner-dispatched
// roll-forward (--roll-forward: a newer seq replacing a bad publish of the same
// CL) is exempt from the one-publish-per-CL limit.
//
// This is a plan printer. plan() reads files and returns lines; promote() calls
// no effect in dry run and refuses a live run, so nothing is signed, published
// or released from here.
//
// TODO(steps 24-26 and 47, need the owner): the live run needs the real signing
// key, the publish workflow and the fork deploy key. Until then --live refuses.
//
// Exit codes: 0 plan printed (a HOLD is a plan too), 3 refused, 2 usage or malformed input.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkAutopilot, checkRateLimits } from './decide.mjs';
import { LOADER_REPO } from './staging.mjs';

export class PromoteError extends Error {}

const need = (cond, msg) => { if (!cond) throw new PromoteError(msg); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (s) => String(s).slice(0, 8);

export function classify(entry, pub) {
  if (!entry) return 'different-cl';
  return String(pub.buildid) === String(entry.buildid) && pub.exeSha256 === entry.exeSha256 ? 'same' : 'same-cl';
}

// Reasons the autopilot file or the history forbid a publish now; [] when it may go.
// The checks are decide.mjs's, so a publish and a release obey one set of limits.
export function gate({ autopilot, history, cl, now, rollForward = false }) {
  const ap = checkAutopilot({ ok: true, value: autopilot });
  if (ap.error) return [ap.error];
  if (!ap.enabled) return ['autopilot is disabled (enabled is not true)'];
  if (!ap.paths.includes('M')) return ['path M (map-only update) is not enabled in autopilot.paths'];
  return checkRateLimits({ historyLoaded: { ok: true, value: history }, repo: LOADER_REPO, cl: String(cl), path: 'M', nowMs: now, maxPerDay: ap.maxPerDay, rollForward });
}

// Returns { action, kind, cl, seq, lines, hold }; kind is how the public build
// matched the index: different-cl, same or same-cl.
export function plan({ index, pub, autopilot, history, lastSeq, now, verify = null, rollForward = false }) {
  need(isObj(index), 'staged index is not an object');
  need(isObj(pub) && Number.isInteger(pub.cl) && /^\d+$/.test(String(pub.buildid)) && /^[0-9a-f]{64}$/.test(String(pub.exeSha256 ?? '')), 'public build needs cl, buildid and exeSha256');
  need(Number.isInteger(lastSeq) && lastSeq >= 0, 'last seq is not a non-negative integer');
  need(Number.isFinite(now), 'now is not a time');
  const lines = [];
  const staged = Object.entries(index).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [cl, e] of staged) if (e.superseded) lines.push(`skip CL-${cl}: superseded, never published`);
  const entry = index[String(pub.cl)];
  const kind = entry && !entry.superseded ? classify(entry, pub) : 'different-cl';
  const live = staged.filter(([cl, e]) => !e.superseded && Number(cl) !== pub.cl);
  for (const [cl, e] of live) lines.push(`keep CL-${cl} staged: ${e.branch} ${e.buildid} is not the public build`);
  const ref = live.length ? live[live.length - 1][1] : null;
  const second = ref ? ` with the staged exe (${short(ref.exeSha256)}) as a second reference` : '';

  if (kind === 'different-cl') {
    lines.unshift(`public ${pub.buildid} is CL-${pub.cl}; no staged CL matches`);
    lines.push(`run the normal new-CL flow (check, suggest, apply, rebuild, re-scan) for CL-${pub.cl}${second}`);
    lines.push('nothing to promote');
    return { action: 'normal-flow', kind, cl: pub.cl, seq: null, lines, hold: [] };
  }
  const repo = entry.repos?.[LOADER_REPO];
  need(repo && repo.ref && repo.sha, `staged CL-${pub.cl} has no ${LOADER_REPO} pointer`);
  lines.unshift(`public ${pub.buildid} matches staged CL-${pub.cl} (${kind === 'same' ? 'same build and exe' : 'same CL, different exe'})`);
  if (kind === 'same') lines.push(`re-scan every DLL on the public exe (build ${pub.buildid})`);
  else {
    lines.push('re-verify every key on the public exe; the rva check is off, the image stamp differs');
    lines.push(`if anything fails: the normal check/suggest/apply flow for CL-${pub.cl} with the staged exe (${short(entry.exeSha256)}) as a second reference; no promotion`);
  }
  const check = kind === 'same' ? 're-scan' : 're-verify';
  if (isObj(verify) && verify.ok === false) {
    lines.push(`the ${check} on the public exe failed: run the normal check/suggest/apply flow for CL-${pub.cl} with the staged exe (${short(entry.exeSha256)}) as a second reference`);
    lines.push('nothing to promote');
    return { action: 'normal-flow', kind, cl: pub.cl, seq: null, lines, hold: [] };
  }
  lines.push(`rebase ${repo.ref} (${short(repo.sha)}) onto the ${LOADER_REPO} fork's current tip; regenerate the data commit if it conflicts`);
  lines.push(`open a PR from the fork into ${LOADER_REPO} main for CL-${pub.cl}; merge once CI passes`);
  if (rollForward) lines.push(`roll-forward: an owner-dispatched re-publish of CL-${pub.cl}; the one-publish-per-CL limit does not apply`);
  const hold = gate({ autopilot, history, cl: pub.cl, now, rollForward });
  if (!isObj(verify) || verify.ok !== true) hold.push(`no passing ${check} result on the public exe`);
  // The signer's rule: the UTC second of signing, and never back.
  const seq = Math.max(Math.floor(now / 1000), lastSeq + 1);
  if (hold.length) {
    for (const h of hold) lines.push(`HOLD: ${h}`);
    lines.push(`would NOT sign and publish seq ${seq}`);
    return { action: 'hold', kind, cl: pub.cl, seq, lines, hold };
  }
  lines.push(`export the feed (every kept CL, one snapshot)`);
  lines.push(`would sign and publish seq ${seq}`);
  return { action: 'promote', kind, cl: pub.cl, seq, lines, hold: [] };
}

// effects: { sign, publish, release }, called only in a live run, which does not exist yet.
export function promote(inputs, { dryRun = true, effects } = {}) {
  need(dryRun === true, 'live promotion is not built (needs the signing key, the publish workflow and the fork deploy key; see the TODO in this file)');
  void effects;
  return plan(inputs);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')); } catch (e) { throw new PromoteError(`${path}: ${e.message}`); }
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  const o = {};
  const FLAGS = ['--live', '--roll-forward'];
  for (let i = 0; i < rest.length; i += FLAGS.includes(rest[i]) ? 1 : 2) {
    if (!rest[i]?.startsWith('--') || (!FLAGS.includes(rest[i]) && rest[i + 1] === undefined)) { process.stderr.write(`promote: bad argument ${rest[i]}\n`); return 2; }
    o[rest[i].slice(2)] = FLAGS.includes(rest[i]) ? true : rest[i + 1];
  }
  if (cmd !== 'plan' || !o.index || !o.public || !o.autopilot || !o.history || o['last-seq'] === undefined || !o.now) {
    process.stderr.write('usage: promote.mjs plan --index <f> --public <f> --autopilot <f> --history <f> --last-seq <N> --now <ISO> [--verify <f>] [--roll-forward] [--out <f>]\n');
    return 2;
  }
  try {
    const now = Date.parse(o.now);
    const loadOr = (p) => { try { return readJson(p); } catch { return null; } };
    const result = promote({
      index: readJson(o.index), pub: readJson(o.public), autopilot: loadOr(o.autopilot), history: loadOr(o.history),
      lastSeq: /^\d+$/.test(o['last-seq']) ? Number(o['last-seq']) : NaN, now,
      verify: o.verify ? loadOr(o.verify) : null, rollForward: o['roll-forward'] === true,
    }, { dryRun: !o.live });
    process.stdout.write(`dry run: nothing is signed, published or released\n${result.lines.join('\n')}\n`);
    if (o.out) writeFileSync(o.out, JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (e) {
    if (!(e instanceof PromoteError)) throw e;
    process.stderr.write(`refused: ${e.message}\n`);
    return 3;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
