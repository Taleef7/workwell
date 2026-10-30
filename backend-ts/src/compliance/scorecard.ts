/**
 * The provider × measure quality scorecard (#852).
 *
 * The practice works per provider and per location, so this states each measure's rate for each
 * provider's patients, a subtotal per location and a practice total, from the same evidence and the same
 * counting as the attributed-list report (`measure-year-rates.ts`): a cell's rate is the rate that report
 * gives for a list of exactly that provider's patients on the same run.
 *
 * Rules that are not obvious:
 *
 * 1. **A patient counts under their PCP on file** (the directory's `providerId`), never under whoever saw
 *    them. A PCP the directory does not list falls in one "Other" row; a patient no longer in the
 *    directory counts nowhere, as on the work list.
 * 2. **Every total is the sum of the rows shown above it**, its counts added and its rate recomputed from
 *    them, never averaged: a location's rate is its patients' numerator over their effective denominator,
 *    as CMS computes any rate. With "My providers" the totals cover only the shown rows. The one exception
 *    is a clinician's card (#870, `onlyProvider`): it carries that provider's row alone, in `scope`, and
 *    the practice total over every patient, with no location or "Other" row, since a location subtotal
 *    beside one provider's row would state their colleagues' combined figures.
 * 3. **Only a complete column shows rates.** A measure with no run for the year, a compacted run, thin
 *    data (#853), rows scored by two logics or rows of another year says so and shows none.
 * 4. **A rate on fewer than 20 patients is marked small** (MIPS's case minimum for most quality measures),
 *    not hidden: the practice decides what to do with it.
 * 5. **Open gaps are this year's work list**: active cases in each measure's current cycle, grouped by the
 *    same lookup, so a provider's count is what `/api/cases?status=open&providerId=…&period=current`
 *    totals. A past year has none to show.
 */
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { compactionExposure } from "../run/compaction-evidence.ts";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";
import { ACTIVE_CASE_STATUSES } from "../case/case-logic.ts";
import { reportingPeriod, type PopulationCounts } from "../fhir/measure-report.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { formatScoringLogic, type ScoringLogic } from "../measure/measure-identity.ts";
import type { MeasureRateGroup } from "../program/measure-rate.ts";
import type { SufficiencyCheck } from "../run/data-sufficiency.ts";
import {
  foldGroups,
  rateGroupsOf,
  readMeasureYearRows,
  selectRunForYear,
  type Buckets,
  type GroupCount,
  type MeasureYearRows,
  type SelectedRun,
} from "./measure-year-rates.ts";

/** Below this effective denominator a rate is marked small (owner decision, 2026-10-20). */
export const SMALL_NUMBER_THRESHOLD = 20;
/** The row key of patients whose PCP the directory does not list. No provider id has this shape. */
const OTHER = "__other__";

export interface ScorecardDeps {
  outcomes: Pick<OutcomeStore, "anyOutcomeForMeasure" | "listOutcomeSubjectMembershipsForRun">;
  runs: Pick<RunStore, "listPopulationRunsForPeriod">;
  events: Pick<CaseEventStore, "recentAuditEventsByType">;
  cases: Pick<CaseStore, "listCases">;
  /** The work list's own patient lookup (`/api/cases`), so both count a patient under the same PCP. */
  subjectOf: (subjectId: string) => { providerId: string } | null;
  /**
   * The directory's provider for an id, or null when it lists none. The deployment's own scoped lookup
   * (`providerById(id, env)`), so the live WebChart provider is a row of its own wherever that deployment
   * shows the live tenant, never folded into "Other".
   */
  providerOf: (id: string) => { id: string; name: string; location: string } | null;
}

export interface ScorecardRequest {
  measurementYear: number;
  measures: readonly { id: string; name: string; policyRef: string }[];
  /** "My providers": only these providers' rows, and totals over them. Null for the whole practice. */
  providerIds: ReadonlySet<string> | null;
  /**
   * A clinician's card (#870): this provider's row alone, in `scope`, beside the practice total. Never
   * with `providerIds`.
   */
  onlyProvider?: string | null;
  ownsPanel: boolean;
  /** UTC `YYYY-MM-DD`, the work list's own "today". */
  today: string;
  now: string;
}

