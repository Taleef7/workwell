# CMS137 through a second engine — the first multi-rate artifact cross-executed, and its one disagreement run to a cause

Date: 2026-09-06. **MM-1c's second-engine sweep for CMS137** (`docs/ROADMAP_2026-08-30.md` §5; the pattern
of `CROSS_ENGINE_2026-08-04.md`). Command: `backend-ts/scripts/cross-engine-check.ts --measure cms137 --load-terminology`.

## What was run

| | |
|---|---|
| Engine | `cqf-fhir-cr` via HAPI FHIR Server **8.10.0** (`hapiproject/hapi:latest`, image `v8.10.0-1`, the same local image as the 2026-08-04 run), Docker, one fresh container per sweep |
| Artifact | `CMS137FHIRSUDTxInitEngagement` v1.0.000, upstream bundle at content commit `ca4b4951…22ab` (Measure + 7 Libraries + 28 ValueSets + 45 test patients + expected MeasureReports, one transaction) |
| Cases | **45** MADiE test cases, `.official-content/input/tests/measure/CMS137FHIRSUDTxInitEngagement/` |
| Period | `2026-01-01 .. 2026-12-31`, read from the expected reports; Java's own report says `2026-01-01T00:00:00+00:00 .. 2026-12-31T23:59:59+00:00` |
| Terminology | our vendored sidecar (`measures/official/cms137/terminology.json`, manifest pin, no capped expansions), pushed as every ValueSet's expansion **before the first evaluation** — 28/28 replaced |
| Comparison | **every group**, through the shared classifier (`src/standards/cross-engine.ts`, `compareReports` → `classifyPopulationAgreement` with `rates`). Until today the script read `group[0]` of each report — Initiation alone |

## Result

**44 of 45 cases agree on both rates.** Every one of the eight steward cases where Initiation and
Engagement disagree — the initiated-but-not-engaged patients ADR-074 exists for — agrees on both rates in
both engines. Our runtime (`fqm-execution`) is 45/45 against the same deck (the MADiE gate), so the one
case is Java against MADiE's expectation, not ours against Java.

| | rate 1 (Initiation) | rate 2 (Engagement) |
|---|---|---|
| Agreeing cases | 44 | 44 |
| Disagreeing | 1 — `044ba9ba…` "IPPass DetoxVisit": expected IPP 1, DENOM 1; Java IPP 0, DENOM 0 | the same case, the same shape |

## The cause, established by construction (ADR-055's standard)

The case is a 14-year-old whose only encounter is a detoxification visit with
`period.start = 2026-01-01T00:00:00.000+00:00` — the **first millisecond of the measurement period** — and
an encounter diagnosis of alcohol abuse with onset an hour later. The initial population requires
`ValidEncounters.period during "Measurement Period"`.

Two hypotheses fit at first: the Java engine builds the period in a non-UTC zone (so `00:00Z` is
31 December local), or it compares the encounter's millisecond-precision start against a
second-precision period start and, per CQL's uncertainty rules for DateTimes of differing precision,
gets `null` where the JS engine gets `true`. Java's own report answers the first — the period is
`+00:00`, at **second** precision — and the first mutation answers the second: on a **fresh** container
(`$evaluate-measure` caches per subject for the server's life), the same encounter with
`period.start = 2026-01-01T00:00:01.000+00:00` — one second later, everything else identical — puts
the patient in the initial population of both rates, and the sweep reads **45/45**.

So: **on this artifact, in this configuration, the Java engine excludes an encounter that starts at the
period's first instant and admits one that starts a second later.** That is a characterisation, not a
verdict on which engine is right. The likeliest mechanism is CQL's comparison semantics for DateTimes
of differing precision — equal at the finest shared precision but more precise on one side is an
*uncertain* comparison — on the Java side alone: `fqm-execution` builds the period at millisecond
precision (`DateTime.fromJSDate(start, 0)`), so the JS comparison is at equal precision and exact, and
there is no uncertainty for it to resolve. MADiE's expected vector agrees with the JS reading.

**The second mutation isolates the mechanism.** The one-second shift is consistent with a
millisecond-versus-second precision null, but equally with a coarser Java period (day precision from
`periodStart=2026-01-01`) or a strict lower bound. So, on another fresh container, the encounter start
was rewritten as `2026-01-01T00:00:00+00:00` — **the same instant, at second precision, no
milliseconds** — with nothing else changed. Java admits the patient to both rates and the sweep reads
**45/45**. A coarser period or a strict bound would have excluded that too; only a precision mismatch
between `.000` and the period's second-precision start explains the pair of results. The Java side
compares an encounter starting at `00:00:00.000` against a period starting at `00:00:00` as
uncertain, and the same encounter at `00:00:00` as included.

| Encounter `period.start` | Java IPP / DENOM (both rates) | Sweep |
|---|---|---|
| `2026-01-01T00:00:00.000+00:00` (the steward's case) | 0 / 0 | 44/45 |
| `2026-01-01T00:00:01.000+00:00` (one second later) | 1 / 1 | 45/45 |
| `2026-01-01T00:00:00+00:00` (same instant, second precision) | 1 / 1 | 45/45 |

Each row is a fresh container with the bundle reloaded and the terminology pushed before the first
evaluation, because `$evaluate-measure` caches per subject for the server's life.

## What it means for the pilot

- **Nothing in this changes a number we report.** The runtime engine and the steward's expectations agree
  on all 45 cases; the divergence is in the second opinion, on one synthetic boundary case.
- **The shape is worth knowing.** A real encounter timestamped at exactly `00:00:00.000` on 1 January is
  rare but not impossible (a midnight admission). The runtime, following the JS engine, would count it;
  a QRDA consumer re-computing with a Java engine at second precision might not. Recorded here so that if
  a PY2027 count is ever disputed to the minute, the boundary is the first place to look.
- The period Java reports ends at `23:59:59`, not `23:59:59.999`; an encounter ending in the last second
  of the year is the mirror case. Not exercised by this deck.

## Limits — read before citing

1. One stock HAPI configuration, one server version, no alternative CR settings.
2. Synthetic MADiE patients, not real patient data; 45 cases.
3. cms130 and cms165 remain **unmeasured cross-engine**: their vendored sidecars are VSAC-completed and the
   uncredentialed vendor cannot produce them locally, so a sweep here would run on the upstream bundle's
   capped expansions — an ambiguous comparison the 2026-08-04 run showed is not one of engines.
4. CMS2's seven `NUMER 1→0` disagreements (2026-08-04) are unchanged and still without a cause.

Running total across the measures cross-executed to date: **299 of 323 cases agree across seven measures**
(255/278 on 2026-08-04, 44/45 today); 45 of the 323 are multi-rate cases compared on every rate.
