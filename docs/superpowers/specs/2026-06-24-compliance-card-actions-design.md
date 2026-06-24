# Per-Employee Compliance Card — Actions + Evidence Drill-in (Design)

Date: 2026-06-24
Status: Approved (design)
Author: Taleef (with Claude)

## 1. Context

E10 shipped the `/compliance` roster grid (#190) and the per-employee **Individual Compliance Status**
card (#191) on `/employees/[externalId]`. The card today is read-only: a RULE → STATUS → METHOD table
whose Info expander shows only the method string, compliance class, and source run id.

E10's design (Section D, `docs/superpowers/specs/2026-06-22-e10-roster-compliance-design.md`) called for
two card actions matching UW's WebChart per-employee screen (`docs/vision doc screenshots/vamsi4.png`):
a **Recalculate** action and a per-rule **Info drill-in into the actual CQL evidence**
(`expressionResults` / `why_flagged`, "reusing the CQL Evidence Explorer"). Both were deferred from the
E10.4 PR. This change finishes them. A third deferred action — **Simulate Compliance History** — needs a
non-persisted as-of-date dry-run (new backend + its own design) and is split into a tracked follow-up
issue; it is **out of scope here**.

## 2. Goal / non-goals

**Goal:** make the per-employee compliance card actionable and fully traceable —
1. **Recalculate** the employee's compliance from the card, refreshing the whole profile.
2. **Inline CQL evidence** in each row's Info expander (every measure, compliant included), using the
   same evidence view as case-detail (extracted to a shared component — no duplication).

**Non-goals:** Simulate Compliance History (separate issue); any change to how compliance is decided
(CQL `Outcome Status` stays the sole authority — ADR-008); any schema/DDL change.

## 3. Findings that shape the design (verified)

- **Recalculate is already supported:** `POST /api/runs/manual` with `scopeType:"EMPLOYEE"` +
  `employeeExternalId` runs **synchronously** (`ASYNC_SCOPES = {ALL_PROGRAMS, SITE}` — EMPLOYEE is not
  async) and returns a terminal `COMPLETED` `ManualRunResponse`. No backend work; no `RunStatusProvider`
  needed (await → refetch). It writes the normal audited run rows.
- **Evidence is not reachable today:** the roster cell carries only `evidenceRef:{runId,outcomeId}`; the
  employee-profile endpoint (`MeasureOutcomeSummary`) *discards* evidence; `GET /api/runs/:id/outcomes`
  returns no evidence. Case-detail shows evidence only because `GET /api/cases/:id` embeds it. So a small
  **new read-only endpoint** is required to hydrate a cell's evidence by id.
- **The "CQL Evidence Explorer" is inline JSX** on `cases/[id]/page.tsx` (the `expressionResults` map +
  `INTERNAL_DEFINES` filter + `why_flagged` rows), not a reusable component. We extract it.

## 4. Architecture

### 4.1 Backend — `GET /api/outcomes/:outcomeId` (read-only, no schema)

- **Store:** add `getOutcomeById(id: string): Promise<OutcomeRecord | null>` to the `OutcomeStore`
  interface, implemented on the SQLite floor (`SELECT … FROM outcomes WHERE id = ?`) and the Postgres
  ceiling (schema-qualified `workwell_spike.outcomes`), mapping to the existing `OutcomeRecord`
  (`{id, runId, subjectId, measureId, evaluationPeriod, status, evidence, evaluatedAt}`).
- **Route:** `backend-ts/src/routes/outcomes.ts` → `handleOutcomes(req, env)`: matches `GET
  /api/outcomes/:outcomeId` exactly (returns `null` for any other path/method so the dispatcher falls
  through); resolves the store, calls `getOutcomeById`, returns `404` JSON if missing, else
  `json({ outcomeId: o.id, status: o.status, evidenceJson: o.evidence })`. Authenticated under `/api/**`,
  **all roles** (the same evidence already rendered on case-detail to all roles; read-only).
- **Wiring:** register `handleOutcomes` in `worker.ts` immediately after `handleCompliance`.
- This is **not** a schema change (read-only query on an existing table) — no owner stop-and-ask gate.

### 4.2 Frontend — shared `CqlEvidence` component

- **New** `frontend/features/evidence/CqlEvidence.tsx`: `function CqlEvidence({ evidence }: { evidence:
  EvidenceJson | null | undefined })` rendering the non-internal `expressionResults` (the
  `INTERNAL_DEFINES`/`isInternalDefine` filter moves here as the single source) + the `why_flagged` rows.
  Handles missing/empty evidence gracefully (renders a muted "No evidence recorded").
- **Refactor** `cases/[id]/page.tsx` to render `<CqlEvidence evidence={caseDetail.evidenceJson} />` in
  place of the two inline copies (mobile + desktop), removing the local `INTERNAL_DEFINES`/`isInternalDefine`
  duplication. Behavior is unchanged (the component reproduces the existing markup/semantics); existing
  case-detail tests must stay green.

### 4.3 Frontend — card actions

- **`useEmployeeProfile`** (`frontend/features/employee/hooks/useEmployeeProfile.ts`): extract its fetch
  into a `useCallback` and return `refetch`, so a recalc can refresh the whole profile (header, posture
  bar, open cases) — keeping the page consistent with the card.
- **`IndividualComplianceStatus`**:
  - Refactor the 3-panel fetch into a `load` callback (so it can re-run).
  - **Recalculate** button in the card header, gated by `canRunMeasures(user?.role)` (via `useAuth`); a
    confirm dialog; on confirm it `POST`s `/api/runs/manual` `{scopeType:"EMPLOYEE", employeeExternalId}`,
    awaits the synchronous result, then `await load()` (refresh the card) and calls `onRecalculated?.()`
    (refresh the parent profile). A busy state disables the button while running; failures surface inline.
  - **Evidence drill-in:** when a row's Info expander opens *and* its cell has an `evidenceRef`, lazy-fetch
    `GET /api/outcomes/:outcomeId` (cached per outcomeId in component state; one fetch per cell), show a
    loading line, then `<CqlEvidence evidence={evidenceJson} />` beneath the existing method/class/run-id
    summary. Cells with no `evidenceRef` (NA) show "not evaluated" (today's behavior).
  - New prop `onRecalculated?: () => void`.
- **Employee page** (`employees/[externalId]/page.tsx`): pass `onRecalculated={refetch}` from
  `useEmployeeProfile`.

## 5. Data flow

```
Recalculate:  click → confirm → POST /api/runs/manual {EMPLOYEE, externalId}  (sync, audited)
                    → await COMPLETED → load() (refetch 3 panels) + onRecalculated() (refetch profile)

Evidence:     expand row → (cell.evidenceRef?) → GET /api/outcomes/:outcomeId → {status, evidenceJson}
                    → cache per outcomeId → <CqlEvidence evidence={evidenceJson} />
```

## 6. Error / edge handling

- Recalc failure → inline error on the card; button re-enables; profile untouched.
- Evidence fetch failure / 404 → the expander shows "Evidence unavailable" (the summary line still shows);
  one bad cell never breaks the row or the card.
- NA cells (no `evidenceRef`) show no Info evidence (nothing to fetch).
- Non-run-trigger roles never see the Recalculate button (RBAC), matching the grid's Recalculate gating.

## 7. Testing

- **Backend:** `getOutcomeById` store test (round-trip + unknown→null); `handleOutcomes` route test on a
  seeded SQLite DB (200 + `evidenceJson`; unknown id → 404; non-GET / wrong path → null).
- **Frontend:**
  - `CqlEvidence.test.tsx` — renders `expressionResults` (internal defines filtered) + `why_flagged` rows;
    empty/None evidence → muted fallback.
  - `IndividualComplianceStatus.test.tsx` — Recalculate posts the EMPLOYEE body, then refetches the card
    (getWithHeaders called again) and calls `onRecalculated`; Info expand lazy-fetches the outcome and
    renders a define from its evidence; one failed evidence fetch shows "unavailable" without breaking.
  - Existing `cases/[id]` tests stay green after the `CqlEvidence` refactor.
- **Full gate:** frontend `vitest` + `lint` + `build`; backend `tsc --noEmit` + `test`.

## 8. Guardrails

- CQL `Outcome Status` remains the sole compliance authority; evidence is display-only; Recalculate reuses
  the existing audited run path (ADR-008 untouched).
- The new endpoint is read-only on an existing table — **no schema/DDL**, no owner gate.
- No new dependencies; reuse `@mieweb/ui`/Tailwind patterns + the existing `useApi`/`rbac`/`useRunStatus`
  conventions.

## 9. Out of scope (tracked follow-up)

**Simulate Compliance History** — a non-persisted, advisory as-of-date re-evaluation of an employee across
all measures (a dry-run that never writes outcomes/cases and never sets status). Needs a new backend
dry-run path + a date control + ADR-008-careful framing. Filed as its own issue; not built here.

## 10. References

- E10 design — `docs/superpowers/specs/2026-06-22-e10-roster-compliance-design.md` (Section D)
- Screenshot — `docs/vision doc screenshots/vamsi4.png`
- ADR-008 (CQL authoritative), ADR-012 (advisory forecast)
