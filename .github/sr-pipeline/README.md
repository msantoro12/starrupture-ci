# StarRupture game-update pipeline

Workflows that watch Steam for a new StarRupture build, check that the loader and plugins still compile (one result per component), and check the new client build offline. They run on GitHub-hosted runners with the built-in `GITHUB_TOKEN`. No self-hosted runner. Issues are used only as alerts: `vmap-watchdog.yml`, and the `alert` job of `sr-client-check.yml` (a failed job, or a map-mode HOLD for any reason but "nothing new", opens or updates the issue "SR map mode: <branch> needs attention"). The one secret is the Steam login of a separate CI account, used only by the client check (see "Steam login for the client check").

They live in `msantoro12/starrupture-ci`. The mod repos are checked out from `vars.MOD_OWNER` (default `AlienXAXS`); nothing here writes to them.

```
.github/workflows/sr-watch.yml        Steam watcher
.github/workflows/sr-build-all.yml    compile check
.github/workflows/sr-client-check.yml offline check of a new client build
.github/sr-pipeline/poll-steam.mjs    the polling script sr-watch runs
.github/sr-pipeline/README.md         this file
state/steam.json                      recorded build ids (baseline, on main)
```

## What runs when

| Workflow | Trigger | What it does |
|---|---|---|
| `sr-watch.yml` | cron at :07 and :37 every hour; manual (`force` input) | Polls api.steamcmd.net for app 1631270 and app 3809400 (every branch without a password, for both), plus the newest Steam news title. Retries 3 times per app, then skips that app for the run (warning annotation, no PR). First sight of an app: commits the baseline to `main`, no alert. On a real change against `state/steam.json` on main: pushes a `game-update/<app>-<branch>-<buildid>` branch holding the new ids, opens a PR titled `Game build <id> on <branch>` (label `game-update`) whose body has the changed-build table, the newest news title and the per-component checklist, then runs `sr-build-all.yml` with the PR number and, for each changed client branch, `sr-client-check.yml`. If a `game-update/*` PR is already open, it is updated instead of duplicated; an unchanged build is not re-announced. |
| `sr-build-all.yml` | nightly 03:23 UTC; manual (branch per repo, default `main`; optional `pr`); called by `sr-watch.yml` | `interface-check` (Plugin SDK `PLUGIN_INTERFACE_VERSION` against the loader's `[MIN, MAX]`), `loader` (Client Release and Server Release), `plugin` (BetterDrone, BetterCheats, WAILA, Codex), `report`. Fail-fast is off. `report` writes the job summary and, when a PR number was given, posts the same table as a PR comment: one row per component with status, job link and artifact link, and a static "Game SDK: manual" row. Artifacts hold build outputs only, 3 days retention. |
| `sr-client-check.yml` | called by `sr-watch.yml` per changed client branch (a forced run checks both); manual (`branch`, optional `pr`); weekly Monday 06:17 UTC (login age only) | `build-scanner` builds `sr-aobscan-client.exe` from the loader branch `loader_ref` (default `gss/loader-work`, so the patterns are the live ones) with `tools/AobScan` from `scanner_ref` (default `ci/aobscan`), and reads the loader's required CL (a loader with a version map has none) and the pinned Game SDK's `Offsets::`. `check` (environment `steam-client`) restores the saved steamcmd login, downloads the client build with Valve's steamcmd (`app_update 1631270`, `-beta public_test_branch` for the test branch; steamcmd cannot fetch single files, so it is the full build, about 16-17 GB down and 50 GB on disk), deletes steamcmd and the login cache, then checks the exe: the loader's version gate passes (ProductVersion ends with the required CL; for a loader with a version map, the running CL has a row in its `kBuilds`, as `sr-aobscan` reports from the loader's own gate code in `exe.supported`; a loader with neither fails), every PreflightRegistry pattern resolves (sr-aobscan; the required ones decide pass or fail), and the four Game-SDK globals (GObjects, FName::AppendString, GNames, GWorld) are compared with the SDK's `Offsets::`. `plugin-plan` lists the plugins: each `plugins` entry is `owner/repo@ref` (built from source) or `owner/repo@latest-release` (the repository's latest GitHub release, resolved through the API to its tag, which the report shows; default: MiniMap, from its author LetMeInside). A plugin owned by msantoro12 is built in the `plugins` job; another author's is fetched or built by the `check` job itself, never stored as an artifact, and validated only (see "Adding your plugin to CI"). Owners are msantoro12 and AlienXAXS, plus LetMeInside for `@latest-release`; that code runs on the runner with the same trust as `scanner_ref`. After the login cache is deleted, `sr-aobscan --plugin` runs each plugin's `OnPluginLoadHooks` against the downloaded exe through the loader's own hook scanner. Verdicts: PASS; GAME-CALL (partial coverage, never a full pass: every pattern registered before the first game call resolved, and the calls into game code, which cannot run offline, were stopped and the hook resumed; reads "N/N resolved before first game call; later scans not exercised"); FAIL (any recorded pattern MISSING or AMBIGUOUS: the loader refuses the plugin; a row the second run, with the scan cache warm, answered differently; or a request that resolved whose own pattern does not match the exe exactly once, labelled OWN-MISSING or OWN-AMBIGUOUS, which a map row would otherwise hide); CRASH (a fault in the plugin's own code, or a game call before any pattern resolved); REFUSED (interface version outside the loader's range); NONE (no `OnPluginLoadHooks`); BUILD-FAILED, FETCH-FAILED, ERROR. PASS, GAME-CALL and NONE count as pass. Limit: when a stopped game call returns null and the plugin bails out, every later scan and failure report is skipped, so GAME-CALL can hide a pattern the hook registers only after a successful call (in game the loader would refuse the plugin); it can also read GAME-CALL for a call that would fail in game. Beside the patterns, `Check the fixed offsets` reads each built plugin's source against the PDB layout of the checked build and of the public one: every offset a plugin reads at a raw number and lists in `ci/native-keys.txt` with an anchor must equal the PDB's, or the plugin fails as `OFFSETS` (`OFFSETS-UNCHECKED` when the layout report is missing). The fix step rewrites an offset when one constant is right for every build that matters, and leaves the rest failing. A failing plugin shows in `result.json` under `plugins.status`; the top-level `status` covers the loader only. Artifact `client-check-<branch>` (result.json and the scanner output, 14 days). `report` comments the result on the PR, with the age of the saved login. Without a saved login the check is skipped, green, and the comment says so. `login-expiry` (weekly) goes red when the saved login is within 30 days of its assumed 200-day lifetime. |

Merging the update PR into main means the update is handled: it advances `state/steam.json`, so the watcher stops reporting that build.

### Update path per component

Release lines are always manual, need the owner's OK, and are versioned independently from each repo's own `version` file.

| Component | Today | Later phase hooks in at |
|---|---|---|
| Loader (Client) | compile check; offline client check (`sr-client-check.yml`): CL, pattern scan, SDK globals | n/a |
| Loader (Server) | compile check; placeholder step "Pattern scan" in the `loader` job | that step (the AOB scan tool) |
| BetterDrone, BetterCheats, WAILA, Codex | rebuild against the current SDK (the `plugin` job); offline pattern check of the built DLL (`sr-client-check.yml`) | a sibling job that `needs: plugin` |
| MiniMap (its author's latest release) | offline pattern check of the latest release's DLL (`sr-client-check.yml`, `plugins` as `@latest-release`) | n/a |
| Game SDK | manual dump from a running game | n/a |

## Adding your plugin to CI

CI checks a plugin's patterns against every new StarRupture client build, offline, before any player has the build. Opting in takes one entry in `sr-client-check.yml`; this section says which entry, what is then checked, and how to read a failure.

### Opt in

A plugin is one entry in the `plugins` input of `sr-client-check.yml` (the `workflow_call` default, which `sr-watch.yml` uses, and the `workflow_dispatch` default). Change both defaults in a pull request to this repository. The plugin's `name` in the report is the repository name without `StarRupture-Plugin-`, and a name may be listed only once.

| Source | Checks | Entry | Allowed |
|---|---|---|---|
| `@ref` | the plugin built from source at a ref | `owner/StarRupture-Plugin-Name@ref`, space-separated | owner `msantoro12` or `AlienXAXS`; `ref` is a branch, a tag or a full 40-character commit (resolved to its commit before any plugin code runs) |
| `@latest-release` | the repository's latest GitHub release, as players get it | `owner/StarRupture-Plugin-Name@latest-release` | owner `msantoro12`, `AlienXAXS` or `LetMeInside` |

A plugin in `plugins` is built on a Windows runner: the repository root has exactly one `.sln`, `Client Release|x64` builds, and exactly one DLL lands in `build\Client Release\Plugins`. The build gets `GameSDKRoot` and `PluginSDKInclude` (the Game SDK at `game_sdk_repo` / `game_sdk_ref`, default AlienXAXS `main`; the Plugin SDK at `plugin_sdk_repo` / `plugin_sdk_ref`, default msantoro12 `gss/sdk-work`, which carries `plugin_map.h`, the header the gss plugins include and AlienXAXS's SDK does not have), the loader's own `plugin_interface.h`, and `ModLoaderBuildTag` from a `version` file at the repository root (`dev` without one). A plugin that does not build fails only itself (`BUILD-FAILED`).

`@latest-release` is resolved when the run starts, through GitHub's `releases/latest` API for the repository, which skips drafts and pre-releases (a repository with no published release, or a lookup that fails, fails only that plugin as `FETCH-FAILED`; the other plugins are still checked). The word `latest-release` is reserved, so a branch or tag of that name cannot be used as an `@ref`. The report and `result.json` show the resolved tag (and its commit for a build), so a run says which release it checked. If the release has exactly one `.dll` asset, that asset is what is checked: it is downloaded on the runner and compared with the SHA-256 GitHub recorded for it (a mismatch is `FETCH-FAILED`), so the plugin is checked as players run it, not as CI would build it. If there is no `.dll` asset or more than one, the tag's source is built instead, exactly as a plugin in `@ref` is (`BUILD-FAILED` if it does not build, for instance when the source needs a header the SDK refs do not have; MiniMap's v1.2.0 source did not build in a trial run (a missing include), so for MiniMap the release DLL is what can be checked), and the report says "built from source".

**CI is validation only for another author's plugin.** Anything not owned by msantoro12 (MiniMap, or an `AlienXAXS` plugin) is only read and scanned. It is never published, uploaded, tagged or released: the `plugins` job (which makes the artifact that carries a plugin DLL between jobs) does not handle it (nor any release DLL), the `check` job fetches or builds it on its own runner after the Steam login is deleted, and the files go away with the runner. No workflow here creates a release, tag or Nexus upload for a plugin or writes to a plugin's repository except the auto-apply job's pushes of verified fixes to the owner's nine forks (`sr-build-all.yml` and `engine-test.yml` keep their builds only as workflow artifacts of this repository); the auto-apply job's deploy keys exist only for the nine plugin forks it names and it checks the plugin name and repository before pushing; and the result artifact holds reports (verdicts, scans, and for a failing plugin a proposed patch of its source), never a plugin binary. A fix for another author's plugin is only a patch in the report, for its author to take or leave.

Both sources run on the runner that held the Steam login, so the same trust applies as to the scanner (`scanner_ref`): only the owners above.

An optional second list, `ci/native-keys.txt`, names game members a plugin reads at a fixed offset (`<plugin name> Class::Member [file-suffix:regex]`). They are compared with the PDB layout of the checked build and the public one (see "Check the fixed offsets" in the table above); a mismatch fails the plugin as `OFFSETS`.

### What CI checks on each game build

For each client branch that changed (`public`, `public_test_branch`), `sr-client-check.yml` downloads the build, deletes the Steam login, and runs the plugin's own `OnPluginLoadHooks` against the exe with `sr-aobscan --plugin`. The plugin's real code runs and calls the loader's own scan code, so every pattern it registers is judged the way the loader judges it in game. Game code is never started: a call into the game is stopped and the hook carries on.

1. **A cold scan.** The scan cache is empty, as on a first launch. Every recorded pattern must resolve to exactly one address of the right kind (`MISSING`: none; `AMBIGUOUS`: several; `WRONGKIND`; `BADREQUEST`). Any failure, required or declared optional, refuses the plugin, as the loader would. A miss on a key a declared feature lists turns that feature off instead and is shown as `FEATURES OFF`.
2. **The warm/cold comparison.** The hook runs again with the scan cache the first run filled, as on the next launch. Every row must come out the same (same result, same address). A difference fails the plugin.
3. **Own-pattern uniqueness.** For every request that resolved, the plugin's own pattern is counted on this exe. It must match exactly once, whatever resolved the request, including a map row. Otherwise the row is labelled `OWN-MISSING` (no match) or `OWN-AMBIGUOUS` (two or more) and the plugin fails. The row's `result` stays `OK`; the label is in the table, in the JSON row's `ownPattern` and in the note. A call that lists alternatives (`ResolveRequiredUnique`, `ResolveOptionalUnique`) is not graded on one of them, since only one has to match.
4. **The map rows.** A request carrying a map key is answered by the loader's version map before its own pattern is tried: with a row for the running build, the row's pattern decides and the plugin's own pattern is not scanned; for a build with no row, the latest row's pattern is rescanned together with the plugin's own. The report prints the `[Map]` line saying which locator took the address. On a build other than the one the plugin was built for, the note also says whether the loader would admit the plugin there (it must be built for interface 72 or later and declare `PLUGIN_MAP_MIGRATED`, and a plugin that declares it must take the Game-SDK globals in `PluginInit`).

The second run, the map resolve, the feature handling and the own-pattern grading are in the loader fork's scanner branch `ci/aobscan`, the default `scanner_ref`, so a default run does all of the steps. It holds only `tools/AobScan`, laid over the loader named by `loader_ref`, and does not build on its own.

Each plugin's verdict goes to the PR comment (one row, then a collapsible table of its patterns) and to `result.json` under `plugins`. A failing plugin fails only itself: the loader's verdict is unchanged. PASS, GAME-CALL and NONE count as pass.

### When a plugin fails

| Verdict or label | What it means | What to do |
|---|---|---|
| `FAIL`, row `MISSING` | the pattern matches nowhere in this build: the game code it describes changed | write a new pattern from the new build. CI proposes replacements in the PR comment. For the owner's own plugin forks it also applies a high-confidence proposal, rebuilds, rescans on this build and the public one, and pushes a verified fix to the fork as `auto/update-<CL>` |
| `FAIL`, row `AMBIGUOUS` | the pattern matches two or more places | lengthen it with bytes unique to the function, fewer wildcards, until it matches once |
| `FAIL`, label `OWN-MISSING` | the request resolved (a map row carried it) but the plugin's own pattern matches nothing on this build | the loader has a row you do not control; a loader without that row refuses the plugin. Replace the pattern in the source |
| `FAIL`, label `OWN-AMBIGUOUS` | the same, but the pattern matches several places: it passes only because the map is carrying it | lengthen the pattern until it matches exactly once on every build CI checks (the checked build and the public one) |
| `FAIL`, "second run ... then ..." in the note | the result depended on the scan cache | the pattern's result changed once the cache was warm: make the scan deterministic (one pattern or one candidate list that always agrees) |
| `CRASH` | a fault in the plugin's own code in `OnPluginLoadHooks`, or a call into the game before any pattern resolved | keep `OnPluginLoadHooks` to resolving patterns; touch game state in `PluginInit` or later |
| `REFUSED` | `interface_version` is outside the loader's `[MIN, MAX]` | rebuild against the loader's current `plugin_interface.h` |
| `GAME-CALL` | partial coverage, counted as pass: the patterns before the first game call resolved, later scans were not exercised | none needed; to cover the rest, register the patterns before the first call into game code |
| `NONE` | no `OnPluginLoadHooks` export, nothing to check | none |
| `OFFSETS`, `OFFSETS-UNCHECKED` | a fixed offset does not match this build's PDB, or could not be checked | change the constant, or add the member to `ci/native-keys.txt` |
| `BUILD-FAILED`, `FETCH-FAILED`, `ERROR` | the plugin did not build, its release DLL could not be fetched or did not match GitHub's recorded SHA-256, or the scan could not run | see the job log |

To reproduce a result, run the scanner the workflow builds (the artifact `sr-aobscan-client-<branch>`) on an exe and your DLL: `sr-aobscan-client.exe <exe> --plugin <dll>`; add `--json` for the rows with their match counts.

## Build arguments

Copied from the loader's `release.yml` and the plugins' `release.yml` build steps (the same arguments `tools/sr-update.ps1` uses), minus everything that tags, releases or uploads. The loader builds against the Game SDK commit its submodule pins, so `game_sdk_branch` only affects plugins.

## Permissions

`permissions: {}` at the top of each workflow; each job asks for what it needs.

| Job | Permissions | Used for |
|---|---|---|
| `sr-watch` / `poll` | `contents: write`, `pull-requests: write` | baseline commit to main, `game-update/*` branches, label, PR |
| `sr-watch` / `build-all` (caller) | `contents: read`, `pull-requests: write`, `actions: read` | covers the called workflow |
| `sr-build-all` / `interface`, `loader`, `plugin` | `contents: read` | check out and build |
| `sr-build-all` / `report` | `contents: read`, `actions: read`, `pull-requests: write` | list jobs and artifacts, comment on the PR |
| `sr-watch` / `client-check` (caller) | `contents: read`, `pull-requests: write` | covers the called workflow; passes no secrets |
| `sr-client-check` / `build-scanner` | `contents: read` | check out the loader, build the scanner |
| `sr-client-check` / `check` | `contents: read`, environment `steam-client` | the only job that can read the Steam login; checks out no repository |
| `sr-client-check` / `report` | `contents: read`, `pull-requests: write` | comment on the PR; no environment, no secrets |
| `sr-client-check` / `login-expiry` | none | reads the repo variable `STEAM_CI_LOGIN_AT` |

The repo setting "Allow GitHub Actions to create and approve pull requests" must be on (Settings, Actions, General, or `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`).

## Steam login for the client check

The client check logs in with a separate Steam account that owns StarRupture, never the owner's main account. Its password never reaches CI: `steam-ci-login.ps1` (on the owner's PC) runs Valve's steamcmd from a private folder, the owner types the password and the Steam Guard code into steamcmd's own prompt, and the script saves steamcmd's login cache (`config/config.vdf`, whose `ConnectCache` entry holds the refresh token), base64-encoded, to:

- Bitwarden Secrets Manager, project `dev`: `STEAM_CI_USERNAME`, `STEAM_CI_LOGIN_CACHE`
- this repo's environment `steam-client` (deployment branch: `main` only): the same two secrets
- repo variable `STEAM_CI_LOGIN_AT`: the date of the login, for the expiry warning

`-Renew` does the same fresh login (password and Steam Guard code again) for the account name saved in Bitwarden. When a run fails with "login expired, run steam-ci-login.ps1 -Renew", do that. The workflow has no `pull_request` trigger and the environment only serves `main`, so the login is never reachable from a pull request or another branch. In the `check` job the decoded token values and the account name are masked, account ids are cut from the steamcmd output, and steamcmd with its cache is deleted before the scanner runs. That does not isolate the scanner: it runs in the same job, whose process holds the secret in memory. So whoever can push to the loader branches it is built from (`loader_ref`, `scanner_ref`; `loader_repo` is limited to `msantoro12` or `AlienXAXS`) can reach the Steam login, as can whoever can push to `main` here. The `check` job runs only the scanner `build-scanner` made in the same run (SHA-256 checked).

To revoke: delete the environment `steam-client` (and the Bitwarden secrets) and deauthorize the account's devices at store.steampowered.com/twofactor/manage.

## Testing the update path

1. Seed: `gh workflow run sr-watch.yml`. Expect a green run, "Seeded baseline" in the summary, no PR, and `state/steam.json` on main.
2. Commit an older client public `buildid` into `state/steam.json` on main, then run the watcher again.
3. Expect: a `game-update/...` PR with the checklist, a `build-all` run, and when it finishes a PR comment with one row per component.
4. Merge the PR; main holds the current ids again.

## Limits

- `GITHUB_TOKEN` cannot act on other repositories, so nothing here dispatches or edits a mod repo.
- A PR opened with `GITHUB_TOKEN` does not start other workflows, so the watcher calls `sr-build-all.yml` with `workflow_call`.
- A scheduled workflow is switched off after 60 days without repository activity. `sr-keepalive.yml` runs monthly and calls the workflow `enable` API (`actions: write`, no push) for `sr-watch.yml`, `sr-build-all.yml`, `sr-client-check.yml` and itself, which resets the timer. It is a plain `gh api` call, not a third-party action.
- Persistent API trouble is a log warning, not a red run; look for "SKIPPED (API failure)" in the summary.
- None of the mod repos' release workflows are called or referenced from here.
