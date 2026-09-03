"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/api/hooks";
import { fmtCount } from "@/lib/format";
import { useRunStatus } from "@/components/run-status-provider";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useAuth } from "@/components/auth-provider";
import { canRunMeasures } from "@/lib/rbac";
import { canSeeEngineering } from "@/lib/public-demo";
import { COMPLIANCE_STATUS_LABELS } from "@/lib/status";
import { SUBJECT } from "@/lib/terminology";
import { ComplianceChip } from "@/features/compliance/ComplianceChip";
import { RosterMobileCards } from "@/features/compliance/RosterMobileCards";
import { usePanelCache } from "@/features/compliance/usePanelCache";
import { SLOW_LOAD_HINT, useSlowLoadHint } from "@/lib/useSlowLoadHint";
import { useMeasureIdentities } from "@/lib/measure-identity";
import { PANEL_OPTIONS, type PanelId, type Roster, type TenantOption } from "@/features/compliance/types";

const STATUS_FILTER_OPTIONS = Object.keys(COMPLIANCE_STATUS_LABELS);
const STATUS_FILTER_VALUES = new Set(STATUS_FILTER_OPTIONS);
const PAGE_SIZES = [25, 50, 100, 200];

function normalizeStatusFilter(raw: string | null): string {
  return raw && STATUS_FILTER_VALUES.has(raw) ? raw : "";
}

function normalizePanelFilter(raw: string | null): PanelId {
  return raw && PANEL_OPTIONS.some((option) => option.id === raw)
    ? (raw as PanelId)
    : "immunizations";
}

