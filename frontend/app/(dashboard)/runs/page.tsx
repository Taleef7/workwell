"use client";

import { useCallback, useEffect, useState } from "react";
import { emitToast } from "@/lib/toast";
import { outcomeStatusClass } from "@/lib/status";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";

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
  scopeType: string;
  scopeLabel: string;
  status: string;
  activeMeasuresExecuted: number;
  totalEvaluated: number;
  compliant: number;
  nonCompliant: number;
  message: string;
  measuresExecuted: string[];
};

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

export default function RunsPage() {
  const api = useApi();

  const [statusFilter, setStatusFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [triggerFilter, setTriggerFilter] = useState("");
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [runLogs, setRunLogs] = useState<RunLogEntry[]>([]);
  const [runOutcomes, setRunOutcomes] = useState<RunOutcomeRow[]>([]);
  const [measures, setMeasures] = useState<MeasureOption[]>([]);
  const [runScopeType, setRunScopeType] = useState<"ALL_PROGRAMS" | "MEASURE" | "CASE">("ALL_PROGRAMS");
  const [runMeasureId, setRunMeasureId] = useState("");
  const [runCaseId, setRunCaseId] = useState("");
  const [runEvaluationDate, setRunEvaluationDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runInsight, setRunInsight] = useState<RunInsightResponse | null>(null);
  const [insightDismissed, setInsightDismissed] = useState(false);
  const { siteId, from, to } = useGlobalFilters();
  const rerunSupported = selectedRun ? ["all_programs", "measure", "case"].includes(selectedRun.scopeType) : false;

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
      query.set("limit", "100");
      if (statusFilter) query.set("status", statusFilter);
      if (scopeFilter) query.set("scopeType", scopeFilter);
      if (triggerFilter) query.set("triggerType", triggerFilter);
      if (siteId) query.set("site", siteId);
      if (from) query.set("from", from);
      if (to) query.set("to", to);
      const data = await api.get<RunListItem[]>(`/api/runs?${query.toString()}`);
      setRuns(data);
      if (!selectedRunId && data.length) {
        setSelectedRunId(data[0].runId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [api, selectedRunId, statusFilter, scopeFilter, triggerFilter, siteId, from, to]);

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
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api, selectedRunId]);

  const loadRunInsight = useCallback(async () => {
    if (!selectedRunId) return;
    try {
      const data = await api.post<undefined, RunInsightResponse>(`/api/runs/${selectedRunId}/ai/insight`);
      setRunInsight(data);
    } catch {
      setRunInsight(null);
    }
  }, [api, selectedRunId]);

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
      emitToast(`${data.scopeLabel} - ${data.message}`);
      setSelectedRunId(data.runId);
      await loadRuns();
      await loadSelectedRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function rerunSameScope() {
    if (!selectedRunId) return;
    setError(null);
    try {
      const data = await api.post<undefined, ManualRunResponse>(`/api/runs/${selectedRunId}/rerun`);
      emitToast("Rerun started");
      setSelectedRunId(data.runId);
      await loadRuns();
      await loadSelectedRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
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
            className="rounded border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800"
            onClick={() => void downloadCsv("/api/exports/runs?format=csv", "runs-export.csv")}
          >
            Export runs CSV
          </button>
          <button
            className="rounded border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800"
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
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 disabled:opacity-60"
            onClick={() => void rerunSameScope()}
            disabled={!selectedRunId || !rerunSupported}
          >
            Rerun Selected Scope
          </button>
        </div>
      </div>

      <div className="grid gap-2 rounded-md border border-slate-200 bg-white p-3 md:grid-cols-4">
        <select className="rounded border border-slate-300 px-2 py-1 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="completed">completed</option>
          <option value="running">running</option>
          <option value="failed">failed</option>
          <option value="partial">partial</option>
        </select>
        <select className="rounded border border-slate-300 px-2 py-1 text-sm" value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)}>
          <option value="">All Scope Types</option>
          <option value="all_programs">all_programs</option>
          <option value="measure">measure</option>
          <option value="case">case</option>
        </select>
        <select className="rounded border border-slate-300 px-2 py-1 text-sm" value={triggerFilter} onChange={(e) => setTriggerFilter(e.target.value)}>
          <option value="">All Trigger Types</option>
          <option value="manual">manual</option>
          <option value="scheduler">scheduler</option>
        </select>
        <button className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700" onClick={() => void loadRuns()}>
          Refresh
        </button>
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Scope</label>
            <select
              className="w-full rounded border border-slate-300 px-2 py-2 text-sm"
              value={runScopeType}
              onChange={(e) => setRunScopeType(e.target.value as "ALL_PROGRAMS" | "MEASURE" | "CASE")}
            >
              <option value="ALL_PROGRAMS">ALL_PROGRAMS</option>
              <option value="MEASURE">MEASURE</option>
              <option value="CASE">CASE</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Measure</label>
            <select
              className="w-full rounded border border-slate-300 px-2 py-2 text-sm disabled:bg-slate-100"
              value={runMeasureId}
              onChange={(e) => setRunMeasureId(e.target.value)}
              disabled={runScopeType !== "MEASURE"}
            >
              <option value="">Select a measure</option>
              {measures.map((measure) => (
                <option key={measure.id} value={measure.id}>
                  {measure.name} v{measure.version} ({measure.status})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Evaluation Date</label>
            <input
              type="date"
              className="w-full rounded border border-slate-300 px-2 py-2 text-sm"
              value={runEvaluationDate}
              onChange={(e) => setRunEvaluationDate(e.target.value)}
            />
          </div>
          {runScopeType === "CASE" ? (
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Case ID</label>
              <input
                type="text"
                className="w-full rounded border border-slate-300 px-2 py-2 text-sm"
                value={runCaseId}
                onChange={(e) => setRunCaseId(e.target.value)}
                placeholder="Paste a case UUID"
              />
            </div>
          ) : null}
          <div className="flex items-end">
            <button className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white" onClick={() => void runManualScope()}>
              Run Now
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-500">MEASURE runs require a measure selection. CASE runs require a case UUID.</p>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {selectedRun && !rerunSupported ? (
        <p className="text-xs text-amber-700">Rerun is available only for all-programs, measure-scoped, or case-scoped runs.</p>
      ) : null}
      {loading ? <p className="text-sm text-slate-600">Loading runs...</p> : null}
      {!loading && runs.length === 0 ? <p className="text-sm text-slate-600">No runs yet. Use the run controls above to start one.</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2">Run</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Scope</th>
                <th className="px-3 py-2">Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.runId}
                  className={`cursor-pointer border-t border-slate-200 ${selectedRunId === run.runId ? "bg-slate-100" : "hover:bg-slate-50"}`}
                  onClick={() => setSelectedRunId(run.runId)}
                >
                  <td className="px-3 py-2">
                    <p className="font-medium text-slate-800">{run.measureName}</p>
                    <p className="text-xs text-slate-500">{run.runId}</p>
                    <p className="text-xs text-slate-500">{run.startedAt ? new Date(run.startedAt).toLocaleString() : "-"}</p>
                  </td>
                  <td className="px-3 py-2">{run.status}</td>
                  <td className="px-3 py-2">{run.scopeType}</td>
                  <td className="px-3 py-2">{Math.round(run.durationMs / 1000)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-3 rounded-md border border-slate-200 bg-white p-3">
          <h3 className="text-sm font-semibold text-slate-900">Run Detail</h3>
          {runInsight && !runInsight.fallback && runInsight.insights.length > 0 && !insightDismissed ? (
            <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-blue-700">AI-generated operational insight - verify before acting</p>
                <button className="text-xs text-blue-700 underline" onClick={() => setInsightDismissed(true)}>
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
              <p className="text-sm text-slate-700">
                {selectedRun.measureName} ({selectedRun.scopeType}) - {selectedRun.status}
              </p>
              <p className="text-xs text-slate-600">Trigger: {selectedRun.triggerType}</p>
              <p className="text-xs text-slate-600">Started: {selectedRun.startedAt ? new Date(selectedRun.startedAt).toLocaleString() : "-"}</p>
              <p className="text-xs text-slate-600">Completed: {selectedRun.completedAt ? new Date(selectedRun.completedAt).toLocaleString() : "-"}</p>
              <p className="text-xs text-slate-600">Duration: {Math.round(selectedRun.durationMs / 1000)}s</p>
              <p className="text-xs text-slate-600">Evaluated: {selectedRun.totalEvaluated}</p>
              <p className="text-xs text-slate-600">Cases: {selectedRun.totalCases}</p>
              <p className="text-xs text-slate-600">Pass Rate: {selectedRun.passRate.toFixed(1)}%</p>
              <p className="text-xs text-slate-600">
                Data Freshness: {selectedRun.dataFreshnessMinutes >= 0 ? `${selectedRun.dataFreshnessMinutes} min old` : "unknown"}
              </p>
              <p className="text-xs text-slate-600">
                Data Fresh As Of: {selectedRun.dataFreshAsOf ? new Date(selectedRun.dataFreshAsOf).toLocaleString() : "-"}
              </p>
              <div>
                <p className="text-xs font-semibold text-slate-700">Outcome Counts</p>
                <ul className="text-xs text-slate-600">
                  {selectedRun.outcomeCounts.map((item) => (
                    <li key={item.status}>
                      {item.status}: {item.count}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-600">Select a run to view details.</p>
          )}
        </div>
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-3">
        <h3 className="text-sm font-semibold text-slate-900">Run Logs</h3>
        {runLogs.length === 0 ? (
          <p className="text-sm text-slate-600">No logs for this run.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {runLogs.map((entry, idx) => (
              <li key={`${entry.timestamp}-${idx}`} className="rounded border border-slate-200 px-2 py-1">
                <span className="font-semibold text-slate-700">{entry.level}</span>{" "}
                <span className="text-slate-500">{new Date(entry.timestamp).toLocaleString()}</span>{" "}
                <span className="text-slate-700">{entry.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-3">
        <h3 className="text-sm font-semibold text-slate-900">Outcomes</h3>
        {runOutcomes.length === 0 ? (
          <p className="text-sm text-slate-600">No outcomes for this run.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-left text-slate-600">
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
                {runOutcomes.map((row) => (
                  <tr key={`${row.employeeExternalId}-${row.caseId ?? "none"}`} className="border-t border-slate-200">
                    <td className="px-2 py-2">
                      <p className="font-medium text-slate-800">{row.employeeName}</p>
                      <p className="text-slate-500">{row.employeeExternalId}</p>
                    </td>
                    <td className="px-2 py-2">{row.role}</td>
                    <td className="px-2 py-2">{row.site}</td>
                    <td className="px-2 py-2">
                      <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${outcomeStatusClass(row.outcomeStatus)}`}>
                        {row.outcomeStatus}
                      </span>
                    </td>
                    <td className="px-2 py-2">{row.daysSinceExam ?? "-"}</td>
                    <td className="px-2 py-2">{row.waiverStatus ?? "-"}</td>
                    <td className="px-2 py-2">
                      {row.caseId ? (
                        <a className="text-blue-700 underline" href={`/cases/${row.caseId}`}>
                          {row.caseId.slice(0, 8)}...
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
