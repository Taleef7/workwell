/**
 * Hand-rolled worker pool orchestration for the scale batch evaluator (#256). PURE orchestration —
 * this module imports NOTHING from `node:worker_threads` and knows nothing about CQL, so it is
 * unit-testable with a fake `PoolWorker`. The real thread-backed worker is wired in
 * `batch-evaluate-scale.ts` (`realSpawnWorker`), which is the ONLY place a `node:worker_threads`
 * `Worker` is constructed — and only ever from the batch CLI path, never the request path / worker.ts.
 *
 * Design (issue #256, research-verified 2026-07-09):
 *   - Work unit = a `(start, end)` range of SUBJECT INDICES. Never a FHIR bundle or a cql-execution
 *     object — the worker regenerates the bundle in-thread from the index (the generator is
 *     deterministic on subject index), so the only thing crossing the thread boundary is a pair of
 *     integers out and plain-JSON outcome rows back.
 *   - The MAIN thread does ALL DB writes: `onChunkRows(rows)` is awaited before a worker is handed its
 *     next chunk, so at most `poolSize` chunks of rows are buffered at once (bounded memory + natural
 *     backpressure), preserving the sequential path's chunked-flush discipline.
 *   - Crash isolation: a worker that errors or exits non-zero mid-chunk is replaced and its chunk
 *     RE-QUEUED ONCE; a second crash fails that chunk's subjects soft to MISSING_DATA
 *     (`buildFallbackRows`) — mirroring the per-subject error isolation of the sequential path — and the
 *     batch continues.
 */

/** A row the worker produces (or the pool synthesizes on a hard crash). Plain JSON only. */
export interface WorkerOutcomeRow {
  subjectId: string;
  measureId: string;
  status: string;
  evidence: unknown;
}

/** Main → worker: evaluate this half-open subject-index range. */
export interface ChunkRequest {
  chunkId: number;
  start: number;
  end: number;
}

/** Worker → main: the rows produced for a chunk. */
export interface ChunkResponse {
  chunkId: number;
  rows: WorkerOutcomeRow[];
}

/**
 * The minimal worker surface the pool drives — an abstraction over `node:worker_threads.Worker` so the
 * orchestration can be tested with an in-process fake. Every registration is one-shot per worker
 * instance (the pool re-registers on the replacement worker after a crash).
 */
export interface PoolWorker {
  postMessage(msg: ChunkRequest): void;
  onMessage(cb: (msg: ChunkResponse) => void): void;
  onError(cb: (err: Error) => void): void;
  onExit(cb: (code: number) => void): void;
  terminate(): void;
}

export type SpawnWorker = () => PoolWorker;

export interface ScaleEvalPoolConfig {
  totalSubjects: number;
  chunkSize: number;
  /** Number of live workers (>= 1). The caller resolves this against `availableParallelism()`. */
  poolSize: number;
  spawnWorker: SpawnWorker;
  /** Persist a chunk's rows (main-thread DB write). Awaited before the worker gets its next chunk. */
  onChunkRows: (rows: WorkerOutcomeRow[]) => Promise<void>;
  /** MISSING_DATA rows for a chunk whose worker crashed twice (hard-crash fallback). */
  buildFallbackRows: (start: number, end: number) => WorkerOutcomeRow[];
}

interface Chunk {
  id: number;
  start: number;
  end: number;
}

interface Slot {
  worker: PoolWorker;
  chunk: Chunk | null;
  retries: number;
  /** True once we intentionally terminate the worker — its `exit` must NOT be read as a crash. */
  intentionalExit: boolean;
  /** Debounces the error→exit double-signal so one physical crash is handled once. */
  crashHandled: boolean;
}

/**
 * Run the pool to completion. Resolves once every chunk's rows have been persisted (via `onChunkRows`),
 * whether produced by a worker or by the crash fallback. Rejects if `onChunkRows` throws (a DB write
 * failure is a real error — mirrors the sequential path aborting on a `recordOutcomes` failure).
 */
