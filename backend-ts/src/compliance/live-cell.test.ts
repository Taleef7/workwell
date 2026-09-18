/**
 * `liveCellsFor` (#569) — what CQL says TODAY for a small set of (subject, measure) pairs.
 *
 * Two properties this suite exists to hold, and each is a defect the first draft had:
 *  - the read is BOUNDED (the requested subjects, from the winning run) and never fills the roster's
 *    per-run cell cache. Filling it is a 20,000-row evidence read per measure on the pilot, six of
 *    them on a cold page, to annotate a handful of rows — the latency shape #561 exists to remove;
 *  - "not currently evaluable" is its OWN answer. A subject the winning run never evaluated, or a
 *    measure with no winning run, is UNKNOWN — folding either into CLEAR would let a patient nobody
 *    has scored read as no longer a gap.
 *
 * node --import tsx --test src/compliance/live-cell.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeRecord, OutcomeWithRun } from "../stores/outcome-store.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";
import { liveAnswerForCase, liveCellsFor, livePairKey, type LiveCellDeps } from "./live-cell.ts";
import { cellFromOutcome, type RosterCellCache } from "./roster-read-model.ts";

const ev = (results: Array<[string, unknown]>) => ({ expressionResults: results.map(([define, result]) => ({ define, result })) });

/** The cycle every fixture row describes, unless a test deliberately dates one elsewhere. */
const PERIOD = "2026-06-13";

/** One outcome row. `measureId` defaults to audiogram, whose binding the vocabulary knows. */
const outcome = (over: Partial<OutcomeRecord> & { subjectId: string; status: string }): OutcomeRecord => ({
  id: `o-${over.subjectId}-${over.measureId ?? "audiogram"}`,
  runId: over.runId ?? "run-1",
  measureId: over.measureId ?? "audiogram",
  evaluationPeriod: over.evaluationPeriod ?? "2026-06-13",
  evidence: over.evidence ?? ev([["Outcome Status", over.status]]),
  evaluatedAt: over.evaluatedAt ?? "2026-06-13T00:00:00Z",
  outOfPopulation: over.outOfPopulation,
  subjectId: over.subjectId,
  status: over.status,
});

const winner = (measureId: string, runId: string): OutcomeWithRun => ({
  runId, runStartedAt: "2026-06-13T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED",
  runTriggeredBy: "manual", subjectId: "unused", measureId, status: "OVERDUE",
});

/**
 * A fake that RESPECTS `subjectIds` and records every call — so a re-implementation that reads the
 * whole run (no `subjectIds`) fails the boundedness assertions rather than passing quietly.
 */
function recordingStore(winners: OutcomeWithRun[], byRun: Record<string, OutcomeRecord[]>) {
  const calls: Array<{ runId: string; measureId?: string; subjectIds?: readonly string[] }> = [];
  const store = {
    listLatestPopulationRuns: latestRunsFromRows(winners),
    listOutcomes: async (runId: string, opts?: { measureId?: string; subjectIds?: readonly string[] }) => {
      calls.push({ runId, measureId: opts?.measureId, subjectIds: opts?.subjectIds });
      let rows = byRun[runId] ?? [];
      if (opts?.measureId != null) rows = rows.filter((o) => o.measureId === opts.measureId);
      if (opts?.subjectIds !== undefined) {
        const wanted = new Set(opts.subjectIds);
        rows = rows.filter((o) => wanted.has(o.subjectId));
      }
      return rows;
    },
  };
  return { deps: { outcomeStore: store } as unknown as LiveCellDeps, calls };
}

