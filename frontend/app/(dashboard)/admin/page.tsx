"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";
import { formatStatusLabel, normalizeEnumValue } from "@/lib/status";

type IntegrationHealth = {
  integration: string;
  displayName: string;
  status: string;
  lastSyncAt: string | null;
  detail: string;
  config: Record<string, unknown>;
};

type SchedulerStatus = {
  enabled: boolean;
  cron: string;
  nextFireAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string;
};

type MeasureOption = {
  id: string;
  name: string;
  status: string;
};

type WaiverRecord = {
  waiverId: string;
  employeeExternalId: string;
  employeeName: string;
  site: string;
  measureId: string;
  measureName: string;
  measureVersionId: string;
  measureVersion: string;
  exclusionReason: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
  notes: string | null;
  active: boolean;
  expired: boolean;
};

type DataElementMapping = {
  id: string;
  sourceId: string;
  sourceDisplayName: string;
  canonicalElement: string;
  sourceField: string;
  mappingStatus: string;
  lastValidatedAt: string | null;
  notes: string | null;
};

type TerminologyMapping = {
  id: string;
  localCode: string;
  localDisplay: string | null;
  localSystem: string;
  standardCode: string;
  standardDisplay: string | null;
  standardSystem: string;
  mappingStatus: string;
  mappingConfidence: number | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  notes: string | null;
};

type AuditEventRow = {
  occurredAt: string;
  eventType: string;
  scope: string;
  caseId: string | null;
  runId: string | null;
  measureName: string | null;
  employeeExternalId: string | null;
  actor: string | null;
  detail: string | null;
};

type OutreachTemplate = {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  type: string;
  active: boolean;
};

type TemplatePreview = {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
};

type DeliveryLogEntry = {
  id: string;
  caseId: string | null;
  toAddress: string;
  subject: string;
  provider: string;
  status: string;
  sentAt: string | null;
  errorDetail: string | null;
  measureName: string | null;
};

