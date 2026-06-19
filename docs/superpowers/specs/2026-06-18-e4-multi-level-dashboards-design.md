# E4 — Multi-level Dashboards Design

Date: 2026-06-18
Status: Approved (design); schema stop-and-ask gate satisfied (no SQL — see §1)
Epic: #74 (E4). Sub-issues: #93 (E4.1 hierarchy model), #94 (E4.2 rollups + drill-down UI).

## Goal

Drill from **enterprise → location → provider → patient** with reconciling rollups, so the
`/programs` dashboard can show compliance at every level of the workforce — the headline feature in
Doug's press release. Today the dashboards cover only program(site)/measure/employee.

## Key finding (reshapes E4.1)

`backend-ts` has **no `employees` table**. The workforce is a static synthetic directory —
`backend-ts/src/engine/synthetic/employee-catalog.ts` — where each row is
`{ externalId, name, role, site }`. `outcomes` and `cases` store only `subjectId` (the external-id
slug); `site` and `role` are resolved **at read-time** from that directory (see
`program-read-models.ts`). The `employees` table described in `DATA_MODEL.md` is a stale Java-era
artifact.

**Therefore the "schema migration = stop-and-ask" gate on #93 is moot in the TS backend.** Adding the
hierarchy is a code change to the synthetic directory plus read-time rollup resolution — **no
`V0xx__*.sql`, no Neon migration, no new `outcomes`/`cases` column.** Approving this design satisfies
the stop-and-ask gate; there is no migration for Taleef to author.

## Level mapping

| Doug's level | Maps to | Status |
|---|---|---|
| enterprise | the org (single tenant, "Total Worker Health") | new (trivial constant) |
| location | `site` (HQ / Plant A / Plant B / Clinic) | already exists |
| provider | attributed occupational-health clinician | **new field** |
| patient | employee | already exists |

"Provider" = **attributed occupational-health clinician** (eCQM/MIPS-authentic: MIPS quality is
scored per provider). Each provider is pinned to exactly **one** location; each employee is attributed
to a provider **at their own site** — so the tree is strictly nested and totals reconcile by
construction.

## 1. Hierarchy model (synthetic directory — no SQL)

Extend `EmployeeProfile` in `employee-catalog.ts` with one required field:

```ts
export interface EmployeeProfile {
  externalId: string;
  name: string;
  role: string;
  site: string;        // = location level
  providerId: string;  // NEW → an entry in PROVIDERS, at the SAME location as `site`
}
```

Add two synthetic constants in the same module:

- `ENTERPRISE = { id: "twh", name: "Total Worker Health" }` — the single-tenant root.
- `PROVIDERS: readonly Provider[]` — **8 clinicians, 2 per location** across the 4 sites
  (Plant A, Plant B, HQ, Clinic), each `{ id, name, location }` where `location` is one of the
  existing sites. `id` form: `prov-001`..`prov-008`.

Every one of the 100 employees gets a `providerId` referencing a provider whose `location` equals the
employee's `site`, assigned **round-robin** within each site (deterministic — sort employees by
`externalId`, distribute across that site's providers in order). Helper exports:

- `providerById(id: string): Provider | null`
- `providersForLocation(location: string): Provider[]`

Invariant (enforced by construction + tested): for every employee, the attributed provider's
`location === employee.site`.

## 2. Rollup read-model (backend)

New module `backend-ts/src/program/hierarchy-rollup.ts`.

Input: the same outcome rows `programOverview` already uses — `listOutcomesWithRun({ from, to })`,
filtered to population runs (`isPopulationRun`, single-subject CASE/EMPLOYEE reruns excluded, exactly
as today). Optional `measureId` narrows to one measure; omitted = aggregate across all **Active**
measures. For each measure, only the **latest population run's** outcomes are counted (consistent with
`programOverview`'s "best run" selection), then summed across measures when aggregating.

Output: a node tree. Each node:

