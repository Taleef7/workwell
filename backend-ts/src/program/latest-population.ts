/**
 * The one way a roster-wide read model finds "the latest population run per measure" and reads it.
 *
 * Until 2026-09-10 the programs overview, the site list, the hierarchy rollup, the order proposals
 * and the MCP directory each fetched EVERY retained outcome row (`listOutcomesWithRun` with no run
 * bound — about a million rows on the pilot, growing nightly by 120,000) and reduced in JavaScript
 * to the newest run per measure, throwing the rest away. The site list did that on every page load,
 * because the dashboard shell asks for it. `listLatestPopulationOutcomes` pushed the reduction into
 * SQL, but PR #506 routed every non-default profile around it, so the pilot — the one deployment at
 * scale — took the slow path everywhere.
 *
 * Here the question is split in two: WHICH runs win (`OutcomeStore.listLatestPopulationRuns`, a
 * bounded walk over the runs table) and THEIR rows (`listOutcomesWithRun({ runIds })`, narrowed to
 * the measure where one measure is asked for). A read model that only needs the winners (the roster,
 * a memo key) never reads a row; one that needs the rows reads one run's worth per measure and not
 * the history.
 *
 * The rule the old code had implicitly — the winner is the newest run with at least one row the
 * CALLER can see — is kept, and it costs only what it did before, only when it fires. Every caller
 * filtered rows (profile, seam, site, tenant) BEFORE reducing to the newest run, so a newer run with
 * no row at the requested site fell through to an older run that had one. PR #506's tests pin the
 * profile half of that on scoped profiles (a newer run made of foreign subjects must not blank an
 * older visible one). A caller now passes its own visibility predicate; a measure whose winner holds
 * rows but none visible under it falls back to that ONE measure's history. On the pilot's own
 * database, with no site filter, it never fires.
 */
