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
timeout() { shift; "$@"; }   # the bound itself is the coreutils command's; the stub only passes through
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
  # Every stage starts FROM the build arg or an earlier stage: a stage naming a registry itself would pull
  # from that one registry alone, which is the failure this exists to remove.
  stages=" "
  while read -r from ref as name; do
    [ "$ref" = '${NODE_IMAGE}' ] || [[ "$stages" == *" ${ref} "* ]] || fail "${df}: a stage starts FROM ${ref}"
    stages="${stages}${name} "
  done < <(tr -d '' < "${repo_root}/${df}" | grep -E '^FROM ')
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
# alone, which is the failure this exists to remove. Each build must also be handed the image of the Dockerfile
# it builds: a frontend build given the backend's would build on Debian rather than Alpine, without an error.
# Prints "<builds> <problems>" for one workflow.
check_builds() {
  tr -d '\r' < "$1" | grep -v '^[[:space:]]*#' | awk '
    function close_build() {
      if (file != pulled) bad = bad " " file "<-" (pulled == "" ? "nothing" : pulled)
      if (!arg) bad = bad " " file ":no-NODE_IMAGE"
      building = 0; pulled = ""
    }
    building && NF > 0 && match($0, /^ */) && RLENGTH <= 6 && $0 !~ /uses: docker\/build-push-action/ { close_build() }
    /run: bash \.github\/scripts\/pull-base-image\.sh / { pulled = $NF; next }
    /uses: docker\/build-push-action/ { if (building) close_build(); building = 1; builds++; file = "?"; arg = 0; next }
    building && /^ +file: / { file = $2; sub(/^\.\//, "", file); next }
    building && index($0, "NODE_IMAGE=${{ steps.base.outputs.image }}") { arg = 1 }
    END { if (building) close_build(); printf "%d%s\n", builds, bad }'
}
for wf in "${repo_root}"/.github/workflows/deploy-*.yml; do
  read -r builds bad <<< "$(check_builds "$wf")"
  [ "$builds" -gt 0 ] || continue
  [ -z "$bad" ] || fail "$(basename "$wf"): ${bad}"
done

# The check above can see each fault it exists for.
fixture="${tmp_dir}/deploy.yml"
build_step() {  # <pulled Dockerfile or ""> <built Dockerfile> <with the NODE_IMAGE arg: yes|no>
  [ -n "$1" ] && printf '      - name: Pull the Node base image\n        id: base\n        run: bash .github/scripts/pull-base-image.sh %s\n' "$1"
  printf '      - uses: docker/build-push-action@v7\n        with:\n          file: ./%s\n          build-args: |\n' "$2"
  [ "$3" = yes ] && printf '            NODE_IMAGE=${{ steps.base.outputs.image }}\n'
  printf '            OTHER=1\n          tags: x\n'
}
{ build_step backend-ts/Dockerfile backend-ts/Dockerfile yes; build_step frontend/Dockerfile frontend/Dockerfile yes; } > "$fixture"
[ "$(check_builds "$fixture")" = "2" ] || fail "a correct workflow passes: $(check_builds "$fixture")"
{ build_step backend-ts/Dockerfile backend-ts/Dockerfile yes; build_step backend-ts/Dockerfile frontend/Dockerfile yes; } > "$fixture"
[[ "$(check_builds "$fixture")" == *"frontend/Dockerfile<-backend-ts/Dockerfile"* ]] || fail "a build handed another Dockerfile's image is caught"
{ build_step "" frontend/Dockerfile yes; } > "$fixture"
[[ "$(check_builds "$fixture")" == *"<-nothing"* ]] || fail "a build with no pull step is caught"
{ build_step frontend/Dockerfile frontend/Dockerfile no; } > "$fixture"
[[ "$(check_builds "$fixture")" == *":no-NODE_IMAGE"* ]] || fail "a build without the NODE_IMAGE arg is caught"
{ printf '      # - run: bash .github/scripts/pull-base-image.sh frontend/Dockerfile\n'; build_step "" frontend/Dockerfile yes; } > "$fixture"
[[ "$(check_builds "$fixture")" == *"<-nothing"* ]] || fail "a commented-out pull step does not count"

echo "pull-base-image: all checks passed"
