#!/usr/bin/env node
// Says whether the feed on the loader's Latest release lags the last signed one.
//
//   node ci/vmap-watchdog.mjs check --signed <file> --published <file|-> [--max-lag <seconds>]
//
// Both files are signed feeds; only their `seq` line (the second line, the UTC
// second of signing) is read, because the publish workflow does the
// verifying and this is an alarm. `--published -` means the release has no feed
// at all. The default allowed lag is 2 h: the publish workflow runs every 15
// minutes, so more means it has stopped (GitHub switches off schedules in a
// public repository after 60 days without activity).
//
// Exit codes: 0 up to date; 3 lagging (the reason is on stdout); 2 usage or input error.

import { readFileSync } from 'node:fs';
import { isMain } from './layout-diff.mjs';

export const EXIT_OK = 0;
export const EXIT_LAGGING = 3;
export const EXIT_ERROR = 2;
export const MAX_LAG_SECONDS = 2 * 60 * 60;

export function seqOf(text, where) {
  const m = /^format\t1\nseq\t([1-9][0-9]*)\n/.exec(text);
  if (!m) throw new Error(`${where}: not a signed feed (no format line and seq line)`);
  return Number(m[1]);
}

// published: the seq on Latest, or null when Latest holds no feed.
export function lag(signed, published, maxLag = MAX_LAG_SECONDS) {
  if (published === null) return { lagging: true, message: `Latest holds no feed; the last signed seq is ${signed}` };
  const behind = signed - published;
  if (behind > maxLag) return { lagging: true, message: `Latest is ${behind} s behind the last signed feed (seq ${published} against ${signed}; allowed ${maxLag})` };
  return { lagging: false, message: `Latest is current (seq ${published}, last signed ${signed})` };
}

export function main(argv) {
  const [cmd, ...args] = argv;
  const opt = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--signed', '--published', '--max-lag'].includes(args[i]) || i + 1 >= args.length) throw new Error(`unknown or incomplete option ${args[i]}`);
    opt[args[i].slice(2)] = args[i + 1];
  }
  if (cmd !== 'check' || !opt.signed || !opt.published) throw new Error('usage: vmap-watchdog.mjs check --signed <file> --published <file|-> [--max-lag <seconds>]');
  if (opt['max-lag'] !== undefined && !/^\d+$/.test(opt['max-lag'])) throw new Error('--max-lag is a non-negative integer');
  const signed = seqOf(readFileSync(opt.signed, 'latin1'), opt.signed);
  const published = opt.published === '-' ? null : seqOf(readFileSync(opt.published, 'latin1'), opt.published);
  const r = lag(signed, published, opt['max-lag'] === undefined ? undefined : Number(opt['max-lag']));
  process.stdout.write(`${r.message}\n`);
  return r.lagging ? EXIT_LAGGING : EXIT_OK;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`vmap-watchdog: ${e.message}\n`);
    process.exitCode = EXIT_ERROR;
  }
}
