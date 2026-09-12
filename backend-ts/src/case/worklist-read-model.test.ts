/**
 * The shared work-list read model (MM-2) — the pipeline `/api/cases` and `/api/worklist/patients`
 * both call, so the two cannot disagree about which cases someone is working.
 *
 * Three behaviours here are changes rather than moves, and each has its own test: the default status
 * set is the ACTIVE set, the panel pre-filter narrows the FETCH without changing the ANSWER, and the
 * pre-filter is withheld where the roster is not authoritative.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";
import { loadWorklistCases, panelSubjectIds, statusesForWorklist, type WorklistDeps } from "./worklist-read-model.ts";
import { ACTIVE_CASE_STATUSES } from "./case-logic.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { CaseQuery, CaseRecord, CaseStore } from "../stores/case-store.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const CYCLE = bucketPeriodForMeasure("audiogram", TODAY);

const dbPath = join(tmpdir(), `workwell-worklist-${crypto.randomUUID()}.sqlite`);
let cases: SqliteCaseStore;
let events: SqliteCaseEventStore;
let runId: string;

/** A small directory: two PCPs, two payers, two sites — enough for every filter to both keep and drop. */
const ROSTER: EmployeeProfile[] = [
  { externalId: "p-1", name: "Ann Akana", role: "Patient", site: "Kahului", providerId: "prov-a", tenantId: "maui", payer: "1", sex: "F", dateOfBirth: "1950-03-02" },
  { externalId: "p-2", name: "Ben Bright", role: "Patient", site: "Kahului", providerId: "prov-a", tenantId: "maui", payer: "11", sex: "M", dateOfBirth: "1952-07-19" },
  { externalId: "p-3", name: "Cara Chun", role: "Patient", site: "Kihei", providerId: "prov-b", tenantId: "maui", payer: "5", sex: "F", dateOfBirth: "1984-01-05" },
  { externalId: "p-4", name: "Dan Diaz", role: "Patient", site: "Kihei", providerId: "prov-b", tenantId: "maui", payer: "2", sex: "M", dateOfBirth: "1991-11-30" },
];
const lookup = (id: string): EmployeeProfile | null => ROSTER.find((e) => e.externalId === id) ?? null;

function deps(overrides: Partial<WorklistDeps> = {}): WorklistDeps {
  return { cases, events, employeeLookup: lookup, roster: () => ROSTER, today: () => TODAY, ...overrides };
}

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  cases = new SqliteCaseStore(db);
  events = new SqliteCaseEventStore(db);
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });
  runId = run.id;
  for (const subjectId of ["p-1", "p-2", "p-3", "p-4"]) {
    await cases.upsertFromOutcome({ runId, subjectId, measureId: "audiogram", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });
  }
  // p-2's case is one an operator has STARTED. That is the case most likely to be looked for, and the
  // one the old OPEN-only default hid.
  const started = (await cases.listCases({ employeeId: "p-2", limit: 10 }))[0]!;
  await cases.patchCase(started.id, { status: "IN_PROGRESS" });
});

after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("the default status set is the ACTIVE set — an IN_PROGRESS case stays on the list someone started it from", async () => {
  // `statusesFor("open")` returned ["OPEN"] while ACTIVE_CASE_STATUSES — the contract's own definition
  // of an active case, which every open-case rollup uses — is OPEN + IN_PROGRESS. So moving a case to
  // IN_PROGRESS removed it from the default work list: the one case someone had actually picked up
  // vanished, which reads as "it got done" rather than "the filter dropped it".
  assert.deepEqual(statusesForWorklist(""), [...ACTIVE_CASE_STATUSES]);
  assert.deepEqual(statusesForWorklist("open"), [...ACTIVE_CASE_STATUSES]);
  assert.ok(statusesForWorklist("")!.includes("IN_PROGRESS"));

  const rows = await loadWorklistCases(deps(), {});
  assert.deepEqual(rows.map((r) => r.employeeId).sort(), ["p-1", "p-2", "p-3", "p-4"]);
  assert.equal(rows.find((r) => r.employeeId === "p-2")?.status, "IN_PROGRESS");

  // The other tokens are unchanged, and an explicit one is taken literally.
  assert.equal(statusesForWorklist("all"), undefined);
  assert.deepEqual(statusesForWorklist("closed"), ["RESOLVED", "CLOSED"]);
  assert.deepEqual(statusesForWorklist("excluded"), ["EXCLUDED"]);
  assert.deepEqual(statusesForWorklist("open"), [...ACTIVE_CASE_STATUSES]);
  assert.deepEqual(statusesForWorklist("RESOLVED"), ["RESOLVED"]);
});

