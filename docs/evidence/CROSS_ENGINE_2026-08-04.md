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
| Measure | CMS125FHIRBreastCancerScreen **v1.0.000** (upstream bundle, self-contained) |
| Cases | 66 MADiE test cases, `.official-content/input/tests/measure/…` |
| Period | 2026-01-01 .. 2026-12-31 (from the expected MeasureReports) |
| Terminology | **our completed expansions** (ADR-041 sidecar), pushed to the server |

The CR property is **`hapi.fhir.cr.enabled`**. With `cr_enabled` the server starts happily and simply
declares no measure operations — a silent no-op. The script now refuses to run unless the
CapabilityStatement lists `Measure/$evaluate-measure`, because otherwise every evaluate 404s and the sweep
reports a catastrophic "0 agreements" that is really a misconfigured container.

## Result

```text
cases      : 66
agreeing   : 56/66
disagreeing: 10  — ALL of them identical in direction
```

**Every one of the 10 is `denominator-exclusion: expected 1, java 0`.** No other population differs on any
case. IPP and DENOM agree on all 66.

## What is MEASURED

- **56/66 agreement between two independently written engines** on the same artifact, same cases, same
  terminology.
- **All 10 disagreements are one-directional**, in one population.
- **Terminology is EXCLUDED as the cause.** The first sweep used the upstream bundle's expansions, in which
  `…1003.110.12.1082` (AdvancedIllness) ships capped at 1000 of 1997 — the exact gap ADR-041 exists to
  close, and a natural suspect since it feeds a DENEX. Our completed expansions were pushed (32 value sets,
  **3043 codes**, matching ADR-041's recorded figure) and the server was **verified** to hold
  `expansion.total: 2000` for that OID. **The same 10 disagreed.** A tidy hypothesis, killed by measurement.
- **Strong correlation with `MedicationRequest`:** it appears in **8 of the 10 disagreeing** cases and in
  **0 of the 25 cases that agree with `DENEX = 1`**. The remaining 2 carry `Procedure` and no
  `MedicationRequest`.
- **Our engine scores 66/66 on these same cases** (the existing gate). So on these 10, ours matches the
  measure developer's expected answers and `cqf-fhir-cr`, as configured here, does not.

## What is NOT established — read this before quoting the number

- **The mechanism is not confirmed by construction.** 8-of-10 versus 0-of-25 is a strong correlation, not a
  demonstrated cause, and this codebase's standard for a cause is a mutation that flips one case (ADR-055).
  The two `Procedure`-only cases are unexplained by it entirely, so there are likely **two** causes.
- **This does not show our engine is "correct" and the Java one "wrong."** It shows that on this artifact,
  this data and **this server configuration**, one implementation diverges from the expected results in a
  characterizable way. A stock HAPI container was used; no alternative CR settings were explored, and a
  configuration difference has not been ruled out.
- **One measure, one server version, one run.** CMS122 and the six other gated measures have not been swept.
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
> 56 of 66 cases, with the 10 exceptions isolated to a single population, a single direction, and a
> characterized (not yet proven) cause.

That is a stronger and more specific claim than the Cypress green ADR-058 retired — and unlike that one, it
was obtainable.

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
