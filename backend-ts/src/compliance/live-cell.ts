/**
 * "What does CQL say today" for a SMALL set of (subject, measure) pairs (#569) — bounded point reads,
 * never a cache fill.
 *
 * The case row cannot answer it: a case a person closed is never touched by the nightly upsert again
 * (`planCaseUpsert` no-ops on a human closure, `case-logic.ts`), so its `current_outcome_status` is
 * frozen at the moment of closure. The answer lives in `outcomes` — the winning population run's row
 * for that subject and measure, which is exactly what the roster and the programs overview read.
 *
 * **Bounded by construction.** The roster derives a measure's WHOLE winning run into a process cache
 * (20,000 rows of evidence per measure on the pilot). That is the roster's cost and the roster pays it
 * once; a page of fifty staff-closed cases must not pay it six times to annotate fifty rows. So this
 * reads only the requested subjects' rows — `listOutcomes(runId, { measureId, subjectIds })`, one
 * small indexed query per measure the pairs reference — and consults the roster cache READ-THROUGH
 * only when it already holds that `(measure, run)`; a miss never fills it. A test counts the queries
 * a page issues.
 *
 * **Three answers, never a silent null.** `GAP`: the run still counts the patient. `CLEAR`: compliant,
 * excluded, or outside the population. `UNKNOWN`: the measure has no winning run, or the subject is
 * not in it — "not currently evaluable" is its own answer, shown as such and counted apart, because
 * folding it into CLEAR would let a patient nobody has evaluated read as no longer a gap.
 */
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { isCompletedRun, isPopulationRun } from "../program/rollup-shared.ts";
import { liveStateOfCell, type LiveState } from "./roster-vocabulary.ts";
import { cellFromOutcome, type RosterCell, type RosterCellCache } from "./roster-read-model.ts";

export type { LiveState };

export interface LiveCell {
  state: LiveState;
  /** The winning run the answer came from; null when the measure has no winner. */
  runId: string | null;
  /** The derived cell, when the subject has a row in the winning run. */
  cell: RosterCell | null;
}

export interface LivePair {
  subjectId: string;
  measureId: string;
}

export type LiveCellDeps = {
  outcomeStore: Pick<OutcomeStore, "listLatestPopulationRuns" | "listOutcomes">;
  cellCache?: RosterCellCache;
};

export interface LiveCellOptions {
  /**
   * The run to read per measure, when the CALLER has already chosen one.
   *
   * The programs overview is the case: its buckets are grouped from the rows a filtered snapshot
   * returned, so a site- or tenant-scoped card can deliberately settle on an OLDER visible run than
   * the newest global winner (`latestPopulationSnapshot`'s visibility fallback). Resolving winners
   * again here would answer the chip from a different run than the `overdue`/`missingData` numbers
   * it sits beside and is meant to reconcile with — two numbers from two runs, which is the very
   * contradiction #569 exists to remove.
   *
   * When it is given it is AUTHORITATIVE and no winners read is issued: a measure the map does not
   * name is UNKNOWN, because the caller has said which run speaks for each measure.
   */
  runByMeasure?: ReadonlyMap<string, string | null>;
}

/**
 * The answer for ONE case — the same map, with the CYCLE equality applied.
 *
 * A winning run describes its own cycle. A case from a closed cycle — reachable through `?period=all`,
 * the history tabs, and every row of the cases CSV, which applies no period filter at all (§6.3) —
 * must not be labelled by today's answer, or a 2024 gap somebody closed reads as "verified compliant"
 * because the patient became compliant in 2026.
 *
 * It lives here, and not in each caller, because three surfaces need the rule and a rule written out
 * three times is a rule one surface ends up without: that is exactly what review found on the CSV,
 * where the list and the MCP tool had the equality and the export did not. The run id survives a
 * mismatch — the measure HAS a winner, it simply describes another cycle, and a null would read as
 * "no run at all".
 */
export function liveAnswerForCase(
  live: ReadonlyMap<string, LiveCell>,
  c: { employeeId: string; measureId: string; evaluationPeriod: string },
): LiveCell {
  const answer = live.get(livePairKey(c.employeeId, c.measureId));
  if (!answer) return { state: "UNKNOWN", runId: null, cell: null };
  if (answer.cell == null || answer.cell.evaluationPeriod !== c.evaluationPeriod) {
    return { state: "UNKNOWN", runId: answer.runId, cell: null };
  }
  return answer;
}

