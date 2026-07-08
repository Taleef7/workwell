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
3-dose). This is computed by the `ImmunizationForecast` port (simulated default; ICE-ready; ADR-012)
and is **advisory only** — it never affects the CQL `Outcome Status`.

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

> **Known simplification (Fable L15):** the `Has Recent HbA1c Result` define does **not** yet apply a
> recency window, so an old HbA1c can read COMPLIANT. This is the documented **SIMPLIFIED** criterion in
> the E14 CMS122 fidelity report (a true measurement-period window needs the VSAC-backed value-set
> resolver, blocked on credentials); the define/label keep the "recent" name pending that wiring.

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
  `outcomes` with a proportion population model whose counts reconcile 1:1 with the run's outcomes
  (#89 / E3.1). Value-set expansion + QRDA are separate E3 items (#90/#91).
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
