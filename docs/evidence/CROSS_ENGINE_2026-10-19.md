# Cross-engine sweeps on a pinned Java image: every disagreement run to a cause

Date: 2026-10-19 (#846, closes #572). **Supersedes the causes recorded in** `CROSS_ENGINE_2026-08-04.md`,
`CROSS_ENGINE_2026-09-06_CMS137.md`, `CROSS_ENGINE_2026-09-07_CMS2.md`,
`CROSS_ENGINE_2026-09-07_CMS130_CMS165.md` and `CONNECTATHON_DISCREPANCIES_2026-08-04.md`. Those runs used
`hapiproject/hapi:latest` (cqf-fhir-cr 8.10.0), and two of the causes they give are wrong.

## Setup

| | |
|---|---|
| Second engine | `cqf-fhir-cr` (clinical-reasoning 4.13.0) in `hapiproject/hapi` v8.12.0-2, pinned by digest `sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e` |
| Harness | `scripts/cross-engine-sweep.sh` + `scripts/cross-engine-check.ts` at `b470bbb4` (CMS138 at `975207c9`, which adds the bundle supplement below), run by the credentialed `cross-engine-sweep` workflow: VSAC-completed terminology, a fresh container per sweep |
| Content | `cqframework/dqm-content-qicore-2025` at `ca4b4951`, the MADiE decks the official gate runs |
| Comparison | every gated population of every rate against the measure developer's expected MeasureReport, with no exemption. A MeasureReport carrying a contained `OperationOutcome` error is an **engine error**, counted apart from disagreements |
| Period | **sent**: the deck's period passed as `periodStart`/`periodEnd` (dates). **Library default**: none sent, so the measure library's own default period applies |

CMS138's bundle omits one value set its library declares (`…3.526.3.1278`, 4 codes; the MADiE gate supplements
it, ADR-053). The sweep adds it to the bundle from the same sidecar before loading. Created on the server after
the load instead, cqf-fhir-cr refused every case with "Unable to locate ValueSet" (runs 39333449032 and
39333864064), although no CMS138 expression reads that set.

## Results

| Measure | Cases | Period sent | Library default | Runs (sent / default) |
|---|---:|---|---|---|
| CMS122 | 55 | **55/55** | – | 39328916486 |
| CMS125 | 66 | 64/66 (2 disagree) | **66/66** | 39327219058 / 39327646090 |
| CMS2 | 36 | **36/36** | – | 39329332227 |
| CMS68 | 19 | **19/19** | – | 39331936679 |
| CMS951 | 55 | **55/55** | – | 39332617951 |
| CMS138 | 47 | **47/47** | – | 39334356986 |
| CMS130 | 64 | **64/64** | – | 39329776756 |
| CMS165 | 68 | 13/68 (54 disagree, 1 engine error) | **67/68, 0 disagree, 1 engine error** | 39326359504 / 39326781560 |
| CMS137 | 45 | 44/45 on both rates (1 disagree) | **45/45** | 39328070373 / 39328489907 |

**With the period sent: 397/455 agree across nine measures, 57 disagree, 1 engine error. With the library
default where the period matters: no disagreement remains** (CMS125 66/66, CMS137 45/45, CMS165 67/68 plus
the one engine error).

## Causes

### 1. The old image's `convert … to days` bug: 22 disagreements, gone on the pinned image

On cqf-fhir-cr 8.10.0, CQL's `convert <Quantity> to days` returned null (cqframework/clinical_quality_language#1682,
fixed in CQL 5.2.0 by cqframework/clinical_quality_language#1816). Every MedicationRequest in the CMS2, CMS122,
CMS125 and CMS130 decks states its supply only as `dispenseRequest.expectedSupplyDuration`, and
`CumulativeMedicationDuration.medicationRequestPeriod` computes `daysSupply` with exactly that conversion. With
it null and no dose stated, the period falls through to `boundsPeriod.high`, which the decks do not state, so
the period was null on Java and the medication never counted.

Same data on both images (run 39287869908): CMS2 29/36 → 36/36, CMS122 49/55 → 55/55, CMS125 56/66 → 64/66,
CMS130 63/64 → 64/64. That is 7 + 6 + 8 + 1 = 22.

**What this corrects.** The September CMS2 note concluded that Java "takes a medication order's start from
`boundsPeriod` and not from `authoredOn`". Both engines take the start from
`Coalesce(boundsPeriod, authoredOn, validityPeriod)`. Adding `boundsPeriod` moved CMS2 to 36/36 because a
stated `boundsPeriod.high` lets the period skip the broken conversion, not because Java reads the start
from a different field. The six CMS122 cases the MADiE gate used to exempt were among these 22 (#846).

### 2. Java's second-precision measurement period: 57 disagreements with the period sent, none without

cqf-fhir-cr builds a period it is sent at second precision (`DateHelper.convertToDateTime`;
cqframework/clinical-reasoning#1133). An event at `…23:59:59.000` is then uncertain against the period's
end, and CQL returns null rather than true. fqm-execution and MADiE build it at millisecond precision.

- **CMS165, 54:** its denominator asks for a hypertension diagnosis in the first six months, and 51 of the 67
  initial-population cases carry their earliest onset at `2026-06-30T23:59:59.000`. Single-variable mutation
  (run 39282653999): moving only the 63 boundary onsets to noon on the same day, period sent as before,
  gives 67/68, and the same 54 cases flip as when no period is sent.
- **CMS125, 2:** both are `DENEX 1→0`, their exclusion procedures performed at `2026-12-31T23:59:59.000`.
  Moving only the deck's five boundary procedures gives 66/66 (run 39288627093). These were the "two
  `Procedure`-only cases still unexplained" in the September notes.
- **CMS137, 1:** an encounter at `00:00:00.000` on 1 January. The 2026-09-06 note characterised this as a
  precision boundary (one second later, or the same instant without milliseconds, is admitted); the
  library-default sweep confirms it: 45/45.

**What this corrects.** CMS165's 11/68 (13/68 on the pinned image) was not "a harness or configuration
difference", and `QICoreCommon.toInterval` over an open-ended onset was not the mechanism (#572). The
September check ruled out second precision at the period's start; the boundary that matters is the end
of the six-month window.

### 3. One engine exception

CMS165's `45e01fed` ("MedicationRequest.medication as Reference") makes cqf-fhir-cr throw "Unable to extract
codes from fhirType Reference" (run 39285971126; cqframework/clinical-reasoning#1071). It answers with an
all-zero MeasureReport and the exception in a contained `OperationOutcome`. The harness records it as an
engine error, not a disagreement, on both period settings.

## Running total

Across all nine gated measures, **397/455 agree with the period sent**. Every one of the 57 disagreements
is the second-precision period, and with the library's default period none remain. The one other case is an
engine exception. No disagreement is unattributed.

## Limits

1. **One stock configuration of one Java image.** This shows the two engines agree once two Java defects
   (one fixed, one reported) are accounted for. It does not show either engine is right where both agree,
   and the deck is the measure developer's.
2. **The library-default sweep relies on the measure library's default period being the deck's year.**
   Java's own report prints its period at second precision either way (`…23:59:59+00:00`), so the report's
   `period` is a rendering and not the interval evaluated.
3. **`$evaluate-measure` caches per subject for the server's life**, which is why each sweep boots a fresh
   container.
4. **Moving the pin** to a newer image is a deliberate act: re-sweep every measure on it and record the
   result here or in a successor.
