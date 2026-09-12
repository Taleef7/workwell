"use client";

/**
 * The PCP ("panel") reference data every work surface needs, in one place.
 *
 * The roster grew a provider filter first; the case list needs the same one, and the pilot's staff
 * work by provider panel, so a third and fourth surface are coming. What must not drift between them
 * is the endpoint, the option ordering, and the word on the label — `/api/providers` is
 * profile-scoped (the pilot's primary-care providers, the occupational clinicians elsewhere), and the
 * deployment's subject term decides whether a clinician is a "PCP" or a "Provider".
 *
 * The markup is deliberately NOT shared: the roster renders native `<select>`s and the case list
 * renders the design-system `Select`. Sharing the data and the wording is what stops them diverging;
 * sharing the element would mean rewriting one page's filter row to serve the other.
 */
import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { SUBJECT } from "@/lib/terminology";

export type PanelProvider = { id: string; name: string; location: string };

/** "PCP" on a patient deployment, "Provider" on the occupational one. */
export const providerFilterLabel = (): string => (SUBJECT.singular === "patient" ? "PCP" : "Provider");

export function usePanelProviders(): {
  providers: PanelProvider[];
  /** `{value,label}` options with the "all panels" empty entry first, for a `Select`. */
  options: { value: string; label: string }[];
  /** Resolve an id to its display name — an active-filter chip should never show a raw id. */
  nameFor: (id: string) => string | undefined;
} {
  const api = useApi();
  const [providers, setProviders] = useState<PanelProvider[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<PanelProvider[]>("/api/providers")
      .then((rows) => {
        if (!cancelled) setProviders(rows ?? []);
      })
      // A provider list that fails to load leaves the filter empty rather than breaking the page:
      // the work list is the page, the filter is an affordance on it.
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const options = useMemo(
    () => [
      { value: "", label: "All panels" },
      ...providers.map((p) => ({ value: p.id, label: `${p.name} — ${p.location}` })),
    ],
    [providers],
  );

  const nameFor = useMemo(() => {
    const byId = new Map(providers.map((p) => [p.id, p.name]));
    return (id: string) => byId.get(id);
  }, [providers]);

  return { providers, options, nameFor };
}
