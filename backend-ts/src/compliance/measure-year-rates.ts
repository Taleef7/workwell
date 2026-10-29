/**
 * One measure's rates for one measurement year, counted per group (#852).
 *
 * The attributed-list report (ADR-082: one group, the list) and the provider scorecard (one group per
 * provider) both answer "what did this year's run score for these patients?". They select, read and count
 * through this module so they cannot disagree: the same run, the same newest row per subject, the same
 * declared rate count, and every subject in the same one of four disjoint buckets.
 *
 * The read is the narrowed per-subject projection (`listOutcomeSubjectMembershipsForRun`): one unordered
 * statement carrying each row's `official` block, error and thin-data markers, and nothing of the
 * `expressionResults` bulk. The paged full read it replaced re-sorted the measure's evidence per page,
 * 1.4 s for 20,000 rows on Postgres against 0.14 s. One evidence per distinct scoring logic is kept,
 * which is all `scoringOfRows` needs to name the logic and detect a mix.
 *
 * Rows of one (run, measure) carry a handful of distinct evidences, and on Postgres the rows that carry
 * the same one share ONE object, so what is derived from an evidence (its error marker, rates, scoring
 * key, memberships per status) is derived once per object, not once per row; each evaluation time is
 * parsed once, not on every comparison of the sort.
 */
import { scoringIdentityOf, type OutcomeStore } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import {
  createRateAggregator,
  isEvaluationErrorEvidence,
  officialReportIdentity,
  parseRateRow,
  rateCountOf,
  type OfficialReportIdentity,
  type PopulationMembership,
  type RateAggregate,
} from "../fhir/measure-report.ts";
import { namingMemoKey, scoringIdentityKey, scoringLogicKeyOf, scoringOfRows } from "../fhir/run-aggregate.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { isPopulationRun } from "../program/rollup-shared.ts";
import { isReportableRunStatus } from "../run/reportable.ts";
import type { MeasureRateGroup } from "../program/measure-rate.ts";
import type { ScoringLogic } from "../measure/measure-identity.ts";
import { dataInsufficientChecks, type SufficiencyCheck } from "../run/data-sufficiency.ts";

/** One page of list members per read (the attributed-list report's member pages). */
export const PAGE = 2000;
/**
 * How many runs OF THE MEASUREMENT YEAR are examined for one that holds this measure's rows.
 *
 * Fifty is generous because the read is already period-scoped: these are the year's own runs,
 * newest-first, and an ALL_PROGRAMS run holds every routed measure, so the first is almost always the
 * answer. The count matters only for a measure routed partway through a year.
 */
const RUN_CANDIDATES = 50;
/**
 * Runs that never answer for a measurement year, whatever their status and scope: the synthetic scale and
 * trend seeding (`SCALE_TRIGGER`, `TREND_HISTORY_TRIGGER`), whose rows are demo data, never evidence.
 */
const SEED_TRIGGERS: ReadonlySet<string> = new Set(["seed:scale", "seed:trend-history"]);

export interface SelectedRun {
  runId: string;
  startedAt: string;
  measurementPeriodStart: string;
  measurementPeriodEnd: string;
}

/**
 * The newest reportable whole-population run for this measure whose own measurement period is the
 * asked-for calendar year.
 *
 * Selected by the run's own MEASUREMENT PERIOD, never by when it started. A manual run takes an
 * arbitrary `evaluationDate` (`run/run-pipeline.ts`), so a run STARTED in 2028 can legitimately score
 * PY2027 (a rerun-to-verify of a closed year is exactly that), and a start-date window drops it while
 * the report answers "no run for this year" with that run sitting in the table. In January 2028 the
 * newest run is a PY2028 one, so "the latest" would answer a PY2027 question with next year's partial
 * data; this walks past it.
 *
 * Seeded runs and runs created for QRDA I imports (`requestedScope.importDriven`, whose rows are only the
 * imported documents' patients) are skipped: until #852 a seeded run could be picked here.
 */
