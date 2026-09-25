/**
 * CSV export builders (#108 exports) — runs / outcomes / cases / audit, matching the column
 * contracts in docs/DATA_MODEL_CONTRACTS.md §6. Read from the existing stores + directories; no new data.
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { CaseStore, CaseQuery } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { toRunSummaryFromCounts, runCandidates, type RunFilters } from "../run/read-models.ts";
import { DEPLOYMENT_PROFILE, DIRECTORY, employeeById, profileSubjectMatcher, subjectNoun } from "../config/deployment-profile.ts";
import { directoryForRows } from "../engine/ingress/webchart/live-directory.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";
import { hasActiveSubjectFilters, matchesSubjectFilters, type SubjectFilters } from "../compliance/subject-filters.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { measureDisplayName } from "../measure/measure-name.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { toCsv, csvCell } from "./csv.ts";
import { closureKindOf } from "../case/case-logic.ts";
import { hasNoSingleWindow } from "../case/case-detail-read-model.ts";
import { matchesCaseSearch, shownStatusFor, siteMatches } from "../case/worklist-read-model.ts";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";
import { liveAnswerForCase, liveCellsFor, liveFieldsFor, type LiveCellDeps } from "../compliance/live-cell.ts";

const measureName = (measureId: string) => measureDisplayName(measureId);
const authoredVersion = (measureId: string) => {
  const lib = MEASURES[measureId]?.library ?? "";
  const dash = lib.lastIndexOf("-");
  return dash >= 0 ? lib.slice(dash + 1) : "-";
};

/**
 * The version that ACTUALLY computed the row (review, #357).
 *
 * `measureVersion` answers "what computed this", and the CSV is the artifact people mail around. Deriving
 * it from `MEASURES[id].library` stamps WorkWell's authored library version — `2.0.0` for cms122 — on a
 * row that CMS122FHIR **v1.0.000** produced. An official outcome carries its own version in
 * `evidence.official.version`, so read it from the record rather than from a static table: the same
 * evidence-first rule ADR-046 applied to MeasureReport and QRDA, for the same reason (a run's provenance
 * does not change because a flag moved later).
 */
const measureVersionFor = (measureId: string, evidence: unknown): string => {
  const official = (evidence as { official?: { version?: unknown } } | null | undefined)?.official;
  const version = official?.version;
  if (typeof version === "string" && version.trim()) return version.trim();
  return authoredVersion(measureId);
};

// ---- runs (DATA_MODEL §6.1) --------------------------------------------------
const RUN_HEADERS = [
  "runId", "measureName", "measureVersion", "scopeType", "triggerType", "status", "startedAt", "completedAt",
  // `notInPopulation` is APPENDED, never inserted: a consumer reading by position keeps every column
  // it had. It reports how many of `missingData` were subjects the measure's logic put outside its
  // population (ADR-079) — the number that explains why a dashboard denominator is smaller than
  // `totalEvaluated`. `missingData` itself still counts every persisted MISSING_DATA row, because the
  // export states what the run wrote.
  "durationMs", "totalEvaluated", "compliant", "dueSoon", "overdue", "missingData", "excluded", "passRate", "dataFreshAsOf",
  "notInPopulation",
] as const;

/**
 * The run-history CSV, filtered by the SAME predicate the screen filters by (#601).
 *
 * Until 2026-09-21 this took no filters at all and the button sent none, so a user who narrowed the
 * history to FAILED runs at one site last week pressed Export and received the most recent 200 runs
 * of everything — no error, and a plausible-looking file. Same defect as the cases CSV (#602), one
 * screen over, and `matchesRunFilters` is shared for the same reason `matchesCaseSearch` is: a second
 * copy of the predicate drifts the first time either is touched.
 *
 * **The candidate read is `runCandidates`, shared with `/api/runs`, and the cap applies AFTER
 * filtering.** The old form read the newest 200 rows and then had nothing to filter, so a deployment
 * with more than 200 runs could not export an older one at all — and the screen said nothing about
 * 200. Sharing the read is what stops the fix recreating the defect from the other side: unbounded
 * here against the list's own 1,000 would have exported rows the screen never showed.
 */
