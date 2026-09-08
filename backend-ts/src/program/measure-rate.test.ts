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

test("reduces official evidence to per-rate counts, an effective denominator and a score; counts errors; memoizes", async () => {
  resetMeasureRateMemo();
  const rows = [
    rec("OVERDUE", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false })), // poor control
    rec("COMPLIANT", official({ ipp: true, denom: true, numer: false, denex: false, denexcep: false })),
    rec("EXCLUDED", official({ ipp: true, denom: true, numer: false, denex: true, denexcep: false })),
    rec("MISSING_DATA", official({ ipp: false, denom: false, numer: false, denex: false, denexcep: false })),
    rec("MISSING_DATA", { evaluationError: "engine threw", message: "boom" }),
  ];
  let calls = 0;
  const os = {
    listOutcomes: async (_runId: string, opts?: { limit?: number; offset?: number }) => {
      calls++;
      const offset = opts?.offset ?? 0;
      return rows.slice(offset, offset + (opts?.limit ?? rows.length));
    },
  };
  const rate = await officialMeasureRate(os, "run-1", "cms122");
  assert.ok(rate);
  assert.equal(rate.source, "official-evidence");
  assert.deepEqual(rate.rates, [{ label: null, ipp: 3, denom: 3, denex: 1, denexcep: 0, numer: 1, effectiveDenominator: 2, score: 0.5 }]);
  assert.equal(rate.evaluationErrors, 1);
  assert.equal(rate.unmeasured, 1, "an errored subject is in no rate, so it is unmeasured as well as an error");
  const before = calls;
  const again = await officialMeasureRate(os, "run-1", "cms122");
  assert.equal(again, rate, "memoized per immutable terminal run");
  assert.equal(calls, before, "the memo hit reads nothing");
});

test("a run with no official evidence has no measure rate (null), never a status-bucket stand-in", async () => {
  resetMeasureRateMemo();
  const os = { listOutcomes: async () => [rec("COMPLIANT", { expressionResults: [] }, "audiogram")] };
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
  const os = { listOutcomes: async () => [rec("OVERDUE", two, "cms137")] };
  const rate = await officialMeasureRate(os, "run-3", "cms137");
  assert.deepEqual(rate?.rates.map((r) => [r.label, r.numer, r.effectiveDenominator]), [["Initiation", 1, 1], ["Engagement", 0, 1]]);
});
