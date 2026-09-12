/**
 * Storage contract — `PanelStore` (MM-2 PR 2, ADR-080). The provider-panel mapping: which staff
 * account works the patients of which provider.
 *
 * The pilot group already works this way and said so twice — their staff are assigned to specific
 * providers, and the same patient lives in one provider's panel, so one person closes all of that
 * patient's gaps rather than five people touching five measures. Until this table existed, that
 * arrangement lived only in their heads: every case a nightly run opened arrived unassigned, and
 * somebody had to re-apply the same mapping by hand every morning.
 *
 * **One assignee per provider, many providers per assignee.** That is the direction the practice
 * works in (nine staff, forty-odd providers), and it is why the primary key is the provider.
 * Coverage — someone else working a panel for a week — is the per-case override and bulk assign, not
 * a second owner column: a case has exactly one assignee, and who that is must be unambiguous.
 *
 * **A provider with no row is a queue, not an error.** An unmapped panel and a patient whose provider
 * nobody owns both stay visible as unassigned work. Nothing here may cause a case to become
 * invisible; the mapping decides who work lands on, never whether it exists.
 *
 * Assignment only. A panel is not an attributed population, not a denominator, and not a claim about
 * who CMS or an ACO considers responsible for a patient (ADR-080 d6).
 */

export interface PanelAssignment {
  /** The provider's external id (`maui-prov-012`), as the directory records it — never a display name. */
  providerId: string;
  /** An assignable account's own spelling, resolved by the route before it reaches the store. */
  assignee: string;
  /** The account that first mapped this provider; kept across later re-assignments. */
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPanelAssignmentInput {
  providerId: string;
  assignee: string;
  /** The authenticated actor making the change; recorded as `created_by` on first mapping only. */
  actor: string | null;
  /** Wall-clock ISO timestamp, passed in so a caller's batch shares one. */
  now: string;
}

export interface PanelStore {
  /**
   * Every mapping, ordered by provider id.
   *
   * Read WHOLE rather than filtered because both callers want the whole thing: the run pipeline builds
   * one map per run, and the panels tab lists every provider. The table has one row per provider —
   * about forty at the pilot — so "load it all" is the cheap answer as well as the simple one.
   */
  listAll(): Promise<PanelAssignment[]>;
  /** The mapping for one provider, or null when nobody owns that panel. */
  getPanelAssignment(providerId: string): Promise<PanelAssignment | null>;
  /**
   * Map a provider to an assignee, replacing any existing mapping.
   *
   * `created_by` and `created_at` survive a re-assignment: they record who first mapped the panel,
   * which is a different question from who owns it now, and losing it would make the ledger the only
   * place the panel's history exists.
   */
  upsertPanelAssignment(input: UpsertPanelAssignmentInput): Promise<PanelAssignment>;
  /**
   * Remove a provider's mapping, returning the row that was removed (or null if there was none).
   *
   * Returns the row rather than a boolean because the caller audits what it removed — the previous
   * assignee is the fact worth recording, and re-reading it after the delete is impossible.
   *
   * **Cases keep their assignee.** Un-mapping a panel is a statement about who owns FUTURE work, not
   * an instruction to drop what is already being worked; bulk assign is the tool for moving open
   * cases, and it is audited per case (ADR-080 d4).
   */
  removePanelAssignment(providerId: string): Promise<PanelAssignment | null>;
}
