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

/**
 * A WorkWell translation of a CMS measure, routed for the one year it covers (CMS published no FHIR
 * logic for it). Named by its own label, never by a CMS eCQM id; CMS's artifact (`executed`) still
 * scores every other year. Absent unless the deployment routes one.
 */
export interface TranslationLogic {
  label: string;
  version: string;
  url: string;
  derivedFrom: string;
  year: string;
}

export interface MeasureIdentity {
  cmsId: string;
  mipsQualityId: string | null;
  improvementNotation?: "increase" | "decrease";
  executed?: ExecutedLogic;
  translation?: TranslationLogic;
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

/**
 * The year a translation scores, beside the "Runs …" line:
 * "For 2027: WorkWell translation of CMS137v15 (ww-2027.1), not a CMS measure".
 */
export function formatTranslationLogic(translation: TranslationLogic | null | undefined): string {
  if (!translation) return "";
  return `For ${translation.year}: ${translation.label} (${translation.version}), not a CMS measure`;
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

/**
 * The logic that scored ONE result, as the backend reads it from that result's own evidence (#769).
 * Never derived from `identity.executed`, which is today's routing: a row scored before a translation
 * was routed, or by authored CQL, would be relabelled.
 */
export type ScoringLogic =
  | {
      kind: "cms-artifact";
      /** "CMS125FHIR" */
      ecqmId: string;
      /** "1.0.000" */
      version: string;
      /** "CMS125v14"; null when the artifact's lineage is not pinned. */
      derivedFrom: string | null;
      status: "draft" | "unknown";
      statusNote: string | null;
    }
  | {
      kind: "workwell-translation";
      /** "WorkWell translation of CMS137v15" */
      label: string;
      /** "ww-2027.1" */
      version: string;
      url: string | null;
      derivedFrom: string | null;
    };

export interface VersionedIdentity {
  /** For a chip: "MIPS 305 · CMS137FHIR (from CMS137v14)" / "MIPS 305 · WW translation of CMS137v15". */
  short: string;
  /** For a heading or wide cell: "MIPS 305 · CMS137FHIR v1.0.000 (from CMS137v14)". */
  full: string;
  /** For title/aria: the full form plus what it is ("…, a CMS draft" / "…, not a CMS measure"). */
  title: string;
}

/**
 * The versioned identity of one result. Null for a measure with no CMS identity (authored, TWH
 * occupational): show its name only, as before. No `logic` (nothing named scored the row, or the
 * surface has no row) gives the unversioned crosswalk, never a version guessed from routing.
 */
export function formatVersionedIdentity(
  identity: MeasureIdentity | null | undefined,
  logic: ScoringLogic | null | undefined,
): VersionedIdentity | null {
  if (!identity) return null;
  const mips = identity.mipsQualityId ? `MIPS ${identity.mipsQualityId} · ` : "";
  if (!logic) {
    const plain = formatMeasureIdentity(identity);
    return { short: plain, full: plain, title: plain };
  }
  if (logic.kind === "workwell-translation") {
    const full = `${mips}${logic.label} (${logic.version})`;
    return {
      short: `${mips}${logic.label.replace(/^WorkWell translation of /, "WW translation of ")}`,
      full,
      title: `${full}, not a CMS measure`,
    };
  }
  const from = logic.derivedFrom ? ` (from ${logic.derivedFrom})` : "";
  const full = `${mips}${logic.ecqmId} v${logic.version}${from}`;
  return {
    // The chip keeps the CMS version (the "from" lineage changes with the year; the FHIR artifact's
    // own "v1.0.000" does not), and drops the artifact version only when the lineage is known.
    short: logic.derivedFrom ? `${mips}${logic.ecqmId}${from}` : `${mips}${logic.ecqmId} v${logic.version}`,
    full,
    title: logic.status === "draft" ? `${full}, a CMS draft` : full,
  };
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

  // With a row's `logic`, the versioned identity (#769); without one, the unversioned crosswalk as before.
  const labelFor = useCallback(
    (measureId: string, fallbackName: string, logic?: ScoringLogic | null): string => {
      const identity = identities[measureId];
      const versioned = formatVersionedIdentity(identity, logic);
      return versioned ? `${versioned.full} · ${fallbackName}` : formatMeasureLabel(identity, fallbackName);
    },
    [identities],
  );

  // The accessible name / tooltip for a result: the full versioned identity and what it is.
  const titleFor = useCallback(
    (measureId: string, fallbackName: string, logic?: ScoringLogic | null): string => {
      const versioned = formatVersionedIdentity(identities[measureId], logic);
      return versioned ? `${versioned.title} · ${fallbackName}` : fallbackName;
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
    (measureId: string, fallbackName: string, logic?: ScoringLogic | null): string =>
      formatVersionedIdentity(identities[measureId], logic)?.short || fallbackName,
    [identities],
  );

  return { identities, measures, labelFor, labelForId, shortLabelFor, titleFor, loading, error, refetch: fetchIdentities };
}
