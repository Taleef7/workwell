"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { emitToast } from "@/lib/toast";
import { outcomeStatusClass } from "@/lib/status";

type CaseSummary = {
  caseId: string;
  employeeId: string;
  employeeName: string;
  site: string;
  measureVersionId: string;
  measureName: string;
  measureVersion: string;
  evaluationPeriod: string;
  status: string;
  priority: string;
  assignee: string | null;
  currentOutcomeStatus: string;
  lastRunId: string;
  updatedAt: string;
};

type MeasureOption = {
  id: string;
  name: string;
  status: string;
};

export default function CasesPage() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [measures, setMeasures] = useState<MeasureOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"open" | "closed" | "all">("open");
  const [measureFilter, setMeasureFilter] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [siteFilter, setSiteFilter] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState(() =>
    typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("search") ?? ""
  );
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [bulkAssignee, setBulkAssignee] = useState("");
  const [bulkActing, setBulkActing] = useState<"assign" | "escalate" | "export" | null>(null);

  const apiBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    return raw.trim().replace(/\/+$/, "");
  }, []);

  const loadMeasures = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/api/measures`, { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as MeasureOption[];
      setMeasures(data.filter((item) => item.status === "Active"));
    } catch {
      setMeasures([]);
    }
  }, [apiBase]);

  const loadCases = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("status", statusFilter);
      if (measureFilter) {
        params.set("measureId", measureFilter);
      }
      if (priorityFilter) {
        params.set("priority", priorityFilter);
      }
      if (assigneeFilter) {
        params.set("assignee", assigneeFilter);
      }
      if (siteFilter) {
        params.set("site", siteFilter);
      }
      const response = await fetch(`${apiBase}/api/cases?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      const data = (await response.json()) as CaseSummary[];
      setCases(data);
      setSelectedCaseIds((existing) => existing.filter((id) => data.some((item) => item.caseId === id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [apiBase, assigneeFilter, measureFilter, priorityFilter, siteFilter, statusFilter]);

  useEffect(() => {
    if (apiBase) {
      const timer = setTimeout(() => {
        void loadMeasures();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [apiBase, loadMeasures]);

  useEffect(() => {
    if (apiBase) {
      const timer = setTimeout(() => {
        void loadCases();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [apiBase, loadCases]);

  const filteredCases = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) {
      return cases;
    }
    return cases.filter((item) => item.employeeName.toLowerCase().includes(term) || item.employeeId.toLowerCase().includes(term));
  }, [cases, searchTerm]);

  const allFilteredSelected = filteredCases.length > 0 && filteredCases.every((item) => selectedCaseIds.includes(item.caseId));

  function toggleCase(caseId: string) {
    setSelectedCaseIds((existing) =>
      existing.includes(caseId) ? existing.filter((id) => id !== caseId) : [...existing, caseId]
    );
  }

  function toggleAllFiltered() {
    if (allFilteredSelected) {
      setSelectedCaseIds((existing) => existing.filter((id) => !filteredCases.some((item) => item.caseId === id)));
      return;
    }
    const ids = new Set(selectedCaseIds);
    filteredCases.forEach((item) => ids.add(item.caseId));
    setSelectedCaseIds(Array.from(ids));
  }

  async function exportCsv(urlPath: string, filename: string) {
    const response = await fetch(`${apiBase}${urlPath}`);
    if (!response.ok) {
      setError(`Export failed (${response.status})`);
      return;
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.URL.revokeObjectURL(url);
  }

  async function bulkAssign() {
    if (!apiBase || selectedCaseIds.length === 0) {
      return;
    }
    setBulkActing("assign");
    setError(null);
    try {
      const assigneeQuery = bulkAssignee.trim() ? `?assignee=${encodeURIComponent(bulkAssignee.trim())}` : "";
      for (const caseId of selectedCaseIds) {
        const response = await fetch(`${apiBase}/api/cases/${caseId}/assign${assigneeQuery}`, { method: "POST" });
        if (!response.ok) {
          throw new Error(`Bulk assign failed (${response.status})`);
        }
      }
      await loadCases();
      emitToast(`Case assigned to ${bulkAssignee.trim() || "unassigned"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBulkActing(null);
    }
  }

  async function bulkEscalate() {
    if (!apiBase || selectedCaseIds.length === 0) {
      return;
    }
    setBulkActing("escalate");
    setError(null);
    try {
      for (const caseId of selectedCaseIds) {
        const response = await fetch(`${apiBase}/api/cases/${caseId}/escalate`, { method: "POST" });
        if (!response.ok) {
          throw new Error(`Bulk escalate failed (${response.status})`);
        }
      }
      await loadCases();
      emitToast("Selected cases escalated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBulkActing(null);
    }
  }

  async function bulkExportSelected() {
    if (selectedCaseIds.length === 0) {
      return;
    }
    setBulkActing("export");
    try {
      const params = new URLSearchParams();
      params.set("format", "csv");
      params.set("caseIds", selectedCaseIds.join(","));
      await exportCsv(`/api/exports/cases?${params.toString()}`, "cases-selected.csv");
      emitToast("Selected cases exported");
    } finally {
      setBulkActing(null);
    }
  }

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 p-8 text-white shadow-lg">
        <p className="text-sm uppercase tracking-[0.3em] text-slate-300">Caseflow</p>
        <h2 className="mt-2 text-3xl font-semibold">Why Flagged cases</h2>
        <p className="mt-3 max-w-2xl text-slate-300">
          Open worklist cases now persist from the seeded Audiogram run. Each card below links to the structured evidence
          that explains why the case exists.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Open and recent cases</h3>
          <p className="text-sm text-slate-500">Loaded from the DB-backed case endpoints.</p>
        </div>
        <p className="text-sm text-slate-500">
          API base: <code>{apiBase || "(missing NEXT_PUBLIC_API_BASE_URL)"}</code>
        </p>
        <button
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900"
          onClick={() =>
            void exportCsv(
              `/api/exports/cases?format=csv&status=${encodeURIComponent(statusFilter)}${measureFilter ? `&measureId=${encodeURIComponent(measureFilter)}` : ""}`,
              "cases.csv"
            )
          }
        >
          Export cases CSV
        </button>
        <button
          className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
          onClick={() => void exportCsv("/api/audit-events/export?format=csv", "audit-events.csv")}
        >
          Export audit CSV
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <label className="text-sm text-slate-600">
          Status{" "}
          <select
            className="ml-2 rounded border border-slate-300 px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "open" | "closed" | "all")}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="text-sm text-slate-600">
          Measure{" "}
          <select
            className="ml-2 rounded border border-slate-300 px-2 py-1 text-sm"
            value={measureFilter}
            onChange={(e) => setMeasureFilter(e.target.value)}
          >
            <option value="">All Active Measures</option>
            {measures.map((measure) => (
              <option key={measure.id} value={measure.id}>
                {measure.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-600">
          Priority{" "}
          <select
            className="ml-2 rounded border border-slate-300 px-2 py-1 text-sm"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
          >
            <option value="">All Priorities</option>
            <option value="HIGH">HIGH</option>
            <option value="MEDIUM">MEDIUM</option>
            <option value="LOW">LOW</option>
          </select>
        </label>
        <label className="text-sm text-slate-600">
          Assignee{" "}
          <select
            className="ml-2 rounded border border-slate-300 px-2 py-1 text-sm"
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
          >
            <option value="">All Assignees</option>
            <option value="unassigned">Unassigned</option>
            {[...new Set(cases.map((item) => item.assignee).filter((item): item is string => Boolean(item)))].map((assignee) => (
              <option key={assignee} value={assignee}>
                {assignee}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-600">
          Site{" "}
          <select
            className="ml-2 rounded border border-slate-300 px-2 py-1 text-sm"
            value={siteFilter}
            onChange={(e) => setSiteFilter(e.target.value)}
          >
            <option value="">All Sites</option>
            {[...new Set(cases.map((item) => item.site).filter(Boolean))].map((site) => (
              <option key={site} value={site}>
                {site}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-600">
          Search
          <input
            className="ml-2 rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="Employee name or ID"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </label>
      </div>

      {selectedCaseIds.length > 0 ? (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-semibold text-blue-900">{selectedCaseIds.length} selected</span>
            <input
              className="rounded border border-blue-300 bg-white px-2 py-1"
              placeholder="Assignee for selected"
              value={bulkAssignee}
              onChange={(e) => setBulkAssignee(e.target.value)}
            />
            <button
              className="rounded-md border border-blue-300 bg-white px-3 py-1 font-semibold text-blue-900 disabled:opacity-60"
              disabled={bulkActing !== null}
              onClick={() => void bulkAssign()}
            >
              {bulkActing === "assign" ? "Assigning..." : "Assign to..."}
            </button>
            <button
              className="rounded-md border border-rose-300 bg-rose-50 px-3 py-1 font-semibold text-rose-900 disabled:opacity-60"
              disabled={bulkActing !== null}
              onClick={() => void bulkEscalate()}
            >
              {bulkActing === "escalate" ? "Escalating..." : "Escalate selected"}
            </button>
            <button
              className="rounded-md border border-slate-300 bg-white px-3 py-1 font-semibold text-slate-900 disabled:opacity-60"
              disabled={bulkActing !== null}
              onClick={() => void bulkExportSelected()}
            >
              {bulkActing === "export" ? "Exporting..." : "Export selected"}
            </button>
          </div>
        </div>
      ) : null}

      {loading ? <p className="text-sm text-slate-600">Loading cases...</p> : null}
      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}

      {!loading && !error && filteredCases.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600">
          No open cases. Run a measure to generate cases.
        </div>
      ) : null}

      {filteredCases.length > 0 ? (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered} />
          <span>Select all in current results</span>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filteredCases.map((item) => (
          <div key={item.caseId} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={selectedCaseIds.includes(item.caseId)}
                  onChange={() => toggleCase(item.caseId)}
                />
                Select
              </label>
              <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white">{item.priority}</span>
            </div>

            <div className="mt-2">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.measureName}</p>
              <h4 className="mt-1 text-lg font-semibold text-slate-900">{item.employeeName}</h4>
              <p className="mt-1 text-sm text-slate-500">{item.employeeId}</p>
              <p className="mt-1 text-xs text-slate-500">{item.site}</p>
            </div>

            <dl className="mt-4 space-y-2 text-sm text-slate-700">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">Status</dt>
                <dd className="font-medium">{item.status}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">Why flagged</dt>
                <dd>
                  <span className={`rounded-full px-2 py-1 text-xs font-semibold ${outcomeStatusClass(item.currentOutcomeStatus)}`}>
                    {item.currentOutcomeStatus}
                  </span>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">Period</dt>
                <dd className="font-medium">{item.evaluationPeriod}</dd>
              </div>
            </dl>

            <p className="mt-4 text-sm text-slate-600">Updated {new Date(item.updatedAt).toLocaleString()}.</p>
            <Link href={`/cases/${item.caseId}`} className="mt-2 inline-block text-sm font-medium text-slate-900 hover:underline">
              View structured evidence →
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}
