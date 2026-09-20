/**
 * The two work-list loaders must answer the same question (#561).
 *
 * `loadWorklistPage` pushes the filters into SQL and returns one page plus the exact total;
 * `loadWorklistCases` loads the filtered set and the caller slices it. Both stay in the code, and a
 * request picks one — so the only thing that keeps them honest is a test that runs BOTH over one
 * fixture and requires identical totals and identical page ids. A predicate added to one and not the
 * other is otherwise a filter that applies on the dashboard badge and not in the export taken from the
 * same screen, with nothing failing.
 *
 * The fixture is built so every term is non-zero: two cadences, two cycles, an unknown measure slug, a
 * status an operator moved, outreach on some rows and not others, and two `created_at` values either
 * side of a UTC midnight.
 *
 * node --import tsx --test src/case/worklist-page-conformance.test.ts
 */
import { test, before, after, beforeEach } from "node:test";
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
import {
  loadWorklistCases, loadWorklistPage, sqlPageBlockedBy, invalidateCaseSubjectInvariant, panelSubjectIds,
  type WorklistDeps, type WorklistFilters,
} from "./worklist-read-model.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { CaseQuery, CaseStore } from "../stores/case-store.ts";

const TODAY = "2026-09-18";
/** Two different cadences, so a mutant that collapses the per-measure cycles to one date is caught. */
const AUDIOGRAM_CYCLE = bucketPeriodForMeasure("audiogram", TODAY);
const CMS122_CYCLE = bucketPeriodForMeasure("cms122", TODAY);
const MYSTERY_CYCLE = bucketPeriodForMeasure("mystery-measure", TODAY);
/**
 * A measure whose cycle anchor is genuinely DIFFERENT from the others.
 *
 * `audiogram`, `cms122` and the unknown-slug fallback all anchor to 2026-01-01 on this date, so a
 * fixture of those three cannot tell a per-measure cycle table from one shared date — a regression
 * collapsing every measure to one annual period would have left this suite green while the real work
 * list dropped current biannual cases and admitted their prior-cycle ones. `diabetes_hba1c` has a
 * 180-day window and anchors to 2026-07-01.
 */
const BIANNUAL_CYCLE = bucketPeriodForMeasure("diabetes_hba1c", TODAY);
const PRIOR = "2019-01-01";

const dbPath = join(tmpdir(), `workwell-page-conf-${crypto.randomUUID()}.sqlite`);
let db: { prepare: (sql: string) => { bind: (...a: unknown[]) => { run: () => Promise<unknown> } }; exec: (s: string) => Promise<unknown> };
let cases: SqliteCaseStore;
let events: SqliteCaseEventStore;
let runId: string;

const ROSTER: EmployeeProfile[] = [
  { externalId: "p-1", name: "Ann Akana", role: "Patient", site: "Kahului", providerId: "prov-a", tenantId: "maui", payer: "1", sex: "F", dateOfBirth: "1950-03-02" },
  { externalId: "p-2", name: "Ben Bright", role: "Patient", site: "Kahului", providerId: "prov-a", tenantId: "maui", payer: "11", sex: "M", dateOfBirth: "1952-07-19" },
  { externalId: "p-3", name: "Cara Chun", role: "Patient", site: "Kihei", providerId: "prov-b", tenantId: "maui", payer: "5", sex: "F", dateOfBirth: "1984-01-05" },
  { externalId: "p-4", name: "Dan Diaz", role: "Patient", site: "Kihei", providerId: "prov-b", tenantId: "maui", payer: "2", sex: "M", dateOfBirth: "1991-11-30" },
];
const lookup = (id: string): EmployeeProfile | null => ROSTER.find((e) => e.externalId === id) ?? null;

