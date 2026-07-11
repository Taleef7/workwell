# WorkWell backend-ts container (issue #109 PR1 — entrypoint + image).
#
# The backend-ts pnpm workspace resolves the @mieweb/cloud packages from the sibling git submodule
# (backend-ts/pnpm-workspace.yaml members: "." + "../external/mieweb-cloud/packages/*"), so this image
# MUST be built from the REPOSITORY ROOT to keep both trees in context:
#
#   docker build -f backend-ts/Dockerfile -t workwell-api-ts .
#
# CI checkouts that build this image must use `submodules: true`.
#
# Multi-stage: builder installs the full graph (incl. native toolchain for better-sqlite3), then
# prunes to production deps. Runtime is node:24-bookworm-slim without the C++ toolchain.

# ── builder ──────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

# better-sqlite3 (the SQLite floor driver + the store-contract tests) is a native module; the
# `local` smoke-test target compiles it, so the builder needs a toolchain. The production `mieweb`
# target uses libSQL/S3/Valkey instead, but the dependency is still installed and must survive prune.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack, pinned to the version CI uses.
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

WORKDIR /app

# Copy both workspace trees with their relative layout preserved (see the workspace note above).
COPY backend-ts/ ./backend-ts/
COPY external/mieweb-cloud/ ./external/mieweb-cloud/

WORKDIR /app/backend-ts
RUN pnpm install --frozen-lockfile

# Slim to production dependencies for a smaller runtime image.
# tsx is listed as a devDependency but is REQUIRED at runtime (CMD uses `node --import tsx`).
# Promote it to dependencies image-locally (never committed), then reinstall --prod so the lockfile
# in this layer stays consistent. fqm-execution is already a real production dependency and stays.
# CI=true is required: pnpm refuses module-dir surgery without a TTY unless CI is set.
RUN node --input-type=commonjs -e "\
const fs = require('fs');\
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));\
if (p.devDependencies && p.devDependencies.tsx) {\
  p.dependencies = p.dependencies || {};\
  p.dependencies.tsx = p.devDependencies.tsx;\
  delete p.devDependencies.tsx;\
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\\n');\
}\
" \
  && CI=true pnpm install --prod --no-frozen-lockfile

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

# No python/make/g++: better-sqlite3's native binary was built in the builder stage on the same
# node:24-bookworm-slim ABI and is copied in with node_modules. ca-certificates for outbound TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy pruned app + workspace sibling (pnpm links @mieweb/* into ../external/mieweb-cloud).
COPY --from=builder /app/backend-ts ./backend-ts
COPY --from=builder /app/external/mieweb-cloud ./external/mieweb-cloud

WORKDIR /app/backend-ts

# Long-running Node host (src/server.ts). MIEWEB_TARGET selects the binding set:
#   mieweb → libSQL + S3/MinIO + Valkey companion services (production)
#   local  → sqlite/fs/memory/inproc, no external services
# The mieweb target listens on :8082 (it co-locates with libSQL which owns :8080); the local
# target listens on :8080. EXPOSE documents the production port.
ENV MIEWEB_TARGET=mieweb

# Default the image to production mode so the startup safety guard (config/startup-safety.ts) is
# ACTIVE out of the box: a container started without a strong JWT secret + exact CORS origins +
# SameSite=None/Secure cookies fails CLOSED (503) instead of serving the API unauthenticated. The
# deploy workflow supplies those real secrets (cutover plan §7). Local smoke runs opt out explicitly
# (the `local` target listens on :8080, not the production :8082 EXPOSEd below):
#   docker run -e MIEWEB_TARGET=local -e WORKWELL_ENVIRONMENT=development -p 8080:8080 ...
ENV WORKWELL_ENVIRONMENT=production

EXPOSE 8082
# Run node directly as PID 1 (not `pnpm start`) so SIGTERM/SIGINT reach the process and the graceful
# shutdown in src/server.ts actually runs — a package-manager wrapper as PID 1 swallows the signal.
CMD ["node", "--import", "tsx", "src/server.ts"]
