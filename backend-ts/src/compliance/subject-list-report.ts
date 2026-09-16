/**
 * The attributed list's measurement-year report (MM-2 PR 3, ADR-082).
 *
 * The ACO asked for numerator, denominator and exclusions over the patients they attribute to the
 * group, with the patient-level result and its date. This computes it from the SAME evidence every
 * other rate on this deployment comes from — `createRateAggregator` over the outcomes' persisted
 * population memberships — fed only the rows whose subject is in the list.
 *
 * Four design points that are not obvious, each of which was a way to be quietly wrong:
 *
 * 1. **The report is FOR A MEASUREMENT YEAR, never "the latest numbers now."** An officially routed
 *    run is scored over the calendar year containing its evaluation date (ADR-072), so in January
 *    2028 the newest run is a PY2028 one and "the latest" would silently answer a PY2027 question
 *    with next year's partial data. `measurementYear` is required, and the run selected per measure
 *    is the newest reportable whole-population run whose own period is that year.
 *
 * 2. **Compaction is checked PER MEASURE, before and after the reads.** ADR-077 refuses a report
 *    built over rows that may be incomplete, and the refusal belongs to the measure whose run is
 *    exposed — the other five measures' numbers are complete and withholding them would be a second
 *    wrong answer. The whole request is 409 only when every selected run is exposed.
 *
 * 3. **`missingFromRun` is reported BESIDE the rates, never subtracted from them.** A member the run
 *    never evaluated is a gap in the evidence, not an exclusion, and folding them into a denominator
 *    would let a smaller run raise the score. The counts reconcile:
 *    `matchedSubjects = distinctSubjectsSeen + missingFromRun`, and
 *    `distinctSubjectsSeen = scoredSubjects + unmeasured + evaluationErrors + outOfPopulation`.
 *
 * 4. **Every derived row is computed before anything is serialised.** A streamed CSV cannot change
 *    its status after the first byte, so a compaction intent landing between page reads would yield a
 *    truncated 200. Only the derived per-member fields are held — never the evidence blob — which the
 *    50,000-member cap bounds at a few tens of megabytes.
 *
 * The score is `numer / (denom − denex − denexcep)`, which is what `createRateAggregator` already
 * computes and what the eCQM proportion-measure convention specifies. `status=EXCLUDED` is the
 * WORKFLOW vocabulary; `denominatorExclusion` and `denominatorException` are the artifact's
 * populations. The ACO's word "exclusions" covers both, so both are reported separately.
 */
import type { OutcomeStore, OutcomeRecord } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { SubjectListStore, SubjectList } from "../stores/subject-list-store.ts";
import { createRateAggregator, officialReportIdentity, reportingPeriod } from "../fhir/measure-report.ts";
import { isEvaluationErrorEvidence } from "../fhir/measure-report.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { isPopulationRun } from "../program/rollup-shared.ts";
import { isReportableRunStatus } from "../run/reportable.ts";
import { compactionExposure } from "../run/compaction-evidence.ts";
import type { MeasureRateGroup } from "../program/measure-rate.ts";

/** One page of outcome rows per read. Matches `fhir/run-aggregate.ts`'s page so the two agree. */
const PAGE = 2000;
/** How many recent population runs per measure are examined for one whose period is the asked-for year. */
const RUN_CANDIDATES = 12;

export interface SubjectListReportDeps {
  lists: SubjectListStore;
  outcomes: OutcomeStore;
  runs: RunStore;
  events: Pick<CaseEventStore, "recentAuditEventsByType">;
}

/** One list member's per-measure result, and the two non-evaluated states a member can be in. */
export type ReportRowStatus = "EVALUATED" | "MISSING_FROM_RUN" | "NOT_MATCHED";

export interface ReportRow {
  rawIdentifier: string;
  subjectId: string | null;
  resolution: string;
  rowStatus: ReportRowStatus;
  measureId: string | null;
  /** Null for a NOT_MATCHED row and for a member the run never evaluated. */
  outcome: Pick<OutcomeRecord, "status" | "evaluatedAt" | "outOfPopulation"> | null;
  /** One entry per rate the measure declares; empty where nothing was evaluated. */
  rates: ReportRowRate[];
  evaluationError: boolean;
}

export interface ReportRowRate {
  label: string | null;
  ipp: boolean;
  denom: boolean;
  denex: boolean;
  denexcep: boolean;
  numer: boolean;
}

