/**
 * The attributed list's measurement-year report (MM-2 PR 3, ADR-082).
 *
 *   node --import tsx --test src/compliance/subject-list-report.test.ts
 *
 * Fakes for all four stores, because every rule worth testing here is about WHICH rows are counted
 * and WHICH run is chosen — questions a real database makes harder to ask, not easier. The rate
 * arithmetic itself is `createRateAggregator`'s and is covered where it lives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { subjectListReport, type SubjectListReportDeps } from "./subject-list-report.ts";
import { subjectListReportCsv, reportCsvHeaders } from "./subject-list-report-csv.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import type { SubjectList, SubjectListMember } from "../stores/subject-list-store.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";

const LIST: SubjectList = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "ACO attribution",
  revision: 3,
  status: "COMPLETE",
  source: "the quarterly file",
  note: null,
  createdBy: "quality-lead@workwell.dev",
  createdAt: "2027-01-05T00:00:00.000Z",
  completedAt: "2027-01-05T00:00:01.000Z",
};

const official = (populationResults: Record<string, boolean>, measurementPeriod?: { start: string; end: string }) => ({
  official: { populationResults, ...(measurementPeriod ? { measurementPeriod } : {}) },
});

let seq = 0;
const row = (
  subjectId: string,
  evidence: Record<string, unknown>,
  over: Partial<OutcomeRecord> = {},
): OutcomeRecord => ({
  id: `o-${++seq}`,
  runId: "run-2027",
  subjectId,
  measureId: "cms122",
  evaluationPeriod: "2027",
  status: "COMPLIANT",
  evidence,
  evaluatedAt: "2027-06-01T00:00:00.000Z",
  ...over,
});

interface FakeOptions {
  members?: SubjectListMember[];
  rows?: OutcomeRecord[];
  runs?: { runId: string; startedAt: string; year: number; status?: string; scopeType?: string; measureId?: string }[];
  compactionCutoffs?: string[];
  /** Appends a compaction intent the FIRST time a page is read — the mid-report race. */
  intentOnFirstPage?: string;
  measureIds?: string[];
}

function fakeDeps(options: FakeOptions): { deps: SubjectListReportDeps; measureIds: string[] } {
  const members = options.members ?? [
    { rawIdentifier: "pat-001", subjectId: "pat-001", resolution: "MATCHED" },
    { rawIdentifier: "pat-002", subjectId: "pat-002", resolution: "MATCHED" },
  ];
  const runs = options.runs ?? [{ runId: "run-2027", startedAt: "2027-12-31T00:00:00.000Z", year: 2027 }];
  const cutoffs = [...(options.compactionCutoffs ?? [])];
  let pagesRead = 0;

  const deps: SubjectListReportDeps = {
    lists: {
      getList: async (id) => (id === LIST.id ? LIST : null),
      listLists: async () => [LIST],
      countMembers: async () =>
        new Map([[
          LIST.id,
          {
            MATCHED: members.filter((m) => m.resolution === "MATCHED").length,
            NOT_FOUND: members.filter((m) => m.resolution === "NOT_FOUND").length,
            AMBIGUOUS: members.filter((m) => m.resolution === "AMBIGUOUS").length,
          },
        ]]),
      listMembers: async (_id, opts) => {
        const filtered = opts.resolution ? members.filter((m) => m.resolution === opts.resolution) : members;
        return { members: filtered.slice(opts.offset, opts.offset + opts.limit), total: filtered.length };
      },
      matchedSubjectIds: async () =>
        members.filter((m) => m.resolution === "MATCHED").map((m) => m.subjectId!),
      createList: async () => {
        throw new Error("not used");
      },
    },
    outcomes: {
      listOutcomes: async (runId: string, opts?: { measureId?: string; limit?: number; offset?: number }) => {
        pagesRead += 1;
        if (options.intentOnFirstPage && pagesRead === 1) cutoffs.push(options.intentOnFirstPage);
        const all = (options.rows ?? []).filter(
          (r) => r.runId === runId && (!opts?.measureId || r.measureId === opts.measureId),
        );
        const offset = opts?.offset ?? 0;
        return all.slice(offset, offset + (opts?.limit ?? all.length));
      },
      listLatestPopulationRuns: async (measureIds: readonly string[]) =>
        runs
          .filter((r) => r.measureId === undefined || r.measureId === measureIds[0])
          .map((r) => ({
          measureId: measureIds[0]!,
          runId: r.runId,
          runStartedAt: r.startedAt,
          runScopeType: r.scopeType ?? "ALL_PROGRAMS",
          runStatus: r.status ?? "COMPLETED",
          runTriggeredBy: "nightly",
        })),
    } as unknown as SubjectListReportDeps["outcomes"],
    runs: {
      getRun: async (runId: string) => {
        const r = runs.find((x) => x.runId === runId);
        if (!r) return null;
        return {
          id: r.runId,
          measurementPeriodStart: `${r.year}-01-01T00:00:00.000Z`,
          measurementPeriodEnd: `${r.year}-12-31T23:59:59.999Z`,
        };
      },
    } as unknown as SubjectListReportDeps["runs"],
    events: {
      recentAuditEventsByType: async () =>
        cutoffs.map((cutoff) => ({
          occurredAt: cutoff,
          eventType: "OUTCOMES_COMPACTION_STARTED",
          actor: null,
          refRunId: null,
          refCaseId: null,
          refMeasureVersionId: null,
          payload: { cutoff },
        })),
    },
  };
  return { deps, measureIds: options.measureIds ?? ["cms122"] };
}

