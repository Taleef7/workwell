"use client";

import { useState, useEffect, useCallback } from "react";
import type { ApiClient } from "@/lib/api/client";
import type { TraceabilityResponse, TraceabilityGap } from "../types";

type Props = {
  measureId: string;
  api: ApiClient;
};

function gapBadgeClass(severity: string) {
  if (severity === "ERROR") return "bg-red-100 text-red-800 border border-red-300";
  return "bg-amber-50 text-amber-800 border border-amber-300";
}

export function TraceabilityTab({ measureId, api }: Props) {
  const [data, setData] = useState<TraceabilityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<TraceabilityResponse>(`/api/measures/${measureId}/traceability`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load traceability data");
    } finally {
      setLoading(false);
    }
  }, [api, measureId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function exportJson() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `traceability-${data.measureName.replace(/\s+/g, "-")}-${data.version}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <p className="text-sm text-slate-600">Loading traceability data...</p>;
  if (error) return <p className="text-sm text-red-700">Error: {error}</p>;
  if (!data) return null;

  const errors = data.gaps.filter((g) => g.severity === "ERROR");
  const warnings = data.gaps.filter((g) => g.severity !== "ERROR");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-md border border-slate-200 bg-white p-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{data.measureName} — {data.version}</p>
          <p className="text-xs text-slate-500">{data.rows.length} traceability links · {data.gaps.length} gap{data.gaps.length !== 1 ? "s" : ""}</p>
        </div>
        <button
          className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          onClick={exportJson}
        >
          Export JSON
        </button>
      </div>

      {errors.length > 0 ? (
        <div className="rounded-md border border-red-300 bg-red-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-red-800">Errors — must fix before activation</p>
          <ul className="mt-2 space-y-1">
            {errors.map((gap, i) => <GapRow key={i} gap={gap} />)}
          </ul>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Warnings</p>
          <ul className="mt-2 space-y-1">
            {warnings.map((gap, i) => <GapRow key={i} gap={gap} />)}
          </ul>
        </div>
      ) : null}

      {data.gaps.length === 0 ? (
        <p className="text-sm text-emerald-700">No traceability gaps detected.</p>
      ) : null}

      {data.rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
          No traceability rows generated. Add a policy reference, spec fields, and CQL.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Policy Requirement</th>
                <th className="px-3 py-2 font-medium">Spec Field</th>
                <th className="px-3 py-2 font-medium">CQL Define</th>
                <th className="px-3 py-2 font-medium">Value Sets</th>
                <th className="px-3 py-2 font-medium">Required Data</th>
                <th className="px-3 py-2 font-medium">Test Fixtures</th>
                <th className="px-3 py-2 font-medium">Evidence Keys</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} className="border-t border-slate-100 align-top hover:bg-slate-50">
                  <td className="px-3 py-2">
                    {row.policyCitation ? <p className="text-[10px] text-slate-400">{row.policyCitation}</p> : null}
                    <p className="font-medium text-slate-800">{row.policyRequirement}</p>
                  </td>
                  <td className="px-3 py-2">
                    <code className="rounded bg-slate-100 px-1 text-[11px] text-slate-700">{row.specField}</code>
                    {row.specValue ? <p className="mt-0.5 text-[11px] text-slate-500 line-clamp-2">{row.specValue}</p> : null}
                  </td>
                  <td className="px-3 py-2">
                    {row.cqlDefine ? (
                      <>
                        <p className="font-mono text-[11px] text-slate-800">&quot;{row.cqlDefine}&quot;</p>
                        {row.cqlSnippet ? (
                          <pre className="mt-1 max-w-xs overflow-hidden text-ellipsis whitespace-pre-wrap text-[10px] text-slate-400 line-clamp-3">{row.cqlSnippet}</pre>
                        ) : null}
                      </>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {row.valueSets.length > 0 ? (
                      <ul className="space-y-0.5">
                        {row.valueSets.map((vs, j) => (
                          <li key={j} className="text-[11px] text-slate-700">{vs.name}</li>
                        ))}
                      </ul>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {row.requiredDataElements.length > 0 ? (
                      <ul className="space-y-0.5">
                        {row.requiredDataElements.map((el, j) => (
                          <li key={j}><code className="text-[10px] text-slate-600">{el}</code></li>
                        ))}
                      </ul>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {row.testFixtures.length > 0 ? (
                      <ul className="space-y-0.5">
                        {row.testFixtures.map((f, j) => (
                          <li key={j} className="text-[11px]">
                            <span className="text-slate-500">{f.fixtureName || "—"}</span>
                            {f.expectedOutcome ? <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-600">{f.expectedOutcome}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {row.runtimeEvidenceKeys.length > 0 ? (
                      <ul className="space-y-0.5">
                        {row.runtimeEvidenceKeys.map((key, j) => (
                          <li key={j}><code className="text-[10px] text-slate-600">{key}</code></li>
                        ))}
                      </ul>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GapRow({ gap }: { gap: TraceabilityGap }) {
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${gapBadgeClass(gap.severity)}`}>
        {gap.severity}
      </span>
      <span className="text-sm text-slate-700">{gap.message}</span>
    </li>
  );
}
