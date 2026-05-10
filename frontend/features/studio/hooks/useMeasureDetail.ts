"use client";

import { useState, useCallback } from "react";
import type { ApiClient } from "@/lib/api/client";
import type { MeasureDetail, ActivationReadiness, VersionHistoryItem } from "../types";

export function useMeasureDetail(api: ApiClient, measureId: string) {
  const [measure, setMeasure] = useState<MeasureDetail | null>(null);
  const [activationReadiness, setActivationReadiness] = useState<ActivationReadiness | null>(null);
  const [versionHistory, setVersionHistory] = useState<VersionHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<MeasureDetail>(`/api/measures/${measureId}`);
      setMeasure(data);
      try {
        const readiness = await api.get<ActivationReadiness>(`/api/measures/${measureId}/activation-readiness`);
        setActivationReadiness(readiness);
      } catch {
        // non-fatal
      }
      try {
        const versions = await api.get<VersionHistoryItem[]>(`/api/measures/${measureId}/versions`);
        setVersionHistory(versions);
      } catch {
        // non-fatal
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [api, measureId]);

  return { measure, activationReadiness, versionHistory, loading, error, setError, load };
}