export async function runsCsv(
  runStore: RunStore,
  outcomeStore: OutcomeStore,
  limit = 200,
  filters: RunFilters = {},
): Promise<string> {
  const runs = (await runCandidates(runStore, filters)).slice(0, limit);
  const rows: unknown[][] = [];
  // ONE query in flight at a time, for the same reason the cases CSV batches (2026-09-13). This was
  // `Promise.all` over the runs: up to 200 concurrent `countOutcomesByStatus` queries against a
  // ten-connection pool. Each is a bounded GROUP BY, so it never 504'd the way the cases export did —
  // but it held every connection while it ran, and a report nobody is waiting on must not be able to
  // make the pages somebody IS waiting on time out. Serially, 200 bounded aggregates are nothing.
  for (const run of runs) {
    // Counts-based (bounded GROUP BY) so the runs CSV never loads the 120k-row seed:scale outcomes
    // per run — same scale regression the /api/runs list fix addresses (this endpoint is on the
    // deploy smoke checklist).
    const s = toRunSummaryFromCounts(run, await outcomeStore.countOutcomesByStatus(run.id));
    const count = (status: string) => s.outcomeCounts.find((c) => c.status === status)?.count ?? 0;
    rows.push([
      s.runId, s.measureName, s.measureVersion, s.scopeType, s.triggerType, s.status, s.startedAt, s.completedAt,
      s.durationMs, s.totalEvaluated, s.compliantCount, count("DUE_SOON"), count("OVERDUE"), count("MISSING_DATA"),
      count("EXCLUDED"), s.passRate, s.dataFreshAsOf, s.notInPopulation,
    ]);
  }
  return toCsv(RUN_HEADERS, rows);
}

/**
 * The two subject columns, named by the deployment's own term (DATA_MODEL_CONTRACTS §6.2/§6.3).
 * Exported so a new export cannot grow a second copy that drifts — the attributed-list report uses it.
 */
export const subjectHeaders = (term: "employee" | "patient") => [`${term}ExternalId`, `${term}Name`] as const;
const outcomeDateHeader = DEPLOYMENT_PROFILE.subjectTerm === "patient" ? "lastResultDate" : "lastExamDate";
const outcomeExclusionHeader = DEPLOYMENT_PROFILE.subjectTerm === "patient" ? "exclusionStatus" : "waiverStatus";

// ---- outcomes (DATA_MODEL §6.2) ----------------------------------------------
const OUTCOME_HEADERS = [
  "outcomeId", "runId", ...subjectHeaders(DEPLOYMENT_PROFILE.subjectTerm), "role", "site", "measureName", "measureVersion",
  "evaluationPeriod", "status", outcomeDateHeader, "complianceWindowDays", "daysOverdue", "roleEligible", "siteEligible",
  outcomeExclusionHeader, "evaluatedAt",
  // APPENDED (MM-2), never inserted, so a consumer reading by position keeps every column it had.
  // The two panel facts the practice filters by; empty where the directory records none.
  "providerId", "payer",
] as const;

interface ExprResult {
  define: string;
  result: unknown;
}
const exprResults = (evidence: unknown): ExprResult[] => {
  const er = (evidence as { expressionResults?: unknown } | null)?.expressionResults;
  return Array.isArray(er) ? (er as ExprResult[]) : [];
};

/** why_flagged fields derived from the CQL defines (same derivation as case detail). */
function whyFlagged(evidence: unknown, measureId: string) {
  const ers = exprResults(evidence);
  // #650: empty for an official outcome, which has no single window (the column stays; §6.2 appends only).
  const official = hasNoSingleWindow(evidence, measureId);
  const window = MEASURE_BINDINGS[measureId]?.complianceWindowDays ?? 365;
  const recent = ers.find((r) => /^most recent .*date$/i.test(r.define));
  const hadExam = recent != null && recent.result != null;
  const daysDefine = ers.find((r) => /^days since/i.test(r.define));
  const days = hadExam && typeof daysDefine?.result === "number" ? daysDefine.result : null;
  const waiver = ers.find((r) => /waiver|exemption|exclusion/i.test(r.define));
  return {
    lastExamDate: hadExam && typeof recent!.result === "string" ? recent!.result.slice(0, 10) : null,
    complianceWindowDays: official ? null : window,
    daysOverdue: days !== null ? Math.max(days - window, 0) : null,
    waiverStatus: typeof waiver?.result === "boolean" ? (waiver.result ? "active" : "none") : "none",
  };
}

