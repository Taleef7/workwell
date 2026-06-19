"use client";

import Link from "next/link";
import { ReactNode, useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Button, Input, Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle, Select, Textarea } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import { CASE_STATUS_LABELS, OUTCOME_LABELS, PRIORITY_LABELS, caseStatusClass, formatStatusLabel, labelFor, normalizeEnumValue, outcomeStatusClass } from "@/lib/status";
import { useApi } from "@/lib/api/hooks";
import { AuditPacketExportButton } from "@/components/audit-packet-export-button";
import { ConfirmDialog } from "@/components/confirm-dialog";

// CQL/FHIR measure-scaffolding defines that carry no domain meaning for the
// Why-Flagged narrative (the custom WorkWell defines + "Outcome Status" tell the
// story). Suppressed from the human-readable evidence list; the raw JSON view
// below still contains them, so traceability is preserved.
const INTERNAL_DEFINES = new Set([
  "Patient",
  "Initial Population",
  "Numerator",
  "Numerator Exclusion",
  "Denominator",
  "Denominator Exclusion",
  "Denominator Exception",
]);

function isInternalDefine(define: string): boolean {
  return INTERNAL_DEFINES.has(define.trim());
}

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

type LinkedValueSet = {
  id: string;
  oid: string;
  name: string;
  version: string | null;
  resolvabilityStatus: string;
  resolvabilityLabel: string;
  codeCount: number;
};

