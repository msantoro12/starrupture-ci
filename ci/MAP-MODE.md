# Map mode

The whole flow, from a new Steam build to a player's loader, is under "The workflow chain"
below. This file is the reference for the tools.

Map mode puts what a game update changes into the loader's version map
(`version_map.generated.h`, format in `VERSION-MAP.md`), instead of into each
plugin's source. A plugin repo gets no commit for a game update; the loader
fork's `auto/update-<CL>` branch gets one.

The bases are the released line, AlienX's `main` (loader, Plugin SDK, Game SDK and the
nine plugins), because that is what players run and what reads the feed; the fork's old
work branches are behind it. Only `tools/AobScan` comes from the fork's `ci/aobscan`
(`scanner_repo`, `scanner_ref`). The fork is a target only: `auto/update-<CL>` is cut
from the exact AlienX commit the run scanned.

## Step 26: the loader fork's deploy key and ruleset (the owner sets it up once)

The `push-loader` job of `sr-client-check.yml` pushes `auto/update-<CL>` to the
loader fork (msantoro12/StarRupture-ModLoader). It needs a credential, and the
credential is repo-admin setup with the owner's `gh` auth, so the owner runs it
himself, once. It follows the procedure the plugin forks use
(`drafts/ci-auto-apply-detail.md`, "Deploy keys"):

1. Make an ed25519 key pair in a temporary directory. Never print or log the
   private half.
2. Add the public half to the loader fork as a write deploy key titled
   `starrupture-ci auto-apply`.
3. Store the private half as the environment secret `SR_DEPLOYKEY_MODLOADER` in
   `fork-push` on msantoro12/starrupture-ci, from the file, and delete the key
   from the machine. (The Bitwarden Secrets Manager copy, project `dev`, is by
   hand.)
4. Add two rulesets to the loader fork, mirrored from a plugin fork:
   "auto-apply deploy keys: auto/** only" (a deploy key may write `auto/**`
   only) and "auto-apply deploy keys: no tags". The admin role bypasses them.
5. The workflow side is in this repo: `sr-watch.yml` passes
   `SR_DEPLOYKEY_MODLOADER` by name, `sr-client-check.yml` declares it
   (`required: false`), and only the `push-loader` job reads it (environment
   `fork-push`; the job holds the key and no game files, as on the plugin
   forks).

Accept: a push to `auto/test` with the key succeeds, and a push to any other ref
is rejected. Delete `auto/test` afterwards.

What the job does. It reads the stage plan and `build.json` from the
`map-mode-<branch>` artifact and checks the repository (only
msantoro12/StarRupture-ModLoader) and the branch name (only `auto/update-<CL>`,
optionally with `-<run id>-<attempt>`) against the allowlist in `ci/staging.mjs`.
It checks out the loader commit the header was read from (the AlienX `main`
commit the scanner was built from, `loader_repo`@`loader_ref`, with its full history), adds one
commit that changes only `version_map.generated.h`, and pushes it to the fork. It never pushes
a tag and never forces.
A branch that already holds the same tree is left alone; one that holds another
tree stays as it is, and the push goes to `auto/update-<CL>-<run id>-<attempt>`.
The job outputs `branch` and `sha` for the next steps (the `candidate-loader` job,
below, and the client rig). A missing key fails the job with "Loader deploy key missing",
naming the secret and the environment; it is never skipped quietly. The job runs
for a build the chain carried through to staging: not a `test_autopilot` run. A build first
seen on `public` is pushed too: it gets its
own `auto/update-<CL>` and a candidate like any other (it is not entered in the
staged index, since public is what a staged build is promoted to).

### The candidate loader and its tests

The `candidate-loader` job of `sr-client-check.yml` follows `push-loader` and
builds the loader from the exact commit that job pushed: Client Release, with the
build action shared with `sr-build-all.yml` (`.github/actions/build-loader`) and the
build tag `cand-<run id>-<sha7>`. It then builds and runs the loader's
`VersionMapTests` and `LayoutCheckTests` on that commit (each project built from its
vcxproj, the exit code is the verdict), so a pushed row set that breaks the map's own
checks fails the chain. It checks that the tag is compiled into
`StarRupture-ModLoader-Core.dll` and uploads `dwmapi.dll` and `ModLoader/*.dll` as the
artifact `loader-candidate-<branch>` (7 days), the layout the client rig takes as a
candidate. Outputs: `artifact`, `version` (the tag), `expect` (`Loader=<tag>`, the
rig's `expect` value) and `sha`; the candidate run id is this run's `github.run_id`.
The `build-scanner` job also builds and runs the scanner's `ObservedTests` before it
hashes the scanner. The alert job watches these two jobs (a push that did not happen, a
candidate that failed to build or pass its tests) and the rigs, and names the cause in the
issue it raises (see "Alerts" below).

### The client rig gate

The client rig is a required gate on the unattended path (owner: version updates are
verified and deployed with the GitHub rig). After `candidate-loader`, the jobs `rig-branch`
and `rig-other` call `sr-client-rig.yml` with the candidate (`candidate_run_id` = this run,
`candidate_artifact` and `expect` from `candidate-loader`), the default plugin set (the
Latest releases of the nine plugins of msantoro12 and AlienXAXS, and the reviewed release of
MiniMap) and both Steam secrets by name. They run
one after the other, `rig-other` after `rig-branch` whatever its result, because the rig's
concurrency group keeps one pending run. `rig-branch` runs on the Steam branch the check is
for and gets `map-mode`'s `expect_refused`; `rig-other` runs on the other branch and gets
`expect_refused_other`: exactly the refusals the loader's own rule predicts for that
branch's current build, so any refusal the rule does not predict is a fail (that branch's
current build must keep working with the same DLLs). `rig-gate` writes both verdicts,
reasons and logs artifacts into the run summary
and is red unless both passed. `publish` needs both rig jobs at verdict `PASS`; the promote
step above is only a plan. With the autopilot off, publish is held and the rigs still run.
Details: `.github/sr-pipeline/README.md`, "Client test rig".

Policy (owner), in plain words:

- The client rig is a required gate on the unattended path: the CI's own candidate loader,
  both Steam branches, the same DLLs. A rig fail blocks publish and raises the alert.
- Graphics are not a gate. The rig runs `-nullrhi` to the main menu: no rendering, overlay,
  DX11 or in-world checks. Graphical problems get small fixes after a release.
- Autopilot off means build everything, publish nothing: the decision stays `HOLD` and the
  `publish` job is skipped ("publish skipped"). The autopilot is the one switch: with it on, a
  public run that passes every gate publishes by itself (below, "The publish path"). The staged
  branch push needs the loader fork's deploy key (step 26). It stays off until the owner has
  approved the first full run.
- The rig runs only candidates built in this repository from our own branches.
- Expected refusals on the other branch: `expect_refused_other` is `decision.json`'s
  `expectRefusedOther`, which `decide.mjs` computes from `--other-cl N` (the CL the other
  branch's Steam build id has in the candidate map's build rows; the watcher passes the id
  as `other_buildid`; a dispatch without it reads the other branch's live build id from Steam,
  with the code of the watcher's poll, and stops the chain with a message if it cannot; an
  explicit `other_buildid` wins). A build the map has no row for: nothing is declared as refused. A plugin of interface v72 or later
  that is not built here has no known migration flag and is not predicted.
