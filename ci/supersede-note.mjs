#!/usr/bin/env node
// The line the alert issue carries when a run released a CL for the second time (sr-watch's supersede input,
// a hand dispatch only): which release it replaces, who started the run, the run and the new seq. A record,
// not a failure: it blocks nothing.
//
//   node ci/supersede-note.mjs --decision chain/decision.json --history chain/history.json
//        --actor <login> --run <run id> --seq <new seq> --out chain/supersede.json
//
// Writes { alerts: [line] } when the chain's decision carries `supersedes` (the seq replaced), and writes
// nothing otherwise. The alert step reads the file like the other writers' alert lists.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };

// The line, or null when the decision is not a second release.
export function supersedeNote({ decision, history, actor, run, seq }) {
  if (decision === null || typeof decision !== 'object' || !Number.isSafeInteger(decision.supersedes)) return null;
  const was = (Array.isArray(history?.releases) ? history.releases : []).find((r) => r?.seq === decision.supersedes && r?.cl === decision.cl);
  return `**second release of CL-${decision.cl}** (supersede, started by ${actor}): it replaces seq ${decision.supersedes}${was?.at ? `, our release of ${was.at}` : ''}; run ${run}, new seq ${seq}`;
}

export function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) { process.stderr.write(`supersede-note: bad argument ${argv[i]}\n`); return 2; }
    a[argv[i].slice(2)] = argv[i + 1];
  }
  if (!a.decision || !a.history || !a.actor || !a.run || !a.seq || !a.out) {
    process.stderr.write('usage: supersede-note.mjs --decision f --history f --actor <login> --run <id> --seq <n> --out f\n');
    return 2;
  }
  const line = supersedeNote({ decision: readJson(a.decision), history: readJson(a.history), actor: a.actor, run: a.run, seq: a.seq });
  if (line !== null) writeFileSync(a.out, `${JSON.stringify({ alerts: [`- ${line}`] }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
