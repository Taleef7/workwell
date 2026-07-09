/**
 * Worker-pool orchestration (#256) — driven by an in-process FAKE worker so the crash/retry/fallback
 * logic is tested deterministically WITHOUT spawning real threads or running CQL. (The real-thread
 * parity + throughput proof lives in batch-evaluate-scale.test.ts.)
 *   node --import tsx --test src/run/scale-eval-pool.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScaleEvalPool, type PoolWorker, type WorkerOutcomeRow, type ChunkRequest, type ChunkResponse } from "./scale-eval-pool.ts";

const MEASURES = ["m1", "m2"];

/** A behavior decision for one (chunk-start, attempt#) — how the fake worker responds to that chunk. */
type Behavior = "ok" | "error" | "exit";

interface Harness {
  spawnWorker: () => PoolWorker;
  spawnCount: () => number;
}

/**
 * Build a fake-worker spawner. `behavior(start, attempt)` decides how the fake responds to a chunk
 * request: "ok" posts deterministic COMPLIANT rows; "error"/"exit" simulate a crash (error event /
 * non-zero exit). Attempts are counted per chunk-start across worker replacements.
 */
function harness(behavior: (start: number, attempt: number) => Behavior): Harness {
  const attempts = new Map<number, number>();
  let spawnCount = 0;
  const spawnWorker = (): PoolWorker => {
    spawnCount++;
    let onMsg: ((m: ChunkResponse) => void) | undefined;
    let onErr: ((e: Error) => void) | undefined;
    let onExit: ((code: number) => void) | undefined;
    return {
      postMessage(req: ChunkRequest) {
        const attempt = (attempts.get(req.start) ?? 0) + 1;
        attempts.set(req.start, attempt);
        const b = behavior(req.start, attempt);
        queueMicrotask(() => {
          if (b === "ok") {
            const rows: WorkerOutcomeRow[] = [];
            for (let i = req.start; i < req.end; i++) {
              for (const m of MEASURES) rows.push({ subjectId: `s${i}`, measureId: m, status: "COMPLIANT", evidence: { i } });
            }
            onMsg?.({ chunkId: req.chunkId, rows });
          } else if (b === "error") {
            onErr?.(new Error("worker boom"));
          } else {
            onExit?.(1);
          }
        });
      },
      onMessage(cb) { onMsg = cb; },
      onError(cb) { onErr = cb; },
      onExit(cb) { onExit = cb; },
      terminate() { /* no-op fake */ },
    };
  };
  return { spawnWorker, spawnCount: () => spawnCount };
}

function fallbackRows(start: number, end: number): WorkerOutcomeRow[] {
  const rows: WorkerOutcomeRow[] = [];
  for (let i = start; i < end; i++) for (const m of MEASURES) rows.push({ subjectId: `s${i}`, measureId: m, status: "MISSING_DATA", evidence: { crashed: true } });
  return rows;
}

async function run(h: Harness, totalSubjects: number, chunkSize: number, poolSize: number): Promise<WorkerOutcomeRow[]> {
  const persisted: WorkerOutcomeRow[] = [];
  await runScaleEvalPool({
    totalSubjects,
    chunkSize,
    poolSize,
    spawnWorker: h.spawnWorker,
    onChunkRows: async (rows) => { persisted.push(...rows); },
    buildFallbackRows: fallbackRows,
  });
  return persisted;
}

test("pool evaluates every subject exactly once across chunks/workers (no drops, no dupes)", async () => {
  const h = harness(() => "ok");
  const rows = await run(h, 20, 3, 4); // 20 subjects, chunks of 3, 4 workers → 7 chunks
  assert.equal(rows.length, 20 * MEASURES.length);
  // Each (subject, measure) appears exactly once.
  const keys = rows.map((r) => `${r.subjectId}|${r.measureId}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicate (subject, measure) rows");
  for (let i = 0; i < 20; i++) for (const m of MEASURES) assert.ok(keys.includes(`s${i}|${m}`), `covered s${i}|${m}`);
  assert.ok(rows.every((r) => r.status === "COMPLIANT"));
});

test("pool with more workers than chunks still completes exactly once", async () => {
  const h = harness(() => "ok");
  const rows = await run(h, 4, 2, 8); // 2 chunks, 8 workers
  assert.equal(rows.length, 4 * MEASURES.length);
  assert.equal(new Set(rows.map((r) => `${r.subjectId}|${r.measureId}`)).size, 4 * MEASURES.length);
});

test("pool retries a crashed chunk ONCE then succeeds (error event)", async () => {
  // Chunk starting at index 0 crashes on its first attempt, succeeds on the retry; others always ok.
  const h = harness((start, attempt) => (start === 0 && attempt === 1 ? "error" : "ok"));
  const rows = await run(h, 12, 3, 2);
  assert.equal(rows.length, 12 * MEASURES.length, "all subjects persisted after the retry");
  assert.ok(rows.every((r) => r.status === "COMPLIANT"), "retry produced real outcomes, no fallback");
  assert.ok(h.spawnCount() > 2, "a replacement worker was spawned for the crash");
});

test("pool retries once for a non-zero EXIT crash too", async () => {
  const h = harness((start, attempt) => (start === 0 && attempt === 1 ? "exit" : "ok"));
  const rows = await run(h, 9, 3, 2);
  assert.equal(rows.length, 9 * MEASURES.length);
  assert.ok(rows.every((r) => r.status === "COMPLIANT"));
});

test("pool fails a twice-crashing chunk SOFT to MISSING_DATA and keeps going", async () => {
  // Chunk at index 0 crashes on both attempt 1 and 2 → fallback; the rest evaluate normally.
  const h = harness((start, attempt) => (start === 0 && attempt <= 2 ? "error" : "ok"));
  const rows = await run(h, 12, 3, 2);
  assert.equal(rows.length, 12 * MEASURES.length, "the batch is not lost — every subject has rows");
  const crashed = rows.filter((r) => Number(r.subjectId.slice(1)) < 3); // subjects s0..s2 (the failed chunk)
  const survived = rows.filter((r) => Number(r.subjectId.slice(1)) >= 3);
  assert.ok(crashed.length > 0 && crashed.every((r) => r.status === "MISSING_DATA"), "failed chunk soft-failed to MISSING_DATA");
  assert.ok(survived.length > 0 && survived.every((r) => r.status === "COMPLIANT"), "other chunks unaffected");
});

test("pool rejects if a DB write (onChunkRows) throws", async () => {
  const h = harness(() => "ok");
  await assert.rejects(
    () =>
      runScaleEvalPool({
        totalSubjects: 6,
        chunkSize: 2,
        poolSize: 2,
        spawnWorker: h.spawnWorker,
        onChunkRows: async () => { throw new Error("db down"); },
        buildFallbackRows: fallbackRows,
      }),
    /db down/,
  );
});

test("pool with zero subjects resolves immediately without spawning a worker", async () => {
  const h = harness(() => "ok");
  const rows = await run(h, 0, 4, 4);
  assert.equal(rows.length, 0);
  assert.equal(h.spawnCount(), 0, "no workers spawned for an empty batch");
});
