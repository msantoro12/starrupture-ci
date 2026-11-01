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
