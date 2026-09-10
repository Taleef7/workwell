import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/api/hooks";

export interface MeasureIdentity {
  cmsId: string;
  mipsQualityId: string | null;
  improvementNotation?: "increase" | "decrease";
}

export interface MeasureListItem {
  id: string;
  name: string;
  /** Catalog status (`Draft | Approved | Active | Deprecated`); optional so older fixtures still type. */
  status?: string;
  identity: MeasureIdentity | null;
}

export function formatMeasureIdentity(
  identity: MeasureIdentity | null | undefined,
): string {
  if (!identity) return "";
  if (identity.mipsQualityId) {
    return `MIPS ${identity.mipsQualityId} · ${identity.cmsId}`;
  }
  return identity.cmsId;
}

export function formatMeasureLabel(
  identity: MeasureIdentity | null | undefined,
  name: string,
): string {
  const prefix = formatMeasureIdentity(identity);
  if (!prefix) return name;
  return `${prefix} · ${name}`;
}

export function useMeasureIdentities() {
  const api = useApi();
  const [identities, setIdentities] = useState<Record<string, MeasureIdentity | null>>({});
  // The catalog rows the identities came from, for pages that need names/status for a measure
  // filter without a second (heavier) read — one `/api/measures` fetch serves both.
  const [measures, setMeasures] = useState<MeasureListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const mountedRef = useRef(true);

  const fetchIdentities = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const measures = await api.get<MeasureListItem[]>("/api/measures");
      if (!mountedRef.current || reqId !== reqIdRef.current) return;
      const map: Record<string, MeasureIdentity | null> = {};
      const rows = Array.isArray(measures) ? measures : [];
      for (const m of rows) {
        map[m.id] = m.identity ?? null;
      }
      setIdentities(map);
      setMeasures(rows);
    } catch (err) {
      if (!mountedRef.current || reqId !== reqIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load measure identities");
    } finally {
      if (mountedRef.current && reqId === reqIdRef.current) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchIdentities();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchIdentities]);

  const labelFor = useCallback(
    (measureId: string, fallbackName: string): string => {
      const identity = identities[measureId];
      return formatMeasureLabel(identity, fallbackName);
    },
    [identities],
  );

  return { identities, measures, labelFor, loading, error, refetch: fetchIdentities };
}
