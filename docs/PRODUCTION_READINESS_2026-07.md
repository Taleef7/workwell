# Production Readiness — PHI posture, environment split, auth fork, tenancy

**Date:** 2026-07-09
**Status:** Memo (issue #261, milestone M1). No code changes. Supersedes nothing; sits alongside
`docs/ROADMAP_2026-07-09.md` (the ordered gap list originates there — this memo expands it) and
`docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md` (the memo defers PHI/auth decisions to those answers).

## Why this exists

The moment real WebChart data flows into WorkWell, the current stack — a shared demo Neon database, a
public URL, hardcoded accounts, in-container evidence storage — is disqualified from touching PHI. This
has been true since day one but was never written down as a gate. It is the #1 unnamed production gap.
This memo names it, maps what already exists against what's missing, and gives every open gap a tracking
issue.

**Hard rule, stated once and meant absolutely: the demo stack never receives PHI.** Every measure and
every synthetic patient in the live `twh.os.mieweb.org` / `workwell-twh` Neon project is generated demo
data (see `docs/ROADMAP_2026-07-09.md` "Scale honesty" note — real CQL evaluation over a generated
population, never real patients). Nothing in this memo changes that. A PHI-capable environment is a
distinct, not-yet-built target described below.

---

## 1) PHI / HIPAA posture

### The hard rule

The demo stack (`twh.os.mieweb.org` / `twh-api-ts.os.mieweb.org` / the `workwell-twh` Neon project) is a
**public-URL, hardcoded-account, single-shared-database demo environment**. It must never receive PHI.
This is not a policy aspiration — it is the current, real security posture: anyone with the published
demo credentials (`admin@workwell.dev` / `Workwell123!`, documented in README/CLAUDE.md) can read and
write every record in the database. There is no per-customer isolation, no encryption-at-rest guarantee
beyond whatever Neon's default tier provides, and no retention policy. That is fine for synthetic data
and disqualifying for real patient data.

### Required environment split

A PHI-capable deployment cannot be "the demo stack with real data typed in." It needs to be a **separate
environment** with, at minimum:

- A separate Neon project (or equivalent managed Postgres) provisioned under a BAA (see below) — not a
  branch of `workwell-twh`, which will keep accumulating public demo traffic and synthetic scale data.
- Real user accounts, not the hardcoded demo set (see §2, Auth fork).
- A durable evidence bucket (S3/R2 with real access controls — the `CloudBucket` port already abstracts
  this; see #167) rather than the in-container ephemeral filesystem bucket the demo stack uses.
- Network/access controls scoped to MIE-authorized users only — no public sign-up, no published demo
  password.
- A retention policy and a documented deletion path (HIPAA does not mandate a specific retention period,
  but it does require a documented one, plus the ability to purge on request).

None of this is buildable in the abstract — it depends on where WorkWell is permitted to run and under
whose BAA, which is exactly the open question sent to MIE (Q C14 in
`docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md`).

### BAA chain question (open, sent to MIE — Q C14)

Two unresolved questions gate everything else in this section:

1. **Where may WorkWell run when it touches PHI?** MIE-hosted infrastructure only, or is our current
   Neon tier (or an upgraded Neon tier) eligible under a Business Associate Agreement? Neon's standard
   tiers are not HIPAA-eligible without a specific BAA-covered plan; this needs to be confirmed before
   any PHI-capable Neon project is provisioned.
2. **Who owns the BAA chain?** If WorkWell is a downstream processor of WebChart data, MIE likely needs
   to be the covered entity's business associate, and WorkWell a sub-associate under MIE's BAA (or MIE
   contracts WorkWell's hosting directly). This is a legal/contractual question, not an engineering one,
   and it is explicitly out of scope for this repo to resolve — it is Q C14, sent to Doug/Dave Carlson.

Until C14 is answered, **no PHI-capable environment should be provisioned.** Standing up infrastructure
ahead of a confirmed BAA chain would create exposure with no legal basis to operate it.

### Encryption, retention, and access-logging requirements (target state)

These are the requirements a PHI-capable environment must meet once C14 unblocks it — captured here so
the design work in #267 (the PHI-capable environment split stub, created by this memo) starts from an
explicit checklist rather than a blank page:

- **Encryption at rest:** database-level encryption (Neon's underlying storage is encrypted at rest by
  default on its managed tiers, but this must be explicitly confirmed for whatever tier is BAA-eligible)
  and encryption for the evidence bucket (S3/R2 server-side encryption, already the default for both).
- **Encryption in transit:** already true today — Neon connections are TLS-only, the MIE containers
  terminate TLS at `os.mieweb.org`, and the refresh-cookie hardening (`SameSite=None; Secure`, fail-fast
  production checks — see below) already assumes an HTTPS-only deployment.
- **Retention:** a documented retention period per data class (outcomes/evidence, audit ledger, evidence
  file bytes) and a deletion mechanism. Today's demo stack has no retention policy because it holds no
  real data; a PHI environment needs one before go-live, not after.
- **Access logging:** who accessed which patient's data, when. This is **partially covered today** — see
  the mapping below — but the audit ledger is not currently PHI-access-logging-shaped (it logs
  compliance-domain events like `RUN_COMPLETED`/`CASE_RESOLVED`, not "user X viewed patient Y's record at
  time T" reads). A PHI environment likely needs an additive read-access log, which is new scope, not a
  gap in what exists today.

### What already exists vs what's missing

| Requirement | Status | Mechanism |
|---|---|---|
| Append-only audit trail of every state change | **Exists** | `audit_events` ledger (`backend-ts/src/audit/`), written on every case/run/segment/identity/measure mutation — DATA_MODEL §3.12. Hard rule in CLAUDE.md: "Every state change writes `audit_event` — no exceptions." |
| Role-based access control | **Exists** | `authorize.ts` role gates (VIEWER/EMPLOYEE/CASE_MANAGER/AUTHOR/APPROVER/ADMIN) enforced server-side on every route; frontend `rbac.ts` mirrors it for nav/action gating (ARCHITECTURE §6–7). |
| Encrypted transport | **Exists** | TLS-only Neon connections; HTTPS-only MIE container endpoints; refresh-token cookie hardened `SameSite=None; Secure` with production fail-fast checks if misconfigured (DEPLOY.md, ARCHITECTURE §6). |
| Production startup safety checks | **Exists** | The backend refuses to start in a production-like profile with auth disabled, a weak JWT secret, wildcard/localhost CORS, or backend-demo configuration (ARCHITECTURE §6). |
| Durable, access-controlled evidence storage | **Exists (since 2026-07-14)** | #167 closed — evidence bytes go to the managed `workwell-twh-evidence` S3 bucket (public-access-blocked, versioned, least-privilege IAM) via the `resolveBucket` app seam (ADR-030); the same bucket receives the nightly `pg_dump` (#270, `backup-neon-nightly.yml`). |
| PHI-eligible database tier / BAA | **Missing** | The live Neon project (`workwell-twh`) is not provisioned under a BAA and should not be assumed HIPAA-eligible without explicit confirmation. Blocked on MIE Q C14. |
| Separate PHI-capable environment | **Missing** | No second environment exists. See the environment-split requirements above. Tracked as #267. |
| Real user directory / production auth | **Missing** | Accounts are hardcoded (CLAUDE.md hard rule, unchanged since inception). See §2. |
| Per-tenant / per-employer data isolation | **Missing** | Tenancy is a read-time display grouping over one shared dataset, not an isolation boundary. See §3. |
| Retention policy + deletion path | **Missing** | Not defined; not needed while no PHI is held. Must exist before any PHI environment goes live. |
| Patient-record access logging (who viewed what) | **Missing** | The `audit_events` ledger logs compliance-domain mutations, not generic PHI reads. A PHI environment likely needs an additive read-access log — new scope. |

---

## 2) Auth fork

### Where things stand today

WorkWell's accounts are **hardcoded** — a fixed set of demo users (`admin@workwell.dev` and role
counterparts) with no real user directory, no SSO, and no self-service account creation. This has been
true since the original 16-day sprint and is an explicit, documented hard rule in CLAUDE.md, not an
oversight. On top of that hardcoded identity layer, a real **JWT refresh-token flow** was built in
Sprint 4 — HttpOnly cookie, token rotation, `/api/auth/refresh`, with production fail-fast checks on
cookie `SameSite`/`Secure` flags (DEPLOY.md, CLAUDE.md hard rules). That flow is genuinely production-
grade token *mechanics*; what it sits on top of — the account directory itself — is not.

### The three options

1. **MIE SSO.** WorkWell authenticates users against whatever identity provider MIE already runs for
   WebChart/EH staff (likely an enterprise SSO — SAML/OIDC via MIE's existing directory). Lowest
   integration friction for MIE-side users; requires MIE to expose an SSO endpoint/client registration
   and to tell WorkWell which claims map to which WorkWell role.
2. **WebChart-delegated auth.** WorkWell trusts a session/token WebChart itself issues (e.g., a
   WebChart-signed assertion or a shared session cookie), so a user who is already logged into WebChart
   doesn't re-authenticate for WorkWell. Tightest coupling to WebChart's own session model; depends
   entirely on what WebChart's auth surface actually looks like (unknown until MIE answers).
3. **Own OIDC.** WorkWell stands up its own identity provider (or a hosted OIDC service) and manages its
   own user directory independent of MIE. Most control, most work, and the option that least leverages
   MIE's existing user base — a customer would need a second set of credentials just for WorkWell.

### Recommendation: do not build until MIE answers Q C15

None of these three should be built now. The right one depends entirely on **Q C15** in
`docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md`: *"Should WorkWell authenticate users against MIE SSO /
WebChart sessions, or run its own directory (OIDC)?"* Building any of the three ahead of that answer
risks throwing away real engineering effort on the wrong option — the JWT refresh mechanics already in
place are auth-provider-agnostic (they wrap whatever identity claim is on the token), so the actual
build-out is narrow (an identity-provider adapter, not a rework of the token flow) once the answer
lands. Tracked as #265 ("Auth for production: resolve the SSO fork") — currently decision-only, gated on
MIE.

---

## 3) Tenancy

### What exists today: read-time synthetic tenancy (demo-grade)

WorkWell already models a tenant/system dimension — "WebChart system" / employer — above the existing
enterprise→location→provider→patient hierarchy (E13 PR-1, ADR-019). Two synthetic systems ship today
(`twh` — Total Worker Health, `ihn` — Indus Hospital Network) plus a population-scale synthetic third
(`mhn`). This is **read-time grouping over one shared in-memory directory and one shared Postgres
schema** (`workwell_spike`) — every tenant's data lives in the same tables, distinguished only by a
`tenantId` field resolved from the synthetic employee catalog (DATA_MODEL §3.6, ARCHITECTURE §3). It is
sufficient to demo multi-employer rollups and prove the aggregation reconciles (All = Σ tenants), but it
is **not isolation** — it is a `WHERE tenant_id = ?`-shaped filter over shared infrastructure, not a
security boundary. Any authenticated user with roster/hierarchy read access can currently see across
tenants by omitting the `?tenant=` filter.

### What real multi-employer production isolation needs

For a genuine multi-employer production deployment (multiple real employers' worker-health data in one
WorkWell instance, or one WorkWell instance per employer), two dimensions need design:

- **Data isolation.** Either (a) a hard schema/database-per-tenant split (strongest isolation, most
  operational overhead — separate Neon projects or separate schemas per employer), or (b) row-level
  security enforced at the query layer (every store read/write scoped by an authenticated tenant claim,
  not an optional query param) with a documented, tested guarantee that no query can cross tenants
  without an explicit break-glass path. Today's `?tenant=` filter is optional and advisory — it would
  need to become mandatory and derived from the authenticated identity, not a client-supplied parameter.
- **Auth isolation.** Once real auth exists (§2), a user's identity needs to carry a tenant claim, and
  every authorization check needs to be tenant-scoped, not just role-scoped. The current `authorize.ts`
  gates by role only (CASE_MANAGER, ADMIN, etc.) — there is no tenant dimension in the authorization
  model at all today, because there has been no need for one on a single-shared-demo-dataset stack.

### This is a design-with-MIE item, not a build-now item

Real tenancy design depends on how MIE's production WebChart deployment actually segments employers —
whether one WorkWell instance serves many employers (needing the isolation model above) or whether each
employer gets its own WorkWell deployment (sidestepping the isolation problem by deployment topology
instead). That is not answerable from WorkWell's side alone. Tracked as #269 ("Real tenant isolation for
multi-employer production" — the M3 stub created by this memo), explicitly flagged as blocked on a
design conversation with MIE, not a spec WorkWell can write unilaterally.

---

## 4) Ordered gap list

From the 2026-07-09 Fable strategy session (`docs/ROADMAP_2026-07-09.md`, "Production gaps, ordered").
Each item is marked **required for first integration** (must be resolved before real WebChart/PHI data
flows) or **nice-to-have** (improves the production posture but does not block the first integration).

| # | Gap | Required for first integration? | Tracking issue |
|---|---|---|---|
| 1 | PHI / environment split | **Required** — nothing touches real data until this exists | #267 (new, this memo) |
| 2 | Auth (production) | **Required** — hardcoded accounts cannot serve real users; MIE-gated (Q C15) | #265 |
| 3 | Evidence bucket (durable storage) | **✓ DONE 2026-07-14** — `workwell-twh-evidence` live via the ADR-030 `resolveBucket` seam; evidence survives container recreates | #167 (closed) |
| 4 | Observability (failed-run alerting + run metrics) | **Required** — a silent failed batch run over real patient data is a correctness incident, not just an inconvenience | #264 |
| 5 | Scale performance (contract-timed once MIE answers volume) | Nice-to-have at launch, required before full-volume production — timing depends on Q C16 (realistic production population size) | #256, #263 (Option B trigger conditions tracked on #78) |
| 6 | Durable scheduler (missed-run detection across restarts) | Nice-to-have — the current in-process `setInterval` scheduler (E13 PR-3) loses its debounce state on container restart/redeploy, so a missed 24h cycle isn't detected or backfilled | #268 (new, this memo) |
| 7 | Real tenancy (multi-employer isolation) | Nice-to-have for a single-employer first integration; required before onboarding a second real employer | #269 (new, this memo) |
| 8 | Backup/DR runbook (Neon branch restore) | **Mostly done 2026-07-14** — runbook written + drill executed + nightly `pg_dump` to S3 live; residual = the Neon plan-upgrade decision (6h PITR + branch protection are Free-plan caps) | #270 |

Items 1–4 are the floor for touching any real WebChart data at all, PHI or not (an observability gap or
a lossy evidence bucket is unacceptable the moment a real case manager depends on the system, before PHI
enters the picture). Items 5–8 scale with how much real data and how many real employers are onboarded,
and several are explicitly timed against answers MIE hasn't given yet (Q C15, C16).

---

## Links

- `docs/ROADMAP_2026-07-09.md` — the roadmap this memo's gap list originates from (milestones M1/M2/M3,
  decision positions, sequencing)
- `docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md` — the question package this memo defers PHI/auth/tenancy
  decisions to (Q C14 PHI/BAA, Q C15 auth, Q C16 volume, Q B12 employer fields)
- `docs/DEPLOY.md` — current stack detail (MIE containers + Neon secrets, the evidence-bucket recipe,
  the self-heal reconciler)
- `docs/ARCHITECTURE.md` §6 — runtime invariants, auth/CORS production fail-fast checks
- `CLAUDE.md` — hard rules (hardcoded accounts, `WORKWELL_EMAIL_PROVIDER=simulated`, audit-on-every-
  mutation)
- #167 (evidence S3/R2 bucket), #264 (observability), #265 (auth), #256/#263 (scale perf; Option B
  trigger conditions on #78), #267/#268/#269/#270 (this memo's new M3 stubs)