test("panelSubjectIds resolves the panel to subject ids — and an EMPTY result is a constraint, not an absent filter", () => {
  assert.deepEqual(panelSubjectIds(ROSTER, { providerId: "prov-a" }, undefined), ["p-1", "p-2"]);
  assert.deepEqual(panelSubjectIds(ROSTER, { payer: ["1", "11"] }, undefined), ["p-1", "p-2"], "Medicare is both codes");
  assert.deepEqual(panelSubjectIds(ROSTER, { payer: ["1"] }, undefined), ["p-1"]);
  assert.deepEqual(panelSubjectIds(ROSTER, { providerId: "prov-a" }, "Kihei"), [], "the filters intersect");
  // A PCP with no patients must resolve to the empty SET rather than to "no filter" — otherwise the
  // store falls through to unfiltered and serves the whole practice under that panel's heading.
  assert.deepEqual(panelSubjectIds(ROSTER, { providerId: "prov-zzz" }, undefined), []);
  // No panel filter and no site ⇒ no pre-filter at all (undefined), which is NOT the same as [].
  assert.equal(panelSubjectIds(ROSTER, {}, undefined), undefined);
  assert.equal(panelSubjectIds(ROSTER, undefined, undefined), undefined);
  // `site=—` is the site of a subject the directory cannot resolve, so it must NOT pre-filter: those
  // rows survive the post-filter and pre-filtering would drop exactly the ones it should keep.
  assert.equal(panelSubjectIds(ROSTER, {}, "—"), undefined);
});

test("the pre-filter narrows the FETCH without changing the ANSWER", async () => {
  // The point of the pre-filter is that the database returns the panel instead of the practice. It is
  // only allowed to be faster — the rows must be identical to what the post-filter alone produces.
  const filters = { subjects: { providerId: "prov-a" } };
  const withPreFilter = await loadWorklistCases(deps(), filters);
  const withoutPreFilter = await loadWorklistCases(deps({ roster: undefined }), filters);
  assert.deepEqual(withPreFilter.map((r) => r.caseId), withoutPreFilter.map((r) => r.caseId));
  assert.deepEqual(withPreFilter.map((r) => r.employeeId).sort(), ["p-1", "p-2"]);

  // And it really did narrow the query rather than filtering afterwards.
  const seen: CaseQuery[] = [];
  const spy: CaseStore = { ...cases, listCases: async (q: CaseQuery) => { seen.push(q); return cases.listCases(q); } } as CaseStore;
  await loadWorklistCases(deps({ cases: spy }), filters);
  assert.deepEqual(seen[0]?.employeeIds, ["p-1", "p-2"]);
});

test("a panel with nobody in it returns NO cases — never the whole practice", async () => {
  const rows = await loadWorklistCases(deps(), { subjects: { providerId: "prov-nobody" } });
  assert.deepEqual(rows, [], "an unknown PCP is an empty list, which is visible; the practice is not");
  const byPayer = await loadWorklistCases(deps(), { subjects: { payer: ["9999"] } });
  assert.deepEqual(byPayer, []);
});

