/**
 * The risk outlook reads the WINNING RUN, remembers what that run determines, and applies `today`
 * and the horizon per request (read-path perf part 3, 2026-09-15).
 *
 * Before this it called `listOutcomesForMeasure` — every retained run, every period, with evidence:
 * about a million rows on the pilot, answering 504 cold and 8.2 s warm. The tests here pin the four
 * things that make the replacement safe rather than merely fast: the winner decides the answer, the
 * memo is invalidated by the runs that win (and never written when the visibility fallback fired or
 * when nothing has run at all), the evidence read names the run whose rows are being described, and
 * an official winner costs ONE peeked row instead of a full evidence page.
 *
 *   node --import tsx --test src/program/program-risk-outlook.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeRecord, OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { programRiskOutlook, __chartMemos } from "./program-read-models.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";

const MEASURE = "cms122";
/** cms122's compliance window is 365 days and DUE_SOON opens 30 days before it. */
const THRESHOLD = 365 - 30;
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

const reset = () => {
  for (const memo of Object.values(__chartMemos)) memo.clear();
};

const joinedRow = (
  runId: string,
  runStartedAt: string,
  subjectId: string,
  status: string,
  extra: Partial<OutcomeWithRun> = {},
): OutcomeWithRun => ({
  runId,
  runStartedAt,
  runScopeType: "ALL_PROGRAMS",
  runStatus: "COMPLETED",
  runTriggeredBy: "manual",
  subjectId,
  measureId: MEASURE,
  status,
  ...extra,
});

const evidenceRow = (runId: string, subjectId: string, status: string, evidence: unknown): OutcomeRecord => ({
  id: `${runId}:${subjectId}`,
  runId,
  subjectId,
  measureId: MEASURE,
  evaluationPeriod: "2026-01-01",
  status,
  evidence,
  evaluatedAt: "2026-09-01T00:00:00.000Z",
});

/** A recency define the anchored `/^most recent .*date$/i` matcher accepts. */
const authoredEvidence = (daysAgo: number) => ({
  expressionResults: [{ define: "Most Recent Exam Date", result: day(daysAgo) }],
});

interface Calls {
  joined: number;
  winners: number;
  byRun: Array<{ runId: string; measureId?: string; subjectId?: string; limit?: number }>;
  history: number;
}

function makeDeps(joined: OutcomeWithRun[], byRun: Record<string, OutcomeRecord[]> = {}, configured = false) {
  const calls: Calls = { joined: 0, winners: 0, byRun: [], history: 0 };
  const winnersOf = latestRunsFromRows(joined);
  const deps = {
    outcomeStore: {
      listOutcomesWithRun: async () => {
        calls.joined++;
        return joined;
      },
      listLatestPopulationRuns: async (measureIds: readonly string[], filter: never, perMeasure?: number) => {
        calls.winners++;
        return winnersOf(measureIds, filter, perMeasure);
      },
      // Honours `measureId`, `subjectId` AND `limit`, because the real store does: a fake that
      // ignored `subjectId` would serve whichever row sorts first and so would pass the very
      // test that exists to prove the peek names a compliant subject. The harness must not be
      // gentler than the real caller. Rows are served in the order given, which is the store's
      // `ORDER BY (evaluated_at, id) ASC`.
      listOutcomes: async (runId: string, opts: { measureId?: string; subjectId?: string; limit?: number } = {}) => {
        calls.byRun.push({ runId, measureId: opts.measureId, subjectId: opts.subjectId, limit: opts.limit });
        const matched = (byRun[runId] ?? []).filter(
          (r) => (!opts.measureId || r.measureId === opts.measureId) && (!opts.subjectId || r.subjectId === opts.subjectId),
        );
        return typeof opts.limit === "number" ? matched.slice(0, opts.limit) : matched;
      },
      listOutcomesForMeasure: async () => {
        calls.history++;
        throw new Error("the outlook must not scan the measure's history");
      },
      aggregateScaleRun: async () => [],
    } as unknown as OutcomeStore,
    runStore: { listRuns: async () => [] } as unknown as RunStore,
    caseStore: { listCases: async () => [] } as unknown as CaseStore,
    webChartEnv: configured
      ? { WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "k" }
      : {},
  };
  return { deps, calls };
}

