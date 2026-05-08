# WorkWell Demo Measures and CQL-to-Outcome Mapping

This document defines the four MVP measures and maps their CQL define logic to final outcome buckets.

Current implementation status:
- All four measures are seeded and runnable.
- Evaluation writes define-level evidence (`expressionResults`) and computed `Outcome Status`.
- Outcome buckets: `COMPLIANT`, `DUE_SOON`, `OVERDUE`, `MISSING_DATA`, `EXCLUDED`.
- TB and HAZWOPER recency checks use explicit procedure-code filtering in CQL so the seeded in-memory CQF evaluator can resolve the most recent exam date without relying on unsupported value-set token retrieval.

## 1) Annual Audiogram Completed
- Policy reference: OSHA 29 CFR 1910.95
  URL: https://www.ecfr.gov/current/title-29/section-1910.95
- CQL file: `backend/src/main/resources/measures/audiogram.cql`

### Define logic summary
- Program eligibility: `In Hearing Conservation Program`
- Exemption: `Has Active Waiver`
- Recency: `Most Recent Audiogram Date`
- Aging metric: `Days Since Last Audiogram`

### Outcome mapping
- `EXCLUDED` when `Has Active Waiver = true`
- `MISSING_DATA` when enrolled, not waived, and no recent date
- `OVERDUE` when enrolled, not waived, and days since exam > 365
- `DUE_SOON` when enrolled, not waived, and days in (336..365)
- `COMPLIANT` when enrolled, not waived, and days <= 335

## 2) HAZWOPER Annual Medical Surveillance
- Policy reference: OSHA 29 CFR 1910.120
  URL: https://www.ecfr.gov/current/title-29/section-1910.120
- CQL file: `backend/src/main/resources/measures/hazwoper.cql`

### Define logic summary
- Program eligibility: `In HAZWOPER Program`
- Exemption: `Has Medical Exemption`
- Recency: `Most Recent Surveillance Exam Date`
- Aging metric: `Days Since Last Exam`

### Outcome mapping
- `EXCLUDED` when `Has Medical Exemption = true`
- `MISSING_DATA` when in program, not exempt, and no exam date
- `OVERDUE` when in program, not exempt, and days since exam > 365
- `DUE_SOON` when in program, not exempt, and days in (335..365]
- `COMPLIANT` when in program, not exempt, and days <= 335

## 3) Annual TB Screening
- Policy reference: CDC TB screening guidance + organizational policy
  URL: https://www.cdc.gov/tb/topic/testing/healthcareworkers.htm
- CQL file: `backend/src/main/resources/measures/tb_surveillance.cql`

### Define logic summary
- Program eligibility: `In TB Screening Program`
- Exemption: `Has Medical Exemption`
- Recency: `Most Recent TB Screen Date`
- Aging metric: `Days Since Last TB Screen`

### Outcome mapping
- `EXCLUDED` when `Has Medical Exemption = true`
- `MISSING_DATA` when eligible, not exempt, and no TB screen date
- `OVERDUE` when eligible, not exempt, and days since last screen > 365
- `DUE_SOON` when eligible, not exempt, and days in (330..365]
- `COMPLIANT` when eligible, not exempt, and days <= 330

## 4) Flu Vaccine This Season
- Policy reference: Organizational seasonal policy informed by CDC guidance
  URL: https://www.cdc.gov/flu/professionals/vaccination/
- CQL file: `backend/src/main/resources/measures/flu_vaccine.cql`

### Define logic summary
- Program eligibility: `Clinical Facing Employee`
- Exemption: `Has Valid Exemption`
- Season completion: `Flu Vaccine This Season`

### Outcome mapping
- `EXCLUDED` when `Has Valid Exemption = true`
- `COMPLIANT` when eligible, not exempt, and vaccinated this season
- `MISSING_DATA` when eligible, not exempt, and not vaccinated this season
- `DUE_SOON` may be true at define level, but final `Outcome Status` currently resolves to `MISSING_DATA` for non-compliant non-exempt rows.
- `OVERDUE` is hard-coded false in current CQL.

## 5) Canonical Status Source
For all measures, the canonical stored status is the value of CQL define `Outcome Status`.

Persistence path:
1. CQL engine evaluates all defines.
2. `Outcome Status` string is read from expression results.
3. Status is persisted in `outcomes.status`.
4. Full define-level results are persisted in `outcomes.evidence_json.expressionResults`.

## 6) Evidence Traceability Expectations
Each outcome evidence payload should include:
- Key eligibility/exemption/recency defines for the measure.
- Computed day-difference define where applicable.
- `Outcome Status` define result.

This supports deterministic replay in case detail (`Why Flagged`) and downstream audit/export flows.
