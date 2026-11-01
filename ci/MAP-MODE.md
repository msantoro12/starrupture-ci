# Map mode

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
that neither the current nor the previous release carries are pruned.

It refuses, naming the keys: two keys for one symbol; one key at two addresses; a
global key off a symbol's start; two request tuples under one `fp` of one key; a
required key (the loader's) without a locator, for a scoped one under the newest
release's `fp`; a different verified row already there for a key, `fp` and CL; a
coverage problem of the written map when key lists are given.

The result does not depend on the order of the input, and a second run on its own
output adds nothing.

## Assembling the input from the harness

\
 is ,
each  a  output (the registry scan for , a
 scan for a plugin), read relative to the spec. The CL and the build's
stamp and size come from the registry scan's  block when the spec does not
give them;  is the build's origin text. A row without a  (a raw scan,
a legacy hookName call) is not a map request and is left out; only the loader's
rows are . A scan whose  is not the  is refused.

 runs both commands in its  job when the input
 is true: it takes the check job's scans and the loader's header at
, and uploads the rewritten header and the report as the artifact
. Not yet wired: the scans of each tracked component's
previous release (), the key lists (), and the push of the
header to the loader fork (step 26).

The harness side of this input (plugin scan rows printing , ,  and
, the suggester's  and kinds  and ) is in the
scanner repo's , not here. A plugin row prints no
 (its request has none); the suggester's  is the
offset of the instruction start inside the pattern, as  reads it.
