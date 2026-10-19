#!/usr/bin/env bash
# Keep the licensed terminology sidecars out of the published images (D17), in the stack's private bucket.
#
#   bash .github/scripts/terminology-store.sh pull   <dir>            # the bucket's copies -> <dir> (best effort)
#   bash .github/scripts/terminology-store.sh seed   <dir> <image>    # an older image's copies -> <dir>, only if
#                                                                     # <dir> is still empty (best effort)
#   bash .github/scripts/terminology-store.sh collect <dir>           # the vendored sidecars -> <dir>/<sha256>.json
#   bash .github/scripts/terminology-store.sh push   <dir>            # <dir> -> the bucket (must succeed)
#   bash .github/scripts/terminology-store.sh assert-clean <image>    # fail if the image holds any sidecar
#
# The sidecars carry AMA CPT and SNOMED CT codes, and the image package is anonymously pullable, so a sidecar
# COPIED into an image is republished by every deploy. The deploy now vendors them as before, uploads each to
# its stack's evidence bucket under terminology/<sha256>.json (the hash the committed manifest pins), builds
# the image without them, and the backend fetches them back at boot (src/wiring/terminology-fetch.ts).
#
# <dir> holds copies named by their pin, the same layout `--fallback-dir` reads: when VSAC no longer
# reproduces a pin, the vendor scripts restore it from there and the pin check judges the copy.
#
# The bucket and its credentials are the stack's evidence-bucket ones (TERMINOLOGY_BUCKET, AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, TERMINOLOGY_ENDPOINT, AWS_DEFAULT_REGION=auto), set by the calling step.
set -euo pipefail

PREFIX="terminology/"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

s3_url() { echo "s3://${TERMINOLOGY_BUCKET:?TERMINOLOGY_BUCKET is not set}/${PREFIX}"; }

# Copy every terminology.json under <measures> into <dir> as <sha256>.json. Prints how many it copied.
collect_sidecars() {
  local measures="$1" dir="$2" file hash count=0
  mkdir -p "$dir"
  while IFS= read -r -d '' file; do
    hash="$(sha256sum "$file" | cut -d' ' -f1)"
    [ -n "$hash" ] && cp "$file" "${dir}/${hash}.json" || return 1
    count=$((count + 1))
  done < <(find "$measures" -mindepth 3 -maxdepth 3 -name terminology.json -print0)
  echo "$count"
}

# The sidecar paths in ANY of an image's layers, one per line; empty when none holds one. Every layer, not the
# final filesystem: a file added in one layer and deleted in a later one is still published in the first.
sidecars_in_image() {
  local image="$1" tmp blob
  tmp="$(mktemp -d)"
  if ! docker save "$image" -o "${tmp}/image.tar" || ! mkdir "${tmp}/x" || ! tar -xf "${tmp}/image.tar" -C "${tmp}/x"; then
    rm -rf "$tmp"
    return 1
  fi
  while IFS= read -r -d '' blob; do
    # Non-tar blobs (the image config, manifests) list nothing.
    tar -tf "$blob" 2>/dev/null | grep -E '(^|/)terminology\.json$' || true
  done < <(find "${tmp}/x" -type f -print0)
  rm -rf "$tmp"
}

main() {
  local command="${1:-}"
  case "$command" in
    pull)
      local dir="${2:?usage: pull <dir>}"
      mkdir -p "$dir"
      # Best effort: an unreachable bucket only removes the second line, and VSAC may still reproduce every pin.
      if aws s3 sync "$(s3_url)" "$dir" --endpoint-url "${TERMINOLOGY_ENDPOINT:?TERMINOLOGY_ENDPOINT is not set}" --only-show-errors; then
        echo "terminology copies from the bucket: $(find "$dir" -name '*.json' | wc -l)"
      else
        echo "::warning::the terminology bucket could not be read; a sidecar VSAC does not reproduce cannot be restored"
      fi
      ;;
    seed)
      # Until the images that still carry sidecars are deleted, the last one is a second source for the
      # first deploys into an empty bucket. Best effort; a no-op once that image holds none.
      local dir="${2:?usage: seed <dir> <image>}" image="${3:?usage: seed <dir> <image>}" container tmp
      if [ -n "$(find "$dir" -name '*.json' -print -quit 2>/dev/null)" ]; then
        echo "the bucket's copies are restored; not seeding from ${image}"
        return 0
      fi
      tmp="$(mktemp -d)"
      if container="$(docker create "$image" 2>/dev/null)"; then
        docker cp "${container}:/app/backend-ts/measures" "${tmp}/measures" >/dev/null 2>&1 || true
        docker rm "$container" >/dev/null 2>&1 || true
        [ -d "${tmp}/measures" ] && echo "terminology copies from ${image}: $(collect_sidecars "${tmp}/measures" "$dir")"
      else
        echo "no copies seeded: ${image} could not be read"
      fi
      rm -rf "$tmp"
      ;;
    collect)
      local dir="${2:?usage: collect <dir>}"
      echo "vendored sidecars collected: $(collect_sidecars "${repo_root}/backend-ts/measures" "$dir")"
      ;;
    push)
      local dir="${2:?usage: push <dir>}"
      # Not best effort: an image without its sidecars boots refusing every routed measure.
      # Explicit, not left to `set -e`: bash ignores errexit inside a caller's `if`, and this must never pass.
      if ! aws s3 sync "$dir" "$(s3_url)" --endpoint-url "${TERMINOLOGY_ENDPOINT:?TERMINOLOGY_ENDPOINT is not set}" --only-show-errors; then
        echo "::error::the terminology could not be stored in the bucket; the image would boot without it" >&2
        return 1
      fi
      echo "terminology copies in the bucket: synced $(find "$dir" -name '*.json' | wc -l)"
      ;;
    assert-clean)
      local image="${2:?usage: assert-clean <image>}" found
      if ! found="$(sidecars_in_image "$image")"; then
        echo "::error::${image} could not be inspected, so it must not be pushed" >&2
        return 1
      fi
      if [ -n "$found" ]; then
        echo "::error::${image} holds licensed terminology and must not be pushed:" >&2
        echo "$found" >&2
        return 1
      fi
      echo "${image} holds no terminology sidecar"
      ;;
    *)
      echo "usage: terminology-store.sh pull|seed|collect|push|assert-clean ..." >&2
      return 2
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
