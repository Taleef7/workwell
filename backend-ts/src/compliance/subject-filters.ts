/**
 * The panel filters the pilot's quality staff actually work by — PCP, age band and sex (spec §5).
 *
 * **One definition, four surfaces.** The roster, the cases route, the CSV exports and the MCP tool all
 * apply these, and each of them previously grew its own copy of the `site` filter. A second definition
 * of "65+" that rounded differently would put a patient on one screen and not another, and nothing
 * would report the disagreement — so the predicate lives here and every surface calls it.
 *
 * **Placement is deliberate (spec §5):** these are read-time joins against the DIRECTORY, applied at
 * the same layer `site` is applied today. `CaseQuery` — the store interface — does not change. The
 * store knows about outcomes and cases; who a subject's PCP is, and how old they are, is directory
 * knowledge, and pushing it into SQL would put the directory in the database.
 */
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";

export const AGE_BANDS = ["0-17", "18-44", "45-64", "65+"] as const;
export type AgeBandFilter = (typeof AGE_BANDS)[number];
export const isAgeBand = (value: string): value is AgeBandFilter => (AGE_BANDS as readonly string[]).includes(value);

export type SexFilter = "F" | "M";
export const isSex = (value: string): value is SexFilter => value === "F" || value === "M";

export interface SubjectFilters {
  /** The PCP's EXTERNAL ID (`maui-prov-012`), never a display name — see `matchesSubjectFilters`. */
  providerId?: string | null;
  ageBand?: string | null;
  sex?: string | null;
}

/**
 * Age at a given instant, in whole years, from a `YYYY-MM-DD` date of birth.
 *
 * UTC throughout: the same patient must not change age band because the server moved timezone, and a
 * birthday is a calendar fact rather than an instant.
 */
export function ageAsOf(dateOfBirth: string, nowMs: number): number | null {
  const born = Date.parse(`${dateOfBirth.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(born)) return null;
  const now = new Date(nowMs);
  const dob = new Date(born);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export function ageBandOf(age: number): AgeBandFilter {
  if (age < 18) return "0-17";
  if (age < 45) return "18-44";
  if (age < 65) return "45-64";
  return "65+";
}

/**
 * Whether a subject passes every ACTIVE filter. An absent filter is not a constraint; an active filter
 * a subject cannot answer (no date of birth, no recorded sex) excludes them rather than admitting them.
 */
export function matchesSubjectFilters(
  employee: EmployeeProfile | null | undefined,
  filters: SubjectFilters,
  nowMs: number = Date.now(),
): boolean {
  const active = filters.providerId || (filters.ageBand && isAgeBand(filters.ageBand)) || (filters.sex && isSex(filters.sex.toUpperCase()));
  if (!active) return true;
  // A subject the directory cannot resolve fails every active filter. Admitting them would make an
  // unknown id read as "matches everything", which is the opposite of what a filter is for.
  if (!employee) return false;

  if (filters.providerId) {
    // The PCP's external id, never a display name: two clinicians can share a name, ids are what the
    // attribution is recorded against, and a name that happened to match would be a coincidence.
    if (employee.providerId !== filters.providerId) return false;
  }
  // An unrecognised token is NOT a constraint, here as well as in `subjectFiltersFromQuery`. The rule
  // lives in both places deliberately: the query parser sanitises what arrives over HTTP, and this
  // guards every other caller — the read model, the exports, the MCP tool — so a junk band passed
  // directly renders the unfiltered roster rather than an empty page reading "no patients".
  if (filters.ageBand && isAgeBand(filters.ageBand)) {
    if (!employee.dateOfBirth) return false;
    const age = ageAsOf(employee.dateOfBirth, nowMs);
    if (age === null || ageBandOf(age) !== filters.ageBand) return false;
  }
  if (filters.sex && isSex(filters.sex.toUpperCase())) {
    // A roster that records no sex (the occupational directory) matches NOTHING rather than
    // everything. A filter that quietly returns the whole roster looks exactly like a working one.
    if (!employee.sex || employee.sex.toUpperCase() !== filters.sex.toUpperCase()) return false;
  }
  return true;
}

/** Reads the three filters off a URL, ignoring values that are not one of the accepted tokens. */
export function subjectFiltersFromQuery(params: URLSearchParams): SubjectFilters {
  const providerId = params.get("providerId")?.trim() || null;
  const rawBand = params.get("ageBand")?.trim() ?? "";
  const rawSex = params.get("sex")?.trim().toUpperCase() ?? "";
  return {
    providerId,
    // An unrecognised token is DROPPED rather than passed through as a filter nothing can satisfy:
    // `?ageBand=old` should show the unfiltered roster, not an empty one that looks like no patients.
    ageBand: isAgeBand(rawBand) ? rawBand : null,
    sex: isSex(rawSex) ? rawSex : null,
  };
}
