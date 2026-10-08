/**
 * The evidence-based rate for one terminal run of one measure — the number a quality lead means by
 * "our CMS122 rate". Reduced by `createRateAggregator`, which already applies the CQM IG folds
 * (numerator exclusions into the numerator, exceptions conditional on the raw numerator), so the score
 * here is `numer / (denom − denex − denexcep)` over its NORMALIZED output and nothing is subtracted
 * twice. Shown on the programs overview as a metric SEPARATE from the workflow-status rate
 * (`complianceRateOf`), and no improvement is ever computed between the two (ADR-077 d5).
 */
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { aggregateOfficialRun } from "../fhir/run-aggregate.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { ecqmIdOf, type ScoringLogic } from "../measure/measure-identity.ts";

export interface MeasureRateGroup {
  /** The reviewed rate label (`OFFICIAL_MEASURE_SEMANTICS[id].rateLabels`); null for a single-rate measure. */
  label: string | null;
  ipp: number;
  denom: number;
  denex: number;
  denexcep: number;
  numer: number;
  /** `denom − denex − denexcep` — what the score divides by. */
  effectiveDenominator: number;
  /** `numer / effectiveDenominator`, or null when the effective denominator is 0. */
  score: number | null;
}

export interface MeasureRate {
  /** `translation-evidence` when a WorkWell translation scored the run — the compliance API's word for it. */
  source: "official-evidence" | "translation-evidence";
  runId: string;
  /**
   * The logic that scored the rows behind this rate, named from their own evidence (`scoringLogicOf`);
   * null when the evidence did not name it. A rate exists only for rows scored by ONE logic, so this is
   * that logic.
   */
  logic: ScoringLogic | null;
  /**
   * The artifact the evidence names, when a row carried it. `kind: "derived"` with its `label` when a
   * WorkWell translation scored the run; its `ecqmId` is then always null (LOCKED §4.3). CMS's id is
   * spelled as every served surface spells it (`ecqmIdOf`: "CMS125FHIR", where the evidence stores the
   * manifest's bare "125FHIR").
   */
  official: {
    ecqmId: string | null;
    version: string | null;
    artifactSha256?: string | null;
    kind?: "derived";
    label?: string | null;
    derivedFrom?: string | null;
  } | null;
  rates: MeasureRateGroup[];
  /** Subjects counted in no rate (ADR-074 d5). */
  unmeasured: number;
  /** Subjects whose evaluation threw: in no population, reported rather than hidden (ADR-077 d6). */
  evaluationErrors: number;
}

/**
 * Terminal runs are immutable, so a run's rate never changes; bounded FIFO over (runId, measureId).
 * PRECONDITION on every caller: pass a REPORTABLE run (COMPLETED or PARTIAL_FAILURE). A moving run
 * memoized here would be served stale for the life of the process, and a FAILED/CANCELLED run's rows
 * are a fragment whose "rate" is not the measure's. The programs overview only ever selects a
 * reportable run (`isCompletedRun`), and the reconciliation route gates on `isReportableRunStatus`.
 */
/**
 * The no-rate answer is memoized too, and it has to be (review of #610).
 *
 * The negative used to cost one row — `runProducedOfficialEvidence` with `LIMIT 1` — so not caching it
 * was free. Since provenance and aggregation share ONE read it costs the measure's whole evidence, and
 * `programOverview` runs this loop per request OUTSIDE its own memo. So a measure whose winning run
 * carries no official evidence — a nightly that errored every subject, a run predating the measure's
 * flip to official, any authored measure — would have re-read 20,000 rows on every single
 * `/api/programs/overview` call, for the life of the process. That is the statement-timeout cliff this
 * change exists to remove, reintroduced by the change itself.
 */
/**
 * What one (run, measure) answers: the rate, or why there is none, and the logics that scored it.
 *
 * Memoized AS THIS OBJECT, never as a bare `null` (#769). A bare `null` stood for three different
 * answers — authored rows, no evaluated row, and rows scored by more than one logic — and a reader that
 * has to NAME the logics of a conflicted run (the programs card, the measure page) read a memoized
 * conflict back as "authored", which has none. `conflict` and `scoringLogics` keep them apart.
 */
