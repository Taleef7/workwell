# E13 PR-2 — Population-scale tenant (120k) in the rollup — Design

Date: 2026-06-26
Epic: E13 (#185) — Multi-WebChart rollup + population scale + scheduled recompute
Status: Approved design (PR-2 slice)
Author: Taleef (brainstormed with Claude)

## 1. Context & goal

Doug's June-15 ask: *"120,000 people, up from 800."* E13 PR-1 added the tenant/system dimension
(All Systems → tenant → enterprise → location → provider → patient) read-time from the synthetic
directory. PR-2 proves the rollup **scales to a ~120k-subject tenant** on the live stack, with a
**perf budget** and **bounded memory** (SQL aggregation, not app-memory scans), plus a **scale-seed
harness**. PR-3 (scheduled cron recompute) is separate.

### Decisions locked during brainstorming
- **Large tenant on the live stack** (not just an offline benchmark): a real ~120k tenant appears in
  the rollup + programs KPIs.
- **Generated outcomes, one-time scale-seed** (not live CQL evaluation — 120k×14 ≈ 1.68M evals/run is
  infeasible). Deterministic, idempotent, owner-run on demand (like `seed:trend-history`), **not** on
  deploy. CQL stays authoritative for the 150 live-evaluated demo employees.
- **Hierarchy encoded in `subject_id` + SQL `GROUP BY`** — no 120k in-memory directory, **no DDL**.
- **Surfaces:** the scale tenant appears in the **hierarchy rollup** (down to provider) **and the
  programs KPIs**. The **roster (`/compliance`) is excluded** — no paging through 120k individuals.

## 2. Architecture & data model

### 2.1 Scale tenant + generated structure (no 120k in the directory)
- One new tenant in `TENANTS`: `mhn` / "MetroHealth Network". Its subjects are **not** in `EMPLOYEES`.
- `backend-ts/src/engine/synthetic/scale-structure.ts` — a deterministic generator of the scale
  tenant's **structure only**: locations + providers (default **24 locations × 10 providers = 240
  providers**), ids/names derived from indices (`L00…L23`, `P00…P09`). A few hundred objects — cheap
  to hold in memory; enough to *name* the rollup nodes. Exposes `SCALE_TENANT`, the location/provider
  lists, and lookups by encoded index.
- **Subject id codec** (same file): `encodeScaleSubject(locIdx, provIdx, n) → "mhn|L07|P03|000123"` and
  `decodeScaleSubject(id)`. Pipe-delimited so Postgres `split_part` reads the parts. The `mhn|` prefix
  identifies a scale subject. The codec is the single source of the format.

### 2.2 Scale-seed CLI (owner-run, on-demand)
- `backend-ts/src/run/cli/seed-scale.ts`, `pnpm seed:scale [--subjects 120000] [--tenant mhn] [--as-of YYYY-MM-DD]`.
- Modeled on `seed-trend-history`: honors `DATABASE_URL` (Pg ceiling), opens no local SQLite when set,
  **not** run on deploy/startup.
- Writes, per runnable measure, **one COMPLETED population run** (`scope_type='MEASURE'`,
  `scope_id=<measureId>`, `triggered_by='seed:scale'`, backdated) + N generated outcomes via the batch
  `recordOutcomes`. Each outcome's `subject_id` is `encodeScaleSubject(...)` spread across the 240
  providers (round-robin/deterministic); `status` is drawn from a deterministic compliance
  distribution (reuse `seededDistributionAtRate` semantics); **`evidence_json` is minimal (`{}` /
  a tiny `{scale:true}` marker)** to keep Neon storage modest (generated rows need no
  `expressionResults`).
- **Idempotent**: keyed on (measure, scale run) — a rerun fills only missing measures, no duplicates.
- **Audited**: one `SCALE_POPULATION_SEEDED` audit event per seeded measure.
- **Reversible** (documented SQL, schema-qualified; delete tagged outcomes then runs):
  ```sql
  DELETE FROM workwell_spike.outcomes
    WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:scale');
  DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:scale';
  ```

### 2.3 Bounded read path (SQL aggregation)
- **New `OutcomeStore` method** `aggregateScaleRun(runId): Promise<ScaleGroupCount[]>` where
  `ScaleGroupCount = { locationId: string; providerId: string; status: string; count: number }`.
  - **Pg ceiling:** `SELECT split_part(subject_id,'|',2) loc, split_part(subject_id,'|',3) prov,
    status, COUNT(*) FROM outcomes WHERE run_id = $1 GROUP BY 1,2,3`. Returns O(locations×providers×5)
    rows (~240×5 ≈ 1.2k), **never** O(subjects). This is the one method that must scale.
  - **SQLite floor:** same contract via `substr`/`instr` or a bounded in-JS group (the floor only runs
    small-N tests). Returns the identical shape.
