/** simulateComplianceAsOf — pure, in-memory, no DB. Proves today-anchoring (scrubbing the date
 * actually changes RECURRING outcomes while PERMANENT stay constant).
 *   node --import tsx --test src/run/employee-compliance-snapshot.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { seededTargetFor } from "./distribution.ts";
import { simulateComplianceAsOf } from "./employee-compliance-snapshot.ts";

const engine = new CqlExecutionEngine();
const TODAY = "2026-06-24";
const FUTURE = "2036-06-24"; // +10y — past any RECURRING window

// An employee whose audiogram is seeded COMPLIANT today (so +10y must flip it to OVERDUE).
const emp = EMPLOYEES.find((e) => seededTargetFor(EMPLOYEES, "audiogram", e.externalId) === "COMPLIANT")!;

test("snapshot covers every runnable measure with a valid display state", async () => {
  const snap = await simulateComplianceAsOf(emp.externalId, TODAY, { engine, today: TODAY });
  assert.ok(snap);
  assert.equal(snap!.externalId, emp.externalId);
  assert.equal(snap!.asOf, TODAY);
  assert.equal(snap!.evaluations.length, Object.keys(MEASURES).length);
  for (const ev of snap!.evaluations) {
    assert.ok(typeof ev.method === "string");
    assert.ok(["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED", "DECLINED", "IN_PROGRESS", "NA"].includes(ev.status));
  }
});

test("scrubbing the date forward ages a RECURRING measure but leaves PERMANENT unchanged", async () => {
  const now = await simulateComplianceAsOf(emp.externalId, TODAY, { engine, today: TODAY });
  const future = await simulateComplianceAsOf(emp.externalId, FUTURE, { engine, today: TODAY });
  const audNow = now!.evaluations.find((e) => e.measureId === "audiogram")!;
  const audFuture = future!.evaluations.find((e) => e.measureId === "audiogram")!;
  assert.equal(audNow.status, "COMPLIANT");        // seeded compliant at "today"
  assert.equal(audFuture.status, "OVERDUE");       // today-anchored exam is now >10y old
  const mmrNow = now!.evaluations.find((e) => e.measureId === "mmr")!;
  const mmrFuture = future!.evaluations.find((e) => e.measureId === "mmr")!;
  assert.equal(mmrNow.status, mmrFuture.status);   // PERMANENT (series-completion) is date-invariant
});

test("unknown employee → null", async () => {
  assert.equal(await simulateComplianceAsOf("nobody-999", TODAY, { engine, today: TODAY }), null);
});
