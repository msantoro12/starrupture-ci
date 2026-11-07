#!/usr/bin/env node
// Reads state/public-builds.json: the one list of the game builds that are, or
// once were, on Steam's public branch. The feed export and the loader's release
// check both read it, so both apply one rule. The format is in ci/VERSION-MAP.md.
//
//   node ci/public-builds.mjs <public-builds.json>
//
// Prints the current public CL and every CL that was public; exits 2 and prints
// why when the file is missing, unreadable or off the format.

import { readFileSync } from 'node:fs';
import { isMain } from './layout-diff.mjs';

export const PUBLIC_BUILDS_URL = 'https://raw.githubusercontent.com/msantoro12/starrupture-ci/main/state/public-builds.json';

export class PublicBuildsError extends Error {}

const need = (ok, message) => {
  if (!ok) throw new PublicBuildsError(message);
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const RE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

// Returns { builds: [{ cl, buildid, firstSeen }] }, in file order (oldest first).
// Strict: unknown keys, a missing field or an out-of-order time is an error, so
// a damaged file never reads as a shorter list.
export function parsePublicBuilds(text, where = 'public builds') {
  let v;
  try {
    v = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new PublicBuildsError(`${where}: not JSON: ${e.message}`);
  }
  need(Array.isArray(v), `${where}: expected a JSON array of { cl, buildid, firstSeen }`);
  need(v.length > 0, `${where}: the list is empty, so public's current build is unknown`);
  let last = -Infinity;
  const builds = v.map((e, i) => {
    const at = `${where}: entry ${i}`;
    need(isObj(e) && Object.keys(e).sort().join() === 'buildid,cl,firstSeen', `${at}: expected exactly cl, buildid and firstSeen`);
    need(Number.isInteger(e.cl) && e.cl > 0, `${at}: cl is not a positive integer`);
    need(typeof e.buildid === 'string' && /^[1-9]\d*$/.test(e.buildid), `${at}: buildid is not a Steam build id string`);
    need(typeof e.firstSeen === 'string' && RE_TIME.test(e.firstSeen) && !Number.isNaN(Date.parse(e.firstSeen)), `${at}: firstSeen is not a UTC time like 2026-10-29T21:15:50Z`);
    const t = Date.parse(e.firstSeen);
    need(t >= last, `${at}: firstSeen is earlier than the entry before it; the list only grows at the end`);
    last = t;
    return { cl: e.cl, buildid: e.buildid, firstSeen: e.firstSeen };
  });
  return { builds };
}

export function readPublicBuilds(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new PublicBuildsError(`${path}: cannot read the public builds list: ${e.message}`);
  }
  return parsePublicBuilds(text, path);
}

// Public's current CL: the newest entry, the last one in the file.
export const currentPublicCL = (list) => list.builds[list.builds.length - 1].cl;

// Every CL that is or was public.
export const publicCLs = (list) => new Set(list.builds.map((b) => b.cl));

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new PublicBuildsError('usage: public-builds.mjs <public-builds.json>');
    const list = readPublicBuilds(process.argv[2]);
    process.stdout.write(`current public CL-${currentPublicCL(list)}; public CLs: ${[...publicCLs(list)].join(', ')}\n`);
  } catch (e) {
    process.stderr.write(`public-builds: ${e.message}\n`);
    process.exitCode = 2;
  }
}