/**
 * How many subjects go into one `listOutcomes` call.
 *
 * The SQLite floor expands `subjectIds` into `subject_id IN (?, ?, …)` — one bind per id — against a
 * per-statement variable cap (999 on older builds, 32,766 on newer). The cases CSV asks about every
 * staff closure in the export's scope, which is unbounded over history, so a deployment on the floor
 * would throw `too many SQL variables` on a large enough export while the Postgres ceiling (one array
 * bind) never noticed. Same cliff, and the same number, as `PANEL_PREFILTER_MAX_IDS`.
 */
const SUBJECT_CHUNK = 900;

/**
 * The map key for a pair.
 *
 * LENGTH-PREFIXED rather than separated by some character no id is supposed to contain. Two earlier
 * spellings used a control character (NUL, then VT) and both wrote a LITERAL control byte into this
 * source file — which compiles, passes every test, and makes git and grep call the file binary
 * (`Binary file … matches`), the same silent corruption a `sed -i` on UTF-8 source caused here twice.
 * Encoding the subject's length makes the key unambiguous for ANY id contents, with nothing but
 * printable characters in the source.
 */
export const livePairKey = (subjectId: string, measureId: string): string =>
  `${subjectId.length}:${subjectId}:${measureId}`;

export async function liveCellsFor(
  deps: LiveCellDeps,
  pairs: readonly LivePair[],
  opts: LiveCellOptions = {},
): Promise<Map<string, LiveCell>> {
  const out = new Map<string, LiveCell>();
  if (pairs.length === 0) return out;

  const subjectsByMeasure = new Map<string, Set<string>>();
  for (const p of pairs) {
    const set = subjectsByMeasure.get(p.measureId) ?? subjectsByMeasure.set(p.measureId, new Set()).get(p.measureId)!;
    set.add(p.subjectId);
  }

  // The winners, exactly as the roster resolves them (O(measures) rows from the runs table): terminal
  // population runs only, scale and trend-history rows excluded, first per measure wins — UNLESS the
  // caller already chose the run each measure's other numbers came from, in which case that choice is
  // authoritative and this read is not issued at all.
  const runByMeasure = new Map<string, string>();
  if (opts.runByMeasure) {
    for (const [measureId, runId] of opts.runByMeasure) if (runId) runByMeasure.set(measureId, runId);
  } else {
    const winners = await deps.outcomeStore.listLatestPopulationRuns([...subjectsByMeasure.keys()], { excludeScale: true, excludeTrendHistory: true });
    for (const w of winners) {
      if (!isPopulationRun(w.runScopeType) || !isCompletedRun(w.runStatus)) continue;
      if (!runByMeasure.has(w.measureId)) runByMeasure.set(w.measureId, w.runId);
    }
  }

  for (const [measureId, subjects] of subjectsByMeasure) {
    const runId = runByMeasure.get(measureId);
    if (!runId) {
      for (const s of subjects) out.set(livePairKey(s, measureId), { state: "UNKNOWN", runId: null, cell: null });
      continue;
    }
    // Read-through: a cache entry for THIS run answers every subject it holds, and a subject it does
    // not hold is absent from the run (the entry is the whole run) — no query in either case.
    const cached = deps.cellCache?.get(measureId);
    if (cached && cached.runId === runId) {
      for (const s of subjects) {
        const cell = cached.cells.get(s) ?? null;
        out.set(livePairKey(s, measureId), cell ? { state: liveStateOfCell(cell), runId, cell } : { state: "UNKNOWN", runId, cell: null });
      }
      continue;
    }
    // The bounded read: only these subjects' rows from the winning run, in chunks the floor can bind.
    // Rows arrive evaluated_at ASC, so the LAST row per subject wins — the same rule the roster's
    // derivation applies.
    const ids = [...subjects];
    const cells = new Map<string, RosterCell>();
    for (let start = 0; start < ids.length; start += SUBJECT_CHUNK) {
      const rows = await deps.outcomeStore.listOutcomes(runId, { measureId, subjectIds: ids.slice(start, start + SUBJECT_CHUNK) });
      for (const o of rows) {
        if (o.measureId !== measureId) continue; // a fake that ignores the filter still yields the right cells
        cells.set(o.subjectId, cellFromOutcome(o, measureId, runId));
      }
    }
    for (const s of subjects) {
      const cell = cells.get(s) ?? null;
      out.set(livePairKey(s, measureId), cell ? { state: liveStateOfCell(cell), runId, cell } : { state: "UNKNOWN", runId, cell: null });
    }
  }
  return out;
}
