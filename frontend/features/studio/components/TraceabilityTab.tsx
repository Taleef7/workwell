"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@mieweb/ui";
import { formatStatusLabel, normalizeEnumValue } from "@/lib/status";
import type { ApiClient } from "@/lib/api/client";
import type { TraceabilityResponse, TraceabilityGap } from "../types";

type Props = {
  measureId: string;
  api: ApiClient;
};

function gapBadgeClass(severity: string) {
  if (normalizeEnumValue(severity) === "ERROR") return "bg-red-100 text-red-800 border border-red-300";
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

  if (loading) return <p className="text-sm text-neutral-600 dark:text-neutral-400">Loading traceability data...</p>;
  if (error) return <p className="text-sm text-red-700">Error: {error}</p>;
  if (!data) return null;

  const errors = data.gaps.filter((g) => normalizeEnumValue(g.severity) === "ERROR");
  const warnings = data.gaps.filter((g) => normalizeEnumValue(g.severity) !== "ERROR");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
        <div>
          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{data.measureName} — {data.version}</p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{data.rows.length} traceability links · {data.gaps.length} gap{data.gaps.length !== 1 ? "s" : ""}</p>
        </div>
        <Button variant="outline" size="sm" onClick={exportJson}>
          Export JSON
        </Button>
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
        <p className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-6 text-sm text-neutral-600 dark:text-neutral-400">
          No traceability rows generated. Add a policy reference, spec fields, and CQL.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-neutral-50 dark:bg-neutral-800/50 text-neutral-500 dark:text-neutral-400">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Policy Requirement</th>
                <th scope="col" className="px-3 py-2 font-medium">Spec Field</th>
                <th scope="col" className="px-3 py-2 font-medium">CQL Define</th>
                <th scope="col" className="px-3 py-2 font-medium">Value Sets</th>
                <th scope="col" className="px-3 py-2 font-medium">Required Data</th>
                <th scope="col" className="px-3 py-2 font-medium">Test Fixtures</th>
                <th scope="col" className="px-3 py-2 font-medium">Evidence Keys</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} className="border-t border-neutral-100 dark:border-neutral-800 align-top hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                  <td className="px-3 py-2">
                    {row.policyCitation ? <p className="text-[10px] text-neutral-400">{row.policyCitation}</p> : null}
                    <p className="font-medium text-neutral-800 dark:text-neutral-200">{row.policyRequirement}</p>
                  </td>
                  <td className="px-3 py-2">
                    <code className="rounded bg-neutral-100 dark:bg-neutral-800 px-1 text-[11px] text-neutral-700 dark:text-neutral-300">{row.specField}</code>
                    {row.specValue ? <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400 line-clamp-2">{row.specValue}</p> : null}
                  </td>
                  <td className="px-3 py-2">
                    {row.cqlDefine ? (
                      <>
                        <p className="font-mono text-[11px] text-neutral-800 dark:text-neutral-200">&quot;{row.cqlDefine}&quot;</p>
                        {row.cqlSnippet ? (
                          <pre className="mt-1 max-w-xs overflow-hidden text-ellipsis whitespace-pre-wrap text-[10px] text-neutral-400 line-clamp-3">{row.cqlSnippet}</pre>
                        ) : null}
                      </>
                    ) : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {row.valueSets.length > 0 ? (
                      <ul className="space-y-0.5">
                        {row.valueSets.map((vs, j) => (
                          <li key={j} className="text-[11px] text-neutral-700 dark:text-neutral-300">{vs.name}</li>
                        ))}
                      </ul>
                    ) : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {row.requiredDataElements.length > 0 ? (
                      <ul className="space-y-0.5">
                        {row.requiredDataElements.map((el, j) => (
                          <li key={j}><code className="text-[10px] text-neutral-600 dark:text-neutral-400">{el}</code></li>
                        ))}
                      </ul>
                    ) : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {row.testFixtures.length > 0 ? (
                      <ul className="space-y-0.5">
                        {row.testFixtures.map((f, j) => (
                          <li key={j} className="text-[11px]">
                            <span className="text-neutral-500 dark:text-neutral-400">{f.fixtureName || "—"}</span>
                            {f.expectedOutcome ? <span className="ml-1 rounded bg-neutral-100 dark:bg-neutral-800 px-1 text-[10px] text-neutral-600 dark:text-neutral-400">{formatStatusLabel(f.expectedOutcome)}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {row.runtimeEvidenceKeys.length > 0 ? (
                      <ul className="space-y-0.5">
                        {row.runtimeEvidenceKeys.map((key, j) => (
                          <li key={j}><code className="text-[10px] text-neutral-600 dark:text-neutral-400">{key}</code></li>
                        ))}
                      </ul>
                    ) : <span className="text-neutral-400">—</span>}
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
        {formatStatusLabel(gap.severity)}
      </span>
      <span className="text-sm text-neutral-700 dark:text-neutral-300">{gap.message}</span>
    </li>
  );
}