test("liveCellsFor — GAP, CLEAR and UNKNOWN are three distinct answers", async () => {
  const winners = [winner("audiogram", "run-1"), winner("hazwoper", "run-2")];
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [
      outcome({ subjectId: "gap", status: "OVERDUE" }),
      outcome({ subjectId: "due", status: "DUE_SOON" }),
      outcome({ subjectId: "missing", status: "MISSING_DATA" }),
      outcome({ subjectId: "compliant", status: "COMPLIANT" }),
      outcome({ subjectId: "excluded", status: "EXCLUDED" }),
    ],
    "run-2": [outcome({ subjectId: "gap", measureId: "hazwoper", status: "OVERDUE", runId: "run-2" })],
  };
  const { deps } = recordingStore(winners, byRun);

  const answers = await liveCellsFor(deps, [
    { subjectId: "gap", measureId: "audiogram" },
    { subjectId: "due", measureId: "audiogram" },
    { subjectId: "missing", measureId: "audiogram" },
    { subjectId: "compliant", measureId: "audiogram" },
    { subjectId: "excluded", measureId: "audiogram" },
    // In the run, but this measure's run never evaluated them.
    { subjectId: "never-evaluated", measureId: "audiogram" },
    // A measure with no winning run at all.
    { subjectId: "gap", measureId: "mmr" },
  ]);
  const state = (subjectId: string, measureId: string) => answers.get(livePairKey(subjectId, measureId))?.state;

  // The three buckets `dispositionFor` calls OPEN — the same rule that decides a case is opened, so a
  // gap the run counts and a gap the work list counts cannot disagree.
  assert.equal(state("gap", "audiogram"), "GAP");
  assert.equal(state("due", "audiogram"), "GAP");
  assert.equal(state("missing", "audiogram"), "GAP");
  assert.equal(state("compliant", "audiogram"), "CLEAR");
  assert.equal(state("excluded", "audiogram"), "CLEAR", "an excluded patient is not a gap the practice can close");
  assert.equal(state("never-evaluated", "audiogram"), "UNKNOWN", "in no winning run → not evaluable, NOT clear");
  assert.equal(state("gap", "mmr"), "UNKNOWN", "no winning run for the measure → not evaluable, NOT clear");
  assert.equal(answers.get(livePairKey("gap", "mmr"))!.runId, null, "and it says there is no run behind the answer");
  assert.equal(answers.get(livePairKey("gap", "audiogram"))!.runId, "run-1", "while a real answer names its run");
});

test("liveCellsFor — a DECLINED cell is a GAP, because the CANONICAL bucket decides (not the display state)", async () => {
  // A documented refusal displays DECLINED, which is a read-time refinement of a NON-COMPLIANT
  // canonical bucket: the run still counts the patient. Keying the question off the display state
  // would drop them from the count, and nothing on screen would say a refusal had been reclassified
  // as resolved. The mutant this catches is `dispositionFor(cell.status)` instead of `.canonical`.
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [
      outcome({ subjectId: "refused", measureId: "mmr", runId: "run-1", status: "OVERDUE", evidence: ev([["Refused", true], ["Outcome Status", "OVERDUE"]]) }),
    ],
    // Out of population is the other direction: a MISSING_DATA row the measure's own logic put
    // OUTSIDE its population is not work (ADR-078), so it must read CLEAR. The cell is decided by the
    // persisted EVIDENCE, not by the row's flag or today's routing (Codex #540), so the fixture
    // carries real official population results — an earlier version of this test set only
    // `outOfPopulation: true` and got MISSING_DATA/GAP, which is the honest answer to that evidence.
    "run-2": [
      outcome({
        subjectId: "outside", measureId: "cms122", runId: "run-2", status: "MISSING_DATA", outOfPopulation: true,
        evidence: { expressionResults: [], official: { populationResults: { ipp: false, denom: false, denex: false, numer: false, denexcep: false } } },
      }),
    ],
  };
  const { deps } = recordingStore([winner("mmr", "run-1"), winner("cms122", "run-2")], byRun);
  const answers = await liveCellsFor(deps, [
    { subjectId: "refused", measureId: "mmr" },
    { subjectId: "outside", measureId: "cms122" },
  ]);

  const refused = answers.get(livePairKey("refused", "mmr"))!;
  assert.equal(refused.cell?.status, "DECLINED", "the DISPLAY state is the refusal");
  assert.equal(refused.cell?.canonical, "OVERDUE", "and the canonical bucket is what the run wrote");
  assert.equal(refused.state, "GAP", "so the patient is still counted");

  const outside = answers.get(livePairKey("outside", "cms122"))!;
  assert.equal(outside.cell?.status, "OUT_OF_POPULATION");
  assert.equal(outside.cell?.canonical, "MISSING_DATA", "the persisted bucket is unchanged — the display state is the refinement");
  assert.equal(outside.state, "CLEAR", "and a patient the measure does not describe is not a gap");
});

test("liveCellsFor — ONE bounded query per measure, carrying exactly the requested subjects", async () => {
  const winners = [winner("audiogram", "run-1"), winner("hazwoper", "run-2")];
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [outcome({ subjectId: "a", status: "OVERDUE" }), outcome({ subjectId: "unrelated", status: "OVERDUE" })],
    "run-2": [outcome({ subjectId: "b", measureId: "hazwoper", runId: "run-2", status: "COMPLIANT" })],
  };
  const { deps, calls } = recordingStore(winners, byRun);

  await liveCellsFor(deps, [
    { subjectId: "a", measureId: "audiogram" },
    { subjectId: "b", measureId: "hazwoper" },
  ]);

  assert.equal(calls.length, 2, "one read per measure — never one per pair, never one per run page");
  for (const call of calls) {
    assert.ok(call.measureId, "the measure is pushed into SQL");
    assert.ok(call.subjectIds, "and so is the subject set — a call without it would read the whole run");
  }
  assert.deepEqual([...calls.find((c) => c.measureId === "audiogram")!.subjectIds!].sort(), ["a"], "only the requested subject, not the run's others");
  assert.deepEqual([...calls.find((c) => c.measureId === "hazwoper")!.subjectIds!].sort(), ["b"]);
});

