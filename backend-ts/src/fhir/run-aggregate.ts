/**
 * One run's official evidence, summed — shared by the MeasureReport/QRDA III exporters
 * (`routes/runs.ts`) and the programs overview (`program/measure-rate.ts`), so the dashboard and the
 * regulatory export cannot disagree because they reduced the same rows differently (ADR-077 d5).
 *
 * NEVER an unnarrowed `listOutcomes(runId)`. Until 2026-09-06 the export path refused any run over the
 * individual-report cap with a 422 — so on the 20,000-patient pilot the two regulatory exports were
 * unreachable for every official measure. The cap protects the INDIVIDUAL report, which builds one
 * document per subject; a sum needs only each row's memberships, which the aggregator retains at a few
 * dozen bytes each.
 *
 * **That last sentence is now what bounds the read, rather than a page window** (2026-09-21, review of
 * #610). `LIMIT/OFFSET` paging bounded memory but re-sorted the measure's whole evidence once per page
 * — no index serves `(evaluated_at, id)` — which on the pilot made this the slowest statement on the
 * deployment. `listOutcomeMembershipsForRun` is ONE unordered statement that returns only the
 * memberships and the error marker, so the bound is the same few dozen bytes per subject, held once.
 *
 * Per RATE, not a single vector (ADR-074): `?type=summary` returned ONE group for cms137 while
 * `?type=bundle` returned two. Strata ride along from the same memberships. `unmeasured` — the subjects
 * ADR-074 d5 counts in NO rate — and `evaluationErrors` — the subjects no engine spoke for (ADR-077 d6)
 * — travel with the counts so a consumer can SAY how many rows the denominators leave out.
 */
import { scoringIdentityOf, type OutcomeStore } from "../stores/outcome-store.ts";
import { formatScoringLogic, scoringLogicOf, type ScoringLogic } from "../measure/measure-identity.ts";
import {
  createRateAggregator,
  isEvaluationErrorEvidence,
  officialMembership,
  officialReportIdentity,
  type OfficialReportIdentity,
  type RateAggregate,
} from "./measure-report.ts";

export interface OfficialRunAggregate extends RateAggregate {
  /** The artifact identity read off the first evaluated row; null when no row carried one. */
  official: OfficialReportIdentity | null;
  /**
   * Whether ANY evaluated row of the run FOR THIS MEASURE carries official population evidence (an
   * errored row carries no engine's evidence and is skipped). Scoped to the measure because ADR-072
   * admits a run that mixes engines across measures.
   *
   * It travels with the counts so a caller that is going to aggregate anyway reads the rows ONCE.
   * `officialMeasureRate` asked the probe and then aggregated, which on the pilot was two reads of the
   * same 20,000 evidence blobs per measure, six measures deep, on the programs overview's cold path.
   */
  producedOfficialEvidence: boolean;
  /**
   * True when the run's evaluated rows for this measure were scored by MORE THAN ONE logic — different
   * artifacts (CMS's draft and a WorkWell translation, or two vendorings) or different measurement
   * periods. One report cannot honestly name one measure and one period over such rows, so the
   * exporters refuse it. A run created by `/evaluate` or `/import` resolves the date per call, which is
   * how one open run can hold more than one year.
   */
  identityConflict: boolean;
  /**
   * The distinct logics that scored this measure's evaluated rows, named (`scoringLogicOf`), one entry
   * per distinct {@link scoringLogicKeyOf} and sorted ({@link distinctScoringLogics}). More than one entry
   * means the rows were scored by more than one logic or measurement period, so there is no one rate.
   * Errored rows were scored by nothing; authored rows have no name to list (they still set
   * `identityConflict` when they sit beside official rows).
   */
  scoringLogics: ScoringLogic[];
}

/**
 * Which logic scored one row, and the key that tells two rows' logics apart: the named logic itself,
 * the artifact digest and the measurement period counted (the period is not part of `ScoringLogic`, but
 * two periods are two answers, exactly as {@link scoringIdentityKey} treats them). Null for a row nothing
 * named: authored, errored, or an `official` block missing the fields that name it.
 */
export function scoringLogicKeyOf(evidence: unknown): { key: string; logic: ScoringLogic } | null {
  const logic = scoringLogicOf(evidence);
  if (!logic) return null;
  const identity: Record<string, unknown> = scoringIdentityOf((evidence as { official?: unknown }).official) ?? {};
  const period = (identity.measurementPeriod ?? {}) as Record<string, unknown>;
  return { key: JSON.stringify([logic, identity.artifactSha256 ?? null, period.start ?? null, period.end ?? null]), logic };
}

/**
 * The distinct named logics among rows' evidence, in a fixed order (by their printed name, then by key),
 * so a list built from rows read in any order is the same list.
 */
