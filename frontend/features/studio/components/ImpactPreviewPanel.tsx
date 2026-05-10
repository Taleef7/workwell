"use client";

import { useState } from "react";
import type { ApiClient } from "@/lib/api/client";
import type { ImpactPreviewResponse } from "../types";

type Props = {
  measureId: string;
  api: ApiClient;
};

const OUTCOME_LABELS: Record<string, string> = {
  COMPLIANT: "Compliant",
  DUE_SOON: "Due Soon",
  OVERDUE: "Overdue",
  MISSING_DATA: "Missing Data",
  EXCLUDED: "Excluded",
};

const OUTCOME_CARD_CLASS: Record<string, string> = {
  COMPLIANT: "border-emerald-200 bg-emerald-50 text-emerald-800",
  DUE_SOON: "border-amber-200 bg-amber-50 text-amber-800",
  OVERDUE: "border-red-200 bg-red-50 text-red-800",
  MISSING_DATA: "border-slate-200 bg-slate-50 text-slate-700",
  EXCLUDED: "border-slate-200 bg-slate-50 text-slate-500",
};

export function ImpactPreviewPanel({ measureId, api }: Props) {
  const [data, setData] = useState<ImpactPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runPreview() {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const result = await api.post<undefined, ImpactPreviewResponse>(`/api/measures/${measureId}/impact-preview`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impact preview failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-900">Activation Impact Preview</p>
          <p className="text-xs text-slate-500">Dry run — no outcomes, cases, or runs will be written.</p>
        </div>
        <button
          className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-800 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={runPreview}
          disabled={loading}
        >
          {loading ? "Running…" : "Preview Activation Impact"}
        </button>
      </div>

      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
            {Object.entries(data.outcomeCounts).map(([status, count]) => (
              <div
                key={status}
                className={`rounded border px-3 py-2 text-center ${OUTCOME_CARD_CLASS[status] ?? "border-slate-200 bg-slate-50 text-slate-700"}`}
              >
                <p className="text-lg font-bold">{count}</p>
                <p className="text-[11px] font-medium">{OUTCOME_LABELS[status] ?? status}</p>
              </div>
            ))}
          </div>

          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
            <p className="mb-1.5 font-semibold text-slate-700">Estimated Case Impact</p>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
              <span className="text-slate-600">Would Create: <span className="font-semibold text-slate-900">{data.caseImpact.wouldCreate}</span></span>
              <span className="text-slate-600">Would Update: <span className="font-semibold text-slate-900">{data.caseImpact.wouldUpdate}</span></span>
              <span className="text-slate-600">Would Close: <span className="font-semibold text-slate-900">{data.caseImpact.wouldClose}</span></span>
              <span className="text-slate-600">Would Exclude: <span className="font-semibold text-slate-900">{data.caseImpact.wouldExclude}</span></span>
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Evaluated {data.populationEvaluated} employees as of {data.evaluationDate}.
          </p>

          {data.warnings.length > 0 ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="mb-1 text-xs font-semibold text-amber-800">Warnings</p>
              <ul className="space-y-0.5">
                {data.warnings.map((w, i) => (
                  <li key={i} className="text-xs text-amber-700">{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Preview only — no outcomes, cases, or runs were written to the database.
          </p>
        </>
      ) : null}
    </div>
  );
}
