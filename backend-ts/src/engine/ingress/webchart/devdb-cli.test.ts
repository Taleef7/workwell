/**
 * `evaluate:webchart-devdb` demo CLI (#246, PR-3) — structured-output test.
 *   node --import tsx --test src/engine/ingress/webchart/devdb-cli.test.ts
 *
 * The deterministic outcomes themselves are proven by `devdb-eval.test.ts`; here we only assert the CLI's
 * aggregation + rendering (bucket counts reconcile, the "real outcomes" headline is non-degenerate, and
 * every excluded measure is named — no silent caps).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDevDb, renderReport, DEVDB_WHITELIST, DEVDB_EXCLUDED } from "./devdb-cli.ts";

test("evaluateDevDb: per-measure bucket counts reconcile to the total, over the whole sample", async () => {
  const r = await evaluateDevDb({ evaluationDate: "2024-06-01" });
  assert.equal(r.population, 56);
  assert.deepEqual(
    r.whitelist.map((m) => m.measureId),
    DEVDB_WHITELIST,
  );
  for (const m of r.whitelist) {
    const summed = Object.values(m.counts).reduce((a, b) => a + b, 0);
    assert.equal(summed, m.total, `${m.measureId}: bucket counts must sum to total`);
    assert.equal(m.total, r.population, `${m.measureId}: every patient is evaluated`);
  }
});

test("evaluateDevDb: the sample produces real (non-MISSING_DATA) outcomes — the proof isn't degenerate", async () => {
  const r = await evaluateDevDb({ evaluationDate: "2024-06-01" });
  const nonMissing = r.whitelist.reduce((a, m) => a + (m.total - m.counts.MISSING_DATA), 0);
  // 31 after eCQI-faithful CMS125 (roster visit stamp + age 42–74 IPP): cms125 contributes 4 OVERDUE
  // age-in-band subjects (wc-8/36/45/47); the pre-eCQI total of 28 counted only the simplified
  // enrollment-gated path (including age-out wc-49).
  assert.equal(nonMissing, 31, `expected the deterministic dev-DB real-outcome total, got ${nonMissing}`);
  // at least one COMPLIANT and one OVERDUE somewhere across the whitelist
  assert.ok(r.whitelist.some((m) => m.counts.COMPLIANT > 0), "expected some COMPLIANT");
  assert.ok(r.whitelist.some((m) => m.counts.OVERDUE > 0), "expected some OVERDUE");
});

test("renderReport: names every excluded measure (no silent caps) + a real-outcomes headline", async () => {
  const out = renderReport(await evaluateDevDb({ evaluationDate: "2024-06-01" }));
  for (const m of DEVDB_EXCLUDED) assert.ok(out.includes(m), `report must name excluded measure ${m}`);
  assert.match(out, /real \(non-MISSING_DATA\) outcomes/);
  for (const m of DEVDB_WHITELIST) assert.ok(out.includes(m), `report must list whitelist measure ${m}`);
});
