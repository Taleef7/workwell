import { DEPLOYMENT_PROFILE } from "./deployment-profile.ts";

/**
 * The practice's calendar date (#882, LOCKED_DECISIONS §4A.10). "Today" — the cycle a work list shows,
 * the year a run scores, the date a re-check evaluates — is the date where the practice is, not the UTC
 * date: in Hawaii the UTC date turns at 2 PM, so a run started on the afternoon of 31 December would
 * otherwise score the next year and roll the old one over. A deployment with no zone keeps UTC.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

/** An `en-CA` (YYYY-MM-DD) day formatter for a zone, cached; a null or unknown zone is UTC. */
export function dayFormatterFor(timeZone: string | null | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "UTC";
  const cached = formatters.get(key);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: key, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    formatter = dayFormatterFor("UTC");
  }
  formatters.set(key, formatter);
  return formatter;
}

/** The practice's date as `YYYY-MM-DD`. Both arguments are parameters for tests. */
export function practiceToday(
  at: Date = new Date(),
  timeZone: string | null = DEPLOYMENT_PROFILE.practiceTimeZone,
): string {
  return dayFormatterFor(timeZone).format(at);
}

/** The practice's calendar year. */
export function practiceYear(
  at: Date = new Date(),
  timeZone: string | null = DEPLOYMENT_PROFILE.practiceTimeZone,
): number {
  return Number(practiceToday(at, timeZone).slice(0, 4));
}
