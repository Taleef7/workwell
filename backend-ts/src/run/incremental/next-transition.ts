/**
 * `next_transition_at` — status-boundary caching for incremental evaluation (#263, Phase 2a; design §3
 * "Making it actually pay off for RECURRING measures").
 *
 * On unchanged data + unchanged logic, a data-hash cache only lets a *same-day* run skip re-evaluation
 * (the clock changes for everyone every day, even when data doesn't — so a naive cache is worthless for
 * recurring measures). `next_transition_at` is what buys the across-day saving: the earliest date a
 * subject's status can possibly change given unchanged data. A daily run may then reuse a cached outcome
 * as long as that date is still in the future.
 *
 * It is only *provably safe* to compute for measures whose status is a **monotone step function of "days
 * since the last qualifying event"** — the windowed-recency OSHA/wellness measures. For those, on
 * unchanged data `days` only increases and the status walks COMPLIANT → DUE_SOON → OVERDUE at fixed
 * thresholds, so the next boundary date is exact arithmetic. Measures whose status is NOT such a
 * function — `flu_vaccine` (seasonal "this season" logic), `cms122`/`cms125` (measurement-period
 * proportion) — are deliberately EXCLUDED: for them a stale copy could ship a wrong status when the
 * season/period rolls, so they get no across-day reuse (only the same-day hash tier).
 *
 * The thresholds live in the CQL, not the binding, so the `BOUNDARY_SAFE` table below is verified
 * against the real engine by `next-transition.golden.test.ts` (sweeps `daysSinceLastExam` and asserts
 * the CQL flips exactly at the tabled boundaries). If a measure's CQL ever drifts from its table entry,
 * that test fails — the table can never silently lie.
 *
 * Return contract (`string | null`, matching the nullable `eval_state.next_transition_at` column):
 *   - `null`        → the status is TERMINAL on unchanged data (OVERDUE; a no-exam MISSING_DATA; a
 *                     PERMANENT series complete-or-not). Reuse across days until data/logic changes.
 *   - a future date → reuse only while `newEvalDate < next_transition_at` (COMPLIANT/DUE_SOON windowed).
 *   - `evalDate`    → NOT eligible for across-day reuse (non-boundary-safe measure, or EXCLUDED whose
 *                     waiver expiry we don't model). Any later run fails `newEvalDate < evalDate`, so
 *                     only a same-day reuse (handled separately by the caller) can hit.
 *
 * Descriptive only (ADR-008): this decides *whether* to re-ask the CQL engine, never the answer.
 */
import { MEASURE_BINDINGS } from "../../engine/synthetic/measure-bindings.ts";

/**
 * Verified windowed-recency thresholds (days since last qualifying event):
 *   - `compliantMaxDays`: the largest `days` still COMPLIANT (COMPLIANT→DUE_SOON flips at +1).
 *   - `overdueMinDays`: the smallest `days` that is OVERDUE (DUE_SOON→OVERDUE; = complianceWindowDays+1).
 * Both are asserted against the live CQL in `next-transition.golden.test.ts`. Only measures listed here
 * get across-day reuse; every other RECURRING measure falls through to "re-evaluate daily" (safe).
 */
export const BOUNDARY_SAFE: Record<string, { compliantMaxDays: number; overdueMinDays: number }> = {
  audiogram: { compliantMaxDays: 335, overdueMinDays: 366 },
  hazwoper: { compliantMaxDays: 335, overdueMinDays: 366 },
  tb_surveillance: { compliantMaxDays: 330, overdueMinDays: 366 },
  hypertension: { compliantMaxDays: 335, overdueMinDays: 366 },
  cholesterol_ldl: { compliantMaxDays: 335, overdueMinDays: 366 },
  obesity_bmi: { compliantMaxDays: 335, overdueMinDays: 366 },
  diabetes_hba1c: { compliantMaxDays: 160, overdueMinDays: 181 },
  adult_immunization: { compliantMaxDays: 3590, overdueMinDays: 3651 },
};

interface ExpressionResult {
  define: string;
  result: unknown;
}

/** The CQL `"Days Since …"` value from stored evidence, or null if absent/non-numeric. */
export function daysSinceFromEvidence(evidence: unknown): number | null {
  const ers = (evidence as { expressionResults?: unknown } | null)?.expressionResults;
  if (!Array.isArray(ers)) return null;
  const d = (ers as ExpressionResult[]).find((r) => r && typeof r === "object" && /^days since/i.test(r.define));
  return typeof d?.result === "number" ? d.result : null;
}

const addDays = (isoDate: string, days: number): string => {
  const t = Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

/**
 * Compute `next_transition_at` for a just-evaluated outcome (see the return contract above). `evalDate`
 * is the run's evaluation date (`YYYY-MM-DD`); `status` is the CQL `Outcome Status`; `evidence` is the
 * outcome's evidence (used to read the current `"Days Since"`).
 */
export function computeNextTransition(measureId: string, status: string, evidence: unknown, evalDate: string): string | null {
  const binding = MEASURE_BINDINGS[measureId];
  const day = evalDate.slice(0, 10);

  // PERMANENT (series-completion): date-invariant. Complete stays complete; incomplete stays incomplete
  // until a new dose (a DATA change caught by the hash). EXCLUDED (contraindication) we treat as
  // not-eligible, conservatively — a Condition could carry an abatement we don't model.
  if (binding?.complianceClass === "PERMANENT") {
    return status === "EXCLUDED" ? day : null;
  }

  const thresholds = BOUNDARY_SAFE[measureId];
  if (!thresholds) return day; // non-boundary-safe (flu/cms/unknown) → no across-day reuse

  const days = daysSinceFromEvidence(evidence);
  switch (status) {
    case "OVERDUE":
      return null; // terminal: days only grows, stays OVERDUE
    case "MISSING_DATA":
      return null; // no qualifying event; a new one is a data change
    case "EXCLUDED":
      return day; // waiver expiry is date-dependent and not modeled — re-evaluate
    case "COMPLIANT":
      if (days === null) return day; // can't reason without the day-count — be safe
      return addDays(day, thresholds.compliantMaxDays + 1 - days); // flips to DUE_SOON at compliantMaxDays+1
    case "DUE_SOON":
      if (days === null) return day;
      return addDays(day, thresholds.overdueMinDays - days); // flips to OVERDUE at overdueMinDays
    default:
      return day;
  }
}
