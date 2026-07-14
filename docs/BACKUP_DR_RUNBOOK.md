# Backup & disaster-recovery runbook (#270)

**Date:** 2026-07-13. **Scope:** the live TWH stack — Neon Postgres (`workwell-twh`), the MIE
containers, and the evidence bucket.
**Status (updated 2026-07-14):** Runbook **executed** (§6 drill ✓). The nightly-dump second line of
defence is **live** (`backup-neon-nightly.yml` → `s3://workwell-twh-evidence/db-dumps/`, §2 item 2).
Remaining owner decision: **the Neon plan upgrade** — the 6-hour PITR window and the unprotected
`production` branch are both Free-plan caps (§2), not settings.

All facts below were read from the live Neon project on 2026-07-13, not assumed.

---

## 1. What we actually have

| Asset | Where | Recovery today |
|---|---|---|
| **Application data** (runs, outcomes, cases, audit ledger, segments, snapshots, person links) | Neon project `workwell-twh` (`sparkling-truth-84539518`), region `aws-us-east-1`, PG 16, single branch **`production`** | Neon point-in-time restore — **but only within a 6-hour window** (§2) |
| **Schema** | Self-creating DDL on boot (`schema-pg.ts` / `schema.ts`) — no migration files | Recreated from code on any fresh DB. **Not a recovery risk.** |
| **Backend + frontend** | GHCR images, tagged `latest` + `sha-<SHA>` per build | Redeploy any prior SHA (`deploy-twh-mieweb.yml`, `workflow_dispatch`) |
| **Container liveness** | MIE Create-a-Container | Self-heal reconciler recreates a down container from `:latest` within ~15 min |
| **Evidence file bytes** | In-container `fs` bucket | **None — lost on every container recreate** (#167, known + documented) |
| **Secrets** | GitHub Actions secrets | Not backed up; re-issuable from Neon/OpenAI/MIE consoles |

**The good news:** the two hardest things to recover — the schema and the application — are already
recreatable from code (self-creating DDL + immutable image tags), and container loss is already
self-healing. The exposure is **data**.

---

## 2. The material gap: the PITR window is 6 hours

The live project's `history_retention_seconds` is **21600 — six hours**.

**What that means concretely:** a destructive change (a bad bulk operation, an accidental
`DELETE FROM outcomes`, a mis-scoped seed rollback, a rogue script) is recoverable **only if it is
noticed within six hours**. A bad change made in the evening and noticed the next morning is
**not recoverable** — there is no snapshot, no dump, and no longer any history to restore from.

There is **no second line of defence**: no scheduled `pg_dump`, no export to object storage, no Neon
snapshot schedule. Retention is the *only* mechanism, and it is six hours.

> **Update 2026-07-14:** no longer true — the nightly `pg_dump` to S3 is live (see the decisions
> block below). The 6-hour PITR window itself remains, pending the plan-upgrade decision.

For today's synthetic demo data this is an inconvenience (the data is regenerable — see §5). **The
moment any real data lands it becomes a compliance-grade incident**, which is exactly the transition
`docs/PRODUCTION_READINESS_2026-07.md` says must not happen accidentally.

### Owner decisions (§2 is the whole point of this document)

> **Update 2026-07-14 — attempted live; two of three are PLAN-CAPPED.** Both settings were attempted
> against the live project via the Neon API: `history_retention_seconds: 604800` was rejected —
> *"requested history retention seconds exceeds allowed maximum; max: 21600"* — and protecting
> `production` was rejected with `BRANCHES_PROTECTED_LIMIT_EXCEEDED`. **The 6-hour window IS the Free
> plan's maximum, and Free allows zero protected branches** — so decisions 1 and 3 are one combined
> decision: **upgrade the Neon plan** (Launch tier gives 7-day restore + protected branches). That is
> a billing call (owner / the MIE-hosting conversation, Q C14), not a settings toggle. Decision 2 is
> **DONE** — see below.

1. **Raise `history_retention_seconds`** on the Neon project — 7 days is the conventional floor for
   anything with a human in the loop. **Blocked by the Free plan (max 21600s, verified 2026-07-14);
   requires a plan upgrade.**
> **⚠ Bucket-host expiry (found 2026-07-14):** `workwell-twh-evidence` lives on an AWS **Free Plan**
> account (no card linked, cannot be charged — but the plan **expires 2026-08-24**, after which AWS
> restricts the account and eventually deletes resources). The bucket, the nightly dumps, and the
> live evidence seam must be **re-homed before ~2026-08-24**: MIE-provided S3/R2 (the C14 hosting
> conversation — preferred), a paid-plan upgrade, or a Cloudflare R2 free bucket. Migration is env
> vars only (`WORKWELL_BUCKET_S3_*` + optional `_ENDPOINT`) plus an `aws s3 sync`; no code change.

2. ~~**Add a second line of defence: a scheduled logical dump.**~~ **DONE 2026-07-14 (#167 + #270):**
   the managed bucket `workwell-twh-evidence` is provisioned (ADR-030) and
   `.github/workflows/backup-neon-nightly.yml` dumps the `workwell_spike` schema to
   `s3://workwell-twh-evidence/db-dumps/` nightly (03:17 UTC, custom format, direct — non-pooler —
   connection, 30-day lifecycle expiry). The dump is written by a **dedicated IAM principal**
   (`workwell-twh-backup`, PutObject on `db-dumps/*` only) and the app's own IAM user has an
   **explicit deny on `db-dumps/*`** — a compromised app container cannot touch the backups.
   Recovery is now independent of Neon retention *and* of Neon itself. Worst-case data-loss window:
   ~24h (nightly dump) beyond the 6h PITR window.
3. **Protect the `production` branch** — **blocked by the Free plan (0 protected branches, verified
   2026-07-14); same plan-upgrade decision as item 1.**

---

## 3. Restore procedures

### 3.1 Data corruption / accidental deletion — Neon point-in-time restore

**Recovery window: 6 hours (§2). Act immediately; do not investigate first.**

1. **Stop the writers** before restoring, or the damage continues underneath you: disable the scheduler
   (`WORKWELL_SCHEDULER_ENABLED=false`) and pause the reconcile workflow, or simply stop the backend
   container.
2. In the Neon console → project `workwell-twh` → **Branches** → `production` → **Restore**, pick a
   timestamp **before** the damage. Neon restores the branch in place and preserves the pre-restore
   state as a backup branch.
3. Verify against a known-good invariant **before** re-enabling writers — e.g. the rollup reconciles
   (`All = Σ tenants`) and the audit ledger's last event predates the incident:
   ```sql
   SELECT max(occurred_at) FROM workwell_spike.audit_events;
   SELECT count(*) FROM workwell_spike.outcomes;
   ```
4. Re-enable the scheduler / restart the backend.

> **If the restore produces a NEW branch** (rather than restoring in place), the connection string
> changes — you must then update the `DATABASE_URL_TWH` GitHub secret and re-run
> `deploy-twh-mieweb.yml` so the containers point at the restored branch. **Forgetting this step is the
> classic failure**: the restore succeeds and the app keeps writing to the damaged branch.

### 3.2 A bad deploy (application, not data)

Data is unaffected. Redeploy a known-good image: `workflow_dispatch` on `deploy-twh-mieweb.yml` at an
earlier good SHA with `replace_existing: true` (every build is tagged `sha-<SHA>` in GHCR).

> **Then make it durable.** The self-heal reconciler recreates from `:latest`, so a fast rollback is
> silently undone within ~15 min. Follow it with `git revert` on `main` so `:latest` rebuilds to the
> good image (already documented in DEPLOY.md → Rollback).

### 3.3 Total loss of the Neon project

Today: the schema self-creates on boot, and the demo data is **regenerable** (§5) — so a fresh Neon
project + the `DATABASE_URL_TWH` secret + a redeploy reconstitutes a working demo stack. Real
operational history (cases, the audit ledger, run history) would be **permanently lost**. That is
acceptable for synthetic demo data and unacceptable for anything else — see §2.2.

### 3.4 Container / node loss

Covered: the reconciler recreates a down container from `:latest` within ~15 min, independent of
Proxmox `onboot` (DEPLOY.md). No action needed. Evidence file bytes are lost (#167).

---

## 4. RPO / RTO — stated plainly

| Scenario | RPO (data loss) | RTO (time to recover) |
|---|---|---|
| Container crash / node reboot | **0** | ≤ 15 min (automatic) |
| Bad deploy | **0** | ~10 min (redeploy a prior SHA) |
| Data corruption **noticed within 6 h** | ≈ 0 (restore to just before) | ~15 min + verification |
| Data corruption **noticed after 6 h** | **TOTAL — unrecoverable** | n/a |
| Neon project loss | **TOTAL** for operational history; demo data regenerable | ~1 h (new project + secret + redeploy + re-seed) |

Rows 4 and 5 are the ones §2 exists to fix.

---

## 5. What is regenerable (and therefore not worth backing up)

The demo stack's bulk is **derivable**, which is why today's exposure is tolerable:

- The 120k `mhn` scale tenant — `pnpm seed:scale` (DEPLOY.md).
- Quality history — `pnpm seed:quality-history`.
- Trend history — `pnpm seed:trend-history`.
- VSAC value sets — `pnpm resolve-valuesets` (needs the UMLS key).
- Measures, segments, the employee directory — seeded on boot from code.

**Not regenerable:** the audit ledger, real case state (assignments, outreach, closures), and any human
`person_links` reconcile decisions. These are the only rows a backup actually protects — and they are
small, which is a further argument for §2.2 (a nightly logical dump of just these would be cheap).

---

## 6. Drill

> **✓ EXECUTED 2026-07-14 (live Neon, zero production impact).** Branch `drill-2026-07-14` created
> from `production`; a backend booted against it (`DATABASE_URL=<branch>` — schema present, both
> `public` and `workwell_spike`, `/api/version` + authenticated `/api/tenants` + `/api/runs` reads
> returned real data); 2 rows deleted from `workwell_spike.terminology_mappings` on the branch
> (5 → 3, verified); the branch restored to its own pre-deletion timestamp
> (`neonctl branches restore <drill> "^self@<T0>"` — note Neon requires `--preserve-under-name` when
> restoring a branch to itself); the deleted rows returned (5/5, outcomes intact at 118,292); both
> drill branches deleted. The exact §3.1 mechanism works as documented.

A runbook that has never been executed is a hypothesis. Before this is considered done:

1. Create a Neon **branch** from `production` (a branch is a cheap copy-on-write clone — this is safe
   and does not touch live data).
2. Point a local backend at it (`DATABASE_URL=<branch>`), confirm it boots, the schema is present, and
   `/api/version` + a roster read work.
3. Delete a few rows on the branch, restore the branch to a timestamp before the deletion, and confirm
   they return.
4. Delete the branch.

That exercises the exact mechanism §3.1 depends on, with zero risk to production. **Owner step — it
needs the Neon console.**
