# WorkWell Measure Catalog

WorkWell Measure Studio implements the **Total Worker Health (TWH)** model: OSHA occupational safety compliance and clinical quality / wellness measures managed in a single platform. The TWH instance seeds all three categories on startup.

## Catalog summary

| Category | Count | Status | CQL |
|----------|-------|--------|-----|
| OSHA occupational safety — fully evaluated | 4 | Active | Full CQL, runnable |
| OSHA occupational safety — catalog only | 2 | Draft / Deprecated | Partial or no CQL |
| HEDIS wellness — fully evaluated | 5 | Active | Full CQL, runnable |
| Permanent immunization panel — fully evaluated | 3 | Active | Full CQL, runnable (series-completion; MMR, Varicella, Hep B) |
| CMS eCQM — fully evaluated | 2 | Active | Full CQL, runnable (CMS125v14, CMS122v14) |
| CMS eCQM catalog (2026 performance period) | 47 | Draft | Catalog entry only — CQL authoring pending |
| **Total** | **63** | | |

Runnable (full CQL): **14** — 4 OSHA + 5 HEDIS + 3 immunization panel + 2 CMS eCQM. Hepatitis B was promoted from an Approved catalog entry to Active (E10.6).

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
- `DUE_SOON` when eligible, not exempt, not vaccinated this season, last vaccine ≤ 365 days ago
- `OVERDUE` when eligible, not exempt, not vaccinated this season, last vaccine > 365 days ago
- `MISSING_DATA` when eligible, not exempt, no flu vaccine record on file

<!-- Fable L16 doc-currency fix (2026-07-03): `flu_vaccine.cql` has a real `Overdue` branch
(`Days Since Last Flu Vaccine > 365`); the earlier "OVERDUE is hard-coded false" note was stale. -->


---

## Category 2 — OSHA Occupational Safety (Catalog Only)

These two measures are seeded for catalog richness and demonstrate the full measure lifecycle (Draft → Approved → Deprecated). They have no runnable CQL evaluation. (Hepatitis B Vaccination Series was promoted to a runnable Active measure in E10.6 and is now a multi-alternative series — see Category 3c.)

| Name | Policy Ref | Status | Tags |
|------|-----------|--------|------|
| Respirator Fit Test | OSHA 29 CFR 1910.134 | Draft v0.9 | surveillance, respiratory, osha |
| Lead Medical Surveillance | OSHA 29 CFR 1910.1025 | Deprecated v1.1 | surveillance, lead, osha |

---

## Category 3 — HEDIS Wellness (Full CQL)

Five employer wellness / HEDIS-style measures with complete CQL and active evaluation. These represent the wellness side of TWH — chronic disease management, preventive health screening, and adult immunization programs run by occupational health departments.

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

The four chronic-disease/screening measures above use the same outcome pattern:
- `EXCLUDED` when `Has Medical Exemption = true`
- `MISSING_DATA` when enrolled, not exempt, no qualifying lab/screening date
- `OVERDUE` when enrolled, not exempt, days since last event > compliance window
- `DUE_SOON` when enrolled, not exempt, days approaching window end
- `COMPLIANT` when enrolled, not exempt, days within window

