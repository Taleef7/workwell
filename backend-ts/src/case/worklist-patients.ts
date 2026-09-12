/**
 * The PATIENT-first work list (MM-2) — the same cases `/api/cases` serves, grouped by the person
 * rather than listed by the gap.
 *
 * **Why the grouping is the feature.** `/api/cases` is gap-centric: a patient with four open measures
 * is four rows, in four places in the list, and a staff member calling them works one row and leaves
 * three. The practice asked for the list they actually work — one row per patient, every open gap on
 * it — so a single call closes what a single call can close.
 *
 * **Grouping stays in JavaScript, and that is a proven constraint rather than a preference.** There is
 * no patients or providers table in Postgres — the directory is in memory — so a `GROUP BY` would have
 * nothing to join the panel facts against. What the database can do is return only the panel's cases,
 * which is what `CaseQuery.employeeIds` is for; the shared read model applies it before we get here.
 */
import type { CaseSummary } from "./case-read-models.ts";
import { priorityRankOf } from "./case-logic.ts";

/** One patient, with every open gap they have. */
export interface WorklistPatientRow {
  employeeId: string;
  employeeName: string;
  site: string;
  providerId: string | null;
  providerName: string | null;
  payer: string | null;
  payerName: string | null;
  /** Every gap in scope for this patient, highest priority first. */
  openGaps: WorklistGap[];
  gapCount: number;
  highestPriority: string;
  /**
   * The single assignee when EVERY gap agrees, `null` when every gap is unassigned, and the literal
   * `"mixed"` when they disagree.
   *
   * "Mixed" is a real answer rather than a rendering detail: a patient whose diabetes gap is one
   * person's and whose mammogram gap is another's has no owner, and showing either name would tell a
   * caller that someone is handling the rest when nobody is.
   */
  owner: string | null | "mixed";
  /** Every distinct assignee across the gaps, sorted — so a row can name them without re-deriving. */
  assignees: string[];
  /** The newest `updatedAt` across the gaps. */
  updatedAt: string;
}

export interface WorklistGap {
  caseId: string;
  measureId: string;
  measureName: string;
  status: string;
  outcomeStatus: string;
  priority: string;
  assignee: string | null;
  nextAction: string | null;
  evaluationPeriod: string;
  updatedAt: string;
  /**
   * True when this gap does NOT itself satisfy the assignee filter — it is shown because the patient
   * matched on another gap. Without it a row filtered to "assigned to me" would look like four of my
   * gaps when one is mine, which is the count-not-describing-the-list defect again.
   */
  otherAssignee?: boolean;
}

/** `assignee=me` resolves against the caller's own JWT `email` claim; `unassigned` is its own token. */
export const ASSIGNEE_ME = "me";
export const ASSIGNEE_UNASSIGNED = "unassigned";

/**
 * Group case summaries into patient rows.
 *
 * `assigneeFilter` is applied HERE rather than upstream, because the semantics are per-patient: a
 * patient with ≥1 gap assigned to X is kept, and then ALL of their gaps are returned with the others
 * marked `otherAssignee`. Filtering the cases first would hand back one gap and hide the three the
 * same phone call could close — which is the whole reason this list exists.
 */