export type ColumnState = "complete" | "no_run" | "compacted" | "data_insufficient" | "mixed_logic" | "period_mismatch";

export interface ScorecardMeasure {
  measureId: string;
  name: string;
  policyRef: string;
  state: ColumnState;
  runId: string | null;
  runStartedAt: string | null;
  measurementPeriod: { start: string; end: string } | null;
  /** The logic that scored the column, by name (`CMS125FHIR v1.0.000`, or a translation's label and version). */
  executedLogic: string | null;
  logic: ScoringLogic | null;
  /** False for an inverse measure (CMS122: the numerator counts poor control, so lower is better). */
  numeratorMeansCompliant: boolean | null;
  rateLabels: readonly string[] | null;
  /** The thin-data checks that refused the column (#853). */
  dataInsufficient: SufficiencyCheck[] | null;
}

export interface ScorecardRate extends MeasureRateGroup {
  /** The effective denominator is below {@link SMALL_NUMBER_THRESHOLD}. */
  smallNumber: boolean;
}

export interface ScorecardCell {
  /** One per rate the run declares; null when the column is not complete. */
  rates: ScorecardRate[] | null;
  /** The four disjoint buckets of the patients counted here; null when the column is not complete. */
  buckets: Buckets | null;
  /** Active cases in the measure's current cycle; null for a past year. */
  openGaps: number | null;
}

export interface ScorecardRow {
  /** Null for the "Other" row, the subtotals and the total. */
  providerId: string | null;
  name: string;
  cells: Record<string, ScorecardCell>;
}

export interface Scorecard {
  measurementYear: number;
  generatedAt: string;
  smallNumberThreshold: number;
  /** Whether open gaps are stated: only for the current year, whose cycle the work list is. */
  openGapsShown: boolean;
  panel: { requested: "me" | "all"; ownsPanel: boolean };
  measures: ScorecardMeasure[];
  locations: Array<{ location: string; providers: ScorecardRow[]; subtotal: ScorecardRow }>;
  /** Patients whose PCP the directory does not list; null when there are none (always with "My providers"). */
  other: ScorecardRow | null;
  total: ScorecardRow;
  /**
   * A clinician's card only (#870): their provider and its row, which is present even when nobody is
   * counted under it, so the practice total is never shown alone. `locations` is then empty and `other`
   * null. Absent from every other card.
   */
  scope?: { providerId: string; name: string; location: string; row: ScorecardRow };
}

interface Column {
  measure: ScorecardMeasure;
  /** Counted patients per row key; empty unless the column is complete. */
  counts: Map<string, GroupCount>;
  /** The run's declared rate count: every row key's aggregate has this many rates (at least one). */
  width: number;
  /** Open gaps per row key; empty for a past year. */
  gaps: Map<string, number>;
}

