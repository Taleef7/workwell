# Alternate-engine verification report — CMS7-FQR (FHIR Quality Reporting with DEQM)

Date: 2026-08-04. Prepared for the **CMS7-FQR** track's standing ask to participants: *verify results on an
alternate engine, help diagnose the remaining discrepancies, and classify each into (A) spec clarification,
(B) tooling fix, (C) content fix, (D) pattern/profile change.*

**Who we are.** WorkWell Measure Studio — a JavaScript/TypeScript quality engine running CMS's published
QI-Core measure artifacts verbatim via `fqm-execution`, hash-pinned, with the MADiE test cases as a
permanent CI gate (410/410 across eight measures). We are not an EHR and we do not pursue ONC certification;
we run the FHIR column.

**What we did.** Cross-executed the 2025 AU MADiE test cases through **two independently written engines** —
`fqm-execution` (JS) and `cqf-fhir-cr` via HAPI FHIR 8.10.0 (Java) — over the same artifacts, the same cases
and the same terminology, and diffed the population vectors against the measure developer's expected
`MeasureReport`.

Harness: `backend-ts/scripts/cross-engine-check.ts`. Full method and limits:
`docs/evidence/CROSS_ENGINE_2026-08-04.md`.

## Results

| measure | agreeing | disagreeing | shape of every disagreement |
|---|---|---|---|
| CMS68 | 19/19 | 0 | — |
| CMS951 | 55/55 | 0 | — |
| CMS138 | 47/47 | 0 | — |
| CMS122 | 49/55 | 6 | `DENEX 1→0` **and** `NUMER 0→1` |
| CMS125 | 56/66 | 10 | `DENEX 1→0` |
| CMS2 | 29/36 | 7 | `NUMER 1→0` |
| **total** | **255/278** | **23** | |

`fqm-execution` matches the expected result on all 278. IPP and DENOM agree on all 278 in both engines.
CMS130 and CMS165 were not swept (no test cases in our local checkout).

**CMS122 and CMS125 are one root event.** CMS122 is inverse and `fqm` zeroes NUMER when a denominator
exclusion is true, so a missed exclusion necessarily reports there as two differences.

---

## Finding 1 — `medicationRequestPeriod()` when `dosageInstruction` is absent

**Measures affected:** CMS125 (10 cases), CMS122 (6 cases).
**Proposed classification: (A) spec clarification**, with **(C) content fix** as an alternative. See below.

### What diverges

The `AdvancedIllnessandFrailty` exclusion is

```cql
AgeInYearsAt(date from end of "Measurement Period") >= 66
  and "Has Criteria Indicating Frailty"
  and ( "Has Advanced Illness in Year Before or During Measurement Period"
        or "Has Dementia Medications in Year Before or During Measurement Period" )
```

and the medication arm is

```cql
exists (( ([MedicationRequest: "Dementia Medications"]).isMedicationActive()) DementiaMedication
  where DementiaMedication.medicationRequestPeriod() overlaps day of
        Interval[start of "Measurement Period" - 1 year, end of "Measurement Period"])
```

`medicationRequestPeriod()` (library `CumulativeMedicationDuration`) opens with

```cql
let dosage: singleton from R.dosageInstruction,
    doseAndRate: singleton from dosage.doseAndRate, ...
```

**The test cases' `MedicationRequest` resources carry no `dosageInstruction` at all** — only
`dispenseRequest.expectedSupplyDuration`. Example (CMS125 case `d4540640-2561-4ebd-b7c6-15878a4dc582`):
rivastigmine `RxNorm 312836`, `status: active`, `intent: order`, `authoredOn: 2026-12-30`,
`dispenseRequest.expectedSupplyDuration: 90 days`, **no `dosageInstruction`**.

So the function's inputs are null. `fqm-execution` yields an interval that overlaps the lookback window and
the subject is excluded, matching the expected result. `cqf-fhir-cr` does not, and the subject is not
excluded.

