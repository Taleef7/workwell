# WorkWell Standards-Conformance Matrix

What WorkWell emits across the eCQM toolchain, and the conformance level of each. (#91 / E3.3)

| Artifact | Standard | What WorkWell emits | Conformance level | Notes |
|----------|----------|---------------------|-------------------|-------|
| Measure logic | HL7 CQL 1.x | Authored `.cql` per runnable measure (`backend-ts/measures/*.cql`) | Authored + compiles | Inline-code + value-set-retrieve variants |
| Compiled logic | HL7 ELM | Build-time CQL→ELM (`@cqframework/cql`, JVM-free), committed JSON | Compiled + executed | Runtime engine executes ELM via `cql-execution` |
| Value sets | FHIR ValueSet / VSAC | `ValueSetResolver` expansion → populated `cql.CodeService` (E3.2) | Real expansion (store-backed) | VSAC-ready behind the port; synthetic codes today |
| Measure result (patient + summary) | FHIR R4 MeasureReport | `GET /api/runs/{id}/measure-report` (summary + individual + Bundle) (E3.1) | Structurally conformant | Membership-label counts reconcile individual↔summary; UUID ids, report-generation date, contained reporter, Bundle `fullUrl`; structural (not HL7-validator) |
| Measure definition export | MAT (Measure/Library/ValueSet) | `GET /api/measures/{id}/versions/{vid}/export/mat` (FHIR R4 XML) | MAT-compatible | Hand-built FHIR R4 bundle |
| Patient-level report | HL7 QRDA Category I | `GET /api/runs/{id}/qrda1` (one CDA per subject) (M-B) | **CVU+-VALIDATED: 0 findings against the HL7 base IG — CDA schema *and* Schematron — on 10 documents over the synthetic corpus (2026-08-02).** Not Calculation Check, not real patient data, official measures only | **The bar is the HL7 QRDA I R1 STU 5.3 US Realm IG** — the §170.205(h)(2) standard that §170.315**(c)(1)** "record and export" and **(c)(2)** "import and calculate" both reference, and the one Cypress validates Category I against. It is **not** the CMS QRDA I IG, which is titled "for Hospital Quality Reporting" (IQR/PI/OQR); CMS122/CMS125 are Eligible Clinician measures whose CMS *submission* format is Category III. Only §170.315(c)(3) "report" splits by setting. **Measured** with `backend-ts/scripts/qrda-schematron-check.py`, which runs the published CMS RY2026 Schematron and partitions failures by conformance number (`CONF:1198/3343/4509/1098/81/67-*` = base HL7, our bar; `CONF:CMS-*` = hospital-only, not our bar — **except** CMS_0105–0113 datatype and CMS_0115–0120 NPI/TIN rules, which carry CMS numbers but bind any conformant CDA and are counted as ours): **one document** with patient data has **0 base-HL7 errors** (+4 CMS-hospital-only findings, expected — we deliberately do not claim the CMS document template `…24.1.3`) and **without** one it has exactly **1** (the missing entry). Evidence, including a negative control that the partition catches: `docs/evidence/QRDA1_SCHEMATRON_2026-07-31.md`. **Scope: one document per state from a hand-built bundle, not a sweep of an endpoint response.** **It reports NO population membership** — Category I has no place for it; measured, no CMS RY2026 sample file contains an `IPOP`/`DENOM`/`NUMER`/`MSRAGG`, because the receiver *recalculates*. Membership stays in MeasureReport + Category III. The Patient Data section carries real QDM entries (Encounter/Diagnosis/Lab/Diagnostic Study/Procedure Performed) translated from the evaluated FHIR bundle — supplied only where the stack can genuinely re-read it (a WebChart-configured seam), **as of export time, not as of the run**; elsewhere the document is emitted, flagged `conformant: false`, counted in the response's `nonConformant`, and says in prose that it cannot be recalculated from. QRDA I **import** now exists — `POST /api/runs/{id}/evaluate` accepts `{measureId, qrda1}` and evaluates the imported bundle through the UNCHANGED engine (§170.315(c)(2) "import and calculate", ADR-051); an unreadable document is a 400 naming the reason, never a silent empty bundle, and every QDM template the mapper does not know is NAMED in the response (the CMS RY2026 sample carries 47). **A round trip found that a QRDA can only carry REAL terminology**: WorkWell's authored measures bind synthetic `urn:workwell:vs:*` value sets with no CDA code system OID, so their data cannot be exported at all — the export now says exactly that instead of emitting an empty document. **CYPRESS CVU+ HAS NOW RUN (2026-08-02, #380/#381) and Category I passes the HL7 base ruler with 0 findings.** 22 submissions of 12 generated documents to a local Cypress **v7.5.1** (application image digest matching the recorded pin), 10 Category I documents covering the five ADR-038 corpus targets × CMS122/CMS125, all HTTP 201. Against `organization=hl7` for reporting year 2026 the result is **0** from `CqmValidators::CDA` (the XSD schema) **and 0** from `Cat1R53` (the base-HL7 Schematron). **Read the Schematron-only row above with this correction:** its "0 base-HL7 errors" was CONFIRMED exactly by CVU+ — and was *narrower than it read*, because `qrda-schematron-check.py` validates Schematron and has **no XSD in it**, where every Category I document was failing 6–10 times. Three defects accounted for all 76: `@root` carrying a URN where CDA's `uid` admits only an OID or UUID (56), the eCQM version STRING in a CDA `INT` (10), and a `<text>` misplaced after `setId`/`versionNumber` (10). All fixed; **76 → 0 re-measured by regenerating and re-uploading**, not re-derived. **What this does NOT license:** it is the externally-supplied-document validation route, **not Cypress Calculation Check** — nothing here says our *calculations* are right; the corpus is **synthetic**, not real patient data; and the 4-per-document CMS-ruler findings that remain are the CMS **Hospital** templateIds we deliberately do not claim, unchanged. The **authored** path still emits `urn:workwell:measure`, which CDA's `uid` rejects — non-conformant **by design** (ADR-046 decision 3 forbids inventing a published eMeasure identity; ADR-051 concluded the authored catalogue is not QRDA-representable at all) and pinned by a test as the only invalid root remaining. **Locked decision #2's bar is the import → evaluate → export → CVU+ green LOOP and is still NOT met**; this is the export leg. Evidence: `docs/evidence/CVU_VALIDATION_RUN_2026-08-02.md`. (ADR-050/051, superseding ADR-049) |
| Aggregate report | HL7 QRDA Category III | `GET /api/runs/{id}/qrda` (CDA XML) (E3.3) | **Stub — now MEASURED and quantified: 48 CVU+ findings** | Well-formed + structurally representative, and as of 2026-08-02 no longer merely *asserted* to be a stub. Submitted to Cypress CVU+ v7.5.1 (`qrdaIII/hl7`, RY2026): **24 findings per document** across the two generated documents — **2** from `CqmValidators::CDA` (XSD) and **46** from `Cat3R1` (the Cat III Schematron). Two separable causes. **(a) TemplateId version drift:** ours carry `extension="2017-06-01"`; the R2.1 validator requires `2020-12-01` on `…27.1.1`, `…27.2.1` and `…27.3.1`, and `2016-09-01` on `…27.3.5`. A pin, not a design gap. **(b) Genuinely absent structure:** no `recordTarget` (CONF:4484-17212), no `custodian` (CONF:4484-17213), no `author`/`time` (CONF:4484-18156/18158), no `methodCode` (CONF:77-19509), no `MSRAGG` rate-aggregation code (CONF:77-19508), no `ASSERTION` (CONF:77-17578), no `statusCode` (CONF:77-17579), no `reference` (CONF:77-18204), no Aggregate Count `entryRelationship` (CONF:77-17584), and measure counts not typed `INT` (CONF:77-17567). The single XSD error is (b) seen from the schema side: `component` appears where `recordTarget` was expected, because `recordTarget` is absent. The `versionNumber` `INT` fix landed here too via the shared helper. Evidence: `docs/evidence/CVU_VALIDATION_RUN_2026-08-02.md` §5.4 |
| Evaluated resources | HL7 QI-Core (US Realm) | Synthetic FHIR bundles stamped with QI-Core `meta.profile` + required elements (E3.4) | Structural alignment | `meta.profile` declared + required elements present; **not** IG/validator-validated (ADR-009) |
| Measure fidelity | Official eCQM spec (eCQI/CMS) | Structural fidelity diff of WorkWell's authored measure vs the official spec (`GET /api/measures/:id/fidelity`) (E14) | **Structural / definitional (descriptive)** | Sourced, versioned `OfficialMeasureReference` (CMS122v14) with provenance; per-criterion COVERED/SIMPLIFIED/OMITTED + value-set coverage; **does not execute the official CQL or diff outcomes**; advisory — `Outcome Status` stays authoritative (ADR-008/ADR-018) |
| External known-answer diagnostics | Official MADiE test cases (**8** gated measures) (2025 AU / PY2026) | `pnpm test:official-cases` executes the official pre-compiled ELM in one fqm batch per measure and compares five raw population memberships (including denominator-exception) | **Executed / diagnostic-only** | **410/410 exact** across all eight gated measures: CMS122 55/55, CMS125 66/66, CMS2 36/36, CMS68 19/19, CMS951 55/55, CMS138 47/47, CMS130 64/64, CMS165 68/68 after inclusive-day normalization of date-only period ends; 0 unexpected mismatches, 0 loader errors. (Was 231/231 across five until CMS138 joined at 278 (ADR-053) and CMS130+CMS165 at 410 (ADR-054).) **Gated ≠ routed:** only CMS122 and CMS125 are routed, and both only on demo/production. CMS68 is gated but **not routable** — it declares `populationBasis: Encounter` and the executor maps one population vector per subject (ADR-047). **CMS138's green is a WEAKER claim than the other seven:** upstream ships its bundle one value set short (`…3.526.3.1278`), so the four codes for that set are OURS, sourced from VSAC, while the expected population vectors stay upstream's — agreement evidences those four codes, not upstream's terminology (ADR-053). Full evidence: `docs/OFFICIAL_TESTCASE_REPORT_2026-07.md` (ADR-026) |
| Official execution over real EHR-derived data (**initial population only**) | Official CMS125 QI-Core v1.0.000 artifact vs WorkWell's authored implementation | `devdb-official-eval.test.ts` runs MIE's WebChart dev-DB sample (56 patients) through the ingress code path (fixture transport, not live HTTP) and compares official vs authored outcomes per subject | **Executed / authored-parity on IPP membership — NOT verification, and NOT numerator parity** | Official CMS125 agrees with authored on all 56 (52 MISSING_DATA, 4 OVERDUE) after `us-core-sex` was mapped from WebChart's `patients.sex`; official CMS122 and authored are both blind on this seed (no Conditions). **Read the limits:** (1) the oracle is our own authored engine, not an external expected answer — agreement means the flip is safe *for this data*, not that either engine is correct; (2) only **4 subjects carry discriminating signal**, all OVERDUE for the same reason, so the fixture **cannot exercise either numerator** — and the numerator gap is now **closed by dual-stamping** (ADR-044) — the crosswalk emits both the CPT/HCPCS `Procedure` the authored engine reads and a LOINC `Observation` with `category ~ imaging` for the official one, so a screened patient no longer reads as a **false OVERDUE**; the fixture itself still cannot exercise either numerator (its only mammogram belongs to a subject outside the IPP), so that closure is evidenced by the four pinned failure-state tests rather than by this distribution; (3) one of the three IPP conjuncts is a CPT 99213 `Encounter` the OH roster **synthesizes**, since WebChart supplies none — so this is not purely EHR-sourced membership; (4) the fix does not reach a live third-party WebChart server, which reads out-of-population by design. That is now **surfaced** (a run `WARN` naming the likely cause) but deliberately **not enforced at runtime** — the hazard is not runtime-detectable without false positives, since a legitimately all-ineligible cohort produces the identical shape and cohort composition varies per run. **Enforcement is this gate plus the pre-flip checklist**, where official is compared against the authored engine over known data — the only place the two causes can be told apart (ADR-043). The same comparison shows cms122's official routability is **stack-dependent**: over WebChart data official puts all 56 out of the IPP and authored agrees there is nobody to score (a data gap, not a divergence), while on the synthetic roster the demo/production stack actually runs — which has no WebChart seam — official cms122 scores across all five corpus targets and agrees with authored. **cms122 and cms125 are ROUTED on demo/production since 2026-07-30** (PR-9c / ADR-045); every other environment leaves `WORKWELL_OFFICIAL_MEASURES` unset. The flip was measured inert for that stack's data (both measures 5/5 in the official initial population, agreeing with authored on every corpus subject — `docs/evidence/PR9C_FLIP_SNAPSHOT_2026-07-30.md`). Cypress CVU+ remains the verification bar for THIS row and has **not** been pointed at it: CVU+ ran on 2026-08-02 against the QRDA **export** (see the Category I row), never against this official-vs-authored parity question, so the oracle here is still our own authored engine rather than external truth (ADR-042/043) |

## MeasureReport population and identity semantics (2026-07-15; ADR-031)

The FHIR and QRDA aggregate exports use **population-membership label counts**. A subject labeled
`denominator-exclusion` is also labeled `denominator`, so the reported denominator **includes**
exclusion members. Exclusions are subtracted only when calculating the performance rate:

`measureScore = numerator / (denominator - denominator-exclusion)`

The score is omitted in FHIR (and emitted as zero by the QRDA stub) when that effective denominator is
not positive. Individual report memberships sum exactly to the summary populations under the same
semantics; in particular, `EXCLUDED` contributes `{ IPP: 1, DENOM: 1, DENEX: 1, NUMER: 0 }`.

This count interpretation follows the worked calculation in the `fhir-cqm` ballot branch `br-57509`
(`score=(3-1)/(6-1-1)` with `DENOM=6` including exclusions). It is a **ballot-branch clarification of
the QM IG, not yet published normative text**; ADR-031 records why WorkWell adopted the unambiguous
worked arithmetic now.

`MISSING_DATA` remains in IPP/DENOM for the OSHA and HEDIS-style measures: there it means an enrolled
subject without sufficient data. The YAML binding flag `missingDataMeansOutOfPopulation` is true only
for `cms122` and `cms125`, whose authored CQL uses `MISSING_DATA` for `not Initial Population`; their
FHIR/QRDA exports therefore map that status to all-zero population membership. Stored outcomes and CQL
`Outcome Status` are unchanged (ADR-008).

All current exports use binding-driven `improvementNotation: increase` because WorkWell's numerator is
always compliance-oriented. This includes `cms122`, whose WorkWell numerator reverses the official
poor-control orientation. Accordingly, reports claim only `urn:workwell:measure:*`; using an official
CMS canonical without also reorienting the numerator and notation is forbidden and guard-tested.

Each emitted MeasureReport now has a lowercase UUID `id`, a request-scoped report-generation `date`, and
a contained Organization reporter named **WorkWell Measure Studio**. The route injects one generation
timestamp for deterministic timestamp assertions; the run's measurement timeframe remains in `period`.
Collection Bundle entries carry matching
`urn:uuid:*` `fullUrl` values. These are valid base-R4 additions only: WorkWell still does **not** claim a
DEQM `meta.profile`, and the structural/not-validator-verified posture above is unchanged.

## E14 — standards fidelity (authored measure vs official eCQM spec)

>  **SUPERSEDED IN PART (2026-07-30, PR-9c / ADR-045):** on the **demo/production stack**, neither `cms122` nor `cms125`
>  evaluates hand-authored CQL any more — both run CMS's **published QI-Core artifacts** verbatim
>  (`WORKWELL_OFFICIAL_MEASURES="cms122,cms125"`). Both still evaluate authored CQL on every other
>  environment. Their MeasureReport canonical + `improvementNotation` and their QRDA III measure identity
>  now derive from each outcome's own official evidence (ADR-046), so a routed cms122 report declares
>  `decrease` — its official numerator counts poor control. The paragraph below describes that authored form.

WorkWell's eCQM measures (`cms122`, `cms125`) are hand-authored, **simplified** CQL (local value sets,
WorkWell-specific defines, gist-level logic). E14 (#186) makes the **officially published** measure
definition the reference and produces a **documented structural fidelity diff** of WorkWell's authored
version against it:

- **Sourced reference:** `backend-ts/src/standards/references/cms122v14.ts` — a vendored,
  provenance-carrying `OfficialMeasureReference` for **CMS122v14** (v14.0.000, steward NCQA, proportion):
  the official population criteria (IPP/DENOM/DENEX/NUMER/NUMEX), the ~21 official VSAC value sets, and a
  curated, grounded coverage judgement per criterion. Every claim is transcribed from the cited official
  sources (eCQI Resource Center HTML + QPP MIPS frozen-code PDF) — no VSAC login.
- **The diff:** `computeFidelity(ref)` (`backend-ts/src/standards/measure-fidelity.ts`) is a pure assembler
  → a `FidelityReport`: each criterion classified `COVERED | SIMPLIFIED | OMITTED` with a note,
  value-set coverage (which official concepts WorkWell represents), reconciling summary counts, a
  data-driven headline, and a disclaimer that it is structural, not an outcome diff.
- **Endpoint:** `GET /api/measures/:id/fidelity` → the report for a measure with an official reference
  (cms122 today); `{ available: false }` (200) for measures without one; 404 for an unknown measure id.
  Read-only, authenticated, read-time, **no schema**.
- **Conformance level:** **structural / definitional (descriptive)**. It documents exactly where the
  authored measure diverges *in definition* from the official spec; it does **not** execute the official
  CQL. **Official-CQL execution is no longer deferred — it SHIPPED** (ADR-026 → ADR-045; `cms125` is routed on demo/production since 2026-07-30). The sentence below describes the E14-era plan and is kept for history. Behind the existing
  E3.2 (#90) `ValueSetResolver` seam (with frozen QPP code lists as a no-VSAC expansion source). The report
  is advisory — CQL `Outcome Status` remains the sole compliance authority (ADR-008/ADR-018).

**Notes:** All emitted artifacts are produced JVM-free with no external runtime dependency (see ADR-009).
The QRDA III stub uses the well-known QRDA III IG template OIDs and carries the aggregate population counts +
performance rate; **its internal observation `code` values (e.g. on the performance-rate observation) are
placeholders pending QRDA III IG alignment** — the document is structurally representative, not IG-code-exact.
Full IG/Schematron validation, IG-exact codes, and multi-measure aggregation are future work.

## Official MADiE offline diagnostic harness (2026-07-15)

The official-case harness is a reproducible, DB-less check of the **literal diagnostic path**, not a
second compliance authority and not a request-path feature. It downloads no content during execution,
writes no database state, and never calls VSAC. Fetch and run from `backend-ts/`:

```powershell
.\scripts\fetch-official-cases.ps1
pnpm test:official-cases [--measure <catalogId>] [--content-dir <path>]
```

The fetch script performs the required Windows-long-path sparse clone into ignored
`backend-ts/.official-content/`; downloaded FHIR resources are not committed. At content revision
`ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab`, all five gated measures ran with
`trustMetaProfile:false` on the first pass and consumed their own Bundle ValueSet expansions:

| Measure | Cases | Exact expected agreement | Unexpected mismatch | Errors | Result note |
|---|---:|---:|---:|---:|---|
| CMS122 v1.0.000 | 55 | **55/55** | 0 | 0 | All six source-reported bad-expecteds matched their committed numerator=0; 0/6 reproduced the source comparison's numerator=1 |
| CMS125 v1.0.000 | 66 | **66/66** | 0 | 0 | Primary execution normalizes the official date-only Dec 31 end to `2026-12-31T23:59:59.999Z`, matching MADiE's inclusive-day expected results; the un-normalized run is 64/66 |

Date-only period ends are normalized before Calculator execution because `fqm-execution` 1.8.5
parses them as start-of-day. The live `/api/measures/cms122/fidelity/diff` literal tier uses the same
inclusive end-of-day bound, while its date-only January 1 start remains correct.

The sole truncated expansion is Advanced Illness (1000/1997) in each Bundle; no primary-run mismatch
depends on it. The older vendored CMS122 v0.5.000 bundle changed **0/55** population vectors when run with
the v1 Bundle's ValueSets as `valueSetCache`; re-vendoring remains a provenance/currency improvement,
not an outcome change for this fixture corpus.

ADR-026 isolation remains executable policy: only `standards/literal-diff.ts` and
`standards/official-cases.ts` may import `fqm-execution`; the architecture test separately preserves
the prohibition on request/run-pipeline, engine-ingress, and `worker.ts` imports.
