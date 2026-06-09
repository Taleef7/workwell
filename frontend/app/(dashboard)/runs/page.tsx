"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { emitToast } from "@/lib/toast";
import {
  MEASURE_STATUS_LABELS,
  OUTCOME_LABELS,
  RUN_STATUS_LABELS,
  SCOPE_LABELS,
  ROLE_LABELS,
  TRIGGER_LABELS,
  formatStatusLabel,
  labelFor,
  normalizeEnumValue,
  outcomeStatusClass
} from "@/lib/status";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";
import { SkeletonRow } from "@/components/skeleton-loader";
import { AuditPacketExportButton } from "@/components/audit-packet-export-button";

type RunListItem = {
  runId: string;
  measureName: string;
  status: string;
  scopeType: string;
  triggerType: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
  totalEvaluated: number;
  compliantCount: number;
  nonCompliantCount: number;
};

type RunSummary = {
  runId: string;
  measureName: string;
  measureVersion: string;
  status: string;
  triggerType: string;
  scopeType: string;
  startedAt: string | null;
  completedAt: string | null;
  totalEvaluated: number;
  totalCases: number;
  compliantCount: number;
  nonCompliantCount: number;
  passRate: number;
  durationMs: number;
  outcomeCounts: Array<{ status: string; count: number }>;
  dataFreshAsOf: string | null;
  dataFreshnessMinutes: number;
};

type RunLogEntry = {
  timestamp: string;
  level: string;
  message: string;
};

type RunOutcomeRow = {
  employeeName: string;
  employeeExternalId: string;
  role: string;
  site: string;
  outcomeStatus: string;
  daysSinceExam: string | null;
  waiverStatus: string | null;
  caseId: string | null;
};

type ManualRunResponse = {
  runId: string;
  scopeType?: string;
  scopeLabel?: string;
  status: string;
  activeMeasuresExecuted?: number;
  totalEvaluated?: number;
  compliant?: number;
  nonCompliant?: number;
  message: string;
  measuresExecuted?: string[];
};

type RunScopeType = "ALL_PROGRAMS" | "MEASURE" | "SITE" | "EMPLOYEE" | "CASE";

type MeasureOption = {
  id: string;
  name: string;
  version: string;
  status: string;
};

type RunInsightResponse = {
  fallback: boolean;
  insights: string[];
};

const RUN_PAGE_SIZE = 20;
const MAX_DISPLAY_DURATION_MS = 60 * 60 * 1000;
const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "PARTIAL_FAILURE", "CANCELLED"]);

function formatAbsoluteTimestamp(dateString: string | null): string {
  if (!dateString) return "-";
  const date = new Date(dateString);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function formatRelativeTimestamp(dateString: string | null): string {
  if (!dateString) return "-";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "-";

  const diffMs = Date.now() - date.getTime();
  const absMinutes = Math.floor(Math.abs(diffMs) / 60_000);
  if (absMinutes < 1) return "just now";

  if (absMinutes < 60) {
    const suffix = diffMs >= 0 ? "ago" : "from now";
    return `${absMinutes}m ${suffix}`;
  }

  const absHours = Math.floor(absMinutes / 60);
  if (absHours < 24) {
    const suffix = diffMs >= 0 ? "ago" : "from now";
    return `${absHours}h ${suffix}`;
  }

  const absDays = Math.floor(absHours / 24);
  if (absDays < 7) {
    const suffix = diffMs >= 0 ? "ago" : "from now";
    return `${absDays}d ${suffix}`;
  }

  return date.toLocaleDateString();
}

function formatRunDuration(durationMs: number, status?: string): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "-";
  if (durationMs > MAX_DISPLAY_DURATION_MS) {
    return normalizeEnumValue(status ?? "") === "RUNNING" ? "Stalled" : "-";
  }
  return `${Math.round(durationMs / 1000)}s`;
}

