"use client";

/**
 * The provider→staff panel mappings (MM-2 PR 2, ADR-080).
 *
 * `/api/panels` returns EVERY provider, mapped or not, so this hook serves two questions from one
 * read: the panels screen's rows, and "do I own a panel?" — which decides whether the work list opens
 * on my patients or on the whole practice.
 *
 * Like the other hooks here, it shares the DATA and the wording rather than the markup.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api/hooks";

export interface PanelRow {
  providerId: string;
  providerName: string;
  location: string;
  /** Patients attributed to this provider — the size of the panel being handed over. */
  patients: number;
  assignee: string | null;
  updatedAt: string | null;
}

/** What a save actually did. `changed` is about the MAPPING; `backfilled` is about the CASES. */
export interface PanelSaveResult {
  providerId: string;
  providerName?: string;
  assignee: string;
  previousAssignee: string | null;
  changed: boolean;
  backfillPlanned: number;
  backfilled: number;
}

export function usePanelAssignments(
  /** The signed-in account, to answer "which of these are mine?" — compared case-insensitively. */
  viewerEmail: string | null | undefined,
  enabled = true,
): {
  rows: PanelRow[];
  loading: boolean;
  error: string | null;
  /** The provider ids this viewer owns. Empty when they own none, which is a real answer. */
  mine: string[];
  /**
   * Whether the viewer owns at least one panel — `undefined` until the first read resolves.
   *
   * Three states, not two, and that matters: the work list defaults to "My panel" only for someone
   * who HAS one, so it must not decide while the answer is still unknown. Treating "not loaded yet"
   * as "owns none" would send every mapped staff member to the whole-practice view on first paint.
   */
  ownsPanel: boolean | undefined;
  reload: () => Promise<void>;
  save: (providerId: string, assignee: string) => Promise<PanelSaveResult>;
  remove: (providerId: string) => Promise<void>;
} {
  const api = useApi();
  const [rows, setRows] = useState<PanelRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<PanelRow[]>("/api/panels");
      setRows(data ?? []);
      setError(null);
    } catch (err) {
      // A panels list that fails to load leaves the tab empty with a message, rather than breaking the
      // work list it lives on.
      setRows([]);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, [api]);

  // Deferred a tick, the same way the work list defers its own load: the lint rule forbids a
  // synchronous setState inside an effect because it cascades renders, and `reload` sets loading on
  // entry.
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      void reload();
    }, 0);
    return () => clearTimeout(timer);
  }, [enabled, reload]);

  const mine = useMemo(() => {
    const email = viewerEmail?.trim().toLowerCase();
    if (!email) return [];
    // Case-insensitively, because an account's stored spelling and the token's can differ, and losing
    // a panel to that would read as "no work assigned to me".
    return rows.filter((r) => r.assignee?.trim().toLowerCase() === email).map((r) => r.providerId);
  }, [rows, viewerEmail]);

  const save = useCallback(
    async (providerId: string, assignee: string) => {
      const result = await api.put<{ assignee: string }, PanelSaveResult>(
        `/api/panels/${encodeURIComponent(providerId)}`,
        { assignee },
      );
      await reload();
      return result;
    },
    [api, reload],
  );

  const remove = useCallback(
    async (providerId: string) => {
      await api.delete(`/api/panels/${encodeURIComponent(providerId)}`);
      await reload();
    },
    [api, reload],
  );

  return { rows, loading, error, mine, ownsPanel: loaded ? mine.length > 0 : undefined, reload, save, remove };
}
