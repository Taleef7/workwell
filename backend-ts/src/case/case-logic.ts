/**
 * Case disposition logic (#107) — pure port of the routing in
 * com.workwell.caseflow.CaseFlowService: an outcome maps to a case disposition,
 * a priority, and a next-action hint.
 */

export type CaseDisposition = "OPEN" | "EXCLUDED" | "RESOLVE";

/**
 * The non-terminal (unresolved, still-actionable) case statuses. `IN_PROGRESS` counts as active — an
 * operator working a case does not make it resolved — so every "active/open case" rollup must include
 * it, or a population run that reconfirms an IN_PROGRESS case (now preserved, not clobbered to OPEN by
 * the H2 state-aware upsert) would silently drop out of the count.
 */
export const ACTIVE_CASE_STATUSES = ["OPEN", "IN_PROGRESS"] as const;

/** EXCLUDED → an excluded case; DUE_SOON/OVERDUE/MISSING_DATA → an open case; else resolve. */
export function dispositionFor(outcomeStatus: string): CaseDisposition {
  if (outcomeStatus === "EXCLUDED") return "EXCLUDED";
  if (outcomeStatus === "OVERDUE" || outcomeStatus === "DUE_SOON" || outcomeStatus === "MISSING_DATA") return "OPEN";
  return "RESOLVE"; // COMPLIANT (and anything else) closes an existing case
}

export function priorityFor(outcomeStatus: string): "HIGH" | "MEDIUM" | "LOW" {
  switch (outcomeStatus) {
    case "OVERDUE":
      return "HIGH";
    case "MISSING_DATA":
    case "DUE_SOON":
      return "MEDIUM";
    default:
      return "LOW";
  }
}

/**
 * Per-measure next-action noun, keyed by measureId — covers every runnable measure (M1 fix). Any
 * unmapped measure falls back to a generic, measure-agnostic noun, never the old "audiogram" default
 * that mislabeled the 13 non-OSHA measures. "annual" was dropped from the DUE_SOON phrasing because
 * the compliance window varies (biannual HbA1c, 27-month mammogram, 10-year Td/Tdap, permanent series).
 */
export const NEXT_ACTION_LABELS: Record<string, string> = {
  audiogram: "audiogram",
  hazwoper: "HAZWOPER surveillance",
  tb_surveillance: "TB screening",
  flu_vaccine: "flu vaccine",
  hypertension: "blood pressure screening",
  diabetes_hba1c: "HbA1c test",
  obesity_bmi: "BMI screening",
  cholesterol_ldl: "cholesterol (LDL) screening",
  adult_immunization: "Td/Tdap immunization",
  mmr: "MMR immunization",
  varicella: "varicella immunization",
  hepatitis_b_vaccination_series: "hepatitis B vaccination",
  cms125: "mammogram",
  cms122: "HbA1c test",
};

export function nextActionFor(outcomeStatus: string, measureId: string): string {
  const label = NEXT_ACTION_LABELS[measureId] ?? "compliance assessment";
  switch (outcomeStatus) {
    case "OVERDUE":
      return `Escalate ${label} follow-up immediately.`;
    case "MISSING_DATA":
      return `Collect the missing ${label} documentation.`;
    case "DUE_SOON":
      return `Schedule the ${label} before the due date.`;
    case "EXCLUDED":
      return "Review the active waiver and rerun before it expires.";
    default:
      return "No action required.";
  }
}

