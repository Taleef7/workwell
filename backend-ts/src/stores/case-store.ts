/**
 * CaseStore contract (#107 cases module). Cases are upserted from a run's outcomes;
 * the idempotency invariant — a rerun never creates a duplicate — is enforced by the
 * UNIQUE key (employee_id, measure_id, evaluation_period) in the adapters.
 */
export interface CaseRecord {
  id: string;
  employeeId: string;
  measureId: string;
  evaluationPeriod: string;
  status: string; // OPEN | RESOLVED | EXCLUDED
  priority: string; // HIGH | MEDIUM | LOW
  assignee: string | null;
  nextAction: string | null;
  /** Who wrote `nextAction`: 'SYSTEM' (the wording table) or 'OPERATOR' (a person's instruction). */
  nextActionSource: string;
  /**
   * Who chose `assignee`: 'PANEL' (the provider-panel mapping) or 'OPERATOR' (a person). `null` when
   * unassigned, and also on a row written before this column existed — a null source that HAS an
   * assignee is read as operator-owned, the reading that declines to move the row (ADR-080 d1).
   */
  assignmentSource: string | null;
  currentOutcomeStatus: string;
  lastRunId: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedReason: string | null;
  closedBy: string | null;
}

export interface UpsertCaseInput {
  runId: string;
  subjectId: string;
  measureId: string;
  evaluationPeriod: string;
  outcomeStatus: string;
  /**
   * The outcome's `evidence_json`, when the caller has it. Read only to word `next_action` for a
   * multi-rate measure (ADR-074: the rate the subject missed); never persisted by the case store.
   */
  evidence?: unknown;
  /**
   * The official logic evaluated this subject and found them OUTSIDE the initial population (ADR-078).
   * Never creates a case; resolves an active one with `closed_reason='OUT_OF_POPULATION'` (a system
   * closure). The run pipeline sets it from the executor's own `inInitialPopulation: false`, and only
   * for an OFFICIALLY routed measure; the persisted status stays MISSING_DATA.
   */
  outOfPopulation?: boolean;
  /**
   * The provider-panel owner for this subject, applied ON THE INSERT BRANCH ONLY (ADR-080 d2): a case
   * this run OPENS is created already assigned to whoever works that provider's panel, so the nightly
   * run hands the practice work that is already on somebody rather than a pile to re-distribute by
   * hand each morning. The row records `assignment_source = 'PANEL'`.
   *
   * An existing case is never touched by this — not on an update, not on a reopen. A reopen is within
   * the same compliance cycle, so the case someone was already working keeps its owner; a NEW cycle is
   * an insert and picks up whatever the map says then.
   *
   * Named `panelAssignee` rather than `assignee` deliberately: there is no way to route an operator's
   * choice through the insert path and have it recorded as anything but a panel assignment, because
   * the field itself names where the value came from.
   */
  panelAssignee?: string;
}

/**
 * The result of an idempotent case upsert — the affected case row PLUS what the upsert actually did,
 * so the run pipeline can emit the matching audit event (Fable H1). A CaseRecord SUPERSET, so every
 * existing caller that uses the return as a CaseRecord is unaffected.
 */
export interface UpsertedCase extends CaseRecord {
  disposition: import("../case/case-logic.ts").CaseUpsertDisposition;
}

/** One case to assign, paired with the state the caller read on it (`null` = unassigned/unknown). */
export interface CaseAssignExpectation {
  id: string;
  expectedAssignee: string | null;
  /**
   * The `assignmentSource` the caller read, when its DECISION depended on it.
   *
   * The panel backfill's rule reads BOTH columns — it moves a case because the assignee is X *and*
   * because a panel put it there (ADR-080 d3) — so guarding only the assignee lets a write that
   * changed only the provenance through. Concretely: the backfill reads `Alice/PANEL` and plans to
   * move it; an operator then re-asserts Alice deliberately, making it `Alice/OPERATOR`; the assignee
   * still matches, so the row is moved and the person's decision is overwritten by the very rule
   * that exists to protect it.
   *
   * `undefined` means the caller did not read it and does not care — the operator-facing bulk assign,
   * whose decision is about the assignee alone. This is the same "guard the whole plan input"
   * correction the batched upsert already carries.
   */
  expectedSource?: string | null;
}

