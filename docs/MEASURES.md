# WorkWell Measure Catalog

WorkWell Measure Studio implements the **Total Worker Health (TWH)** model: OSHA occupational safety compliance and clinical quality / wellness measures managed in a single platform. The TWH instance seeds all three categories on startup.

## Catalog summary

| Category | Count | Status | CQL |
|----------|-------|--------|-----|
| OSHA occupational safety — fully evaluated | 4 | Active | Full CQL, runnable |
| OSHA occupational safety — catalog only | 3 | Draft / Approved / Deprecated | Partial or no CQL |
| HEDIS wellness — fully evaluated | 4 | Active | Full CQL, runnable |
| CMS eCQM — fully evaluated | 2 | Active | Full CQL, runnable (CMS125v14, CMS122v14) |
| CMS eCQM catalog (2026 performance period) | 47 | Draft | Catalog entry only — CQL authoring pending |
| **Total** | **60** | | |

Outcome buckets (all measures): `COMPLIANT`, `DUE_SOON`, `OVERDUE`, `MISSING_DATA`, `EXCLUDED`.

---

## Category 1 — OSHA Occupational Safety (Full CQL)

These four measures have complete CQL libraries, are seeded as Active, and run against the synthetic employee dataset.

### 1.1 Annual Audiogram Completed
- Policy reference: OSHA 29 CFR 1910.95
  URL: https://www.ecfr.gov/current/title-29/section-1910.95
- CQL file: `backend-ts/measures/audiogram.cql`
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
- CQL file: `backend-ts/measures/hazwoper.cql`
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
- CQL file: `backend-ts/measures/tb_surveillance.cql`
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
- CQL file: `backend-ts/measures/flu_vaccine.cql`
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
- CQL file: `backend-ts/measures/hypertension.cql`
- Tags: `wellness`, `hypertension`, `cardiovascular`
- Compliance window: 365 days (DueSoon 336–365)

### 3.2 Diabetes HbA1c Monitoring
- Policy reference: HEDIS HBD / JPMC Wellness Rewards
- CQL file: `backend-ts/measures/diabetes_hba1c.cql`
- Tags: `wellness`, `diabetes`, `hba1c`
- Compliance window: 180 days biannual (DueSoon 161–180)

### 3.3 BMI Screening & Counseling
- Policy reference: HEDIS WCC / Cigna Healthcare Wellness
- CQL file: `backend-ts/measures/obesity_bmi.cql`
- Tags: `wellness`, `bmi`, `obesity`
- Compliance window: 365 days annual

### 3.4 Cholesterol LDL Screening
- Policy reference: HEDIS CBP / JPMC Wellness Rewards
- CQL file: `backend-ts/measures/cholesterol_ldl.cql`
- Tags: `wellness`, `cholesterol`, `cardiovascular`
- Compliance window: 365 days annual

All four wellness measures use the same outcome pattern:
- `EXCLUDED` when `Has Medical Exemption = true`
- `MISSING_DATA` when enrolled, not exempt, no qualifying lab/screening date
- `OVERDUE` when enrolled, not exempt, days since last event > compliance window
- `DUE_SOON` when enrolled, not exempt, days approaching window end
- `COMPLIANT` when enrolled, not exempt, days within window

---

## Category 3b — CMS eCQM (Full CQL)

Two CMS eCQM measures promoted from Draft catalog to Active with full CQL evaluation:

### 3b.1 Breast Cancer Screening (CMS125v14 / MIPS 112)
- Policy reference: CMS125v14
- CQL file: `backend-ts/measures/cms125.cql`
- Tags: `ecqm`, `cms`, `cancer-screening`, `preventive`
- Compliance window: 27 months (820 days — mammogram within the measurement period or 26 months prior)

Outcome mapping:
- `EXCLUDED` when bilateral mastectomy or documented clinical exclusion
- `MISSING_DATA` when enrolled, not excluded, no mammogram date found
- `OVERDUE` when enrolled, not excluded, days since last mammogram > 820
- `DUE_SOON` when enrolled, not excluded, days in (790..820]
- `COMPLIANT` when enrolled, not excluded, days <= 790