export function groupIntoPatients(
  summaries: readonly CaseSummary[],
  options: { assignee?: string | null; viewerEmail?: string | null } = {},
): WorklistPatientRow[] {
  const wanted = normaliseAssignee(options.assignee, options.viewerEmail);
  const byPatient = new Map<string, CaseSummary[]>();
  for (const c of summaries) {
    const existing = byPatient.get(c.employeeId);
    if (existing) existing.push(c);
    else byPatient.set(c.employeeId, [c]);
  }

  const rows: WorklistPatientRow[] = [];
  for (const [employeeId, gaps] of byPatient) {
    if (wanted.kind !== "none" && !gaps.some((c) => gapMatchesAssignee(c, wanted))) continue;
    const sorted = [...gaps].sort(
      (a, b) => priorityRankOf(a.priority) - priorityRankOf(b.priority) || b.updatedAt.localeCompare(a.updatedAt) || a.caseId.localeCompare(b.caseId),
    );
    const first = sorted[0]!;
    const assignees = [...new Set(sorted.map((c) => c.assignee).filter((a): a is string => Boolean(a)))].sort();
    rows.push({
      employeeId,
      employeeName: first.employeeName,
      site: first.site,
      providerId: first.providerId,
      providerName: first.providerName,
      payer: first.payer,
      payerName: first.payerName,
      openGaps: sorted.map((c) => ({
        caseId: c.caseId,
        measureId: c.measureId,
        measureName: c.measureName,
        status: c.status,
        outcomeStatus: c.currentOutcomeStatus,
        priority: c.priority,
        assignee: c.assignee,
        nextAction: c.nextAction ?? null,
        evaluationPeriod: c.evaluationPeriod,
        updatedAt: c.updatedAt,
        // Marked only when an assignee filter is active AND this gap is not the reason the row is here.
        ...(wanted.kind !== "none" && !gapMatchesAssignee(c, wanted) ? { otherAssignee: true } : {}),
      })),
      gapCount: sorted.length,
      highestPriority: first.priority,
      // EVERY gap must agree. One gap assigned and one not is "mixed", not the assigned one's name:
      // the whole point of the field is to answer "is this patient handled?", and a patient with an
      // unassigned gap is not. The first version read `assignees.length === 1`, which counts only the
      // gaps that HAVE an owner and so reported a half-owned patient as owned.
      owner: ownerOf(sorted),
      assignees,
      updatedAt: sorted.reduce((newest, c) => (c.updatedAt > newest ? c.updatedAt : newest), sorted[0]!.updatedAt),
    });
  }

  // HIGH → MEDIUM → LOW, then most gaps, then name, then id. The last key is what makes the order
  // STABLE: without it two patients with the same priority, gap count and name page inconsistently,
  // and a row can appear on page 1 and page 2 of the same list or on neither.
  rows.sort(
    (a, b) =>
      priorityRankOf(a.highestPriority) - priorityRankOf(b.highestPriority) ||
      b.gapCount - a.gapCount ||
      a.employeeName.localeCompare(b.employeeName) ||
      a.employeeId.localeCompare(b.employeeId),
  );
  return rows;
}

/**
 * The assignee filter, resolved into an explicit variant.
 *
 * A variant rather than a sentinel string: the first version encoded "matches nobody" as an
 * unguessable magic value, which is both unreadable and one typo away from matching a real account.
 */
type AssigneeFilter =
  | { kind: "none" }
  | { kind: "unassigned" }
  | { kind: "email"; value: string }
  | { kind: "nobody" };

/**
 * `me` with no signed-in email resolves to `nobody` rather than to `none` — an unauthenticated caller
 * asking for their own list must get an empty one, not everyone's.
 */
function normaliseAssignee(raw: string | null | undefined, viewerEmail: string | null | undefined): AssigneeFilter {
  const token = raw?.trim();
  if (!token) return { kind: "none" };
  const lower = token.toLowerCase();
  if (lower === ASSIGNEE_UNASSIGNED) return { kind: "unassigned" };
  if (lower === ASSIGNEE_ME) {
    const email = viewerEmail?.trim().toLowerCase();
    return email ? { kind: "email", value: email } : { kind: "nobody" };
  }
  return { kind: "email", value: lower };
}

/**
 * The owner of a set of gaps: the one assignee they ALL share, `null` when none is assigned, and
 * `"mixed"` for every other case — including "some assigned to X, the rest to nobody".
 */
function ownerOf(gaps: readonly CaseSummary[]): string | null | "mixed" {
  const first = gaps[0]?.assignee ?? null;
  return gaps.every((c) => (c.assignee ?? null) === first) ? first : "mixed";
}

/** Case-insensitive, matching how the assign endpoint stores an account's own spelling. */
function gapMatchesAssignee(c: CaseSummary, wanted: AssigneeFilter): boolean {
  switch (wanted.kind) {
    case "none": return true;
    case "nobody": return false;
    case "unassigned": return !c.assignee;
    case "email": return (c.assignee ?? "").toLowerCase() === wanted.value;
  }
}
