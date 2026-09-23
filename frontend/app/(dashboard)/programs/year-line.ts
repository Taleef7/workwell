/** The shape `yearLineFor` reads off a program summary. */
export interface DatedSummary {
  measurementYear?: number | null;
  asOf?: string | null;
}

/**
 * The page's one line of context: which year the numbers describe, as of when (#637). On 1 January
 * the first run of a new year replaces last year's final numbers, and without this the page gave no
 * sign that near-empty cards were a new year rather than a collapse. "Measurement year" is the
 * pilot's (calendar-year eCQM) vocabulary; the occupational deployment's rolling-window measures get
 * the plain "as of".
 */
export function yearLineFor(programs: DatedSummary[], calendarYear: boolean): string | null {
  const dated = programs.filter((p) => p.measurementYear != null && p.asOf);
  if (dated.length === 0) return null;
  const asOf = dated.map((p) => p.asOf!).sort().at(-1)!;
  const asOfLabel = new Date(`${asOf}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  if (!calendarYear) return `Latest results as of ${asOfLabel}`;
  const years = [...new Set(dated.map((p) => p.measurementYear!))].sort((a, b) => a - b);
  if (years.length > 1) return `Measurement years ${years[0]}–${years.at(-1)} · latest results as of ${asOfLabel}`;
  const year = years[0]!;
  return `Measurement year ${year}${asOf < `${year}-12-31` ? " · year to date" : ""}, as of ${asOfLabel}`;
}

