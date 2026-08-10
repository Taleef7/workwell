# EXPORTS

Date: 2026-05-06

## `GET /api/exports/runs?format=csv`

Returns all runs (latest first), with optional filters `status`, `scopeType`, `triggerType`, and `limit`.

CSV columns:
- `runId`
- `measureName`
- `measureVersion`
- `scopeType`
- `triggerType`
- `status`
- `startedAt`
- `completedAt`
- `durationMs`
- `totalEvaluated`
- `compliant`
- `dueSoon`
- `overdue`
- `missingData`
- `excluded`
- `passRate`
- `dataFreshAsOf`

Response headers:
- `Content-Type: text/csv`
- `Content-Disposition: attachment; filename="runs-export.csv"`

## `GET /api/exports/outcomes?format=csv&runId={runId}`

Exports outcomes for a specific run. If `runId` is omitted, latest run is exported.

CSV columns:
- `outcomeId`
- `runId`
- `employeeExternalId`
- `employeeName`
- `role`
- `site`
- `measureName`
- `measureVersion`
- `evaluationPeriod`
- `status`
- `lastExamDate`
- `complianceWindowDays`
- `daysOverdue`
- `roleEligible`
- `siteEligible`
- `waiverStatus`
- `evaluatedAt`

Evidence mapping notes:
- `lastExamDate`, `complianceWindowDays`, `daysOverdue`, `roleEligible`, `siteEligible`, and `waiverStatus` are read from `outcomes.evidence_json -> why_flagged`.

## `GET /api/exports/cases?format=csv&status=open`

Exports case records. All query filters are optional: `status`, `measureId`, `priority`, `assignee`, `site`.

CSV columns:
- `caseId`
- `employeeExternalId`
- `employeeName`
- `role`
- `site`
- `measureName`
- `measureVersion`
- `evaluationPeriod`
- `status`
- `priority`
- `assignee`
- `currentOutcomeStatus`
- `nextAction`
- `lastRunId`
- `createdAt`
- `updatedAt`
- `closedAt`
- `latestOutreachDeliveryStatus`

Delivery-state mapping note:
- `latestOutreachDeliveryStatus` is derived from the latest `case_actions` row with `action_type='OUTREACH_DELIVERY_UPDATED'`.
