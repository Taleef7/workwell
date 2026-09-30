# MADiE test patients end to end (#727)

**Result (2026-09-29): all 334 of the steward's test patients for the six Maui measures agree through the
whole pipeline, on SQLite and on Postgres.**

## What was checked

The official-cases gate (`OFFICIAL_TESTCASE_REPORT_2026-07.md`) proves the calculation, running each
steward test patient through `fqm-execution` in memory. This test drives the same patients through what
comes after:

- **The run:** one `ALL_PROGRAMS` run, as the nightly does, through `planManualRun` + `finishOrFail`.
  - Evaluation date: 2026-12-31.
  - It uses the vendored artifacts, the sidecar terminology and the runtime's own settings, including
    `preparedForQiCore` and cms165's `trustMetaProfile=true`.
- **The stores:** outcomes and cases are persisted in both the SQLite floor and the Postgres ceiling.
- **The read APIs:** the answers are asked of the endpoints the screens use.

Then:

- **Per patient, per rate:** the subject-list report shows the steward's initial population,
  denominator, exclusion, exception and numerator.
- **The roster:** the cell for the patient's own measure matches an oracle written from the population
  table. The other five measures read "not evaluated", so no measure leaks into another.
- **Cases:** a gap opens a case, an exclusion records a closed one, and compliant or out-of-population
  patients have none.
- **Programs overview:**
  - the buckets equal the summed steward results, with Due soon 0 and in-population missing 0;
  - each rate is numerator ÷ (denominator − exclusions − exceptions).
- **Run reconciliation:** one row per patient, no evaluation errors, and the out-of-population count.
- **Idempotency:** a second run writes no case event and changes no case. As a positive control, the
  first run's case events cover every case it created.
- **After the second run,** every check above runs again against the newer run. The report and the
  programs rate must read from it, so a surface that summed across runs or picked the older one fails.

The run uses the deployment's seeded, enabled segments, with every deck patient at one clinic. That is
closer to the nightly than the issue's `segments: []`, and it makes every patient applicable.

## Result per measure

| Measure | Patients | Compliant | Overdue | Excluded | Out of population |
|---|---|---|---|---|---|
| cms122 (inverse) | 55 | 1 | 25 | 25 | 4 |
| cms125 | 66 | 2 | 23 | 35 | 6 |
| cms2 | 36 | 14 | 7 | 13 | 2 |
| cms130 | 64 | 8 | 29 | 20 | 7 |
| cms165 | 68 | 2 | 27 | 38 | 1 |
| cms137 (2 rates, worst shown) | 45 | 6 | 25 | 9 | 5 |

The two risks the issue named were the runtime's `trustMetaProfile=true` for cms165 and
`preparedForQiCore` on the deck bundles. Neither changed a single patient's result.

## How to run it

The test needs all six measures' terminology sidecars (`pnpm vendor:official … --complete-terminology`,
with a VSAC key). Without them it skips and names what is missing. When the context is credentialed
(`WORKWELL_REQUIRE_OFFICIAL_TERMINOLOGY=true`), a missing sidecar fails the test instead.

- **SQLite:** `node --import tsx --test src/run/madie-end-to-end.test.ts`
- **Postgres:** `node --import tsx --test src/stores/postgres/madie-end-to-end-postgres.test.ts`. It needs
  a reachable Postgres and runs in a database of its own, which it drops afterwards.
- **CI:** both run in the "Official MADiE test cases" job.
- **`pnpm test`** also collects both files. They run wherever the sidecars are present and skip in the
  backend CI shards, which have none.

The test was mutation-checked by breaking the pipeline nine ways:

- cms122 read the right way round;
- an exception not treated as an exclusion;
- out-of-population counted in population;
- cms137 taking its best rate;
- the rate ignoring exceptions;
- the score ignoring exclusions;
- an exclusion recording no case;
- a re-confirm reading as a change;
- the report reading the older of two 2026 runs.

Each one fails the test and names the steward case.

## Not covered

- **Population shapes no steward deck holds.** No case in the six decks has any of these:
  - exception and numerator;
  - exclusion and numerator;
  - initial population without denominator;
  - a cms137 patient out of one rate's population but in the other's;
  - excluded on one rate only.

  So the end-to-end test cannot check how the pipeline handles them. `test-support/madie-oracle.test.ts`
  pins what the oracle expects for each, but that pins the specification, not the code.
- **One disagreement on such a shape, now decided.** Take a patient in both the exception and the numerator.
  - The rate counts them as meeting the numerator (`normalizeMembership`, following the QI-Core IG).
  - `outcomeFromPopulations` showed them as Excluded.

  The owner decided on 2026-09-29 that the screen follows the rate, and #732 makes that change. No deck
  holds that patient, so no current result moves.
- **Stratifiers:** the cms125, cms130 and cms137 decks carry expected stratifier results, and neither
  this test nor the gate compares them. That is a follow-up.
- **cms68, cms951 and cms138:** they stay in the in-memory gate only, because none is in a deployment's
  measure set.
