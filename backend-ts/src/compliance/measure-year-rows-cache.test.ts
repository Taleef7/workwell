/**
 * The scorecard's kept reads (#884): what is kept, what replaces it, what is shared and what is dropped.
 *
 *   node --import tsx --test src/compliance/measure-year-rows-cache.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MeasureYearRowsCache } from "./measure-year-rows-cache.ts";
import type { OutcomeSubjectMembership } from "../stores/outcome-store.ts";
import { scorecardRows } from "./scorecard.ts";
import { compactOutcomes } from "../run/outcome-compaction.ts";

const evidence = (numer: boolean) => ({ official: { populationResults: { ipp: true, denom: true, denex: false, numer, denexcep: false } } });

/** A store whose rows per (run, measure) are `subjects` patients, counting reads; `hold` makes the next read wait. */
function store(subjects: (runId: string, measureId: string) => number = () => 2) {
  const reads: string[] = [];
  let held: { release: () => void; fail: (err: Error) => void } | null = null;
  let gate: Promise<void> | null = null;
  return {
    reads,
    hold() {
      gate = new Promise<void>((resolve, reject) => {
        held = { release: resolve, fail: reject };
      });
      const handle = held!;
      return handle;
    },
    outcomes: {
      listOutcomeSubjectMembershipsForRun: async (runId: string, measureId: string): Promise<OutcomeSubjectMembership[]> => {
        reads.push(`${runId}|${measureId}`);
        const waiting = gate;
        gate = null;
        if (waiting) await waiting;
        return Array.from({ length: subjects(runId, measureId) }, (_, i) => ({
          id: `${runId}-${measureId}-${i}`,
          subjectId: `s${i}`,
          evaluatedAt: "2026-06-01T00:00:00.000Z",
          status: "COMPLIANT",
          evidence: evidence(i % 2 === 0),
        }));
      },
    },
  };
}

const cache = (maxEntries = 18, protectedYears: number[] = []) =>
  new MeasureYearRowsCache({ maxEntries: () => maxEntries, protectedYears: () => new Set(protectedYears) });
const run = (runId: string, startedAt = "2026-11-02T12:00:00.000Z") => ({ runId, startedAt });

test("a kept read answers the next request without reading again", async () => {
  const s = store();
  const c = cache();
  const first = await c.rows(s.outcomes, run("r1"), "cms125", 2026);
  const second = await c.rows(s.outcomes, run("r1"), "cms125", 2026);
  assert.equal(s.reads.length, 1);
  assert.equal(second, first);
  assert.equal(first.rows.length, 2);
});

test("requests for the same run, measure and year at once share one read", async () => {
  const s = store();
  const c = cache();
  const handle = s.hold();
  const a = c.rows(s.outcomes, run("r1"), "cms125", 2026);
  const b = c.rows(s.outcomes, run("r1"), "cms125", 2026);
  handle.release();
  assert.equal(await a, await b);
  assert.equal(s.reads.length, 1);
});

test("two measures of one run, or two years of one measure, never share a read", async () => {
  const s = store((_runId, measureId) => (measureId === "cms125" ? 2 : 3));
  const c = cache();
  const handle = s.hold();
  const [a, b] = [c.rows(s.outcomes, run("r1"), "cms125", 2026), c.rows(s.outcomes, run("r1"), "cms122", 2026)];
  handle.release();
  assert.equal((await a).rows.length, 2);
  assert.equal((await b).rows.length, 3);
  assert.deepEqual(s.reads, ["r1|cms125", "r1|cms122"]);

  const t = store();
  const d = cache();
  const held = t.hold();
  const [y2026, y2025] = [d.rows(t.outcomes, run("r1"), "cms125", 2026), d.rows(t.outcomes, run("r1"), "cms125", 2025)];
  held.release();
  await Promise.all([y2026, y2025]);
  assert.equal(t.reads.length, 2, "a year apart is a read apart");
  assert.notEqual(await y2026, await y2025);
});

test("another run is a miss", async () => {
  const s = store();
  const c = cache();
  await c.rows(s.outcomes, run("r1"), "cms125", 2026);
  await c.rows(s.outcomes, run("r2", "2026-11-03T12:00:00.000Z"), "cms125", 2026);
  assert.equal(s.reads.length, 2);
});