import type { LatestPopulationRun, OutcomeMeasureFilter, OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import { directoryForRows, type DirectorySnapshot } from "../engine/ingress/webchart/live-directory.ts";
import { DEPLOYMENT_PROFILE, DIRECTORY, profileSubjectMatcher } from "../config/deployment-profile.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";
import { isCompletedRun, isPopulationRun, latestRunRows } from "./rollup-shared.ts";

export interface LatestPopulationWinners {
  winners: LatestPopulationRun[];
  /**
   * The identity of the answer: every `measure:runId` pair, sorted. A terminal population run's
   * outcomes are immutable (the roster cell cache rests on the same fact), so anything derived from
   * the winners' rows alone is stable while this key is — it is what {@link RunKeyedMemo} checks.
   * A caller memoizes under the key it got from {@link latestPopulationWinners}, i.e. the winners
   * BEFORE any visibility fallback — and only when no fallback fired (`fellBack`), because a
   * fallback's answer can change without the winners changing.
   */
  runKey: string;
}

/** What a caller's visibility predicate is handed, so it can resolve the subject the way it will downstream. */
export interface VisibilityContext {
  directory: DirectorySnapshot;
  webChartConfigured: boolean;
  profileMatch: (subjectId: string) => boolean;
}

export interface SnapshotOptions {
  /** Winners a caller already resolved (for its memo check) — saves the second walk on a miss. */
  precomputed?: readonly LatestPopulationRun[];
  /**
   * The caller's own row-visibility rule (profile + seam + site + tenant, whatever it applies after
   * the read). A measure whose winner holds rows but none visible falls back to the newest run that
   * has one, exactly as the pre-2026-09-10 filter-then-reduce did. Default: PR #506's rule alone —
   * the profile match on a scoped profile, nothing on the default profile.
   */
  visible?: (subjectId: string, ctx: VisibilityContext) => boolean;
}

export interface LatestPopulationSnapshot extends LatestPopulationWinners {
  /**
   * The winners' rows: population-scoped, terminal, one run per measure (or `perMeasure` runs when a
   * caller asked for a window). NOT filtered by the caller's predicate — callers apply their
   * `profileMatch`/`subjectVisible`/site/tenant predicates exactly as they did over the full read,
   * so a fake that returns foreign rows still exercises the caller's filter. The one exception is a
   * measure the visibility fallback moved to an older run: it comes back with that run's VISIBLE
   * rows only, which is what the old filter-then-reduce kept; the caller's filter is idempotent over it.
   */
  rows: OutcomeWithRun[];
  directory: DirectorySnapshot;
  webChartConfigured: boolean;
  profileMatch: (subjectId: string) => boolean;
  /**
   * True when at least one measure's rows came from the visibility fallback rather than its winner.
   * A caller must NOT memoize such a result under the winners' key: a visible run that started
   * before the winner and completes after it changes the fallback's answer without changing the
   * winner — so the key would never move and the older run would be served indefinitely (Codex on
   * #547). The fallback path is the filtered-view path and costs what it did before; it is simply
   * not cached.
   */
  fellBack: boolean;
}

const pairKey = (measureId: string, runId: string): string => `${measureId}:${runId}`;

const winnersFilter = (filter: OutcomeMeasureFilter): OutcomeMeasureFilter => {
  // The measure list is the argument; a stray measureId/runIds on the filter must not narrow the
  // walk (and `listLatestPopulationRuns` ignores them anyway).
  const { measureId: _m, runIds: _r, ...rest } = filter;
  return rest;
};

export const runKeyOf = (winners: readonly LatestPopulationRun[]): string =>
  winners.map((w) => pairKey(w.measureId, w.runId)).sort().join(",");

/** The winners only — what a memo key or the roster needs; no outcome row is read. */
export async function latestPopulationWinners(
  store: Pick<OutcomeStore, "listLatestPopulationRuns">,
  measureIds: readonly string[],
  filter: OutcomeMeasureFilter,
  perMeasure = 1,
): Promise<LatestPopulationWinners> {
  const winners = measureIds.length === 0 ? [] : await store.listLatestPopulationRuns(measureIds, winnersFilter(filter), perMeasure);
  return { winners, runKey: runKeyOf(winners) };
}

const populationRow = (r: OutcomeWithRun): boolean => isPopulationRun(r.runScopeType) && isCompletedRun(r.runStatus);

/**
 * The winners' rows, read as few times and as narrowly as the winners allow. One measure → one read
 * narrowed to it (the trend's window is ten runs of ONE measure; reading the whole ALL_PROGRAMS run
 * ten times would be 1.2M rows to keep 200k). Several measures sharing a run → that run once. A run
 * that won for a strict subset of the measures → narrowed to its one measure, or read whole and
 * filtered to the pairs when it won for several.
 */
async function readWinnersRows(
  store: Pick<OutcomeStore, "listOutcomesWithRun">,
  measureIds: readonly string[],
  filter: OutcomeMeasureFilter,
  winners: readonly LatestPopulationRun[],
): Promise<OutcomeWithRun[]> {
  if (winners.length === 0) return [];
  const base = winnersFilter(filter);
  // Each read carries the (measure, run) pairs it was issued for, and keeps only those rows: an
  // ALL_PROGRAMS run that won for measure A also holds measure B's rows, and B may have won a
  // different run — and a test double that ignores the filter returns everything on every read.
  const reads: Array<{ filter: OutcomeMeasureFilter; pairs: Set<string> }> = [];
  const distinct = [...new Set(measureIds)];
  const byRun = new Map<string, Set<string>>();
  for (const w of winners) (byRun.get(w.runId) ?? byRun.set(w.runId, new Set()).get(w.runId)!).add(w.measureId);
  const pairsOf = (runIds: readonly string[]): Set<string> =>
    new Set(runIds.flatMap((runId) => [...(byRun.get(runId) ?? [])].map((m) => pairKey(m, runId))));
  if (distinct.length === 1) {
    const runIds = [...byRun.keys()];
    reads.push({ filter: { ...base, measureId: distinct[0]!, runIds }, pairs: pairsOf(runIds) });
  } else {
    const whole: string[] = [];
    for (const [runId, measures] of byRun) {
      if (measures.size === distinct.length) whole.push(runId);
      else if (measures.size === 1) reads.push({ filter: { ...base, measureId: [...measures][0]!, runIds: [runId] }, pairs: pairsOf([runId]) });
      else reads.push({ filter: { ...base, runIds: [runId] }, pairs: pairsOf([runId]) });
    }
    if (whole.length) reads.push({ filter: { ...base, runIds: whole }, pairs: pairsOf(whole) });
  }
  const rows: OutcomeWithRun[] = [];
  for (const read of reads) {
    // The population/terminal guard is redundant with the store's walk — defense-in-depth, like the
    // sibling reads.
    for (const r of await store.listOutcomesWithRun(read.filter)) {
      if (read.pairs.has(pairKey(r.measureId, r.runId)) && populationRow(r)) rows.push(r);
    }
  }
  return rows;
}

/**
 * The winners AND their rows. `measureIds` are the measures the caller shows; `perMeasure` > 1 widens
 * each measure to its newest N runs (the trend's window) — the visibility fallback applies only to a
 * single winner, so a windowed read on a scoped profile keeps whatever of its N runs is visible
 * (stated edge; the old code widened the window over the full history). The rows come back with the
 * run projection `latestRunRows` expects, so every downstream grouping is unchanged and a passthrough.
 */
export async function latestPopulationSnapshot(
  store: Pick<OutcomeStore, "listLatestPopulationRuns" | "listOutcomesWithRun">,
  measureIds: readonly string[],
  filter: OutcomeMeasureFilter,
  webChartEnv: DataSourceEnv | undefined,
  perMeasure = 1,
  opts: SnapshotOptions = {},
): Promise<LatestPopulationSnapshot> {
  const webChartConfigured = isWebChartConfigured(webChartEnv ?? {});
  const winners = opts.precomputed ? [...opts.precomputed] : (await latestPopulationWinners(store, measureIds, filter, perMeasure)).winners;
  const visible = opts.visible ?? ((subjectId, ctx) => DEPLOYMENT_PROFILE.id === "default" || ctx.profileMatch(subjectId));
  const contextFor = (rows: readonly OutcomeWithRun[]): VisibilityContext => {
    const directory = directoryForRows(rows, webChartConfigured, webChartEnv, DIRECTORY);
    return { directory, webChartConfigured, profileMatch: profileSubjectMatcher(directory.employeeById) };
  };

  let rows = await readWinnersRows(store, measureIds, filter, winners);
  let ctx = contextFor(rows);
  let fellBack = false;

  if (perMeasure === 1) {
    // The filter-then-reduce rule: a winner whose rows the caller cannot see does not blank the
    // measure. Detected per measure from the rows just read, and paid only for that measure's history.
    const byMeasure = new Map<string, OutcomeWithRun[]>();
    for (const r of rows) (byMeasure.get(r.measureId) ?? byMeasure.set(r.measureId, []).get(r.measureId)!).push(r);
    const blanked = [...byMeasure].filter(([, rs]) => rs.length > 0 && !rs.some((r) => visible(r.subjectId, ctx))).map(([m]) => m);
    if (blanked.length > 0) {
      const replaced = new Set(blanked);
      const kept = rows.filter((r) => !replaced.has(r.measureId));
      const fallback: OutcomeWithRun[] = [];
      for (const measureId of blanked) {
        const history = (await store.listOutcomesWithRun({ ...winnersFilter(filter), measureId })).filter(populationRow);
        const historyCtx = contextFor(history);
        fallback.push(...latestRunRows(history.filter((r) => visible(r.subjectId, historyCtx))));
      }
      rows = [...kept, ...fallback];
      ctx = contextFor(rows);
      fellBack = true;
    }
  }

  // The key names the runs the rows actually came from (a fallback moved a measure to an older run).
  const finalPairs = new Map<string, LatestPopulationRun>();
  for (const r of rows) {
    const k = pairKey(r.measureId, r.runId);
    if (!finalPairs.has(k)) {
      finalPairs.set(k, {
        measureId: r.measureId, runId: r.runId, runStartedAt: r.runStartedAt,
        runScopeType: r.runScopeType, runStatus: r.runStatus, runTriggeredBy: r.runTriggeredBy,
      });
    }
  }
  const finalWinners = [...finalPairs.values()];
  return { winners: finalWinners, runKey: runKeyOf(finalWinners), rows, directory: ctx.directory, webChartConfigured, profileMatch: ctx.profileMatch, fellBack };
}

/**
 * A process-lifetime memo keyed by a caller's own key (its filters) and validated by the winners'
 * `runKey`: an entry is served only while the same runs win, so a nightly that completes — or a
 * rerun that supersedes a measure's winner — invalidates it on the next read, without a timer.
 *
 * Only for values derived from the winners' OUTCOME rows. Anything that reads a mutable table
 * (cases, waivers, the measure's rate memo that pages evidence) is computed outside the memo, per
 * request. Bounded: the oldest entry is evicted past `max`, so a filter combination nobody repeats
 * cannot grow it. Not shared across processes and lost on restart, like `rosterCellCache`.
 *
 * One residual, stated: retention compaction (ADR-073) deletes rows of runs that are NOT a measure's
 * newest, so a trend memo built over a 10-run window can hold counts for an older run compaction
 * has since thinned — until the next nightly changes the winner and refreshes it. The newest run's
 * rows are never compacted, so a one-run memo (overview, sites, top-drivers) has no such window.
 */
export class RunKeyedMemo<T> {
  private readonly entries = new Map<string, { runKey: string; value: T }>();
  constructor(private readonly max = 32) {}

  get(key: string, runKey: string): T | undefined {
    const hit = this.entries.get(key);
    return hit && hit.runKey === runKey ? hit.value : undefined;
  }

  set(key: string, runKey: string, value: T): T {
    this.entries.delete(key);
    this.entries.set(key, { runKey, value });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  /** Test seam. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
