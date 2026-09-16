/**
 * Storage contract — `SubjectListStore` (MM-2 PR 3, ADR-082). The patient list an ACO attributes to
 * the group, and what happened to each identifier in it.
 *
 * The 2026-09-09 working session produced exactly one concrete ask: hand WorkWell the attributed
 * list, run the measures over that subset, and get numerator/denominator/exclusions back with
 * patient-level results. Every other population question this deployment answers is "the patients in
 * our directory". This one is "the patients somebody else says are ours", and the two are different
 * populations — which is the whole reason the list has to be stored rather than filtered for.
 *
 * **A list is IMMUTABLE, and that is load-bearing rather than tidy.** A report is a function of
 * (list revision, run ids). If a list could be edited underneath a report, every number the ACO had
 * already filed would become unverifiable — there would be no way to answer "what was the list when
 * you computed this?" So there is no update and no delete anywhere in this interface, a re-import is
 * a NEW row with `revision + 1` under the same name, and a manual resolution of a non-match is also a
 * new revision (the rule ADR-022 applies to identity matching: match, don't auto-merge, and never
 * silently rewrite what a source asserted).
 *
 * **A list is an ATTRIBUTION someone else asserts.** A panel (ADR-080 d6) is WorkWell's own
 * assignment map and is explicitly not an attribution; conflating them would let an assignment
 * decision change a denominator. Neither is a denominator by itself — the denominator is whatever
 * the measure's own logic computes over the list's members.
 *
 * **Nothing is visible until the whole import landed.** A list is written `IMPORTING`, its members
 * follow in chunks, and only then does it flip to `COMPLETE`; every read here filters on `COMPLETE`.
 * A short list is worse than no list: it reads as a smaller ACO population under a real list's name,
 * and nothing downstream could tell the difference.
 */

export type SubjectListResolution = "MATCHED" | "NOT_FOUND" | "AMBIGUOUS";

export type SubjectListStatus = "IMPORTING" | "COMPLETE";

export interface SubjectList {
  id: string;
  /** What the operator called it ("ACO Q3 attribution"). Unique only together with `revision`. */
  name: string;
  /** 1 for the first import of a name, then 1 + the highest revision that name has. */
  revision: number;
  status: SubjectListStatus;
  /** Where it came from, in the operator's words. Free text; never parsed. */
  source: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

export interface SubjectListMember {
  /** The identifier exactly as the file carried it, trimmed. Kept whatever it resolved to. */
  rawIdentifier: string;
  /** The directory subject this resolved to; NULL unless `resolution` is MATCHED. */
  subjectId: string | null;
  resolution: SubjectListResolution;
}

export interface CreateSubjectListInput {
  id: string;
  name: string;
  source: string | null;
  note: string | null;
  createdBy: string;
  /** Wall-clock ISO timestamp, passed in so the header and its completion share one clock. */
  now: string;
  /** Distinct by `rawIdentifier` — the caller de-duplicates, because it also reports how many it dropped. */
  members: readonly SubjectListMember[];
  /**
   * Run after every member is written and BEFORE the list becomes visible.
   *
   * This is where the `SUBJECT_LIST_IMPORTED` audit event goes, and the ordering is the one
   * `case-actions.ts` already uses: audit before the visible mutation. A failed audit then leaves a
   * recorded-but-unapplied import, never an applied-but-unrecorded one — the direction that keeps the
   * ledger a superset of what happened. Throwing here aborts the import with nothing visible.
   */
  beforeComplete?: (list: SubjectList) => Promise<void>;
}

/**
 * Two imports of the same name raced for the same revision number and the loser could not be placed.
 *
 * Typed rather than a bare unique-violation because the route answers it as a 409 naming the revision
 * that won: "your import lost a race" and "your database is broken" must not look the same to a
 * person who just uploaded a 50,000-line file.
 */
export class SubjectListRevisionConflictError extends Error {
  constructor(
    readonly name_: string,
    readonly existingRevision: number,
  ) {
    super(`subject list "${name_}" already has revision ${existingRevision}`);
    this.name = "SubjectListRevisionConflictError";
  }
}

export interface ListMembersOptions {
  resolution?: SubjectListResolution;
  limit: number;
  offset: number;
}

export interface MemberPage {
  members: SubjectListMember[];
  /** Total matching the filter, not the page — the members table pages on it. */
  total: number;
}

/** Per-resolution counts for one list. Every key present, zeros included. */
export type MemberCounts = Record<SubjectListResolution, number>;

export interface ListListsOptions {
  /**
   * Include lists still `IMPORTING`. The admin surface asks for this to show a stuck import; every
   * other caller — the report, the `?listId=` filter, the picker — must never see one.
   */
  includeIncomplete?: boolean;
}

export interface SubjectListStore {
  /**
   * Write a list and its members, then make it visible.
   *
   * The revision is allocated INSIDE the write, not by the caller: two concurrent imports of one name
   * must get consecutive revisions rather than one overwriting the other's number. Members are
   * inserted in chunks — a 50,000-row import is not one statement on either backend — so "the whole
   * thing in one transaction" is not what makes this safe. The `IMPORTING` → `COMPLETE` flip is.
   *
   * Throws `SubjectListRevisionConflictError` when the revision cannot be allocated.
   */
  createList(input: CreateSubjectListInput): Promise<SubjectList>;
  /** One COMPLETE list by id, or null. Never returns an in-flight import. */
  getList(id: string): Promise<SubjectList | null>;
  /** Newest first (created_at DESC, then revision DESC). COMPLETE only unless asked otherwise. */
  listLists(options?: ListListsOptions): Promise<SubjectList[]>;
  /** Counts for several lists in ONE statement — the picker shows them for every row. */
  countMembers(listIds: readonly string[]): Promise<Map<string, MemberCounts>>;
  /** A page of members ordered by `raw_identifier`, with the filtered total. */
  listMembers(listId: string, options: ListMembersOptions): Promise<MemberPage>;
  /**
   * Every MATCHED member's subject id.
   *
   * The read that every `?listId=` surface pays, and the one the covering index exists for. Returns
   * an empty array for an unknown or incomplete list — callers distinguish "no such list" with
   * `getList`, because an empty set is a legitimate answer (a list none of whose identifiers
   * resolved) and must not be confused with a missing one.
   */
  matchedSubjectIds(listId: string): Promise<string[]>;
}