export default function CompliancePage() {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { startTracking, isActive } = useRunStatus();
  // Site scoping comes from the shared dashboard site selector (header) / `?site=` URL — same as the
  // cases & programs pages — not a page-local field, so the global filter actually applies here.
  const { siteId } = useGlobalFilters();
  const canRecalc = canRunMeasures(user?.role) && canSeeEngineering(user?.role);
  const { labelFor: measureLabelFor } = useMeasureIdentities();

  // Derived from the URL rather than useState-initialized, so browser back/forward between two
  // filtered /compliance URLs re-renders with the right filter.
  const panel: PanelId = normalizePanelFilter(searchParams.get("panel"));
  const status: string = normalizeStatusFilter(searchParams.get("status"));
  const measureId: string = searchParams.get("measureId") ?? "";
  const [q, setQ] = useState<string>("");
  const [segment, setSegment] = useState<string>("");
  const [segmentOptions, setSegmentOptions] = useState<{ id: string; name: string }[]>([]);
  const [tenant, setTenant] = useState<string>("");
  const [tenantOptions, setTenantOptions] = useState<TenantOption[]>([]);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(50);

  // A global site change can shrink the result set so the current page slices to empty
  // ("No employees match" / "Page 5 of 1"). Jump back to page 1 the moment siteId changes — the
  // React-documented "adjust state during render when a value changes" pattern, so `load` rebuilds with
  // page=1 before it fires (no stale out-of-range request, no double fetch). The selects/search/page-size
  // controls already reset the page in their own onChange; this covers the externally-driven site filter.
  const [prevSiteId, setPrevSiteId] = useState(siteId);
  if (siteId !== prevSiteId) {
    setPrevSiteId(siteId);
    setPage(1);
  }

  // panel/status are URL-derived, so like siteId they can change externally (back/forward, deep link),
  // not only through their selects — the same render-adjust reset covers both paths.
  const [prevPanel, setPrevPanel] = useState(panel);
  const [prevStatus, setPrevStatus] = useState(status);
  if (panel !== prevPanel || status !== prevStatus) {
    setPrevPanel(panel);
    setPrevStatus(status);
    setPage(1);
  }

  // Debounce the free-text search so a fetch fires once the typing settles, not per keystroke
  // (matches the cases page). The selects + paging + global site filter drive `load` immediately.
  const [debouncedQ, setDebouncedQ] = useState<string>("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const [roster, setRoster] = useState<Roster | null>(null);
  const [loadedPanel, setLoadedPanel] = useState<PanelId | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [recalcBusy, setRecalcBusy] = useState<boolean>(false);

  // UX-3 — optimistic panel/filter caching: keep each fetched (panel + filters + page) result in memory
  // for the session, keyed by its full query signature. Switching a panel/filter — or switching *back*
  // to one already loaded — renders instantly from cache instead of re-paying the cold roster fetch and
  // re-showing a blank skeleton. Session-scoped (unmounts with the page); a recompute clears it below.
  const cache = usePanelCache<{ roster: Roster; total: number }>();
  const slow = useSlowLoadHint(loading);

  // Stale-fetch guard (Fable M20): a slow All-Systems response must not land after a fast tenant=ihn
  // one and paint the wrong rows under the selected filter. Only the latest load applies its result.
  const reqIdRef = useRef(0);
  const load = useCallback(async () => {
    const params = new URLSearchParams();
    params.set("panel", panel);
    if (status) params.set("status", status);
    if (measureId.trim()) params.set("measureId", measureId.trim());
    if (siteId.trim()) params.set("site", siteId.trim());
    if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
    if (segment) params.set("segment", segment);
    if (tenant) params.set("tenant", tenant);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    const query = params.toString();

    // Cache hit → paint instantly, never a blank skeleton for data already fetched this session. Bump
    // the request id so any in-flight fetch for a prior key can't land on top of the cached result.
    const cached = cache.read(query);
    if (cached) {
      reqIdRef.current++;
      setRoster(cached.roster);
      setLoadedPanel(panel);
      setTotal(cached.total);
      setError(null);
      setLoading(false);
      return;
    }

    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const { data, headers } = await api.getWithHeaders<Roster>(`/api/compliance/roster?${query}`);
      if (reqId !== reqIdRef.current) return;
      setRoster(data);
      setLoadedPanel(panel);
      const matchTotal = Number(headers.get("X-Total-Count") ?? data.rows.length);
      const resolvedTotal = Number.isFinite(matchTotal) ? matchTotal : data.rows.length;
      setTotal(resolvedTotal);
      cache.write(query, { roster: data, total: resolvedTotal });
    } catch (err) {
      if (reqId !== reqIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load the compliance roster.");
      setRoster(null);
      setLoadedPanel(null);
      setTotal(0);
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [api, cache, panel, status, measureId, siteId, debouncedQ, segment, tenant, page, pageSize]);

  useEffect(() => {
    // Defer out of the synchronous effect body (matches cases/page.tsx) so the load's setState calls
    // don't trip react-hooks/set-state-in-effect.
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    // A recompute makes every cached panel/filter stale — drop the whole cache so the reload actually
    // re-fetches the current key (and future switches re-fetch too) instead of serving pre-run data.
    const onComplete = () => {
      cache.clear();
      void load();
    };
    window.addEventListener("ww:run-complete", onComplete);
    return () => window.removeEventListener("ww:run-complete", onComplete);
  }, [load, cache]);

  // Load the enabled segments once for the optional Segment filter. Best-effort: the filter is
  // optional and must never break the roster, so swallow errors and leave the options empty. The
  // setState rides in the async .then so it doesn't trip react-hooks/set-state-in-effect.
  useEffect(() => {
    api
      .get<{ id: string; name: string; enabled: boolean }[]>("/api/segments")
      .then((list) =>
        setSegmentOptions((Array.isArray(list) ? list : []).filter((s) => s.enabled).map(({ id, name }) => ({ id, name })))
      )
      .catch(() => setSegmentOptions([]));
  }, [api]);

  // Load the tenants/systems once for the optional Tenant filter (E13 PR-1). Best-effort, like segments.
  useEffect(() => {
    api
      .get<TenantOption[]>("/api/tenants")
      .then((list) => setTenantOptions(Array.isArray(list) ? list : []))
      .catch(() => setTenantOptions([]));
  }, [api]);

  const recalculate = useCallback(async () => {
    if (!canRecalc || isActive) return; // a run is already in flight — don't fan out a duplicate
    if (!window.confirm(`Recalculate compliance for all programs? This runs every active measure across the ${SUBJECT.population}.`)) return;
    setRecalcBusy(true);
    try {
      const result = await api.post<{ scopeType: string }, { runId: string; status?: string }>(
        "/api/runs/manual",
        { scopeType: "ALL_PROGRAMS" }
      );
      startTracking(result.runId, result.status ?? "REQUESTED");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the recalculation run.");
    } finally {
      setRecalcBusy(false);
    }
  }, [api, canRecalc, isActive, startTracking]);

  const writePanelToUrl = useCallback((nextPanel: PanelId, replace = false) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("panel", nextPanel);
    params.delete("measureId");
    const query = params.toString();
    const target = query ? `${pathname}?${query}` : pathname;
    if (replace) {
      router.replace(target);
    } else {
      router.push(target);
    }
  }, [pathname, router, searchParams]);

  const clearMeasureId = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("measureId");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  const setPanelAndUrl = useCallback((nextPanel: PanelId) => {
    writePanelToUrl(nextPanel, false);
  }, [writePanelToUrl]);

  useEffect(() => {
    if (roster && loadedPanel === panel && roster.panel !== panel) {
      writePanelToUrl(roster.panel, true);
    }
  }, [roster, loadedPanel, panel, writePanelToUrl]);

  const setStatusAndUrl = useCallback((nextStatus: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextStatus) {
      params.set("status", nextStatus);
    } else {
      params.delete("status");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  const columns = roster?.columns ?? [];
  const rows = roster?.rows ?? [];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const emptyPanels = roster?.availablePanels !== undefined && roster.availablePanels.length === 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Individual Compliance Status</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {`Every ${SUBJECT.singular} across the selected panel — compliant and excluded included. The inverse of the worklist.`}
          </p>
        </div>
        {canRecalc ? (
          <button
            type="button"
            onClick={recalculate}
            disabled={recalcBusy || isActive}
            title={isActive ? "A run is already in progress" : undefined}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {isActive ? "Run in progress…" : recalcBusy ? "Starting…" : "Recalculate"}
          </button>
        ) : null}
      </header>

      {emptyPanels ? (
        <p className="rounded-lg border border-neutral-200 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800">
          No compliance panel is configured for this deployment.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <label className="flex flex-col text-xs font-medium">
              <span className="mb-1">Panel</span>
              <select
                aria-label="Panel"
                value={loadedPanel === panel ? (roster?.panel ?? panel) : panel}
                onChange={(e) => setPanelAndUrl(e.target.value as PanelId)}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
              >
              {(roster?.availablePanels
                ? PANEL_OPTIONS.filter((p) => roster.availablePanels!.includes(p.id))
                : PANEL_OPTIONS
              ).map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">System</span>
            <select
              aria-label="System"
              value={tenant}
              onChange={(e) => { setPage(1); setTenant(e.target.value); }}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            >
              <option value="">All systems</option>
              {tenantOptions.map((o) => (<option key={o.id} value={o.id}>{o.name}</option>))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">Segment</span>
            <select
              aria-label="Segment"
              value={segment}
              onChange={(e) => { setPage(1); setSegment(e.target.value); }}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            >
              <option value="">All segments</option>
              {segmentOptions.map((o) => (<option key={o.id} value={o.id}>{o.name}</option>))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">Status</span>
            <select
              value={status}
              onChange={(e) => setStatusAndUrl(e.target.value)}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            >
              <option value="">All statuses</option>
              {STATUS_FILTER_OPTIONS.map((s) => (<option key={s} value={s}>{COMPLIANCE_STATUS_LABELS[s]}</option>))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">Search</span>
            <input
              value={q}
              onChange={(e) => { setPage(1); setQ(e.target.value); }}
              placeholder="Name or ID"
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            />
          </label>
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">Page size</span>
            <select
              value={pageSize}
              onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)); }}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            >
              {PAGE_SIZES.map((n) => (<option key={n} value={n}>{n}</option>))}
            </select>
          </label>
        </div>

        {measureId ? (
          <div className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
            <span>
              Scoped to{" "}
              <span className="font-semibold text-neutral-900 dark:text-neutral-100">
                {measureLabelFor(measureId, measureId)}
              </span>
            </span>
            <span>—</span>
            <button
              type="button"
              onClick={clearMeasureId}
              className="font-medium text-primary-700 hover:underline dark:text-primary-400"
            >
              Clear
            </button>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        <span className="sr-only" role="status" aria-live="polite">
          {loading ? (slow ? `${SLOW_LOAD_HINT} Still loading.` : "Loading roster…") : `${rows.length} ${rows.length === 1 ? SUBJECT.singular : SUBJECT.plural} loaded`}
        </span>

        {slow && loading ? (
          <p className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
            <span aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
            {SLOW_LOAD_HINT}
          </p>
        ) : null}

        <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 md:block dark:border-neutral-800">
          <table className="min-w-full border-collapse text-sm">
            <thead className="bg-neutral-50 dark:bg-neutral-900/60">
              <tr>
                <th scope="col" className="sticky left-0 z-10 bg-neutral-50 px-3 py-2 text-left font-semibold dark:bg-neutral-900/60">
                  {SUBJECT.Singular}
                </th>
                {columns.map((c) => (
                  <th key={c.measureId} scope="col" className="px-3 py-2 text-left font-semibold">
                    {measureLabelFor(c.measureId, c.name)}
                    <span className="ml-1 text-[10px] font-normal uppercase text-neutral-400">{c.complianceClass === "PERMANENT" ? "perm" : "rec"}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={columns.length + 1} className="px-3 py-6 text-center text-neutral-500">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={columns.length + 1} className="px-3 py-6 text-center text-neutral-500">{`No ${SUBJECT.plural} match these filters.`}</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.subject.externalId} className="border-t border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900/40">
                    <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-normal dark:bg-neutral-950">
                      <Link href={`/employees/${encodeURIComponent(r.subject.externalId)}`} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                        {r.subject.name}
                      </Link>
                      <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        {r.subject.tenantName} · {r.subject.site}{SUBJECT.singular === "patient" ? null : <> · {r.subject.role}</>}
                      </div>
                    </th>
                    {columns.map((c) => {
                      const cell = r.cells[c.measureId] ?? { status: "NA" as const, method: "Not evaluated" };
                      return (
                        <td key={c.measureId} className="px-3 py-2 align-top">
                          <ComplianceChip cell={cell} />
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <RosterMobileCards columns={columns} rows={rows} loading={loading} labelFor={measureLabelFor} />

        <div className="flex items-center justify-between text-sm text-neutral-500 dark:text-neutral-400">
          <span>{fmtCount(total)} {total === 1 ? SUBJECT.singular : SUBJECT.plural}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-50 dark:border-neutral-700"
            >
              Prev
            </button>
            <span>Page {page} of {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => (p < totalPages ? p + 1 : p))}
              disabled={page >= totalPages}
              className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-50 dark:border-neutral-700"
            >
              Next
            </button>
          </div>
        </div>
        </>
      )}
    </div>
  );
}
