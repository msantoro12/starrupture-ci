#!/usr/bin/env bash
# The publish routine of the signed plugin catalog (plugin-catalog.v1.txt), for the live vmap-feed release and for a
# rehearsal's staging prerelease. The catalog has its own seq and no history: it is not made per game CL, so
# ci/vmap-publish.sh (whose history is keyed per CL) is not used for it.
#
#   bash tool/ci/plugin-catalog-publish.sh last-seq <target release> live|staging
#   bash tool/ci/plugin-catalog-publish.sh publish  <target release> live|staging
#
# Run from the job's work directory, which holds the signed catalog (plugin-catalog.v1.txt). Environment: GH_REPO,
# GITHUB_STEP_SUMMARY. `live` is the release named vmap-feed and no other; `staging` is any other release (the
# vmap-feed-rehearsal prerelease), so a staging call can never name the live release.
#
#   last-seq  Prints the seq of the catalog the target release holds now: 0 when it holds none, a stop when the file
#             it holds does not verify. The seq of a catalog counts on its own, not with the version map's.
#   publish   Refuses, before anything is uploaded, a file that does not verify as a signed plugin catalog (a version
#             map, a changed byte, a wrong key: `vmap-sign.mjs verify --kind catalog`), and one whose seq does not
#             rise above the target's. Then uploads it to the target release only, downloads it as the loader will and
#             checks the signature, the seq and the sha256. A live call takes the release key (k2) only; a staging call
#             also takes the TEST key (k1). The first live publish never replaces a catalog; a later one does.
#
# Exit 0 ok, 2 stopped.

set -euo pipefail

phase="${1:-}"
target="${2:-}"
kind="${3:-}"
asset=plugin-catalog.v1.txt
sign=tool/ci/vmap-sign.mjs
usage() { echo "usage: plugin-catalog-publish.sh last-seq|publish <target release> live|staging" >&2; exit 2; }
case "$phase" in last-seq | publish) ;; *) usage ;; esac
[ -n "$target" ] && { [ "$kind" = live ] || [ "$kind" = staging ]; } || usage
if [ "$kind" = live ] && [ "$target" != vmap-feed ]; then echo "::error::a live publish goes to the release vmap-feed, not $target" >&2; exit 2; fi
if [ "$kind" = staging ] && [ "$target" = vmap-feed ]; then echo "::error::a staging publish never goes to the live release vmap-feed" >&2; exit 2; fi
trust=()
if [ "$kind" = staging ]; then trust=(--allow-test-key); fi

# Whether the target release exists: 0 yes, 1 no (the release is not found); any other failure stops the routine.
release_exists() {
  local err
  if err="$(gh release view "$target" 2>&1 > /dev/null)"; then return 0; fi
  case "$err" in *"not found"*) return 1 ;; esac
  echo "::error::the release $target cannot be read: $err" >&2; exit 2
}

# The seq of the catalog the target holds, 0 when it holds none.
published_seq() {
  local has out
  if ! release_exists; then
    [ "$kind" = staging ] || { echo "::error::the live release $target does not exist" >&2; exit 2; }
    echo 0; return
  fi
  has="$(gh release view "$target" --json assets --jq ".assets | any(.name == \"$asset\")")"
  [ "$has" = true ] || { echo 0; return; }
  rm -rf current
  gh release download "$target" --pattern "$asset" --dir current --clobber
  out="$(node "$sign" verify "current/$asset" --kind catalog "${trust[@]}")" \
    || { echo "::error::the catalog on $target does not verify, so its seq is unknown and nothing is uploaded over it" >&2; exit 2; }
  echo "${out#ok seq=}" | cut -d' ' -f1
}

if [ "$phase" = last-seq ]; then
  published_seq
  exit 0
fi

# publish
[ -f "$asset" ] || { echo "::error::$asset is not in the work directory"; exit 2; }
out="$(node "$sign" verify "$asset" --kind catalog "${trust[@]}")" \
  || { echo "::error::$asset does not verify as a signed plugin catalog, so nothing was uploaded"; exit 2; }
seq="$(echo "${out#ok seq=}" | cut -d' ' -f1)"
if [ "$kind" = live ]; then
  [ "$out" = "ok seq=$seq key=k2" ] || { echo "::error::a live catalog is signed with the release key k2: $out"; exit 2; }
fi
last="$(published_seq)"
[ "$seq" -gt "$last" ] || { echo "::error::the catalog's seq $seq does not rise above the seq $last on $target; nothing was uploaded"; exit 2; }
echo "catalog seq $seq above the published seq $last"

clobber=(--clobber)
if release_exists; then
  # The first live publish uploads without --clobber, so a catalog that is there is never replaced by it.
  has="$(gh release view "$target" --json assets --jq ".assets | any(.name == \"$asset\")")"
  if [ "$kind" = live ] && [ "$has" != true ]; then clobber=(); fi
elif [ "$kind" = staging ]; then
  gh release create "$target" --prerelease --latest=false --title "Version map feed rehearsal" --notes "Signed files of rehearsal runs. Not read by the loader; never the live feed."
else
  echo "::error::the live release $target does not exist"; exit 2
fi
if [ "$kind" = staging ]; then
  [ "$(gh release view "$target" --json isPrerelease,isDraft --jq '.isPrerelease and (.isDraft | not)')" = true ] \
    || { echo "::error::$target is not a published prerelease; nothing was uploaded to it"; exit 2; }
fi
gh release upload "$target" "$asset" "${clobber[@]}" \
  || { echo "::error::the catalog (seq $seq) did not upload to $target"; exit 2; }

rm -rf published
gh release download "$target" --pattern "$asset" --dir published --clobber
check="$(node "$sign" verify "published/$asset" --kind catalog "${trust[@]}" --expect-seq "$seq")" \
  || { echo "::error::the catalog on $target does not verify as seq $seq after the upload"; exit 2; }
echo "$check"
want="$(sha256sum "$asset" | cut -d' ' -f1)"
got="$(sha256sum "published/$asset" | cut -d' ' -f1)"
[ "$want" = "$got" ] || { echo "::error::the published $asset has sha256 $got, not the $want that was signed and uploaded"; exit 2; }
echo "$asset sha256 $got"
if [ "$kind" = live ]; then
  echo "### Published the plugin catalog to $target: seq $seq, release key k2, sha256 $got" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
else
  echo "### Rehearsal: staged the plugin catalog on $target (prerelease): seq $seq, sha256 $got. The live release was not written." >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
fi
