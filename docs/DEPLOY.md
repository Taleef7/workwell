# Deployment Guide

**Stack:** MIE Create-a-Container (frontend + backend containers) + Neon Postgres 16 + Cloudflare R2
(evidence, backups) + OpenAI. **Cost target:** under about $25/month.

Backups, restores and disaster recovery: **`docs/BACKUP_DR_RUNBOOK.md`**. The `deploy` skill lists the
traps to read first. Rationale lives in the ADRs cited inline.

---

## MIE Create-a-Container Deployment

All stacks run on MIE's container platform (`os.mieweb.org`, site id `1`). Backend: the TypeScript worker
(`backend-ts/`, `MIEWEB_TARGET=local`, port 8080). Frontend: Next.js (port 3000). The `workwell_spike`
schema self-creates on boot; there are no migration files.

| Stack | Frontend | Backend API | Trigger | Self-heal |
|---|---|---|---|---|
| **TWH** (demo, primary) | `twh.os.mieweb.org` | `twh-api-ts.os.mieweb.org` | push to `main` + dispatch | `reconcile-twh-mieweb.yml` |
| **Maui** (pilot sandbox) | `maui.os.mieweb.org` | `maui-api-ts.os.mieweb.org` | push to `main` + dispatch | `reconcile-maui-mieweb.yml` |
| Staging (live WebChart) | `twh-staging.os.mieweb.org` | `twh-staging-api-ts.os.mieweb.org` | dispatch only | none |

Images: backend `ghcr.io/taleef7/workwell-api-ts` (shared; tags namespaced per stack), frontends
`…/workwell-twh-frontend` and `…/workwell-maui-frontend`.

### Deployment workflow

A push to `main` runs `deploy-twh-mieweb.yml` and `deploy-maui-mieweb.yml`, unless it changes only `docs/`
or root `*.md` files (no image contains them). Each:

1. **Builds the backend**: vendors official terminology (Step 1), runs the reproducibility gate
   `git diff --exit-code backend-ts/measures/official`, bakes `WORKWELL_BUILD_SHA` into the image.
   TWH tags `latest` + `sha-<SHA>`; Maui pushes only `maui-sha-<SHA>`.
2. **Builds the frontend** with the stack's build args.
3. **Deploys the backend**: validates required secrets, builds the container env as a fixed `jq` array,
   runs `.github/scripts/deploy-mieweb-container.sh` (delete + recreate, ~30–120 s of downtime).
4. **Deploys the frontend** only if the backend deploy succeeded.

Each stack's deploy and reconcile share a concurrency group (`twh-mieweb-container-ops`,
`maui-mieweb-container-ops`), so a heal never races a deploy. A push always replaces containers; a
manual dispatch needs `replace_existing=true` (`false` is for first creation only).

#### Step 1 — vendoring official terminology: fetched at build, not committed (ADR-036)

`measures/official/<catalogId>/terminology.json` is **gitignored on purpose** (VSAC/CPT-derived content
must not be redistributed). Every build re-fetches it from the pinned upstream commit; the committed
manifest's SHA-256 pins the bytes. Both deploy workflows run, per vendored measure (cms122, cms125, cms2,
cms68, cms951, cms138, cms130, cms165, plus cms137 on Maui):

```bash
node scripts/vendor-official-measure.mjs --measure CMS122FHIRDiabetesAssessGT9Pct --catalog-id cms122 --strip-elm-annotations --complete-terminology
```

Plain `node`, no install; retries transport errors and 5xx, a 4xx is final. Without the sidecar the
fidelity diff silently degrades from `literal` to `subset`/`estimate`, and a routed measure refuses.
Locally: `pnpm vendor:official --measure <MADiE name> --catalog-id <id> --strip-elm-annotations`.

#### Step 1a — `--complete-terminology`: value sets the bundle does not fully carry (ADR-041, ADR-053)

Upstream caps expansions at 1000 codes and omits some value sets; a capped or empty set narrows a
population silently, so routing refuses one. This flag completes them from VSAC at the release the
content names (old name `--complete-capped-expansions` still accepted).

- **`WORKWELL_VSAC_API_KEY_VENDOR` missing, or VSAC unreachable** ⇒ capped codes ship, the manifest no
  longer matches the committed one, and **the deploy fails at the reproducibility gate**. So every
  deploy needs NLM VSAC reachable: any post-ADR-041 SHA, forward *or* rollback, fails during an outage.
- `_VENDOR` (build time) and `WORKWELL_VSAC_API_KEY_TWH` (runtime resolver, ADR-023) are separate
  secrets on purpose (ADR-036), even though they hold the same UMLS key.
- **Landing order — secrets before manifests.** Add or change the secret in the **same change** that
  commits the regenerated manifests, or CI fails on every PR and every push to `main` fails its deploy:

  ```bash
  cd backend-ts
  WORKWELL_VSAC_API_KEY=<umls-api-key> pnpm vendor:official --measure <Name> --catalog-id <id> --strip-elm-annotations --complete-terminology
  git diff measures/official     # sha256 moves, truncated → [], a completion block appears
  pnpm test:official-cases       # then commit the regenerated report
  ```

  A new completion changes `officialLogicVersion` (ADR-040) and invalidates that measure's `eval_state`.
- `pnpm official:terminology-audit [<MADiE name>]` lists value sets the ELM retrieves but the bundle does
  not ship (CMS138 is the known case). Only VSAC fixes those; the MADiE deck is the real check.

##### Step 1b — vendoring a NEW measure when you cannot read the secret

