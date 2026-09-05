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