const demoResetVisible = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export default function AdminPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ROLE_ADMIN";
  const [integrations, setIntegrations] = useState<IntegrationHealth[]>([]);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [measures, setMeasures] = useState<MeasureOption[]>([]);
  const [waivers, setWaivers] = useState<WaiverRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEventRow[]>([]);
  const [dataMappings, setDataMappings] = useState<DataElementMapping[]>([]);
  const [terminologyMappings, setTerminologyMappings] = useState<TerminologyMapping[]>([]);
  const [validatingMappings, setValidatingMappings] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [updatingScheduler, setUpdatingScheduler] = useState(false);
  const [loadingWaivers, setLoadingWaivers] = useState(false);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auditScope, setAuditScope] = useState<"all" | "access" | "mutations">("access");
  const [waiverMeasureFilter, setWaiverMeasureFilter] = useState("");
  const [waiverExpiresAfter, setWaiverExpiresAfter] = useState("");
  const [waiverExpiresBefore, setWaiverExpiresBefore] = useState("");
  const [waiverActiveFilter, setWaiverActiveFilter] = useState("");
  const [waiverEmployeeExternalId, setWaiverEmployeeExternalId] = useState("");
  const [waiverMeasureId, setWaiverMeasureId] = useState("");
  const [waiverExclusionReason, setWaiverExclusionReason] = useState("");
  const [waiverExpiresAt, setWaiverExpiresAt] = useState("");
  const [waiverNotes, setWaiverNotes] = useState("");
  const [waiverActive, setWaiverActive] = useState(true);
  const [grantingWaiver, setGrantingWaiver] = useState(false);
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateForm, setTemplateForm] = useState({ subject: "", bodyText: "" });
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templatePreview, setTemplatePreview] = useState<TemplatePreview | null>(null);
  const [deliveryLog, setDeliveryLog] = useState<DeliveryLogEntry[]>([]);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showDisableSchedulerConfirm, setShowDisableSchedulerConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [showAddMapping, setShowAddMapping] = useState(false);
  const [mappingForm, setMappingForm] = useState({
    localCode: "",
    localDisplay: "",
    localSystem: "",
    standardCode: "",
    standardDisplay: "",
    standardSystem: "",
    mappingStatus: "PROPOSED",
    mappingConfidence: "",
    notes: ""
  });
  const [savingMapping, setSavingMapping] = useState(false);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const { siteId } = useGlobalFilters();
  const api = useApi();

  const loadDataMappings = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const data = await api.get<DataElementMapping[]>("/api/admin/data-mappings");
      setDataMappings(data);
    } catch {
      setDataMappings([]);
    }
  }, [api, isAdmin]);

  const loadTerminologyMappings = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const data = await api.get<TerminologyMapping[]>("/api/admin/terminology-mappings");
      setTerminologyMappings(data);
    } catch {
      setTerminologyMappings([]);
    }
  }, [api, isAdmin]);

  const loadIntegrations = useCallback(async () => {
    if (!isAdmin) return;
    setError(null);
    try {
      const data = await api.get<IntegrationHealth[]>("/api/admin/integrations");
      setIntegrations(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api, isAdmin]);

  const loadScheduler = useCallback(async () => {
    if (!isAdmin) return;
    setError(null);
    try {
      const data = await api.get<SchedulerStatus>("/api/admin/scheduler");
      setScheduler(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api, isAdmin]);

  const loadMeasures = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const data = await api.get<MeasureOption[]>("/api/measures");
      setMeasures(data.filter((item) => normalizeEnumValue(item.status) === "ACTIVE"));
    } catch {
      setMeasures([]);
    }
  }, [api, isAdmin]);

  const loadWaivers = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingWaivers(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (siteId) params.set("site", siteId);
      if (waiverMeasureFilter) params.set("measureId", waiverMeasureFilter);
      if (waiverExpiresAfter) params.set("expiresAfter", waiverExpiresAfter);
      if (waiverExpiresBefore) params.set("expiresBefore", waiverExpiresBefore);
      if (waiverActiveFilter) params.set("active", waiverActiveFilter);
      const data = await api.get<WaiverRecord[]>(`/api/admin/waivers?${params.toString()}`);
      setWaivers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoadingWaivers(false);
    }
  }, [api, siteId, waiverMeasureFilter, waiverExpiresAfter, waiverExpiresBefore, waiverActiveFilter, isAdmin]);

  const loadAuditEvents = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingAudit(true);
    setError(null);
    try {
      const data = await api.get<AuditEventRow[]>(`/api/admin/audit-events?scope=${auditScope}&limit=50`);
      setAuditEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoadingAudit(false);
    }
  }, [api, auditScope, isAdmin]);

  const loadTemplates = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const data = await api.get<OutreachTemplate[]>("/api/admin/outreach-templates");
      setTemplates(data);
    } catch {
      setTemplates([]);
    }
  }, [api, isAdmin]);

  const loadDeliveryLog = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const data = await api.get<DeliveryLogEntry[]>("/api/admin/outreach/delivery-log?limit=20");
      setDeliveryLog(data);
    } catch {
      setDeliveryLog([]);
    }
  }, [api, isAdmin]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadIntegrations();
      void loadScheduler();
      void loadMeasures();
      void loadDataMappings();
      void loadTerminologyMappings();
      void loadTemplates();
      void loadDeliveryLog();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadIntegrations, loadMeasures, loadScheduler, loadDataMappings, loadTerminologyMappings, loadTemplates, loadDeliveryLog]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadWaivers();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadWaivers]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAuditEvents();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAuditEvents]);

  async function validateMappings() {
    if (!isAdmin) return;
    setValidatingMappings(true);
    setError(null);
    try {
      const data = await api.post<undefined, DataElementMapping[]>("/api/admin/data-mappings/validate");
      setDataMappings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setValidatingMappings(false);
    }
  }

  async function triggerSync(integration: string) {
    if (!isAdmin) return;
    setSyncing(integration);
    setError(null);
    try {
      await api.post(`/api/admin/integrations/${integration}/sync`);
      await loadIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSyncing(null);
    }
  }

  async function toggleScheduler(enabled: boolean) {
    if (!isAdmin) return;
    setUpdatingScheduler(true);
    setError(null);
    try {
      const data = await api.post<undefined, SchedulerStatus>(`/api/admin/scheduler?enabled=${enabled ? "true" : "false"}`);
      setScheduler(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setUpdatingScheduler(false);
    }
  }

  async function grantWaiver() {
    if (!isAdmin) return;
    if (!waiverEmployeeExternalId.trim() || !waiverMeasureId) {
      setError("Employee external ID and measure are required");
      return;
    }
    if (!waiverExclusionReason.trim()) {
      setError("Waiver reason is required");
      return;
    }
    setGrantingWaiver(true);
    setError(null);
    try {
      await api.post("/api/admin/waivers", {
        employeeExternalId: waiverEmployeeExternalId.trim(),
        measureId: waiverMeasureId,
        exclusionReason: waiverExclusionReason.trim(),
        expiresAt: waiverExpiresAt ? new Date(waiverExpiresAt).toISOString() : null,
        notes: waiverNotes.trim() || null,
        active: waiverActive
      });
      setWaiverEmployeeExternalId("");
      setWaiverMeasureId("");
      setWaiverExclusionReason("");
      setWaiverExpiresAt("");
      setWaiverNotes("");
      setWaiverActive(true);
      await loadWaivers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setGrantingWaiver(false);
    }
  }

  function startEditTemplate(template: OutreachTemplate) {
    setEditingTemplateId(template.id);
    setTemplateForm({ subject: template.subject, bodyText: template.bodyText });
    setTemplatePreview(null);
  }

  async function saveTemplate(template: OutreachTemplate) {
    if (!isAdmin) return;
    setSavingTemplate(true);
    setError(null);
    try {
      await api.put(`/api/admin/outreach-templates/${template.id}`, {
        name: template.name,
        subject: templateForm.subject,
        bodyText: templateForm.bodyText,
        type: template.type,
        active: template.active
      });
      setEditingTemplateId(null);
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function previewTemplate(templateId: string) {
    if (!isAdmin) return;
    setError(null);
    try {
      const preview = await api.get<TemplatePreview>(`/api/admin/outreach-templates/${templateId}/preview`);
      setTemplatePreview(preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to preview template");
    }
  }

  function resetMappingForm() {
    setMappingForm({
      localCode: "",
      localDisplay: "",
      localSystem: "",
      standardCode: "",
      standardDisplay: "",
      standardSystem: "",
      mappingStatus: "PROPOSED",
      mappingConfidence: "",
      notes: ""
    });
    setMappingError(null);
  }

  async function submitMapping() {
    if (!isAdmin) return;
    if (!mappingForm.localCode.trim() || !mappingForm.localSystem.trim()
        || !mappingForm.standardCode.trim() || !mappingForm.standardSystem.trim()) {
      setMappingError("Local Code, Local System, Standard Code, and Standard System are required.");
      return;
    }
    let confidence: number | null = null;
    if (mappingForm.mappingConfidence.trim()) {
      const parsed = Number.parseFloat(mappingForm.mappingConfidence.trim());
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        setMappingError("Confidence must be a number between 0 and 1.");
        return;
      }
      confidence = parsed;
    }
    setSavingMapping(true);
    setMappingError(null);
    try {
      await api.post("/api/admin/terminology-mappings", {
        localCode: mappingForm.localCode.trim(),
        localDisplay: mappingForm.localDisplay.trim() || null,
        localSystem: mappingForm.localSystem.trim(),
        standardCode: mappingForm.standardCode.trim(),
        standardDisplay: mappingForm.standardDisplay.trim() || null,
        standardSystem: mappingForm.standardSystem.trim(),
        mappingStatus: mappingForm.mappingStatus,
        mappingConfidence: confidence,
        notes: mappingForm.notes.trim() || null
      });
      resetMappingForm();
      setShowAddMapping(false);
      await loadTerminologyMappings();
    } catch (err) {
      setMappingError(err instanceof Error ? err.message : "Failed to create mapping");
    } finally {
      setSavingMapping(false);
    }
  }

  async function handleDemoReset() {
    if (!isAdmin) return;
    setResetting(true);
    setResetMessage(null);
    setError(null);
    try {
      await api.post("/api/admin/demo-reset", {});
      setShowResetConfirm(false);
      setResetMessage("Demo data reset. All runs, cases, and audit events were cleared.");
      await Promise.all([
        loadIntegrations(),
        loadDeliveryLog(),
        loadAuditEvents()
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo reset failed");
    } finally {
      setResetting(false);
    }
  }

  if (!isAdmin) {
    return (
      <section className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="max-w-md rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100">
            <ShieldAlert className="h-7 w-7 text-slate-700" />
          </div>
          <h2 className="mt-4 text-2xl font-semibold text-slate-900">Admin access required</h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Your current role does not have access to this section. If you expected to see admin tools, please sign in with an
            administrator account.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 p-8 text-white shadow-lg">
        <p className="text-sm uppercase tracking-[0.3em] text-slate-300">Admin</p>
        <h2 className="mt-2 text-3xl font-semibold">Operations, waivers, and audit access</h2>
        <p className="mt-3 max-w-2xl text-slate-300">
          Keep the demo coherent: integration health, scheduler control, waiver tracking, and access-event review all live
          from the same admin surface.
        </p>
      </div>

      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">scheduler</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">{scheduler?.enabled ? "enabled" : "disabled"}</p>
          <p className="mt-2 text-xs text-slate-500">Cron: {scheduler?.cron ?? "-"}</p>
          <p className="mt-1 text-xs text-slate-500">
            Next fire: {scheduler?.nextFireAt ? new Date(scheduler.nextFireAt).toLocaleString() : "-"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Last scheduled run: {scheduler?.lastRunAt ? new Date(scheduler.lastRunAt).toLocaleString() : "Never"} ({formatStatusLabel(scheduler?.lastRunStatus ?? "never")})
          </p>
          <div className="mt-4 flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowDisableSchedulerConfirm(false);
                  void toggleScheduler(true);
                }}
                disabled={updatingScheduler || scheduler?.enabled === true}
                className="rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
              >
                Enable
              </button>
              {!showDisableSchedulerConfirm && (
                <button
                  type="button"
                  onClick={() => setShowDisableSchedulerConfirm(true)}
                  disabled={updatingScheduler || scheduler?.enabled === false}
                  className="rounded-md bg-slate-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                >
                  Disable
                </button>
              )}
            </div>
            {showDisableSchedulerConfirm && (
              <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-xl space-y-2">
                <p className="text-xs text-amber-800 font-medium">Are you sure you want to disable the scheduler?</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowDisableSchedulerConfirm(false);
                      void toggleScheduler(false);
                    }}
                    className="rounded-md bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
                  >
                    Confirm Disable
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDisableSchedulerConfirm(false)}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </article>

        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">integration health</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {integrations.map((item) => (
              <div key={item.integration} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.displayName}</p>
                <p className="mt-2">
                  <span className={statusBadgeClass(item.status)}>{formatStatusLabel(item.status)}</span>
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Last sync: {item.lastSyncAt ? new Date(item.lastSyncAt).toLocaleString() : "Never"}
                </p>
                <p className="mt-2 text-sm text-slate-600">{item.detail}</p>
                <button
                  type="button"
                  onClick={() => void triggerSync(item.integration)}
                  disabled={syncing === item.integration}
                  className="mt-4 rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {syncing === item.integration ? "Syncing..." : "Manual Sync"}
                </button>
              </div>
            ))}
          </div>
        </article>
      </div>

      <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">data readiness</p>
            <h3 className="mt-1 text-2xl font-semibold text-slate-900">Source mappings</h3>
            <p className="mt-1 text-sm text-slate-600">
              Required data elements for each measure must be mapped to a source system before a measure can safely activate.
              Run Validate Mappings to sync source health into mapping statuses.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void validateMappings()}
            disabled={validatingMappings}
            className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-60"
          >
            {validatingMappings ? "Validating…" : "Validate Mappings"}
          </button>
        </div>

        <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Canonical Element</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">Source Field</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Last Validated</th>
                <th className="px-4 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {dataMappings.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-4 text-sm text-slate-500">No mappings loaded.</td>
                </tr>
              ) : null}
              {dataMappings.map((m) => (
                <tr key={m.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <code className="text-[11px] text-slate-700">{m.canonicalElement}</code>
                  </td>
                  <td className="px-4 py-2 text-slate-600">{m.sourceDisplayName}</td>
                  <td className="px-4 py-2">
                    <code className="text-[11px] text-slate-500">{m.sourceField}</code>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${mappingStatusBadgeClass(m.mappingStatus)}`}>
                      {formatStatusLabel(m.mappingStatus)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {m.lastValidatedAt ? new Date(m.lastValidatedAt).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{m.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">terminology governance</p>
            <h3 className="mt-1 text-2xl font-semibold text-slate-900">Local code mappings</h3>
            <p className="mt-1 text-sm text-slate-600">
              Local and internal codes mapped to standard terminology (LOINC, CPT, CVX, SNOMED). Demo mappings are
              labeled as such and do not claim official accuracy.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (showAddMapping) {
                  resetMappingForm();
                }
                setShowAddMapping((open) => !open);
              }}
              className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              {showAddMapping ? "Close" : "Add Mapping"}
            </button>
            <button
              type="button"
              onClick={() => void loadTerminologyMappings()}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Refresh
            </button>
          </div>
        </div>

        {showAddMapping ? (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h4 className="text-sm font-semibold text-slate-900">Add terminology mapping</h4>
            <p className="mt-1 text-xs text-slate-500">
              Creates a new local-to-standard mapping. New mappings default to <code className="text-[11px]">PROPOSED</code> and
              require review before promotion.
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="text-xs font-medium text-slate-700">
                Local Code *
                <input
                  type="text"
                  value={mappingForm.localCode}
                  onChange={(e) => setMappingForm((prev) => ({ ...prev, localCode: e.target.value }))}
                  placeholder="e.g. LOCAL-AUD-001"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-700">
                Local Display
                <input
                  type="text"
                  value={mappingForm.localDisplay}
                  onChange={(e) => setMappingForm((prev) => ({ ...prev, localDisplay: e.target.value }))}
                  placeholder="Optional human-readable label"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-700">
                Local System *
                <input
                  type="text"
                  value={mappingForm.localSystem}
                  onChange={(e) => setMappingForm((prev) => ({ ...prev, localSystem: e.target.value }))}
                  placeholder="e.g. urn:workwell:demo"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-700">
                Standard Code *
                <input
                  type="text"
                  value={mappingForm.standardCode}
                  onChange={(e) => setMappingForm((prev) => ({ ...prev, standardCode: e.target.value }))}
                  placeholder="e.g. 92557"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-700">
                Standard Display
                <input
                  type="text"
                  value={mappingForm.standardDisplay}
                  onChange={(e) => setMappingForm((prev) => ({ ...prev, standardDisplay: e.target.value }))}
                  placeholder="Optional human-readable label"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-700">
                Standard System *
                <input
                  type="text"
                  value={mappingForm.standardSystem}
                  onChange={(e) => setMappingForm((prev) => ({ ...prev, standardSystem: e.target.value }))}
                  placeholder="e.g. http://www.ama-assn.org/go/cpt"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-700">
                Status
                <div className="mt-1 rounded border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-600">
                  PROPOSED — new mappings always start as PROPOSED and require review before promotion
                </div>
              </label>
              <label className="text-xs font-medium text-slate-700">
                Confidence (0.0 – 1.0)
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={mappingForm.mappingConfidence}
                  onChange={(e) => setMappingForm((prev) => ({ ...prev, mappingConfidence: e.target.value }))}
                  placeholder="e.g. 0.95"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-700 md:col-span-2">
                Notes
                <textarea
                  value={mappingForm.notes}
                  onChange={(e) => setMappingForm((prev) => ({ ...prev, notes: e.target.value }))}
                  placeholder="Optional context for reviewers"
                  rows={2}
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
            </div>
            {mappingError ? <p className="mt-3 text-sm text-red-700">{mappingError}</p> : null}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void submitMapping()}
                disabled={savingMapping}
                className="rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
              >
                {savingMapping ? "Saving…" : "Save mapping"}
              </button>
              <button
                type="button"
                onClick={() => {
                  resetMappingForm();
                  setShowAddMapping(false);
                }}
                disabled={savingMapping}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Local Code</th>
                <th className="px-4 py-2 font-medium">Local System</th>
                <th className="px-4 py-2 font-medium">Standard Code</th>
                <th className="px-4 py-2 font-medium">Standard System</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Confidence</th>
                <th className="px-4 py-2 font-medium">Reviewed By</th>
                <th className="px-4 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {terminologyMappings.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-4 text-sm text-slate-500">No terminology mappings loaded.</td>
                </tr>
              ) : null}
              {terminologyMappings.map((m) => (
                <tr key={m.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <code className="text-[11px] text-slate-700">{m.localCode}</code>
                    {m.localDisplay ? <p className="text-[11px] text-slate-500">{m.localDisplay}</p> : null}
                  </td>
                  <td className="px-4 py-2">
                    <code className="text-[11px] text-slate-500">{m.localSystem}</code>
                  </td>
                  <td className="px-4 py-2">
                    <code className="text-[11px] text-slate-700">{m.standardCode}</code>
                    {m.standardDisplay ? <p className="text-[11px] text-slate-500">{m.standardDisplay}</p> : null}
                  </td>
                  <td className="px-4 py-2">
                    <code className="text-[11px] text-slate-500">{m.standardSystem}</code>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${terminologyStatusBadgeClass(m.mappingStatus)}`}>
                      {formatStatusLabel(m.mappingStatus)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600">
                    {m.mappingConfidence != null ? `${Math.round(m.mappingConfidence * 100)}%` : "—"}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{m.reviewedBy ?? "—"}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{m.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">waivers</p>
            <h3 className="mt-1 text-2xl font-semibold text-slate-900">Excluded case support</h3>
            <p className="mt-1 text-sm text-slate-600">
              Global site filter applies automatically. Use the filters below to inspect active and expired waivers, or
              grant one manually for a specific employee and measure.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadWaivers()}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Refresh waivers
          </button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <label className="text-sm text-slate-600">
            Measure
            <select
              className="mt-2 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={waiverMeasureFilter}
              onChange={(e) => setWaiverMeasureFilter(e.target.value)}
            >
              <option value="">All measures</option>
              {measures.map((measure) => (
                <option key={measure.id} value={measure.id}>
                  {measure.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-slate-600">
            Active
            <select
              className="mt-2 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={waiverActiveFilter}
              onChange={(e) => setWaiverActiveFilter(e.target.value)}
            >
              <option value="">All</option>
              <option value="true">Active only</option>
              <option value="false">Inactive only</option>
            </select>
          </label>
          <label className="text-sm text-slate-600">
            Expires after
            <input
              type="date"
              className="mt-2 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={waiverExpiresAfter}
              onChange={(e) => setWaiverExpiresAfter(e.target.value)}
            />
          </label>
          <label className="text-sm text-slate-600">
            Expires before
            <input
              type="date"
              className="mt-2 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              value={waiverExpiresBefore}
              onChange={(e) => setWaiverExpiresBefore(e.target.value)}
            />
          </label>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-900">Waivers</p>
              <button
                type="button"
                onClick={() => void loadWaivers()}
                disabled={loadingWaivers}
                className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-60"
              >
                {loadingWaivers ? "Loading..." : "Reload"}
              </button>
            </div>
            <div className="mt-3 space-y-3">
              {waivers.length === 0 ? <p className="text-sm text-slate-600">No waivers found for the current filters.</p> : null}
              {waivers.map((waiver) => (
                <div key={waiver.waiverId} className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-slate-900">
                        {waiver.employeeName} <span className="text-xs text-slate-500">({waiver.employeeExternalId})</span>
                      </p>
                      <p className="text-xs text-slate-600">
                        {waiver.measureName} • v{waiver.measureVersion} • {waiver.site || "Unknown site"}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className={`rounded-full px-2 py-1 text-xs font-semibold ${waiver.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>
                        {waiver.active ? "Active" : "Inactive"}
                      </span>
                      {waiver.expired ? (
                        <span className="rounded-full bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-800">Expired</span>
                      ) : null}
                    </div>
                  </div>
                  <p className="mt-2 text-slate-700">{waiver.exclusionReason}</p>
                  <div className="mt-2 grid gap-1 text-xs text-slate-500">
                    <p>Granted by {waiver.grantedBy} at {new Date(waiver.grantedAt).toLocaleString()}</p>
                    <p>Expires {waiver.expiresAt ? new Date(waiver.expiresAt).toLocaleString() : "never"}</p>
                    {waiver.notes ? <p>Notes: {waiver.notes}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Grant waiver</p>
            <p className="mt-1 text-xs text-slate-500">
              Use an employee external ID from the seeded dataset. The latest active version for the selected measure will be used.
            </p>
            <div className="mt-4 grid gap-3">
              <label className="text-sm text-slate-600">
                Employee external ID
                <input
                  className="mt-2 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  placeholder="patient-003"
                  value={waiverEmployeeExternalId}
                  onChange={(e) => setWaiverEmployeeExternalId(e.target.value)}
                />
              </label>
              <label className="text-sm text-slate-600">
                Measure
                <select
                  className="mt-2 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  value={waiverMeasureId}
                  onChange={(e) => setWaiverMeasureId(e.target.value)}
                >
                  <option value="">Select a measure</option>
                  {measures.map((measure) => (
                    <option key={measure.id} value={measure.id}>
                      {measure.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm text-slate-600">
                Exclusion reason
                <textarea
                  className="mt-2 min-h-24 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  placeholder="Active medical waiver on file."
                  value={waiverExclusionReason}
                  onChange={(e) => setWaiverExclusionReason(e.target.value)}
                />
              </label>
              <label className="text-sm text-slate-600">
                Expires at
                <input
                  type="datetime-local"
                  className="mt-2 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  value={waiverExpiresAt}
                  onChange={(e) => setWaiverExpiresAt(e.target.value)}
                />
              </label>
              <label className="text-sm text-slate-600">
                Notes
                <textarea
                  className="mt-2 min-h-20 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  placeholder="Optional notes for the waiver record."
                  value={waiverNotes}
                  onChange={(e) => setWaiverNotes(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={waiverActive} onChange={(e) => setWaiverActive(e.target.checked)} />
                Active waiver
              </label>
              <button
                type="button"
                onClick={() => void grantWaiver()}
                disabled={grantingWaiver}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {grantingWaiver ? "Granting..." : "Grant waiver"}
              </button>
            </div>
          </div>
        </div>
      </article>

      <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">notification templates</p>
            <h3 className="mt-1 text-2xl font-semibold text-slate-900">Outreach message templates</h3>
            <p className="mt-1 text-sm text-slate-600">
              Edit the subject and body of outreach templates inline. Preview substitutes sample values for
              {" "}
              <code className="text-[11px] text-slate-500">{"{employee_name}"}</code>,{" "}
              <code className="text-[11px] text-slate-500">{"{measure_name}"}</code>,{" "}
              <code className="text-[11px] text-slate-500">{"{due_date}"}</code>,{" "}
              <code className="text-[11px] text-slate-500">{"{assignee_name}"}</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadTemplates()}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Refresh templates
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {templates.length === 0 ? (
            <p className="text-sm text-slate-600">No templates loaded.</p>
          ) : null}
          {templates.map((template) => (
            <div key={template.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{template.name}</p>
                  <p className="text-xs text-slate-500">
                    {template.type} · Subject: {template.subject}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => startEditTemplate(template)}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void previewTemplate(template.id)}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    Preview
                  </button>
                </div>
              </div>
              {editingTemplateId === template.id ? (
                <div className="mt-3 space-y-2">
                  <input
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                    value={templateForm.subject}
                    onChange={(e) => setTemplateForm((f) => ({ ...f, subject: e.target.value }))}
                    placeholder="Subject"
                  />
                  <textarea
                    className="h-32 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
                    value={templateForm.bodyText}
                    onChange={(e) => setTemplateForm((f) => ({ ...f, bodyText: e.target.value }))}
                    placeholder="Body text"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void saveTemplate(template)}
                      disabled={savingTemplate}
                      className="rounded-md bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      {savingTemplate ? "Saving..." : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingTemplateId(null)}
                      className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {templatePreview && templatePreview.id === template.id ? (
                <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Preview</p>
                  <p className="mt-2 text-sm font-semibold text-slate-800">{templatePreview.subject}</p>
                  <pre className="mt-2 whitespace-pre-wrap text-[12px] leading-5 text-slate-700">{templatePreview.bodyText}</pre>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </article>

      <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">outreach delivery log</p>
            <h3 className="mt-1 text-2xl font-semibold text-slate-900">Recent outreach emails</h3>
            <p className="mt-1 text-sm text-slate-600">
              Every outreach send is recorded here. On the demo stack the provider is{" "}
              <code className="text-[11px] text-slate-500">simulated</code> — no real email is delivered.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadDeliveryLog()}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Refresh log
          </button>
        </div>

        <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Recipient</th>
                <th className="px-4 py-2 font-medium">Measure</th>
                <th className="px-4 py-2 font-medium">Subject</th>
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Sent</th>
              </tr>
            </thead>
            <tbody>
              {deliveryLog.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-4 text-sm text-slate-500">No outreach emails sent yet.</td>
                </tr>
              ) : null}
              {deliveryLog.map((entry) => (
                <tr key={entry.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-700">{entry.toAddress}</td>
                  <td className="px-4 py-2 text-slate-600">{entry.measureName ?? "—"}</td>
                  <td className="max-w-xs truncate px-4 py-2 text-xs text-slate-600">{entry.subject}</td>
                  <td className="px-4 py-2">
                    <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                      {entry.provider}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${deliveryStatusBadgeClass(entry.status)}`}>
                      {entry.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {entry.sentAt ? new Date(entry.sentAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      {demoResetVisible ? (
      <article className="rounded-3xl border border-red-200 bg-white p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-red-600">demo tools</p>
        <h3 className="mt-1 text-2xl font-semibold text-red-700">Reset demo data</h3>
        <p className="mt-1 text-sm text-slate-600">
          Clears all runs, cases, outcomes, outreach, and audit events. Employees, measures, and value sets are
          preserved. Only available outside production.
        </p>
        {resetMessage ? <p className="mt-3 text-sm font-medium text-emerald-700">{resetMessage}</p> : null}
        <div className="mt-4">
          {!showResetConfirm ? (
            <button
              type="button"
              onClick={() => {
                setResetMessage(null);
                setShowResetConfirm(true);
              }}
              className="rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100"
            >
              Reset Demo Data
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-red-700">Are you sure? This cannot be undone.</span>
              <button
                type="button"
                onClick={() => void handleDemoReset()}
                disabled={resetting}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              >
                {resetting ? "Resetting..." : "Confirm Reset"}
              </button>
              <button
                type="button"
                onClick={() => setShowResetConfirm(false)}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </article>
      ) : null}

      <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">audit log</p>
            <h3 className="mt-1 text-2xl font-semibold text-slate-900">Access events and mutations</h3>
            <p className="mt-1 text-sm text-slate-600">
              CASE_VIEWED events are separated from mutations so access review stays distinct from action history.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {([
              ["all", "All"],
              ["access", "Access Events Only"],
              ["mutations", "Mutations Only"]
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setAuditScope(value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${auditScope === value ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-sm text-slate-600">
            {auditScope === "access" ? "Showing case views." : auditScope === "mutations" ? "Showing write events." : "Showing all audit events."}
          </p>
          <button
            type="button"
            onClick={() => void loadAuditEvents()}
            disabled={loadingAudit}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60"
          >
            {loadingAudit ? "Loading..." : "Refresh audit"}
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {auditEvents.length === 0 ? <p className="text-sm text-slate-600">No audit events found.</p> : null}
          {auditEvents.map((event) => (
            <div key={`${event.eventType}-${event.occurredAt}-${event.caseId ?? "none"}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-slate-900">{event.eventType}</p>
                  <p className="text-xs text-slate-500">
                    {event.scope === "access" ? "Access event" : "Mutation"} • {event.actor ?? "system"} • {new Date(event.occurredAt).toLocaleString()}
                  </p>
                </div>
                <span className={`rounded-full px-2 py-1 text-xs font-semibold ${event.scope === "access" ? "bg-indigo-100 text-indigo-800" : "bg-slate-100 text-slate-700"}`}>
                  {event.scope}
                </span>
              </div>
              <div className="mt-2 grid gap-1 text-xs text-slate-600">
                <p>Case: {event.caseId ?? "-"}</p>
                <p>Run: {event.runId ?? "-"}</p>
                <p>Measure: {event.measureName ?? "-"}</p>
                <p>Employee: {event.employeeExternalId ?? "-"}</p>
              </div>
              {event.detail ? <pre className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white p-3 text-[11px] leading-5 text-slate-700">{event.detail}</pre> : null}
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}

function terminologyStatusBadgeClass(status: string) {
  const s = (status ?? "").toUpperCase();
  if (s === "APPROVED") return "bg-emerald-100 text-emerald-800";
  if (s === "REVIEWED") return "bg-blue-100 text-blue-800";
  if (s === "PROPOSED") return "bg-amber-100 text-amber-800";
  if (s === "REJECTED") return "bg-red-100 text-red-800";
  return "bg-slate-100 text-slate-700";
}

function mappingStatusBadgeClass(status: string) {
  const s = (status ?? "").toUpperCase();
  if (s === "MAPPED") return "bg-emerald-100 text-emerald-800";
  if (s === "STALE" || s === "PARTIAL") return "bg-amber-100 text-amber-800";
  if (s === "UNMAPPED" || s === "ERROR") return "bg-red-100 text-red-800";
  return "bg-slate-100 text-slate-700";
}

function deliveryStatusBadgeClass(status: string) {
  const s = (status ?? "").toUpperCase();
  if (s === "SENT") return "bg-emerald-100 text-emerald-800";
  if (s === "SIMULATED") return "bg-sky-100 text-sky-800";
  if (s === "FAILED") return "bg-red-100 text-red-800";
  return "bg-slate-100 text-slate-700";
}

function statusBadgeClass(status: string) {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "healthy") {
    return "rounded-full border border-emerald-300 bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-900";
  }
  if (normalized === "simulated") {
    return "rounded-full border border-sky-300 bg-sky-100 px-3 py-1 text-sm font-semibold text-sky-900";
  }
  if (normalized === "degraded" || normalized === "stale") {
    return "rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900";
  }
  if (normalized === "unhealthy") {
    return "rounded-full border border-red-300 bg-red-100 px-3 py-1 text-sm font-semibold text-red-900";
  }
  // unknown / anything else
  return "rounded-full border border-slate-300 bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-700";
}
