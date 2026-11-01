# Map mode

The whole flow, from a new Steam build to a player's loader, is in the loader repository's
[VersionMap.md](https://github.com/AlienXAXS/StarRupture-ModLoader/blob/main/VersionMap.md#how-a-build-reaches-players-ci). This file is the reference for the tools.

Map mode puts what a game update changes into the loader's version map
(`version_map.generated.h`, format in `VERSION-MAP.md`), instead of into each
plugin's source. A plugin repo gets no commit for a game update; the loader
fork's `auto/update-<CL>` branch gets one.

## Step 26: the loader fork's deploy key and ruleset (a gate, not done here)

The push of `auto/update-<CL>` to the loader fork needs a credential. That is
repo-admin setup with the owner's `gh` auth, so it is a checklist, not code. It
follows the procedure the plugin forks use (`drafts/ci-auto-apply-detail.md`,
"Deploy keys"):

1. Make an ed25519 key pair. Never print or log the private half.
2. Add the public half to the loader fork as a write deploy key titled
   `starrupture-ci auto-apply`.
3. Store the private half as an environment secret in `fork-push` on
   msantoro12/starrupture-ci (for example `SR_DEPLOYKEY_MODLOADER`), from stdin,
   and in the Bitwarden Secrets Manager project `dev`.
4. Add two rulesets to the loader fork, as on the plugin forks:
   "auto-apply deploy keys: auto/** only" (a deploy key may write `auto/**`
   only) and "auto-apply deploy keys: no tags". The admin role bypasses them.
5. Name the secret in the workflow's push job (the job holds the key and no game
   files, as on the plugin forks).

Accept: a push to `auto/test` with the key succeeds, and a push to any other ref
is rejected. Delete `auto/test` afterwards.

Nothing in this repo refers to the key yet. Until step 5 is done, map mode runs
and writes the header on the runner, and the push job has nothing to push with.

## Step 27: `map-mode.mjs write`

```
node ci/map-mode.mjs write <header> --input <observations.json> [--keys <keys.txt>]... [--report <file>]
```

`<header>` is the loader's `version_map.generated.h`; it is rewritten in place.
`--keys` takes the tracked components' key lists (`VERSION-MAP.md`, "The coverage
rule"), once per component; the written map must satisfy the rule over their
union. `--report` writes `{ written, added, pruned, problems, notes, patches }`.
Exit 0 written, 3 refused (the header is untouched, every reason is on stderr),
2 usage or malformed input.

### The input

One JSON file per new build, which the runner assembles from the harness
(`sr-aobscan`):

```json
{
  "schema": 1,
  "cl": 128786,
  "build": { "stamp": "0x6A1B2C3D", "size": "0x0A412000", "source": "public_test_branch 26271156" },
  "components": [
    {
      "owner": "ModLoader",
      "tracked": true,
      "releases": [
        {
          "tag": "v1.22.1",
          "rank": "current",
          "fpAware": true,
          "rows": [
            {
              "key": "ModLoader/GObjects (GUObjectArray.ObjObjects)",
              "kind": "any",
              "fp": "0x1C4D2E3F",
              "result": "OK",
              "required": true,
              "rva": "0x8E2D3B0",
              "symbolRva": null,
              "pattern": "48 8B 05 ?? ?? ?? ?? 48 8B 0C C8 48 8D 04 D1",
              "resultOffset": 0,
              "followRel32At": -1,
              "followRipDispAt": 0,
              "siteArithmetic": 0,
              "suggest": null
            }
          ]
        }
      ]
    }
  ]
}
```

- `owner` is the plugin's `PluginInfo` name, or `ModLoader`. A component with
  `"tracked": false` (MiniMap) writes no rows; its failing rows come back as
  `patches`, for the pattern path (`apply-proposals.mjs select` and `apply`) to
  turn into a source patch.
- `rank` is `current` or `previous`: the harness runs on the DLL of the current
  release and on the one before it (for the loader, the harness built at each
  release tag). `fpAware: false` marks a loader release that predates
  fingerprints; CI writes no scoped rows for it.
- A row is one map request. `key`, `kind` (1-6 or the harness name), `fp` and the
  request's `pattern`, `resultOffset`, `followRel32At`, `followRipDispAt` and
  `siteArithmetic` are what the harness prints; CI copies the `fp` and never
  computes one. A global key (kinds `function`, `data`) has no `fp`.
- `result` is the harness verdict. An OK row needs `pattern` and `rva`.
  `symbolRva` is the start of the symbol that contains the final address, from
  the runner's symbol table, as an address and never as a name (no PDB names reach
  a log). `suggest` is the suggester's block for a row that failed
  (`confidence`, `rva`, `symbolRva`, `proposals[]` with `pattern`,
  `followRel32At`, `followRipDispAt`, `uniqueOnTarget`).

