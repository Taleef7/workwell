/**
 * `?listId=` → the resolved subject set every filtered surface applies (MM-2 PR 3, ADR-082).
 *
 * Six surfaces take this parameter — the roster, the cases route, the work list, both CSV exports and
 * the MCP tool — and each one needs the same two answers: does this list exist (404 if not), and who
 * is in it. Resolving it in one place is the same rule `subject-filters.ts` states for the predicate:
 * a second definition would let a patient be in the ACO's list on one screen and not another.
 *
 * **The set is memoized, and that is safe only because a list is immutable.** A 50,000-id `Set`
 * rebuilt from the database on every `/worklist` page load is the pool-pressure shape #560 removed
 * from the case export — one unavoidable read per request, against a ten-connection pool, on a page a
 * staff member reloads all day. Because nothing can ever alter a list's members (no UPDATE, no DELETE
 * anywhere in the store interface), a cached set cannot go stale and needs no invalidation. If that
 * immutability is ever relaxed, this memo is the first thing that breaks.
 */
import type { SubjectListStore } from "../stores/subject-list-store.ts";

/** Eight lists is more than an operator juggles; beyond that the oldest is simply re-read. */
const MEMO_CAPACITY = 8;

export type ListFilterResolution =
  | { found: true; subjectIds: ReadonlySet<string> }
  | { found: false };

/**
 * Process-lifetime LRU of list id → matched subject ids.
 *
 * Deliberately NOT keyed by anything else: a list id identifies one immutable revision, so there is
 * no run key, no clock and no configuration that could change the answer.
 */
export class SubjectListMemo {
  private readonly entries = new Map<string, ReadonlySet<string>>();

  get(listId: string): ReadonlySet<string> | undefined {
    const held = this.entries.get(listId);
    if (held === undefined) return undefined;
    // Re-insert so the map's insertion order is the recency order the eviction below reads.
    this.entries.delete(listId);
    this.entries.set(listId, held);
    return held;
  }

  set(listId: string, subjectIds: ReadonlySet<string>): void {
    this.entries.delete(listId);
    this.entries.set(listId, subjectIds);
    while (this.entries.size > MEMO_CAPACITY) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Test seam, and the escape hatch if immutability is ever relaxed. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** One memo per process, shared by every surface — the point is that they agree. */
export const subjectListMemo = new SubjectListMemo();

/**
 * Resolve `?listId=` to a subject set, or report that no such list exists.
 *
 * **Existence is checked through `getList`, not through the size of the set.** A list none of whose
 * identifiers resolved returns an empty set legitimately, and treating empty as missing would answer
 * 404 for a real list whose whole point is that nobody in it could be found — which is precisely the
 * finding the review queue exists to show.
 *
 * An in-flight import is invisible to `getList`, so it resolves as "no such list" rather than as a
 * partial membership.
 */
export async function resolveListFilter(
  store: SubjectListStore,
  listId: string,
  memo: SubjectListMemo = subjectListMemo,
): Promise<ListFilterResolution> {
  const cached = memo.get(listId);
  if (cached !== undefined) return { found: true, subjectIds: cached };
  const list = await store.getList(listId);
  if (!list) return { found: false };
  const subjectIds = new Set(await store.matchedSubjectIds(listId));
  memo.set(listId, subjectIds);
  return { found: true, subjectIds };
}

/** The 404 body every surface returns for an unknown list, so they all say it the same way. */
export const listNotFoundBody = (listId: string): { error: "not_found"; parameter: "listId"; listId: string } => ({
  error: "not_found",
  parameter: "listId",
  listId,
});

/**
 * Read `?listId=` off a URL and fold it into already-parsed filters.
 *
 * One helper for all six surfaces (the roster, the cases route, the work list, both CSV exports and
 * the MCP tool) so none of them can grow its own spelling — the rule `subject-filters.ts` states for
 * the predicate, applied to the parameter that feeds it. Absent parameter ⇒ the filters unchanged, so
 * a surface that never sees `?listId=` pays one `URLSearchParams.get`.
 */
export async function withListFilter<T extends { listSubjectIds?: ReadonlySet<string> | null }>(
  store: SubjectListStore,
  params: URLSearchParams,
  filters: T,
  memo: SubjectListMemo = subjectListMemo,
): Promise<{ ok: true; filters: T } | { ok: false; listId: string }> {
  const listId = params.get("listId")?.trim();
  if (!listId) return { ok: true, filters };
  const resolved = await resolveListFilter(store, listId, memo);
  if (!resolved.found) return { ok: false, listId };
  return { ok: true, filters: { ...filters, listSubjectIds: resolved.subjectIds } };
}
