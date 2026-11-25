#!/usr/bin/env node
// The signed mod index: the loader's mod-index/index.json, carried byte for byte inside the signed envelope.
// The JSON is carried as it is: it must be one JSON array (the loader's index.json is an array) that passes the entry checks below, UTF-8 with LF line ends and a final LF.
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
//   node ci/mod-index.mjs loader-head <sha>                          exit 0 only when <sha> is the tip of the loader's main right now
//
// loader-ref is the gate on what gets signed. <ref> is main, a release branch (release/next, release/<x.y.z>) or a full
// commit id, and the commit is printed only when the GitHub API shows that one of those branches of the loader
// repository reaches it. GitHub serves the commits of forks and pull requests under the parent repository's name, and
// the compare API resolves them too, so nothing but a branch tip read from the repository's own refs counts. Tags and
// every other branch are refused, and so is the run when the API does not answer. GH_TOKEN is used when set.
//
// loader-head is the extra gate on a live signature: the commit must be where main is now, not only reachable from it.
//
// The index is checked on every build, sign and verify (checkBody): a JSON array of at most 200 entries. An entry that
// carries an install key (download_url, download_sha256, download_size, install_files, update_manifest_url) needs a
// download_url that is a .dll asset of a GitHub release (https://github.com/<owner>/<repo>/releases/download/<tag>/<name>.dll)
// of the repository its own page_url names, a download_sha256 of exactly 64 lowercase hex characters and a download_size
// from 1 byte to 32 MB written as plain digits. The loader reads these keys with its own text scanner (first occurrence,
// at any depth, by raw text), so an index is refused where, in any entry, one of them (or page_url) is nested, appears
// twice, or where any key is written with a backslash escape (scanEntries, per entry). None of this depends on the
// loader's builder, so a loader commit without it does not weaken the check.
//
// An entry may also carry a thumbnail, as three flat keys that come all or none: thumbnail_url
// (https://raw.githubusercontent.com/<owner>/<repo>/<40 lowercase hex commit>/images/thumbnail.png, of the repository
// page_url names), thumbnail_sha256 (64 lowercase hex) and thumbnail_size (plain digits, 1 to 512 KiB). They are read
// under the same raw-text rules as the install keys.
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
  const list = await get(`repos/${LOADER_REPO}/git/matching-refs/heads/release/?per_page=100`);
  need(Array.isArray(list) && list.length < 100, 'GitHub API did not list the release branches, or lists more than one page of them');
  return list.flatMap((entry) => {
    const name = String(entry?.ref).replace(/^refs\/heads\//, '');
    return SIGNING_BRANCH.test(name) ? [tipOf(entry, name)] : [];
  });
}

const mainTip = async (get) => tipOf(await get(`repos/${LOADER_REPO}/git/ref/heads/main`), 'main');

// Live signing reads the loader's main as it is now: ok only when sha is the tip of main at this moment.
export async function checkLoaderHead(sha, get) {
  need(typeof sha === 'string' && FULL_SHA.test(sha), `loader-head takes a full commit id, not ${JSON.stringify(sha)}`);
  const tip = await mainTip(get);
  need(tip.sha === sha, `the commit ${sha} is not the tip of main of ${LOADER_REPO} (main is at ${tip.sha}); a live signature takes the current main only`);
  return tip.sha;
}

// Returns { sha, branch }: the full commit id to read all loader content by, and the branch that reaches it.
export async function resolveLoaderRef(ref, get) {
  const isSha = typeof ref === 'string' && FULL_SHA.test(ref);
  need(isSha || (typeof ref === 'string' && SIGNING_BRANCH.test(ref)),
    `loader_ref ${JSON.stringify(ref)} is refused: it is main, release/next, release/<x.y.z> or a full commit id of ${LOADER_REPO}`);
  if (!isSha) {
    const tip = ref === 'main' ? await mainTip(get) : (await releaseTips(get)).find((t) => t.name === ref);
    need(tip, `${LOADER_REPO} has no branch ${ref}`);
    return { sha: tip.sha, branch: tip.name };
  }
  // ref is an ancestor of a tip only when it is the merge base of the two and the tip is not behind it.
  const reaches = async (tip) => {
    if (tip.sha === ref) return true;
    const c = await get(`repos/${LOADER_REPO}/compare/${ref}...${tip.sha}?per_page=1`);
    return (c?.status === 'ahead' || c?.status === 'identical') && c.behind_by === 0 && c.merge_base_commit?.sha === ref;
  };
  const main = await mainTip(get);
  if (await reaches(main)) return { sha: ref, branch: main.name };
  for (const tip of await releaseTips(get)) if (await reaches(tip)) return { sha: ref, branch: tip.name };
  throw new ModIndexError(`the commit ${ref} is refused: neither main nor a release branch of ${LOADER_REPO} reaches it`);
}

