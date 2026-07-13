# Backup & disaster-recovery runbook (#270)

**Date:** 2026-07-13. **Scope:** the live TWH stack — Neon Postgres (`workwell-twh`), the MIE
containers, and the evidence bucket.
**Status:** Runbook + a gap list. **One gap is material and needs an owner decision today (§2).**

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

For today's synthetic demo data this is an inconvenience (the data is regenerable — see §5). **The
moment any real data lands it becomes a compliance-grade incident**, which is exactly the transition
`docs/PRODUCTION_READINESS_2026-07.md` says must not happen accidentally.

### Owner decisions (§2 is the whole point of this document)

1. **Raise `history_retention_seconds`** on the Neon project — 7 days is the conventional floor for
   anything with a human in the loop. This is a project-setting change (owner-gated; it may affect
   the storage bill, which is why it is a decision and not a task).
2. **Add a second line of defence: a scheduled logical dump.** A nightly `pg_dump` of the
   `workwell_spike` schema to object storage gives a recovery path independent of Neon retention *and*
   independent of Neon itself. **This shares its blocker with #167** (there is no managed bucket yet) —
   so provisioning one bucket unblocks *both* evidence persistence and DB backups. That makes #167
   materially more valuable than it looks on the M3 list.
3. **Protect the `production` branch** (`protected: false` today). Neon branch protection prevents
   accidental deletion of the primary branch.

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
