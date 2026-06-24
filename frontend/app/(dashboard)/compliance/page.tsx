"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api/hooks";
import { useRunStatus } from "@/components/run-status-provider";
import { useAuth } from "@/components/auth-provider";
import { canRunMeasures } from "@/lib/rbac";
import { COMPLIANCE_STATUS_LABELS } from "@/lib/status";
import { ComplianceChip } from "@/features/compliance/ComplianceChip";
import { PANEL_OPTIONS, type PanelId, type Roster } from "@/features/compliance/types";

const STATUS_FILTER_OPTIONS = Object.keys(COMPLIANCE_STATUS_LABELS);
const PAGE_SIZES = [25, 50, 100, 200];

export default function CompliancePage() {
  const api = useApi();
  const { user } = useAuth();
  const { startTracking } = useRunStatus();
  const canRecalc = canRunMeasures(user?.role);

  const [panel, setPanel] = useState<PanelId>("immunizations");
  const [status, setStatus] = useState<string>("");
  const [site, setSite] = useState<string>("");
  const [q, setQ] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(50);

  const [roster, setRoster] = useState<Roster | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [recalcBusy, setRecalcBusy] = useState<boolean>(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("panel", panel);
      if (status) params.set("status", status);
      if (site.trim()) params.set("site", site.trim());
      if (q.trim()) params.set("q", q.trim());
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      const { data, headers } = await api.getWithHeaders<Roster>(`/api/compliance/roster?${params.toString()}`);
      setRoster(data);
      const matchTotal = Number(headers.get("X-Total-Count") ?? data.rows.length);
      setTotal(Number.isFinite(matchTotal) ? matchTotal : data.rows.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the compliance roster.");
      setRoster(null);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [api, panel, status, site, q, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onComplete = () => void load();
    window.addEventListener("ww:run-complete", onComplete);
    return () => window.removeEventListener("ww:run-complete", onComplete);
  }, [load]);

  const recalculate = useCallback(async () => {
    if (!canRecalc) return;
    if (!window.confirm("Recalculate compliance for all programs? This runs every active measure across the workforce.")) return;
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
  }, [api, canRecalc, startTracking]);

  const columns = roster?.columns ?? [];
  const rows = roster?.rows ?? [];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Individual Compliance Status</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Every employee across the selected panel — compliant and excluded included. The inverse of the worklist.
          </p>
        </div>
        {canRecalc ? (
          <button
            type="button"
            onClick={recalculate}
            disabled={recalcBusy}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {recalcBusy ? "Starting…" : "Recalculate"}
          </button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">Panel</span>
          <select
            value={panel}
            onChange={(e) => { setPage(1); setPanel(e.target.value as PanelId); }}
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          >
            {PANEL_OPTIONS.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">Status</span>
          <select
            value={status}
            onChange={(e) => { setPage(1); setStatus(e.target.value); }}
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          >
            <option value="">All statuses</option>
            {STATUS_FILTER_OPTIONS.map((s) => (<option key={s} value={s}>{COMPLIANCE_STATUS_LABELS[s]}</option>))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">Site</span>
          <input
            value={site}
            onChange={(e) => { setPage(1); setSite(e.target.value); }}
            placeholder="All sites"
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
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

      {error ? (
        <p role="alert" className="rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="min-w-full border-collapse text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-900/60">
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-neutral-50 px-3 py-2 text-left font-semibold dark:bg-neutral-900/60">
                Employee
              </th>
              {columns.map((c) => (
                <th key={c.measureId} scope="col" className="px-3 py-2 text-left font-semibold">
                  {c.name}
                  <span className="ml-1 text-[10px] font-normal uppercase text-neutral-400">{c.complianceClass === "PERMANENT" ? "perm" : "rec"}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr><td colSpan={columns.length + 1} className="px-3 py-6 text-center text-neutral-500">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={columns.length + 1} className="px-3 py-6 text-center text-neutral-500">No employees match these filters.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.subject.externalId} className="border-t border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900/40">
                  <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-normal dark:bg-neutral-950">
                    <Link href={`/employees/${encodeURIComponent(r.subject.externalId)}`} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                      {r.subject.name}
                    </Link>
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400">{r.subject.site} · {r.subject.role}</div>
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

      <div className="flex items-center justify-between text-sm text-neutral-500 dark:text-neutral-400">
        <span>{total} employee{total === 1 ? "" : "s"}</span>
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
    </div>
  );
}