export const MAX_ENTRIES = 200;
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const MAX_URL_LEN = 200;
const INSTALL_KEYS = ['download_url', 'download_sha256', 'download_size', 'install_files', 'update_manifest_url'];
const THUMBNAIL_KEYS = ['thumbnail_url', 'thumbnail_sha256', 'thumbnail_size'];
const MAX_THUMBNAIL_BYTES = 512 * 1024;
const SCANNED_KEYS = ['page_url', ...INSTALL_KEYS, ...THUMBNAIL_KEYS];

// ASCII letters, digits, '_', '.', '-', with no "..".
const plainSegment = (s) => /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && !s.includes('..');
const lowerAscii = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const sameName = (a, b) => lowerAscii(a) === lowerAscii(b);

// https://github.com/<owner>/<repo>/releases/download/<tag>/<name>.dll as [owner, repo], or null. Nothing else passes:
// no other scheme or host, no user info, port, query, fragment, backslash, "..", or a path that is not a release download.
function releaseAssetRepo(url) {
  const start = 'https://github.com/';
  if (typeof url !== 'string' || url.length > MAX_URL_LEN || !url.startsWith(start)) return null;
  const p = url.slice(start.length).split('/');
  if (p.length !== 6 || p[2] !== 'releases' || p[3] !== 'download' || !p.every(plainSegment) || !/\.dll$/i.test(p[5]) || p[5].length <= 4) return null;
  return [p[0], p[1]];
}

// Reads the index text the way the loader's JsonFindValue and JsonSplitObjectArray do (a string token followed by a
// colon is a key, the raw text between its quotes is compared) and returns, for each element of the top-level array,
// how often each of `keys` is a direct member of it and the raw text of its value. It throws on what the loader could
// read differently from JSON.parse: a key written with a backslash escape (JSON.parse decodes it, the loader compares
// the raw text), one of `keys` anywhere but directly in an entry (the loader finds a key at any depth) or twice in one
// entry (the loader takes the first, JSON.parse the last). The text must already be valid JSON.
function scanEntries(text, keys, label) {
  const entries = [];
  const at = (n) => entries[n] ??= { counts: Object.fromEntries(keys.map((k) => [k, 0])), raw: {} };
  let depth = 0;
  let n = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 1) n++;
    if (c !== '"') { i++; continue; }
    const start = ++i;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) break;
    const end = i++;
    let next = i;
    while (next < text.length && /\s/.test(text[next])) next++;
    if (text[next] !== ':') continue;
    const key = text.slice(start, end);
    need(!key.includes('\\'), `the mod index has a key written with a backslash escape (${JSON.stringify(key)}); the loader reads keys as raw text`);
    if (!keys.includes(key)) continue;
    const who = label(n);
    need(depth === 2, `${who}: the key ${key} must be a direct member of the entry, not nested`);
    const e = at(n);
    need(++e.counts[key] === 1, `${who}: the key ${key} appears more than once`);
    next++;
    while (next < text.length && /\s/.test(text[next])) next++;
    if (key === 'download_size' || key === 'thumbnail_size') e.raw[key] = /^[^\s,}\]]*/.exec(text.slice(next))[0];
  }
  return entries;
}

// Whether page_url is https://github.com/<owner>/<repo>[/plain segments] for [owner, repo], case aside.
function pageNames(pageUrl, [owner, repo]) {
  const page = typeof pageUrl === 'string' ? pageUrl.split('/') : [];
  return page.length >= 5 && page[0] === 'https:' && page[1] === '' && sameName(page[2], 'github.com') && sameName(page[3], owner) && sameName(page[4], repo) && page.slice(5, page.at(-1) === '' ? -1 : undefined).every(plainSegment);
}

// https://raw.githubusercontent.com/<owner>/<repo>/<40 lowercase hex commit>/images/thumbnail.png as [owner, repo], or null.
function thumbnailRepo(url) {
  const start = 'https://raw.githubusercontent.com/';
  if (typeof url !== 'string' || url.length > MAX_URL_LEN || !url.startsWith(start)) return null;
  const p = url.slice(start.length).split('/');
  if (p.length !== 5 || !p.slice(0, 2).every(plainSegment) || !/^[0-9a-f]{40}$/.test(p[2]) || p[3] !== 'images' || p[4] !== 'thumbnail.png') return null;
  return [p[0], p[1]];
}

