/**
 * The per-call phase timing (#563).
 *
 *   node --import tsx --test src/run/phase-timing.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKWELL_RUNTIME_PREFIX,
  batchPhaseTiming,
  formatPhaseTiming,
  emitPhaseTiming,
  type BatchPhaseTiming,
} from "./phase-timing.ts";

const base = { runId: "run-1", measureId: "cms122", subjects: 500, batchMs: 6400, bundleMs: 900, outcome: "batched" as const };

test("the executor's own time is separated from bundle construction — they have different fixes", () => {
  const t = batchPhaseTiming(base);
  assert.equal(t.bundleMs, 900);
  assert.equal(t.evalMs, 5500, "evalMs is the await minus the factory, not the whole await");
  assert.equal(t.batchMs, 6400, "the total is still reported, so the two parts can be reconciled");
});

test("a clock hiccup cannot publish a negative duration", () => {
  // The two readings bracket a NESTED call, so bundleMs > batchMs is possible by a millisecond.
  // A negative evalMs would read as a bug in the executor rather than as measurement noise.
  const t = batchPhaseTiming({ ...base, batchMs: 100, bundleMs: 101 });
  assert.equal(t.evalMs, 0);
});

test("zero subjects reports 0 per subject, not NaN or Infinity", () => {
  // A chunk can offer a measure no subjects. `NaN` serializes to `null` in JSON and would read as
  // "not measured"; Infinity serializes to `null` too. Both are indistinguishable from a missing field.
  const t = batchPhaseTiming({ ...base, subjects: 0, batchMs: 12 });
  assert.equal(t.msPerSubject, 0);
  assert.ok(Number.isFinite(t.msPerSubject));
  assert.match(formatPhaseTiming(t), /"msPerSubject":0/, "and it survives serialization as a number");
});

test("msPerSubject is the figure the 11-16 ms prior is compared against", () => {
  assert.equal(batchPhaseTiming(base).msPerSubject, 12.8);
  assert.equal(batchPhaseTiming({ ...base, subjects: 3, batchMs: 10 }).msPerSubject, 3.33, "rounded to 2dp");
});

test("the line is ONE line of parseable JSON behind a prefix that is not WORKWELL_ALERT", () => {
  const line = formatPhaseTiming(batchPhaseTiming(base));
  assert.equal(line.split("\n").length, 1, "a multi-line event is split by log shippers");
  assert.ok(line.startsWith(`${WORKWELL_RUNTIME_PREFIX} `));
  assert.ok(!line.startsWith("WORKWELL_ALERT"), "operators grep WORKWELL_ALERT as an incident signal");
  const parsed = JSON.parse(line.slice(WORKWELL_RUNTIME_PREFIX.length + 1)) as BatchPhaseTiming;
  assert.equal(parsed.measureId, "cms122");
  assert.equal(parsed.kind, "evaluateBatch");
});

test("all three outcomes are timed — a failure after 30 s is as interesting as a success", () => {
  for (const outcome of ["batched", "not-batchable", "failed"] as const) {
    const t = batchPhaseTiming({ ...base, outcome });
    assert.equal(t.outcome, outcome);
    assert.equal(t.batchMs, 6400, `${outcome} still carries its duration`);
  }
});

test("a THROWING sink is swallowed — an instrument may never fail the run it measures", () => {
  // The hazard is a SYNCHRONOUS throw (closed stdout, or a non-function passed by a caller). A bare
  // `.catch()` would not contain it, and the run-pipeline call site sits after the subjects are
  // already evaluated.
  assert.doesNotThrow(() =>
    emitPhaseTiming(batchPhaseTiming(base), () => {
      throw new TypeError("stdout is closed");
    }),
  );
});

test("the sink receives the timing OBJECT, so a caller need not parse a line back", () => {
  const seen: BatchPhaseTiming[] = [];
  emitPhaseTiming(batchPhaseTiming(base), (t) => seen.push(t));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.measureId, "cms122");
  assert.equal(seen[0]!.evalMs, 5500);
});
