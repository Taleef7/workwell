/**
 * The official calculation, off the main thread (#604).
 *
 * The pilot's nightly is ~94% one call: `fqm-execution`'s `calculate` over a 500-subject chunk, ~21 s
 * of synchronous CPU inside a loop we do not own. While it ran, the process could answer nothing —
 * `/health` took 14 s, the event loop stalled 20–25 s at a time for the ~80 minutes of the run, and a
 * sign-in during it failed with "The WorkWell server did not respond". A macrotask yield (ADR-085 d1)
 * cannot reach inside a third-party loop, and smaller chunks only shorten each stall.
 *
 * So the call runs in ONE persistent worker thread. The main thread posts a chunk and awaits the
 * reduced result; requests keep being served meanwhile. One worker, not a pool: it takes the stall off
 * the event loop whatever the core count, and whether a pool would also shorten the run depends on the
 * cores the container has (`cpus` on /api/admin/runtime), which is a separate decision.
 *
 * Failure keeps the in-process contract: a thrown error comes back as a rejection with the same
 * message, and a worker that dies (an uncaught error, an out-of-memory kill) rejects every chunk it was
 * holding, so a run fails the chunk as it would on a throw and never stays RUNNING. The next chunk
 * starts a fresh worker.
 *
 * The worker holds the process open only while a chunk is in flight, so a CLI or a test that used it
 * still exits when it is done.
 *
 * Known limit: the worker runs one chunk at a time, so a single-subject official read (`/simulate`, a
 * rerun) arriving during the nightly waits behind the chunk in flight, up to its ~21–42 s. That is no
 * worse than before (everything waited then) and only inside the nightly window; a second worker for
 * interactive reads is the fix if it matters. A hung fqm call still hangs its chunk, as it did
 * in-process; the worker has no heap limit of its own yet (`memoryLimitMb` on /api/admin/runtime is
 * what to size one against).
 */
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import type { OfficialBatchResult, OfficialCalculationInput, OfficialSubjectResult } from "@work-well/official-executor";

/** What crosses to the worker: the calculation input minus the injectable function, which cannot be cloned. */
export type WorkerCalculationInput = Omit<OfficialCalculationInput, "calculate">;

export interface WorkerRequest {
  id: number;
  input: WorkerCalculationInput;
  /** Tests only: a module URL exporting `calculate`, used in place of the real fqm calculator. */
  calculatorModule?: string;
}

export type WorkerResponse =
  | { id: number; ok: true; bySubject: Array<[string, OfficialSubjectResult]>; retrieveSignal: boolean }
  | { id: number; ok: false; message: string; stack?: string };

/** The seam the official executor calls instead of `calculateOfficialWithSignal` when it is set. */
export type BatchCalculator = (input: WorkerCalculationInput) => Promise<OfficialBatchResult>;

export interface FqmWorker {
  calculate: BatchCalculator;
  /** Chunks posted to the worker since it was created. */
  readonly requests: number;
  /** Chunks posted and not yet answered. */
  readonly inFlight: number;
  /** Threads currently running (idle ones are released after `idleMs`). */
  readonly alive: number;
  /** Stop the worker; chunks still in flight reject. */
  close(): Promise<void>;
}

const ENTRY = new URL("./fqm-worker-entry.ts", import.meta.url);

/**
 * How long an idle worker is kept. Each one holds fqm-execution and a measure's parsed ELM, about 500 MB
 * measured, and a nightly uses them for ~an hour a day; kept forever they would hold that memory for the
 * other 23. Five minutes bridges the gaps between one run's chunks and a person's back-to-back reads;
 * after that the next chunk pays a fresh worker's start (fqm's load, about 2 s).
 */
export const DEFAULT_WORKER_IDLE_MS = 5 * 60_000;

