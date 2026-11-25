#!/usr/bin/env node
// The signed mod index: the loader's mod-index/index.json, carried byte for byte inside the signed envelope.
// The JSON is opaque here: it must be one JSON object or array (the loader's index.json is an array), UTF-8 with LF line ends and a final LF.
//
//   format<TAB>1
//   seq<TAB><n>                       added by the signer (ci/vmap-sign.mjs --kind mod-index)
//   kind<TAB>mod-index
//   <the index JSON, byte for byte>
//   sig<TAB><keyId><TAB><base64>      added by the signer
//
//   node ci/mod-index.mjs build <index.json> --out <unsigned.txt>
//   node ci/mod-index.mjs same <published-asset.txt> <index.json>    exit 0 when the asset's body equals index.json
//   node ci/mod-index.mjs loader-ref <ref>                           print the loader commit the signing path may read
//
// loader-ref is the gate on what gets signed. <ref> is main, a release branch (release/next, release/<x.y.z>) or a full
// commit id, and the commit is printed only when the GitHub API shows that one of those branches of the loader
// repository reaches it. GitHub serves the commits of forks and pull requests under the parent repository's name, and
// the compare API resolves them too, so nothing but a branch tip read from the repository's own refs counts. Tags and
// every other branch are refused, and so is the run when the API does not answer. GH_TOKEN is used when set.
//
// same compares bodies only; it does not verify the signature, so callers run vmap-sign.mjs verify first.
// Exit codes: 0 ok (same: equal); 1 same: the bodies differ; 2 usage or input error, or a refused loader ref.

import { readFileSync, writeFileSync } from 'node:fs';
import { isMain } from './layout-diff.mjs';

export const MOD_INDEX_FORMAT_LINE = 'format\t1';
export const MOD_INDEX_KIND_LINE = 'kind\tmod-index';
export const MOD_INDEX_MAX_BYTES = 256 * 1024;

export class ModIndexError extends Error {}
const need = (cond, msg) => { if (!cond) throw new ModIndexError(msg); };

export const LOADER_REPO = 'AlienXAXS/StarRupture-ModLoader';
// Exact names. Another branch under release/ is a work branch and does not count.
export const SIGNING_BRANCH = /^(main|release\/next|release\/[0-9]+\.[0-9]+\.[0-9]+)$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

// get(path) answers one GitHub REST call with its parsed JSON and throws on anything but a 200.
export function githubApi(token, fetchFn = fetch) {
  return async (path) => {
    let res;
    try {
      res = await fetchFn(`https://api.github.com/${path}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'sr-mod-index', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) { throw new ModIndexError(`GitHub API ${path} failed: ${e.message}`); }
    need(res.status === 200, `GitHub API ${path} answered HTTP ${res.status}`);
    try { return await res.json(); } catch (e) { throw new ModIndexError(`GitHub API ${path} did not answer JSON: ${e.message}`); }
  };
}

// The tip of one entry of the git refs API.
function tipOf(entry, name) {
  need(entry?.ref === `refs/heads/${name}` && entry.object?.type === 'commit' && FULL_SHA.test(entry.object.sha), `GitHub API did not give the tip of the branch ${name}`);
  return { name, sha: entry.object.sha };
}

async function releaseTips(get) {
  const list = await get(`repos/${LOADER_REPO}/git/matching-refs/heads/release/`);
  need(Array.isArray(list), 'GitHub API did not list the release branches');
  return list.flatMap((entry) => {
    const name = String(entry?.ref).replace(/^refs\/heads\//, '');
    return SIGNING_BRANCH.test(name) ? [tipOf(entry, name)] : [];
  });
}

// Returns { sha, branch }: the full commit id to read all loader content by, and the branch that reaches it.
export async function resolveLoaderRef(ref, get) {
  const isSha = typeof ref === 'string' && FULL_SHA.test(ref);
  need(isSha || (typeof ref === 'string' && SIGNING_BRANCH.test(ref)),
    `loader_ref ${JSON.stringify(ref)} is refused: it is main, release/next, release/<x.y.z> or a full commit id of ${LOADER_REPO}`);
  const mainTip = async () => tipOf(await get(`repos/${LOADER_REPO}/git/ref/heads/main`), 'main');
  if (!isSha) {
    const tip = ref === 'main' ? await mainTip() : (await releaseTips(get)).find((t) => t.name === ref);
    need(tip, `${LOADER_REPO} has no branch ${ref}`);
    return { sha: tip.sha, branch: tip.name };
  }
  // ref is an ancestor of a tip only when it is the merge base of the two and the tip is not behind it.
  const reaches = async (tip) => {
    if (tip.sha === ref) return true;
    const c = await get(`repos/${LOADER_REPO}/compare/${ref}...${tip.sha}?per_page=1`);
    return (c?.status === 'ahead' || c?.status === 'identical') && c.behind_by === 0 && c.merge_base_commit?.sha === ref;
  };
  const main = await mainTip();
  if (await reaches(main)) return { sha: ref, branch: main.name };
  for (const tip of await releaseTips(get)) if (await reaches(tip)) return { sha: ref, branch: tip.name };
  throw new ModIndexError(`the commit ${ref} is refused: neither main nor a release branch of ${LOADER_REPO} reaches it`);
}

// body: the index JSON as text. Throws ModIndexError when it cannot be carried: a CR, no final LF, a line that would
// pass for the signer's seq or sig line, or JSON that is not one object or array. The size cap is the whole file's, checked by
// the signer and verifier; here a body that alone is over it is refused too.
export function checkBody(body) {
  need(typeof body === 'string' && body.length > 0, 'the mod index is empty');
  need(!body.includes('\r'), 'the mod index has a CR');
  need(body.endsWith('\n'), 'the mod index does not end in LF');
  need(Buffer.byteLength(body) <= MOD_INDEX_MAX_BYTES, `the mod index is over ${MOD_INDEX_MAX_BYTES} bytes`);
  need(!body.split('\n').some((l) => l.startsWith('sig\t') || l.startsWith('seq\t')), 'the mod index has a line starting with sig or seq and a TAB');
  let json;
  try { json = JSON.parse(body); } catch (e) { throw new ModIndexError(`the mod index is not valid JSON: ${e.message}`); }
  need(json !== null && typeof json === 'object', 'the mod index is not a JSON object or array');
}

// Reads index.json as bytes: a UTF-8 BOM or bytes that are not UTF-8 would not survive a text round trip.
function readIndex(path) {
  const bytes = readFileSync(path);
  need(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${path} starts with a byte order mark`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  need(Buffer.from(text, 'utf8').equals(bytes), `${path} is not plain UTF-8`);
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
  if (cmd === 'loader-ref') {
    need(a.length === 1, 'usage: mod-index.mjs loader-ref <ref>');
    return resolveLoaderRef(a[0], githubApi(process.env.GH_TOKEN)).then(({ sha, branch }) => {
      process.stderr.write(`mod-index: the loader commit ${sha} is on the branch ${branch} of ${LOADER_REPO}\n`);
      process.stdout.write(`${sha}\n`);
      return 0;
    });
  }
  throw new ModIndexError('usage: mod-index.mjs build|same|loader-ref ...');
}

if (isMain(import.meta.url)) {
  // No top-level await: vmap-sign.mjs imports this module.
  new Promise((done) => done(main(process.argv.slice(2)))).then(
    (code) => { process.exitCode = code; },
    (e) => {
      process.stderr.write(`mod-index: ${e.message}\n`);
      process.exitCode = 2;
    },
  );
}
