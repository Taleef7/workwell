/**
 * The dashboard's measure rate is the run's official evidence reduced by the SAME aggregator the
 * MeasureReport uses — not a second reducer, and not the workflow-status buckets (ADR-077 d5).
 *   node --import tsx --test src/program/measure-rate.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import { officialMeasureRate, resetMeasureRateMemo } from "./measure-rate.ts";

const official = (populationResults: Record<string, boolean>) => ({ official: { populationResults } });
let n = 0;
const rec = (status: string, evidence: Record<string, unknown>, measureId = "cms122"): OutcomeRecord =>
  ({ id: `o-${++n}`, runId: "run-1", subjectId: `p-${n}`, measureId, evaluationPeriod: "2026", status, evidence, evaluatedAt: "2026-06-01T00:00:00.000Z" });

/**
 * A fake `listOutcomeMembershipsForRun` that NARROWS exactly as the real stores do, and counts calls.
 *
 * The narrowing matters. `evidence_json` also carries `expressionResults`, and the aggregate no longer
 * reads it — review of #610 found that the unpaged full read had lost the memory bound, so the read is
 * a projection rather than a page window. A fake returning whole records would be gentler than the
 * shipped query, and the one thing it would stop these tests noticing is a reader reaching for a field
 * the projection does not carry.
 *
 * It honours `measureId` for the same reason: the real stores push it into SQL.
 */
function membershipStore(rows: OutcomeRecord[]) {
  const store = {
    calls: 0,
    listOutcomeMembershipsForRun: async (_runId: string, measureId: string) => {
      store.calls++;
      return rows
        .filter((r) => r.measureId === measureId)
        .map((r) => {
          const full = r.evidence as Record<string, unknown>;
          const evidence: Record<string, unknown> = {};
          if (full?.official !== undefined && full.official !== null) evidence.official = full.official;
          if (full && "evaluationError" in full) evidence.evaluationError = full.evaluationError;
          return { status: r.status, evidence };
        });
    },
  };
  return store;
}

test("reduces official evidence to per-rate counts, an effective denominator and a score; counts errors; memoizes", async () => {
  resetMeasureRateMemo();
  const rows = [
    rec("OVERDUE", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false })), // poor control
    rec("COMPLIANT", official({ ipp: true, denom: true, numer: false, denex: false, denexcep: false })),
    rec("EXCLUDED", official({ ipp: true, denom: true, numer: false, denex: true, denexcep: false })),
    rec("MISSING_DATA", official({ ipp: false, denom: false, numer: false, denex: false, denexcep: false })),
    rec("MISSING_DATA", { evaluationError: "engine threw", message: "boom" }),
  ];
  const os = membershipStore(rows);
  const rate = await officialMeasureRate(os, "run-1", "cms122");
  assert.ok(rate);
  assert.equal(rate.source, "official-evidence");
  assert.deepEqual(rate.rates, [{ label: null, ipp: 3, denom: 3, denex: 1, denexcep: 0, numer: 1, effectiveDenominator: 2, score: 0.5 }]);
  assert.equal(rate.evaluationErrors, 1);
  assert.equal(rate.unmeasured, 1, "an errored subject is in no rate, so it is unmeasured as well as an error");
  const before = os.calls;
  const again = await officialMeasureRate(os, "run-1", "cms122");
  assert.equal(again, rate, "memoized per immutable terminal run");
  assert.equal(os.calls, before, "the memo hit reads nothing");
});

test("a run with no official evidence has no measure rate (null), never a status-bucket stand-in", async () => {
  resetMeasureRateMemo();
  const os = membershipStore([rec("COMPLIANT", { expressionResults: [] }, "audiogram")]);
  assert.equal(await officialMeasureRate(os, "run-2", "audiogram"), null);
});

test("a multi-rate measure carries its reviewed rate labels", async () => {
  resetMeasureRateMemo();
  const two = {
    official: {
      populationResults: { ipp: true, denom: true, numer: true, denex: false, denexcep: false },
      rates: [
        { ipp: true, denom: true, numer: true, denex: false, denexcep: false },
        { ipp: true, denom: true, numer: false, denex: false, denexcep: false },
      ],
    },
  };
  const os = membershipStore([rec("OVERDUE", two, "cms137")]);
  const rate = await officialMeasureRate(os, "run-3", "cms137");
  assert.deepEqual(rate?.rates.map((r) => [r.label, r.numer, r.effectiveDenominator]), [["Initiation", 1, 1], ["Engagement", 0, 1]]);
});

