/** Compliance-simulation route — pure synthetic, no DB. node --import tsx --test src/routes/compliance-simulation.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { handleComplianceSimulation } from "./compliance-simulation.ts";

const ID = EMPLOYEES[0]!.externalId;
const call = (path: string, method = "GET") => handleComplianceSimulation(new Request(`http://x${path}`, { method }));

test("non-matching path / method returns null", async () => {
  assert.equal(await call("/api/employees/x/profile"), null);
  assert.equal(await call(`/api/employees/${ID}/simulate`, "POST"), null);
});

test("GET …/simulate → { externalId, asOf, evaluations[] } for every measure (asOf defaults to today)", async () => {
  const res = (await call(`/api/employees/${ID}/simulate`))!;
  assert.equal(res.status, 200);
  const body = (await res.json()) as { externalId: string; asOf: string; evaluations: Array<{ measureId: string; status: string; method: string }> };
  assert.equal(body.externalId, ID);
  assert.match(body.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.evaluations.length, Object.keys(MEASURES).length);
});

test("explicit asOf is echoed", async () => {
  const res = (await call(`/api/employees/${ID}/simulate?asOf=2030-01-01`))!;
  const body = (await res.json()) as { asOf: string };
  assert.equal(body.asOf, "2030-01-01");
});

test("malformed asOf → 400", async () => {
  const res = (await call(`/api/employees/${ID}/simulate?asOf=2026-13-99`))!;
  assert.equal(res.status, 400);
});

test("unknown employee → 404", async () => {
  const res = (await call("/api/employees/nobody-999/simulate"))!;
  assert.equal(res.status, 404);
});
