/**
 * The work list, as one read model (MM-2).
 *
 * `/api/cases` grew this pipeline inline; `/api/worklist/patients` needs the same cases grouped by
 * patient rather than listed by gap. Two copies of "which cases is this person working?" would
 * disagree the first time either was touched — a case on one screen and not the other, with nothing
 * reporting the disagreement — so the pipeline lives here and both routes call it.
 *
 * **What moved in, deliberately:**
 *
 * - **The default status set is ACTIVE (`OPEN` + `IN_PROGRESS`), not `OPEN`.** `statusesFor("open")`
 *   returned `["OPEN"]` while `ACTIVE_CASE_STATUSES` — the contract's own definition of an active case,
 *   which every rollup and open-case count uses — is both. So a case an operator moved to IN_PROGRESS
 *   dropped off the default work list: the one case someone had actually started disappeared from the
 *   list they started it from. `DATA_MODEL_CONTRACTS` §4 names this exact hazard for the counts; the
 *   list had it too.
 * - **The panel pre-filter.** The panel filters are DIRECTORY joins — there is no patients table in
 *   Postgres — so working a 150-case panel meant loading every case in the practice and discarding
 *   ~99% in JavaScript. The matching subject ids are resolved from the in-memory directory first and
 *   passed as `CaseQuery.employeeIds`.
 * - **Outreach counts only when someone renders them.** `outreachSentCounts` is a grouped query over
 *   every returned case id; the patient work list does not show the badge, so it does not pay for it.
 *
 * **The pre-filter is GATED, and the gate is not an optimisation detail.** It is only applied when the
 * caller says its roster is the COMPLETE set of subjects that can appear on a case. On a
 * WebChart-configured deployment the route's `employeeLookup` resolves live subjects that are not in
 * `employees()` — so a pre-filter built from the directory would omit their cases entirely, and the
 * result would be a work list that is short by exactly the people the live integration exists to
 * serve. Missing rows read as "no gaps", which is the invisible wrong answer this codebase keeps
 * naming. Where the roster is not authoritative the pre-filter is skipped and the post-filter alone
 * decides, which is what happens today: slower, and correct.
 */
import type { CaseStore, CaseQuery } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { ACTIVE_CASE_STATUSES } from "./case-logic.ts";
import { toCaseSummary, type CaseSummary } from "./case-read-models.ts";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";
import {
  hasActiveSubjectFilters, matchesSubjectFilters, type SubjectFilters,
} from "../compliance/subject-filters.ts";

/** Every filter the work list understands. `subjects` carries the panel filters (PCP, payer, age, sex). */
export interface WorklistFilters {
  /** The raw `?status=` token — `open` (default), `closed`, `excluded`, `all`, or a concrete status. */
  status?: string | null;
  measureId?: string;
  priority?: string;
  assignee?: string;
  /** `?period=` — omitted/`current` on the open list means "each measure's current cycle". */
  period?: string;
  /** Case CREATION time, day-granular and inclusive. */
  from?: string;
  to?: string;
  site?: string;
  /** Outcome bucket (`OVERDUE`, `DUE_SOON`, …) — the "why flagged" axis, distinct from case status. */
  outcome?: string;
  /** `none` keeps cases with no OUTREACH_SENT record; `any` the rest. */
  outreach?: "none" | "any";
  search?: string;
  subjects?: SubjectFilters;
}

export interface WorklistDeps {
  cases: CaseStore;
  events: CaseEventStore;
  /** Resolves a subject id to a profile. On a live deployment this reaches beyond `roster`. */
  employeeLookup: (externalId: string) => EmployeeProfile | null;
  /** Resolves a provider id to its display name (for `CaseSummary.providerName`). */
  providerLookup?: (id: string) => { name: string } | null;
  /**
   * The complete roster, for the panel pre-filter — pass it ONLY when every subject that can appear on
   * a case is in it. Omitting it is always safe: the pre-filter is skipped and the post-filter decides.
   * See the header note on why a partial roster here would silently shorten the list.
   */
  roster?: () => readonly EmployeeProfile[];
  /** Whether to compute `outreachRecordCount`. Off by default — it is a query per call. */
  withOutreachCounts?: boolean;
  /** Keeps only subjects this deployment profile owns (the route's `profileSubjectMatcher`). */
  profileMatch?: (externalId: string) => boolean;
  /** Injectable clock, so the current-cycle default is testable. */
  today?: () => string;
}

/**
 * Map the `?status=` token to concrete case statuses.
 *
 * The default is the ACTIVE set — see the header. `all` is the explicit unfiltered view; anything
 * else is taken as a literal status so a caller can ask for one precisely.
 */
export function statusesForWorklist(raw: string | null | undefined): string[] | undefined {
  switch ((raw ?? "").toLowerCase()) {
    case "all":
      return undefined;
    case "closed":
      return ["RESOLVED", "CLOSED"];
    case "excluded":
      return ["EXCLUDED"];
    case "":
    case "open":
      return [...ACTIVE_CASE_STATUSES];
    default:
      return [(raw as string).toUpperCase()];
  }
}

