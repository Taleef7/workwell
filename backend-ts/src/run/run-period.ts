/**
 * Shared measurement-period helper (ADR-072): an all-official run uses the calendar year containing
 * the evaluation date; an authored (or mixed) run keeps the rolling 365-day registry window.
 *
 * Exported so `planManualRun` and `case-rerun` cannot drift apart — the period must be one rule,
 * not two implementations that were once correct together.
 */
import { isOfficialRouted } from "../wiring/official-routing.ts";

export function runMeasurementPeriod(measureIds: readonly string[], evalDate: string): { start: string; end: string } {
  const allOfficial = measureIds.length > 0 && measureIds.every((id) => isOfficialRouted(id));
  if (allOfficial) {
    const year = evalDate.slice(0, 4);
    return { start: `${year}-01-01T00:00:00.000Z`, end: `${year}-12-31T23:59:59.999Z` };
  }
  const periodEnd = `${evalDate}T00:00:00.000Z`;
  return { start: new Date(new Date(periodEnd).getTime() - 365 * 86400000).toISOString(), end: periodEnd };
}

/**
 * The period a SINGLE-CASE rerun records. Officially routed measures get the calendar year, exactly as
 * a population run does. Everything else keeps `case-rerun`'s own historical ONE-DAY window.
 *
 * The one-day window is not an accident and must not be quietly replaced by `planManualRun`'s rolling
 * 365-day one: a rerun re-evaluates as of TODAY while the outcome stays keyed to the case's existing
 * compliance cycle (#150 H1/M6), and this period is what a MeasureReport or QRDA export then declares
 * as its reporting period. ADR-072 scoped the calendar-year change to officially-routed measures, so
 * changing the authored path here would be an undeclared behaviour change with regulatory output.
 */
export function caseRerunMeasurementPeriod(measureId: string, evalDate: string): { start: string; end: string } {
  if (isOfficialRouted(measureId)) return runMeasurementPeriod([measureId], evalDate);
  const start = `${evalDate}T00:00:00.000Z`;
  return { start, end: new Date(new Date(start).getTime() + 86400000 - 1000).toISOString() };
}
