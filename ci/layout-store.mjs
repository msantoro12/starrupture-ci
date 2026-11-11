#!/usr/bin/env node
// The reference layout of the public build, kept per CL as a release asset.
//
//   node ci/layout-store.mjs record --out <record.json> --result <result.json> --scanner <scanner.json> --layout <layout-target.json>
//        --run <run id> --sha <workflow sha> [--at <time>] [--existing <record.json> --release <release.json>]
//   node ci/layout-store.mjs reference <header> --record <record.json> --release <release.json> --cl <target CL> --sha256 <target exe sha256>
//        --native-keys <native-keys.txt> --layout-keys <list> --out <layout report> [--published <dir>]
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
//         for the same CL, and --release, the release object that lists it) it keeps
//         the older keys and adds the new ones; another exe for a stored CL is
//         refused, so a CL is never overwritten, and so is a stored asset an Actions
//         job did not upload, so a hand-made one is not carried into a trusted one.
//         When the result equals the stored asset it writes nothing (exit 0).
// reference
//         Checks a stored record against the header and writes it as a layout
//         report for field-rows --base. Exit 3 prints the first thing that is
//         wrong and writes nothing; the caller then runs field-rows with
//         --base-missing so the run holds with that reason. --published names a
//         directory with the published version map (version-map-client.v1.txt) and the
//         JSON of the release that lists it (release.json): the record is also checked
//         against that file's field rows for the built CL. If the file is missing,
//         unreadable, not the bot's upload or has no rows for that CL, one line says the
//         wider check was skipped and the header's rows still check the record.
//
// A record is accepted only when ALL hold: it is the layout of the CL the header
// was built for; its build id, image stamp and image size are those of the
// header's build row for that CL; when the new build has the same CL, the exe
// sha256 is the same; the release asset was uploaded by the Actions bot (an
// Actions job of this repository, with its token: a hand upload does not count);
// it has an entry for every reflected key now listed; and its offsets, sizes and masks agree with the
// header's own field rows for that CL (crossCheck), and with the published version map's when it is usable. The uploader is what
// the release API reports, so any job of this repository that holds
// contents: write could upload as the bot: only people who can push a workflow to
// this repository can do that, and they can change main as well.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ParseError } from './layout-diff.mjs';
import { REFLECTED_SIZE_KEYS, keysFromCheck } from './field-rows.mjs';
import { parseLayoutReport } from './layout-table.mjs';
import { numberOf } from './map-mode.mjs';
import { EXIT_ERROR, EXIT_OK, EXIT_VIOLATION, MapError, buildMismatch, parse, parseFeed } from './version-map.mjs';

export const SCHEMA = 1;
export const RELEASE = 'vmap-layouts';
export const UPLOADER = { login: 'github-actions[bot]', type: 'Bot' };
export const PUBLISHED = { release: 'vmap-feed', asset: 'version-map-client.v1.txt' };

export const assetName = (cl) => `layout-CL-${cl}.json`;

const SHA256 = /^[0-9a-f]{64}$/;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const json = (text, what) => {
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new MapError(`${what}: not JSON (${e.message})`); }
};

// The same build: CL, exe hash, Steam build id, image stamp and size.
const IDENTITY = ['cl', 'buildid', 'exeSha256', 'imageStamp', 'imageSize'];

// The record for the public build a check scanned, or why there is none.
// existing: { text, release } when an asset for this CL is already stored (its text, and the release object that lists it).
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
  checkAsset(existing.release, cl, existing.text);
  const old = readRecord(existing.text, 'the stored record');
  for (const f of IDENTITY) {
    if (old[f] !== record[f]) throw new MapError(`CL-${cl} is already stored for another exe (${f}: stored ${old[f]}, measured ${record[f]}); nothing is overwritten`);
  }
  const merged = new Map(old.keys.map((k) => [k.key, k]));
  for (const k of record.keys) {
    const had = merged.get(k.key);
    if (had && !sameEntry(had, k)) throw new MapError(`CL-${cl} is already stored with another result for ${k.key}; nothing is overwritten`);
    merged.set(k.key, k);
  }
  return { ...record, keys: [...merged.values()].sort((a, b) => cmp(a.key, b.key)) };
}

const ENTRY = ['key', 'result', 'offset', 'size', 'boolMask'];
const sameEntry = (a, b) => ENTRY.every((f) => a[f] === b[f]);

// True when two records describe the same build with the same keys and values (run, sha and time are information only).
export function sameLayout(a, b) {
  return IDENTITY.every((f) => a[f] === b[f]) && a.keys.length === b.keys.length && a.keys.every((k, i) => sameEntry(k, b.keys[i]));
}

// The release asset for `cl`, or a MapError naming why it is not trusted: it must be listed, uploaded by the
// Actions bot, and be the file in hand (same size).
export function checkAsset(release, cl, text) {
  return trustedAsset(release, RELEASE, assetName(cl), text);
}

