#!/usr/bin/env bash
# Pull a Dockerfile's Node base image from the first registry that serves it, for a deploy image build.
#
#   bash .github/scripts/pull-base-image.sh backend-ts/Dockerfile
#
# Reads the Dockerfile's `ARG NODE_IMAGE=` default (an official Docker Hub library image, pinned by digest),
# tries the SAME image from Google's mirror, AWS's public mirror and Docker Hub in turn, and writes the one it
# pulled, by digest, to $GITHUB_OUTPUT as `image=`. The build passes that back as the NODE_IMAGE build arg; the
# runner's own Docker builds the image (the `docker` buildx driver), so it uses the pulled copy.
#
# The start-ci-postgres.sh fallback (#808), applied to the deploys. A Dockerfile FROM names ONE registry, and
# three of eight deploy runs failed on 2026-10-16 when AWS's mirror answered "429 Data limit exceeded" before any
# step of the build ran. Each registry has refused anonymous pulls at some point, and Google's mirror is a cache that
# may evict an image. The digest is what makes the fallback safe: a pull by digest yields the identical image
# from every registry, or fails, so the image a deploy ships never depends on which registry answered. No
# credentials: the AWS account is suspended and the repo holds no Docker Hub login.
set -euo pipefail

REGISTRIES=(mirror.gcr.io/library public.ecr.aws/docker/library docker.io/library)

# The repository@digest after a registry's `library/` prefix, from the Dockerfile's `ARG NODE_IMAGE=` default
# (`node:24-bookworm-slim@sha256:…` -> `node@sha256:…`; the tag only documents what the digest is). Refuses a
# default that is not pinned by digest, because the fallback would then mix images across registries.
base_image_of() {
  local dockerfile="$1" default path
  default="$(tr -d '\r' < "$dockerfile" | sed -n 's/^ARG NODE_IMAGE=\(.*\)$/\1/p')"
  if [ -z "$default" ] || [ "$(printf '%s\n' "$default" | wc -l)" -ne 1 ]; then
    echo "::error::${dockerfile} must declare exactly one 'ARG NODE_IMAGE=' default" >&2
    return 1
  fi
  path="${default##*/library/}"
  if [ "$path" = "$default" ] || ! [[ "$path" =~ ^[a-z0-9._-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]]; then
    echo "::error::${dockerfile}'s NODE_IMAGE default (${default}) is not a library image pinned by digest" >&2
    return 1
  fi
  printf '%s@%s\n' "${path%%[:@]*}" "${path##*@}"
}

# Prints the reference it pulled; fails when no registry serves the image.
pull_base_image() {
  local image="$1" registry
  for registry in "${REGISTRIES[@]}"; do
    # Bounded: a registry that hangs rather than refusing must not hold the build until the job times out.
    if timeout "${PULL_TIMEOUT_SECONDS:-300}" docker pull --quiet "${registry}/${image}" >&2; then
      printf '%s/%s\n' "$registry" "$image"
      return 0
    fi
    echo "::warning::could not pull ${registry}/${image}; trying the next registry" >&2
  done
  echo "::error::${image} could not be pulled from any registry" >&2
  return 1
}

main() {
  local image pulled
  image="$(base_image_of "$1")"
  pulled="$(pull_base_image "$image")"
  echo "base image: ${pulled}"
  echo "image=${pulled}" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
