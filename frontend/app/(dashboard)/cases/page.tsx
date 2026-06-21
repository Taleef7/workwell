"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge, Button, Input, Select } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import {
  CASE_STATUS_LABELS,
  OUTCOME_LABELS,
  PRIORITY_LABELS,
  caseStatusClass,
  labelFor,
  normalizeEnumValue,
  outcomeStatusClass
} from "@/lib/status";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";
import { SkeletonRow } from "@/components/skeleton-loader";
import { useAuth } from "@/components/auth-provider";
import { canManageCases } from "@/lib/rbac";
import { SlaChip } from "@/components/SlaChip";
import { ChevronRight } from "lucide-react";

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
  exclusionReason: string | null;
  waiverExpiresAt: string | null;
  waiverExpired: boolean;
  updatedAt: string;
  slaRemainingDays?: number | null;
  slaBreached?: boolean;
};

type MeasureOption = {
  id: string;
  name: string;
  status: string;
};

type CaseStatusFilter = "open" | "closed" | "excluded" | "all";

const PRIORITY_BADGE_VARIANT: Record<string, "danger" | "warning" | "secondary"> = {
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "secondary"
};

function normalizeCaseStatusFilter(value: string | null): CaseStatusFilter {
  switch (value?.toLowerCase()) {
    case "closed":
      return "closed";
    case "excluded":
      return "excluded";
    case "all":
      return "all";
    case "open":
    default:
      return "open";
  }
}

