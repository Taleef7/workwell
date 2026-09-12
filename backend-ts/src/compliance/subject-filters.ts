/**
 * The panel filters the pilot's quality staff actually work by — PCP, age band, sex and primary payer
 * (spec §5; payer added for MM-2 after the practice asked to work a panel by insurance).
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
  /**
   * A SET of provider ids — "my panel" (MM-2 PR 2, ADR-080 d5). A subject matches when their provider
   * is ANY of them (OR within the filter; AND against the other filters, including `providerId`).
   *
   * A set rather than a single id because one staff member owns MANY providers: nine staff to
   * forty-odd providers is the pilot's shape, so "the patients I am responsible for" is inherently a
   * union. An EMPTY array is a real constraint meaning "no provider matches" — a viewer who owns no
   * panel sees an empty list, not the whole practice — while `undefined` is the absent filter.
   *
   * Not parsed from the query string by `subjectFiltersFromQuery`: it is resolved server-side from
   * the panel mappings and the caller's own identity, so a client cannot ask for somebody else's
   * panel by spelling it in a URL.
   */
  providerIds?: readonly string[] | null;
  ageBand?: string | null;
  sex?: string | null;
  /**
   * Primary payer, as one or more Source of Payment Typology codes. A subject matches when their
   * `payer` equals ANY of them (OR within the filter; AND against the other filters).
   *
   * **A SET rather than a single code, because Medicare is two codes.** The typology is hierarchical:
   * `1` is Medicare and `11` is its managed-care child, which a practice calls Medicare Advantage. On
   * the pilot corpus that is 3,927 patients under `1` and 2,900 under `11`, so a single-valued filter
   * lets someone ask for Medicare, receive 3,927, and never learn that 2,900 more were withheld under
   * a heading that claims to contain them — the ADR-079 failure shape exactly. The caller selects the
   * codes; `payerCodesInGroup` (`engine/synthetic/payer-display.ts`) is what turns "Medicare" into the
   * set that is actually present in the directory.
   *
   * **Open terminology, unlike `ageBand` and `sex`.** Those two have a closed, short list this
   * codebase owns, so a token outside it is a typo and gets a 400. A payer code comes from a live
   * Coverage and the typology has members we have not enumerated, so any non-empty token is ACCEPTED
   * and an unknown one simply matches nobody. Refusing it would mean refusing a real code because our
   * display table is incomplete.
   */
  payer?: readonly string[] | string | null;
}

/** The payer filter as a normalised code set: trimmed, de-duplicated, empties dropped. */
export function payerCodesOf(payer: SubjectFilters["payer"]): string[] {
  if (payer === null || payer === undefined) return [];
  const raw = typeof payer === "string" ? [payer] : payer;
  const codes = new Set<string>();
  for (const value of raw) {
    // A comma-joined value is accepted alongside a repeated parameter so `?payer=1,11` and
    // `?payer=1&payer=11` mean the same thing — an integrator will write one and the UI the other.
    for (const part of String(value).split(",")) {
      const trimmed = part.trim();
      if (trimmed) codes.add(trimmed);
    }
  }
  return [...codes];
}

/**
 * Whether ANY panel filter is active — the one question four surfaces were each answering with their
 * own copy of `providerId || ageBand || sex`.
 *
 * That copy is a **vacuous guard** the moment a filter is added: `payer` went into `SubjectFilters`
 * and into the predicate, and the roster, the cases route, the CSV exports and the MCP tool would each
 * have kept skipping the predicate entirely — serving an unfiltered list under a filtered heading,
 * which is the exact failure this module's header calls the invisible wrong answer. A guard that reads
 * as present and cannot fire is the defect class this project collects, so the question is asked once
 * here and every surface calls it.
 */
export function hasActiveSubjectFilters(filters: SubjectFilters): boolean {
  return Boolean(
    filters.providerId?.trim() ||
    // `!= null` rather than `.length`: an EMPTY panel set is an ACTIVE filter that matches nobody, and
    // reading it as inactive would serve the whole practice to a viewer who owns no panel — under a
    // heading that says "My panel". That is the exact shape of defect this function exists to prevent.
    filters.providerIds != null ||
    filters.ageBand?.trim() ||
    filters.sex?.trim() ||
    payerCodesOf(filters.payer).length > 0,
  );
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
  const payers = payerCodesOf(filters.payer);
  if (!hasActiveSubjectFilters(filters)) return true;
  // A subject the directory cannot resolve fails every active filter. Admitting them would make an
  // unknown id read as "matches everything", which is the opposite of what a filter is for.
  if (!employee) return false;

  if (filters.providerId) {
    // The PCP's external id, never a display name: two clinicians can share a name, ids are what the
    // attribution is recorded against, and a name that happened to match would be a coincidence.
    if (employee.providerId !== filters.providerId) return false;
  }
  if (filters.providerIds != null) {
    // An empty set matches NOBODY. Falling through to "no constraint" would answer "which of my
    // panel's patients have gaps?" with the whole practice.
    if (!filters.providerIds.includes(employee.providerId)) return false;
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
  if (payers.length > 0) {
    // A roster that records no payer (the occupational directory, and the live WebChart directory
    // until Coverage extraction lands) matches NOTHING rather than everything — same rule as `sex`,
    // for the same reason: a filter that quietly returns the whole roster looks exactly like a
    // working one. Exact code comparison: `1` does not match `11`, and grouping is the caller's job.
    if (!employee.payer || !payers.includes(employee.payer)) return false;
  }
  return true;
}

/**
 * Reads the three filters off a URL. An unrecognised `ageBand` or `sex` token THROWS a
 * `SubjectFilterError`; the routes turn it into a 400 that names the accepted values.
 */
export function subjectFiltersFromQuery(params: URLSearchParams): SubjectFilters {
  const providerId = params.get("providerId")?.trim() || null;
  // `65+` written literally in a query string decodes to `65 ` — `+` is a space in
  // application/x-www-form-urlencoded — so a hand-typed or naively built URL arrives here as `65`.
  // That is the ONE spelling of a real band the refusal below must not reject: the frontend encodes it
  // as `65%2B`, but an integrator's curl will not, and a 400 telling them to send `65+` when they did is
  // the wrong kind of strict. Nothing else is normalised; `old` stays a 400.
  const rawBand = (params.get("ageBand") ?? "").trim().replace(/^65$/, "65+");
  const rawSex = params.get("sex")?.trim().toUpperCase() ?? "";
  if (rawBand && !isAgeBand(rawBand)) throw new SubjectFilterError("ageBand", rawBand);
  if (rawSex && !isSex(rawSex)) throw new SubjectFilterError("sex", rawSex);
  // Repeated `?payer=` parameters and a comma-joined one both arrive here; `payerCodesOf` folds them
  // into one set. No refusal: payer terminology is open (see `SubjectFilters.payer`), so an unknown
  // code matches nobody instead of 400-ing a real code our display table has not been taught yet.
  const payer = payerCodesOf(params.getAll("payer"));
  return {
    providerId,
    ageBand: rawBand || null,
    sex: rawSex || null,
    payer: payer.length > 0 ? payer : null,
  };
}

/** The 400 body a route returns for a `SubjectFilterError` — one shape, so every surface says it the same way. */
export function subjectFilterErrorBody(error: SubjectFilterError): { error: "invalid_request"; parameter: string; message: string } {
  return { error: "invalid_request", parameter: error.parameter, message: error.message };
}
