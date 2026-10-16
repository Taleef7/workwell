#!/usr/bin/env bash
# The deploy builds' base-image fallback: which image it reads, which registry it takes, and that every
# deploy build uses it.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=pull-base-image.sh
source "${repo_root}/.github/scripts/pull-base-image.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
calls="${tmp_dir}/calls"
DIGEST="sha256:$(printf 'a%.0s' $(seq 1 64))"

refusing=""   # registries whose pull fails, space-separated
docker() {
  [ "$1" = "pull" ] || fail "unexpected docker $*"
  local ref="${!#}"
  echo "$ref" >> "$calls"
  local registry
  for registry in $refusing; do
    case "$ref" in "${registry}"/*) return 1 ;; esac
  done
}

dockerfile() {
  printf '%s\n' "$@" > "${tmp_dir}/Dockerfile"
  echo "${tmp_dir}/Dockerfile"
}

# ── which image ──────────────────────────────────────────────────────────────
for df in backend-ts/Dockerfile frontend/Dockerfile; do
  got="$(base_image_of "${repo_root}/${df}")"
  [[ "$got" =~ ^node@sha256:[0-9a-f]{64}$ ]] || fail "${df}: read '${got}'"
done
[ "$(base_image_of "$(dockerfile "ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-alpine@${DIGEST}" 'FROM ${NODE_IMAGE}')")" = "node@${DIGEST}" ] \
  || fail "the tag is dropped and the digest kept"
[ "$(base_image_of "$(dockerfile "ARG NODE_IMAGE=docker.io/library/node@${DIGEST}")")" = "node@${DIGEST}" ] \
  || fail "a digest without a tag is read"

if base_image_of "$(dockerfile "ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-alpine")" 2>/dev/null; then
  fail "an image not pinned by digest is refused: a fallback would mix images across registries"
fi
if base_image_of "$(dockerfile "FROM public.ecr.aws/docker/library/node:24-alpine@${DIGEST}")" 2>/dev/null; then
  fail "a Dockerfile with no NODE_IMAGE default is refused"
fi
if base_image_of "$(dockerfile "ARG NODE_IMAGE=docker.io/library/node@${DIGEST}" "ARG NODE_IMAGE=docker.io/library/node@${DIGEST}")" 2>/dev/null; then
  fail "two NODE_IMAGE defaults are refused"
fi
if base_image_of "$(dockerfile "ARG NODE_IMAGE=ghcr.io/someone/node@${DIGEST}")" 2>/dev/null; then
  fail "an image outside a registry's official library is refused"
fi

# ── which registry ───────────────────────────────────────────────────────────
: > "$calls"; refusing=""
[ "$(pull_base_image "node@${DIGEST}" 2>/dev/null)" = "mirror.gcr.io/library/node@${DIGEST}" ] || fail "Google's mirror first"
[ "$(wc -l < "$calls")" -eq 1 ] || fail "no further registry is tried once one serves the image"

: > "$calls"; refusing="mirror.gcr.io"
[ "$(pull_base_image "node@${DIGEST}" 2>/dev/null)" = "public.ecr.aws/docker/library/node@${DIGEST}" ] || fail "AWS's mirror second"

: > "$calls"; refusing="mirror.gcr.io public.ecr.aws"
[ "$(pull_base_image "node@${DIGEST}" 2>/dev/null)" = "docker.io/library/node@${DIGEST}" ] || fail "Docker Hub last"
[ "$(wc -l < "$calls")" -eq 3 ] || fail "each registry is tried once"

: > "$calls"; refusing="mirror.gcr.io public.ecr.aws docker.io"
if pull_base_image "node@${DIGEST}" >/dev/null 2>&1; then fail "no registry serving the image fails the step"; fi

# ── what the build is given ──────────────────────────────────────────────────
refusing="mirror.gcr.io"
GITHUB_OUTPUT="${tmp_dir}/output"
: > "$GITHUB_OUTPUT"
main "$(dockerfile "ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim@${DIGEST}")" >/dev/null 2>&1
[ "$(cat "$GITHUB_OUTPUT")" = "image=public.ecr.aws/docker/library/node@${DIGEST}" ] || fail "the pulled reference reaches the step output"

# ── every deploy build uses it ───────────────────────────────────────────────
# A build step without the pull step and the build arg would build FROM the Dockerfile's default registry
# alone, which is the failure this exists to remove.
for wf in "${repo_root}"/.github/workflows/deploy-*.yml; do
  builds="$(grep -c 'uses: docker/build-push-action' "$wf" || true)"
  pulls="$(grep -c 'run: bash .github/scripts/pull-base-image.sh ' "$wf" || true)"
  args="$(grep -c 'NODE_IMAGE=${{ steps.base.outputs.image }}' "$wf" || true)"
  [ "$builds" -gt 0 ] || continue
  [ "$pulls" -eq "$builds" ] && [ "$args" -eq "$builds" ] \
    || fail "$(basename "$wf"): ${builds} image builds, ${pulls} base-image pulls, ${args} NODE_IMAGE build args"
done

echo "pull-base-image: all checks passed"
