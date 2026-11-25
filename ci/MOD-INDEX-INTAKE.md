# Mod index intake check

`ci/mod-index-intake.mjs` checks a pull request that adds or changes a plugin entry in the loader repo's `mod-index/index.json`. The loader repo's `mod-index-check.yml` calls it.

```
node ci/mod-index-intake.mjs --index <pr index.json> [--base <base index.json>] [--summary <file>]
```

- With `--base`, only entries that are new or changed against it are checked. Without it, all entries are.
- `--summary <file>` appends the result as GitHub step-summary markdown.
- Exit 0: nothing failed. Exit 1: at least one FAIL. Exit 2: wrong arguments or an unreadable file.

## What it checks

1. The whole index passes the rules of `ci/mod-index.mjs` (`checkBody`). That includes: `page_url` and `download_url` name the same repository. A failure here is one FAIL line that names the entry.
2. The release asset at `download_url` downloads. Only `https://github.com/...` is followed first; redirects may go only to `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`, at most 5 times. No cookies, no login. At most `download_size` + 1 byte is read, with a 60 second limit.
3. The size and the sha256 equal `download_size` and `download_sha256`.
4. The bytes are an x64 PE DLL (machine `0x8664`, DLL flag) whose export table has `GetPluginInfo`, `PluginInit` and `PluginShutdown`. `OnPluginLoadHooks`, `GetPluginWireInfo` and `PluginSetHostInfo` are listed when present.
5. Best effort, warning only: if `GetPluginInfo` is exactly `lea rax,[rip+disp32]; ret`, the check reads the declared interface version, target, name and version from the table it returns. If it looks like anything else, the result is the warning "interface not read" and the entry still passes.

## Static only

The DLL is downloaded as bytes and parsed as data. It is never loaded, run or handed to another program, so a hostile DLL cannot execute anything. Every read of the file is bounds-checked and a malformed file is a FAIL. Run it from a plain `pull_request` job with a read-only token and no secrets, never from `pull_request_target`. The job file is drafted in `drafts/agents/mod-index-intake-workflow-draft.yml` of the contribution workspace.

Tests: `node --test ci/mod-index-intake.test.mjs`. They use PE files built in the test and an injected fetch, so they need no network.
