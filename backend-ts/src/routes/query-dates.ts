/**
 * Strict YYYY-MM-DD query-param parsing shared by the dashboard routes (programs + hierarchy),
 * so the two `/api` routes that accept the same from/to filters validate them identically and
 * can't drift. A malformed value throws QueryDateError → the route returns 400 instead of
 * silently lexicographically filtering on garbage.
 */
export class QueryDateError extends Error {}

/** Blank/absent → undefined (no filter). Throws QueryDateError on a malformed value. */
export function parseQueryDate(raw: string | null, field: string): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return v;
  }
  throw new QueryDateError(`${field} must use YYYY-MM-DD`);
}

/**
 * The CASE-WINDOW day predicate — deliberately NOT `parseQueryDate`, and the two must not be merged.
 *
 * `parseQueryDate` above serves the dashboard routes, which filter on DATES and therefore accept
 * `YYYY-MM-DD` and nothing else. `/api/cases` and the cases CSV filter on `created_at`, a TIMESTAMP
 * column, so they accept a day optionally carrying the rest of an ISO timestamp. Unifying them would
 * either start rejecting `?from=2026-09-01T00:00:00Z` on the case surfaces or start accepting it on
 * the dashboard ones; both are behaviour changes wearing a tidy-up's clothes.
 *
 * This lives here rather than in `routes/cases.ts` because the cases CSV has to validate a window
 * **identically** to the list it is exported from. When the export took three of the list's nine
 * filters, `from`/`to` were among the six it dropped — so a window narrowed on screen produced a
 * wider file, silently. One predicate is what makes that unable to recur.
 *
 * A REAL calendar day, not merely the shape of one. The first version of this guard was a regex
 * alone, which admitted `2026-02-30`, `2026-99-99` and a bare trailing `T` — each then filtering
 * lexicographically by its first ten characters instead of being refused. The components round-trip
 * through `Date.UTC`, and a timestamp suffix must itself parse.
 */
export function isCalendarDayOrTimestamp(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})([T ].+)?$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return false;
  return m[4] === undefined || !Number.isNaN(Date.parse(value));
}

/** The 400 body both case surfaces return, so the two refusals read the same to a caller. */
export function calendarDayErrorBody(name: string, value: string): { error: string; message: string; parameter: string } {
  return {
    error: "invalid_request",
    message: `${name} must be a date as YYYY-MM-DD (got '${value}')`,
    parameter: name,
  };
}

/**
 * Read and validate the `from`/`to` created-at window from a query string.
 *
 * Returns the pair, or the name+value of the first offender so the caller can 400 with its own
 * `json` helper — this module stays free of Response so it can be imported anywhere.
 */
export function caseWindowFrom(q: URLSearchParams):
  | { ok: true; from?: string; to?: string }
  | { ok: false; name: string; value: string } {
  const from = q.get("from")?.trim() || undefined;
  const to = q.get("to")?.trim() || undefined;
  for (const [name, value] of [["from", from], ["to", to]] as const) {
    if (value !== undefined && !isCalendarDayOrTimestamp(value)) return { ok: false, name, value };
  }
  return { ok: true, from, to };
}