- A build the candidate map has no row for on the other branch: the loader cannot run it and
  declines. `decide.mjs --other-unmapped` sets `expectDeclineOther`, map mode passes
  `expect_decline: true` to `rig-other`, and that rig passes only on a clean decline: the
  version-mismatch line and the aborted hook installation are logged, no plugin is read or
  initialised, nothing crashes, and the game process is still alive when the rig stops it. The
  summary names the expectation. Anything else fails the rig. A CL in the map is judged as before.
- Plugins of other authors are pinned. A rig plugin whose owner is neither msantoro12 nor
  AlienXAXS (MiniMap) runs only at the `Pin` (tag and asset digest) in `ci/plugin-names.json`,
  in the client check as well as in the rig: the check's `plugin-plan` reads the same Pin,
  fetches that tag and never builds such a plugin from source; a digest mismatch, a missing or
  malformed Pin fails the plugin (FETCH-FAILED) and the rig. A newer release does not change
  anything that is scanned, run or predicted: the alert job adds "new <plugin> release <tag>
  waiting for review", which blocks nothing.
- The refusals declared to a rig come from the DLLs that rig runs. The check job resolves the
  rig's set with `ci/client-rig-set.ps1` (Latest released plugins plus the pinned third-party
  one), fetches it through the rig's download cache, reads each DLL with `sr-aobscan --plugin`
  into `out/rig-plugins.json`, and `decide.mjs --rig-plugins res/rig-plugins.json` applies the
  loader's rule (`loaderRefusal`) to those facts, for `expect_refused` and
  `expect_refused_other`. The resolved tags go to both rigs as `tags` (output `rig_tags`).
  The plugin builds from `main` still produce the map rows and the verdicts, but declare
  nothing. A DLL whose facts cannot be read, or no `rig-plugins.json` at all, declares
  nothing (a note in the decision), so a refusal there is a loud fail.

## Step 27: `map-mode.mjs write`

```
node ci/map-mode.mjs write <header> --input <observations.json> [--keys <keys.txt>]... [--report <file>]
         [--published <signed feed> [--retired <file>]]
```

`<header>` is the loader's `version_map.generated.h`; it is rewritten in place.
`--keys` takes the tracked components' key lists (`VERSION-MAP.md`, "The coverage
rule"), once per component; the written map must satisfy the rule over their
union. `--report` writes `{ written, added, pruned, problems, notes, patches }`.
`--remeasure true` (the client check passes it on a `test_autopilot` run only) replaces the build row of a
CL already in the table and drops that CL's rows before writing, so a known CL can be measured again;
without it a known CL with another exe or source is refused. The client check then puts back every
published row that the run did not measure (see "A re-measure keeps published rows").
`--published` takes the signed feed (it must verify, exit 4 otherwise) and keeps its function rows
out of the prune below; `--retired` (needs `--published`) is the retired list, whose rows are not kept.
Exit 0 written, 3 refused (the header is untouched, every reason is on stderr),
2 usage or malformed input.

### The input

One JSON file per new build, which the runner assembles from the harness
(`sr-aobscan`):

```json
{
  "schema": 1,
  "cl": 128786,
  "build": { "stamp": "0x6A1B2C3D", "size": "0x0A412000", "source": "steam_build 26271156" },
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
resolves through on every CL. With `--published`, a row the published feed has is never
pruned, whatever the scan says; it leaves only by an entry in `ci/retired-rows.txt`.

A function key (`Class::Function`) written without a `symbolRva` gets a note in the
report: the symbol-start and one-key-per-symbol checks cannot run for it.

It refuses, naming the keys: two keys for one symbol; one key at two addresses; a
global key off a symbol's start (a key source's key dropped for its symbol, see Key sources, is not checked); two request tuples under one `fp` of one key; a
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
the commit the scanner was built from (`loader_ref` of `loader_repo`), and uploads the rewritten header and the report as the artifact
`map-mode-<branch>`; the `push-loader` job then pushes the staged header to the
loader fork (step 26). Not yet wired: the scans of each tracked component's
previous release (`rank: previous`) and the key lists (`--keys`). So today the job
feeds the current releases only, and prunes nothing.

A build the loader does not run on yet is the case this job exists for. With
`map_mode` on, the check records a failed loader version gate as a new build
(`checks.exe.newBuild`, top-level status `new-build`) instead of failing, so the
job runs and measures it; the PR comment and the alert issue say "new build,
measured by map mode". With `map_mode` off the same build still fails the check.
Every other gate (login, download, branch, exe, pattern scan, PDB) fails the check
as before, and a failed check never reaches this job.

The harness side of this input (plugin scan rows printing `key`, `kind`, `fp` and
`symbolRva`, the suggester's `followRipDispAt` and kinds `data` and `any`) is in the
scanner repo's `tools/AobScan`, not here. A plugin row prints no
`followRipDispAt` (its request has none); the suggester's `followRipDispAt` is the
offset of the instruction start inside the pattern, as `ScanValidation::Resolve` reads it.

## Carrying forward the keys no plugin requested

A key that has rows on earlier CLs but that no scanned DLL requested on the new
build gets no row from `assemble`. The scanner's carry mode
(`sr-aobscan <exe> --carry --map <header> [--cl <CL>] [--ignore-cl <CL>]`) re-resolves
each such key on the target exe with the pattern of its newest earlier row, the lookup
the loader does at run time, and writes `carry.json`: `{ kind: "carry", cl, summary,
rows }`. A row is one key as the map keeps it (key, kind, fp):

- `key`, `kind` (the map's number) and `fp` (hex; 0 for a global key);
- `fromCL`: the build whose pattern was tried, or `null` when the key has no pattern
  row to try;
- `matches`, `rva` and `result`, one of `match`, `none`, `ambiguous`, with a `reason`
  unless it matched;
- the locator that was tried: `pattern`, `resultOffset`, `followRel32At`, `followRipDispAt`;
- `owners` (comma-separated), when a newer absent row of a global key binds owners.

The scanner exits 0 whenever it wrote a report, so the report is what a step reads,
never the exit code. Exit 2 means there is no report.

```
node ci/map-mode.mjs assemble <scans.json> --out <observations.json> --carry <carry.json> --base <header>
node ci/map-mode.mjs write <header> --input <observations.json> --report <write report>
node ci/map-mode.mjs complete <header> --cl <CL> --report <write report>
```

`--base` is the loader header before the write. Per entry:
- `match` with `matches` 1: a present row for the target CL at the entry's `rva`, with
  the entry's `kind`, `fp`, `pattern`, `resultOffset`, `followRel32At` and
  `followRipDispAt`. A match without a pattern or an `rva` is refused.
- `none`, `ambiguous`, or a `match` with other than 1 hit: an absent row. The header
  has no reason column, so the reason shows as a note in the write report
  ("carried from CL-N: ..."). A global absent row must list owners: the entry's `owners`
  when it has them, else the owners of the key's earlier rows in `--base` (sorted, each
  once). A scoped key lists none. If a global key has no owners either way, no row is
  written: the key and its reason go to the write report's `absences` and the gate below
  counts it as accounted for.
- A `fromCL` of `null` is an absent row with the reason `no pattern row`, by the same
  owner rules (so report-only when no owner is named).
- A key with a fresh scan row (any component) gets no carried row.

A carry report that is missing, is not JSON, has another `kind` or another `cl` than
the build, or holds an entry with no key, no `kind` or `fp`, an unknown `result`, a
`match` with no `fromCL`, or a malformed locator, stops `assemble` with exit 2 and a
message that names the file and the key. Nothing is guessed. Without `--carry` nothing
changes.

`complete` is the gate: every function key with a row on an earlier CL must have a
row on `<CL>`, present or absent, or be named in the `absences` of the write report given as
`--report` (the result, `missing` and `line`, is merged into that file). A key missing from
both still fails. It prints one line (`N of M function keys have no CL-X row: a, b, c,
+k more`), lists each key on stderr, and exits 3 when any is missing, 0 otherwise.

In `sr-client-check.yml`:
- The `check` job runs the scan after the login cache is gone: it checks out the base
  header (the loader commit the scanner was built from, `needs.build.outputs.loader_sha`,
  which is also the commit `auto/update-<CL>` is cut from) and runs the scanner the
  build job made with `--carry --map` against the exe it just checked, with `--cl` set to
  the exe's CL. A dispatched test run (`test_autopilot`) re-measures a CL the header
  already has rows for, so it adds `--ignore-cl`. The report is `out/carry.json`, in the
  `client-check-<branch>` artifact. The step fails (annotation `Carry scan`) when
  there is no usable report, so the check job fails with that cause.
- The `map-mode` job passes it to `assemble` with the unwritten header as `--base`,
  and stops with `::error::` when the file is missing or `assemble` refuses it. After
  `write` it runs `complete` on the written header with the write report. On exit 3 the
  job fails with `::error::<the one-line cause>`; the alert reads that annotation first, so
  its "map mode" line reads, for example, `cause: step "Write the update into the
  header": 3 of 220 function keys have no CL-129402 row: a, b, c`. Nothing after
  that step (decide, export, staging, the push) runs.