export function distinctScoringLogics(evidences: Iterable<unknown>): ScoringLogic[] {
  const byKey = new Map<string, ScoringLogic>();
  for (const evidence of evidences) {
    const entry = scoringLogicKeyOf(evidence);
    if (entry && !byKey.has(entry.key)) byKey.set(entry.key, entry.logic);
  }
  return [...byKey.entries()]
    .sort(([ka, a], [kb, b]) => {
      const na = formatScoringLogic(a) ?? "";
      const nb = formatScoringLogic(b) ?? "";
      return na < nb ? -1 : na > nb ? 1 : ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .map(([, logic]) => logic);
}

/**
 * What makes two rows' scoring the same logic: the artifact kind and hash, and the period counted. An
 * evaluated row with no official evidence was scored by authored CQL, which is a logic of its own: an
 * open run that took authored rows before a routing flip and official rows after must not have the
 * authored memberships summed under the official artifact's name.
 */
export function scoringIdentityKey(identity: OfficialReportIdentity | null): string {
  if (!identity) return "authored";
  return JSON.stringify([identity.kind ?? "official", identity.artifactSha256 ?? null, identity.measurementPeriod?.start ?? null, identity.measurementPeriod?.end ?? null]);
}

export async function aggregateOfficialRun(
  os: Pick<OutcomeStore, "listOutcomeMembershipsForRun">,
  runId: string,
  measureId: string,
): Promise<OfficialRunAggregate> {
  const aggregator = createRateAggregator(measureId);
  // The artifact identity travels with the counts so BOTH exporters describe the same measure. Read off
  // the first evaluated row that carries it — within ONE measure a run uses one engine, so any of its
  // rows is decisive, and a run where only some rows errored still names the artifact the rest were
  // scored by (ADR-046).
  let identity: OfficialReportIdentity | null = null;
  // SCOPED TO THE MEASURE. An ALL_PROGRAMS run holds one row per (subject, measure) pair, so an
  // unscoped scan sums every measure the run touched and returns that one number for whichever measure
  // was asked about. On the pilot's 2026-09-08 nightly that served CMS125's initial population, score
  // and `ecqmId` under CMS122's name on the programs overview.
  // ONE unordered statement over a NARROWED projection, not a LIMIT/OFFSET walk (2026-09-21). The
  // walk cost one sort of the measure's whole evidence PER PAGE — `(evaluated_at, id)` has no index,
  // and each page re-ran the same filter and sort to skip further into it — so ten pages did ten times
  // the server work for the same bytes. On the pilot that made the programs overview's cold read the
  // statement the 30 s role default cancelled: `/api/programs/overview` answered 503.
  //
  // Nothing here reads the rows in order, so dropping the sort changes no answer. It DOES drop the
  // memory bound the page window gave, which is why the read is narrowed to the memberships
  // (`listOutcomeMembershipsForRun`) rather than simply unpaged. A first cut of this justified the
  // unpaged full read as "smaller than the 120,000-row read the overview already makes"; that was
  // wrong twice over, and both halves were caught in review: `listOutcomesWithRun` has a LEAN
  // projection with no `evidence_json` at all, and `for (const row of await …)` awaits the whole
  // parsed array, so nothing is folded as it arrives.
  // ORDER-INDEPENDENT, and it had to become so (review of #610). Letting the FIRST evaluated row settle
  // provenance was deterministic under `ORDER BY evaluated_at, id`; with the sort dropped "first" is
  // whatever the planner returns, and `officialMeasureRate`
  // memoizes whichever answer landed — so one `(run, measure)` could yield a rate on one process and
  // `null` on another. `officialMembership` returns null for an unreadable `populationResults` as well
  // as for authored evidence, so a single malformed row arriving first would have made a whole
  // official measure read as authored and dropped its rate off the dashboard.
  //
  // ANY evaluated row carrying official membership settles it. The reason the first cut gave for not
  // doing this — that asking every row would re-alert on each unreadable blob — was simply false:
  // `aggregator.add` already calls `officialMembership` on every non-error row (`membershipRatesFor` →
  // `membershipFor`), so every alert was already being emitted.
  let producedOfficialEvidence = false;
  let identityConflict = false;
  let firstKey: string | null = null;
  // COLLECTED, not only compared: a reader that has to say WHICH logics scored a conflicted run (the
  // programs card, the run detail) needs the list, and a boolean cannot carry it. One evidence per
  // distinct logic is kept, so the cost stays O(logics), never O(rows).
  const logicEvidence = new Map<string, unknown>();
  for (const row of await os.listOutcomeMembershipsForRun(runId, measureId)) {
    aggregator.add(row);
    if (isEvaluationErrorEvidence(row.evidence)) continue;
    const rowIdentity = officialReportIdentity(row.evidence);
    if (!identity) identity = rowIdentity;
    // Every evaluated row is compared, not just the first: the first row naming the report is only honest
    // if every other row was scored the same way. An errored row was scored by nothing and is skipped above.
    const key = scoringIdentityKey(rowIdentity);
    if (firstKey === null) firstKey = key;
    else if (key !== firstKey) identityConflict = true;
    const named = scoringLogicKeyOf(row.evidence);
    if (named && !logicEvidence.has(named.key)) logicEvidence.set(named.key, row.evidence);
    producedOfficialEvidence ||= officialMembership(row.evidence) !== null;
  }
  return {
    ...aggregator.finish(),
    official: identity,
    producedOfficialEvidence,
    identityConflict,
    scoringLogics: distinctScoringLogics(logicEvidence.values()),
  };
}
