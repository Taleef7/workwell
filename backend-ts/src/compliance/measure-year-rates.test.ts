/**
 * The counting the attributed-list report and the provider scorecard share (#852).
 *
 *   node --import tsx --test src/compliance/measure-year-rates.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldGroups, readMeasureYearRows, selectRunForYear } from "./measure-year-rates.ts";
import { scoringOfRows } from "../fhir/run-aggregate.ts";
import type { OutcomeRecord, OutcomeStore } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import { anyOutcomeVia, subjectMembershipsVia } from "../test-support/memberships.ts";

const pr = (ipp: boolean, denom: boolean, numer: boolean) => ({ ipp, denom, denex: false, numer, denexcep: false });
const oneRate = (numer: boolean) => ({ official: { populationResults: pr(true, true, numer) } });
const twoRates = (a: boolean, b: boolean) => ({
  official: { populationResults: pr(true, true, a), rates: [pr(true, true, a), pr(true, true, b)] },
});
const errored = { evaluationError: "engine failure", message: "boom" };

let seq = 0;
const row = (subjectId: string, evidence: unknown, over: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  id: `o-${String(++seq).padStart(4, "0")}`,
  runId: "run-1",
  subjectId,
  measureId: "cms137",
  evaluationPeriod: "2027",
  status: "COMPLIANT",
  evidence,
  evaluatedAt: "2027-06-01T00:00:00.000Z",
  ...over,
});

const store = (rows: OutcomeRecord[]): Pick<OutcomeStore, "anyOutcomeForMeasure" | "listOutcomeSubjectMembershipsForRun"> => {
  const listOutcomes = async (runId: string, opts?: { measureId?: string }) =>
    rows.filter((r) => r.runId === runId && (!opts?.measureId || r.measureId === opts.measureId));
  return { anyOutcomeForMeasure: anyOutcomeVia(listOutcomes), listOutcomeSubjectMembershipsForRun: subjectMembershipsVia(listOutcomes) };
};

test("a group whose rows all errored still reports every rate the RUN declares", async () => {
  const rows = [row("a", twoRates(true, false)), row("b", errored), row("c", errored)];
  const read = await readMeasureYearRows(store(rows), "run-1", "cms137", 2027);
  assert.equal(read.declaredRates, 2);
  const groups = foldGroups(read.rows, "cms137", read.declaredRates, (r) => (r.subjectId === "a" ? "p1" : "p2"));
  const p2 = groups.get("p2")!;
  assert.equal(p2.aggregate.rates.length, 2, "two zero rates, not one");
  assert.deepEqual(p2.buckets, { scored: 0, unmeasured: 0, evaluationErrors: 2, outOfPopulation: 0 });
  assert.equal(groups.get("p1")!.aggregate.rates[1]!.numer, 0);
  assert.equal(groups.get("p1")!.aggregate.rates[0]!.numer, 1);
});

test("the counted rows declare the rate count; a set of errors takes the run's, and a superseded row never sets it", async () => {
  // The kept subject's rows were scored with one rate: counted as they were scored, not as unmeasured
  // under a count only other subjects carry (the CSV writes each member's own rates).
  const kept = await readMeasureYearRows(store([row("a", twoRates(true, true)), row("b", oneRate(true))]), "run-1", "cms137", 2027, (id) => id === "b");
  assert.equal(kept.declaredRates, 1);
  assert.deepEqual(foldGroups(kept.rows, "cms137", kept.declaredRates, () => "list").get("list")!.buckets.scored, 1);

  // Every kept row errored: the run's count, so the group still reports both rates.
  const errors = await readMeasureYearRows(store([row("a", twoRates(true, true)), row("b", errored)]), "run-1", "cms137", 2027, (id) => id === "b");
  assert.equal(errors.declaredRates, 2);

  // An older two-rate row superseded by a newer one-rate row declares nothing.
  const superseded = await readMeasureYearRows(
    store([
      // Read newest first, so "the last row read" and "the newest row" disagree.
      row("a", oneRate(true), { evaluatedAt: "2027-06-02T00:00:00.000Z" }),
      row("a", twoRates(true, true), { evaluatedAt: "2027-06-01T00:00:00.000Z" }),
      row("b", errored),
    ]),
    "run-1",
    "cms137",
    2027,
    (id) => id === "b",
  );
  assert.equal(superseded.declaredRates, 1, "the run's newest rows carry one rate");
});

/** The fake store, recording each membership read's subject set (undefined = every row). */
const countingStore = (rows: OutcomeRecord[]) => {
  const base = store(rows);
  const reads: Array<readonly string[] | undefined> = [];
  const outcomes: Pick<OutcomeStore, "listOutcomeSubjectMembershipsForRun"> = {
    listOutcomeSubjectMembershipsForRun: async (runId, measureId, subjectIds) => {
      reads.push(subjectIds);
      return base.listOutcomeSubjectMembershipsForRun(runId, measureId, subjectIds);
    },
  };
  return { base, outcomes, reads };
};

