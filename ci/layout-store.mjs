#!/usr/bin/env node
// The reference layout of the public build, kept per CL as a release asset.
//
//   node ci/layout-store.mjs record --out <record.json> --result <result.json> --scanner <scanner.json> --layout <layout-target.json>
//        --run <run id> --sha <workflow sha> [--at <time>] [--existing <record.json>]
//   node ci/layout-store.mjs reference <header> --record <record.json> --release <release.json> --cl <target CL> --sha256 <target exe sha256>
//        --native-keys <native-keys.txt> --layout-keys <list> --out <layout report>
//
// Field rows record where a reflected key moved between the build the plugins
// were built for and the new build. A non-public check downloads the public
// build to compare with; a public check has no older build to download, because
// Steam stops serving it once public moves. So every public check stores the
// layout it scanned, one asset `layout-CL-<CL>.json` of the `vmap-layouts`
// release, and the next public update reads the one for the header's builtCL.
//
// record  Builds the asset from the check's own files. It refuses a build that is
//         not an installed public build. With --existing (the asset already stored
//         for the same CL) it keeps the older keys and adds the new ones; another
//         exe for a stored CL is refused, so a CL is never overwritten.
// reference
//         Checks a stored record against the header and writes it as a layout
//         report for field-rows --base. Exit 3 prints the first thing that is
//         wrong and writes nothing; the caller then runs field-rows with
//         --base-missing so the run holds with that reason.
//
// A record is accepted only when ALL hold: it is the layout of the CL the header
// was built for; its build id, image stamp and image size are those of the
// header's build row for that CL; when the new build has the same CL, the exe
// sha256 is the same; the release asset was uploaded by the Actions bot (this
// repo's own workflow, with its token: a person or a fork cannot be that
// uploader); and it has an entry for every reflected key now listed.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ParseError } from './layout-diff.mjs';
import { keysFromCheck } from './field-rows.mjs';
import { parseLayoutReport } from './layout-table.mjs';
import { numberOf } from './map-mode.mjs';
import { EXIT_ERROR, EXIT_OK, EXIT_VIOLATION, MapError, buildMismatch, parse } from './version-map.mjs';

export const SCHEMA = 1;
export const RELEASE = 'vmap-layouts';
export const UPLOADER = { login: 'github-actions[bot]', type: 'Bot' };

export const assetName = (cl) => `layout-CL-${cl}.json`;

const SHA256 = /^[0-9a-f]{64}$/;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const json = (text, what) => {
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new MapError(`${what}: not JSON (${e.message})`); }
};

// The same build: CL, exe hash, Steam build id, image stamp and size.
const IDENTITY = ['cl', 'buildid', 'exeSha256', 'imageStamp', 'imageSize'];