export default function CaseDetailPage() {
  const params = useParams<{ id: string }>();
  const caseId = params.id;
  const api = useApi();
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
  // Outreach channel: EMAIL is the default so existing behavior is unchanged (#75 E5).
  const [outreachChannel, setOutreachChannel] = useState<string>("EMAIL");
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
  const [linkedValueSets, setLinkedValueSets] = useState<LinkedValueSet[]>([]);
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidenceDescription, setEvidenceDescription] = useState("");
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [escalationConfirmOpen, setEscalationConfirmOpen] = useState(false);
  const caseStatus = caseDetail ? normalizeEnumValue(caseDetail.status) : "";

  // Option lists for @mieweb/ui Select controls.
  // The empty-value option is the default: no templateId is sent, so the backend picks the
  // outcome-aware template (#150 M1). An operator can still override by choosing a specific one.
  const templateOptions = useMemo(
    () => [
      { value: "", label: "Auto (by outcome)" },
      ...templates.map((template) => ({ value: template.id, label: template.name })),
    ],
    [templates],
  );
  const channelOptions = useMemo(
    () => [
      { value: "EMAIL", label: "Email" },
      { value: "SMS", label: "SMS" },
      { value: "PHONE", label: "Phone" },
    ],
    [],
  );
  const appointmentTypeOptions = useMemo(
    () =>
      ["Audiogram", "TB Test", "Annual Physical", "Flu Vaccine", "Other"].map((t) => ({
        value: t,
        label: t,
      })),
    [],
  );

  const loadCase = useCallback(async () => {
    try {
      const data = await api.get<CaseDetail>(`/api/cases/${caseId}`);
      setCaseDetail(data);
      setAssigneeInput(data.assignee ?? "");
      try {
        const vsets = await api.get<LinkedValueSet[]>(`/api/measures/versions/${data.measureVersionId}/value-sets`);
        setLinkedValueSets(vsets);
      } catch {
        setLinkedValueSets([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [api, caseId]);

  const loadTemplates = useEffectEvent(async () => {
    try {
      const data = await api.get<OutreachTemplate[]>("/api/admin/outreach-templates");
      setTemplates(data);
      // Do NOT pre-select a template: leaving selectedTemplateId empty makes the manual workflow
      // send no templateId, so the backend applies the outcome-aware default (#150 M1).
    } catch {
      setTemplates([]);
    }
  });

  const loadAppointments = useCallback(async () => {
    try {
      const data = await api.get<ScheduledAppointment[]>(`/api/cases/${caseId}/appointments`);
      setAppointments(data);
    } catch {
      setAppointments([]);
    }
  }, [api, caseId]);

  const loadEvidence = useCallback(async () => {
    try {
      const data = await api.get<EvidenceAttachment[]>(`/api/cases/${caseId}/evidence`);
      setEvidence(data);
    } catch {
      setEvidence([]);
    }
  }, [api, caseId]);

  useEffect(() => {
    if (caseId) {
      const timer = setTimeout(() => {
        void loadCase();
        void loadTemplates();
        void loadAppointments();
        void loadEvidence();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [caseId, loadAppointments, loadEvidence, loadCase]);

  async function runAction(action: "outreach" | "rerun") {
    if (!caseId) return;
    setActing(action);
    setError(null);
    const endpoint = action === "outreach" ? "actions/outreach" : "rerun-to-verify";
    let templateQuery = "";
    if (action === "outreach") {
      const params = new URLSearchParams();
      if (selectedTemplateId) params.set("templateId", selectedTemplateId);
      // EMAIL is the default; forward channel so SMS/PHONE selections reach the backend (#75 E5).
      params.set("channel", outreachChannel);
      const qs = params.toString();
      templateQuery = qs ? `?${qs}` : "";
    }
    try {
      const updated = await api.post<undefined, CaseDetail>(`/api/cases/${caseId}/${endpoint}${templateQuery}`);
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
    if (!caseId) return;
    setPreviewing(true);
    setError(null);
    try {
      const templateQuery = selectedTemplateId ? `?templateId=${encodeURIComponent(selectedTemplateId)}` : "";
      const data = await api.get<OutreachPreview>(`/api/cases/${caseId}/actions/outreach/preview${templateQuery}`);
      setOutreachPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setPreviewing(false);
    }
  }

  async function assignCase() {
    if (!caseId) return;
    setAssigning(true);
    setError(null);
    try {
      const assigneeParam = assigneeInput.trim() ? `?assignee=${encodeURIComponent(assigneeInput.trim())}` : "";
      const updated = await api.post<undefined, CaseDetail>(`/api/cases/${caseId}/assign${assigneeParam}`);
      setCaseDetail(updated);
      emitToast(`Case assigned to ${assigneeInput.trim() || "unassigned"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setAssigning(false);
    }
  }

  async function escalateCase() {
    if (!caseId) return;
    setEscalating(true);
    setError(null);
    try {
      const updated = await api.post<undefined, CaseDetail>(`/api/cases/${caseId}/escalate`);
      setCaseDetail(updated);
      emitToast("Case escalated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setEscalating(false);
    }
  }

  async function explainWhyFlagged() {
    if (!caseId) return;
    setExplaining(true);
    setError(null);
    try {
      const data = await api.post<undefined, CaseExplanationResponse>(`/api/cases/${caseId}/ai/explain`);
      setAiExplanation(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setExplaining(false);
    }
  }

  async function updateDeliveryStatus(deliveryStatus: "QUEUED" | "SENT" | "FAILED") {
    if (!caseId) return;
    setActing("delivery");
    setError(null);
    try {
      const updated = await api.post<undefined, CaseDetail>(`/api/cases/${caseId}/actions/outreach/delivery?deliveryStatus=${deliveryStatus}`);
      setCaseDetail(updated);
      emitToast(`Outreach delivery marked ${deliveryStatus}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActing(null);
    }
  }

  async function markResolved() {
    if (!caseId) return;
    if (!resolveNote.trim()) {
      setError("Closure note is required");
      return;
    }
    setResolving(true);
    setError(null);
    try {
      const updated = await api.post<object, CaseDetail>(`/api/cases/${caseId}/actions`, {
        type: "RESOLVE",
        note: resolveNote.trim(),
        resolvedAt: new Date().toISOString()
      });
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
    if (!caseId) return;
    if (!appointmentDateTime || !appointmentLocation.trim()) {
      setError("Appointment date/time and location are required");
      return;
    }
    setScheduling(true);
    setError(null);
    try {
      const updated = await api.post<object, CaseDetail>(`/api/cases/${caseId}/actions`, {
        type: "SCHEDULE_APPOINTMENT",
        appointmentType,
        scheduledAt: new Date(appointmentDateTime).toISOString(),
        location: appointmentLocation.trim(),
        notes: appointmentNotes.trim()
      });
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
    if (!caseId || !evidenceFile) {
      setError("Select a file to upload");
      return;
    }
    setUploadingEvidence(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", evidenceFile);
      formData.append("description", evidenceDescription);
      await api.postForm(`/api/cases/${caseId}/evidence`, formData);
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
      <ConfirmDialog
        open={escalationConfirmOpen}
        title="Escalate this case?"
        description="This will raise the case priority, update the next action, and write an escalation entry to the audit timeline."
        confirmLabel={escalating ? "Escalating..." : "Confirm escalation"}
        cancelLabel="Cancel"
        onConfirm={() => {
          setEscalationConfirmOpen(false);
          void escalateCase();
        }}
        onCancel={() => setEscalationConfirmOpen(false)}
      />
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link href="/cases" className="text-sm font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100">
            ← Back to cases
          </Link>
          <h2 className="mt-2 text-3xl font-semibold">Case detail</h2>
          <p className="mt-2 text-neutral-600 dark:text-neutral-400">Structured Why Flagged evidence for the selected case and its waiver context.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Case: <code>{caseId}</code>
          </p>
          <AuditPacketExportButton
            api={api}
            path={`/api/auditor/cases/${caseId}/packet`}
            filenamePrefix={`workwell-case-packet-${caseId}`}
            label="Export Case Audit Packet"
            onError={(message) => setError(message || null)}
          />
        </div>
      </div>

      {loading ? <p className="text-sm text-neutral-600 dark:text-neutral-400">Loading case...</p> : null}
      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}

      {caseDetail ? (
        <>
        <div className="space-y-3 md:hidden">
          <details open className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-neutral-900 dark:text-neutral-100">Case Summary</summary>
            <div className="mt-3 space-y-2 text-sm">
              <p className="font-semibold text-neutral-900 dark:text-neutral-100">{caseDetail.employeeName}</p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{caseDetail.employeeId}</p>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">{caseDetail.measureName}</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${caseStatusClass(caseDetail.status)}`}>
                  {labelFor(CASE_STATUS_LABELS, caseDetail.status)}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${outcomeStatusClass(caseDetail.currentOutcomeStatus)}`}>
                  {labelFor(OUTCOME_LABELS, caseDetail.currentOutcomeStatus)}
                </span>
              </div>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">Period: {caseDetail.evaluationPeriod}</p>
              <p className="text-xs text-neutral-700 dark:text-neutral-300">{caseDetail.nextAction}</p>
              <Link href={`/employees/${caseDetail.employeeId}`} className="text-xs font-semibold text-primary-700 dark:text-primary-400 hover:underline">
                Open Employee Profile
              </Link>
            </div>
          </details>

          <details className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-neutral-900 dark:text-neutral-100">Actions</summary>
            <div className="mt-3 space-y-3">
              <Select
                label="Outreach Template"
                value={selectedTemplateId}
                onValueChange={setSelectedTemplateId}
                options={templateOptions}
              />
              <Select
                label="Channel"
                value={outreachChannel}
                onValueChange={setOutreachChannel}
                options={channelOptions}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void previewOutreach()}
                  disabled={previewing || caseStatus === "EXCLUDED"}
                  isLoading={previewing}
                  loadingText="Previewing..."
                >
                  Preview
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => void runAction("outreach")}
                  disabled={acting !== null || caseStatus === "EXCLUDED"}
                  isLoading={acting === "outreach"}
                  loadingText="Sending..."
                >
                  Send Outreach
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => void runAction("rerun")}
                  disabled={acting !== null}
                  isLoading={acting === "rerun"}
                  loadingText="Verifying..."
                >
                  Rerun to Verify
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => setEscalationConfirmOpen(true)}
                  disabled={escalating}
                  isLoading={escalating}
                  loadingText="Escalating..."
                >
                  Escalate
                </Button>
              </div>
              <div className="grid gap-2">
                <Input
                  label="Assignee"
                  hideLabel
                  value={assigneeInput}
                  onChange={(e) => setAssigneeInput(e.target.value)}
                  placeholder="Assignee email or handle"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void assignCase()}
                  disabled={assigning}
                  isLoading={assigning}
                  loadingText="Assigning..."
                >
                  Assign
                </Button>
              </div>
            </div>
          </details>

          <details className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-neutral-900 dark:text-neutral-100">Why Flagged Evidence</summary>
            <div className="mt-3 space-y-2">
              {(caseDetail.evidenceJson.expressionResults ?? [])
                .filter((row) => !isInternalDefine(String(row.define ?? "")))
                .map((row, index) => (
                <div key={`${String(row.define ?? index)}-${index}`} className="rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-2">
                  <p className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">{String(row.define ?? "define")}</p>
                  <p className="text-xs text-neutral-700 dark:text-neutral-300">{String(row.result)}</p>
                </div>
              ))}
            </div>
          </details>

          <details className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-neutral-900 dark:text-neutral-100">Timeline</summary>
            <div className="mt-3 space-y-2">
              {caseDetail.timeline.map((event) => (
                <div key={`${event.eventType}-${event.occurredAt}`} className="rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-2">
                  <p className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">{formatEventType(event.eventType)}</p>
                  <p className="text-[11px] text-neutral-600 dark:text-neutral-400">{new Date(event.occurredAt).toLocaleString()} • {event.actor}</p>
                </div>
              ))}
            </div>
          </details>
        </div>

        <div className="hidden gap-6 md:grid xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-6">
            <div className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">{caseDetail.measureName}</p>
                  <h3 className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
                    <Link href={`/employees/${caseDetail.employeeId}`} className="hover:underline hover:text-primary-700 dark:text-primary-400">
                      {caseDetail.employeeName}
                    </Link>
                  </h3>
                  <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{caseDetail.employeeId}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${caseStatusClass(caseDetail.status)}`}>
                    {labelFor(CASE_STATUS_LABELS, caseDetail.status)}
                  </span>
                  <span className="rounded-full border border-neutral-300 dark:border-neutral-700 px-3 py-1 text-xs font-semibold text-neutral-700 dark:text-neutral-300">
                    {labelFor(PRIORITY_LABELS, caseDetail.priority)}
                  </span>
                </div>
              </div>

              <dl className="mt-6 grid gap-4 sm:grid-cols-2">
                <Info
                  label="Outcome"
                  value={
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${outcomeStatusClass(caseDetail.currentOutcomeStatus)}`}>
                      {labelFor(OUTCOME_LABELS, caseDetail.currentOutcomeStatus)}
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
                    {formatStatusLabel(caseDetail.latestOutreachDeliveryStatus ?? "NOT_SENT")}
                  </span>
                </div>
                {caseStatus === "EXCLUDED" ? (
                  <div className={`mt-4 rounded-2xl border p-4 ${caseDetail.waiverExpired ? "border-rose-200 bg-rose-50" : "border-indigo-200 bg-indigo-50"}`}>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-700">Waiver status</p>
                    <p className="mt-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                      {caseDetail.exclusionReason ?? "Excluded by documented waiver or exemption."}
                    </p>
                    <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
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
                  <Select
                    label="Outreach template"
                    value={selectedTemplateId}
                    onValueChange={setSelectedTemplateId}
                    options={templateOptions}
                  />
                  <Select
                    label="Channel"
                    value={outreachChannel}
                    onValueChange={setOutreachChannel}
                    options={channelOptions}
                  />
                </div>
                <div className="mt-4 grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.15em] text-amber-700">Assignee</label>
                  <div className="flex items-end gap-2">
                    <Input
                      label="Assignee"
                      hideLabel
                      className="w-full"
                      value={assigneeInput}
                      onChange={(e) => setAssigneeInput(e.target.value)}
                      placeholder="e.g. supervisor-a"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void assignCase()}
                      disabled={assigning}
                      isLoading={assigning}
                      loadingText="Assigning..."
                    >
                      Assign
                    </Button>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void previewOutreach()}
                    disabled={previewing || caseStatus === "EXCLUDED"}
                    isLoading={previewing}
                    loadingText="Previewing..."
                  >
                    Preview outreach
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => void runAction("outreach")}
                    disabled={acting !== null || caseStatus === "CLOSED" || caseStatus === "EXCLUDED" || outreachPreview === null}
                    title={outreachPreview === null ? "Preview the message before sending" : undefined}
                    isLoading={acting === "outreach"}
                    loadingText="Sending outreach..."
                  >
                    Send outreach
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => setEscalationConfirmOpen(true)}
                    disabled={escalating}
                    isLoading={escalating}
                    loadingText="Escalating..."
                  >
                    Escalate
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void runAction("rerun")}
                    disabled={acting !== null || caseStatus === "CLOSED"}
                    isLoading={acting === "rerun"}
                    loadingText="Verifying..."
                  >
                    Rerun to verify
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setResolveModalOpen(true)}
                    disabled={caseStatus === "CLOSED" || caseStatus === "RESOLVED"}
                  >
                    Mark Resolved
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setAppointmentModalOpen(true)}
                  >
                    Schedule Appointment
                  </Button>
                </div>
                <Modal open={appointmentModalOpen} onOpenChange={(open) => { if (!open) setAppointmentModalOpen(false); }} size="md">
                  <ModalHeader>
                    <ModalTitle>Schedule Appointment</ModalTitle>
                  </ModalHeader>
                  <ModalBody>
                    <div className="space-y-3">
                      <Select
                        label="Appointment type"
                        value={appointmentType}
                        onValueChange={setAppointmentType}
                        options={appointmentTypeOptions}
                      />
                      <Input
                        type="datetime-local"
                        label="Date and time"
                        value={appointmentDateTime}
                        onChange={(e) => setAppointmentDateTime(e.target.value)}
                      />
                      <Input
                        label="Location"
                        value={appointmentLocation}
                        onChange={(e) => setAppointmentLocation(e.target.value)}
                      />
                      <Textarea
                        label="Notes"
                        className="min-h-20"
                        value={appointmentNotes}
                        onChange={(e) => setAppointmentNotes(e.target.value)}
                      />
                    </div>
                  </ModalBody>
                  <ModalFooter>
                    <Button type="button" variant="secondary" size="sm" onClick={() => setAppointmentModalOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => void scheduleAppointment()}
                      disabled={scheduling}
                      isLoading={scheduling}
                      loadingText="Scheduling..."
                    >
                      Save Appointment
                    </Button>
                  </ModalFooter>
                </Modal>
                {resolveModalOpen ? (
                  <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                    <Textarea
                      label="Closure note (required)"
                      className="min-h-24"
                      value={resolveNote}
                      onChange={(e) => setResolveNote(e.target.value)}
                      placeholder="Describe why this case was manually resolved."
                    />
                    <div className="mt-3 flex gap-2">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={() => void markResolved()}
                        disabled={resolving || !resolveNote.trim()}
                        isLoading={resolving}
                        loadingText="Resolving..."
                      >
                        Confirm Resolve
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setResolveModalOpen(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
                {outreachPreview ? (
                  <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
                    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-primary-700 dark:text-primary-400">Outreach preview</p>
                    <p className="mt-2"><span className="font-semibold">Template:</span> {outreachPreview.templateName}</p>
                    <p className="mt-1"><span className="font-semibold">Subject:</span> {outreachPreview.subject}</p>
                    <p className="mt-1"><span className="font-semibold">Due date:</span> {outreachPreview.dueDate}</p>
                    <p className="mt-2 whitespace-pre-wrap">{outreachPreview.bodyText}</p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-amber-800">Preview the outreach message before sending.</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void updateDeliveryStatus("QUEUED")} disabled={acting !== null}>
                    Mark queued
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void updateDeliveryStatus("SENT")} disabled={acting !== null}>
                    Mark sent
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void updateDeliveryStatus("FAILED")} disabled={acting !== null}>
                    Mark failed
                  </Button>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">Why Flagged</p>
              <h4 className="mt-2 text-xl font-semibold">Code evidence explorer</h4>
              <div className="mt-4 space-y-2">
                {(caseDetail.evidenceJson.expressionResults ?? [])
                  .filter((row) => !isInternalDefine(String(row.define ?? "")))
                  .map((row, index) => {
                  const defineStr = String(row.define ?? "define");
                  const resultStr = String(row.result ?? "");
                  const isOutcomeStatus = defineStr === "Outcome Status";
                  const isTrue = resultStr.toLowerCase() === "true";
                  const isFalse = resultStr.toLowerCase() === "false";
                  const isNull = resultStr === "null" || resultStr === "";
                  const isDate = /^\d{4}-\d{2}-\d{2}/.test(resultStr);
                  const isNumber = !isNaN(Number(resultStr)) && resultStr !== "" && !isDate;
                  let chipClass = "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300";
                  let chipLabel = resultStr || "—";
                  if (isOutcomeStatus) {
                    chipClass = "bg-amber-100 text-amber-900 font-semibold";
                  } else if (isTrue) {
                    chipClass = "bg-emerald-100 text-emerald-800";
                    chipLabel = "✓ true";
                  } else if (isFalse) {
                    chipClass = "bg-red-100 text-red-800";
                    chipLabel = "✗ false";
                  } else if (isNull) {
                    chipClass = "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 italic";
                    chipLabel = "not found";
                  } else if (isDate) {
                    chipClass = "bg-blue-100 text-blue-800";
                    chipLabel = `📅 ${resultStr.slice(0, 10)}`;
                  } else if (isNumber) {
                    const n = Number(resultStr);
                    chipClass = n > 0 ? "bg-orange-100 text-orange-800" : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300";
                  }
                  return (
                    <div
                      key={`${defineStr}-${index}`}
                      className="flex items-center justify-between gap-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-4 py-3"
                    >
                      <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{defineStr}</p>
                      <span className={`rounded-full px-3 py-1 text-xs ${chipClass}`}>{chipLabel}</span>
                    </div>
                  );
                })}
              </div>

              {linkedValueSets.length > 0 ? (
                <div className="mt-6 rounded-2xl border border-indigo-100 bg-indigo-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-700">Declared value sets</p>
                  <p className="mt-1 text-xs text-indigo-600">These are the code sets the CQL was evaluating against for this measure version.</p>
                  <div className="mt-3 space-y-2">
                    {linkedValueSets.map((vs) => (
                      <div key={vs.id} className="flex items-center justify-between rounded-xl border border-indigo-200 bg-white dark:bg-neutral-900 px-3 py-2">
                        <div>
                          <p className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">{vs.name}</p>
                          <p className="font-mono text-[10px] text-neutral-500 dark:text-neutral-400">{vs.oid}</p>
                        </div>
                        <div className="flex items-center gap-2 text-right">
                          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">{vs.codeCount} code{vs.codeCount !== 1 ? "s" : ""}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${vs.resolvabilityStatus === "RESOLVED" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                            {vs.resolvabilityLabel}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-6 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-4">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">why_flagged</p>
                {caseDetail.evidenceJson.why_flagged ? (
                  <dl className="mt-3 grid gap-2 text-xs text-neutral-700 dark:text-neutral-300 sm:grid-cols-2">
                    <Row label="Last exam date" value={caseDetail.evidenceJson.why_flagged.last_exam_date ?? "None"} />
                    <Row label="Window (days)" value={String(caseDetail.evidenceJson.why_flagged.compliance_window_days)} />
                    <Row label="Days overdue" value={String(caseDetail.evidenceJson.why_flagged.days_overdue ?? 0)} />
                    <Row label="Role eligible" value={caseDetail.evidenceJson.why_flagged.role_eligible ? "Yes" : "No"} />
                    <Row label="Site eligible" value={caseDetail.evidenceJson.why_flagged.site_eligible ? "Yes" : "No"} />
                    <Row label="Waiver status" value={caseDetail.evidenceJson.why_flagged.waiver_status} />
                  </dl>
                ) : null}
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-neutral-700 dark:text-neutral-300">
                  {JSON.stringify(caseDetail.evidenceJson.why_flagged ?? {}, null, 2)}
                </pre>
                <div className="mt-4">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowRawEvidence((current) => !current)}
                  >
                    {showRawEvidence ? "Hide Raw Evidence" : "View Raw Evidence"}
                  </Button>
                </div>
                {showRawEvidence ? (
                  <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 text-xs leading-5 text-neutral-700 dark:text-neutral-300">
                    {JSON.stringify(caseDetail.evidenceJson ?? {}, null, 2)}
                  </pre>
                ) : null}
                <div className="mt-4">
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => void explainWhyFlagged()}
                    disabled={explaining}
                    isLoading={explaining}
                    loadingText="Explaining..."
                  >
                    Explain Why Flagged
                  </Button>
                  {explaining ? <div className="mt-3 h-16 animate-pulse rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-800" /> : null}
                  {aiExplanation ? (
                    <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-primary-700 dark:text-primary-400">Plain-language explanation (AI-assisted)</p>
                      <p>{aiExplanation.explanation}</p>
                      <p className="mt-2 text-xs text-primary-700 dark:text-primary-400">{aiExplanation.disclaimer}</p>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="mt-6 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-4">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Evaluated resource</p>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-neutral-700 dark:text-neutral-300">
                  {JSON.stringify(caseDetail.evidenceJson.evaluatedResource ?? {}, null, 2)}
                </pre>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">Metadata</p>
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

            <div className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">Appointments</p>
              {appointments.length === 0 ? <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">No appointments scheduled.</p> : null}
              <div className="mt-3 space-y-2">
                {appointments.map((appointment) => (
                  <div key={appointment.id} className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-3 text-sm">
                    <p className="font-semibold text-neutral-900 dark:text-neutral-100">{appointment.appointmentType}</p>
                    <p className="text-neutral-700 dark:text-neutral-300">{new Date(appointment.scheduledAt).toLocaleString()} • {appointment.location}</p>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400">Status: {appointment.status} • Created by: {appointment.createdBy}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">Evidence</p>
              <div className="mt-3 space-y-2">
                <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => setEvidenceFile(e.target.files?.[0] ?? null)} />
                <Input
                  label="Evidence description"
                  hideLabel
                  placeholder="Description"
                  value={evidenceDescription}
                  onChange={(e) => setEvidenceDescription(e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void uploadEvidence()}
                  disabled={uploadingEvidence || !evidenceFile}
                  isLoading={uploadingEvidence}
                  loadingText="Uploading..."
                >
                  Upload Evidence
                </Button>
              </div>
              <div className="mt-4 space-y-2">
                {evidence.length === 0 ? <p className="text-sm text-neutral-600 dark:text-neutral-400">No evidence uploaded.</p> : null}
                {evidence.map((entry) => (
                  <div key={entry.id} className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-3 text-sm">
                    <p className="font-semibold text-neutral-900 dark:text-neutral-100">📎 {entry.fileName}</p>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400">{Math.round(entry.fileSizeBytes / 1024)} KB • {entry.mimeType}</p>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400">Uploaded by {entry.uploadedBy} at {new Date(entry.uploadedAt).toLocaleString()}</p>
                    {entry.description ? <p className="text-xs text-neutral-700 dark:text-neutral-300">{entry.description}</p> : null}
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="mt-2"
                      onClick={() => {
                        void api.downloadBlob(`/api/evidence/${entry.id}/download`).then((blob) => {
                          const url = window.URL.createObjectURL(blob);
                          const anchor = document.createElement("a");
                          anchor.href = url;
                          anchor.download = entry.fileName;
                          document.body.appendChild(anchor);
                          anchor.click();
                          document.body.removeChild(anchor);
                          window.URL.revokeObjectURL(url);
                        }).catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : "Download failed");
                        });
                      }}
                    >
                      Download
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">Audit timeline</p>
              <div className="mt-4 space-y-3">
                {caseDetail.timeline.map((event, index) => (
                  (() => {
                    const notificationBadge = timelineNotificationBadge(event);
                    return (
                      <div
                        key={`${event.eventType}-${event.occurredAt}`}
                        className={`rounded-2xl border p-4 ${
                          index === 0 ? "border-blue-300 bg-blue-50/50" : "border-neutral-200 dark:border-neutral-800"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                              <span className="mr-2" aria-hidden>{eventIcon(event.eventType)}</span>
                              {formatEventType(event.eventType)}
                            </p>
                            <p className="text-xs text-neutral-500 dark:text-neutral-400">{event.actor}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-neutral-500 dark:text-neutral-400">{new Date(event.occurredAt).toLocaleString()}</p>
                            <span className="mt-1 inline-block rounded-full border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-neutral-700 dark:text-neutral-300">
                              {timelineSource(event.eventType)}
                            </span>
                            {notificationBadge ? (
                              <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] ${notificationBadge.className}`}>
                                {notificationBadge.label}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-neutral-700 dark:text-neutral-300">
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
      </>
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
      className: "border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
    };
  }

  return null;
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-4">
      <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="mt-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="text-right font-medium text-neutral-900 dark:text-neutral-100">{value}</dd>
    </div>
  );
}

function deliveryBadgeClass(status: string | null) {
  const normalized = normalizeEnumValue(status ?? "");
  if (normalized === "SENT") {
    return "rounded-full border border-emerald-300 bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-900";
  }
  if (normalized === "FAILED") {
    return "rounded-full border border-rose-300 bg-rose-100 px-2 py-0.5 font-semibold text-rose-900";
  }
  if (normalized === "QUEUED") {
    return "rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 font-semibold text-amber-900";
  }
  if (normalized === "SIMULATED") {
    return "rounded-full border border-sky-300 bg-sky-100 px-2 py-0.5 font-semibold text-sky-900";
  }
  return "rounded-full border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 font-semibold text-neutral-700 dark:text-neutral-300";
}
