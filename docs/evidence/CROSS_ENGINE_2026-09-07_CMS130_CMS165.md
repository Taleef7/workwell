# CMS130 and CMS165 through the second engine — the last two measures, and only one of them counts

Date: 2026-09-07. Closing the measurable half of issue #532. These are the two measures that had never
been cross-executed, because their terminology sidecars are VSAC-completed (ADR-041) and an
uncredentialed machine cannot reproduce them — so the sweep had to run where the credential lives.

Command: the `cross-engine-sweep` workflow, dispatched per measure. It vendors the sidecar with
`--complete-terminology`, refuses if the manifest still reports a truncated expansion, and drives
`scripts/cross-engine-sweep.sh`. CMS130's run reported `31 value sets, 3172 codes, 0 truncated`, with
the AdvancedIllness list completed from VSAC at 1000 → 2000 codes.

| | |
|---|---|
| Engine | `cqf-fhir-cr` via HAPI FHIR Server 8.10.0, a fresh container per measure |
| Period | `2026-01-01 .. 2026-12-31`; Java's own report says `…T00:00:00+00:00 .. …T23:59:59+00:00` |
| Cases | CMS130: 64. CMS165: 68. Every case evaluated; no request failed on either run |

## CMS130 — 63 of 64 agree

A real measurement, and the strongest first result of any measure swept so far.

The single disagreement is `DENEX 1→0`: case `f9ef1fd1…`, where the steward and `fqm-execution` apply a
denominator exclusion and the Java engine does not. **That is the same shape as CMS122's and CMS125's**,
and the case carries the same signature the CMS2 investigation isolated — a `MedicationRequest` with
`dispenseRequest.expectedSupplyDuration` and **no `dosageInstruction`**, which is the shape
`CumulativeMedicationDuration.medicationRequestPeriod` returns a null interval for on the Java side
(`CROSS_ENGINE_2026-09-07_CMS2.md`).

**Consistent-with, not proven.** One case, matching a signature proven by mutation elsewhere, is the
August standard's "consistent-with by inventory". Proving it would need a mutation run — adding
`dosageInstruction.timing.repeat.boundsPeriod` to that order and re-sweeping — which needs the
credentialed context, and the workflow does not yet accept a mutated bundle. Worth doing before anyone
cites CMS130's number to the minute; not worth blocking the measurement on.

## CMS165 — 11 of 68, and it is NOT a comparison of engines yet

Reported as an open question rather than a conformance number, because a result this shape is far more
likely to be a harness or configuration difference than a genuine disagreement about the measure — the
same judgement the 2026-08-04 run made about sweeping on capped expansions, and the reason the check
script refuses a degenerate sweep outright.

**What the run establishes.** All 68 cases evaluated and no request failed, so this is not the partial
sweep the workflow now refuses. The Java engine puts **56 of 68 patients out of the initial population
entirely**. The disagreement shapes are `IPP + DENOM + DENEX` (31), `IPP + DENOM` (24), and `DENEX`
alone (2) — i.e. almost all of it is one thing: the patient is not in the population at all.

**What has been ruled out.** The obvious suspect was the period boundary proven for CMS137: CMS165's
MADiE deck starts most encounters at `2026-01-01T00:00:00.000+00:00`, the period's first millisecond,
which the Java engine treats as an uncertain comparison against its second-precision period start. The
correlation does not hold. Of the cases whose every encounter sits at that instant, **nine were admitted
to the initial population by Java anyway** (expected IPP 1, Java IPP 1). A first-millisecond encounter
is therefore not uniformly dropped here, and the CMS137 mechanism does not explain this.

**What it is not.** Not terminology: the sidecar was completed and verified as untruncated before the
sweep. Not our runtime: `fqm-execution` passes all 68 against the same deck (ADR-072). Not request
failures.

**The next step**, for whoever picks this up: CMS165's initial population is the one that reads a
hypertension `Condition`'s prevalence period, and its denominator turns on the diagnosis falling in the
first six months of the period. `QICoreCommon.toInterval` over a `Condition` whose `onset`/`abatement`
are absent or open-ended is the first place to look, and the discriminating experiment is a single case
with an explicit `onsetDateTime` well inside the period.

**Until that is answered, CMS165 has no cross-engine number**, and none is quoted anywhere. It is the
one pilot measure that must not be routed for an unrelated reason as well (ADR-076 d1 and issue #533).

## Running total

**362 of 387 cases agree across EIGHT measures** — the previous 299/323 across seven, plus CMS130's
63/64. CMS165 is deliberately excluded: a number that is probably measuring the harness does not belong
in a total that is cited as evidence about engines.

## Limits — read before citing

1. One stock HAPI configuration, one server version, no alternative Clinical Reasoning settings.
2. Synthetic MADiE patients, not real patient data.
3. CMS130's single disagreement is attributed by signature, not by mutation. See above.
4. CMS165's result is recorded as an open question and is not a conformance claim.
