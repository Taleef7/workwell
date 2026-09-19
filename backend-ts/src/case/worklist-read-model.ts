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
 * - **Outreach counts only when someone renders them OR filters on them.** `outreachSentCounts` is a
 *   grouped query over every returned case id; the patient work list does not show the badge, so it
 *   does not pay for it — but an `outreach=` filter reads the count, so the filter asks for it too.
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
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { VENDORED_OFFICIAL_MEASURE_IDS } from "../config/official-measure-ids.ts";
import {
  hasActiveSubjectFilters, matchesSubjectFilters, type SubjectFilters,
} from "../compliance/subject-filters.ts";
import { liveAnswerForCase, liveCellsFor, type LiveCellDeps } from "../compliance/live-cell.ts";

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
  /**
   * Where "what does CQL say today" comes from (#569). Passed by the routes; omitted in tests that do
   * not exercise the staff-closed list. Present ⇒ the staff-closed list resolves the live status
   * before the outcome filter, so the filter and the rendered value are the same thing.
   */
  live?: LiveCellDeps;
}

/** The `?status=` token for the cases a PERSON closed (#569). */
export const STAFF_CLOSED_TOKEN = "staff_closed";
/** Every terminal status a person can have written — a manual close, a rerun-verified or -excluded one. */
export const STAFF_CLOSED_STATUSES = ["CLOSED", "RESOLVED", "EXCLUDED"] as const;

/** The store-side fragment a `?status=` token means: which statuses, and (for `staff_closed`) who closed them. */
export interface WorklistStatusQuery {
  statuses?: string[];
  closure?: "staff";
}

/**
 * Map the `?status=` token to the store query it means — ONE function for the work list, the cases
 * CSV and the MCP `list_cases` tool, which used to carry three copies of this switch and disagreed
 * the first time one was touched (#551 was that disagreement).
 *
 * **What a BLANK token means is the caller's, not this function's.** The work list and the MCP tool
 * default to the ACTIVE set (an operator's queue); the cases CSV applies no status filter by contract
 * (`DATA_MODEL_CONTRACTS` §6.3 — 32,558 rows on the pilot, not the 15,309 open ones), so a fold that
 * hard-coded either default would silently change the other caller's answer. `all` is the explicit
 * unfiltered view; `staff_closed` is every terminal row a person closed (`closure: "staff"` — the
 * store's whole classification, so an open row never qualifies); anything else is taken as a
 * literal status so a caller can ask for one precisely.
 */
export function worklistQueryFor(raw: string | null | undefined, opts: { blank: "active" | "all" }): WorklistStatusQuery {
  // Trimmed, because the ROUTES trim before comparing to the token and this did not: `?status=%20open`
  // took the default branch and asked the store for a literal status " OPEN ", which matches no row.
  switch ((raw ?? "").trim().toLowerCase()) {
    case "":
      return opts.blank === "all" ? {} : { statuses: [...ACTIVE_CASE_STATUSES] };
    case "all":
      return {};
    case "closed":
      return { statuses: ["RESOLVED", "CLOSED"] };
    case "excluded":
      return { statuses: ["EXCLUDED"] };
    case "open":
      return { statuses: [...ACTIVE_CASE_STATUSES] };
    case STAFF_CLOSED_TOKEN:
      return { statuses: [...STAFF_CLOSED_STATUSES], closure: "staff" };
    default:
      return { statuses: [(raw as string).trim().toUpperCase()] };
  }
}

/** The work list's own reading of the token (blank ⇒ ACTIVE). Kept for the callers that only need statuses. */
export function statusesForWorklist(raw: string | null | undefined): string[] | undefined {
  return worklistQueryFor(raw, { blank: "active" }).statuses;
}

/** Whether this query is the "closed by staff" list (#569). */
const isStaffClosedList = (filters: WorklistFilters): boolean =>
  (filters.status ?? "").trim().toLowerCase() === STAFF_CLOSED_TOKEN;

