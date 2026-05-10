"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import type { ApiClient } from "@/lib/api/client";
import type { DataReadinessResponse } from "../types";

type Props = {
  measureId: string;
  api: ApiClient;
};

function overallStatusClass(status: string) {
  if (status === "READY") return "bg-emerald-100 text-emerald-800 border border-emerald-300";
  if (status === "READY_WITH_WARNINGS") return "bg-amber-100 text-amber-800 border border-amber-300";
  return "bg-red-100 text-red-800 border border-red-300";
}

function mappingBadgeClass(status: string) {
  if (status === "MAPPED") return "bg-emerald-50 text-emerald-800";
  if (status === "STALE" || status === "PARTIAL") return "bg-amber-50 text-amber-800";
  if (status === "UNMAPPED" || status === "ERROR") return "bg-red-50 text-red-800";
  return "bg-slate-100 text-slate-600";
}

function freshnessBadgeClass(status: string) {
  if (status === "FRESH") return "text-emerald-700";
  if (status === "STALE") return "text-amber-700";
  if (status === "VERY_STALE") return "text-red-700";
  return "text-slate-500";
}

export function DataReadinessPanel({ measureId, api }: Props) {
  const [data, setData] = useState<DataReadinessResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<DataReadinessResponse>(`/api/measures/${measureId}/data-readiness`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data readiness");
    } finally {
      setLoading(false);
    }
  }, [api, measureId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="mt-4 space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-900">Data Readiness</p>
          <p className="text-xs text-slate-500">
            Source mapping, freshness, and missingness for required data elements.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data ? (
            <span className={`rounded px-2 py-1 text-[11px] font-semibold ${overallStatusClass(data.overallStatus)}`}>
              {data.overallStatus.replace(/_/g, " ")}
            </span>
          ) : null}
          <button
            className="rounded border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}

      {data ? (
        <>
          {data.blockers.length > 0 ? (
            <div className="rounded-md border border-red-300 bg-red-50 p-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-800">Blockers</p>
              <ul className="space-y-0.5">
                {data.blockers.map((b, i) => (
                  <li key={i} className="text-xs text-red-700">{b}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {data.warnings.length > 0 ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800">Warnings</p>
              <ul className="space-y-0.5">
                {data.warnings.map((w, i) => (
                  <li key={i} className="text-xs text-amber-700">{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {data.requiredElements.length > 0 ? (
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Required Element</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 font-medium">Mapping</th>
                    <th className="px-3 py-2 font-medium">Freshness</th>
                    <th className="px-3 py-2 font-medium">Missingness</th>
                  </tr>
                </thead>
                <tbody>
                  {data.requiredElements.map((el, i) => (
                    <tr key={i} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2">
                        <p className="font-medium text-slate-800">{el.label}</p>
                        <p className="text-[10px] text-slate-400">{el.canonicalElement}</p>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{el.sourceId ?? "—"}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${mappingBadgeClass(el.mappingStatus)}`}>
                          {el.mappingStatus}
                        </span>
                      </td>
                      <td className={`px-3 py-2 text-[11px] font-medium ${freshnessBadgeClass(el.freshnessStatus)}`}>
                        {el.freshnessStatus}
                      </td>
                      <td className="px-3 py-2">
                        {el.missingnessRate > 0 ? (
                          <span className="text-amber-700">{(el.missingnessRate * 100).toFixed(0)}%</span>
                        ) : (
                          <span className="text-slate-400">0%</span>
                        )}
                        {el.sampleMissingEmployees.length > 0 ? (
                          <p className="mt-0.5 text-[10px] text-slate-400">
                            e.g. {el.sampleMissingEmployees.join(", ")}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-slate-500">No required elements defined in spec.</p>
          )}

          <p className="text-xs text-slate-500">
            Manage source mappings in{" "}
            <Link href="/admin" className="text-blue-700 underline hover:text-blue-900">
              Admin → Data Mappings
            </Link>
            .
          </p>
        </>
      ) : null}
    </div>
  );
}
