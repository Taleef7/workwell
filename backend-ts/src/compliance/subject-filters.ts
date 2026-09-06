/**
 * The panel filters the pilot's quality staff actually work by — PCP, age band and sex (spec §5).
 *
 * **One definition, four surfaces.** The roster, the cases route, the CSV exports and the MCP tool all
 * apply these, and each of them previously grew its own copy of the `site` filter. A second definition
 * of "65+" that rounded differently would put a patient on one screen and not another, and nothing
 * would report the disagreement — so the predicate lives here and every surface calls it.
 *
 * **An unrecognised token is REFUSED, never dropped.** The first version dropped `?ageBand=old` and
 * served the unfiltered roster, reasoning that an empty page reading "no patients" was the worse
 * failure. It is the other way round. A work list that silently ignores a filter looks exactly like a
 * work list that applied it: a staff member asking for the 65+ panel and handed everybody would call
 * every one of them, or trust a count that is the whole practice's. An empty page with a 400 saying
 * which token was wrong is a visible failure; the whole roster under a filter that was not applied is
 * an invisible wrong answer, which is the failure class this project names. So the HTTP parser throws
 * a `SubjectFilterError` (the routes turn it into a 400 naming the accepted values), the MCP tool
 * returns an INVALID_ARGUMENT error, and the predicate — which every surface reaches only through one
 * of those two — treats a token it does not recognise as a constraint nobody satisfies.
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

export const SEXES = ["F", "M"] as const;
export type SexFilter = (typeof SEXES)[number];
export const isSex = (value: string): value is SexFilter => value === "F" || value === "M";

export interface SubjectFilters {
  /** The PCP's EXTERNAL ID (`maui-prov-012`), never a display name — see `matchesSubjectFilters`. */
  providerId?: string | null;
  ageBand?: string | null;
  sex?: string | null;
}

/** A filter token the surface does not accept. Routes map it to a 400; the message names the accepted values. */
export class SubjectFilterError extends Error {
  constructor(readonly parameter: "ageBand" | "sex", readonly received: string) {
    super(
      parameter === "ageBand"
        ? `ageBand must be one of ${AGE_BANDS.join(", ")}; received "${received}"`
        : `sex must be one of ${SEXES.join(", ")}; received "${received}"`,
    );
    this.name = "SubjectFilterError";
  }
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
  const ageBand = filters.ageBand?.trim() || null;
  const sex = filters.sex?.trim().toUpperCase() || null;
  const active = Boolean(filters.providerId || ageBand || sex);
  if (!active) return true;
  // A subject the directory cannot resolve fails every active filter. Admitting them would make an
  // unknown id read as "matches everything", which is the opposite of what a filter is for.
  if (!employee) return false;

  if (filters.providerId) {
    // The PCP's external id, never a display name: two clinicians can share a name, ids are what the
    // attribution is recorded against, and a name that happened to match would be a coincidence.
    if (employee.providerId !== filters.providerId) return false;
  }
  if (ageBand) {
    // A token that is not a band is a constraint NOBODY satisfies — never one everybody does. The
    // parsers above refuse such a token before it gets here; this is the backstop for a caller that
    // bypasses them, and its failure is an empty list, which is visible, rather than the whole roster,
    // which is not.
    if (!isAgeBand(ageBand)) return false;
    if (!employee.dateOfBirth) return false;
    const age = ageAsOf(employee.dateOfBirth, nowMs);
    if (age === null || ageBandOf(age) !== ageBand) return false;
  }
  if (sex) {
    if (!isSex(sex)) return false;
    // A roster that records no sex (the occupational directory) matches NOTHING rather than
    // everything. A filter that quietly returns the whole roster looks exactly like a working one.
    if (!employee.sex || employee.sex.toUpperCase() !== sex) return false;
  }
  return true;
}

/**
 * Reads the three filters off a URL. An unrecognised `ageBand` or `sex` token THROWS a
 * `SubjectFilterError`; the routes turn it into a 400 that names the accepted values.
 */
export function subjectFiltersFromQuery(params: URLSearchParams): SubjectFilters {
  const providerId = params.get("providerId")?.trim() || null;
  const rawBand = params.get("ageBand")?.trim() ?? "";
  const rawSex = params.get("sex")?.trim().toUpperCase() ?? "";
  if (rawBand && !isAgeBand(rawBand)) throw new SubjectFilterError("ageBand", rawBand);
  if (rawSex && !isSex(rawSex)) throw new SubjectFilterError("sex", rawSex);
  return {
    providerId,
    ageBand: rawBand || null,
    sex: rawSex || null,
  };
}

/** The 400 body a route returns for a `SubjectFilterError` — one shape, so every surface says it the same way. */
export function subjectFilterErrorBody(error: SubjectFilterError): { error: "invalid_request"; parameter: string; message: string } {
  return { error: "invalid_request", parameter: error.parameter, message: error.message };
}
