// Test that no workflow uses a status function in an env: value (or any key but if:).
//
//   node --test ci/workflow-status-functions.test.mjs
//
// GitHub allows cancelled(), always(), failure() and success() only in if: conditions.
// Anywhere else the workflow file is invalid and its runs fail with no jobs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const statusCall = /\b(?:cancelled|always|failure|success)\(\)/;
const keyed = /^\s*(?:-\s+)?([\w-]+):\s*(.*)$/;

test('no workflow uses a status function outside an if: condition', () => {
  const bad = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
      const m = keyed.exec(line);
      if (m && m[1] !== 'if' && m[2].includes('${{') && statusCall.test(m[2])) bad.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});
