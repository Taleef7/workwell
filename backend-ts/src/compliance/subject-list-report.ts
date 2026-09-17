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
 *    would let a smaller run raise the score.
 *
 *    The counts reconcile, and the four not-scored buckets are DISJOINT by construction here rather
 *    than by assumption. `createRateAggregator`'s own `unmeasured` is a SUPERSET of its
 *    `evaluationErrors` (`measure-report.ts` starts the count at the error count), and
 *    `outcomes.out_of_population` is an independently persisted column that can be true on a row the
 *    aggregator also calls unmeasured — so subtracting the aggregate's three numbers from the subject
 *    count double-counted errors and could go NEGATIVE. Each row is classified into exactly one
 *    bucket, in a stated order, and the identities hold for every input:
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
import { createRateAggregator, membershipRatesFor, officialReportIdentity, reportingPeriod } from "../fhir/measure-report.ts";
import { isEvaluationErrorEvidence } from "../fhir/measure-report.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { isPopulationRun } from "../program/rollup-shared.ts";
import { isReportableRunStatus } from "../run/reportable.ts";
import { compactionExposure } from "../run/compaction-evidence.ts";
import type { MeasureRateGroup } from "../program/measure-rate.ts";

/** One page of outcome rows per read. Matches `fhir/run-aggregate.ts`'s page so the two agree. */
const PAGE = 2000;
/**
 * How many runs OF THE MEASUREMENT YEAR are examined for one that holds this measure's rows.
 *
 * Fifty is generous because the read is already period-scoped: these are the year's own runs,
 * newest-first, and an ALL_PROGRAMS run holds every routed measure, so the first is almost always the
 * answer. The count matters only for a measure routed partway through a year.
 */
