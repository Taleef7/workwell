# CMS2's seven cross-engine disagreements, run to a cause

Date: 2026-09-07. The MM-1c precondition for CMS2's flip (`docs/ROADMAP_2026-08-30.md` §5;
`LOCKED_DECISIONS.md` §4A.5 — no known-unverified measure is routed to the pilot). The disagreements
themselves were found on 2026-08-04 (`CROSS_ENGINE_2026-08-04.md`) and recorded as **undiagnosed**;
this closes that.

Command: `backend-ts/scripts/cross-engine-sweep.sh cms2 -- --json`, which is new here — the container
lifecycle that used to be four steps of a runbook, with the three silent ways to get it wrong written
into the script rather than into a paragraph nobody re-reads.

## What was run

| | |
|---|---|
| Engine | `cqf-fhir-cr` via HAPI FHIR Server **8.10.0** (`hapiproject/hapi:latest`), Docker, a FRESH container per input |
| Artifact | `CMS2FHIRPCSDepScreenAndFollowUp`, the vendored bundle's upstream original |
| Cases | **36** MADiE test cases |
| Period | `2026-01-01 .. 2026-12-31`; Java's own report says `2026-01-01T00:00:00+00:00 .. 2026-12-31T23:59:59+00:00` |
| Terminology | our vendored sidecar, pushed as every value set's expansion before the first evaluation — 15/15 replaced |

**Baseline reproduces 2026-08-04 exactly: 29 of 36 agree, and all seven disagreements are `NUMER 1→0`**
— the Java engine does not credit a numerator the steward and `fqm-execution` both credit. Initial
population and denominator agree on all 36.

## The cause, established by construction (ADR-055's standard)

### 1. The seven share one shape, and it is not shared by the cases that agree

Fourteen cases expect `NUMER = 1`. Seven agree and seven do not, and the split is exact:

| follow-up recorded | cases | agree? |
|---|---|---|
| `Procedure`, `ServiceRequest`, or a negative screen | 7 | yes |
| a `MedicationRequest` **only** | 7 | **no** |
| a `MedicationRequest` **and** a `Procedure` | 1 (`82134291`) | yes — the Procedure carries it |

The split holds across both age branches (adolescent and adult, screened with 73831-0 and 73832-8) and
both drug codes in the deck. CMS2's numerator credits a follow-up through three paths; the medication
path is the only one that disagrees, and it is the only one that calls
`CumulativeMedicationDuration.medicationRequestPeriod`.

### 2. It is not retrieval, and it is not terminology

Both were checked directly rather than assumed, because both are the usual suspects:

- The order **is retrieved and evaluated**. `$evaluate-measure` for a failing subject lists
  `MedicationRequest/cf0c59bf…` in `evaluatedResource` beside the Patient, Encounter and Observation.
  The engine saw it and declined to credit it.
- The drug **is in the value set we pushed**. RxNorm 1000048 is a member of *Adult Depression
  Medications* (`2.16.840.1.113883.3.526.3.1566`) in our sidecar, whose expansion is complete —
  200 of a declared 200, not capped.

### 3. Three data-shape repairs are refuted, and the fourth is decisive

Each row is a fresh container, the whole bundle reloaded, terminology pushed before the first
evaluation, one variable changed and nothing else. Mutations 1 and 4 differ by a single field.

| # | mutation on the seven orders | sweep |
|---|---|---|
| 0 | none — the steward's deck as published | 29/36 |
| 1 | add `dosageInstruction` with `timing.repeat` frequency/period/periodUnit and a dose | 29/36 |
| 2a | add `dispenseRequest.validityPeriod` (start **and** end), on three of them | 29/36 |
| 2b | move the drug from `medicationCodeableConcept` to a contained `Medication` + `medicationReference`, on the other four | 29/36 |
| 3 | all of the above together, plus `numberOfRepeatsAllowed` and `quantity` | **36/36** |
| 4 | **mutation 1 plus `timing.repeat.boundsPeriod`, and nothing else** | **36/36** |

Mutation 4 is the isolation. Its only difference from the refuted mutation 1 is `boundsPeriod`, and it
flips all seven.

### 4. The statement

