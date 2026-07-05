"use client";

import { useState, useEffect, useCallback } from "react";
import type { ApiClient } from "@/lib/api/client";

/**
 * E14 (#186) Standards Fidelity tab — a read-only view of WorkWell's authored eCQM measure vs the
 * official spec. Consumes GET /api/measures/:id/fidelity (structural COVERED/SIMPLIFIED/OMITTED diff)
 * and /fidelity/diff (criterion-impact outcome diff over the latest population run). Descriptive only
 * — never affects a compliance outcome (ADR-008). Surfaces the previously API-only E14 feature (F12).
 */

type Coverage = "COVERED" | "SIMPLIFIED" | "OMITTED";

interface CriterionFidelity {
  population: string;
  key: string;
  description: string;
  coverage: Coverage;
  note: string;
  valueSetOids: string[];
}
interface ValueSetFidelity {
  name: string;
  oid: string;
  concept: string;
  workwellRepresented: boolean;
  workwellValueSet?: string;
  note: string;
}
interface FidelityReport {
  available: true;
  measureId: string;
  ecqmId: string;
  title: string;
  version: string;
  steward: string;
  criteria: CriterionFidelity[];
  valueSets: ValueSetFidelity[];
  summary: {
    covered: number;
    simplified: number;
    omitted: number;
    officialValueSetCount: number;
    workwellValueSetCount: number;
    headline: string;
  };
  disclaimer: string;
}
interface CriterionImpact {
  key: string;
  population: string;
  coverage: Coverage;
  verifiable: boolean;
  subjectsAffected: number;
  reason?: string;
  note: string;
}
interface OutcomeDiffReport {
  measureId: string;
  ecqmId: string;
  runId: string | null;
  asOf: string | null;
  totalSubjectsEvaluated: number;
  totalDivergent: number;
  criterionImpacts: CriterionImpact[];
  headline: string;
  disclaimer: string;
}
interface ExecutionSubject {
  subjectId: string;
  workwellOutcome: string;
  officialOutcome: string;
  diverged: boolean;
  divergenceGate: string;
}
interface ExecutionDiffReport {
  mode: "execution";
  measureId: string;
  ecqmId: string;
  runId: string | null;
  asOf: string | null;
  totalSubjectsEvaluated: number;
  totalDivergent: number;
  byGate: Record<string, number>;
  subjects: ExecutionSubject[];
  headline: string;
  disclaimer: string;
}
type FidelityResponse = { available: false } | FidelityReport;
// Discriminated on `mode`: the PR-3 execution report carries mode:"execution"; the PR-2
// estimate (criterion-impact) report has no `mode` field.
type DiffResponse = { available: false } | OutcomeDiffReport | ExecutionDiffReport;

type Props = { measureId: string; api: ApiClient };

const coverageBadge: Record<Coverage, string> = {
  COVERED: "bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300",
  SIMPLIFIED: "bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-300",
  OMITTED: "bg-red-100 text-red-800 border border-red-300 dark:bg-red-950/40 dark:text-red-300",
};

