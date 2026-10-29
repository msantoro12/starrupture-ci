#!/usr/bin/env node
// Download the full Dumper-7 Assertions.inl files behind the layout-diff
// fixtures (about 270 MB, too big to commit) from AlienXAXS/StarRupture-Game-SDK.
//
//   node ci/fetch-layout-fixtures.mjs [--out <dir>]      default: out/layout-full
//
// Needs the GitHub CLI (`gh`), logged in or with GH_TOKEN set. Files already
// present with the expected sha256 are kept. Then:
//
//   LAYOUT_FULL_DIR=out/layout-full node --test ci/layout-diff.test.mjs

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The four builds: CL-125368, CL-125897, CL-126119, CL-127004.
export const COMMITS = {
  abd0ebd: { sha: 'abd0ebd6ff10c99668127af250caa6d2b01d329b', cl: 125368 },
  f3eb06b: { sha: 'f3eb06bd1189a42dfa202ce9c36a0c4f302ae453', cl: 125897 },
  '0b3c9e6': { sha: '0b3c9e6b9e32216a74d8d0896f4b1db302a2935c', cl: 126119 },
  '659656c': { sha: '659656c002e883312db46433c7b388a1184d6ad9', cl: 127004 },
};

export const SHA256 = {
  'Client-abd0ebd.inl': 'cb7d4404e6ff5dd746966508f77279f01073380ddd56527be2baad90605fd8f6',
  'Client-f3eb06b.inl': '261faf1ee3d552c4739ab184548af42dd2c7986189abc40ae7acd69643671760',
  'Client-0b3c9e6.inl': '3887861caca162ac1074c2ce3d652a5bcf4f28fe3f7e006b92b45fe042f4ef93',
  'Client-659656c.inl': 'db156d870e58d7c0952db6e4d9b4c60b61958fc9cc205587c982a3daf783fb48',
  'Server-abd0ebd.inl': '14cfa78fb9937bc378080267ae24d59a47b27db45055cb9786c859bce66c3806',
  'Server-f3eb06b.inl': 'fe13d62c78a3dd8adef3ba1a8e214b8483ae451d9dc017b58dd05de9bf4e7be5',
  'Server-0b3c9e6.inl': 'bce75503307aefaadca721228290bf5055f8c21bfb1a8fa87fac178325f95cc2',
  'Server-659656c.inl': 'd54887622782311623000e9b8e61adea4bbb69544bddc9ae19ac7b5146281458',
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function main(argv) {
  const i = argv.indexOf('--out');
  const out = i >= 0 ? argv[i + 1] : 'out/layout-full';
  mkdirSync(out, { recursive: true });
  for (const [short, { sha }] of Object.entries(COMMITS)) {
    for (const side of ['Client', 'Server']) {
      const name = `${side}-${short}.inl`;
      const dest = join(out, name);
      if (existsSync(dest) && sha256(readFileSync(dest)) === SHA256[name]) continue;
      const buf = execFileSync(
        'gh',
        ['api', '-H', 'Accept: application/vnd.github.raw', `repos/AlienXAXS/StarRupture-Game-SDK/contents/${side}/Assertions.inl?ref=${sha}`],
        { maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      );
      if (sha256(buf) !== SHA256[name]) throw new Error(`${name}: sha256 mismatch after download`);
      writeFileSync(dest, buf);
      console.log(`fetched ${name} (${(buf.length / 1048576).toFixed(1)} MB)`);
    }
  }
  console.log(`layout fixtures ready in ${out}`);
}

try {
  if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
} catch (e) {
  console.error(`fetch-layout-fixtures: ${e.message}`);
  process.exitCode = 1;
}
