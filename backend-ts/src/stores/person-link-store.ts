/**
 * Storage contract — `PersonLinkStore` (#187 E15 PR-2). A human-confirmed cross-system identity link:
 * an assertion that two source-system records ARE (`CONFIRMED`) or are NOT (`BROKEN`) the same person.
 * Overrides the auto `matchKey` grouping at read time (`resolvePeople`). One row per record-pair,
 * normalized so `(a) <= (b)` lexicographically → the pair is direction-independent and UNLINK re-upserts
 * the same pair to `BROKEN` (last write wins). Written only by the audited CASE_MANAGER/ADMIN reconcile
 * endpoint (match-don't-auto-merge). Descriptive only — never decides compliance (ADR-008/ADR-022).
 */

export type PersonLinkType = "CONFIRMED" | "BROKEN";

/** One source-system record reference. */
export interface PersonLinkRef {
  tenantId: string;
  externalId: string;
}

/** A persisted link between two records (already pair-normalized). */
export interface PersonLink {
  id: string;
  a: PersonLinkRef;
  b: PersonLinkRef;
  linkType: PersonLinkType;
  createdBy: string | null;
  createdAt: string;
}

export interface UpsertPersonLinkInput {
  a: PersonLinkRef;
  b: PersonLinkRef;
  linkType: PersonLinkType;
  createdBy: string | null;
}

/** Stable ordering key for a record ref. */
const refKey = (r: PersonLinkRef): string => `${r.tenantId}|${r.externalId}`;

/**
 * Normalize a pair so the lexicographically smaller ref is `a` — makes the (a,b) key
 * direction-independent, so CONFIRM(x,y) and UNLINK(y,x) target the same row.
 */
export function normalizePair(x: PersonLinkRef, y: PersonLinkRef): { a: PersonLinkRef; b: PersonLinkRef } {
  return refKey(x) <= refKey(y) ? { a: x, b: y } : { a: y, b: x };
}

export interface PersonLinkStore {
  /** All links (both CONFIRMED + BROKEN) — the read-time override set for `resolvePeople`. */
  listLinks(): Promise<PersonLink[]>;
  /**
   * Upsert a link, normalizing the pair first. Re-asserting the same pair (e.g. UNLINK after a
   * CONFIRM) overwrites in place — last write wins, never a duplicate. A no-op self-pair (a === b)
   * is rejected by the caller (reconcile route), not here.
   */
  upsertLink(input: UpsertPersonLinkInput): Promise<PersonLink>;
}