/** Day portion (YYYY-MM-DD) for day-granular, inclusive comparison. */
const day = (s: string): string => s.slice(0, 10);

/**
 * The subject ids a panel-filtered query can possibly match, or `undefined` when the pre-filter does
 * not apply (no panel filter active, or no authoritative roster to resolve against).
 *
 * `site` joins the pre-filter only when it names a real site. A case whose subject the directory
 * cannot resolve renders its site as `—`, and that row survives a `?site=—` post-filter — so
 * pre-filtering on that token would drop exactly the rows it is supposed to keep. Rare enough to be a
 * curiosity, cheap enough to be exact.
 */
export function panelSubjectIds(
  roster: readonly EmployeeProfile[],
  subjects: SubjectFilters | undefined,
  site: string | undefined,
  nowMs: number = Date.now(),
): readonly string[] | undefined {
  const panelActive = subjects ? hasActiveSubjectFilters(subjects) : false;
  const siteActive = Boolean(site && site !== "—");
  if (!panelActive && !siteActive) return undefined;
  const ids: string[] = [];
  for (const employee of roster) {
    if (siteActive && employee.site !== site) continue;
    if (panelActive && !matchesSubjectFilters(employee, subjects!, nowMs)) continue;
    ids.push(employee.externalId);
  }
  return ids;
}

/**
 * The filtered work list, newest-first, BEFORE paging — so a caller can page it or group it and still
 * report an exact total.
 */
export async function loadWorklistCases(deps: WorklistDeps, filters: WorklistFilters): Promise<CaseSummary[]> {
  const nowMs = Date.now();
  const wantCurrentCycle = isCurrentCycleDefault(filters);

  const query: CaseQuery = {
    statuses: statusesForWorklist(filters.status),
    measureId: filters.measureId,
    priority: filters.priority,
    assignee: filters.assignee,
    period: wantCurrentCycle ? "all" : (filters.period || "all"),
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0,
  };
  // The pre-filter, where the roster is authoritative. `employeeIds: []` is a real constraint meaning
  // "no subject matches" — a PCP with no patients must return no cases rather than the practice's.
  const preFilter = deps.roster ? panelSubjectIds(deps.roster(), filters.subjects, filters.site, nowMs) : undefined;
  if (preFilter !== undefined) query.employeeIds = preFilter;

  // Uncapped on purpose: the current-cycle default post-filters per measure in JS, so the loaded set
  // must be complete or a total would under-report and a client would stop paging early (#150 M10).
  let rows = await deps.cases.listCases(query);

  if (filters.from) rows = rows.filter((c) => day(c.createdAt) >= day(filters.from!));
  if (filters.to) rows = rows.filter((c) => day(c.createdAt) <= day(filters.to!));
  if (deps.profileMatch) rows = rows.filter((c) => deps.profileMatch!(c.employeeId));

  const counts = deps.withOutreachCounts ? await deps.events.outreachSentCounts(rows.map((c) => c.id)) : {};
  let summaries = rows.map((c) => toCaseSummary(c, counts[c.id] ?? 0, deps.employeeLookup, deps.providerLookup));

  if (wantCurrentCycle) {
    // Each measure's CURRENT cycle by today + its cadence: exact and cadence-correct, so a stale row
    // at another cadence's anchor cannot appear and a rolled-over cycle with no open cases does not
    // fall back to a prior cycle's opens.
    const today = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
    summaries = summaries.filter((c) => c.evaluationPeriod === bucketPeriodForMeasure(c.measureVersionId, today));
  }
  // The post-filters stay authoritative even where the pre-filter ran: they are the same predicate over
  // the same directory, so the pre-filter can only narrow the fetch, never change the answer.
  if (filters.site) summaries = summaries.filter((c) => c.site === filters.site);
  if (filters.subjects && hasActiveSubjectFilters(filters.subjects)) {
    summaries = summaries.filter((c) => matchesSubjectFilters(deps.employeeLookup(c.employeeId), filters.subjects!, nowMs));
  }
  if (filters.outcome) summaries = summaries.filter((c) => (c.currentOutcomeStatus ?? "").toUpperCase() === filters.outcome);
  if (filters.outreach) {
    summaries = summaries.filter((c) => (filters.outreach === "none") === ((c.outreachRecordCount ?? 0) === 0));
  }
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    summaries = summaries.filter(
      (c) =>
        c.employeeName.toLowerCase().includes(needle) ||
        c.measureName.toLowerCase().includes(needle) ||
        c.employeeId.toLowerCase().includes(needle),
    );
  }
  return summaries;
}

/**
 * Whether this query means "each measure's current compliance cycle".
 *
 * Only the OPEN list defaults to it; the closed/excluded/all tabs show full history. A BLANK
 * `?period=` (present but empty, which is what a cleared control sends) is the default rather than a
 * literal period — `??` alone would leak it through and reintroduce the flood this default prevents.
 */
function isCurrentCycleDefault(filters: WorklistFilters): boolean {
  const status = (filters.status ?? "").toLowerCase();
  const isOpenList = status === "" || status === "open";
  const period = filters.period?.trim() || undefined;
  return isOpenList && (!period || period.toLowerCase() === "current");
}