/**
 * The status a SURFACE shows for a row: the live display state where one was resolved, else the case
 * row's own column. Filtering and rendering must agree, so both read this.
 */
const liveOrFrozenStatus = (c: CaseSummary): string =>
  c.liveDisplayStatus ?? c.liveOutcomeStatus ?? c.currentOutcomeStatus;

/** Day portion (YYYY-MM-DD) for day-granular, inclusive comparison. */
const day = (s: string): string => s.slice(0, 10);

/**
 * The largest id set worth sending to the store as a pre-filter.
 *
 * Two reasons, and the first is a hard limit rather than a preference. The SQLite floor expands the
 * set into `employee_id IN (?, ?, …)` — one bind per id — against a per-statement variable cap
 * (999 on older builds, 32,766 on newer). A payer-group selection on the pilot's roster is ~6,800
 * ids, which is fine on one build and a fatal `too many SQL variables` on another, and the Postgres
 * ceiling binds the same set as ONE array parameter and never notices. Two stores must answer the
 * same question the same way; a cliff only one of them can fall off is not that.
 *
 * The second is that above this size the pre-filter has stopped earning its keep: a "panel" of
 * several thousand subjects is most of the practice, so the fetch it narrows was never the problem.
 * Skipping it is always CORRECT — the post-filter is authoritative and applies the same predicate —
 * so this trades a bounded amount of work for a bound nobody can trip over.
 */
export const PANEL_PREFILTER_MAX_IDS = 900;

/**
 * The subject ids a panel-filtered query can possibly match, or `undefined` when the pre-filter does
 * not apply (no panel filter active, no authoritative roster to resolve against, or a matched set too
 * large to send — see `PANEL_PREFILTER_MAX_IDS`).
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
    // Stop the moment the set is too large to be worth sending, rather than building a list of
    // thousands and discarding it. `undefined` here is "no pre-filter", NOT "nobody matches" — the
    // post-filter still applies the identical predicate, so the rows are the same either way.
    if (ids.length > PANEL_PREFILTER_MAX_IDS) return undefined;
  }
  return ids;
}

/**
 * Every measure whose current cycle this process can name.
 *
 * `bucketPeriodForMeasure` is per-measure because cadences differ, so the SQL form of "the current
 * cycle" is a TABLE of (measure, period) pairs rather than one date. This enumerates the measures the
 * pair can be computed for; a case whose slug is not here takes the same 365-day fallback anchor the
 * in-memory filter gives it, which is why the fallback is passed alongside rather than left implicit.
 */
/**
 * A slug no registry can hold, used to ask `bucketPeriodForMeasure` what an UNKNOWN measure's anchor
 * is — so the fallback comes from the same function the per-row filter uses instead of restating its
 * 365-day rule here.
 *
 * Spelled with underscores rather than a control character. An earlier draft wrote a NUL escape, which the editor
 * wrote as a literal NUL byte: the file compiled and every test passed, but git classified it
 * as binary, skipped CRLF normalisation, rendered the commit as a whole-file rewrite, and `grep -n`
 * answered "Binary file matches" with no line number for the module that DEFINES this read model.
 * That is the third time a control byte has reached a `.ts` file here.
 */
const UNKNOWN_MEASURE_SENTINEL = "__unknown-measure__";

function currentCyclesFor(today: string): { cycles: Array<{ measureId: string; evaluationPeriod: string }>; fallback: string } {
  const ids = new Set<string>([...Object.keys(MEASURE_BINDINGS), ...VENDORED_OFFICIAL_MEASURE_IDS]);
  return {
    cycles: [...ids].map((measureId) => ({ measureId, evaluationPeriod: bucketPeriodForMeasure(measureId, today) })),
    // The anchor an UNKNOWN slug gets. Computed through the same function, with a slug no registry
    // holds, so it cannot drift from the rule it mirrors.
    fallback: bucketPeriodForMeasure(UNKNOWN_MEASURE_SENTINEL, today),
  };
}