// The record for the public build a check scanned, or why there is none.
export function buildRecord({ result, scanner, layoutText, run, workflowSha, at, existing = null }) {
  const exe = result?.checks?.exe;
  const dl = result?.download;
  if (!exe || !dl) throw new MapError('result.json has no exe check or download section');
  if (dl.betaKey !== 'public' || dl.installed !== true) throw new MapError(`only an installed public build is stored (branch ${JSON.stringify(dl.betaKey)}, installed ${dl.installed})`);
  if (!/^\d+$/.test(String(dl.buildid ?? ''))) throw new MapError(`the download has no Steam build id (${JSON.stringify(dl.buildid)})`);
  const sha = String(exe.sha256 ?? '').toLowerCase();
  if (!SHA256.test(sha)) throw new MapError('result.json has no exe sha256');
  const cl = numberOf(exe.cl, 'exe.cl', { lo: 1 });
  const se = scanner?.exe;
  if (!se) throw new MapError('scanner.json has no exe section');
  if (numberOf(se.cl, 'scanner exe.cl', { lo: 1 }) !== cl) throw new MapError(`the scanner measured CL-${se.cl}, the exe check says CL-${cl}`);
  const keys = parseLayoutReport(layoutText, 'the target layout report');
  if (!keys.length) throw new MapError('the target layout report has no keys');
  const record = {
    schema: SCHEMA,
    cl,
    buildid: String(dl.buildid),
    branch: 'public',
    productVersion: String(exe.productVersion ?? ''),
    exeSha256: sha,
    imageStamp: numberOf(se.imageStamp, 'exe.imageStamp'),
    imageSize: numberOf(se.imageSize, 'exe.imageSize', { lo: 1 }),
    run: Number(run),
    workflowSha: String(workflowSha),
    at: String(at),
    keys: [...keys].sort((a, b) => cmp(a.key, b.key)),
  };
  if (!existing) return record;
  const old = readRecord(existing, 'the stored record');
  for (const f of IDENTITY) {
    if (old[f] !== record[f]) throw new MapError(`CL-${cl} is already stored for another exe (${f}: stored ${old[f]}, measured ${record[f]}); nothing is overwritten`);
  }
  const merged = new Map(old.keys.map((k) => [k.key, k]));
  for (const k of record.keys) {
    const had = merged.get(k.key);
    if (had && JSON.stringify(had) !== JSON.stringify(k)) throw new MapError(`CL-${cl} is already stored with another result for ${k.key}; nothing is overwritten`);
    merged.set(k.key, k);
  }
  return { ...record, keys: [...merged.values()].sort((a, b) => cmp(a.key, b.key)) };
}

// A stored record, shape-checked. `what` names it in the message.
export function readRecord(text, what = 'the stored layout') {
  const doc = typeof text === 'string' ? json(text, what) : text;
  if (!doc || doc.schema !== SCHEMA) throw new MapError(`${what}: not a layout record of schema ${SCHEMA}`);
  const out = { ...doc };
  out.cl = numberOf(doc.cl, `${what}: cl`, { lo: 1 });
  if (!/^\d+$/.test(String(doc.buildid ?? ''))) throw new MapError(`${what}: no Steam build id`);
  out.buildid = String(doc.buildid);
  if (!SHA256.test(String(doc.exeSha256 ?? ''))) throw new MapError(`${what}: no exe sha256`);
  out.imageStamp = numberOf(doc.imageStamp, `${what}: imageStamp`);
  out.imageSize = numberOf(doc.imageSize, `${what}: imageSize`, { lo: 1 });
  try { out.keys = parseLayoutReport(JSON.stringify({ keys: doc.keys }), what); } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    throw new MapError(e.message);
  }
  return out;
}

// The layout report to give field-rows as its base, or a MapError naming what is
// wrong. `release` is the GitHub release object (assets with uploader and size),
// `size` the byte length of the downloaded record, `fields` the reflected keys now listed.
export function referenceFor({ headerText, recordText, release, targetCl, targetSha256, fields }) {
  const map = parse(headerText, 'the header');
  const built = map.builtCL;
  if (recordText === null || recordText === undefined) throw new MapError(`no stored layout for CL-${built}, the CL the plugins and the loader were built for (release ${RELEASE} has no ${assetName(built)}); it is stored by a public check of that build while Steam still serves it`);
  const record = readRecord(recordText, assetName(built));
  if (record.cl !== built) throw new MapError(`the stored layout is for CL-${record.cl}, the header was built for CL-${built}`);
  const row = map.builds.find((b) => b.cl === built);
  if (!row) throw new MapError(`the header has no build row for CL-${built}`);
  const why = buildMismatch(row, { cl: record.cl, source: `steam_build ${record.buildid}`, stamp: record.imageStamp, size: record.imageSize });
  if (why) throw new MapError(`the stored layout of CL-${built} is not the header's build: ${why}`);
  if (Number(targetCl) === record.cl && String(targetSha256 ?? '').toLowerCase() !== record.exeSha256) {
    throw new MapError(`CL-${built} is stored for the exe ${record.exeSha256.slice(0, 12)}, the build scanned now has ${String(targetSha256 ?? '').slice(0, 12) || 'no sha256'}`);
  }
  const asset = (release?.assets ?? []).find((a) => a?.name === assetName(built));
  if (!asset) throw new MapError(`release ${RELEASE} lists no ${assetName(built)}`);
  if (asset.uploader?.login !== UPLOADER.login || asset.uploader?.type !== UPLOADER.type) {
    throw new MapError(`${assetName(built)} was uploaded by ${asset.uploader?.login ?? 'unknown'} (${asset.uploader?.type ?? 'unknown'}), not by this repo's workflow (${UPLOADER.login}); it is not trusted`);
  }
  if (asset.size !== Buffer.byteLength(recordText)) throw new MapError(`${assetName(built)} is not the asset the release lists (size ${Buffer.byteLength(recordText)}, listed ${asset.size})`);
  const have = new Set(record.keys.map((k) => k.key));
  const missing = [...fields].filter((k) => !have.has(k)).sort(cmp);
  if (missing.length) {
    throw new MapError(`the stored layout of CL-${built} has no entry for ${missing.length} reflected key${missing.length === 1 ? '' : 's'} now listed (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? `, +${missing.length - 5} more` : ''}); a public check of that build, while Steam still serves it, adds them`);
  }
  return { cl: record.cl, keys: record.keys };
}

