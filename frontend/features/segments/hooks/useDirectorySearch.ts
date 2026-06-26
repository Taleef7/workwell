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
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void api
        .get<DirectoryEmployee[]>(`/api/employees/search?q=${encodeURIComponent(q)}&limit=10`)
        .then((r) => {
          if (!cancelled) setResults(r);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, query]);
  return results;
}
