# WorkWell Measure Catalog

WorkWell Measure Studio implements the **Total Worker Health (TWH)** model: OSHA occupational safety compliance and clinical quality / wellness measures managed in a single platform. The TWH instance seeds all three categories on startup.

## Catalog summary

| Category | Count | Status | CQL |
|----------|-------|--------|-----|
| OSHA occupational safety — fully evaluated | 4 | Active | Full CQL, runnable |
| OSHA occupational safety — catalog only | 3 | Draft / Approved / Deprecated | Partial or no CQL |
| HEDIS wellness — fully evaluated | 4 | Active | Full CQL, runnable |
| CMS eCQM catalog (2025 performance period) | 47 | Draft | Catalog entry only — CQL authoring pending |
| **Total** | **58** | | |

Outcome buckets (all measures): `COMPLIANT`, `DUE_SOON`, `OVERDUE`, `MISSING_DATA`, `EXCLUDED`.

---

## Category 1 — OSHA Occupational Safety (Full CQL)

These four measures have complete CQL libraries, are seeded as Active, and run against the synthetic employee dataset.

### 1.1 Annual Audiogram Completed
- Policy reference: OSHA 29 CFR 1910.95
  URL: https://www.ecfr.gov/current/title-29/section-1910.95
- CQL file: `backend/src/main/resources/measures/audiogram.cql`
- Tags: `surveillance`, `hearing`, `osha`

#### Define logic
- Program eligibility: `In Hearing Conservation Program`
- Exemption: `Has Active Waiver`
- Recency: `Most Recent Audiogram Date`
- Aging metric: `Days Since Last Audiogram`

#### Outcome mapping
- `EXCLUDED` when `Has Active Waiver = true`
- `MISSING_DATA` when enrolled, not waived, no exam date
- `OVERDUE` when enrolled, not waived, days since exam > 365
- `DUE_SOON` when enrolled, not waived, days in (336..365)
- `COMPLIANT` when enrolled, not waived, days <= 335

### 1.2 HAZWOPER Annual Medical Surveillance
- Policy reference: OSHA 29 CFR 1910.120
  URL: https://www.ecfr.gov/current/title-29/section-1910.120
- CQL file: `backend/src/main/resources/measures/hazwoper.cql`
- Tags: `surveillance`, `hazmat`, `osha`

#### Define logic
- Program eligibility: `In HAZWOPER Program`
- Exemption: `Has Medical Exemption`
- Recency: `Most Recent Surveillance Exam Date`
- Aging metric: `Days Since Last Exam`

#### Outcome mapping
- `EXCLUDED` when `Has Medical Exemption = true`
- `MISSING_DATA` when in program, not exempt, no exam date
- `OVERDUE` when in program, not exempt, days since exam > 365
- `DUE_SOON` when in program, not exempt, days in (335..365]
- `COMPLIANT` when in program, not exempt, days <= 335

### 1.3 Annual TB Screening
- Policy reference: CDC TB screening guidance + organizational policy
  URL: https://www.cdc.gov/tb/topic/testing/healthcareworkers.htm
- CQL file: `backend/src/main/resources/measures/tb_surveillance.cql`
- Tags: `surveillance`, `infection-control`, `cdc`

#### Define logic
- Program eligibility: `In TB Screening Program`
- Exemption: `Has Medical Exemption`
- Recency: `Most Recent TB Screen Date`
- Aging metric: `Days Since Last TB Screen`

#### Outcome mapping
- `EXCLUDED` when `Has Medical Exemption = true`
- `MISSING_DATA` when eligible, not exempt, no TB screen date
- `OVERDUE` when eligible, not exempt, days since last screen > 365
- `DUE_SOON` when eligible, not exempt, days in (330..365]
- `COMPLIANT` when eligible, not exempt, days <= 330

### 1.4 Flu Vaccine This Season
- Policy reference: Organizational seasonal policy informed by CDC guidance
  URL: https://www.cdc.gov/flu/professionals/vaccination/
- CQL file: `backend/src/main/resources/measures/flu_vaccine.cql`
- Tags: `vaccine`, `seasonal`, `immunization`

#### Define logic
- Program eligibility: `Clinical Facing Employee`
- Exemption: `Has Valid Exemption`
- Season completion: `Flu Vaccine This Season`

#### Outcome mapping
- `EXCLUDED` when `Has Valid Exemption = true`
- `COMPLIANT` when eligible, not exempt, vaccinated this season
- `MISSING_DATA` when eligible, not exempt, not vaccinated this season
- `OVERDUE` is hard-coded false in current CQL

---

## Category 2 — OSHA Occupational Safety (Catalog Only)

These three measures are seeded for catalog richness and demonstrate the full measure lifecycle (Draft → Approved → Deprecated). They have no runnable CQL evaluation.

| Name | Policy Ref | Status | Tags |
|------|-----------|--------|------|
| Respirator Fit Test | OSHA 29 CFR 1910.134 | Draft v0.9 | surveillance, respiratory, osha |
| Hepatitis B Vaccination Series | OSHA 29 CFR 1910.1030 | Approved v2.0 | vaccine, bbp, osha |
| Lead Medical Surveillance | OSHA 29 CFR 1910.1025 | Deprecated v1.1 | surveillance, lead, osha |