export default function RunsPage() {
  const api = useApi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlRunId = searchParams.get("runId");
  const urlRunIdRef = useRef<string | null>(urlRunId);
  const runsRef = useRef<RunListItem[]>([]);

  const [statusFilter, setStatusFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [triggerFilter, setTriggerFilter] = useState("");
  const [limit, setLimit] = useState(RUN_PAGE_SIZE);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(urlRunId);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [runLogs, setRunLogs] = useState<RunLogEntry[]>([]);
  const [runOutcomes, setRunOutcomes] = useState<RunOutcomeRow[]>([]);
  const [measures, setMeasures] = useState<MeasureOption[]>([]);
  const [runScopeType, setRunScopeType] = useState<RunScopeType>("ALL_PROGRAMS");
  const [runMeasureId, setRunMeasureId] = useState("");
  const [runSite, setRunSite] = useState("");
  const [runEmployeeExternalId, setRunEmployeeExternalId] = useState("");
  const [runCaseId, setRunCaseId] = useState("");
  const [runEvaluationDate, setRunEvaluationDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runInsight, setRunInsight] = useState<RunInsightResponse | null>(null);
  const [insightDismissed, setInsightDismissed] = useState(false);
  const [isRunTriggering, setIsRunTriggering] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunStartedAt, setActiveRunStartedAt] = useState<Date | null>(null);
  const [runElapsedSec, setRunElapsedSec] = useState(0);
  const { siteId, from, to } = useGlobalFilters();
  const rerunSupported = selectedRun
    ? ["ALL_PROGRAMS", "MEASURE", "SITE", "EMPLOYEE", "CASE"].includes(normalizeEnumValue(selectedRun.scopeType))
    : false;
  const selectedRunIdRef = useRef<string | null>(selectedRunId);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);


  const loadMeasures = useCallback(async () => {
    try {
      const data = await api.get<MeasureOption[]>("/api/measures");
      setMeasures(data);
      setRunMeasureId((current) => current || (data.length > 0 ? data[0].id : ""));
    } catch {
      setMeasures([]);
    }
  }, [api]);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      query.set("limit", String(limit));
      if (statusFilter) query.set("status", statusFilter);
      if (scopeFilter) query.set("scopeType", scopeFilter);
      if (triggerFilter) query.set("triggerType", triggerFilter);
      if (siteId) query.set("site", siteId);
      if (from) query.set("from", from);
      if (to) query.set("to", to);
      const data = await api.get<RunListItem[]>(`/api/runs?${query.toString()}`);
      setRuns(data);
      runsRef.current = data;
      const currentSelectedRunId = selectedRunIdRef.current;
      const nextSelectedRunId =
        currentSelectedRunId &&
        (data.some((run) => run.runId === currentSelectedRunId) ||
          currentSelectedRunId === urlRunIdRef.current)
          ? currentSelectedRunId
          : data[0]?.runId ?? null;
      if (nextSelectedRunId !== currentSelectedRunId) {
        setSelectedRunId(nextSelectedRunId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [api, limit, statusFilter, scopeFilter, triggerFilter, siteId, from, to]);

  const loadSelectedRun = useCallback(async () => {
    if (!selectedRunId) return;
    try {
      const [summary, logs] = await Promise.all([
        api.get<RunSummary>(`/api/runs/${selectedRunId}`),
        api.get<RunLogEntry[]>(`/api/runs/${selectedRunId}/logs?limit=200`)
      ]);
      setSelectedRun(summary);
      setRunLogs(logs);
      try {
        const outcomes = await api.get<RunOutcomeRow[]>(`/api/runs/${selectedRunId}/outcomes`);
        setRunOutcomes(outcomes);
      } catch {
        setRunOutcomes([]);
      }
      setInsightDismissed(false);
    } catch (err) {
      // A deep-linked runId (?runId=...) that no longer exists or is invalid
      // must not strand the user on an error path: drop the URL preservation,
      // clean the query param, and fall back to the newest available run.
      if (selectedRunId === urlRunIdRef.current) {
        urlRunIdRef.current = null;
        router.replace("/runs");
        const fallbackRunId = runsRef.current.find((run) => run.runId !== selectedRunId)?.runId ?? null;
        setSelectedRun(null);
        setRunLogs([]);
        setRunOutcomes([]);
        setSelectedRunId(fallbackRunId);
        return;
      }
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api, router, selectedRunId]);

  const loadRunInsight = useCallback(async () => {
    if (!selectedRunId) return;
    try {
      const data = await api.post<undefined, RunInsightResponse>(`/api/runs/${selectedRunId}/ai/insight`);
      setRunInsight(data);
    } catch {
      setRunInsight(null);
    }
  }, [api, selectedRunId]);

  // Poll the active run every 2 s; stop and reload when it reaches a terminal state.
  useEffect(() => {
    if (!activeRunId) return;
    const interval = setInterval(async () => {
      try {
        const updated = await api.get<RunListItem>(`/api/runs/${activeRunId}`);
        setRuns((prev) =>
          prev.map((r) =>
            r.runId === activeRunId
              ? { ...r, status: updated.status, durationMs: updated.durationMs, completedAt: updated.completedAt }
              : r
          )
        );
        if (TERMINAL_RUN_STATUSES.has(normalizeEnumValue(updated.status))) {
          setActiveRunId(null);
          setActiveRunStartedAt(null);
          setIsRunTriggering(false);
          void loadRuns();
          if (selectedRunIdRef.current === activeRunId) {
            void (async () => {
              try {
                const [summary, logs] = await Promise.all([
                  api.get<RunSummary>(`/api/runs/${activeRunId}`),
                  api.get<RunLogEntry[]>(`/api/runs/${activeRunId}/logs?limit=200`),
                ]);
                setSelectedRun(summary);
                setRunLogs(logs);
                api
                  .get<RunOutcomeRow[]>(`/api/runs/${activeRunId}/outcomes`)
                  .then(setRunOutcomes)
                  .catch(() => setRunOutcomes([]));
              } catch {
                // ignore transient error on completion reload
              }
            })();
          }
        }
      } catch {
        // transient polling error — keep going
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [activeRunId, api, loadRuns]);

  // Live elapsed-second timer while a run is in progress.
  useEffect(() => {
    if (!activeRunStartedAt) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRunElapsedSec(0);
      return;
    }
    setRunElapsedSec(Math.floor((Date.now() - activeRunStartedAt.getTime()) / 1000));
    const interval = setInterval(() => {
      setRunElapsedSec(Math.floor((Date.now() - activeRunStartedAt.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [activeRunStartedAt]);

  useEffect(() => {
    urlRunIdRef.current = urlRunId;
    if (urlRunId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedRunId(urlRunId);
    }
  }, [urlRunId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRuns();
    void loadMeasures();
  }, [loadMeasures, loadRuns]);

  useEffect(() => {
    if (selectedRunId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadSelectedRun();
      void loadRunInsight();
    }
  }, [selectedRunId, loadSelectedRun, loadRunInsight]);

  async function runManualScope() {
    setError(null);
    setIsRunTriggering(true);
    try {
      const payload: Record<string, string | boolean | null> = {
        scopeType: runScopeType,
        dryRun: false
      };
      if (runScopeType === "MEASURE") {
        if (!runMeasureId) {
          throw new Error("Select a measure before running a measure-scoped job.");
        }
        payload.measureId = runMeasureId;
      } else if (runScopeType === "SITE") {
        if (!runSite.trim()) {
          throw new Error("Enter a site before running a site-scoped job.");
        }
        payload.site = runSite.trim();
      } else if (runScopeType === "EMPLOYEE") {
        if (!runEmployeeExternalId.trim()) {
          throw new Error("Enter an employee external ID before running an employee-scoped job.");
        }
        payload.employeeExternalId = runEmployeeExternalId.trim();
      } else if (runScopeType === "CASE") {
        if (!runCaseId.trim()) {
          throw new Error("Enter a case ID before running a case-scoped job.");
        }
        payload.caseId = runCaseId.trim();
      }
      if (runEvaluationDate) {
        payload.evaluationDate = runEvaluationDate;
      }
      const data = await api.post<typeof payload, ManualRunResponse>("/api/runs/manual", payload);
      emitToast(data.scopeLabel ? `${data.scopeLabel} - ${data.message}` : data.message);
      setSelectedRunId(data.runId);
      setActiveRunId(data.runId);
      setActiveRunStartedAt(new Date());
      await loadRuns();
      // Detail will reload via useEffect([selectedRunId, ...]) — no duplicate call needed.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setIsRunTriggering(false);
    }
  }

  async function rerunSameScope() {
    if (!selectedRunId) return;
    setError(null);
    setIsRunTriggering(true);
    try {
      const data = await api.post<undefined, ManualRunResponse>(`/api/runs/${selectedRunId}/rerun`);
      emitToast("Rerun started");
      setSelectedRunId(data.runId);
      setActiveRunId(data.runId);
      setActiveRunStartedAt(new Date());
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setIsRunTriggering(false);
    }
  }

  async function downloadCsv(path: string, filename: string) {
    const blob = await api.downloadBlob(path);
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.URL.revokeObjectURL(url);
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold">Run History</h2>
        <div className="flex items-center gap-2">
          <button
            className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-xs font-semibold text-neutral-800 dark:text-neutral-200"
            onClick={() => void downloadCsv("/api/exports/runs?format=csv", "runs-export.csv")}
          >
            Export runs CSV
          </button>
          <button
            className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-xs font-semibold text-neutral-800 dark:text-neutral-200"
            onClick={() =>
              void downloadCsv(
                `/api/exports/outcomes?format=csv${selectedRunId ? `&runId=${encodeURIComponent(selectedRunId)}` : ""}`,
                "outcomes.csv"
              )
            }
          >
            Export outcomes CSV
          </button>
          <button
            className="flex items-center gap-2 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-2 text-sm font-medium text-neutral-800 dark:text-neutral-200 disabled:opacity-60"
            onClick={() => void rerunSameScope()}
            disabled={!selectedRunId || !rerunSupported || isRunTriggering}
          >
            {isRunTriggering ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Running…
              </>
            ) : (
              "Rerun Selected Scope"
            )}
          </button>
        </div>
      </div>

      <div className="grid gap-2 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 md:grid-cols-4">
        <select className="rounded border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="completed">{labelFor(RUN_STATUS_LABELS, "COMPLETED")}</option>
          <option value="running">{labelFor(RUN_STATUS_LABELS, "RUNNING")}</option>
          <option value="failed">{labelFor(RUN_STATUS_LABELS, "FAILED")}</option>
          <option value="partial">{labelFor(RUN_STATUS_LABELS, "PARTIAL")}</option>
        </select>
        <select className="rounded border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-sm" value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)}>
          <option value="">All Scope Types</option>
          <option value="all_programs">{labelFor(SCOPE_LABELS, "ALL_PROGRAMS")}</option>
          <option value="measure">{labelFor(SCOPE_LABELS, "MEASURE")}</option>
          <option value="site">{labelFor(SCOPE_LABELS, "SITE")}</option>
          <option value="employee">{labelFor(SCOPE_LABELS, "EMPLOYEE")}</option>
          <option value="case">{labelFor(SCOPE_LABELS, "CASE")}</option>
        </select>
        <select className="rounded border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-sm" value={triggerFilter} onChange={(e) => setTriggerFilter(e.target.value)}>
          <option value="">All Trigger Types</option>
          <option value="manual">{labelFor(TRIGGER_LABELS, "MANUAL")}</option>
          <option value="scheduler">{labelFor(TRIGGER_LABELS, "SCHEDULER")}</option>
        </select>
        <button className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm text-neutral-700 dark:text-neutral-300" onClick={() => void loadRuns()}>
          Refresh
        </button>
      </div>

      <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Scope</label>
            <select
              className="w-full rounded border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm"
              value={runScopeType}
              onChange={(e) => setRunScopeType(e.target.value as RunScopeType)}
            >
              <option value="ALL_PROGRAMS">{labelFor(SCOPE_LABELS, "ALL_PROGRAMS")}</option>
              <option value="MEASURE">{labelFor(SCOPE_LABELS, "MEASURE")}</option>
              <option value="SITE">{labelFor(SCOPE_LABELS, "SITE")}</option>
              <option value="EMPLOYEE">{labelFor(SCOPE_LABELS, "EMPLOYEE")}</option>
              <option value="CASE">{labelFor(SCOPE_LABELS, "CASE")}</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Measure</label>
            <select
              className="w-full rounded border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm disabled:bg-neutral-100 dark:bg-neutral-800"
              value={runMeasureId}
              onChange={(e) => setRunMeasureId(e.target.value)}
              disabled={runScopeType !== "MEASURE"}
            >
              <option value="">Select a measure</option>
              {measures.map((measure) => (
                <option key={measure.id} value={measure.id}>
                  {measure.name} v{measure.version} ({labelFor(MEASURE_STATUS_LABELS, measure.status)})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Evaluation Date</label>
            <input
              type="date"
              className="w-full rounded border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm"
              value={runEvaluationDate}
              onChange={(e) => setRunEvaluationDate(e.target.value)}
            />
          </div>
          {runScopeType === "SITE" ? (
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Site</label>
              <input
                type="text"
                className="w-full rounded border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm"
                value={runSite}
                onChange={(e) => setRunSite(e.target.value)}
                placeholder="Enter a site name, for example Plant A"
              />
            </div>
          ) : null}
          {runScopeType === "EMPLOYEE" ? (
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Employee External ID</label>
              <input
                type="text"
                className="w-full rounded border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm"
                value={runEmployeeExternalId}
                onChange={(e) => setRunEmployeeExternalId(e.target.value)}
                placeholder="Enter an employee external ID, for example emp-041"
              />
            </div>
          ) : null}
          {runScopeType === "CASE" ? (
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Case ID</label>
              <input
                type="text"
                className="w-full rounded border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm"
                value={runCaseId}
                onChange={(e) => setRunCaseId(e.target.value)}
                placeholder="Paste a case UUID"
              />
            </div>
          ) : null}
          <div className="flex items-end">
            <button
              className="flex w-full items-center justify-center gap-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              onClick={() => void runManualScope()}
              disabled={isRunTriggering}
            >
              {isRunTriggering ? (
                <>
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Running…
                </>
              ) : (
                "Run Now"
              )}
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          MEASURE runs require a measure selection. SITE runs require a site name. EMPLOYEE runs require an employee external ID.
          CASE runs require a case UUID.
        </p>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {selectedRun && !rerunSupported ? (
        <p className="text-xs text-amber-700">Rerun is available only for all-programs, measure-scoped, site-scoped, employee-scoped, or case-scoped runs.</p>
      ) : null}
      {loading ? (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <table className="min-w-full text-sm">
            <tbody>{Array.from({ length: 10 }, (_, i) => <SkeletonRow key={i} cols={7} />)}</tbody>
          </table>
        </div>
      ) : null}
      {!loading && runs.length === 0 ? <p className="text-sm text-neutral-600 dark:text-neutral-400">No runs yet. Use the run controls above to start one.</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <table className="min-w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[40%]" />
              <col className="w-[14%]" />
              <col className="w-[16%]" />
              <col className="w-[10%]" />
              <col className="w-[20%]" />
            </colgroup>
            <thead className="bg-neutral-50 dark:bg-neutral-800/50 text-left text-neutral-600 dark:text-neutral-400">
              <tr>
                <th className="px-3 py-2">Run</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Scope</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.runId}
                  className={`cursor-pointer border-t border-neutral-200 dark:border-neutral-800 ${selectedRunId === run.runId ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-800/50"}`}
                  onClick={() => setSelectedRunId(run.runId)}
                >
                  <td className="px-3 py-2 align-top">
                    <p className="font-medium text-neutral-800 dark:text-neutral-200">{run.measureName}</p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400" title={run.runId}>
                      {run.runId.slice(0, 8)}...
                    </p>
                  </td>
                  <td className="px-3 py-2 align-top">{labelFor(RUN_STATUS_LABELS, run.status)}</td>
                  <td className="px-3 py-2 align-top">{labelFor(SCOPE_LABELS, run.scopeType)}</td>
                  <td className="px-3 py-2 align-top">
                    {run.runId === activeRunId ? (
                      <span className="tabular-nums">
                        {runElapsedSec}s <span className="animate-pulse text-neutral-400">●</span>
                      </span>
                    ) : (
                      formatRunDuration(run.durationMs, run.status)
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-neutral-600 dark:text-neutral-400" title={formatAbsoluteTimestamp(run.startedAt)}>
                    {formatRelativeTimestamp(run.startedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.length >= limit ? (
            <div className="border-t border-neutral-200 dark:border-neutral-800 px-3 py-3">
              <button
                className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-xs font-semibold text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 disabled:opacity-60"
                onClick={() => setLimit((current) => current + RUN_PAGE_SIZE)}
                disabled={loading}
              >
                Load more runs
              </button>
            </div>
          ) : null}
        </div>

        <div className="space-y-3 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Run Detail</h3>
          {runInsight && !runInsight.fallback && runInsight.insights.length > 0 && !insightDismissed ? (
            <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-primary-700 dark:text-primary-400">AI-generated operational insight - verify before acting</p>
                <button className="text-xs text-primary-700 dark:text-primary-400 underline" onClick={() => setInsightDismissed(true)}>
                  Dismiss
                </button>
              </div>
              <ul className="list-disc space-y-1 pl-4 text-xs text-blue-900">
                {runInsight.insights.map((item, idx) => (
                  <li key={`${idx}-${item}`}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {selectedRun ? (
            <>
              <p className="text-sm text-neutral-700 dark:text-neutral-300">
                {selectedRun.measureName} ({labelFor(SCOPE_LABELS, selectedRun.scopeType)}) - {labelFor(RUN_STATUS_LABELS, selectedRun.status)}
              </p>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">Trigger: {labelFor(TRIGGER_LABELS, selectedRun.triggerType)}</p>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">Started: {selectedRun.startedAt ? new Date(selectedRun.startedAt).toLocaleString() : "-"}</p>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">Completed: {selectedRun.completedAt ? new Date(selectedRun.completedAt).toLocaleString() : "-"}</p>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">
                Duration:{" "}
                {selectedRunId === activeRunId ? (
                  <span className="tabular-nums">
                    {runElapsedSec}s <span className="animate-pulse text-neutral-400">●</span>
                  </span>
                ) : (
                  formatRunDuration(selectedRun.durationMs, selectedRun.status)
                )}
              </p>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">Evaluated: {selectedRun.totalEvaluated}</p>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">Cases: {selectedRun.totalCases}</p>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">Pass Rate: {selectedRun.passRate.toFixed(1)}%</p>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">
                Data Freshness: {selectedRun.dataFreshnessMinutes >= 0 ? `${selectedRun.dataFreshnessMinutes} min old` : "unknown"}
              </p>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">
                Data Fresh As Of: {selectedRun.dataFreshAsOf ? new Date(selectedRun.dataFreshAsOf).toLocaleString() : "-"}
              </p>
              <div>
                <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">Outcome Counts</p>
                <ul className="text-xs text-neutral-600 dark:text-neutral-400">
                  {selectedRun.outcomeCounts.map((item) => (
                    <li key={item.status}>
                      {labelFor(OUTCOME_LABELS, item.status)}: {item.count}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-1">
                <AuditPacketExportButton
                  api={api}
                  path={`/api/auditor/runs/${selectedRunId}/packet`}
                  filenamePrefix={`workwell-run-packet-${selectedRunId}`}
                  label="Export Run Audit Packet"
                  onError={(message) => setError(message || null)}
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">Select a run to view details.</p>
          )}
        </div>
      </div>

      <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Run Logs</h3>
        {runLogs.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No logs for this run.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {runLogs.map((entry, idx) => (
              <li key={`${entry.timestamp}-${idx}`} className="rounded border border-neutral-200 dark:border-neutral-800 px-2 py-1">
                <span className="font-semibold text-neutral-700 dark:text-neutral-300">{formatStatusLabel(entry.level)}</span>{" "}
                <span className="text-neutral-500 dark:text-neutral-400">{new Date(entry.timestamp).toLocaleString()}</span>{" "}
                <span className="text-neutral-700 dark:text-neutral-300">{entry.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Outcomes</h3>
        {runOutcomes.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No outcomes for this run.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-neutral-50 dark:bg-neutral-800/50 text-left text-neutral-600 dark:text-neutral-400">
                <tr>
                  <th className="px-2 py-2">Employee</th>
                  <th className="px-2 py-2">Role</th>
                  <th className="px-2 py-2">Site</th>
                  <th className="px-2 py-2">Outcome</th>
                  <th className="px-2 py-2">Days Since Exam</th>
                  <th className="px-2 py-2">Waiver</th>
                  <th className="px-2 py-2">Case</th>
                </tr>
              </thead>
              <tbody>
                {runOutcomes.map((row) => {
                  const caseHref = row.caseId ? `/cases/${row.caseId}` : null;
                  return (
                    <tr
                      key={`${row.employeeExternalId}-${row.caseId ?? "none"}`}
                      className={
                        caseHref
                          ? "cursor-pointer border-t border-neutral-200 dark:border-neutral-800 hover:bg-blue-50"
                          : "cursor-default border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/40 dark:bg-neutral-800/40 text-neutral-500 dark:text-neutral-400"
                      }
                      onClick={caseHref ? () => router.push(caseHref) : undefined}
                      role={caseHref ? "link" : undefined}
                      tabIndex={caseHref ? 0 : undefined}
                      title={caseHref ? "Open case detail" : "No linked case"}
                      onKeyDown={
                        caseHref
                          ? (event) => {
                              // Only act when the row itself is focused — keydown
                              // bubbles from nested links (Employee / Case), and
                              // those must keep their own navigation.
                              if (event.target !== event.currentTarget) return;
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                router.push(caseHref);
                              }
                            }
                          : undefined
                      }
                    >
                      <td className="px-2 py-2">
                        <a
                          href={`/employees/${row.employeeExternalId}`}
                          className="font-medium text-neutral-800 dark:text-neutral-200 hover:underline hover:text-primary-700 dark:text-primary-400"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {row.employeeName}
                        </a>
                        <p className="text-neutral-500 dark:text-neutral-400">{row.employeeExternalId}</p>
                      </td>
                      <td className="px-2 py-2">{labelFor(ROLE_LABELS, row.role)}</td>
                      <td className="px-2 py-2">{row.site}</td>
                      <td className="px-2 py-2">
                        <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${outcomeStatusClass(row.outcomeStatus)}`}>
                          {labelFor(OUTCOME_LABELS, row.outcomeStatus)}
                        </span>
                      </td>
                      <td className="px-2 py-2">{row.daysSinceExam ?? "-"}</td>
                      <td className="px-2 py-2">{formatStatusLabel(row.waiverStatus)}</td>
                      <td className="px-2 py-2">
                        {caseHref ? (
                          <a
                            className="text-primary-700 dark:text-primary-400 underline"
                            href={caseHref}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {row.caseId?.slice(0, 8)}...
                          </a>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
