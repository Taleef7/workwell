"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { emitToast } from "@/lib/toast";
import { outcomeStatusClass } from "@/lib/status";

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
  scope: string;
  activeMeasuresExecuted: number;
  measuresExecuted: string[];
};

type RunInsightResponse = {
  fallback: boolean;
  insights: string[];
};

export default function RunsPage() {
  const apiBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    return raw.trim().replace(/\/+$/, "");
  }, []);

  const [statusFilter, setStatusFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [triggerFilter, setTriggerFilter] = useState("");
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [runLogs, setRunLogs] = useState<RunLogEntry[]>([]);
  const [runOutcomes, setRunOutcomes] = useState<RunOutcomeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runInsight, setRunInsight] = useState<RunInsightResponse | null>(null);
  const [insightDismissed, setInsightDismissed] = useState(false);
  const rerunSupported = selectedRun ? selectedRun.scopeType === "all_programs" || selectedRun.scopeType === "measure" : false;

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      query.set("limit", "100");
      if (statusFilter) query.set("status", statusFilter);
      if (scopeFilter) query.set("scopeType", scopeFilter);
      if (triggerFilter) query.set("triggerType", triggerFilter);
      const response = await fetch(`${apiBase}/api/runs?${query.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to load runs (${response.status})`);
      const data = (await response.json()) as RunListItem[];
      setRuns(data);
      if (!selectedRunId && data.length) {
        setSelectedRunId(data[0].runId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [apiBase, selectedRunId, statusFilter, scopeFilter, triggerFilter]);

  const loadSelectedRun = useCallback(async () => {
    if (!selectedRunId) return;
    try {
      const [summaryResponse, logsResponse] = await Promise.all([
        fetch(`${apiBase}/api/runs/${selectedRunId}`, { cache: "no-store" }),
        fetch(`${apiBase}/api/runs/${selectedRunId}/logs?limit=200`, { cache: "no-store" })
      ]);
      if (!summaryResponse.ok) throw new Error(`Failed to load run detail (${summaryResponse.status})`);
      if (!logsResponse.ok) throw new Error(`Failed to load run logs (${logsResponse.status})`);
      setSelectedRun((await summaryResponse.json()) as RunSummary);
      setRunLogs((await logsResponse.json()) as RunLogEntry[]);
      const outcomesResponse = await fetch(`${apiBase}/api/runs/${selectedRunId}/outcomes`, { cache: "no-store" });
      if (outcomesResponse.ok) {
        setRunOutcomes((await outcomesResponse.json()) as RunOutcomeRow[]);
      } else {
        setRunOutcomes([]);
      }
      setInsightDismissed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [apiBase, selectedRunId]);

  const loadRunInsight = useCallback(async () => {
    if (!selectedRunId) return;
    try {
      const response = await fetch(`${apiBase}/api/runs/${selectedRunId}/ai/insight`, { method: "POST" });
      if (!response.ok) return;
      const data = (await response.json()) as RunInsightResponse;
      setRunInsight(data);
    } catch {
      setRunInsight(null);
    }
  }, [apiBase, selectedRunId]);

  useEffect(() => {
    if (apiBase) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadRuns();
    }
  }, [apiBase, loadRuns]);

  useEffect(() => {
    if (apiBase && selectedRunId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadSelectedRun();
      void loadRunInsight();
    }
  }, [apiBase, selectedRunId, loadSelectedRun, loadRunInsight]);

  async function runAllProgramsNow() {
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/runs/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "All Programs" })
      });
      if (!response.ok) throw new Error(`Manual run failed (${response.status})`);
      const data = (await response.json()) as ManualRunResponse;
      emitToast(`Run completed - ${data.activeMeasuresExecuted} measures generated`);
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
      const response = await fetch(`${apiBase}/api/runs/${selectedRunId}/rerun`, { method: "POST" });
      if (!response.ok) throw new Error(`Rerun failed (${response.status})`);
      const data = (await response.json()) as ManualRunResponse;
      emitToast("Rerun started");
      setSelectedRunId(data.runId);
      await loadRuns();
      await loadSelectedRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function downloadCsv(path: string, filename: string) {
    const response = await fetch(`${apiBase}${path}`);
    if (!response.ok) {
      throw new Error(`Export failed (${response.status})`);
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
          <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white" onClick={runAllProgramsNow}>
            Run Measures Now
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

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {selectedRun && !rerunSupported ? (
        <p className="text-xs text-amber-700">Rerun is available only for all-programs or measure-scoped runs.</p>
      ) : null}
      {loading ? <p className="text-sm text-slate-600">Loading runs...</p> : null}
      {!loading && runs.length === 0 ? <p className="text-sm text-slate-600">No runs yet. Click &apos;Run Measures Now&apos; to start.</p> : null}

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