### What it writes and what it refuses

For the new CL it writes a locator row per global key and per scoped key and fp:
the request's own pattern when it resolved, otherwise the suggester's proposal
(high confidence, unique on the build, `resultOffset` 0); otherwise an `absent`
row (owners for a global key, the `fp` for a scoped one). Row sets of an `fp`
that neither the current nor the previous release carries are pruned, and only for
a key whose every owner had both releases in the input. Without the previous
release's scan the `fp`s it still reads are not known, so every set is kept: a
player on that release (AutoUpdate off, or the update declined) keeps the rows it
resolves through on every CL.

A function key (`Class::Function`) written without a `symbolRva` gets a note in the
report: the symbol-start and one-key-per-symbol checks cannot run for it.

It refuses, naming the keys: two keys for one symbol; one key at two addresses; a
global key off a symbol's start; two request tuples under one `fp` of one key; a
required key (the loader's) without a locator, for a scoped one under the newest
release's `fp`; a different verified row already there for a key, `fp` and CL; a
coverage problem of the written map when key lists are given.

The result does not depend on the order of the input, and a second run on its own
output adds nothing.

## Assembling the input from the harness

```
node ci/map-mode.mjs assemble <scans.json> --out <observations.json>
```

`<scans.json>` is `{ cl?, build?, source?, scans: [{ owner, tracked, tag, rank, fpAware, file }] }`,
each `file` a `sr-aobscan --json` output (the registry scan for `ModLoader`, a
`--plugin` scan for a plugin), read relative to the spec. The CL and the build's
stamp and size come from the registry scan's `exe` block when the spec does not
give them; `source` is the build's origin text. A row without a `key` (a raw scan,
a legacy hookName call) is not a map request and is left out; only the loader's
rows are `required`. A scan whose `plugin.name` is not the `owner` is refused.

`sr-client-check.yml` runs both commands in its `map-mode` job when the input
`map_mode` is true: it takes the check job's scans and the loader's header at
`loader_ref`, and uploads the rewritten header and the report as the artifact
`map-mode-<branch>`. Not yet wired: the scans of each tracked component's
previous release (`rank: previous`), the key lists (`--keys`), and the push of the
header to the loader fork (step 26). So today the job feeds the current releases
only, and prunes nothing.