---

## Category 3 — HEDIS Wellness (Full CQL)

Four employer wellness / HEDIS-style measures with complete CQL and active evaluation. These represent the wellness side of TWH — chronic disease management and preventive health screening programs run by occupational health departments.

### 3.1 Hypertension BP Screening
- Policy reference: HEDIS BPC / JPMC Wellness Rewards
- CQL file: `backend/src/main/resources/measures/hypertension.cql`
- Tags: `wellness`, `hypertension`, `cardiovascular`
- Compliance window: 365 days (DueSoon 336–365)

### 3.2 Diabetes HbA1c Monitoring
- Policy reference: HEDIS HBD / JPMC Wellness Rewards
- CQL file: `backend/src/main/resources/measures/diabetes_hba1c.cql`
- Tags: `wellness`, `diabetes`, `hba1c`
- Compliance window: 180 days biannual (DueSoon 161–180)

### 3.3 BMI Screening & Counseling
- Policy reference: HEDIS WCC / Cigna Healthcare Wellness
- CQL file: `backend/src/main/resources/measures/obesity_bmi.cql`
- Tags: `wellness`, `bmi`, `obesity`
- Compliance window: 365 days annual

### 3.4 Cholesterol LDL Screening
- Policy reference: HEDIS CBP / JPMC Wellness Rewards
- CQL file: `backend/src/main/resources/measures/cholesterol_ldl.cql`
- Tags: `wellness`, `cholesterol`, `cardiovascular`
- Compliance window: 365 days annual

All four wellness measures use the same outcome pattern:
- `EXCLUDED` when `Has Medical Exemption = true`
- `MISSING_DATA` when enrolled, not exempt, no qualifying lab/screening date
- `OVERDUE` when enrolled, not exempt, days since last event > compliance window
- `DUE_SOON` when enrolled, not exempt, days approaching window end
- `COMPLIANT` when enrolled, not exempt, days within window

---

## Category 4 — CMS eCQM Catalog (2025 Performance Period)

47 official CMS electronic Clinical Quality Measures seeded as Draft v1.0 catalog entries. The `policy_ref` field stores the CMS eCQM ID (e.g., `CMS128v13`). The `spec_json` stores `cmsEcqmId` and `mipsQualityId` for downstream tooling. CQL authoring for these measures is future work.

The measures page renders CMS IDs as blue mono badges to distinguish them from OSHA CFR citations and HEDIS references.

### Domain breakdown

| Domain | Measures |
|--------|---------|
| Mental Health / Behavioral | CMS2v14, CMS128v13, CMS136v14, CMS137v13, CMS149v13, CMS159v13, CMS177v13 |
| Cardiovascular | CMS22v13, CMS90v14, CMS135v13, CMS144v13, CMS145v13, CMS165v13, CMS347v8 |
| Diabetes | CMS122v13, CMS131v13, CMS142v13, CMS951v3 |
| Cancer Screening / Preventive | CMS69v13, CMS124v13, CMS125v13, CMS130v13, CMS138v13, CMS139v13, CMS153v13, CMS155v13 |
| Pediatric / Immunization | CMS74v14, CMS75v13, CMS117v13 |
| HIV / Infectious Disease | CMS314v2, CMS349v7, CMS1157v1, CMS1188v2 |
| Oncology | CMS129v14, CMS157v13, CMS645v8, CMS646v5 |
| Ophthalmology | CMS131v13, CMS133v13, CMS143v13 |
| Functional Status / Orthopedic | CMS56v13 |
| Medication Safety | CMS68v14, CMS156v13 |
| Care Coordination | CMS50v13 |
| Nephrology | CMS951v3 |
| Urology | CMS771v6 |
| Radiology / Patient Safety | CMS1056v2 |
| Musculoskeletal | CMS249v7 |

Full list with MIPS Quality IDs is embedded in `MeasureService.CMS_ECQM_CATALOG` and visible in the measures catalog at `/measures`.

---

## Canonical Status Source

For all runnable measures, the canonical stored status is the value of CQL define `Outcome Status`.

Persistence path:
1. CQL engine evaluates all defines.
2. `Outcome Status` string is read from expression results.
3. Status is persisted in `outcomes.status`.
4. Full define-level results are persisted in `outcomes.evidence_json.expressionResults`.

## Evidence Traceability

Each outcome evidence payload includes:
- Key eligibility/exemption/recency defines for the measure.
- Computed day-difference define where applicable.
- `Outcome Status` define result.
- `why_flagged` derived fields for the UI (last exam date, compliance window, days overdue, waiver status).

## Implementation Notes

- TB and HAZWOPER recency checks use explicit procedure-code filtering in CQL so the seeded in-memory CQF evaluator can resolve the most recent exam date without relying on unsupported value-set token retrieval.
- All four HEDIS wellness measures are seeded via `ensureInstanceSeeds()` when `WORKWELL_INSTANCE=ecqm` or `twh`.
- All 47 CMS eCQM catalog entries are seeded via `ensureCmsEcqmCatalogSeed()` for the same instance values. They are Draft-only and do not participate in CQL evaluation runs until CQL is authored and compiled.