export async function selectRunForYear(
  deps: { runs: Pick<RunStore, "listPopulationRunsForPeriod">; outcomes: Pick<OutcomeStore, "listOutcomes"> },
  measureId: string,
  measurementYear: number,
): Promise<SelectedRun | null> {
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
    if (SEED_TRIGGERS.has(run.triggeredBy)) continue;
    if (run.requestedScope?.importDriven === true) continue;
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

/** One subject's newest row, reduced to what counting and the list report's rows read. */
export interface LeanRow {
  id: string;
  subjectId: string;
  evaluatedAt: string;
  status: string;
  outOfPopulation?: boolean;
  /** No engine spoke for this subject: counted as an error, in no rate (ADR-077 d6). */
  errored: boolean;
  /** One per rate the row carries; empty for an errored row. */
  memberships: PopulationMembership[];
  /**
   * Interned key of everything `scoringOfRows` and the report identity read off a row (`namingMemoKey`
   * plus `scoringLogicKeyOf`'s key): two evaluated rows with the same key answer both the same. Empty for
   * an errored row, which names no logic.
   */
  logicKey: string;
  /** Interned, comma-joined data-sufficiency checks the row failed (#853), or null. */
  thin: string | null;
}

export interface MeasureYearRows {
  /** The newest row per kept subject, in the order subjects were first read. */
  rows: LeanRow[];
  duplicateRowsCollapsed: number;
  /** A kept row states a measurement period outside the asked-for year. */
  periodMismatch: boolean;
  /**
   * How many rates the counted rows declare: the widest any kept subject's newest evaluated row carries.
   * Where no kept row was evaluated (every one errored) it is the run's own, read the same way over every
   * subject's newest row, so a group of errors still reports every rate (CMS137's two) rather than one.
   * Superseded duplicates never set it. 0 when nothing in the run was evaluated.
   */
  declaredRates: number;
  /** The first evaluated kept row's artifact identity; null when none was evaluated or it was authored. */
  identity: OfficialReportIdentity | null;
  /** The kept rows were scored by more than one logic (`scoringOfRows`), e.g. CMS's draft and a translation. */
  mixedLogic: boolean;
  /** The one logic the evaluated kept rows were scored by; null when mixed, authored, or none named. */
  logic: ScoringLogic | null;
  /** The checks the kept rows say their measure's data failed (#853), or null when they carry none. */
  dataInsufficient: SufficiencyCheck[] | null;
}

/**
 * Read a run's rows for one measure and keep the newest per subject that `keep` accepts.
 *
 * Newest (evaluatedAt, id) per subject wins, deterministically: a run can hold more than one row for a
 * subject, and the read is unordered. The kept rows are served in (evaluatedAt, id) order.
 */
export async function readMeasureYearRows(
  outcomes: Pick<OutcomeStore, "listOutcomeSubjectMembershipsForRun">,
  runId: string,
  measureId: string,
  measurementYear: number,
  keep: (subjectId: string) => boolean = () => true,
): Promise<MeasureYearRows> {
  // The newest kept row per subject, with its `evaluatedAt` parsed once: comparing re-parsed both
  // timestamps on every call, and as the sort's comparator that was most of the read's time at 20,000 rows.
  const newest = new Map<string, { row: LeanRow; at: number }>();
  // One evidence per distinct logic key, from an evaluated row: `scoringOfRows` over these answers as it
  // would over every row, because the key decides the answer. O(logics) blobs, never O(rows).
  const logicEvidence = new Map<string, unknown>();
  const interned = new Map<string, string>();
  const intern = (value: string): string => {
    const held = interned.get(value);
    if (held !== undefined) return held;
    interned.set(value, value);
    return value;
  };
  let duplicateRowsCollapsed = 0;
  let periodMismatch = false;
  // Every subject's newest row's rate count (0 for an errored row), kept or not: the run's own count, the
  // fallback for a kept set none of whose rows was evaluated.
  const runNewest = new Map<string, { id: string; at: number; rates: number }>();
  const logicKeyByRaw = new Map<string, string>();
  // Everything below that is read off a row's evidence, derived once per evidence OBJECT: the Postgres
  // read hands every row of a (run, measure) with the same narrowed evidence one shared object, so 20,000
  // rows are a handful of derivations. Each value is a function of the evidence alone (memberships of the
  // evidence and the status), so a row reads exactly what deriving it afresh would give. Where every row
  // has its own object (the SQLite floor) each is derived once, as before.
  const derivedByEvidence = new Map<unknown, Derived>();
  const derive = (evidence: unknown): Derived => {
    let derived = derivedByEvidence.get(evidence);
    if (!derived) {
      const errored = isEvaluationErrorEvidence(evidence);
      derived = { errored, rates: errored ? 0 : rateCountOf(evidence), kept: null, membershipsByStatus: new Map() };
      derivedByEvidence.set(evidence, derived);
    }
    return derived;
  };
  // What only a KEPT row reads, so a list report's non-members cost no more than the two values above.
  const keptOf = (derived: Derived, evidence: unknown): KeptDerived => {
    if (derived.kept) return derived.kept;
    const identity = officialReportIdentity(evidence);
    const period = identity?.measurementPeriod;
    // Exact: `namingMemoKey` reads the TRIMMED identity and `scoringLogicKeyOf` the raw block, so two rows
    // differing only in an untrimmed digest or a partial period share the first and not the second; keyed
    // on both, one evidence per key answers `scoringOfRows` as every row would. Both are functions of the
    // raw `scoringIdentityOf` projection alone, so they are computed once per distinct projection.
    let logicKey = "";
    if (!derived.errored) {
      const raw = JSON.stringify(scoringIdentityOf((evidence as { official?: unknown } | null)?.official));
      const known = logicKeyByRaw.get(raw);
      logicKey = known ?? intern(JSON.stringify([namingMemoKey(scoringIdentityKey(identity), identity), scoringLogicKeyOf(evidence)?.key ?? null]));
      if (known === undefined) logicKeyByRaw.set(raw, logicKey);
    }
    const checks = dataInsufficientChecks(evidence);
    derived.kept = {
      otherYear: !!period && new Date(period.start).getUTCFullYear() !== measurementYear,
      logicKey,
      thin: checks ? intern(checks.join(",")) : null,
    };
    return derived.kept;
  };

  for (const row of await outcomes.listOutcomeSubjectMembershipsForRun(runId, measureId)) {
    const derived = derive(row.evidence);
    const at = Date.parse(row.evaluatedAt);
    const seenInRun = runNewest.get(row.subjectId);
    if (!seenInRun || isNewerAt(at, row.id, seenInRun.at, seenInRun.id)) {
      runNewest.set(row.subjectId, { id: row.id, at, rates: derived.rates });
    }
    if (!keep(row.subjectId)) continue;
    const kept = keptOf(derived, row.evidence);
    if (kept.otherYear) periodMismatch = true;
    const held = newest.get(row.subjectId);
    if (held) {
      duplicateRowsCollapsed += 1;
      if (!isNewerAt(at, row.id, held.at, held.row.id)) continue;
    }
    if (!derived.errored && !logicEvidence.has(kept.logicKey)) logicEvidence.set(kept.logicKey, row.evidence);
    let memberships = derived.membershipsByStatus.get(row.status);
    if (!memberships) {
      // Strata are not read: neither report states them, and they are most of a parsed row's size. The
      // status is part of the key because an authored row's membership is read off it.
      memberships = parseRateRow(row, measureId).memberships;
      derived.membershipsByStatus.set(row.status, memberships);
    }
    newest.set(row.subjectId, {
      at,
      row: {
        id: row.id,
        subjectId: row.subjectId,
        evaluatedAt: row.evaluatedAt,
        status: row.status,
        ...(row.outOfPopulation !== undefined ? { outOfPopulation: row.outOfPopulation } : {}),
        errored: derived.errored,
        memberships,
        logicKey: kept.logicKey,
        thin: kept.thin,
      },
    });
  }

  const rows = [...newest.values()]
    .sort((a, b) => (isNewerAt(a.at, a.row.id, b.at, b.row.id) ? 1 : isNewerAt(b.at, b.row.id, a.at, a.row.id) ? -1 : 0))
    .map((held) => held.row);
  let keptRates = 0;
  for (const row of rows) if (!row.errored) keptRates = Math.max(keptRates, row.memberships.length);
  let runRates = 0;
  for (const subject of runNewest.values()) runRates = Math.max(runRates, subject.rates);
  const declaredRates = keptRates > 0 ? keptRates : runRates;
  const keys = new Set<string>();
  let thin: Set<SufficiencyCheck> | null = null;
  let identity: OfficialReportIdentity | null = null;
  let identified = false;
  for (const row of rows) {
    // Before the error skip: a thin measure's flag is on every one of its rows, errored ones included. A
    // flag naming no check still refuses, as it does in `aggregateOfficialRun`.
    if (row.thin !== null) {
      thin ??= new Set();
      for (const check of row.thin ? row.thin.split(",") : []) thin.add(check as SufficiencyCheck);
    }
    // An errored row scored nothing, so it never names the logic, even if it kept an `official` block.
    if (row.errored) continue;
    keys.add(row.logicKey);
    if (!identified) {
      identity = officialReportIdentity(logicEvidence.get(row.logicKey));
      identified = true;
    }
  }
  const scoring = scoringOfRows([...keys].map((key) => logicEvidence.get(key)));
  return {
    rows,
    duplicateRowsCollapsed,
    periodMismatch,
    declaredRates,
    identity,
    mixedLogic: scoring.conflict,
    logic: scoring.conflict ? null : (scoring.logics[0] ?? null),
    dataInsufficient: thin ? [...thin].sort() : null,
  };
}

/** A row's evidence, read once per evidence object (`readMeasureYearRows`). */
interface Derived {
  errored: boolean;
  /** The rate count the run's own declared count reads: 0 for an errored row. */
  rates: number;
  /** Filled by the first KEPT row carrying this evidence. */
  kept: KeptDerived | null;
  /** `parseRateRow`'s memberships, per status (an authored row's membership is read off its status). */
  membershipsByStatus: Map<string, PopulationMembership[]>;
}

interface KeptDerived {
  /** The evidence states a measurement period that starts in another year. */
  otherYear: boolean;
  logicKey: string;
  thin: string | null;
}

/**
 * Is row A (evaluated at `aAt`, `Date.parse`d once by the caller) newer than row B? Compared as INSTANTS,
 * not as strings: `2027-01-01T10:00:00+02:00` is earlier than `2027-01-01T09:30:00Z` and sorts after it
 * lexically, so a string compare could pick the older clinical evaluation. The id breaks a genuine tie,
 * and is compared as a string because that is all it is; it decides alone when either time is unreadable.
 */
function isNewerAt(aAt: number, aId: string, bAt: number, bId: string): boolean {
  return Number.isFinite(aAt) && Number.isFinite(bAt) ? (aAt === bAt ? aId > bId : aAt > bAt) : aId > bId;
}

export interface Buckets {
  scored: number;
  unmeasured: number;
  evaluationErrors: number;
  outOfPopulation: number;
}

/**
 * ONE bucket per subject, in this order. The order is the contract: an errored row is an error first (no
 * engine spoke for it, so nothing else about it is known), an out-of-population row is out of population
 * before it is "in no rate", and only what survives both is scored. Classifying by subtraction instead
 * double-counted errors and could go negative (ADR-082's first cut).
 */
export function bucketOf(row: Pick<LeanRow, "errored" | "outOfPopulation" | "memberships">, declaredRates: number): keyof Buckets {
  if (row.errored) return "evaluationErrors";
  if (row.outOfPopulation) return "outOfPopulation";
  if (declaredRates > 1 && row.memberships.length !== declaredRates) return "unmeasured";
  return "scored";
}

export interface GroupCount {
  aggregate: RateAggregate;
  buckets: Buckets;
  /** Subjects counted in this group: the sum of the four buckets. */
  seen: number;
}

/**
 * Count the rows per group. A row whose group is null is counted nowhere (a patient no longer in the
 * directory has no provider to be counted under). Every group's aggregate is seeded with the run's
 * declared rate count, so the groups' rates line up and sum to the whole.
 */
export function foldGroups<K>(
  rows: Iterable<LeanRow>,
  measureId: string,
  declaredRates: number,
  groupOf: (row: LeanRow) => K | null,
): Map<K, GroupCount> {
  const groups = new Map<K, { aggregator: ReturnType<typeof createRateAggregator>; buckets: Buckets; seen: number }>();
  for (const row of rows) {
    const key = groupOf(row);
    if (key === null) continue;
    let group = groups.get(key);
    if (!group) {
      group = {
        aggregator: createRateAggregator(measureId, { declaredRates }),
        buckets: { scored: 0, unmeasured: 0, evaluationErrors: 0, outOfPopulation: 0 },
        seen: 0,
      };
      groups.set(key, group);
    }
    group.aggregator.addParsed({ errored: row.errored, memberships: row.memberships, strata: null });
    group.buckets[bucketOf(row, declaredRates)] += 1;
    group.seen += 1;
  }
  const out = new Map<K, GroupCount>();
  for (const [key, group] of groups) out.set(key, { aggregate: group.aggregator.finish(), buckets: group.buckets, seen: group.seen });
  return out;
}

/**
 * Per-rate counts as served: `numer / (denom − denex − denexcep)`, the eCQM proportion-measure score, null
 * when the effective denominator is 0, labelled with the reviewed rate labels.
 */
export function rateGroupsOf(aggregate: Pick<RateAggregate, "rates">, measureId: string): MeasureRateGroup[] {
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