/**
 * Row filters for the outcomes export (DATA_MODEL_CONTRACTS §6.2). `site` and the three panel filters
 * are directory joins, applied in-app for the reason the cases export applies `site` in-app: the
 * directory is not in the database.
 */
export interface OutcomeExportFilter extends SubjectFilters {
  site?: string;
}

function matchesOutcomeFilters(
  subjectId: string,
  filters: OutcomeExportFilter,
  lookup: (externalId: string) => EmployeeProfile | null,
): boolean {
  const employee = lookup(subjectId);
  if (filters.site && (employee?.site ?? "").toLowerCase() !== filters.site.toLowerCase()) return false;
  return matchesSubjectFilters(employee, filters);
}

/** One outcome CSV row (shared by the string + streamed builders). */
function outcomeRowCells(
  o: { id: string; runId: string; subjectId: string; measureId: string; evaluationPeriod: string; status: string; evidence: unknown; evaluatedAt: string },
  employeeLookup = employeeById,
): unknown[] {
  const emp = employeeLookup(o.subjectId);
  const wf = whyFlagged(o.evidence, o.measureId);
  return [
    o.id, o.runId, o.subjectId, emp?.name ?? o.subjectId, emp?.role ?? "—", emp?.site ?? "—",
    measureName(o.measureId), measureVersionFor(o.measureId, o.evidence), o.evaluationPeriod, o.status,
    wf.lastExamDate, wf.complianceWindowDays, wf.daysOverdue, true, true, wf.waiverStatus, o.evaluatedAt,
    emp?.providerId ?? "", emp?.payer ?? "",
  ];
}

function directoryForProfileRows(
  rows: readonly { subjectId: string }[],
  webChartEnv?: DataSourceEnv,
) {
  return DEPLOYMENT_PROFILE.id === "default"
    ? DIRECTORY
    : directoryForRows(rows, isWebChartConfigured(webChartEnv ?? {}), webChartEnv, DIRECTORY);
}

async function latestVisibleOutcomeRunId(
  outcomeStore: OutcomeStore,
  runStore: RunStore,
  webChartEnv?: DataSourceEnv,
): Promise<string | undefined> {
  const runs = await runStore.listRuns(DEPLOYMENT_PROFILE.id === "default" ? 1 : 100000);
  if (DEPLOYMENT_PROFILE.id === "default") return runs[0]?.id;
  for (const run of runs) {
    let offset = 0;
    while (true) {
      const records = await outcomeStore.listOutcomes(run.id, { limit: OUTCOME_STREAM_PAGE, offset });
      const directory = directoryForProfileRows(records, webChartEnv);
      if (records.some((record) => profileSubjectMatcher(directory.employeeById)(record.subjectId))) return run.id;
      if (records.length < OUTCOME_STREAM_PAGE) break;
      offset += records.length;
    }
  }
  return undefined;
}

export async function outcomesCsv(
  outcomeStore: OutcomeStore,
  runStore: RunStore,
  runId?: string,
  webChartEnv?: DataSourceEnv,
  filters: OutcomeExportFilter = {},
): Promise<string> {
  // Java exportOutcomeCsv: an explicit runId, otherwise the LATEST run (not every run's
  // outcomes — that would mix historical duplicate employee rows). Export exactly one run.
  const resolvedRunId = runId ?? (await latestVisibleOutcomeRunId(outcomeStore, runStore, webChartEnv));
  const records = resolvedRunId ? await outcomeStore.listOutcomes(resolvedRunId) : [];
  const directory = directoryForProfileRows(records, webChartEnv);
  const profileMatch = profileSubjectMatcher(directory.employeeById);
  const out = records
    .filter((r) => profileMatch(r.subjectId))
    .filter((r) => matchesOutcomeFilters(r.subjectId, filters, directory.employeeById))
    .slice()
    .sort((a, b) => a.subjectId.localeCompare(b.subjectId)) // Java ORDER BY e.external_id ASC
    .map((r) => outcomeRowCells(r, directory.employeeById));
  return toCsv(OUTCOME_HEADERS, out);
}

