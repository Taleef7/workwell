# Issue #109 — Phase 5: Deploy cutover & JVM retirement (execution plan)

> **Status:** Plan only — nothing outward-facing executed. Written 2026-06-15.
> **Predecessor:** Phases 0–4b complete (#103–#108). The whole Java API surface is ported to
> `backend-ts/` behind the unchanged Next.js fetch contract; ~362 `backend-ts` tests green.
> **Governing docs:** ADR-008; `docs/superpowers/plans/2026-06-12-issue-96-dejava-replatform.md` §6 (Phase 5).
> **Stakes:** This phase changes the **live `twh-api` production stack**. It is hard to reverse and
> outward-facing — every step below is gated behind explicit go-ahead, and the recommended path
> never flips production until a shadow container has passed the smoke checklist.

---

## STATUS UPDATE (2026-06-16) — pivoted to the Neon/Postgres path; resume guide

> The original plan below recommended **A1 (libSQL/cloud-os, abandon Neon)**. With the §4
> prerequisites unanswerable without MIE/Doug, we **pivoted to A2 (keep Neon Postgres)** — it removes
> all four blocking questions (it needs only a single container + env vars, exactly what MIE already
> does for the Java backend) and reuses the already-built `Pg*Store` ceiling. **A2 is the chosen
> path;** the A1 analysis below is retained as the alternative if MIE multi-service support is later
> confirmed. §6 (smoke checklist), §7 (env), §8 (docs), §9 (risks) still apply.

**Done**
- **PR1 (#155, merged):** `backend-ts/src/server.ts` entrypoint + `backend-ts/Dockerfile` + scoped
  `Dockerfile.dockerignore`. Image fails closed by default (`WORKWELL_ENVIRONMENT=production`); runs
  node as PID 1 for graceful SIGTERM. Validated in Docker.
- **Store seam (PR #156, open):** `backend-ts/src/stores/factory.ts` selects the SQLite floor or the
  Pg ceiling by a non-blank `DATABASE_URL`; all 10 routes converted (~74 sites) — default stays the
  floor, so behavior-preserving. **Proven:** Pg store-contract suite **42/42** vs real `postgres:16`;
  **422** backend-ts tests green on SQLite; end-to-end container on Postgres (60 measures, a MEASURE
  run → 100 outcomes / 22 cases, worklist working).

**Remaining (in order)**
1. **Evidence `BUCKET`** — **DECIDED (2026-06-17): defer as a documented known limitation** for the
   first cutover. The shadow/flip run the `local` target, so `BUCKET` is the in-container `fs` driver —
   evidence upload works but is ephemeral (lost on container recreate). A managed S3/R2 binding is a
   later follow-up. (`CACHE`/`JOBS` stay in-process — fine for a single-replica container.)
2. **Shadow deploy (PR):** ✅ **WRITTEN (2026-06-17)** — `.github/workflows/deploy-twh-ts-shadow.yml`
   on `feat/issue-109-shadow-deploy`. `workflow_dispatch`-only; builds `backend-ts/Dockerfile`
   (`submodules: recursive`) → `ghcr.io/taleef7/workwell-api-ts`; creates a **separate** `twh-api-ts`
   container (internal port **8080**, `MIEWEB_TARGET=local`) against Neon (`DATABASE_URL` = the
   existing `DATABASE_URL_TWH` secret) + the §7 env, via `deploy-mieweb-container.sh`. The live Java
   `twh-api` stays untouched. **Next action: merge, then manually trigger it and run the §6 smoke
   checklist against `twh-api-ts.os.mieweb.org`.** First-run op note: set the new `workwell-api-ts`
   GHCR package's visibility/pull access to match `workwell-api` so the MIE manager can pull it.
3. **Blue-green flip (PR):** point the frontend at the proven TS backend (rebuild with
   `NEXT_PUBLIC_API_BASE_URL` → `twh-api-ts`). The Java backend stays alive → instant rollback =
   repoint the frontend back. **Never** destroy the live backend with an unproven image.
4. **Retire the JVM (PR):** after a soak, delete `backend/` + the Java Dockerfile + Java CI jobs; wire
   the backend-ts typecheck/tests into `ci.yml`. Then update `ARCHITECTURE.md`/`DEPLOY.md` (topology →
   Node/TS) + `README.md`.

Running narrative: `docs/JOURNAL.md` (newest on top).

---

## 1. Where things stand (verified facts)

**The app:**
- `backend-ts/` is a self-contained pnpm workspace; it consumes `@mieweb/cloud` from the git
  **submodule** `external/mieweb-cloud` (`.gitmodules`). Its bindings are `DB` / `BUCKET` / `CACHE` /
  `JOBS` (see `backend-ts/wrangler.jsonc`).
- The worker is a Cloudflare-style `fetch(req, env, ctx)` handler (`backend-ts/src/worker.ts`). Route
  handlers talk to `env.DB` through the **floor** stores (`Sqlite*Store(env.DB)`) — which work over any
  D1/libSQL-compatible `CloudDatabase`. The hand-written `Pg*Store` ceiling adapters are exercised by
  the store-contract tests only; **the worker does not use them**.
- **Schema is self-creating at runtime:** the route one-shot inits `env.DB.exec(RUN_STORE_FLOOR_DDL)`
  + seed on first request. There is **no migration step** to run at deploy (the canonical Flyway
  migrations are Java-only). This simplifies the cutover.
- There is **no Dockerfile and no production start script** in `backend-ts/` today.

**The runtime (`@mieweb/cli` + `external/mieweb-cloud`):**
- `mieweb.jsonc` already defines two non-Cloudflare targets:
  - `local` — in-process Node adapters (sqlite/fs/memory/inproc). The test/dev floor.
  - `mieweb` — **libSQL + S3/MinIO + Valkey** (the `external/mieweb-cloud/packages/cloud-os`
    docker-compose stack: libSQL on `:8080`, MinIO `:9000`, Valkey `:6379`; the **app must listen on
    `:8082`** to avoid colliding with libSQL when co-located).
  - `postgres` — **sketched in a comment only**; depends on a `@mieweb/cloud-postgres` driver that
    does not exist yet.
- `mieweb --target mieweb dev` → `runHostTarget` imports `@mieweb/cloud-os` (registers the
  libSQL/S3/Valkey drivers) then `startLocalHost({config})`, a **long-running Node HTTP host** that
  serves the worker's `fetch` and stays alive until interrupted. So this command **is** usable as a
  container entrypoint — though it is named `dev` (see Decision E).
- `mieweb deploy` is **Cloudflare-only**. There is no MIE deploy command — MIE shipping goes through
  the existing `deploy-twh-mieweb.yml` + `.github/scripts/deploy-mieweb-container.sh` (Create-a-Container
  v1 API), which builds a Docker image and creates a container with a single internal port + env vars.

**The current deploy (`.github/workflows/deploy-twh-mieweb.yml`):**
- On every push to `main` (and `workflow_dispatch`): builds `./backend/Dockerfile` (Java) → GHCR
  `ghcr.io/taleef7/workwell-api:sha-<sha>`, deploys to the MIE `twh-api` container (internal port 8080)
  with env (`DATABASE_URL` = Neon, `OPENAI_API_KEY`, `SPRING_PROFILES_ACTIVE=prod,production`, CORS,
  JWT, `WORKWELL_INSTANCE=twh`). Frontend builds `./frontend/Dockerfile` → `twh` container (port 3000),
  pointed at `https://twh-api.os.mieweb.org`.

---

## 2. The decisions that are yours (or Doug's) — with recommendations

These can't be derived from the repo; they set what the cutover actually does.

### Decision A — Production DB binding (the big one)
What backs `env.DB` in the live container.

- **Option A1 — libSQL via the `mieweb` cloud-os target (recommended for the demo stack).**
  The floor stores run unchanged over libSQL. Matches the existing `mieweb.jsonc` sketch and the
  "SQLite/D1 floor in production" principle (ADR-008). **Abandons Neon Postgres** as the app DB.
  Because demo data re-seeds on boot, **no data migration** is needed for a showcase stack.
  *Cost:* requires the cloud-os companion services (libSQL/MinIO/Valkey) to run with the container
  (Decision B).
- **Option A2 — keep Neon Postgres.** Requires either (a) a real `@mieweb/cloud-postgres`
  `CloudDatabase` driver (so `env.DB` is Postgres) **plus** rewriting the floor stores' SQL to be
  Postgres-compatible (they use `?` placeholders, `INTEGER` booleans, SQLite `ON CONFLICT` forms), or
  (b) rewiring the worker to select the existing `Pg*Store` adapters when a PG binding is present.
  Both are real build work beyond this phase's "cutover" scope.
- **Recommendation:** **A1** for the live demo stack — lowest friction, matches the config, no schema
  rewrite. Pursue A2 later only if a managed/persistent Postgres is a hard requirement. **Flag for
  Doug:** is losing Neon (persistent managed Postgres) acceptable for `twh`, given it's a
  re-seeding demo stack?

### Decision B — Companion services (BUCKET / CACHE / JOBS)
The `mieweb` target needs S3/MinIO (evidence files), Valkey (cache + the async run-job queue).
- **Option B1 (recommended):** run the `cloud-os` docker-compose stack alongside the app (sidecar /
  same pod / a second container) so `localhost:{8080,9000,6379}` resolve. **Depends on what MIE
  Create-a-Container supports** (Decision = a prerequisite question for MIE, §4).
- **Option B2:** point the drivers at managed equivalents (a hosted S3 bucket, a hosted Valkey/Redis).
- **Minimal-surface fallback:** if companion services are a blocker, a first cutover could degrade
  `JOBS` to an in-process queue and `CACHE` to memory (both already exist as `local` drivers) and only
  require a real `BUCKET` for evidence — but that diverges from the `mieweb` target and needs a
  custom target. Treat as a last resort.

### Decision C — Cutover strategy
- **Option C1 — shadow then flip (recommended).** Stand up a **separate** `twh-api-ts` container
  (new hostname, e.g. `twh-api-ts.os.mieweb.org`) from the TS image, leaving the live `twh-api` (Java)
  untouched. Validate the full smoke checklist (§6) against it (a throwaway frontend env or curl with a
  JWT). Only when green, flip `twh-api` to the TS image.
- **Option C2 — direct flip.** Point `deploy-twh-mieweb.yml`'s backend job at the TS image; next merge
  to `main` runs production on TypeScript. Higher risk, no parallel validation.
- **Recommendation:** **C1.**

### Decision D — Java removal timing
- **Option D1 (recommended):** keep `backend/` deployable through a soak period; delete it in a
  **separate** follow-up PR once the TS container is proven healthy in production.
- **Option D2:** delete `backend/` in the same PR that flips. Cleaner history, no quick revert.
- **Recommendation:** **D1.**

### Decision E — Container entrypoint / "dev" naming
`mieweb --target mieweb dev` is the long-running host harness, but the `dev` name is a smell for a
prod CMD. **Options:** (E1) use it as-is and document why; (E2) ask MIE to add a `serve`/`start`
alias to `@mieweb/cli`; (E3) add a tiny `backend-ts/src/server.ts` that imports `startLocalHost`
directly with `target=mieweb` and is the container CMD (no CLI dependency at runtime).
- **Recommendation:** **E3** — a 10-line explicit server entrypoint is clearer than shipping a
  `dev` command to prod and insulates us from CLI changes. Confirm `@mieweb/cloud-local/host`
  `startLocalHost` is importable as a stable API.

---

## 3. Recommended path (one line)
**C1 shadow-then-flip, on the A1 libSQL `mieweb` target, with B1 cloud-os companion services, an E3
explicit server entrypoint, and D1 deferred Java removal** — pending the §4 prerequisites being
confirmed with MIE/Doug.

---

## 4. Prerequisites to confirm with MIE / Doug (BLOCKING — verify before writing cutover code)
1. **Companion services on Create-a-Container:** can a provisioned container run (or be accompanied
   by) the `cloud-os` libSQL + MinIO + Valkey services — multi-service template, sidecars, or managed
   endpoints? The deploy script today creates **one** container with **one** internal port. (If only
   single-process is supported, Decision A/B must change.)
2. **Persistence:** does the container's libSQL volume persist across the delete-and-recreate that
   every `main` push performs? (If not, libSQL is effectively ephemeral → fine for a re-seeding demo,
   not for real data — informs Decision A.)
3. **Production host harness:** is `startLocalHost` (`@mieweb/cloud-local/host`) intended/blessed as a
   long-running production host, or should we wait for a hardened `serve`? (Decision E.)
4. **Neon decision:** is dropping Neon for `twh` acceptable (Decision A1), or is Postgres required
   (A2 → schedule the `@mieweb/cloud-postgres` build)?

---

## 5. Execution phases (each = one reviewable PR; do not start until §4 is settled)

### PR 1 — Container entrypoint + image (no production impact)
- Add `backend-ts/src/server.ts` (Decision E3): import `startLocalHost`, force `target=mieweb`, listen
  on `:8082`, graceful shutdown. (Or, if E1 chosen, document `mieweb --target mieweb dev` as CMD.)
- Add `backend-ts/Dockerfile`: Node 24-slim; enable corepack/pnpm; copy `backend-ts/` **and**
  `external/mieweb-cloud/` (the workspace submodule); `pnpm install --frozen-lockfile`;
  pre-compile measures if needed (`pnpm compile-measures`); `EXPOSE 8082`; `CMD ["node","--import","tsx","src/server.ts"]` (or the CLI form).
  - **Submodule note:** the Docker build context must include the submodule. Either build from repo
    root with a `backend-ts/Dockerfile` that copies `external/mieweb-cloud`, or vendor the needed
    cloud packages. The CI checkout must use `submodules: true`.
- Add a `pnpm build`/`pnpm start` script pair so the image has a non-dev start path.
- **Verify locally:** `docker build` succeeds; `docker run` serves `/api/version` + `/actuator/health`
  (note: confirm the TS app exposes an actuator-health-equivalent; if not, the frontend/MIE healthcheck
  must point at `/api/health` or `/api/version`).

### PR 2 — Shadow deploy workflow (parallel, never touches `twh-api`)
- Add `.github/workflows/deploy-twh-ts-shadow.yml` (`workflow_dispatch` only — **not** on push):
  builds `ghcr.io/taleef7/workwell-api-ts` from `backend-ts/Dockerfile` (with `submodules: true`),
  deploys a **new** container `twh-api-ts` (internal port 8082) via the existing
  `deploy-mieweb-container.sh`, with the TS env set (see §7).
- Stand up the companion services per Decision B.
- **Verify:** run the §6 smoke checklist against `https://twh-api-ts.os.mieweb.org`.

### PR 3 — Flip `twh-api` to TypeScript
- Edit `deploy-twh-mieweb.yml`: backend `build` job → `backend-ts/Dockerfile` (context root,
  `submodules: true`); `BACKEND_IMAGE` → `workwell-api-ts` (or keep the name, swap the build);
  internal port 8080 → **8082**; replace the Java env block with the TS env block (§7 — drop
  `JAVA_OPTS`, keep DATABASE_URL only if A2). Keep the frontend job unchanged.
- Merge → the next deploy runs production on TypeScript. Watch the post-deploy smoke checklist.
- **Rollback:** revert this commit (re-deploys the Java image), or `workflow_dispatch` an earlier
  `sha-<good>` with `replace_existing: true` (each Java image is still tagged in GHCR).

### PR 4 — Retire the JVM (after soak, Decision D1)
- Delete `backend/` (Java + Gradle), the Java `Dockerfile`, and any Java-only CI jobs in `ci.yml`.
- Wire `backend-ts` typecheck + tests into `ci.yml` as the backend gate (if not already).
- Remove the shadow workflow (PR 2) once the flip is proven.
- Update docs (§8).

---

## 6. Smoke checklist (run against the shadow container, then post-flip)
Mirrors `docs/DEPLOY.md` + the ported surface:
- `GET /api/version` → `{"api":"v1",...}`; health endpoint → 200.
- `POST /api/auth/login` (demo creds) → tokens; `POST /api/auth/refresh` round-trips the cookie.
- `GET /api/measures` → 60; `GET /api/measures/audiogram` → detail **with value sets**.
- `POST /api/runs/manual` (MEASURE) → outcomes; ALL_PROGRAMS → `RUNNING` then `COMPLETED` (async).
- `GET /api/cases?status=open`; a case detail; outreach send → delivery status flips.
- Evidence upload → list → download (exercises the **BUCKET** binding — the key new infra dependency).
- `GET /api/exports/runs?format=csv` (+ outcomes/cases/audit) → 200.
- `GET /api/auditor/cases/{id}/packet?format=json`; MAT export → `application/fhir+xml`.
- Admin: integrations, terminology create, outreach-template create/update, **waiver grant**,
  demo-reset **403** (prod profile must be set so it's gated).
- MCP: `GET /sse` opens; a `tools/call` returns (note the known MIE nginx SSE timeout caveat).
- Frontend: log in at the shadow/flipped URL, click through programs → runs → cases → studio → admin.

## 7. Production env for the TS container (vs the Java block)
Keep: `OPENAI_API_KEY`, `WORKWELL_CORS_ALLOWED_ORIGINS`/`CORS_ALLOWED_ORIGINS` = frontend URL,
`WORKWELL_AUTH_COOKIE_SAME_SITE=None`, `WORKWELL_AUTH_COOKIE_SECURE=true`, `WORKWELL_AUTH_JWT_SECRET`,
`WORKWELL_AUTH_ACCESS_TTL_SECONDS`, `WORKWELL_INSTANCE=twh`, and a production profile flag the TS
`isProductionLike` honours (`SPRING_PROFILES_ACTIVE=prod,production` **or** `NODE_ENV=production` **or**
`WORKWELL_ENVIRONMENT=production`).
Drop: `JAVA_OPTS`. `DATABASE_URL` only if A2 (Postgres); for A1 the DB binding comes from the
`mieweb` target's libSQL config, not an env URL.
Confirm: the startup-safety fail-fast (`config/startup-safety.ts`) passes with this env (auth enabled,
strong secret, exact non-localhost CORS, SameSite=None + Secure) — it throws on a production-like
profile otherwise.

## 8. Docs to update (in the flip / retirement PRs)
`docs/DEPLOY.md` (TS image, port 8082, companion services, env table, healthcheck path, rollback),
`docs/ARCHITECTURE.md` (deployment topology → Node/TS), `README.md` (tech stack, status → cutover
done), `docs/JOURNAL.md` (per-PR), `docs/DECISIONS.md` (ADR for the final binding choice from
Decision A), and `docs/CQF_FHIR_CR_REFERENCE.md` (note the JVM CQL path is retired in favour of
build-time CQL→ELM). Remove Java-specific guidance.

## 9. Risks
- **Neon pooler rejects the `options` startup param** (FOUND + FIXED 2026-06-17): the first shadow run
  500'd on every DB route because `createPgPool` set `options=-c search_path=workwell_spike,public`,
  which Neon's pooled (PgBouncer) endpoint rejects (`08P01`). Dropped it — the adapters fully-qualify
  `workwell_spike.*`, so search_path is unneeded (a `SET` wouldn't survive transaction pooling). The
  42/42 store-contract tests missed it because they run against a *direct/unpooled* `postgres:16`. New
  guard: `pg-database.test.ts`. Lesson: validate the ceiling against a *pooled* endpoint, not just direct PG.
- **Companion-service availability** (§4.1) is the critical unknown; it can force Decision A/B to change.
- **libSQL persistence across recreate** (§4.2): a `main` push recreates the container — verify the
  data volume survives, or accept re-seed-on-boot (demo-acceptable).
- **BUCKET correctness:** evidence upload/download is the one surface that genuinely needs external
  object storage; it's the highest-value item on the smoke checklist.
- **SSE/MCP:** the pre-existing MIE nginx `proxy_read_timeout`/buffering issue (May-22 journal) is
  independent of language and still applies; don't treat MCP SSE flakiness as a cutover regression.
- **Submodule in CI/Docker:** forgetting `submodules: true` or the submodule copy in the image is the
  most likely build break — call it out in both PR 1 and PR 3.
```
