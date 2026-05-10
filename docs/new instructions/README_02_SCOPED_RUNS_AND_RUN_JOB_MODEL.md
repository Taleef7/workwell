# Scoped Runs and Run Job Model README

## Objective

Upgrade the execution model from a mostly demo-oriented all-program run into scoped, durable, auditable runs. WorkWell should support operational scopes such as all programs, one measure, one site, one employee, and one case verification.

## Files to inspect

Backend:

- `web/EvalController.java`
- `web/RunController.java`
- `run/AllProgramsRunService.java`
- `run/RunPersistenceService.java`
- `compile/CqlEvaluationService.java`
- `measure/MeasureService.java`
- `measure/SyntheticEmployeeCatalog.java`
- Flyway migrations.

Frontend:

- `runs/page.tsx`
- `runs/[id]/page.tsx`
- `programs/page.tsx`
- `programs/[measureId]/page.tsx`
- `cases/[id]/page.tsx`

## Run request contract

Extend `POST /api/runs/manual` or add `POST /api/runs`.

Request:

```json
{
  "scopeType": "ALL_PROGRAMS | MEASURE | SITE | EMPLOYEE | CASE",
  "measureId": "uuid optional",
  "measureVersionId": "uuid optional",
  "site": "string optional",
  "employeeExternalId": "string optional",
  "caseId": "uuid optional",
  "evaluationDate": "YYYY-MM-DD optional",
  "dryRun": false
}
```

Validation:

- `ALL_PROGRAMS`: no extra ID needed.
- `MEASURE`: requires `measureId` or `measureVersionId`.
- `SITE`: requires `site`.
- `EMPLOYEE`: requires `employeeExternalId`.
- `CASE`: requires `caseId`.

Start with support for `ALL_PROGRAMS`, `MEASURE`, and `CASE`. Add `SITE` and `EMPLOYEE` next.

## Backend design

Create a shared run executor instead of adding more controller logic.

Suggested DTO:

```java
public record ManualRunRequest(
    RunScopeType scopeType,
    UUID measureId,
    UUID measureVersionId,
    String site,
    String employeeExternalId,
    UUID caseId,
    LocalDate evaluationDate,
    boolean dryRun
) {}
```

Suggested service:

```java
public interface MeasureRunExecutor {
    ManualRunResponse run(ManualRunRequest request, String actor);
}
```

Executor responsibilities:

1. Validate request.
2. Resolve scope.
3. Create run record.
4. Write run log: requested/running.
5. Evaluate measure(s).
6. Persist outcomes.
7. Upsert cases.
8. Write audit events.
9. Finalize status.

## Run states

Use durable statuses:

- `REQUESTED`
- `QUEUED`
- `RUNNING`
- `PARTIAL_FAILURE`
- `COMPLETED`
- `FAILED`
- `CANCELLED`

Even if execution remains synchronous, persist transitional states.

## Database additions

Consider adding:

```sql
ALTER TABLE runs ADD COLUMN IF NOT EXISTS requested_scope_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS failure_summary TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS partial_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS dry_run BOOLEAN NOT NULL DEFAULT FALSE;
```

If `status` already exists, reuse it. Avoid overloading `scope_id` ambiguously unless documented.

## Run logs

Every run should log:

- run requested
- scope resolved
- measure loaded
- employee population resolved
- CQL evaluation started/completed
- employee-level failures
- outcomes persisted
- cases upserted
- run completed/failed

## Failure behavior

Employee-level failure:

- persist `MISSING_DATA` with error evidence if employee was attempted.
- continue evaluating other employees.
- mark run `PARTIAL_FAILURE` if needed.

Measure-level failure before employee evaluation:

- do not fabricate employee outcomes.
- mark run `FAILED` or `PARTIAL_FAILURE`.
- write failure summary.
- keep prior cases stable.

Case verification failure:

- do not close case.
- add `VERIFICATION_FAILED` case action.
- write audit event and run log.

## Case scope

`CASE` scope is required for corrected rerun-to-verify.

Flow:

1. Load case.
2. Resolve employee and measure version.
3. Evaluate only that employee/measure.
4. Persist verification run and outcome.
5. Update case based on actual outcome.
6. Audit prior/new status.

## Frontend requirements

Runs page controls:

- scope type dropdown
- measure dropdown
- site dropdown
- employee external ID field
- evaluation date picker
- dry-run toggle if implemented
- run button with validation

Run list columns:

- run ID short label
- scope label
- status
- triggered by
- started/completed
- duration
- total evaluated
- failure count
- pass rate

Run detail:

- summary cards
- outcome counts
- run logs
- outcome table
- failure summary
- export buttons
- rerun same scope

Case detail:

- `Rerun to Verify` should trigger CASE-scope run.
- UI must state that the case closes only if the CQL result is compliant/excluded.

## Tests

- all-program run still works.
- measure-scope run persists outcomes only for that measure.
- invalid scope returns 400.
- case-scope run evaluates one employee/measure.
- failed run does not fake outcomes.
- repeated scoped runs do not duplicate cases.
- run logs are written.

## Acceptance criteria

- ALL_PROGRAMS, MEASURE, and CASE scopes work.
- invalid scope combinations return clear 400s.
- run states are durable.
- full-measure failure does not fabricate outcomes.
- case verification uses scoped evaluation.
- UI supports scoped run initiation and run detail inspection.

## Implementation Progress

### Status
In progress

### Completed
- [x] Repository hygiene checked
- [x] Existing run flow inspected
- [x] Run scope request model added
- [x] ALL_PROGRAMS preserved
- [x] MEASURE scope implemented
- [x] CASE scope implemented
- [x] Rerun-to-verify uses shared CASE scoped evaluation path or equivalent shared logic
- [x] Run status/log behavior improved
- [x] Failure behavior documented/implemented
- [x] Backend tests added
- [x] Frontend minimal UI updated if needed
- [x] Docs updated

### In progress
- [ ] SITE scope
- [ ] EMPLOYEE scope

### Blocked
- Blocker: None
- Reason: N/A
- Needed decision: None

### Notes from implementation
- `ALL_PROGRAMS`, `MEASURE`, and `CASE` now share the same scoped-run contract.
- CASE reruns reuse the structured case verification path instead of a demo shortcut.
- Run rows now persist request metadata, final status, and failure summaries so the history view can distinguish completed, partial, and failed runs.

### Tests added/updated
- `backend/src/test/java/com/workwell/run/ScopedRunIntegrationTest.java`
- `backend/src/test/java/com/workwell/run/ScopedRunFailureIntegrationTest.java`
- `backend/src/test/java/com/workwell/web/EvalControllerTest.java`
- `backend/src/test/java/com/workwell/web/RunControllerTest.java`

### Docs updated
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/JOURNAL.md`
- `docs/new instructions/README_02_SCOPED_RUNS_AND_RUN_JOB_MODEL.md`

### Commit
- Pending
