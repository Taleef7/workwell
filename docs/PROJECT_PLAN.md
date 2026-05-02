Compressing inline — applying caveman rules directly to the provided text, preserving all code blocks, URLs, headings, and file paths exactly.

# WorkWell Measure Studio — Summer 2026 Project Plan

**Author:** Taleef Tamsal
**Project sponsor:** MIE / Enterprise Health (CQL Internship)
**Internship window:** May 18 – Aug 14, 2026 (13 weeks)
**Doc version:** v1.0 — Apr 29, 2026
**Status:** Pre-internship planning; finalize during Week 0

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Background & Problem](#2-background--problem)
3. [Vocabulary & Key Concepts](#3-vocabulary--key-concepts)
4. [Solution Overview](#4-solution-overview)
5. [End-to-End Flow](#5-end-to-end-flow)
6. [Architecture & Components](#6-architecture--components)
7. [Data Model](#7-data-model)
8. [Technology Stack](#8-technology-stack)
9. [The Four Demo Measures](#9-the-four-demo-measures)
10. [Repository Structure](#10-repository-structure)
11. [MVP Success Criteria](#11-mvp-success-criteria)
12. [13-Week Roadmap](#12-13-week-roadmap)
13. [Detailed Phase Plans](#13-detailed-phase-plans)
14. [Ticket Breakdown](#14-ticket-breakdown)
15. [Week 1 Day-by-Day](#15-week-1-day-by-day)
16. [Pre-Internship Prep](#16-pre-internship-prep-apr-29--may-18)
17. [Risks & Mitigations](#17-risks--mitigations)
18. [AI/MCP Strategy & Guardrails](#18-aimcp-strategy--guardrails)
19. [Demo Script Outline](#19-demo-script-outline)
20. [References & Reading List](#20-references--reading-list)
21. [Open Questions](#21-open-questions)

---

## 1. Executive Summary

**WorkWell Measure Studio** lets compliance teams take regulation text (e.g., OSHA 29 CFR 1910.95 — annual audiograms for noise-exposed workers), convert to executable CQL, run against employee health data, generate **worklist cases** — concrete follow-up actions for non-compliant employees with "why flagged" evidence + audit trail.

Replaces spreadsheets + manual chart review with policy-to-CQL → run → operationalize pipeline. MVP = three layers:

- **Author** — Measure Studio (catalog, spec authoring, CQL editor, value sets, tests, release/approval)
- **Execute** — Run service / Measure Engine (manual + scheduled runs, outcomes, evidence)
- **Operate** — Worklist + Cases (idempotent case upsert, why-flagged explainability, actions, rerun-to-verify)

Fourth layer — **AI/MCP integration** — confirmed scope (stakeholders expect demo visibility), constrained to draft-only AI surfaces and read-only MCP server. AI never decides compliance.

**Final deliverables:** working stakeholder demo + internal pilot path + open-source reference implementation. Tests, docs, CI are daily flow — not bolted on at end.

---

## 2. Background & Problem

### 2.1 The operational pain
Compliance teams own medical surveillance requirements by site, job role, exposure risk:

- Annual physicals by role
- TB screening
- Immunizations (Hepatitis B series, seasonal flu, etc.)
- Hearing conservation (audiograms)
- Respirator clearance / fit testing
- HAZWOPER medical surveillance
- Lead, asbestos, bloodborne-pathogen surveillance

In practice: spreadsheets, manual chart review, ad hoc reporting. Result:

- Requirements interpreted inconsistently.
- "Due vs overdue" logic varies by person.
- Work reactive — someone checks spreadsheet, chases people.
- OSHA audit: defending determinations hard with no traceable evidence trail.

### 2.2 The core insight
Problem is **not** missing dashboard. Dashboards exist. Problem is absence of:

1. **Repeatable translation layer** from policy/OSHA text → executable, testable compliance logic.
2. **Reliable operational workflow** turning results into accountable follow-up actions.
3. **Explainability + audit substrate** — without "why was this person flagged?" and "who changed what, when?", system can't be trusted and leadership can't defend decisions.

eCQMs fill same gap in healthcare quality reporting. WorkWell applies same pattern to occupational-health compliance.

---

## 3. Vocabulary & Key Concepts

Glossary. Terms drive architectural choices.

### 3.1 OSHA medical surveillance
Federally required periodic health monitoring for workers exposed to specific hazards. Each rule states *who must be screened, how often, with what test*. Examples this project models:

- **29 CFR 1910.95** (Occupational Noise Exposure) → annual audiogram for workers with TWA ≥ 85 dBA.
- **29 CFR 1910.120** (HAZWOPER) → annual medical surveillance exam for hazardous-waste workers.
- **29 CFR 1910.134** (Respiratory Protection) → fit testing and medical clearance.
- **29 CFR 1910.1030** (Bloodborne Pathogens) → Hepatitis B vaccination series.

### 3.2 eCQM (electronic Clinical Quality Measure)
Standardized, computer-executable quality measure. CMS uses these for Medicare quality reporting; same *pattern* for OSHA compliance. eCQM defines populations:

- **Initial Population** — universe being evaluated (e.g., all employees).
- **Denominator** — those eligible (e.g., enrolled in hearing conservation program).
- **Numerator** — those satisfying measure (e.g., have audiogram in last 365 days).
- **Exclusions / Exceptions** — removed for valid reasons (e.g., active medical waiver).

### 3.3 CQL (Clinical Quality Language)
HL7's DSL for writing eCQM logic. Looks like SQL but operates over FHIR resources. Example from project's existing CQL:

```cql
library AnnualAudiogramCompleted version '1.2'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

codesystem "LOINC": 'http://loinc.org'
codesystem "SNOMED": 'http://snomed.info/sct'

valueset "Audiogram Procedures":          'urn:oid:2.16.840.1.113883.3.464.1003.118.11.1'
valueset "Medical Waiver Conditions":     'urn:workwell:vs:medical-waiver'
valueset "Hearing Conservation Enrollment": 'urn:workwell:vs:hearing-enrollment'

parameter "Measurement Period" Interval<DateTime>
context Patient

define "In Hearing Conservation Program":
  exists([Condition: "Hearing Conservation Enrollment"])
    or exists([Observation] O where O.code.coding.display ~ 'Noise Exposure ≥ 85 dBA')

define "Has Active Waiver":
  exists(
    [Condition: "Medical Waiver Conditions"] C
      where C.clinicalStatus ~ 'active'
        and (C.abatement is null or C.abatement after Today())
  )
```

### 3.4 FHIR R4 (Fast Healthcare Interoperability Resources)
HL7's data standard for clinical info. Resources used:

- `Patient` — employee
- `Procedure` — exams performed (audiograms, TB tests)
- `Observation` — lab results, exposure measurements, screening results
- `Condition` — diagnosed conditions (incl. program enrollments and waivers)
- `DocumentReference` — uploaded documents (waiver letters, lab reports)
- `Immunization` — vaccinations
- `Encounter` — clinical visits

CQL queries operate over these resources.

### 3.5 Value Set
Curated list of clinical codes all meaning same thing for measure purposes. Identified by OID like `urn:oid:2.16.840.1.113883.3.464.1003.118.11.1`. Example: "Audiogram Procedures" value set bundles several LOINC codes all representing audiometry tests.

**Value set drift** is real risk: if underlying code list changes, measure quietly stops working. Measures must reference value sets by ID + version.

### 3.6 Code systems
Three terminologies you'll touch:

- **LOINC** — lab tests and observations (e.g., `28615-2` = "Audiometry study")
- **SNOMED CT** — clinical concepts: conditions, procedures, findings (e.g., `183932001` = "Medical exemption")
- **ICD-10-CM** — diagnoses for billing/admin

### 3.7 "Lumpers and splitters"
Taxonomy debate: one broad measure with parameters vs many narrow specific ones? For "Annual Physical by Role," lumpers want one measure with role parameter; splitters want six role-specific measures. **MVP recommendation:** start as splitter (clearer demos, cleaner CQL), refactor later if duplication hurts.

### 3.8 "Vectorization of value sets"
Converting code lists to vector embeddings so AI assistant can suggest right value set when author types measure name. Phase 4 stretch; aligns with prior summer's RAG work.

### 3.9 Outcome states (five buckets)
Every employee × measure evaluation lands in exactly one:

- **Compliant** — satisfies measure within window
- **Due Soon** — compliant now but window closing (e.g., 30 days from expiry)
- **Overdue** — window expired, action needed
- **Missing Data** — insufficient data to determine; do **not** treat as overdue
- **Excluded** — covered by active waiver/exemption

### 3.10 Idempotent case upsert
Single most important correctness property. Cases keyed by `(employee_id, measure_version_id, evaluation_period)`. Same scope twice produces zero duplicate cases. Without this, every rerun creates noise and worklist becomes useless.

---

## 4. Solution Overview

### 4.1 What WorkWell Measure Studio is
Policy-to-CQL authoring + execution workflow that:

1. Converts OSHA / internal surveillance requirements into versioned eCQMs (CQL).
2. Executes measures against occupational health data (HRIS + EHR/FHIR + IH exposure).
3. Operationalizes outcomes as actionable worklist cases with explainability + audit.

### 4.2 What it is *not*
- Not EHR replacement.
- Not clinical decision support — operates on populations, not individual diagnoses.
- Not where AI decides compliance — AI assists humans, never adjudicates.
- Not generic rules engine — CQL is source of truth; Spec tab is structured metadata.

### 4.3 Five capabilities (from press release)
1. **OSHA-to-eCQM measure authoring** — versioned eCQMs with eligibility, exclusions, compliance windows.
2. **CQL execution against occupational health data** — produces compliance outcomes and cohorts.
3. **Evidence-based explanations for each result** — every flagged employee shows data path used.
4. **Case Worklist for compliance operations** — actionable queues, not passive dashboards.
5. **Safe AI integration** — accelerates authoring/summary/explanation; never decides compliance.

---

## 5. End-to-End Flow

### 5.1 Authoring
Measure author opens **Measure Studio**, creates "Annual Audiogram Completed v1.2." They:

- Fill **Spec tab**: eligibility criteria, exclusions/waivers, policy reference, role/site filters, compliance window in days.
- Author **CQL tab**: executable logic over FHIR R4. Compile must succeed.
- Attach **Value Sets**: identifiers, names, versions; resolvability checked at compile time.
- Define **Tests**: fixture patients with expected outcomes. Tests must pass to release.
- Submit for **Approval**: lifecycle moves Draft → Approved → Active.

Release gate refuses to activate unless CQL compiles AND tests pass.

### 5.2 Execution
At scheduled time (or manual trigger), **Run service**:

1. Creates `Run` record with scope, site, trigger type.
2. Loads roster from HRIS, clinical data from FHIR/EHR, exposure data from IH DB.
3. For each employee × active measure pair, evaluates CQL.
4. Writes per-employee `Outcome` records with status + `evidence_json`.
5. Logs progress to `RunLog` (resumable; partial progress preserved).
6. Generates `RunSummary` (counts, pass rate, duration).

### 5.3 Operations
Non-compliant outcomes flow into **Case service**:

1. Upserts cases keyed by `(employee, measure_version, evaluation_period)` — idempotent.
2. Excluded outcomes do **not** create active cases; recorded with waiver context.
3. Case Manager opens worklist, filters by status/priority/site/measure.
4. Opens case → sees Why Flagged evidence + recommended action.
5. Takes action (outreach, scheduling, evidence upload, mark resolved).
6. Triggers rerun-to-verify; case auto-closes if employee becomes Compliant.

### 5.4 Audit
Every state change writes append-only event with `run_id ↔ case_id ↔ measure_version_id` linkage:

- Measure edited / approved / activated / deprecated
- Run started / completed / failed
- Case created / assigned / updated / closed
- Action performed (outreach sent, evidence uploaded, scheduling)
- Notification dispatched

Audit log makes system defensible during OSHA audit.

---

## 6. Architecture & Components

### 6.1 Component overview

```
┌─────────────────────────────────────────────────────────────────�
│                    Frontend (Next.js + shadcn/ui)               │
│  Programs │ Worklist │ Measures │ Studio │ Test Runs │ Admin    │
└─────────────────────────────┬───────────────────────────────────┘
                              │ REST/JSON + JWT
┌─────────────────────────────┴───────────────────────────────────�
│              Backend (Spring Boot, single deployable)           │
│ ┌──────────────� ┌──────────────� ┌──────────────� ┌──────────�│
│ │   Measure    │ │   Compile/   │ │     Run      │ │   Case   ││
│ │   Service    │ │   Validate   │ │   Service    │ │  Service ││
│ └──────────────┘ └──────────────┘ └──────────────┘ └──────────┘│
│ ┌──────────────� ┌──────────────� ┌──────────────� ┌──────────�│
│ │  Value Set   │ │    Audit     │ │    AI /      │ │   MCP    ││
│ │   Registry   │ │  Event Log   │ │   Spring AI  │ │  Server  ││
│ └──────────────┘ └──────────────┘ └──────────────┘ └──────────┘│
└──────┬──────────────────────┬────────────────────────┬──────────┘
       │                      │                        │
   ┌───┴────�         ┌───────┴────────�      ┌────────┴────────�
   │Postgres│         │ HAPI FHIR JPA  │      │  Anthropic API  │
   │  (App) │         │    Server      │      │   (Claude)      │
   └────────┘         └────────────────┘      └─────────────────┘
                              │
                      ┌───────┴────────�
                      │ Synthea seed   │
                      │ + HRIS/IH stubs│
                      └────────────────┘
```

### 6.2 Backend services (Spring Boot packages, one deployable)

**Measure Service** (`com.workwell.measure`)
CRUD over `Measure` + `MeasureVersion`. Lifecycle state machine. Version cloning ("v1.1 → v1.2 with change summary").

**Compile/Validate Service** (`com.workwell.compile`)
Wraps CQL translator (`org.opencds.cqf:cql-translator`). Endpoint takes CQL text, returns `{compiled, errors[], warnings[], dependencies[], referenced_value_sets[]}`. Standardizes validation output.

**Value Set Registry** (`com.workwell.valueset`)
Stores value sets by OID + version + curated codes JSON. Resolvability check at compile/release time. Seeded from hand-picked file for MVP.

**Run Service / Measure Engine** (`com.workwell.run`)
Orchestrates runs via Spring `@Async` + `@Scheduled`. Wraps HAPI FHIR's `clinical-reasoning` module (`org.opencds.cqf.fhir:cqf-fhir-cr`) for CQL evaluation against FHIR data → `MeasureReport`s. Translates reports into `Outcome` rows. Resumable; writes partial progress.

**Case Service** (`com.workwell.caseflow`)
Subscribes to `OutcomePersisted` Spring Application Events. Upserts cases via unique key. Handles state transitions. Closes/resolves on rerun-becomes-compliant.

**Audit / Event Log** (`com.workwell.audit`)
Append-only `audit_events` table. Every service writes here via shared `AuditEventPublisher`. Queryable by run / case / measure_version.

**FHIR Data Layer** (`com.workwell.fhir`)
HAPI FHIR client wrapper. `FhirDataFetcher` loads (Patient, Procedure, Observation, Condition, DocumentReference, Immunization) for employee in scope.

**Integrations** (`com.workwell.integrations`)
Three demo-grade connectors:
- HRIS roster — CSV-fed mock (modeling SAP SuccessFactors)
- EHR FHIR client — points at HAPI FHIR sandbox
- IH exposure data — CSV-fed mock

**AI Layer** (`com.workwell.ai`)
Spring AI `AnthropicChatClient`. Prompt templates with strict JSON schema enforcement. All AI calls audited.

**MCP Server** (`com.workwell.mcp`)
Java MCP server (using `modelcontextprotocol/java-sdk`) exposing read-only tools. Runs on separate port; can be packaged separately if EH wants independent MCP deployment.

**Notification Service** (`com.workwell.notification`)
Minimum viable: templated outreach with delivery-status simulation. Stores would-have-sent records for demo. Real email delivery is post-MVP.

### 6.3 Frontend pages (mapped to screenshots)
- **Programs Overview** — Screenshot 8 — KPI cards per program
- **Program Detail** — Screenshot 7 — TB Surveillance compliance trend, top drivers
- **Worklist** — case queue with filters
- **Measures Catalog** — Screenshot 6 — table of all measures with status pills
- **Measure Studio** — Screenshot 5 — Spec tab + tab nav
- **CQL Editor** — Screenshot 4 — Monaco editor with right-rail panels
- **Test Runs** — Screenshot 3 — run history table
- **Run Logs** — Screenshot 1 — execution log + run summary
- **Admin** — Screenshot 2 — integrations, SSO, notification templates

---

## 7. Data Model

### 7.1 Core schema (PostgreSQL DDL sketch)

```sql
-- Measures and versioning
CREATE TABLE measures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  policy_ref      TEXT,                    -- e.g., "OSHA 29 CFR 1910.95"
  owner           TEXT,
  tags            TEXT[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE measure_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  measure_id      UUID NOT NULL REFERENCES measures(id),
  version         TEXT NOT NULL,           -- "v1.2"
  status          TEXT NOT NULL,           -- 'DRAFT'|'APPROVED'|'ACTIVE'|'DEPRECATED'
  spec_json       JSONB NOT NULL,          -- structured spec
  cql_text        TEXT,
  compile_status  TEXT,                    -- 'COMPILED'|'WARNINGS'|'ERRORS'
  compile_result  JSONB,                   -- errors/warnings detail
  change_summary  TEXT,
  approved_by     TEXT,
  activated_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(measure_id, version)
);

-- Value sets
CREATE TABLE value_sets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oid             TEXT NOT NULL,           -- 'urn:oid:...' or 'urn:workwell:vs:...'
  name            TEXT NOT NULL,
  version         TEXT,
  codes_json      JSONB NOT NULL,          -- [{system, code, display}, ...]
  last_resolved_at TIMESTAMPTZ,
  UNIQUE(oid, version)
);

CREATE TABLE measure_value_set_links (
  measure_version_id UUID REFERENCES measure_versions(id),
  value_set_id       UUID REFERENCES value_sets(id),
  PRIMARY KEY (measure_version_id, value_set_id)
);

-- Employees (synced from HRIS)
CREATE TABLE employees (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id     TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT,
  site            TEXT,
  supervisor_id   UUID REFERENCES employees(id),
  fhir_patient_id TEXT,                    -- corresponding FHIR Patient
  start_date      DATE,
  active          BOOLEAN DEFAULT true
);

-- Runs and outcomes
CREATE TABLE runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type        TEXT NOT NULL,         -- 'ALL'|'PROGRAM'|'MEASURE'
  scope_id          UUID,
  site              TEXT,
  trigger_type      TEXT NOT NULL,         -- 'MANUAL'|'SCHEDULED'
  status            TEXT NOT NULL,         -- 'RUNNING'|'COMPLETED'|'FAILED'|'PARTIAL'
  triggered_by      TEXT,
  started_at        TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  total_evaluated   INTEGER,
  compliant         INTEGER,
  non_compliant     INTEGER,
  duration_ms       BIGINT,
  measurement_period_start TIMESTAMPTZ NOT NULL,
  measurement_period_end   TIMESTAMPTZ NOT NULL
);

CREATE TABLE run_logs (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID NOT NULL REFERENCES runs(id),
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  level           TEXT NOT NULL,           -- 'INFO'|'WARN'|'ERROR'
  message         TEXT NOT NULL
);

CREATE TABLE outcomes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES runs(id),
  employee_id         UUID NOT NULL REFERENCES employees(id),
  measure_version_id  UUID NOT NULL REFERENCES measure_versions(id),
  evaluation_period   TEXT NOT NULL,       -- e.g., "2026-Q1" or measurement_period range
  status              TEXT NOT NULL,       -- the 5 buckets
  evidence_json       JSONB NOT NULL,
  evaluated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON outcomes (employee_id, measure_version_id, evaluation_period);
CREATE INDEX ON outcomes (run_id);

-- Cases — note the unique constraint: this is the idempotency contract
CREATE TABLE cases (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID NOT NULL REFERENCES employees(id),
  measure_version_id  UUID NOT NULL REFERENCES measure_versions(id),
  evaluation_period   TEXT NOT NULL,
  status              TEXT NOT NULL,       -- 'OPEN'|'IN_PROGRESS'|'RESOLVED'|'CLOSED'|'EXCLUDED'
  priority            TEXT NOT NULL,       -- 'HIGH'|'MEDIUM'|'LOW'
  assignee            TEXT,
  next_action         TEXT,
  current_outcome_status TEXT NOT NULL,    -- mirrors latest outcome
  last_run_id         UUID NOT NULL REFERENCES runs(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at           TIMESTAMPTZ,
  UNIQUE(employee_id, measure_version_id, evaluation_period)
);

CREATE TABLE case_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         UUID NOT NULL REFERENCES cases(id),
  action_type     TEXT NOT NULL,           -- 'OUTREACH'|'SCHEDULE'|'EVIDENCE'|'RESOLVE'|'COMMENT'
  payload_json    JSONB,
  performed_by    TEXT,
  performed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit log: append-only
CREATE TABLE audit_events (
  id                  BIGSERIAL PRIMARY KEY,
  event_type          TEXT NOT NULL,       -- e.g., 'MEASURE_RELEASED','RUN_COMPLETED','CASE_CLOSED'
  entity_type         TEXT NOT NULL,
  entity_id           UUID,
  actor               TEXT,
  ref_run_id          UUID,
  ref_case_id         UUID,
  ref_measure_version_id UUID,
  payload_json        JSONB,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_events (ref_run_id);
CREATE INDEX ON audit_events (ref_case_id);
```

### 7.2 The `evidence_json` schema

**Single most important data shape** — powers Why Flagged, audit defensibility, AI explanations. Design deliberately.

```json
{
  "status": "OVERDUE",
  "status_reason": "OVERDUE_NO_RECENT_AUDIOGRAM",
  "eligibility": {
    "in_program": true,
    "role": "Welder",
    "site": "Plant A",
    "matched_program_enrollment_resource": "Condition/abc-123"
  },
  "last_qualifying_event": {
    "date": "2024-09-15",
    "code": { "system": "http://loinc.org", "code": "28615-2", "display": "Audiometry study" },
    "source_resource": "Procedure/xyz-789"
  },
  "window": {
    "compliance_days": 365,
    "due_soon_threshold_days": 30,
    "days_since_last": 412,
    "computed_against": "2026-06-12T00:00:00Z"
  },
  "waiver": {
    "active": false,
    "checked_resources": ["Condition", "DocumentReference"]
  },
  "missing_data": null,
  "rule_path": [
    "In Hearing Conservation Program: TRUE",
    "Has Active Waiver: FALSE",
    "Most Recent Audiogram: 2024-09-15",
    "Days Since Last: 412 > 365 → OVERDUE"
  ]
}
```

`rule_path` lets AI write natural-language explanation *without* interpreting raw FHIR.

---

## 8. Technology Stack

### 8.1 Frontend
- **Next.js 14+** (App Router) + **TypeScript**
- **Tailwind CSS** + **shadcn/ui** (matches V0 storyboard visuals)
- **Monaco Editor** for CQL pane (with custom CQL language definition)
- **TanStack Query** for server state
- **Zod** for runtime API response validation
- **NextAuth / Auth.js** for session (dev mode + JWT to backend)
- **pnpm** as package manager

### 8.2 Backend
- **Spring Boot 3.x** on **Java 21 (LTS)**
- **Gradle** with Kotlin DSL
- **Spring Web** + **Spring Data JPA** + **Hibernate**
- **PostgreSQL 16+**
- **Flyway** for migrations
- **Spring Security** (JWT resource server)
- **Spring `@Scheduled` + `@Async`** for run pipeline
- **springdoc-openapi** for auto-generated OpenAPI/Swagger
- **JUnit 5 + Spring Boot Test + Testcontainers** for integration tests
- **MapStruct** for entity ↔ DTO mapping (optional; cuts boilerplate)

### 8.3 CQL + FHIR layer
- **HAPI FHIR JPA Server** (Docker) — demo EHR
- **`org.opencds.cqf.fhir:cqf-fhir-cr`** — HAPI clinical reasoning module (translator + engine + data adapter)
- **Synthea** with custom occupational-health module — synthetic patient generation
- Curated **value-set seed file** — 8–12 hand-picked value sets for 4 demo measures

### 8.4 AI layer
- **Spring AI** (`spring-ai-anthropic-spring-boot-starter`) — first-class Claude integration
- **Anthropic Claude Sonnet 4.6 or Opus 4.7** for AI calls
- **MCP Java SDK** (`io.modelcontextprotocol/sdk`) for read-only MCP server

### 8.5 Infrastructure / DevEx
- **Docker Compose** for local stack (postgres, hapi-fhir, backend, frontend)
- **GitHub Actions** for CI (build + test + lint on PR)
- **GitHub Issues** for ticket tracking (or Jira if EH mandates)
- **`.devcontainer`** config for consistent VS Code dev environments

### 8.6 Things deliberately not in scope
- Kafka / event streaming — Spring Application Events + DB-backed audit log sufficient
- Microservices — one Spring Boot app with modular packages; split later if needed
- Full VSAC integration — curated seed file
- Production-grade auth — stub roles; document prod path
- Real email delivery — simulate

---

## 9. The Four Demo Measures

Pick measures exercising four interesting outcome shapes. Lock in `docs/MEASURES.md` Week 1.

### 9.1 Annual Audiogram Completed (OSHA 29 CFR 1910.95)
- **Population:** employees enrolled in Hearing Conservation Program OR with TWA noise exposure ≥ 85 dBA.
- **Numerator:** audiogram (LOINC 28615-2) within last 365 days.
- **Exclusion:** active medical waiver (Condition with code or DocumentReference).
- **Status thresholds:** ≤335 days = Compliant, 336–365 = Due Soon, >365 = Overdue.

### 9.2 Annual Medical Surveillance Exam — HAZWOPER (OSHA 29 CFR 1910.120)
- **Population:** employees in HAZWOPER program (role-based or program enrollment).
- **Numerator:** comprehensive physical exam encounter within last 12 months.
- **Exclusion:** none for MVP.
- Tests role-based eligibility filter pattern.

### 9.3 Annual TB Screening (CDC / org policy)
- **Population:** employees in high-risk roles (clinic, healthcare-facing).
- **Numerator:** TB skin test (Mantoux) OR IGRA blood test OR symptom screen within last 12 months.
- Tests multi-path numerator pattern.

### 9.4 Flu Vaccine This Season (Org policy)
- **Population:** all clinical-facing employees.
- **Numerator:** Immunization resource for flu vaccine this season (Sep–Apr).
- Tests seasonal window pattern and Immunization resource.

These four cover: cyclic exam, role-filtered exam, multi-path screening, seasonal vaccine — exercise most CQL features needed.

---

## 10. Repository Structure

Single monorepo, cleanly split:

```
workwell-measure-studio/
├─ backend/                            # Spring Boot
│  ├─ src/main/java/com/workwell/
│  │  ├─ measure/                      # Measure + MeasureVersion
│  │  ├─ valueset/                     # Value set registry
│  │  ├─ compile/                      # CQL compile/validate service
│  │  ├─ run/                          # Run orchestrator + outcomes
│  │  ├─ caseflow/                     # Case service (avoid keyword 'case')
│  │  ├─ audit/                        # Append-only event log
│  │  ├─ fhir/                         # HAPI client + data fetcher
│  │  ├─ integrations/                 # HRIS / EHR / IH connectors
│  │  ├─ ai/                           # Spring AI integrations
│  │  ├─ mcp/                          # MCP server module
│  │  ├─ notification/                 # Templated outreach
│  │  ├─ config/                       # AppConfig, AsyncConfig, etc.
│  │  ├─ security/                     # JWT, role mapping
│  │  └─ web/                          # Common controllers, exception handlers
│  ├─ src/main/resources/
│  │  ├─ application.yml
│  │  ├─ db/migration/                 # Flyway SQL (V001__init.sql, ...)
│  │  └─ seed/value-sets.json
│  ├─ src/test/java/...                # Unit + integration tests
│  └─ build.gradle.kts
│
├─ frontend/                           # Next.js
│  ├─ app/
│  │  ├─ (dashboard)/
│  │  │  ├─ programs/
│  │  │  ├─ worklist/
│  │  │  ├─ measures/
│  │  │  ├─ studio/[measureId]/[versionId]/
│  │  │  ├─ runs/
│  │  │  └─ admin/
│  │  ├─ api/                          # Next.js API routes for BFF if needed
│  │  └─ layout.tsx
│  ├─ components/
│  │  ├─ ui/                           # shadcn primitives
│  │  └─ feature/                      # MeasureCatalog, CqlEditor, CaseDetail, ...
│  ├─ lib/
│  │  ├─ api.ts                        # typed API client
│  │  └─ schemas.ts                    # Zod schemas
│  ├─ public/
│  └─ package.json
│
├─ infra/
│  ├─ docker-compose.yml               # postgres + hapi + backend + frontend
│  ├─ docker-compose.dev.yml           # dev overrides (volume mounts, etc.)
│  ├─ synthea/
│  │  ├─ modules/                      # custom OH module
│  │  └─ output-bundles/               # generated patient bundles (gitignored)
│  └─ seed-value-sets/                 # JSON files
│
├─ docs/
│  ├─ ARCHITECTURE.md                  # how it's built
│  ├─ DATA_MODEL.md                    # schemas + invariants
│  ├─ MEASURES.md                      # the 4 demo measures, plain English
│  ├─ DEMO_SCRIPT.md                   # demo flow with timing
│  ├─ AI_GUARDRAILS.md                 # AI usage policy
│  ├─ DECISIONS.md                     # ADRs (architecture decision records)
│  └─ JOURNAL.md                       # daily/weekly log (mirror Doug's Summer 2025 lesson)
│
├─ .github/
│  ├─ workflows/ci.yml
│  └─ ISSUE_TEMPLATE/
├─ .devcontainer/
├─ LICENSE                             # Apache 2.0 if open-source path
├─ README.md
└─ PROJECT_PLAN.md                     # this doc
```

---

## 11. MVP Success Criteria

### 11.1 Functional acceptance (binary done/not-done)
1. Author creates measure, compiles CQL, attaches value sets, runs tests, releases v1.0 to Active.
2. Manual or scheduled run produces run summary + per-employee outcomes for all measures in scope.
3. Non-compliant outcomes upsert cases into worklist with assignee, status, priority, next action.
4. Case manager opens case, sees Why Flagged evidence, takes ≥1 action, reruns to verify closure.
5. Every measurable action is in audit trail.

### 11.2 Quantitative targets
- **Authoring lead time:** Draft → Active under 1 business day for single measure.
- **Run reliability:** ≥ 95% successful runs in demo environment; failures produce actionable error summaries.
- **Explainability coverage:** ≥ 95% of flagged outcomes display Why Flagged evidence.
- **Operational integrity:** duplicate-case rate near zero across repeated runs.
- **Closure loop:** case manager closes + verifies case via rerun in one pass.

### 11.3 Tradeoffs accepted
- CQL is source of truth for compliance logic. Spec tab is structured metadata for auditability/UI/explainability — **not** second rules engine.
- Compile/validate is backend service call (lightweight editor, standardized output).
- Cases upserted via deterministic key — duplicate prevention built into schema, not application logic.
- MVP supports demo-grade connected flow with simulated fallbacks, not production-grade hardening.

---

## 12. 13-Week Roadmap

| Phase | Weeks | Dates | Theme | Key tickets |
|-------|-------|-------|-------|-------------|
| **0** | 1 | May 18–22 | Foundation: skeleton + first synthetic patient flowing | Repo, CI, Docker stack |
| **1** | 2–4 | May 25–Jun 12 | Authoring backbone | Tickets 1, 2, 3 |
| **2** | 5–7 | Jun 15–Jul 3 | Execution backbone | Ticket 4 |
| **3** | 8–10 | Jul 6–Jul 24 | Worklist + Cases | Tickets 5, 6 |
| **4** | 11–12 | Jul 27–Aug 7 | AI + MCP | AI Draft Spec, Explain Why Flagged, MCP server |
| **5** | 13 | Aug 10–14 | Demo hardening + docs | Seed dataset, exports, walkthrough video |

**Buffer policy:** Phase 2 slips week (likely — see Risks), Phase 3 slips week. Don't compress Phase 2 to make up time; data model built there is foundation for everything after.

---

## 13. Detailed Phase Plans

### Phase 0 — Foundation (Week 1, May 18–22)
**Goal:** every later feature has real home; one synthetic patient flows end-to-end.

**Deliverables:**
- Locked decisions in `docs/MEASURES.md` (4 measures) and `docs/ARCHITECTURE.md` (one-pager)
- Spring Boot skeleton with Postgres + Flyway + first migration creating `audit_events`
- Next.js skeleton with Tailwind + shadcn/ui init; left-nav app shell matching Screenshot 6
- HAPI FHIR JPA in `docker-compose.yml`; 50 Synthea patients ingested
- CI green on first commit (lint + unit tests run on PRs)
- First vertical slice: `GET /api/measures` returns hardcoded list; FE renders it

**Definition of Done:**
- `docker compose up` brings up entire stack from fresh clone
- New contributor clones, runs, sees Programs page in under 10 minutes

### Phase 1 — Authoring backbone (Weeks 2–4, May 25–Jun 12)
**Goal:** author one measure end-to-end including releasing v1.0 to Active.

**Week 2 — Ticket 1: Measure Catalog + Versioning**
- Backend: `Measure`, `MeasureVersion` entities; CRUD endpoints; lifecycle state machine
- Frontend: Measure Catalog page; Create Measure modal; New Version flow with change summary
- Audit events emitted on every state change

**Week 3 — Ticket 2: Spec Tab**
- Backend: extend `MeasureVersion` with `spec_json` (typed via JSON schema)
- Frontend: Measure Studio detail page with tab nav (Spec | CQL | Value Sets | Tests | Release/Approval)
- Fully functional Spec tab matching Screenshot 5

**Week 4 — Ticket 3: CQL Editor + Compile/Validate + Value Sets stub**
- Backend: `/api/compile` endpoint wrapping CQL translator
- Frontend: Monaco editor; Compile button; right-rail panels (Required Data Elements / Dependencies / Status Logic) matching Screenshot 4
- Minimal Value Sets manager (UI list + attach; backend stores OID + name + version)
- Release gate refuses to activate if compile fails

**Definition of Done:**
- User authors "Annual Audiogram Completed" end-to-end, clicks Release → v1.0 Active
- Audit log shows: created, edited, compiled, approved, activated
- Tests cover lifecycle state machine

### Phase 2 — Execution backbone (Weeks 5–7, Jun 15–Jul 3)
**Goal:** "Run All Measures Now" works against ~200 synthetic employees; outcomes persist; reruns deterministic.

**Week 5 — Run service skeleton + outcome model**
- Backend: `Run`, `RunLog`, `Outcome` entities; `/api/runs` POST enqueuing async job
- `@Scheduled` cron stub; `FhirDataFetcher` loads required resources for employee

**Week 6 — CQL evaluation loop + evidence payload (HIGHEST RISK WEEK)**
- Wire HAPI `clinical-reasoning` module to evaluate one measure version against one patient → `MeasureReport`
- Translate `MeasureReport` into `Outcome` with `status` and `evidence_json`
- **Allocate explicit spike time** to verify 4 demo measures actually run before building infrastructure around them

**Week 7 — Run summary UI + Test Runs history**
- Frontend: Run Logs page (Screenshot 1); Test Runs history (Screenshot 3)
- Verify rerun determinism: same scope twice → identical outcomes
- Stress test: 500 employees, 4 measures, measure duration

**Definition of Done:**
- Click "Run All Measures Now" → see live execution log → run completes with summary
- Run twice; outcomes identical; counts match
- ≥ 95% of outcomes have non-empty `evidence_json`

### Phase 3 — Worklist + Cases (Weeks 8–10, Jul 6–Jul 24)
**Goal:** full vertical demo loop works end-to-end with audit trail.

**Week 8 — Ticket 5: Case upsert engine**
- Subscribe to `OutcomePersisted` Spring events; upsert via unique constraint
- Auto-close on rerun-becomes-Compliant; `Excluded` outcomes don't generate active cases
- **Unit tests for idempotency contract first** — if not green, nothing else is trustworthy

**Week 9 — Ticket 6: Case detail + one action + rerun-to-verify**
- Frontend: Worklist page with filters (status, priority, assignee, measure, site)
- Case detail rendering `evidence_json` as Why Flagged panel
- One action end-to-end: **Send outreach** (templated message + delivery-status simulation)
- Rerun-to-verify button on case detail

**Week 10 — Programs overview + audit trail surfacing**
- Programs Overview (Screenshot 8); Program Detail (Screenshot 7) with KPI cards, top drivers, compliance trend
- Audit trail page filterable by run / case / measure_version
- Polish: filters persistence, keyboard shortcuts, empty states

**Definition of Done:**
- Full demo loop works without intervention: author releases → run produces outcomes → cases appear → manager opens case → sends outreach → reruns → case auto-closes
- Audit log shows entire chain with run/case/measure linkage

### Phase 4 — AI + MCP layer (Weeks 11–12, Jul 27–Aug 7)
**Goal:** AI surfaces visible in demo; MCP shows safe agent access.


**Scope note update (ADR-002 accepted):** Why Flagged is now structured-first, AI-optional.

**Week 11 — AI authoring + explainability**
- "AI Draft Spec" button (Screenshot 5): paste OSHA text → Claude returns structured `spec_json` draft → author reviews and accepts
- "Explain Why Flagged" on case detail: takes `evidence_json` → 2–3 sentence natural language explanation grounded in structured fields
- All AI calls audited; structured fields remain source of truth above explanation
- Document in `docs/AI_GUARDRAILS.md`

**Week 12 — Read-only MCP server**
- Java MCP server exposing read-only tools (see Section 18.4)
- Demo with Claude Desktop or Claude Code: "Show me the top 5 overdue cases at Plant A this week and explain why each was flagged"
- **Differentiating moment of demo**

**Definition of Done:**
- AI Draft Spec produces valid, non-hallucinated specs for known OSHA references
- Explain Why Flagged matches structured evidence (no contradictions)
- MCP server queries return only what user has permission to see

### Phase 5 — Demo hardening (Week 13, Aug 10–14)
**Goal:** clean, repeatable demo with credible auditability + open-source-ready repo.

**Deliverables:**
- Seeded demo dataset committed to repo: ~300 deterministic Synthea patients with intentional scenarios
  - One clean compliant case
  - One transitioning compliant after action
  - One waiver-excluded case
  - One missing-data case
  - One due-soon case becoming overdue
- Exportable CSV of run summary + outcomes + cases
- `README.md` with quickstart
- `ARCHITECTURE.md` with diagrams
- `DEMO_SCRIPT.md` with timing
- Walkthrough video (matches prior YouTube cadence)
- LICENSE finalized for open-source release path

**Definition of Done:**
- Stranger clones repo, follows README, reaches demo state in 15 minutes
- Demo video walks full flow in under 5 minutes

---

## 14. Ticket Breakdown

Six core tickets, each with acceptance criteria. Add as GitHub Issues at start of relevant phase.

### Ticket 1 — Measure Catalog + Versioning (CRUD + statuses)
**User story:** As measure author, I want to browse all measures, see status/version, and quickly create or update a measure version.

**Acceptance criteria:**
- Catalog table lists: Measure Name, OSHA/Policy Ref, Version, Status, Owner, Last Updated, Tags
- Create Measure flow creates Draft v0.x or v1.0 (configurable)
- New Version flow clones prior version into new Draft (e.g., v1.1 → v1.2) with change summary field
- Lifecycle states enforced: Draft → Approved → Active; Deprecated is terminal
- Audit event emitted on every state change

**Non-goals (MVP):** bulk import/export of measures.

### Ticket 2 — Measure Studio Spec Tab
**User story:** As measure author, I want to define structured requirements separate from CQL so measure is auditable and can drive UI explanations.

**Acceptance criteria:**
- Spec fields: name, description, policy reference, program enrollment criteria, role filter, site filter, compliance window in days
- Required Data Elements panel exists (manual input for MVP)
- Exclusions section supports waiver/exemption definition (label + criteria)
- Save Draft persists without requiring compiled CQL
- "AI Draft Spec" button stub (functionality lands in Phase 4)

**Non-goals (MVP):** auto-deriving all spec fields from CQL.

### Ticket 3 — CQL Editor + Compile/Validate (FHIR R4)
**User story:** As measure author, I want to write CQL and confirm it compiles so runs are trustworthy.

**Acceptance criteria:**
- CQL tab provides Monaco editor, Compile button, status indicator (Compiled / Warnings count / Errors list)
- Display dependencies list (FHIRHelpers version, CodeSystems used)
- Display referenced ValueSets (by name + identifier)
- Block Release/Approval if compile fails
- Compile result stored on `MeasureVersion`

**Non-goals (MVP):** advanced editor features (autocomplete, refactor, jump-to-definition).

### Ticket 4 — Manual Measure Run Orchestrator + Run Logs + Run Summary
**User story:** As compliance analyst, I want to trigger a run and see what happened so I can trust results and take action.

**Acceptance criteria:**
- Manual run initiated for scope (All Programs / selected program / selected measure)
- System creates `Run` record (Run ID, timestamp, scope, site, trigger type) and appends execution logs
- Run Summary includes: total employees evaluated, pass rate, compliant/non-compliant counts, duration
- Per-employee outcomes persisted with status + pointer to Why Flagged evidence
- Reruns deterministic given identical inputs

**Non-goals (MVP):** full scheduling UI; manual trigger sufficient (cron stub for scheduled).

### Ticket 5 — Worklist Case Upsert Engine
**User story:** As case manager, I want non-compliant employees to appear as cases with clear status and next action so I can work queue consistently.

**Acceptance criteria:**
- For each non-compliant outcome, system upserts case keyed by `(employee_id, measure_version_id, evaluation_period)`
- Cases include: assignee, status, priority, next action, created/updated timestamps, link to last run ID
- Excluded outcomes do **not** generate active cases (recorded with waiver context)
- On rerun: if employee becomes Compliant, case auto-closes
- Priority mapping: Overdue = High, Due Soon = Medium, Missing Data = Medium

**Non-goals (MVP):** complex routing rules; default assignment + optional supervisor escalation sufficient.

### Ticket 6 — Case Detail Evidence + One Action + Rerun-to-Verify + Audit Events
**User story:** As case manager, I want to open case, understand why it exists, take action, and verify closure via rerun.

**Acceptance criteria:**
- Case Detail shows employee + measure context, status/priority/next action, Why Flagged section listing key data elements (last exam date, role/site eligibility, waiver status)
- Evidence timeline supports outreach action (sent + delivery status)
- Rerun-to-verify: trigger rerun for employee/measure; case state updates per new outcome
- Audit trail records: run initiated/completed, case created/updated/closed, outreach sent
- Run ID ↔ Case ID ↔ Measure Version linkage visible

**Non-goals (MVP):** full document storage (evidence as metadata + link placeholder enough).

### Stretch tickets (not in critical path)
- Value Sets Manager (search/import value sets, show identifiers)
- Tests Tab (define fixtures + expected outcomes; block release if failing)
- Approval/Release Flow (single approver chain + version activation polish)
- Notifications (templates + send on case creation/escalation; delivery status)
- Admin Integrations Health (connector status, last sync, manual sync trigger)
- Baseline Reporting/Export (CSV export of run summary + outcomes + case states)

---

## 15. Week 1 Day-by-Day (May 18–22)

First week most failure-prone. Hit Friday with working hello-world end-to-end — earned the rest.

### Monday — Prep & lock decisions
- Initialize monorepo on GitHub
- Add LICENSE (Apache 2.0 if open-source path real), README stub, `.gitignore`
- Commit `docs/MEASURES.md` with 4 chosen measures in plain English
- Commit `docs/ARCHITECTURE.md` (one-pager)
- Set up `.devcontainer` config
- GitHub Actions workflow stub: `echo hello` on PR

### Tuesday — Spring Boot skeleton
- `gradle init` with Spring Boot 3.x, Java 21
- Dependencies: web, data-jpa, security, validation, actuator, flyway, postgresql
- Health endpoint live (`/actuator/health`)
- springdoc-openapi serving Swagger UI at `/swagger-ui.html`
- First Flyway migration: empty `audit_events` table
- JUnit 5 + Testcontainers integration test spinning up Postgres and verifying migration ran

### Wednesday — Next.js skeleton + Docker Compose
- `pnpm create next-app` with TS + Tailwind + App Router
- shadcn/ui init: `npx shadcn-ui@latest init`
- App shell with left nav matching Screenshot 6 (links go nowhere yet)
- Docker Compose with postgres + hapi-fhir + backend + frontend services
- `docker compose up` brings up whole stack

### Thursday — HAPI FHIR + Synthea
- HAPI FHIR JPA running in container
- Run Synthea standalone to generate 50 patients
- POST bundles to HAPI; verify via Swagger UI
- Note: Synthea occupational health modules don't ship by default — custom OH module is Phase 0 stretch. Use default population for Week 1 so data flows.

### Friday — First vertical slice + retro
- Backend: `GET /api/measures` returns hardcoded `[{name: "Annual Audiogram", version: "v1.0", status: "Active"}]`
- Frontend: Measures page fetches and renders in shadcn `Table`
- NextAuth in dev mode (no real auth, session only)
- Push everything; write Week 1 retro into `docs/JOURNAL.md`
- Celebrate

### What NOT to do in Week 1
- Real auth flow
- CQL editor
- Real measure data
- Run engine
- Case service

Deliberately later phases.

---

## 16. Pre-Internship Prep (Apr 29 → May 18)

No need to wait. Useful pre-work in priority order:

### High value (do these)
- **Read eCQM mechanics.** Walk through CMS's eCQI Resource Center. Read 2–3 published eCQMs (e.g., CMS122 Diabetes A1c) end-to-end: Initial Population, Denominator, Numerator, Exclusions.
- **Skim HAPI FHIR's `clinical-reasoning` module docs.** Single most important library.
- **Run HAPI FHIR + Synthea once locally.** Feel for FHIR resources before building around them. ~30 minutes.
- **Refresh Spring Boot 3 + Java 21.** Records, sealed classes, switch expressions. Baeldung is fastest path.
- **Sketch actual CQL for 4 measures** in scratch file. Loose CQL = know which value sets needed.
- **Re-read enhanced-rass MCP work.** Phase 4 MCP server is muscle memory if you do.

### Medium value (do if time)
- Read CQL Author's Guide (HL7) — at least first 20 pages
- Skim Spring AI's Anthropic starter docs
- Set up dev environment (Java 21, Node 20, pnpm, Docker, IntelliJ or VS Code)

### Low value (skip unless curious)
- Deep dive into all of FHIR (only need handful of resources)
- VSAC integration (curated seed file enough for MVP)
- Production deployment patterns (Phase 5 problem)

---

## 17. Risks & Mitigations

### From the original proposal
| Risk | Mitigation |
|------|-----------|
| Data completeness/mapping gaps | Treat Missing Data as first-class outcome; show data freshness/missingness in run summary |
| Value set drift / code mismatch | Show referenced value sets + dependencies; require resolvable value sets at compile/release time |
| Over-alerting / worklist fatigue | Prioritize outcomes; filters by program/site/role; idempotent reruns over repeated noise |
| Audit/explainability expectations | Store structured evidence payloads per outcome; link every case to run ID + measure version; append-only audit |
| Long-running or partially failing runs | Persist partial logs and summaries; resumable runs; keep prior outcomes stable until replacement written |

### Additional risks to watch
| Risk | Mitigation |
|------|-----------|
| **Phase 2 Week 6 integration depth** � wiring `cqf-fhir-cr` to produce `MeasureReport` from real `MeasureVersion` against real FHIR data always surprises | **Closed � ADR-002 accepted, run pipeline architecture decided.** Canonical flow is `evaluateMeasureWithCqlEngine(...)` -> `evaluateMeasure(..., compositeResults)` with probe evidence showing lower cost than direct service path (`combinedMs=2` vs `serviceEvaluateMs=5`). Remaining Week 5 confirmation: validate this same composite flow under JPA-backed repository in main backend integration. |
| **Missing Data vs Overdue branching** — hardest correctness call | Make explicit branch in CQL with separate `define` block; cover both cases in test fixtures from day one |
| **Time-zone & date math in CQL** — "within last 365 days" depends on "today" | Pin `Measurement Period` as explicit parameter passed to every run; never rely on system clock inside CQL |
| **Synthea regeneration breaks determinism** | Generate once, commit bundles as fixtures, load from disk in demo mode |
| **AI hallucination in spec drafts** | Strict JSON schema enforcement; UI shows draft as "AI suggestion" requiring explicit author acceptance; all AI calls audited |
| **"All three deliverable" pressure** | Tests + docs as you go, not at end. Never merge PR that breaks CI. If anything slips to "later," AI phase gets sacrificed. |
| **Solo developer fatigue / context loss** | Daily JOURNAL.md entries (Doug's Summer 2025 lesson). ADRs in `docs/DECISIONS.md`. Weekly retros. |

---

## 18. AI/MCP Strategy & Guardrails

Lives in `docs/AI_GUARDRAILS.md` separately; policy here.

### 18.1 The non-negotiable rule
**AI never decides compliance.** Structured `evidence_json` is always source of truth. AI explanations sit *next to* structured data, never replacing it. AI never modifies active measure version directly.

### 18.2 Three AI surfaces (Phase 4)

**1. AI Draft Spec** (Measure Studio → Spec tab)
- Input: pasted OSHA regulation text or policy reference
- Output: structured `spec_json` draft (eligibility, exclusions, compliance window, etc.)
- UX: shown as "AI suggestion — review and edit before saving"
- Author must click "Apply" to populate fields
- AI call audited with input text + output JSON

**2. Explain Why Flagged** (Case Detail)
- Input: `evidence_json` from outcome
- Output: 2–3 sentence natural-language explanation
- UX: collapsible "Plain English explanation" section beneath structured Why Flagged panel
- Explanation regenerated on demand; not stored as canonical reason
- AI call audited

**3. Run Summary Insight** (Run detail page)
- Input: run summary + per-measure breakdown
- Output: 3–5 bullet insight summary ("Flu vaccine compliance dropped 5% at Plant B; consider scheduling vaccination drive")
- UX: dismissible insight card above run details
- Author can rate insight quality (thumbs up/down) for prompt iteration

### 18.3 What AI does NOT do (deliberately)
- Does not edit CQL
- Does not change case status
- Does not send outreach without human click
- Does not modify measure versions directly
- Does not have access to write tools in Phase 4 MCP server

### 18.4 MCP server tools (Phase 4 — read-only)
| Tool | Description |
|------|-------------|
| `list_measures` | List all measures with optional status filter |
| `get_measure_version` | Get structured spec + CQL + value sets for a version |
| `list_runs` | List recent runs with optional scope filter |
| `get_run_summary` | Get summary + counts + duration for a run |
| `list_cases` | List cases with filters (status, priority, site, measure) |
| `get_case` | Get case detail including evidence_json |
| `explain_outcome` | Run AI explanation on outcome (read-only side effect: adds audit event) |

### 18.5 Future write tools (post-MVP, gated)
- `draft_outreach_message` — produces draft, never sends
- `draft_spec_from_text` — same pattern as UI button, callable by agent

All write tools require human approval before any state change.

---

## 19. Demo Script Outline

Lands in `docs/DEMO_SCRIPT.md` with timing. Sketch:

### 19.1 Setup (pre-demo)
- Run-once: `docker compose up`, run scheduled measure run 30s before demo so worklist populated
- Browser at Programs Overview page

### 19.2 The 5-minute story arc

**[0:00] Programs Overview** — "Here's what occupational health team sees Monday morning. Four programs, compliance rates, last run." Click TB Surveillance → Program Detail with top drivers.

**[0:45] Worklist** — "12 cases at Plant A clinic overdue for TB screening. Here's queue." Filter by site → click first case.

**[1:30] Case Detail with Why Flagged** — "Maria Rodriguez, Nurse, Plant A clinic. Last TB screening 412 days ago. Here's evidence — actual data points rule used." Show structured evidence.

**[2:15] AI Explanation** — Click "Plain English" → AI summary: "Maria is overdue because her last TB screening (Mar 2025) is more than 365 days old. She has no active waiver and is in a high-risk role." Note: generated *from* structured evidence, not separate inference.

**[2:45] Take Action** — Click "Send outreach reminder" → templated message; delivery status updates.

**[3:00] Behind the scenes — Measure Studio** — "Where does rule come from? Here's measure that flagged her." Open Annual TB Screening v1.3 → Spec → CQL.

**[3:45] CQL Editor** — Show actual CQL. "This is executable; compiles, testable. When OSHA changes rule, we change CQL, not 12 spreadsheet formulas."

**[4:15] AI Draft Spec** — "Here's how we'd add new measure quickly." Paste OSHA paragraph → click AI Draft Spec → draft populates → "Human reviews and decides."

**[4:45] MCP integration** — Pivot to Claude Desktop: "Agent talking to system." Run: "Show me overdue cases at Plant A and explain top three." Claude returns answer using MCP tools.

**[5:00] Audit trail** — "Everything logged. Who released measure, when run happened, who opened case, what AI said. Defensible at audit time."

### 19.3 What we DON'T demo
- Auth flow (stubbed)
- Real EHR integration (HAPI FHIR sandbox)
- Email actually sending (simulated delivery status)
- Production deployment

---

## 20. References & Reading List

### eCQM / CQL
- HL7 CQL Specification: https://cql.hl7.org/
- CMS eCQI Resource Center: https://ecqi.healthit.gov/
- CQL Author's Guide: https://cql.hl7.org/02-authorsguide.html
- Project Cypress (CQL execution test harness): https://github.com/projectcypress
- cqframework: https://github.com/cqframework/clinical_quality_language

### FHIR
- FHIR R4 spec: https://hl7.org/fhir/R4/
- HAPI FHIR: https://hapifhir.io/
- HAPI Clinical Reasoning module: https://hapifhir.io/hapi-fhir/docs/clinical_reasoning/overview.html
- Synthea: https://github.com/synthetichealth/synthea
- Synthea modules: https://github.com/synthetichealth/synthea/wiki/Generic-Module-Framework

### Spring + Java
- Spring Boot 3 reference: https://docs.spring.io/spring-boot/docs/current/reference/html/
- Spring AI Anthropic: https://docs.spring.io/spring-ai/reference/api/chat/anthropic-chat.html
- Java 21 features (records, sealed classes): https://openjdk.org/projects/jdk/21/
- Testcontainers: https://www.testcontainers.org/

### MCP
- Model Context Protocol spec: https://modelcontextprotocol.io/
- MCP Java SDK: https://github.com/modelcontextprotocol/java-sdk
- Anthropic MCP docs: https://docs.anthropic.com/en/docs/agents-and-tools/mcp

### OSHA references
- 29 CFR 1910.95 (Noise / Hearing Conservation): https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.95
- 29 CFR 1910.120 (HAZWOPER): https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.120
- 29 CFR 1910.134 (Respiratory Protection): https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.134
- 29 CFR 1910.1030 (Bloodborne Pathogens): https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.1030

### Code systems
- LOINC: https://loinc.org/
- SNOMED CT: https://www.snomed.org/
- ICD-10-CM: https://www.cms.gov/medicare/coding-billing/icd-10-codes
- VSAC (Value Set Authority Center): https://vsac.nlm.nih.gov/

### Project assets (yours, existing)
- V0 Storyboard: https://v0-work-well-measure-studio.vercel.app/
- YouTube Short walkthrough: https://youtube.com/shorts/ojDNq38NksA

---

## 21. Open Questions

No clear answers in existing docs; may surface during Week 0 discussions with Doug.

### Operational
- Will Doug or another EH stakeholder serve as regular reviewer (e.g., weekly demo)?
- Is there target customer or design partner whose workflow should drive priorities?
- Will team Doug mentioned be involved at any phase, or fully solo?
- Is there code review path within EH, or review on open-source repo only?

### Technical
- Are there existing EH services (auth, audit, FHIR connectivity) to integrate with rather than rebuild?
- Deployment target? Internal Kubernetes? Docker on VM? Runs locally for demo only?
- Preferred Java version, Spring version, or Node version inside EH to match?
- Does EH have preferred CQL engine already used elsewhere?

### Data
- Is there anonymized real data, or everything synthetic?
- Are there real value sets EH uses internally to seed from?
- Preferred HRIS shape (SuccessFactors fields, etc.) to mock?

### Scope
- Does open-source release actually happen, or hypothetical?
- Is AI integration meant to use Anthropic specifically, or provider-agnostic preferred?
- Is "Ozwell" (mentioned in proposal) separate AI product/team to coordinate with?

Add answers as they come; mark dated.

---

*End of plan. Update doc as decisions made — working source of truth.*
