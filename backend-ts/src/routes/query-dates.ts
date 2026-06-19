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
