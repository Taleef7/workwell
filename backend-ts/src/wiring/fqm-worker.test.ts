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
import { corpusBundleSource } from "./corpus-bundle-source.ts";
import { corpusDirectory } from "../engine/synthetic/corpus/corpus-directory.ts";
import { DEFAULT_CORPUS_SEED } from "../engine/synthetic/corpus/corpus-parameters.ts";

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

// The data the nightly actually scores (the Maui corpus), for every measure it routes — including cms137,
// the one with two rates and age strata, the richest shape that has to survive the thread boundary.
const CORPUS_DATE = `${new Date().getUTCFullYear()}-12-31`;
const CORPUS = corpusDirectory(DEFAULT_CORPUS_SEED, 80).EMPLOYEES;
for (const measureId of ["cms122", "cms125", "cms2", "cms130", "cms165", "cms137"]) {
  test(`the worker scores official ${measureId} exactly as the in-process call does (#604)`, { skip: skipWithout(measureId) }, async () => {
    const source = corpusBundleSource();
    const subjects = CORPUS.map((e) => ({ subjectId: e.externalId, patientBundle: source.bundleForSubject!(e, CORPUS_DATE) }));
    const expand = officialTerminologyExpander(loadOfficialArtifact);
    const worker = createFqmWorker();
    try {
      const inProcess = await officialMeasureExecutor({ expand }).evaluateBatch(measureId, subjects, CORPUS_DATE);
      const inWorker = await officialMeasureExecutor({ expand, calculateBatch: worker.calculate }).evaluateBatch(measureId, subjects, CORPUS_DATE);
      assert.equal(worker.requests, 1, "the second executor really calculated in the worker");
      assert.ok([...inProcess.values()].some((o) => o.inInitialPopulation), "someone is in the population, so the comparison says something");
      assert.deepEqual(inWorker, inProcess, "outcomes and evidence are identical");
    } finally {
      await worker.close();
    }
  });
}

test("a crashed worker's exit does not fail the next chunk, already sent to its replacement (#604, Codex)", async () => {
  const worker = createFqmWorker({ calculatorModule: FIXTURE });
  try {
    const crashed = worker.calculate(input([{ mode: "uncaught" }]));
    // The retry is posted from the rejection handler, i.e. between the old worker's `error` and `exit`.
    const retried = crashed.catch(() => worker.calculate(input([{}, {}])));
    await assert.rejects(crashed, /uncaught inside fqm/);
    const result = await retried;
    assert.equal(result.bySubject.size, 2, "the replacement worker's chunk survived the old worker's exit");
  } finally {
    await worker.close();
  }
});

test("chunks submitted together each get their own answer (the worker runs them one at a time) (#604)", async () => {
  const worker = createFqmWorker({ calculatorModule: FIXTURE });
  try {
    const [slow, fast, failing] = await Promise.allSettled([
      worker.calculate(input([{ mode: "busy", cpuMs: 300 }, {}, {}])),
      worker.calculate(input([{}])),
      worker.calculate(input([{ mode: "throw" }])),
    ]);
    assert.equal(slow.status === "fulfilled" && slow.value.bySubject.size, 3);
    assert.equal(fast.status === "fulfilled" && fast.value.bySubject.size, 1);
    assert.equal(failing.status, "rejected", "one chunk's failure stays that chunk's");
    assert.equal(worker.requests, 3);
  } finally {
    await worker.close();
  }
});
