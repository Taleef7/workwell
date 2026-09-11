# Backup & disaster-recovery runbook (#270)

**Date:** 2026-07-13. **Scope:** the live stacks — Neon Postgres (`workwell-twh` and the pilot's own
project), the MIE containers, and the evidence bucket.
**Status (updated 2026-09-11):** Runbook **executed** (§6 drill ✓). The nightly-dump second line of
defence is **live for BOTH stacks** (`backup-neon-nightly.yml` → `r2://workwell-backups/db-dumps/twh/`
and `…/db-dumps/maui/`, §2 item 2). Storage moved from AWS S3 to **Cloudflare R2 on 2026-09-11**
after the AWS Free Plan account expired (#473 — see the §2 note). Remaining owner decision: **the Neon
plan upgrade** — the 6-hour PITR window and the unprotected `production` branch are both Free-plan
caps (§2), not settings.

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
> **⚠ The bucket-host expiry happened. Written up because the warning was right and useless.**
> The note that stood here from 2026-07-14 said `workwell-twh-evidence` sat on an AWS **Free Plan**
> account expiring **2026-08-24**, and that the bucket had to be re-homed before then. It was not.
> On 2026-08-25 AWS suspended the account: S3 began answering `AllAccessDisabled`, every key stopped
> authenticating, the nightly dump failed **seventeen consecutive nights** (#473), and the evidence
> seam failed **silently for eighteen days** because it is only exercised on the first evidence
> operation. Everything uploaded in that window is gone, and the dumps that were in the bucket are
> unrecoverable without settling the account.
> **Re-homed to Cloudflare R2 on 2026-09-11** — buckets `workwell-evidence-twh` and
> `workwell-backups`, one scoped API token each, `db-dumps/` expiring after 30 days. Migration was
> env vars only (`WORKWELL_BUCKET_S3_*` + `_ENDPOINT`), exactly as predicted; no code changed.
> R2's free tier has **no expiry clock**, which is the property that actually failed here.
> Two durable lessons: **a dated deadline in a runbook is not a control** — nothing failed loudly on
> the day it lapsed — and a configured-but-unreachable seam must announce itself, which is now the
> boot-time probe (`bucket-health.ts`, `docs/DEPLOY.md`).

2. ~~**Add a second line of defence: a scheduled logical dump.**~~ **DONE 2026-07-14 (#167 + #270);
   extended to both stacks and re-homed to R2 on 2026-09-11 (#473):**
   `.github/workflows/backup-neon-nightly.yml` dumps the `workwell_spike` schema of **each** live
   stack nightly (03:17 UTC, custom format, direct — non-pooler — connection) to
   `r2://workwell-backups/db-dumps/twh/` and `r2://workwell-backups/db-dumps/maui/`, with a 30-day
   lifecycle expiry on the `db-dumps/` prefix. A matrix leg per stack, `fail-fast: false`, so one
   stack's outage never cancels the other's dump — **the pilot carried 20,000 patients from
   2026-09-06 with no backup at all** until this leg existed. The dumps are written by a **dedicated
   R2 token scoped to `workwell-backups` alone**; the app's evidence token names a different bucket
   and therefore cannot reach them at all. Recovery is independent of Neon retention *and* of Neon
   itself. Worst-case data-loss window: ~24h (nightly dump) beyond the 6h PITR window.
   **Watch the dump size** on the run summary: the R2 free tier is 10 GB and the window is 30 dumps
   per stack, so the pilot's size is what decides whether 30 days actually fits.
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

The schema self-creates on boot and the demo data is **regenerable** (§5), so a fresh Neon project +
the stack's `DATABASE_URL_*` secret + a redeploy reconstitutes a working stack. Operational history
(cases, the audit ledger, run history) comes from the **nightly dump — restore it per §3.5**; without
one it is permanently lost, which is what §2 item 2 exists to prevent and why the seventeen-night
outage (#473) mattered as much as it did.

### 3.4 Container / node loss

Covered: the reconciler recreates a down container from `:latest` within ~15 min, independent of
Proxmox `onboot` (DEPLOY.md). No action needed. Evidence file bytes survive on any stack whose
`WORKWELL_BUCKET_S3_*` vars are set (TWH since 2026-07-14, the pilot since 2026-09-11) and are lost
on any stack still using the in-container `fs` bucket (#167).

### 3.5 Restoring a nightly dump from R2

The dumps are `pg_dump --format=custom` of the `workwell_spike` schema, at
`s3://workwell-backups/db-dumps/<stack>/workwell_spike-<ISO8601>.dump`, retained 30 days.

```bash
# Credentials: the WORKWELL_BACKUP_S3_* repo secrets (the backup token is read+write on this bucket).
export AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…  AWS_DEFAULT_REGION=auto
export R2=https://<account-id>.r2.cloudflarestorage.com     # = the WORKWELL_R2_S3_ENDPOINT secret

# 1. Find the dump you want (newest last).
aws s3 ls s3://workwell-backups/db-dumps/maui/ --endpoint-url "$R2"

# 2. Pull it.
aws s3 cp s3://workwell-backups/db-dumps/maui/workwell_spike-2026-09-11T161626Z.dump . \
  --endpoint-url "$R2"

# 3. Restore into a FRESH Neon project or branch — never over a live one while you are still
#    diagnosing. Use the DIRECT (non-pooler) host, as the dump job does.
pg_restore -d "$TARGET_DIRECT_URL" --no-owner --schema=workwell_spike \
  workwell_spike-2026-09-11T161626Z.dump

# 4. Verify BEFORE repointing anything (the §3.1 invariants).
psql "$TARGET_DIRECT_URL" -c "SELECT count(*) FROM workwell_spike.outcomes;" \
                          -c "SELECT max(occurred_at) FROM workwell_spike.audit_events;"

# 5. Repoint the stack: set DATABASE_URL_MAUI (or _TWH) to the new connection string and redeploy.
```

**`pg_restore` needs a client at least as new as the server (PG 16).** And note what a dump does not
carry: evidence file BYTES live in the evidence bucket, not the database, so a restored database
references attachments that only exist if that bucket still does.

---

## 4. RPO / RTO — stated plainly

| Scenario | RPO (data loss) | RTO (time to recover) |
|---|---|---|
| Container crash / node reboot | **0** | ≤ 15 min (automatic) |
| Bad deploy | **0** | ~10 min (redeploy a prior SHA) |
| Data corruption **noticed within 6 h** | ≈ 0 (restore to just before) | ~15 min + verification |
| Data corruption **noticed after 6 h** | ≤ 24 h (the nightly dump, §3.5) | ~1 h (pull + `pg_restore` + verify + repoint) |
| Neon project loss | ≤ 24 h for operational history; demo data regenerable | ~1 h (new project + restore §3.5 + secret + redeploy) |

Rows 4 and 5 are the ones §2 exists to fix, and **since 2026-07-14 for TWH and 2026-09-11 for the
pilot they are fixed** — both read "≤ 24 h" rather than "TOTAL" only because a nightly dump exists to
restore. That claim is worth exactly as much as the last successful run of `backup-neon-nightly.yml`:
it silently became false for seventeen nights in 2026-08/09 (#473), and the workflow now raises an
issue per stack on the first failure.

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