const runReport = async (options: FakeOptions, year = 2027) => {
  const { deps, measureIds } = fakeDeps(options);
  return subjectListReport(deps, LIST.id, year, measureIds, () => "2027-01-06T00:00:00.000Z");
};

test("the rates are computed over the LIST'S MEMBERS ONLY — a patient outside it moves nothing", async () => {
  // The whole point of the report. If a non-member's row reached the aggregator, the ACO would be
  // handed the practice's rate under a heading naming their attributed population, and the number
  // would look entirely plausible.
  const result = await runReport({
    rows: [
      row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false })),
      row("pat-002", official({ ipp: true, denom: true, numer: false, denex: false, denexcep: false })),
      row("pat-999", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false })),
    ],
  });
  assert.equal(result.ok, true);
  const entry = (result as { report: { measures: { rates: { numer: number; denom: number; score: number | null }[] }[] } }).report.measures[0]!;
  assert.equal(entry.rates[0]!.denom, 2, "the non-member is not in the denominator");
  assert.equal(entry.rates[0]!.numer, 1);
  assert.equal(entry.rates[0]!.score, 0.5);
});

test("a member the run never evaluated is REPORTED, never subtracted — and the counts reconcile", async () => {
  // A gap in the evidence is not an exclusion. Folding these into a denominator would let a SMALLER
  // run produce a HIGHER score, which is the one direction a quality number must never move by
  // accident.
  const result = await runReport({
    members: [
      { rawIdentifier: "pat-001", subjectId: "pat-001", resolution: "MATCHED" },
      { rawIdentifier: "pat-002", subjectId: "pat-002", resolution: "MATCHED" },
      { rawIdentifier: "pat-003", subjectId: "pat-003", resolution: "MATCHED" },
    ],
    rows: [
      row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false })),
      row("pat-002", official({ ipp: true, denom: true, numer: false, denex: false, denexcep: false })),
    ],
  });
  assert.equal(result.ok, true);
  const report = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report;
  const entry = report.measures[0]!;
  assert.equal(entry.matchedSubjects, 3);
  assert.equal(entry.distinctSubjectsSeen, 2);
  assert.equal(entry.missingFromRun, 1);
  assert.equal(entry.rates[0]!.denom, 2, "the unevaluated member is NOT in the denominator");
  // The two reconciliations the doc states, pinned so a later change has to break a test to break them.
  assert.equal(entry.matchedSubjects, entry.distinctSubjectsSeen + entry.missingFromRun);
  assert.equal(
    entry.distinctSubjectsSeen,
    entry.scoredSubjects + entry.unmeasured + entry.evaluationErrors + entry.outOfPopulation,
  );
  // And the member appears as a row, so the ACO can see WHO was not measured.
  const missing = report.rows.filter((r) => r.rowStatus === "MISSING_FROM_RUN");
  assert.deepEqual(missing.map((r) => r.subjectId), ["pat-003"]);
});

