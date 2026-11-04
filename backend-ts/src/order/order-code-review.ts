/**
 * An admin approves each order code (#640 item 2; owner decision 2026-11-04).
 *
 * A code becomes a card suggestion only once a terminology mapping for it is APPROVED
 * (`order/approved-codes.ts`). Until now a mapping could only be created, at any status. This module is the
 * one path that changes a mapping's status: every review is audited BEFORE the change (who, when, from, to,
 * note), and the change itself is a compare-and-set on the status the reviewer saw, so two admins acting at
 * once cannot both win.
 *
 * Two entry points:
 * - `reviewTerminologyMapping`: one mapping row by id (the Terminology table's row actions).
 * - `reviewOrderCode`: one national code from the order catalog (the Order codes panel). The approval is
 *   recorded on the code's own row (local = national). No row is seeded at boot: the row is created
 *   PROPOSED the first time an admin acts on the code, under a deterministic id, so a retry or a second
 *   admin finds the same row. Revoking rejects EVERY approved row for the code, each audited, so no clinic
 *   mapping keeps the code card-ready behind the admin's back.
 *
 * Nothing here decides compliance (AI_GUARDRAILS §1): an approved code only lets a card PROPOSE an order,
 * which a clinician accepts or not, and the gap closes only when CQL finds the result.
 */
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { TerminologyMappingRecord, ValueSetStore } from "../stores/value-set-store.ts";
import { isClinicCodeRow, standardKeyOf } from "./approved-codes.ts";
import { codeKey, isSuggestible, ordersForMeasure, type OrderOption } from "./order-catalog.ts";

export type ReviewDecision = "APPROVE" | "REJECT";
export const MAPPING_STATUSES = ["PROPOSED", "REVIEWED", "APPROVED", "REJECTED"] as const;

export class TerminologyReviewError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TerminologyReviewError";
  }
}

export interface ReviewDeps {
  valueSets: Pick<
    ValueSetStore,
    "listTerminologyMappings" | "getTerminologyMapping" | "updateTerminologyMappingStatus" | "createTerminologyMapping"
  >;
  events: Pick<CaseEventStore, "appendAudit">;
  now?: () => string;
}

const targetOf = (decision: ReviewDecision): "APPROVED" | "REJECTED" => (decision === "APPROVE" ? "APPROVED" : "REJECTED");

export function parseDecision(raw: unknown): ReviewDecision {
  const d = String(raw ?? "").trim().toUpperCase();
  if (d === "APPROVE" || d === "REJECT") return d;
  throw new TerminologyReviewError(400, "invalid_request", "decision must be APPROVE or REJECT");
}

/** Review one mapping row: audit first, then compare-and-set from the status read. */
export async function reviewTerminologyMapping(
  deps: ReviewDeps,
  id: string,
  decision: ReviewDecision,
  note: string | null,
  actor: string,
): Promise<TerminologyMappingRecord> {
  const current = await deps.valueSets.getTerminologyMapping(id);
  if (!current) throw new TerminologyReviewError(404, "not_found", "Terminology mapping not found.");
  return applyReview(deps, current, decision, note, actor);
}

async function applyReview(
  deps: ReviewDeps,
  current: TerminologyMappingRecord,
  decision: ReviewDecision,
  note: string | null,
  actor: string,
): Promise<TerminologyMappingRecord> {
  const to = targetOf(decision);
  if (current.mappingStatus === to) {
    throw new TerminologyReviewError(409, "unchanged", `This mapping is already ${to}.`);
  }
  if (to === "APPROVED" && isClinicCodeRow(current)) {
    // At most one clinic code rides on a national code, so a card never has to pick between two.
    const key = standardKeyOf(current);
    const other = (await deps.valueSets.listTerminologyMappings()).find(
      (m) => m.id !== current.id && m.mappingStatus === "APPROVED" && standardKeyOf(m) === key && isClinicCodeRow(m),
    );
    if (other) {
      throw new TerminologyReviewError(
        409,
        "clinic_code_already_approved",
        `${other.localSystem}|${other.localCode} is already the approved clinic code for ${key}. Reject it first.`,
      );
    }
  }
  const reviewedAt = (deps.now ?? (() => new Date().toISOString()))();
  // AUDIT BEFORE MUTATE: a lost race below leaves this event as an over-claim, never a silent change.
  await deps.events.appendAudit({
    eventType: "TERMINOLOGY_MAPPING_REVIEWED",
    entityType: "terminology_mapping",
    entityId: current.id,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: {
      mappingId: current.id,
      from: current.mappingStatus,
      to,
      note,
      reviewedAt,
      standardSystem: current.standardSystem,
      standardCode: current.standardCode,
      localSystem: current.localSystem,
      localCode: current.localCode,
    },
  });
  const updated = await deps.valueSets.updateTerminologyMappingStatus(current.id, current.mappingStatus, to, actor, reviewedAt);
  if (!updated) {
    throw new TerminologyReviewError(409, "conflict", "Another review changed this mapping first. Reload and try again.");
  }
  return updated;
}

// ---- the order catalog's codes ------------------------------------------------------------------------

