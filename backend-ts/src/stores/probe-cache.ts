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
 * **The one thing that can change a probe's answer under a fixed key is compaction**, which deletes
 * rows rather than runs — so `compactOlderThan` clears its store's cache. A WINNER cannot be affected
 * (ADR-073 keeps the newest usable row per key, and a winner's rows are keep-set rows by
 * construction), but a run deeper in a `perMeasure` window can lose its last row for a measure, and
 * nothing else would move the key.
 *
 * Per INSTANCE, never module-global: the ceiling and the floor run in one process during the store
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
