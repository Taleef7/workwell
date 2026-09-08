/**
 * One run's official evidence, summed page by page — shared by the MeasureReport/QRDA III exporters
 * (`routes/runs.ts`) and the programs overview (`program/measure-rate.ts`), so the dashboard and the
 * regulatory export cannot disagree because they reduced the same rows differently (ADR-077 d5).
 *
 * PAGED, never one `listOutcomes(runId)`. Until 2026-09-06 the export path refused any run over the
 * individual-report cap with a 422 — so on the 20,000-patient pilot the two regulatory exports were
 * unreachable for every official measure. The cap protects the INDIVIDUAL report, which builds one
 * document per subject; a sum needs only each row's memberships, which the aggregator retains at a few
 * dozen bytes each, so it is read in pages.
 *
 * Per RATE, not a single vector (ADR-074): `?type=summary` returned ONE group for cms137 while
 * `?type=bundle` returned two. Strata ride along from the same memberships. `unmeasured` — the subjects
 * ADR-074 d5 counts in NO rate — and `evaluationErrors` — the subjects no engine spoke for (ADR-077 d6)
 * — travel with the counts so a consumer can SAY how many rows the denominators leave out.
 */
import type { OutcomeStore } from "../stores/outcome-store.ts";
import {
  createRateAggregator,
  isEvaluationErrorEvidence,
  officialMembership,
  officialReportIdentity,
  type OfficialReportIdentity,
  type RateAggregate,
} from "./measure-report.ts";

/** Rows per page when summing a run's official evidence; bounded memory at any roster size. */
export const AGGREGATE_PAGE = 2000;

export interface OfficialRunAggregate extends RateAggregate {
  /** The artifact identity read off the first evaluated row; null when no row carried one. */
  official: OfficialReportIdentity | null;
}

/**
 * Whether ANY evaluated row of the run carries official population evidence. An errored row says
 * nothing about which engine the run used, so it is skipped, and the scan continues page by page until
 * a row that was evaluated answers; only a run in which EVERY subject errored reads to the end, and that
 * run has nothing to export either way. First page of one: the overwhelmingly common case (first row
 * evaluated fine) costs a single row.
 */
export async function runProducedOfficialEvidence(os: Pick<OutcomeStore, "listOutcomes">, runId: string): Promise<boolean> {
  let limit = 1;
  let offset = 0;
  for (;;) {
    const page = await os.listOutcomes(runId, { limit, offset });
    for (const row of page) {
      if (isEvaluationErrorEvidence(row.evidence)) continue;
      return officialMembership(row.evidence) !== null;
    }
    if (page.length < limit) return false;
    offset += page.length;
    limit = AGGREGATE_PAGE;
  }
}

export async function aggregateOfficialRun(
  os: Pick<OutcomeStore, "listOutcomes">,
  runId: string,
  measureId: string,
): Promise<OfficialRunAggregate> {
  const aggregator = createRateAggregator(measureId);
  // The artifact identity travels with the counts so BOTH exporters describe the same measure. Read off
  // the first evaluated row that carries it — a run evaluates one measure with one engine, so any row is
  // decisive, and a run where only some rows errored still names the artifact the rest were scored by
  // (ADR-046).
  let identity: OfficialReportIdentity | null = null;
  for (let offset = 0; ; offset += AGGREGATE_PAGE) {
    const page = await os.listOutcomes(runId, { limit: AGGREGATE_PAGE, offset });
    for (const row of page) {
      aggregator.add(row);
      if (!identity && !isEvaluationErrorEvidence(row.evidence)) identity = officialReportIdentity(row.evidence);
    }
    if (page.length < AGGREGATE_PAGE) break;
  }
  return { ...aggregator.finish(), official: identity };
}
