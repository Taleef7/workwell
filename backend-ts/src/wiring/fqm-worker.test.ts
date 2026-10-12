/**
 * #604: the official calculation in a worker thread.
 *   node --import tsx --test src/wiring/fqm-worker.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { __resetSharedFqmWorker, createFqmPool, createFqmWorker, fqmWorkerCount, sharedFqmPoolSize, sharedFqmWorker } from "./fqm-worker.ts";
import { officialMeasureExecutor } from "./official-executor-adapter.ts";
import { isOfficialCalculationError } from "./official-calculation-error.ts";
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
    // #789: only the calculation's own throw is marked, so only it is retried one patient at a time. A worker
    // that crashed, threw outside the calculation or was closed would only be loaded further by that.
    const kindOf = (chunk: Promise<unknown>) => chunk.then(() => "resolved", (e: unknown) => (isOfficialCalculationError(e) ? "calculation" : "other"));
    assert.equal(await kindOf(worker.calculate(input([{ mode: "throw" }]))), "calculation");
    assert.equal(await kindOf(worker.calculate(input([{ mode: "exit" }]))), "other");
    assert.equal(await kindOf(worker.calculate(input([{ mode: "uncaught" }]))), "other");
    const closing = worker.calculate(input([{ mode: "busy", cpuMs: 500 }]));
    await worker.close();
    assert.equal(await kindOf(closing), "other");
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

/** A hypertensive patient with one blood pressure, its readings in `unit` (UCUM's is `mm[Hg]`). */
const hypertensive = (id: string, unit: string) => ({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: { resourceType: "Patient", id, gender: "female", birthDate: "1960-04-01", extension: [{ url: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex", valueCode: "248152002" }] } },
    { resource: { resourceType: "Encounter", id: `${id}-e`, status: "finished", type: [{ coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99213" }] }], period: { start: "2025-04-02T09:00:00Z", end: "2025-04-02T09:30:00Z" } } },
    {
      resource: {
        resourceType: "Condition", id: `${id}-c`,
        clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
        verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "problem-list-item" }] }],
        code: { coding: [{ system: "http://snomed.info/sct", code: "59621000" }] },
        onsetDateTime: "2024-01-01T00:00:00Z",
      },
    },
    {
      resource: {
        resourceType: "Observation", id: `${id}-bp`, status: "final",
        meta: { profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure"] },
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
        code: { coding: [{ system: "http://loinc.org", code: "85354-9" }] },
        effectiveDateTime: "2025-10-01T09:00:00Z",
        component: [
          { code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] }, valueQuantity: { value: 130, unit, system: "http://unitsofmeasure.org", code: unit } },
          { code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] }, valueQuantity: { value: 80, unit, system: "http://unitsofmeasure.org", code: unit } },
        ],
      },
    },
  ],
});

test("#789: one patient's blood pressure in `mmHg` rejects official cms165's batch as a CALCULATION error, in process and in the worker", { skip: skipWithout("cms165") }, async () => {
  const subjects = [
    { subjectId: "ok", patientBundle: hypertensive("ok", "mm[Hg]") },
    { subjectId: "bad", patientBundle: hypertensive("bad", "mmHg") },
  ];
  const expand = officialTerminologyExpander(loadOfficialArtifact);
  const worker = createFqmWorker();
  try {
    for (const executor of [officialMeasureExecutor({ expand }), officialMeasureExecutor({ expand, calculateBatch: worker.calculate })]) {
      const error = await executor.evaluateBatch("cms165", subjects, "2025-12-31").then(() => undefined, (e: unknown) => e);
      assert.ok(isOfficialCalculationError(error), `marked as the calculation's: ${String(error)}`);
      assert.match(String((error as Error).message), /Invalid UCUM unit: 'mmHg'/);
      // Alone, the patient whose units are UCUM's is scored; only the other fails.
      assert.equal((await executor.evaluate({ measureId: "cms165", patientBundle: subjects[0]!.patientBundle, evaluationDate: "2025-12-31" })).outcome, "COMPLIANT");
      await assert.rejects(() => executor.evaluate({ measureId: "cms165", patientBundle: subjects[1]!.patientBundle, evaluationDate: "2025-12-31" }), /Invalid UCUM unit/);
    }
    assert.ok(worker.requests >= 1, "the second executor really calculated in the worker");
  } finally {
    await worker.close();
  }
});

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

test("a pool of two calculates two chunks at the same time (#604 follow-up)", async () => {
  const pool = createFqmPool(2, { calculatorModule: FIXTURE });
  try {
    await Promise.all([pool.calculate(input([{}])), pool.calculate(input([{}]))]); // start both threads first
    const started = Date.now();
    await Promise.all([pool.calculate(input([{ mode: "busy", cpuMs: 800 }])), pool.calculate(input([{ mode: "busy", cpuMs: 800 }]))]);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1400, `two 800 ms chunks took ${elapsed} ms: one per worker, side by side`);
    assert.equal(pool.alive, 2);
    assert.equal(pool.requests, 4);
  } finally {
    await pool.close();
  }
});

