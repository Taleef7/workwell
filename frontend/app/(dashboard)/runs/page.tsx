"use client";

import { useMemo, useState } from "react";

type EvalResponse = {
  evaluationId: string;
  outcome: string;
  summary: string;
  expressionResults: Array<Record<string, unknown>>;
  evaluatedResource: Record<string, unknown>;
};

const samplePayload = {
  patientBundle: { id: "patient-001" },
  cqlLibrary: "library AnnualAudiogramCompleted version '1.0.0'"
};

export default function RunsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvalResponse | null>(null);

  const apiBase = useMemo(() => process.env.NEXT_PUBLIC_API_BASE_URL ?? "", []);

  async function runEvalProbe() {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch(`${apiBase}/api/eval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(samplePayload)
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      const data = (await response.json()) as EvalResponse;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold">S0 Eval Probe</h2>
      <p className="text-slate-600">
        Walking skeleton check: POST sample patient bundle + CQL to backend and render returned outcome.
      </p>
      <p className="text-sm text-slate-500">
        API base: <code>{apiBase || "(missing NEXT_PUBLIC_API_BASE_URL)"}</code>
      </p>

      <button
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
        onClick={runEvalProbe}
        disabled={loading || !apiBase}
      >
        {loading ? "Running..." : "Run Eval Probe"}
      </button>

      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}
      {result ? (
        <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-4 text-xs">
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}