- The artifact `map-mode-<branch>` holds `carry.json` and `map-mode-report.json` (with
  `absences`, `alerts`, `missing` and `line`) beside the other files.

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
every reflected `field` key whose offset, size or mask moved or that only the new build resolves.

It also writes a **class-key row** (the key is the class name alone, offset 0, size N,
mask 0) for the size of every class a component requests (`size <Class>
check|compiled|live` in `--uses`), on every build and whether or not the size
changed, so each CL has its own row and none falls back to another build's. N is the
size the new build's `--layout` report gives for the class. It goes through the same
add-field rule as a member row: the same row again changes nothing, another value for
that key and CL is refused. A class the new build does not resolve gets no row (what
depended on it is degraded or refused below), and a requested class with no entry in
the report refuses the run. Without `--uses` nothing says which sizes are requested,
so no class-key row is written.

A `native-keys.txt` line `<plugin> <ClassName> [size] [optional]` is the same row for an
unreflected struct: its size is read from the PDB by the same `--layout` run (the scanner
reports the size of any class that has a body in the PDB, reflected or not) and written
on every build. The word `size` is only for reading. `optional` works as on a member
line: a struct gone from a build gets an absent row and the plugin takes its fallback.
It has no built values and no anchor.

A line may name `ModLoader` as the owner: the loader itself reads that member. Without
`optional`, a build that lacks it holds the update, since every plugin depends on the loader.
With `optional` the loader can do without it, so a build that lacks it (`NOMEMBER`, `NOTYPE` or
unreadable) gets an absent row and a low-severity note on `ModLoader`, and the update goes on.
A plugin that lists the same key without `optional` still counts it as required.

The gate is per plugin, over what that plugin requests. `--uses` is the client check's
`layout-uses.txt`: per component, its keys (`key`), the members its code requests
(`request`: `SR_FIELD`, its two-argument wrappers, a hand-written `"Class::Member"`), the
members it looks up by name on first use (`lazy`, a `PluginLazyField`) and the classes it
depends on the whole size of (`size <Class> check|compiled|live`) or reads live (`size <Class> live`). The plugin tables are built
with `layout-table.mjs gen --granularity 2 --uses-out`, so a struct lists only the members
a plugin uses or requests, as a UClass already did.

- A key the new build does not have (NOMEMBER, NOTYPE, or a reflected key only the
  reference build resolves) never holds a plugin. It gets an absent row (no row on that
  CL), the loader turns that request off, and the report's `degraded` lists the plugin
  with the key: severity `high` for a required request, `low` for an optional one (a key
  list's `optional`, or a lazy lookup). A key no plugin requests or looks up is a note.
- A key the loader itself reads (component `ModLoader`) holds the update, unless its
  `native-keys.txt` line says `optional`: every plugin depends on the loader.
  The loader's optional lines are the two heap members and the six image-library members
  (`UTexture::PrivateResource`, `FTexture::TextureRHI`, `FD3D12Texture::ResourceLocation`,
  `FD3D12ResourceLocation::UnderlyingResource`, `FD3D12Resource::DefaultResourceState`,
  `FD3D12Resource::Resource`): a build without one gets an absent row, the exit stays 0.
- A class whose size changed is a note when nothing depends on its whole size or the
  only users read it live from the running game (`SR_SIZE`, `size <Class> live`: the
  game answers with its own size on every build), and
  degrades the plugin with `SR_SIZE_CHECK` on it (the loader refuses that request). Code
  that uses the compiled size with no check (`sizeof`, a `TArray` of it by value, a copy)
  holds the update: the loader cannot see the change, so that code misreads it, and
  nothing in the feed turns one plugin off. The fix is `SR_SIZE_CHECK` in that plugin.
  A refused class writes no header, so no class-key row ships with it.
  Without `--uses`, every class is taken to be used by its compiled size.
- A class that is gone degrades every plugin with a key in it.
- A row that is not verified never ships: a native key the report has no entry for, or
  that does not resolve for another reason, is refused (exit 3, header untouched) when a
  plugin requires it. When only `optional` lines ask for it (MiniMap's building-picture
  members, for one), it is an absent row instead: that request goes off, and the key and the
  scanner's answer (`BITFIELD`, `AMBIGUOUS`, `NOMEMBER`) are in `absent`, in the plugin's
  `degraded` list and in the run summary, and a feature that needs the member stays off until the
  scanner can read it. A native key gets a row on the CL a run maps and
  on no other, so a CL that was mapped before a line was added gets it from a proof run.

A rename is not guessed. `FTransform::Translation` and `::Scale3D` keep the size the key list
was built with, because the PDB sizes them as the 32-byte SIMD register and
reflection as an FVector (review N2). The output holds keys and numbers only.
Classes and objects found by name at run time (Blueprint classes, assets) are not in the
PDB, so their existence is not checked here.
It runs after `write` (the build must be in the table).

### Where the reference layout comes from

Field rows record what moved, so they need the layout of the build the plugins were
built for as well as the new one.

- A check of any branch but `public` downloads the live `public` build and scans it:
  that is `layout-reference.json`.
- `public` has no older build to download: Steam stops serving it once `public`
  moves. So every `public` map-mode check keeps the layout it scanned, one file per CL
  (`layout-CL-<CL>.json`), on this repository's `vmap-layouts` release. The `layout-store`
  job writes it, with the job's own token, only from `main`. A file already stored for a CL
  is extended with new keys only for the same exe, and only if an Actions job uploaded it;
  an unchanged one is not uploaded again. The job is red when the check left nothing to
  store, because that build cannot be fetched again once `public` moves.
- When `public` moves, field rows read the file for the CL the header was built for.
  `ci/layout-store.mjs reference` accepts it only if all of these hold: it is for that CL;
  its Steam build id, image stamp and image size are the header's build row for that CL;
  the release says the Actions bot uploaded it (a hand upload does not count); it has
  an entry for the reflected keys now listed, apart from a few (see below); and, for a re-run of the same CL, the exe
  hash is the same. "Uploaded by the Actions bot" means an Actions job of this repository:
  anyone who can push a workflow here could upload as the bot, and could change `main`
  as well. The recorded run is not looked up, because runs age out and the file must not.
- The file is also checked against the header itself. Every key that has a field row in
  the header for that CL and an entry in the file must agree on offset, size and bool
  mask (a class key is a size only; the two `FTransform` keys hold the register's size in the
  file and the built size in the header, so their size is not compared). One disagreement refuses the file, and so does a file that
  covers fewer than half of the header's rows for that CL. A key that resolves on the new
  build but not on the reference build is new there: it gets a row from the new build's
  values and a note, and holds nothing.
- The header carries few field rows, so the file is checked the same way against the
  field rows of this repository's published version map as well, when the run can
  download it from the `vmap-feed` release and the release lists it as uploaded by an Actions job.
  If the version map is missing, unreadable, uploaded by anyone else or has no rows for that CL, the run prints one line saying the wider check was
  skipped and goes on with the header's rows; a disagreement still refuses the file.
- If any of that is missing, nothing is guessed. The run holds, and the hold names what
  is missing ("no reference layout to find what moved: no stored layout for CL-N ...").
  A plugin can add a reflected key after the file was saved, and the file cannot be
  extended once Steam has stopped serving that build. So a file that lacks some of the
  reflected keys now listed is still used, as long as it lacks no more than 10 of them,
  or no more than 1 in 20 (5%) of the listed ones when that is more. The run prints one line with the
  count and the first names. Those keys have nothing to compare against: if the new
  build resolves one, it gets a row from the new build's values and a note, and if it
  does not, the run holds, because that cannot be told apart from a key that is gone.
  Above the limit the file is refused, and the update holds until the header is built
  for a newer CL.
- The one-time seed, so the build `public` runs today is stored before it moves:
  `gh workflow run sr-client-check.yml --repo msantoro12/starrupture-ci --ref main -f branch=public -f map_mode=true -f test_autopilot=true`.
  Dispatch it a second time to see the stored layout read back.
- To compare a stored base with the live-scan base on a build that really moved, dispatch a
  test run of the other Steam branch (`-f branch=<the other branch>`) with
  `-f stored_reference=true -f map_mode=true -f test_autopilot=true`. It takes the stored
  layout as its base instead of the live scan, so its `field-rows.json` (in the map-mode
  artifact) can be compared with the one of a normal run on the same build. It is refused
  on `public`, with publish on, without `test_autopilot`, and from sr-watch.

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

decide also reads the plugin verdicts of the client check (`--plugins`, `result.json`
`plugins`) and gates per plugin: one plugin never holds the others. `decision.json`
`plugins` lists each one as `updated` (PASS, NONE, GAME-CALL), `updated` with `degraded`
entries (FAIL: the patterns that did not resolve turn off; and every `degraded` entry of
the field-rows report), or `held` (REFUSED: it cannot load on the new CL at all, interface
version or no built CL; it alone goes to the rebuild path, and the loader refuses it
there; RULE3: it declares `PLUGIN_MAP_MIGRATED` and still reads game members directly; and
CRASH, ERROR, BUILD-FAILED, FETCH-FAILED, OFFSETS, OFFSETS-UNCHECKED: it crashed, did not
build, could not be fetched or was not verified). A held plugin stays on its last release
and every other plugin goes on; one plugin's build failure does not fail the `plugins` job,
and with every plugin held the loader alone still ships. The run summary shows the same
table. Only a verdict decide does not know, and the loader's own gates (G1 to G4, the SDK
globals, a loader key), hold the whole update. `pluginsOk` is false only
then, and the promote re-scan (`verify.json`) reads it.