test("a pool holds chunks beyond its workers on the main thread, one per worker at a time (#707, Codex)", async () => {
  const pool = createFqmPool(2, { calculatorModule: FIXTURE });
  try {
    const jobs = [0, 1, 2, 3, 4, 5].map((i) => pool.calculate(input(Array.from({ length: i + 1 }, (_, k) => (k === 0 ? { mode: "busy", cpuMs: 150 } : {})))));
    assert.equal(pool.queued, 4, "six chunks on two workers: two posted, four waiting as references");
    assert.equal(pool.inFlight, 6);
    const results = await Promise.all(jobs);
    assert.deepEqual(results.map((r) => r.bySubject.size), [1, 2, 3, 4, 5, 6], "each chunk got its own answer");
    assert.equal(pool.queued, 0);
    assert.equal(pool.requests, 6, "every chunk reached a worker");
    const failing = pool.calculate(input([{ mode: "throw" }]));
    const after = pool.calculate(input([{}]));
    await assert.rejects(failing, /fqm could not parse/);
    assert.equal((await after).bySubject.size, 1, "a failed chunk frees its worker for the next");
  } finally {
    await pool.close();
  }
});

test("an idle worker is released and the next chunk starts a fresh one (#604 follow-up)", async () => {
  const worker = createFqmWorker({ calculatorModule: FIXTURE, idleMs: 100 });
  try {
    await worker.calculate(input([{}]));
    assert.equal(worker.alive, 1);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(worker.alive, 0, "released after its idle time, so its memory is too");
    assert.equal((await worker.calculate(input([{}, {}]))).bySubject.size, 2, "and a new chunk still runs");
    assert.equal(worker.alive, 1);
  } finally {
    await worker.close();
  }
});

test("the pool size: 2 by default, WORKWELL_FQM_WORKERS to change it, never more than the cores minus one (#604 follow-up)", () => {
  assert.equal(fqmWorkerCount({}, 4), 2);
  assert.equal(fqmWorkerCount({ WORKWELL_FQM_WORKERS: "3" }, 4), 3);
  assert.equal(fqmWorkerCount({ WORKWELL_FQM_WORKERS: "8" }, 4), 3, "the main thread keeps a core");
  assert.equal(fqmWorkerCount({ WORKWELL_FQM_WORKERS: "1" }, 4), 1, "the single worker #604 shipped with");
  assert.equal(fqmWorkerCount({ WORKWELL_FQM_WORKERS: "0" }, 4), 2, "nonsense falls back to the default");
  assert.equal(fqmWorkerCount({ WORKWELL_FQM_WORKERS: "abc" }, 4), 2);
  assert.equal(fqmWorkerCount({}, 2), 1, "a two-core host gets one worker");
  assert.equal(fqmWorkerCount({}, 1), 1);
});

test("the shared pool takes its size from the first caller, and says so when a later one asks for another (#707 review)", async () => {
  await __resetSharedFqmWorker();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (msg: string) => void warnings.push(msg);
  try {
    assert.equal(sharedFqmPoolSize(), null, "nothing until something uses it");
    const pool = sharedFqmWorker(2);
    assert.equal(sharedFqmPoolSize(), 2);
    assert.equal(sharedFqmWorker(), pool, "a caller that names no size gets the pool as it is, silently");
    assert.deepEqual(warnings, []);
    assert.equal(sharedFqmWorker(3), pool, "the pool is not resized");
    assert.match(warnings[0] ?? "", /already has 2 worker\(s\); a request for 3 is ignored/);
  } finally {
    console.warn = warn;
    await __resetSharedFqmWorker();
  }
});

test("trusted profiles cross the thread as data and the narrowed PatientSource is built in the worker (#591)", async () => {
  const worker = createFqmWorker({ calculatorModule: FIXTURE });
  try {
    const bundle = {
      mode: "narrowed",
      resourceType: "Bundle",
      entry: [
        { resource: { resourceType: "Patient", id: "p0" } },
        { resource: { resourceType: "Observation", id: "bp", meta: { profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure"] } } },
        { resource: { resourceType: "Observation", id: "a1c" } },
      ],
    };
    const readOf = async (options: Record<string, unknown>) => {
      const result = await worker.calculate({ ...input([bundle]), options });
      return (result.bySubject.get("p0")?.populationResults[0] as { read?: number } | undefined)?.read;
    };
    assert.equal(await readOf({ trustedProfiles: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure"] }), 1, "only the stamped reading");
    assert.equal(await readOf({}), -1, "no list, no source: fqm would build its own");
  } finally {
    await worker.close();
  }
});
