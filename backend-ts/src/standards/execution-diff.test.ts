import { test } from "node:test";
import assert from "node:assert/strict";
import { computeExecutionDiff, __clearExecutionDiffCache } from "./execution-diff.ts";
import { CMS122_DIABETES_OID, CMS122_HBA1C_OID, CMS122_QUALIFYING_VISIT_OIDS, CMS122_HOSPICE_OID, CMS122_PALLIATIVE_OID } from "./cms122-official.ts";
import { CMS122V14 } from "./references/cms122v14.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { ValueSetResolver } from "../engine/cql/value-set-resolver.ts";

const RESOLVER: ValueSetResolver = {
  expand: (oid) =>
    Promise.resolve(
      oid === CMS122_DIABETES_OID ? [{ code: "44054006", system: "http://snomed.info/sct" }]
      : oid === CMS122_HBA1C_OID ? [{ code: "4548-4", system: "http://loinc.org" }]
      : oid === CMS122_QUALIFYING_VISIT_OIDS[0] ? [{ code: "99213", system: "http://www.ama-assn.org/go/cpt" }]
      : oid === CMS122_HOSPICE_OID ? [{ code: "183919006", system: "http://snomed.info/sct" }]
      : oid === CMS122_PALLIATIVE_OID ? [{ code: "103735009", system: "http://snomed.info/sct" }]
      : [],
    ),
};

const rows = EMPLOYEES.slice(0, 40).map((e) => ({ subjectId: e.externalId, status: "MISSING_DATA", runId: "run-1", runStartedAt: "2026-06-30T00:00:00Z" }));

test("execution diff: produces per-subject rows; production cms122 is parity-aligned with the official subset", async () => {
  // Since the 2026-07 production-faithful promotion, production `cms122` and the diagnostic
  // official-subset evaluate the same ELM (DiabetesHbA1cPoorControlCQL-2.0.0) on the same enriched
  // bundle → totalDivergent is 0 (parity regression). Residual divergence is only possible if a
  // mock engine injects it (see GMI / error tests below).
  __clearExecutionDiffCache();
  const report = await computeExecutionDiff(CMS122V14, rows, {
    engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }),
    resolver: RESOLVER,
    employees: EMPLOYEES,
    today: "2026-06-30",
    asOf: "2026-06-30",
  });
  assert.equal(report.mode, "subset");
  assert.equal(report.runId, "run-1");
  assert.equal(report.subjects.length, rows.length);
  assert.equal(report.totalDivergent, 0, "production cms122 is the eCQI faithful-subset — expect parity");
  assert.equal(report.totalErrors, 0);
  assert.ok(report.subjects.every((s) => !s.diverged && s.divergenceGate === ""));
  assert.match(report.headline, /0 would have a different outcome/);
});

test("execution diff: per-subject evaluation failures surface in totalErrors, not divergence (Codex P2)", async () => {
  __clearExecutionDiffCache();
  // An engine that throws for the official measure on every subject → all rows are ERROR/non-divergent.
  const throwingEngine = {
    evaluate: (input: { measureId: string }) =>
      input.measureId === "cms122_official"
        ? Promise.reject(new Error("official CQL evaluation failed"))
        : Promise.resolve({ outcome: "COMPLIANT", evidence: { expressionResults: [] } }),
  };
  const report = await computeExecutionDiff(CMS122V14, rows, {
    engine: throwingEngine,
    resolver: RESOLVER,
    employees: EMPLOYEES,
    today: "2026-06-30",
    asOf: "2026-06-30",
  });
  assert.equal(report.totalErrors, rows.length, "every failed subject is counted as an error");
  assert.equal(report.totalDivergent, 0, "failed subjects are never counted as divergent");
  assert.ok(report.subjects.every((s) => s.officialOutcome === "ERROR" && !s.diverged));
  assert.match(report.headline, /failed to evaluate/);
});

test("execution diff: a GMI-driven official numerator attributes to gmi-poor-control, not workwell-side (Codex P2)", async () => {
  __clearExecutionDiffCache();
  // Official OVERDUE via a poor GMI (all gates pass, glycemic assessment NOT missing); WorkWell can't see
  // the GMI so it buckets the subject COMPLIANT → divergence must be labeled gmi-poor-control.
  const gmiEngine = {
    evaluate: (input: { measureId: string }) =>
      input.measureId === "cms122_official"
        ? Promise.resolve({
            outcome: "OVERDUE",
            evidence: {
              expressionResults: [
                { define: "Age 18 To 75", result: true },
                { define: "Has Qualifying Visit", result: true },
                { define: "Has Diabetes", result: true },
                { define: "Has Hospice", result: false },
                { define: "Has Palliative", result: false },
                { define: "Glycemic Assessment Missing", result: false },
              ],
            },
          })
        : Promise.resolve({ outcome: "COMPLIANT", evidence: { expressionResults: [] } }),
  };
  const report = await computeExecutionDiff(CMS122V14, rows, {
    engine: gmiEngine, resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30",
  });
  assert.ok(report.totalDivergent >= 1);
  assert.ok(report.subjects.every((s) => s.diverged && s.divergenceGate === "gmi-poor-control"));
  assert.equal(report.byGate["gmi-poor-control"], report.totalDivergent);
  assert.equal(report.byGate["workwell-side"], undefined, "GMI numerator is no longer mislabeled workwell-side");
});

test("execution diff: memoized per run-id (second call reuses the cached report)", async () => {
  __clearExecutionDiffCache();
  const deps = { engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }), resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30" };
  const r1 = await computeExecutionDiff(CMS122V14, rows, deps);
  const r2 = await computeExecutionDiff(CMS122V14, rows, deps);
  assert.equal(r1, r2, "same object returned from cache for the same runId");
});
