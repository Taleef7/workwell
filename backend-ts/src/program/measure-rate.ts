/**
 * The evidence-based rate for one terminal run of one measure — the number a quality lead means by
 * "our CMS122 rate". Reduced by `createRateAggregator`, which already applies the CQM IG folds
 * (numerator exclusions into the numerator, exceptions conditional on the raw numerator), so the score
 * here is `numer / (denom − denex − denexcep)` over its NORMALIZED output and nothing is subtracted
 * twice. Shown on the programs overview as a metric SEPARATE from the workflow-status rate
 * (`complianceRateOf`), and no improvement is ever computed between the two (ADR-077 d5).
 */
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { aggregateOfficialRun, runProducedOfficialEvidence } from "../fhir/run-aggregate.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";

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
  source: "official-evidence";
  runId: string;
  /** The artifact the evidence names, when a row carried it. */
  official: { ecqmId: string | null; version: string | null } | null;
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
const memo = new Map<string, MeasureRate>();
const MEMO_LIMIT = 32;
export function resetMeasureRateMemo(): void {
  memo.clear();
}

export async function officialMeasureRate(
  os: Pick<OutcomeStore, "listOutcomes">,
  runId: string,
  measureId: string,
): Promise<MeasureRate | null> {
  const key = `${runId}|${measureId}`;
  const hit = memo.get(key);
  if (hit) return hit;
  // One row decides whether there is official evidence to reduce; an authored run is never paged.
  if (!(await runProducedOfficialEvidence(os, runId))) return null;
  const aggregate = await aggregateOfficialRun(os, runId, measureId);
  const labels = officialMeasureSemantics(measureId)?.rateLabels;
  const rate: MeasureRate = {
    source: "official-evidence",
    runId,
    official: aggregate.official ? { ecqmId: aggregate.official.ecqmId ?? null, version: aggregate.official.version ?? null } : null,
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
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value as string);
  memo.set(key, rate);
  return rate;
}
