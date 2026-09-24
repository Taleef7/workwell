/**
 * #604: the official calculation in a worker thread.
 *   node --import tsx --test src/wiring/fqm-worker.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFqmWorker } from "./fqm-worker.ts";
import { officialMeasureExecutor } from "./official-executor-adapter.ts";
import { officialTerminologyExpander, loadOfficialTerminology } from "./official-terminology.ts";
import { loadOfficialArtifact } from "./official-artifacts.ts";
import { directSyntheticGenerator } from "../run/scale-generator.ts";
import type { TargetOutcome } from "../engine/synthetic/exam-config.ts";

const FIXTURE = new URL("./fqm-worker.fixture-calculator.ts", import.meta.url).href;
const PERIOD = { start: "2026-01-01", end: "2026-12-31" };
const input = (bundles: unknown[]) => ({ bundle: { resourceType: "Bundle" as const, entry: [] }, patientBundles: bundles, period: PERIOD });

test("the event loop keeps serving while a CPU-bound calculation runs in the worker (#604)", async () => {
  const worker = createFqmWorker({ calculatorModule: FIXTURE });
  try {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = Date.now();
    const result = await worker.calculate(input([{ mode: "busy", cpuMs: 1500 }]));
    clearInterval(timer);
    assert.ok(Date.now() - started >= 1500, "the calculation really ran for its full CPU time");
    // In-process, a 1.5 s synchronous loop allows zero ticks until it ends. Allow generous scheduling slack.
    assert.ok(ticks >= 25, `the main thread ticked ${ticks} times during 1.5 s of worker CPU`);
    assert.equal(result.bySubject.size, 1, "and the reduced result came back");
    assert.equal(result.retrieveSignal, true);
  } finally {
    await worker.close();
  }
});

test("an error in the calculation rejects with its message; a crashed worker rejects its chunk and the next one runs (#604)", async () => {
  const worker = createFqmWorker({ calculatorModule: FIXTURE });
  try {
    await assert.rejects(() => worker.calculate(input([{ mode: "throw" }])), /fqm could not parse the measure/);
    await assert.rejects(() => worker.calculate(input([{ mode: "exit" }])), /exited \(code 3\) with a chunk in flight/);
    const after = await worker.calculate(input([{}, {}]));
    assert.equal(after.bySubject.size, 2, "a fresh worker served the next chunk");
  } finally {
    await worker.close();
  }
});

const skipWithout = (id: string) => {
  const artifact = loadOfficialArtifact(id);
  return artifact && loadOfficialTerminology(artifact).ok ? false : `run 'pnpm vendor:official' to fetch ${id}'s terminology sidecar`;
};

test("the worker scores a real official measure exactly as the in-process call does (#604)", { skip: skipWithout("cms125") }, async () => {
  const generator = directSyntheticGenerator();
  const targets: TargetOutcome[] = ["COMPLIANT", "OVERDUE", "MISSING_DATA", "EXCLUDED"];
  const subjects = Array.from({ length: 24 }, (_, i) => {
    const subjectId = `w604-${i}`;
    return { subjectId, patientBundle: generator.bundleFor(subjectId, "cms125", targets[i % targets.length]!, "2026-07-27") };
  });
  const expand = officialTerminologyExpander(loadOfficialArtifact);
  const worker = createFqmWorker();
  try {
    const inProcess = await officialMeasureExecutor({ expand }).evaluateBatch("cms125", subjects, "2026-07-27");
    const inWorker = await officialMeasureExecutor({ expand, calculateBatch: worker.calculate }).evaluateBatch("cms125", subjects, "2026-07-27");
    assert.equal(worker.requests, 1, "the second executor really calculated in the worker");
    assert.equal(inProcess.size, subjects.length);
    assert.ok(new Set([...inProcess.values()].map((o) => o.outcome)).size > 1, "the roster is not degenerate");
    assert.deepEqual(inWorker, inProcess, "outcomes and evidence are identical");
  } finally {
    await worker.close();
  }
});
