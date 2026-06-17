# WorkWell backend-ts container (issue #109 PR1 — entrypoint + image; NOT wired into the live deploy).
#
# The backend-ts pnpm workspace resolves the @mieweb/cloud packages from the sibling git submodule
# (backend-ts/pnpm-workspace.yaml members: "." + "../external/mieweb-cloud/packages/*"), so this image
# MUST be built from the REPOSITORY ROOT to keep both trees in context:
#
#   docker build -f backend-ts/Dockerfile -t workwell-api-ts .
#
# CI checkouts that build this image must use `submodules: true`.
FROM node:24-bookworm-slim

# better-sqlite3 (the SQLite floor driver + the store-contract tests) is a native module; the
# `local` smoke-test target compiles it, so the image needs a toolchain. The production `mieweb`
# target uses libSQL/S3/Valkey instead, but the dependency is still installed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack, pinned to the version CI uses.
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

WORKDIR /app

# Copy both workspace trees with their relative layout preserved (see the workspace note above).
COPY backend-ts/ ./backend-ts/
COPY external/mieweb-cloud/ ./external/mieweb-cloud/

WORKDIR /app/backend-ts
RUN pnpm install --frozen-lockfile

# Long-running Node host (src/server.ts). MIEWEB_TARGET selects the binding set:
#   mieweb → libSQL + S3/MinIO + Valkey companion services (production)
#   local  → sqlite/fs/memory/inproc, no external services (smoke test: -e MIEWEB_TARGET=local)
# The mieweb target listens on :8082 (it co-locates with libSQL which owns :8080); the local
# target listens on :8080. EXPOSE documents the production port.
ENV MIEWEB_TARGET=mieweb
EXPOSE 8082
CMD ["pnpm", "start"]