### How it was isolated (proof by construction)

Three single-variable mutations on that subject (age 74; frailty `DeviceRequest` SNOMED 183240000; the
rivastigmine order above), each on a **fresh server** because `$evaluate-measure` caches:

| mutation | DENEX | conclusion |
|---|---|---|
| baseline | 0 | the disagreement |
| inject hospice `Condition` | **1** | the engine can exclude this subject — failure is branch-specific |
| add a minimal `dosageInstruction` | 0 | not sufficient alone |
| inject Advanced Illness `Condition` | **1** | **decisive** — bypasses only the medication arm |

The last mutation leaves the age and frailty conjuncts untouched, so DENEX reaching 1 proves both are
credited by `cqf-fhir-cr`. The failing conjunct is therefore precisely **"Has Dementia Medications in Year
Before or During Measurement Period"**.

### Why we lean (A) rather than (B)

The behaviour of `medicationRequestPeriod()` when `dosageInstruction` is absent does not appear to be
pinned anywhere: two conforming engines derive different intervals from the same null inputs. That is a
specification gap before it is an implementation defect. **(C)** is a reasonable alternative reading — a
test case exercising a medication-duration path arguably ought to carry the dosage that calculation
consumes — but that would change the content rather than settle what the function means.

**Question for the track:** what *should* `medicationRequestPeriod()` return when `dosageInstruction` is
absent but `dispenseRequest.expectedSupplyDuration` is present? A defined answer resolves 16 of our 23
discrepancies.

---

## Finding 2 — `cqf-fhir-cr` retrieval is QI-Core `meta.profile`-sensitive

**Proposed classification: (D) pattern/profile change**, or documentation.

A `Condition` created by `PUT` with no `meta.profile` is **stored, searchable and silently never
retrieved** — it does not appear in `evaluatedResource` and the measure evaluates as if the resource were
absent. Adding `meta.profile: [".../qicore-condition-problems-health-concerns"]` to the identical resource
causes it to be retrieved immediately and changes the population result.

This is not a defect report so much as a trap worth documenting: **anyone hand-building QI-Core test data
for this engine must stamp the profile**, and there is no diagnostic when they do not. It cost us one
failed mutation experiment before we found it, and it silently invalidates any comparison built on
hand-authored data.

---

## Finding 3 — CMS2 `NUMER 1→0`, undiagnosed

**Measure affected:** CMS2 (7 cases). **Classification: unknown — we are asking, not reporting.**

Seven cases where the expected numerator is 1 and `cqf-fhir-cr` returns 0, with the exclusion untouched.
Distinct in shape from Findings 1 and 2 and not yet isolated. We can supply the case ids and per-case
vectors on request.

---

## Two operational notes for anyone reproducing this

1. **The HAPI property is `hapi.fhir.cr.enabled`.** With `cr_enabled` the server starts normally and simply
   declares no measure operations — a silent no-op. Confirm `Measure/$evaluate-measure` is in the
   CapabilityStatement before trusting any run.
2. **`$evaluate-measure` caches per subject for the life of the server**, and the default image is
   in-memory H2 so a `restart` wipes the data rather than just the cache. Every changed input needs a fresh
   container and a full reload. We published a conclusion that had to be re-proved cold after finding this.

## Limits on everything above

- One server version, one stock CR configuration; no alternative settings explored. **We are not claiming
  `cqf-fhir-cr` is wrong** — we are reporting that two conforming engines diverge, and where.
- Synthetic MADiE patients, not real patient data.
- CMS130 and CMS165 unmeasured.
- Our own engine's agreement with the expected results is a CI gate we run ourselves; the expected answers
  are third-party, the execution is not.

## Contact / artifacts

Harness, evidence and per-case vectors are in the WorkWell repository:
`backend-ts/scripts/cross-engine-check.ts`, `docs/evidence/CROSS_ENGINE_2026-08-04.md`. Per-case JSON for
any measure is reproducible with `--json`.