export interface CaseQuery {
  /** Concrete statuses to include (e.g. ["OPEN"]); omit for all. */
  statuses?: string[];
  /**
   * One subject's cases. The patient profile page wanted exactly this and had no way to ask for it, so
   * it read `listCases({ limit: 100000 })` — every case in the tenant — and filtered in JavaScript,
   * scaling with the tenant's case count rather than with the one patient being looked at.
   */
  employeeId?: string;
  /**
   * A SET of subjects — the panel pre-filter (MM-2).
   *
   * The panel filters (PCP, payer, site) are DIRECTORY joins: there is no patients table in Postgres,
   * so they cannot become SQL predicates. Without this, working a 150-case panel meant loading every
   * case in the practice and discarding ~99% of them in JavaScript. The caller resolves the matching
   * subject ids from the in-memory directory FIRST and passes them here, so the database returns the
   * panel instead of the practice.
   *
   * An EMPTY array is a real constraint meaning "no subject matches", not an absent filter — a panel
   * whose PCP has nobody must return nothing rather than everybody. `undefined` is the absent filter.
   * Composes with `employeeId` (both apply) rather than replacing it.
   */
  employeeIds?: readonly string[];
  measureId?: string;
  priority?: string;
  assignee?: string;
  /**
   * Compliance-cycle filter (#150 H1):
   *   - omitted / `undefined` / `"all"` / `"current"` → no period filter (every cycle).
   *   - a concrete `YYYY-MM-DD` anchor → exactly that cycle.
   * The worklist's current-cycle default is computed per-measure from today + the measure's
   * cadence in the route (date-driven, Codex P2), not by the store — `"current"` is accepted
   * here as a no-op so a caller forwarding it doesn't accidentally match a literal period.
   */
  period?: string;
  /**
   * Who closed the case (#569): `staff` = a terminal row with `closed_by` set (a person closed it —
   * manually, or by rerun-to-verify); `system` = a terminal row with `closed_by` NULL (the run closed
   * it). Implements the WHOLE classification, not half of it: `closed_by IS NULL` alone would match
   * every OPEN row, so both values also require `status NOT IN` the active set, and an active row
   * matches neither. Composes with `statuses`; the closure kind is the same rule `closureKindOf`
   * applies in memory (`case/case-logic.ts`), so a row this returns is one that function calls STAFF.
   */
  closure?: "staff" | "system";
  /**
   * The work list's CURRENT-CYCLE default, expressed as SQL (#561).
   *
   * Each measure's current cycle is `bucketPeriodForMeasure(measureId, today)` — a per-measure answer,
   * because cadences differ — so it cannot be one `evaluation_period = $1`. The caller computes the
   * pair for every measure it knows and passes them here; a row matches when its own measure's pair
   * matches. `cyclesFallbackPeriod` is the anchor for a measure the caller did NOT name (a slug from a
   * deployment whose registry this process does not carry), which is the same 365-day fallback the
   * in-memory filter applies — so an unknown measure is filtered, not silently admitted.
   *
   * Absent means no cycle filter, exactly as before. It composes with `period`, which stays the
   * explicit single-cycle filter; a caller sets one or the other, never both.
   */
  cycles?: ReadonlyArray<{ measureId: string; evaluationPeriod: string }>;
  cyclesFallbackPeriod?: string;
  /** `current_outcome_status`, compared case-insensitively — the frozen column, not the live answer. */
  outcome?: string;
  /**
   * Whether the case has any `OUTREACH_SENT` action. `none` is the dashboard badge's filter and the
   * reason it is here: answering it in JavaScript means counting outreach for every row first.
   */
  outreach?: "none" | "any";
  /** `created_at`, compared by UTC DAY and INCLUSIVE at both ends, as the in-memory filter does. */
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
  offset?: number;
}

/** One page of cases AND the exact size of the filtered set, from one statement. */
export interface CasePage {
  total: number;
  rows: CaseRecord[];
}

/**
 * Mutable case fields an operator action may patch (assign/escalate/outreach/rerun).
 * A nullable field set to `null` clears that column; omit a field to leave it unchanged.
 */