test("a subject present only in the previous run is absent from the site table", async () => {
  reset();
  const older = [
    joinedRow("run-old", "2026-08-01T00:00:00.000Z", "emp-006", "OVERDUE"),
    joinedRow("run-old", "2026-08-01T00:00:00.000Z", "emp-007", "OVERDUE"),
  ];
  const newer = [joinedRow("run-new", "2026-09-01T00:00:00.000Z", "emp-006", "COMPLIANT")];
  const { deps } = makeDeps([...older, ...newer]);

  const outlook = await programRiskOutlook(deps, MEASURE, 30);
  assert.ok(outlook);
  const total = outlook!.siteComplianceRates.reduce((n, s) => n + s.total, 0);
  // emp-007 was evaluated only by the superseded run. This is the semantic change #547 made
  // everywhere else and the outlook now shares: the table describes the run that won.
  assert.equal(total, 1, "only the winning run's subjects are counted");
  assert.equal(outlook!.siteComplianceRates[0]!.compliant, 1);
});

test("an OFFICIAL winner costs one peeked row and reports no expirations", async () => {
  reset();
  const joined = [joinedRow("run-official", "2026-09-01T00:00:00.000Z", "emp-006", "COMPLIANT")];
  // A real official outcome's expressionResults are named `official:<population>` precisely so they
  // cannot match the anchored recency matcher — the old code paged 20,000 of these to find nothing.
  const official = {
    official: { measurementPeriod: { start: "2026-01-01", end: "2026-12-31" }, populationResults: [] },
    expressionResults: [{ define: "official:initial-population", result: true }],
  };
  const { deps, calls } = makeDeps(joined, { "run-official": [evidenceRow("run-official", "emp-006", "COMPLIANT", official)] });

  const outlook = await programRiskOutlook(deps, MEASURE, 180);
  assert.ok(outlook);
  assert.deepEqual(outlook!.upcomingExpirations, [], "an official run carries no recency define");
  assert.equal(outlook!.upcomingNonCompliantCount, 0);
  assert.equal(outlook!.forecastable, false, "#617: its zeros are structural, and the page must say so");
  assert.equal(calls.history, 0);
  assert.deepEqual(calls.byRun, [{ runId: "run-official", measureId: MEASURE, subjectId: "emp-006", limit: 1 }],
    "exactly one evidence read, of exactly one row");
});

test("#617: an official winner with nobody compliant yet is still not forecastable, for one peeked row", async () => {
  reset();
  // Early in a measurement year a measure can have no COMPLIANT subject. The peek used to be skipped
  // then, so an official measure's structural zeros were served as a forecast.
  const joined = [
    joinedRow("run-january", "2027-01-02T00:00:00.000Z", "emp-006", "OVERDUE"),
    joinedRow("run-january", "2027-01-02T00:00:00.000Z", "emp-007", "MISSING_DATA"),
  ];
  const official = {
    official: { measurementPeriod: { start: "2027-01-01", end: "2027-12-31" }, populationResults: [] },
    expressionResults: [{ define: "official:initial-population", result: true }],
  };
  const { deps, calls } = makeDeps(joined, {
    "run-january": [evidenceRow("run-january", "emp-006", "OVERDUE", official), evidenceRow("run-january", "emp-007", "MISSING_DATA", official)],
  });

  const outlook = await programRiskOutlook(deps, MEASURE, 90);
  assert.ok(outlook);
  assert.equal(outlook!.forecastable, false);
  assert.deepEqual(calls.byRun, [{ runId: "run-january", measureId: MEASURE, subjectId: "emp-006", limit: 1 }],
    "one NAMED row of the run (the indexed lookup), and never the unpaged read");
});

test("#617: with nobody compliant, the peek names a row that cannot be an evaluation error", async () => {
  reset();
  // An error forces MISSING_DATA and replaces the evidence, so it carries no `official` block: peeking
  // it would read an official measure as forecastable. It sorts first in the store here, as a failed
  // first chunk would; the peek must name the OVERDUE subject instead.
  const joined = [
    joinedRow("run-partial-jan", "2027-01-02T00:00:00.000Z", "emp-001", "MISSING_DATA"),
    joinedRow("run-partial-jan", "2027-01-02T00:00:00.000Z", "emp-009", "OVERDUE"),
  ];
  const official = {
    official: { measurementPeriod: { start: "2027-01-01", end: "2027-12-31" }, populationResults: [] },
    expressionResults: [{ define: "official:initial-population", result: true }],
  };
  const { deps, calls } = makeDeps(joined, {
    "run-partial-jan": [
      evidenceRow("run-partial-jan", "emp-001", "MISSING_DATA", { evaluationError: "CQL engine failure", message: "boom" }),
      evidenceRow("run-partial-jan", "emp-009", "OVERDUE", official),
    ],
  });

  const outlook = await programRiskOutlook(deps, MEASURE, 90);
  assert.ok(outlook);
  assert.equal(outlook!.forecastable, false);
  assert.deepEqual(calls.byRun, [{ runId: "run-partial-jan", measureId: MEASURE, subjectId: "emp-009", limit: 1 }]);
});