/**
 * Whether this query can be answered in SQL — and if not, WHY not, in a form a log line can carry.
 *
 * Three filters read the in-memory directory rather than the database and have no SQL form: `site`,
 * `search`, and a panel selection too large to send as ids. The staff-closed list is excluded for a
 * different reason: it resolves what CQL says today for EVERY row before filtering (the outcome
 * filter reads the live value, and the tab's three header counts describe the whole list), so it
 * needs the whole set by construction and a page would not shorten the work.
 *
 * Returning a REASON rather than a boolean is deliberate: a fast path that silently stops being taken
 * is indistinguishable from one that was never wired up, and the badge would quietly cost a second
 * again with nothing to look at.
 */
export function sqlPageBlockedBy(deps: WorklistDeps, filters: WorklistFilters, preFilter: readonly string[] | undefined): string | null {
  if (!deps.roster) return "roster-not-authoritative";
  if (isStaffClosedList(filters)) return "staff-closed-needs-whole-list";
  if (filters.site) return "site-is-a-directory-join";
  if (filters.search) return "search-is-a-directory-join";
  // An ACTIVE panel selection that produced no id set is one too large to send (`panelSubjectIds`
  // returns undefined past `PANEL_PREFILTER_MAX_IDS`); the post-filter is then the only thing that
  // can apply it. An INACTIVE selection produces no set either, and is not a blocker.
  if (filters.subjects && hasActiveSubjectFilters(filters.subjects) && preFilter === undefined) return "panel-too-large-to-bind";
  return null;
}

/**
 * The filtered work list, newest-first, BEFORE paging — so a caller can page it or group it and still
 * report an exact total.
 */
