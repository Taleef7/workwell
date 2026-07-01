/**
 * E15 PR-1 — cross-system person-identity resolution layer (pure, read-time). Resolves ONE person
 * across ≥1 WebChart source systems by a deterministic match key, so the demo can show Doug's
 * "same employee in two different systems" / duplicate / mobility story on top of the E13 multi-tenant
 * directory — with NO schema and NO new compliance authority.
 *
 * Conservative + auditable by design (ADR — identity resolves/groups, never decides compliance;
 * match-don't-auto-merge): a `Person` is a resolved *view* over source records; the CQL `Outcome Status`
 * per (subject, measure, system) is unchanged and authoritative (ADR-008). Identity only groups records
 * and follows a person across a move — it never recomputes compliance, and it never re-aggregates tenant
 * counts (E13's All = Σ tenants holds because each source record still belongs to exactly one tenant).
 *
 * The match key is deterministic on a shared national/MRN identifier (the seam where a real EMPI /
 * probabilistic matcher drops in later, E15 PR-3). A record with no shared identifier is its own
 * singleton person — nothing is grouped by accident.
 */
import { EMPLOYEES, tenantById, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";

export type SourceStatus = "ACTIVE" | "PRIOR";

/** One source-system record that belongs to a resolved person. */
export interface SourceLink {
  tenantId: string;
  tenantName: string;
  externalId: string;
  name: string;
  role: string;
  site: string;
  providerId: string;
  /** ACTIVE = the person's current system; PRIOR = a system they moved away from (mobility). */
  status: SourceStatus;
  /** For a PRIOR link: the date the person moved off this system (YYYY-MM-DD). */
  moveDate?: string;
}

/** A resolved person — a view over ≥1 `SourceLink`s. `crossSystem` ⇒ links span >1 tenant. */
export interface Person {
  personId: string;
  displayName: string;
  nationalId: string | null;
  dateOfBirth: string | null;
  crossSystem: boolean;
  sources: SourceLink[];
}

/**
 * Mobility overlay (E15 PR-1 seed) — records that are a PRIOR system for a person who moved. Keyed by
 * source `externalId`. Everything not listed is ACTIVE. This is the documented human-in-the-loop link
 * annotation (a move is a documented link with a direction + date, not a data move); the audited
 * write path to set it is E15 PR-2 (owner-gated). `emp-006` "Omar Siddiq" moved twh → ihn.
 */
export const MOBILITY_OVERLAY: Record<string, { status: SourceStatus; moveDate?: string }> = {
  "emp-006": { status: "PRIOR", moveDate: "2026-02-15" },
};

/** Fold case/whitespace/diacritics so equal humans normalize equal (display/validation aid). */
export function normalizeName(raw: string): string {
  return raw.normalize("NFKD").replace(/[̀-ͯ]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Deterministic candidate key. A shared national/MRN identifier groups records into one person; absent
 * one, the record keys uniquely on (tenant, externalId) so it never groups with anyone by accident.
 * This is the documented seam for a real EMPI / demographic matcher (E15 PR-3).
 */
export function matchKey(rec: Pick<EmployeeProfile, "tenantId" | "externalId" | "nationalId">): string {
  return rec.nationalId ? `nid:${rec.nationalId.trim().toLowerCase()}` : `local:${rec.tenantId}:${rec.externalId}`;
}

/** Stable, reproducible person id from a match key (FNV-1a; no persistence needed across reseeds). */
export function personIdFor(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `person-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function toSourceLink(e: EmployeeProfile): SourceLink {
  const mobility = MOBILITY_OVERLAY[e.externalId];
  return {
    tenantId: e.tenantId,
    tenantName: tenantById(e.tenantId)?.name ?? e.tenantId,
    externalId: e.externalId,
    name: e.name,
    role: e.role,
    site: e.site,
    providerId: e.providerId,
    status: mobility?.status ?? "ACTIVE",
    ...(mobility?.moveDate ? { moveDate: mobility.moveDate } : {}),
  };
}

/**
 * Group the directory into resolved people by match key. A person's `sources` are ordered ACTIVE-first
 * then by tenant (so the current system leads); `displayName` comes from the ACTIVE source. Pure —
 * pass a directory slice + mobility overlay for tests; defaults to the full synthetic directory.
 */
export function resolvePeople(
  directory: readonly EmployeeProfile[] = EMPLOYEES,
): Person[] {
  const groups = new Map<string, EmployeeProfile[]>();
  for (const e of directory) {
    const key = matchKey(e);
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(e);
  }

  const people: Person[] = [];
  for (const [key, records] of groups) {
    const sources = records
      .map(toSourceLink)
      .sort((a, b) =>
        a.status === b.status ? a.tenantId.localeCompare(b.tenantId) : a.status === "ACTIVE" ? -1 : 1,
      );
    const primary = sources[0]!;
    const distinctTenants = new Set(sources.map((s) => s.tenantId));
    people.push({
      personId: personIdFor(key),
      displayName: primary.name,
      nationalId: records[0]!.nationalId ?? null,
      dateOfBirth: records[0]!.dateOfBirth ?? null,
      crossSystem: distinctTenants.size > 1,
      sources,
    });
  }
  return people;
}

/** The cross-system / duplicate subset — people whose links span more than one WebChart system. */
export function duplicateCandidates(directory: readonly EmployeeProfile[] = EMPLOYEES): Person[] {
  return resolvePeople(directory).filter((p) => p.crossSystem);
}

/** Resolve a single person by id (over the full or a provided directory). */
export function personById(personId: string, directory: readonly EmployeeProfile[] = EMPLOYEES): Person | null {
  return resolvePeople(directory).find((p) => p.personId === personId) ?? null;
}
