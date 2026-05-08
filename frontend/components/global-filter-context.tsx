"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type DateRangePreset = "7d" | "30d" | "90d" | "all";

type GlobalFilterContextValue = {
  siteId: string;
  from: string;
  to: string;
  datePreset: DateRangePreset;
  setSiteId: (siteId: string) => void;
  setDatePreset: (preset: DateRangePreset) => void;
};

const GlobalFilterContext = createContext<GlobalFilterContextValue | null>(null);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function subtractDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function derivePreset(from: string, to: string): DateRangePreset {
  if (!from && !to) return "all";
  const today = todayIso();
  if (to !== today) return "all";
  if (from === subtractDaysIso(7)) return "7d";
  if (from === subtractDaysIso(30)) return "30d";
  if (from === subtractDaysIso(90)) return "90d";
  return "all";
}

export function GlobalFilterProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const [siteId, setSiteIdState] = useState(() => searchParams.get("site") ?? "");
  const [from, setFrom] = useState(() => searchParams.get("from") ?? "");
  const [to, setTo] = useState(() => searchParams.get("to") ?? "");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSiteIdState(searchParams.get("site") ?? "");
      setFrom(searchParams.get("from") ?? "");
      setTo(searchParams.get("to") ?? "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [searchParams, searchParamsString]);

  const datePreset = derivePreset(from, to);

  const updateParams = useCallback((next: { site?: string; from?: string; to?: string }) => {
    const nextSite = next.site !== undefined ? next.site : siteId;
    const nextFrom = next.from !== undefined ? next.from : from;
    const nextTo = next.to !== undefined ? next.to : to;

    const params = new URLSearchParams(searchParamsString);
    if (nextSite) params.set("site", nextSite);
    else params.delete("site");
    if (nextFrom) params.set("from", nextFrom);
    else params.delete("from");
    if (nextTo) params.set("to", nextTo);
    else params.delete("to");

    setSiteIdState(nextSite);
    setFrom(nextFrom);
    setTo(nextTo);

    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [siteId, from, to, router, pathname, searchParamsString]);

  const setSiteId = useCallback((nextSite: string) => {
    updateParams({ site: nextSite });
  }, [updateParams]);

  const setDatePreset = useCallback((preset: DateRangePreset) => {
    if (preset === "all") {
      updateParams({ from: "", to: "" });
      return;
    }
    const today = todayIso();
    const fromDate = preset === "7d" ? subtractDaysIso(7) : preset === "30d" ? subtractDaysIso(30) : subtractDaysIso(90);
    updateParams({ from: fromDate, to: today });
  }, [updateParams]);

  const value = useMemo<GlobalFilterContextValue>(() => ({
    siteId,
    from,
    to,
    datePreset,
    setSiteId,
    setDatePreset
  }), [siteId, from, to, datePreset, setSiteId, setDatePreset]);

  return <GlobalFilterContext.Provider value={value}>{children}</GlobalFilterContext.Provider>;
}

export function useGlobalFilters() {
  const value = useContext(GlobalFilterContext);
  if (!value) {
    throw new Error("useGlobalFilters must be used inside GlobalFilterProvider");
  }
  return value;
}
