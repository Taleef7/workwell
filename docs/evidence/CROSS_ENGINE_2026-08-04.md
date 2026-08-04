# Two independently written engines over the same official artifact — the first run

Date: 2026-08-04. **ROADMAP_2026-08-04 §4 V4 / milestone B7** — the second of the two checks that replaced
the retired Cypress bar (ADR-058). Command: `backend-ts/scripts/cross-engine-check.ts`.

## Why this check and not another

Our MADiE gate is **410/410 across eight measures**, and the expected answers in it are third-party
(CMS/measure-developer-authored). But **the execution is entirely ours** — one engine, `fqm-execution`,
reading one artifact. The obvious candidates for a second opinion do not qualify: **`fqm-testify` and
`deqm-test-server` both WRAP `fqm-execution`**, so comparing against either compares our engine to itself.

`cqf-fhir-cr` (HAPI's Clinical Reasoning module) is a separate implementation in a different language with
a different CQL engine and a different data provider. This is the first time WorkWell's artifacts have been
run by anything other than us.

## Setup

| | |
|---|---|
| Engine | `cqf-fhir-cr` via HAPI FHIR Server **8.10.0** (`hapiproject/hapi:latest`, Docker) |
| Measures | the **six** with test cases checked out locally, all **v1.0.000** upstream bundles (self-contained: Measure + Libraries + ValueSets + patients + expected MeasureReports) |
| Cases | **278** MADiE test cases, `.official-content/input/tests/measure/…` |
| Period | per measure, read from its own expected MeasureReports |
| Terminology | **our completed expansions** (ADR-041 sidecar) where one exists, loaded BEFORE any evaluation |
| Procedure | one fresh container per measure; wait for readiness, **then settle**, then load, then sweep |

The CR property is **`hapi.fhir.cr.enabled`**. With `cr_enabled` the server starts happily and simply
declares no measure operations — a silent no-op. The script now refuses to run unless the
CapabilityStatement lists `Measure/$evaluate-measure`, because otherwise every evaluate 404s and the sweep
reports a catastrophic "0 agreements" that is really a misconfigured container.

## Result — all six locally checked-out measures

**255 of 278 cases agree. Three of the six measures agree on every case.**

| measure | agreeing | disagreeing | the shape of every disagreement |
|---|---|---|---|
| CMS68 | **19/19** | 0 | — |
| CMS951 | **55/55** | 0 | — |
| CMS138 | **47/47** | 0 | — |
| CMS122 | 49/55 | 6 | `DENEX 1→0` **and** `NUMER 0→1` |
| CMS125 | 56/66 | 10 | `DENEX 1→0` |
| CMS2 | 29/36 | 7 | `NUMER 1→0` |
| **total** | **255/278** | **23** | |

**CMS122 and CMS125 are the same root event.** CMS122 is an inverse measure and `fqm` zeroes the numerator
when a denominator exclusion is true, so "Java did not credit the exclusion" necessarily shows up there as
`DENEX 1→0` *and* `NUMER 0→1` — two reported differences, one cause. **CMS2's is a different failure**: a
numerator Java does not credit, with the exclusion untouched.

Within each measure every disagreement has an identical shape, and IPP and DENOM agree on **all 278 cases**
across all six measures.

**Correction to a number this document first reported.** An initial batch loop swept all six measures back
to back and reported **CMS122 at 7/55**. That was an artefact of sweeping before the server had settled —
the container answered `/metadata` with 200 while the CR module was still coming up. Re-run on a settled
server (a fixed wait after readiness, and after the bundle load), CMS122 is **49/55**. CMS2 reproduced
unchanged at 29/36, and all three perfect measures reproduced at 100%. **A degraded server produces more
disagreement, not less**, which is why the three 100% results were trustworthy even from the bad batch —
but the two divergent ones were not, and both were re-measured.

## CORRECTION (same day): `$evaluate-measure` CACHES, and it invalidated this document's first proof

**`$evaluate-measure` results are cached per subject for the life of the server.** Proven: a `Condition`
was PUT for a subject already evaluated, confirmed stored and searchable (`total: 1`), and the next
evaluation returned a **byte-identical `evaluatedResource` list** that did not contain it.

**This invalidated the terminology conclusion as originally evidenced.** The sequence actually run was:
fresh server → load bundle (capped expansions) → **sweep 1** → push completed expansions → **sweep 2**.
Sweep 1 was cold and valid. **Sweep 2 was warm**, so "we changed the terminology and the same 10 disagreed"
did not establish what it claimed — the second sweep may simply have replayed the first.

**Re-established properly:** fresh container → load bundle → push completed terminology **before any
evaluation** → sweep. Result **56/66, the same 10**. So the conclusion stands, and now the evidence for it
does too. Right answer, wrong proof, corrected.

**Consequence for anyone using this harness: mutating data or terminology requires a NEW container.** There
is no cache-bust short of a restart, and the failure mode is silent — you get a plausible previous answer.

## What is MEASURED

- **255/278 agreement between two independently written engines** across six measures on the same
  artifacts, cases and terminology — with **CMS68, CMS951 and CMS138 agreeing on every single case**.
- **Every disagreement is one-directional within its measure**, and IPP + DENOM agree on all 278.
- **Terminology is EXCLUDED as the cause.** The first sweep used the upstream bundle's expansions, in which
  `…1003.110.12.1082` (AdvancedIllness) ships capped at 1000 of 1997 — the exact gap ADR-041 exists to
  close, and a natural suspect since it feeds a DENEX. Our completed expansions were pushed (32 value sets,
  **3043 codes**, matching ADR-041's recorded figure) and the server was **verified** to hold
  `expansion.total: 2000` for that OID. **The same 10 disagreed.** A tidy hypothesis, killed by measurement.
- **The disagreement is BRANCH-level, not resource-level.** This is a correction of the first reading,
  which said "correlates with `MedicationRequest` (8/10 vs 0/25)". That correlation is real but it
  mischaracterised the cause, and a direct check disproved the obvious reading of it: **Java DOES retrieve
  the `MedicationRequest` and the `DeviceRequest`** — both appear in `evaluatedResource` for a failing
  subject — so it is **not** a retrieve failure.

  What actually separates the groups is which *exclusion branch* the case exercises. Every one of the 25
  agreeing `DENEX = 1` cases uses a **simple** branch — a hospice `Condition`, a bilateral-mastectomy-history
  `Condition`, encounters. The disagreeing cases use the compound **"Advanced Illness and Frailty"** branch,
  which needs age ≥ 65 **and** a frailty device/diagnosis **and** either an advanced-illness diagnosis or a
  dementia medication. A failing subject carries exactly that shape: a frailty `DeviceRequest`
  (SNOMED 183240000, self-propelled wheelchair) and rivastigmine (`RxNorm 312836`), both retrieved, and the
  branch still evaluates false.
- **Our engine scores 410/410 on these same cases** (the existing MADiE gate, which covers all eight
  measures). So on these 23, ours matches the measure developer's expected answers and `cqf-fhir-cr`, as
  configured here, does not.

## What is NOT established — read this before quoting the number

- **The mechanism is NOT confirmed by construction, and a mutation proof was ATTEMPTED and FAILED.** This
  codebase's standard for a cause is a mutation that flips one case (ADR-055). The attempt: inject a hospice
  `Condition` — a branch Java demonstrably credits — into a failing subject on a **cold** server, expecting
  `DENEX` to flip to 1 and thereby isolate the failure to the Advanced-Illness-and-Frailty branch.

  **It did not flip.** The injected `Condition` was stored and searchable but never appeared in
  `evaluatedResource`, on a cold server, on repeated calls — while the *real* hospice case
  (`01c88972…`) evaluated correctly on that same server with its `Condition` present in `evaluatedResource`.
  So a hand-PUT resource is not picked up the way a bundle-loaded one is, for a reason not isolated here
  (candidate differences: the id form, `category` display, or something in the CR data-retrieval path).
  **Until that is understood, no mutation experiment on this harness can be trusted**, which is why the
  cause remains characterised rather than proven.
- **The two `Procedure`-only cases are unexplained** by the branch account, so there are likely two causes.
- **This does not show our engine is "correct" and the Java one "wrong."** It shows that on this artifact,
  this data and **this server configuration**, one implementation diverges from the expected results in a
  characterizable way. A stock HAPI container was used; no alternative CR settings were explored, and a
  configuration difference has not been ruled out.
- **Six of eight measures swept; CMS130 and CMS165 have no test cases checked out locally**, so they are
  unmeasured here. One server version (HAPI 8.10.0), one CR configuration.
- **A settled server matters and is not obvious.** `/metadata` returns 200 before the CR module is
  ready, and sweeping in that window produces wrong answers that look like engine divergence.
- The 66 cases are MADiE synthetic test patients, not real patient data.

## Why the finding is worth having anyway

The CMS7-FQR connectathon's own run compared the Java and JavaScript engines across **74 measures × 3,964
test cases** and found **98.16% pass with 3 measures still disputed**. Engine-level divergence on a small
number of cases is the known state of this ecosystem, and **the track's stated ask to participants is
exactly this: verify results on an alternate engine and help classify each discrepancy** into spec
clarification, tooling fix, content fix, or pattern change. This run is that contribution, and it is the
concrete thing to bring to M-E0.

## What we can now say that we could not yesterday

> WorkWell's official-measure execution has been reproduced by a second, independently written engine on
> **255 of 278 cases across six measures — three of them at 100%** — with every exception isolated to a
> single population, a single direction per measure, and a characterised (not yet proven) cause.

That is a stronger and more specific claim than the Cypress green ADR-058 retired — and unlike that one, it
was obtainable.

## The harness's own refusals, and which are proven

Four false-green paths were closed after review (#393). Three are **proven by execution**; one is not, and
saying which is which matters more than the count.

| refusal | proven? | how |
|---|---|---|
| server is not CR-enabled | **yes** | pointed at `https://hapi.fhir.org/baseR4` → refused, exit 1 |
| no cases discovered | **yes** | `--measure cms130`, whose tests are not checked out → refused, exit 1 |
| terminology partially loaded | **yes** (by construction) | `32/32` required; the run prints the ratio |
| every case returns an all-zero vector | **yes** | loaded the bundle with all 32 ValueSets stripped → all 66 all-zero → refused, exit 1 |

**All four have now been watched fire.** The all-zero one was induced by re-loading the measure bundle with
every ValueSet stripped: the Measure, Libraries and patients load, no code can match, and all 66 cases come
back all-zero. Without the guard that run would have reported partial agreement — the cases whose expected
vector is also all-zero would have "agreed" — which is exactly the false pass it exists to stop.

**Three of the four were false greens that the first version shipped**, and one repeats a defect this repo
already knew about: `POPULATION_CODES` carries a comment recording that the DENEXCEP omission was caught on
**#358**, and the first version of this script reintroduced it in a new file. The comparison now uses the
shared `classifyPopulationAgreement` rather than a local rule, which also narrows the CMS122 exemption to
the exact defect upstream has (one difference, on numerator, expected 0 vs actual 1) instead of exempting
those six cases wholesale.

**The corrected comparison did not change the result: still 56/66.** CMS125 declares no DENEXCEP and the
Java engine reported none, so the zero-initialisation changes nothing here — it will matter for CMS2 and
CMS68, which declare exception populations.

## Reproducing

```bash
docker run -d --name hapi-cr -p 8899:8080 \
  -e hapi.fhir.fhir_version=R4 -e hapi.fhir.cr.enabled=true \
  -e hapi.fhir.allow_external_references=true \
  -e hapi.fhir.enforce_referential_integrity_on_write=false \
  hapiproject/hapi:latest

curl -X POST http://localhost:8899/fhir -H "Content-Type: application/fhir+json" \
  --data-binary @backend-ts/.official-content/bundles/measure/CMS125FHIRBreastCancerScreen/CMS125FHIRBreastCancerScreen-bundle.json

cd backend-ts
corepack pnpm exec tsx scripts/cross-engine-check.ts --measure cms125 --load-terminology
```

**Not in CI**, and it must not be: it needs Docker, a JVM and a multi-minute server start. ADR-008 retired
the JVM from the product; this reintroduces it as a **dev-time oracle only** — never a runtime, packaged or
CI dependency.

## Next

1. Isolate the mechanism by construction — remove/alter the `MedicationRequest` on one disagreeing case and
   confirm the population flips, the way ADR-055's importer causes were proven.
2. Explain the two `Procedure`-only cases, which the medication hypothesis does not cover.
3. Sweep CMS122 (55 cases, and note `CMS122_KNOWN_BAD_EXPECTEDS` — 6 expecteds upstream itself flags wrong).
4. Take the classified discrepancies to the CMS7-FQR track (M-E0).
