/**
 * Waiver service (#108 admin write CRUD — waivers) — TS port of WaiverService.listWaivers /
 * grantWaiver. The store holds raw rows with TEXT employee/measure ids; this service resolves the
 * display fields at read time (employee name/site from the synthetic directory, measure name/version
 * from the measure store) and computes `expired`, matching Java's read JOIN. Backs Admin → Waivers.
 *
 * Granting a waiver is a record-keeping action here (the synthetic evaluation engine derives EXCLUDED
 * from its seeded distribution, not from this table) — so a grant does not retroactively change
 * outcomes, same as the admin surface in the Java app.
 */
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { MeasureStore } from "../stores/measure-store.ts";
import type { WaiverQuery, WaiverRow, WaiverStore } from "../stores/waiver-store.ts";
import { employeeById } from "../config/deployment-profile.ts";

export class WaiverError extends Error {}

export interface WaiverRecord {
  waiverId: string;
  employeeExternalId: string;
  employeeName: string;
  site: string;
  measureId: string;
  measureName: string;
  measureVersionId: string;
  measureVersion: string;
  exclusionReason: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
  notes: string | null;
  active: boolean;
  expired: boolean;
}

export interface WaiverDeps {
  waivers: WaiverStore;
  measures: MeasureStore;
  events: Pick<CaseEventStore, "appendAudit">;
}

/** Resolve a raw row into the display record (employee + measure joins + computed `expired`). */
async function toRecord(deps: WaiverDeps, row: WaiverRow, now: number): Promise<WaiverRecord> {
  const emp = employeeById(row.employeeExternalId);
  const mv = (await deps.measures.getByVersionId(row.measureVersionId)) ?? (await deps.measures.getLatest(row.measureId));
  const expired = row.active && row.expiresAt != null && new Date(row.expiresAt).getTime() < now;
  return {
    waiverId: row.id,
    employeeExternalId: row.employeeExternalId,
    employeeName: emp?.name ?? row.employeeExternalId,
    site: emp?.site ?? "",
    measureId: row.measureId,
    measureName: mv?.name ?? row.measureId,
    measureVersionId: row.measureVersionId,
    measureVersion: mv?.version ?? "",
    exclusionReason: row.exclusionReason,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
    expiresAt: row.expiresAt,
    notes: row.notes,
    active: row.active,
    expired,
  };
}

export interface ListWaiversFilter extends WaiverQuery {
  /** Employee site (resolved field) — filtered in JS since the store has no site column. */
  site?: string | null;
}

export async function listWaivers(deps: WaiverDeps, filter: ListWaiversFilter): Promise<WaiverRecord[]> {
  const rows = await deps.waivers.list({
    measureId: filter.measureId,
    active: filter.active,
    expiresAfter: filter.expiresAfter,
    expiresBefore: filter.expiresBefore,
  });
  const now = Date.now();
  const records = await Promise.all(rows.map((r) => toRecord(deps, r, now)));
  const site = filter.site?.trim();
  return site ? records.filter((r) => r.site.toLowerCase() === site.toLowerCase()) : records;
}

export interface GrantWaiverRequest {
  employeeExternalId: string;
  measureId: string;
  exclusionReason: string;
  expiresAt: string | null;
  notes: string | null;
  active: boolean | null;
}

export async function grantWaiver(deps: WaiverDeps, req: GrantWaiverRequest, actor: string): Promise<WaiverRecord> {
  const employeeExternalId = req.employeeExternalId?.trim();
  if (!employeeExternalId) throw new WaiverError("employeeExternalId is required");
  if (!req.measureId?.trim()) throw new WaiverError("measureId is required");
  if (!req.exclusionReason?.trim()) throw new WaiverError("exclusionReason is required");
  if (!employeeById(employeeExternalId)) throw new WaiverError(`Employee not found: ${employeeExternalId}`);

  const measure = await deps.measures.getLatest(req.measureId.trim());
  if (!measure) throw new WaiverError(`Measure not found: ${req.measureId}`);

  // Reject an unparsable expiresAt rather than silently dropping it.
  if (req.expiresAt != null && req.expiresAt.trim() !== "" && Number.isNaN(new Date(req.expiresAt).getTime())) {
    throw new WaiverError("expiresAt is not a valid timestamp");
  }
  const expiresAt = req.expiresAt && req.expiresAt.trim() !== "" ? new Date(req.expiresAt).toISOString() : null;

  // AUDIT BEFORE MUTATE (#598). The id is minted here rather than by the insert, which is what makes
  // that possible — the same shape `createTerminologyMapping` uses.
  const waiverId = crypto.randomUUID();
  // The values the event reports, resolved BEFORE either write — they were read off the inserted row,
  // which is exactly what forced the audit to come second. Each is the input the insert is about to
  // store, so the event describes the same waiver the row will.
  const exclusionReason = req.exclusionReason.trim();
  const active = req.active == null ? true : req.active;
  await deps.events.appendAudit({
    eventType: "WAIVER_GRANTED",
    entityType: "waiver",
    entityId: waiverId,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: measure.versionId,
    payload: { waiverId, employeeExternalId, measureId: measure.measureId, exclusionReason, active },
  });
  const row = await deps.waivers.insert({
    id: waiverId,
    employeeExternalId,
    measureId: measure.measureId,
    measureVersionId: measure.versionId,
    exclusionReason,
    grantedBy: actor,
    expiresAt,
    notes: req.notes && req.notes.trim() !== "" ? req.notes.trim() : null,
    active,
  });

  return toRecord(deps, row, Date.now());
}
