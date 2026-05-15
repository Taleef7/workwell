"use client";

import { useCallback, useEffect, useState } from "react";
import { formatStatusLabel, normalizeEnumValue } from "@/lib/status";
import type { ApiClient } from "@/lib/api/client";
import type { ResolveCheckResponse } from "../types";

type Props = {
  measureId: string;
  api: ApiClient;
};

function resolutionStatusClass(status: string) {
  const s = normalizeEnumValue(status ?? "");
  if (s === "RESOLVED") return "bg-emerald-100 text-emerald-800";
  if (s === "STALE") return "bg-amber-100 text-amber-800";
  if (s === "UNRESOLVED" || s === "EMPTY" || s === "ERROR") return "bg-red-100 text-red-800";
  return "bg-slate-100 text-slate-700";
}

export function ValueSetGovernancePanel({ measureId, api }: Props) {
  const [data, setData] = useState<ResolveCheckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCheck = useCallback(() => {
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await api.post<undefined, ResolveCheckResponse>(
          `/api/measures/${measureId}/value-sets/resolve-check`
        );
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Resolve check failed");
      } finally {
        setLoading(false);
      }
    })();
  }, [api, measureId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runCheck();
  }, [runCheck]);

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Value Set Governance</p>
        <button
          type="button"
          onClick={runCheck}
          disabled={loading}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {loading ? "Checking…" : "Re-check"}
        </button>
      </div>

      {error ? <p className="mt-2 text-xs text-red-700">{error}</p> : null}

      {data ? (
        <>
          <div className="mt-2 flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${data.allResolved ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>
              {data.allResolved ? "All Resolved" : "Blockers Found"}
            </span>
            <span className="text-xs text-slate-600">{data.valueSets.length} value set(s) checked</span>
          </div>

          {data.blockers.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {data.blockers.map((b, i) => (
                <li key={i} className="flex items-start gap-1 text-xs text-red-800">
                  <span>&#10060;</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {data.warnings.length > 0 ? (
            <ul className="mt-1 space-y-1">
              {data.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-1 text-xs text-amber-800">
                  <span>&#9888;&#65039;</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {data.valueSets.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-2 py-1">Name</th>
                    <th className="px-2 py-1">Version</th>
                    <th className="px-2 py-1">Resolution</th>
                    <th className="px-2 py-1">Codes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.valueSets.map((vs) => (
                    <tr key={vs.id} className="border-t border-slate-200">
                      <td className="px-2 py-1 font-medium text-slate-800">{vs.name}</td>
                      <td className="px-2 py-1 text-slate-600">{vs.version ?? "—"}</td>
                      <td className="px-2 py-1">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${resolutionStatusClass(vs.resolutionStatus)}`}>
                          {formatStatusLabel(vs.resolutionStatus)}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-slate-600">{vs.codeCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500">No value sets attached to this measure version.</p>
          )}
        </>
      ) : !loading ? (
        <p className="mt-2 text-xs text-slate-500">Run a check to see value set governance status.</p>
      ) : (
        <p className="mt-2 text-xs text-slate-500">Checking…</p>
      )}
    </div>
  );
}
