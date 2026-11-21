#!/usr/bin/env bash
# The publish routine of the version object map, one for the live release and for a rehearsal's staging prerelease.
# Only the target release changes between them; the order, the checks and the history handling are the same.
#
#   bash tool/ci/vmap-publish.sh entry
#   bash tool/ci/vmap-publish.sh feed    <target release> live|staging
#   bash tool/ci/vmap-publish.sh verify  <target release> live|staging
#   bash tool/ci/vmap-publish.sh history <target release> live|staging
#
# Run from the job's work directory, which holds the signed feed ($VMAP_ASSET) and, once `entry` has run,
# vmap-history.json. Environment: GH_REPO, CHAIN_SEQ, FIRST_PUBLISH, GITHUB_STEP_SUMMARY, RETRY_CL, ACTOR, RUN_ID, and
# two that name what is published (the defaults are the client's; the dedicated server's file sets both):
#   VMAP_ASSET         the feed's file name: version-map-client.v1.txt, or version-map-server.v1.txt
#   VMAP_HISTORY_REPO  the repo part of the history key (<repo>:<CL>): ModLoader, or ModLoaderServer
#
#   entry    Writes vmap-history.json: the live history (live/vmap-history.json, read again by the publish job), a
#            retry_cl reset for that one CL if there is one, then this release upserted by its key (one entry per CL,
#            the newest seq, `supersedes` naming the seq it replaced).
#   feed     Refuses a feed or a history that lists one version twice, before anything is uploaded. Prints the one
#            command that writes the history (the restore command), to the log and the job summary, BEFORE the upload.
#            Then uploads the feed.
#   verify   Downloads the feed as the loader will and checks its signature, seq and sha256.
#   history  Uploads the history last (three tries) and checks the uploaded copy.
#
# The feed goes first and is verified, the history last, so a stop between them leaves the feed live with no history
# entry (a re-run is held, a supersede is refused) and the restore command in the log and the summary says how to
# write the entry. Exit 0 ok, 2 stopped.

set -euo pipefail

phase="${1:-}"
target="${2:-}"
kind="${3:-live}"
asset="${VMAP_ASSET:-version-map-client.v1.txt}"
history_repo="${VMAP_HISTORY_REPO:-ModLoader}"
case "$asset:$history_repo" in
  version-map-client.v1.txt:ModLoader | version-map-server.v1.txt:ModLoaderServer) ;;
  *) echo "::error::VMAP_ASSET and VMAP_HISTORY_REPO name no known pair ($asset, $history_repo): client file with ModLoader, server file with ModLoaderServer" >&2; exit 2 ;;
esac

if [ "$phase" = entry ]; then
  # Built from the live history read again just before signing, not the copy the chain made when it started.
  hist=live/vmap-history.json
  if [ -n "${RETRY_CL:-}" ]; then
    node tool/ci/vmap-history.mjs retry --history "$hist" --cl "$RETRY_CL" --actor "$ACTOR" --run "$RUN_ID" --out history.retried.json
    hist=history.retried.json
  fi
  cl="$(node -p "JSON.parse(require('fs').readFileSync('chain/decision.json','utf8')).cl")"
  replaced="$(node -p "JSON.parse(require('fs').readFileSync('chain/decision.json','utf8')).supersedes ?? ''")"
  sup_flag=()
  if [ -n "$replaced" ]; then sup_flag=(--supersedes "$replaced"); fi
  node tool/ci/vmap-history.mjs record --history "$hist" --repo "$history_repo" --cl "$cl" --seq "$CHAIN_SEQ" --out vmap-history.json "${sup_flag[@]}"
  exit 0
fi

[ -n "$target" ] && { [ "$kind" = live ] || [ "$kind" = staging ]; } || { echo "usage: vmap-publish.sh entry | feed|verify|history <target release> live|staging" >&2; exit 2; }
if [ "$kind" = live ]; then place="the live release"; held="; a re-run is held and a supersede is refused until the history holds its entry"; else place="the staging release $target"; held=""; fi