A plugin is judged against the candidate map, and against the loader's own rule. The
probe's planned stop (`the probe ended PluginInit there, as planned ... (0xC0000005)`) is
not a crash: a FAIL plugin whose refusals are all for rows the field-rows report wrote
(`fields.rows`) is `updated`, and only what the candidate does not fix holds it alone (a
pattern still MISSING, a refusal for a key with no row, or a FAIL with nothing listed). A
plugin the loader refuses on the build is `held`, whatever its scan says, with the reason
`refused by the loader on CL-<n>: plugin interface v<x>, needs its author's update`. The
rule is `VersionMap::OffBuildRefusal` (the loader's `memory_scanner/version_map.cpp`, called
from `plugin_manager.cpp` at DLL load, before the plugin scans): a plugin is judged
against the build its SDK came from. Interface v70 and v71 have no game-build tail and
count as built on CL-127004; v72 and newer name their build. Off that build the plugin is
refused unless it is v72 or newer and declares `PLUGIN_MAP_MIGRATED`. The pipeline reads
the interface version and build from the scanner's `plugin` block in `plugins.json`
(`interfaceVersion`, `gameBuild`), and the migrated flag from `rule3.migrated` (plugins
built here; a released DLL has none), else from the probe `note`, where the scanner puts
the loader's own refusal text (`Needs an update to run on CL-<n>: ...`). The autofix patch
for another author's plugin (verdict `PATCH`) stays a patch: no row is ever written for
it, and a refused plugin lists no degraded patterns.

`decision.json` `expectRefused` lists, sorted, the plugins the loader refuses on this
branch's build (the rule above, and the scanner's own REFUSED verdict). The map-mode job
exposes it as the output `expect_refused`: log names separated by single spaces, empty
when there are none, written whenever decide ran (held or not). It is the client rig's
`expect_refused` input as `client-rig-set.ps1` reads it (`Read-Names`: tokens of
`[A-Za-z0-9_.-]`). For CL-129402 it is `MiniMap`; for CL-127004 it is empty.

With `--other-cl N` (the CL the other Steam branch runs) decide also writes `otherCl` and
`expectRefusedOther`: the plugins the loader rule refuses on CL-N, from the same plugin
metadata. Only the loader rule counts there: the scanner's REFUSED verdict and a probe note
are about the scanned CL, not another build. The map-mode job exposes it as
`expect_refused_other`, the `expect_refused` input of `rig-other`. Without `--other-cl`
the field is absent and the other rig expects no refusal; `--other-unmapped` (a build the map has no row for) sets `expectDeclineOther` instead, see above.

A used class that moved is settled when `--fields` (the `field-rows.mjs` report for the
same CL) covers it with a row or an absent row; an uncovered one holds on path C. A field-rows report that was given and not written cleanly (refused,
or for another CL) holds whatever moved, on every path: the native members get their
rows from the same run. `state/autopilot.json` has `enabled: true` (path M only) since 2026-11-10; while it
is not `true`, decide returns `HOLD` ("autopilot is disabled") on a clean update.

The autopilot gates publishing only, not the candidate. `--candidate` (the
unattended chain: `map_mode` on, not a `test_autopilot` run, which
is what `sr-watch.yml` calls, with `publish: true`; the publish input does not change the candidate) keeps that `HOLD` and its reason, and adds `wouldBe`
and `candidate: true`. When `wouldBe` is `M`, the only thing that held it was the
autopilot, and the chain runs on: export, TEST-key signing and verify, staging (and
the push of the staged branch), and `promote.mjs plan --test-autopilot`, which plans
past the switch and marks the plan `test`. Every other `HOLD` reason (a gate, a
plugin verdict, the field rows, the path list, a rate limit, an unreadable
autopilot file) leaves `wouldBe` at `HOLD` and stops the chain before the export.
The decision stays `HOLD` while the autopilot is off, and the map-mode `test` output
is `true` for it, so the publish job cannot run. With the autopilot on, `--candidate`
changes nothing.

