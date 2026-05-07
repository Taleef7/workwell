# Demo Runbook (Production)

This runbook is for live demo execution against deployed production surfaces.

## 1) Production URLs
- Frontend: `https://frontend-seven-eta-24.vercel.app`
- Backend API: `https://workwell-measure-studio-api.fly.dev`

## 2) Pinned Cases for Demo
Pinned from production open-case payload on **2026-05-06**.

### Audiogram overdue (primary showcase)
- Case ID: `31fa70c5-c9cb-46fe-aeae-02506ba7bcc0`
- Employee: `emp-006` / Omar Siddiq
- Measure: Audiogram `v1.0`
- Outcome: `OVERDUE`

### Audiogram due soon (secondary)
- Case ID: `e087cd8a-16f8-438e-96af-a092054958ce`
- Employee: `emp-002` / Bilal Raza
- Outcome: `DUE_SOON`

### Audiogram missing data (secondary)
- Case ID: `7f5af8bc-114d-403c-84a4-c7066652fc27`
- Employee: `emp-004` / Kamran Malik
- Outcome: `MISSING_DATA`

## 3) Pre-Demo Health Check
Run these before presenting:
1. `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `{"status":"UP"}`
2. Open `https://frontend-seven-eta-24.vercel.app/programs` and verify cards render.
3. Open `https://frontend-seven-eta-24.vercel.app/runs` and verify run list loads.
4. Open `https://frontend-seven-eta-24.vercel.app/cases` and verify worklist loads.

## 4) Step-by-Step Demo Script

### Step 1: Programs overview
1. Open `/programs`.
2. Explain KPI row and per-program cards.
3. Click `Run All Measures Now`.
Expected:
- New run appears in `/runs`.
- Program card counts refresh.

Fallback if failed:
- If run button returns error, open `/runs` and trigger run from there.
- If API unavailable, show existing completed run detail and outcomes.

### Step 2: Run detail and outcomes
1. Open `/runs`.
2. Select latest `All Programs` run.
3. In right panel, show status, duration, evaluated count, and outcome counts.
4. Scroll outcomes table and show case links.

Expected:
- Run status `completed`.
- Outcomes table has employee-level status rows.

Fallback if failed:
- Refresh once.
- If list still empty, select previous completed run and proceed.

### Step 3: Case worklist
1. Open `/cases`.
2. Filter `Status=Open`, `Measure=Audiogram`.
3. Use search box with `emp-006`.
4. Open case `31fa70c5-c9cb-46fe-aeae-02506ba7bcc0`.

Expected:
- Selected case shows `OVERDUE` with case metadata and actions.

Fallback if failed:
- Search with case ID prefix `31fa70c5`.
- If case resolved during demo, use pinned backup overdue case: `e4539112-e760-4fdf-8882-88b910ec23f9`.

### Step 4: Why Flagged evidence + explanation
1. In case detail, review `Structured evidence trail` entries.
2. Expand `View Raw Evidence`.
3. Click `Explain Why Flagged`.

Expected AI explanation behavior:
- Panel title: `Plain-language explanation (AI-assisted)`.
- Message should paraphrase structured evidence only (for example: overdue because last valid exam is outside compliance window and no active waiver).
- Disclaimer is visible and indicates explanation is assistive, not authoritative.

Fallback if AI unavailable:
- API returns deterministic fallback explanation text.
- Continue demo using structured `expressionResults` + `why_flagged` as canonical evidence.

### Step 5: Outreach workflow
1. Select template.
2. Click `Preview outreach`.
3. Click `Send outreach`.
4. Mark delivery as `SENT`.

Expected:
- Timeline logs outreach actions.
- Delivery badge updates to `SENT`.

Fallback if failed:
- If send fails, keep demo at preview and proceed to rerun-to-verify.

### Step 6: Rerun to verify
1. Click `Rerun to verify`.
2. Return to `/runs` and show new run event.

Expected:
- Case remains open or resolves based on latest evaluated status.
- Audit trail includes rerun action.

Fallback if failed:
- Show prior successful run + audit export to prove traceability.

## 5) Admin integration check (optional)
1. Open `/admin`.
2. Trigger manual sync for `FHIR`, `MCP`, `AI`.
Expected:
- Status tiles update with recent sync timestamps.

Fallback:
- If one integration reports degraded/unavailable, continue demo; this does not block compliance evaluation path.

## 6) Post-Demo export evidence
Download and archive:
1. `/api/exports/runs?format=csv`
2. `/api/exports/outcomes?format=csv&runId=<latest-run-id>`
3. `/api/exports/cases?format=csv&status=open`
4. `/api/audit-events/export?format=csv`

These four files form the replayable evidence package.
