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

test("execution diff: produces per-subject rows and a divergent count tied to the run", async () => {
  __clearExecutionDiffCache();
  const report = await computeExecutionDiff(CMS122V14, rows, {
    engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }),
    resolver: RESOLVER,
    employees: EMPLOYEES,
    today: "2026-06-30",
    asOf: "2026-06-30",
  });
  assert.equal(report.mode, "execution");
  assert.equal(report.runId, "run-1");
  assert.equal(report.subjects.length, rows.length);
  assert.ok(report.totalDivergent >= 1);
  for (const s of report.subjects.filter((x) => x.diverged)) assert.ok(s.divergenceGate.length > 0);
});

test("execution diff: memoized per run-id (second call reuses the cached report)", async () => {
  __clearExecutionDiffCache();
  const deps = { engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }), resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30" };
  const r1 = await computeExecutionDiff(CMS122V14, rows, deps);
  const r2 = await computeExecutionDiff(CMS122V14, rows, deps);
  assert.equal(r1, r2, "same object returned from cache for the same runId");
});