export interface MeasureReportEntry {
  measureId: string;
  ecqmId: string | null;
  version: string | null;
  runId: string | null;
  runStartedAt: string | null;
  measurementPeriod: { start: string; end: string } | null;
  /** "complete" | "compacted" | "no_run" — why a measure has no numbers, when it has none. */
  compactionStatus: "complete" | "compacted" | "no_run";
  reason?: string;
  matchedSubjects: number;
  distinctSubjectsSeen: number;
  missingFromRun: number;
  scoredSubjects: number;
  unmeasured: number;
  evaluationErrors: number;
  outOfPopulation: number;
  duplicateRowsCollapsed: number;
  rates: MeasureRateGroup[];
}

export interface SubjectListReport {
  list: SubjectList;
  measurementYear: number;
  generatedAt: string;
  members: { matched: number; notFound: number; ambiguous: number; total: number };
  compaction: { cutoff: string | null };
  /** Measures whose selected run is compaction-exposed; their entries carry no rates and no rows. */
  compactedMeasures: string[];
  measures: MeasureReportEntry[];
  rows: ReportRow[];
}

export type ReportResult =
  | { ok: true; report: SubjectListReport }
  | { ok: false; status: 404 | 409; body: Record<string, unknown> };

/**
 * Build the report, or say why not.
 *
 * `measureIds` is the caller's runnable ∩ official-routed set: an authored measure has status-derived
 * membership rather than populations, so there is no numerator to report for one.
 */
export async function subjectListReport(
  deps: SubjectListReportDeps,
  listId: string,
  measurementYear: number,
  measureIds: readonly string[],
  now: () => string = () => new Date().toISOString(),
): Promise<ReportResult> {
  const list = await deps.lists.getList(listId);
  if (!list) return { ok: false, status: 404, body: { error: "not_found", parameter: "listId", listId } };

  const counts = (await deps.lists.countMembers([listId])).get(listId) ?? {
    MATCHED: 0,
    NOT_FOUND: 0,
    AMBIGUOUS: 0,
  };
  const matchedIds = new Set(await deps.lists.matchedSubjectIds(listId));

  const entries: MeasureReportEntry[] = [];
  const rows: ReportRow[] = [];
  const compactedMeasures: string[] = [];
  let furthestCutoff: string | null = null;
  let measuresWithARun = 0;

  for (const measureId of measureIds) {
    const winner = await selectRunForYear(deps, measureId, measurementYear);
    if (!winner) {
      entries.push(emptyEntry(measureId, matchedIds.size, "no_run", `no_completed_population_run_for_year`));
      continue;
    }
    measuresWithARun += 1;

    // BEFORE the reads: a run already known to be exposed is never paged at all.
    const before = await compactionExposure({ startedAt: winner.startedAt }, deps.events);
    if (before.cutoff) furthestCutoff = maxIso(furthestCutoff, before.cutoff);
    if (before.exposed) {
      compactedMeasures.push(measureId);
      entries.push(emptyEntry(measureId, matchedIds.size, "compacted", "run_compacted"));
      continue;
    }

    const read = await readMeasure(deps, winner.runId, measureId, matchedIds, measurementYear);
    if (read.periodMismatch) {
      // A run that MIXES measurement periods cannot be reported as one year's numbers, and picking
      // either would be a silent choice. ADR-072 says the outcome-level period is the only place that
      // states which year an official outcome describes, so a contradiction is fatal rather than folded.
      return {
        ok: false,
        status: 409,
        body: {
          error: "period_mismatch",
          measureId,
          runId: winner.runId,
          measurementYear,
          message: "the selected run carries outcomes from a different measurement period",
        },
      };
    }

    // AFTER the reads, as `routes/runs.ts` does: a compaction pass that began WHILE this report was
    // paging would otherwise have deleted rows the earlier pages already counted.
    const after = await compactionExposure({ startedAt: winner.startedAt }, deps.events);
    if (after.cutoff) furthestCutoff = maxIso(furthestCutoff, after.cutoff);
    if (after.exposed) {
      compactedMeasures.push(measureId);
      entries.push(emptyEntry(measureId, matchedIds.size, "compacted", "run_compacted"));
      continue;
    }

    entries.push({
      measureId,
      ecqmId: read.identity?.ecqmId ?? null,
      version: read.identity?.version ?? null,
      runId: winner.runId,
      runStartedAt: winner.startedAt,
      measurementPeriod: reportingPeriod(winner, read.identity ?? null),
      compactionStatus: "complete",
      matchedSubjects: matchedIds.size,
      distinctSubjectsSeen: read.seen.size,
      missingFromRun: matchedIds.size - read.seen.size,
      scoredSubjects: read.seen.size - read.aggregate.unmeasured - read.outOfPopulation,
      unmeasured: read.aggregate.unmeasured,
      evaluationErrors: read.aggregate.evaluationErrors,
      outOfPopulation: read.outOfPopulation,
      duplicateRowsCollapsed: read.duplicateRowsCollapsed,
      rates: toRateGroups(read.aggregate, measureId),
    });
    rows.push(...read.rows);
    // One row per (measure) for a matched member the run never evaluated — filled patient columns,
    // empty population columns. Never `0` or `false`, which would read as a scored result.
    for (const subjectId of matchedIds) {
      if (read.seen.has(subjectId)) continue;
      rows.push({
        rawIdentifier: subjectId,
        subjectId,
        resolution: "MATCHED",
        rowStatus: "MISSING_FROM_RUN",
        measureId,
        outcome: null,
        rates: [],
        evaluationError: false,
      });
    }
  }

  // The whole request is refused only when EVERY measure that had a run is compacted. Withholding five
  // complete measures because the sixth's run aged out would be a second wrong answer.
  if (measuresWithARun > 0 && compactedMeasures.length === measuresWithARun) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "run_compacted",
        measurementYear,
        compactedMeasures,
        cutoff: furthestCutoff,
        message:
          "every measure's run for this year predates a compaction cutoff; a score computed over a keep set is a different number wearing the run's identity",
      },
    };
  }

  // Each NOT_MATCHED member appears EXACTLY ONCE, after every evaluated row — never once per measure,
  // which would multiply an unresolved identifier by six and read as six failures.
  const unmatched = await allUnmatchedMembers(deps, listId);
  rows.push(...unmatched);

  return {
    ok: true,
    report: {
      list,
      measurementYear,
      generatedAt: now(),
      members: {
        matched: counts.MATCHED,
        notFound: counts.NOT_FOUND,
        ambiguous: counts.AMBIGUOUS,
        total: counts.MATCHED + counts.NOT_FOUND + counts.AMBIGUOUS,
      },
      compaction: { cutoff: furthestCutoff },
      compactedMeasures,
      measures: entries,
      rows,
    },
  };
}