test("the year selector walks PAST a newer run from the wrong year", async () => {
  // In January 2028 the newest run is a PY2028 one. "The latest numbers" would answer a PY2027
  // question with next year's first nightly — a wrong number that looks exactly like a right one.
  const result = await runReport({
    runs: [
      { runId: "run-2028", startedAt: "2028-01-02T00:00:00.000Z", year: 2028 },
      { runId: "run-2027", startedAt: "2027-12-31T00:00:00.000Z", year: 2027 },
    ],
    rows: [
      row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }), { runId: "run-2028" }),
      row("pat-001", official({ ipp: true, denom: true, numer: false, denex: false, denexcep: false }), { runId: "run-2027" }),
    ],
  });
  assert.equal(result.ok, true);
  const entry = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report.measures[0]!;
  assert.equal(entry.runId, "run-2027");
  assert.equal(entry.rates[0]!.numer, 0, "PY2027's answer, not PY2028's");
});

test("no run for the requested year is a REASON on the measure, not a 409", async () => {
  // An ACO asking for a year the sandbox never ran is asking a legitimate question. 409 is reserved
  // for "the evidence may be incomplete"; this is "there is no evidence", and saying so is the answer.
  const result = await runReport({ runs: [{ runId: "run-2026", startedAt: "2026-12-31T00:00:00.000Z", year: 2026 }] }, 2027);
  assert.equal(result.ok, true);
  const entry = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report.measures[0]!;
  assert.equal(entry.compactionStatus, "no_run");
  assert.equal(entry.reason, "no_completed_population_run_for_year");
  assert.equal(entry.runId, null);
  assert.deepEqual(entry.rates, []);
});

test("compaction is per MEASURE: one exposed run does not withhold the other measures' numbers", async () => {
  // ADR-077 refuses a report built over rows that may be incomplete. The refusal belongs to the
  // measure whose run aged out — the other measures' numbers are complete, and withholding them
  // would be a second wrong answer to a question the ACO has to file.
  const pass = await runReport({
    measureIds: ["cms122", "cms125"],
    runs: [
      { runId: "run-old", startedAt: "2027-01-02T00:00:00.000Z", year: 2027, measureId: "cms122" },
      { runId: "run-fresh", startedAt: "2027-12-31T00:00:00.000Z", year: 2027, measureId: "cms125" },
    ],
    rows: [
      row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }), { runId: "run-old" }),
      row("pat-001", official({ ipp: true, denom: true, numer: false, denex: false, denexcep: false }), { runId: "run-fresh", measureId: "cms125" }),
    ],
    compactionCutoffs: ["2027-06-01T00:00:00.000Z"],
  });
  assert.equal(pass.ok, true, "five complete measures are not withheld because the sixth aged out");
  const report = (pass as { report: import("./subject-list-report.ts").SubjectListReport }).report;
  assert.deepEqual(report.compactedMeasures, ["cms122"]);
  const exposed = report.measures.find((m) => m.measureId === "cms122")!;
  const complete = report.measures.find((m) => m.measureId === "cms125")!;
  assert.equal(exposed.compactionStatus, "compacted");
  assert.deepEqual(exposed.rates, [], "no numbers for the measure whose evidence may be incomplete");
  assert.equal(complete.compactionStatus, "complete");
  assert.equal(complete.rates[0]!.denom, 1);
  assert.equal(report.rows.every((r) => r.measureId !== "cms122"), true, "and no rows either");

  // Every selected run exposed ⇒ the WHOLE request is refused.
  const all = await runReport({
    measureIds: ["cms122", "cms125"],
    runs: [{ runId: "run-old", startedAt: "2027-01-02T00:00:00.000Z", year: 2027 }],
    rows: [row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }), { runId: "run-old" })],
    compactionCutoffs: ["2027-06-01T00:00:00.000Z"],
  });
  assert.equal(all.ok, false);
  assert.equal((all as { status: number }).status, 409);
  assert.equal((all as unknown as { body: { error: string } }).body.error, "run_compacted");
});

test("a compaction intent landing MID-REPORT refuses, rather than serving a truncated 200", async () => {
  // The post-read check. A pass that began while this report was paging would have deleted rows the
  // earlier pages already counted, and a 200 over those counts is a number nobody can reproduce.
  const result = await runReport({
    // Started in January; the pass that begins mid-report carries a June cutoff, so the run's rows
    // are inside the window it deletes from. A run that started AFTER every cutoff is never exposed,
    // which is why this fixture's date matters.
    runs: [{ runId: "run-2027", startedAt: "2027-01-02T00:00:00.000Z", year: 2027 }],
    rows: [row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }))],
    intentOnFirstPage: "2027-06-01T00:00:00.000Z",
  });
  assert.equal(result.ok, false);
  assert.equal((result as { status: number }).status, 409);
});