test("#617: an authored winner with nobody compliant stays forecastable and reads no more than a peek", async () => {
  reset();
  const joined = [joinedRow("run-authored-0", "2026-09-01T00:00:00.000Z", "emp-006", "OVERDUE")];
  const { deps, calls } = makeDeps(joined, { "run-authored-0": [evidenceRow("run-authored-0", "emp-006", "OVERDUE", authoredEvidence(400))] });

  const outlook = await programRiskOutlook(deps, MEASURE, 90);
  assert.ok(outlook);
  assert.equal(outlook!.forecastable, true, "an authored measure's zero is a real answer");
  assert.equal(calls.byRun.length, 1);
});

test("an AUTHORED winner peeks, then reads the run's evidence once, narrowed to the measure", async () => {
  reset();
  const joined = [
    joinedRow("run-authored", "2026-09-01T00:00:00.000Z", "emp-006", "COMPLIANT"),
    joinedRow("run-authored", "2026-09-01T00:00:00.000Z", "emp-007", "COMPLIANT"),
    joinedRow("run-authored", "2026-09-01T00:00:00.000Z", "emp-008", "OVERDUE"),
  ];
  const byRun = {
    "run-authored": [
      // 320 days ago ⇒ 15 days until DUE_SOON: inside a 30-day horizon.
      evidenceRow("run-authored", "emp-006", "COMPLIANT", authoredEvidence(320)),
      // 250 days ago ⇒ 85 days until DUE_SOON: outside 30, inside 180.
      evidenceRow("run-authored", "emp-007", "COMPLIANT", authoredEvidence(250)),
      evidenceRow("run-authored", "emp-008", "OVERDUE", {}),
    ],
  };
  const { deps, calls } = makeDeps(joined, byRun);

  const near = await programRiskOutlook(deps, MEASURE, 30);
  assert.ok(near);
  assert.equal(near!.forecastable, true);
  assert.deepEqual(near!.upcomingExpirations.map((e) => e.externalId), ["emp-006"]);
  assert.equal(near!.upcomingExpirations[0]!.daysUntilDueSoon, THRESHOLD - 320);
  assert.equal(near!.upcomingExpirations[0]!.complianceWindowDays, 365);
  assert.equal(calls.history, 0);
  assert.deepEqual(calls.byRun, [
    { runId: "run-authored", measureId: MEASURE, subjectId: "emp-006", limit: 1 },
    { runId: "run-authored", measureId: MEASURE, subjectId: undefined, limit: undefined },
  ], "the peek, then one full read narrowed to the measure");
});

test("an official winner whose FIRST stored row is an evaluation error still costs one peek", async () => {
  reset();
  // All three review lanes found this independently, and it was the strongest finding of the round.
  // `listOutcomes` orders by `(evaluated_at, id)` ASC; an evaluation failure REPLACES the evidence
  // with `{ evaluationError, message }` and forces MISSING_DATA (DATA_MODEL_CONTRACTS §5); and a
  // PARTIAL_FAILURE run satisfies `isCompletedRun`, so it can win. Peeking the run's FIRST row
  // therefore learned nothing on exactly the runs most likely to be large, and fell through to the
  // unpaged read of every evidence blob — the 8.2 s this function exists to remove. The peek now
  // names a COMPLIANT subject, which cannot be an evaluation error.
  const joined = [
    joinedRow("run-partial", "2026-09-01T00:00:00.000Z", "emp-008", "MISSING_DATA"),
    joinedRow("run-partial", "2026-09-01T00:00:00.000Z", "emp-006", "COMPLIANT"),
  ];
  const official = {
    official: { measurementPeriod: { start: "2026-01-01", end: "2026-12-31" }, populationResults: [] },
    expressionResults: [{ define: "official:initial-population", result: true }],
  };
  const byRun = {
    // Oldest first, exactly as the store returns them: the ERROR row sorts ahead of the official one.
    "run-partial": [
      { ...evidenceRow("run-partial", "emp-008", "MISSING_DATA", { evaluationError: "CQL engine failure", message: "boom" }), evaluatedAt: "2026-09-01T00:00:00.000Z" },
      { ...evidenceRow("run-partial", "emp-006", "COMPLIANT", official), evaluatedAt: "2026-09-01T00:00:05.000Z" },
    ],
  };
  const { deps, calls } = makeDeps(joined, byRun);

  const outlook = await programRiskOutlook(deps, MEASURE, 180);
  assert.ok(outlook);
  assert.deepEqual(outlook!.upcomingExpirations, [], "an official run carries no recency define");
  assert.equal(calls.byRun.length, 1, "one read, not a fall-through to the whole run's evidence");
  assert.deepEqual(calls.byRun[0], { runId: "run-partial", measureId: MEASURE, subjectId: "emp-006", limit: 1 },
    "and it names a COMPLIANT subject, not whichever row sorts first");
});