// The three thumbnail keys come all or none.
function checkThumbnail(e, who, raw) {
  const missing = THUMBNAIL_KEYS.filter((k) => !Object.hasOwn(e, k));
  if (missing.length === THUMBNAIL_KEYS.length) return;
  need(missing.length === 0, `${who}: the thumbnail keys come all or none, missing ${missing.join(', ')}`);
  const repo = thumbnailRepo(e.thumbnail_url);
  need(repo, `${who}: thumbnail_url must be https://raw.githubusercontent.com/<owner>/<repo>/<40 lowercase hex commit>/images/thumbnail.png`);
  need(pageNames(e.page_url, repo), `${who}: thumbnail_url must belong to the repository page_url names`);
  need(typeof e.thumbnail_sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.thumbnail_sha256), `${who}: thumbnail_sha256 must be 64 lowercase hex characters`);
  need(/^[1-9][0-9]*$/.test(raw.thumbnail_size ?? '') && Number.isSafeInteger(e.thumbnail_size) && e.thumbnail_size <= MAX_THUMBNAIL_BYTES,
    `${who}: thumbnail_size must be a whole number from 1 to ${MAX_THUMBNAIL_BYTES}, written as plain digits`);
}

function checkEntry(e, who, raw) {
  need(e !== null && typeof e === 'object' && !Array.isArray(e), `${who} is not an object`);
  if (INSTALL_KEYS.some((k) => Object.hasOwn(e, k))) checkInstall(e, who, raw);
  checkThumbnail(e, who, raw);
}

function checkInstall(e, who, raw) {
  const asset = releaseAssetRepo(e.download_url);
  need(asset, `${who}: download_url must be https://github.com/<owner>/<repo>/releases/download/<tag>/<name>.dll`);
  need(pageNames(e.page_url, asset), `${who}: download_url must belong to the repository page_url names`);
  need(typeof e.download_sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.download_sha256), `${who}: download_sha256 must be 64 lowercase hex characters`);
  // The raw text must be plain digits: the loader reads 3.2e7 as 3, JSON.parse as 32000000.
  need(/^[1-9][0-9]*$/.test(raw.download_size ?? '') && Number.isSafeInteger(e.download_size) && e.download_size <= MAX_DOWNLOAD_BYTES,
    `${who}: download_size must be a whole number from 1 to ${MAX_DOWNLOAD_BYTES}, written as plain digits`);
}

function checkEntries(body, list) {
  need(Array.isArray(list), 'the mod index is not a JSON array');
  need(list.length <= MAX_ENTRIES, `the mod index has ${list.length} entries (at most ${MAX_ENTRIES})`);
  const label = (i) => `entry ${i + 1}${typeof list[i]?.id === 'string' && list[i].id !== '' ? ` (${list[i].id})` : ''}`;
  // First, that no key is read from another place than the checks below read it from, entry by entry.
  const scanned = scanEntries(body, SCANNED_KEYS, label);
  list.forEach((e, i) => {
    const s = scanned[i] ?? { counts: {}, raw: {} };
    if (e !== null && typeof e === 'object') for (const k of SCANNED_KEYS) need((s.counts[k] ?? 0) === (Object.hasOwn(e, k) ? 1 : 0), `${label(i)}: the key ${k} is not read the same way by the loader`);
    checkEntry(e, label(i), s.raw);
  });
}

// body: the index JSON as text. Throws ModIndexError when it cannot be carried: a CR, no final LF, a line that would
// pass for the signer's seq or sig line, JSON that is not one array, or an entry that fails the checks above. The size
// cap is the whole file's, checked by the signer and verifier; here a body that alone is over it is refused too.
export function checkBody(body) {
  need(typeof body === 'string' && body.length > 0, 'the mod index is empty');
  need(!body.includes('\r'), 'the mod index has a CR');
  need(body.endsWith('\n'), 'the mod index does not end in LF');
  need(Buffer.byteLength(body) <= MOD_INDEX_MAX_BYTES, `the mod index is over ${MOD_INDEX_MAX_BYTES} bytes`);
  need(!body.split('\n').some((l) => l.startsWith('sig\t') || l.startsWith('seq\t')), 'the mod index has a line starting with sig or seq and a TAB');
  let json;
  try { json = JSON.parse(body); } catch (e) { throw new ModIndexError(`the mod index is not valid JSON: ${e.message}`); }
  checkEntries(body, json);
}

// Reads index.json as bytes: a UTF-8 BOM or bytes that are not UTF-8 would not survive a text round trip.
export function readIndex(path) {
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
  if (cmd === 'loader-head') {
    need(a.length === 1, 'usage: mod-index.mjs loader-head <sha>');
    return checkLoaderHead(a[0], githubApi(process.env.GH_TOKEN)).then((sha) => {
      process.stderr.write(`mod-index: the loader commit ${sha} is the tip of main of ${LOADER_REPO}\n`);
      return 0;
    });
  }
  throw new ModIndexError('usage: mod-index.mjs build|same|loader-ref|loader-head ...');
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