const RUN_CANDIDATES = 50;

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
  // subject id -> the identifier the ACO's file carried. Equal today (matching is exact `externalId`)
  // and the whole point of the `rawIdentifier` column the moment it is not.
  const rawBySubject = await rawIdentifiersBySubject(deps, listId);
  const rawIdentifierOf = (subjectId: string): string => rawBySubject.get(subjectId) ?? subjectId;

  const entries: MeasureReportEntry[] = [];
  const rows: ReportRow[] = [];
  const compactedMeasures: string[] = [];
  let furthestCutoff: string | null = null;
  let measuresWithARun = 0;

  for (const measureId of measureIds) {
    const winner = await selectRunForYear(deps, measureId, measurementYear);
    if (!winner) {
      entries.push(emptyEntry(measureId, matchedIds.size, "no_run", `no_completed_population_run_for_year`));
      // The rows go out too. The CSV serialises `rows` alone, so without them the summary would claim
      // N patients were missing from a measure while the patient-level artifact named none of them —
      // and DATA_MODEL_CONTRACTS §6.6 says every JSON count is recomputable from the rows. A measure
      // with no usable run saw nobody, so every matched member is missing from it, and the ACO needs
      // the list of who.
      for (const subjectId of matchedIds) {
        rows.push({
          rawIdentifier: rawIdentifierOf(subjectId),
          subjectId,
          resolution: "MATCHED",
          rowStatus: "MISSING_FROM_RUN",
          measureId,
          outcome: null,
          rates: [],
          evaluationError: false,
        });
      }
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

    const read = await readMeasure(deps, winner.runId, measureId, matchedIds, measurementYear, rawIdentifierOf);
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
      // The four DISJOINT buckets, counted per row rather than derived by subtraction — see the
      // header. `unmeasured` here means "in no rate for a reason other than an error or being out of
      // population", which is narrower than the aggregator's own `unmeasured` and is what makes the
      // stated identity hold.
      scoredSubjects: read.buckets.scored,
      unmeasured: read.buckets.unmeasured,
      evaluationErrors: read.buckets.evaluationErrors,
      outOfPopulation: read.buckets.outOfPopulation,
      duplicateRowsCollapsed: read.duplicateRowsCollapsed,
      rates: toRateGroups(read.aggregate, measureId),
    });
    rows.push(...read.rows);
    // One row per (measure) for a matched member the run never evaluated — filled patient columns,
    // empty population columns. Never `0` or `false`, which would read as a scored result.
    for (const subjectId of matchedIds) {
      if (read.seen.has(subjectId)) continue;
      rows.push({
        rawIdentifier: rawIdentifierOf(subjectId),
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
  // A measure with NO RUN saw nobody, so every matched member is missing from it — and the rows are
  // emitted to match, so the count is reconstructable from the CSV.
  //
  // A COMPACTED measure claims NOTHING per subject. ADR-077 refuses numbers built over rows that may
  // be incomplete, and "how many of your patients did this measure miss?" is such a number; emitting
  // `missingFromRun = N` with no rows would assert a per-subject fact from evidence we have just said
  // we cannot read. DATA_MODEL_CONTRACTS §6.6 scopes the identity accordingly.
  missingFromRun: compactionStatus === "compacted" ? 0 : matchedSubjects,
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
  // Selected by the run's own MEASUREMENT PERIOD, never by when it started. A manual run takes an
  // arbitrary `evaluationDate` (`run/run-pipeline.ts`), so a run STARTED in 2028 can legitimately
  // score PY2027 — a rerun-to-verify of a closed year is exactly that — and a start-date window drops
  // it while the report answers "no run for this year" with that run sitting in the table.
  //
  // The earlier attempt filtered `listLatestPopulationRuns` by start date because that call caps its
  // walk at 25 runs whatever candidate count it is given. A period-scoped read has no such cap and is
  // the simpler thing as well as the correct one.
  const candidates = await deps.runs.listPopulationRunsForPeriod(
    `${measurementYear}-01-01T00:00:00.000Z`,
    `${measurementYear + 1}-01-01T00:00:00.000Z`,
    RUN_CANDIDATES,
  );
  for (const run of candidates) {
    // The store already filtered status and scope; re-asserted here because this function's contract
    // is "a reportable whole-population run" and a second reader should not have to trust a join.
    if (!isReportableRunStatus(run.status)) continue;
    if (!isPopulationRun(run.scopeType)) continue;
    // Newest-first, so the FIRST run that holds this measure's rows is the answer. An ALL_PROGRAMS run
    // holds every routed measure, so this is one probe in the common case; a measure routed later than
    // the newest run is found further down rather than reported as absent.
    const probe = await deps.outcomes.listOutcomes(run.id, { measureId, limit: 1, offset: 0 });
    if (probe.length === 0) continue;
    return {
      runId: run.id,
      startedAt: run.startedAt,
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
  /** The four DISJOINT buckets every seen subject falls into, classified per row in a stated order. */
  buckets: { scored: number; unmeasured: number; evaluationErrors: number; outOfPopulation: number };
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
  /**
   * The identifier the ACO's file actually carried for a subject.
   *
   * Carried through rather than substituting the subject id, which is only equal to it while matching
   * is exact-`externalId`. The moment the format changes (name+DOB, MBI — the seam
   * `subject-list-import.ts` names), the ACO loses the one column that lets them reconcile the CSV
   * against the file they sent, and nothing would report the loss.
   */
  rawIdentifierOf: (subjectId: string) => string,
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
      // Compared as INSTANTS, not as strings. `2027-01-01T10:00:00+02:00` is earlier than
      // `2027-01-01T09:30:00Z` and sorts after it lexically, so a string compare could pick the older
      // clinical evaluation. The id breaks a genuine tie, and is compared as a string because that is
      // all it is.
      const ms = (r: OutcomeRecord) => Date.parse(r.evaluatedAt);
      const a = ms(row);
      const b = ms(held);
      const newer = Number.isFinite(a) && Number.isFinite(b) ? (a === b ? row.id > held.id : a > b) : row.id > held.id;
      if (newer) newest.set(row.subjectId, row);
    }
    if (page.length < PAGE) break;
  }

  const aggregator = createRateAggregator(measureId);
  const kept: { row: OutcomeRecord; errored: boolean; memberships: ReturnType<typeof membershipRatesFor> }[] = [];
  let identity: ReturnType<typeof officialReportIdentity> = null;
  for (const row of newest.values()) {
    aggregator.add(row);
    identity ??= officialReportIdentity(row.evidence);
    const errored = isEvaluationErrorEvidence(row.evidence);
    // Memberships are read ONCE per row and reused for the row's flags and its bucket. The first cut
    // built a whole `createRateAggregator` per row for the flags alone — 300,000 stateful aggregators
    // at the 50,000-member cap across six measures, each re-parsing the evidence.
    kept.push({ row, errored, memberships: errored ? [] : membershipRatesFor(row, measureId) });
  }
  const aggregate = aggregator.finish();
  // How many rates this run DECLARES, which is what makes a row with fewer of them unmeasured. Read
  // off the finished aggregate so a single row cannot decide it — the rule is about the run.
  const declaredRates = aggregate.rates.length;
  const labels = officialMeasureSemantics(measureId)?.rateLabels;

  const rows: ReportRow[] = [];
  const buckets = { scored: 0, unmeasured: 0, evaluationErrors: 0, outOfPopulation: 0 };
  for (const { row, errored, memberships } of kept) {
    // ONE bucket per subject, in this order. The order is the contract: an errored row is an error
    // first (no engine spoke for it, so nothing else about it is known), an out-of-population row is
    // out of population before it is "in no rate", and only what survives both is scored. Classifying
    // by subtraction instead — the first cut — double-counted errors and could go negative.
    if (errored) buckets.evaluationErrors += 1;
    else if (row.outOfPopulation) buckets.outOfPopulation += 1;
    else if (declaredRates > 1 && memberships.length !== declaredRates) buckets.unmeasured += 1;
    else buckets.scored += 1;
    rows.push({
      rawIdentifier: rawIdentifierOf(row.subjectId),
      subjectId: row.subjectId,
      resolution: "MATCHED",
      rowStatus: "EVALUATED",
      measureId,
      outcome: { status: row.status, evaluatedAt: row.evaluatedAt, outOfPopulation: row.outOfPopulation },
      rates: memberships.map((m, index) => ({
        label: labels?.[index] ?? null,
        ipp: m.ipp,
        denom: m.denom,
        denex: m.denex,
        denexcep: m.denexcep,
        numer: m.numer,
      })),
      evaluationError: errored,
    });
  }
  return {
    aggregate,
    identity,
    seen: new Set(newest.keys()),
    rows,
    buckets,
    duplicateRowsCollapsed,
    periodMismatch,
  };
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

/** subject id -> the raw identifier the ACO's file carried, for the MATCHED members. */
async function rawIdentifiersBySubject(
  deps: SubjectListReportDeps,
  listId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await deps.lists.listMembers(listId, { resolution: "MATCHED", limit: PAGE, offset });
    for (const member of page.members) {
      if (member.subjectId) out.set(member.subjectId, member.rawIdentifier);
    }
    if (page.members.length < PAGE) break;
  }
  return out;
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
