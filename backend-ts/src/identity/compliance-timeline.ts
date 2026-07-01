/**
 * E15 PR-1 — merged cross-system compliance timeline. The union of every linked source record's
 * outcomes for a resolved `Person`, time-ordered (newest first) and tagged with the system each came
 * from — so a move reads as "continuous history, system changes at date X" rather than restarting at
 * the new system. Pure: the caller supplies each source's outcomes (reusing the existing per-subject
 * `outcomes` reads); this only groups + annotates. Descriptive only — never sets `Outcome Status`.
 */
import type { Person, SourceStatus } from "./identity-model.ts";

/** Minimal outcome shape the timeline needs (a projection of an `outcomes` row). */
export interface TimelineOutcome {
  measureId: string;
  measureName?: string;
  status: string;
  evaluatedAt: string; // ISO-8601
}

export interface TimelineEntry extends TimelineOutcome {
  tenantId: string;
  tenantName: string;
  externalId: string;
  sourceStatus: SourceStatus;
}

/** A documented move annotation (mobility banner) when a person has a PRIOR + an ACTIVE system. */
export interface MoveAnnotation {
  fromTenantName: string;
  toTenantName: string;
  date: string | null;
}

export interface MergedTimeline {
  entries: TimelineEntry[];
  move: MoveAnnotation | null;
}

/**
 * Build the person's unified timeline from per-source outcomes. `outcomesByExternalId` maps each
 * source `externalId` → its outcomes; missing/empty sources simply contribute nothing.
 */
export function mergedComplianceTimeline(
  person: Person,
  outcomesByExternalId: Map<string, TimelineOutcome[]>,
): MergedTimeline {
  const entries: TimelineEntry[] = [];
  for (const src of person.sources) {
    for (const o of outcomesByExternalId.get(src.externalId) ?? []) {
      entries.push({
        ...o,
        tenantId: src.tenantId,
        tenantName: src.tenantName,
        externalId: src.externalId,
        sourceStatus: src.status,
      });
    }
  }
  // Newest first; ties broken by tenant then measure for stable ordering.
  entries.sort(
    (a, b) =>
      b.evaluatedAt.localeCompare(a.evaluatedAt) ||
      a.tenantName.localeCompare(b.tenantName) ||
      a.measureId.localeCompare(b.measureId),
  );

  const prior = person.sources.find((s) => s.status === "PRIOR");
  const active = person.sources.find((s) => s.status === "ACTIVE");
  const move: MoveAnnotation | null =
    prior && active ? { fromTenantName: prior.tenantName, toTenantName: active.tenantName, date: prior.moveDate ?? null } : null;

  return { entries, move };
}