test("a member SET reads only the members' rows, and answers exactly as the same predicate does (#874)", async () => {
  const rows = [
    row("a", twoRates(true, false)),
    row("b", oneRate(true), { evaluatedAt: "2027-06-01T00:00:00.000Z" }),
    row("b", oneRate(false), { evaluatedAt: "2027-06-02T00:00:00.000Z" }),
    row("c", errored),
    row("d", oneRate(true)),
  ];
  const { base, outcomes, reads } = countingStore(rows);
  const viaSet = await readMeasureYearRows(outcomes, "run-1", "cms137", 2027, new Set(["b", "c"]));
  const viaPredicate = await readMeasureYearRows(base, "run-1", "cms137", 2027, (id) => id === "b" || id === "c");
  assert.deepEqual(viaSet, viaPredicate);
  assert.deepEqual(reads, [["b", "c"]], "one read, narrowed to the members: a member was evaluated, so no run-wide read");
});

test("where no member was evaluated, a narrowed read still declares the RUN's rates, from one full read (#874)", async () => {
  const rows = [row("a", twoRates(true, true)), row("b", errored), row("c", oneRate(true))];
  const { base, outcomes, reads } = countingStore(rows);
  const viaSet = await readMeasureYearRows(outcomes, "run-1", "cms137", 2027, new Set(["b"]));
  assert.equal(viaSet.declaredRates, 2, "CMS137's two rates, read off the run's own rows");
  assert.deepEqual(viaSet, await readMeasureYearRows(base, "run-1", "cms137", 2027, (id) => id === "b"));
  assert.deepEqual(reads, [["b"], undefined], "the members, then the run in full for its rate count");
});

test("#875: facts are read only when asked, held on the newest kept row, and never by the run-wide fallback", async () => {
  const facts = (date: string) => ({ spec: 1, values: [{ define: "First SUD Episode During Measurement Period", value: date }] });
  const rows = [
    row("a", { ...oneRate(true), cqlFacts: facts("old") }, { evaluatedAt: "2027-06-01T00:00:00.000Z" }),
    row("a", { ...oneRate(false), cqlFacts: facts("new") }, { evaluatedAt: "2027-06-02T00:00:00.000Z" }),
    row("b", oneRate(true)),
    row("c", { ...oneRate(true), cqlFacts: { spec: 1, values: [{ define: 7 }] } }),
  ];
  const optsSeen: Array<{ cqlFacts?: boolean } | undefined> = [];
  const base = store(rows);
  const outcomes: Pick<OutcomeStore, "listOutcomeSubjectMembershipsForRun"> = {
    listOutcomeSubjectMembershipsForRun: async (runId, measureId, subjectIds, opts) => {
      optsSeen.push(opts);
      return base.listOutcomeSubjectMembershipsForRun(runId, measureId, subjectIds, opts);
    },
  };
  const asked = await readMeasureYearRows(outcomes, "run-1", "cms137", 2027, new Set(["a", "b", "c"]), { cqlFacts: true });
  const of = (id: string) => asked.rows.find((r) => r.subjectId === id)!;
  assert.deepEqual(of("a").cqlFacts, facts("new"), "the newest row's facts, with its populations");
  assert.equal(of("b").cqlFacts, null, "a row with none says so");
  assert.equal(of("c").cqlFacts, null, "an unreadable shape reads as none");
  const plain = await readMeasureYearRows(outcomes, "run-1", "cms137", 2027, new Set(["a"]));
  assert.equal("cqlFacts" in plain.rows[0]!, false, "not asked: the field is absent");

  // Every member errored, so the run's rate count takes a second, full read: it never asks for facts.
  optsSeen.length = 0;
  await readMeasureYearRows(
    { listOutcomeSubjectMembershipsForRun: async (runId, measureId, subjectIds, opts) => {
      optsSeen.push(opts);
      return store([row("x", errored), row("y", oneRate(true))]).listOutcomeSubjectMembershipsForRun(runId, measureId, subjectIds, opts);
    } },
    "run-1", "cms137", 2027, new Set(["x"]), { cqlFacts: true },
  );
  assert.deepEqual(optsSeen, [{ cqlFacts: true }, undefined]);
});

test("two rows whose blocks differ only where the trimmed identity cannot see are still a mix", async () => {
  // `officialReportIdentity` trims the digest; `scoringLogicKeyOf` reads it raw. Keyed on the trimmed form
  // alone, one sample stood for both rows and the mix went unseen.
  const block = (sha: string) => ({
    official: { ecqmId: "CMS137FHIR", version: "1.0.000", artifactSha256: sha, populationResults: pr(true, true, true) },
  });
  const read = await readMeasureYearRows(store([row("a", block("abc")), row("b", block(" abc "))]), "run-1", "cms137", 2027);
  const direct = scoringOfRows([block("abc"), block(" abc ")]);
  assert.equal(direct.conflict, true, "the rule the run detail applies calls these a mix");
  assert.equal(read.mixedLogic, true);
});