/**
 * State-aware case-upsert planning (Fable H1/H2). A pure decision shared by the SQLite floor and
 * Postgres ceiling so the two adapters stay in lockstep and the logic is unit-testable. Replaces the
 * old blanket `ON CONFLICT DO UPDATE SET status = excluded.status`, which (a) flipped operator-set
 * IN_PROGRESS cases back to OPEN, (b) silently reopened human-closed cases while leaving stale
 * closed_* residue, and (c) drifted closed_at forward on every subsequent compliant run.
 *
 * Rules:
 *  - COMPLIANT resolves an OPEN/IN_PROGRESS case (system closure, `closed_by = NULL`); an
 *    already-terminal case is a no-op (no closed_at drift, no audit).
 *  - A non-compliant outcome opens a new case, refreshes an existing OPEN/IN_PROGRESS one
 *    (preserving IN_PROGRESS), and — respecting manual closure — reopens a case the system itself
 *    closed (`closed_by IS NULL`: either a prior auto-resolve, status RESOLVED, or an auto-exclusion,
 *    status EXCLUDED, whose waiver has since lapsed); a human-closed case (`closed_by` set) is left
 *    closed, so reopening it stays an explicit operator action.
 *  - EXCLUDED transitions a non-excluded case to EXCLUDED; an already-excluded case is a no-op.
 *
 * `disposition` drives the pipeline's audit emission: CREATED/UPDATED/REOPENED/RESOLVED/EXCLUDED
 * write an audit event; UNCHANGED (an idempotent re-confirm of the same open outcome) refreshes the
 * row's last_run_id/updated_at but writes NO audit event — so a nightly run re-confirming hundreds of
 * still-overdue cases records one RUN_COMPLETED, not hundreds of noise events.
 */
export type CaseUpsertDisposition = "CREATED" | "UPDATED" | "REOPENED" | "RESOLVED" | "EXCLUDED" | "UNCHANGED";

export interface ExistingCaseState {
  status: string;
  currentOutcomeStatus: string;
  closedBy: string | null;
}

export interface CaseUpsertPlan {
  op: "insert" | "update" | "noop";
  /** Present iff `op !== "noop"`. */
  disposition?: CaseUpsertDisposition;
  /** Resulting status for insert/update. */
  status?: string;
  closedAt?: string | null;
  closedReason?: string | null;
  closedBy?: string | null;
}

/** Decide how a case should be upserted from one outcome, given the existing row (or null). Pure. */
export function planCaseUpsert(existing: ExistingCaseState | null, outcomeStatus: string, now: string): CaseUpsertPlan {
  const disposition = dispositionFor(outcomeStatus);

  if (!existing) {
    if (disposition === "RESOLVE") return { op: "noop" }; // COMPLIANT with no case → nothing to do
    if (disposition === "EXCLUDED")
      return { op: "insert", disposition: "EXCLUDED", status: "EXCLUDED", closedAt: now, closedReason: "EXCLUDED", closedBy: null };
    return { op: "insert", disposition: "CREATED", status: "OPEN", closedAt: null, closedReason: null, closedBy: null };
  }

  const s = existing.status;

  if (disposition === "RESOLVE") {
    if (s === "OPEN" || s === "IN_PROGRESS")
      return { op: "update", disposition: "RESOLVED", status: "RESOLVED", closedAt: now, closedReason: "AUTO_RESOLVED", closedBy: null };
    return { op: "noop" }; // already terminal — no closed_at drift, no audit
  }

  if (disposition === "EXCLUDED") {
    if (s === "EXCLUDED") return { op: "noop" };
    return { op: "update", disposition: "EXCLUDED", status: "EXCLUDED", closedAt: now, closedReason: "EXCLUDED", closedBy: null };
  }

  // Non-compliant (DUE_SOON / OVERDUE / MISSING_DATA)
  if (s === "OPEN" || s === "IN_PROGRESS") {
    // Preserve IN_PROGRESS; only audit when the outcome actually changed (e.g. DUE_SOON → OVERDUE).
    const changed = existing.currentOutcomeStatus !== outcomeStatus;
    return { op: "update", disposition: changed ? "UPDATED" : "UNCHANGED", status: s, closedAt: null, closedReason: null, closedBy: null };
  }
  // Terminal (RESOLVED / EXCLUDED): respect a human closure; reopen any system closure now that CQL
  // says the subject is actionable again. A system auto-resolve (a prior COMPLIANT run) OR a system
  // exclusion (a waiver that has since been removed/expired, so CQL no longer returns EXCLUDED) both
  // reopen — leaving a system-excluded case closed with a stale OVERDUE outcome and no audit event was
  // the bug (Codex P2). Only a human closure (`closed_by` set) stays closed.
  if (existing.closedBy != null) return { op: "noop" };
  return { op: "update", disposition: "REOPENED", status: "OPEN", closedAt: null, closedReason: null, closedBy: null };
}
