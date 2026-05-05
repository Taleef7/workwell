# WorkWell Measure Studio

Spring Boot + Next.js monorepo for occupational-health compliance operations:
author measures, run evaluations, manage cases, and maintain an audit trail.

## Current Scope

- Measures catalog + Studio (Spec, CQL, Value Sets, Tests)
- Lifecycle transitions: `Draft -> Approved -> Active -> Deprecated`
- Compile gate + test-fixture validation gate before activation
- Manual measure runs (`Audiogram`, `TB Surveillance`, and `All Programs`)
- Case worklist, case detail, outreach action, rerun-to-verify
- Audit trail + CSV export
- MCP Layer 1 read tools

## Tech Stack

- Backend: Java 21, Spring Boot 3.x, Gradle, PostgreSQL 16, Flyway
- Frontend: Next.js App Router, TypeScript
- Infra: Fly.io (backend), Vercel (frontend), Neon Postgres

## Local Development

### Backend

```bash
cd backend
./gradlew.bat test
./gradlew.bat bootRun
```

### Frontend

```bash
cd frontend
npm install
npm run lint
npm run build
npm run dev
```

## API Highlights

- `GET /api/measures`
- `GET /api/measures/{id}`
- `PUT /api/measures/{id}/spec`
- `POST /api/measures/{id}/cql/compile`
- `PUT /api/measures/{id}/tests`
- `POST /api/measures/{id}/tests/validate`
- `GET /api/value-sets`
- `POST /api/value-sets`
- `POST /api/runs/audiogram`
- `POST /api/runs/tb-surveillance`
- `POST /api/runs/manual`
- `GET /api/cases`
- `GET /api/cases/{id}`
- `POST /api/cases/{id}/actions/outreach`
- `POST /api/cases/{id}/actions/outreach/delivery?deliveryStatus=QUEUED|SENT|FAILED`
- `POST /api/cases/{id}/rerun-to-verify`
- `GET /api/admin/integrations`
- `POST /api/admin/integrations/{integration}/sync`
- `GET /api/exports/runs?format=csv`
- `GET /api/exports/outcomes?format=csv&runId={optional}`
- `GET /api/exports/cases?format=csv`
- `GET /api/audit-events/export?format=csv`

CSV column contracts:
- `runs.csv`: `runId,measureName,status,scopeType,triggerType,startedAt,completedAt,durationMs,totalEvaluated,compliant,nonCompliant`
- `outcomes.csv`: `runId,employeeId,employeeName,site,measureName,measureVersion,evaluationPeriod,status,summary,evaluatedAt,evidenceJson`
- `cases.csv`: `caseId,employeeId,employeeName,site,measureName,measureVersion,evaluationPeriod,status,priority,assignee,currentOutcomeStatus,lastRunId,updatedAt`

## Notes

- `POST /api/eval` is internal compatibility-only and requires `X-WorkWell-Internal: true`.
- Canonical execution plan: `docs/SPIKE_PLAN.md`.
- Active execution backlog: `docs/TODO.md`.
