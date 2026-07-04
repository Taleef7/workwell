/**
 * Display formatting helpers.
 *
 * `fmtCount` groups an integer count with thousands separators ("1682100" → "1,682,100") so KPI numbers
 * read credibly at enterprise scale (UX-12). A FIXED "en-US" locale is used deliberately: an argument-less
 * `toLocaleString()` resolves to the runtime locale, which can differ between the SSR render and the
 * client and trigger a React hydration mismatch — a fixed locale renders identically on both.
 */
export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.trunc(n).toLocaleString("en-US");
}