export interface OrderCodeView {
  measureId: string;
  mode: "protocol" | "choice";
  key: string;
  system: string;
  code: string;
  display: string;
  interval: string | null;
  audience: string | null;
  note: string | null;
  suggestible: boolean;
  /** APPROVED when any mapping for the national code is approved; else the code's own row's status, else PROPOSED. */
  status: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** Every mapping row whose national code is this one (the code's own row and any clinic codes). */
  mappings: TerminologyMappingRecord[];
}

const isSelfRow = (m: TerminologyMappingRecord): boolean => m.localSystem === m.standardSystem && m.localCode === m.standardCode;

/** The deterministic id of a code's own approval row, so a retry or a second admin finds the same row. */
export const selfRowId = (system: string, code: string): string => `order-code:${system}|${code}`;

export function orderCodeViews(measureIds: readonly string[], mappings: readonly TerminologyMappingRecord[]): OrderCodeView[] {
  const out: OrderCodeView[] = [];
  for (const measureId of measureIds) {
    const orders = ordersForMeasure(measureId);
    if (!orders) continue;
    for (const o of orders.options) {
      const key = codeKey(o);
      const rows = mappings.filter((m) => standardKeyOf(m) === key);
      const approved = rows.filter((m) => m.mappingStatus === "APPROVED");
      const self = rows.find(isSelfRow) ?? null;
      const decided = approved.find(isSelfRow) ?? approved[0] ?? self;
      out.push({
        measureId,
        mode: orders.mode,
        key,
        system: o.system,
        code: o.code,
        display: o.display,
        interval: o.interval ?? null,
        audience: o.audience ?? null,
        note: o.note ?? null,
        suggestible: isSuggestible(o),
        status: approved.length > 0 ? "APPROVED" : (self?.mappingStatus ?? "PROPOSED"),
        reviewedBy: decided?.reviewedBy ?? null,
        reviewedAt: decided?.reviewedAt ?? null,
        mappings: rows,
      });
    }
  }
  return out;
}

function catalogOption(measureIds: readonly string[], system: string, code: string): OrderOption | null {
  for (const m of measureIds) {
    const found = ordersForMeasure(m)?.options.find((o) => o.system === system && o.code === code);
    if (found) return found;
  }
  return null;
}

/** The code's own row, created PROPOSED (audited first) the first time an admin acts on the code. */
async function ensureSelfRow(deps: ReviewDeps, option: OrderOption, actor: string): Promise<TerminologyMappingRecord> {
  const all = await deps.valueSets.listTerminologyMappings();
  const existing = all.find((m) => isSelfRow(m) && m.standardSystem === option.system && m.standardCode === option.code);
  if (existing) return existing;
  const id = selfRowId(option.system, option.code);
  await deps.events.appendAudit({
    eventType: "TERMINOLOGY_MAPPING_CREATED",
    entityType: "terminology_mapping",
    entityId: id,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: {
      mappingId: id,
      localCode: option.code,
      localSystem: option.system,
      standardCode: option.code,
      standardSystem: option.system,
      mappingStatus: "PROPOSED",
      mappingConfidence: null,
      source: "order-catalog",
    },
  });
  try {
    return await deps.valueSets.createTerminologyMapping({
      id,
      localCode: option.code,
      localDisplay: option.display,
      localSystem: option.system,
      standardCode: option.code,
      standardDisplay: option.display,
      standardSystem: option.system,
      mappingStatus: "PROPOSED",
      mappingConfidence: null,
      notes: "The order catalog's own code (#640).",
    });
  } catch (err) {
    // A second admin created it first: the unique key held, and the row is the one we wanted.
    const raced = await deps.valueSets.getTerminologyMapping(id);
    if (raced) return raced;
    throw err;
  }
}

/**
 * Approve or revoke one catalog code. Approve records the approval on the code's own row. Revoke (REJECT)
 * rejects every approved row for the code, each audited; with none approved it records the rejection on
 * the code's own row.
 */
export async function reviewOrderCode(
  deps: ReviewDeps,
  measureIds: readonly string[],
  system: string,
  code: string,
  decision: ReviewDecision,
  note: string | null,
  actor: string,
): Promise<TerminologyMappingRecord[]> {
  const option = catalogOption(measureIds, system, code);
  if (!option) throw new TerminologyReviewError(400, "not_in_catalog", `${system}|${code} is not an order code for any measure here.`);
  if (!isSuggestible(option)) {
    throw new TerminologyReviewError(400, "not_suggestible", `${option.display} is listed for the clinician and is never a card suggestion.`);
  }
  if (decision === "REJECT") {
    const approved = (await deps.valueSets.listTerminologyMappings()).filter(
      (m) => m.mappingStatus === "APPROVED" && m.standardSystem === system && m.standardCode === code,
    );
    if (approved.length > 0) {
      const out: TerminologyMappingRecord[] = [];
      for (const m of approved) out.push(await applyReview(deps, m, "REJECT", note, actor));
      return out;
    }
  }
  const self = await ensureSelfRow(deps, option, actor);
  return [await applyReview(deps, self, decision, note, actor)];
}