test("a row whose evidence names a DIFFERENT measurement period refuses the report", async () => {
  // ADR-072: the outcome-level period is the only place that states which year an official outcome
  // describes. A run that mixes them cannot be reported as one year's numbers, and picking either
  // would be a silent choice made on the ACO's behalf.
  const result = await runReport({
    rows: [
      row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }, { start: "2026-01-01", end: "2026-12-31" })),
    ],
  });
  assert.equal(result.ok, false);
  assert.equal((result as { status: number }).status, 409);
  assert.equal((result as unknown as { body: { error: string } }).body.error, "period_mismatch");
});

test("two rows for one subject collapse to the NEWEST, whatever order the store returned them", async () => {
  // A run can hold more than one row for a subject. "Whichever came back first" would make the
  // report depend on page ordering, so the same request could answer differently twice.
  const older = row("pat-001", official({ ipp: true, denom: true, numer: false, denex: false, denexcep: false }), {
    evaluatedAt: "2027-06-01T00:00:00.000Z",
  });
  const newer = row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }), {
    evaluatedAt: "2027-09-01T00:00:00.000Z",
  });
  for (const rows of [[older, newer], [newer, older]]) {
    const result = await runReport({ rows });
    const entry = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report.measures[0]!;
    assert.equal(entry.rates[0]!.numer, 1, "the September row wins");
    assert.equal(entry.duplicateRowsCollapsed, 1);
    assert.equal(entry.distinctSubjectsSeen, 1, "one subject, not two");
  }
});

test("an unresolved member appears EXACTLY ONCE, after the evaluated rows — not once per measure", async () => {
  // One unresolved identifier multiplied by six routed measures would read as six separate failures,
  // and the ACO's review queue would be six times the size of the real disagreement.
  const result = await runReport({
    measureIds: ["cms122", "cms125"],
    members: [
      { rawIdentifier: "pat-001", subjectId: "pat-001", resolution: "MATCHED" },
      { rawIdentifier: "MRN-77", subjectId: null, resolution: "NOT_FOUND" },
    ],
    rows: [row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }))],
  });
  assert.equal(result.ok, true);
  const rows = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report.rows;
  const unmatched = rows.filter((r) => r.rowStatus === "NOT_MATCHED");
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0]!.rawIdentifier, "MRN-77");
  assert.equal(rows.indexOf(unmatched[0]!), rows.length - 1, "after every evaluated row");
});

test("an unknown list is a 404 before any evidence is read", async () => {
  const { deps } = fakeDeps({});
  const result = await subjectListReport(deps, "22222222-2222-4222-8222-222222222222", 2027, ["cms122"]);
  assert.equal(result.ok, false);
  assert.equal((result as { status: number }).status, 404);
});


test("the four not-scored buckets are DISJOINT, so the reconciliation holds with errors in the run", async () => {
  // The defect the first cut shipped: `createRateAggregator`'s `unmeasured` is a SUPERSET of its
  // `evaluationErrors` (it starts the count at the error count), so subtracting both from the subject
  // count double-counted every error — and the test that "pinned" the identity used a fixture with
  // zero errors, zero unmeasured and zero out-of-population, which makes it `2 === 2 + 0 + 0 + 0` and
  // passes for any implementation. PARTIAL_FAILURE runs are ordinary on the pilot.
  const result = await runReport({
    members: [
      { rawIdentifier: "pat-001", subjectId: "pat-001", resolution: "MATCHED" },
      { rawIdentifier: "pat-002", subjectId: "pat-002", resolution: "MATCHED" },
      { rawIdentifier: "pat-003", subjectId: "pat-003", resolution: "MATCHED" },
      { rawIdentifier: "pat-004", subjectId: "pat-004", resolution: "MATCHED" },
    ],
    rows: [
      row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false })),
      row("pat-002", { evaluationError: "engine threw", message: "boom" }, { status: "MISSING_DATA" }),
      row("pat-003", official({ ipp: false, denom: false, numer: false, denex: false, denexcep: false }), {
        status: "MISSING_DATA",
        outOfPopulation: true,
      }),
      // Not in the run at all — pat-004 is missingFromRun.
    ],
  });
  assert.equal(result.ok, true);
  const entry = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report.measures[0]!;
  assert.equal(entry.distinctSubjectsSeen, 3);
  assert.equal(entry.missingFromRun, 1);
  assert.equal(entry.evaluationErrors, 1);
  assert.equal(entry.outOfPopulation, 1);
  assert.equal(entry.scoredSubjects, 1, "one subject was actually scored");
  assert.equal(
    entry.distinctSubjectsSeen,
    entry.scoredSubjects + entry.unmeasured + entry.evaluationErrors + entry.outOfPopulation,
    "the identity holds WITH errors present, which is what the first version could not do",
  );
  assert.equal(entry.matchedSubjects, entry.distinctSubjectsSeen + entry.missingFromRun);
});

