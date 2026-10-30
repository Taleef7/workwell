"use client";

/**
 * The "Attributed list" filter on the three screens that list patients and gaps (#874).
 *
 * `?listId=` has narrowed the work list, the roster, Cases and both CSVs at the API since ADR-082, but
 * no screen sent it, so chasing gaps for only the ACO's attributed patients meant typing a URL. The
 * options, their wording and the notes live here so the three screens agree; the select element stays
 * with each page (native on the roster, the design system's on the others), as the PCP filter's does
 * (`use-panel-providers`).
 *
 * **Only the newest revision of each list is offered.** Re-importing a name creates a new revision and
 * keeps the old one (lists are immutable), so offering every revision would put two "Q3 attribution"
 * entries side by side with nothing saying which one the ACO sent last. An older revision a link
 * already names stays selectable, labelled with its revision, and the note says a newer one exists.
 */
import Link from "next/link";
import { useMemo } from "react";
import { canManageCases } from "@/lib/rbac";
import { SUBJECT } from "@/lib/terminology";
import { useSubjectLists, type SubjectListRow } from "./use-subject-lists";

export const LIST_FILTER_LABEL = "Attributed list";

/**
 * The list id a screen may send, read off its URL.
 *
 * Narrowing by list is CASE_MANAGER/ADMIN at the API (the worker answers 403 to anyone else), so for
 * any other seat the parameter is dropped rather than sent, and `refused` says a link named one. Not
 * refused while the seat is still unknown (`role` undefined before the session loads), which would
 * flash the note at a case manager.
 */
export function listParam(
  searchParams: { get(name: string): string | null },
  role: string | null | undefined,
): { listId: string; refused: boolean } {
  const raw = searchParams.get("listId")?.trim() ?? "";
  if (canManageCases(role)) return { listId: raw, refused: false };
  return { listId: "", refused: raw !== "" && role != null };
}

export type ListFilterState = "none" | "loading" | "found" | "missing" | "failed";

export interface ListFilter {
  /** `{value,label}` options, "Not limited to a list" first; the chosen id is always among them. */
  options: { value: string; label: string }[];
  selected: SubjectListRow | null;
  /** The newest revision of the chosen list's name, when the chosen one is older. */
  newer: SubjectListRow | null;
  state: ListFilterState;
  /** What a chip calls the chosen list: its name, or its id when the lists could not name it. */
  chipName: string;
}

const unmatchedOf = (list: SubjectListRow): number => list.counts.NOT_FOUND + list.counts.AMBIGUOUS;

export function useListFilter(listId: string, enabled: boolean): ListFilter {
  const { lists, loading, failed } = useSubjectLists({ enabled });
  return useMemo(() => {
    const newestByName = new Map<string, SubjectListRow>();
    const revisionsByName = new Map<string, number>();
    for (const list of lists) {
      const newest = newestByName.get(list.name);
      if (!newest || list.revision > newest.revision) newestByName.set(list.name, list);
      revisionsByName.set(list.name, (revisionsByName.get(list.name) ?? 0) + 1);
    }
    const nameOf = (list: SubjectListRow): string =>
      (revisionsByName.get(list.name) ?? 0) > 1 ? `${list.name} v${list.revision}` : list.name;

    const selected = listId ? (lists.find((list) => list.id === listId) ?? null) : null;
    const offered = [...newestByName.values()];
    if (selected && !offered.includes(selected)) offered.push(selected);
    offered.sort((a, b) => a.name.localeCompare(b.name) || b.revision - a.revision);

    const state: ListFilterState = !listId
      ? "none"
      : selected
        ? "found"
        : loading
          ? "loading"
          : failed
            ? "failed"
            : "missing";

    const options = [
      { value: "", label: "Not limited to a list" },
      ...offered.map((list) => {
        const unmatched = unmatchedOf(list);
        return {
          value: list.id,
          label:
            `${nameOf(list)} · imported ${list.createdAt.slice(0, 10)} · ` +
            `${list.counts.MATCHED.toLocaleString()} ${SUBJECT.plural}` +
            (unmatched > 0 ? ` (${unmatched.toLocaleString()} not matched)` : ""),
        };
      }),
      // A link can name a list the options do not hold (still loading, a failed fetch, an unknown id).
      // It stays visible as the selected value instead of the select falling back to "not limited".
      ...(listId && !selected ? [{ value: listId, label: state === "loading" ? "Loading…" : listId }] : []),
    ];

    const newest = selected ? (newestByName.get(selected.name) ?? null) : null;
    return {
      options,
      selected,
      newer: newest && newest !== selected ? newest : null,
      state,
      chipName: selected ? nameOf(selected) : listId,
    };
  }, [lists, loading, failed, listId]);
}

const linkClass = "font-medium text-primary-700 hover:underline dark:text-primary-400";
const warnClass =
  "flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm";

/**
 * What a screen filtered by a list has to say about it: a link the seat may not use, an id nobody
 * holds, lists that would not load, members the directory could not match, and a newer revision.
 */
export function ListFilterNote({
  listId,
  refused,
  filter,
  onChange,
}: {
  listId: string;
  refused: boolean;
  filter: ListFilter;
  onChange: (next: string) => void;
}) {
  if (refused) {
    // The way out: this seat has no picker, chip or Clear that would remove the id from the URL.
    return (
      <p data-testid="list-filter-note" className={warnClass}>
        <span>Attributed lists are for case managers, so the list in this link was not applied.</span>
        <button type="button" className={linkClass} onClick={() => onChange("")}>
          Remove it from the link
        </button>
      </p>
    );
  }
  if (!listId) return null;
  if (filter.state === "missing" || filter.state === "failed") {
    return (
      <p data-testid="list-filter-note" role="status" className={warnClass}>
        <span>
          {filter.state === "missing"
            ? `No attributed list has the id ${listId}.`
            : `Limited to attributed list ${listId}; the lists could not be loaded to name it.`}
        </span>
        <button type="button" className={linkClass} onClick={() => onChange("")}>
          Clear the list
        </button>
      </p>
    );
  }
  const unmatched = filter.selected ? unmatchedOf(filter.selected) : 0;
  if (unmatched === 0 && !filter.newer) return null;
  return (
    <div data-testid="list-filter-note" className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
      {unmatched > 0 ? (
        <p>
          {unmatched.toLocaleString()} list {unmatched === 1 ? "member isn't" : "members aren't"} matched to{" "}
          {SUBJECT.an} {SUBJECT.singular} here, so {unmatched === 1 ? "it" : "they"} cannot appear below.{" "}
          <Link href="/lists" className={linkClass}>
            Review on Attributed lists
          </Link>
        </p>
      ) : null}
      {filter.newer ? (
        <p>
          A newer revision of this list was imported on {filter.newer.createdAt.slice(0, 10)}.{" "}
          <button type="button" className={linkClass} onClick={() => onChange(filter.newer!.id)}>
            Use it
          </button>
        </p>
      ) : null}
    </div>
  );
}
