#!/usr/bin/env bash
# Start the official postgres:16 image for a CI job, on localhost:5432 as user/password/db `workwell`.
#
# A step rather than a `services:` container, because a service names ONE image and fails the job before any
# step runs when that registry refuses the pull. Each registry has failed us anonymously: Docker Hub's pull
# limit (2026-10-09, #780), AWS's public mirror's data limit ("toomanyrequests: Data limit exceeded", three
# times on 2026-10-13), and Google's mirror is a cache that may evict an image, which it documents for use
# as a daemon mirror with Docker Hub behind it, not as a registry on its own. So the same official image is
# tried from each in turn. No credentials: the AWS account is suspended and the repo holds no registry login.
set -euo pipefail

pulled=""
for image in mirror.gcr.io/library/postgres:16 public.ecr.aws/docker/library/postgres:16 docker.io/library/postgres:16; do
  if docker pull --quiet "$image"; then
    pulled="$image"
    break
  fi
  echo "::warning::could not pull $image; trying the next registry"
done
if [ -z "$pulled" ]; then
  echo "::error::postgres:16 could not be pulled from any registry"
  exit 1
fi

docker run --detach --name postgres \
  --env POSTGRES_USER=workwell --env POSTGRES_PASSWORD=workwell --env POSTGRES_DB=workwell \
  --publish 5432:5432 "$pulled"

for _ in $(seq 1 50); do
  if docker exec postgres pg_isready --username workwell >/dev/null 2>&1; then
    echo "postgres:16 from $pulled is ready"
    exit 0
  fi
  sleep 2
done
docker logs postgres
echo "::error::postgres:16 did not become ready"
exit 1