export async function buildScorecard(deps: ScorecardDeps, request: ScorecardRequest): Promise<Scorecard> {
  // Resolved once per id: the lookup is the directory's, and a run names the same few hundred PCPs over and over.
  const resolved = new Map<string, { id: string; name: string; location: string } | null>();
  const providerOf = (id: string) => {
    if (!resolved.has(id)) resolved.set(id, deps.providerOf(id));
    return resolved.get(id)!;
  };
  const only = request.onlyProvider ? providerOf(request.onlyProvider) : null;
  if (request.onlyProvider && request.providerIds) throw new Error("buildScorecard: onlyProvider and providerIds are exclusive");
  if (request.onlyProvider && !only) throw new Error(`buildScorecard: provider ${request.onlyProvider} is not in the directory`);
  const openGapsShown = request.measurementYear === Number(request.today.slice(0, 4));

  // A subject's row key: their PCP, "Other" for a PCP the directory does not list, null when they are no
  // longer in the directory. With "My providers", any other provider's patient (and "Other") is null.
  const rowKeyOf = (subjectId: string): string | null => {
    const subject = deps.subjectOf(subjectId);
    if (!subject) return null;
    const key = providerOf(subject.providerId) ? subject.providerId : OTHER;
    if (request.providerIds && !request.providerIds.has(key)) return null;
    return key;
  };

  const columns: Column[] = [];
  for (const m of request.measures) {
    const [column, gaps] = await Promise.all([
      readColumn(deps, m, request.measurementYear, rowKeyOf),
      openGapsShown ? openGapsByRow(deps, m.id, request.today, rowKeyOf) : Promise.resolve(new Map<string, number>()),
    ]);
    columns.push({ ...column, gaps });
  }

  // The rows: every provider with a counted patient or an open gap in some column.
  const keys = new Set<string>();
  for (const column of columns) {
    for (const key of column.counts.keys()) keys.add(key);
    for (const key of column.gaps.keys()) keys.add(key);
  }

  const rowOf = (name: string, providerId: string | null, members: readonly string[]): ScorecardRow => ({
    providerId,
    name,
    cells: Object.fromEntries(columns.map((column) => [column.measure.measureId, cellOf(column, members, openGapsShown)])),
  });

  const byLocation = new Map<string, string[]>();
  for (const key of keys) {
    if (key === OTHER) continue;
    const location = providerOf(key)!.location;
    byLocation.set(location, [...(byLocation.get(location) ?? []), key]);
  }
  const nameOf = (id: string): string => providerOf(id)!.name;
  const total = rowOf("Total", null, [...keys]);
  if (only) {
    // Keyed over the whole practice like any card, so `total` is the practice's; only the one row is said.
    return {
      measurementYear: request.measurementYear,
      generatedAt: request.now,
      smallNumberThreshold: SMALL_NUMBER_THRESHOLD,
      openGapsShown,
      panel: { requested: "all", ownsPanel: request.ownsPanel },
      measures: columns.map((c) => c.measure),
      locations: [],
      other: null,
      total,
      scope: { providerId: only.id, name: only.name, location: only.location, row: rowOf(only.name, only.id, [only.id]) },
    };
  }
  const locations = [...byLocation.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([location, ids]) => {
      const sorted = [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      return {
        location,
        providers: sorted.map((id) => rowOf(nameOf(id), id, [id])),
        subtotal: rowOf(location, null, sorted),
      };
    });

  return {
    measurementYear: request.measurementYear,
    generatedAt: request.now,
    smallNumberThreshold: SMALL_NUMBER_THRESHOLD,
    openGapsShown,
    panel: { requested: request.providerIds ? "me" : "all", ownsPanel: request.ownsPanel },
    measures: columns.map((c) => c.measure),
    locations,
    other: keys.has(OTHER) ? rowOf("Other", null, [OTHER]) : null,
    total,
  };
}

/** One measure's column: the run, its state, and its patients counted per row key. */
async function readColumn(
  deps: ScorecardDeps,
  m: { id: string; name: string; policyRef: string },
  measurementYear: number,
  rowKeyOf: (subjectId: string) => string | null,
): Promise<Omit<Column, "gaps">> {
  const semantics = officialMeasureSemantics(m.id);
  const column = (state: ColumnState, run: SelectedRun | null, read: MeasureYearRows | null): Omit<Column, "gaps"> => ({
    measure: {
      measureId: m.id,
      name: m.name,
      policyRef: m.policyRef,
      state,
      runId: run?.runId ?? null,
      runStartedAt: run?.startedAt ?? null,
      measurementPeriod: run ? reportingPeriod(run, read?.identity ?? null) : null,
      executedLogic: formatScoringLogic(read?.logic),
      logic: read?.logic ?? null,
      numeratorMeansCompliant: semantics?.numeratorMeansCompliant ?? null,
      rateLabels: semantics?.rateLabels ?? null,
      dataInsufficient: read?.dataInsufficient ?? null,
    },
    counts: new Map(),
    width: Math.max(read?.declaredRates ?? 0, 1),
  });

  const run = await selectRunForYear(deps, m.id, measurementYear);
  if (!run) return column("no_run", null, null);

  // Compaction, the one thing that changes a terminal run's rows, is checked before the read (an exposed
  // run is never read) and after it (a pass that began during the read), as the list report does. Nothing
  // is cached, so every request reads each measure's evidence again: on a quarter-CPU Postgres (Maui's
  // Neon compute) that read is most of the page, about 0.6 s per measure for 20,000 rows and 2 s for
  // CMS137 (2026-10-29), and a cache of every subject's row is memory the next nightly makes stale.
  if ((await compactionExposure(run, deps.events)).exposed) return column("compacted", run, null);
  const read = await readMeasureYearRows(deps.outcomes, run.runId, m.id, measurementYear);
  if ((await compactionExposure(run, deps.events)).exposed) return column("compacted", run, null);
  if (read.periodMismatch) return column("period_mismatch", run, read);
  if (read.mixedLogic) return column("mixed_logic", run, read);
  if (read.dataInsufficient) return column("data_insufficient", run, read);

  return {
    ...column("complete", run, read),
    counts: foldGroups(read.rows, m.id, read.declaredRates, (row) => rowKeyOf(row.subjectId)),
  };
}

/** Active cases in the measure's current cycle, per row key, by the work list's own lookup and "today". */
async function openGapsByRow(
  deps: ScorecardDeps,
  measureId: string,
  today: string,
  rowKeyOf: (subjectId: string) => string | null,
): Promise<Map<string, number>> {
  // Uncapped, in ONE statement, as the work list's own uncapped read is (`loadWorklistCases`): the store's
  // default limit is 50, which counted only the 50 most recently updated gaps, and paging with OFFSET
  // while the nightly updates cases can skip or repeat rows.
  const cases = await deps.cases.listCases({
    measureId,
    statuses: [...ACTIVE_CASE_STATUSES],
    period: bucketPeriodForMeasure(measureId, today),
    limit: Number.MAX_SAFE_INTEGER,
  });
  const out = new Map<string, number>();
  for (const c of cases) {
    const key = rowKeyOf(c.employeeId);
    if (key !== null) out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * The cell of a set of row keys (one provider, a location, the practice): its keys' counts ADDED. Exact,
 * because every key was folded with the same declared rate count, so the per-rate counts line up and a
 * patient is in exactly one key.
 */
function cellOf(column: Column, members: readonly string[], openGapsShown: boolean): ScorecardCell {
  const openGaps = openGapsShown ? members.reduce((n, key) => n + (column.gaps.get(key) ?? 0), 0) : null;
  if (column.measure.state !== "complete") return { rates: null, buckets: null, openGaps };
  const rates: PopulationCounts[] = Array.from({ length: column.width }, () => ({ ipp: 0, denom: 0, denex: 0, numer: 0, denexcep: 0 }));
  const buckets: Buckets = { scored: 0, unmeasured: 0, evaluationErrors: 0, outOfPopulation: 0 };
  for (const key of members) {
    const group = column.counts.get(key);
    if (!group) continue;
    group.aggregate.rates.forEach((r, index) => {
      const sum = rates[index]!;
      sum.ipp += r.ipp;
      sum.denom += r.denom;
      sum.denex += r.denex;
      sum.numer += r.numer;
      sum.denexcep += r.denexcep;
    });
    for (const bucket of Object.keys(buckets) as Array<keyof Buckets>) buckets[bucket] += group.buckets[bucket];
  }
  return {
    rates: rateGroupsOf({ rates }, column.measure.measureId).map((r) => ({ ...r, smallNumber: r.effectiveDenominator < SMALL_NUMBER_THRESHOLD })),
    buckets,
    openGaps,
  };
}
