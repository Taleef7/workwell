"use client";

import { useMemo, useState } from "react";

type EvalResponse = {
  evaluationId: string;
  outcome: string;
  summary: string;
  expressionResults: Array<Record<string, unknown>>;
  evaluatedResource: Record<string, unknown>;
};

type AudiogramRunResponse = {
  runId: string;
  measureName: string;
  measureVersion: string;
  evaluationDate: string;
  summary: {
    compliant: number;
    dueSoon: number;
    overdue: number;
    missingData: number;
    excluded: number;
  };
  outcomes: Array<{
    patientId: string;
    outcome: string;
    summary: string;
    evidenceJson: Record<string, unknown>;
  }>;
};

const samplePayload = {
  patientBundle: { id: "patient-001" },
  cqlLibrary: "library AnnualAudiogramCompleted version '1.0.0'"
};

export default function RunsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvalResponse | null>(null);
  const [audiogramRun, setAudiogramRun] = useState<AudiogramRunResponse | null>(null);
  const [savedRun, setSavedRun] = useState<AudiogramRunResponse | null>(null);

  const apiBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    return raw.trim().replace(/\/+$/, "");
  }, []);

  async function runEvalProbe() {
    setLoading(true);
    setError(null);
    setResult(null);
    setAudiogramRun(null);
    setSavedRun(null);

    try {
      const requestUrl = `${apiBase}/api/eval`;
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(samplePayload)
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status} (${requestUrl})`);
      }

      const data = (await response.json()) as EvalResponse;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function runAudiogramVertical() {
    setLoading(true);
    setError(null);
    setResult(null);
    setAudiogramRun(null);
    setSavedRun(null);

    try {
      const requestUrl = `${apiBase}/api/runs/audiogram`;
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status} (${requestUrl})`);
      }

      const data = (await response.json()) as AudiogramRunResponse;
      setAudiogramRun(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function loadLatestAudiogramRun() {
    setLoading(true);
    setError(null);

    try {
      const requestUrl = `${apiBase}/api/runs/audiogram/latest`;
      const response = await fetch(requestUrl);

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status} (${requestUrl})`);
      }

      const data = (await response.json()) as AudiogramRunResponse | null;
      setSavedRun(data);
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
      <button
        className="ml-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        onClick={runAudiogramVertical}
        disabled={loading || !apiBase}
      >
        {loading ? "Running..." : "Run S1a Audiogram Vertical"}
      </button>
      <button
        className="ml-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        onClick={loadLatestAudiogramRun}
        disabled={loading || !apiBase}
      >
        {loading ? "Loading..." : "Load Latest Saved Audiogram"}
      </button>

      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}
      {result ? (
        <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-4 text-xs">
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
      {audiogramRun ? (
        <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm">
          <p className="font-medium">
            {audiogramRun.measureName} v{audiogramRun.measureVersion} - run {audiogramRun.runId}
          </p>
          <p className="text-slate-600">Evaluation date: {audiogramRun.evaluationDate}</p>
          <p className="text-slate-700">
            Summary: compliant {audiogramRun.summary.compliant}, due soon {audiogramRun.summary.dueSoon},
            overdue {audiogramRun.summary.overdue}, missing data {audiogramRun.summary.missingData},
            excluded {audiogramRun.summary.excluded}
          </p>
          <pre className="overflow-x-auto rounded-md border border-slate-200 bg-white p-3 text-xs">
            {JSON.stringify(audiogramRun.outcomes, null, 2)}
          </pre>
        </div>
      ) : null}
      {savedRun ? (
        <div className="space-y-3 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm">
          <p className="font-medium">
            Saved copy: {savedRun.measureName} v{savedRun.measureVersion} - run {savedRun.runId}
          </p>
          <p className="text-emerald-800">
            Loaded from the database-backed latest run endpoint.
          </p>
          <pre className="overflow-x-auto rounded-md border border-emerald-200 bg-white p-3 text-xs">
            {JSON.stringify(savedRun.summary, null, 2)}
          </pre>
        </div>
      ) : null}
    </section>
  );
}