export function StandardsTab({ measureId, api }: Props) {
  const [fidelity, setFidelity] = useState<FidelityResponse | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Parallel fetch; the diff is best-effort (needs a population run) so a diff failure
      // never blocks the structural fidelity report.
      const [f, d] = await Promise.all([
        api.get<FidelityResponse>(`/api/measures/${measureId}/fidelity`),
        api.get<DiffResponse>(`/api/measures/${measureId}/fidelity/diff`).catch(() => ({ available: false }) as DiffResponse),
      ]);
      setFidelity(f);
      setDiff(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load standards fidelity");
    } finally {
      setLoading(false);
    }
  }, [api, measureId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (loading) return <p className="text-sm text-neutral-600 dark:text-neutral-400">Loading standards fidelity…</p>;
  if (error) return <p className="text-sm text-red-700">Error: {error}</p>;
  if (!fidelity) return null;

  if (fidelity.available === false) {
    return (
      <p className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-6 text-sm text-neutral-600 dark:text-neutral-400">
        No official eCQM reference is registered for this measure. Standards fidelity is available for CMS
        eCQM measures with a vendored official specification (e.g. CMS122v14, CMS125v14).
      </p>
    );
  }

  const f = fidelity;
  const execution = diff && "mode" in diff && diff.mode === "execution" ? diff : null;
  const divergent = diff && "criterionImpacts" in diff ? diff : null;
  const impactByKey = new Map((divergent?.criterionImpacts ?? []).map((c) => [c.key, c]));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {f.title} <span className="ml-1 rounded bg-blue-100 px-1.5 py-0.5 font-mono text-[11px] text-blue-800 dark:bg-blue-950/50 dark:text-blue-300">{f.ecqmId}</span>
        </p>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          Steward: {f.steward} · Authored measure: {f.measureId} v{f.version}
        </p>
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">{f.summary.headline}</p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <span className={`rounded px-2 py-0.5 font-medium ${coverageBadge.COVERED}`}>{f.summary.covered} Covered</span>
          <span className={`rounded px-2 py-0.5 font-medium ${coverageBadge.SIMPLIFIED}`}>{f.summary.simplified} Simplified</span>
          <span className={`rounded px-2 py-0.5 font-medium ${coverageBadge.OMITTED}`}>{f.summary.omitted} Omitted</span>
          <span className="rounded border border-neutral-300 px-2 py-0.5 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
            Value sets: {f.summary.workwellValueSetCount} of {f.summary.officialValueSetCount} represented
          </span>
        </div>
      </div>

      {/* Criterion fidelity */}
      <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-neutral-50 dark:bg-neutral-800/50 text-neutral-500 dark:text-neutral-400">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Population</th>
              <th scope="col" className="px-3 py-2 font-medium">Official criterion</th>
              <th scope="col" className="px-3 py-2 font-medium">Coverage</th>
              <th scope="col" className="px-3 py-2 font-medium">Note</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Subjects affected</th>
            </tr>
          </thead>
          <tbody>
            {f.criteria.map((c) => {
              const impact = impactByKey.get(c.key);
              return (
                <tr key={c.key} className="border-t border-neutral-100 dark:border-neutral-800 align-top hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                  <td className="px-3 py-2 font-medium text-neutral-800 dark:text-neutral-200">{c.population}</td>
                  <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{c.description}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${coverageBadge[c.coverage]}`}>{c.coverage}</span>
                  </td>
                  <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">{c.note}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {impact == null ? (
                      <span className="text-neutral-600 dark:text-neutral-400">—</span>
                    ) : impact.verifiable ? (
                      <span className={impact.subjectsAffected > 0 ? "font-semibold text-red-700 dark:text-red-400" : "text-neutral-500 dark:text-neutral-400"}>
                        {impact.subjectsAffected}
                      </span>
                    ) : (
                      <span className="text-[10px] text-neutral-600 dark:text-neutral-400" title={impact.reason ?? "Not verifiable against synthetic data"}>not verifiable</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Outcome diff summary */}
      {divergent ? (
        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Criteria-impact outcome diff</p>
          <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">{divergent.headline}</p>
          {divergent.runId ? (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Based on the latest population run ({divergent.asOf}); {divergent.totalSubjectsEvaluated} subjects evaluated,
              <span className="font-semibold text-red-700 dark:text-red-400"> {divergent.totalDivergent}</span> would change if the official criteria were applied.
            </p>
          ) : (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">No population run yet — run this measure to populate the outcome diff.</p>
          )}
        </div>
      ) : null}

      {/* Per-subject execution divergence (PR-3, cms122 with imported VSAC value sets) */}
      {execution ? (
        <div className="space-y-3">
          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Official-CQL execution diff</p>
            <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">{execution.headline}</p>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {execution.asOf ? `Based on the latest population run (${execution.asOf}); ` : ""}
              <span className="font-semibold text-red-700 dark:text-red-400">{execution.totalDivergent} of {execution.totalSubjectsEvaluated}</span> subjects diverge from the official-subset CQL execution.
            </p>
            {Object.keys(execution.byGate).length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {Object.entries(execution.byGate).map(([gate, count]) => (
                  <span key={gate} className="rounded border border-neutral-300 px-2 py-0.5 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
                    <span className="font-mono text-[11px]">{gate}</span>: {count}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-neutral-50 dark:bg-neutral-800/50 text-neutral-500 dark:text-neutral-400">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Subject</th>
                  <th scope="col" className="px-3 py-2 font-medium">WorkWell outcome</th>
                  <th scope="col" className="px-3 py-2 font-medium">Official outcome</th>
                  <th scope="col" className="px-3 py-2 font-medium">Gate</th>
                </tr>
              </thead>
              <tbody>
                {execution.subjects.map((s) => (
                  <tr
                    key={s.subjectId}
                    className={`border-t border-neutral-100 dark:border-neutral-800 align-top hover:bg-neutral-50 dark:hover:bg-neutral-800/50 ${s.diverged ? "font-semibold text-red-700 dark:text-red-400" : ""}`}
                  >
                    <td className="px-3 py-2 font-mono">{s.subjectId}</td>
                    <td className="px-3 py-2">{s.workwellOutcome}</td>
                    <td className="px-3 py-2">{s.officialOutcome}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{s.divergenceGate || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] leading-5 text-neutral-600 dark:text-neutral-500">{execution.disclaimer}</p>
        </div>
      ) : null}

      {/* Value-set fidelity */}
      <details className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Value-set fidelity ({f.summary.workwellValueSetCount}/{f.summary.officialValueSetCount})
        </summary>
        <ul className="mt-2 space-y-1">
          {f.valueSets.map((vs) => (
            <li key={vs.oid} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${vs.workwellRepresented ? coverageBadge.COVERED : coverageBadge.OMITTED}`}>
                {vs.workwellRepresented ? "represented" : "missing"}
              </span>
              <span className="text-neutral-700 dark:text-neutral-300">
                {vs.name} <code className="text-[10px] text-neutral-600 dark:text-neutral-400">{vs.oid}</code>
                {vs.note ? <span className="ml-1 text-neutral-600 dark:text-neutral-400">— {vs.note}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </details>

      <p className="text-[11px] leading-5 text-neutral-600 dark:text-neutral-500">{f.disclaimer}</p>
    </div>
  );
}