test("groups partition the run: their counts sum to the whole, and a null group counts nowhere", async () => {
  const rows = [
    row("a", twoRates(true, false)),
    row("b", twoRates(false, false)),
    row("c", twoRates(true, true)),
    row("d", twoRates(true, true), { outOfPopulation: true }),
    row("gone", twoRates(true, true)),
  ];
  const read = await readMeasureYearRows(store(rows), "run-1", "cms137", 2027);
  const provider: Record<string, string | null> = { a: "p1", b: "p1", c: "p2", d: "p2", gone: null };
  const groups = foldGroups(read.rows, "cms137", read.declaredRates, (r) => provider[r.subjectId] ?? null);
  const whole = foldGroups(read.rows.filter((r) => r.subjectId !== "gone"), "cms137", read.declaredRates, () => "all").get("all")!;
  for (const index of [0, 1]) {
    for (const field of ["ipp", "denom", "numer", "denex", "denexcep"] as const) {
      const sum = [...groups.values()].reduce((n, g) => n + g.aggregate.rates[index]![field], 0);
      assert.equal(sum, whole.aggregate.rates[index]![field], `rate ${index} ${field}`);
    }
  }
  assert.equal([...groups.values()].reduce((n, g) => n + g.seen, 0), 4);
  assert.equal(groups.get("p2")!.buckets.outOfPopulation, 1);
});

test("the newest row per subject wins by instant, a superseded row's logic is not counted, and rows are served in time order", async () => {
  const translation = {
    official: { kind: "derived", label: "WorkWell translation of CMS137v15", url: "urn:workwell:t", populationResults: pr(true, true, true) },
  };
  const rows = [
    // 10:00+02:00 is 08:00Z: OLDER than the 09:30Z row, though it sorts after it as a string.
    row("a", translation, { evaluatedAt: "2027-06-01T10:00:00+02:00" }),
    row("a", oneRate(false), { evaluatedAt: "2027-06-01T09:30:00Z" }),
    row("b", oneRate(true)),
  ];
  const read = await readMeasureYearRows(store(rows), "run-1", "cms137", 2027);
  assert.equal(read.duplicateRowsCollapsed, 1);
  assert.equal(read.rows.find((r) => r.subjectId === "a")!.memberships[0]!.numer, false);
  assert.equal(read.mixedLogic, false, "the translation row was superseded, so no mix");
  // Served by each kept row's (evaluatedAt, id): b's row (00:00Z) before a's newest (09:30Z), whatever the read order.
  assert.deepEqual(read.rows.map((r) => r.subjectId), ["b", "a"]);
});

test("two logics among the kept rows are a mix", async () => {
  const translation = {
    official: { kind: "derived", label: "WorkWell translation of CMS137v15", url: "urn:workwell:t", populationResults: pr(true, true, true) },
  };
  const read = await readMeasureYearRows(store([row("a", translation), row("b", oneRate(true))]), "run-1", "cms137", 2027);
  assert.equal(read.mixedLogic, true);
  assert.equal(read.logic, null);
});

test("a thin measure's flag is read off every kept row, errored ones included", async () => {
  const thin = { dataInsufficient: { checks: ["failedFetches"] } };
  const read = await readMeasureYearRows(store([row("a", { ...errored, ...thin }), row("b", oneRate(true))]), "run-1", "cms137", 2027);
  assert.deepEqual(read.dataInsufficient, ["failedFetches"]);
  // A flag naming no check still refuses, as `aggregateOfficialRun` does: absent is the only "sufficient".
  const unnamed = await readMeasureYearRows(store([row("a", { ...oneRate(true), dataInsufficient: {} })]), "run-1", "cms137", 2027);
  assert.deepEqual(unnamed.dataInsufficient, []);
});

test("run selection skips seeded runs and runs created for QRDA I imports", async () => {
  const run = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    status: "COMPLETED",
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "nightly",
    requestedScope: {},
    startedAt: "2027-06-01T00:00:00.000Z",
    measurementPeriodStart: "2027-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2027-12-31T23:59:59.999Z",
    ...over,
  });
  const runs = [
    run("scale", { triggeredBy: "seed:scale" }),
    run("trend", { triggeredBy: "seed:trend-history" }),
    run("import", { requestedScope: { importDriven: true } }),
    run("real"),
  ];
  const rows = runs.map((r) => row("a", oneRate(true), { runId: r.id }));
  const selected = await selectRunForYear(
    {
      runs: { listPopulationRunsForPeriod: async () => runs } as unknown as Pick<RunStore, "listPopulationRunsForPeriod">,
      outcomes: store(rows),
    },
    "cms137",
    2027,
  );
  assert.equal(selected?.runId, "real");
});
