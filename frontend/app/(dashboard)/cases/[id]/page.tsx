"use client";

import Link from "next/link";
import { ReactNode, useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { emitToast } from "@/lib/toast";
import { caseStatusClass, outcomeStatusClass } from "@/lib/status";

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
  measureVersionId: string;
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
  closedReason: string | null;
  closedBy: string | null;
  exclusionReason: string | null;
  waiverExpiresAt: string | null;
  waiverExpired: boolean;
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

type ScheduledAppointment = {
  id: string;
  appointmentType: string;
  scheduledAt: string;
  location: string;
  status: string;
  notes: string | null;
  createdBy: string;
};

type EvidenceAttachment = {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  description: string | null;
  uploadedBy: string;
  uploadedAt: string;
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
  const [showRawEvidence, setShowRawEvidence] = useState(false);
  const [resolveNote, setResolveNote] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveModalOpen, setResolveModalOpen] = useState(false);
  const [appointments, setAppointments] = useState<ScheduledAppointment[]>([]);
  const [appointmentModalOpen, setAppointmentModalOpen] = useState(false);
  const [appointmentType, setAppointmentType] = useState("Audiogram");
  const [appointmentDateTime, setAppointmentDateTime] = useState("");
  const [appointmentLocation, setAppointmentLocation] = useState("");
  const [appointmentNotes, setAppointmentNotes] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceAttachment[]>([]);
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidenceDescription, setEvidenceDescription] = useState("");
  const [uploadingEvidence, setUploadingEvidence] = useState(false);

  const apiBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    return raw.trim().replace(/\/+$/, "");
  }, []);

  const loadCase = useCallback(async () => {
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
  }, [apiBase, caseId]);

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

  const loadAppointments = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/api/cases/${caseId}/appointments`, { cache: "no-store" });
      if (!response.ok) return;
      setAppointments((await response.json()) as ScheduledAppointment[]);
    } catch {
      setAppointments([]);
    }
  }, [apiBase, caseId]);

  const loadEvidence = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/api/cases/${caseId}/evidence`, { cache: "no-store" });
      if (!response.ok) return;
      setEvidence((await response.json()) as EvidenceAttachment[]);
    } catch {
      setEvidence([]);
    }
  }, [apiBase, caseId]);

  useEffect(() => {
    if (apiBase && caseId) {
      const timer = setTimeout(() => {
        void loadCase();
        void loadTemplates();
        void loadAppointments();
        void loadEvidence();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [apiBase, caseId, loadAppointments, loadEvidence, loadCase]);

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
        emitToast("Outreach sent");
      } else {
        emitToast("Case rerun verification completed");
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
      emitToast(`Case assigned to ${assigneeInput.trim() || "unassigned"}`);
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
      emitToast("Case escalated");
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
      emitToast(`Outreach delivery marked ${deliveryStatus}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActing(null);
    }
  }

  async function markResolved() {
    if (!apiBase || !caseId) return;
    if (!resolveNote.trim()) {
      setError("Closure note is required");
      return;
    }
    setResolving(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/cases/${caseId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "RESOLVE",
          note: resolveNote.trim(),
          resolvedAt: new Date().toISOString()
        })
      });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      const updated = (await response.json()) as CaseDetail;
      setCaseDetail(updated);
      setResolveModalOpen(false);
      setResolveNote("");
      emitToast("Case manually resolved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setResolving(false);
    }
  }

  async function scheduleAppointment() {
    if (!apiBase || !caseId) return;
    if (!appointmentDateTime || !appointmentLocation.trim()) {
      setError("Appointment date/time and location are required");
      return;
    }
    setScheduling(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/cases/${caseId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "SCHEDULE_APPOINTMENT",
          appointmentType,
          scheduledAt: new Date(appointmentDateTime).toISOString(),
          location: appointmentLocation.trim(),
          notes: appointmentNotes.trim()
        })
      });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      const updated = (await response.json()) as CaseDetail;
      setCaseDetail(updated);
      setAppointmentModalOpen(false);
      setAppointmentNotes("");
      setAppointmentLocation("");
      setAppointmentDateTime("");
      await loadAppointments();
      emitToast("Appointment scheduled");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setScheduling(false);
    }
  }

  async function uploadEvidence() {
    if (!apiBase || !caseId || !evidenceFile) {
      setError("Select a file to upload");
      return;
    }
    setUploadingEvidence(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", evidenceFile);
      formData.append("description", evidenceDescription);
      const response = await fetch(`${apiBase}/api/cases/${caseId}/evidence`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      setEvidenceFile(null);
      setEvidenceDescription("");
      await loadEvidence();
      await loadCase();
      emitToast("Evidence uploaded");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setUploadingEvidence(false);
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
          <p className="mt-2 text-slate-600">Structured Why Flagged evidence for the selected case and its waiver context.</p>
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
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${caseStatusClass(caseDetail.status)}`}>
                    {caseDetail.status}
                  </span>
                  <span className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700">
                    {caseDetail.priority}
                  </span>
                </div>
              </div>

              <dl className="mt-6 grid gap-4 sm:grid-cols-2">
                <Info
                  label="Outcome"
                  value={
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${outcomeStatusClass(caseDetail.currentOutcomeStatus)}`}>
                      {caseDetail.currentOutcomeStatus}
                    </span>
                  }
                />
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
                {caseDetail.status === "EXCLUDED" ? (
                  <div className={`mt-4 rounded-2xl border p-4 ${caseDetail.waiverExpired ? "border-rose-200 bg-rose-50" : "border-indigo-200 bg-indigo-50"}`}>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-700">Waiver status</p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">
                      {caseDetail.exclusionReason ?? "Excluded by documented waiver or exemption."}
                    </p>
                    <p className="mt-1 text-sm text-slate-700">
                      {caseDetail.waiverExpiresAt
                        ? `Expires ${new Date(caseDetail.waiverExpiresAt).toLocaleString()}`
                        : "No expiry on file."}
                    </p>
                    <p className={`mt-2 text-sm font-semibold ${caseDetail.waiverExpired ? "text-rose-700" : "text-indigo-800"}`}>
                      {caseDetail.waiverExpired ? "Waiver Expired — Rerun Recommended" : "Active waiver on file"}
                    </p>
                  </div>
                ) : null}
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
                    disabled={previewing || caseDetail.status === "EXCLUDED"}
                    className="rounded-xl border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-900 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {previewing ? "Previewing..." : "Preview outreach"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void runAction("outreach")}
                    disabled={acting !== null || caseDetail.status === "CLOSED" || caseDetail.status === "EXCLUDED" || outreachPreview === null}
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
                  <button
                    type="button"
                    onClick={() => setResolveModalOpen(true)}
                    disabled={caseDetail.status === "CLOSED" || caseDetail.status === "RESOLVED"}
                    className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-900 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Mark Resolved
                  </button>
                  <button
                    type="button"
                    onClick={() => setAppointmentModalOpen(true)}
                    className="rounded-xl border border-indigo-300 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-900 transition hover:bg-indigo-100"
                  >
                    Schedule Appointment
                  </button>
                </div>
                {appointmentModalOpen ? (
                  <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-3">
                    <label className="text-xs font-semibold uppercase tracking-[0.15em] text-indigo-800">Appointment type</label>
                    <select className="mt-2 w-full rounded border border-indigo-300 bg-white px-3 py-2 text-sm" value={appointmentType} onChange={(e) => setAppointmentType(e.target.value)}>
                      <option>Audiogram</option>
                      <option>TB Test</option>
                      <option>Annual Physical</option>
                      <option>Flu Vaccine</option>
                      <option>Other</option>
                    </select>
                    <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.15em] text-indigo-800">Date and time</label>
                    <input type="datetime-local" className="mt-2 w-full rounded border border-indigo-300 bg-white px-3 py-2 text-sm" value={appointmentDateTime} onChange={(e) => setAppointmentDateTime(e.target.value)} />
                    <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.15em] text-indigo-800">Location</label>
                    <input className="mt-2 w-full rounded border border-indigo-300 bg-white px-3 py-2 text-sm" value={appointmentLocation} onChange={(e) => setAppointmentLocation(e.target.value)} />
                    <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.15em] text-indigo-800">Notes</label>
                    <textarea className="mt-2 min-h-20 w-full rounded border border-indigo-300 bg-white px-3 py-2 text-sm" value={appointmentNotes} onChange={(e) => setAppointmentNotes(e.target.value)} />
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => void scheduleAppointment()} disabled={scheduling} className="rounded-lg bg-indigo-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60">
                        {scheduling ? "Scheduling..." : "Save Appointment"}
                      </button>
                      <button type="button" onClick={() => setAppointmentModalOpen(false)} className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                {resolveModalOpen ? (
                  <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                    <label className="text-xs font-semibold uppercase tracking-[0.15em] text-emerald-800">Closure note (required)</label>
                    <textarea
                      className="mt-2 min-h-24 w-full rounded border border-emerald-300 bg-white px-3 py-2 text-sm text-slate-900"
                      value={resolveNote}
                      onChange={(e) => setResolveNote(e.target.value)}
                      placeholder="Describe why this case was manually resolved."
                    />
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void markResolved()}
                        disabled={resolving || !resolveNote.trim()}
                        className="rounded-lg bg-emerald-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                      >
                        {resolving ? "Resolving..." : "Confirm Resolve"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setResolveModalOpen(false)}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
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
                    onClick={() => setShowRawEvidence((current) => !current)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-900"
                  >
                    {showRawEvidence ? "Hide Raw Evidence" : "View Raw Evidence"}
                  </button>
                </div>
                {showRawEvidence ? (
                  <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-xl border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-700">
                    {JSON.stringify(caseDetail.evidenceJson ?? {}, null, 2)}
                  </pre>
                ) : null}
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => void explainWhyFlagged()}
                    disabled={explaining}
                    className="rounded-xl bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {explaining ? "Explaining..." : "Explain Why Flagged"}
                  </button>
                  {explaining ? <div className="mt-3 h-16 animate-pulse rounded-xl border border-slate-200 bg-slate-100" /> : null}
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
                <Row label="Closed reason" value={caseDetail.closedReason ?? "-"} />
                <Row label="Closed by" value={caseDetail.closedBy ?? "-"} />
                <Row label="Assignee" value={caseDetail.assignee ?? "Unassigned"} />
                <Row label="Outcome evaluated" value={new Date(caseDetail.outcomeEvaluatedAt).toLocaleString()} />
              </dl>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Appointments</p>
              {appointments.length === 0 ? <p className="mt-2 text-sm text-slate-600">No appointments scheduled.</p> : null}
              <div className="mt-3 space-y-2">
                {appointments.map((appointment) => (
                  <div key={appointment.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                    <p className="font-semibold text-slate-900">{appointment.appointmentType}</p>
                    <p className="text-slate-700">{new Date(appointment.scheduledAt).toLocaleString()} • {appointment.location}</p>
                    <p className="text-xs text-slate-600">Status: {appointment.status} • Created by: {appointment.createdBy}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Evidence</p>
              <div className="mt-3 space-y-2">
                <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => setEvidenceFile(e.target.files?.[0] ?? null)} />
                <input
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  placeholder="Description"
                  value={evidenceDescription}
                  onChange={(e) => setEvidenceDescription(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => void uploadEvidence()}
                  disabled={uploadingEvidence || !evidenceFile}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-60"
                >
                  {uploadingEvidence ? "Uploading..." : "Upload Evidence"}
                </button>
              </div>
              <div className="mt-4 space-y-2">
                {evidence.length === 0 ? <p className="text-sm text-slate-600">No evidence uploaded.</p> : null}
                {evidence.map((entry) => (
                  <div key={entry.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                    <p className="font-semibold text-slate-900">📎 {entry.fileName}</p>
                    <p className="text-xs text-slate-600">{Math.round(entry.fileSizeBytes / 1024)} KB • {entry.mimeType}</p>
                    <p className="text-xs text-slate-600">Uploaded by {entry.uploadedBy} at {new Date(entry.uploadedAt).toLocaleString()}</p>
                    {entry.description ? <p className="text-xs text-slate-700">{entry.description}</p> : null}
                    <a className="mt-2 inline-block text-xs font-semibold text-blue-700 hover:underline" href={`${apiBase}/api/evidence/${entry.id}/download`} target="_blank" rel="noreferrer">
                      Download
                    </a>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Audit timeline</p>
              <div className="mt-4 space-y-3">
                {caseDetail.timeline.map((event, index) => (
                  (() => {
                    const notificationBadge = timelineNotificationBadge(event);
                    return (
                      <div
                        key={`${event.eventType}-${event.occurredAt}`}
                        className={`rounded-2xl border p-4 ${
                          index === 0 ? "border-blue-300 bg-blue-50/50" : "border-slate-200"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              <span className="mr-2" aria-hidden>{eventIcon(event.eventType)}</span>
                              {formatEventType(event.eventType)}
                            </p>
                            <p className="text-xs text-slate-500">{event.actor}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-slate-500">{new Date(event.occurredAt).toLocaleString()}</p>
                            <span className="mt-1 inline-block rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-700">
                              {timelineSource(event.eventType)}
                            </span>
                            {notificationBadge ? (
                              <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] ${notificationBadge.className}`}>
                                {notificationBadge.label}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-slate-700">
                          {JSON.stringify(event.payload, null, 2)}
                        </pre>
                      </div>
                    );
                  })()
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
  const compact = eventType
    .replace("CASE_ACTION_", "")
    .replace("CASE_", "")
    .replace("OUTCOME_", "")
    .replace("RUN_", "");
  return compact
    .toLowerCase()
    .split("_")
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function eventIcon(eventType: string) {
  const normalized = eventType.toUpperCase();
  if (normalized.includes("APPOINTMENT")) return "📅";
  if (normalized.includes("EVIDENCE")) return "📎";
  if (normalized.includes("OUTREACH")) return "✉";
  if (normalized.includes("RERUN") || normalized.includes("RUN")) return "↻";
  if (normalized.includes("CREATED")) return "+";
  if (normalized.includes("RESOLVED") || normalized.includes("CLOSED")) return "✓";
  if (normalized.includes("ESCALAT")) return "!";
  if (normalized.includes("ASSIGN")) return "@";
  return "•";
}

function timelineSource(eventType: string) {
  return eventType.toUpperCase().startsWith("CASE_ACTION_") ? "action" : "audit";
}

function timelineNotificationBadge(event: AuditEvent) {
  const payload = event.payload as Record<string, unknown>;
  const eventType = event.eventType.toUpperCase();
  const autoTriggered = payload.autoTriggered ?? payload.auto_triggered;
  const timelineSourceValue = payload.timelineSource;

  if (eventType === "NOTIFICATION_AUTO_QUEUED" || autoTriggered === true) {
    return {
      label: "Auto",
      className: "border-indigo-200 bg-indigo-50 text-indigo-800"
    };
  }

  if (eventType.includes("OUTREACH") && timelineSourceValue === "case_action") {
    return {
      label: "Manual",
      className: "border-slate-300 bg-slate-100 text-slate-700"
    };
  }

  return null;
}

function Info({ label, value }: { label: string; value: ReactNode }) {
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
