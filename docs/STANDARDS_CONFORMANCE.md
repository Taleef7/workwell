# WorkWell Standards-Conformance Matrix

What WorkWell emits across the eCQM toolchain, and the conformance level of each. (#91 / E3.3)

| Artifact | Standard | What WorkWell emits | Conformance level | Notes |
|----------|----------|---------------------|-------------------|-------|
| Measure logic | HL7 CQL 1.x | Authored `.cql` per runnable measure (`backend-ts/measures/*.cql`) | Authored + compiles | Inline-code + value-set-retrieve variants |
| Compiled logic | HL7 ELM | Build-time CQL→ELM (`@cqframework/cql`, JVM-free), committed JSON | Compiled + executed | Runtime engine executes ELM via `cql-execution` |
| Value sets | FHIR ValueSet / VSAC | `ValueSetResolver` expansion → populated `cql.CodeService` (E3.2) | Real expansion (store-backed) | VSAC-ready behind the port; synthetic codes today |
| Measure result (patient + summary) | FHIR R4 MeasureReport | `GET /api/runs/{id}/measure-report` (summary + individual + Bundle) (E3.1) | Structurally conformant | Membership-label counts reconcile individual↔summary; UUID ids, report-generation date, contained reporter, Bundle `fullUrl`; structural (not HL7-validator) |
| Measure definition export | MAT (Measure/Library/ValueSet) | `GET /api/measures/{id}/versions/{vid}/export/mat` (FHIR R4 XML) | MAT-compatible | Hand-built FHIR R4 bundle |
| Aggregate report | HL7 QRDA Category III | `GET /api/runs/{id}/qrda` (CDA XML) (E3.3) | **Stub** | Well-formed + structurally representative; **not** IG/Schematron-validated |
| Evaluated resources | HL7 QI-Core (US Realm) | Synthetic FHIR bundles stamped with QI-Core `meta.profile` + required elements (E3.4) | Structural alignment | `meta.profile` declared + required elements present; **not** IG/validator-validated (ADR-009) |
| Measure fidelity | Official eCQM spec (eCQI/CMS) | Structural fidelity diff of WorkWell's authored measure vs the official spec (`GET /api/measures/:id/fidelity`) (E14) | **Structural / definitional (descriptive)** | Sourced, versioned `OfficialMeasureReference` (CMS122v14) with provenance; per-criterion COVERED/SIMPLIFIED/OMITTED + value-set coverage; **does not execute the official CQL or diff outcomes**; advisory — `Outcome Status` stays authoritative (ADR-008/ADR-018) |
| External known-answer diagnostics | Official MADiE CMS122/CMS125 test cases (2025 AU / PY2026) | `pnpm test:official-cases` executes the official pre-compiled ELM in one fqm batch per measure and compares four raw population memberships | **Executed / diagnostic-only** | **121/121 exact:** CMS122 55/55 and CMS125 66/66 after inclusive-day normalization of date-only period ends; 0 loader errors. Full evidence: `docs/OFFICIAL_TESTCASE_REPORT_2026-07.md` (ADR-026) |

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
  CQL. **Official-CQL execution + an evaluated-outcome diff is deferred to E14 PR-2**, behind the existing
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
pnpm test:official-cases [--measure cms122|cms125] [--content-dir <path>]
```

The fetch script performs the required Windows-long-path sparse clone into ignored
`backend-ts/.official-content/`; downloaded FHIR resources are not committed. At content revision
`ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab`, both measures ran with
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