```ts
interface HierarchyNode {
  level: "enterprise" | "location" | "provider" | "patient";
  id: string;
  name: string;
  parentId: string | null;
  totals: {
    evaluated: number;
    compliant: number;
    dueSoon: number;
    overdue: number;
    missingData: number;
    excluded: number;
    complianceRate: number; // compliant/evaluated × 100, 1 decimal (round1, matches programOverview)
    openCases: number;
  };
  children: HierarchyNode[];
}
```

Build bottom-up: per patient compute totals from their counted outcome rows (and open-case count via
`caseStore.listCases`, same site/period filter approach as `programOverview`), then a provider node =
Σ its patients, a location node = Σ its providers, the enterprise node = Σ its locations. Patients with
zero counted outcomes in scope are **omitted** (no empty leaves); a provider/location with no patients
in scope is also omitted, so an empty scope yields an enterprise node with `evaluated: 0` and no
children. `complianceRate` is computed at each level from that level's summed `compliant`/`evaluated`
(not averaged from children) so it stays exact.

Endpoint (route `backend-ts/src/routes/`, authenticated under `/api/**`):

```
GET /api/hierarchy/rollup?measureId=&from=&to=  → HierarchyNode (enterprise root), application/json
```

Returns the whole tree (≈113 nodes max — small; the UI expands client-side). `measureId` for an
unknown/non-Active measure → empty enterprise node (not 404), consistent with returning a valid scope
with no data.

## 3. Frontend drill-down

New route `frontend/app/(dashboard)/programs/hierarchy/page.tsx`.

A nested **expandable semantic table**: the enterprise row expands to locations, each location expands
to its providers, each provider expands to its patients. Each row shows: name, evaluated, compliant,
complianceRate, openCases (and the outcome-bucket breakdown on the leaf/provider rows). A measure
filter (all Active measures + "All measures") reuses the existing `/programs` filter pattern and the
global site filter where applicable. Fetches `GET /api/hierarchy/rollup` via the existing API client.
Semantic tables only — the NITRO grid swaps in later once `@mieweb/datavis` is published (per the epic
note). Linked from `/programs` (a "View hierarchy" affordance).

## 4. Testing

- **Directory integrity** (`employee-catalog.test.ts` extension): every employee's `providerId`
  resolves to a `PROVIDERS` entry; that provider's `location === employee.site`; every location has
  ≥1 provider; provider ids are unique.
- **Reconciliation invariant (headline AC)** (`hierarchy-rollup.test.ts`): for **every** parent node
  at every level, `parent.totals[k] === Σ children.totals[k]` for each count field; rates recomputed
  exactly. Asserted on a deterministic fixture of outcome rows.
- **Compliance-rate correctness**: a fixture with known buckets yields the expected per-level
  `complianceRate` and `openCases`.
- **Scope filters**: `measureId` narrows correctly; `from`/`to` bound by run/case date; empty scope →
  enterprise node with zeros and no children.
- **Route test** (`hierarchy.test.ts`): 200 + correct shape; reconciliation holds through the API;
  `measureId` filter passes through.
- **Frontend**: `npm run lint` + `npm run build`; a drill-down expand render check (one level deep)
  if a component-test pattern exists in `frontend/`.

## 5. Out of scope (YAGNI)

Real provider/NPI data or provider CRUD; cross-location provider panels; the NITRO grid swap;
supervisor/org-chart hierarchy; any DB schema change; per-patient drill into case detail beyond the
existing `/cases/[id]` link.

## 6. Docs to update in the same PR

`docs/ARCHITECTURE.md` (new route surface + `/api/hierarchy/rollup` interface + the
`hierarchy-rollup` module under §3 `program`), `docs/DATA_MODEL.md` (note the synthetic-directory
hierarchy; correct the stale `employees`-table description), `docs/JOURNAL.md` (dated entry),
`README.md` key-routes/API-highlights if warranted, and `CLAUDE.md` Current Focus (E4 status). Add an
ADR to `docs/DECISIONS.md` only if a non-obvious decision warrants it (the provider=clinician modeling
choice is a candidate).
