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
    expressionResults?: Array<Record<string, unknown>>;
    evaluatedResource?: Record<string, unknown>;
    why_flagged?: {
      last_exam_date: string | null;
      compliance_window_days: number;
      days_overdue: number | null;
      role_eligible: boolean;
      site_eligible: boolean;
      waiver_status: string;
      outcome_status?: string;
    };
  };
  outcomeStatus: string;
  outcomeSummary: string;
  outcomeEvaluatedAt: string;
  latestOutreachDeliveryStatus: string | null;
  timeline: AuditEvent[];
};

type CaseExplanationResponse = {
  explanation: string;
  disclaimer: string;
};

type OutreachTemplate = {
  id: string;
  name: string;
  subject: string;
};

type OutreachPreview = {
  templateId: string | null;
  templateName: string;
  subject: string;
  bodyText: string;
  employeeName: string;
  measureName: string;
  dueDate: string;
};

export default function CaseDetailPage() {
  const params = useParams<{ id: string }>();
  const caseId = params.id;
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<"outreach" | "rerun" | "delivery" | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [escalating, setEscalating] = useState(false);
  const [assigneeInput, setAssigneeInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [aiExplanation, setAiExplanation] = useState<CaseExplanationResponse | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [outreachPreview, setOutreachPreview] = useState<OutreachPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

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
      setAssigneeInput(data.assignee ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  });

  const loadTemplates = useEffectEvent(async () => {
    try {
      const response = await fetch(`${apiBase}/api/admin/outreach-templates`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as OutreachTemplate[];
      setTemplates(data);
      if (!selectedTemplateId && data.length > 0) {
        setSelectedTemplateId(data[0].id);
      }
    } catch {
      setTemplates([]);
    }
  });

  useEffect(() => {
    if (apiBase && caseId) {
      const timer = setTimeout(() => {
        void loadCase();
        void loadTemplates();
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
    const templateQuery = action === "outreach" && selectedTemplateId ? `?templateId=${encodeURIComponent(selectedTemplateId)}` : "";

    try {
      const response = await fetch(`${apiBase}/api/cases/${caseId}/${endpoint}${templateQuery}`, {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      const updated = (await response.json()) as CaseDetail;
      setCaseDetail(updated);
      if (action === "outreach") {
        setOutreachPreview(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActing(null);
    }
  }

  async function previewOutreach() {
    if (!apiBase || !caseId) return;
    setPreviewing(true);
    setError(null);
    try {
      const templateQuery = selectedTemplateId ? `?templateId=${encodeURIComponent(selectedTemplateId)}` : "";
      const response = await fetch(`${apiBase}/api/cases/${caseId}/actions/outreach/preview${templateQuery}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      setOutreachPreview((await response.json()) as OutreachPreview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setPreviewing(false);
    }
  }

  async function assignCase() {
    if (!apiBase || !caseId) return;
    setAssigning(true);
    setError(null);
    try {
      const assigneeParam = assigneeInput.trim() ? `?assignee=${encodeURIComponent(assigneeInput.trim())}` : "";
      const response = await fetch(`${apiBase}/api/cases/${caseId}/assign${assigneeParam}`, { method: "POST" });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      const updated = (await response.json()) as CaseDetail;
      setCaseDetail(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setAssigning(false);
    }
  }

  async function escalateCase() {
    if (!apiBase || !caseId) return;
    setEscalating(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/cases/${caseId}/escalate`, { method: "POST" });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      const updated = (await response.json()) as CaseDetail;
      setCaseDetail(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setEscalating(false);
    }
  }

  async function explainWhyFlagged() {
    if (!apiBase || !caseId) return;
    setExplaining(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/cases/${caseId}/ai/explain`, { method: "POST" });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      setAiExplanation((await response.json()) as CaseExplanationResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setExplaining(false);
    }
  }

  async function updateDeliveryStatus(deliveryStatus: "QUEUED" | "SENT" | "FAILED") {
    if (!apiBase || !caseId) return;
    setActing("delivery");
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/cases/${caseId}/actions/outreach/delivery?deliveryStatus=${deliveryStatus}`, {
        method: "POST"
      });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      setCaseDetail((await response.json()) as CaseDetail);
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
                <div className="mt-2 flex items-center gap-2 text-xs text-amber-800">
                  <span>Outreach delivery:</span>
                  <span className={deliveryBadgeClass(caseDetail.latestOutreachDeliveryStatus)}>
                    {caseDetail.latestOutreachDeliveryStatus ?? "NOT_SENT"}
                  </span>
                </div>
                <div className="mt-4 grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.15em] text-amber-700">Outreach template</label>
                  <select
                    className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-900"
                    value={selectedTemplateId}
                    onChange={(e) => setSelectedTemplateId(e.target.value)}
                  >
                    {templates.length === 0 ? <option value="">Default template</option> : null}
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="mt-4 grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.15em] text-amber-700">Assignee</label>
                  <div className="flex gap-2">
                    <input
                      className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-900"
                      value={assigneeInput}
                      onChange={(e) => setAssigneeInput(e.target.value)}
                      placeholder="e.g. supervisor-a"
                    />
                    <button
                      type="button"
                      onClick={() => void assignCase()}
                      disabled={assigning}
                      className="rounded-xl border border-amber-400 bg-white px-4 py-2 text-sm font-semibold text-amber-900 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {assigning ? "Assigning..." : "Assign"}
                    </button>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => void previewOutreach()}
                    disabled={previewing}
                    className="rounded-xl border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-900 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {previewing ? "Previewing..." : "Preview outreach"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void runAction("outreach")}
                    disabled={acting !== null || caseDetail.status === "CLOSED" || outreachPreview === null}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {acting === "outreach" ? "Sending outreach..." : "Send outreach"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void escalateCase()}
                    disabled={escalating}
                    className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-900 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:bg-rose-100 disabled:text-rose-400"
                  >
                    {escalating ? "Escalating..." : "Escalate"}
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
                {outreachPreview ? (
                  <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
                    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-blue-700">Outreach preview</p>
                    <p className="mt-2"><span className="font-semibold">Template:</span> {outreachPreview.templateName}</p>
                    <p className="mt-1"><span className="font-semibold">Subject:</span> {outreachPreview.subject}</p>
                    <p className="mt-1"><span className="font-semibold">Due date:</span> {outreachPreview.dueDate}</p>
                    <p className="mt-2 whitespace-pre-wrap">{outreachPreview.bodyText}</p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-amber-800">Preview the outreach message before sending.</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void updateDeliveryStatus("QUEUED")}
                    disabled={acting !== null}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-60"
                  >
                    Mark queued
                  </button>
                  <button
                    type="button"
                    onClick={() => void updateDeliveryStatus("SENT")}
                    disabled={acting !== null}
                    className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 disabled:opacity-60"
                  >
                    Mark sent
                  </button>
                  <button
                    type="button"
                    onClick={() => void updateDeliveryStatus("FAILED")}
                    disabled={acting !== null}
                    className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-800 disabled:opacity-60"
                  >
                    Mark failed
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Why Flagged</p>
              <h4 className="mt-2 text-xl font-semibold">Structured evidence trail</h4>
              <div className="mt-4 space-y-3">
                {(caseDetail.evidenceJson.expressionResults ?? []).map((row, index) => (
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
                <p className="text-sm font-semibold text-slate-900">why_flagged</p>
                {caseDetail.evidenceJson.why_flagged ? (
                  <dl className="mt-3 grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
                    <Row label="Last exam date" value={caseDetail.evidenceJson.why_flagged.last_exam_date ?? "None"} />
                    <Row label="Window (days)" value={String(caseDetail.evidenceJson.why_flagged.compliance_window_days)} />
                    <Row label="Days overdue" value={String(caseDetail.evidenceJson.why_flagged.days_overdue ?? 0)} />
                    <Row label="Role eligible" value={caseDetail.evidenceJson.why_flagged.role_eligible ? "Yes" : "No"} />
                    <Row label="Site eligible" value={caseDetail.evidenceJson.why_flagged.site_eligible ? "Yes" : "No"} />
                    <Row label="Waiver status" value={caseDetail.evidenceJson.why_flagged.waiver_status} />
                  </dl>
                ) : null}
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-slate-700">
                  {JSON.stringify(caseDetail.evidenceJson.why_flagged ?? {}, null, 2)}
                </pre>
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => void explainWhyFlagged()}
                    disabled={explaining}
                    className="rounded-xl bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {explaining ? "Explaining..." : "Explain Why Flagged"}
                  </button>
                  {aiExplanation ? (
                    <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-blue-700">Plain-language explanation (AI-assisted)</p>
                      <p>{aiExplanation.explanation}</p>
                      <p className="mt-2 text-xs text-blue-700">{aiExplanation.disclaimer}</p>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-900">Evaluated resource</p>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-slate-700">
                  {JSON.stringify(caseDetail.evidenceJson.evaluatedResource ?? {}, null, 2)}
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
                        <p className="text-sm font-semibold text-slate-900">{formatEventType(event.eventType)}</p>
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

function formatEventType(eventType: string) {
  return eventType
    .toLowerCase()
    .split("_")
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
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

function deliveryBadgeClass(status: string | null) {
  if (status === "SENT") {
    return "rounded-full border border-emerald-300 bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-900";
  }
  if (status === "FAILED") {
    return "rounded-full border border-rose-300 bg-rose-100 px-2 py-0.5 font-semibold text-rose-900";
  }
  if (status === "QUEUED") {
    return "rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 font-semibold text-amber-900";
  }
  return "rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 font-semibold text-slate-700";
}