test("a newer run replaces the kept read; an older one never does, and a tie goes to the larger id", async () => {
  const s = store();
  const c = cache();
  await c.rows(s.outcomes, run("r-old", "2026-11-02T12:00:00.000Z"), "cms125", 2026);
  await c.rows(s.outcomes, run("r-new", "2026-11-03T12:00:00.000Z"), "cms125", 2026);
  await c.rows(s.outcomes, run("r-new", "2026-11-03T12:00:00.000Z"), "cms125", 2026);
  assert.equal(s.reads.length, 2, "the newer run is kept");
  // A request that chose last night's run reads it, but does not put it back over tonight's.
  await c.rows(s.outcomes, run("r-old", "2026-11-02T12:00:00.000Z"), "cms125", 2026);
  await c.rows(s.outcomes, run("r-new", "2026-11-03T12:00:00.000Z"), "cms125", 2026);
  assert.deepEqual(s.reads, ["r-old|cms125", "r-new|cms125", "r-old|cms125"]);

  // The store's order is `started_at DESC, id DESC`: on a tie the larger id is the newer run.
  const t = store();
  const d = cache();
  const same = "2026-11-03T12:00:00.000Z";
  await d.rows(t.outcomes, run("run-b", same), "cms125", 2026);
  await d.rows(t.outcomes, run("run-a", same), "cms125", 2026);
  await d.rows(t.outcomes, run("run-b", same), "cms125", 2026);
  assert.deepEqual(t.reads, ["run-b|cms125", "run-a|cms125"], "run-a never replaced run-b");
});

test("a shared read that fails is retried once by the one who joined it, and a failed read is never kept", async () => {
  const s = store();
  const c = cache();
  const handle = s.hold();
  const first = c.rows(s.outcomes, run("r1"), "cms125", 2026);
  const joiner = c.rows(s.outcomes, run("r1"), "cms125", 2026);
  handle.fail(new Error("statement timeout"));
  await assert.rejects(first, /statement timeout/);
  assert.equal((await joiner).rows.length, 2, "the joiner read on its own");
  assert.equal(s.reads.length, 2);
  await c.rows(s.outcomes, run("r1"), "cms125", 2026);
  assert.equal(s.reads.length, 2, "the joiner's read is kept");

  const t = store();
  const d = cache();
  const lone = t.hold();
  const alone = d.rows(t.outcomes, run("r1"), "cms125", 2026);
  lone.fail(new Error("boom"));
  await assert.rejects(alone, /boom/);
  await d.rows(t.outcomes, run("r1"), "cms125", 2026);
  assert.equal(t.reads.length, 2, "nothing was kept from the failure");
});

test("a reset drops what is kept, and a read in flight across it is not kept", async () => {
  const s = store();
  const c = cache();
  await c.rows(s.outcomes, run("r1"), "cms125", 2026);
  c.reset();
  await c.rows(s.outcomes, run("r1"), "cms125", 2026);
  assert.equal(s.reads.length, 2);

  const t = store();
  const d = cache();
  const handle = t.hold();
  const during = d.rows(t.outcomes, run("r1"), "cms125", 2026);
  d.reset(); // compaction lands while the read is outstanding
  handle.release();
  await during;
  assert.equal(d.size, 0);
  await d.rows(t.outcomes, run("r1"), "cms125", 2026);
  assert.equal(t.reads.length, 2, "the read that began before the reset was not kept");
});

test("past the bound the least recently used goes first, and a hit counts as a use", async () => {
  const s = store();
  const c = cache(2);
  await c.rows(s.outcomes, run("r1"), "cms125", 2026); // A
  await c.rows(s.outcomes, run("r1"), "cms122", 2026); // B
  await c.rows(s.outcomes, run("r1"), "cms125", 2026); // A again: now B is the least recent
  assert.equal(s.reads.length, 2);
  await c.rows(s.outcomes, run("r1"), "cms2", 2026); // C evicts B
  assert.equal(c.size, 2);
  await c.rows(s.outcomes, run("r1"), "cms125", 2026);
  assert.equal(s.reads.length, 3, "A survived");
  await c.rows(s.outcomes, run("r1"), "cms122", 2026);
  assert.equal(s.reads.length, 4, "B was evicted");
});

test("the working year outlives every year browsed after it", async () => {
  const s = store();
  const c = cache(2, [2026]);
  await c.rows(s.outcomes, run("r1"), "cms125", 2026); // the least recent, but protected
  await c.rows(s.outcomes, run("r1"), "cms125", 2025);
  await c.rows(s.outcomes, run("r1"), "cms125", 2024); // evicts 2025, not 2026
  await c.rows(s.outcomes, run("r1"), "cms125", 2026);
  assert.equal(s.reads.length, 3, "2026 was kept");
  await c.rows(s.outcomes, run("r1"), "cms125", 2025);
  assert.equal(s.reads.length, 4, "2025 was the one evicted");
});

test("outcome compaction drops the scorecard's kept reads, since it is what changes a finished run's rows", async () => {
  const s = store();
  scorecardRows.reset();
  await scorecardRows.rows(s.outcomes, run("r1"), "cms125", 2026);
  await compactOutcomes(
    {
      outcomes: { compactOlderThan: async () => 0 } as never,
      events: { appendAudit: async () => {} } as never,
    },
    { retentionDays: 400, now: Date.parse("2026-11-03T00:00:00Z") },
  );
  await scorecardRows.rows(s.outcomes, run("r1"), "cms125", 2026);
  assert.equal(s.reads.length, 2, "read again after compaction");
  scorecardRows.reset();
});
