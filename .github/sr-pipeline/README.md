# StarRupture game-update pipeline

Workflows that watch Steam for a new StarRupture build, check that the loader and plugins still compile (one result per component), and check the new client build offline. They run on GitHub-hosted runners with the built-in `GITHUB_TOKEN`. No self-hosted runner, no Issues. The one secret is the Steam login of a separate CI account, used only by the client check (see "Steam login for the client check").

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
| `sr-client-check.yml` | called by `sr-watch.yml` per changed client branch (a forced run checks both); manual (`branch`, optional `pr`); weekly Monday 06:17 UTC (login age only) | `build-scanner` builds `sr-aobscan-client.exe` from the loader branch `loader_ref` (default `gss/loader-work`, so the patterns are the live ones) with `tools/AobScan` from `scanner_ref` (default `ci/aobscan`), and reads the loader's required CL (a loader with a version map has none) and the pinned Game SDK's `Offsets::`. `check` (environment `steam-client`) restores the saved steamcmd login, downloads the client build with Valve's steamcmd (`app_update 1631270`, `-beta public_test_branch` for the test branch; steamcmd cannot fetch single files, so it is the full build, about 16-17 GB down and 50 GB on disk), deletes steamcmd and the login cache, then checks the exe: the loader's version gate passes (ProductVersion ends with the required CL; for a loader with a version map, the running CL has a row in its `kBuilds`, as `sr-aobscan` reports from the loader's own gate code in `exe.supported`; a loader with neither fails), every PreflightRegistry pattern resolves (sr-aobscan; the required ones decide pass or fail), and the four Game-SDK globals (GObjects, FName::AppendString, GNames, GWorld) are compared with the SDK's `Offsets::`. `plugin-plan` lists the plugins: each `plugins` entry (`name@ref`) is built from source in the `plugins` job, and each `plugin_manifests` entry is fetched as players get it, from the update-manifest URL in its sidecar `.json` (default: none, since MiniMap is built from `vmap-develop` in `plugins`; a plugin may not be in both lists). Manifest URLs and the DLL they point to must be GitHub release URLs of a `StarRupture-Plugin-*` repo owned by msantoro12, AlienXAXS or LetMeInside; those released DLLs run on the runner with the same trust as `scanner_ref`. After the login cache is deleted, `sr-aobscan --plugin` runs each plugin's `OnPluginLoadHooks` against the downloaded exe through the loader's own hook scanner. Verdicts: PASS; GAME-CALL (partial coverage, never a full pass: every pattern registered before the first game call resolved, and the calls into game code, which cannot run offline, were stopped and the hook resumed; reads "N/N resolved before first game call; later scans not exercised"); FAIL (any recorded pattern MISSING or AMBIGUOUS: the loader refuses the plugin, or a row the second run, with the scan cache warm, answered differently); CRASH (a fault in the plugin's own code, or a game call before any pattern resolved); REFUSED (interface version outside the loader's range); NONE (no `OnPluginLoadHooks`); BUILD-FAILED, FETCH-FAILED, ERROR. PASS, GAME-CALL and NONE count as pass. Limit: when a stopped game call returns null and the plugin bails out, every later scan and failure report is skipped, so GAME-CALL can hide a pattern the hook registers only after a successful call (in game the loader would refuse the plugin); it can also read GAME-CALL for a call that would fail in game. Beside the patterns, `Check the fixed offsets` reads each built plugin's source against the PDB layout of the checked build and of the public one: every offset a plugin reads at a raw number and lists in `ci/native-keys.txt` with an anchor must equal the PDB's, or the plugin fails as `OFFSETS` (`OFFSETS-UNCHECKED` when the layout report is missing). The fix step rewrites an offset when one constant is right for every build that matters, and leaves the rest failing. A failing plugin shows in `result.json` under `plugins.status`; the top-level `status` covers the loader only. Artifact `client-check-<branch>` (result.json and the scanner output, 14 days). `report` comments the result on the PR, with the age of the saved login. Without a saved login the check is skipped, green, and the comment says so. `login-expiry` (weekly) goes red when the saved login is within 30 days of its assumed 200-day lifetime. |

Merging the update PR into main means the update is handled: it advances `state/steam.json`, so the watcher stops reporting that build.

### Update path per component

Release lines are always manual, need the owner's OK, and are versioned independently from each repo's own `version` file.

| Component | Today | Later phase hooks in at |
|---|---|---|
| Loader (Client) | compile check; offline client check (`sr-client-check.yml`): CL, pattern scan, SDK globals | n/a |
| Loader (Server) | compile check; placeholder step "Pattern scan" in the `loader` job | that step (the AOB scan tool) |
| BetterDrone, BetterCheats, WAILA, Codex | rebuild against the current SDK (the `plugin` job); offline pattern check of the built DLL (`sr-client-check.yml`) | a sibling job that `needs: plugin` |
| MiniMap | offline pattern check of the `vmap-develop` build (`sr-client-check.yml`, `plugins`); the released DLL can be checked by passing its manifest in `plugin_manifests` and leaving MiniMap out of `plugins` | n/a |
| Game SDK | manual dump from a running game | n/a |

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
