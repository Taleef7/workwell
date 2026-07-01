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
import { normalizePair, type PersonLink, type PersonLinkRef } from "../stores/person-link-store.ts";

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
  // Trim BEFORE the truthiness check so a blank/whitespace-only id doesn't collapse to the shared
  // key `nid:` and false-group unrelated records — the "absent id ⇒ unique local key" invariant.
  const nid = rec.nationalId?.trim();
  return nid ? `nid:${nid.toLowerCase()}` : `local:${rec.tenantId}:${rec.externalId}`;
}

/**
 * Stable, reproducible person id from a match key (32-bit FNV-1a; no persistence needed across reseeds).
 * Collision risk is negligible at synthetic-directory scale; the real persisted/EMPI id (E15 PR-3)
 * replaces this hash, so a growing directory never relies on 32-bit uniqueness in production.
 */
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

const refKey = (r: PersonLinkRef): string => `${r.tenantId}|${r.externalId}`;
const recRef = (e: EmployeeProfile): PersonLinkRef => ({ tenantId: e.tenantId, externalId: e.externalId });
/** Unordered pair key for a normalized (a,b) pair — for the BROKEN-edge lookup. */
const pairKey = (a: PersonLinkRef, b: PersonLinkRef): string => `${refKey(a)}::${refKey(b)}`;

/** Minimal union-find over record ref-keys (smaller key wins, so component roots are deterministic). */
class UnionFind {
  private parent = new Map<string, string>();
  find(k: string): string {
    if (!this.parent.has(k)) this.parent.set(k, k);
    let root = k;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = k;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const [lo, hi] = ra < rb ? [ra, rb] : [rb, ra];
    this.parent.set(hi, lo);
  }
}

/**
 * Group the directory into resolved people. Auto-grouping is by match key; human-confirmed identity
 * `links` (E15 PR-2) then override it: a CONFIRMED pair unions two records (links them even without a
 * shared identifier), a BROKEN pair removes the direct auto/confirmed edge between exactly those two
 * records (undo a bad shared-id auto-match or a prior CONFIRM). `sources` are ordered ACTIVE-first then
 * by tenant; `displayName` comes from the ACTIVE source. Pure — pass a directory slice + links for
 * tests; defaults to the full synthetic directory + no links.
 *
 * NOTE (PR-2 scope): BROKEN removes the *direct* edge; two records still connected transitively via a
 * third record stay grouped. Sufficient for the 2-source cases; a fuller split model is future work.
 */
export function resolvePeople(
  directory: readonly EmployeeProfile[] = EMPLOYEES,
  links: readonly PersonLink[] = [],
): Person[] {
  const byRef = new Map<string, EmployeeProfile>();
  for (const e of directory) byRef.set(refKey(recRef(e)), e);

  const broken = new Set<string>();
  for (const l of links) {
    if (l.linkType === "BROKEN") {
      const { a, b } = normalizePair(l.a, l.b);
      broken.add(pairKey(a, b));
    }
  }

  const uf = new UnionFind();
  for (const e of directory) uf.find(refKey(recRef(e))); // seed singletons

  // Auto edges: within each match-key group, a star from the first record to the rest (skip BROKEN pairs).
  const keyGroups = new Map<string, EmployeeProfile[]>();
  for (const e of directory) {
    const k = matchKey(e);
    const g = keyGroups.get(k);
    if (g) g.push(e);
    else keyGroups.set(k, [e]);
  }
  for (const records of keyGroups.values()) {
    for (let i = 1; i < records.length; i++) {
      const { a, b } = normalizePair(recRef(records[0]!), recRef(records[i]!));
      if (!broken.has(pairKey(a, b))) uf.union(refKey(a), refKey(b));
    }
  }
  // CONFIRMED edges: only between two distinct records that both exist in the directory.
  for (const l of links) {
    if (l.linkType !== "CONFIRMED") continue;
    const ak = refKey(l.a);
    const bk = refKey(l.b);
    if (ak !== bk && byRef.has(ak) && byRef.has(bk)) uf.union(ak, bk);
  }

  // Collect components.
  const components = new Map<string, EmployeeProfile[]>();
  for (const e of directory) {
    const root = uf.find(refKey(recRef(e)));
    const g = components.get(root);
    if (g) g.push(e);
    else components.set(root, [e]);
  }

  const people: Person[] = [];
  for (const records of components.values()) {
    const sources = records
      .map(toSourceLink)
      .sort((a, b) =>
        a.status === b.status ? a.tenantId.localeCompare(b.tenantId) : a.status === "ACTIVE" ? -1 : 1,
      );
    const primary = sources[0]!;
    const distinctTenants = new Set(sources.map((s) => s.tenantId));
    // Deterministic id: the smallest record ref-key in the component (stable across reseeds + iteration
    // order, and UNIQUE per component — so a BROKEN split of a shared-id pair yields two distinct ids,
    // which a match-key-based canonical could not since both halves share the same match key).
    const canonical = records.map((r) => refKey(recRef(r))).sort()[0]!;
    const withId = records.find((r) => r.nationalId) ?? records[0]!;
    people.push({
      personId: personIdFor(canonical),
      displayName: primary.name,
      nationalId: withId.nationalId ?? null,
      dateOfBirth: withId.dateOfBirth ?? null,
      crossSystem: distinctTenants.size > 1,
      sources,
    });
  }
  return people;
}

/**
 * The DUPLICATE worklist — cross-system people who are **active in >1 system** (a genuine duplicate to
 * reconcile). A person with a PRIOR source is a MOBILITY case (they *moved*, one continuous history),
 * not a duplicate, so they are excluded here — the two E15 stories stay distinct for consumers.
 */
export function duplicateCandidates(
  directory: readonly EmployeeProfile[] = EMPLOYEES,
  links: readonly PersonLink[] = [],
): Person[] {
  return resolvePeople(directory, links).filter((p) => p.crossSystem && !p.sources.some((s) => s.status === "PRIOR"));
}

/** Resolve a single person by id (over the full or a provided directory + links). */
export function personById(
  personId: string,
  directory: readonly EmployeeProfile[] = EMPLOYEES,
  links: readonly PersonLink[] = [],
): Person | null {
  return resolvePeople(directory, links).find((p) => p.personId === personId) ?? null;
}
