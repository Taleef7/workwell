# HL7 Connectathon Research — Findings & Action Plan

**Date:** 2026-07-15
**Source material:** CMS Connectathon 7 (July 14–16, 2026, virtual) — "FHIR Quality Reporting with DEQM" track (lead: Bryn Rhodes, Smile Digital Health). Four PPTX decks, 20 screenshots, `links.md`, plus follow-up web research on every referenced repo/IG (8 parallel research agents + owner-side source verification of every code-level claim).

**TL;DR:** This track's focus measures are literally our two runnable eCQMs (CMS122, CMS125), and the ecosystem publishes **free official MADiE-authored test cases with expected results** (55 for CMS122, 66 for CMS125) — the first external ground truth WorkWell can run against. The research also surfaced **two verified conformance defects in our FHIR MeasureReport export**, a **reproducibility gap in our VSAC import**, and one important discovery: our vendored CMS122 literal bundle is a **stale draft (v0.5.000)** vs the ecosystem's test-validated **v1.0.000**. Nothing found invalidates our measure outcomes themselves — every defect is confined to the export/reporting/import layer.

---

## 1. What the track is

- **Track:** FHIR Quality Reporting with DEQM (Confluence 453908529), part of CMS 2026-07 FHIR Connectathon 7 (453905739). Zulip: `chat.fhir.org` stream `#179220-cql`.
- **Specs exercised:** DEQM IG (2026May ballot, `hl7.org/fhir/uv/deqm`), Quality Measure IG (`hl7.org/fhir/uv/cqm` + published US `cqfmeasures`), CQL IG (`$cql` operation), US Core 6.1.0 / US Quality Core 0.5.0, CRMI terminology manifests.
- **Scenario measure set (narrowed in planning):** **CMS122**, CMS124, **CMS125**, CMS165, CMS71, CMS1028.
- **Participants:** Bellese, CMS, Lantana, Smile Digital Health, Leavitt Partners. All test servers open + synthetic (Alphora `cloud.alphora.com/sandbox/r4/cqm/fhir/`, Bellese, Lantana, c3ib Flame incl. a **DEQM Inferno test kit** at `flame-demo.c3ib.org/deqm-test-kit`).
- **Headline result presented:** 74 measures × 3,964 MADiE test cases compared **Java engine vs JavaScript engine** — 98.16% pass, only 3 measures with discrepancies (UKG presentation; harness at `github.com/SeenaFa/dqm-content-qicore-2025`, branch `uscdi-measure-testing`).

## 2. The five opportunities (ranked)

### 2.1 Official test cases for CMS122/CMS125 ★ highest value

`github.com/cqframework/dqm-content-qicore-2025` = the 2025 Annual Update dQMs = **2026 performance period, the SAME annual update as our v14 artifacts** (verified: test MeasureReports use period 2026-01-01→2026-12-31).

