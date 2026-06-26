"use client";
import { useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import type { DirectoryEmployee } from "../types";

/** Debounced directory type-ahead over the existing GET /api/employees/search (min 2 chars). */
export function useDirectorySearch(query: string) {
  const api = useApi();
  const [results, setResults] = useState<DirectoryEmployee[]>([]);
  useEffect(() => {
    const q = query.trim();
    let cancelled = false;
    // Defer ALL state updates (including the <2-char reset) out of the synchronous effect body so
    // we never trip react-hooks/set-state-in-effect (matches useSegments/useEmployeeProfile). The
    // reset fires on the next tick (0ms); the fetch keeps its 250ms debounce.
    const t = setTimeout(
      () => {
        if (q.length < 2) {
          if (!cancelled) setResults([]);
          return;
        }
        void api
          .get<DirectoryEmployee[]>(`/api/employees/search?q=${encodeURIComponent(q)}&limit=10`)
          .then((r) => {
            if (!cancelled) setResults(r);
          })
          .catch(() => {
            if (!cancelled) setResults([]);
          });
      },
      q.length < 2 ? 0 : 250
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, query]);
  return results;
}