const maxIso = (a: string | null, b: string): string =>
  a === null || Date.parse(b) > Date.parse(a) ? b : a;

const emptyEntry = (
  measureId: string,
  matchedSubjects: number,
  compactionStatus: MeasureReportEntry["compactionStatus"],
  reason: string,
): MeasureReportEntry => ({
  measureId,
  ecqmId: null,
  version: null,
  runId: null,
  runStartedAt: null,
  measurementPeriod: null,
  compactionStatus,
  reason,
  matchedSubjects,
  distinctSubjectsSeen: 0,
  missingFromRun: 0,
  scoredSubjects: 0,
  unmeasured: 0,
  evaluationErrors: 0,
  outOfPopulation: 0,
  duplicateRowsCollapsed: 0,
  rates: [],
});

/**
 * The newest reportable whole-population run for this measure whose own measurement period is the
 * asked-for calendar year.
 *
 * Walks the recent population runs (the winners' own lean probe) and reads each candidate's row for
 * its period. In January 2028 the newest run is a PY2028 one, so "the latest" would answer a PY2027
 * question with next year's partial data; this walks past it.
 */
async function selectRunForYear(
  deps: SubjectListReportDeps,
  measureId: string,
  measurementYear: number,
): Promise<{ runId: string; startedAt: string; measurementPeriodStart: string; measurementPeriodEnd: string } | null> {
  const candidates = await deps.outcomes.listLatestPopulationRuns(
    [measureId],
    { excludeScale: true, excludeTrendHistory: true },
    RUN_CANDIDATES,
  );
  for (const candidate of candidates) {
    if (!isReportableRunStatus(candidate.runStatus)) continue;
    if (!isPopulationRun(candidate.runScopeType)) continue;
    const run = await deps.runs.getRun(candidate.runId);
    if (!run) continue;
    if (new Date(run.measurementPeriodStart).getUTCFullYear() !== measurementYear) continue;
    return {
      runId: candidate.runId,
      startedAt: candidate.runStartedAt,
      measurementPeriodStart: run.measurementPeriodStart,
      measurementPeriodEnd: run.measurementPeriodEnd,
    };
  }
  return null;
}

interface MeasureRead {
  aggregate: ReturnType<ReturnType<typeof createRateAggregator>["finish"]>;
  identity: ReturnType<typeof officialReportIdentity>;
  seen: Set<string>;
  rows: ReportRow[];
  outOfPopulation: number;
  duplicateRowsCollapsed: number;
  periodMismatch: boolean;
}