- Test cases at `input/tests/measure/{MeasureName}/{patient-uuid}/` — loose QICore FHIR R4 JSON resources per patient **plus one expected `MeasureReport`** (profile `test-case-cqfm`, per-population counts 0/1 + measureScore). `.madie` manifest gives human names/series (IPPass, NUMPass, DENEXFail…).
- **CMS122FHIRDiabetesAssessGT9Pct: 55 cases · CMS125FHIRBreastCancerScreen: 66 cases.**
- Full measure bundles (Measure + libraries with ELM + value sets w/ expansions capped at 1000 codes) at `bundles/measure/{MeasureName}/{MeasureName}-bundle.json` (CMS122's is ~16.8 MB).
- **⚠ Version drift found:** our vendored literal bundle is `CMS122FHIRDiabetesAssessGreaterThan9Percent` **v0.5.000** (earlier public-comment draft, different artifact name + canonical); the repo's tests were validated against `CMS122FHIRDiabetesAssessGT9Pct` **v1.0.000** (2026-01-16). Re-vendor v1.0.000 before blaming any engine.
- **Known-bad expecteds:** the repo's own `scripts/comparison/discrepancy_report.md` flags **6 CMS122 cases** (expected NUMER=0, actual 1): `ede0ee7a…`, `e61be907…`, `cade5021…`, `3b62b0a8…`, `9cba6cfa…`, `f5771b74…`. If we flag exactly those 6 we AGREE with the reference engine. **CMS125 has zero known discrepancies** — any CMS125 failure is a real WorkWell bug.
- Gotchas: loose files need assembling into a collection Bundle per patient; resources are QICore-profiled plain R4 (our `stampQiCoreStructure` should become a no-op on them — verify no double-stamping); CMS122 is inverse (numerator=1 ≠ compliant); literal CMS125 execution needs its VSAC OIDs imported (we only imported CMS122's 21); MADiE exports have a history of missing resources/broken refs (UKG slides) — validate bundles.

### 2.2 CQL conformance suite — our runtime already has a public report card

- `github.com/cqframework/cql-tests`: ~1,731 language-level tests (16 XML files by operator category), **no retrieves / no data model / no terminology needed**. Runner: `cql-tests-runner` (Node/TS) drives a FHIR `$cql` operation; results posted to `cql-tests-results` (browsable at `cql-tests-runner.quality.hl7.org`).
- **Our exact runtime (cql-execution 3.3.x) has posted results: 1,533 pass / 81 fail / 113 skip / 4 error** — competitive with the Java reference engine (1,537 pass). Citable today, zero work.
- Known JS-engine failure clusters: `Long` type (dangerous: `1L + 2L` → `"12"`), `LowBoundary`/`HighBoundary` unimplemented (these DO appear in official QICore eCQM logic), decimal precision (Predecessor/Successor step, trailing zeros), Quantity `mod`/`div`, interval `Expand`, DateTime edge formatting. **None are exercised by our 14 runnable measures.**
- Integration options: (i) in-repo harness feeding tests through our translator + cql-execution directly, ~1–2 days — also measures what the JS-translator beta (`@cqframework/cql` 4.0.0-beta.1) breaks vs the Java translator (the posted run used the Java translator; that delta is unpublished, we'd be first); (ii) dev-only `$cql` endpoint so the runner runs stock, ~3–4 days — the entry ticket to posting official vendor results; (iii) runner-as-library: not viable (it's an HTTP client).

### 2.3 Java-vs-JS discrepancy study validates ADR-008

71/74 measures identical across engines. Filed engine bugs (watch-list; none affect our runnable measures): cqframework/clinical_quality_language **#1690** (UCUM conversion), **#1691** (dimensionless units), **#1678** ('day of'), **#1604** (MedicationRequest.medicationReference), **#1682** ('convert'). Their comparison pattern (expected/actual CSVs + regenerated markdown discrepancy report) is worth porting.

### 2.4 DEQM operations = the standards-track version of our integration story

- `$submit-data` / `$collect-data` are the standardized form of what our E12 WebChart ingress hand-rolls; `$data-requirements`-driven gathering parallels #263 delta-eval. **Add to the #254/Doug question list:** any MIE interest in DEQM operations server-side?
- DEQM Inferno test kit + open test servers available to validate our MeasureReport export externally.
- DEQM STU5 care-gaps machinery ≈ WorkWell's open-cases model — cheap vocabulary alignment for credibility.

### 2.5 Terminology manifests fix a real gap we have (see defect 3)

QM IG Measure Terminology Service: a **manifest** (a `Library`, e.g. NLM's `Library/ecqm-update-2025-05-08` on `cts.nlm.nih.gov/fhir`) pins code-system/value-set versions so `$expand?manifest=…` is reproducible across engines and over time. VSAC supports it today. `cqframework/cqm-playground` = known-answer bundles for all 4 scoring types (proportion/ratio/CV/cohort) — a conformance fixture source. The `HL7/fhir-cqm` Postman collection is server-side conformance (wrong side of the wire for us — skip).

---

## 3. Verified defects in our implementation

All verified line-by-line in source on 2026-07-15. **None affect stored outcomes or compliance decisions** — CQL `Outcome Status` (ADR-008) is untouched; these live in the export/import layers.

### D1 — MeasureReport population counts semantically off (two ways)
`backend-ts/src/fhir/measure-report.ts`
- **DENOM excludes DENEX members** (`denom: ipp - denex` at :41/:54; `EXCLUDED → {denom: 0}` at :93). Per the clarified calculation semantics (the saved link — fhir-cqm branch `br-57509`, worked example `score=(3−1)/(6−1−1)` over DENOM=6 *including* exclusions): reported counts are membership-label counts; exclusions subtract only in the score. Our **measureScore is arithmetically correct**; only the reported count elements are wrong. *Caveat: br-57509 is a ballot-branch clarification, not yet published text — but the worked arithmetic is unambiguous.*
- **IPP inflated for the two CMS measures.** Every outcome counts into IPP (:38) and MISSING_DATA → `{ipp:1, denom:1}` (:92), but for cms122/cms125 MISSING_DATA explicitly means **not in the Initial Population** (`cms122.cql:101`, `cms125.cql:113-114`) — deflating the exported score. Correct for OSHA/HEDIS (MISSING_DATA = enrolled-but-no-data), so the fix is per-measure; the `Initial Population` define is already persisted in `evidence_json.expressionResults`. QRDA III inherits both via shared `countPopulations`.

### D2 — Hardcoded `improvementNotation: "increase"` on an inverse measure
`measure-report.ts:82`. CMS122's official notation is `decrease` (numerator = poor control). Internally consistent today ONLY because we also invert the numerator (NUMER=COMPLIANT ≈ 1−official score) AND claim a `urn:workwell:measure:cms122` canonical (:57), not the CMS one — no consumer can mistake it for the official measure. **One step from a real bug:** switching the canonical to the official CMS URL would make the report wrong twice over. Fix: per-measure notation from the YAML binding + a guard test on the invariant.

### D3 — VSAC imports unpinned, no version provenance
`backend-ts/src/run/cli/resolve-valuesets.ts` + `vsac-client.ts`
- `$expand` carries no `manifest`/`expansion`/`valueSetVersion`/`system-version` params → latest-active semantics; a VSAC republish silently changes our expansions (and therefore CMS122 literal-diff results). This is the exact drift the QM IG manifest mechanism exists to prevent.
- We write `version: null` (:86, :110) despite receiving `ValueSet.version` (column exists, is even in the UNIQUE key); `expansion.identifier`/`timestamp` discarded.
- `expansionHash` is a 32-bit rolling hash (:66-74) — honestly labeled "idempotency/audit only", but weak as an integrity artifact; SHA-256 elsewhere in repo.
- Latent: on a VSAC-keyed deployment, runtime live-expansion vs store-imported rows can disagree after a republish (two "official" expansions in one process). Inert on the demo stack (unkeyed).

### DEQM-conformance gaps (valid R4, honestly documented as such)
Missing vs DEQM profiles: `reporter` (1..1), `date` (1..1 individual), `meta.profile`, scoring extension, `improvementNotation` on individual, `evaluatedResource`, versioned resolvable canonical, subject-list type, Patient resources for the dangling `Patient/{id}` refs, Bundle `fullUrl`s, vendor/data-location/CEHRT extensions, `$submit-data`/`$collect-data`/CapabilityStatement. `docs/STANDARDS_CONFORMANCE.md`'s "structurally conformant, not validator-verified" claim is **accurate** — this is an improvement menu, not a misrepresentation.

### Explicitly fine (checked, no findings)
Base-R4 validity (required elements, correct population code system `terminology.hl7.org/CodeSystem/measure-population`); DENOM=0 score guard; individual↔summary count reconciliation; cms122/cms125 numerator defines bake in `Initial Population and not Denominator Exclusions` (matches clarified implicit-dependency semantics); `literal-diff.ts` DENEX-before-numerator ordering robust (latent: no DENEXCEP branch — fine for CMS122, add a comment); no DENEXCEP/NUMEX loss for our two eCQMs (neither defines them) but the 5-bucket vocabulary has no slot for them → **documented precondition before promoting Draft CMS measures that do** (e.g. CMS68, CMS156); patient-based Boolean population basis conformant; HEDIS caution reconfirmed (real HEDIS content needs an NCQA DUA — never present our "HEDIS-style" measures as certified HEDIS).

---

## 4. Action plan (priority order)

1. **Official test-case harness** — re-vendor CMS122 v1.0.000 (+ CMS125 v1.0.000), run all 55+66 official test cases through the fqm-execution literal path, compare vs expected MeasureReports, produce a committed discrepancy report. Expected outcome: agree with reference engine everywhere except (possibly) the 6 known-bad CMS122 expecteds. → *Delegated to an implementation agent 2026-07-15; results to be appended as §7.*
2. **Fix D1 + D2** (MeasureReport count semantics ~hours; per-measure improvementNotation ~hours; eCQM IPP fix ~half-day). Also cheap DEQM adds: `id`, `date`, `reporter`, Bundle `fullUrl`.
3. **Fix D3** (`--manifest` param on resolve-valuesets, record version/expansion.identifier, SHA-256 hash, drift-detection audit event) ~half-day.
4. **CQL conformance harness** (in-repo, 1–2 days) → our own numbers + the unpublished JS-translator-beta delta; `$cql` endpoint later only if posting official results.
5. **#254 additions for Doug/MIE:** DEQM `$submit-data`/`$collect-data` interest; US Quality Core 0.5.0 trajectory (the refactored `dqm-content-cms-2025` content assumes it; relevant to the E12 WebChart adapter since MIE is US Core-based).

## 5. Key links

| What | URL |
|---|---|
| Track page | https://confluence.hl7.org/spaces/FHIR/pages/453908529/2026+-+07+FHIR+Quality+Reporting+with+DEQM |
| Test content (2025 AU / PY2026) | https://github.com/cqframework/dqm-content-qicore-2025 |
| CMS122 test cases | …/tree/master/input/tests/measure/CMS122FHIRDiabetesAssessGT9Pct |
| CMS125 test cases | …/tree/master/input/tests/measure/CMS125FHIRBreastCancerScreen |
| Known discrepancies | …/blob/master/scripts/comparison/discrepancy_report.md |
| CQL test suite / runner / results | https://github.com/cqframework/cql-tests · /cql-tests-runner · /cql-tests-results (UI: https://cql-tests-runner.quality.hl7.org) |
| $cql operation | https://hl7.org/fhir/uv/cql/OperationDefinition-cql-cql.html |
| Clarified population semantics | https://build.fhir.org/ig/HL7/fhir-cqm/branches/br-57509-clarify-calculation-semantics/en/measure-conformance.html |
| DEQM IG (STU5) | https://hl7.org/fhir/us/davinci-deqm/ |
| Measure Terminology Service | https://hl7.org/fhir/us/cqfmeasures/measure-terminology-service.html |
| VSAC FHIR (manifests) | https://www.nlm.nih.gov/vsac/support/usingvsac/vsacfhirapi.html |
| Scoring-type playground | https://github.com/cqframework/cqm-playground |
| DEQM Inferno test kit | https://flame-demo.c3ib.org/deqm-test-kit |
| Advanced 2026 content (stratifiers/risk-adjust) | https://github.com/cqframework/dqm-content-cms-2026 |
| JS engine bug watch-list | cqframework/clinical_quality_language issues #1690 #1691 #1678 #1604 #1682 |

## 6. Honest caveats

- The DENOM-count reading (D1a) rests on a **ballot-branch** clarification page; direction of travel, not yet published text.
- The reference engine behind the content repo's expected results is inferred to be the Java engine (VS Code plugin); their READMEs never name it.
- The 98.16% pass rate was presented at the event; the repo's committed 2026-01-16 report shows more discrepancies — presumably a later post-fix run. Not reconciled.
- Content-repo LICENSE not reviewed yet — check before vendoring test data into our repo.
- Google Sheets (content index, schedules, attendee list), Whova agenda, and Zoom recordings were not accessible.

---

## 7. Official MADiE test-case execution results

**Run date:** 2026-07-15

**Content:** `cqframework/dqm-content-qicore-2025` master at `ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab`

**Runtime:** `fqm-execution` 1.8.5, pre-compiled ELM, Node 24, no server/DB/VSAC key
**Full case tables:** `docs/OFFICIAL_TESTCASE_REPORT_2026-07.md`

The offline harness is `pnpm test:official-cases [--measure cms122|cms125] [--content-dir <path>]`.
`backend-ts/scripts/fetch-official-cases.ps1` performs the long-path-safe sparse clone into ignored
`backend-ts/.official-content/`; no downloaded FHIR content is committed. The upstream root license
checked at this revision is CC0-1.0, but the local-only rule is retained.

### 7.1 Result summary

| Measure | Cases | Exact MADiE expected agreement | Source-known discrepancies reproduced | Unexpected mismatches | Loader/calculation errors |
|---|---:|---:|---:|---:|---:|
| CMS122 v1.0.000 | 55 | **55/55 (100.0%)** | **0/6** | 0 | 0 |
| CMS125 v1.0.000 | 66 | **64/66 (97.0%)** | n/a (source says zero) | **2** | 0 |
| Combined | 121 | **119/121 (98.3%)** | 0/6 | **2** | 0 |

Both primary runs used `trustMetaProfile:false` on the first attempt; neither required the retry.
`fqm-execution` consumed the expanded ValueSets directly from each measure Bundle (CMS122 26/26;
CMS125 32/32), so no external cache or VSAC call was required for v1.0.000.

### 7.2 CMS122 calibration: committed expecteds vs the source comparison

All six UUIDs called out by the source repo as bad expecteds produced numerator `0`, exactly matching
their committed MeasureReports. They did **not** reproduce the source comparison engine's numerator
`1`. The harness therefore reports 55 exact expected passes, not six reference-adjusted passes.

| UUID | MADiE expected NUMER | fqm actual NUMER | Source comparison actual |
|---|---:|---:|---:|
| `ede0ee7a-18ab-4ba7-934c-23618f1270ea` | 0 | **0** | 1 |
| `e61be907-af68-493f-a6bc-3d93ef8b6c6e` | 0 | **0** | 1 |
| `cade5021-b1bf-43e9-a0a4-659c05b386d0` | 0 | **0** | 1 |
| `3b62b0a8-44f2-4365-bcb9-7cadef5bab2e` | 0 | **0** | 1 |
| `9cba6cfa-9671-4850-803d-e286c7d59ee7` | 0 | **0** | 1 |
| `f5771b74-a7de-439a-a51f-49a3863e086b` | 0 | **0** | 1 |

CMS122 is inverse; these are raw population memberships only. No numerator value was translated to a
WorkWell compliance label.

### 7.3 CMS125: two real fqm date-precision findings

The two failures are the same shape: expected DENEX `1`, actual `0`; every other population agrees.

| Case | UUID | Expected IPP/DEN/DENEX/NUM | Actual IPP/DEN/DENEX/NUM | Classification |
|---|---|---|---|---|
| BilateralMastProcOnDec31OfMP | `4cf81a94-81fb-4be2-b075-7d8f9ff02a6e` | 1/1/**1**/0 | 1/1/**0**/0 | fqm 1.8.5 MP-end date precision |
| UniMastRandLProcDec31OfMP | `857fec09-9c8c-4e4b-a123-85f473b8fc2a` | 1/1/**1**/0 | 1/1/**0**/0 | fqm 1.8.5 MP-end date precision |

Both cases put the qualifying Procedure at `2026-12-31T23:59:59Z`. The expected MeasureReports carry
the date-precision end `2026-12-31`; fqm 1.8.5 converts that through JavaScript `Date`, yielding
midnight at the **start** of Dec 31, so the late-day Procedures are outside the execution interval.
A controlled diagnostic rerun with end `2026-12-31T23:59:59.999Z` produced **66/66**. The primary
report deliberately retains the official expected period string, so the two fqm defects remain visible.

This is not a loader or ValueSet-cap effect: the relevant SNOMED bilateral mastectomy code is present
in its complete 16/16 expansion, and both ICD-10-PCS unilateral codes are present in their complete
9/9 expansions. The sole capped set in both bundles is **Advanced Illness** (1000/1997), which neither
failed case exercises.

### 7.4 Honest classification and draft drift

- **WorkWell production-engine/request-path bugs:** 0 found. This CLI executes the ADR-026
  diagnostic-only fqm path; it does not exercise or change WorkWell's authored run pipeline.
- **fqm-execution findings:** 2 CMS125 end-of-day DENEX misses, isolated above.
- **Known-bad MADiE expecteds:** the six CMS122 cases remain known from the source report, but this
  fqm run matched the committed expecteds on all six rather than reproducing the comparison engine.
- **Harness/loader errors:** 0/121. Every case resolved one Patient, one expected MeasureReport, and a
  patientId-keyed fqm result.
- **Value-set-cap effects:** 0 observed. Advanced Illness is capped at 1000/1997 in both bundles, but
  no mismatch depends on it; cap risk remains explicitly reported.
- **v0.5.000 → v1.0.000 drift stretch:** **0/55 population vectors changed** when the older vendored
  CMS122 bundle was run over the same patients with v1's ValueSets supplied as `valueSetCache` (0
  errors). For this corpus, re-vendoring improves provenance/currency but does not change the four
  population memberships.

The architecture guard now explicitly allows `fqm-execution` imports only from
`standards/literal-diff.ts` and `standards/official-cases.ts`; it still prohibits imports from the
request/run pipeline, engine ingress, and `worker.ts`.
