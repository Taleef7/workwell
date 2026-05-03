"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { useParams } from "next/navigation";

type AuditEvent = {
  eventType: string;
  actor: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

type CaseDetail = {
  caseId: string;
  employeeId: string;
  employeeName: string;
  measureName: string;
  measureVersion: string;
  evaluationPeriod: string;
  status: string;
  priority: string;
  assignee: string | null;
  nextAction: string;
  currentOutcomeStatus: string;
  lastRunId: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  evidenceJson: {
    expressionResults: Array<Record<string, unknown>>;
    evaluatedResource: Record<string, unknown>;
  };
  outcomeStatus: string;
  outcomeSummary: string;
  outcomeEvaluatedAt: string;
  timeline: AuditEvent[];
};

export default function CaseDetailPage() {
  const params = useParams<{ id: string }>();
  const caseId = params.id;
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<"outreach" | "rerun" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apiBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    return raw.trim().replace(/\/+$/, "");
  }, []);

  const loadCase = useEffectEvent(async () => {
    try {
      const response = await fetch(`${apiBase}/api/cases/${caseId}`);
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      const data = (await response.json()) as CaseDetail;
      setCaseDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  });

  useEffect(() => {
    if (apiBase && caseId) {
      const timer = setTimeout(() => {
        void loadCase();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [apiBase, caseId]);

  async function runAction(action: "outreach" | "rerun") {
    if (!apiBase || !caseId) {
      return;
    }

    setActing(action);
    setError(null);
    const endpoint = action === "outreach" ? "actions/outreach" : "rerun-to-verify";

    try {
      const response = await fetch(`${apiBase}/api/cases/${caseId}/${endpoint}`, {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      const updated = (await response.json()) as CaseDetail;
      setCaseDetail(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActing(null);
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link href="/cases" className="text-sm font-medium text-slate-500 hover:text-slate-900">
            ← Back to cases
          </Link>
          <h2 className="mt-2 text-3xl font-semibold">Case detail</h2>
          <p className="mt-2 text-slate-600">Structured Why Flagged evidence for the seeded Audiogram slice.</p>
        </div>
        <p className="text-sm text-slate-500">
          API base: <code>{apiBase || "(missing NEXT_PUBLIC_API_BASE_URL)"}</code>
        </p>
      </div>

      {loading ? <p className="text-sm text-slate-600">Loading case...</p> : null}
      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}

      {caseDetail ? (
        <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{caseDetail.measureName}</p>
                  <h3 className="mt-1 text-2xl font-semibold text-slate-900">{caseDetail.employeeName}</h3>
                  <p className="mt-1 text-sm text-slate-500">{caseDetail.employeeId}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white">
                    {caseDetail.status}
                  </span>
                  <span className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700">
                    {caseDetail.priority}
                  </span>
                </div>
              </div>

              <dl className="mt-6 grid gap-4 sm:grid-cols-2">
                <Info label="Outcome" value={caseDetail.currentOutcomeStatus} />
                <Info label="Evaluation period" value={caseDetail.evaluationPeriod} />
                <Info label="Outcome summary" value={caseDetail.outcomeSummary} />
                <Info label="Last run" value={caseDetail.lastRunId} />
              </dl>

              <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">Next action</p>
                <p className="mt-2 text-sm text-amber-950">{caseDetail.nextAction}</p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => void runAction("outreach")}
                    disabled={acting !== null || caseDetail.status === "CLOSED"}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {acting === "outreach" ? "Sending outreach..." : "Send outreach"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void runAction("rerun")}
                    disabled={acting !== null || caseDetail.status === "CLOSED"}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    {acting === "rerun" ? "Verifying..." : "Rerun to verify"}
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Why Flagged</p>
              <h4 className="mt-2 text-xl font-semibold">Structured evidence trail</h4>
              <div className="mt-4 space-y-3">
                {caseDetail.evidenceJson.expressionResults.map((row, index) => (
                  <div
                    key={`${String(row.define ?? index)}-${index}`}
                    className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-slate-900">{String(row.define ?? "define")}</p>
                      <p className="text-xs text-slate-500">Evidence item {index + 1}</p>
                    </div>
                    <p className="text-sm font-semibold text-slate-900">{String(row.result)}</p>
                  </div>
                ))}
              </div>

              <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-900">Evaluated resource</p>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-slate-700">
                  {JSON.stringify(caseDetail.evidenceJson.evaluatedResource, null, 2)}
                </pre>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Metadata</p>
              <dl className="mt-4 space-y-3 text-sm">
                <Row label="Created" value={new Date(caseDetail.createdAt).toLocaleString()} />
                <Row label="Updated" value={new Date(caseDetail.updatedAt).toLocaleString()} />
                <Row label="Closed" value={caseDetail.closedAt ? new Date(caseDetail.closedAt).toLocaleString() : "Open"} />
                <Row label="Assignee" value={caseDetail.assignee ?? "Unassigned"} />
                <Row label="Outcome evaluated" value={new Date(caseDetail.outcomeEvaluatedAt).toLocaleString()} />
              </dl>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Audit timeline</p>
              <div className="mt-4 space-y-3">
                {caseDetail.timeline.map((event) => (
                  <div key={`${event.eventType}-${event.occurredAt}`} className="rounded-2xl border border-slate-200 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{event.eventType}</p>
                        <p className="text-xs text-slate-500">{event.actor}</p>
                      </div>
                      <p className="text-xs text-slate-500">{new Date(event.occurredAt).toLocaleString()}</p>
                    </div>
                    <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-slate-700">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">{label}</dt>
      <dd className="mt-2 text-sm font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}