```bash
gh workflow run vendor-official-measure.yml -f measure=CMS138FHIRTobaccoScrnCessation -f catalog_id=cms138
gh run watch
gh run download <run-id> -n vendored-cms138 -D backend-ts/measures/official/cms138   # -D = the catalog dir
```

It uploads `bundle.json` + `manifest.json` only (never the licensed `terminology.json`), and fails
without the credential or with an incomplete artifact. Then, in one PR: commit both files and add the
measure to `OFFICIAL_GATED_MEASURES`, both deploy workflows' vendor lists and `fetch-official-cases.ps1`.

### Flipping a measure to official execution — pre-flip checklist (ADR-043)

Routing is `WORKWELL_OFFICIAL_MEASURES`: **TWH `cms122,cms125`; Maui
`cms122,cms125,cms2,cms130,cms165,cms137`** (ADR-078). Pass a stack's current list to flip tooling.
A missing artifact, sidecar or complete expansion refuses. A whole roster falling **outside the
initial population** does not — it completes with MISSING_DATA and a `WARN`. This catches it:

1. **The gate is green.** These self-skip without the sidecar, so run them explicitly and **expect
   `skipped 0`** (a new sidecar-reading test must be added to CI's `official-cases` job):

   ```bash
   cd backend-ts
   pwsh -NoProfile -File scripts/fetch-official-cases.ps1
   WORKWELL_VSAC_API_KEY=<umls-api-key> pnpm vendor:official --measure <Name> --catalog-id <id> --strip-elm-annotations --complete-terminology
   pnpm exec node --import tsx --test src/wiring/official-corpus-outcomes.test.ts src/engine/ingress/webchart/devdb-official-eval.test.ts
   pnpm test:official-cases
   ```

   **No authored counterpart (cms2, cms130, cms165, cms137) ⇒ use `flip-gate`, not `flip-snapshot`
   (ADR-072):** `WORKWELL_INSTANCE=maui WORKWELL_MAUI_CORPUS_SIZE=20000 WORKWELL_OFFICIAL_MEASURES=<list>
   pnpm flip-gate --measure <id> --evaluation-date <YYYY-MM-DD> [--subjects 2000|all]`. It reports the
   MADiE deck, the deployment's own roster and the artifact's `effectivePeriod`, writes
   `.flip-gate/<id>-<date>.json` for the PR, and always exits 0. Use `--subjects all` for evidence.
   cms122/125/130/165 sidecars are VSAC-completed, so locally they read UNAVAILABLE — run the manual
   **`flip-gate.yml`** instead. cms165 on real WebChart data also needs profile-stamped BPs (#591).

2. **Take the before/after snapshot and confirm a NON-ZERO initial population:**

   ```bash
   pnpm flip-snapshot --measure <id> --source synthetic --eval <YYYY-MM-DD>   # stack with no WORKWELL_WEBCHART_*
   pnpm evaluate:webchart-live --list-patients > roster.json                   # WebChart stack: map the tenant's ids
   WORKWELL_WEBCHART_BASE_URL=… WORKWELL_WEBCHART_CLIENT_ID=… WORKWELL_WEBCHART_PRIVATE_KEY_B64=… \
     pnpm flip-snapshot --measure <id> --source live --roster roster.json --eval <YYYY-MM-DD>
   ```

   Verdict **DO NOT FLIP** = official admits nobody while authored finds subjects (a data/mapping gap);
   **INCONCLUSIVE** = neither finds anyone; no verdict = proceed. It exits 0; a human decides — never
   wire it into CI. `--source fixture` is not a substitute for `live`; `synthetic` is an
   engine-agreement check, not a roster forecast.

3. **Check the numerator, not just membership** (ADR-044: CPT vs LOINC mammograms made screened women
   OVERDUE).

4. **Edit the workflows, never the container**: the stack's deploy **and** reconcile workflow.
   `official-flip-config.test.ts` fails the build if they disagree or a measure lacks its gate (ADR-045).

5. **Redeploy and check the signals.** A misconfiguration does not fail boot: grep
   `WORKWELL_ALERT {"kind":"OFFICIAL_ROUTING_MISCONFIGURED"` (health stays 200 while evaluations 500).
   Then run one population run: `run_logs` shows `N subject(s) evaluated in one official batch` per
   routed measure, plus the ADR-043 `WARN` if a roster fell out of the population.

**Reversible:** remove the id from both workflows and redeploy; `logic_version` carries the artifact's
identity (ADR-040), so no cache cleanup is needed.

### The deploy script and the Container Manager API

- **v1 API** (`<manager-origin>/api/v1`): `{"data": …}` envelopes; create body `template` +
  `services[]`; job polling reads `.data.status == "success"`.
- Job poll `DEPLOY_JOB_POLL_ATTEMPTS` × 10 s (default 90, max 360) — raise it on a dispatch if a slow
  pull times out; then container status is polled 18 × 10 s for `running`.
- 10 s connect / 30 s total per request. `GET` retries 6× 20 s apart; `POST`/`DELETE` are sent once.
- **An ambiguous `DELETE` is resolved by reading the manager back** (`mieweb-delete-confirmed.sh`):
  absent ⇒ continue; could not tell ⇒ fail the job; still registered ⇒ re-issue, which
  re-targets the id the manager itself just reported. Knobs: `MIEWEB_DELETE_ATTEMPTS` (3),
  `MIEWEB_DELETE_CONFIRM_ATTEMPTS` (6), `MIEWEB_DELETE_CONFIRM_DELAY_SECONDS` (10). Pinned by
  `mieweb-delete-confirmed{,.integration}.test.sh` and `mieweb-api-request.test.sh` in CI.

### Required GitHub Secrets for MIE deploy

The deploy fails if a required secret is missing. Suffixed secrets map to unsuffixed runtime names
(`DATABASE_URL_TWH` → `DATABASE_URL`); a `jdbc:` prefix is stripped.

| Secret | Purpose |
|---|---|
| `LAUNCHPAD_API_URL`, `LAUNCHPAD_API_KEY` | Container Manager API (every deploy/reconcile) |
| `DATABASE_URL_TWH` / `_MAUI` / `_STAGING` | Neon **pooled** URL per stack; also the backup job. Maui/staging read `_TWH` only to refuse a same-host paste |
| `WORKWELL_AUTH_JWT_SECRET_TWH` / `_MAUI` / `_STAGING` | JWT signing secret |
| `OPENAI_API_KEY` | AI surfaces |
| `WORKWELL_VSAC_API_KEY_VENDOR` | build-time VSAC (Step 1a); CI, deploys, flip-gate, vendor, cross-engine-sweep |
| `WORKWELL_VSAC_API_KEY_TWH` | runtime VSAC resolver on TWH **and** Maui |
| `WORKWELL_BUCKET_S3_ACCESS_KEY_ID_TWH` / `SECRET_ACCESS_KEY_TWH`, `…_MAUI` | R2 token per evidence bucket |
| `WORKWELL_R2_S3_ENDPOINT` | R2 endpoint (secret because it embeds the account id; the repo is public) |
| `WORKWELL_BACKUP_S3_ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` | R2 token for `workwell-backups` |
| `WORKWELL_WEBCHART_PRIVATE_KEY_STAGING` | teatea SMART key (staging) |
| `NPM_TOKEN` | `publish-packages.yml` |

### Backend runtime configuration (set by the workflow / container)

Both live stacks ship: `MIEWEB_TARGET=local`, `WORKWELL_ENVIRONMENT=production`, `DATABASE_URL`,
`OPENAI_API_KEY`, `WORKWELL_CORS_ALLOWED_ORIGINS` + `CORS_ALLOWED_ORIGINS` (the frontend URL),
`WORKWELL_AUTH_COOKIE_SAME_SITE=None`, `WORKWELL_AUTH_COOKIE_SECURE=true`, `WORKWELL_AUTH_JWT_SECRET`,
`WORKWELL_INSTANCE`, `WORKWELL_SCHEDULER_ENABLED=true`, `WORKWELL_OFFICIAL_MEASURES`,
`WORKWELL_VSAC_API_KEY` and the five `WORKWELL_BUCKET_S3_*`; Maui adds the corpus variables.
`WORKWELL_EMAIL_PROVIDER` is unset, so email stays simulated. The reconcilers duplicate this array —
**keep-in-sync**.

`WORKWELL_ENVIRONMENT=production` arms `config/startup-safety.ts`: auth on, JWT secret ≥32 chars and not a
demo value, exact CORS origins, refresh cookie `SameSite=None; Secure` (frontend and API are different
origins; otherwise silent refresh fails).

Frontend: env `NODE_ENV=production`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_API_BASE_URL`; build args
`NEXT_PUBLIC_API_URL`, `_APP_NAME`, `_APP_TAGLINE`, `_APP_DESCRIPTION`, `_CODIFY_INDEX_URL` (repo
variable); Maui adds `NEXT_PUBLIC_SUBJECT_TERM=patient` and `NEXT_PUBLIC_PUBLIC_DEMO=off`.

### Deployment profiles

`WORKWELL_INSTANCE` (unset/`default`/`twh`, or `maui`) selects visible and evaluable tenants and runnable
measures, and the backend `subjectTerm` (`employee` | `patient`) used in AI prompts, outreach and CSV
headers; `NEXT_PUBLIC_SUBJECT_TERM` must match.

#### The Maui roster is a generated corpus (ADR-075)

Deploy and reconcile must ship **identical** values (`official-flip-config.test.ts` checks).

| Variable | Maui | TWH | Notes |
|---|---|---|---|
| `WORKWELL_MAUI_CORPUS_SIZE` | `20000` | unset (48) | Changing it is a recreate, not a migration; the first N patients never change. |
| `WORKWELL_MAUI_CORPUS_SEED` | unset (`maui-py2027-v1`) | unset | Changing it makes *different people* under the same ids. |
| `WORKWELL_RUN_CHUNK_SIZE` | `500` | unset (500) | Subjects per chunk; bounds memory. |
| `WORKWELL_SCHEDULER_ANCHOR_HOUR_UTC` | `12` | unset (12) | Nightly hour (12 UTC = 02:00 HST). The 23.5-hour debounce is a floor beneath the anchor, not the cadence. |
| `WORKWELL_OUTCOME_RETENTION_DAYS` | **`400`** | unset (off) | ADR-073/077. Keeps each subject's newest row per `(measure, period)`, run rows and case-cited rows. Needs the keep-set indexes `schema-pg.ts` creates. |

Clinical facts follow the calendar year of each run's evaluation date. Turning retention on deletes a lot
at once: run the first pass by hand with `pnpm outcomes:compact`.

#### Segment repair after adding a tenant, site or routed measure (owner-gated)

Case creation is gated by segment applicability, and the baseline segment (`All Employees` / `All
Patients`) lists sites **and** measures. A fresh database derives it; an already-seeded one never changes
(seeding never mutates). So after adding a tenant, site or routed measure, widen it via the audited
`PUT /api/segments/:id` (`/admin → Groups`, writes `SEGMENT_UPDATED`) — never edit the tables. A run
writes a `WARN` containing `no segment makes them applicable` when this is owed. Done on both live stacks
(TWH 2026-06-29; Maui #536).

### Operating the live stacks

- **Start runs with `POST /api/runs/manual`.** A bare `POST /api/runs` creates an unclaimable `QUEUED`
  run that sits until the boot sweep fails it after 6 h.
- **Stuck runs:** at boot, a `RUNNING` run created before this process started is failed and audited
  (`RUN_RECOVERED`). **One backend container at a time is assumed** — a second would sweep live runs.
- **Read-model warm (ADR-087):** a deploy empties every in-process memo; boot warms them in the
  background. Grep `read models warmed at boot in <ms>ms` or `boot read-model warm failed after …`, or
  read `lastWarm` on `/health` (every pass: `boot`, `nightly`, `run`) and `warms`, with the error, on
  `/api/admin/runtime` (#615).
  The cold path's worst statement, the winners probe, is served by `spike_outcomes_run_measure_idx`
  (#615; created at boot by the schema DDL).
- **Measure performance on a quiet, warm worker** — not during the nightly (12:00 UTC, ~90 min on Maui)
  and not in the first minutes after a deploy.

### Which run scopes are SCHEDULED, and which answer in the request (ADR-085, #590)

`ALL_PROGRAMS`, `SITE` and `MEASURE` are scheduled: **201** with `status: RUNNING` and a `runId` — poll
`GET /api/runs/:id`. `EMPLOYEE` runs in the request. **Never retry a run you think failed**: the retry
also runs, and two 20,000-patient runs exhaust the 10-connection pool (`503 pool_exhausted`). On a 504,
check `GET /api/runs?status=RUNNING` first.

### If requests are slow while a run is in flight (ADR-085)

Authored measures yield after every subject. Official measures run each chunk in one `fqm-execution`
call that cannot yield; the only lever is `WORKWELL_RUN_CHUNK_SIZE` (smaller = shorter stalls, more DB
round trips). Measure it on your deployment:

```bash
curl -s "$BASE/api/runs/manual" -X POST -H "$AUTH" -d '{"scopeType":"ALL_PROGRAMS"}'
curl -s "$BASE/api/runs/$RUN_ID" -H "$AUTH" | jq -r '.logs[] | select(.message|test("ms/subject"))'
```

### The API answers nothing, `/health` included (#663)

TLS completes but nothing answers = a **blocked event loop** (`/health` does no I/O). **Read the log
before healing** — a recreate discards it. `WORKWELL_ALERT {"kind":"EVENT_LOOP_STALL_ONGOING",…}` is
written by a watchdog thread *during* the stall and names the longest-running requests;
`{"kind":"EVENT_LOOP_STALL",…}` follows once it ends (max one a minute). Afterwards `GET /health` shows
`build.sha`, `startedAt`/`uptimeSeconds` and `eventLoop`; `GET /api/admin/runtime` (ADMIN) shows what ran.

A stall past 30 s also writes its report to `var/stall-evidence.json` on the container's disk
(`WORKWELL_STALL_EVIDENCE_PATH`). **Heal by restarting, not recreating:** the reconcilers now send a
restart-only request (`PUT /sites/{site}/containers/{id}` with `{"restart": true}`) and recreate only if the
API is still down after it. A restart keeps the disk, so the next boot logs
`WORKWELL_ALERT {"kind":"PREVIOUS_PROCESS_STALLED",…}` and shows the report as `previousStall` on
`/api/admin/runtime` (timings on `/health`). A recreate deletes it, as it deletes the logs.

### Run phase timing (#563) — `WORKWELL_RUNTIME`

Each official batch logs `WORKWELL_RUNTIME {"kind":"evaluateBatch",…,"batchMs","bundleMs","evalMs",
"msPerSubject","outcome"}` (separate from `WORKWELL_ALERT` on purpose). `batchMs` is one uninterrupted
synchronous stretch; `bundleMs` points at the bundle source, `evalMs` at chunk size. The same numbers are
on the run log's per-measure INFO line (`GET /api/runs/:id`) for anyone without container-log access.

Since #604 that stretch runs in worker threads (`wiring/fqm-worker.ts`), so it no longer stalls the event
loop; `batchMs` still measures it. A chunk's measures are calculated side by side on a pool of
`WORKWELL_FQM_WORKERS` workers (default 2, never more than the cores minus one; ~500 MB each while busy,
released after 5 idle minutes). `WORKWELL_FQM_WORKERS=1` is one worker; `WORKWELL_FQM_WORKER=off` runs the
calculation in-process again (the escape hatch if the workers misbehave). `cpus` and `memoryLimitMb` are on
`/api/admin/runtime`.

### Failed-run alerts (#264)

A FAILED/PARTIAL_FAILURE population run, a stuck-run recovery or a scheduler tick throw emits one
`WORKWELL_ALERT {"kind":…}` log line, plus a JSON POST to `WORKWELL_ALERT_WEBHOOK_URL` when set.

### On-demand data tools (never run on deploy; owner-run)

From `backend-ts/`, with `DATABASE_URL` set. Idempotent and resumable. Undo SQL is schema-qualified
`workwell_spike.`; delete tagged `outcomes` before `runs` (no cascade).

| Command | Writes | Status | Undo |
|---|---|---|---|
| `pnpm seed:scale --subjects N --as-of <date> [--workers n]` | the `mhn` scale tenant (real batch evaluation) | TWH: 5,000 (done) | rows of runs with `triggered_by='seed:scale'` |
| `pnpm seed:quality-history --months 12 --as-of <YYYY-MM>` | past `quality_snapshots` | TWH: done | `DELETE FROM quality_snapshots` |
| `pnpm seed:trend-history --weeks N --as-of <date>` | synthetic weekly runs | refuses under retention | `triggered_by='seed:trend-history'` |
| `pnpm resolve-valuesets --manifest <canonical> [--official <id>]` | VSAC expansions into `value_sets` (descriptive) | TWH: done | `DELETE FROM value_sets WHERE source='VSAC'` |
| `pnpm outcomes:compact` | one retention pass | also runs after each Maui nightly | none |

A crashed `seed:scale` leaves RUNNING runs that are not auto-swept — roll back before resuming.

### Manual re-deploy (force update existing containers)

Actions → the stack's deploy workflow → Run workflow, `replace_existing: true`.

### Maui sandbox deployment

The pilot group's sandbox (`deploy-maui-mieweb.yml`), with its own Neon project, JWT secret and R2 bucket
(`workwell-evidence-maui`); env as above with `WORKWELL_INSTANCE=maui` and the six routed measures.

- **Isolation guard:** deploy and reconcile refuse when `DATABASE_URL_MAUI` has the same host as
  `DATABASE_URL_TWH`.
- **Backend tags are namespaced — do not "simplify" this.** Maui deploys `maui-sha-<SHA>` and must never
  publish `:latest`, which TWH's reconciler heals from.
- **Recovery tags name the last SUCCESSFUL DEPLOY.** After a container is up, its deploy job re-points
  `maui-latest` (backend) or the frontend's `:latest` at the deployed digest (`docker buildx imagetools
  create`). `reconcile-maui-mieweb.yml` heals from those, never onto a failed build.
- Demo accounts are profile-scoped (#520): only `@maui.workwell.dev` accounts sign in on Maui, and they
  are refused elsewhere. Password: the shared demo password in `backend-ts/src/auth/demo-users.ts`.

| Identifier | Role |
|---|---|
| `quality-lead@maui.workwell.dev`, `quality-staff@maui.workwell.dev` | `ROLE_CASE_MANAGER` |
| `clinician@maui.workwell.dev` | `ROLE_VIEWER` |
| `admin@maui.workwell.dev` | `ROLE_ADMIN` |

### Staging environment — live WebChart against teatea (separate stack; NOT the demo)

`deploy-staging-mieweb.yml` (dispatch, from the branch to test) runs live against the teatea WebChart
trial (synthetic data). Separate Neon project (the deploy refuses TWH's host; create it on Postgres 16,
us-east-1, 0.25–2 CU), `staging-*` tags, scheduler off, no self-heal.

- The only WebChart secret is the plain PEM `WORKWELL_WEBCHART_PRIVATE_KEY_STAGING` (set it from the file:
  `Get-Content key.pem -Raw | gh secret set WORKWELL_WEBCHART_PRIVATE_KEY_STAGING`); the workflow
  base64-encodes it. teatea 403s a bare `GET /Patient`, so the workflow sets
  `WORKWELL_WEBCHART_PATIENT_SEARCH=birthdate=le9999-12-31`.
- **Residual gap:** the client detects a truncated fetch (`Bundle.total`) but not a query that
  under-matches, and no birthdate bound reaches a record with no `birthDate`; teatea has no `$export`.
- Verify: staging's seam line reads `webchart=on`; TWH and Maui still read `webchart=off`. When the trial
  lapses, live runs fail and the prior population stays authoritative.

### Service startup & reboot policy

**Live stacks.** Restart-on-reboot is Proxmox `onboot`, which the manager API neither exposes nor lets us
set. The **reconcilers** cover it regardless: every 15 min (cron) or on dispatch they probe the frontend
and `/actuator/health` (6 tries over ~3 min) and recreate a down container from its recovery tag
(`:latest` for TWH, `maui-latest` for Maui). **The cron is not a recovery-time guarantee** — GitHub
delivers scheduled runs hours apart; to heal now, run the reconcile workflow by hand.

**Self-hosted / VM / local.** `infra/docker-compose.yml` services are `restart: unless-stopped`, and
`infra/systemd/workwell.service` starts the stack on boot (`infra/systemd/README.md`):
`sudo systemctl enable docker && sudo systemctl enable --now workwell`.

---

## Environment variables reference

`B` = backend container env, `F` = frontend build arg/env. `.env.example` mirrors the names.

| Var | | Purpose |
|-----|---|---------|
| `DATABASE_URL` | B | Pooled Neon URL ⇒ Pg ceiling; unset ⇒ SQLite floor (`WORKWELL_SQLITE_PATH`). |
| `WORKWELL_ENVIRONMENT` | B | `production` arms startup safety (`SPRING_PROFILES_ACTIVE=prod` and `NODE_ENV=production` also count). |
| `WORKWELL_INSTANCE` | B | Deployment profile. |
| `OPENAI_API_KEY` | B | AI surfaces (deterministic fallbacks, `AI_GUARDRAILS.md` §5); `WORKWELL_AI_OPENAI_MODEL` / `_FALLBACK_MODEL` override models; both must accept the options in `AI_PROMPTS.md` §3. |
| `WORKWELL_AUTH_ENABLED`, `WORKWELL_AUTH_JWT_SECRET` | B | Auth defaults on; `false` refused in production. |
| `WORKWELL_AUTH_COOKIE_SAME_SITE` / `_SECURE` | B | **`None` / `true` in production**; defaults `Lax` / `false` locally. |
| `WORKWELL_CORS_ALLOWED_ORIGINS` | B | Exact origins; production refuses wildcard/blank/`localhost` with **503 `unsafe_configuration`**. First origin = Studio link in CDS cards; add a browser CDS client's origin deliberately (ADR-067). |
| `WORKWELL_SCHEDULER_ENABLED` | B | `true` enables the nightly scheduler. |
| corpus / chunk / anchor / retention vars | B | See the Maui table. |
| `WORKWELL_OFFICIAL_MEASURES` | B | Catalog ids run by the official artifact; `all` refused. Workflow edit only (flip checklist). |
| `WORKWELL_VSAC_API_KEY`, `WORKWELL_VSAC_BASE_URL` | B | Runtime VSAC resolver (ADR-023); base defaults to `https://cts.nlm.nih.gov/fhir`. |
| `WORKWELL_BUCKET_S3_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | B | Evidence bucket; **all three** or evidence falls back to the in-container `fs` (lost on recreate). |
| `WORKWELL_BUCKET_S3_REGION`, `_ENDPOINT` | B | `auto` on R2; a non-empty endpoint also switches to path-style. |
| `WORKWELL_ALERT_WEBHOOK_URL` | B | Optional POST of each `WORKWELL_ALERT`. |
| `WORKWELL_INCREMENTAL_EVAL` | B | `true` enables outcome reuse (ADR-035); off on live stacks; undo `DELETE FROM eval_state`. |
| `WORKWELL_EMAIL_PROVIDER`, `WORKWELL_EMAIL_SENDGRID_API_KEY` | B | **Simulated on the live stacks (hard rule).** SendGrid only with both set, non-demo. |
| `WORKWELL_IMMZ_ICE_BASE_URL` / `_API_KEY` | B | Real ICE forecaster (below); unset on live stacks. |
| `WORKWELL_WEBCHART_BASE_URL` + `_CLIENT_ID` + `_PRIVATE_KEY_B64` | B | SMART Backend Services (ADR-028); **unset on TWH and Maui**. Deployed stacks use `_B64` (whole PEM, `base64 -w0`) — a multi-line value is truncated at the first newline. `_PRIVATE_KEY` is for local use. |
| `WORKWELL_WEBCHART_TOKEN_URL`, `_SCOPE`, `_KID`, `_API_KEY`, `_DISABLE_COUNT`, `_PATIENT_SEARCH`, `_ENROLLMENT_JSON` | B | Optional WebChart knobs (token URL override, scope default `system/*.rs`, JWK kid, legacy bearer, skip `_count`, population query, enrollment map). |
| `WORKWELL_WEBCHART_LIVE_TEST_BASE_URL` | test | Gates live-HTTP tests. **Never on a deployed stack.** |
| `NEXT_PUBLIC_API_BASE_URL` | F | Backend origin — no `/api` suffix, no trailing whitespace. |
| `NEXT_PUBLIC_APP_NAME` | F | Display name. |
| `NEXT_PUBLIC_DEMO_MODE` | F | Local login prefill; `true` fails the production build. |
| `NEXT_PUBLIC_SUBJECT_TERM` | F | `employee` or `patient`; anything else silently becomes `employee`. |
| `NEXT_PUBLIC_PUBLIC_DEMO` | F | `off` (Maui) hides public demo links and is pilot mode: non-admins lose engineering surfaces (`frontend/lib/public-demo.ts`). |

### Local HAPI live-tenant recipe (ADR-032)

```powershell
docker compose -f infra/docker-compose.yml up -d hapi-fhir
Set-Location backend-ts; corepack pnpm load:hapi
$env:WORKWELL_WEBCHART_BASE_URL = "http://localhost:8081"; $env:WORKWELL_WEBCHART_API_KEY = "local-dev"
corepack pnpm dev
```

An `ALL_PROGRAMS` run should show 56 `wc|` rows and `All Systems = Σ tenants`. Live-HTTP tests: set
`WORKWELL_WEBCHART_LIVE_TEST_BASE_URL` and run `hapi-live.test.ts` / `hapi-app-live.test.ts`.

### Local WCDB shim live-tenant recipe (ADR-034) — SQL-backed alternative to HAPI

`docker compose -f infra/docker-compose.yml --profile wcdb up -d wcdb wcdb-fhir-shim`, then the HAPI
recipe with `WORKWELL_WEBCHART_BASE_URL=http://localhost:8085`. Local only (`wcdb-fhir-shim/README.md`).

### Email delivery

Outreach is simulated: each attempt lands in `outreach_delivery_log` with `status=SIMULATED`. SendGrid
(`backend-ts/src/case/email-service.ts`) is an inert stub. `POST /api/admin/demo-reset` truncates demo
tables (including `audit_events`) and returns 403 in production.

### Immunization forecasting (ICE sidecar) — ADR-029, opt-in, NOT on the live stacks

`docker run -d -p 32775:8080 --memory=3g hlnconsulting/ice:latest`, then
`WORKWELL_IMMZ_ICE_BASE_URL=http://localhost:32775/opencds-decision-support-service`. Needs 2–3 GB and a
slow cold start. Calls time out at 3 s and fall back to the simulated forecast (60 s circuit breaker);
grep `ICE forecast failed` if forecasts look simulated. Advisory only.

### Evidence upload persistence (Cloudflare R2) — #167 / ADR-030

Evidence goes through `resolveBucket(env)` (`backend-ts/src/case/resolve-bucket.ts`). Buckets (all
private, one token each, so the app cannot reach the dumps): `workwell-evidence-twh`,
`workwell-evidence-maui`, and `workwell-backups` (`db-dumps/twh/`, `db-dumps/maui/`, lifecycle
`expire-dumps-30d`). The `WORKWELL_BUCKET_S3_*` keys must match between a stack's deploy and reconcile
workflows. Attachments from before 2026-09-11 that pointed at the old AWS bucket are unrecoverable; reads
fail with `EvidenceMissingError`.

### The evidence bucket is probed at boot (#473)

`probeEvidenceBucket` (`backend-ts/src/case/bucket-health.ts`) **lists** an empty prefix once per process
(never a `get`, which reads `NoSuchBucket` as "not found"). Failures log
`WORKWELL_ALERT {"kind":"EVIDENCE_BUCKET_UNREACHABLE","status":"EVIDENCE_BUCKET_UNREACHABLE"|"EVIDENCE_BUCKET_NOT_CONFIGURED",…}`
— the second means a bucket is named but a credential is empty.

---

## Schema changes apply themselves

All DDL is `IF NOT EXISTS` in `schema-pg.ts` / `schema.ts`, run on boot; a fresh database needs no
manual step. DDL is owner-approved (`CLAUDE.md`). Panels (ADR-080) and attributed lists (ADR-082) need
no backfill; map panels in-app at `/worklist?tab=panels`.

**Attributed lists (ADR-082):** import answers 403 whenever WebChart is configured; on synthetic stacks
an identifier outside the namespace (`pat-…` Maui, `emp-…` TWH) refuses the whole upload. **Ops
stopgap:** keep every report handed to the ACO as a dated CSV in the R2 evidence bucket — a live
re-render is refused once its runs pass the retention cutoff (ADR-077).

## One-time backfill — `outcomes.out_of_population` (ADR-079, 2026-09-10)

Pre-column rows are NULL (read as in-population); only official outcomes carry the flag. **Applied on
Maui 2026-09-11. Not recorded as run on TWH**, whose cms122/cms125 rows from before 2026-09-10 are still
NULL. Fresh databases don't need it. `populationResults` is an **array** of `{populationType, result}`.
On the direct URL, keeping statements free of leading comment lines (a splitter dropped them once):

```sql
BEGIN;
UPDATE workwell_spike.outcomes o SET out_of_population = TRUE
 WHERE o.out_of_population IS NULL AND o.status = 'MISSING_DATA'
   AND o.evidence_json ? 'official' AND NOT (o.evidence_json ? 'evaluationError')
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(
       CASE WHEN jsonb_typeof(o.evidence_json #> '{official,rates}') = 'array'
             AND jsonb_array_length(o.evidence_json #> '{official,rates}') > 0
            THEN o.evidence_json #> '{official,rates}'
            ELSE jsonb_build_array(o.evidence_json #> '{official,populationResults}') END) AS rate
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(rate) = 'array' THEN rate ELSE '[]'::jsonb END) AS pop
     WHERE pop ->> 'populationType' = 'initial-population'
       AND COALESCE((pop ->> 'result')::boolean, FALSE));
UPDATE workwell_spike.outcomes o SET out_of_population = FALSE
 WHERE o.out_of_population IS NULL
   AND o.evidence_json ? 'official' AND NOT (o.evidence_json ? 'evaluationError');
SELECT measure_id,
       COUNT(*) FILTER (WHERE out_of_population)          AS not_in_population,
       COUNT(*) FILTER (WHERE out_of_population IS FALSE) AS in_population,
       COUNT(*) FILTER (WHERE out_of_population IS NULL)  AS still_unrecorded,
       COUNT(*) FILTER (WHERE status = 'MISSING_DATA' AND out_of_population IS FALSE) AS in_population_missing
  FROM workwell_spike.outcomes GROUP BY measure_id ORDER BY measure_id;
COMMIT;  -- or ROLLBACK
```

Before COMMIT, `in_population` must equal each measure's initial population (any rate's IPP, excluded
subjects included). **Then restart the backend** (dispatch the deploy with `replace_existing=true`): the
read models memoize by winning run and would keep serving old numbers. Rates rise sharply — warn anyone
holding earlier figures. Rollback: `UPDATE workwell_spike.outcomes SET out_of_population = NULL;`.

## Database compute cost (read before changing any polling interval)

Neon bills CU-hours while the compute is **awake**; it suspends only after an idle timeout. A timer that
queries more often than that pins it awake 24/7 (~182 CU-hours/month at 0.25 CU with no users) — it once
exhausted the Free plan and every DB route returned `{"error":"internal_error"}` (HTTP 402 from the
pooler). **If every DB route fails at once, check the Neon quota before reading code.**

**Invariant:** a recurring task that queries the database runs less often than the suspend timeout, or
gates itself behind a DB-free check. `schedulerTick` keeps `shouldSkipTickWithoutDb()` as its first
statement; keep the `setInterval` in `backend-ts/src/server.ts` well above the suspend timeout.

### Console settings that cap the bill

Neon console → Settings: a **spending limit** (e.g. $10–20/mo, the real backstop), suspend timeout 60 s,
autoscaling 0.25–1 CU to start.

### Watch the right signal

`/actuator/health` is **deliberately DB-free** — never add a query to it, or the reconciler becomes a
compute-pinning loop. So the reconciler reads green through a database outage (and through a misrouted
measure or a dead bucket). The real database check is `backup-neon-nightly.yml` (03:17 UTC, both stacks):
on failure it opens or comments on the issue "Nightly Neon backup is failing" (Maui: "… (Maui pilot)")
and closes it on the next success. **Treat that issue as a production incident.**

## Neon (Postgres)

One project per stack, **Postgres 16** (TWH: `workwell-twh`, AWS us-east). The pooled URL goes in the
stack's `DATABASE_URL_*` secret; the direct URL is for owner-run `psql` and scripts. `neonctl projects
create` defaults to Postgres 17 — pass 16 or use the console. The app pool is `max: 10`.

### The statement timeout is a ROLE DEFAULT, set by hand, once per project (#562, ADR-084)

Neon's proxy silently drops a `statement_timeout` in the startup packet and rejects `options=-c …`, so the
pool sets none. **Done on both live projects 2026-09-20; required on any new one.** Deploy the app first
(the nightly compaction opts out via `withStatementTimeoutDisabled`).

```sh
psql "<direct url>" -c "ALTER ROLE <app role> SET statement_timeout = '30s';"
psql "<direct url>" -c "show statement_timeout"                             # expect 30s
psql "<direct url>" -c "ALTER ROLE <app role> RESET statement_timeout;"     # rollback
```

- **One pooled check reads `0`, and that is not failure** — warm pooler backends predate the default.
  Hold ~10–20 concurrent connections and read `select current_setting('statement_timeout'), (select
  source from pg_settings where name='statement_timeout');` — new backends show `30s` / `user`.
- Prove it fires: `select pg_sleep(35)` must fail with SQLSTATE `57014`, which the worker maps to a 503.
- 30 s sits under the 60 s gateway cut. `pg_dump` sets its own timeout to 0; run one backup smoke test after.

## OpenAI

Set a hard monthly usage limit and store the key only as the `OPENAI_API_KEY` secret.

## CI/CD

- `ci.yml` (every branch push, dispatch; no `pull_request` trigger, so a PR's checks are its head
  commit's push run): frontend lint/test/build; backend typecheck, gates and tests in 3 shards; the
  credentialed MADiE gate; packages; the Maui Playwright suite. Never deploys.
- Deploy: `deploy-twh-mieweb.yml`, `deploy-maui-mieweb.yml` (push + dispatch; docs-only pushes skip),
  `deploy-staging-mieweb.yml` (dispatch). Self-heal: the two `reconcile-*` workflows.
- `backup-neon-nightly.yml` (nightly). Credentialed manual jobs: `vendor-official-measure.yml`,
  `flip-gate.yml`, `cross-engine-sweep.yml`. `publish-packages.yml` (dispatch, dry run by default;
  irreversible — `docs/PACKAGES.md`).

## Health checks

- Backend: `GET /api/version` → `{"api":"v1",…}`; `/actuator/health` → `{"status":"UP"}`; `/health` adds
  `build.sha` — confirm it is the commit you deployed.
- Frontend: `/` → 200. DB: `psql "<direct url>" -c "SELECT 1"`.
- All health endpoints are DB-free, so also grep the log for `WORKWELL_ALERT` and the boot warm line.
- `scripts/smoke-shadow.sh https://<api-host>` runs the post-deploy checklist (health, runs, open cases,
  the four CSV exports, integrations, MCP sync, outreach delivery) as PASS/FAIL/WARN; WARNs are known
  limitations (its evidence line predates R2; `/sse` is the ingress caveat below).

## Rollback

No migration to undo — the schema is additive. Roll back by redeploying an earlier image:

- **TWH:** dispatch `deploy-twh-mieweb.yml` at the good SHA with `replace_existing: true`, or
  `git revert <bad-merge-sha>` on `main`. The next TWH heal recreates from `:latest` and **undoes a
  dispatch rollback** — revert on `main` too, or disable the reconciler meanwhile.
- **Maui:** dispatch `deploy-maui-mieweb.yml` at the good SHA with `replace_existing: true`; the recovery tag
  follows it, but the next push supersedes it, so revert on `main`.
- During an NLM VSAC outage only a pre-ADR-041 SHA can be rebuilt (Step 1a).
- Routing: remove the measure from both workflows. Data: `docs/BACKUP_DR_RUNBOOK.md`.

## Cost monitoring

Check the Neon dashboard (compute + storage) and OpenAI usage daily while a stack is live; fix anything
near a limit the same day.

## Troubleshooting

- **Every DB route returns `{"error":"internal_error"}`** → Neon quota (see Database compute cost).
- **`503 pool_exhausted`** → a second run in flight (`GET /api/runs?status=RUNNING`).
- **`503 statement_timeout`** → a read hit the 30 s role default, often a cold read model after a deploy.
- **Green container, every evaluation 500s** → grep `OFFICIAL_ROUTING_MISCONFIGURED`.
- **Evidence fails, health green** → grep `EVIDENCE_BUCKET_UNREACHABLE`.
- **MCP/SSE drops every ~60 s (504)** → MIE nginx defaults; the fix is an MIE vhost change on the SSE/MCP
  locations (`proxy_buffering off`, `proxy_read_timeout 3600s`, `proxy_http_version 1.1`, empty
  `Connection`). MCP is at `/sse` + `/mcp/**` and needs a WorkWell JWT (`docs/MCP.md`).
- **Deploy fails at the manager API (curl 7/28)** → check TCP 443 to `manager.os.mieweb.org`; don't loop
  state-changing requests by hand; when it recovers, `gh run rerun <run-id> --failed`.
- **`Container is 'offline', expected running`** after the ~3 min poll → the container did not start:
  check the image tag, env and secrets (startup safety throws on unsafe config), then dispatch the
  reconciler.