/** Page size for the streamed outcomes export — the most rows held in memory at a time. */
const OUTCOME_STREAM_PAGE = 1000;

/**
 * Stream one run's outcomes as CSV, paged (Fable H4) — bounded memory regardless of run size, so a
 * `seed:scale` run's 120k rows never materialize at once (the un-paged {@link outcomesCsv} loaded them
 * all: ~43s to first byte live). Rows stream in the store's (evaluated_at, id) order rather than the
 * subject_id sort — a single run's outcomes share an evaluation time, so the difference is cosmetic and
 * every row is still present. The bytes match {@link toCsv}: header then `\r\n`-prefixed rows.
 */
export function outcomesCsvStream(
  outcomeStore: OutcomeStore,
  runStore: RunStore,
  runId?: string,
  webChartEnv?: DataSourceEnv,
  filters: OutcomeExportFilter = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let resolvedRunId: string | null | undefined;
  let offset = 0;
  let wroteHeader = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!wroteHeader) {
        controller.enqueue(encoder.encode(OUTCOME_HEADERS.join(",")));
        wroteHeader = true;
        resolvedRunId = runId ?? (await latestVisibleOutcomeRunId(outcomeStore, runStore, webChartEnv));
        if (!resolvedRunId) {
          controller.close();
          return;
        }
      }
      const records = await outcomeStore.listOutcomes(resolvedRunId!, { limit: OUTCOME_STREAM_PAGE, offset });
      if (records.length === 0) {
        controller.close();
        return;
      }
      offset += records.length;
      const directory = directoryForProfileRows(records, webChartEnv);
      const profileMatch = profileSubjectMatcher(directory.employeeById);
      // The SAME filter the un-streamed builder applies. These two produce the same document by
      // different routes, so a filter added to one and not the other means `?format=csv` and the
      // streamed export of the same run disagree — and only the large one is streamed, so the
      // disagreement would only ever appear on the exports that matter.
      const matching = records
        .filter((o) => profileMatch(o.subjectId))
        .filter((o) => matchesOutcomeFilters(o.subjectId, filters, directory.employeeById));
      const chunk = matching.map((o) => "\r\n" + outcomeRowCells(o, directory.employeeById).map(csvCell).join(",")).join("");
      if (chunk) controller.enqueue(encoder.encode(chunk));
      if (records.length < OUTCOME_STREAM_PAGE) controller.close();
    },
  });
}

// ---- cases (DATA_MODEL §6.3) -------------------------------------------------
const CASE_HEADERS = [
  "caseId", ...subjectHeaders(DEPLOYMENT_PROFILE.subjectTerm), "role", "site", "measureName", "measureVersion", "evaluationPeriod",
  "status", "priority", "assignee", "currentOutcomeStatus", "nextAction", "lastRunId", "createdAt", "updatedAt",
  "closedAt", "latestOutreachDeliveryStatus",
  // APPENDED (MM-2), same rule as §6.2 above.
  "providerId", "payer",
  // APPENDED (#569, ADR-083): who closed the case, and — for the rows a PERSON closed, whose
  // `currentOutcomeStatus` is frozen at closure — what the winning run says today. Empty on every
  // other row, where `currentOutcomeStatus` is already the live answer.
  //
  // `liveState` is the RECONCILIATION column and the reason the bucket alone is not enough: a
  // consumer deriving "still a gap" from `liveOutcomeStatus` would apply `dispositionFor` and count
  // an out-of-population row (canonical MISSING_DATA) as a gap, which is exactly what the programs
  // chip, the staff-closed tab and the roster all do NOT do. This column is what those surfaces use.
  "closedReason", "closedBy", "liveState", "liveOutcomeStatus", "liveOutcomeRunId",
] as const;

