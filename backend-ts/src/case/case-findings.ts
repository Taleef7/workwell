/**
 * What the measure's own CQL found for the patient, on the case page (#880).
 *
 * The attributed-list report's CSV says this per patient and rate (#875, `evidenceOf`); the case page now
 * says it for the gap it is about, through THE SAME reader, so the screen and the file cannot disagree
 * about one outcome. Nothing here reads FHIR data or chooses among values: the status is `evidenceOf`'s,
 * every value is CQL's own rendering, labelled with its define, and the date is the spec's one Date define.
 *
 * Which rate: the one the case is about — the first rate the patient missed (`missedRateIndex`, the same
 * rate the next-action wording and the card read), else the first. On CMS137 a case opened for Engagement
 * therefore reads `NOT_EXPOSED_BY_LOGIC`, as the CSV does for that rate.
 */
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import { formatScoringLogic, scoringLogicOf } from "../measure/measure-identity.ts";
import { parseRateRow } from "../fhir/measure-report.ts";
import { missedRateIndex } from "../compliance/official-display.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { factsSpecFor, readCqlFacts } from "../wiring/official-facts.ts";
import { evidenceOf, type EvidenceStatus } from "../compliance/evidence-status.ts";

export interface CaseCqlFindings {
  /**
   * The list report's `evidenceStatus` (§6.6) for this case's rate. The page shows the values on
   * `NUMERATOR_EVIDENCE` and `LATEST_NOT_QUALIFYING`, a line on `NONE_FOUND` and `NOT_EXPOSED_BY_LOGIC`,
   * and nothing on `NOT_RECORDED_BY_RUN` (authored CQL, a run before #875) or `NOT_APPLICABLE`.
   */
  status: EvidenceStatus;
  /** The rate's label on a multi-rate measure ("Initiation"); null on a single-rate one. */
  rate: string | null;
  /** The spec's Date define's value, on the two found statuses only; null otherwise. */
  date: string | null;
  /** That define's name, so the date never reads as a fact WorkWell chose. */
  dateLabel: string | null;
  /** The logic that computed the values ("CMS165FHIR v1.0.000", or a WorkWell translation's label). */
  executedLogic: string | null;
  /**
   * Every recorded value as CQL rendered it, by define, in the spec's order, on the found and
   * `NONE_FOUND` statuses. CQL's own "no record" define (CMS122) is the status, never a row here.
   */
  values: Array<{ label: string; value: string }>;
}

const SHOWS_VALUES: ReadonlySet<EvidenceStatus> = new Set(["NUMERATOR_EVIDENCE", "LATEST_NOT_QUALIFYING", "NONE_FOUND"]);

/** The case's findings from its cited outcome, or null with no outcome (nothing to read). */
export function cqlFindingsOf(measureId: string, outcome: Pick<OutcomeRecord, "status" | "evidence" | "outOfPopulation"> | null): CaseCqlFindings | null {
  if (!outcome) return null;
  const evidence = outcome.evidence as Record<string, unknown> | null | undefined;
  const logic = scoringLogicOf(evidence);
  const executedLogic = formatScoringLogic(logic);
  const semantics = officialMeasureSemantics(measureId);
  const { errored, memberships } = parseRateRow({ status: outcome.status, evidence }, measureId);
  const missed = missedRateIndex(evidence, semantics?.numeratorMeansCompliant ?? true);
  const rateIndex = missed >= 0 ? missed : 0;
  const membership = memberships[rateIndex];
  const empty = (status: EvidenceStatus): CaseCqlFindings => ({
    status,
    rate: null,
    date: null,
    dateLabel: null,
    executedLogic,
    values: [],
  });
  // An errored row or one with no population flags (authored CQL) recorded nothing a reader can name.
  if (errored || !membership) return empty("NOT_RECORDED_BY_RUN");
  const facts = readCqlFacts(evidence?.cqlFacts);
  const cells = evidenceOf(
    measureId,
    { logic, executedLogic },
    rateIndex,
    { label: null, ...membership },
    { outcome: { status: outcome.status, evaluatedAt: "", outOfPopulation: outcome.outOfPopulation }, cqlFacts: facts },
  );
  const rate = memberships.length > 1 ? (semantics?.rateLabels?.[rateIndex] ?? null) : null;
  if (!SHOWS_VALUES.has(cells.status)) return { ...empty(cells.status), rate };
  const kind = logic?.kind === "cms-artifact" ? "official" : "derived";
  const noneFoundDefine = factsSpecFor(measureId, kind)?.noneFoundDefine;
  const date = cells.date || null;
  return {
    status: cells.status,
    rate,
    date,
    dateLabel: date ? (factsSpecFor(measureId, kind)?.dateDefine ?? null) : null,
    executedLogic,
    values: (facts?.values ?? []).filter(({ define }) => define !== noneFoundDefine).map(({ define, value }) => ({ label: define, value })),
  };
}