export interface CasePatch {
  status?: string;
  priority?: string;
  assignee?: string | null;
  /**
   * Setting this through `patchCase` marks the action OPERATOR-owned, so the nightly upsert stops
   * overwriting it while the outcome it was written about holds (`planNextAction`). That is the whole
   * boundary: the system writes `next_action` through `upsertFromOutcome`, people write it through
   * here. A caller that computes an action the way a run would should say so with `nextActionSource`.
   */
  nextAction?: string;
  nextActionSource?: "SYSTEM" | "OPERATOR";
  /**
   * Who chose `assignee`. Setting `assignee` through `patchCase` defaults this to OPERATOR, because
   * this is the operator surface — the case page, the patient page, the single-case assign route. A
   * panel backfill goes through `assignCases`, which takes its source explicitly. Clearing the
   * assignee clears the source with it: nobody chose nobody.
   */
  assignmentSource?: "PANEL" | "OPERATOR" | null;
  currentOutcomeStatus?: string;
  lastRunId?: string;
  closedAt?: string | null;
  closedReason?: string | null;
  closedBy?: string | null;
}

export interface CaseStore {
  /**
   * Upsert a case from one outcome (idempotent on the unique key), state-aware (Fable H1/H2 — see
   * `planCaseUpsert`): a non-compliant outcome opens/refreshes a case (preserving IN_PROGRESS and
   * respecting human closures); COMPLIANT resolves an OPEN/IN_PROGRESS case; EXCLUDED excludes one.
   * Returns the affected case tagged with its `disposition`, or null when nothing changed
   * (COMPLIANT with no case, an idempotent already-terminal row, or a respected human closure).
   */
  upsertFromOutcome(input: UpsertCaseInput): Promise<UpsertedCase | null>;
  /**
   * The same upsert for a whole evaluation chunk, returning one result PER INPUT, IN INPUT ORDER, with
   * `null` exactly where the single-row call returns null — so the run pipeline's audit pass is a zip
   * rather than a second decision.
   *
   * Why it exists: the case pass awaited `upsertFromOutcome` per (subject, measure) pair, and each call
   * is a SELECT then an INSERT/UPDATE. On the pilot's six-measure nightly — 120,000 pairs — that is
   * ~240,000 sequential round trips to Neon before the audit writes, and the run measured 9.5 pairs a
   * second, about three and a half hours, which a deploy then killed at 87,000.
   *
   * Every §4 guarantee is per-input and unchanged: IN_PROGRESS preserved, human closures respected,
   * ADR-078 out-of-population, no `closed_at` drift, the UNCHANGED-vs-UPDATED rule (ADR-074 d13), and
   * ADR-076 d2's operator ownership of `next_action`. A row whose compare-and-set loses inside the
   * batch falls back to the per-row path, which is the proven one.
   *
   * THROWS on a duplicate `(subjectId, measureId, evaluationPeriod)` within one batch. A set-based
   * UPDATE would apply one of the two arbitrarily and silently, where the sequential path applied both
   * in order; a run should not produce a duplicate, and if one appears the caller should hear about it
   * rather than get a coin flip.
   *
   * `now` is computed ONCE per batch, so a chunk's `created_at`/`updated_at`/`closed_at` share a
   * timestamp instead of drifting across it.
   */
  upsertFromOutcomes(inputs: UpsertCaseInput[]): Promise<(UpsertedCase | null)[]>;
  getCase(id: string): Promise<CaseRecord | null>;
  /**
   * Many cases by id, in ONE query. Order is not guaranteed; ids that do not exist are simply absent,
   * so the caller can report which of the ids it asked for were missing.
   *
   * Bulk assign needs this to keep the event-before-patch rule (`case-actions.ts`): it must know which
   * rows WOULD change before it changes them, and doing that with N `getCase` calls is N round trips
   * on a set the UI caps at 500.
   */
  getCases(ids: readonly string[]): Promise<CaseRecord[]>;
  /**
   * Assign many cases, returning the ids that actually CHANGED.
   *
   * Set-based on purpose. The per-case `patchCase` path is a round trip each, and the panel backfill
   * and the work list's "assign these 200 patients' gaps" both hand it hundreds at once — enough to
   * exceed a worker deadline on Neon.
   *
   * **Compare-and-set: each entry carries the assignee the CALLER READ**, and the row is updated only
   * while it still holds that value. The first version checked only that the current assignee differed
   * from the target, which is not the same thing and loses a concurrent write: A reads a case owned by
   * Alice and audits `previousAssignee: Alice`; B assigns it to Bob; A's update still matches (Bob
   * differs from A's target) and overwrites Bob, leaving a ledger entry naming a transition that never
   * happened. With the pre-read owner in the predicate, A's row simply does not match and is skipped —
   * its already-written audit becomes a recorded-but-unapplied action, which is the side of the trade
   * `case-actions.ts` chose.
   *
   * The two conditions are distinct and both can fire: the compare-and-set fails on a concurrent
   * change, and `assignee <> target` fails on a request that asks for what is already there (a no-op,
   * which must not be reported as changed and must not be audited).
   *
   * The case must still be ACTIVE. The return value is the ids changed rather than a count, because
   * the caller audits exactly those.
   *
   * **`source` records WHO chose** (ADR-080 d1) — 'PANEL' for the provider-panel backfill, 'OPERATOR'
   * for a person's bulk assign. It is what lets the next panel edit tell its own previous assignment
   * from one a person made by hand, and move only the former. Clearing an assignee (`assignee` null)
   * clears the source too, whatever is passed here.
   */
  assignCases(
    expected: readonly CaseAssignExpectation[],
    assignee: string | null,
    source: "PANEL" | "OPERATOR",
  ): Promise<string[]>;
  listCases(query: CaseQuery): Promise<CaseRecord[]>;
  /**
   * One page of the same query, PLUS the exact total — from ONE statement (#561).
   *
   * Why not a COUNT and then a SELECT: they are two statements against a table the nightly run is
   * mutating, so a case closed between them makes `X-Total-Count` disagree with the page under it —
   * the client pages past the end, or stops one short. The window count is taken over the same scan,
   * so the number and the rows describe one snapshot.
   *
   * **The single-snapshot guarantee is for a NON-EMPTY page**, which is every page a client renders.
   * An empty result carries no window value — and empty is not the same as "total zero", it is also
   * every page PAST the end of a non-empty set, so answering 0 there would tell a client on page 9 of
   * 8 that everything had vanished. That one case therefore pays a second, bounded `COUNT(*)`, and its
   * total is that statement's: a concurrent insert or delete between the two can move it. Stated
   * rather than glossed, because the cheap alternatives are worse — a CTE that counts and pages in one
   * statement materialises the filtered set on both engines, and this branch is reached only by a
   * client that has already paged past the end.
   *
   * `limit`/`offset` are the page's, taken from the second argument; any `limit`/`offset` on `query`
   * is ignored, so a caller cannot half-page by setting both.
   */
  listCasesPage(query: CaseQuery, page: { limit: number; offset: number }): Promise<CasePage>;
  /**
   * Every distinct `employee_id` that has a case — the evidence for an INVARIANT, not a read surface.
   *
   * A deployment with a scoped profile (`WORKWELL_INSTANCE=maui`) hides any subject its directory does
   * not hold, and that predicate cannot become SQL: there is no patients table. The SQL page path is
   * therefore exact only while every case subject IS in the directory, which on the pilot is true by
   * construction — the corpus is deterministic and the list import refuses identifiers outside its
   * namespace (ADR-082). "True by construction" is what this method exists to stop us from assuming:
   * it is checked, off the request path, and a violation disables the fast path loudly instead of
   * producing a total that is quietly too large.
   *
   * Bounded by subjects, not by cases — ~20,000 short strings on the pilot against 32,558 cases.
   */
  distinctCaseSubjectIds(): Promise<string[]>;
  /** Patch mutable fields (always bumps updated_at); returns the updated row or null. */
  patchCase(id: string, patch: CasePatch): Promise<CaseRecord | null>;
  /** Count cases whose last_run_id is the given run (the run summary's totalCases). */
  countByLastRun(runId: string): Promise<number>;
}
