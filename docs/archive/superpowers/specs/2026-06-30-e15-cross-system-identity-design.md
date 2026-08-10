# E15 — Cross-system identity & mobility — Design

Date: 2026-06-30
Epic: E15 (#187) — Cross-system identity & mobility
Status: Draft — pending owner review (drafted by Claude for Taleef)
Author: Drafted with Claude; not yet brainstormed/approved
Depends on: E13 (#185, done) · E12 (#184, PR-2 blocked on MIE WebChart schema)

## 0. Why this is a draft (read first)

E15 is **design-first and sensitive** (identity matching across systems is the kind of thing that, done
wrong, mis-merges two real people's medical records). The epic body calls for "conservative, auditable,
human-in-the-loop" and "owner-gated for schema." This document is a **design + slice plan**, not an
approved build. Two things matter before any code:

1. **The real cross-system resolver depends on E12 PR-2** (real WebChart/MariaDB→FHIR adapters), which is
   parked on MIE's WebChart schema. We cannot resolve "the same person in two *real* systems" until two
   real systems exist.
2. **But a synthetic-first PR-1 is buildable now** on top of the E13 multi-tenant directory — and it
   demonstrates the whole identity/duplicate/mobility story for the demo without the blocker. That is the
   recommended first slice; the rest is design we lock now and execute when E12 lands.

## 1. Context & goal

Doug's June-15 feedback (`vamsi4.png` DUPLICATE badge, `vamsi5.png` employee search, plus the verbal
notes): *"provider database dropdown — same employee in two different systems,"* *"an expatriate might
move from one country to another,"* *"someone might move from one oncologist to another."* WorkWell today
assumes a **single directory**; E13 added a **tenant/system dimension** (`twh`, `ihn`, `mhn`), but each
person still belongs to exactly one system and is keyed by a system-local `externalId`. Reality:

- **One person, many systems** — the same human is a patient in WebChart-A and WebChart-B.
- **Duplicates** — those two records may not obviously be the same person (different ids, slight name
  variance), so we flag candidates rather than silently merge.
- **Mobility** — a person moves (country, employer, provider), and their **compliance history must follow
  them** rather than restarting at the new system.

**Goal:** a conservative, auditable, human-in-the-loop **person-identity layer** above the existing
tenant→enterprise→location→provider→patient hierarchy that (a) resolves one person across ≥2 source
systems, (b) surfaces and reconciles duplicate candidates, and (c) shows continuous compliance history
across a documented move.

### Decisions proposed for brainstorming (lock before build)

- **Identity is a read-time resolution layer, not a new compliance authority.** A `Person` is a resolved
  view over ≥1 source-system records. The CQL `Outcome Status` per (subject, measure, system) is
  unchanged and authoritative (ADR-008). Identity only *groups* and *follows* — it never recomputes
  compliance.
- **Match, don't auto-merge.** Deterministic candidate match keys produce *suggestions*; a human confirms
  a link/merge. Every link/unlink/merge writes an audit event. (EMPI-grade probabilistic matching is
  explicitly out of scope — too risky for synthetic-demo scope and unnecessary for the story.)
- **Synthetic-first (mirrors E13).** PR-1 models cross-system people in the read-time synthetic directory
  (no schema), exactly as E13 modeled tenants. The real resolver behind E12's adapters is PR-2+,
  owner-gated for any persistence.
- **Mobility = a documented link with a directionful timeline**, not a data move. A person's compliance
  history is the union of their linked source records, ordered by time, annotated with which system each
  came from — so a move reads as "continuous history, system changes at date X."

## 2. Architecture & data model

### 2.1 Identity model (`backend-ts/src/identity/` — new module)

A pure resolution layer, no Spring/host coupling, mirroring `segment/` and `program/`.

- `Person` = `{ personId, displayName, sources: SourceLink[] }` where
  `SourceLink = { tenantId, externalId, role, site, providerId, status: "ACTIVE" | "PRIOR" }`.
  `personId` is a stable app-generated id (synthetic: a deterministic hash of the canonical match key, so
  it is reproducible across reseeds without persistence).
- `matchKey(record)` — deterministic candidate key from low-variance fields available in the synthetic
  directory (e.g. normalized `name` + a synthetic `dateOfBirth` + a synthetic `nationalId`). Returns a
  normalized string; equal keys ⇒ duplicate candidates. **Documented as the seam** where a real EMPI /
  probabilistic matcher drops in later.
- `resolvePeople(directory)` — groups source records by match key into `Person`s; a person with >1
  `SourceLink` is a **cross-system / duplicate** person.
- `duplicateCandidates(directory)` — the subset with >1 source link in **different tenants** (the DUPLICATE
  surface).
- `mergedComplianceTimeline(person, outcomesByExternalId)` — the union of each linked record's outcomes,
  time-ordered, each entry tagged with `tenantId`/`tenantName`; the read model for "history follows the
  person." Pure; reuses the existing per-subject outcome reads.

### 2.2 Synthetic directory (`engine/synthetic/employee-catalog.ts`)

- Introduce a **small, explicit set of cross-system people** (PR-1): pick e.g. 2–3 `twh` employees and add
  a matching record in `ihn` (same synthetic person, system-local ids differ) so a real duplicate exists
  to demonstrate. Add the minimal synthetic identity fields (`dateOfBirth`, `nationalId`) needed for
  `matchKey`. **Additive only** — existing ids/counts unchanged; reconciliation tenant totals (E13) must
  still hold because each source record still belongs to exactly one tenant.
- A documented **move** fixture: one person whose `ihn` link is `status:"ACTIVE"` and whose `twh` link is
  `status:"PRIOR"` with a move date — the mobility demo subject.

### 2.3 Reconciliation with E13

Identity sits *above* the rollup and does **not** change tenant counts: a cross-system person still
contributes one outcome per (system, measure), so All-Systems = Σ tenants is preserved. The DUPLICATE
surface is an overlay/annotation, not a re-aggregation. (A future "dedupe headcount" view is explicitly
out of scope — it would break the E13 invariant and needs its own design.)

## 3. API (additive, read-only in PR-1)

| Endpoint | Shape | Notes |
|----------|-------|-------|
| `GET /api/identity/people?q=&tenant=` | `Person[]` + `X-Total-Count` | Employee search across systems (the `vamsi5.png` search); `q` matches name/id. Authenticated `/api/**`, read-only. |
| `GET /api/identity/people/:personId` | `Person` + `mergedComplianceTimeline` | The unified person view; compliance history across all linked systems. |
| `GET /api/identity/duplicates?tenant=` | `{ personId, sources[] }[]` | Duplicate-candidate worklist (the DUPLICATE badge source). |
| `POST /api/identity/people/:personId/reconcile` | body `{ action: "CONFIRM_LINK" \| "UNLINK", externalId, tenantId }` | **PR-2+, owner-gated** — confirm/break a link; audited (`IDENTITY_LINK_CONFIRMED` / `IDENTITY_LINK_BROKEN`). In PR-1 this is **design only** (links are seeded, read-only) since a write path implies persistence. |

Validation: unknown `personId`/`tenant` → empty/404, never 500 (matches E13). No new run scope.

## 4. Frontend (additive)

- **Provider-database / system selector** is already shipped (E13's System `<select>`). E15 adds a
  **cross-system person view**: a `/people` (or an extension of `/compliance`) search surface listing
  resolved `Person`s with a **DUPLICATE badge** when `sources.length > 1`.
- **Person detail** — the unified compliance timeline (reusing the `/compliance` chips + the
  `CqlEvidence` drill-in), each row labeled with its source system; a **mobility banner** ("History
  continues from *Total Worker Health* → *Indus Hospital Network* as of <date>").
- **Reconcile action** (PR-2+) — ADMIN-gated confirm/unlink with a confirm dialog; mirrors the segments
  ADMIN gating + audit pattern. Read-only for everyone in PR-1.
- Reuses existing filter/table/RBAC patterns; no new deps.

## 5. Testing

- **Backend (Vitest, SQLite floor + seeded directory):**
  - `matchKey` is stable + normalization-correct (case/whitespace/diacritics folded); two seeded
    cross-system records produce the same key, unrelated records do not.
  - `resolvePeople` groups correctly; a cross-system person has exactly the expected `SourceLink`s.
  - **E13 reconciliation still holds** with cross-system people present (All = Σ tenants) — guard test.
  - `mergedComplianceTimeline` is time-ordered, system-tagged, and includes every linked record's
    outcomes; the mobility subject reads as continuous with a system change at the move date.
  - `GET /api/identity/*` shape + auth + unknown-id handling.
- **Frontend:** `npm run lint` + `npm run build`; a wiring test for the DUPLICATE badge + person search.
- Full backend `pnpm typecheck && pnpm test` + frontend lint/build green before PR.

## 6. Docs (same PR — Definition of Done)

- `ARCHITECTURE.md` — new `identity` module (§3), `/people` surface (§4), `/api/identity/*` (§7), and the
  invariant note (§6: identity resolves/groups, never decides compliance; E13 reconciliation preserved).
- `DATA_MODEL.md` — a `§3.24` note: identity resolved read-time from the synthetic directory, **no table**
  in PR-1; the owner-gated `person_links` / audit-backed reconciliation table is the documented PR-2+
  drop-in (mirrors the §3.17/§3.19 "documented, not built" pattern).
- `DECISIONS.md` — **new ADR**: identity as a read-time resolution layer (match-don't-auto-merge,
  human-in-the-loop, CQL stays authoritative); deterministic match-key seam for a future EMPI.
- `JOURNAL.md` dated entry; `CLAUDE.md` Current Focus; `MEASURES.md` only if directory size note changes.

## 7. Constraints & invariants honored

- **No DDL in PR-1** — additive synthetic identity fields + read-time resolution; reversible by revert.
  Any persistence (reconcile write path, `person_links`) is **owner-gated** and lands no earlier than
  PR-2.
- **No new dependencies.**
- **ADR-008** — CQL `Outcome Status` stays the sole compliance authority; identity groups/follows only.
- **E13 reconciliation** (All = Σ tenants) preserved — identity is an overlay, not a re-aggregation.
- **Auditable + human-in-the-loop** — every link/unlink/merge (when the write path exists) writes an audit
  event; nothing auto-merges.
- One feature branch (`feat/e15-cross-system-identity`), merge after review, no auto-merge.

## 8. Slice plan & what unblocks when

- **PR-1 (buildable now):** synthetic cross-system people + duplicate surface + unified person view +
  mobility timeline, **read-only, no schema**. Demonstrates the entire Doug story on the demo stack.
- **PR-2 (owner-gated; needs the reconcile write path decision):** ADMIN reconcile action + audited
  link/unlink; persistence design (`person_links` table or audit-backed, like `CampaignStore`).
- **PR-3 (blocked on E12 PR-2):** wire the resolver to **real** WebChart sources via the E12 adapter seam;
  swap the synthetic `matchKey` for a real candidate matcher behind the documented port. Probabilistic /
  EMPI-grade matching remains a separate, explicitly-scoped research item.

## 9. Open questions for Doug

- Match keys in the real systems — is there a shared **national/MRN identifier** across WebChart instances,
  or must matching be demographic (name + DOB + …)? This determines deterministic-vs-probabilistic.
- Mobility across **countries** (the expatriate case) — does compliance *policy* change with the country
  (different required measures), or only the data source? (If policy changes, that pairs with E14's
  `jurisdiction` field.)
- Who is authorized to confirm/break an identity link (ADMIN only, or a dedicated identity-steward role)?
