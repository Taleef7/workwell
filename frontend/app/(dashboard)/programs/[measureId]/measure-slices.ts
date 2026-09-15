/**
 * The measure detail page's four panels, their load statuses, and the measure they describe — as one
 * tagged value with a pure reducer over it.
 *
 * Why a tag rather than a request counter. The page used to gate its first paint on
 * `Promise.allSettled` over all four reads, so the whole page waited for `risk-outlook`, which on the
 * pilot answered 504 after 60 s: the measure page rendered nothing at all for a minute, and the Maui
 * e2e suite's one flake is exactly that (no heading within 20 s). Un-gating it means each panel lands
 * on its own, which re-opens the race the `allSettled` was accidentally closing — A's slow response
 * painting under B's heading after a navigation.
 *
 * The identity of the data is therefore carried WITH the data, as `(measureId, loadId)`, and every
 * update goes through {@link applySlice}, which drops anything not matching BOTH. The render reads
 * the panels only while the measure tag equals the route's.
 *
 * Both halves of that pair are load-bearing, and the first cut shipped only the first:
 * - **`measureId`** catches a navigation. A `reqId` counter alone does not, because the counter lives
 *   in a ref the render never consults — the guard runs inside the loader while the render still
 *   trusts whatever is in state.
 * - **`loadId`** catches two loads of the SAME measure overlapping, which happens whenever a
 *   `ww:run-complete` refresh starts while the first read is in flight. Without it the older response
 *   lands last and overwrites the newer run's numbers. Two independent reviewers raised this against
 *   the measure-tag-only version.
 *
 * Pure and exported so the tag rule is unit-testable without a DOM: the jsdom `next/navigation` mock
 * updates `useParams` synchronously, which defines the router race away and cannot reproduce it
 * (JOURNAL 2026-09-12 — the standing rule about that harness).
 */

export type ProgramSummary = {
  measureId: string;
  measureName: string;
  policyRef: string;
  version: string;
  latestRunId: string | null;
  latestRunAt: string | null;
  totalEvaluated: number;
  denominator?: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  /** Patients the measure's logic put outside its initial population — not missing data, not work. */
  notInPopulation?: number;
  excluded: number;
  complianceRate: number;
  /** Which way the measure improves; sent by the programs API so the rate never waits on /api/measures. */
  improvementNotation?: "increase" | "decrease";
  openCaseCount: number;
};

export type TopDrivers = {
  bySite: Array<{ site: string; overdueCount: number; note: string }>;
  byRole: Array<{ role: string; overdueCount: number }>;
  byOutcomeReason: Array<{ reason: string; count: number; pct: number }>;
};

export type RiskOutlook = {
  upcomingNonCompliantCount: number;
  upcomingExpirations: Array<{
    externalId: string;
    name: string;
    site: string;
    measureName: string;
    lastExamDate: string;
    complianceWindowDays: number;
    daysSinceLastExam: number;
    daysUntilDueSoon: number;
    predictedDueSoonDate: string;
  }>;
  /**
   * @deprecated Retired server-side (ADR-081) and ALWAYS `[]`. The key is kept so the response
   * shape is unchanged for existing consumers; the page renders no panel for it. Do not read it,
   * and remove it when the API surface next takes a breaking change.
   */
  repeatNonCompliers: Array<{
    externalId: string;
    name: string;
    site: string;
    measureName: string;
    streakCount: number;
  }>;
  siteComplianceRates: Array<{
    site: string;
    total: number;
    compliant: number;
    upcomingExpirations: number;
    currentComplianceRate: number;
    predictedComplianceRate: number;
  }>;
};

/**
 * A FRESH empty value per call, never a shared module-level constant.
 *
 * The first cut exported one shared object that every `freshSlices` handed out, which review
 * flagged: a single `drivers.bySite.push` anywhere would corrupt every future fresh state in the
 * process. Freezing it fights the mutable type this mirrors from the API response, and the simpler
 * answer to shared mutable state is not to share it — `freshSlices` runs once per load, so the
 * allocation is free.
 */
export const emptyDrivers = (): TopDrivers => ({ bySite: [], byRole: [], byOutcomeReason: [] });

export type SliceKey = "program" | "trend" | "drivers" | "outlook";

/**
 * `loading` is the skeleton, `failed` is a named absence, `ready` is the render. Kept in a record
 * BESIDE the values rather than unioned into them, so no string literal has to be threaded through
 * `RiskOutlook | null` and every existing property access on the page still type-checks.
 */
