/**
 * The 20,000-patient run, end to end through the real pipeline, with a pinned wall-clock ceiling.
 *
 * **What this measures, and what it does not.** The engine is a stub. That is deliberate: CQL time is
 * linear in subjects and is measured where it can be measured honestly — against the real artifacts,
 * in the credentialed job (`corpus-official-population.test.ts`). What is NOT linear, and what this
 * exists to catch, is everything chunking touched: corpus generation, bundle construction, the chunk
 * loop, the case upserts and the batched persistence. An accidental O(n²) in any of them — a filter
 * over `items` per chunk, a lookup that scans the roster per subject — is invisible at 150 subjects,
 * comfortable at 2,000, and fatal at 20,000.
 *
 * Skipped unless `WORKWELL_RUN_SCALE_MAUI=1`, so it never runs in the default suite. The `run-scale-maui`
 * CI job sets it.
 *
 *   cd backend-ts && WORKWELL_RUN_SCALE_MAUI=1 node --import tsx --test src/run/run-scale-maui.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { planManualRun, finishOrFail, type RunPipelineDeps } from "./run-pipeline.ts";
import { corpusDirectory } from "../engine/synthetic/corpus/corpus-directory.ts";
import { corpusBundleSource } from "../wiring/corpus-bundle-source.ts";
import { DEFAULT_CORPUS_SEED } from "../engine/synthetic/corpus/corpus-parameters.ts";

/**
 * Fifteen minutes. Recorded from the first measured run and pinned then (spec §11) — a ceiling that is
 * raised whenever it is hit measures nothing. If this fails, the number goes in the JOURNAL and the
 * cause is found; it is not edited upward.
 */
const CEILING_MS = 15 * 60 * 1000;

const SIZE = Number(process.env.WORKWELL_MAUI_CORPUS_SIZE ?? 20000);

const skip = process.env.WORKWELL_RUN_SCALE_MAUI === "1" ? false : "set WORKWELL_RUN_SCALE_MAUI=1 to run the scale test";

test(`a full run over ${SIZE} patients completes inside the CI ceiling`, { skip }, async () => {
  const dbPath = join(tmpdir(), `workwell-scale-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await (db as { exec(sql: string): Promise<unknown> }).exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));

  try {
    const generationStarted = Date.now();
    const employees = corpusDirectory(DEFAULT_CORPUS_SEED, SIZE).EMPLOYEES;
    const generationMs = Date.now() - generationStarted;
    assert.equal(employees.length, SIZE);

    const deps: RunPipelineDeps = {
      runStore: new SqliteRunStore(db as never),
      outcomeStore: new SqliteOutcomeStore(db as never),
      caseStore: new SqliteCaseStore(db as never),
      employees,
      bundleSource: corpusBundleSource(DEFAULT_CORPUS_SEED),
      engine: {
        // Not a measurement of CQL — see the header. A third of subjects are non-compliant so the case
        // upsert path is exercised at scale rather than being a no-op for the whole roster.
        evaluate: async ({ patientBundle }: { patientBundle: unknown }) => {
          const size = (patientBundle as { entry?: unknown[] }).entry?.length ?? 0;
          return { outcome: size % 3 === 0 ? "OVERDUE" : "COMPLIANT", evidence: {}, inInitialPopulation: true };
        },
      } as unknown as RunPipelineDeps["engine"],
    };

    const started = Date.now();
    const planned = await planManualRun(deps, { scopeType: "ALL_PROGRAMS" });
    // The pipeline runs every RUNNABLE measure for the profile; on a non-Maui test process that is the
    // authored registry, so assert what was actually planned rather than assuming five.
    const measureCount = planned.measureIds.length;
    assert.ok(measureCount >= 1);
    await finishOrFail(deps, planned);
    const elapsed = Date.now() - started;

    const run = (await deps.runStore.listRuns(1))[0]!;
    const outcomes = await deps.outcomeStore.listOutcomes(run.id, { limit: 1 });
    console.log(
      `[scale] ${SIZE} patients x ${measureCount} measures = ${SIZE * measureCount} items in ` +
        `${(elapsed / 1000).toFixed(1)}s (corpus generation ${(generationMs / 1000).toFixed(1)}s), status=${run.status}`,
    );

    assert.equal(run.status, "COMPLETED", "a scale run must not degrade to PARTIAL_FAILURE");
    assert.ok(outcomes.length > 0, "outcomes were persisted");
    assert.ok(elapsed < CEILING_MS, `run took ${(elapsed / 60000).toFixed(1)} min, ceiling is ${CEILING_MS / 60000} min`);
  } finally {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test("corpus generation itself is linear in the roster size", { skip }, () => {
  // The cheapest possible check for the quadratic that identity disambiguation could introduce: it
  // consults every lower index's (name, DOB), so a naive implementation is O(n²) and would show up as
  // a ratio far above 10 here.
  //
  // 2,000 and 20,000 rather than 1,000 and 10,000: at a thousand the whole generation is ~13 ms, which
  // is mostly JIT warm-up, and the ratio that comes out of it says more about the first run than about
  // the algorithm. One warm-up pass first, for the same reason.
  corpusDirectory(DEFAULT_CORPUS_SEED, 2000);
  const smallStart = Date.now();
  corpusDirectory(DEFAULT_CORPUS_SEED, 2000);
  const small = Math.max(1, Date.now() - smallStart);
  const bigStart = Date.now();
  corpusDirectory(DEFAULT_CORPUS_SEED, 20000);
  const big = Date.now() - bigStart;
  console.log(`[scale] corpus 2k=${small}ms 20k=${big}ms ratio=${(big / small).toFixed(1)}x for 10x the subjects`);
  assert.ok(big / small < 20, `10x the subjects took ${(big / small).toFixed(1)}x the time — generation is not linear`);
});
