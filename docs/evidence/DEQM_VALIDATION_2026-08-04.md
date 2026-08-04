# MeasureReport vs DEQM STU5 — the first measurement of the FHIR reporting column

Date: 2026-08-04. **ROADMAP_2026-08-04 §4 V3 / milestone B6** — the first of the two checks that replaced
the retired Cypress bar (ADR-058). Command: `backend-ts/scripts/deqm-validate.ts`.

## Headline

**Base R4: 0 errors across all four report shapes. DEQM STU5: 12 errors — exactly 3 per report, the same
3 every time.** Our floor holds, and the gap to DEQM is three structural defects rather than a long tail.

**This is a GAP measurement, not a conformance claim.** `measure-report.ts` deliberately does not stamp
`meta.profile` with a DEQM canonical, so the validator was pointed at the profiles **explicitly** with
`-profile`. Claiming a profile we do not meet is the misdeclaration ADR-050 corrected for QRDA's `…24.1.3`
and `…27.1.2`; asking what claiming it *would* cost is the honest version of the same question.

## Run

| | |
|---|---|
| `validator_cli.jar` sha256 | `fc663ae55dd31bbfde19788dddfb49cacbeebc3c64498fa7b7779df90000434b` |
| IG | `hl7.fhir.us.davinci-deqm#5.0.0` (STU5, `trial-use`, 2025-05-19) |
| Java | Temurin 21.0.10 |
| FHIR version | 4.0.1 |

## Results

| Report | Why it is in the set | base R4 | DEQM |
|---|---|---|---|
| `summary-official-cms125` | the routed, proportion-scored summary a receiver aggregates | **0** | 3 |
| `summary-official-cms122-inverse` | the INVERSE measure — `improvementNotation: decrease` (ADR-046) | **0** | 3 |
| `summary-authored-audiogram` | the AUTHORED path — `urn:workwell:measure`, kept local by ADR-046 d3 | **0** | 3 |
| `individual-official-cms125` | one subject's membership — the QRDA Category I analogue | **0** | 3 |

**The identical 3-per-report count across official AND authored is the informative part.** It means none of
the three defects is provenance-dependent: they are properties of how `measure-report.ts` builds every
report, not of the ADR-046 identity split. Fixing them once fixes all four shapes.

## The three defects

1. **`deqm-0` — "Canonical URL SHALL contain a version."** at `MeasureReport.measure`.
   We emit `https://madie.cms.gov/Measure/CMS125FHIRBreastCancerScreen` with no `|1.0.000`. **We already
   hold the version** — `evidence.official.version`, which ADR-046 threads to the QRDA III identity — so
   this is an omission at one call site, not missing data. The authored path fails the same rule with
   `urn:workwell:measure:audiogram`.
2. **`MeasureReport.reporter` does not match `qicore-organization`.** Our contained Organization carries
   only `name`; the QI-Core profile wants more. Note this is QI-Core's constraint reaching us *through*
   DEQM, not a DEQM rule.
3. **`deqm-3` — "Measure scoring is required. It must be specified on the root only, or on every group,
   and it cannot be on both."** We emit no measure-scoring extension anywhere. Note the shape of the rule:
   satisfying it in both places is as wrong as satisfying it in neither.

## Two findings outside the error count

- **`measureScore.value` is flagged as "outside the range of commonly/reasonably supported decimals"**
  (a base-R4 *warning*, so it is not in the 0). We emit raw float — `0.019417475728155338`. The QRDA III
  exporter formats the same quantity `.toFixed(4)`. So the two exporters describing one run hand a receiver
  `0.0194` and `0.019417475728155338`, and `qrda3-export.ts` claims in a comment that they "must match
  exactly". They match in value and not in representation. Worth closing when the three above are.
- **The DEQM STU5 package resolves `hl7.fhir.us.qicore#6.0.0` and `hl7.fhir.us.core#6.1.0`.** That is
  independent confirmation of ROADMAP_2026-08-04 §6 correction 2, arriving from the tool rather than from
  research: the published quality stack binds **QI-Core 6**, not STU7. The script prints the resolved
  package list for exactly this reason.

## What this does and does not license

- **Does:** state that our MeasureReports are valid R4, measured, across both provenance paths and both
  report types; and state the DEQM gap as a specific, bounded list of three.
- **Does NOT:** license adding `meta.profile` with a DEQM canonical. That is a conformance claim and stays
  owner-reviewed; the gate is this run reaching 0 DEQM errors first, with the base-R4 run proving the
  resource stayed valid.
- **Does NOT** say anything about our arithmetic. That is V4 (cross-execution against Java `cqf-fhir-cr`).
- The sample is four hand-constructed reports from the real builders, not a sweep of a live endpoint's
  responses — the same scope limit `qrda-schematron-check.py` states about itself.

## Reproducing

```bash
curl -L -o validator_cli.jar \
  https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar
cd backend-ts
corepack pnpm exec tsx scripts/deqm-validate.ts --validator ../validator_cli.jar
```

Not in CI: it needs Java 17+, a ~187 MB jar and network access to `packages.fhir.org`, none of which are
backend-ts dependencies. Regressions get pinned in TypeScript in `src/fhir/measure-report.test.ts`, each
assertion citing its constraint key — the `qrda-schematron-check.py` discipline.
