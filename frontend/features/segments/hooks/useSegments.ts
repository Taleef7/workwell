"use client";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import type { Segment, SegmentDraft } from "../types";

export function useSegments() {
  const api = useApi();
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSegments(await api.get<Segment[]>("/api/segments"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load groups");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    // Defer out of the synchronous effect body so refetch's setLoading doesn't trip
    // react-hooks/set-state-in-effect (matches useEmployeeProfile).
    const t = setTimeout(() => void refetch(), 0);
    return () => clearTimeout(t);
  }, [refetch]);

  const create = useCallback(
    (draft: SegmentDraft) => api.post<SegmentDraft, Segment>("/api/segments", draft),
    [api]
  );
  const update = useCallback(
    (id: string, draft: SegmentDraft) => api.put<SegmentDraft, Segment>(`/api/segments/${id}`, draft),
    [api]
  );
  const remove = useCallback((id: string) => api.delete(`/api/segments/${id}`), [api]);

  return { segments, loading, error, refetch, create, update, remove };
}