export interface CaseExportFilter extends CaseQuery, SubjectFilters {
  /** Explicit case ids (the worklist's bulk-export of a selected set) — comma list in the route. */
  caseIds?: string[];
  /** Employee site (resolved from the directory, not stored on the case). */
  site?: string;
  /**
   * Free text over subject name / measure name / subject id — a directory join, like `site`, which
   * is why it is here rather than on `CaseQuery`. Applied with the work list's own predicate.
   */
  search?: string;
  /**
   * Restrict to each measure's CURRENT compliance cycle, the way the work list's open and
   * staff-closed lists do (#603). Decided by `wantsCurrentCycle` at the route, with this endpoint's
   * blank meaning `all` — so absent keeps the documented all-history behaviour (§6.3) byte for byte.
   *
   * A BOOLEAN rather than the raw token, because `CaseQuery.period` means "this literal evaluation
   * period" and a per-MEASURE cycle has no single value to put there. It would also be harmless to
   * forward the token — both stores treat `"all"` and `"current"` as no-ops and say so — and the first
   * cut of this comment wrongly claimed it would filter `evaluation_period = 'current'` (review).
   */
  currentCycleOnly?: boolean;
}

export async function casesCsv(
  caseStore: CaseStore,
  eventStore: CaseEventStore,
  filter: CaseExportFilter,
  webChartEnv?: DataSourceEnv,
  /** Where the two live columns come from (#569); without it they are empty and the row says so by being empty. */
  liveDeps?: LiveCellDeps,
): Promise<string> {
  // **`outcome` is withheld from the STORE on the staff-closed list, and only there** (2026-09-20).
  //
  // The store compares `current_outcome_status`, which froze when the person closed the case (§4).
  // For every other row that column IS live — the run refreshes an active row and wrote a
  // system-closed one — so the SQL predicate is right and stays. On the staff-closed list the screen
  // filters on what CQL says TODAY (`worklist-read-model.ts`, the comment beside its own outcome
  // filter), so applying the token in SQL here put a row labelled Compliant in the file under an
  // Overdue filter and dropped the row the screen showed — a file disagreeing with the list it was
  // taken from, which is the defect this whole export change exists to close.
  const staffClosedList = filter.closure === "staff";
  let cases = await caseStore.listCases({
    ...filter,
    outcome: staffClosedList ? undefined : filter.outcome,
    // **The same unbounded read the work list takes, and it has to be the same number.**
    //
    // `site`, `search` and a large panel selection are directory joins applied AFTER this read
    // (there is no patients table to join — ADR-075), so a cap here truncates the candidate set
    // before the predicate that decides which rows the caller asked for. This said `100000` while
    // `loadWorklistCases` reads `Number.MAX_SAFE_INTEGER` for exactly these filters: above the cap a
    // searched subject the screen shows would be silently missing from the file taken off that
    // screen — possibly a header-only CSV — which is this export's own defect class at a scale the
    // pilot (32,558 cases) has not reached. The cap protected nothing the list is not already
    // exposed to at the same scale on the same table, and a magic number that only bites once the
    // deployment grows is worse than no number: it fails quietly, later, on somebody else's watch.
    limit: Number.MAX_SAFE_INTEGER,
  });
  const directory = directoryForProfileRows(cases.map((c) => ({ subjectId: c.employeeId })), webChartEnv);
  const profileMatch = profileSubjectMatcher(directory.employeeById);
  cases = cases.filter((c) => profileMatch(c.employeeId));
  // Each measure's CURRENT compliance cycle, by today and its own cadence — the same post-filter the
  // work list applies, in the same position in the chain, and only when the route asked for it
  // (`wantsCurrentCycle`, blank meaning `all` here). Not expressible as a store predicate: the period
  // is per MEASURE, so there is no one value to compare a column against.
  if (filter.currentCycleOnly) {
    const today = new Date().toISOString().slice(0, 10);
    cases = cases.filter((c) => c.evaluationPeriod === bucketPeriodForMeasure(c.measureId, today));
  }
  // caseIds + site aren't SQL-filterable here (site lives in the directory), so apply them in-app.
  if (filter.caseIds?.length) {
    const wanted = new Set(filter.caseIds);
    cases = cases.filter((c) => wanted.has(c.id));
  }
  if (filter.site) {
    // `siteMatches`, shared with the work list (#603) — it compared exactly and this compared
    // case-insensitively, so a directory holding two sites differing only in case would export both
    // under a heading naming one.
    // `?? "—"` is not cosmetic: the work list compares `CaseSummary.site`, which is
    // `emp?.site ?? "—"`, and `—` is a SELECTABLE option in the filter (the control's options are the
    // loaded rows' own site strings). A subject the directory does not hold is therefore visible on
    // screen under Site = — while this comparison saw `""` and matched nothing — a header-only CSV
    // taken off a screen with rows on it, which is this export's own defect class (review of #611).
    cases = cases.filter((c) => siteMatches(directory.employeeById(c.employeeId)?.site ?? "—", filter.site!));
  }
  // `search` is a directory join like `site`, so it lands here rather than in SQL — and it uses the
  // work list's own predicate (`matchesCaseSearch`) over the same three fields, because this export
  // is taken FROM that list. A second three-field list here would drift the first time either was
  // touched, and the drift would show up as a file that disagrees with the screen it came from.
  if (filter.search) {
    const needle = filter.search.toLowerCase();
    cases = cases.filter((c) =>
      matchesCaseSearch(needle, {
        employeeName: directory.employeeById(c.employeeId)?.name ?? c.employeeId,
        measureName: measureName(c.measureId),
        employeeId: c.employeeId,
      }),
    );
  }
  if (hasActiveSubjectFilters(filter)) {
    cases = cases.filter((c) => matchesSubjectFilters(directory.employeeById(c.employeeId), filter));
  }
  // What the winning run says today, for the rows a PERSON closed (#569) — the only rows whose
  // `currentOutcomeStatus` can be stale, and a set bounded by human activity. Bounded point reads
  // through `liveCellsFor`; never a run read.
  const staffClosed = cases.filter((c) => closureKindOf(c) === "STAFF");
  const live = liveDeps && staffClosed.length > 0
    ? await liveCellsFor(liveDeps, staffClosed.map((c) => ({ subjectId: c.employeeId, measureId: c.measureId })))
    : null;
  // The withheld `outcome`, applied to what the SCREEN shows — through the work list's own rule
  // (`liveOrFrozenStatus`), so the two cannot answer differently. It runs BEFORE the outreach batch
  // so that read is over the surviving rows, and it costs nothing extra: these rows were resolved
  // above for the `live*` columns regardless.
  if (staffClosedList && filter.outcome) {
    const wantOutcome = filter.outcome.toUpperCase();
    cases = cases.filter((c) => {
      const f = live && closureKindOf(c) === "STAFF" ? liveFieldsFor(liveAnswerForCase(live, c)) : null;
      return shownStatusFor(c.currentOutcomeStatus, f).toUpperCase() === wantOutcome;
    });
  }
  // ONE lookup for the whole export, not one per case. The per-case form fired a query per row
  // through `Promise.all` — ~15,300 of them on the pilot, against a ten-connection pool — which
  // answered 504 at 60 s and held every connection while it did, so the deployment's other pages
  // timed out for the minute it ran (measured 2026-09-13).
  const deliveryStatuses = await eventStore.latestOutreachDeliveryStatuses(cases.map((c) => c.id));
  const rows = cases.map((c) => {
    const emp = directory.employeeById(c.employeeId);
    // Absent key ⇒ no outreach action ⇒ null, the same cell the per-case call wrote.
    const latest = deliveryStatuses[c.id] ?? null;
    // This export applies no period filter by DEFAULT (§6.3; `?period=current` narrows it since #603), so it carries more
    // prior-cycle closures than any other surface, and the cycle equality in `liveAnswerForCase` is
    // what keeps a 2024 closure from being exported under the 2026 winner's answer. Without it the
    // row states a `liveState`, a status and a run id that describe a different measurement year.
    const fields = live && closureKindOf(c) === "STAFF" ? liveFieldsFor(liveAnswerForCase(live, c)) : undefined;
    // UNKNOWN is written as the word, not as an empty cell: an empty cell means "not a staff closure".
    const liveStatus = fields ? (fields.outcomeStatus ?? "UNKNOWN") : "";
    const liveState = fields ? fields.state : "";
    return [
      c.id, c.employeeId, emp?.name ?? c.employeeId, emp?.role ?? "—", emp?.site ?? "—",
      // A case row carries no evidence, so this is the AUTHORED version even for a routed measure.
      // Stated rather than silently wrong: the case CSV is an operational worklist keyed on
      // `lastRunId`, and the outcomes CSV is the one that answers "what computed this" per row.
      measureName(c.measureId), authoredVersion(c.measureId), c.evaluationPeriod, c.status, c.priority, c.assignee,
      c.currentOutcomeStatus, c.nextAction, c.lastRunId, c.createdAt, c.updatedAt, c.closedAt, latest,
      emp?.providerId ?? "", emp?.payer ?? "",
      c.closedReason ?? "", c.closedBy ?? "", liveState, liveStatus, fields?.runId ?? "",
    ];
  });
  return toCsv(CASE_HEADERS, rows);
}

