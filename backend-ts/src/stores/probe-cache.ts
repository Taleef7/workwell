/**
 * A per-store-instance memo for a read whose answer is decided by an identity the caller can compute
 * cheaply — built for `listLatestPopulationRuns`, whose cost is not its first statement but the
 * probes that follow it.
 *
 * `listLatestPopulationRuns` asks two questions. WHICH runs qualify is one indexed statement over
 * `runs` (`spike_runs_status_started_idx`, a bounded `LIMIT`) and costs almost nothing. WHICH of them
 * holds a row for each measure is an `EXISTS` probe per (run, measure) with no `(run_id, measure_id)`
 * index behind it, and on the pilot that pair of steps measures **2.5–4 s**. `/api/programs/overview`
 * pays it once, and `?include=detail` pays it thirteen times — the overview, then a trend and a
 * top-drivers pass per measure, each resolving the same winners again. Measured on the Maui sandbox
 * 2026-09-21: `?include=detail` took **59.8 s** with every downstream memo already warm, which is to
 * say the whole minute was thirteen walks.
 *
 * The identity is the candidate run list itself, and that is what makes this exact rather than a TTL:
 * a probe's answer depends only on which runs are in the list and which rows they hold, a terminal
 * population run's rows are immutable (the roster cell cache and every `RunKeyedMemo` already rest on
 * that same fact), and a run reaches the list only once terminal. A nightly that completes changes the
 * list, so the key moves and the probes run again.
 *
 * **Two things can change a probe's answer under a fixed key.** COMPACTION deletes rows rather than
 * runs, so `compactOlderThan` clears the cache: a winner cannot be affected (ADR-073 keeps the newest
 * usable row per key, and a winner's rows are keep-set rows by construction), but a run deeper in a
 * `perMeasure` window can lose its last row for a measure. And an outcome WRITE can add the first row
 * of a measure to a run already in the list, which is why both write paths clear it too.
 *
 * **A third is possible and is left uninvalidated, deliberately** (review of #610). `finalizeRun` flips
 * a run's status into the qualifying set AFTER its rows were written — so a run whose `started_at` does
 * not place it in the newest `LATEST_RUN_PROBE_BUDGET` qualifying runs can enter step 2's reckoning
 * without the candidate list moving, and a probe answered in the window between the last chunk write
 * and that status update would survive it. The window is the gap between two adjacent statements of one
 * finalize, and the run has to be old enough to fall outside a 25-run budget while being finalized now
 * — a backdated rerun. Named rather than fixed, because the fix is another invalidation on a path that
 * has no reason to know about this cache.
 *
 * **Keyed by the DATABASE HANDLE, not by the store instance — and that distinction is load-bearing
 * (review of #610).** `getStores` caches its bundle in a `WeakMap` keyed by the ENV OBJECT
 * (`stores/factory.ts`), and a live container builds two env objects: the `schedulerEnv` literal in
 * `server.ts`, and the one the host builds for the worker. Only the pg POOL is module-global, so there
 * are **two `PgOutcomeStore` instances** — the scheduler's and the request path's. A per-instance cache
 * therefore put the compaction invalidation on the instance that does the DELETING and left it open on
 * the instance that does the READING, and made the boot warm fill a cache no request would ever hit.
 *
 * Keyed by the handle, one cache serves both — which is correct, because they are the same rows — while
 * the ceiling and the floor stay separate, since they are separate handles. That separation is what
 * this note originally defended and it is preserved: the two run in one process during the store
 * contract tests, over different data, and a shared key space would serve one store's answer to the
 * other.
 */

/** A bounded, self-invalidating promise memo. Keys are opaque strings the caller composes. */
export class ProbeCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  constructor(private readonly limit = 32) {}

  /**
   * The cached answer for `key`, computing it once. The PROMISE is cached, not the value, so two
   * concurrent requests that miss together issue one read rather than two — which is the common case
   * on a dashboard that fires its overview and its detail call in sequence behind one page load.
   * A rejection is never cached: the entry is dropped so the next caller retries.
   */
  async resolve(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) return hit;
    // Evict BEFORE inserting, so the FIFO victim is never the entry just added.
    while (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    const pending = compute();
    this.entries.set(key, pending);
    try {
      return await pending;
    } catch (err) {
      if (this.entries.get(key) === pending) this.entries.delete(key);
      throw err;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  /** Entries currently held — for the tests that assert a second call did not read again. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * The one cache per database handle. A `WeakMap`, so a handle that goes away takes its cache with it
 * (which is what keeps the per-test SQLite databases from accumulating).
 */
const byHandle = new WeakMap<object, ProbeCache<never>>();

/** The winners-probe cache for this pool / D1 handle, created on first use. */
export function probeCacheFor<T>(handle: object): ProbeCache<T> {
  const existing = byHandle.get(handle);
  if (existing) return existing as unknown as ProbeCache<T>;
  const created = new ProbeCache<T>();
  byHandle.set(handle, created as unknown as ProbeCache<never>);
  return created;
}