**On this artifact, in this configuration, `cqf-fhir-cr` credits an antidepressant follow-up only when
the order carries `dosageInstruction.timing.repeat.boundsPeriod`. `fqm-execution` and the measure
developer's expected reports credit the same order from `authoredOn`.**

`medicationRequestPeriod` returns an interval only where it can derive both a start and a duration, and
returns null otherwise; the numerator's timing test against a null interval is not a follow-up. The
mutations say which inputs the Java side will accept as that start: `boundsPeriod` yes, `authoredOn` no,
`dispenseRequest.validityPeriod` no. That is a characterisation of a helper's behaviour under one
engine, not a verdict on which engine is right — and note that MADiE's own expected reports, produced
by a Java stack, agree with the JS reading.

### 5. It is the same helper as CMS122 and CMS125

The 2026-08-04 run proved those two measures' `DENEX 1→0` disagreements by isolating them to
`"Has Dementia Medications in Year Before or During Measurement Period"`, whose period likewise comes
from `medicationRequestPeriod` deriving from `dosageInstruction`, which the MADiE cases omit.

With CMS2 diagnosed, that helper is implicated in **21 of the 24** known cross-engine disagreements —
CMS122's 6, CMS125's 8, CMS2's 7 — but the 21 are not all attributed to the same standard, and the
difference matters:

| | cases | standard |
|---|---|---|
| **Proven by construction** | **8** | one CMS125 case in August, and all 7 CMS2 cases here — a single-variable mutation flipped each |
| Consistent-with, by inventory | 13 | the other CMS122/CMS125 disagreements: every one carries a `MedicationRequest` and no agreeing case does, which is strong and is not a proof |
| Unattributed | 2 | the CMS125 cases whose follow-up is a `Procedure` only — same shape, different cause |
| Separate, and separately proven | 1 | CMS137's period-boundary precision difference (2026-09-06) |

The August evidence counted **9 of 23 unattributed**; it is now **2 of 24**. Anywhere this is
summarised, "implicated in 21" is the honest verb and "proven for 8" is the stronger claim that can
also be made.

That is worth more than three separate findings. It says the second engine agrees with ours about
depression screening, breast cancer screening and diabetes control, and disagrees about how to read a
medication order — one difference wearing three costumes, rather than three unrelated problems.

## What it changes for the pilot

- **No number we report moves.** Our runtime agrees with the steward on all 36 CMS2 cases (the MADiE
  gate), and the disagreement is in the second opinion.
- **CMS2's MM-1c verification debt is paid.** The measure's disagreements are no longer unexplained,
  which is the condition §4A.5 and ROADMAP MM-1c put on its flip. The flip itself remains the owner's
  reviewed workflow edit and still wants a `flip-gate --subjects all` run.
- **Our own corpus was relying on the leniency.** `corpus-bundle.ts` emits the dementia-medication
  order with a real supply period *via `dispenseRequest`* — deliberately, so the frailty exclusion
  would be reachable "because of the data, not because of an engine leniency". Mutation 2a shows that
  `dispenseRequest` alone does not satisfy the Java reading, so the order now also carries
  `timing.repeat.boundsPeriod` for the same supply window. Same clinical fact, stated in the field both
  engines read.
- **For a QRDA consumer recomputing our counts in Java**, a medication-only follow-up recorded without
  dosage timing is the shape to look at first, exactly as the CMS137 evidence says of a midnight
  encounter boundary.

## Limits — read before citing

1. One stock HAPI configuration, one server version, no alternative CR settings.
2. Synthetic MADiE patients, not real patient data; 36 cases.
3. This says WHICH INPUT each engine will accept as a medication's start, not which engine implements
   the specification correctly. Establishing that needs the CQL specification's own answer for
   `medicationRequestPeriod` over a request with `authoredOn` and a dispense request, which is a
   question for the measure steward and the engine authors, not for a mutation.
4. cms130 and cms165 remain unmeasured cross-engine — their sidecars are VSAC-completed and cannot be
   produced without the credential (issue #532).

Running total across the measures cross-executed to date: **299 of 323 cases agree across seven
measures**, unchanged — this is a diagnosis of a known disagreement, not a new measurement.
