// Does an open game-update PR already hold the build ids this poll found?
//
//   node ci/pr-covers.mjs --baseline <steam.json on main> --polled <steam.json after the poll> --pr-head <steam.json on the PR branch>
//
// sr-watch.yml asks this before it refreshes an open update PR and runs the chain again.
// Exit 0: covered (skip). Exit 1: not covered (refresh, run the chain once).
// Exit 2: a file is missing or unreadable; that also counts as not covered.
//
// A state file maps app -> branch -> { buildid, timeupdated }. The "changes" of a file are the
// app:branch entries whose build id differs from the baseline (main), as the poll sees them.
// The PR covers the poll when every change the poll found is a change the PR head holds with the
// same build id. timeupdated is ignored. A branch missing from this poll's Steam answer is not a
// change of the poll, so a Steam hiccup never reads as a new build.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// { 'app:branch': buildid } for every entry of `state` that differs from `baseline`.
export function changesAgainst(baseline, state) {
  const out = {};
  for (const [app, a] of Object.entries(state?.apps ?? {})) {
    for (const [branch, v] of Object.entries(a?.branches ?? {})) {
      const was = baseline?.apps?.[app]?.branches?.[branch]?.buildid;
      if (v?.buildid != null && String(v.buildid) !== (was == null ? undefined : String(was))) out[`${app}:${branch}`] = String(v.buildid);
    }
  }
  return out;
}

// True when the PR head holds every change the poll found, with the same build ids.
export function covers(baseline, polled, prHead) {
  const found = changesAgainst(baseline, polled);
  const held = changesAgainst(baseline, prHead);
  const keys = Object.keys(found);
  return keys.length > 0 && keys.every((k) => held[k] === found[k]);
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i < 0 ? undefined : argv[i + 1];
  };
  const read = (name) => {
    const path = arg(name);
    try {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      if (!state || typeof state !== 'object' || typeof state.apps !== 'object') throw new Error('not a state file');
      return state;
    } catch (e) {
      console.error(`Cannot read the ${name} state (${path}): ${e.message}`);
      process.exit(2);
    }
  };
  const baseline = read('baseline');
  const polled = read('polled');
  const prHead = read('pr-head');
  if (covers(baseline, polled, prHead)) {
    console.log('The PR head already holds every build id this poll found.');
    return 0;
  }
  console.log('The PR head does not hold every build id this poll found.');
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