test("scoredSubjects cannot go negative when one row is both out of population and an error", async () => {
  // `outcomes.out_of_population` is an independently persisted column; nothing stops it being true on
  // a row whose evidence is an evaluation error. Subtracting both from the subject count gave -1,
  // served to the ACO as JSON. Classifying each row into ONE bucket makes that unreachable.
  const result = await runReport({
    members: [{ rawIdentifier: "pat-001", subjectId: "pat-001", resolution: "MATCHED" }],
    rows: [
      row("pat-001", { evaluationError: "engine threw", message: "boom" }, {
        status: "MISSING_DATA",
        outOfPopulation: true,
      }),
    ],
  });
  const entry = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report.measures[0]!;
  assert.ok(entry.scoredSubjects >= 0, `scoredSubjects must not be negative, got ${entry.scoredSubjects}`);
  assert.equal(entry.scoredSubjects, 0);
  // An error is an error FIRST: no engine spoke for the subject, so nothing else about it is known.
  assert.equal(entry.evaluationErrors, 1);
  assert.equal(entry.outOfPopulation, 0);
  assert.equal(
    entry.distinctSubjectsSeen,
    entry.scoredSubjects + entry.unmeasured + entry.evaluationErrors + entry.outOfPopulation,
  );
});

test("a measure with NO usable run still satisfies matchedSubjects = seen + missingFromRun", async () => {
  // §6.6 states that identity unconditionally, so it has to hold for the entries a reader is most
  // likely to be checking: the ones with no numbers. A measure that saw nobody is missing everybody.
  const result = await runReport({ runs: [{ runId: "run-2026", startedAt: "2026-12-31T00:00:00.000Z", year: 2026 }] }, 2027);
  const entry = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report.measures[0]!;
  assert.equal(entry.compactionStatus, "no_run");
  assert.equal(entry.matchedSubjects, entry.distinctSubjectsSeen + entry.missingFromRun);
  assert.equal(entry.missingFromRun, entry.matchedSubjects);
});

