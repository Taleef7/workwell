/**
 * The logic that scored each case's cited outcome, for surfaces that list cases (#769).
 *
 * A case row carries no evidence, but it names the outcome it is about: `(last_run_id, employee_id,
 * measure_id)` and its `evaluation_period`, refreshed by every run that re-confirms the case and kept by
 * retention. Reading that row is exact; asking today's routing which logic covers the case's period is
 * not (a row scored before a translation was routed, or by authored CQL on TWH before the flip, would be
 * relabelled).
 *
 * One bounded read per (run, measure) group, chunked by subject like the live cells (#569), and per case
 * the row `outcomeForCase` returns (`citedRow`: the first row of the case's period in the store's
 * `evaluated_at ASC` order, else the first row) — so a list and the case page always name the same logic,
 * even for a run holding one subject's 2026 and 2027 rows.
 *
 * The read is the identity-only projection (`OutcomeStore.listScoringIdentities`) when the store has it:
 * a page of cases names its logics without fetching a single `evidence_json`. A reader without it (a test
 * double) falls back to `listOutcomes`, with the same answer.
 */
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { measureVersionOf, scoringLogicOf, type ScoringLogic } from "../measure/measure-identity.ts";
import { citedRow } from "./case-outcome.ts";

const SUBJECT_CHUNK = 900;

export interface CaseOutcomeRef {
  lastRunId: string | null | undefined;
  employeeId: string;
  measureId: string;
  /**
   * The case's period. Prefers the subject's row of this period in the cited run; absent (or no row of
   * it), the first row stands.
   */
  evaluationPeriod?: string | null;
}

/** The outcome store as the cited-row reads use it: the projection when there is one, else the rows. */
export type CaseScoringReader = Pick<OutcomeStore, "listOutcomes"> & Partial<Pick<OutcomeStore, "listScoringIdentities">>;

/** One entry per case: two cases of one subject citing the same run in different periods stay apart. */
export const caseLogicKey = (ref: Pick<CaseOutcomeRef, "lastRunId" | "employeeId" | "measureId" | "evaluationPeriod">): string =>
  `${ref.lastRunId ?? ""}\u0000${ref.employeeId}\u0000${ref.measureId}\u0000${ref.evaluationPeriod ?? ""}`;

/** What scored one case's cited outcome: its logic (null when nothing named did) and that logic's version. */
export interface CaseScoring {
  logic: ScoringLogic | null;
  /** `measureVersionOf` the cited row; "" when there is no row (no run, or the row is gone). */
  version: string;
}

/**
 * `caseLogicKey(ref)` → the scoring logic of that case's cited outcome, or null (no run, no row, or a
 * row nothing named scored: authored or errored). Every ref gets an entry.
 */
export async function scoringLogicForCases(
  outcomes: CaseScoringReader,
  refs: readonly CaseOutcomeRef[],
): Promise<Map<string, ScoringLogic | null>> {
  const scoring = await scoringForCases(outcomes, refs);
  return new Map([...scoring].map(([k, v]) => [k, v.logic]));
}

/** One subject's row of a (run, measure), reduced to what names its logic. */
interface CitedCandidate {
  subjectId: string;
  measureId: string;
  evaluationPeriod: string;
  evidence: unknown;
}

/**
 * One chunk of a (run, measure) group's rows, in the store's `evaluated_at ASC, id ASC` order. From the
 * projection, the evidence is rebuilt to exactly what `scoringLogicOf` and `measureVersionOf` read: the
 * identity as `official`, an errored row as the bare marker, an authored row as nothing.
 */
async function readChunk(outcomes: CaseScoringReader, runId: string, measureId: string, subjectIds: readonly string[]): Promise<CitedCandidate[]> {
  if (typeof outcomes.listScoringIdentities === "function") {
    return (await outcomes.listScoringIdentities(runId, { measureId, subjectIds })).map((r) => ({
      subjectId: r.subjectId,
      measureId: r.measureId,
      evaluationPeriod: r.evaluationPeriod,
      evidence: r.errored ? { evaluationError: true } : r.official ? { official: r.official } : {},
    }));
  }
  return outcomes.listOutcomes(runId, { measureId, subjectIds });
}

/** As `scoringLogicForCases`, with the version that scored the row (for CSVs and version fields). */
export async function scoringForCases(
  outcomes: CaseScoringReader,
  refs: readonly CaseOutcomeRef[],
): Promise<Map<string, CaseScoring>> {
  const out = new Map<string, CaseScoring>();
  const groups = new Map<string, { runId: string; measureId: string; refs: CaseOutcomeRef[]; subjects: Set<string> }>();
  for (const ref of refs) {
    out.set(caseLogicKey(ref), { logic: null, version: "" });
    if (!ref.lastRunId) continue;
    const g = `${ref.lastRunId}\u0000${ref.measureId}`;
    const group = groups.get(g) ?? { runId: ref.lastRunId, measureId: ref.measureId, refs: [], subjects: new Set<string>() };
    group.refs.push(ref);
    group.subjects.add(ref.employeeId);
    groups.set(g, group);
  }
  for (const { runId, measureId, refs: groupRefs, subjects } of groups.values()) {
    const ids = [...subjects];
    // Every row per subject, in order: a subject's rows in one (run, measure) are a handful, and which
    // one a case cites depends on the case's period.
    const rowsBySubject = new Map<string, CitedCandidate[]>();
    for (let start = 0; start < ids.length; start += SUBJECT_CHUNK) {
      for (const row of await readChunk(outcomes, runId, measureId, ids.slice(start, start + SUBJECT_CHUNK))) {
        // A fake that ignores the filters still yields the right answer.
        if (row.measureId !== measureId || !subjects.has(row.subjectId)) continue;
        const list = rowsBySubject.get(row.subjectId) ?? [];
        list.push(row);
        rowsBySubject.set(row.subjectId, list);
      }
    }
    for (const ref of groupRefs) {
      const row = citedRow(rowsBySubject.get(ref.employeeId) ?? [], ref.evaluationPeriod);
      if (!row) continue;
      out.set(caseLogicKey(ref), { logic: scoringLogicOf(row.evidence), version: measureVersionOf(measureId, row.evidence) });
    }
  }
  return out;
}