test("liveCellsFor — reads the roster cache through for the SAME run, and never fills it on a miss", async () => {
  const winners = [winner("audiogram", "run-1")];
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [outcome({ subjectId: "a", status: "OVERDUE" }), outcome({ subjectId: "b", status: "COMPLIANT" })],
  };

  // (1) A cache MISS answers from the bounded read and leaves the cache exactly as it was. The mutant
  //     here is the version that populated the cache like `buildRoster` does: it would read the whole
  //     run, and the cache would gain an entry.
  const cache: RosterCellCache = new Map();
  const miss = recordingStore(winners, byRun);
  const missAnswers = await liveCellsFor({ ...miss.deps, cellCache: cache }, [{ subjectId: "a", measureId: "audiogram" }]);
  assert.equal(missAnswers.get(livePairKey("a", "audiogram"))!.state, "GAP");
  assert.equal(miss.calls.length, 1);
  assert.equal(cache.size, 0, "a point lookup must not populate the roster's per-run cache");

  // (2) A cache HIT for the SAME run answers with NO query at all — the roster has already paid for
  //     this run, so the page rides on it.
  const cells = new Map([
    ["a", cellFromOutcome(byRun["run-1"]![0]!, "audiogram", "run-1")],
    ["b", cellFromOutcome(byRun["run-1"]![1]!, "audiogram", "run-1")],
  ]);
  const warm = recordingStore(winners, byRun);
  const warmCache: RosterCellCache = new Map([["audiogram", { runId: "run-1", cells }]]);
  const warmAnswers = await liveCellsFor({ ...warm.deps, cellCache: warmCache }, [
    { subjectId: "a", measureId: "audiogram" },
    { subjectId: "b", measureId: "audiogram" },
    { subjectId: "absent", measureId: "audiogram" },
  ]);
  assert.equal(warm.calls.length, 0, "the cache entry for the winning run answers every subject");
  assert.equal(warmAnswers.get(livePairKey("a", "audiogram"))!.state, "GAP");
  assert.equal(warmAnswers.get(livePairKey("b", "audiogram"))!.state, "CLEAR");
  assert.equal(warmAnswers.get(livePairKey("absent", "audiogram"))!.state, "UNKNOWN", "the entry holds the WHOLE run, so a subject it lacks is absent from the run");

  // (3) A cache entry for a DIFFERENT (superseded) run is ignored rather than served: the answer must
  //     come from the run that wins TODAY, which is the whole point of calling this "live".
  const stale = recordingStore(winners, byRun);
  const staleCache: RosterCellCache = new Map([["audiogram", { runId: "run-0", cells: new Map() }]]);
  const staleAnswers = await liveCellsFor({ ...stale.deps, cellCache: staleCache }, [{ subjectId: "a", measureId: "audiogram" }]);
  assert.equal(stale.calls.length, 1, "a stale entry is not an answer");
  assert.equal(staleAnswers.get(livePairKey("a", "audiogram"))!.state, "GAP");
  assert.equal(staleCache.get("audiogram")!.runId, "run-0", "and it is left alone, not refilled");
});

test("liveCellsFor — no pairs is no work, and duplicate pairs are one read", async () => {
  const { deps, calls } = recordingStore([winner("audiogram", "run-1")], { "run-1": [outcome({ subjectId: "a", status: "OVERDUE" })] });
  assert.equal((await liveCellsFor(deps, [])).size, 0);
  assert.equal(calls.length, 0, "an empty request touches no store");

  const answers = await liveCellsFor(deps, [
    { subjectId: "a", measureId: "audiogram" },
    { subjectId: "a", measureId: "audiogram" },
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0]!.subjectIds!], ["a"], "the same subject twice is one bind, not two");
  assert.equal(answers.size, 1, "and one answer, keyed by the pair");
});