test("a winner holding no visible row reads no evidence at all", async () => {
  reset();
  // The `compliantSubjects.length > 0 && evidenceRunId` conjunction is load-bearing, not redundant:
  // a winner that exists in the runs table but holds no row the caller can see leaves `snap.winners`
  // EMPTY while the precomputed winners are not, and the visibility fallback cannot fire because it
  // requires the winner to have had rows. Reviewers noted no test covered it.
  const joined = [joinedRow("run-empty", "2026-09-01T00:00:00.000Z", "emp-006", "COMPLIANT")];
  const { calls, deps } = makeDeps(joined);
  // The winners walk finds the run; the row read returns nothing for it.
  (deps.outcomeStore as unknown as { listOutcomesWithRun: () => Promise<unknown[]> }).listOutcomesWithRun = async () => {
    calls.joined++;
    return [];
  };

  const outlook = await programRiskOutlook(deps, MEASURE, 30);
  assert.ok(outlook);
  assert.deepEqual(outlook!.siteComplianceRates, []);
  assert.deepEqual(outlook!.upcomingExpirations, []);
  assert.deepEqual(calls.byRun, [], "no evidence read when there is no visible row to describe");
});

test("the memo holds what the RUN determines, so a different horizon is served without a re-read", async () => {
  reset();
  const joined = [
    joinedRow("run-authored", "2026-09-01T00:00:00.000Z", "emp-006", "COMPLIANT"),
    joinedRow("run-authored", "2026-09-01T00:00:00.000Z", "emp-007", "COMPLIANT"),
  ];
  const byRun = {
    "run-authored": [
      evidenceRow("run-authored", "emp-006", "COMPLIANT", authoredEvidence(320)),
      evidenceRow("run-authored", "emp-007", "COMPLIANT", authoredEvidence(250)),
    ],
  };
  const { deps, calls } = makeDeps(joined, byRun);

  const near = await programRiskOutlook(deps, MEASURE, 30);
  const readsAfterFirst = calls.byRun.length;
  const far = await programRiskOutlook(deps, MEASURE, 180);

  // The horizon is NOT in the memo key, and the memoized value is not the rendered answer: the
  // second request reads nothing and still gets a different, correct list. Were `horizonDays` in the
  // key this would re-read; were the rendered outlook memoized it would return the 30-day answer.
  assert.equal(calls.byRun.length, readsAfterFirst, "no further evidence read");
  assert.deepEqual(near!.upcomingExpirations.map((e) => e.externalId), ["emp-006"]);
  assert.deepEqual(far!.upcomingExpirations.map((e) => e.externalId), ["emp-006", "emp-007"]);
  // ... and each site row's `upcomingExpirations` is recomputed with it rather than frozen.
  assert.equal(near!.siteComplianceRates.reduce((n, s) => n + s.upcomingExpirations, 0), 1);
  assert.equal(far!.siteComplianceRates.reduce((n, s) => n + s.upcomingExpirations, 0), 2);
});

test("a new winning run evicts the memo", async () => {
  reset();
  const rows: OutcomeWithRun[] = [joinedRow("run-a", "2026-09-01T00:00:00.000Z", "emp-006", "OVERDUE")];
  // The fake reads the array by reference on every call, so pushing a newer run mid-test is exactly
  // a nightly completing between two requests.
  const winnersOf = latestRunsFromRows(() => rows);
  let joinedReads = 0;
  const deps = {
    outcomeStore: {
      listOutcomesWithRun: async () => {
        joinedReads++;
        return rows;
      },
      listLatestPopulationRuns: winnersOf,
      listOutcomes: async () => [],
      // Nothing to aggregate in this fixture, so the membership read is empty too - stated rather than
      // inherited, because `aggregateOfficialRun` reads it and not `listOutcomes` (review of #610).
      listOutcomeMembershipsForRun: async () => [],
      listOutcomesForMeasure: async () => {
        throw new Error("no history scan");
      },
      aggregateScaleRun: async () => [],
    } as unknown as OutcomeStore,
    runStore: { listRuns: async () => [] } as unknown as RunStore,
    caseStore: { listCases: async () => [] } as unknown as CaseStore,
    webChartEnv: {},
  };

  const first = await programRiskOutlook(deps, MEASURE, 30);
  assert.equal(first!.siteComplianceRates.reduce((n, s) => n + s.total, 0), 1, "run-a's single subject");
  const readsAfterFirst = joinedReads;
  assert.equal((await programRiskOutlook(deps, MEASURE, 30))!.siteComplianceRates.length, 1);
  assert.equal(joinedReads, readsAfterFirst, "the second request is served from the memo");

  rows.push(joinedRow("run-b", "2026-09-02T00:00:00.000Z", "emp-006", "COMPLIANT"));
  rows.push(joinedRow("run-b", "2026-09-02T00:00:00.000Z", "emp-007", "COMPLIANT"));
  const third = await programRiskOutlook(deps, MEASURE, 30);
  assert.ok(joinedReads > readsAfterFirst, "a new winner forces a re-read");
  assert.equal(third!.siteComplianceRates.reduce((n, s) => n + s.total, 0), 2, "the newer run's rows");
  assert.equal(third!.siteComplianceRates.reduce((n, s) => n + s.compliant, 0), 2);
});