### 3b.2 Diabetes: Glycemic Status Assessment Greater Than 9% (CMS122v14 / MIPS 1)
- Policy reference: CMS122v14
- CQL file: `backend-ts/measures/cms122.cql`
- Tags: `ecqm`, `cms`, `diabetes`
- Value-based (numeric): outcome is driven by HbA1c lab value, not recency
- Catalog/display name follows the current CMS122v14 title ("Glycemic Status Assessment Greater Than 9%"); the CQL define is still named `HbA1c Poor Control`. This name is the exact key the evaluator binds CQL by (`forMeasure`), so it must match across the DB seed, `measures/cms122.yaml`, and `backend-ts`.

Outcome mapping:
- `EXCLUDED` when documented clinical exclusion
- `MISSING_DATA` when diabetes diagnosis, not excluded, no recent HbA1c result
- `OVERDUE` when diabetes diagnosis, not excluded, HbA1c value > 9% (poor control — intervention needed)
- `COMPLIANT` when diabetes diagnosis, not excluded, HbA1c value ≤ 9% (adequate control)
- `DUE_SOON` — not applicable (hard-coded false; control status drives outcome, not recency)

---

## Category 4 — CMS eCQM Catalog (2026 Performance Period)

47 official CMS electronic Clinical Quality Measures seeded as Draft v1.0 catalog entries (CMS125v14 and CMS122v14 are now Active with full CQL — see Category 3b). The `policy_ref` field stores the CMS eCQM ID (e.g., `CMS128v14`). The `spec_json` stores `cmsEcqmId` and `mipsQualityId` for downstream tooling. CQL authoring for the remaining catalog entries is future work.

The measures page renders CMS IDs as blue mono badges to distinguish them from OSHA CFR citations and HEDIS references.

Two new measures added in 2026 vs 2025: CMS146v14 (Appropriate Testing for Pharyngitis) and CMS154v14 (Appropriate Treatment for URI) in the new Respiratory / Antimicrobial Stewardship domain; CMS1173v1 (Diagnostic Delay of VTE) added to Cardiovascular; CMS1154v1 (Screening for Abnormal Glucose Metabolism) added to Diabetes. CMS249v7 (DXA Scans) retired from 2026 eligible clinician list.

### Domain breakdown

| Domain | Measures |
|--------|---------|
| Mental Health / Behavioral | CMS2v15, CMS128v14, CMS136v15, CMS137v14, CMS149v14, CMS159v14, CMS177v14 |
| Cardiovascular | CMS22v14, CMS90v15, CMS135v14, CMS144v14, CMS145v14, CMS165v14, CMS347v9, CMS1173v1 |
| Diabetes | CMS122v14, CMS131v14, CMS142v14, CMS951v4, CMS1154v1 |
| Cancer Screening / Preventive | CMS69v14, CMS124v14, CMS125v14, CMS130v14, CMS138v14, CMS139v14, CMS153v14, CMS155v14 |
| Respiratory / Antimicrobial Stewardship | CMS146v14, CMS154v14 |
| Pediatric / Immunization | CMS74v15, CMS75v14, CMS117v14 |
| HIV / Infectious Disease | CMS314v3, CMS349v8, CMS1157v2, CMS1188v3 |
| Oncology | CMS129v15, CMS157v14, CMS645v9, CMS646v6 |
| Ophthalmology | CMS133v14, CMS143v14 |
| Functional Status / Orthopedic | CMS56v14 |
| Medication Safety | CMS68v15, CMS156v14 |
| Care Coordination | CMS50v14 |
| Urology | CMS771v7 |
| Radiology / Patient Safety | CMS1056v3 |

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

- All 8 active CQL measures now use inline code-filter expressions on both the qualifying event (Procedure or Immunization) and the enrollment/exemption Conditions, matching the system/code stamped by `SyntheticFhirBundleBuilder`. This replaces the earlier `exists([Condition])` / `Count([Condition]) > 1` pattern that was semantically correct but not code-scoped. True ValueSet token expansion (resolving `urn:workwell:vs:*` OIDs via the VSAC or a local expansion service) is a known evaluator limitation of the in-memory CQF path; the inline-code pattern is the stable workaround until a resolver is wired.
- All four HEDIS wellness measures are seeded via `ensureInstanceSeeds()` when `WORKWELL_INSTANCE=ecqm` or `twh`.
- All 49 CMS eCQM catalog entries (2026 performance period) are seeded via `ensureCmsEcqmCatalogSeed()` for the same instance values. They are Draft-only and do not participate in CQL evaluation runs until CQL is authored and compiled. On re-seed, existing measures are looked up by CMS ID prefix (`LIKE 'CMSNNNv%'`) and updated in-place so version bumps (e.g., v13→v14) do not create duplicate DB rows.
