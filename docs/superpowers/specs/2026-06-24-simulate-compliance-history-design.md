# Simulate Compliance History — Design (#197)

Date: 2026-06-24
Status: Approved (design)
Author: Taleef (with Claude)

## 1. Context

The per-employee **Individual Compliance Status** card (`/employees/[externalId]`) now has Recalculate +
inline CQL evidence (PR #198). The E10 design (Section D,
`docs/superpowers/specs/2026-06-22-e10-roster-compliance-design.md:111`) called for one more action on
that screen, deferred to its own issue (#197):

> **Simulate Compliance History** (advisory only — reuses the forecast pattern, never sets status; ADR-012).

This builds it: an **advisory, non-persisted, as-of-date re-evaluation** of one employee's compliance
across every active measure, shown in a panel below the compliance card. It generalizes the
immunization-forecast idea ("ask the engine as-of a different date") to all measures.

## 2. Goal / non-goals

**Goal:** Let an operator scrub a date and see how this employee's compliance would read on that date —
per measure, using the same chip + method vocabulary as the card — clearly advisory and writing nothing.

**Non-goals:** a persisted multi-point compliance trend / timeline (that's E13 scale work — chosen
"single date + scrub" over a mini-timeline); any change to how compliance is decided (CQL `Outcome Status`
stays sole authority — ADR-008/ADR-012); any DB write, schema, or new dependency.

## 3. Key technical decision (why scrubbing is meaningful)

The synthetic bundle builder dates events **relative to** its `evaluationDate` arg, so naively calling
`buildSyntheticBundle(employee, config, asOf)` would place the last exam at `asOf − daysSinceLastExam`
every time → the outcome would be identical on every date (useless).

Instead we **anchor the employee's events to today** and **vary only the evaluation date**:
`bundle = buildSyntheticBundle(employee, config, TODAY)` (events at absolute, today-relative positions),
then `engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: asOf })`. Days-since then equals
`asOf − (TODAY − daysSince)`, so scrubbing `asOf` forward pushes a RECURRING measure toward OVERDUE and
backward toward COMPLIANT — a real "history simulation". PERMANENT measures (series-completion, no recency)
correctly stay constant across dates ("once compliant, always compliant"). A useful property falls out:
**simulate as-of today reproduces the live cell** (both use the same seeded target).

## 4. Architecture

### 4.1 Backend — snapshot logic (pure, zero writes)

`backend-ts/src/run/employee-compliance-snapshot.ts`:

```
simulateComplianceAsOf(externalId, asOf, deps) → EmployeeComplianceSnapshot
```
- `deps = { engine: CqlExecutionEngine, employees = EMPLOYEES, today = <YYYY-MM-DD> }` (inject `today` +
  `employees` for deterministic tests).
- Resolve the subject from `employees`; if absent → return `null` (route → 404).
- For each measure id in `Object.keys(MEASURES)` (the active runnable set):
  1. `binding = MEASURE_BINDINGS[measureId]`
  2. `target = seededTargetFor(employees, binding.rateKey, externalId) ?? "MISSING_DATA"` — the same
     seeded bucket a real EMPLOYEE run uses (so the sim reflects the employee's actual synthetic history).
  3. `config = deriveExamConfig(binding, target)`
  4. `bundle = buildSyntheticBundle(employee, config, today)` — **anchor events to today** (§3).
  5. `outcome = await deps.engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: asOf })`
  6. `cell = deriveCell(outcome.outcome, outcome.evidence, measureId, asOf)` — same E10.5 vocabulary as
     the roster/card (`{ status, method }`).
  7. push `{ measureId, name: MEASURES[measureId].name, complianceClass: binding.complianceClass,
     status: cell.status, method: cell.method }`.
- Return `{ externalId, asOf, evaluations: [...] }`. **Writes nothing** — no runs, outcomes, cases, or
  audit (not a state change; mirrors the forecast endpoint). Advisory only.

Signatures reused (verbatim): `deriveExamConfig(binding: MeasureBinding, target: TargetOutcome): ExamConfig`
· `buildSyntheticBundle(employee, config, evaluationDate): FhirBundle` · `seededTargetFor(employees,
rateKey, externalId): TargetOutcome | null` · `CqlExecutionEngine.evaluate({measureId, patientBundle,
evaluationDate}): Promise<MeasureOutcome>` · `deriveCell(status, evidence, measureId, evaluationPeriod): Cell`.

### 4.2 Backend — route

`backend-ts/src/routes/compliance-simulation.ts` → `handleComplianceSimulation(req, env)`:
- `GET /api/employees/:externalId/simulate?asOf=YYYY-MM-DD` (regex match; returns `null` for any other
  path/method so the dispatcher falls through).
- `asOf` parsed via the existing `parseQueryDate(value, "asOf")` (strict YYYY-MM-DD; `QueryDateError` →
  `400 { error:"invalid_request", message }`); defaults to `today` when absent.
- Builds the engine + calls `simulateComplianceAsOf`; `null` subject → `404 { error:"not_found", externalId }`.
- Returns `{ externalId, asOf, evaluations }`. Authenticated under `/api/**`, **all roles** (read-only,
  same as the forecast). Registered in `worker.ts` after `handleOutcomes`.

### 4.3 Frontend — advisory panel

`frontend/features/employee/components/SimulateComplianceHistory.tsx`, mounted on
`frontend/app/(dashboard)/employees/[externalId]/page.tsx` directly below `<IndividualComplianceStatus>`:
- A collapsible panel (mirrors the immunization-forecast advisory card): a **date `<input type="date">`**
  (default today), a small "Simulate" affordance, and an explicit advisory banner: *"Advisory simulation —
  re-evaluates compliance as of {asOf}. Never changes status; CQL is the sole authority."*
- On date change (debounced ~300ms) → `api.get('/api/employees/{externalId}/simulate?asOf={date}')` →
  render per-measure rows reusing **`ComplianceChip`** (the endpoint returns the same `{status, method}`
  shape a roster cell carries). Loading + error + empty states; one failed fetch shows an inline message,
  never blanks the page.
- Read-only; no RBAC gate (all roles, like the forecast). Uses the token-bound `useApi()` hook.

## 5. Data flow

```
scrub date → GET /api/employees/:id/simulate?asOf=YYYY-MM-DD
  → simulateComplianceAsOf: for each active measure
       seededTargetFor → deriveExamConfig → buildSyntheticBundle(…, TODAY)
       → engine.evaluate(evaluationDate=asOf) → deriveCell
  → { externalId, asOf, evaluations:[{measureId,name,complianceClass,status,method}] }
  → render ComplianceChip per row, advisory banner   (NOTHING persisted)
```

## 6. Error / edge handling

- Malformed `asOf` → 400 (parseQueryDate). Unknown employee → 404. Both surfaced inline on the panel.
- A single measure's evaluation that throws is caught per-measure → that row shows `MISSING_DATA` /
  "evaluation error" (one bad measure never aborts the snapshot), mirroring the run pipeline's
  one-failure-doesn't-abort invariant.
- PERMANENT measures are constant across dates (expected). Future `asOf` is allowed (forward projection).
- Frontend: debounce avoids a fetch per keystroke; loading/error/empty states.

## 7. Testing

- **Backend (snapshot logic):** with an injected fixed `today` + a real engine — (a) `asOf == today`
  reproduces the seeded status for a known (employee, RECURRING measure); (b) a far-future `asOf` pushes
  that RECURRING measure to OVERDUE while a PERMANENT measure stays COMPLIANT (proves the today-anchoring
  works); (c) unknown employee → `null`.
- **Backend (route):** 200 shape (`{externalId, asOf, evaluations[]}`); malformed `asOf` → 400; unknown
  employee → 404; non-GET / wrong path → null. Seeded against the synthetic directory (no DB writes).
- **Frontend:** renders the date control + advisory banner; changing the date refetches with the new
  `asOf`; renders a `ComplianceChip` per evaluation; loading + error states.
- **Full gate:** backend `tsc --noEmit` + `node --test`; frontend `vitest` + `lint` + `build`.

## 8. Guardrails

- **Advisory only, zero writes** — no runs/outcomes/cases/audit; CQL `Outcome Status` stays the sole
  compliance authority (ADR-008/ADR-012). The simulation never feeds back into stored state.
- **No schema/DDL, no new dependencies.** Pure reuse of the engine + synthetic adapters + `deriveCell`.
- Read-only endpoint under the existing `/api/**` auth matrix (all roles).

## 9. File structure

- Create: `backend-ts/src/run/employee-compliance-snapshot.ts` (+ `.test.ts`),
  `backend-ts/src/routes/compliance-simulation.ts` (+ `.test.ts`),
  `frontend/features/employee/components/SimulateComplianceHistory.tsx` (+ `.test.tsx`).
- Modify: `backend-ts/src/worker.ts` (register route),
  `frontend/app/(dashboard)/employees/[externalId]/page.tsx` (mount panel),
  `docs/ARCHITECTURE.md` (§4 route surface + §7 endpoint), `docs/JOURNAL.md`.

## 10. References

- E10 design — `docs/superpowers/specs/2026-06-22-e10-roster-compliance-design.md:111`
- Issue #197; immunization forecast (`GET /api/immunization/forecast`, ADR-012) as the advisory-UX template
- Engine: `backend-ts/src/engine/cql/cql-execution-engine.ts` · synthetic adapters under
  `backend-ts/src/engine/synthetic/` · `deriveCell` `backend-ts/src/compliance/roster-vocabulary.ts`
