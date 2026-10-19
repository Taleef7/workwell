#!/usr/bin/env bash
# The terminology store (D17): copies are named by their pin, a dirty image is refused, a failed upload fails
# the deploy, an unreadable bucket does not, and both deploys use it around the image build.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=terminology-store.sh
source "${repo_root}/.github/scripts/terminology-store.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# ── collect: one copy per sidecar, named by its SHA-256 ────────────────────────
measures="${tmp_dir}/measures"
mkdir -p "${measures}/official/cms1" "${measures}/derived/cms1" "${measures}/official/cms2"
printf 'one' > "${measures}/official/cms1/terminology.json"
printf 'two' > "${measures}/derived/cms1/terminology.json"
printf 'not a sidecar' > "${measures}/official/cms2/bundle.json"
store="${tmp_dir}/store"
[ "$(collect_sidecars "$measures" "$store")" = "2" ] || fail "collect copied the wrong number of files"
one="$(printf 'one' | sha256sum | cut -d' ' -f1)"
[ "$(cat "${store}/${one}.json")" = "one" ] || fail "a copy is not named by its hash"
[ "$(find "$store" -type f | wc -l)" -eq 2 ] || fail "a non-sidecar was copied"

# ── assert-clean: a sidecar in ANY layer is refused ───────────────────────────────
# `docker save` writes an archive of layer tars; the stub builds one whose layers hold `layer_paths`.
layer_paths=()
docker() {
  [ "$1" = "save" ] || fail "unexpected docker $*"
  local out="${!#}" work i=0 path
  work="$(mktemp -d)"
  mkdir -p "${work}/image"
  printf '{}' > "${work}/image/config.json"
  for path in "${layer_paths[@]}"; do
    mkdir -p "${work}/root${i}/$(dirname "$path")" && printf 'x' > "${work}/root${i}/${path}"
    tar -cf "${work}/image/layer${i}.tar" -C "${work}/root${i}" .
    i=$((i + 1))
  done
  tar -cf "$out" -C "${work}/image" .
  rm -rf "$work"
}
layer_paths=("app/backend-ts/measures/official/cms1/bundle.json")
main assert-clean image:clean >/dev/null || fail "a clean image was refused"
layer_paths=("app/backend-ts/src/x.ts" "app/backend-ts/measures/official/cms1/terminology.json")
if main assert-clean image:dirty >/dev/null 2>&1; then fail "an image with a sidecar in a lower layer was accepted"; fi
docker() { return 1; }
if main assert-clean image:unreadable >/dev/null 2>&1; then fail "an image that could not be inspected was accepted"; fi

# ── seed only fills an empty store ───────────────────────────────────────────────
docker() { fail "seeded although the bucket's copies were restored"; }
main seed "$store" image:old >/dev/null

# ── pull is best effort; push is not ───────────────────────────────────────────
export TERMINOLOGY_BUCKET=bucket TERMINOLOGY_ENDPOINT=https://example.invalid
aws() { return 1; }
main pull "${tmp_dir}/pulled" >/dev/null || fail "an unreadable bucket failed the pull"
if main push "$store" >/dev/null 2>&1; then fail "a failed upload did not fail the push"; fi
aws() { echo "$*" >> "${tmp_dir}/aws"; }
main push "$store" >/dev/null
grep -q "sync ${store} s3://bucket/terminology/ --endpoint-url https://example.invalid" "${tmp_dir}/aws" || fail "push synced the wrong place: $(cat "${tmp_dir}/aws")"

# ── both deploys: store, then build without pushing, check, push ───────────────
for workflow in deploy-maui-mieweb deploy-twh-mieweb; do
  yaml="${repo_root}/.github/workflows/${workflow}.yml"
  grep -q 'terminology-store.sh push' "$yaml" || fail "${workflow} never uploads its sidecars"
  grep -q 'terminology-store.sh assert-clean' "$yaml" || fail "${workflow} never checks its image"
  grep -q -- '--fallback-image' "$yaml" && fail "${workflow} still restores sidecars from an image"
  push_line="$(grep -n 'terminology-store.sh push' "$yaml" | head -1 | cut -d: -f1)"
  clean_line="$(grep -n 'terminology-store.sh assert-clean' "$yaml" | head -1 | cut -d: -f1)"
  image_push_line="$(grep -n 'docker push' "$yaml" | head -1 | cut -d: -f1)"
  [ -n "$image_push_line" ] && [ "$push_line" -lt "$image_push_line" ] && [ "$clean_line" -lt "$image_push_line" ] \
    || fail "${workflow}: the image is pushed before its sidecars are stored and it is checked"
  # The build itself must not publish: only `docker push`, after the check, may.
  build="$(sed -n '/file: \.\/backend-ts\/Dockerfile/,/tags:/p' "$yaml")"
  grep -q 'push: false' <<< "$build" && grep -q 'load: true' <<< "$build" && ! grep -q 'push: true' <<< "$build" \
    || fail "${workflow}: the backend build step publishes the image before it is checked"
done
grep -q 'measures/\*\*/terminology.json' "${repo_root}/backend-ts/Dockerfile.dockerignore" \
  || fail "the image build context does not exclude the sidecars"

echo "terminology-store: ok"