export type SliceStatus = "loading" | "ready" | "failed";

export interface MeasureSlices<TrendPoint> {
  /** The measure these four values describe. Render nothing unless it matches the route. */
  measureId: string;
  /**
   * Which load these values belong to. The measure alone is not enough: two loads of the SAME measure
   * overlap whenever a `ww:run-complete` refresh starts while the first read is still in flight, and
   * without this the older response lands last and overwrites the newer run's numbers. Both an
   * external reviewer and the project's own reviewer raised it; the request-generation guard this
   * restores is the one the pre-2026-09-15 loader had in a ref, moved into the state the render
   * actually reads.
   */
  loadId: number;
  program: ProgramSummary | null;
  trend: TrendPoint[];
  drivers: TopDrivers;
  outlook: RiskOutlook | null;
  status: Record<SliceKey, SliceStatus>;
}

interface UpdateTag {
  measureId: string;
  loadId: number;
}

export type SliceUpdate<TrendPoint> = UpdateTag &
  (
    | { key: "program"; value: ProgramSummary | null }
    | { key: "trend"; value: TrendPoint[] }
    | { key: "drivers"; value: TopDrivers }
    | { key: "outlook"; value: RiskOutlook | null }
    | { key: SliceKey; failed: true }
  );

/** A fresh, all-loading object for a measure's `loadId`-th load. */
export function freshSlices<TrendPoint>(measureId: string, loadId = 0): MeasureSlices<TrendPoint> {
  return {
    measureId,
    loadId,
    program: null,
    trend: [],
    drivers: emptyDrivers(),
    outlook: null,
    status: { program: "loading", trend: "loading", drivers: "loading", outlook: "loading" },
  };
}

/**
 * Begin a load: rebase the state onto `(measureId, loadId)`.
 *
 * A NAVIGATION (the measure changed) resets every panel to its skeleton. A REFRESH of the same
 * measure keeps the values and statuses and only moves `loadId`, so the numbers on screen survive
 * until new ones land — the behaviour `Promise.allSettled` had — while the older in-flight responses
 * become stale and are dropped by {@link applySlice}.
 */
export function beginLoad<TrendPoint>(
  state: MeasureSlices<TrendPoint>,
  measureId: string,
  loadId: number,
): MeasureSlices<TrendPoint> {
  if (state.measureId !== measureId) return freshSlices<TrendPoint>(measureId, loadId);
  if (state.loadId === loadId) return state;
  return { ...state, loadId };
}

/**
 * Apply one landed (or failed) read. Returns the SAME object when the update belongs to another
 * measure or to a superseded load, so a stale response is a no-op rather than a re-render.
 *
 * A failure keeps whatever value was already there and only moves the status.
 */
export function applySlice<TrendPoint>(
  state: MeasureSlices<TrendPoint>,
  update: SliceUpdate<TrendPoint>,
): MeasureSlices<TrendPoint> {
  if (update.measureId !== state.measureId || update.loadId !== state.loadId) return state;
  if ("failed" in update) {
    return { ...state, status: { ...state.status, [update.key]: "failed" } };
  }
  const next: MeasureSlices<TrendPoint> = {
    ...state,
    status: { ...state.status, [update.key]: "ready" },
  };
  switch (update.key) {
    case "program":
      next.program = update.value;
      break;
    case "trend":
      next.trend = update.value;
      break;
    case "drivers":
      next.drivers = update.value;
      break;
    case "outlook":
      next.outlook = update.value;
      break;
  }
  return next;
}

/**
 * The previous point the KPI delta compares against, or null when there is no previous run.
 *
 * Deliberately NOT falling back to `program`: the page used to compare the current rate against the
 * CURRENT summary when the trend held fewer than two points, which is a subtraction from itself and
 * renders as "↑ 0.0 from previous" — a measure with exactly one run in its history claiming it had
 * held steady since a run that does not exist. The delta is now absent until there is something to
 * compare with, and it waits for the trend to be `ready` so it does not flash in while loading.
 */
export function previousTrendPoint<TrendPoint>(
  slices: Pick<MeasureSlices<TrendPoint>, "trend" | "status">,
): TrendPoint | null {
  if (slices.status.trend !== "ready") return null;
  return slices.trend.length > 1 ? (slices.trend[1] ?? null) : null;
}