function trustedAsset(release, releaseName, name, text) {
  const asset = (release?.assets ?? []).find((a) => a?.name === name);
  if (!asset) throw new MapError(`release ${releaseName} lists no ${name}`);
  if (asset.uploader?.login !== UPLOADER.login || asset.uploader?.type !== UPLOADER.type) {
    throw new MapError(`${name} was uploaded by ${asset.uploader?.login ?? 'unknown'} (${asset.uploader?.type ?? 'unknown'}), not by an Actions job of this repository (${UPLOADER.login}); it is not trusted`);
  }
  if (asset.size !== Buffer.byteLength(text)) throw new MapError(`${name} is not the asset the release lists (size ${Buffer.byteLength(text)}, listed ${asset.size})`);
  return asset;
}

// A stored record, shape-checked. `what` names it in the message.
export function readRecord(text, what = 'the stored layout') {
  const doc = json(text, what);
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

const hex = (n) => (Number.isInteger(n) ? `0x${n.toString(16)}` : String(n));

// The header's field rows for the CL it was built for are an independent source for the record's values.
// Every key that has both must agree on offset, size and mask. A class key is a struct size (offset 0,
// mask 0); a key in REFLECTED_SIZE_KEYS holds the built size in the header and the PDB's register size in
// the record, so its size is not compared. A header key the record lacks, and a renamed member (the record
// looks keys up by name, so it cannot hold the renamed one), is skipped, but a pass that compared under half
// of the header's rows proves nothing and is refused too.
// `source` names where the rows come from ('header' or 'version map').
function crossCheck(rows, built, record, source = 'header') {
  const by = new Map(record.keys.map((k) => [k.key, k]));
  const bad = [];
  let compared = 0;
  for (const r of rows) {
    const k = by.get(r.key);
    if (!k) continue;
    compared++;
    const cls = !r.key.includes('::');
    const sz = REFLECTED_SIZE_KEYS.has(r.key);
    const rec = { offset: cls ? 0 : k.offset, size: k.size, mask: cls ? 0 : (k.boolMask ?? 0) };
    const diff = k.result !== 'OK' || rec.offset !== r.offset || rec.mask !== r.mask || (!sz && rec.size !== r.size);
    if (diff) {
      const show = (v) => `${hex(v.offset)}/${hex(v.size)}/${hex(v.mask)}`;
      bad.push(`${r.key}: ${source} ${show(r)}, record ${k.result === 'OK' ? show(rec) : k.result}`);
    }
  }
  if (bad.length) {
    throw new MapError(`the stored layout of CL-${built} disagrees with the ${source}'s field rows for CL-${built} on ${bad.length} of ${compared} keys (offset/size/mask; first: ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? `; +${bad.length - 3} more` : ''})`);
  }
  if (compared * 2 < rows.length) {
    throw new MapError(`the stored layout of CL-${built} has an entry for only ${compared} of the ${source}'s ${rows.length} field rows for CL-${built}, too few to check it against the ${source}`);
  }
}

// The field rows the published version map carries for `built`, or why it cannot be used. It is used only
// when the release lists it, the Actions bot uploaded it and it is the file in hand; the loader's own signature
// check is not repeated, because the uploader is the trust the record gets too. A reason is not a refusal:
// the caller skips the wider check and goes on with the header's rows.
function publishedRows(text, release, built) {
  if (text === null || text === undefined) return { why: `no ${PUBLISHED.asset} was downloaded from release ${PUBLISHED.release}` };
  try {
    trustedAsset(release, PUBLISHED.release, PUBLISHED.asset, text);
    const lines = text.split('\n');
    if (!/^seq\t/.test(lines[1] ?? '') || !/^sig\t/.test(lines[lines.length - 2] ?? '') || lines[lines.length - 1] !== '') throw new MapError(`${PUBLISHED.asset} has no seq or sig line`);
    const map = parseFeed([lines[0], ...lines.slice(2, -2), ''].join('\n'), PUBLISHED.asset);
    const rows = map.fields.filter((r) => r.cl === built && r.member === null);
    if (!rows.length) return { why: `${PUBLISHED.asset} has no field rows for CL-${built}` };
    return { rows };
  } catch (e) {
    if (!(e instanceof MapError)) throw e;
    return { why: e.message };
  }
}

// The layout report to give field-rows as its base, or a MapError naming what is
// wrong. `release` is the GitHub release object (assets with uploader and size),
// `recordText` the downloaded record (null when it could not be downloaded), `fields` the reflected keys now listed.
// `published` is { text, release } for the published version map (text null when it could not be downloaded);
// without it, or when it cannot be used, only the header's rows check the record and `skipped` says why.
export function referenceFor({ headerText, recordText, release, targetCl, targetSha256, fields, published = null }) {
  const map = parse(headerText, 'the header');
  const built = map.builtCL;
  if (recordText === null || recordText === undefined) {
    const listed = (release?.assets ?? []).some((a) => a?.name === assetName(built));
    throw new MapError(listed
      ? `${assetName(built)} is listed on release ${RELEASE} but could not be downloaded`
      : `no stored layout for CL-${built}, the CL the plugins and the loader were built for (release ${RELEASE} has no ${assetName(built)}); it is stored by a public check of that build while Steam still serves it`);
  }
  checkAsset(release, built, recordText);
  const record = readRecord(recordText, assetName(built));
  if (record.cl !== built) throw new MapError(`the stored layout is for CL-${record.cl}, the header was built for CL-${built}`);
  const row = map.builds.find((b) => b.cl === built);
  if (!row) throw new MapError(`the header has no build row for CL-${built}`);
  const why = buildMismatch(row, { cl: record.cl, source: `steam_build ${record.buildid}`, stamp: record.imageStamp, size: record.imageSize });
  if (why) throw new MapError(`the stored layout of CL-${built} is not the header's build: ${why}`);
  if (Number(targetCl) === record.cl && String(targetSha256 ?? '').toLowerCase() !== record.exeSha256) {
    throw new MapError(`CL-${built} is stored for the exe ${record.exeSha256.slice(0, 12)}, the build scanned now has ${String(targetSha256 ?? '').slice(0, 12) || 'no sha256'}`);
  }
  crossCheck(map.fields.filter((r) => r.cl === built && r.member === null), built, record);
  const wider = published ? publishedRows(published.text, published.release, built) : { why: 'no published version map was given' };
  if (wider.rows) crossCheck(wider.rows, built, record, 'version map');
  const have = new Set(record.keys.map((k) => k.key));
  const missing = [...fields].filter((k) => !have.has(k)).sort(cmp);
  if (missing.length) {
    throw new MapError(`the stored layout of CL-${built} has no entry for ${missing.length} reflected key${missing.length === 1 ? '' : 's'} now listed (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? `, +${missing.length - 5} more` : ''}); a public check of that build, while Steam still serves it, adds them`);
  }
  return { cl: record.cl, keys: record.keys, skipped: wider.why ?? null };
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
      if (!o.existing !== !o.release) throw new MapError('record takes --existing and --release together');
      const existing = o.existing ? { text: read(o.existing), release: json(read(o.release), o.release) } : null;
      const record = buildRecord({
        result: json(read(o.result), o.result), scanner: json(read(o.scanner), o.scanner), layoutText: read(o.layout),
        run: o.run, workflowSha: o.sha, at: o.at ?? new Date().toISOString(), existing,
      });
      if (existing && sameLayout(readRecord(existing.text, 'the stored record'), record)) {
        process.stdout.write(`layout-store: CL-${record.cl} is already stored with these ${record.keys.length} keys; nothing to upload\n`);
        return EXIT_OK;
      }
      writeFileSync(o.out, JSON.stringify(record, null, 2) + '\n');
      process.stdout.write(`layout-store: CL-${record.cl} (build ${record.buildid}), ${record.keys.length} keys\n`);
      return EXIT_OK;
    }
    if (cmd === 'reference') {
      const [header, ...more] = rest;
      const o = args(more);
      for (const f of ['record', 'release', 'cl', 'native-keys', 'layout-keys', 'out']) if (!header || !o[f]) throw new MapError(`reference needs <header> and --${f}`);
      // The published version map and the JSON of the release that lists it, in one directory.
      // Anything unreadable there is the same as absent: the wider check is skipped, never a refusal.
      const soft = (f, parse = (t) => t) => { try { return parse(read(join(o.published, f))); } catch { return null; } };
      const published = o.published ? { text: soft(PUBLISHED.asset), release: soft('release.json', (t) => JSON.parse(t.replace(/^﻿/, ''))) } : null;
      const fields = keysFromCheck(read(o['native-keys']), read(o['layout-keys'])).fields;
      const report = referenceFor({
        headerText: read(header), recordText: readOptional(o.record), release: json(read(o.release), o.release),
        targetCl: Number(o.cl), targetSha256: o.sha256, fields, published,
      });
      if (report.skipped) process.stdout.write(`layout-store: the wider cross-check against the published version map was skipped: ${report.skipped}\n`);
      writeFileSync(o.out, JSON.stringify({ keys: report.keys }, null, 2) + '\n');
      process.stdout.write(`layout-store: reference layout = stored CL-${report.cl}\n`);
      return EXIT_OK;
    }
    process.stderr.write('usage: layout-store.mjs record --out <f> --result <f> --scanner <f> --layout <f> --run <id> --sha <sha> [--at <t>] [--existing <f> --release <f>]\n       layout-store.mjs reference <header> --record <f> --release <f> --cl <CL> --sha256 <hex> --native-keys <f> --layout-keys <f> --out <f> [--published <dir>]\n');
    return EXIT_ERROR;
  } catch (e) {
    if (!(e instanceof MapError) && !(e instanceof ParseError)) throw e;
    process.stderr.write(`${e.message}\n`);
    return cmd === 'record' || cmd === 'reference' ? EXIT_VIOLATION : EXIT_ERROR;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