export async function loadWorklistCases(deps: WorklistDeps, filters: WorklistFilters): Promise<CaseSummary[]> {
  const nowMs = Date.now();
  const wantCurrentCycle = isCurrentCycleDefault(filters);

  const query: CaseQuery = {
    ...worklistQueryFor(filters.status, { blank: "active" }),
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

  // Resolved WITHOUT the outreach count, so every filter that does not need one runs first and the
  // count query is asked about the survivors instead of the whole fetched set. On the pilot the
  // dashboard's gap badge (`?status=open&outreach=none&limit=1`, fired on every page) discarded most
  // of what it had just counted: the current-cycle filter alone drops every prior period's rows.
  // Exact, not an approximation — `X-Total-Count` is computed after all the filters either way, and
  // the outreach filter still sees a real count for every row that reaches it.
  let summaries = rows.map((c) => toCaseSummary(c, 0, deps.employeeLookup, deps.providerLookup));

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
  // The outcome filter reads what the SURFACE shows, which on the staff-closed list is not the case
  // row's column. That column froze when the person closed the case, so filtering on it while the page
  // paints the live value would put rows labelled "Compliant" under an Overdue filter and drop rows
  // labelled "Overdue" from it — the same disagreement #569 exists to remove, one control over. The
  // live pass therefore runs BEFORE this filter on that list, and costs nothing extra: the caller
  // resolves the whole list for its header counts anyway.
  if (filters.outcome || isStaffClosedList(filters)) {
    if (deps.live && isStaffClosedList(filters)) summaries = await withLiveStatus(deps.live, summaries);
    if (filters.outcome) {
      // BOTH sides uppercased, because the SQL predicate is `UPPER(col) = UPPER($n)`. Comparing an
      // uppercased cell against the caller's raw token made a lowercase `?outcome=overdue` return
      // nothing here and everything on the SQL path — the routes happen to uppercase first, so it was
      // one caller away from being real.
      const wantOutcome = filters.outcome.toUpperCase();
      summaries = summaries.filter((c) => (liveOrFrozenStatus(c) ?? "").toUpperCase() === wantOutcome);
    }
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

  // The count, for the rows that survived — and the filter that reads it, last.
  //
  // Asked whenever the caller displays the badge OR filters on it. A caller that filtered on outreach
  // without asking for counts would otherwise see every row at 0: `outreach=none` would return
  // everything and `outreach=any` nothing, both under a heading claiming the opposite. No caller does
  // that today; a filter that cannot fail is how one starts.
  if (deps.withOutreachCounts || filters.outreach) {
    const counts = await deps.events.outreachSentCounts(summaries.map((c) => c.caseId));
    summaries = summaries.map((c) => ({ ...c, outreachRecordCount: counts[c.caseId] ?? 0 }));
  }
  if (filters.outreach) {
    summaries = summaries.filter((c) => (filters.outreach === "none") === ((c.outreachRecordCount ?? 0) === 0));
  }
  return summaries;
}

/** One page of the work list, and the exact size of the filtered set. */
export interface WorklistPage {
  total: number;
  rows: CaseSummary[];
}

/**
 * Whether the directory holds every subject that has a case — checked, never assumed.
 *
 * On a scoped deployment profile `profileMatch` hides any subject the directory does not know, and
 * that predicate has no SQL form: there is no patients table to join. The SQL page path is therefore
 * exact only while the invariant holds. It does hold on the pilot — the corpus is deterministic and
 * the list import refuses identifiers outside its namespace (ADR-082) — but a flag that ASSUMES it is
 * the vacuous-guard shape this codebase keeps paying for, so it is established from the data.
 *
 * Once per process, off the request path in the steady state, and re-established whenever a run has
 * written new cases (`invalidateCaseSubjectInvariant`). A violation disables the fast path and says so
 * in the log, rather than serving a total that counts people the page cannot show.
 */
let subjectInvariant: "unknown" | "holds" | "violated" = "unknown";
/**
 * The scan IN FLIGHT, so concurrent requests share one.
 *
 * Every run invalidates the answer, and the minutes after the nightly are exactly when the dashboard
 * is busiest — without this, each request arriving before the first scan returned would issue its own
 * `SELECT DISTINCT employee_id` (20,000 subjects on the pilot) through a ten-connection pool, which is
 * the contention shape this whole change exists to remove.
 */
let subjectInvariantScan: Promise<boolean> | null = null;
/**
 * Bumped by every invalidation, and captured by a scan when it STARTS.
 *
 * Without it a scan could answer with a snapshot taken before the writes that invalidated it: a run
 * commits a case for a foreign subject while a scan is in flight, the run then invalidates, and the
 * older scan lands afterwards and writes `holds` — restoring a stale answer that no later event
 * disturbs until a restart. A scan whose generation has moved therefore reports its result to its own
 * caller and does NOT publish it.
 */
let subjectInvariantGeneration = 0;

/** Called when new cases may have been written (the run pipeline, on both its finish paths) and by tests. */
export function invalidateCaseSubjectInvariant(): void {
  subjectInvariant = "unknown";
  subjectInvariantScan = null;
  subjectInvariantGeneration += 1;
}

async function directoryHoldsEveryCaseSubject(deps: WorklistDeps): Promise<boolean> {
  if (!deps.profileMatch) return true;
  if (subjectInvariant !== "unknown") return subjectInvariant === "holds";
  const startedAt = subjectInvariantGeneration;
  subjectInvariantScan ??= (async () => {
    const profileMatch = deps.profileMatch!;
    const subjects = await deps.cases.distinctCaseSubjectIds();
    const foreign = subjects.filter((id) => !profileMatch(id));
    const holds = foreign.length === 0;
    if (foreign.length > 0) {
      console.warn(
        `[worklist] invariant: ${foreign.length} case subject(s) are not in the directory — the SQL page path is disabled until a restart or the next run finds it restored`,
      );
    }
    // Only publish if nothing invalidated while this scan was running. A stale `holds` is the one
    // answer that matters here: it re-enables the fast path over data the scan never saw.
    if (subjectInvariantGeneration === startedAt) subjectInvariant = holds ? "holds" : "violated";
    return holds && subjectInvariantGeneration === startedAt;
  })().catch((err) => {
    // The check exists to be CONSERVATIVE, so a failure to establish it must not fail the request —
    // it means "not established", and the caller takes the slow path, which is always correct.
    console.warn(`[worklist] invariant: could not be established (${(err as Error)?.message ?? err}); taking the uncapped path`);
    subjectInvariantScan = null;
    return false;
  });
  return subjectInvariantScan;
}

/**
 * ONE page of the work list, answered in SQL where every active filter has a SQL form (#561).
 *
 * Why it exists: the dashboard's open-case badge asks for `?status=open&outreach=none&limit=1` on every
 * navigation, and the uncapped path loads every active case (15,309 on the pilot), builds a summary for
 * each, filters in JavaScript, counts outreach over the survivors, and hands back one row. About a
 * second, on every page load, for a number.
 *
 * Where a filter has no SQL form the uncapped path still runs and the answer is identical — slower, and
 * correct. Both paths consume the SAME `WorklistFilters`, and the conformance test runs them over one
 * fixture and requires identical totals and identical page ids, so the next filter added lands in both
 * or is caught.
 */
export async function loadWorklistPage(
  deps: WorklistDeps,
  filters: WorklistFilters,
  page: { limit: number; offset: number },
): Promise<WorklistPage> {
  const nowMs = Date.now();
  const preFilter = deps.roster ? panelSubjectIds(deps.roster(), filters.subjects, filters.site, nowMs) : undefined;
  const slow = async (): Promise<WorklistPage> => {
    const all = await loadWorklistCases(deps, filters);
    return { total: all.length, rows: all.slice(page.offset, page.offset + page.limit) };
  };
  if (sqlPageBlockedBy(deps, filters, preFilter) !== null) return slow();
  if (!(await directoryHoldsEveryCaseSubject(deps))) return slow();

  const today = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const wantCurrentCycle = isCurrentCycleDefault(filters);
  const query: CaseQuery = {
    ...worklistQueryFor(filters.status, { blank: "active" }),
    measureId: filters.measureId,
    priority: filters.priority,
    assignee: filters.assignee,
    period: wantCurrentCycle ? "all" : filters.period || "all",
    // The outcome filter compares the FROZEN column here, which is what the in-memory filter compares
    // on every list this path serves: the live value is resolved only for the staff-closed list, and
    // that list is not on this path (`sqlPageBlockedBy`). If it ever were, these two would disagree.
    outcome: filters.outcome,
    outreach: filters.outreach,
    createdFrom: filters.from,
    createdTo: filters.to,
  };
  if (preFilter !== undefined) query.employeeIds = preFilter;
  if (wantCurrentCycle) {
    const { cycles, fallback } = currentCyclesFor(today);
    query.cycles = cycles;
    query.cyclesFallbackPeriod = fallback;
  }

  const { total, rows } = await deps.cases.listCasesPage(query, page);
  // The invariant was established from the data, but it can go stale between a run's writes and the
  // next invalidation. A page row the profile would hide proves it has: the total already counted that
  // row, so neither showing it nor silently dropping it is right. Re-establish and answer the slow way.
  if (deps.profileMatch && rows.some((c) => !deps.profileMatch!(c.employeeId))) {
    invalidateCaseSubjectInvariant();
    return slow();
  }

  let summaries = rows.map((c) => toCaseSummary(c, 0, deps.employeeLookup, deps.providerLookup));
  // For the PAGE only — the whole point. The uncapped path counts outreach for every survivor because
  // its own filter needs it; here the filter is already applied in SQL.
  // The SAME condition the uncapped path uses. The SQL path no longer NEEDS the count to filter, but a
  // caller that filtered on outreach without asking for counts would otherwise get a list of cases that
  // provably have outreach with every badge reading 0 — a field-level divergence the conformance test
  // cannot see, because it compares totals and ids.
  if (deps.withOutreachCounts || filters.outreach) {
    const counts = await deps.events.outreachSentCounts(summaries.map((c) => c.caseId));
    summaries = summaries.map((c) => ({ ...c, outreachRecordCount: counts[c.caseId] ?? 0 }));
  }
  return { total, rows: summaries };
}

/**
 * Whether this query means "each measure's current compliance cycle".
 *
 * The OPEN list and the STAFF-CLOSED list default to it — a closure from a prior cycle describes a
 * prior cycle's gap, and the current cycle opened a new case (#569); the closed/excluded/all tabs
 * show full history. A BLANK `?period=` (present but empty, which is what a cleared control sends)
 * is the default rather than a literal period — `??` alone would leak it through and reintroduce the
 * flood this default prevents.
 */
function isCurrentCycleDefault(filters: WorklistFilters): boolean {
  const status = (filters.status ?? "").trim().toLowerCase();
  const isCycleList = status === "" || status === "open" || status === STAFF_CLOSED_TOKEN;
  const period = filters.period?.trim() || undefined;
  return isCycleList && (!period || period.toLowerCase() === "current");
}

/**
 * What CQL says TODAY for every STAFF-closed row in `summaries` (#569) — the winning run's cell for
 * each (subject, measure), read through `liveCellsFor` (bounded point reads, never a cache fill).
 *
 * Only staff-closed rows are resolved, because only they can be stale: the nightly upsert refreshes
 * an active row's `currentOutcomeStatus` and never touches a human closure again. Every other row is
 * returned as it came. A row whose measure has no winning run, or whose subject the run did not
 * evaluate, is `UNKNOWN` — shown as "current CQL status unavailable", never folded into "verified".
 */
export async function withLiveStatus(deps: LiveCellDeps, summaries: readonly CaseSummary[]): Promise<CaseSummary[]> {
  const staffClosed = summaries.filter((c) => c.closure === "STAFF");
  if (staffClosed.length === 0) return [...summaries];
  const live = await liveCellsFor(
    deps,
    staffClosed.map((c) => ({ subjectId: c.employeeId, measureId: c.measureId })),
  );
  return summaries.map((c) => {
    if (c.closure !== "STAFF") return c;
    // The cycle equality lives in `liveAnswerForCase`, shared with the cases CSV and the programs
    // chip: the winning run describes ITS cycle, so a case from a closed cycle reads UNKNOWN rather
    // than taking today's answer. The roster overlay enforces the same rule on the cell.
    const answer = liveAnswerForCase(live, c);
    if (answer.cell == null) {
      return { ...c, liveState: "UNKNOWN", liveOutcomeStatus: null, liveDisplayStatus: null, liveOutcomeRunId: answer.runId };
    }
    return {
      ...c,
      liveState: answer.state,
      liveOutcomeStatus: answer.cell.canonical,
      // The DISPLAY state as well as the bucket: out-of-population is canonical MISSING_DATA, and a
      // surface handed only the bucket would say "Missing Data" and "verified compliant" at once.
      liveDisplayStatus: answer.cell.status,
      liveOutcomeRunId: answer.runId,
    };
  });
}

/** The three numbers the staff-closed tab shows in its header: still counted by CQL, verified, not evaluated. */
export function staffClosedCounts(summaries: readonly CaseSummary[]): { gap: number; verified: number; unknown: number } {
  const counts = { gap: 0, verified: 0, unknown: 0 };
  for (const c of summaries) {
    if (c.closure !== "STAFF") continue;
    if (c.liveState === "GAP") counts.gap += 1;
    else if (c.liveState === "CLEAR") counts.verified += 1;
    else counts.unknown += 1;
  }
  return counts;
}