test("an ALL_PROGRAMS run is read PER MEASURE — each measure's rate is its own rows, not the run's sum", async () => {
  resetMeasureRateMemo();
  // One nightly run, two measures, one row per (subject, measure) pair — the pilot's shape since the
  // 2026-09-08 flip. Before the scan was measure-scoped, both cards showed the summed aggregate and
  // whichever `ecqmId` sorted first, so CMS125's 59.2% was served under CMS122's name.
  const rows = [
    rec("OVERDUE", { official: { ecqmId: "122FHIR", populationResults: { ipp: true, denom: true, numer: true, denex: false, denexcep: false } } }, "cms122"),
    rec("COMPLIANT", { official: { ecqmId: "122FHIR", populationResults: { ipp: true, denom: true, numer: false, denex: false, denexcep: false } } }, "cms122"),
    rec("COMPLIANT", { official: { ecqmId: "125FHIR", populationResults: { ipp: true, denom: true, numer: true, denex: false, denexcep: false } } }, "cms125"),
    rec("COMPLIANT", { official: { ecqmId: "125FHIR", populationResults: { ipp: true, denom: true, numer: true, denex: false, denexcep: false } } }, "cms125"),
    rec("COMPLIANT", { official: { ecqmId: "125FHIR", populationResults: { ipp: true, denom: true, numer: true, denex: false, denexcep: false } } }, "cms125"),
  ];
  // The fake honours `measureId` because the real stores push it into SQL; a fake that ignored it would
  // pass while the shipped query narrowed, which is the harness being gentler than the caller.
  const os = membershipStore(rows);
  const a = await officialMeasureRate(os, "run-mixed", "cms122");
  const b = await officialMeasureRate(os, "run-mixed", "cms125");
  assert.deepEqual(a?.rates.map((r) => [r.ipp, r.numer]), [[2, 1]], "cms122 sees only its own two rows");
  assert.deepEqual(b?.rates.map((r) => [r.ipp, r.numer]), [[3, 3]], "cms125 sees only its own three rows");
  assert.equal(a?.official?.ecqmId, "122FHIR");
  assert.equal(b?.official?.ecqmId, "125FHIR", "the artifact identity is the measure's, not the first row of the run");
});

test("ONE read per (run, measure), unordered — the shape the statement timeout forced (2026-09-21)", async () => {
  resetMeasureRateMemo();
  // Until now this path asked `runProducedOfficialEvidence` and then aggregated: two reads of the same
  // rows, the second a LIMIT/OFFSET walk that re-sorted the measure's whole evidence per page. On the
  // pilot's 20,000-patient measures that was the statement the 30 s role default cancelled, and
  // `/api/programs/overview` answered 503.
  const rows = [
    rec("OVERDUE", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }), "cms122"),
    rec("COMPLIANT", official({ ipp: true, denom: true, numer: false, denex: false, denexcep: false }), "cms122"),
  ];
  const os = membershipStore(rows);
  const rate = await officialMeasureRate(os, "run-one-read", "cms122");
  assert.deepEqual(rate?.rates.map((r) => [r.ipp, r.numer]), [[2, 1]]);
  assert.equal(os.calls, 1, "one read, not a probe plus a page walk");
});

test("an ERRORED row first still settles provenance from the first EVALUATED row", async () => {
  resetMeasureRateMemo();
  // `listOutcomes` used to order by `(evaluated_at, id)`, and an evaluation failure REPLACES the
  // evidence with `{ evaluationError }` — so an errored row sorting first once sent a whole official
  // run down the authored path. Unordered reads make row order arbitrary rather than adverse, which is
  // strictly more reason for the rule to hold: the FIRST EVALUATED row decides, wherever it lands.
  const rows = [
    rec("MISSING_DATA", { evaluationError: "engine threw", message: "boom" }, "cms122"),
    rec("OVERDUE", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }), "cms122"),
  ];
  const os = membershipStore(rows);
  const rate = await officialMeasureRate(os, "run-err-first", "cms122");
  assert.ok(rate, "an errored row carries no engine's evidence and must not read as 'not official'");
  assert.equal(rate.evaluationErrors, 1);
  assert.deepEqual(rate.rates.map((r) => [r.ipp, r.numer]), [[1, 1]]);
});

test("a run whose EVERY row errored has no rate, and says so rather than reporting zeros", async () => {
  resetMeasureRateMemo();
  const os = membershipStore([rec("MISSING_DATA", { evaluationError: "boom" }, "cms122")]);
  assert.equal(await officialMeasureRate(os, "run-all-err", "cms122"), null);
  // THE NEGATIVE IS MEMOIZED, and it has to be (review of #610). It used to cost one row
  // (`runProducedOfficialEvidence` with LIMIT 1), so leaving it uncached was free; it now costs the
  // measure's whole membership set, and `programOverview` runs this loop per request OUTSIDE its own
  // memo. An un-memoized null would therefore have re-read every row of that measure on every
  // dashboard load for the life of the process — the statement-timeout cliff this change exists to
  // remove, reintroduced by the change itself.
  const after = os.calls;
  assert.equal(await officialMeasureRate(os, "run-all-err", "cms122"), null);
  assert.equal(os.calls, after, "the second ask reads nothing");
});