export async function runScaleEvalPool(cfg: ScaleEvalPoolConfig): Promise<void> {
  const chunks: Chunk[] = [];
  for (let s = 0; s < cfg.totalSubjects; s += cfg.chunkSize) {
    chunks.push({ id: chunks.length, start: s, end: Math.min(s + cfg.chunkSize, cfg.totalSubjects) });
  }
  const total = chunks.length;
  if (total === 0) return;

  const poolSize = Math.max(1, Math.min(cfg.poolSize, total));
  let nextChunk = 0;
  let completed = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const slots: Slot[] = [];

    const finish = () => {
      if (settled) return;
      settled = true;
      for (const slot of slots) {
        slot.intentionalExit = true;
        slot.chunk = null;
        try {
          slot.worker.terminate();
        } catch {
          /* terminating an already-dead worker is harmless */
        }
      }
      resolve();
    };

    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      for (const slot of slots) {
        slot.intentionalExit = true;
        slot.chunk = null;
        try {
          slot.worker.terminate();
        } catch {
          /* best effort */
        }
      }
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    // Persist a chunk's rows, tick the completion counter, then either finish or feed the slot again.
    const settleChunk = async (slot: Slot, rows: WorkerOutcomeRow[]) => {
      slot.chunk = null;
      try {
        await cfg.onChunkRows(rows);
      } catch (e) {
        fail(e);
        return;
      }
      if (settled) return;
      completed++;
      if (completed === total) {
        finish();
        return;
      }
      assignNext(slot);
    };

    const assignNext = (slot: Slot) => {
      if (settled) return;
      if (nextChunk >= total) return; // idle worker; the batch finishes when the in-flight chunks land
      const chunk = chunks[nextChunk++]!;
      slot.chunk = chunk;
      slot.retries = 0;
      slot.crashHandled = false;
      slot.worker.postMessage({ chunkId: chunk.id, start: chunk.start, end: chunk.end });
    };

    const wire = (slot: Slot, worker: PoolWorker) => {
      worker.onMessage((msg) => {
        // Ignore a stale message from a worker we've since replaced (chunk id mismatch).
        if (settled || slot.worker !== worker || !slot.chunk || slot.chunk.id !== msg.chunkId) return;
        void settleChunk(slot, msg.rows);
      });
      worker.onError(() => {
        if (slot.worker !== worker) return;
        void handleCrash(slot);
      });
      worker.onExit((code) => {
        if (slot.worker !== worker) return;
        if (slot.intentionalExit || code === 0) return;
        void handleCrash(slot);
      });
    };

    const handleCrash = async (slot: Slot) => {
      if (settled || !slot.chunk || slot.crashHandled) return;
      slot.crashHandled = true;
      const chunk = slot.chunk;
      // Replace the dead worker in this slot.
      slot.intentionalExit = true;
      try {
        slot.worker.terminate();
      } catch {
        /* already dead */
      }
      const replacement = cfg.spawnWorker();
      slot.worker = replacement;
      slot.intentionalExit = false;
      slot.crashHandled = false;
      wire(slot, replacement);

      if (slot.retries < 1) {
        slot.retries++;
        replacement.postMessage({ chunkId: chunk.id, start: chunk.start, end: chunk.end }); // re-queue once
        return;
      }
      // Crashed twice: fail this chunk's subjects soft to MISSING_DATA and keep going.
      await settleChunk(slot, cfg.buildFallbackRows(chunk.start, chunk.end));
    };

    // Boot the pool: one worker per slot, seeded with a chunk.
    for (let i = 0; i < poolSize; i++) {
      const worker = cfg.spawnWorker();
      const slot: Slot = { worker, chunk: null, retries: 0, intentionalExit: false, crashHandled: false };
      slots.push(slot);
      wire(slot, worker);
      assignNext(slot);
    }
  });
}
