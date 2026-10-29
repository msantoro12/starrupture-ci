# StarRupture game-update pipeline

Two workflows that watch Steam for a new StarRupture build and check that the loader and plugins still compile, one result per component. They run on GitHub-hosted runners with the built-in `GITHUB_TOKEN`. No secrets, no self-hosted runner, no Steam login, no Issues.

They live in `msantoro12/starrupture-ci`. The mod repos are checked out from `vars.MOD_OWNER` (default `AlienXAXS`); nothing here writes to them.

```
.github/workflows/sr-watch.yml        Steam watcher
.github/workflows/sr-build-all.yml    compile check
.github/sr-pipeline/poll-steam.mjs    the polling script sr-watch runs
.github/sr-pipeline/README.md         this file
state/steam.json                      recorded build ids (baseline, on main)
```

## What runs when

| Workflow | Trigger | What it does |
|---|---|---|
| `sr-watch.yml` | cron at :07 and :37 every hour; manual (`force` input) | Polls api.steamcmd.net for app 1631270 (branches `public`, `public_test_branch`) and app 3809400 (every non-password branch), plus the newest Steam news title. Retries 3 times per app, then skips that app for the run (warning annotation, no PR). First sight of an app: commits the baseline to `main`, no alert. On a real change against `state/steam.json` on main: pushes a `game-update/<app>-<branch>-<buildid>` branch holding the new ids, opens a PR titled `Game build <id> on <branch>` (label `game-update`) whose body has the changed-build table, the newest news title and the per-component checklist, then runs `sr-build-all.yml` with the PR number. If a `game-update/*` PR is already open, it is updated instead of duplicated; an unchanged build is not re-announced. |
| `sr-build-all.yml` | nightly 03:23 UTC; manual (branch per repo, default `main`; optional `pr`); called by `sr-watch.yml` | `interface-check` (Plugin SDK `PLUGIN_INTERFACE_VERSION` against the loader's `[MIN, MAX]`), `loader` (Client Release and Server Release), `plugin` (BetterDrone, BetterCheats, WAILA, Codex), `report`. Fail-fast is off. `report` writes the job summary and, when a PR number was given, posts the same table as a PR comment: one row per component with status, job link and artifact link, and a static "Game SDK: manual" row. Artifacts hold build outputs only, 3 days retention. |

Merging the update PR into main means the update is handled: it advances `state/steam.json`, so the watcher stops reporting that build.

### Update path per component

Release lines are always manual, need the owner's OK, and are versioned independently from each repo's own `version` file.

| Component | Today | Later phase hooks in at |
|---|---|---|
| Loader (Client, Server) | compile check; placeholder step "Pattern scan" in the `loader` job | that step (the AOB scan tool) |
| BetterDrone, BetterCheats, WAILA, Codex | rebuild against the current SDK (the `plugin` job) | a sibling job that `needs: plugin` |
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

The repo setting "Allow GitHub Actions to create and approve pull requests" must be on (Settings, Actions, General, or `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`).

## Testing the update path

1. Seed: `gh workflow run sr-watch.yml`. Expect a green run, "Seeded baseline" in the summary, no PR, and `state/steam.json` on main.
2. Commit an older client public `buildid` into `state/steam.json` on main, then run the watcher again.
3. Expect: a `game-update/...` PR with the checklist, a `build-all` run, and when it finishes a PR comment with one row per component.
4. Merge the PR; main holds the current ids again.

## Limits

- `GITHUB_TOKEN` cannot act on other repositories, so nothing here dispatches or edits a mod repo.
- A PR opened with `GITHUB_TOKEN` does not start other workflows, so the watcher calls `sr-build-all.yml` with `workflow_call`.
- A scheduled workflow is switched off after 60 days without repository activity. `sr-keepalive.yml` runs monthly and calls the workflow `enable` API (`actions: write`, no push) for `sr-watch.yml`, `sr-build-all.yml` and itself, which resets the timer. It is a plain `gh api` call, not a third-party action.
- Persistent API trouble is a log warning, not a red run; look for "SKIPPED (API failure)" in the summary.
- None of the mod repos' release workflows are called or referenced from here.