// ---- audit (Java AuditExportService header) ---------------------------------
const AUDIT_HEADERS = ["timestamp", "eventType", "caseId", "runId", "measureName", `${subjectNoun(DEPLOYMENT_PROFILE).singular}Id`, "actor", "detail"] as const;

type AuditEvent = Awaited<ReturnType<CaseEventStore["listAuditEvents"]>>[number];

/**
 * Resolve the employee id per referenced case for a page of events. Java derives the employee via the
 * referenced case (COALESCE(case.employee_id, outcome.employee_id)); case audit payloads (assign/
 * escalate/outreach) don't carry subjectId, so resolve it from the case.
 */
async function resolveCaseEmployees(events: AuditEvent[], caseStore: CaseStore): Promise<Map<string, string>> {
  const caseEmployee = new Map<string, string>();
  for (const id of new Set(events.map((e) => e.refCaseId).filter((x): x is string => !!x))) {
    const c = await caseStore.getCase(id);
    if (c) caseEmployee.set(id, c.employeeId);
  }
  return caseEmployee;
}

/** One audit CSV row (cell array) for an event, given its page's resolved case→employee map. */
function auditRowCells(e: AuditEvent, caseEmployee: Map<string, string>): unknown[] {
  const employeeId =
    (e.payload.subjectId as string | undefined) ??
    (e.payload.employeeId as string | undefined) ??
    (e.refCaseId ? caseEmployee.get(e.refCaseId) : undefined) ??
    "";
  const name = e.refMeasureVersionId ? measureName(e.refMeasureVersionId.replace(/-v[\d.]+$/, "")) : "";
  return [e.occurredAt, e.eventType, e.refCaseId, e.refRunId, name, employeeId, e.actor, JSON.stringify(e.payload)];
}

