#!/usr/bin/env node
// The signed mod index: the loader's mod-index/index.json, carried byte for byte inside the signed envelope.
// The JSON is opaque here: it must be one JSON object, UTF-8 with LF line ends and a final LF.
//
//   format<TAB>1
//   seq<TAB><n>                       added by the signer (ci/vmap-sign.mjs --kind mod-index)
//   kind<TAB>mod-index
//   <the index JSON, byte for byte>
//   sig<TAB><keyId><TAB><base64>      added by the signer
//
//   node ci/mod-index.mjs build <index.json> --out <unsigned.txt>
//   node ci/mod-index.mjs same <published-asset.txt> <index.json>    exit 0 when the asset's body equals index.json
//
// Exit codes: 0 ok (same: equal); 1 same: the bodies differ; 2 usage or input error.

import { readFileSync, writeFileSync } from 'node:fs';
import { isMain } from './layout-diff.mjs';

export const MOD_INDEX_FORMAT_LINE = 'format\t1';
export const MOD_INDEX_KIND_LINE = 'kind\tmod-index';
export const MOD_INDEX_MAX_BYTES = 256 * 1024;

export class ModIndexError extends Error {}
const need = (cond, msg) => { if (!cond) throw new ModIndexError(msg); };

// body: the index JSON as text. Throws ModIndexError when it cannot be carried: a CR, no final LF, a line that would
// pass for the signer's seq or sig line, or JSON that is not one object. The size cap is the whole file's, checked by
// the signer and verifier; here a body that alone is over it is refused too.
export function checkBody(body) {
  need(typeof body === 'string' && body.length > 0, 'the mod index is empty');
  need(!body.includes('\r'), 'the mod index has a CR');
  need(body.endsWith('\n'), 'the mod index does not end in LF');
  need(Buffer.byteLength(body) <= MOD_INDEX_MAX_BYTES, `the mod index is over ${MOD_INDEX_MAX_BYTES} bytes`);
  need(!body.split('\n').some((l) => l.startsWith('sig\t') || l.startsWith('seq\t')), 'the mod index has a line starting with sig or seq and a TAB');
  let json;
  try { json = JSON.parse(body); } catch (e) { throw new ModIndexError(`the mod index is not valid JSON: ${e.message}`); }
  need(json !== null && typeof json === 'object' && !Array.isArray(json), 'the mod index is not a JSON object');
}

// Reads index.json as bytes: a UTF-8 BOM or bytes that are not UTF-8 would not survive a text round trip.
function readIndex(path) {
  const bytes = readFileSync(path);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  need(Buffer.from(text, 'utf8').equals(bytes), `${path} is not plain UTF-8`);
  need(!text.startsWith('﻿'), `${path} starts with a byte order mark`);
  return text;
}

export function buildModIndex(body) {
  checkBody(body);
  const text = `${MOD_INDEX_FORMAT_LINE}\n${MOD_INDEX_KIND_LINE}\n${body}`;
  need(Buffer.byteLength(text) <= MOD_INDEX_MAX_BYTES, `the mod index file is over ${MOD_INDEX_MAX_BYTES} bytes`);
  return text;
}

// text: a signed (or unsigned) mod index file. Returns its body: the lines after the kind line, without the sig line.
export function bodyOf(text) {
  const lines = text.split('\n');
  need(lines.pop() === '', 'the file does not end in LF');
  let i = 1;
  need(lines[0] === MOD_INDEX_FORMAT_LINE, `the first line is not ${JSON.stringify(MOD_INDEX_FORMAT_LINE)}`);
  if (/^seq\t[1-9][0-9]*$/.test(lines[1] ?? '')) i = 2;
  need(lines[i] === MOD_INDEX_KIND_LINE, `the kind line ${JSON.stringify(MOD_INDEX_KIND_LINE)} is missing`);
  const rest = lines.slice(i + 1);
  if (rest.length > 0 && rest[rest.length - 1].startsWith('sig\t')) rest.pop();
  return `${rest.join('\n')}\n`;
}

// The signer's row check, for the unsigned layout (no seq line) and the signed one (seq line second).
// lines: the file split at LF, ending in ''.
export function checkRows(lines) {
  const i = lines.findIndex((l) => l.startsWith('kind\t'));
  need(i === 1 || (i === 2 && /^seq\t/.test(lines[1])), 'the kind line is not where a mod index has it');
  need(lines[i] === MOD_INDEX_KIND_LINE, `the kind line is ${JSON.stringify(lines[i])}, not ${JSON.stringify(MOD_INDEX_KIND_LINE)}`);
  checkBody(`${lines.slice(i + 1).join('\n')}`);
}

export function main(argv) {
  const [cmd, ...a] = argv;
  if (cmd === 'build') {
    need(a.length === 3 && a[1] === '--out', 'usage: mod-index.mjs build <index.json> --out <unsigned.txt>');
    writeFileSync(a[2], buildModIndex(readIndex(a[0])));
    return 0;
  }
  if (cmd === 'same') {
    need(a.length === 2, 'usage: mod-index.mjs same <published-asset.txt> <index.json>');
    return bodyOf(readFileSync(a[0], 'utf8')) === readIndex(a[1]) ? 0 : 1;
  }
  throw new ModIndexError('usage: mod-index.mjs build|same ...');
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`mod-index: ${e.message}\n`);
    process.exitCode = 2;
  }
}
