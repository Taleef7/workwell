"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type CaseSummary = {
  caseId: string;
  employeeId: string;
  employeeName: string;
  measureName: string;
  measureVersion: string;
  evaluationPeriod: string;
  status: string;
  priority: string;
  currentOutcomeStatus: string;
  lastRunId: string;
  updatedAt: string;
};

export default function CasesPage() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    return raw.trim().replace(/\/+$/, "");
  }, []);

  useEffect(() => {
    async function loadCases() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${apiBase}/api/cases`);
        if (!response.ok) {
          throw new Error(`Request failed: ${response.status}`);
        }
        const data = (await response.json()) as CaseSummary[];
        setCases(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    if (apiBase) {
      void loadCases();
    }
  }, [apiBase]);

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 p-8 text-white shadow-lg">
        <p className="text-sm uppercase tracking-[0.3em] text-slate-300">Caseflow</p>
        <h2 className="mt-2 text-3xl font-semibold">Why Flagged cases</h2>
        <p className="mt-3 max-w-2xl text-slate-300">
          Open worklist cases now persist from the seeded Audiogram run. Each card below links to the structured evidence
          that explains why the case exists.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Open and recent cases</h3>
          <p className="text-sm text-slate-500">Loaded from the DB-backed case endpoints.</p>
        </div>
        <p className="text-sm text-slate-500">
          API base: <code>{apiBase || "(missing NEXT_PUBLIC_API_BASE_URL)"}</code>
        </p>
      </div>

      {loading ? <p className="text-sm text-slate-600">Loading cases...</p> : null}
      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}

      {!loading && !error && cases.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600">
          No cases yet. Run the Audiogram vertical first, then come back here to inspect the flagged outcomes.
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cases.map((item) => (
          <Link
            key={item.caseId}
            href={`/cases/${item.caseId}`}
            className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.measureName}</p>
                <h4 className="mt-1 text-lg font-semibold text-slate-900">{item.employeeName}</h4>
                <p className="mt-1 text-sm text-slate-500">{item.employeeId}</p>
              </div>
              <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white">{item.priority}</span>
            </div>

            <dl className="mt-4 space-y-2 text-sm text-slate-700">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">Status</dt>
                <dd className="font-medium">{item.status}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">Why flagged</dt>
                <dd className="font-medium">{item.currentOutcomeStatus}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">Period</dt>
                <dd className="font-medium">{item.evaluationPeriod}</dd>
              </div>
            </dl>

            <p className="mt-4 text-sm text-slate-600">
              Updated {new Date(item.updatedAt).toLocaleString()}.
            </p>
            <p className="mt-2 text-sm font-medium text-slate-900 transition group-hover:translate-x-0.5">
              View structured evidence →
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}
