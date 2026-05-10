# Auditor Mode and Export Packet README

## Objective

Implement Auditor Mode: structured export packets that package logic, evidence, run history, case actions, and audit logs into defensible artifacts.

A CSV export is useful, but an audit packet is what makes WorkWell feel enterprise-ready. It should answer: “Why did the system flag this person/run, what logic was used, what data was used, and who acted on it?”

## Packet types

### Case audit packet

Include:

- case summary
- employee context
- measure/version/policy reference
- CQL text or hash/link
- attached value sets
- latest outcome and status
- why-flagged evidence
- attachments metadata
- outreach records
- scheduled appointments
- waiver/exclusion context
- case actions timeline
- rerun verification history
- audit events
- AI assistance logs/disclaimers if used

### Run audit packet

Include:

- run metadata
- scope
- triggered by
- started/completed/duration
- measure versions evaluated
- outcome counts
- run logs
- employee outcome rows
- case impact summary
- errors/failures
- data freshness/readiness snapshot if available
- audit events linked to run

### Measure version packet

Include:

- measure metadata
- version/status/change summary
- policy reference
- spec JSON
- CQL text
- compile result
- value sets
- test fixtures/validation
- approval/activation history
- traceability matrix
- impact previews if available
- audit events linked to measure version

## Files to inspect

Backend:

- `web/ExportController.java`
- `web/AuditController.java`
- `run/RunPersistenceService.java`
- `caseflow/CaseFlowService.java`
- `measure/MeasureService.java`
- Flyway migrations

Frontend:

- `cases/[id]/page.tsx`
- `runs/[id]/page.tsx`
- `studio/[id]/page.tsx`

## Endpoints

```http
GET /api/auditor/cases/{caseId}/packet?format=json
GET /api/auditor/cases/{caseId}/packet?format=html
GET /api/auditor/runs/{runId}/packet?format=json
GET /api/auditor/runs/{runId}/packet?format=html
GET /api/auditor/measure-versions/{measureVersionId}/packet?format=json
GET /api/auditor/measure-versions/{measureVersionId}/packet?format=html
```

JSON first. HTML second. PDF can be deferred or handled by browser print-to-PDF.

## Authorization

Minimum:

- `ROLE_ADMIN`: all packets.
- `ROLE_CASE_MANAGER`: case/run packets.
- `ROLE_APPROVER`: measure version packets.
- `ROLE_AUTHOR`: own draft/measure packet if product rules allow.

Every packet generation writes:

- `AUDIT_PACKET_GENERATED`
- actor
- packet type
- entity ID
- format
- timestamp
- payload size/hash

## Case packet response shape

```json
{
  "packetType": "CASE",
  "generatedAt": "2026-05-09T15:00:00Z",
  "generatedBy": "cm@workwell.dev",
  "case": { "caseId": "uuid", "status": "OPEN", "priority": "HIGH" },
  "employee": { "externalId": "emp-006", "role": "Welder", "site": "Plant A" },
  "measure": { "name": "Annual Audiogram", "version": "v1.0", "policyRef": "29 CFR 1910.95" },
  "decisionEvidence": { "whyFlagged": {}, "expressionResults": [] },
  "actions": [],
  "outreach": [],
  "appointments": [],
  "attachments": [],
  "verificationRuns": [],
  "auditEvents": [],
  "aiAssistance": [],
  "disclaimers": ["Compliance status is determined by structured CQL evaluation, not AI-generated explanation text."]
}
```

## Frontend UI

Add buttons:

- Case detail: `Export Case Audit Packet`
- Run detail: `Export Run Audit Packet`
- Measure Studio Release tab: `Export Measure Version Packet`

HTML packet layout:

1. packet metadata
2. executive summary
3. measure/policy context
4. employee/run context
5. decision evidence
6. timeline
7. actions/outreach/appointments/evidence
8. audit log
9. AI disclaimer
10. technical appendix

## Optional database table

```sql
CREATE TABLE audit_packet_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  packet_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  format TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload_hash TEXT,
  payload_size_bytes BIGINT
);
```

## Tests

- case packet includes case, employee, measure, evidence, actions, audit.
- run packet includes logs and outcome counts.
- measure packet includes spec, CQL, compile result, value sets, tests.
- unauthorized user cannot export.
- packet generation writes audit event.
- AI disclaimer appears if AI events exist.

## Acceptance criteria

- JSON export exists for case, run, and measure version.
- at least case packet has human-readable HTML or clean JSON download.
- packet export is role-protected.
- generation is audited.
- UI exposes export buttons.
- tests cover content and authorization.
