# Mod index intake check

`ci/mod-index-intake.mjs` checks a pull request that adds or changes a plugin entry in the loader repo's `mod-index/index.json`. It is meant to run from a pull-request job in the loader repo's `mod-index-check.yml` (see the job below).

```
node ci/mod-index-intake.mjs --index <pr index.json> [--base <base index.json>] [--summary <file>]
```

- With `--base`, only entries that are new or changed against it are checked. Without it, all entries are.
- `--summary <file>` appends the result as GitHub step-summary markdown.
- Exit 0: nothing failed. Exit 1: at least one FAIL. A missing, byte-order-marked or non-UTF-8 index is also one FAIL line (exit 1). Exit 2: wrong arguments.

## What it checks

1. The whole index passes the rules of `ci/mod-index.mjs` (`checkBody`). That includes: `page_url` and `download_url` name the same repository. A failure here is one FAIL line that names the entry.
2. The release asset at `download_url` downloads. Only `https://github.com/...` is followed first; redirects may go only to `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`, at most 5 times. No cookies, no login. At most `download_size` + 1 byte is read, with a 60 second limit.
3. The size and the sha256 equal `download_size` and `download_sha256`.
4. The bytes are an x64 PE DLL (machine `0x8664`, DLL flag) whose export table has `GetPluginInfo`, `PluginInit` and `PluginShutdown`. `OnPluginLoadHooks`, `GetPluginWireInfo` and `PluginSetHostInfo` are listed when present.
5. Best effort, warning only: if `GetPluginInfo` is exactly `lea rax,[rip+disp32]; ret`, the check reads the declared interface version, target, name and version from the table it returns. If it looks like anything else, the result is the warning "interface not read" and the entry still passes.

## Static only

The DLL is downloaded as bytes and parsed as data. It is never loaded, run or handed to another program, so a hostile DLL cannot execute anything. Every read of the file is bounds-checked and a malformed file is a FAIL. Run it from a plain `pull_request` job with a read-only token and no secrets, never from `pull_request_target`.

Tests: `node --test ci/mod-index-intake.test.mjs`. They use PE files built in the test and an injected fetch, so they need no network.

## The loader job

The job the loader repo's `mod-index-check.yml` adds (not in place yet). It runs on `pull_request` only, with a read-only token and no secrets. `starrupture-ci` is public, so the default token can check it out. Replace the placeholder with the full commit id of this script and move it forward only by a reviewed change.

```yaml
name: mod index intake

on:
  pull_request:
    paths: ['mod-index/index.json']

permissions:
  contents: read

jobs:
  intake:
    name: plugin entries
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Check out the pull request
        uses: actions/checkout@v7.0.1
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          path: pr
          persist-credentials: false
      - name: Check out the base index
        uses: actions/checkout@v7.0.1
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: base
          sparse-checkout: mod-index
          persist-credentials: false
      - name: Check out the intake script
        uses: actions/checkout@v7.0.1
        with:
          repository: msantoro12/starrupture-ci
          ref: <full 40-character commit id>
          path: ci-tools
          persist-credentials: false
      - uses: actions/setup-node@v7.1.0
        with:
          node-version: 26
      - name: Check the new and changed entries
        run: |
          base_args=()
          if [ -f base/mod-index/index.json ]; then base_args=(--base base/mod-index/index.json); fi
          node ci-tools/ci/mod-index-intake.mjs --index pr/mod-index/index.json "${base_args[@]}" --summary "$GITHUB_STEP_SUMMARY"
```
