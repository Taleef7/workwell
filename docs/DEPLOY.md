# Deployment Guide

**Stack:** MIE Create-a-Container (frontend + backend) + Neon (Postgres) + OpenAI API.
**Status:** Current deployment reference for the merged WorkWell Measure Studio stack.
**Cost target:** keep the live stack under about $25/month.

> The MIE TWH stack below is the **sole live deployment**. The earlier Vercel + Fly.io
> public-preview stack is **decommissioned** — its setup is retained only as
> [Appendix A](#appendix-a--decommissioned-vercel--flyio-stack-historical-reference) for historical reference.

---

## MIE Create-a-Container Deployment (sole live stack)

The deployment runs on MIE's internal container platform (`os.mieweb.org`).
**One instance only: TWH** — Total Worker Health. Encompasses all OSHA safety + eCQM wellness measures.

| Service | Hostname | Image |
|---------|----------|-------|
| Frontend | `twh.os.mieweb.org` | `ghcr.io/taleef7/workwell-twh-frontend` |
| Backend API | `twh-api-ts.os.mieweb.org` | `ghcr.io/taleef7/workwell-api-ts` — the de-Java TypeScript backend (`backend-ts/`), the sole backend |

> **#109 — JVM retired (PR4):** the frontend is served by the **TypeScript** backend (`twh-api-ts`);
> the Java backend (`twh-api`) has been retired (`backend/` deleted). The TS backend runs the `local`
> mieweb target (`MIEWEB_TARGET=local` — in-process bindings, no
> companion services, internal port **8080**) and overrides the DB to Neon via `DATABASE_URL` (the
> store factory then uses the Pg ceiling, isolated to the `workwell_spike` schema; Java's `public`
> tables are untouched). The `DATABASE_URL_TWH` secret is a **JDBC** URL (`jdbc:postgresql://…`); the
> workflow strips the `jdbc:` prefix for node-postgres. **Evidence upload is ephemeral** (in-container
> `fs` BUCKET) until a managed S3/R2 bucket is wired. See **Rollback** below.

### Deployment workflow

Push to `main` triggers `.github/workflows/deploy-twh-mieweb.yml` which:
1. Builds the **TypeScript** backend image (`workwell-api-ts`, from `backend-ts/Dockerfile`, repo-root
   context + `submodules: recursive`) tagged `latest` + `sha-<SHA>`
2. Builds the frontend image (TWH branding via build-args) pointed at `twh-api-ts.os.mieweb.org`
3. Deploys both containers to MIE via `.github/scripts/deploy-mieweb-container.sh`

The deploy script talks to the MIE Container Manager **v1 API** (`<manager-origin>/api/v1`):
responses are wrapped in a `{"data": ...}` envelope, the create body uses `template` with
`services` as an array of flat objects, and job polling reads `.data.status` (success value
`"success"`). See the 2026-06-03 JOURNAL entries for the v1 migration details (PRs #55, #56).

### Required GitHub Secrets for MIE deploy

| Secret | Purpose |
|--------|---------|
| `LAUNCHPAD_API_URL` | MIE Create-a-Container API base URL |
| `LAUNCHPAD_API_KEY` | MIE API authentication key |
| `DATABASE_URL_TWH` | Neon pooled connection string for TWH instance |
| `OPENAI_API_KEY` | AI services (Draft Spec, Explain Why Flagged) |
| `WORKWELL_AUTH_JWT_SECRET_TWH` | JWT signing secret for TWH instance |

The deploy workflow maps these `*_TWH` GitHub secrets onto the backend container's runtime
environment variable names (e.g. `DATABASE_URL_TWH` → `DATABASE_URL`,
`WORKWELL_AUTH_JWT_SECRET_TWH` → `WORKWELL_AUTH_JWT_SECRET`) used in the
[environment variables reference](#environment-variables-reference) below.

### Backend runtime configuration (set by the workflow / container)

- `WORKWELL_INSTANCE=twh` — selects TWH seeding (see below)
- `SPRING_PROFILES_ACTIVE=prod`
- `WORKWELL_AUTH_ENABLED=true`, `WORKWELL_AUTH_JWT_SECRET=<strong-random-secret>`
- `WORKWELL_AUTH_COOKIE_SAME_SITE=None`, `WORKWELL_AUTH_COOKIE_SECURE=true`
- `WORKWELL_EMAIL_PROVIDER=simulated` (must stay `simulated` on the demo stack)

> **Refresh-cookie config:** the refresh-token cookie is set `SameSite=None; Secure`, and
> production startup **fails fast** if `WORKWELL_AUTH_COOKIE_SAME_SITE` is not `None` or
> `WORKWELL_AUTH_COOKIE_SECURE` is not `true`. With the frontend (`twh.os.mieweb.org`) and
> API (`twh-api-ts.os.mieweb.org`) on split origins, this is what lets the browser send the
> cookie on the `POST /api/auth/refresh` fetch — otherwise silent token refresh fails and
> users are logged out on every reload.

### Instance seeding

The backend detects `WORKWELL_INSTANCE=twh` (set in the workflow) and seeds:
- All 4 OSHA surveillance measures with full CQL (Audiogram, HAZWOPER, TB, Flu)
- 4 HEDIS wellness catalog measures (Cholesterol, BMI, Diabetes HbA1c, Hypertension)
- All 49 CMS eCQM catalog entries (Draft, awaiting CQL authoring)

Total catalog: **60 measures** (see `docs/MEASURES.md` for the full breakdown).

#### One-time segment repair after adding a tenant (E13 PR-1, owner-gated)

> **✓ Done on 2026-06-29 (live Neon).** `PUT /api/segments/ad1facc4-14f5-4897-8d67-a3f9136c3f6c`
> widened `All Employees` from `["HQ","Plant A","Plant B","Clinic"]` to all 7 sites
> (`Clinic`, `HQ`, `North Campus`, `Outpatient Clinic`, `Plant A`, `Plant B`, `South Campus`).
> `SEGMENT_UPDATED` audit event recorded; `updatedAt` → 2026-06-29T15:12:24Z.
> If the stack is ever re-provisioned from a fresh DB, the seed auto-covers all sites — no repair needed.

The demo **risk-group segments** seed (`backend-ts/src/segment/segment-seed.ts`) is **name-idempotent**:
a boot over an already-seeded DB adds no duplicates and **never mutates an existing segment** (so it
can't clobber operator edits, and it writes no unaudited boot-time change). The universal
`All Employees` baseline now derives its cohort site list from the directory, so any **fresh** DB (the
SQLite floor, a new instance) automatically covers every tenant — including a newly added one (E13's
`ihn` / Indus Hospital Network campuses).

An **already-seeded** stack (the live Neon demo, seeded pre-E13) keeps its old `All Employees` row,
which lists only the original `twh` sites — so the new tenant's employees would read
`NOT_APPLICABLE` for the baseline wellness/eCQM measures until repaired. The repair is **owner-gated**
(like all data migrations): edit `All Employees` to add the new tenant's sites
(`North Campus`, `South Campus`, `Outpatient Clinic`) via the **audited** `PUT /api/segments/:id`
route — i.e. the `/admin → Groups` Configure Groups editor — which records a `SEGMENT_UPDATED` audit
event. (Do **not** hand-edit `segment_measures`/`rule_json` directly; use the route so the change is
audited.)

### Seeding synthetic trend history (on-demand, NOT auto-run on deploy)

The `/programs` + `/programs/[measureId]` trend charts can read as flat lines on a stack with only a
few real runs per measure. `pnpm seed:trend-history` backfills **synthetic demo data** — backdated
weekly COMPLETED runs per runnable measure — so the trends show realistic variation. It is a
controlled, on-demand tool and is **not run automatically on deploy**. Run it once against Neon from
`backend-ts/` (it honors `DATABASE_URL` for the Pg ceiling and opens no local SQLite file when set):

```bash
cd backend-ts
DATABASE_URL=<neon-pooled> pnpm seed:trend-history --weeks 12 --as-of 2026-06-21
```

It is idempotent and resumable at the week level — a rerun or a larger `--weeks` fills only missing
weeks, no duplicates. Seeded runs carry `triggered_by='seed:trend-history'` (labeled `SEED` on
`/api/runs`; real operator runs stay `MANUAL`) and are anchored strictly before each measure's latest
real run, so the programs overview is never affected.

**Rollback (reversible, synthetic data only) — delete tagged outcomes first, then runs**
(`outcomes.run_id` is not `ON DELETE CASCADE`; schema-qualify on the Pg ceiling):

```sql
DELETE FROM workwell_spike.outcomes
  WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history');
DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history';
```

### Seeding the population-scale tenant (E13 PR-2, on-demand, NOT auto-run on deploy)

> **✓ Done on 2026-06-29 (live Neon).** `pnpm seed:scale --subjects 120000 --as-of 2026-06-26`
> wrote **14 runs × 120,000 subjects = 1,680,000 outcomes** to `workwell_spike` (14 `SCALE_POPULATION_SEEDED`
> audit events). Live All Systems rollup = 1,682,100 (ihn 700 + twh 1,400 + mhn 1,680,000), all reconciling.
> Re-run only after rolling back (see SQL below) or to change `--subjects`.

`pnpm seed:scale` populates the **`mhn` ("MetroHealth Network") ~120k-subject tenant** so the
`/programs/hierarchy` rollup + the `/programs` KPIs aggregate a real population-scale system (Doug's
"120,000 people"). The subjects are **generated demo data** (not live CQL-evaluated) and exist only as
`outcomes` rows whose `subject_id` encodes the hierarchy (`mhn|Lxx|Pxx|n`) — **no schema change**. It is
a controlled, on-demand, owner-gated tool and is **not** run automatically on deploy. Run it once
against Neon from `backend-ts/` (honors `DATABASE_URL` for the Pg ceiling; opens no local SQLite when
set):

```bash
cd backend-ts
DATABASE_URL=<neon-pooled> pnpm seed:scale --subjects 120000 --as-of 2026-06-26
```

It writes one COMPLETED `MEASURE` run per runnable measure (`triggered_by='seed:scale'`, minimal
`evidence_json`), audited (`SCALE_POPULATION_SEEDED`). It is **idempotent** — a single existing
`seed:scale` run makes a rerun a no-op (re-seed after a rollback, or to change `--subjects`, requires
the rollback below first). The bounded SQL aggregation (`aggregateScaleRun`) is what keeps the rollup
fast at 120k — app memory never holds the per-subject rows. **Storage note:** 120k × 14 runnable
measures ≈ **1.68M `outcomes` rows** on Neon (minimal evidence keeps each row small); size accordingly
or seed fewer `--subjects`.

> **Now real batch CQL evaluation (2026-07-08, this branch — supersedes the fabricated path).**
> `seed:scale` now defaults to **`--mode evaluate`**: the `mhn` outcomes are produced by **real batch
> CQL evaluation** (engine `batchEvaluateScalePopulation`), not the previous fabricated compliance
> distribution. It is **subject-major** — each subject's FHIR bundle is generated once (default the
> `webChartRealisticGenerator`, emitting real LOINC/CVX/CPT codes routed through the WebChart terminology
> crosswalk, so the real WebChart adapter is genuinely exercised at scale — for **13 of the 14** runnable
> measures; `hazwoper` has no real terminology for OSHA 1910.120 surveillance and passes through on its
> synthetic code. Lab/vital measures re-code to a real LOINC Procedure, so the crosswalk runs but the
> Observation→Procedure *synthesis* half of the adapter is not exercised at scale — that path is covered
> by the offline #246 dev-DB proof), evaluated against all runnable measures, then fanned out to the
> per-measure `seed:scale` runs. It is bounded-memory (one
> chunk buffered), whole-batch resumable (per-measure idempotency on COMPLETED `seed:scale` runs; a crash
> before the finalize loop re-seeds all measures), and per-subject error-isolated (an evaluation failure
> persists `MISSING_DATA` with `{evaluationError, message}` evidence and never aborts the run). Each real
> run is audited with the new **`SCALE_POPULATION_EVALUATED`** event (the fabricated path used
> `SCALE_POPULATION_SEEDED`). The **`mhn|Lxx|Pxx|n` `subject_id` encoding, `aggregateScaleRun`, and the
> rollback SQL below are all unchanged** — only the outcomes' provenance changed (fabricated → real CQL).
>
> **⚠ Long-run warning + parallelism (#256).** `--mode evaluate` is CPU-bound — **measured cost (#253
> N=5000 live-Neon proof, 2026-07-09): ≈68 ms per evaluation overall** (70,000 evaluations in ~79.5 min
> wall-clock; ~63 ms/eval once host CPU contention eased — the first chunks ran at 86–88 ms/eval under 4
> concurrent build agents) — so a full 120k × 14 ≈ 1.68M evaluations is on the order of **~30 hours
> single-threaded** (`--workers 1`; a proof/dev run at `--subjects 5000` is ~80 min). A **worker
> pool** (`--workers <n>`, default **4**, clamped to `availableParallelism()-1`) parallelizes the evaluate
> phase across `node:worker_threads` — measured **3.7× at 4 workers / 5.1× at 8 workers** on a many-core
> host (N=500 × 14 measures: 693.6s → 187.5s → 136.3s; see `docs/JOURNAL.md` 2026-07-09), making the 120k
> dial usable (order of hours on 8 cores rather than a day). Each worker regenerates bundles from subject indices and evaluates in-thread; the **main
> thread does every DB write**, so resume/idempotency (per-measure COMPLETED `seed:scale` +
> `requestedScope.batchEvaluated` marker) and the `SCALE_POPULATION_EVALUATED` audit are unchanged, and the
> `aggregateScaleRun` read path is byte-for-byte the same (status-only). `--workers 1` (or `0`) forces the
> single-threaded path unchanged. The pool is confined to this batch CLI — never the request path.
> Progress is logged one line per chunk. For a proof/dev run use a small `--subjects` (e.g. 5000, ~80 min
> single-threaded, less with workers). `--mode fabricated` keeps the legacy instant path reachable for one
> more release (it ignores `--workers` and the evidence policy below).
>
> **Tiered evidence policy (#257) — evidence value follows ACTIONABILITY.** Full `evidence_json` (~1–3
> KB/outcome) at 120k × 14 is GB-scale on the cost-capped Neon, so trimming is now **tiered**, not
> all-or-nothing: when trimming, outcomes with status **OVERDUE / DUE_SOON / MISSING_DATA keep FULL
> evidence** (they feed cases/worklists — load-bearing; an evaluation-error MISSING_DATA keeps its
> `{evaluationError}` payload), **COMPLIANT / EXCLUDED get minimal `{scale:true}`**, and a
> **deterministic ~1% subject-index sample** (`idx % 100 === 0`) keeps full evidence across ALL buckets
> for audit spot-checks. **Auto-trim:** the trim engages automatically when `--subjects > 20000` and
> `--trim-evidence` was not explicitly passed (a notice is printed) — the "forgotten flag on a big run"
> failure mode is closed; pass **`--full-evidence`** to explicitly keep full evidence on every row
> (the two flags together are a usage error). `--trim-evidence` still forces the tiered trim at any N.
> The trim never touches `outcomes.status`, so `aggregateScaleRun` + the rollup (status-only reads) are
> provably unchanged (guard test). **Long-term home** for large evidence payloads is the #167 managed
> S3/R2 bucket — once that lands, Neon keeps status + hash only.
>
> **First run on a DB that already has the OLD fabricated seed (⚠ applies to live Neon).** `--mode evaluate`
> **refuses to run** if any COMPLETED *fabricated* `seed:scale` run exists (it will not silently no-op, and
> it will not auto-delete). The live Neon DB carries the 2026-06-29 fabricated 1.68M-row seed, so the first
> real-eval run there must **roll that back first** (the SQL below), then run `--mode evaluate`. Real
> (batch-evaluated) runs carry a `requestedScope.batchEvaluated` marker so they are distinguished from
> fabricated ones — a resumed evaluate run correctly skips already-evaluated measures.
>
> **Crash recovery.** A crashed `--mode evaluate` run leaves orphaned RUNNING `seed:scale` runs (up to one
> per measure, each holding its already-written outcomes) — these are **not** auto-swept (`failStuckRuns`
> excludes `seed:%` runs). A resume re-seeds every measure under new run ids (correct: the rollup is
> COMPLETED-only, latest-wins), but the orphaned rows persist. **Roll back the crashed run with the SQL
> below before resuming** to avoid storage bloat on Neon.
>
> ```bash
> cd backend-ts
> # proof/dev run: real batch eval over a small population (default 4 workers, core-clamped)
> DATABASE_URL=<neon-pooled> pnpm seed:scale --subjects 5000 --as-of 2026-06-26 --mode evaluate
> # full 120k real run: tiered trim AUTO-ENGAGES above 20k subjects; scale workers to the host's cores
> DATABASE_URL=<neon-pooled> pnpm seed:scale --subjects 120000 --as-of 2026-06-26 --mode evaluate --workers 8
> # explicitly keep FULL evidence on every row despite >20k (overrides the auto-trim)
> DATABASE_URL=<neon-pooled> pnpm seed:scale --subjects 120000 --as-of 2026-06-26 --mode evaluate --full-evidence --workers 8
> # force the single-threaded path (escape hatch / parity baseline)
> DATABASE_URL=<neon-pooled> pnpm seed:scale --subjects 5000 --as-of 2026-06-26 --mode evaluate --workers 1
> ```
>
> Spec/plan: `docs/superpowers/specs/2026-07-08-option-a-scale-batch-eval-design.md`,
> `docs/superpowers/plans/2026-07-08-option-a-scale-batch-eval.md`.

**Rollback (reversible, synthetic data only) — delete tagged outcomes first, then runs**
(schema-qualify on the Pg ceiling):

```sql
DELETE FROM workwell_spike.outcomes
  WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:scale');
DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:scale';
```

### Seeding quality-over-time history (E16 PR-2, on-demand, NOT auto-run on deploy)

> **✓ Done on 2026-07-01 (live Neon).** `pnpm seed:quality-history --months 12 --as-of 2026-06` wrote
> **12 months × ~4,046 rows = 48,552 `quality_snapshots`** (2025-07 → 2026-06; 2026-07 already existed
> from forward materialization → 13 months total). Verified live: `all` scope ~flat 82.5–82.6% (scale
> tenant is time-invariant by design), `tenant=twh` shows the real evaluated trend (97.9% → 69.1% as the
> RECURRING measure ages). Re-run only after a rollback (`DELETE FROM quality_snapshots`).

`pnpm seed:quality-history` materializes **real evaluated** `quality_snapshots` (numerator/denominator +
the 5 bucket counts per measure × month × scope) for a range of past calendar months, so the
`/programs/[measureId]` "Quality over time" card has genuine history — Doug's *"how do I know if they were
compliant in December? October?"* answered from a persisted aggregate. It **supersedes** the synthetic
sine-wave `seed:trend-history` for the quality trend: these rows are actually CQL-evaluated as-of each
month's end, not faked. On-demand, owner-run, **not** auto-run on deploy. Run once against Neon from
`backend-ts/` (honors `DATABASE_URL`; no local SQLite when set):

```bash
cd backend-ts
DATABASE_URL=<neon-pooled> pnpm seed:quality-history --months 12 --as-of 2026-06
```

Forward materialization also accrues a snapshot on every completed population run (E16 PR-1), so this CLI
is only needed to backfill *history* the live runs haven't produced yet. The live `twh`/`ihn` employees are genuinely
re-evaluated per month; the 120k `mhn` scale tenant folds in via the bounded `aggregateScaleRun` (never its
per-subject rows), but the scale population is **generated demo data with no time dimension**, so its
current distribution is folded unchanged into every historical month (there is no per-month history to
recover for it) — so per-tenant scopes (`twh`/`ihn`) show real evaluated month-to-month variation, while
the `all` aggregate at population scale is dominated by that time-invariant scale distribution. Audited
(`QUALITY_HISTORY_BACKFILLED`, one per month). **Idempotent + resumable** at the month level (a rerun
skips months that already have snapshots).

**Rollback (reversible) — the whole table is a rebuildable cache** (schema-qualify on the Pg ceiling):

```sql
DELETE FROM workwell_spike.quality_snapshots;
```

### Resolving VSAC value sets (ADR-023, on-demand, NOT auto-run on deploy)

`pnpm resolve-valuesets` imports **real VSAC (NLM UMLS) value-set expansions** into `value_sets` so the
CQL engine can resolve official eCQM value sets against authoritative terminology instead of only the
locally-seeded codes — the on-ramp for the E14 official-CQL work. It `$expand`s each target OID via the
live NLM FHIR terminology service and upserts the codes (`source="VSAC"`, RESOLVED; a failed OID → an
ERROR row + continue), audited `VALUE_SETS_RESOLVED` per OID (existing `value_sets` columns only — **no
DDL**; DATA_MODEL §3.4). Default target = the 21 CMS122v14 reference OIDs; `--oid <oid>` (repeatable) /
`--measure cms122` override. On-demand, owner-run, **not** auto-run on deploy. Run against Neon from
`backend-ts/` (honors `DATABASE_URL`; requires the VSAC key):

```bash
cd backend-ts
DATABASE_URL=<neon-pooled> WORKWELL_VSAC_API_KEY=<umls-api-key> pnpm resolve-valuesets
```

**Descriptive only — changes no current outcome.** The runtime composite resolver still falls back to the
local store for the synthetic measures' `urn:workwell:*` references, so importing VSAC codes does not shift
any measure's `Outcome Status` (ADR-008/ADR-023; audiogram cross-mode parity test). VSAC is **inert on the
demo stack unless the key is set** — `resolveValueSetResolver`/`engineForEnv` are key-gated, so with no
`WORKWELL_VSAC_API_KEY` the evaluation path is byte-identical to today. **If VSAC is enabled in the deployed
env,** add the UMLS API key as a GitHub secret `WORKWELL_VSAC_API_KEY_TWH` and map it onto the backend
container env in `deploy-twh-mieweb.yml` (analogous to `DATABASE_URL_TWH` → `DATABASE_URL`,
`WORKWELL_AUTH_JWT_SECRET_TWH` → `WORKWELL_AUTH_JWT_SECRET`); the **demo stack leaves the key unset**.

**Rollback (reversible) — remove the imported rows** (schema-qualify on the Pg ceiling):

```sql
DELETE FROM workwell_spike.value_sets WHERE source = 'VSAC';
```

### Manual re-deploy (force update existing containers)

Use `workflow_dispatch` with `replace_existing: true` from the GitHub Actions UI.

### Service startup & reboot policy

> "What happens if the server reboots — does WorkWell come back up on its own?"

There are two runtime contexts, and the answer differs:

**1. Live stack (`os.mieweb.org`) — MIE Create-a-Container.**
The `twh` and `twh-api-ts` containers run on **MIE's Container Manager**, which is a **Proxmox
abstraction** (the manager talks to each node's Proxmox API via a stored token; nodes are named
`opensource-phxdc-pve*`). Restart-on-reboot therefore lives at the Proxmox **`onboot`** layer.

What was verified directly against the manager API (`GET /api/v1/sites/1/containers/{id}` and
`/sites/1/nodes`, 2026-06-09):
- The container object exposes **no** restart/`onboot`/uptime field (only `status`, `hostname`,
  `nodeName`, `services`, `environmentVars`, etc.), and neither does the node object. So a restart
  policy is **not user-configurable or user-readable** through this API — there is nothing to add
  to the create payload in `deploy-mieweb-container.sh`, and nothing to inspect.
- **Clean restart recovery is already proven** by normal operation: every push to `main` runs
  `deploy-twh-mieweb.yml`, which **deletes and recreates** both containers, and the deploy script
  fails unless the final container `status` is `running`. So the containers reliably return to
  `running` after being recreated.

> **Open question (nice-to-know, not a blocker — see the reconciler below):** are provisioned
> containers created with Proxmox **`onboot=1`** (auto-start when the node reboots)? This is the one
> thing not verifiable from our side — a manual container restart does **not** test it (restart ≠ node
> reboot), and rebooting a shared Proxmox node is not an option.

**Self-healing reconciler (covers reboot recovery regardless of `onboot`).**
`.github/workflows/reconcile-twh-mieweb.yml` runs every 15 minutes (+ `workflow_dispatch`): it
health-checks the live surfaces (`twh` → 200; `twh-api-ts` → `/actuator/health` `UP`, retrying up to
6× over ~3 min so a transient blip or a normal cold start never registers as down) and, if any is
down, **recreates that container from its last-good GHCR `:latest` image** via
`deploy-mieweb-container.sh` (`REPLACE_EXISTING=true`). This recovers the stack from a node reboot, a
container crash/OOM, or accidental deletion — **independent of `onboot`** — so the `onboot` question
above is no longer a blocker. Worst-case recovery latency ≈ the 15-min interval; a recreate is
~30–120s of that container's downtime; no data loss (Neon persists). It heals both live containers
(`twh` + `twh-api-ts`); since the JVM was retired (#109 PR4) there is no separate Java rollback
container to exclude. The env blocks are duplicated from `deploy-twh-mieweb.yml` and marked
**keep-in-sync** in both.

**How to see reconciler history (#264 doc note):** open the repo on GitHub → **Actions** tab → filter
workflow **`reconcile-twh-mieweb`** (or open `.github/workflows/reconcile-twh-mieweb.yml` → "View
workflow runs"). Each run shows the health-check outcome and whether a recreate fired. Manual re-run:
**Actions → reconcile-twh-mieweb → Run workflow** (`workflow_dispatch`).

**Two safety properties to know.** (1) The reconciler shares the `twh-mieweb-container-ops` concurrency
group with `deploy-twh-mieweb.yml`, so a heal never runs while a push-to-main deploy is mid
delete+recreate of the same container — the later run queues behind the in-flight one. (2) A heal
recreates from `:latest`. After a **fast rollback** (redeploying an older `sha-<SHA>` via
`workflow_dispatch`), the next heal would re-pull `:latest` and silently undo it — so follow a fast
rollback with a **durable** one (revert the bad commit on `main` so `:latest` rebuilds to the good
image), or temporarily disable the reconcile workflow, before relying on the rollback.

**2. Self-hosted / VM / local — Docker Compose + systemd.**
For any host we *do* control, reboot recovery is fully handled and is the reference Doug asked for:

- **Per-container crash recovery:** every service in `infra/docker-compose.yml` is now
  `restart: unless-stopped`, so Docker restarts a crashed container automatically (and restarts
  the stack when the Docker daemon starts).
- **Boot-time startup:** an example systemd unit, `infra/systemd/workwell.service`, starts the
  whole compose stack on boot. Install + verification steps are in `infra/systemd/README.md`.

```bash
sudo systemctl enable docker                       # Docker starts on boot
sudo systemctl enable --now workwell               # stack starts now + on every boot
systemctl status workwell                          # verify
```

With both in place, a `sudo reboot` brings the entire stack back automatically (`docker compose ps`
shows all services `Up`).

---

## Environment variables reference

| Var | Where | Purpose |
|-----|-------|---------|
| `DATABASE_URL` | Backend | Pooled Neon connection for app runtime |
| `DATABASE_URL_DIRECT` | Backend | Direct Neon connection for Flyway migrations |
| `OPENAI_API_KEY` | Backend | AI calls (drafting and explanation surfaces) |
| `SPRING_PROFILES_ACTIVE` | Backend | Always `prod` in deployed env |
| `WORKWELL_INSTANCE` | Backend | `twh` selects the TWH seed set |
| `WORKWELL_AUTH_ENABLED` | Backend | Enable auth; set `true` in deployed env |
| `WORKWELL_AUTH_JWT_SECRET` | Backend | Required when auth is enabled; use a strong secret |
| `WORKWELL_AUTH_COOKIE_SAME_SITE` | Backend | Refresh-cookie SameSite. **Must be `None` in production** (split frontend/API origins). Default `Lax` for local same-origin dev. |
| `WORKWELL_AUTH_COOKIE_SECURE` | Backend | Refresh-cookie Secure flag. **Must be `true` in production** (required for SameSite=None). Default `false` for local HTTP dev. |
| `NEXT_PUBLIC_API_BASE_URL` | Frontend | Backend URL for fetch calls (origin-only, no `/api` suffix, no trailing whitespace) |
| `NEXT_PUBLIC_APP_NAME` | Frontend | App display name |
| `NEXT_PUBLIC_DEMO_MODE` | Frontend | Prefill login form for local/demo builds only; `true` **fails the production frontend build** |
| `WORKWELL_EMAIL_PROVIDER` | Backend | Outreach email provider. **Stays `simulated` on the demo stack (default + CLAUDE.md hard rule).** |
| `WORKWELL_EMAIL_SENDGRID_API_KEY` | Backend | SendGrid API key. Wiring exists in code but **must remain unset on the demo stack**; only set in an explicit non-demo deployment alongside `WORKWELL_EMAIL_PROVIDER=sendgrid`. |
| `WORKWELL_EMAIL_FROM_ADDRESS` | Backend | From address for outreach (default `noreply@workwell-demo.dev`). |
| `WORKWELL_EMAIL_FROM_NAME` | Backend | From display name (default `WorkWell Measure Studio`). |
| `WORKWELL_VSAC_API_KEY` | Backend | UMLS API key for live VSAC value-set expansion (ADR-023). **Inert unless set — the demo stack leaves it unset** (evaluation stays byte-identical to the inline path). Also required by the `pnpm resolve-valuesets` import CLI. |
| `WORKWELL_VSAC_BASE_URL` | Backend | NLM FHIR terminology service base for VSAC `$expand` (default `https://cts.nlm.nih.gov/fhir`). |
| `WORKWELL_ALERT_WEBHOOK_URL` | Backend | Optional failed-run alert webhook (#264). When set, PARTIAL_FAILURE/FAILED population runs (and scheduler tick errors / stuck-run recoveries) POST a JSON `RunAlert` body here. **Inert unless set.** Console always emits a greppable `WORKWELL_ALERT …` line regardless. Demo stack may leave unset. |

`Where = Backend` vars are container environment on the MIE backend container (mapped from the
`*_TWH` GitHub secrets where applicable); `Where = Frontend` vars are build-args/env baked into
the MIE frontend image. `.env.example` at repo root mirrors this list (without values). Env vars
must be verified manually before deploy; the CI workflow does not validate deployment secrets.

### Email delivery (Sprint 6)

The demo stack runs `WORKWELL_EMAIL_PROVIDER=simulated`. Outreach actions never send a real
email — each attempt is logged and written to `outreach_delivery_log` with `status=SIMULATED`,
visible in the Admin → Outreach Delivery Log panel. SendGrid wiring lives in `backend-ts`
(`resolveEmailService(env)` + `sendgridEmailService` in `backend-ts/src/case/email-service.ts`,
routed through the EMAIL outreach channel) and is selected solely when both
`WORKWELL_EMAIL_PROVIDER=sendgrid` and `WORKWELL_EMAIL_SENDGRID_API_KEY` are set; if the
provider is `sendgrid` but no key is configured it degrades safely back to a simulated send.
The SendGrid adapter is currently an **inert stub** (returns a `QUEUED` record, no real HTTP —
inert-unless-configured, mirroring the DataChaser channel stub, ADR-011); a real SendGrid v3
send is the documented drop-in behind it. Do not set `WORKWELL_EMAIL_SENDGRID_API_KEY` on the
demo stack.

The non-prod `POST /api/admin/demo-reset` endpoint (admin-only, `@Profile("!prod")`) truncates
volatile demo tables including `audit_events`; it returns 403 under the `prod` profile.

### Failed-run alerts (#264)

Every population run that ends **FAILED** or **PARTIAL_FAILURE** (plus stuck-run boot recovery and a
scheduler tick throw) emits **exactly one** alert through `resolveAlertChannels(env)`:

1. **Always:** a single greppable container log line —
   `WORKWELL_ALERT {"kind":"RUN_PARTIAL_FAILURE",...}` (`console.error`). Grep MIE container logs for
   `WORKWELL_ALERT`.
2. **Optional:** when `WORKWELL_ALERT_WEBHOOK_URL` is set, a plain JSON POST of the same payload.
   Leave unset on the demo stack unless you have a webhook sink. Inert-unless-configured; listed on
   the boot seam inventory as `alert-webhook=off|on`.

Alert emission is best-effort — a webhook timeout never fails the run. Run metrics (duration,
evaluated count, compliant/non-compliant, per-status `outcomeCounts`) remain on `GET /api/runs` and
`GET /api/runs/:id` as before.

### Evidence upload persistence (managed S3/R2 bucket)

Evidence bytes are stored behind the `CloudBucket` port (`@mieweb/cloud`): `EvidenceService`
(`backend-ts/src/case/evidence-service.ts`) only calls `bucket.put(key, bytes)` / `bucket.get(key)`,
so **the storage backend is a binding choice — no app code changes to make evidence persistent.**

The live TWH container runs the `local` mieweb target, whose `BUCKET` binding is
`{"driver":"fs","path":".data/local/evidence"}` (`backend-ts/mieweb.jsonc`) — an **in-container
filesystem** bucket, so uploaded evidence is **lost on container recreate** (every deploy/heal
recreates the container). The DB persists (Neon) because it is overridden to Postgres via
`DATABASE_URL`; the bucket has no equivalent managed backend wired yet.

**To make evidence durable, point `BUCKET` at a managed S3-compatible bucket (AWS S3 or Cloudflare
R2).** The `mieweb` target in `mieweb.jsonc` already shows the exact `s3` driver shape:

```jsonc
"BUCKET": {
  "driver": "s3",
  "endpoint": "https://<account>.r2.cloudflarestorage.com",   // or an S3 region endpoint
  "bucket": "workwell-evidence",
  "accessKeyId":  "<from a GitHub secret>",
  "secretAccessKey": "<from a GitHub secret>",
  "forcePathStyle": true,
  "createIfMissing": true
}
```

Steps when a bucket is available: (1) provision an R2/S3 bucket + scoped credentials; (2) add the
access key/secret as GitHub secrets and map them onto the backend container env in
`deploy-twh-mieweb.yml` (alongside `DATABASE_URL_TWH`); (3) set the live `BUCKET` binding to the `s3`
driver above (env-substituted from those secrets). No code change — the `CloudBucket` contract is
unchanged. **Owner-gated, like schema/DDL — provisioning + the deploy-config edit are Taleef's;**
this is the documented recipe for when the bucket exists. Until then, treat evidence upload as
ephemeral (demo-only).

## Neon (Postgres)

1. Project `workwell-twh`, region us-east, **Postgres 16**
2. **Pooled** connection string → `DATABASE_URL_TWH` GitHub secret (app runtime)
3. **Direct** connection string → used for Flyway migrations (`DATABASE_URL_DIRECT`)

Do not use `neonctl projects create` unless it supports `pg_version=16`; the CLI defaults to
Postgres 17 and is not compliant with the locked stack.

## OpenAI

1. Get API key from platform.openai.com
2. Set a hard monthly usage limit in billing
3. Store as the `OPENAI_API_KEY` GitHub secret only (never expose to the frontend)

## CI/CD

**Active deploy workflow:** `.github/workflows/deploy-twh-mieweb.yml`
- Triggers on every push to `main` and via `workflow_dispatch`
- Builds backend + frontend Docker images, pushes to GHCR, deploys both containers to MIE

**CI workflow:** `.github/workflows/ci.yml`
- Runs backend build + tests (8-way test sharding; ~11m30s wall-clock)
- Runs frontend lint
- Does not deploy (deploy is the separate workflow above)

## Health checks

- Backend (TS): `GET https://twh-api-ts.os.mieweb.org/api/version` → `{"api":"v1",...}` (also serves `/actuator/health` → 200)
- Frontend: `GET https://twh.os.mieweb.org/` → 200 OK
- DB: `psql "$DATABASE_URL_DIRECT" -c "SELECT 1"` from any host with the Neon direct string

> Quick end-to-end check of the live primary: `scripts/smoke-shadow.sh https://twh-api-ts.os.mieweb.org`
> runs the post-deploy smoke checklist below (expects all-pass except the two documented WARN
> limitations — ephemeral evidence BUCKET + the MCP-SSE nginx caveat).

Post-deploy smoke checklist (MVP complete surface):
- `GET /actuator/health` -> `200`
- `GET /api/runs?limit=1` -> `200`
- `GET /api/cases?status=open` -> `200`
- `GET /api/exports/runs?format=csv` -> `200`
- `GET /api/exports/outcomes?format=csv&runId=<latest-run-id>` -> `200`
- `GET /api/exports/cases?format=csv&status=open` -> `200`
- `GET /api/audit-events/export?format=csv` -> `200`
- `GET /api/admin/integrations` -> `200`
- `POST /api/admin/integrations/mcp/sync` -> `200`
- `POST /api/cases/{id}/actions/outreach/delivery?deliveryStatus=SENT` -> `200`
- `GET /api/cases/{id}` confirms `latestOutreachDeliveryStatus=SENT`

## Rollback

### Roll back to a known-good TS image (Java is retired)
The Java backend was retired in #109 PR4, so rollback is **redeploying an earlier known-good
`twh-api-ts` image** (each build is tagged `sha-<SHA>` in GHCR):
- **Workflow dispatch:** run `deploy-twh-mieweb.yml` via `workflow_dispatch` from the Actions UI at the
  earlier good SHA with `replace_existing: true` — it rebuilds + redeploys that SHA's images.
- **Or revert + push:** `git revert <bad-merge-sha>` on `main` re-triggers `deploy-twh-mieweb.yml` with
  the reverted code.
- **Or pin a prior image fast (no rebuild):** the self-heal reconciler (`reconcile-twh-mieweb.yml`)
  and `deploy-mieweb-container.sh` recreate from `:latest`; to pin an *older* image, re-run the deploy
  at that SHA.

### Neon
Each schema change is additive (`workwell_spike` self-creates via `CREATE … IF NOT EXISTS` on boot;
no Flyway). Neon branches can still be promoted from the dashboard if a data rollback is needed.

> **Index build on next deploy (Fable H5/M17 hardening, 2026-07-03):** the boot DDL now also creates
> five indexes via `CREATE INDEX IF NOT EXISTS` — `spike_outcomes_subject_idx`,
> `spike_outcomes_measure_idx`, `spike_audit_events_occurred_at_idx`,
> `spike_audit_events_event_type_idx`, `spike_audit_events_ref_run_id_idx`. On the live Neon DB the
> first deploy after this change builds them **once** over the existing ~1.68M-row `outcomes` table (a
> one-time index build; the boot query blocks until each completes, then subsequent boots are no-ops).
> No data migration; reversible with `DROP INDEX … ` in `workwell_spike` if ever needed. Owner-gated
> DDL — reviewed via the hardening PR.

## Cost monitoring

Daily check while the stack is live:

- **Neon dashboard:** storage + compute consumed
- **OpenAI usage dashboard:** today's spend
- **MIE platform:** internal container hosting (no per-month cloud bill like the legacy Fly tier)

If any approaches limit, fix that day. Don't wait.

## Troubleshooting

**Neon connection limit hit**
- Use the pooled connection string (`DATABASE_URL`), not direct, in the app
- HikariCP `maximum-pool-size: 10` in `application.yml`
- Direct connection only for Flyway

**OpenAI 429**
- One retry with exponential backoff (1s, 2s)
- Surface "AI temporarily unavailable" in UI
- Fall back to rule-based explanation text
- Audit log records the failure

**Audit log missing entries after deploy**
- Check Spring profile is `prod`, not `dev`
- Verify migrations ran: `psql "$DATABASE_URL_DIRECT" -c "\dt"` — should list `audit_events`

**Case detail or outreach delivery endpoint returns 500 after deploy**
- Check for SQL operator compatibility in prepared statements.
- PostgreSQL JSON existence should use `jsonb_exists(payload_json, 'key')` in JDBC query text rather than the raw `?` operator when bind parameters are present.

**MCP server can't be reached**
- MCP is exposed at `/sse` + `/mcp/**` on the backend
- Verify the Claude Desktop config points to the deployed URL and sends an `Authorization` header with a valid WorkWell JWT
- Role gates apply: `/sse` and `/mcp/**` return 403 unauthenticated

**Backend deploy job fails at the MIE manager API**
- Confirm the API base resolves to `<manager-origin>/api/v1` (the origin serves the SPA; `/api` serves Swagger)
- Responses are `{"data": ...}` enveloped; the create body uses `template` + `services[]`; job polling reads `.data.status` (`"success"`)

**Deploy fails with `Container is 'offline', expected running`**
- This is a **startup race**, not a crash: the create job reports `success` once the container is
  provisioned, but it can still be `offline`/`pending` for a few seconds before it reports `running`.
  `deploy-mieweb-container.sh` now **polls** the container status up to ~3 min (18× / 10s) instead of a
  single eager read, so a brief startup window no longer fails an otherwise-good deploy.
- If it still fails after the full poll window, the container genuinely failed to start — check the
  image tag, the container env vars, and (for the backend) `DATABASE_URL`/auth secrets; the self-heal
  reconciler will also retry from `:latest` within ~15 min.

---

## Appendix A — Decommissioned Vercel + Fly.io stack (historical reference)

> **Decommissioned — do not use.** None of the resources below are deployed any more.
> MIE TWH (above) is the sole live stack. This section is retained only so the earlier
> public-preview setup remains documented. Environment variable *names* are unchanged;
> on the current stack they are set on the MIE containers, not as Fly secrets or Vercel env.

Legacy stack layout:

| Layer | Service | Tier | Cost |
|-------|---------|------|------|
| Frontend | Vercel | Hobby | $0 |
| Backend | Fly.io | shared-cpu-1x, 512MB | ~$2/mo |
| Postgres | Neon | Free | $0 (3GB cap) |
| AI | OpenAI API | direct, budget-capped | variable |
| Domain | Vercel subdomain | n/a | $0 |

Notes from that era: Fly 256MB free OOMs Spring Boot (use 512MB). Fallback if Fly cost was a
problem: Render free tier (cold-start tradeoff, ~30s first hit per inactive period).

### Legacy prerequisites
- Fly CLI: `iwr https://fly.io/install.ps1 -useb | iex` (Windows) or `curl -L https://fly.io/install.sh | sh`
- Vercel CLI: `pnpm i -g vercel`

### Legacy Fly.io setup

```bash
cd backend
fly launch --no-deploy
fly secrets set DATABASE_URL=<neon-pooled>
fly secrets set DATABASE_URL_DIRECT=<neon-direct>
fly secrets set OPENAI_API_KEY=<key>
fly secrets set SPRING_PROFILES_ACTIVE=prod
fly secrets set WORKWELL_AUTH_ENABLED=true
fly secrets set WORKWELL_AUTH_JWT_SECRET=<strong-random-secret>
fly secrets set WORKWELL_AUTH_COOKIE_SAME_SITE=None
fly secrets set WORKWELL_AUTH_COOKIE_SECURE=true
```

> On the legacy stack the frontend (Vercel) and backend (Fly) were different registrable
> domains, so every browser→API call was **cross-site** and the refresh-token cookie had to be
> `SameSite=None; Secure`. (The same production fail-fast check applies on MIE today.)

`fly.toml`: `memory = "512mb"`, region closest to you (e.g., `ord`, `iad`), and
`min_machines_running = 1` for a stable remote MCP connection.

```bash
fly deploy
curl https://<app>.fly.dev/actuator/health  # expect {"status":"UP"}
```

### Legacy Vercel setup

1. Import GitHub repo, root directory `frontend/`
2. Framework: Next.js (auto-detected)
3. Env vars: `NEXT_PUBLIC_API_BASE_URL` = Fly app URL; `NEXT_PUBLIC_APP_NAME`; `NEXT_PUBLIC_DEMO_MODE` (local/demo only)

### Legacy rollback
- **Fly:** `fly releases list` then `fly releases rollback <version>`, or `git checkout <sha> && fly deploy`
- **Vercel:** Dashboard → Deployments → previous → Promote to Production

### Legacy troubleshooting
- **Fly OOM:** verify `memory = "512mb"`; reduce heap `JAVA_OPTS=-Xmx384m -Xss256k`; check `fly logs` for OOMKilled
- **Vercel build fails:** Node 20+; verify `NEXT_PUBLIC_API_BASE_URL`; clear build cache if backend types changed
- **DB from Fly machine:** `fly ssh console` then `psql $DATABASE_URL_DIRECT -c "SELECT 1"`

### Legacy domain / probe notes
- Vercel subdomain `workwell-measure-studio.vercel.app` was the demo frontend; Fly `workwell-measure-studio-api.fly.dev` the backend
- S0 `/runs` probe: `OPTIONS https://workwell-measure-studio-api.fly.dev/api/eval` expecting `200` + `Access-Control-Allow-Origin`