`--test-autopilot` (the client check's dispatch-only `test_autopilot` input, refused
with `publish` on, absent from sr-watch's calls) keeps that `HOLD` and adds `wouldBe`,
the decision with autopilot on. When it is `M` the chain runs on: export, TEST-key
signing and verify, staging and `promote.mjs plan --test-autopilot`, which plans past
the switch with every other gate kept and marks the plan `test`. Nothing in a test run
is publishable.

## The signed feed

`version-map.mjs export-feed <header> --out <file>` writes the loader's map as the
unsigned feed. `vmap-sign.mjs` signs and checks it:

```
node ci/vmap-sign.mjs sign <unsigned-feed> --out <file> --key-id k1|k2 [--key-env <NAME> | --key-file <pem>] [--last-seq <n>] [--now <unix seconds>] [--seq <n>]
node ci/vmap-sign.mjs next-seq [--last-seq <n>] [--now <unix seconds>]
node ci/vmap-sign.mjs verify <signed-feed> [--last-seq <n>] [--now <unix seconds>] [--pub <keyId>=<64 hex>]... [--allow-test-key] [--expect-seq <n>]
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

**The feed carries every build in the header** (owner, 2026-11-08: every build we can reach).
`export-feed <header> --out <file>` writes the whole map. A feed over the size cap
(`FEED_MAX_BYTES`, 512 KiB, half of what every loader accepts) is refused with its size, before
anything is signed.

**One seq per publish.** `seq` is worked out once with `vmap-sign.mjs next-seq` and that
number is passed on: `vmap-sign.mjs sign --seq <n>` signs exactly it (it must rise above
`--last-seq` and be within a day of the clock), `promote.mjs plan --seq <n>` plans with it,
and the history entry records it. `vmap-sign.mjs verify --expect-seq <n>` refuses (exit 3)
a signed feed that carries another seq, so a plan and a feed that disagree stop the run.

The feed format, the key slots (`k1` is the TEST key, `k2` the release key) and what the
loader checks are in the loader repository's [VersionMap.md](https://github.com/AlienXAXS/StarRupture-ModLoader/blob/main/VersionMap.md#the-feed).
`PUBLIC_KEYS` in `vmap-sign.mjs` must hold the same public keys as `kK1Hex` and `kK2Hex` in the
loader's `version_feed.cpp`. The private half of k1 is the repo secret `VMAP_SIGN_KEY_TEST` (also Bitwarden
`vmap-sign-test-k1`). The private half of k2 is `VMAP_SIGN_KEY` in the `vmap-sign`
environment (also Bitwarden `vmap-sign-k2`), not a repo secret: the environment only
accepts deployments from `main`, and it has no required reviewer, so the automated
pipeline is not blocked. `verify` refuses a TEST-key feed without `--allow-test-key`,
and only the `publish` job reads `VMAP_SIGN_KEY`.

`vmap-sign.yml` is a manual run that signs the export of a test header with the TEST
key and verifies it with the public key.

### Publishing and the watchdog

The signed feed's home is this repository's `vmap-feed` release, as the asset
`version-map-client.v1.txt`. The loader repository's `vmap-publish.yml` carries it to the loader's Latest release:

- It runs every 15 minutes, pulls the `vmap-feed` asset and verifies it against the public
  keys in the loader's `version_feed.cpp`.
- It uploads to Latest only if the feed verifies and its `seq` is higher than the newest
  `seq` on any release.
- The first publish needs a manual run with `first_publish` set; until then every scheduled
  run fails with "No release carries a feed". The loader repository's `vmap-publish.yml`
  schedule is disabled until then, and it is re-enabled with
  `gh workflow enable vmap-publish.yml --repo AlienXAXS/StarRupture-ModLoader` once that
  first publish is verified.
- The loader repository holds no signing secrets; only the signed file moves.
- The feed sits on Latest because the loader's `prune_releases.yml` deletes the other
  releases.

`vmap-watchdog.yml` runs hourly and opens one issue when the feed on the loader's Latest release
lags the last signed `seq` by more than two hours, or when Latest holds no feed. It opens no
second issue while one is open. It reads only `seq` and does not verify
(`ci/vmap-watchdog.mjs check --signed <file> --published <file|-> [--max-lag <seconds>]`).
`sr-keepalive.yml` re-enables it monthly with the other scheduled workflows, because GitHub
switches off scheduled workflows in a public repository after 60 days of no activity.

## The published feed as the base

A new feed is cut from the loader header. If the header lacks a row the published feed has,
that row would drop out of the next feed and players would lose it. Every map-mode run takes
the published feed as part of the base: it adds it to the header first, and a published
row is never removed or rewritten by a run.

**What a run does.**

1. Right after a job checks out the loader header (the check job's carry scan, map mode;
   not the daily layout refresh), it fetches `version-map-client.v1.txt` from the `vmap-feed` release (3 tries, 5 and 15
   seconds apart), verifies the signature with the release key, and adds the builds and rows the
   header lacks (`ci/published-base.mjs take`, which runs `version-map.mjs import-published`).
2. Map mode writes its rows on top of that header. Rows the feed has are kept out of the prune.
3. After the feed is cut, map mode checks that it still holds every published line unchanged
   (`ci/published-base.mjs preserve`).
4. The `publish` job checks the same against the live file it downloads, before the key is used.

A first publish has no published file, so step 1 skips a missing one for that run only and step
3 and 4 do not run.

**The two lists.** `ci/retired-rows.txt` and `ci/changed-rows.txt` are the only way a published row
may leave or change. Format and an example entry are in `VERSION-MAP.md` ("The published feed is
part of the base"). A test run that measures a published build again keeps the rows it did not
measure (below); a row it measures with other content needs an entry in `ci/changed-rows.txt`, with
a reason, or the run holds.

**A re-measure keeps published rows.** A test run (`test_autopilot`) can measure a build the published
file already holds. `--remeasure` drops that build's rows first, so a row whose key is no longer in
the key list, or that the scan no longer resolves, would be missing. After the member rows are written,
the chain step runs `version-map.mjs restore-published` for the run's build:

- A published row the run did not measure is put back as published.
- A published function row that the run measured as absent (no address) is put back as the real row.
  The same holds for a member row the run found no member for. A real published row is never
  replaced by an absent one.
- A row the run measured with other content (offset, size, mask, address or pattern) stays as measured.
  The preserve check then holds on it, and the message says so: add the row to `ci/changed-rows.txt`
  with a reason if the new content is right.
- A row in `ci/retired-rows.txt` or `ci/changed-rows.txt` is not put back.

Each kept row is printed in the job log and listed in the step summary ("Published rows of CL-<n> in a
re-measure"), with the reason: `the run did not measure it`, `the run found no address for it` or
`the run found no member for it`. The list is also in the `kept-published.json` chain artifact.
A run that is not a test run does not do this: a build it measures is new to the file.

**Carried field keys.** A new build's key list can lose a member key that the published rows of an
older build still have (a key list is rebuilt from what the components read now). So the player's older
plugin would find no row for the new build. A map-mode run for a build that the published file does not
hold yet therefore also asks the scan of that build for the field keys of the *newest* published build,
meaning the highest CL in the published file, that its key list does not name
(`version-map.mjs carry-keys`, written to `layout-carry-keys.txt`). `field-rows.mjs` then handles each
one:

- It resolves: a row is written for the new build, and the report notes it.
- It does not resolve (missing, a bit field, no type, or not in the report): a note only. It is never a
  hold, never an absent row and never a degraded plugin.
- A key with an entry in `ci/retired-rows.txt` (a field entry on any build, or the whole newest build) is not carried.

A build the file already holds carries nothing; its rows are kept as above. The carry only adds rows to
what the run measures. The scanner and the loader are not involved.

**What a hold looks like.** The run never goes on with the loader header alone. Map mode ends in a
`HOLD` decision (nothing is signed, staged or published), and the alert issue shows

```
- decide: **HOLD** on CL-<n>
  - published base: <what went wrong>
  - <the rows, up to 20>
```

If the `publish` job finds the loss instead, the job fails and the alert shows
`job publish the feed failed` with the first lost rows as its cause (the job log lists all of them).

| The reason says | What it means | To clear it |
|---|---|---|
| `could not be fetched after 3 tries` | GitHub did not answer | Run again. |
| `signature was refused` | The file does not verify with the release key | Do not run again. Look at the `vmap-feed` release; this is not a transient error. |
| `N rows differ` | A row in the header and in the published feed has other content (a test run that measured a different value lands here too) | If the new content is right, add the row to `ci/changed-rows.txt` with a reason; otherwise fix the header. |
| `published lines are missing` | The new feed lost a published row | If it should go, add it to `ci/retired-rows.txt` with a reason; otherwise find why it was dropped. |
| `the release does not exist` / `has no ...` on a run that is not a first publish | No published file to take | Check the `vmap-feed` release. |

One refusal is not a hold. With the published file in the base, a run for a build (CL) the feed already holds
can end `map-mode.mjs write` with `CL-<n> is already in the build table with another exe or source`, or with a
published key found at another address. The `map mode` job then fails and the alert shows `job map mode failed`
with that line. Nothing is signed or published. Check the Steam build id of the run against the one in the feed.

After the fix is on `main`, run again (`gh workflow run sr-watch.yml --ref main -f force=true`).

## Staging and promotion (dry run)

A build that passed the chain and is not on `public` yet is staged, and promoted when public flips to the
same build. A build first seen on `public` is pushed to the loader fork but is not
staged (nothing to promote it to). Both are plan printers: the `map-mode` job of `sr-client-check.yml` runs
them (below), and nothing is signed with the release key, published or released
from them. The staged index is not kept between runs, so a plan is all they produce.

```
node ci/staging.mjs stage --build <build.json> --index <staged.json> [--branches <file>] [--out <plan.json>]
node ci/staging.mjs rederive --branches <branches.json> --out <staged.json>
node ci/staging.mjs target --repo <owner/name> --plan <stage-plan.json>
node ci/staging.mjs push --repo <owner/name> --plan <stage-plan.json> --build <build.json> --header <file> --checkout <dir> --run-id <n> --run-attempt <n>
node ci/promote.mjs plan --index <staged.json> --public <public.json> --autopilot <autopilot.json> --history <history.json> --last-seq <N> --now <ISO time> [--verify <verify.json>] [--roll-forward] [--out <plan.json>]
```

- **Staging** puts the build's rows on the loader fork's `auto/update-<CL>` branch (a
  newer build at the same CL gets `-<run>`, so nothing is force-pushed). The commit
  message carries the record, and `state/staged.json` is the readable index of those
  branches. The index holds pointers; the rows live in the header. `stage` is handed
  only a branch push and an index write, so it cannot reach signing, the feed or a
  release. `stage` only plans the push (`done: false`, in the map-mode job, which holds
  no key). The real push is `staging.mjs push`, run by the `push-loader` job that holds
  the deploy key (step 26): one commit on the loader commit the header was read from,
  changing only the header.
- **Promotion** matches the public build against the index by build id, exe SHA-256
  and CL. The same build is re-scanned and promoted. The same CL on another exe is
  re-verified key by key. Either needs a passing result (`--verify`, `{ ok: true }`)
  before it may publish. The chain writes that result from this run's own re-scan, and
  it is `ok` only when the loader registry check passed and the plugin scan passed
  for every plugin, so it can fail; a failed one runs the normal flow, and a missing one holds.
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
does for the server app, so a second branch is tracked the day it appears; a
password-protected branch is ignored. `SR_STEAMCMD_API` and `SR_NEWS_API` replace the
two service addresses, for the tests.

## Key sources

Map mode learns a plugin's function keys only by scanning its DLL, and its field and size keys
only from the source of a build. The plugins of the `plugins` input are the released line, so a
key that only our fork builds request never got a row, and the loader refused that request on
a new build until a row was written by hand. A **key source** is such a fork build, built and
scanned for its keys alone, so every key it requests gets a row on every build.

Input `key_sources` (both triggers): space-separated `msantoro12/StarRupture-Plugin-<Name>@<branch>[:<commit>]`.
The default is the nine plugins on `gss/plugin-work`, plus the MiniMap key-scan build
(`feat/full-version-map`, pinned to a commit). Only `msantoro12` plugin repositories are accepted, the ref
is a branch name (never a pull request ref or a tag), and a ref with no commit pin is accepted only
for the nine plugins on `gss/plugin-work`; anything else needs `:<40-digit commit>`, which must be the
branch head or in its history. Nothing from an issue or a fork pull request is ever built.

Jobs (map mode only; none holds a secret or an environment):

1. `key-sources-plan` (ubuntu) checks the list and resolves each branch to its commit with
   `git ls-remote` (the pin is verified with `gh api compare`). It logs `<repo>@<branch> = <sha>` for each.
2. `key-sources` (Windows, one leg per source, `fail-fast: false`) builds exactly that commit and uploads it as
   `keysrc-<branch>-<name>` for one day. A plugin is built the way the `plugins` job builds one. MiniMap
   needs the Unreal Engine headers for its readback adapter, so it is built `MiniMapKeyScanOnly` on the same Plugin SDK
   commit as every key source: the DLL reports `<version>-keyscan` and refuses at PluginInit,
   but every key request runs first. A MiniMap build without `-keyscan` in it is not taken. These DLLs are
   never installed, released or published.
3. The `check` job (it alone has the game files) downloads the artifacts after the login cache is removed, scans each with
   `sr-aobscan --plugin` into `out/keysrc-<name>.json` and writes `out/keysrc.json` (status, commit, number of keyed
   requests). In the layout step each source's keys and uses are read from its source with `layout-table.mjs gen`
   as a component named `<Name>@<branch>`: in `layout-keys.txt` and `layout-uses.txt` (so field and size
   rows exist for them) but not in `layout.json`, so no gate or pdb-diff reads them. The step records
   `layout: ok` in `keysrc.json`. A key source never changes what the check job reports.
4. A key source that did not build, was not scanned or had no keys read does not fail map mode. The step
   "Settle the key sources" names it in the run summary and as a line of the pipeline-alert issue
   (`key source <repo>@<branch> (<sha12>, checked the branch, not an installed DLL): <cause>`, from
   `alerts.json`), and map mode goes on without the keys only that source requests. A list that was
   refused or could not be resolved still stops the run. Every source builds against the Plugin SDK fork
   branch `gss/sdk-dev` at the commit `KEY_SDK_REF` in the workflow `env`, the one place that names it
   (move it with sr-update's pin; MiniMap's key-scan keeps its own). Then the
   scans builder adds each source's scan after the released plugin scans: owner the name the plugin reports,
   `tracked: true`, rank `current`, tag `<repo>@<branch>`.

A key source is a source of observations and nothing else. It is not in `plugins.json`, so not in decide's
plugin verdicts, `expect_refused`, rule 3 or auto-apply; it is not in the client rig's set
(`ci/client-rig-set.ps1` reads the `plugins` input); it is not a candidate, not staged and not in the feed. Tests
(`ci/client-check-workflow.test.mjs`) hold each of these.

**Patterns in key sources (for plugin authors).** A key source is built with `SR_KEY_SOURCE_BUILD` defined (the
version tag of its DLL is `keysource`); no shipped build has it. Wrap a global function key's pattern in
`PLUGIN_MAP_PATTERN(...)` (Plugin SDK, `plugin_map.h`): the map run still sees the pattern and records the
row, while a shipped build passes `nullptr` and the loader uses only the row. A site (scoped) key must keep
its pattern at run time, so do not wrap it.

```cpp
// Global function key: the pattern is only for the map run.
PluginMap::FunctionAs<void (*)(SDK::UWorld*)>(scan, self, "UWorld::BeginPlay", PLUGIN_MAP_PATTERN(kBeginPlayPattern));
```

**Duplicate observations.** A key a released plugin and a key source both request is one row: rows group by
(key, fp), and the first resolved row in the order of the Step 27 plan supplies the locator. Released scans come
first in `scans.json`, and the sort keeps input order among equal owners and ranks, so the released plugin's row
wins and the row's `from` names `<Owner> current`. A key only a source requests gets its row from the source
(`from` is `<Owner> <repo>@<branch>`). Resolved rows at different addresses still refuse the write, as for any two
scans.

**A key source never gates.** The release the scans builder gives a source's scan carries `keySource: true`, and
two rules follow from it:

- One key per symbol. When a source's key names a symbol that a plan plugin's key also names, the plan
  plugin's key wins: the source key is dropped, with a note (`<key>: asked for by key source <tag> at <rva>, where
  the released map has <key2>; no row`) and an alert line (`key source <tag> (<sha>, checked the branch, not an
  installed DLL): asks for <key> at <rva>, which the released map names <key2>; that branch is stale`). The
  dropped key is listed in `absences`, so `complete` does not count it missing when an earlier row has it. Two plan plugins on one symbol, a plan plugin
  against itself, and two source keys alone on one symbol still refuse.
- Compiled sizes (`field-rows.mjs`). A use of `size <Class> compiled` that comes only from a key source (a
  component named `<Name>@<branch>`; `--sources <commits.json>`, written by the scans builder, supplies its tag and commit) on a class whose size changed is a note and an alert line (`<plugin> key
  source <tag> (<sha>, checked the branch, not an installed DLL): compiles the size of <Class>, which changed on CL-<n>; that build needs SR_SIZE_CHECK or live`), not a
  refusal; the class-key size row is still written. A plan plugin's compiled use still refuses.

Both kinds of alert line go to `map-mode-report.json` and `field-rows.json` (`alerts`), and the alert job lists them as
review lines: loud, but they do not fail the chain.

The alert lines say what was checked (the branch at a commit), never what is installed.
Other checks still apply to a key source's rows: one key at two addresses, a request-tuple clash, and a key
at a symbol's start that stays.

## The workflow chain

```
sr-watch (poll Steam, every build)
  -> client-check: build, plugin-plan, plugins, key-sources, check
  -> map-mode (assemble, write, field-rows, decide, export, sign k1, stage, promote plan)
  -> push-loader (auto/update-<CL> to the loader fork)
  -> candidate-loader (build the candidate loader and plugins)
  -> rig-branch + rig-other (client rig on each Steam branch)
  -> rig-gate (both PASS)
  -> feed-plan, feed-loader, rig-feed, rig-feed-other, feed-loader-cleanup, feed-gate (public runs: the feed-path rig on each branch's build, PASS or a named skip)
  -> publish (public runs, autopilot on (or a first publish), rigs and feed gate pass; sign k2, upload, verify the upload)
  -> vmap-publish.yml (loader repo, every 15 min: verify, upload to Latest)
  -> players' loaders
```

The feed-path rig (public runs) tests the feed the way players get it. It builds the
loader of AlienX's Latest release tag with one define, `VMAP_TRUST_TEST_KEY`, set in the
`CL` environment variable of the build step (no source change; the build log must show
it reached the compiler). The rig puts this run's TEST-signed feed in the loader's feed
cache and the verdict checks that the loader applied it and took rows from it. A missing
feed, or a feed without the CL, fails. The gate has two legs on the same loader build: the CL
the run checked (`rig-feed`) and the CL the other Steam branch runs, when the candidate map holds
it (`rig-feed-other`, after the first rig). It compares the feed's rows for each CL
with the release tag's compiled map (`feedDelta` in `version-map.mjs`). It skips, with that
reason, only when the feed adds no row and changes no row for that CL: then the loader runs on
the compiled rows with or without the feed. A row the tag lacks, or holds with other values,
is a row the feed delivers, so the rig runs and has to pass. Publish needs the gate to PASS
or skip, and any failed leg fails it. The build is a rig input, never a release asset. It trusts the TEST key, so the
`feed-loader-cleanup` job deletes its artifact as soon as the rig has ended, on every outcome.
It is not built inside the rig job because that job holds the live Steam login and no build code
runs there.

A proof run of this path (dispatch only, publish off) can name `feed_loader_ref`, a branch of
`msantoro12/StarRupture-ModLoader`, which the rig then builds instead of the Latest release,
for example a branch without public's rows, so the feed is their only source. It is refused
with `publish` on or a name that is not a plain branch, and `sr-watch` cannot set it.

`proof_run` (dispatch only, `public` with `publish` and `test_autopilot` off, else map mode refuses it) carries the CL public already runs, which the header already maps, through the whole chain: G3 passes the same CL, its field rows take the build as its own reference, the candidate goes to `auto/update-<CL>-<run>-<attempt>` (never the plain name), both rigs and the rig gate run, and the run is marked a test, so it never publishes. The push needs the candidate to differ from the loader's header (it adds the CL's field rows while the header lacks them). The feed-path rig runs only when the feed adds or changes rows over the loader it builds: pair `proof_run` with `feed_loader_ref` (a branch without the CL's rows) to be sure it runs.

The `map-mode` job of `sr-client-check.yml` (input `map_mode`, passed on by
`sr-watch.yml`) is the unattended path M on one build. It reads only the check
job's artifacts, the loader's header and the `vmap-feed` release: no Steam login,
no plugin code, no game file.

1. `map-mode.mjs assemble` (with the check's `carry.json`), `write` and then `complete`
   put the observations in the header and fail the job if a key with an earlier row is
   left with none (above). The build
   row is named `<branch> <buildid>`. The build id is the one Steam installed
   (`result.json` `download.buildid`), else the `buildid` input (a manual dispatch
   can give it; the poller always does), else the job stops. A plugin is tracked
   when its repo is in the built `plugins` list.
2. `field-rows.mjs write` from the PDB layouts of the check (`layout-target.json`,
   `layout-reference.json`, `layout-keys.txt`, `ci/native-keys.txt`). A refusal (exit 3) does
   not fail the job; it writes the report and decide holds. Any other failure (exit 2, a
   missing or malformed input) fails the job. The check writes `layout-reference.json` only
   when it has an older build to compare with (not on the `public` branch, which has no older
   build to download). On `public` the step reads the stored layout instead (see "Where the
   reference layout comes from" under Step 28). With no reference at all the step runs with no
   `--base` and field-rows refuses while a reflected key is listed, so decide holds with that
   reason.
3. `decide.mjs` with the gates built from the check: G1 the builds, G2 the check, G3
   the CL against the one the header was built for, G4 the client registry scan (the
   client check alone decides; no dedicated-server scan is read), G5 the classes
   the layout diff moved, changed or lost, the plugin verdicts (`plugins.json`), then
   the field rows, and the history on the `vmap-feed` release for the rate limits.
4. On path M, or on the HOLD that only the autopilot caused (the candidate chain, above):
   `export-feed` (every CL in the header; the step summary names them and the size), sign with the TEST key (k1, `VMAP_SIGN_KEY_TEST`) and verify it,
   `staging.mjs stage` for a build not on `public` yet, and `promote.mjs plan`. All dry runs. Then, for
   a staged build, the `push-loader` job pushes `auto/update-<CL>` to the loader fork.
   The chain writes `verify.json` from this run's re-scan and marks the run publishable
   for a promotion, or for `public`'s own build on a new CL with nothing staged (the
   normal flow).
5. The `publish` job, below ("The publish path"). `sr-watch.yml` passes `publish: true` and
   only these secrets, by name: the Steam login (`STEAM_CI_USERNAME`, `STEAM_CI_LOGIN_CACHE`, so the
   called `check` job reads them from `steam-client`), `VMAP_SIGN_KEY_TEST`, the loader fork's deploy key
   `SR_DEPLOYKEY_MODLOADER`, the nine plugin forks' deploy keys
   (`SR_DEPLOYKEY_<PLUGIN>`, read by the `auto-apply` job in `fork-push`) and the release key
   `VMAP_SIGN_KEY`; no `secrets: inherit`. The release key is an environment secret of
   `vmap-sign` that only the `publish` job reads, and it reads empty there unless the caller passes it. Its `client-check` job grants `contents: write` as a ceiling: GitHub checks every
   called job against the caller's permissions when it parses the call; each called job still
   sets its own, and only `publish` asks for write.

### The publish path

The `publish` job runs by itself, with nobody pressing a button, when and only when all of
these hold:

1. The run is for `public`. The feed it signs carries every build in the loader's map, the build
   the other Steam branch runs included (owner, 2026-11-08: every build we can reach).
2. The `publish` input is on: `sr-watch` passes it, a dispatch sets it, and nothing infers it
   from who called. A dispatch without it is a dry run, and a `test_autopilot` run never publishes.
3. `decide` says `M`. That needs `state/autopilot.json` enabled, except for a first publish
   (below), which stands in for it for that one run; while it is off the decision is `HOLD` and the
   job is skipped.
4. `promote.mjs` marks the run publishable, and no test mark is on `decision.json` or
   `promote-plan.json` (checked again in the job).
5. Both client rigs ended with verdict `PASS` on the candidate loader.
6. The feed gate ended `PASS`, or `SKIP` because the feed adds and changes no row for the build of
   either Steam branch.

Just before it signs, the job reads `state/autopilot.json` on main again and stops unless it is
enabled and allows path M, so turning the autopilot off stops a chain that is already running.

It runs in the `vmap-sign` environment (main only), one at a time (`concurrency: vmap-publish`).
It signs the feed the chain staged with the release key k2, uploads it and `vmap-history.json`
to the `vmap-feed` release, then downloads what it published and checks the signature (release
key, no TEST key), the seq and the sha256. The secret is `VMAP_SIGN_KEY`, the environment
`vmap-sign`.

- **Public runs.** Only a run for `public` publishes. The feed it signs is the export of the
  chain's header, every build in it. Before signing, the job cuts the feed again from the chain's
  header and stops if it differs from the staged one.
- **First publish.** The dispatch input `first_publish` (sr-watch cannot pass it) lets one run
  publish the first feed: `public`, `map_mode` and `publish` on, `proof_run` and `test_autopilot`
  off, `loader_repo` `msantoro12/StarRupture-ModLoader` and `loader_ref` a branch
  `auto/update-<CL>-<run>-<attempt>` of it that holds the rows of the build the other Steam branch
  runs now. Before any Steam login the run reads that base header and refuses unless it has a build
  row and function rows for that build (the live Steam build id, or `other_buildid`) and the build
  is not public's; the chain proves it again on the candidate header and on the signed feed. Any
  other combination is refused before the build starts, and `loader_repo` and `loader_ref` are
  checked again in `map-mode` and `push-loader`. Two first publishes share one concurrency group,
  so the second waits and then refuses (a feed exists). For that run decide takes the autopilot as on for
  path M and lets G3 pass a CL that is not newer than the base's (`decide.mjs --first-publish`);
  `state/autopilot.json` is neither read nor changed. The chain adds or verifies public's rows on
  top of the base, requires the feed to carry rows for both CLs, and pushes the candidate under the
  run-suffixed name (or, when it adds no row, uses the base commit itself). Every gate of a normal
  run applies: both candidate rigs, the rig gate, both feed-path legs, the feed gate. The publish
  job refuses when the `vmap-feed` release already carries a feed asset, uploads the feed without
  overwriting, and instead of re-reading the autopilot it requires the chain's first-publish mark
  (and no other chain may carry it). A `vmap-feed` release without a feed asset counts as no feed:
  if the history uploaded and the feed did not, re-run the publish job, or dispatch the first
  publish again (it ignores the history of such a release and writes it anew); nothing is deleted
  by hand.
- **One seq.** `map-mode` computes the seq once (`vmap-sign.mjs next-seq`) and uses that
  number for the TEST signature, the promote plan, the release signature and the history
  entry; the job checks the published feed with `verify --expect-seq`. If another publish
  landed meanwhile and the seq no longer rises above the live one, nothing is signed and the
  chain runs again.
- **Published rows.** The job also checks the feed it is about to sign
  against the live file it just downloaded and fails, before the key is used, if a published line
  is missing or changed (a row in `ci/retired-rows.txt` or `ci/changed-rows.txt` excepted). See
  "The published feed as the base".

The header is always an artifact too. Until the loader fork's deploy key exists
(step 26), the `push-loader` job fails with its cause, and the staging record in
the artifact still names the loader commit the header was read from.

Offline replay (2026-11-01, run 41272795133, CL-128786, a throwaway key): the loader's
header pruned to CL-127004 gives 102 rows written, 557 field rows with 5 absent,
decide M (autopilot copy enabled), a signed and verified feed, a staged
`auto/update-128786` and a promote plan with a seq.

## Alerts

A stuck or failing update has to reach the owner through GitHub's own notifications, with
the cause in the alert. The `alert` job of `sr-client-check.yml` opens (or comments on)
the issue "SR map mode: <branch> needs attention", labelled `pipeline-alert`, assigned to
`msantoro12` and mentioning him. Its lines, each with its cause:

- a failed job (build-scanner, plugin-plan, check, map mode, publish the feed): the cause
  is the check's `result.json` reason, else the failed step and its first error line, from
  the job's failure annotations or else its log (jobs API; `ci/pipeline-alert.mjs`); a map mode that never uploaded its artifact says so;
- a client check that did not run: `result.json` status `skipped` or `no-login`, with the
  reason it recorded;
- a map-mode HOLD, with the decide reasons, except "nothing new" (G3) and the autopilot switch
  alone;
- staged rows that were not pushed (`push-loader`), a candidate loader that did not build or
  pass its tests (`candidate-loader`);
- the rig gate failing, or a rig job that did not end with `success` and verdict `PASS`, with
  the rig's verdict reason and logs artifact.

A HOLD whose only reason is "autopilot is disabled" with everything else passing is the
normal waiting state, not an alert: the PR gets one "Ready, publish held (autopilot off)"
comment (edited in place) and no issue is opened. A run with no alert line labels the PR
`chain-passed-<branch>`. `sr-watch.yml`, when it skips a build because its game-update PR
is open, checks that PR: open over 6 hours and no `chain-passed-<branch>` label for a changed
client branch means the branch's alert issue gets a comment (or is opened), at most once per
6 hours (a `<!-- sr-stale-pr:N -->` marker in the issue or its comments dates the last one).
A PR refreshed by a new build loses its labels.