test("a measure that has never run answers empty without reading rows, and the first real run shows at once", async () => {
  reset();
  const rows: OutcomeWithRun[] = [];
  const { deps, calls } = makeDeps(rows);

  const empty = await programRiskOutlook(deps, MEASURE, 30);
  assert.ok(empty);
  assert.deepEqual(empty!.siteComplianceRates, []);
  assert.deepEqual(empty!.upcomingExpirations, []);
  // A measure with no runs reads no rows. Stated as a property of the PATH, not of any one branch:
  // `readWinnersRows` already returns early on an empty winners list, so this stays 0 with or without
  // the short-circuit in `programRiskOutlook` — it would move only if something started reading rows
  // before resolving the winners, which is the regression worth holding.
  assert.equal(calls.joined, 0, "no row read for a measure that has never run");
  assert.deepEqual(calls.byRun, []);

  // And the first real run is visible immediately. This holds whether or not the empty answer was
  // memoized — `RunKeyedMemo.get` validates against the `runKey` the caller presents, so an entry
  // stored under `runKeyOf([]) === ""` stops matching the moment a run exists. Asserted anyway,
  // because it is the behaviour that matters to whoever opens the page.
  rows.push(joinedRow("run-first", "2026-09-01T00:00:00.000Z", "emp-006", "COMPLIANT"));
  const afterFirstRun = await programRiskOutlook(deps, MEASURE, 30);
  assert.equal(afterFirstRun!.siteComplianceRates.reduce((n, s) => n + s.total, 0), 1,
    "the first real run must be visible immediately");
});

test("after a visibility fallback the evidence names the run the ROWS came from, and nothing is memoized", async () => {
  reset();
  // The seam is OFF, so `wc|` subjects are invisible. The NEWEST run holds only those, so its rows
  // are unusable and the snapshot falls back to the older run — which is the one whose evidence must
  // be read. Reading the precomputed winner instead would pair an older visible snapshot with a
  // newer invisible run's evidence and report zero expirations.
  const joined = [
    joinedRow("run-visible", "2026-09-01T00:00:00.000Z", "emp-006", "COMPLIANT"),
    joinedRow("run-hidden", "2026-09-02T00:00:00.000Z", "wc|hidden-1", "COMPLIANT"),
  ];
  const byRun = {
    "run-visible": [evidenceRow("run-visible", "emp-006", "COMPLIANT", authoredEvidence(320))],
    "run-hidden": [evidenceRow("run-hidden", "wc|hidden-1", "COMPLIANT", authoredEvidence(320))],
  };
  const { deps, calls } = makeDeps(joined, byRun, false);

  const outlook = await programRiskOutlook(deps, MEASURE, 30);
  assert.ok(outlook);
  assert.deepEqual(outlook!.upcomingExpirations.map((e) => e.externalId), ["emp-006"],
    "the fallback run's evidence is what was read");
  assert.equal(calls.byRun.every((c) => c.runId === "run-visible"), true,
    "no evidence read names the superseded, invisible winner");

  // A fallback's answer can change without the winners changing (a visible run that started earlier
  // and completes later), so it is never memoized: the second request must do the work again.
  const readsAfterFirst = calls.byRun.length;
  const second = await programRiskOutlook(deps, MEASURE, 30);
  assert.ok(calls.byRun.length > readsAfterFirst, "a fallback result is recomputed, never served from the memo");
  assert.deepEqual(second!.upcomingExpirations.map((e) => e.externalId), ["emp-006"]);
});