/** Counts which loader path actually ran, so a conformance pass cannot be vacuous. */
interface Calls { page: number; uncapped: number }
function countingStore(inner: CaseStore, calls: Calls): CaseStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "listCasesPage") {
        return (q: CaseQuery, p: { limit: number; offset: number }) => { calls.page += 1; return target.listCasesPage(q, p); };
      }
      if (prop === "listCases") {
        return (q: CaseQuery) => {
          if (q.limit === Number.MAX_SAFE_INTEGER) calls.uncapped += 1;
          return target.listCases(q);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

function deps(calls: Calls, overrides: Partial<WorklistDeps> = {}): WorklistDeps {
  return {
    cases: countingStore(cases, calls),
    events,
    employeeLookup: lookup,
    roster: () => ROSTER,
    today: () => TODAY,
    profileMatch: (id) => lookup(id) !== null,
    withOutreachCounts: true,
    ...overrides,
  };
}

const mk = async (subjectId: string, measureId: string, evaluationPeriod: string, outcomeStatus = "OVERDUE") =>
  (await cases.upsertFromOutcome({ runId, subjectId, measureId, evaluationPeriod, outcomeStatus }))!;

before(async () => {
  db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  cases = new SqliteCaseStore(db as never);
  events = new SqliteCaseEventStore(db as never);
  const run = await new SqliteRunStore(db as never).createRun({
    scopeType: "ALL_PROGRAMS", triggeredBy: "test", requestedScope: {},
    measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-12-31T00:00:00.000Z",
  });
  runId = run.id;

  // Current cycle, three measures with three different cadence rules.
  const a1 = await mk("p-1", "audiogram", AUDIOGRAM_CYCLE);
  await mk("p-2", "audiogram", AUDIOGRAM_CYCLE, "DUE_SOON");
  await mk("p-3", "cms122", CMS122_CYCLE);
  // A CLOSED row in the current cycle, on its own subject, so the closed tabs have something to find
  // without removing cms122 from the default list.
  const c1 = await mk("p-2", "cms122", CMS122_CYCLE);
  await mk("p-4", "mystery-measure", MYSTERY_CYCLE);
  // The second cadence, current and prior, so the per-measure table is load-bearing here.
  await mk("p-1", "diabetes_hba1c", BIANNUAL_CYCLE);
  await mk("p-2", "diabetes_hba1c", PRIOR);
  // A PRIOR cycle for each, which the current-cycle default must exclude — including for the unknown
  // slug, whose anchor comes from the fallback rather than from a named pair.
  await mk("p-1", "audiogram", PRIOR);
  await mk("p-3", "cms122", PRIOR);
  await mk("p-4", "mystery-measure", PRIOR);
  // An operator has started one; another is closed. Both are real states the status token selects.
  await cases.patchCase(a1.id, { status: "IN_PROGRESS" });
  await cases.patchCase(c1.id, {
    status: "CLOSED", closedAt: "2026-09-17T00:00:00.000Z", closedReason: "MANUAL_RESOLVE", closedBy: "nurse@example.org",
  });

  // Outreach on exactly one case, so `none` and `any` each keep and drop something.
  const outreachOn = (await cases.listCases({ employeeId: "p-2", limit: 10 }))[0]!;
  await events.recordCaseEvents([
    {
      action: { caseId: outreachOn.id, actionType: "OUTREACH_SENT", actor: "cm@workwell.dev", payload: { channel: "EMAIL" } },
      audit: {
        eventType: "CASE_OUTREACH_SENT", entityType: "case", entityId: outreachOn.id, actor: "cm@workwell.dev",
        refRunId: outreachOn.lastRunId, refCaseId: outreachOn.id, refMeasureVersionId: outreachOn.measureId,
        payload: { channel: "EMAIL" },
      },
    },
  ]);

  // Two `created_at` values either side of a UTC midnight. A cast in the wrong direction moves one of
  // them across the boundary, and the day-window comparison is the only thing that would notice.
  const all = await cases.listCases({ limit: 100 });
  await db.prepare("UPDATE cases SET created_at = ? WHERE id = ?").bind("2026-09-17T23:59:59.000Z", all[0]!.id).run();
  await db.prepare("UPDATE cases SET created_at = ? WHERE id = ?").bind("2026-09-18T00:30:00.000Z", all[1]!.id).run();
});

after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

beforeEach(() => invalidateCaseSubjectInvariant());

/**
 * Both loaders over the same filters, required to agree — and the SQL one required to have actually
 * run, because two calls that both fall back would agree perfectly and prove nothing.
 */
async function bothAgree(filters: WorklistFilters, page: { limit: number; offset: number }): Promise<void> {
  const refCalls: Calls = { page: 0, uncapped: 0 };
  const all = await loadWorklistCases(deps(refCalls), filters);
  const expected = { total: all.length, ids: all.slice(page.offset, page.offset + page.limit).map((c) => c.caseId) };

  const fastCalls: Calls = { page: 0, uncapped: 0 };
  const d = deps(fastCalls);
  // The gate is asked with the RESOLVED pre-filter, exactly as the loader asks it: an active panel
  // selection is answerable in SQL precisely when its ids fit in one bind.
  const pre = panelSubjectIds(ROSTER, filters.subjects, filters.site, Date.now());
  assert.equal(sqlPageBlockedBy(d, filters, pre), null, `these filters must be SQL-answerable: ${JSON.stringify(filters)}`);
  const fast = await loadWorklistPage(d, filters, page);

  const where = `${JSON.stringify(filters)} @ ${page.offset}/${page.limit}`;
  assert.equal(fastCalls.page, 1, `the SQL page path ran exactly once — ${where}`);
  assert.equal(fastCalls.uncapped, 0, `and it never loaded the uncapped set — ${where}`);
  assert.equal(fast.total, expected.total, `same total — ${where}`);
  assert.deepEqual(fast.rows.map((c) => c.caseId), expected.ids, `same page, same order — ${where}`);
}

test("every SQL-answerable filter gives the same total and the same page as the in-memory pipeline", async () => {
  const combos: WorklistFilters[] = [
    {},                                             // the default: ACTIVE, current cycle per measure
    { status: "open" },
    { status: "all", period: "all" },
    { status: "closed", period: "all" },
    { measureId: "audiogram" },
    { priority: "HIGH" },
    { outcome: "OVERDUE" },
    { outcome: "DUE_SOON" },
    // LOWERCASE on purpose. The SQL predicate uppercases both sides; the in-memory filter uppercased
    // only the cell and compared against the caller's raw token, so this combination returned nothing
    // on one path and everything on the other. The routes happen to uppercase first, which is the only
    // reason it was not already reachable.
    { outcome: "overdue" },
    { outcome: "Due_Soon" },
    { outreach: "none" },
    { outreach: "any" },
    { status: "open", outreach: "none" },           // the dashboard badge, verbatim
    { period: "all", from: "2026-09-18" },
    { period: "all", to: "2026-09-17" },
    { period: "all", from: "2026-09-17", to: "2026-09-18" },
    { subjects: { providerIds: ["prov-a"] } },
    { subjects: { payer: ["11"] } },
    { status: "all", period: PRIOR },
    { status: "all", period: "all", measureId: "mystery-measure" },
  ];
  for (const filters of combos) {
    for (const page of [{ limit: 50, offset: 0 }, { limit: 2, offset: 0 }, { limit: 2, offset: 2 }, { limit: 3, offset: 99 }]) {
      await bothAgree(filters, page);
    }
  }
});

test("the two paths agree on the outreach BADGE, not only on which rows come back", async () => {
  // `bothAgree` compares totals and page ids, so a field that differs between the loaders is invisible
  // to it — and one did: the SQL path computed `outreachRecordCount` only when the caller asked for
  // counts, while the uncapped path also computed it whenever an outreach FILTER was active. A caller
  // filtering on outreach without asking for counts got a list of cases that provably have outreach,
  // every badge reading 0.
  const filters: WorklistFilters = { period: "all", status: "all", outreach: "any" };
  const deps_ = (calls: Calls) => deps(calls, { withOutreachCounts: false });
  const expected = await loadWorklistCases(deps_({ page: 0, uncapped: 0 }), filters);
  const calls: Calls = { page: 0, uncapped: 0 };
  const got = await loadWorklistPage(deps_(calls), filters, { limit: 50, offset: 0 });

  assert.equal(calls.page, 1, "the SQL path ran");
  assert.ok(expected.length > 0, "the fixture has a case WITH outreach, or this proves nothing");
  assert.deepEqual(
    got.rows.map((c) => [c.caseId, c.outreachRecordCount]),
    expected.slice(0, 50).map((c) => [c.caseId, c.outreachRecordCount]),
    "same rows AND the same badge on each",
  );
  assert.ok(got.rows.every((c) => (c.outreachRecordCount ?? 0) > 0), "a case on the `any` list has a non-zero count");
});

test("the current-cycle default is per MEASURE, and an unknown slug takes the fallback anchor", async () => {
  // Three measures with three cadence rules, each with a prior-cycle row that must not appear. A
  // mutant that used one shared period would drop two of the three current rows, or admit three prior
  // ones — and both paths would still agree, so this is asserted against the fixture directly.
  const calls: Calls = { page: 0, uncapped: 0 };
  const page = await loadWorklistPage(deps(calls), {}, { limit: 100, offset: 0 });
  assert.notEqual(BIANNUAL_CYCLE, AUDIOGRAM_CYCLE, "the fixture must span TWO cadences or it proves nothing");
  const periods = new Set(page.rows.map((c) => c.evaluationPeriod));
  assert.equal(periods.has(PRIOR), false, "no prior-cycle row survives the current-cycle default");
  assert.deepEqual(
    [...new Set(page.rows.map((c) => `${c.measureVersionId}@${c.evaluationPeriod}`))].sort(),
    [`audiogram@${AUDIOGRAM_CYCLE}`, `cms122@${CMS122_CYCLE}`, `mystery-measure@${MYSTERY_CYCLE}`, `diabetes_hba1c@${BIANNUAL_CYCLE}`].sort(),
    "each measure is at ITS OWN current cycle, including the slug no registry names",
  );
});

test("a filter with no SQL form falls back, says which one, and still answers correctly", async () => {
  const calls: Calls = { page: 0, uncapped: 0 };
  const d = deps(calls);
  // Each blocker names itself, so a fast path that silently stops being taken is visible.
  assert.equal(sqlPageBlockedBy(d, { site: "Kahului" }, undefined), "site-is-a-directory-join");
  assert.equal(sqlPageBlockedBy(d, { search: "Ann" }, undefined), "search-is-a-directory-join");
  assert.equal(sqlPageBlockedBy(d, { status: "staff_closed" }, undefined), "staff-closed-needs-whole-list");
  assert.equal(sqlPageBlockedBy({ ...d, roster: undefined }, {}, undefined), "roster-not-authoritative");
  // An ACTIVE panel filter whose set was too large to bind blocks; an INACTIVE one does not.
  assert.equal(sqlPageBlockedBy(d, { subjects: { providerIds: ["prov-a"] } }, undefined), "panel-too-large-to-bind");
  assert.equal(sqlPageBlockedBy(d, {}, undefined), null);

  // And the fallback still answers: same result as the in-memory pipeline, by the slow route.
  const site: WorklistFilters = { site: "Kahului" };
  const expected = await loadWorklistCases(deps({ page: 0, uncapped: 0 }), site);
  const got = await loadWorklistPage(d, site, { limit: 50, offset: 0 });
  assert.equal(calls.page, 0, "the SQL page path is not taken when a directory filter is active");
  assert.equal(got.total, expected.length);
  assert.deepEqual(got.rows.map((c) => c.caseId), expected.map((c) => c.caseId));
});

test("a case subject the directory does not hold disables the SQL path rather than over-counting", async () => {
  // The invariant the scoped-profile fast path rests on, violated on purpose. The SQL predicate cannot
  // express "is in the directory" — there is no patients table — so a total computed in SQL would
  // count this row while no page could ever show it.
  await mk("ghost-1", "audiogram", AUDIOGRAM_CYCLE);
  invalidateCaseSubjectInvariant();
  try {
    const calls: Calls = { page: 0, uncapped: 0 };
    const d = deps(calls);
    const got = await loadWorklistPage(d, {}, { limit: 50, offset: 0 });
    assert.equal(calls.page, 0, "the fast path is refused while the invariant does not hold");
    const expected = await loadWorklistCases(deps({ page: 0, uncapped: 0 }), {});
    assert.equal(got.total, expected.length, "and the answer is the in-memory one, which hides the ghost");
    assert.equal(got.rows.some((c) => c.employeeId === "ghost-1"), false);

    // With no profile predicate there is nothing to violate, and the fast path is available again.
    const noProfile: Calls = { page: 0, uncapped: 0 };
    invalidateCaseSubjectInvariant();
    await loadWorklistPage(deps(noProfile, { profileMatch: undefined }), {}, { limit: 50, offset: 0 });
    assert.equal(noProfile.page, 1, "an unscoped deployment has no such invariant to check");
  } finally {
    const ghost = (await cases.listCases({ employeeId: "ghost-1", limit: 10 }))[0];
    if (ghost) await db.prepare("DELETE FROM cases WHERE id = ?").bind(ghost.id).run();
    invalidateCaseSubjectInvariant();
  }
});