case "$phase" in
  feed)
    # One entry per CL, one row per build: a history or a feed that lists a version twice is never uploaded.
    node tool/ci/vmap-history.mjs check --history vmap-history.json \
      || { echo "::error::vmap-history.json lists one version twice, so nothing was uploaded"; exit 2; }
    node tool/ci/vmap-sign.mjs unique "$asset" \
      || { echo "::error::the signed feed lists a build or a row twice, so nothing was uploaded"; exit 2; }
    # The one command that writes this release's history entry, for the case where the feed goes up and the
    # history does not follow. The history is carried inside it (base64: no quoting to get wrong), so it works
    # from any shell that is logged in to gh.
    {
      if [ "$kind" = live ]; then
        echo "If the feed (seq $CHAIN_SEQ) is live and the history entry for it is not written, nothing can release this CL again: a re-run is held (the live feed covers it) and a supersede is refused (the history lacks seq $CHAIN_SEQ). One command writes the entry:"
      else
        echo "If the staged feed (seq $CHAIN_SEQ) is up on $target and its history is not written, one command writes it:"
      fi
      echo
      echo "echo $(base64 -w0 vmap-history.json) | base64 -d > vmap-history.json && gh release upload $target vmap-history.json --clobber --repo $GH_REPO"
    } > history-recovery.txt
    { echo "### If this job stops after the feed upload and before the history is written"; echo; cat history-recovery.txt; } | tee -a "$GITHUB_STEP_SUMMARY"
    if [ "$kind" = live ]; then
      gh release view "$target" > /dev/null 2>&1 || gh release create "$target" --title "Version map feed" --notes "The signed version map feed the loader fetches."
    else
      gh release view "$target" > /dev/null 2>&1 || gh release create "$target" --prerelease --latest=false --title "Version map feed rehearsal" --notes "Signed feeds of rehearsal runs (sr-watch, rehearsal input). Not read by the loader or by vmap-publish; never the live feed."
      [ "$(gh release view "$target" --json isPrerelease,isDraft --jq '.isPrerelease and (.isDraft | not)')" = true ] \
        || { echo "::error::$target is not a published prerelease; nothing was uploaded to it"; exit 2; }
    fi
    # The first publish uploads the feed without --clobber, so a feed that is there is never replaced.
    clobber=(--clobber)
    if [ "$kind" = live ] && [ "${FIRST_PUBLISH:-}" = true ]; then clobber=(); fi
    gh release upload "$target" "$asset" "${clobber[@]}" \
      || { echo "::error::the feed (seq $CHAIN_SEQ) did not upload; the history was not written and the once-per-CL record is as it was, so a re-run can sign again"; exit 2; }
    ;;
  verify)
    # From here the feed is up: any stop below leaves it there with no history entry.
    trap 'rc=$?; if [ "$rc" -ne 0 ]; then echo "::error::the feed (seq $CHAIN_SEQ) is on $place but this run did not confirm it, and the history entry is not written$held"; { echo "### The feed is up and the history entry is not written"; echo; cat history-recovery.txt; } | tee -a "$GITHUB_STEP_SUMMARY"; fi' EXIT
    # Download the feed as the loader will, and check it against what was signed here.
    gh release download "$target" --pattern "$asset" --dir published --clobber
    out="$(node tool/ci/vmap-sign.mjs verify "published/$asset" --expect-seq "$CHAIN_SEQ")"
    echo "$out"
    case "$out" in "ok seq=$CHAIN_SEQ key=k2") ;; *) echo "::error::the published feed is not seq $CHAIN_SEQ signed with the release key k2: $out"; exit 2 ;; esac
    want="$(sha256sum "$asset" | cut -d' ' -f1)"
    got="$(sha256sum "published/$asset" | cut -d' ' -f1)"
    [ "$want" = "$got" ] || { echo "::error::the published $asset has sha256 $got, not the $want that was signed and uploaded; the history was not written"; exit 2; }
    echo "$asset sha256 $got"
    ;;
  history)
    trap 'rc=$?; if [ "$rc" -ne 0 ]; then { echo "### The feed is up and the history entry is not confirmed"; echo; cat history-recovery.txt; } | tee -a "$GITHUB_STEP_SUMMARY"; fi' EXIT
    up=1
    for try in 1 2 3; do
      if gh release upload "$target" vmap-history.json --clobber; then up=0; break; fi
      echo "the history upload failed (try $try of 3)"
    done
    if [ "$up" -ne 0 ]; then
      echo "::error::the feed (seq $CHAIN_SEQ) is on $place but vmap-history.json did not upload$held: the one command that writes it is in the job summary and below"
      exit 2
    fi
    gh release download "$target" --pattern vmap-history.json --dir published --clobber
    want="$(sha256sum vmap-history.json | cut -d' ' -f1)"
    got="$(sha256sum published/vmap-history.json | cut -d' ' -f1)"
    [ "$want" = "$got" ] || { echo "::error::the published vmap-history.json has sha256 $got, not the $want that was uploaded; the feed (seq $CHAIN_SEQ) is on $place and the history is not confirmed: the one command that writes it is in the job summary and below"; exit 2; }
    echo "vmap-history.json sha256 $got"
    feedsum="$(sha256sum "published/$asset" | cut -d' ' -f1)"
    if [ "$kind" = live ]; then
      echo "### Published the feed: seq $CHAIN_SEQ, release key k2, sha256 $feedsum; history written after it" >> "$GITHUB_STEP_SUMMARY"
    else
      echo "### Rehearsal: staged the feed on $target (prerelease): seq $CHAIN_SEQ, release key k2, sha256 $feedsum. The live release was not written." >> "$GITHUB_STEP_SUMMARY"
    fi
    ;;
  *) echo "usage: vmap-publish.sh entry | feed|verify|history <target release> live|staging" >&2; exit 2 ;;
esac
