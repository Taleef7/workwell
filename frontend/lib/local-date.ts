/**
 * The browser's own calendar (#882). The server's "today" is the practice's date (Maui: Pacific/Honolulu),
 * and a browser at the practice is in that zone, so every default year, every "today" and every
 * January-to-March check reads the LOCAL calendar. `toISOString()` and `getUTC*` are UTC's: in Hawaii the
 * UTC date turns at 2 PM, so on the afternoon of 31 December they already named the next year.
 */
import { SUBJECT } from "./terminology";

const pad = (n: number): string => String(n).padStart(2, "0");

/** The browser's date as `YYYY-MM-DD`. */
export function localIsoDate(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The browser's calendar year. */
export function localYear(at: Date = new Date()): number {
  return at.getFullYear();
}

/**
 * January to March: the first nightly of the year closed every open case of the year before, and the lead
 * may still re-score that year so records that arrived late reach its scorecard and list report. This
 * year's rates rest on the few patients seen so far.
 */
export function inCloseOutWindow(at: Date = new Date()): boolean {
  return at.getMonth() <= 2;
}

/**
 * Why an open-gap list is empty or short from January to March, or null in the rest of the year: last
 * year's gaps were closed, and this year's open only as patients are seen.
 */
export function newYearListNote(at: Date = new Date()): string | null {
  if (!inCloseOutWindow(at)) return null;
  const year = localYear(at);
  return `${year - 1}'s gaps closed when ${year} began. ${year}'s gaps appear as ${SUBJECT.plural} are seen, so this list starts short in January.`;
}

/** A timestamp's date in the browser's zone, as "January 5, 2027". */
export function localLongDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}
