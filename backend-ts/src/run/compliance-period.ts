/**
 * Compliance-cycle bucketing (#150 H1) — TS port of `com.workwell.run.CompliancePeriod`.
 *
 * The case idempotency key is (employee, measure, evaluation_period). When evaluation_period
 * is the raw run date, every nightly run mints a fresh cohort of cases for the same people —
 * the worklist flood (#150 H1). Bucketing the period to the measure's current compliance CYCLE
 * (annual → Jan 1; biannual → Jan 1 / Jul 1; seasonal/flu → the Jul 1 season anchor) makes
 * repeated runs within one cycle idempotent: the same (employee, measure, period) key upserts
 * the existing case instead of inserting a new one.
 *
 * Pure + deterministic — string in, string out, no Date/timezone surprises — and mirrors the
 * Java helper line-for-line so BOTH stacks bucket identically across the #109 cutover.
 */
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { isVendoredOfficialMeasure } from "../config/official-measure-ids.ts";

export type Cadence = "ANNUAL" | "BIANNUAL" | "SEASONAL";

/** Flu is the only seasonal (Jul–Jun season) measure; everything else is recency-windowed. */
const SEASONAL_MEASURE_IDS = new Set<string>(["flu_vaccine"]);

/** Cadence from the compliance window: a ≤200-day window is biannual, otherwise annual; seasonal overrides both. */
export function cadenceFor(complianceWindowDays: number, seasonal: boolean): Cadence {
  if (seasonal) return "SEASONAL";
  if (complianceWindowDays > 0 && complianceWindowDays <= 200) return "BIANNUAL";
  return "ANNUAL";
}

/**
 * Anchor date (`YYYY-MM-DD`) of the compliance cycle containing `asOf` (also `YYYY-MM-DD`):
 *   ANNUAL   → Jan 1 of asOf's year
 *   BIANNUAL → Jan 1 (Jan–Jun) or Jul 1 (Jul–Dec)
 *   SEASONAL → Jul 1 of the current Jul–Jun season (prior year's Jul 1 when asOf is Jan–Jun)
 */
export function cycleAnchor(cadence: Cadence, asOf: string): string {
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  switch (cadence) {
    case "ANNUAL":
      return `${year}-01-01`;
    case "BIANNUAL":
      return month <= 6 ? `${year}-01-01` : `${year}-07-01`;
    case "SEASONAL":
      return month >= 7 ? `${year}-07-01` : `${year - 1}-07-01`;
  }
}

/** Cycle-anchor key for a window/seasonal flag at `asOf`. */
export function cycleKey(complianceWindowDays: number, seasonal: boolean, asOf: string): string {
  return cycleAnchor(cadenceFor(complianceWindowDays, seasonal), asOf);
}

/**
 * Measure-aware bucket: resolve the measure's compliance window + seasonality from its binding,
 * then return the cycle anchor for `asOf`. Unknown measures fall back to a 365-day annual cycle.
 */
export function bucketPeriodForMeasure(measureId: string, asOf: string): string {
  return cycleAnchor(cadenceForMeasure(measureId), asOf);
}

/** A measure's cycle cadence (unknown measures: annual). */
export function cadenceForMeasure(measureId: string): Cadence {
  // ADR-072: official-only measures bucket to the calendar year by rule, not by the 365-day fallback.
  if (!MEASURE_BINDINGS[measureId] && isVendoredOfficialMeasure(measureId)) return "ANNUAL";
  return cadenceFor(MEASURE_BINDINGS[measureId]?.complianceWindowDays ?? 365, SEASONAL_MEASURE_IDS.has(measureId));
}

/**
 * The calendar year that the case period `period` is (#882), or null when it is not one: a half-year or a
 * season (`2026-01-01` of a twice-yearly measure is January to June), or a period that is not a cycle's
 * first day. The case page says "2026 has ended" only of a year.
 */
export function cycleCalendarYear(measureId: string, period: string): number | null {
  const match = /^(\d{4})-01-01$/.exec(period);
  return match && cadenceForMeasure(measureId) === "ANNUAL" ? Number(match[1]) : null;
}

/**
 * Whether `period` is a cycle that has already ended on `today` (#882): strictly older than the measure's
 * current cycle, by cycle order, as the rollover compares (a non-date period is never earlier). An
 * outcome of such a cycle is recorded but never opens or reopens a case (`planCaseUpsert`), and a run
 * that scores one is never anyone's "latest" (`run/earlier-cycle.ts`).
 */
export function isEarlierCycle(measureId: string, period: string, today: string): boolean {
  return Date.parse(period) < Date.parse(bucketPeriodForMeasure(measureId, today));
}