export default function CasesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlStatus = searchParams.get("status");
  const urlSearch = searchParams.get("search") ?? "";
  const view = searchParams.get("view") ?? "all";
  const { user } = useAuth();
  const canManage = canManageCases(user?.role);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [measures, setMeasures] = useState<MeasureOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusFilter = normalizeCaseStatusFilter(urlStatus);
  const [measureFilter, setMeasureFilter] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [siteFilter, setSiteFilter] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState<string>(urlSearch);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [bulkAssignee, setBulkAssignee] = useState("");
  const [bulkActing, setBulkActing] = useState<"assign" | "escalate" | "export" | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const { siteId, from, to } = useGlobalFilters();
  const api = useApi();
  const [pageSize, setPageSize] = useState(25);
  const [outcomeFilter, setOutcomeFilter] = useState<string>("");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");

  // Track the most recent search value we ourselves wrote to the URL so we can
  // distinguish state-driven URL writes from external URL changes (browser
  // back/forward, deep links, other controls). Without this guard, an external
  // URL change would see a mismatch with stale local state and get clobbered
  // back to the old value after the debounce window.
  const lastWrittenSearchRef = useRef<string>(urlSearch);

  // URL → state: pull external URL changes into the input state.
  useEffect(() => {
    if (urlSearch === lastWrittenSearchRef.current) {
      return;
    }
    lastWrittenSearchRef.current = urlSearch;
    setSearchTerm(urlSearch);
  }, [urlSearch]);

  // state → URL: debounce-write user input to the URL.
  useEffect(() => {
    const trimmed = searchTerm.trim();
    if (trimmed === urlSearch.trim()) {
      return;
    }
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (trimmed) {
        params.set("search", trimmed);
      } else {
        params.delete("search");
      }
      const query = params.toString();
      lastWrittenSearchRef.current = trimmed;
      router.replace(query ? `${pathname}?${query}` : pathname);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchTerm, urlSearch, searchParams, router, pathname]);

  const loadMeasures = useCallback(async () => {
    try {
      const data = await api.get<MeasureOption[]>("/api/measures");
      setMeasures(data.filter((item) => item.status === "Active"));
    } catch {
      setMeasures([]);
    }
  }, [api, setMeasures]);

  const loadCases = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("status", statusFilter);
      if (measureFilter) params.set("measureId", measureFilter);
      if (priorityFilter) params.set("priority", priorityFilter);
      const effectiveAssignee = view === "mine" ? (user?.email ?? "") : assigneeFilter;
      if (effectiveAssignee) params.set("assignee", effectiveAssignee);
      if (siteFilter) {
        params.set("site", siteFilter);
      } else if (siteId) {
        params.set("site", siteId);
      }
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (outcomeFilter) params.set("outcome", outcomeFilter);
      if (urlSearch.trim()) params.set("search", urlSearch.trim());
      params.set("limit", String(pageSize));
      params.set("offset", "0");
      // #150 M10: X-Total-Count carries the full filtered match count, so paging is driven by the real
      // total (not the brittle "page was full" heuristic, which mis-signals when total is an exact multiple).
      const { data, headers } = await api.getWithHeaders<CaseSummary[]>(`/api/cases?${params.toString()}`);
      const matchTotal = Number(headers.get("X-Total-Count") ?? data.length);
      setCases(data);
      setTotal(Number.isFinite(matchTotal) ? matchTotal : data.length);
      setHasMore(data.length < (Number.isFinite(matchTotal) ? matchTotal : data.length));
      setSelectedCaseIds((existing) => existing.filter((id) => data.some((item) => item.caseId === id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [api, assigneeFilter, measureFilter, priorityFilter, siteFilter, outcomeFilter, pageSize, siteId, from, to, urlSearch, statusFilter, view, user, setLoading, setError, setCases, setSelectedCaseIds]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadMeasures();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadMeasures]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadCases();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadCases]);

  const filteredCases = cases;

  const allFilteredSelected = filteredCases.length > 0 && filteredCases.every((item) => selectedCaseIds.includes(item.caseId));

  const measureOptions = useMemo(
    () => [{ value: "", label: "All Active Measures" }, ...measures.map((m) => ({ value: m.id, label: m.name }))],
    [measures]
  );
  const priorityOptions = useMemo(
    () => [
      { value: "", label: "All Priorities" },
      { value: "HIGH", label: labelFor(PRIORITY_LABELS, "HIGH") },
      { value: "MEDIUM", label: labelFor(PRIORITY_LABELS, "MEDIUM") },
      { value: "LOW", label: labelFor(PRIORITY_LABELS, "LOW") }
    ],
    []
  );
  const assigneeOptions = useMemo(
    () => [
      { value: "", label: "All Assignees" },
      { value: "unassigned", label: "Unassigned" },
      ...[...new Set(cases.map((item) => item.assignee).filter((item): item is string => Boolean(item)))].map((a) => ({
        value: a,
        label: a
      }))
    ],
    [cases]
  );
  const siteOptions = useMemo(
    () => [
      { value: "", label: "All Sites" },
      ...[...new Set(cases.map((item) => item.site).filter(Boolean))].map((s) => ({ value: s, label: s }))
    ],
    [cases]
  );
  // Outcome bucket ("why flagged") — distinct from case status. Drives the new ?outcome= filter.
  const outcomeOptions = useMemo(
    () => [
      { value: "", label: "All Outcomes" },
      { value: "OVERDUE", label: labelFor(OUTCOME_LABELS, "OVERDUE") },
      { value: "DUE_SOON", label: labelFor(OUTCOME_LABELS, "DUE_SOON") },
      { value: "MISSING_DATA", label: labelFor(OUTCOME_LABELS, "MISSING_DATA") },
      { value: "COMPLIANT", label: labelFor(OUTCOME_LABELS, "COMPLIANT") },
      { value: "EXCLUDED", label: labelFor(OUTCOME_LABELS, "EXCLUDED") }
    ],
    []
  );
  const pageSizeOptions = useMemo(
    () => [25, 50, 100, 200, 500].map((n) => ({ value: String(n), label: `${n} / page` })),
    []
  );

  const setStatusAndUrl = useCallback((nextStatus: CaseStatusFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextStatus === "open") {
      params.delete("status");
    } else {
      params.set("status", nextStatus);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

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

  async function loadMoreCases() {
    setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      params.set("status", statusFilter);
      if (measureFilter) params.set("measureId", measureFilter);
      if (priorityFilter) params.set("priority", priorityFilter);
      const effectiveAssignee = view === "mine" ? (user?.email ?? "") : assigneeFilter;
      if (effectiveAssignee) params.set("assignee", effectiveAssignee);
      if (siteFilter) params.set("site", siteFilter);
      else if (siteId) params.set("site", siteId);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (outcomeFilter) params.set("outcome", outcomeFilter);
      if (urlSearch.trim()) params.set("search", urlSearch.trim());
      params.set("limit", String(pageSize));
      params.set("offset", String(cases.length));
      const { data: next, headers } = await api.getWithHeaders<CaseSummary[]>(`/api/cases?${params.toString()}`);
      const matchTotal = Number(headers.get("X-Total-Count") ?? 0);
      setCases((prev) => {
        const merged = [...prev, ...next];
        setHasMore(merged.length < (Number.isFinite(matchTotal) && matchTotal > 0 ? matchTotal : merged.length));
        return merged;
      });
      if (Number.isFinite(matchTotal) && matchTotal > 0) setTotal(matchTotal);
    } catch {
      // ignore
    } finally {
      setLoadingMore(false);
    }
  }

  async function exportCsv(urlPath: string, filename: string) {
    try {
      const blob = await api.downloadBlob(urlPath);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    }
  }

  async function bulkAssign() {
    if (selectedCaseIds.length === 0) return;
    setBulkActing("assign");
    setError(null);
    try {
      const assigneeQuery = bulkAssignee.trim() ? `?assignee=${encodeURIComponent(bulkAssignee.trim())}` : "";
      for (const caseId of selectedCaseIds) {
        await api.post(`/api/cases/${caseId}/assign${assigneeQuery}`);
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
    if (selectedCaseIds.length === 0) return;
    setBulkActing("escalate");
    setError(null);
    try {
      for (const caseId of selectedCaseIds) {
        await api.post(`/api/cases/${caseId}/escalate`);
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
      <div className="rounded-3xl border border-neutral-800 bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-950 p-8 text-white shadow-lg">
        <p className="text-sm uppercase tracking-[0.3em] text-neutral-300">Caseflow</p>
        <h2 className="mt-2 text-3xl font-semibold">Why Flagged cases</h2>
        <p className="mt-3 max-w-2xl text-neutral-300">
          Your daily worklist of employees flagged by the latest measure runs. Each card links to the structured
          evidence that explains why the case is open, including waiver context when an exclusion applies.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Open and recent cases</h3>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Filter, search, and bulk-act on flagged cases.</p>
        </div>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {total > cases.length
            ? `${cases.length} of ${total} cases`
            : `${cases.length} case${cases.length !== 1 ? "s" : ""} loaded`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void exportCsv(
                `/api/exports/cases?format=csv&status=${encodeURIComponent(statusFilter)}${measureFilter ? `&measureId=${encodeURIComponent(measureFilter)}` : ""}`,
                "cases.csv"
              )
            }
          >
            Export cases CSV
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void exportCsv("/api/audit-events/export?format=csv", "audit-events.csv")}
          >
            Export audit CSV
          </Button>
        </div>
      </div>

      <div className="mb-4 flex gap-0 border-b border-neutral-200 dark:border-neutral-800">
        {(["all", "mine"] as const).map((tab) => {
          const active = tab === "mine" ? view === "mine" : view !== "mine";
          return (
            <button
              key={tab}
              type="button"
              onClick={() => {
                const params = new URLSearchParams(searchParams.toString());
                params.set("view", tab);
                router.push(`/cases?${params.toString()}`);
              }}
              className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-primary-600 text-primary-700 dark:text-primary-400"
                  : "border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
              }`}
            >
              {tab === "mine" ? "My Cases" : "All Cases"}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
          <span>Status</span>
          {(["open", "closed", "all", "excluded"] as const).map((status) => (
            <Button
              key={status}
              type="button"
              size="sm"
              variant={statusFilter === status ? "primary" : "outline"}
              className="rounded-full"
              onClick={() => setStatusAndUrl(status)}
            >
              {status === "open" ? "Open" : status === "closed" ? "Closed" : status === "all" ? "All" : "Excluded"}
            </Button>
          ))}
        </div>
        <Select
          label="Measure"
          size="sm"
          className="w-48"
          value={measureFilter}
          onValueChange={setMeasureFilter}
          options={measureOptions}
        />
        <Select
          label="Priority"
          size="sm"
          className="w-40"
          value={priorityFilter}
          onValueChange={setPriorityFilter}
          options={priorityOptions}
        />
        <Select
          label="Assignee"
          size="sm"
          className="w-44"
          value={assigneeFilter}
          onValueChange={setAssigneeFilter}
          options={assigneeOptions}
        />
        <Select
          label="Site"
          size="sm"
          className="w-40"
          value={siteFilter}
          onValueChange={setSiteFilter}
          options={siteOptions}
        />
        <Select
          label="Outcome"
          size="sm"
          className="w-44"
          value={outcomeFilter}
          onValueChange={setOutcomeFilter}
          options={outcomeOptions}
        />
        <Input
          label="Search"
          size="sm"
          className="w-56"
          placeholder="Employee name or ID"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <Select
          label="Per page"
          size="sm"
          className="w-32"
          value={String(pageSize)}
          onValueChange={(v) => setPageSize(Number(v))}
          options={pageSizeOptions}
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">View</span>
          <div className="inline-flex overflow-hidden rounded-lg border border-neutral-300 dark:border-neutral-700" role="group" aria-label="Result view">
            {(["cards", "table"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={viewMode === mode}
                onClick={() => setViewMode(mode)}
                className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  viewMode === mode
                    ? "bg-primary-600 text-white"
                    : "bg-white text-neutral-600 hover:bg-neutral-50 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>

      {canManage && selectedCaseIds.length > 0 ? (
        <div className="rounded-xl border border-primary-200 bg-primary-50 p-3 dark:border-primary-800 dark:bg-primary-900/20">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-semibold text-primary-900 dark:text-primary-200">{selectedCaseIds.length} selected</span>
            <Input
              label="Assignee for selected"
              hideLabel
              size="sm"
              className="w-48"
              placeholder="Assignee for selected"
              value={bulkAssignee}
              onChange={(e) => setBulkAssignee(e.target.value)}
            />
            <Button size="sm" variant="primary" disabled={bulkActing !== null} onClick={() => void bulkAssign()}>
              {bulkActing === "assign" ? "Assigning..." : "Assign to..."}
            </Button>
            <Button size="sm" variant="danger" disabled={bulkActing !== null} onClick={() => void bulkEscalate()}>
              {bulkActing === "escalate" ? "Escalating..." : "Escalate selected"}
            </Button>
            <Button size="sm" variant="outline" disabled={bulkActing !== null} onClick={() => void bulkExportSelected()}>
              {bulkActing === "export" ? "Exporting..." : "Export selected"}
            </Button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table className="min-w-full text-sm">
            <tbody>{Array.from({ length: 10 }, (_, i) => <SkeletonRow key={i} cols={8} />)}</tbody>
          </table>
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-700 dark:text-red-400">Error: {error}</p> : null}

      {!loading && !error && filteredCases.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
          {urlSearch.trim()
            ? `No results match your search "${urlSearch.trim()}".`
            : statusFilter === "excluded"
              ? "No excluded cases yet."
              : statusFilter === "closed"
                ? "No closed cases yet."
                : statusFilter === "all"
                  ? "No cases found for the current filters."
                  : "No open cases. Run a measure to generate cases."}
        </div>
      ) : null}

      {canManage && filteredCases.length > 0 ? (
        <label className="hidden items-center gap-2 text-sm text-neutral-600 md:flex dark:text-neutral-400">
          <input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered} />
          <span>Select all in current results</span>
        </label>
      ) : null}

      <div className="space-y-2 md:hidden">
        {filteredCases.map((item) => {
          const outcomeLabel = labelFor(OUTCOME_LABELS, item.currentOutcomeStatus);
          return (
            <Link
              key={item.caseId}
              href={`/cases/${item.caseId}`}
              className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{item.employeeName}</p>
                <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{item.measureName}</p>
              </div>
              <div className="ml-3 flex items-center gap-2">
                <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${outcomeStatusClass(item.currentOutcomeStatus)}`}>
                  {outcomeLabel}
                </span>
                <ChevronRight className="h-4 w-4 text-neutral-400" />
              </div>
            </Link>
          );
        })}
      </div>

      {viewMode === "table" ? (
        <CasesTable items={filteredCases} selectedCaseIds={selectedCaseIds} onToggle={toggleCase} canManage={canManage} />
      ) : (
      <div className="hidden gap-4 md:grid md:grid-cols-2 xl:grid-cols-3">
        {filteredCases.map((item) => {
          const caseStatus = normalizeEnumValue(item.status);
          const caseStatusLabel = labelFor(CASE_STATUS_LABELS, item.status);
          const priorityLabel = labelFor(PRIORITY_LABELS, item.priority);
          const outcomeLabel = labelFor(OUTCOME_LABELS, item.currentOutcomeStatus);
          return (
            <div key={item.caseId} className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex items-start justify-between gap-3">
                {canManage ? (
                  <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                    <input
                      type="checkbox"
                      checked={selectedCaseIds.includes(item.caseId)}
                      onChange={() => toggleCase(item.caseId)}
                    />
                    Select
                  </label>
                ) : (
                  <span />
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${caseStatusClass(item.status)}`}>{caseStatusLabel}</span>
                  <Badge variant={PRIORITY_BADGE_VARIANT[normalizeEnumValue(item.priority)] ?? "secondary"}>{priorityLabel}</Badge>
                </div>
              </div>

              <div className="mt-2">
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">{item.measureName}</p>
                <h4 className="mt-1 text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                  <Link href={`/employees/${item.employeeId}`} className="hover:text-primary-700 hover:underline dark:hover:text-primary-400">
                    {item.employeeName}
                  </Link>
                </h4>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{item.employeeId}</p>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{item.site}</p>
              </div>

              <dl className="mt-4 space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-neutral-500 dark:text-neutral-400">Status</dt>
                  <dd className="font-medium">{caseStatusLabel}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-neutral-500 dark:text-neutral-400">Why flagged</dt>
                  <dd>
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${outcomeStatusClass(item.currentOutcomeStatus)}`}>
                      {outcomeLabel}
                    </span>
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-neutral-500 dark:text-neutral-400">Period</dt>
                  <dd className="font-medium">{item.evaluationPeriod}</dd>
                </div>
                {item.slaRemainingDays != null ? (
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-neutral-500 dark:text-neutral-400">SLA</dt>
                    <SlaChip slaRemainingDays={item.slaRemainingDays} slaBreached={item.slaBreached} />
                  </div>
                ) : null}
                {caseStatus === "EXCLUDED" ? (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <dt className="text-neutral-500 dark:text-neutral-400">Exclusion reason</dt>
                      <dd className="max-w-[220px] text-right text-xs text-neutral-700 dark:text-neutral-300">
                        {item.exclusionReason ?? "Excluded by active waiver or exemption."}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-neutral-500 dark:text-neutral-400">Waiver</dt>
                      <dd className="text-right text-xs font-medium text-neutral-700 dark:text-neutral-300">
                        {item.waiverExpiresAt ? (
                          <span className={`rounded-full px-2 py-1 ${item.waiverExpired ? "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300" : "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300"}`}>
                            {item.waiverExpired ? "Expired" : "Expires"} {new Date(item.waiverExpiresAt).toLocaleDateString()}
                          </span>
                        ) : (
                          "No expiry on file"
                        )}
                      </dd>
                    </div>
                  </>
                ) : null}
              </dl>

              <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">Updated {new Date(item.updatedAt).toLocaleString()}.</p>
              <Link href={`/cases/${item.caseId}`} className="mt-2 inline-block text-sm font-medium text-neutral-900 hover:underline dark:text-neutral-100">
                View structured evidence →
              </Link>
            </div>
          );
        })}
      </div>
      )}

      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" disabled={loadingMore} onClick={() => void loadMoreCases()}>
            {loadingMore ? "Loading…" : "Load more cases"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function CasesTable({
  items,
  selectedCaseIds,
  onToggle,
  canManage,
}: {
  items: CaseSummary[];
  selectedCaseIds: string[];
  onToggle: (caseId: string) => void;
  canManage: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="hidden overflow-x-auto rounded-2xl border border-neutral-200 bg-white md:block dark:border-neutral-800 dark:bg-neutral-900">
      <table className="min-w-full text-sm">
        <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-400">
          <tr>
            {canManage ? <th className="w-10 px-3 py-2" aria-label="Select" /> : null}
            <th className="px-3 py-2">Employee</th>
            <th className="px-3 py-2">Measure</th>
            <th className="px-3 py-2">Site</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Why flagged</th>
            <th className="px-3 py-2">Priority</th>
            <th className="px-3 py-2">Updated</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.caseId}
              className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-800/40"
            >
              {canManage ? (
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${item.employeeName}`}
                    checked={selectedCaseIds.includes(item.caseId)}
                    onChange={() => onToggle(item.caseId)}
                  />
                </td>
              ) : null}
              <td className="px-3 py-2">
                <Link
                  href={`/cases/${item.caseId}`}
                  className="font-medium text-neutral-900 hover:text-primary-700 hover:underline dark:text-neutral-100 dark:hover:text-primary-400"
                >
                  {item.employeeName}
                </Link>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{item.employeeId}</p>
              </td>
              <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{item.measureName}</td>
              <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{item.site}</td>
              <td className="px-3 py-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${caseStatusClass(item.status)}`}>
                  {labelFor(CASE_STATUS_LABELS, item.status)}
                </span>
              </td>
              <td className="px-3 py-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${outcomeStatusClass(item.currentOutcomeStatus)}`}>
                  {labelFor(OUTCOME_LABELS, item.currentOutcomeStatus)}
                </span>
              </td>
              <td className="px-3 py-2">
                <Badge variant={PRIORITY_BADGE_VARIANT[normalizeEnumValue(item.priority)] ?? "secondary"}>
                  {labelFor(PRIORITY_LABELS, item.priority)}
                </Badge>
              </td>
              <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                {new Date(item.updatedAt).toLocaleDateString()}
              </td>
              <td className="px-3 py-2 text-right">
                <Link href={`/cases/${item.caseId}`} className="text-xs font-medium text-primary-700 hover:underline dark:text-primary-400">
                  View →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