export function createFqmWorker(options: { calculatorModule?: string; idleMs?: number } = {}): FqmWorker {
  let worker: Worker | null = null;
  let nextId = 1;
  let requests = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  const idleMs = options.idleMs ?? DEFAULT_WORKER_IDLE_MS;
  const cancelIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  // Each chunk remembers the worker it was posted to. A crash emits `error` and then `exit`, and between
  // the two a rejected chunk's caller can already have posted the NEXT chunk to a fresh worker; the old
  // worker's `exit` must not fail that one (Codex on #705). So a worker only ever fails its own chunks.
  const pending = new Map<number, { owner: Worker | null; resolve: (r: OfficialBatchResult) => void; reject: (e: Error) => void }>();

  const failAll = (error: Error, owner?: Worker): void => {
    for (const [id, waiter] of pending) {
      if (owner && waiter.owner !== owner) continue;
      pending.delete(id);
      waiter.reject(error);
    }
  };
  const holdsWork = (owner: Worker): boolean => [...pending.values()].some((w) => w.owner === owner);

  const ensure = (): Worker => {
    if (worker) return worker;
    // `node --import tsx` is inherited through execArgv, which is what lets the entry be TypeScript.
    const w = new Worker(ENTRY);
    w.unref();
    w.on("message", (response: WorkerResponse) => {
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      if (!holdsWork(w)) {
        w.unref();
        cancelIdle();
        idleTimer = setTimeout(() => {
          idleTimer = null;
          // Still this worker, and still idle: release it. Its `exit` finds no chunk to fail.
          if (worker === w && !holdsWork(w)) {
            worker = null;
            void w.terminate();
          }
        }, idleMs);
        idleTimer.unref();
      }
      if (response.ok) {
        waiter.resolve({ bySubject: new Map(response.bySubject), retrieveSignal: response.retrieveSignal });
      } else {
        const error = new Error(response.message);
        if (response.stack) error.stack = response.stack;
        waiter.reject(error);
      }
    });
    w.on("error", (err) => {
      if (worker === w) worker = null;
      failAll(new Error(`official calculation worker failed: ${err.message}`), w);
    });
    w.on("exit", (code) => {
      if (worker === w) worker = null;
      if (holdsWork(w)) failAll(new Error(`official calculation worker exited (code ${code}) with a chunk in flight`), w);
    });
    worker = w;
    return w;
  };

  return {
    get requests() {
      return requests;
    },
    get inFlight() {
      return pending.size;
    },
    get alive() {
      return worker ? 1 : 0;
    },
    calculate(input) {
      cancelIdle();
      const w = ensure();
      const id = nextId++;
      requests += 1;
      return new Promise<OfficialBatchResult>((resolve, reject) => {
        pending.set(id, { owner: w, resolve, reject });
        w.ref();
        const request: WorkerRequest = { id, input, ...(options.calculatorModule ? { calculatorModule: options.calculatorModule } : {}) };
        try {
          w.postMessage(request);
        } catch (err) {
          // An input that cannot be cloned fails here, synchronously, as a thrown error would in-process.
          pending.delete(id);
          if (!holdsWork(w)) w.unref();
          reject(err as Error);
        }
      });
    },
    async close() {
      cancelIdle();
      const w = worker;
      worker = null;
      if (w) await w.terminate();
      failAll(new Error("official calculation worker closed"));
    },
  };
}

/**
 * A pool of calculation workers, each chunk to the one with the fewest chunks in flight. The run
 * pipeline posts a chunk's measures together, so N workers calculate N measures side by side: measured
 * locally on 500 corpus subjects, 2 workers took a chunk from 27.5 s to 17.9 s (1.5–1.7x) at ~500 MB
 * more memory.
 */
export function createFqmPool(size: number, options: { calculatorModule?: string; idleMs?: number } = {}): FqmWorker {
  const workers = Array.from({ length: Math.max(1, Math.floor(size)) }, () => createFqmWorker(options));
  return {
    get requests() {
      return workers.reduce((n, w) => n + w.requests, 0);
    },
    get inFlight() {
      return workers.reduce((n, w) => n + w.inFlight, 0);
    },
    get alive() {
      return workers.reduce((n, w) => n + w.alive, 0);
    },
    calculate(input) {
      const least = workers.reduce((best, w) => (w.inFlight < best.inFlight ? w : best));
      return least.calculate(input);
    },
    async close() {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}

/**
 * How many workers: `WORKWELL_FQM_WORKERS`, default 2, never more than the cores minus one — the main
 * thread (requests, the database, the run's own bookkeeping) keeps a core. On the pilot's 4-core
 * container that allows 3; 2 is the default because a third bought nothing measurable locally and costs
 * another ~500 MB. `1` is the single worker #604 shipped with.
 */
export function fqmWorkerCount(env: Record<string, unknown>, cores: number = availableParallelism()): number {
  const ceiling = Math.max(1, cores - 1);
  const raw = Number.parseInt(String(env.WORKWELL_FQM_WORKERS ?? ""), 10);
  const wanted = Number.isFinite(raw) && raw >= 1 ? raw : 2;
  return Math.min(wanted, ceiling);
}

let shared: FqmWorker | null = null;

/** The process's calculation pool, created on first use at the size the first caller asks for. */
export function sharedFqmWorker(size = 1): FqmWorker {
  return (shared ??= createFqmPool(size));
}

/** On unless `WORKWELL_FQM_WORKER=off` — the escape hatch back to the in-process call. */
export function fqmWorkerEnabled(env: Record<string, unknown>): boolean {
  return String(env.WORKWELL_FQM_WORKER ?? "").trim().toLowerCase() !== "off";
}