function args(rest) {
  const o = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k?.startsWith('--') || rest[i + 1] === undefined) throw new MapError(`bad argument ${k}`);
    o[k.slice(2)] = rest[i + 1];
  }
  return o;
}

const read = (p) => readFileSync(p, 'utf8');
const readOptional = (p) => { try { return read(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

export function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'record') {
      const o = args(rest);
      for (const f of ['out', 'result', 'scanner', 'layout', 'run', 'sha']) if (!o[f]) throw new MapError(`record needs --${f}`);
      const existingText = o.existing ? readOptional(o.existing) : null;
      const record = buildRecord({
        result: json(read(o.result), o.result), scanner: json(read(o.scanner), o.scanner), layoutText: read(o.layout),
        run: o.run, workflowSha: o.sha, at: o.at ?? new Date().toISOString(), existing: existingText,
      });
      writeFileSync(o.out, JSON.stringify(record, null, 2) + '\n');
      process.stdout.write(`layout-store: CL-${record.cl} (build ${record.buildid}), ${record.keys.length} keys\n`);
      return EXIT_OK;
    }
    if (cmd === 'reference') {
      const [header, ...more] = rest;
      const o = args(more);
      for (const f of ['record', 'release', 'cl', 'native-keys', 'layout-keys', 'out']) if (!header || !o[f]) throw new MapError(`reference needs <header> and --${f}`);
      const fields = keysFromCheck(read(o['native-keys']), read(o['layout-keys'])).fields;
      const report = referenceFor({
        headerText: read(header), recordText: readOptional(o.record), release: json(read(o.release), o.release),
        targetCl: Number(o.cl), targetSha256: o.sha256, fields,
      });
      writeFileSync(o.out, JSON.stringify({ keys: report.keys }, null, 2) + '\n');
      process.stdout.write(`layout-store: reference layout = stored CL-${report.cl}\n`);
      return EXIT_OK;
    }
    process.stderr.write('usage: layout-store.mjs record --out <f> --result <f> --scanner <f> --layout <f> --run <id> --sha <sha> [--at <t>] [--existing <f>]\n       layout-store.mjs reference <header> --record <f> --release <f> --cl <CL> --sha256 <hex> --native-keys <f> --layout-keys <f> --out <f>\n');
    return EXIT_ERROR;
  } catch (e) {
    if (!(e instanceof MapError) && !(e instanceof ParseError)) throw e;
    process.stderr.write(`${e.message}\n`);
    return cmd === 'record' || cmd === 'reference' ? EXIT_VIOLATION : EXIT_ERROR;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