export interface MeasureRateResult {
  /** Null for authored rows, for a run with no evaluated official row, and for a conflict. */
  rate: MeasureRate | null;
  /**
   * The distinct named logics of the run's evaluated rows for the measure, sorted
   * (`distinctScoringLogics`). Empty for authored rows; more than one entry is a conflict.
   */
  scoringLogics: ScoringLogic[];
  /** The rows were scored by more than one logic or measurement period (authored rows count as one). */
  conflict: boolean;
}

const memo = new Map<string, MeasureRateResult>();
const MEMO_LIMIT = 32;
export function resetMeasureRateMemo(): void {
  memo.clear();
}

/** The rate alone — null for authored rows, no evaluated official row, or a conflict. */
export async function officialMeasureRate(
  os: Pick<OutcomeStore, "listOutcomeMembershipsForRun">,
  runId: string,
  measureId: string,
): Promise<MeasureRate | null> {
  return (await officialMeasureRateResult(os, runId, measureId)).rate;
}

export async function officialMeasureRateResult(
  os: Pick<OutcomeStore, "listOutcomeMembershipsForRun">,
  runId: string,
  measureId: string,
): Promise<MeasureRateResult> {
  const key = `${runId}|${measureId}`;
  const cached = memo.get(key);
  if (cached) return cached;
  const remember = (result: MeasureRateResult): MeasureRateResult => {
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value as string);
    memo.set(key, result);
    return result;
  };
  // ONE read of the measure's rows, which also answers whether there was official evidence to reduce
  // (`producedOfficialEvidence`). It used to ask `runProducedOfficialEvidence` first and then
  // aggregate — two reads of the same 20,000 evidence blobs per measure, six measures deep, on the
  // programs overview's cold path. Scoped to the measure either way: on an ALL_PROGRAMS run every
  // measure's rows share the run id, so an unscoped question is answered by whichever measure
  // happened to sort first.
  //
  // An AUTHORED measure now pays the read rather than one row. That is the trade this makes, and it is
  // the right way round: on the pilot every routed measure is official, so the authored case is TWH's
  // small occupational rosters, while the official case is the 20,000-patient one that was timing out.
  const aggregate = await aggregateOfficialRun(os, runId, measureId);
  const scoringLogics = aggregate.scoringLogics;
  // Rows scored by two different logics (an ad-hoc evaluation spanning a year boundary) have no one
  // rate: summing CMS's 2026 counts with a translation's 2027 counts names neither. The exporters refuse
  // the same run (`mixed_logic`). Two NAMED logics are a conflict even where the exporters' coarser key
  // agrees (rows recorded before the digest was), so that "more than one logic listed" and "no rate"
  // always say the same thing.
  const conflict = aggregate.identityConflict || scoringLogics.length > 1;
  if (!aggregate.producedOfficialEvidence || conflict) return remember({ rate: null, scoringLogics, conflict });
  const labels = officialMeasureSemantics(measureId)?.rateLabels;
  const derived = aggregate.official?.kind === "derived";
  const rate: MeasureRate = {
    source: derived ? "translation-evidence" : "official-evidence",
    runId,
    logic: scoringLogics[0] ?? null,
    official: aggregate.official
      ? {
          // One spelling on every served id; a translation never carries one, whatever a row held.
          ecqmId: !derived && aggregate.official.ecqmId ? ecqmIdOf(aggregate.official.ecqmId) : null,
          version: aggregate.official.version ?? null,
          artifactSha256: aggregate.official.artifactSha256 ?? null,
          ...(aggregate.official.kind === "derived"
            ? { kind: "derived" as const, label: aggregate.official.label ?? null, derivedFrom: aggregate.official.derivedFrom ?? null }
            : {}),
        }
      : null,
    rates: aggregate.rates.map((c, index) => {
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
    }),
    unmeasured: aggregate.unmeasured,
    evaluationErrors: aggregate.evaluationErrors,
  };
  return remember({ rate, scoringLogics, conflict: false });
}
