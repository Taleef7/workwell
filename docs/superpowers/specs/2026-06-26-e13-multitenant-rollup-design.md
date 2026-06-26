# E13 PR-1 — Multi-tenant (multi-system) rollup — Design

Date: 2026-06-26
Epic: E13 (#185) — Multi-WebChart rollup + population scale + scheduled recompute
Status: Approved design (PR-1 slice)
Author: Taleef (brainstormed with Claude)

## 1. Context & goal

Doug's June-15 feedback: *"roll up any WebChart system into 1 quality dashboard."* WorkWell today
assumes a **single** system — one synthetic enterprise (`ENTERPRISE = {id:"twh"}`) above
`location → provider → patient` (E4 / #74). E13 PR-1 introduces a **tenant/system dimension** above
that hierarchy so compliance from multiple WebChart systems aggregates into one reconciling dashboard.

E13's other two pieces — population-scale batch (~120k) and scheduled cron recompute — are **deferred
to PR-2/PR-3**. This spec covers the multi-tenant rollup only.

### Decisions locked during brainstorming
- **5-level tree:** `tenant → enterprise → location → provider → patient` (enterprise kept for future
  multi-org tenants; 1 enterprise per tenant in PR-1).
- **Multi-tenant everywhere:** all read surfaces become tenant-aware via an additive optional
  `?tenant=<id>` filter (default = all systems). Existing demo numbers grow because a second tenant's
  employees are now evaluated — accepted.
- **2 tenants:** keep today's 100 employees as Tenant 1 (unchanged identities); add **one** new,
  contrasting-sector system, **~50 employees**.
- **No schema change:** tenant is resolved at read-time from the synthetic directory, exactly like
  `site`/`providerId` today. `outcomes`/`cases` persist only `subjectId`. (Owner-gated schema rule
  respected; ADR-008 — read models never decide compliance.)

## 2. Architecture & data model

### 2.1 Synthetic directory (`backend-ts/src/engine/synthetic/employee-catalog.ts`)
- New `Tenant` type `{ id, name }` + a `TENANTS` list.
- A `tenant → enterprise` association (PR-1: 1:1). The existing `ENTERPRISE` constant becomes
  Tenant 1's enterprise; Tenant 2 gets its own enterprise constant.
- `EmployeeProfile` gains `tenantId`; `Provider` gains `tenantId`.
- **Tenant 1 — `twh` / "Total Worker Health":** the existing 100 employees (`emp-001…emp-100`),
  providers `prov-001…prov-008`, locations Plant A / Plant B / HQ / Clinic. **Identities unchanged.**
- **Tenant 2 — `ihn` / "Indus Hospital Network":** a new healthcare-sector system with ~50 employees
  (ids prefixed `ihn-emp-001…`), its own locations (e.g. North Campus / South Campus / Outpatient
  Clinic) and providers (ids `prov-101…`), all distinctly named/keyed so nothing collides with
  Tenant 1.
- `EMPLOYEES` spans **both** tenants → the run pipeline (`run-pipeline.ts`, which iterates `EMPLOYEES`)
  evaluates everyone → real outcome data for both systems. `ALL_PROGRAMS` needs no change.
- New helpers: `tenantById(id)`, `enterpriseForTenant(tenantId)`, `employeesForTenant(tenantId)`;
  provider/location resolution carries `tenantId`. Provider attribution stays the deterministic
  per-site round-robin (pure function of inputs — reconciliation tests rely on stability).

### 2.2 Rollup (`backend-ts/src/program/hierarchy-rollup.ts`)
- New top level: a single **cross-system aggregate root** `{ level:"all", id:"all", name:"All Systems" }`
  whose children are **tenant** nodes, each → enterprise → location → provider → patient.
- `HierarchyLevel` extends to `"all" | "tenant" | "enterprise" | "location" | "provider" | "patient"`.
- **Reconciliation invariant (extended):** parent totals = Σ children at **every** level, including the
  new all→tenant and tenant→enterprise edges.
- Internal accumulation maps become **tenant-qualified** (keyed by `(tenantId, …)`) so same-named
  locations/providers never merge across tenants. (Tenant 2's names are distinct anyway; qualification
  is defensive and future-proof.)
- `?tenant=<id>` filter: when set, the returned root **is** that tenant's subtree (tenant node as root),
  so a single-system view is a strict slice whose totals equal that tenant's portion of the unfiltered
  tree. Unknown tenant → empty aggregate root (no throw).

## 3. API (additive, backward-compatible)

All tenant filters are **optional**; omitting `tenant` preserves prior behavior aggregated across all
systems (existing callers keep working).

| Endpoint | Change |
|----------|--------|
| `GET /api/hierarchy/rollup` | + `?tenant=<id>`. Default → "All Systems" aggregate root. `from`/`to`/`measureId` unchanged. |
| `GET /api/compliance/roster` | + `?tenant=<id>` (scopes rows). Each row carries `tenantId`/`tenantName`. `X-Total-Count` paging unchanged. |
| `GET /api/programs/overview` (+ `/programs/:measureId`) | + `?tenant=<id>` to scope KPI aggregates; default across all systems. |
| `GET /api/tenants` (new) | Lists `{ id, name }` for the UI selector. Authenticated under `/api/**`, read-only, no schema. |

Run pipeline: no API change in PR-1 (a `?tenant=` run scope is a possible future addition).

Validation: `tenant` is matched against `TENANTS`; unknown → empty/elided result, never 500.

## 4. Frontend (additive)

- **`/programs/hierarchy`** — the nested-expandable rollup table renders one more top level (All Systems
  → tenant → location → provider → patient). New **tenant `<select>`** (`GET /api/tenants`, default
  "All systems") appends `&tenant=`.
- **`/compliance`** — tenant `<select>` added to the existing filter row (mirrors the site/segment
  selects) + a **tenant** column on the grid.
- **`/programs`** — same tenant `<select>` scoping the overview KPIs; default "All systems".
- Reuses existing filter/table patterns + `lib/api/client.ts` GET cache. RBAC unchanged (read-only).

## 5. Testing

- **Backend (Vitest, SQLite floor + seeded-run fixtures):**
  - Directory: every employee + provider resolves to exactly one tenant; `employeesForTenant`
    partitions `EMPLOYEES` with no overlap/gap; Tenant 1 identities unchanged (snapshot of the 100 ids).
  - **Rollup reconciliation across tenants** (the headline invariant): All-Systems totals = Σ tenant =
    Σ enterprise = Σ location = Σ provider = Σ patient at every level; `?tenant=<id>` subtree totals
    equal that tenant's slice of the unfiltered tree; unknown tenant → empty root.
  - Roster/programs `?tenant=` filter: filtered counts ⊆ unfiltered; rows carry correct tenant; unknown
    tenant → empty page.
  - `GET /api/tenants` returns both tenants.
- **Frontend:** `npm run lint` + `npm run build`; light wiring test for the tenant select where the
  surface has existing vitest coverage.
- **Full backend `pnpm typecheck && pnpm test` green; frontend lint + build green** before PR.

## 6. Docs (same PR — Definition of Done)

- `ARCHITECTURE.md` — §3 `program` module (tenant level in the rollup), §4 route surfaces, §7 API
  (the `?tenant=` filters + `GET /api/tenants`), §6 invariant (cross-tenant reconciliation).
- `DATA_MODEL.md` — §3.6 directory note: tenant resolved read-time from the directory, **no table**.
- `JOURNAL.md` — dated entry.
- `DECISIONS.md` — **new ADR**: tenant dimension modeled in the read-time synthetic directory (no
  schema); the cross-system aggregate-root reconciliation contract; multi-tenant-everywhere via optional
  `?tenant=` filters.
- `CLAUDE.md` — Current Focus updated (E13 PR-1 shipped; PR-2 scale + PR-3 cron next).
- `MEASURES.md` — measures/catalog counts are **unchanged** (no measure work); employee count note only
  if it documents directory size.

## 7. Constraints & invariants honored

- **No DDL / no schema migration** — additive synthetic data + read-time resolution only. Reversible by
  reverting the PR (Tenant 2 is purely additive).
- **No new dependencies.**
- **ADR-008** — CQL `Outcome Status` stays the sole compliance authority; tenant resolution is
  display/grouping only.
- **Reconciliation** — the E4 parent=Σ-children invariant extends cleanly to the two new top edges.
- One feature branch (`feat/e13-multitenant-rollup`), merge after review, no auto-merge.

## 8. Out of scope (later E13 PRs)

- PR-2: population-scale batch path (~120k) + seed/scale harness + pagination/streaming + perf budget.
- PR-3: scheduled cron recompute (wire the inert `/api/admin/scheduler` stub to fire audited
  `ALL_PROGRAMS` runs, mirroring the self-heal reconciler workflow pattern).
- A `?tenant=` **run scope** and the real WebChart/MariaDB adapter (E12 PR-2, blocked on MIE schema).
