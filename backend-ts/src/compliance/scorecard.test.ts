/**
 * The provider × measure scorecard's own rules (#852). Agreement with the list report and the work list
 * is asserted through the real routes in `routes/scorecard.maui.test.ts`; this pins the layout rules.
 *
 *   node --import tsx --test src/compliance/scorecard.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScorecard, type ScorecardDeps, type ScorecardRequest } from "./scorecard.ts";
import { anyOutcomeVia, subjectMembershipsVia } from "../test-support/memberships.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import type { CaseRecord } from "../stores/case-store.ts";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";

const CYCLE = bucketPeriodForMeasure("cms125", "2026-10-20");

const pr = (denom: boolean, numer: boolean) => ({ ipp: true, denom, denex: false, numer, denexcep: false });
const one = (numer: boolean) => ({ official: { populationResults: pr(true, numer) } });
const two = (a: boolean, b: boolean) => ({ official: { populationResults: pr(true, a), rates: [pr(true, a), pr(true, b)] } });
const errored = { evaluationError: "engine failure", message: "boom" };

const PROVIDERS = [
  { id: "p-a", name: "Dr. A", location: "North" },
  { id: "p-b", name: "Dr. B", location: "North" },
  { id: "p-c", name: "Dr. C", location: "South" },
];

interface Fixture {
  rows?: OutcomeRecord[];
  pcp: Record<string, string>;
  cases?: Array<Pick<CaseRecord, "employeeId" | "measureId" | "evaluationPeriod" | "status">>;
  compacted?: boolean;
  runs?: Array<{ id: string; triggeredBy?: string }>;
}

let seq = 0;
const row = (subjectId: string, measureId: string, evidence: unknown, over: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  id: `o-${String(++seq).padStart(5, "0")}`,
  runId: "run-1",
  subjectId,
  measureId,
  evaluationPeriod: "2026",
  status: "COMPLIANT",
  evidence,
  evaluatedAt: "2026-06-01T00:00:00.000Z",
  ...over,
});

function deps(f: Fixture): ScorecardDeps {
  let compacted = f.compacted ?? false;
  const listOutcomes = async (runId: string, opts?: { measureId?: string }) =>
    (f.rows ?? []).filter((r) => r.runId === runId && (!opts?.measureId || r.measureId === opts.measureId));
  return {
    outcomes: { anyOutcomeForMeasure: anyOutcomeVia(listOutcomes), listOutcomeSubjectMembershipsForRun: subjectMembershipsVia(listOutcomes) },
    runs: {
      listPopulationRunsForPeriod: async () =>
        (f.runs ?? [{ id: "run-1" }]).map((r) => ({
          id: r.id,
          status: "COMPLETED",
          scopeType: "ALL_PROGRAMS",
          triggeredBy: r.triggeredBy ?? "nightly",
          requestedScope: {},
          startedAt: "2026-06-01T00:00:00.000Z",
          measurementPeriodStart: "2026-01-01T00:00:00.000Z",
          measurementPeriodEnd: "2026-12-31T23:59:59.999Z",
        })),
    } as unknown as ScorecardDeps["runs"],
    events: {
      recentAuditEventsByType: async () =>
        compacted ? [{ occurredAt: "2026-12-01T00:00:00.000Z", payload: { cutoff: "2026-12-01T00:00:00.000Z" } }] : [],
    } as unknown as ScorecardDeps["events"],
    cases: {
      // As the real stores do: the default page is 50, so a reader that omits `limit` sees at most 50.
      listCases: async (q) =>
        (f.cases ?? [])
          .filter((c) => c.measureId === q.measureId && (!q.statuses || q.statuses.includes(c.status)) && (!q.period || c.evaluationPeriod === q.period))
          .slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 50)) as CaseRecord[],
    },
    subjectOf: (id) => (f.pcp[id] ? { providerId: f.pcp[id]! } : null),
    providerOf: (id) => PROVIDERS.find((p) => p.id === id) ?? null,
    // Exposed for the compaction test, which flips it after the first read.
    ...({ setCompacted: (v: boolean) => (compacted = v) } as object),
  } as ScorecardDeps;
}

const request = (over: Partial<ScorecardRequest> = {}): ScorecardRequest => ({
  measurementYear: 2026,
  measures: [{ id: "cms125", name: "Breast Cancer Screening", policyRef: "CMS125" }],
  providerIds: null,
  ownsPanel: false,
  today: "2026-10-20",
  now: "2026-10-20T15:00:00.000Z",
  ...over,
});

test("rows group by PCP under their location; an unlisted PCP is Other; a patient gone from the directory counts nowhere", async () => {
  const rows = [
    row("s1", "cms125", one(true)),
    row("s2", "cms125", one(false)),
    row("s3", "cms125", one(true)),
    row("s4", "cms125", one(true)),
    row("s5", "cms125", one(false)),
    row("gone", "cms125", one(true)),
  ];
  const card = await buildScorecard(deps({ rows, pcp: { s1: "p-a", s2: "p-a", s3: "p-b", s4: "p-c", s5: "p-unlisted" } }), request());
  assert.deepEqual(card.locations.map((l) => [l.location, l.providers.map((p) => p.providerId)]), [
    ["North", ["p-a", "p-b"]],
    ["South", ["p-c"]],
  ]);
  const north = card.locations[0]!.subtotal.cells.cms125!.rates![0]!;
  assert.deepEqual([north.numer, north.denom], [2, 3], "North is its two providers' patients counted again");
  assert.deepEqual([card.other!.cells.cms125!.rates![0]!.numer, card.other!.cells.cms125!.rates![0]!.denom], [0, 1]);
  const total = card.total.cells.cms125!.rates![0]!;
  assert.deepEqual([total.numer, total.denom], [3, 5], "the patient no longer in the directory is in no row and no total");
});

test("a provider whose patients all errored still gets every rate the run declares", async () => {
  const measures = [{ id: "cms137", name: "Initiation and Engagement", policyRef: "CMS137" }];
  const rows = [row("s1", "cms137", two(true, false)), row("s2", "cms137", errored)];
  const card = await buildScorecard(deps({ rows, pcp: { s1: "p-a", s2: "p-c" } }), request({ measures }));
  const south = card.locations.find((l) => l.location === "South")!.providers[0]!.cells.cms137!;
  assert.equal(south.rates!.length, 2);
  assert.equal(south.buckets!.evaluationErrors, 1);
  assert.equal(south.rates![0]!.score, null, "no effective denominator, no rate");
});

test("a rate on fewer than 20 patients is marked small, and 20 is not", async () => {
  const rows = [
    ...Array.from({ length: 19 }, (_, i) => row(`a${i}`, "cms125", one(i % 2 === 0))),
    ...Array.from({ length: 20 }, (_, i) => row(`b${i}`, "cms125", one(i % 2 === 0))),
  ];
  const pcp = Object.fromEntries(rows.map((r) => [r.subjectId, r.subjectId.startsWith("a") ? "p-a" : "p-b"]));
  const card = await buildScorecard(deps({ rows, pcp }), request());
  const [a, b] = card.locations[0]!.providers;
  assert.equal(a!.cells.cms125!.rates![0]!.effectiveDenominator, 19);
  assert.equal(a!.cells.cms125!.rates![0]!.smallNumber, true);
  assert.equal(b!.cells.cms125!.rates![0]!.effectiveDenominator, 20);
  assert.equal(b!.cells.cms125!.rates![0]!.smallNumber, false);
});

test("My providers shows only the caller's providers, with totals over them and no Other row", async () => {
  const rows = [row("s1", "cms125", one(true)), row("s3", "cms125", one(false)), row("s5", "cms125", one(true))];
  const card = await buildScorecard(
    deps({ rows, pcp: { s1: "p-a", s3: "p-c", s5: "p-unlisted" } }),
    request({ providerIds: new Set(["p-a"]), ownsPanel: true }),
  );
  assert.deepEqual(card.panel, { requested: "me", ownsPanel: true });
  assert.deepEqual(card.locations.flatMap((l) => l.providers.map((p) => p.providerId)), ["p-a"]);
  assert.equal(card.other, null);
  assert.equal(card.total.cells.cms125!.rates![0]!.denom, 1);
});

test("a clinician's card is their provider's row and the practice total, with no location, Other or colleague (#870)", async () => {
  const rows = [
    row("s1", "cms125", one(true)),
    row("s2", "cms125", one(false)),
    row("s3", "cms125", one(true)),
    row("s4", "cms125", one(false)),
    row("s5", "cms125", one(true)),
  ];
  const fixture = {
    rows,
    pcp: { s1: "p-a", s2: "p-a", s3: "p-b", s4: "p-c", s5: "p-unlisted" },
    cases: [
      { employeeId: "s2", measureId: "cms125", evaluationPeriod: CYCLE, status: "OPEN" as const },
      { employeeId: "s4", measureId: "cms125", evaluationPeriod: CYCLE, status: "OPEN" as const },
    ],
  };
  const practice = await buildScorecard(deps(fixture), request());
  const card = await buildScorecard(deps(fixture), request({ onlyProvider: "p-a" }));

  assert.deepEqual(card.locations, [], "no location row, so no subtotal of p-b's figures beside p-a's");
  assert.equal(card.other, null);
  assert.deepEqual(card.panel, { requested: "all", ownsPanel: false });
  assert.deepEqual(
    { providerId: card.scope!.providerId, name: card.scope!.name, location: card.scope!.location },
    { providerId: "p-a", name: "Dr. A", location: "North" },
  );
  assert.deepEqual(card.scope!.row, practice.locations[0]!.providers[0], "the row the practice card gives p-a");
  // The total is the whole practice's, Other and every location included, open gaps too.
  assert.deepEqual(card.total, practice.total);
  assert.equal(card.total.cells.cms125!.rates![0]!.denom, 5);
  assert.equal(card.total.cells.cms125!.openGaps, 2);
  assert.equal(card.scope!.row.cells.cms125!.openGaps, 1);
  // Nothing names a colleague.
  const text = JSON.stringify(card);
  for (const colleague of ["p-b", "p-c", "Dr. B", "Dr. C", "South"]) {
    assert.equal(text.includes(colleague), false, `the card names ${colleague}`);
  }
  assert.equal("scope" in practice, false, "the practice card carries no scope");
});

test("a clinician whose provider has nobody counted still gets their row, so the total is never shown alone", async () => {
  const thin = { ...one(true), dataInsufficient: { checks: ["encounterTypeCoded"] } };
  const card = await buildScorecard(
    deps({ rows: [row("s3", "cms125", one(true)), row("s4", "cms137", thin)], pcp: { s3: "p-b", s4: "p-b" } }),
    request({
      onlyProvider: "p-a",
      measures: [
        { id: "cms125", name: "Breast Cancer Screening", policyRef: "CMS125" },
        { id: "cms137", name: "Initiation and Engagement", policyRef: "CMS137" },
      ],
    }),
  );
  const mine = card.scope!.row;
  assert.equal(mine.providerId, "p-a");
  // A complete column: zero counts, no rate. A refused column: null, as on every row.
  const [rate] = mine.cells.cms125!.rates!;
  assert.deepEqual([rate!.numer, rate!.denom, rate!.effectiveDenominator, rate!.score], [0, 0, 0, null]);
  assert.equal(mine.cells.cms137!.rates, null);
  assert.equal(card.total.cells.cms125!.rates![0]!.denom, 1, "the practice still counts p-b's patient");
});

test("a clinician's card refuses to be built with My providers, or for a provider the directory does not list", async () => {
  await assert.rejects(
    buildScorecard(deps({ pcp: {} }), request({ onlyProvider: "p-a", providerIds: new Set(["p-a"]) })),
    /exclusive/,
  );
  await assert.rejects(buildScorecard(deps({ pcp: {} }), request({ onlyProvider: "p-unlisted" })), /not in the directory/);
});

test("a thin column shows no rate but still states this year's open gaps", async () => {
  const thin = { ...one(true), dataInsufficient: { checks: ["encounterTypeCoded"] } };
  const card = await buildScorecard(
    deps({
      rows: [row("s1", "cms125", thin)],
      pcp: { s1: "p-a" },
      cases: [{ employeeId: "s1", measureId: "cms125", evaluationPeriod: CYCLE, status: "OPEN" }],
    }),
    request(),
  );
  assert.equal(card.measures[0]!.state, "data_insufficient");
  assert.deepEqual(card.measures[0]!.dataInsufficient, ["encounterTypeCoded"]);
  const cell = card.locations[0]!.providers[0]!.cells.cms125!;
  assert.equal(cell.rates, null);
  assert.equal(cell.openGaps, 1);
});

test("a past year states no open gaps: the work list is this year's cycle", async () => {
  const card = await buildScorecard(
    deps({
      rows: [row("s1", "cms125", one(true))],
      pcp: { s1: "p-a" },
      cases: [{ employeeId: "s1", measureId: "cms125", evaluationPeriod: CYCLE, status: "OPEN" }],
    }),
    request({ today: "2027-02-01" }),
  );
  assert.equal(card.openGapsShown, false);
  assert.equal(card.locations[0]!.providers[0]!.cells.cms125!.openGaps, null);
});

test("a measure with no run for the year says so, and a seeded run is never its run", async () => {
  const card = await buildScorecard(
    deps({ rows: [row("s1", "cms125", one(true), { runId: "scale" })], pcp: { s1: "p-a" }, runs: [{ id: "scale", triggeredBy: "seed:scale" }] }),
    request(),
  );
  assert.equal(card.measures[0]!.state, "no_run");
  assert.deepEqual(card.locations, []);
});

test("compaction is checked on every request: a run compacted since the last visit shows no rate", async () => {
  const d = deps({ rows: [row("s1", "cms125", one(true))], pcp: { s1: "p-a" } });
  assert.equal((await buildScorecard(d, request())).measures[0]!.state, "complete");
  (d as unknown as { setCompacted(v: boolean): void }).setCompacted(true);
  const card = await buildScorecard(d, request());
  assert.equal(card.measures[0]!.state, "compacted");
  assert.equal(card.total.cells.cms125!.rates, null);
});

test("open gaps are every active case in the cycle, not the store's first page of 50", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `s${i}`);
  const card = await buildScorecard(
    deps({
      rows: ids.map((id) => row(id, "cms125", one(false))),
      pcp: Object.fromEntries(ids.map((id) => [id, "p-a"])),
      cases: ids.map((id) => ({ employeeId: id, measureId: "cms125", evaluationPeriod: CYCLE, status: "OPEN" })),
    }),
    request(),
  );
  assert.equal(card.total.cells.cms125!.openGaps, 60);
});

test("a compaction that lands while the rows are read refuses the column, never a rate over a partial read", async () => {
  const d = deps({ rows: [row("s1", "cms125", one(true))], pcp: { s1: "p-a" } });
  const read = d.outcomes.listOutcomeSubjectMembershipsForRun;
  d.outcomes.listOutcomeSubjectMembershipsForRun = async (runId, measureId) => {
    (d as unknown as { setCompacted(v: boolean): void }).setCompacted(true);
    return read(runId, measureId);
  };
  const card = await buildScorecard(d, request());
  assert.equal(card.measures[0]!.state, "compacted");
});