The harness side of this input (plugin scan rows printing `key`, `kind`, `fp` and
`symbolRva`, the suggester's `followRipDispAt` and kinds `data` and `any`) is in the
scanner repo's `tools/AobScan`, not here. A plugin row prints no
`followRipDispAt` (its request has none); the suggester's `followRipDispAt` is the
offset of the instruction start inside the pattern, as `ScanValidation::Resolve` reads it.

## Step 28: `field-rows.mjs write`

```
node ci/field-rows.mjs write <header> --cl <CL> --next <layout.json> [--base <layout.json>]
    (--keys <keys.txt>... | --native-keys <native-keys.txt> --layout-keys <list>) [--report <file>]
```

The client check has no per-component key lists; it gives `ci/native-keys.txt` and the
plain key list the layout reports were read with (`layout-keys.txt`, an artifact of
the check job). A key on that list that is not native is a reflected field.

`--next` and `--base` are `sr-aobscan --layout --json` reports of the new build and
the reference build over the same key list. For the new CL it writes a row for
every `native` key (offset, size, bool mask, found by the key's own text) and for
every reflected `field` key whose offset, size or mask moved. A key the new build
does not have (NOMEMBER or NOTYPE) gets an absent row: no row on that CL, the loader
refuses that one request and the plugin takes its fallback. A key marked `required`
in the key list is refused instead (exit 3, header untouched), and so is a native
key the report has no entry for or does not resolve for another reason. A reflected
key that resolves on the reference build only is listed under `partial` (a rename
guess is low confidence and is not written); the run then reads PARTIAL but exits 0. `FTransform::Translation` and `::Scale3D` keep the size the key list
was built with, because the PDB sizes them as the 32-byte SIMD register and
reflection as an FVector (review N2). The output holds keys and numbers only.
It runs after `write` (the build must be in the table).

## Step 29: `tail-check.mjs`

```
node ci/tail-check.mjs migrated --used <keys.txt> --keys <keys.txt>... [--checks <list>] [--engine <list>] --source <file>...
node ci/tail-check.mjs build-cl --build-cl <build_cl.txt> --basic <Basic.hpp> --map <header>
```

`migrated` fails (exit 3, naming the members) when a plugin that sets
`PLUGIN_MAP_MIGRATED` in code reads a game member that is not one of its `native` or
`field` keys, a check or size row, or an engine member (`Class` covers its members).
`--used` is `layout-table.mjs keys` on the plugin's sources. `build-cl` fails when
`build_cl.txt` is not a CL in the loader map's build table, or the dump's
`Offsets::GObjects` or `Offsets::AppendString` (Basic.hpp) differs from the map's
rows for those keys on that CL. `GNames` and `GWorld` are compared and reported
only: the SDK's values for them differ from the engine's by design (the existing
client check treats them the same way).

## Path M: the map-only update

`decide.mjs` turns the gate results for one game build into a release path. The
paths are `M`, `B` and `C`:

- **M** (exit 0): everything is clean. The update is rows in the loader's map, and
  it ships as a signed feed (below). No plugin repo changes and no CL-only source
  patch is made.
- **B** (exit 10): a required pattern missed; the pattern path (`apply-proposals.mjs`)
  repairs a plugin's patterns.
- **C**: a used class moved. Held until that path is proven.

`state/autopilot.json` lists the paths that may run unattended (`"paths": ["M"]`),
the `enabled` switch and `max_releases_per_day`, which can only lower the daily cap
in `decide.mjs`. A file that names a path other than `M`, `B` or `C` is malformed and
holds. The Game-SDK globals (GObjects, GNames, AppendString, GWorld) must still
resolve. A value that differs from the SDK's baked `sdkRva` is a note, not a hold,
because under path M the map row carries the new value.

A used class that moved is settled when `--fields` (the `field-rows.mjs` report for the
same CL) covers it with a row, an absent row or a class-size move; an uncovered one
holds on path C. A field-rows report that was given and not written cleanly (refused,
or for another CL) holds whatever moved, on every path: the native members get their
rows from the same run. `state/autopilot.json` ships with `enabled: false`: until it
is `true`, decide returns `HOLD` ("autopilot is disabled") on a clean update.

## The signed feed

`version-map.mjs export-feed <header> --out <file>` writes the loader's map as the
unsigned feed. `vmap-sign.mjs` signs and checks it:

```
node ci/vmap-sign.mjs sign <unsigned-feed> --out <file> --key-id k1|k2 [--key-env <NAME> | --key-file <pem>] [--last-seq <n>] [--now <unix seconds>]
node ci/vmap-sign.mjs verify <signed-feed> [--last-seq <n>] [--now <unix seconds>] [--pub <keyId>=<64 hex>]... [--allow-test-key]
```

Signing inserts a `seq` line after the `format` line and ends the file with
`sig<TAB><keyId><TAB><base64>`: an Ed25519 signature over every byte before that line.
`seq` is the UTC second of signing, raised to the last published `seq` plus one when
the clock has not passed it. The private key is read from the environment variable
`VMAP_SIGN_KEY` (a PEM) or a file and is never printed. Both commands refuse a
`seq` more than a day ahead of the clock; the signer also refuses a feed over
512 KiB or one that already has a `seq` or `sig` line; `verify` takes files up to
1 MiB, checks the signature before anything else and, with `--last-seq`, requires a
higher `seq`. `verify` exits 3 when it refuses a file.

The feed format, the key slots (`k1` is the TEST key, `k2` the release key) and what the
loader checks are in the loader repository's [VersionMap.md](https://github.com/AlienXAXS/StarRupture-ModLoader/blob/main/VersionMap.md#the-feed).
`PUBLIC_KEYS` in `vmap-sign.mjs` must hold the same public keys as `kK1Hex` and `kK2Hex` in the
loader's `version_feed.cpp`. The private halves are the repo secrets `VMAP_SIGN_KEY_TEST` (also
Bitwarden `vmap-sign-test-k1`) and `VMAP_SIGN_KEY` (also `vmap-sign-k2`); `verify` refuses a TEST-key
feed without `--allow-test-key`, and only the `publish` job, in the `vmap-sign` environment, reads
`VMAP_SIGN_KEY`.

`vmap-sign.yml` is a manual run that signs the export of a test header with the TEST
key and verifies it with the public key.

### Publishing and the watchdog

The signed feed's home is this repository's `vmap-feed` release, as the asset
`version-map-client.v1.txt`. How the loader repository's `vmap-publish.yml` carries it to the
loader's Latest release, and how players fetch it, is in
[VersionMap.md](https://github.com/AlienXAXS/StarRupture-ModLoader/blob/main/VersionMap.md#how-a-build-reaches-players-ci).

`vmap-watchdog.yml` runs hourly and opens one issue when the feed on the loader's Latest release
lags the last signed `seq` by more than two hours, or when Latest holds no feed. It opens no
second issue while one is open. It reads only `seq` and does not verify
(`ci/vmap-watchdog.mjs check --signed <file> --published <file|-> [--max-lag <seconds>]`).
`sr-keepalive.yml` re-enables it monthly with the other scheduled workflows, because GitHub
switches off scheduled workflows in a public repository after 60 days of no activity.

## Staging and promotion (dry run)

A beta build that passed the chain is staged, and promoted when public flips to the
same build. Both are plan printers: the `map-mode` job of `sr-client-check.yml` runs
them (below), and nothing is signed with the release key, published or released
from them.

```
node ci/staging.mjs stage --build <build.json> --index <staged.json> [--branches <file>] [--out <plan.json>]
node ci/staging.mjs rederive --branches <branches.json> --out <staged.json>
node ci/promote.mjs plan --index <staged.json> --public <public.json> --autopilot <autopilot.json> --history <history.json> --last-seq <N> --now <ISO time> [--verify <verify.json>] [--roll-forward] [--out <plan.json>]
```

- **Staging** puts the build's rows on the loader fork's `auto/update-<CL>` branch (a
  newer build at the same CL gets `-<run>`, so nothing is force-pushed). The commit
  message carries the record, and `state/staged.json` is the readable index of those
  branches. The index holds pointers; the rows live in the header. `stage` is handed
  only a branch push and an index write, so it cannot reach signing, the feed or a
  release. The push itself waits for the deploy key above, so the command line records
  it in the plan and writes only the index.
- **Promotion** matches the public build against the index by build id, exe SHA-256
  and CL. The same build is re-scanned and promoted. The same CL on another exe is
  re-verified key by key. Either needs a passing result (`--verify`, `{ ok: true }`)
  before it may publish; a failed one runs the normal flow, and a missing one holds.
  A different CL promotes nothing, and the staged build stays
  a second reference. A staged CL older than the public one is listed and skipped.
  A promote needs path `M` in `state/autopilot.json` and passes `decide.mjs`'s
  `checkAutopilot` and `checkRateLimits`, with the daily cap counted on the loader
  repository only. `seq` is max(now, last + 1) in UTC seconds, as the signer writes
  it. One publish per CL; `--roll-forward` marks an owner-dispatched re-publish (a
  newer `seq` replacing a bad one), which skips only that limit. It prints the pull
  request it would open and `would sign and publish seq N`; any reason it may not
  goes out as a `HOLD`. `--live` is refused.

## The Steam poll

`poll-steam.mjs` lists every branch of the client app that has no password, as it
does for the server app, so a second beta is tracked the day it appears; a
password-protected branch is ignored. `SR_STEAMCMD_API` and `SR_NEWS_API` replace the
two service addresses, for the tests.

## The workflow chain

The `map-mode` job of `sr-client-check.yml` (input `map_mode`, passed on by
`sr-watch.yml`) is the unattended path M on one build. It reads only the check
job's artifacts, the loader's header and the `vmap-feed` release: no Steam login,
no plugin code, no game file.

1. `map-mode.mjs assemble` and `write` put the observations in the header. The build
   row is named `<branch> <buildid>`. The build id is the one Steam installed
   (`result.json` `download.buildid`), else the `buildid` input (a manual dispatch
   can give it; the poller always does), else the job stops. A plugin is tracked
   when its repo is in the built `plugins` list.
2. `field-rows.mjs write` from the PDB layouts of the check (`layout-target.json`,
   `layout-reference.json`, `layout-keys.txt`, `ci/native-keys.txt`). A refusal does not
   fail the job; decide reads the report and holds.
3. `decide.mjs` with the gates built from the check: G1 the builds, G2 the check, G3
   the CL against the one the header was built for, G4 the client registry scan (the
   client check alone decides; no dedicated-server scan is read), G5 the classes
   the layout diff moved, changed or lost, then the field rows, and the history on
   the `vmap-feed` release for the rate limits.
4. On path M only: `export-feed`, sign with the TEST key (k1, `VMAP_SIGN_KEY_TEST`) and
   verify it, `staging.mjs stage` for a beta build, and `promote.mjs plan`. All dry runs.
5. The `publish` job (input `publish`, default off; `public` branch only; decide `M` and
   promote action `promote`) signs the exported feed with the release key k2 at the
   planned seq, verifies it without the TEST key, and uploads it with the history to
   the `vmap-feed` release. `sr-watch.yml` does not pass `publish`.

Until the loader fork's deploy key exists (step 26), the staging record carries no
loader commit (zeros) and the header is an artifact only.

Offline replay (2026-11-01, run 41272795133, CL-128786, a throwaway key): the loader's
header pruned to CL-127004 gives 102 rows written, 557 field rows with 5 absent,
decide M (autopilot copy enabled), a signed and verified feed, a staged
`auto/update-128786` and a promote plan with a seq.