test("liveCellsFor — a subject set larger than the chunk is SPLIT, and every subject still answers", async () => {
  // The floor expands `subjectIds` into a bound per id, and SQLite's limit is 999. A page cannot
  // reach 900 subjects today, but the helper is also called by the CSV export, whose page IS the
  // whole staff-closed set — so the chunking is the difference between an answer and a driver error
  // the day somebody closes a thousand cases.
  const PAIRS = 2_050;
  const subjects = Array.from({ length: PAIRS }, (_, i) => `p-${i}`);
  const rows = subjects.map((subjectId, i) =>
    outcome({ subjectId, status: i % 2 === 0 ? "OVERDUE" : "COMPLIANT" }),
  );
  const asked: number[] = [];
  const deps = {
    outcomeStore: {
      listLatestPopulationRuns: latestRunsFromRows([winner("audiogram", "run-1")]),
      listOutcomes: async (_runId: string, opts?: { subjectIds?: readonly string[] }) => {
        const wanted = opts?.subjectIds ?? [];
        asked.push(wanted.length);
        const set = new Set(wanted);
        return rows.filter((o) => set.has(o.subjectId));
      },
    },
  } as unknown as LiveCellDeps;

  const live = await liveCellsFor(deps, subjects.map((subjectId) => ({ subjectId, measureId: "audiogram" })));

  assert.equal(live.size, PAIRS, "every requested pair has an answer");
  assert.ok(asked.length > 1, "the read was split");
  assert.ok(asked.every((n) => n <= 900), `no chunk exceeds the bind budget: ${asked.join(",")}`);
  assert.equal(asked.reduce((a, b) => a + b, 0), PAIRS, "and every subject was asked about exactly once");
  assert.equal(live.get(livePairKey("p-0", "audiogram"))!.state, "GAP");
  assert.equal(live.get(livePairKey("p-2049", "audiogram"))!.state, "CLEAR");
});

test("runByMeasure is AUTHORITATIVE — the caller's run is read and no winner is resolved again", async () => {
  // The programs overview passes the run each card's own numbers came from, which on a scoped
  // overview can be an older visible run than the global winner. If this helper resolved winners
  // anyway, the chip would answer from a different run than the buckets it sits beside.
  let winnersRead = 0;
  const asked: string[] = [];
  const deps = {
    outcomeStore: {
      listLatestPopulationRuns: async () => { winnersRead += 1; return []; },
      listOutcomes: async (runId: string) => { asked.push(runId); return [outcome({ subjectId: "p-1", status: "OVERDUE" })]; },
    },
  } as unknown as LiveCellDeps;

  const live = await liveCellsFor(
    deps,
    [{ subjectId: "p-1", measureId: "audiogram" }, { subjectId: "p-2", measureId: "unnamed" }],
    { runByMeasure: new Map([["audiogram", "chosen-run"]]) },
  );

  assert.equal(winnersRead, 0, "the winners walk is not issued at all — the caller has already chosen");
  assert.deepEqual(asked, ["chosen-run"], "and the caller's run is the one read");
  assert.equal(live.get(livePairKey("p-1", "audiogram"))!.runId, "chosen-run");
  assert.equal(live.get(livePairKey("p-1", "audiogram"))!.state, "GAP");
  // A measure the caller did not name has no run it is willing to stand behind, so the answer is
  // UNKNOWN rather than one fetched from somewhere the caller did not ask about.
  assert.equal(live.get(livePairKey("p-2", "unnamed"))!.state, "UNKNOWN");
  assert.equal(live.get(livePairKey("p-2", "unnamed"))!.runId, null);
});

test("liveAnswerForCase — a cell from another cycle is not evidence about this one", async () => {
  // The rule three surfaces need (the work list, the cases CSV, the programs chip) and therefore the
  // rule that lives in ONE place: a rule written out three times is a rule one surface ends up
  // without, which is what review found on the CSV.
  const cell = cellFromOutcome(outcome({ subjectId: "p-1", status: "COMPLIANT" }), "audiogram", "win-1");
  const live = new Map([[livePairKey("p-1", "audiogram"), { state: "CLEAR" as const, runId: "win-1", cell }]]);
  const base = { employeeId: "p-1", measureId: "audiogram" };

  assert.equal(cell.evaluationPeriod, PERIOD, "the derived cell records the cycle it describes");
  const sameCycle = liveAnswerForCase(live, { ...base, evaluationPeriod: PERIOD });
  assert.equal(sameCycle.state, "CLEAR");
  assert.equal(sameCycle.cell, cell);

  const otherCycle = liveAnswerForCase(live, { ...base, evaluationPeriod: "2019-01-01" });
  assert.equal(otherCycle.state, "UNKNOWN", "never CLEAR: the patient became compliant in ANOTHER year");
  assert.equal(otherCycle.cell, null);
  assert.equal(otherCycle.runId, "win-1", "the run id survives — the measure has a winner, it describes another cycle");

  // A pair the map never answered is UNKNOWN with no run at all, which is a different fact.
  const absent = liveAnswerForCase(live, { employeeId: "p-9", measureId: "audiogram", evaluationPeriod: PERIOD });
  assert.equal(absent.state, "UNKNOWN");
  assert.equal(absent.runId, null);
});
