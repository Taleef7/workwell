import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/api/hooks";

/**
 * The logic an officially routed measure ACTUALLY runs: CMS's FHIR artifact (`CMS125FHIR v1.0.000`),
 * derived from the QDM measure the catalog is named after (`CMS125v14`). Absent for an authored measure.
 */
export interface ExecutedLogic {
  ecqmId: string;
  version: string;
  status: "draft" | "unknown";
  /** A dated phrase for the status, e.g. "posted for public comment Jan–Feb 2026"; null when unknown. */
  statusNote: string | null;
  derivedFrom: string | null;
}

export interface MeasureIdentity {
  cmsId: string;
  mipsQualityId: string | null;
  improvementNotation?: "increase" | "decrease";
  executed?: ExecutedLogic;
}

/**
 * One sentence naming the executed logic, for where a measure is described in detail:
 * "Runs CMS125FHIR v1.0.000, a CMS FHIR draft (posted for public comment Jan–Feb 2026), derived from CMS125v14".
 * The identity chip ("MIPS 112 · CMS125") stays as it is; this line is what says which version runs.
 */
export function formatExecutedLogic(executed: ExecutedLogic | null | undefined): string {
  if (!executed) return "";
  const parts = [`Runs ${executed.ecqmId} v${executed.version}`];
  if (executed.status === "draft") {
    parts.push(executed.statusNote ? `a CMS FHIR draft (${executed.statusNote})` : "a CMS FHIR draft");
  }
  if (executed.derivedFrom) parts.push(`derived from ${executed.derivedFrom}`);
  return parts.join(", ");
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

  // The label when only the id is at hand: the catalog's own name after the identity, never the id twice
  // ("MIPS 112 · CMS125 · cms125" was the result of passing the id as the fallback name).
  const labelForId = useCallback(
    (measureId: string): string => labelFor(measureId, measures.find((m) => m.id === measureId)?.name ?? measureId),
    [labelFor, measures],
  );

  // The short form, for a chip in a table cell (#648): the published identity alone ("MIPS 113 · CMS130"),
  // or the name for a measure that has none. Pair it with the long form as the chip's accessible name.
  const shortLabelFor = useCallback(
    (measureId: string, fallbackName: string): string => formatMeasureIdentity(identities[measureId]) || fallbackName,
    [identities],
  );

  return { identities, measures, labelFor, labelForId, shortLabelFor, loading, error, refetch: fetchIdentities };
}
