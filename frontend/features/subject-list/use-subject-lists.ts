"use client";

/**
 * The attributed lists an ACO has sent (MM-2 PR 3, ADR-082).
 *
 * The same hardening `use-panel-payers` and `use-assignable-users` needed: a row that is not what it
 * claims to be is DROPPED rather than rendered, because a successful fetch carrying the wrong shape
 * used to take the whole page down on `.toLocaleString()`. An optional surface's endpoint returning
 * an unexpected payload must cost that surface, not the page behind it — and when every row is
 * unusable that is a server bug, so it warns rather than rendering an empty state that reads as
 * "this deployment has no lists".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api/hooks";

export interface SubjectListCounts {
  MATCHED: number;
  NOT_FOUND: number;
  AMBIGUOUS: number;
}

export interface SubjectListRow {
  id: string;
  name: string;
  revision: number;
  source: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  counts: SubjectListCounts;
}

const isCounts = (value: unknown): value is SubjectListCounts => {
  const c = value as Partial<SubjectListCounts> | null;
  return (
    !!c &&
    typeof c.MATCHED === "number" &&
    typeof c.NOT_FOUND === "number" &&
    typeof c.AMBIGUOUS === "number"
  );
};

export const isSubjectListRow = (value: unknown): value is SubjectListRow => {
  const row = value as Partial<SubjectListRow> | null;
  return (
    !!row &&
    typeof row.id === "string" &&
    typeof row.name === "string" &&
    typeof row.revision === "number" &&
    typeof row.createdAt === "string" &&
    isCounts(row.counts)
  );
};

/**
 * `enabled: false` fetches nothing: the work screens pass `canManageCases`, because the endpoint is
 * CASE_MANAGER/ADMIN and a VIEWER would only meet a 403 (#874).
 */
export function useSubjectLists({ enabled = true }: { enabled?: boolean } = {}): {
  lists: SubjectListRow[];
  loading: boolean;
  /** The fetch failed. Kept apart from "no lists", so a screen filtered by one can say it cannot name it. */
  failed: boolean;
  reload: () => Promise<void>;
} {
  const api = useApi();
  const [lists, setLists] = useState<SubjectListRow[]>([]);
  // Loading until the first fetch settles, even while disabled (masked below). A screen mounts before
  // the session names the seat, so `enabled` turns true one render before the fetch starts; starting at
  // `enabled` read that render as "fetched, no lists" and flashed "No attributed list has the id".
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const data = await api.get<unknown>("/api/subject-lists");
      const rows = Array.isArray(data) ? data : [];
      const usable = rows.filter(isSubjectListRow);
      if (rows.length > 0 && usable.length === 0) {
        console.warn("[subject-lists] /api/subject-lists returned rows in an unrecognised shape; showing none");
      }
      setLists(usable);
    } catch {
      // A failed fetch costs the picker, never the page behind it.
      setLists([]);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (!enabled) return;
    // Deferred out of the synchronous effect body (the idiom compliance/page.tsx and cases/page.tsx
    // use) so `load`'s setState calls do not trip react-hooks/set-state-in-effect.
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [enabled, load]);

  return useMemo(
    () => ({ lists, loading: enabled && loading, failed, reload: load }),
    [enabled, lists, loading, failed, load],
  );
}
