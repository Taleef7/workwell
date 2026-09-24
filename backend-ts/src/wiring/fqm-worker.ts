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
 */
import { Worker } from "node:worker_threads";
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
  /** Stop the worker; chunks still in flight reject. */
  close(): Promise<void>;
}

const ENTRY = new URL("./fqm-worker-entry.ts", import.meta.url);

export function createFqmWorker(options: { calculatorModule?: string } = {}): FqmWorker {
  let worker: Worker | null = null;
  let nextId = 1;
  let requests = 0;
  const pending = new Map<number, { resolve: (r: OfficialBatchResult) => void; reject: (e: Error) => void }>();

  const failAll = (error: Error): void => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const ensure = (): Worker => {
    if (worker) return worker;
    // `node --import tsx` is inherited through execArgv, which is what lets the entry be TypeScript.
    const w = new Worker(ENTRY);
    w.unref();
    w.on("message", (response: WorkerResponse) => {
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      if (pending.size === 0) w.unref();
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
      failAll(new Error(`official calculation worker failed: ${err.message}`));
    });
    w.on("exit", (code) => {
      if (worker === w) worker = null;
      if (pending.size > 0) failAll(new Error(`official calculation worker exited (code ${code}) with a chunk in flight`));
    });
    worker = w;
    return w;
  };

  return {
    get requests() {
      return requests;
    },
    calculate(input) {
      const w = ensure();
      const id = nextId++;
      requests += 1;
      return new Promise<OfficialBatchResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.ref();
        const request: WorkerRequest = { id, input, ...(options.calculatorModule ? { calculatorModule: options.calculatorModule } : {}) };
        try {
          w.postMessage(request);
        } catch (err) {
          // An input that cannot be cloned fails here, synchronously, as a thrown error would in-process.
          pending.delete(id);
          if (pending.size === 0) w.unref();
          reject(err as Error);
        }
      });
    },
    async close() {
      const w = worker;
      worker = null;
      if (w) await w.terminate();
      failAll(new Error("official calculation worker closed"));
    },
  };
}

let shared: FqmWorker | null = null;

/** The process's one calculation worker, created on first use. */
export function sharedFqmWorker(): FqmWorker {
  return (shared ??= createFqmWorker());
}

/** On unless `WORKWELL_FQM_WORKER=off` — the escape hatch back to the in-process call. */
export function fqmWorkerEnabled(env: Record<string, unknown>): boolean {
  return String(env.WORKWELL_FQM_WORKER ?? "").trim().toLowerCase() !== "off";
}
