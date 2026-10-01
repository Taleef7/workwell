/**
 * Links between the three screens that list patients and gaps (#698). The work list is the case
 * manager's daily screen: one row per patient with every open gap. Cases is the same gaps one row per
 * gap, the open ones by default with the closed ones behind its tabs; Compliance is everyone, compliant
 * and excluded included. A link between them carries the measure, the gap status, the site, the PCP
 * and the search, so moving across never drops the question.
 */

/** The statuses that are open gaps: the only ones the work list lists. */
export const GAP_STATUSES: ReadonlySet<string> = new Set(["OVERDUE", "DUE_SOON", "MISSING_DATA"]);

export interface ListScope {
  measureId?: string | null;
  /** A status (`OVERDUE`, `DUE_SOON`, `MISSING_DATA`); anything else is not a gap and is dropped. */
  outcome?: string | null;
  site?: string | null;
  /** The PCP filter (`providerId`): the same query key on the work list and Cases. */
  providerId?: string | null;
  search?: string | null;
  /** An assignee's email: the work list's `assignee` filter, which Cases' "My Cases" view is. */
  assignee?: string | null;
  /** The closed-by-staff view, which both lists have (`status=staff_closed`). */
  staffClosed?: boolean;
}

function params(scope: ListScope): URLSearchParams {
  const p = new URLSearchParams();
  if (scope.measureId) p.set("measureId", scope.measureId);
  const outcome = scope.outcome?.trim().toUpperCase();
  if (outcome && GAP_STATUSES.has(outcome)) p.set("outcome", outcome);
  if (scope.site) p.set("site", scope.site);
  if (scope.providerId) p.set("providerId", scope.providerId);
  if (scope.search?.trim()) p.set("search", scope.search.trim());
  if (scope.assignee) p.set("assignee", scope.assignee);
  if (scope.staffClosed) p.set("status", "staff_closed");
  return p;
}

const withQuery = (path: string, p: URLSearchParams): string => {
  const query = p.toString();
  return query ? `${path}?${query}` : path;
};

/**
 * The work list, filtered to the scope. `wholePractice` asks for every panel (`panel=all`): a link
 * from a practice-wide count must open the practice, because a staff member who owns a panel would
 * otherwise land on "My panel" and see a fraction of the number they clicked.
 */
export function worklistHref(scope: ListScope & { wholePractice?: boolean } = {}): string {
  const p = params(scope);
  if (scope.wholePractice) p.set("panel", "all");
  return withQuery("/worklist", p);
}

/** Cases (one row per gap), filtered to the scope. */
export function casesHref(scope: ListScope = {}): string {
  return withQuery("/cases", params(scope));
}