test("the pre-filter is WITHHELD when the roster is not authoritative, so a live subject's case is not dropped", async () => {
  // With WebChart configured the route's lookup resolves subjects the directory does not hold. If the
  // pre-filter were built from the directory anyway, those cases would never be fetched — a work list
  // short by exactly the people the live integration exists to serve, and a missing row reads as
  // "no gaps". So `roster` is omitted there and the post-filter alone decides.
  const seen: CaseQuery[] = [];
  const spy: CaseStore = { ...cases, listCases: async (q: CaseQuery) => { seen.push(q); return cases.listCases(q); } } as CaseStore;
  await loadWorklistCases(deps({ cases: spy, roster: undefined }), { subjects: { providerId: "prov-a" } });
  assert.equal(seen[0]?.employeeIds, undefined, "no pre-filter was sent");

  // A subject the roster does not contain, but the lookup can resolve, keeps their case.
  const live = { externalId: "wc|99", name: "Live Person", role: "Patient", site: "Kahului", providerId: "prov-a", tenantId: "maui", payer: "1" } as EmployeeProfile;
  const liveLookup = (id: string) => (id === "wc|99" ? live : lookup(id));
  await cases.upsertFromOutcome({ runId, subjectId: "wc|99", measureId: "audiogram", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });
  try {
    const rows = await loadWorklistCases(
      deps({ roster: undefined, employeeLookup: liveLookup }),
      { subjects: { providerId: "prov-a" } },
    );
    assert.ok(rows.some((r) => r.employeeId === "wc|99"), "the live subject's case was dropped");
  } finally {
    const stale = (await cases.listCases({ employeeId: "wc|99", limit: 10 }))[0];
    if (stale) await cases.patchCase(stale.id, { status: "RESOLVED" });
  }
});

test("outreach counts are computed only when the caller renders them", async () => {
  let calls = 0;
  const spyEvents = { ...events, outreachSentCounts: async (ids: string[]) => { calls += 1; return events.outreachSentCounts(ids); } };
  await loadWorklistCases(deps({ events: spyEvents as typeof events }), {});
  assert.equal(calls, 0, "the patient work list does not show the badge, so it does not pay for the query");
  await loadWorklistCases(deps({ events: spyEvents as typeof events, withOutreachCounts: true }), {});
  assert.equal(calls, 1);
});

test("the panel summary carries the PCP and payer names the list renders", async () => {
  const rows = await loadWorklistCases(
    deps({ providerLookup: (id) => (id === "prov-a" ? { name: "Dr. Akana" } : null) }),
    { subjects: { providerId: "prov-a" } },
  );
  const row = rows.find((r) => r.employeeId === "p-1")!;
  assert.equal(row.providerId, "prov-a");
  assert.equal(row.providerName, "Dr. Akana");
  assert.equal(row.payer, "1");
  assert.equal(row.payerName, "Medicare");
  // An id the provider table does not resolve keeps the ID as its name rather than rendering blank
  // over a patient who does have an attributed clinician.
  const unresolved = (await loadWorklistCases(deps({ providerLookup: () => null }), { subjects: { providerId: "prov-a" } }))
    .find((r) => r.employeeId === "p-1")!;
  assert.equal(unresolved.providerName, "prov-a");
});

test("a subject the directory cannot resolve fails an ACTIVE panel filter rather than passing it", async () => {
  const rows = await loadWorklistCases(
    deps({ roster: undefined, employeeLookup: () => null }),
    { subjects: { providerId: "prov-a" } },
  );
  assert.deepEqual(rows, [], "an unresolvable subject must not read as 'matches everything'");
});

test("filters compose, and each one is the intersection", async () => {
  const all = await loadWorklistCases(deps(), {});
  const byPayer = await loadWorklistCases(deps(), { subjects: { payer: ["1", "11"] } });
  const bySite = await loadWorklistCases(deps(), { site: "Kihei" });
  const both = await loadWorklistCases(deps(), { site: "Kahului", subjects: { payer: ["1"] } });
  assert.equal(all.length, 4);
  assert.deepEqual(byPayer.map((r) => r.employeeId).sort(), ["p-1", "p-2"]);
  assert.deepEqual(bySite.map((r) => r.employeeId).sort(), ["p-3", "p-4"]);
  assert.deepEqual(both.map((r) => r.employeeId), ["p-1"]);
  const bySearch = await loadWorklistCases(deps(), { search: "chun" });
  assert.deepEqual(bySearch.map((r) => r.employeeId), ["p-3"]);
});

test("a record the store returns for a subject outside the profile is dropped by profileMatch", async () => {
  const rows = await loadWorklistCases(deps({ profileMatch: (id) => id !== "p-3" }), {});
  assert.deepEqual(rows.map((r) => r.employeeId).sort(), ["p-1", "p-2", "p-4"]);
});

test("CaseRecord shape assumptions this suite relies on", async () => {
  const rows: CaseRecord[] = await cases.listCases({ limit: 10 });
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(typeof r.employeeId, "string");
});
