/**
 * The logic that scored each case's cited outcome, for surfaces that list cases (#769).
 *
 * A case row carries no evidence, but it names the outcome it is about: `(last_run_id, employee_id,
 * measure_id)`, refreshed by every run that re-confirms the case and kept by retention. Reading that one
 * row is exact; asking today's routing which logic covers the case's period is not (a row scored before
 * a translation was routed, or by authored CQL on TWH before the flip, would be relabelled).
 *
 * One bounded read per (run, measure) group, chunked by subject like the live cells (#569), and only the
 * first row per subject in the store's `evaluated_at ASC` order — the row `outcomeForCase` returns, so a
 * list and the case page always name the same logic.
 */
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { measureVersionOf, scoringLogicOf, type ScoringLogic } from "../measure/measure-identity.ts";

const SUBJECT_CHUNK = 900;

export interface CaseOutcomeRef {
  lastRunId: string | null | undefined;
  employeeId: string;
  measureId: string;
}

export const caseLogicKey = (ref: Pick<CaseOutcomeRef, "lastRunId" | "employeeId" | "measureId">): string =>
  `${ref.lastRunId ?? ""}\u0000${ref.employeeId}\u0000${ref.measureId}`;

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
  outcomes: Pick<OutcomeStore, "listOutcomes">,
  refs: readonly CaseOutcomeRef[],
): Promise<Map<string, ScoringLogic | null>> {
  const scoring = await scoringForCases(outcomes, refs);
  return new Map([...scoring].map(([k, v]) => [k, v.logic]));
}

/** As `scoringLogicForCases`, with the version that scored the row (for CSVs and version fields). */
export async function scoringForCases(
  outcomes: Pick<OutcomeStore, "listOutcomes">,
  refs: readonly CaseOutcomeRef[],
): Promise<Map<string, CaseScoring>> {
  const out = new Map<string, CaseScoring>();
  const groups = new Map<string, { runId: string; measureId: string; subjects: Set<string> }>();
  for (const ref of refs) {
    out.set(caseLogicKey(ref), { logic: null, version: "" });
    if (!ref.lastRunId) continue;
    const g = `${ref.lastRunId}\u0000${ref.measureId}`;
    const group = groups.get(g) ?? { runId: ref.lastRunId, measureId: ref.measureId, subjects: new Set<string>() };
    group.subjects.add(ref.employeeId);
    groups.set(g, group);
  }
  for (const { runId, measureId, subjects } of groups.values()) {
    const ids = [...subjects];
    const seen = new Set<string>();
    for (let start = 0; start < ids.length; start += SUBJECT_CHUNK) {
      const rows = await outcomes.listOutcomes(runId, { measureId, subjectIds: ids.slice(start, start + SUBJECT_CHUNK) });
      for (const o of rows) {
        // A fake that ignores the filters still yields the right answer.
        if (o.measureId !== measureId || !subjects.has(o.subjectId) || seen.has(o.subjectId)) continue;
        seen.add(o.subjectId);
        out.set(caseLogicKey({ lastRunId: runId, employeeId: o.subjectId, measureId }), {
          logic: scoringLogicOf(o.evidence),
          version: measureVersionOf(measureId, o.evidence),
        });
      }
    }
  }
  return out;
}
