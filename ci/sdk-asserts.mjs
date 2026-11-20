// Comments out the Dumper-7 asserts that MSVC can never satisfy, in a freshly dumped CppSDK.
//
//   node ci/sdk-asserts.mjs <sdk-dir> [--max <n>]
//
// Dumper-7 writes the members of a struct whose base is a 1-byte empty fragment at offset 0x0000
// and asserts that. MSVC lays them out after the base, so the size and the offset assert of that
// struct fail with C2338 in every file that includes the header. The SDK in the Game-SDK repo has
// those calls commented out by hand (`//DUMPER7_ASSERTS_<Struct>;`); this does the same edit.
//
// The rule is read from the header text: a struct whose comment says its base is 0x0001 bytes
// (`// 0x000B (0x000C - 0x0001)`) and that has a member at 0x0000. Its `DUMPER7_ASSERTS_<Struct>;`
// line gets a `//` in front and nothing else changes (line endings and BOM stay as written).
// Every changed line is printed. More than --max (default 50) changes writes nothing and fails.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX = 50;

const SIZES = /^\/\/ 0x[0-9A-Fa-f]+ \(0x[0-9A-Fa-f]+ - 0x([0-9A-Fa-f]+)\)\r?$/;
const STRUCT = /^struct (F\w+)(?: final)? : public \w+\r?$/;
const MEMBER_AT_0 = /\/\/ 0x0000\(0x[0-9A-Fa-f]+\)/;

// The 1-based lines of `text` to comment out, as [{ line, name }].
export function findUnbuildableAsserts(text) {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const sizes = SIZES.exec(lines[i]);
    if (!sizes || parseInt(sizes[1], 16) !== 1) continue;
    const struct = STRUCT.exec(lines[i + 1]);
    if (!struct) continue;
    let j = i + 2;
    let memberAtZero = false;
    for (; j < lines.length && !/^};\r?$/.test(lines[j]); j++) {
      if (MEMBER_AT_0.test(lines[j])) memberAtZero = true;
    }
    if (!memberAtZero) continue;
    if (lines[j + 1] !== undefined && lines[j + 1].replace(/\r$/, '') === `DUMPER7_ASSERTS_${struct[1]};`) {
      found.push({ line: j + 2, name: struct[1] });
    }
  }
  return found;
}

export function commentOut(text, found) {
  const lines = text.split('\n');
  for (const { line } of found) lines[line - 1] = `//${lines[line - 1]}`;
  return lines.join('\n');
}

// Runs over <sdkDir>/SDK/*_structs.hpp. Returns the changes; writes the files only when all of them
// are within `max`. Throws when there is nothing to scan or too much to change.
export function fixSdk(sdkDir, max = DEFAULT_MAX, write = writeFileSync) {
  const dir = join(sdkDir, 'SDK');
  if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
  const files = readdirSync(dir).filter((f) => f.endsWith('_structs.hpp')).sort();
  if (files.length === 0) throw new Error(`no *_structs.hpp under ${dir}`);
  const edits = [];
  for (const f of files) {
    // latin1 keeps every byte (BOM, CRLF) as it is on the way back out.
    const text = readFileSync(join(dir, f), 'latin1');
    const found = findUnbuildableAsserts(text);
    if (found.length) edits.push({ file: f, text, found });
  }
  const total = edits.reduce((n, e) => n + e.found.length, 0);
  if (total > max) {
    throw new Error(`${total} asserts match, more than the ${max} expected: nothing was changed; the SDK layout may have changed, look at it`);
  }
  for (const e of edits) write(join(dir, e.file), commentOut(e.text, e.found), 'latin1');
  return edits.flatMap((e) => e.found.map((x) => ({ file: `SDK/${e.file}`, ...x })));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const maxAt = args.indexOf('--max');
  const max = maxAt >= 0 ? Number(args.splice(maxAt, 2)[1]) : DEFAULT_MAX;
  if (args.length !== 1 || !Number.isInteger(max) || max < 0) {
    console.error('usage: node ci/sdk-asserts.mjs <sdk-dir> [--max <n>]');
    process.exit(2);
  }
  try {
    const changes = fixSdk(args[0], max);
    for (const c of changes) console.log(`commented out ${c.file}:${c.line} DUMPER7_ASSERTS_${c.name}`);
    console.log(`sdk asserts: ${changes.length} commented out`);
  } catch (e) {
    console.error(`::error title=sdk asserts::${e.message}`);
    process.exit(1);
  }
}