/** Page a run's outcomes for one measure, keeping only the list's members. */
async function readMeasure(
  deps: SubjectListReportDeps,
  runId: string,
  measureId: string,
  matchedIds: ReadonlySet<string>,
  measurementYear: number,
): Promise<MeasureRead> {
  // Newest (evaluatedAt, id) per subject wins, deterministically — a run can hold more than one row
  // for a subject, and "whichever came back first" would make the report depend on page ordering.
  const newest = new Map<string, OutcomeRecord>();
  let duplicateRowsCollapsed = 0;
  let periodMismatch = false;
  for (let offset = 0; ; offset += PAGE) {
    const page = await deps.outcomes.listOutcomes(runId, { measureId, limit: PAGE, offset });
    if (page.length === 0) break;
    for (const row of page) {
      if (!matchedIds.has(row.subjectId)) continue;
      const identity = officialReportIdentity(row.evidence);
      const period = identity?.measurementPeriod;
      if (period && new Date(period.start).getUTCFullYear() !== measurementYear) periodMismatch = true;
      const held = newest.get(row.subjectId);
      if (!held) {
        newest.set(row.subjectId, row);
        continue;
      }
      duplicateRowsCollapsed += 1;
      const key = (r: OutcomeRecord) => `${r.evaluatedAt}|${r.id}`;
      if (key(row) > key(held)) newest.set(row.subjectId, row);
    }
    if (page.length < PAGE) break;
  }

  const aggregator = createRateAggregator(measureId);
  const rows: ReportRow[] = [];
  let identity: ReturnType<typeof officialReportIdentity> = null;
  let outOfPopulation = 0;
  const labels = officialMeasureSemantics(measureId)?.rateLabels;
  for (const row of newest.values()) {
    aggregator.add(row);
    identity ??= officialReportIdentity(row.evidence);
    if (row.outOfPopulation) outOfPopulation += 1;
    const errored = isEvaluationErrorEvidence(row.evidence);
    rows.push({
      rawIdentifier: row.subjectId,
      subjectId: row.subjectId,
      resolution: "MATCHED",
      rowStatus: "EVALUATED",
      measureId,
      outcome: { status: row.status, evaluatedAt: row.evaluatedAt, outOfPopulation: row.outOfPopulation },
      rates: errored ? [] : membershipsOf(row, measureId, labels),
      evaluationError: errored,
    });
  }
  return {
    aggregate: aggregator.finish(),
    identity,
    seen: new Set(newest.keys()),
    rows,
    outOfPopulation,
    duplicateRowsCollapsed,
    periodMismatch,
  };
}

function membershipsOf(
  row: OutcomeRecord,
  measureId: string,
  labels: readonly string[] | undefined,
): ReportRowRate[] {
  // Reuses the aggregator's own reader so a row's per-rate flags and the group totals cannot disagree.
  const single = createRateAggregator(measureId);
  single.add(row);
  const finished = single.finish();
  return finished.rates.map((counts, index) => ({
    label: labels?.[index] ?? null,
    ipp: counts.ipp > 0,
    denom: counts.denom > 0,
    denex: counts.denex > 0,
    denexcep: counts.denexcep > 0,
    numer: counts.numer > 0,
  }));
}

function toRateGroups(
  aggregate: ReturnType<ReturnType<typeof createRateAggregator>["finish"]>,
  measureId: string,
): MeasureRateGroup[] {
  const labels = officialMeasureSemantics(measureId)?.rateLabels;
  return aggregate.rates.map((c, index) => {
    const effectiveDenominator = c.denom - c.denex - c.denexcep;
    return {
      label: labels?.[index] ?? null,
      ipp: c.ipp,
      denom: c.denom,
      denex: c.denex,
      denexcep: c.denexcep,
      numer: c.numer,
      effectiveDenominator,
      score: effectiveDenominator > 0 ? c.numer / effectiveDenominator : null,
    };
  });
}

/** Every NOT_FOUND / AMBIGUOUS member, paged out of the store, as one row each. */
async function allUnmatchedMembers(deps: SubjectListReportDeps, listId: string): Promise<ReportRow[]> {
  const out: ReportRow[] = [];
  for (const resolution of ["NOT_FOUND", "AMBIGUOUS"] as const) {
    for (let offset = 0; ; offset += PAGE) {
      const page = await deps.lists.listMembers(listId, { resolution, limit: PAGE, offset });
      for (const member of page.members) {
        out.push({
          rawIdentifier: member.rawIdentifier,
          subjectId: null,
          resolution,
          rowStatus: "NOT_MATCHED",
          measureId: null,
          outcome: null,
          rates: [],
          evaluationError: false,
        });
      }
      if (page.members.length < PAGE) break;
    }
  }
  return out;
}