export async function auditCsv(eventStore: CaseEventStore, caseStore: CaseStore): Promise<string> {
  const events = await eventStore.listAuditEvents();
  const caseEmployee = await resolveCaseEmployees(events, caseStore);
  return toCsv(AUDIT_HEADERS, events.map((e) => auditRowCells(e, caseEmployee)));
}

/** Page size for the streamed audit export — one page is the most rows held in memory at a time. */
const AUDIT_STREAM_PAGE = 1000;

/**
 * Stream the full audit ledger as CSV (#150 M9 — parity with the Java StreamingResponseBody export):
 * page the ledger so the export never materializes the whole table (or one giant string) at once. The
 * bytes are identical to {@link auditCsv} — header then `\r\n`-prefixed rows, matching `toCsv`'s join.
 */
export function auditCsvStream(eventStore: CaseEventStore, caseStore: CaseStore): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let offset = 0;
  let wroteHeader = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!wroteHeader) {
        controller.enqueue(encoder.encode(AUDIT_HEADERS.join(",")));
        wroteHeader = true;
      }
      const events = await eventStore.listAuditEvents(AUDIT_STREAM_PAGE, offset);
      if (events.length === 0) {
        controller.close();
        return;
      }
      offset += events.length;
      const caseEmployee = await resolveCaseEmployees(events, caseStore);
      // Each row is CRLF-prefixed so the concatenation equals toCsv's `[header, ...rows].join("\r\n")`.
      const chunk = events.map((e) => "\r\n" + auditRowCells(e, caseEmployee).map(csvCell).join(",")).join("");
      controller.enqueue(encoder.encode(chunk));
      if (events.length < AUDIT_STREAM_PAGE) controller.close();
    },
  });
}