### 3.5 Adult Immunization Status — Td/Tdap (AIS-E)
- Policy reference: NCQA HEDIS AIS-E (Adult Immunization Status — Employer)
  URL: https://www.ncqa.org/report-cards/health-plans/state-of-health-care-quality-report/adult-immunization-status-ais-e/
  Clinical criteria: HEDIS MY2025 Adult Measures Clinical Guide (AIS-E), https://www.alliancehealthplan.org/document-library/Adult-Measures-Practitioner-Clinical-Guide-for-HEDIS-MY2025.pdf
  (CMS127 v11 was considered and rejected — age 65+/ever-never design, not a good forecasting fit:
   https://ecqi.healthit.gov/ecqm/ec/2023/cms0127v11)
- CQL file: `backend-ts/measures/adult_immunization.cql`
- Tags: `wellness`, `immunization`, `tdap`, `hedis`, `ais-e`
- Compliance window: 10 years / 3650 days (DueSoon 3591–3650 days)

#### Define logic
- Program eligibility: `In Immunization Program`
- Exemption: `Has Td/Tdap Contraindication` (clinical contraindication Condition)
- Refusal: `Refused Td/Tdap` (documented `tdap-refusal` Condition — does NOT exclude; case stays open)
- Recency: `Most Recent Td/Tdap Date`
- Aging metric: `Days Since Last Td/Tdap`

#### Outcome mapping
- `EXCLUDED` when `Has Td/Tdap Contraindication = true`
- `MISSING_DATA` when enrolled, not contraindicated, no Td/Tdap record on file
- `OVERDUE` when enrolled, not contraindicated, days since last dose > 3650 (>10 years)
- `DUE_SOON` when enrolled, not contraindicated, days in (3590..3650]
- `COMPLIANT` when enrolled, not contraindicated, days <= 3590

Refusal: a `Refused` define in evidence_json flags the refusal; the case stays OPEN and is routed
to a case manager for intervention. Refusal does not trigger an EXCLUDED outcome.

**Advisory immunization forecast:** for `adult_immunization` cases, `GET /api/cases/:id` attaches
an advisory `immunizationForecast` covering all 3 ACIP series (Td/Tdap, Influenza annual, Hepatitis B
3-dose). It is computed by the `ImmunizationForecast` port and is **advisory only** — it never affects
the CQL `Outcome Status` (ADR-012).

The port has two implementations (ADR-029, 2026-07-13): the **simulated** forecaster (the default —
ACIP-style windows over its own deterministic synthetic dose history) and a **real** adapter against a
self-hosted **ICE** sidecar (HLN's ACIP-maintained Immunization Calculation Engine), selected by
`WORKWELL_IMMZ_ICE_BASE_URL` alone and falling back whole to the simulated forecaster on any failure.
When ICE is on, the forecast carries ICE's own recommendation and reason codes (e.g.
`ICE RECOMMENDED (DUE_NOW, ADMINISTER_TDAP_OR_TD)`).

**ICE and a WorkWell measure can legitimately disagree, and that is not a defect.** ICE scores the
full ACIP schedule for a vaccine *group*; a WorkWell measure scores its own authored rule. A subject
with 2 Hep B doses reads COMPLIANT under `hepatitis_b_vaccination_series` if those doses complete the
Heplisav-B alternative, while ICE — told the doses are a traditional adult formulation — will
correctly propose dose 3. The CQL `Outcome Status` remains the sole compliance authority
(ADR-008/ADR-012); the ICE forecast is clinical advice sitting beside it, not a second verdict.

---

## Category 3c — Permanent Immunization Panel (series-completion CQL)

These three measures introduce the **PERMANENT** compliance class (E10.1 / E10.6): compliance is proven
by a completed **dose series**, not recency — once the series is on file the employee stays COMPLIANT
indefinitely ("once compliant, always compliant"). This contrasts with every other measure, which is
**RECURRING** (windowed days-since-last with DUE_SOON/OVERDUE). The class is declared as `complianceClass`
in each measure's YAML binding (default `RECURRING`); it is descriptive/routing metadata only — the CQL
`Outcome Status` remains the sole compliance authority (ADR-008). These are the repo's first
series-completion CQL measures (`Count("Valid Doses") >= N`, no recency filter).

| Measure | id | Series | COMPLIANT when | Excludes |
|---------|----|--------|----------------|----------|
| MMR Immunity | `mmr` | 2 doses (CVX 03/94) | ≥ 2 valid MMR doses on file | contraindication |
| Varicella Immunity | `varicella` | 2 doses (CVX 21) | ≥ 2 valid varicella doses on file | contraindication |
| Hepatitis B Vaccination Series | `hepatitis_b_vaccination_series` | **multi-alternative** (E11.2c): Heplisav-B 2 doses (CVX 189, ≥28d apart) **OR** traditional 3 doses (CVX 08/43/44/45, ACIP min intervals 28/56d) | either alternative series complete | contraindication |

Outcome mapping (MMR / Varicella):
- `EXCLUDED` when a documented contraindication Condition is present
- `COMPLIANT` when enrolled, not contraindicated, and `Dose Count >= 2` (regardless of dose age)
- `MISSING_DATA` otherwise — including a **partial** series (`0 < Dose Count < 2`), surfaced by the roster
  read model as **IN_PROGRESS** (E10.5)
- `DUE_SOON` / `OVERDUE` are **not applicable** to PERMANENT measures

**Hepatitis B (multi-alternative, E11.2c / #183):** COMPLIANT requires a **complete alternative series** —
`"Heplisav-B Complete"` (2 doses CVX 189 ≥28 days apart) **OR** `"Traditional Complete"` (3 doses CVX
08/43/44/45 with consecutive gaps ≥28 and ≥56 days). A union `"Dose Count"` define (any Hep B CVX) is kept
for the roster's method string only — so a mid-**traditional-3** series shows the approximate "1 of 2 doses
on file" (the IN_PROGRESS denominator uses the top-level `series.requiredDoses` 2; the canonical bucket is
CQL-authoritative). `EXCLUDED`/`MISSING_DATA`/refusal behave as the other two. The codegen capability is
E11.2c (ADR-015); this repoint is additive seed/app data with **no schema change**.

A documented **refusal** (declination) Condition does not change the canonical bucket; it is surfaced
as **DECLINED** by the roster read model (E10.5) and keeps the case open (same pattern as `adult_immunization`).
**Titer-proves-immunity** ("Allow positive titer") for Hep B remains deferred.

---

## Category 3b — CMS eCQM (Full CQL)

Two CMS eCQM measures promoted from Draft catalog to Active with full CQL evaluation:

### 3b.1 Breast Cancer Screening (CMS125v14 / MIPS 112)
- Policy reference: **CMS125v14** (2026 eCQI; v15/2027 annual roll-forward — stay on v14 for 2026)
- CQL file: `backend-ts/measures/cms125.cql` (v2.0.0 production faithful-subset)
- Tags: `ecqm`, `cms`, `cancer-screening`, `preventive`
- Measurement period: **12 months** (`periodMonths: 12`)
- **Fidelity:** structural report at `GET /api/measures/cms125/fidelity`

Official criteria (CMS125-v14.0.000-QDM): women **42-74** + visit during MP; mammogram on/between **Oct 1 two years prior to MP** and end of MP (VSAC Mammography); DENEX hospice / mastectomy / palliative (66+ LTC + frailty/AI = Phase 2 residual).

Outcome mapping (higher is better):
- `EXCLUDED` — DENEX (mastectomy / hospice / palliative)
- `COMPLIANT` — in IPP with qualifying mammogram
- `OVERDUE` — in IPP without qualifying mammogram
- `MISSING_DATA` — not in IPP
- `DUE_SOON` — not used (cleaner eCQI proportion story)

### 3b.2 Diabetes: Glycemic Status Assessment Greater Than 9% (CMS122v14 / MIPS 1)
- Policy reference: **CMS122v14** (2026 eCQI; stay on v14)
- CQL file: `backend-ts/measures/cms122.cql` (v2.0.0 production faithful-subset)
- Tags: `ecqm`, `cms`, `diabetes`
- Measurement period: **12 months**
- Catalog/display name matches eCQI title; library `DiabetesHbA1cPoorControlCQL-2.0.0`
- **Fidelity:** structural + estimate + subset + literal fqm (`GET /api/measures/cms122/fidelity` + `/diff`)

Official criteria (CMS122-v14.0.000-QDM): age **18-75** + diabetes + visit; NUMER most recent **HbA1c or GMI (LOINC 97506-0)** in MP > 9% or missing/not performed; DENEX hospice + palliative (66+ LTC + frailty/AI = Phase 2).

Outcome mapping (lower-is-better eCQM rate; NUMER maps to OVERDUE):
- `EXCLUDED` — DENEX
- `OVERDUE` — in IPP and numerator (poor control or missing assessment)
- `COMPLIANT` — in IPP with glycemic assessment <= 9%
- `MISSING_DATA` — not in IPP

### eCQM accuracy posture (vs eCQI — read this before claiming parity)

**Short answer (2026-07 production-faithful promotion):** the two runnable CMS measures are **eCQI-aligned faithful subsets** for 2026 (v14). They are still not full multi-library QICore MAT packages for MIPS submission.

| What we ship | Count | Relationship to eCQI | How we prove it |
|---|---|---|---|
| **Runnable Active CMS CQL** | **2** — CMS122v14, CMS125v14 | Faithful official-subset production CQL: 12-month MP, age/sex/visit, VSAC OIDs, GMI, Oct-1 mammogram window, hospice/palliative/mastectomy. Residual Phase 2: 66+ LTC + frailty/AI. Dual-coded synthetic data. | Structural fidelity both; CMS122 also estimate + subset + literal fqm |
| **Draft CMS catalog entries** | **47** | Metadata only — correct CMS ID, **v14 = 2026**, MIPS ID, title | Terminology audit 2026-07-08 |
| **OSHA / HEDIS / permanent vax** | 12 | Not CMS eCQMs | Separate authorities |

**Demo claim that is honest:**

> We evaluate CMS122v14 and CMS125v14 — the 2026 eCQI Eligible Clinician measures (MIPS 001 / 112) — with production CQL aligned to official population criteria. We can show structural fidelity (and for CMS122, a literal official package comparison). We do not claim full MAT multi-library submission packages or 2027 v15 until we cut over.

**Remaining accuracy work:** Phase 2 DENEX (LTC/frailty); optional CMS125 literal ELM; annual roll-forward to v15/2027 when product targets that year.

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

- **CQL→SQL (WCDB) demo translations (#292 / ADR-034, 2026-07-20 — descriptive only, ADR-008).**
  Four observation-backed windowed-recency measures (`hypertension`, `cholesterol_ldl`,
  `obesity_bmi`, `diabetes_hba1c`) also have **generated MariaDB SQL** against the WebChart dev-DB
  schema: `pnpm generate:sql` (`engine/cql/codegen/generate-sql-cli.ts`) templates the same rule
  params that compile to CQL (plus the crosswalk's LOINC sets, `loincCodesForMeasure`) into
  parameterized per-patient / single-patient / cohort statements, committed under
  `wcdb-fhir-shim/sql/` (freshness-tested) and executed only by the standalone shim's compliance
  API. **CQL remains the sole `Outcome Status` authority** — the SQL is parity-gated per ADR-025
  (the CQL engine over the shim's FHIR output is the oracle; cohort counts verified equal
  2026-07-20) and serves nothing in the product. Series-completion SQL is deliberately absent
  (WCDB has no immunization table to prove parity against).
- **Live WebChart enrollment and groups (ADR-033).** When the live tenant seam is configured,
  `WORKWELL_WEBCHART_ENROLLMENT_JSON` may map raw Patient ids to explicitly enrolled measure ids.
  Otherwise the safe demo default enrolls every live subject in every `ROSTER_ELIGIBLE_MEASURES`
  member. Enrollment only supplies occupational-health context: each measure's CQL age, sex,
  diagnosis, visit, exclusion, and clinical-data gates remain authoritative, and CQL alone sets
  `Outcome Status`. The demo-segment baseline (**All Employees**) now covers the fixed live site
  `WebChart` out of the box (`WEBCHART_LIVE_SITE`, folded into the seed's site list), so on any
  **fresh** DB (a local demo, a new instance) WebChart subjects are applicable and the `/compliance`
  roster shows their real per-measure chips immediately — no manual admin step. (An **already-seeded**
  DB predating this change keeps its old baseline row, since seeding is name-idempotent and never
  auto-mutates an operator's segment; the owner-gated repair — edit **All Employees** at
  `/admin → Groups`, add site **WebChart**, save, recording an audited `SEGMENT_UPDATED` — still
  applies there, and the live Neon stack leaves the seam off regardless.) Cases are still not created
  for `wc|` subjects by default and rerun-to-verify on any resulting `wc|` case returns a non-mutating
  409 until fetch-one-patient lands.

- **Terminology & standards currency (2026 audit, 2026-07-08 — `docs/TERMINOLOGY_AUDIT_2026-07-08.md`).** A three-way verification (our implementation vs MIE's WebChart dev DB vs the current 2026 authorities — CMS eCQI, CDC CVX, LOINC, VSAC, AMA CPT, eCFR) confirmed everything load-bearing is correct and current: all 49 CMS catalog versions/MIPS IDs (**v14 = 2026** confirmed), all OSHA CFR citations, and all runnable LOINC/CPT codes. The one defect class — **vaccine CVX currency** on the WebChart crosswalk — was fixed: influenza matching expanded from `141`/`140`-only to the full active seasonal CVX set (VSAC "Influenza Vaccine" OID `2.16.840.1.113883.3.526.3.1254`); the **inactive** Td code `139` supplemented with active `09`/`113`/`196`; MMRV `94` now counts toward varicella; deleted HCPCS `G0202` marked read-only. All fixes are additive to the WebChart read path (`engine/ingress/webchart/terminology.ts`) — **synthetic outcomes are unchanged** (the synthetic CQL matches `urn:workwell:*` codes, not CVX numbers). Inactive codes are matched on read for legacy records, never emitted. Durable follow-up: resolve flu membership from the VSAC value set via the ADR-023 resolver rather than the hardcoded active list.
- All active CQL measures now use inline code-filter expressions on both the qualifying event (Procedure or Immunization) and the enrollment/exemption Conditions, matching the system/code stamped by `SyntheticFhirBundleBuilder`. This replaces the earlier `exists([Condition])` / `Count([Condition]) > 1` pattern that was semantically correct but not code-scoped. **HAZWOPER (`hazwoper.cql`) and TB Screening (`tb_surveillance.cql`) were the last two still on the un-scoped pattern; the Fable H3 hardening fix (2026-07-03) brought them into line** — a patient with unrelated Conditions no longer false-positives as enrolled/exempt on the arbitrary-bundle path (`evaluateBundle`/`pnpm evaluate`), where the synthetic per-measure bundles had masked it. A `foreign-condition-scoping.test.ts` golden regression guards it; the ELM was recompiled (`pnpm compile-measures`); synthetic outcomes are unchanged. True ValueSet token expansion (resolving `urn:workwell:vs:*` OIDs via the VSAC or a local expansion service) is a known evaluator limitation of the in-memory CQF path; the inline-code pattern is the stable workaround until a resolver is wired.
  **(E3.2 / #90 update)** A `ValueSetResolver` seam now supports real value-set expansion: the engine
  can run in an expansion mode (an optional resolver → a populated `cql.CodeService`) where a CQL
  value-set retrieve (`[Procedure: "Audiogram Procedures"]`) filters by real membership. Audiogram
  ships a value-set-retrieve ELM variant proven byte-equal to the inline path (cross-mode golden
  parity); the inline path remains the default.
  **(ADR-023 update, 2026-07-05)** The **live VSAC (NLM UMLS) adapter is now real behind the port**,
  superseding the "future drop-in" language above: a `CompositeValueSetResolver` routes dotted-numeric
  VSAC OIDs → a live `VsacValueSetResolver` (`GET {base}/ValueSet/{oid}/$expand`) and `urn:workwell:*`
  references → the local store, selected only when `WORKWELL_VSAC_API_KEY` is set (inert-unless-configured;
  `engineForEnv` is key-gated so the unkeyed path is byte-identical to today). The owner-run
  `pnpm resolve-valuesets` CLI imports official VSAC expansions into `value_sets` (`source="VSAC"`, no
  DDL; DEPLOY.md). **Descriptive only (ADR-008)** — expansion feeds the `CodeService`, never `Outcome
  Status` (guarded by the audiogram cross-mode VSAC parity test).
  **(E14 PR-3, 2026-07-05 — SHIPPED)** `GET /api/measures/cms122/fidelity/diff` now runs a **real,
  subject-by-subject execution outcome diff** for CMS122: for each subject in the latest cms122
  population run it builds the synthetic bundle, additively enriches it with real VSAC-member codes,
  evaluates **both** WorkWell's authored `cms122` **and** an official-subset CMS122 measure fresh, and
  diffs — attributing each divergence to the first differing official gate (age 18–75 / qualifying visit
  / diabetes diagnosis / hospice / palliative / HbA1c-missing / WorkWell-side exclusion). It resolves the
  imported VSAC `value_sets` (`source="VSAC"`) rows from the store, so **no runtime VSAC key is needed**
  (the key was only for the one-time `pnpm resolve-valuesets` import); when those rows are absent (e.g.
  local/dev), the route degrades to the unchanged PR-2 criteria-impact **estimate**.
  The official measure is a **faithful official-SUBSET** — `measures/cms122_official.cql`,
  `using FHIR '4.0.1'` in the proven value-set-retrieve style, driven by the VSAC OID value sets and
  compiled to committed ELM (`DiabetesHbA1cPoorControlOfficialCQL-1.0.0`) — **not** the literal
  multi-library QICore artifact. A **compile-feasibility spike (2026-07-05)** proved the literal CMS122v14
  QICore CQL is un-compilable under the pinned JVM-free translator `@cqframework/cql` 4.0.0-beta.1 (its
  modelinfo loader can't resolve the cross-model `FHIR.*`/`USCore.*` type refs, so the whole QICore model
  fails to load) and that the runtime engine links no multi-library include graph; the literal path is to
  be revisited when the translator ships a stable multi-model release. The diff is **descriptive only
  (ADR-008)** — it writes nothing and never sets an `Outcome Status`; WorkWell's cms122 outcomes stay
  byte-identical (the enrichment is harness-local — it appends codings to a copy for the diff harness, it
  is not a change to the live `fhir-bundle-builder`). The **GMI numerator alternative is now modeled**
  in the official-subset CQL (2026-07-05): the numerator takes the most recent of an HbA1c (VSAC HbA1c
  Laboratory Test set) **OR** a Glucose Management Indicator (GMI, LOINC 97506-0) within the period, so a
  newer GMI supersedes an older HbA1c. GMI uses a direct LOINC-97506-0 code filter (the synthetic corpus
  ships no GMI value set, so no VSAC OID is invented) — the remaining simplification for that criterion is
  terminology-only (this code filter vs the official combined "Glycemic Status Assessment" VSAC set), and
  WorkWell's own **authored** cms122 still models neither GMI nor a recency window (see Fable L15 above).
  The diff is **CMS122-only**.
  **(#258, 2026-07-09 — LITERAL tier SHIPPED; supersedes ADR-024's "revisit on a stable translator"
  clause — ADR-026)** The fidelity diff now has a **three-tier ladder** — `literal → subset → estimate` —
  surfaced by an additive `mode` field in the response. The **literal** tier executes the *actual official
  multi-library QICore CMS122v14 artifact* (MADiE FHIR export `CMS122FHIRDiabetesAssessGreaterThan9Percent`
  v0.5.000, `using QICore '6.0.0'`, 8 included libraries — the exact CQL ADR-024 proved un-compilable under
  the pinned JS translator) via MITRE's **`fqm-execution`** over the **pre-compiled ELM** shipped inside the
  bundle's `Library.content` (`application/elm+json`) — **no translation happens**. The bundle is vendored
  with provenance under `backend-ts/measures/official/cms122v14/`; value sets are supplied from the imported
  VSAC `value_sets` rows via a `valueSetCache` (no runtime VSAC key). `fqm-execution` is a **diagnostic-only**
  dependency — imported solely by `standards/literal-diff.ts`, never the run pipeline / ingress / worker
  (arch-tested by `fqm-isolation.test.ts`). Per-subject population membership (IPP/DENEX/NUMER) maps to the
  outcome vocabulary with population-level gate attribution; a harness-local `stampQiCoreStructure`
  normalizes the synthetic Conditions to QICore active/confirmed + in-past onset (fields WorkWell's cms122
  ignores — its outcomes stay byte-identical, ADR-008 guard test). The subset tier remains the fallback when
  the vendored bundle is absent or the literal execution fails at runtime; the estimate remains the floor.
- All five HEDIS wellness measures (including `adult_immunization`) are seeded via `ensureInstanceSeeds()` when `WORKWELL_INSTANCE=ecqm` or `twh`.
- The synthetic FHIR bundles declare QI-Core conformance: each resource carries a QI-Core `meta.profile`
  canonical + the required structural elements (#92 / E3.4). Structural alignment (JVM-free), not
  IG/validator-validated — `meta.profile` is metadata, so evaluation outcomes are unchanged. See
  `docs/STANDARDS_CONFORMANCE.md`.
- All 49 CMS eCQM catalog entries (2026 performance period) are seeded via `ensureCmsEcqmCatalogSeed()` for the same instance values. They are Draft-only and do not participate in CQL evaluation runs until CQL is authored and compiled. On re-seed, existing measures are looked up by CMS ID prefix (`LIKE 'CMSNNNv%'`) and updated in-place so version bumps (e.g., v13→v14) do not create duplicate DB rows.
- A headless CLI (`pnpm evaluate --patient <bundle.json> --measure <id>`, `backend-ts/src/engine/cli/`)
  evaluates one FHIR R4 patient bundle against a measure with no server or DB — the same
  `CqlExecutionEngine` the run pipeline uses. Golden regression over `backend-ts/spike/synthetic`
  asserts outcomes for all 11 measures × 4 scenarios (#72 / E2, updated for E6).
  - **E12 PR-1 (#184):** the same DB-less evaluation is also a **library** entry —
    `evaluateBundle(bundle, measureId)` (single JSON/FHIR object) + `evaluateBatch(bundles, measureId)`
    (a "bucket", per-item error isolation), from `backend-ts/src/engine/ingress`. A `PatientDataSource`
    port + `resolveDataSource(env)` make the ingress pluggable (JSON default; WebChart adapter is an
    inert stub until E12 PR-2). FHIR-native-first — adapters feed the unchanged engine (ADR-017).
- **Immunization forecasting (E6 / #76):** `GET /api/immunization/forecast?subjectId=&asOf=` returns an
  advisory `ImmunizationForecast` (Td/Tdap, Influenza, Hepatitis B next-dose-due) computed by the
  `ImmunizationForecast` port (`backend-ts/src/engine/immunization/immunization-forecast.ts`). The
  simulated forecaster is the default; an ICE adapter can be activated by setting
  `WORKWELL_IMMZ_ICE_API_KEY` + `WORKWELL_IMMZ_ICE_BASE_URL` (inert stub until configured). The
  forecast is **advisory only** — the CQL `Outcome Status` remains the sole compliance authority (ADR-012).
- A completed single-measure run can be exported as a FHIR R4 `MeasureReport` (summary + per-subject
  individual + a collection Bundle) via `GET /api/runs/{runId}/measure-report` — built from persisted
  `outcomes` with a proportion population model whose individual membership labels reconcile 1:1 with
  the summary (#89 / E3.1; ADR-031). Reported DENOM includes DENEX membership; the score is
  `NUMER / (DENOM - DENEX)`. For `cms122`/`cms125` only, binding metadata maps `MISSING_DATA` to
  out-of-population because their authored CQL uses that status for `not Initial Population`; OSHA and
  HEDIS-style measures keep it in IPP/DENOM. Value-set expansion + QRDA are separate E3 items (#90/#91).
- A completed single-measure run can be exported as an HL7 QRDA Category III aggregate stub via
  `GET /api/runs/{runId}/qrda?format=xml` — well-formed CDA carrying the aggregate population counts +
  performance rate (reuses the MeasureReport `countPopulations`); a stub, not IG-validated (#91 / E3.3).
  See `docs/STANDARDS_CONFORMANCE.md`.
- **E7 action-evaluator order map (#77):** each runnable measure has a corresponding proposed order
  code in `backend-ts/src/order/order-catalog.ts`. Codes reuse the `terminology_mappings` seed
  standards where present: audiogram → CPT 92557; tb_surveillance → CPT 86580; flu_vaccine → CVX 141;
  hazwoper → `hazwoper-exam` in `urn:workwell:vs:hazwoper-exams`. Measures without a seed mapping
  (e.g., BMI screening, hypertension, cholesterol, CMS eCQMs) use LOCAL `urn:workwell:orders` codes
  pending standard terminology alignment. `GET /api/orders/proposals` returns `ProposedOrder` records
  (or FHIR R4 `ServiceRequest` bundles) for at-risk subjects; proposals are advisory only.
