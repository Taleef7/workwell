/**
 * Orders route (#77 E7): seed an audiogram population run + outcomes (OVERDUE + COMPLIANT),
 * then assert GET /api/orders/proposals returns proposals for at-risk subjects only.
 *   node --import tsx --test src/routes/orders.test.ts
 *
 * Harness mirrors hierarchy.test.ts exactly: real SQLite D1 + SqliteRunStore/OutcomeStore.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { handleOrders } from "./orders.ts";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const dbPath = join(tmpdir(), `workwell-orders-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
const get = (qs = "") => handleOrders(new Request(`http://x/api/orders/proposals${qs}`, { method: "GET" }), env as never);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  // Seed a population (ALL_PROGRAMS) run with one at-risk and one compliant subject.
  // Finalize to COMPLETED so the terminal-run filter includes it.
  const run = await runStore.createRun({
    scopeType: "ALL_PROGRAMS",
    scopeId: undefined,
    triggeredBy: "test",
    requestedScope: {},
    measurementPeriodStart: "2026-06-19T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-19T00:00:00.000Z",
  });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-007", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  // Two more at-risk subjects, so the windowing test has a set to page.
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-008", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-013", measureId: "audiogram", status: "DUE_SOON", evidence: {} });
  // #616: the old default invented an audiogram standing order for emp-014 (from a hash of its id), so
  // this proposal was withheld. It holds the route to proposing it.
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-014", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  // #546: two patients whose official evaluation persisted MISSING_DATA (ADR-078) — one INSIDE
  // cms122's initial population and one outside, as the run recorded it (ADR-079). Only the first is
  // at risk of anything.
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-020", measureId: "cms122", status: "MISSING_DATA", evidence: {}, outOfPopulation: false });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-021", measureId: "cms122", status: "MISSING_DATA", evidence: {}, outOfPopulation: true });
  await runStore.finalizeRun(run.id, "COMPLETED");
});

after(() => {
  try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
});

test("returns domain proposals for at-risk outcomes (default format)", async () => {
  const res = await get("");
  assert.equal(res!.status, 200);
  const body = await res!.json() as { proposed: Array<{ subjectId: string }>; suppressed: Array<{ subjectId: string }> };
  assert.ok(Array.isArray(body.proposed));
  // emp-006 is OVERDUE → proposed; emp-007 is COMPLIANT → neither proposed nor suppressed
  assert.ok(!body.proposed.some((p) => p.subjectId === "emp-007"), "COMPLIANT subject must not be proposed");
  assert.ok(!body.suppressed.some((p) => p.subjectId === "emp-007"), "COMPLIANT subject must not be suppressed");
  assert.ok(body.proposed.some((p) => p.subjectId === "emp-006"), "at-risk subject is proposed");
});

test("#616: with no order source connected, no proposal is withheld and the answer says nothing was checked", async () => {
  const body = (await get("").then((r) => r!.json())) as {
    proposed: Array<{ subjectId: string }>;
    suppressed: unknown[];
    totals: { proposed: number; suppressed: number };
    standingOrdersChecked: boolean;
  };
  // The invented standing orders withheld 46 at-risk patients on the pilot, and emp-014 here.
  assert.deepEqual(body.suppressed, []);
  assert.equal(body.totals.suppressed, 0);
  assert.deepEqual(body.proposed.map((p) => p.subjectId).sort(), ["emp-006", "emp-008", "emp-013", "emp-014", "emp-020"], "every at-risk subject is proposed, emp-014 included");
  assert.equal(body.standingOrdersChecked, false, "orders already on the chart were not looked at, and the page is told so");
  // The FHIR bundle carries the same proposals: none left out behind an order that does not exist.
  const fhir = (await get("?format=fhir").then((r) => r!.json())) as { entry?: unknown[] };
  assert.equal((fhir.entry ?? []).length, 5);
});

test("the domain view carries totals, and ?limit/?offset window both lists without changing the totals", async () => {
  const whole = (await get("").then((r) => r!.json())) as { proposed: unknown[]; suppressed: unknown[]; totals: { proposed: number; suppressed: number } };
  assert.deepEqual(whole.totals, { proposed: whole.proposed.length, suppressed: whole.suppressed.length }, "no window → whole arrays, totals alongside");
  // emp-006/008/013/014 on audiogram, plus emp-020 — the cms122 patient who IS in the population.
  // emp-021 is the same status on the same measure and is absent, which is the #546 rule.
  assert.equal(whole.totals.proposed + whole.totals.suppressed, 5, "the five at-risk subjects, and not the out-of-population one");
  assert.ok(whole.totals.proposed >= 2, "fixture: at least two proposals (else the paging and FHIR assertions below are vacuous)");
  const ids = (xs: Array<{ subjectId: string }>) => xs.map((x) => x.subjectId);
  assert.deepEqual(ids(whole.proposed as Array<{ subjectId: string }>), [...ids(whole.proposed as Array<{ subjectId: string }>)].sort(), "proposals are in subject order, so a page is a page");

  const page = (await get("?limit=1&offset=0").then((r) => r!.json())) as typeof whole;
  assert.deepEqual(page.totals, whole.totals, "the window never changes the totals");
  assert.deepEqual(page.proposed, whole.proposed.slice(0, 1), "page 1 is the first of the whole, in the same order");
  assert.deepEqual(page.suppressed, whole.suppressed.slice(0, 1));
  const second = (await get("?limit=1&offset=1").then((r) => r!.json())) as typeof whole;
  assert.deepEqual(second.proposed, whole.proposed.slice(1, 2), "page 2 is the second — no duplicate, no omission");
  const past = (await get("?limit=1&offset=5").then((r) => r!.json())) as typeof whole;
  assert.deepEqual([past.proposed, past.suppressed], [[], []], "past the end → empty pages, same totals");
  assert.deepEqual(past.totals, whole.totals);

  for (const qs of ["?limit=0", "?limit=1001", "?limit=x", "?limit=10&offset=-1", "?offset=1.5", "?limit=0x10", "?limit=1e1"]) {
    assert.equal((await get(qs))!.status, 400, `${qs} is refused rather than served as a silently different page`);
  }
  const fhir = (await get("?format=fhir&limit=1&offset=5").then((r) => r!.json())) as { entry?: unknown[] };
  assert.equal((fhir.entry ?? []).length, whole.totals.proposed, "the FHIR bundle is never windowed");
});

test("format=fhir returns a ServiceRequest Bundle", async () => {
  const res = await get("?format=fhir");
  assert.equal(res!.status, 200);
  const body = await res!.json() as { resourceType: string; type: string };
  assert.equal(body.resourceType, "Bundle");
  assert.equal(body.type, "collection");
});

test("400 on malformed from date", async () => {
  const res = await get("?from=2026-13-99");
  assert.equal(res!.status, 400);
});

test("falls through (null) on non-match path", async () => {
  assert.equal(await handleOrders(new Request("http://x/api/other", { method: "GET" }), env as never), null);
});

test("falls through (null) on non-GET method", async () => {
  assert.equal(await handleOrders(new Request("http://x/api/orders/proposals", { method: "POST" }), env as never), null);
});

test("measureId filter: unknown Active measure returns empty lists", async () => {
  const res = await get("?measureId=does-not-exist");
  assert.equal(res!.status, 200);
  const body = await res!.json() as { proposed: unknown[]; suppressed: unknown[] };
  assert.equal(body.proposed.length, 0);
  assert.equal(body.suppressed.length, 0);
});

test("subjectId filter narrows to that subject", async () => {
  // emp-006 (OVERDUE) → proposed, alone; emp-007 (COMPLIANT) → empty
  const r6 = await get("?subjectId=emp-006");
  const b6 = await r6!.json() as { proposed: Array<{ subjectId: string }>; suppressed: Array<{ subjectId: string }> };
  assert.deepEqual(b6.proposed.map((p) => p.subjectId), ["emp-006"], "only emp-006 should be present");
  assert.deepEqual(b6.suppressed, []);

  const r7 = await get("?subjectId=emp-007");
  const b7 = await r7!.json() as { proposed: unknown[]; suppressed: unknown[] };
  assert.equal(b7.proposed.length, 0); // COMPLIANT → no proposal
  assert.equal(b7.suppressed.length, 0);
});

test("RUNNING run is excluded from proposals (only terminal runs contribute)", async () => {
  // Seed a second ALL_PROGRAMS run left RUNNING (not finalized) with a newer started_at.
  // Its outcomes must NOT appear in proposals — only the COMPLETED run's outcomes should.
  const db = (env as { DB: unknown }).DB;
  const runStore = new SqliteRunStore(db as never);
  const outcomes = new SqliteOutcomeStore(db as never);
  // Ensure this run has a later started_at than the COMPLETED run seeded in before().
  await new Promise((r) => setTimeout(r, 5));
  const runningRun = await runStore.createRun({
    scopeType: "ALL_PROGRAMS",
    scopeId: undefined,
    triggeredBy: "test-running",
    requestedScope: {},
    measurementPeriodStart: "2026-06-19T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-19T00:00:00.000Z",
  });
  // Mark it RUNNING (in-flight — never finalized)
  await runStore.markRunning(runningRun.id);
  // Give this RUNNING run an OVERDUE outcome for a unique new subject
  await outcomes.recordOutcome({ runId: runningRun.id, subjectId: "emp-running-only", measureId: "audiogram", status: "OVERDUE", evidence: {} });

  const res = await get("");
  const body = await res!.json() as { proposed: Array<{ subjectId: string }>; suppressed: Array<{ subjectId: string }> };
  const allSubjects = [...body.proposed, ...body.suppressed].map((p) => p.subjectId);
  assert.ok(
    !allSubjects.includes("emp-running-only"),
    "subject from RUNNING run must not appear in proposals (in-flight run excluded)",
  );
  // emp-006 from the COMPLETED run must still appear
  assert.ok(allSubjects.includes("emp-006"), "subject from COMPLETED run still appears");
});

test("#546: a patient outside the measure's initial population gets no proposal, one inside still does", async () => {
  const res = await get("?measureId=cms122");
  assert.equal(res!.status, 200);
  const body = await res!.json() as { proposed: Array<{ subjectId: string }>; suppressed: Array<{ subjectId: string }>; totals: { proposed: number; suppressed: number } };
  const subjects = [...body.proposed, ...body.suppressed].map((p) => p.subjectId);

  assert.ok(subjects.includes("emp-020"), "in-population MISSING_DATA is still a gap to close");
  assert.ok(!subjects.includes("emp-021"), "out-of-population MISSING_DATA proposes nothing — not even a suppressed row");
  // Suppression is a DIFFERENT statement ("a standing order already covers this"), so the skipped
  // patient must not show up there either: totals count exactly one patient for this measure.
  assert.equal(body.totals.proposed + body.totals.suppressed, 1);
});

test("#621: the measures with no order to propose are named, on the pilot's six-measure scope", () => {
  // On Maui four of the six routed measures have no catalog order, so their at-risk patients get no
  // proposal. The page used to show an empty list, which reads as "nobody is at risk"; the route names
  // them so it can say otherwise. Run in a fresh Maui process: the scope is fixed at module load.
  const output = runProfileChild(
    "maui",
    `
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { createSqliteD1 } from "@mieweb/cloud-local";
      import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
      import { handleOrders } from "./src/routes/orders.ts";
      const db = await createSqliteD1(join(tmpdir(), "workwell-orders-621-" + crypto.randomUUID() + ".sqlite"));
      await db.exec(RUN_STORE_FLOOR_DDL.split(String.fromCharCode(10)).join(" "));
      const read = async (qs) => (await (await handleOrders(new Request("http://x/api/orders/proposals" + qs), { DB: db })).json()).measuresWithoutOrder;
      console.log(JSON.stringify({ all: await read(""), cms130: await read("?measureId=cms130"), cms122: await read("?measureId=cms122") }));
    `,
    { WORKWELL_OFFICIAL_MEASURES: "cms122,cms125,cms2,cms130,cms165,cms137", DATABASE_URL: undefined },
  );
  assert.deepEqual([...(output.all as string[])].sort(), ["cms130", "cms137", "cms165", "cms2"]);
  assert.deepEqual(output.cms130, ["cms130"], "filtered to a measure with no order: named, not an empty list");
  assert.deepEqual(output.cms122, [], "a measure with an order is not named");
});

test("#621: on the default profile every active measure has an order, so none is named", async () => {
  const body = (await get("").then((r) => r!.json())) as { measuresWithoutOrder: string[] };
  assert.deepEqual(body.measuresWithoutOrder, []);
});