test("the run search is scoped to the YEAR, so a year of newer nightlies cannot hide it", async () => {
  // The first cut took the twelve most recent runs outright, which on a nightly deployment is twelve
  // DAYS: by mid-January a PY2027 report answered `no_completed_population_run_for_year` while the
  // year's runs sat uncompacted in the table. The window is the mechanism; the count is not.
  const manyNewer = Array.from({ length: 30 }, (_, i) => ({
    runId: `run-2028-${i}`,
    startedAt: `2028-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    year: 2028,
  }));
  const { deps } = fakeDeps({
    runs: [...manyNewer, { runId: "run-2027", startedAt: "2027-12-31T00:00:00.000Z", year: 2027 }],
    rows: [row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }), { runId: "run-2027" })],
  });
  const result = await subjectListReport(deps, LIST.id, 2027, ["cms122"], () => "x");
  assert.equal(result.ok, true);
  const entry = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report.measures[0]!;
  assert.equal(entry.runId, "run-2027", "thirty newer nightlies do not hide the year's run");
});

test("the CSV carries the identifier the ACO SENT, not the subject id we resolved it to", async () => {
  // Equal today, because matching is exact `externalId`. The moment the format changes — name+DOB, an
  // MBI, the seam `subject-list-import.ts` names — this is the only column that lets the ACO
  // reconcile the file they sent against the file they get back.
  const result = await runReport({
    members: [
      { rawIdentifier: "MBI-1EG4TE5MK73", subjectId: "pat-001", resolution: "MATCHED" },
      { rawIdentifier: "MBI-9XY2QW1ZZ08", subjectId: "pat-009", resolution: "MATCHED" },
    ],
    rows: [row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }))],
  });
  const report = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report;
  const evaluated = report.rows.find((r) => r.rowStatus === "EVALUATED")!;
  const missing = report.rows.find((r) => r.rowStatus === "MISSING_FROM_RUN")!;
  assert.equal(evaluated.rawIdentifier, "MBI-1EG4TE5MK73");
  assert.equal(evaluated.subjectId, "pat-001", "and the resolved id is still carried, in its own column");
  assert.equal(missing.rawIdentifier, "MBI-9XY2QW1ZZ08", "the unevaluated member too");
});

// ---- the CSV contract (DATA_MODEL_CONTRACTS §6.6) ---------------------------------------------

const profile = (externalId: string): EmployeeProfile | null =>
  externalId === "pat-001"
    ? ({ externalId, name: "Ari Wren", role: "Patient", site: "Wailuku Clinic", providerId: "maui-prov-001", payer: "1" } as EmployeeProfile)
    : null;

test("the CSV header is pinned exactly — the ACO's tooling reads it by name", async () => {
  // A renamed or inserted column silently breaks a downstream import that has been working for
  // months, and the failure surfaces as wrong numbers rather than as an error.
  assert.deepEqual(reportCsvHeaders("patient"), [
    "listId", "listRevision", "generatedAt", "rawIdentifier", "patientExternalId", "patientName",
    "resolution", "rowStatus", "measureId", "ecqmId", "measureVersion", "runId",
    "measurementPeriodStart", "measurementPeriodEnd", "evaluatedAt", "rate",
    "initialPopulation", "denominator", "denominatorExclusion", "denominatorException", "numerator",
    "status", "outOfPopulation", "evaluationError", "providerId", "payer",
  ]);
  // The subject columns follow the deployment's own term, exactly as §6.2/§6.3 do.
  assert.equal(reportCsvHeaders("employee")[4], "employeeExternalId");
});

test("every CSV row has exactly as many cells as the header, in all three row shapes", async () => {
  const result = await runReport({
    members: [
      { rawIdentifier: "pat-001", subjectId: "pat-001", resolution: "MATCHED" },
      { rawIdentifier: "pat-003", subjectId: "pat-003", resolution: "MATCHED" },
      { rawIdentifier: "MRN-77", subjectId: null, resolution: "NOT_FOUND" },
    ],
    rows: [row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }))],
  });
  assert.equal(result.ok, true);
  const report = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report;
  const csv = subjectListReportCsv(report, profile, "patient");
  const lines = csv.split("\r\n");
  const width = reportCsvHeaders("patient").length;
  for (const [i, line] of lines.entries()) {
    assert.equal(line.split(",").length, width, `row ${i} has ${width} cells`);
  }
  // EVALUATED + MISSING_FROM_RUN + NOT_MATCHED, plus the header.
  assert.equal(lines.length, 4);
});

test("a member the run never evaluated has EMPTY population cells — never 0, which reads as a score", async () => {
  const result = await runReport({
    members: [
      { rawIdentifier: "pat-001", subjectId: "pat-001", resolution: "MATCHED" },
      { rawIdentifier: "pat-003", subjectId: "pat-003", resolution: "MATCHED" },
    ],
    rows: [row("pat-001", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }))],
  });
  const report = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report;
  const csv = subjectListReportCsv(report, profile, "patient");
  const headers = reportCsvHeaders("patient");
  const missing = csv.split("\r\n").find((l) => l.includes("MISSING_FROM_RUN"))!.split(",");
  for (const column of ["initialPopulation", "denominator", "denominatorExclusion", "denominatorException", "numerator", "status"]) {
    assert.equal(missing[headers.indexOf(column)], "", `${column} is empty, not 0/false`);
  }
  // The measure IS named, and the run id with it: the row says "this measure did not see them".
  assert.equal(missing[headers.indexOf("measureId")], "cms122");
  assert.notEqual(missing[headers.indexOf("runId")], "");
});

test("an identifier that looks like a formula is neutralised before it reaches a spreadsheet", async () => {
  // A CSV of somebody's uploaded identifiers must not become code that runs when the ACO opens it.
  const result = await runReport({
    members: [{ rawIdentifier: "=SUM(A1:A9)", subjectId: null, resolution: "NOT_FOUND" }],
    rows: [],
  });
  const report = (result as { report: import("./subject-list-report.ts").SubjectListReport }).report;
  const csv = subjectListReportCsv(report, profile, "patient");
  assert.match(csv, /'=SUM\(A1:A9\)/, "prefixed with an apostrophe");
  assert.doesNotMatch(csv, /,=SUM/, "and never left bare at the start of a cell");
});