- **Exclude scale runs from the existing in-memory path.** The rollup + programs in-memory aggregation
  filters out `runTriggeredBy === 'seed:scale'` (already joined on `OutcomeWithRun`), so the live
  150-employee tenants keep their exact current directory-resolved path and the 120k rows are never
  materialized in app memory.

### 2.4 Rollup merge
`buildHierarchyRollup` (`hierarchy-rollup.ts`):
- Builds the **small-tenant subtrees** exactly as today (directory + latest non-scale population run).
- Builds the **scale-tenant subtree** from `aggregateScaleRun` over the latest `seed:scale` run **per
  measure** (union the per-measure group-counts): `mhn` tenant → enterprise → location → **provider
  (leaf)**. Provider is a **leaf** — 120k patients are deliberately **not** enumerated. Node names come
  from `scale-structure.ts`.
- Merges both under the All-Systems root. Reconciliation holds for the levels that exist: All = Σ
  tenants; `mhn` = Σ its locations = Σ its providers. (The scale subtree simply has no patient level.)
- `?tenant=mhn` → just the scale subtree (the aggregation path only). `?tenant=twh|ihn` → the existing
  in-memory path only. `?measureId=` scopes which measures' scale runs are aggregated.

### 2.5 Programs KPIs
`programOverview`: after the existing in-memory per-measure aggregation (scale runs excluded), add the
scale tenant's per-measure counts by **reusing the same `aggregateScaleRun(runId)`** over the latest
`seed:scale` run for that measure and **summing its group-counts by status** (collapsing loc/prov) —
one method, no separate query. `?tenant=mhn` shows only scale; `?tenant=twh|ihn` excludes scale; no
tenant → live + scale summed. Trend/top-drivers are **not** extended to scale in PR-2 (rollup +
overview KPIs only).

## 3. Perf budget & testing

- **Bounded-memory invariant (core):** the scale path returns O(providers) grouped rows (~1.2k),
  never O(subjects). A test asserts the aggregation result row-count is bounded as N grows (e.g. equal
  at N=2k and N=20k for the same structure).
- **Perf benchmark (Pg ceiling — self-skips without a local Postgres):** seed a representative large N
  (e.g. **50k** for CI time) via the seed path, run `buildHierarchyRollup`, assert it completes under a
  budget (target **< ~2s**) and that the live in-memory path loaded **zero** scale rows (spy/guard on
  the store).
- **Floor correctness tests:** codec round-trip; `aggregateScaleRun` groups correctly at small N;
  rollup merges scale + live subtrees and reconciles (All = Σ tenants incl. the provider-leaf scale
  subtree); `?tenant=mhn` isolates; programs KPIs include scale counts; scale runs excluded from the
  live in-memory rollup/overview.
- Backend `pnpm typecheck` + full `pnpm test` green; frontend `npm run lint && npm run build` green
  (the hierarchy page already renders arbitrary depth + the tenant selector from PR-1; the scale tenant
  shows up via `GET /api/tenants` once it has data — see §5).

## 4. Frontend

Minimal — PR-1 already shipped the System `<select>` (from `GET /api/tenants`) and the depth-agnostic
rollup table. PR-2:
- `GET /api/tenants` lists `mhn` (it's in `TENANTS`), so the selector gains "MetroHealth Network"
  automatically.
- The hierarchy table renders the scale subtree (provider leaves) with no change — it already recurses
  on `children` and labels by `level`.
- No roster/programs UI change beyond what PR-1 shipped (the tenant filter already exists). The scale
  tenant's provider leaves have no expand caret (no children) — handled by existing `hasChildren`.

## 5. Constraints & invariants honored

- **No DDL / no schema migration** — encoded `subject_id` + SQL `GROUP BY` over existing columns;
  generated structure + outcomes only. Owner-gated schema rule respected.
- **No new dependencies.**
- **ADR-008** — CQL `Outcome Status` stays the sole compliance authority for live-evaluated subjects;
  the scale tenant is generated demo data and never sets a live subject's status.
- **Audit** — every scale-seed write emits `SCALE_POPULATION_SEEDED` (every state change is audited).
- **Reversible** — delete the `seed:scale` runs+outcomes (documented SQL). The default demo stays 150
  live employees until the owner runs `pnpm seed:scale`.
- **Bounded memory** — the 120k rows are aggregated in Postgres, never materialized in app memory.

## 6. Out of scope (later)

- PR-3: scheduled cron recompute (wire the inert `/api/admin/scheduler`).
- Roster (`/compliance`) paging over the scale tenant's individuals; per-patient drill-down for the
  scale tenant; trend/top-drivers/risk-outlook for the scale tenant.
- The real WebChart/MariaDB adapter (E12 PR-2, blocked on MIE schema).
- Live CQL evaluation of the scale tenant (generated outcomes only).
