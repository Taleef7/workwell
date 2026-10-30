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
import { createRateAggregator, reportingPeriod, type OfficialReportIdentity, type RateAggregate } from "../fhir/measure-report.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { compactionExposure } from "../run/compaction-evidence.ts";
import type { MeasureRateGroup } from "../program/measure-rate.ts";
import { ecqmIdOf, type ScoringLogic } from "../measure/measure-identity.ts";
import type { SufficiencyCheck } from "../run/data-sufficiency.ts";
import { PAGE, foldGroups, rateGroupsOf, readMeasureYearRows, selectRunForYear, type Buckets } from "./measure-year-rates.ts";

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
  /**
   * The logic that produced the numbers, by name: `CMS137FHIR v1.0.000` for CMS's artifact, or a WorkWell
   * translation's label (`WorkWell translation of CMS137v15`), whose `ecqmId` is null (LOCKED §4.3).
   */
  executedLogic: string | null;
  /**
   * The same logic, structured (`scoringLogicOf` over the rows' own evidence, #769): CMS's artifact with
   * its eCQM id, version and lineage, or a translation by its label and version (never an eCQM id).
   * Null where nothing was counted or nothing named the logic. `executedLogic` stays the §6.6 string.
   */
  logic: ScoringLogic | null;
  runId: string | null;
  runStartedAt: string | null;
  measurementPeriod: { start: string; end: string } | null;
  /**
   * "complete" | "compacted" | "no_run" | "data_insufficient" — why a measure has no numbers, when it has
   * none. `data_insufficient` (#853): the run's data for the measure was too thin to trust (D12).
   */
  compactionStatus: "complete" | "compacted" | "no_run" | "data_insufficient";
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
  /** Measures whose selected run's data was too thin to trust (#853); their entries carry no rates and no rows. */
  dataInsufficientMeasures: string[];
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
  const dataInsufficientMeasures: string[] = [];
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
    if (read.mixedLogic) {
      // Rows of one year scored by two logics (CMS's draft and a WorkWell translation, or authored CQL):
      // their sum names neither, and `executedLogic` could only name one. Refused as QRDA and the
      // MeasureReport refuse the same run (422 there; 409 here, beside `period_mismatch`).
      return {
        ok: false,
        status: 409,
        body: {
          error: "mixed_logic",
          measureId,
          runId: winner.runId,
          measurementYear,
          message: "the selected run's outcomes for this measure were scored by more than one logic",
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
    // #853: the run's data for this measure was too thin to trust, so its rates would describe missing
    // data. Refused like a compacted measure, by measure, never by withholding the others.
    if (read.dataInsufficient) {
      dataInsufficientMeasures.push(measureId);
      entries.push(emptyEntry(measureId, matchedIds.size, "data_insufficient", `data_insufficient:${read.dataInsufficient.join(",")}`));
      continue;
    }

    entries.push({
      measureId,
      // One spelling on every served eCQM id, and none for a translation, whatever its rows carried.
      ecqmId: read.identity?.ecqmId && read.identity.kind !== "derived" ? ecqmIdOf(read.identity.ecqmId) : null,
      version: read.identity?.version ?? null,
      executedLogic: executedLogicOf(read.identity ?? null),
      logic: read.logic,
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
      rates: rateGroupsOf(read.aggregate, measureId),
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

  // The whole request is refused only when EVERY measure that had a run is refused, compacted or too thin
  // to trust. Withholding five complete measures because the sixth's run aged out would be a second wrong
  // answer.
  if (measuresWithARun > 0 && compactedMeasures.length + dataInsufficientMeasures.length === measuresWithARun) {
    const allCompacted = dataInsufficientMeasures.length === 0;
    return {
      ok: false,
      status: 409,
      body: allCompacted
        ? {
            error: "run_compacted",
            measurementYear,
            compactedMeasures,
            cutoff: furthestCutoff,
            message:
              "every measure's run for this year predates a compaction cutoff; a score computed over a keep set is a different number wearing the run's identity",
          }
        : {
            error: "data_insufficient",
            measurementYear,
            dataInsufficientMeasures,
            compactedMeasures,
            message: "every measure's run for this year was refused: its data was too thin to trust, or it was compacted",
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
      dataInsufficientMeasures,
      measures: entries,
      rows,
    },
  };
}

const maxIso = (a: string | null, b: string): string =>
  a === null || Date.parse(b) > Date.parse(a) ? b : a;

/**
 * A translation by its label; CMS's artifact by its eCQM id and version, spelled as the measure page
 * spells it (`CMS125FHIR v1.0.000`: the evidence stores the manifest's bare `125FHIR`); null when
 * neither is known.
 */
export function executedLogicOf(identity: OfficialReportIdentity | null): string | null {
  if (!identity) return null;
  if (identity.kind === "derived") return identity.label ?? null;
  if (!identity.ecqmId || !identity.version) return null;
  return `${ecqmIdOf(identity.ecqmId)} v${identity.version}`;
}

const emptyEntry = (
  measureId: string,
  matchedSubjects: number,
  compactionStatus: MeasureReportEntry["compactionStatus"],
  reason: string,
): MeasureReportEntry => ({
  measureId,
  ecqmId: null,
  version: null,
  executedLogic: null,
  logic: null,
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
  // we cannot read. DATA_MODEL_CONTRACTS §6.6 scopes the identity accordingly. A DATA-INSUFFICIENT
  // measure (#853) claims nothing for the same reason: its rows exist, and none of them is trusted.
  missingFromRun: compactionStatus === "no_run" ? matchedSubjects : 0,
  scoredSubjects: 0,
  unmeasured: 0,
  evaluationErrors: 0,
  outOfPopulation: 0,
  duplicateRowsCollapsed: 0,
  rates: [],
});

interface MeasureRead {
  aggregate: RateAggregate;
  identity: OfficialReportIdentity | null;
  seen: Set<string>;
  rows: ReportRow[];
  /** The four DISJOINT buckets every seen subject falls into (`bucketOf`), classified per row in a stated order. */
  buckets: Buckets;
  duplicateRowsCollapsed: number;
  periodMismatch: boolean;
  /** The counted rows were scored by more than one logic (`scoringOfRows`), e.g. CMS's draft and a translation. */
  mixedLogic: boolean;
  /** The one logic the non-errored counted rows were scored by; null when mixed, authored, or none named. */
  logic: ScoringLogic | null;
  /** The checks the counted rows say their measure's data failed (#853), or null when they carry none. */
  dataInsufficient: SufficiencyCheck[] | null;
}

/**
 * Read a run's outcomes for one measure, keeping only the list's members, and count them as ONE group
 * through the scorecard's own counting (`measure-year-rates.ts`, #852), so the two cannot disagree.
 */
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
  // The member SET, so the store reads only the members' rows (#874).
  const read = await readMeasureYearRows(deps.outcomes, runId, measureId, measurementYear, matchedIds);
  // The run's declared rate count, not the list's: a list whose rows all errored still reports every
  // rate the run declares (two zero rates for CMS137), and a member with fewer rates is unmeasured here
  // exactly as it is in the run's own MeasureReport.
  const counted = foldGroups(read.rows, measureId, read.declaredRates, () => "list").get("list");
  const labels = officialMeasureSemantics(measureId)?.rateLabels;
  const rows: ReportRow[] = read.rows.map((row) => ({
    rawIdentifier: rawIdentifierOf(row.subjectId),
    subjectId: row.subjectId,
    resolution: "MATCHED",
    rowStatus: "EVALUATED",
    measureId,
    outcome: { status: row.status, evaluatedAt: row.evaluatedAt, outOfPopulation: row.outOfPopulation },
    rates: row.memberships.map((m, index) => ({
      label: labels?.[index] ?? null,
      ipp: m.ipp,
      denom: m.denom,
      denex: m.denex,
      denexcep: m.denexcep,
      numer: m.numer,
    })),
    evaluationError: row.errored,
  }));
  return {
    aggregate: counted?.aggregate ?? createRateAggregator(measureId, { declaredRates: read.declaredRates }).finish(),
    identity: read.identity,
    seen: new Set(read.rows.map((row) => row.subjectId)),
    rows,
    buckets: counted?.buckets ?? { scored: 0, unmeasured: 0, evaluationErrors: 0, outOfPopulation: 0 },
    duplicateRowsCollapsed: read.duplicateRowsCollapsed,
    periodMismatch: read.periodMismatch,
    mixedLogic: read.mixedLogic,
    logic: read.logic,
    dataInsufficient: read.dataInsufficient,
  };
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
