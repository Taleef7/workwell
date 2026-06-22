"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button, Checkbox, Input, Select, Textarea } from "@mieweb/ui";
import { useAuth } from "@/components/auth-provider";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";
import { formatStatusLabel, normalizeEnumValue } from "@/lib/status";
import NitroGrid, { type NitroGridColumn } from "@/features/datavis/NitroGridClient";
import type { RowData, TableColumn } from "datavis/src/components/table/types";

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

const ADMIN_TABS = [
  { id: "operations", label: "Operations" },
  { id: "governance", label: "Governance" },
  { id: "outreach", label: "Outreach" },
  { id: "audit", label: "Audit" },
] as const;
type AdminTab = (typeof ADMIN_TABS)[number]["id"];

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
  const [auditScope, setAuditScope] = useState<"all" | "access" | "mutations">("all");
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
  const [activeTab, setActiveTab] = useState<AdminTab>("operations");
  const loadedTabs = useRef(new Set<AdminTab>());
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

  // Always-needed, cheap: integration status + scheduler + the measures list (used by several tabs).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadIntegrations();
      void loadScheduler();
      void loadMeasures();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadIntegrations, loadScheduler, loadMeasures]);

  // Lazy per-tab loading: fetch each tab's heavier data (and its NitroGrids' rows) the first time the
  // tab is shown, not all on mount — so landing on Operations doesn't fetch governance/outreach/audit
  // data. `loadedTabs` is marked inside the timer so a cancelled fast tab-switch doesn't mark-without-load.
  useEffect(() => {
    if (loadedTabs.current.has(activeTab)) return;
    const timer = window.setTimeout(() => {
      loadedTabs.current.add(activeTab);
      if (activeTab === "governance") {
        void loadDataMappings();
        void loadTerminologyMappings();
      } else if (activeTab === "outreach") {
        void loadTemplates();
        void loadDeliveryLog();
        void loadWaivers();
      } else if (activeTab === "audit") {
        void loadAuditEvents();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeTab, loadDataMappings, loadTerminologyMappings, loadTemplates, loadDeliveryLog, loadWaivers, loadAuditEvents]);

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

  // ── NITRO grids for the three admin governance/audit tables ──
  // (declared before the isAdmin early-return so hooks run unconditionally)
  const dataMappingColumns: NitroGridColumn[] = [
    { field: "canonicalElement", header: "Canonical Element" },
    { field: "source", header: "Source" },
    { field: "sourceField", header: "Source Field" },
    { field: "status", header: "Status" },
    { field: "lastValidated", header: "Last Validated" },
    { field: "notes", header: "Notes" },
    { field: "rawStatus", header: "Raw Status", visible: false },
  ];
  const dataMappingRows = useMemo(
    () =>
      dataMappings.map((m) => ({
        canonicalElement: m.canonicalElement,
        source: m.sourceDisplayName,
        sourceField: m.sourceField,
        status: formatStatusLabel(m.mappingStatus),
        rawStatus: m.mappingStatus,
        lastValidated: m.lastValidatedAt ? new Date(m.lastValidatedAt).toLocaleString() : "—",
        notes: m.notes ?? "—",
      })),
    [dataMappings],
  );
  const formatDataMappingCell = useCallback((value: unknown, row: RowData, column: TableColumn) => {
    if (column.field === "canonicalElement" || column.field === "sourceField") {
      return <code className="text-[11px] text-neutral-700 dark:text-neutral-300">{String(value ?? "")}</code>;
    }
    if (column.field === "status") {
      return (
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${mappingStatusBadgeClass(String(row.rawStatus ?? ""))}`}>
          {String(value ?? "")}
        </span>
      );
    }
    return value as React.ReactNode;
  }, []);

  const terminologyColumns: NitroGridColumn[] = [
    { field: "localCode", header: "Local Code" },
    { field: "localSystem", header: "Local System" },
    { field: "standardCode", header: "Standard Code" },
    { field: "standardSystem", header: "Standard System" },
    { field: "status", header: "Status" },
    { field: "confidence", header: "Confidence" },
    { field: "reviewedBy", header: "Reviewed By" },
    { field: "notes", header: "Notes" },
    { field: "rawStatus", header: "Raw Status", visible: false },
  ];
  const terminologyRows = useMemo(
    () =>
      terminologyMappings.map((m) => ({
        localCode: m.localDisplay ? `${m.localCode} (${m.localDisplay})` : m.localCode,
        localSystem: m.localSystem,
        standardCode: m.standardDisplay ? `${m.standardCode} (${m.standardDisplay})` : m.standardCode,
        standardSystem: m.standardSystem,
        status: formatStatusLabel(m.mappingStatus),
        rawStatus: m.mappingStatus,
        confidence: m.mappingConfidence != null ? `${Math.round(m.mappingConfidence * 100)}%` : "—",
        reviewedBy: m.reviewedBy ?? "—",
        notes: m.notes ?? "—",
      })),
    [terminologyMappings],
  );
  const formatTerminologyCell = useCallback((value: unknown, row: RowData, column: TableColumn) => {
    if (column.field === "localCode" || column.field === "localSystem" || column.field === "standardCode" || column.field === "standardSystem") {
      return <code className="text-[11px] text-neutral-700 dark:text-neutral-300">{String(value ?? "")}</code>;
    }
    if (column.field === "status") {
      return (
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${terminologyStatusBadgeClass(String(row.rawStatus ?? ""))}`}>
          {String(value ?? "")}
        </span>
      );
    }
    return value as React.ReactNode;
  }, []);

  const waiverMeasureFilterOptions = useMemo(
    () => [
      { value: "", label: "All measures" },
      ...measures.map((measure) => ({ value: measure.id, label: measure.name })),
    ],
    [measures],
  );
  const waiverActiveFilterOptions = useMemo(
    () => [
      { value: "", label: "All" },
      { value: "true", label: "Active only" },
      { value: "false", label: "Inactive only" },
    ],
    [],
  );
  const waiverGrantMeasureOptions = useMemo(
    () => [
      { value: "", label: "Select measure" },
      ...measures.map((measure) => ({ value: measure.id, label: measure.name })),
    ],
    [measures],
  );

  const deliveryColumns: NitroGridColumn[] = [
    { field: "recipient", header: "Recipient" },
    { field: "measure", header: "Measure" },
    { field: "subject", header: "Subject" },
    { field: "provider", header: "Provider" },
    { field: "status", header: "Status" },
    { field: "sent", header: "Sent" },
  ];
  const deliveryRows = useMemo(
    () =>
      deliveryLog.map((entry) => ({
        recipient: entry.toAddress,
        measure: entry.measureName ?? "—",
        subject: entry.subject,
        provider: entry.provider,
        status: entry.status,
        sent: entry.sentAt ? new Date(entry.sentAt).toLocaleString() : "—",
      })),
    [deliveryLog],
  );
  const formatDeliveryCell = useCallback((value: unknown, _row: RowData, column: TableColumn) => {
    if (column.field === "provider") {
      return (
        <span className="rounded-full border border-neutral-300 bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          {String(value ?? "")}
        </span>
      );
    }
    if (column.field === "status") {
      return (
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${deliveryStatusBadgeClass(String(value ?? ""))}`}>
          {String(value ?? "")}
        </span>
      );
    }
    return value as React.ReactNode;
  }, []);

  if (!isAdmin) {
    return (
      <section className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="max-w-md rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-8 text-center shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800">
            <ShieldAlert className="h-7 w-7 text-neutral-700 dark:text-neutral-300" />
          </div>
          <h2 className="mt-4 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Admin access required</h2>
          <p className="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
            Your current role does not have access to this section. If you expected to see admin tools, please sign in with an
            administrator account.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-950 p-8 text-white shadow-lg">
        <p className="text-sm uppercase tracking-[0.3em] text-neutral-300 dark:text-neutral-600">Admin</p>
        <h2 className="mt-2 text-3xl font-semibold">Operations, waivers, and audit access</h2>
        <p className="mt-3 max-w-2xl text-neutral-300 dark:text-neutral-600">
          Keep the demo coherent: integration health, scheduler control, waiver tracking, and access-event review all live
          from the same admin surface.
        </p>
      </div>

      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}

      <div className="flex gap-1 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800" role="tablist" aria-label="Admin sections">
        {ADMIN_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            onClick={() => setActiveTab(t.id)}
            className={`shrink-0 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === t.id
                ? "border-primary-600 text-primary-700 dark:text-primary-400"
                : "border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "operations" && (
      <div className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">scheduler</p>
          <p className="mt-2 text-lg font-semibold text-neutral-900 dark:text-neutral-100">{scheduler?.enabled ? "enabled" : "disabled"}</p>
          <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Cron: {scheduler?.cron ?? "-"}</p>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            Next fire: {scheduler?.nextFireAt ? new Date(scheduler.nextFireAt).toLocaleString() : "-"}
          </p>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            Last scheduled run: {scheduler?.lastRunAt ? new Date(scheduler.lastRunAt).toLocaleString() : "Never"} ({formatStatusLabel(scheduler?.lastRunStatus ?? "never")})
          </p>
          <div className="mt-4 flex flex-col gap-2">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => {
                  setShowDisableSchedulerConfirm(false);
                  void toggleScheduler(true);
                }}
                disabled={updatingScheduler || scheduler?.enabled === true}
              >
                Enable
              </Button>
              {!showDisableSchedulerConfirm && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowDisableSchedulerConfirm(true)}
                  disabled={updatingScheduler || scheduler?.enabled === false}
                >
                  Disable
                </Button>
              )}
            </div>
            {showDisableSchedulerConfirm && (
              <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-xl space-y-2">
                <p className="text-xs text-amber-800 font-medium">Are you sure you want to disable the scheduler?</p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setShowDisableSchedulerConfirm(false);
                      void toggleScheduler(false);
                    }}
                  >
                    Confirm Disable
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowDisableSchedulerConfirm(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </article>

        <article className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">integration health</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {integrations.map((item) => (
              <div key={item.integration} className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">{item.displayName}</p>
                <p className="mt-2">
                  <span className={statusBadgeClass(item.status)}>{formatStatusLabel(item.status)}</span>
                </p>
                <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                  Last sync: {item.lastSyncAt ? new Date(item.lastSyncAt).toLocaleString() : "Never"}
                </p>
                <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{item.detail}</p>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="mt-4"
                  onClick={() => void triggerSync(item.integration)}
                  disabled={syncing === item.integration}
                  isLoading={syncing === item.integration}
                  loadingText="Syncing..."
                >
                  Manual Sync
                </Button>
              </div>
            ))}
          </div>
        </article>
      </div>
      )}

      {activeTab === "governance" && (<>
      <article className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">data readiness</p>
            <h3 className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Source mappings</h3>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              Required data elements for each measure must be mapped to a source system before a measure can safely activate.
              Run Validate Mappings to sync source health into mapping statuses.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void validateMappings()}
            disabled={validatingMappings}
            isLoading={validatingMappings}
            loadingText="Validating…"
          >
            Validate Mappings
          </Button>
        </div>

        {dataMappings.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 px-4 py-4 text-sm text-neutral-500 dark:text-neutral-400">No mappings loaded.</p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
            <NitroGrid
              rows={dataMappingRows}
              columns={dataMappingColumns}
              sourceName="Data Element Mappings"
              formatCell={formatDataMappingCell}
              style={{ height: "26rem" }}
            />
          </div>
        )}
      </article>

      <article className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">terminology governance</p>
            <h3 className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Local code mappings</h3>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              Local and internal codes mapped to standard terminology (LOINC, CPT, CVX, SNOMED). Demo mappings are
              labeled as such and do not claim official accuracy.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => {
                if (showAddMapping) {
                  resetMappingForm();
                }
                setShowAddMapping((open) => !open);
              }}
            >
              {showAddMapping ? "Close" : "Add Mapping"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadTerminologyMappings()}
            >
              Refresh
            </Button>
          </div>
        </div>

        {showAddMapping ? (
          <div className="mt-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-4">
            <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Add terminology mapping</h4>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Creates a new local-to-standard mapping. New mappings default to <code className="text-[11px]">PROPOSED</code> and
              require review before promotion.
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <Input
                label="Local Code *"
                type="text"
                value={mappingForm.localCode}
                onChange={(e) => setMappingForm((prev) => ({ ...prev, localCode: e.target.value }))}
                placeholder="e.g. LOCAL-AUD-001"
              />
              <Input
                label="Local Display"
                type="text"
                value={mappingForm.localDisplay}
                onChange={(e) => setMappingForm((prev) => ({ ...prev, localDisplay: e.target.value }))}
                placeholder="Optional human-readable label"
              />
              <Input
                label="Local System *"
                type="text"
                value={mappingForm.localSystem}
                onChange={(e) => setMappingForm((prev) => ({ ...prev, localSystem: e.target.value }))}
                placeholder="e.g. urn:workwell:demo"
              />
              <Input
                label="Standard Code *"
                type="text"
                value={mappingForm.standardCode}
                onChange={(e) => setMappingForm((prev) => ({ ...prev, standardCode: e.target.value }))}
                placeholder="e.g. 92557"
              />
              <Input
                label="Standard Display"
                type="text"
                value={mappingForm.standardDisplay}
                onChange={(e) => setMappingForm((prev) => ({ ...prev, standardDisplay: e.target.value }))}
                placeholder="Optional human-readable label"
              />
              <Input
                label="Standard System *"
                type="text"
                value={mappingForm.standardSystem}
                onChange={(e) => setMappingForm((prev) => ({ ...prev, standardSystem: e.target.value }))}
                placeholder="e.g. http://www.ama-assn.org/go/cpt"
              />
              <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Status
                <div className="mt-1 rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-400">
                  PROPOSED — new mappings always start as PROPOSED and require review before promotion
                </div>
              </label>
              <Input
                label="Confidence (0.0 – 1.0)"
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={mappingForm.mappingConfidence}
                onChange={(e) => setMappingForm((prev) => ({ ...prev, mappingConfidence: e.target.value }))}
                placeholder="e.g. 0.95"
              />
              <div className="md:col-span-2">
                <Textarea
                  label="Notes"
                  value={mappingForm.notes}
                  onChange={(e) => setMappingForm((prev) => ({ ...prev, notes: e.target.value }))}
                  placeholder="Optional context for reviewers"
                  rows={2}
                />
              </div>
            </div>
            {mappingError ? <p className="mt-3 text-sm text-red-700">{mappingError}</p> : null}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={() => void submitMapping()}
                disabled={savingMapping}
                isLoading={savingMapping}
                loadingText="Saving…"
                variant="primary"
                size="sm"
              >
                Save mapping
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  resetMappingForm();
                  setShowAddMapping(false);
                }}
                disabled={savingMapping}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {terminologyMappings.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 px-4 py-4 text-sm text-neutral-500 dark:text-neutral-400">No terminology mappings loaded.</p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
            <NitroGrid
              rows={terminologyRows}
              columns={terminologyColumns}
              sourceName="Terminology Mappings"
              formatCell={formatTerminologyCell}
              style={{ height: "26rem" }}
            />
          </div>
        )}
      </article>
      </>)}

      {activeTab === "outreach" && (<>
      <article className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">waivers</p>
            <h3 className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Excluded case support</h3>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              Global site filter applies automatically. Use the filters below to inspect active and expired waivers, or
              grant one manually for a specific employee and measure.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadWaivers()}
          >
            Refresh waivers
          </Button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <Select
            label="Measure"
            value={waiverMeasureFilter}
            onValueChange={setWaiverMeasureFilter}
            options={waiverMeasureFilterOptions}
          />
          <Select
            label="Active"
            value={waiverActiveFilter}
            onValueChange={setWaiverActiveFilter}
            options={waiverActiveFilterOptions}
          />
          <Input
            type="date"
            label="Expires after"
            value={waiverExpiresAfter}
            onChange={(e) => setWaiverExpiresAfter(e.target.value)}
          />
          <Input
            type="date"
            label="Expires before"
            value={waiverExpiresBefore}
            onChange={(e) => setWaiverExpiresBefore(e.target.value)}
          />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Waivers</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadWaivers()}
                disabled={loadingWaivers}
                isLoading={loadingWaivers}
                loadingText="Loading..."
              >
                Reload
              </Button>
            </div>
            <div className="mt-3 space-y-3">
              {waivers.length === 0 ? <p className="text-sm text-neutral-600 dark:text-neutral-400">No waivers found for the current filters.</p> : null}
              {waivers.map((waiver) => (
                <div key={waiver.waiverId} className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-neutral-900 dark:text-neutral-100">
                        {waiver.employeeName} <span className="text-xs text-neutral-500 dark:text-neutral-400">({waiver.employeeExternalId})</span>
                      </p>
                      <p className="text-xs text-neutral-600 dark:text-neutral-400">
                        {waiver.measureName} • {waiver.measureVersion} • {waiver.site || "Unknown site"}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className={`rounded-full px-2 py-1 text-xs font-semibold ${waiver.active ? "bg-emerald-100 text-emerald-800" : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300"}`}>
                        {waiver.active ? "Active" : "Inactive"}
                      </span>
                      {waiver.expired ? (
                        <span className="rounded-full bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-800">Expired</span>
                      ) : null}
                    </div>
                  </div>
                  <p className="mt-2 text-neutral-700 dark:text-neutral-300">{waiver.exclusionReason}</p>
                  <div className="mt-2 grid gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                    <p>Granted by {waiver.grantedBy} at {new Date(waiver.grantedAt).toLocaleString()}</p>
                    <p>Expires {waiver.expiresAt ? new Date(waiver.expiresAt).toLocaleString() : "never"}</p>
                    {waiver.notes ? <p>Notes: {waiver.notes}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-4">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Grant waiver</p>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Use an employee external ID from the seeded dataset. The latest active version for the selected measure will be used.
            </p>
            <div className="mt-4 grid gap-3">
              <Input
                label="Employee external ID"
                placeholder="patient-003"
                value={waiverEmployeeExternalId}
                onChange={(e) => setWaiverEmployeeExternalId(e.target.value)}
              />
              <Select
                label="Measure"
                value={waiverMeasureId}
                onValueChange={setWaiverMeasureId}
                options={waiverGrantMeasureOptions}
              />
              <Textarea
                label="Exclusion reason"
                className="min-h-24"
                placeholder="Active medical waiver on file."
                value={waiverExclusionReason}
                onChange={(e) => setWaiverExclusionReason(e.target.value)}
              />
              <Input
                type="datetime-local"
                label="Expires at"
                value={waiverExpiresAt}
                onChange={(e) => setWaiverExpiresAt(e.target.value)}
              />
              <Textarea
                label="Notes"
                className="min-h-20"
                placeholder="Optional notes for the waiver record."
                value={waiverNotes}
                onChange={(e) => setWaiverNotes(e.target.value)}
              />
              <Checkbox
                label="Active waiver"
                checked={waiverActive}
                onChange={(e) => setWaiverActive(e.target.checked)}
              />
              <Button
                type="button"
                variant="primary"
                onClick={() => void grantWaiver()}
                disabled={grantingWaiver}
                isLoading={grantingWaiver}
                loadingText="Granting..."
              >
                Grant waiver
              </Button>
            </div>
          </div>
        </div>
      </article>

      <article className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">notification templates</p>
            <h3 className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Outreach message templates</h3>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              Edit the subject and body of outreach templates inline. Preview substitutes sample values for
              {" "}
              <code className="text-[11px] text-neutral-500 dark:text-neutral-400">{"{employee_name}"}</code>,{" "}
              <code className="text-[11px] text-neutral-500 dark:text-neutral-400">{"{measure_name}"}</code>,{" "}
              <code className="text-[11px] text-neutral-500 dark:text-neutral-400">{"{due_date}"}</code>,{" "}
              <code className="text-[11px] text-neutral-500 dark:text-neutral-400">{"{assignee_name}"}</code>.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadTemplates()}
          >
            Refresh templates
          </Button>
        </div>

        <div className="mt-4 space-y-3">
          {templates.length === 0 ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">No templates loaded.</p>
          ) : null}
          {templates.map((template) => (
            <div key={template.id} className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{template.name}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {template.type} · Subject: {template.subject}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => startEditTemplate(template)}>
                    Edit
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void previewTemplate(template.id)}>
                    Preview
                  </Button>
                </div>
              </div>
              {editingTemplateId === template.id ? (
                <div className="mt-3 space-y-2">
                  <Input
                    label="Subject"
                    hideLabel
                    value={templateForm.subject}
                    onChange={(e) => setTemplateForm((f) => ({ ...f, subject: e.target.value }))}
                    placeholder="Subject"
                  />
                  <Textarea
                    label="Body text"
                    hideLabel
                    className="h-32 font-mono"
                    value={templateForm.bodyText}
                    onChange={(e) => setTemplateForm((f) => ({ ...f, bodyText: e.target.value }))}
                    placeholder="Body text"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => void saveTemplate(template)}
                      disabled={savingTemplate}
                      isLoading={savingTemplate}
                      loadingText="Saving..."
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditingTemplateId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
              {templatePreview && templatePreview.id === template.id ? (
                <div className="mt-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Preview</p>
                  <p className="mt-2 text-sm font-semibold text-neutral-800 dark:text-neutral-200">{templatePreview.subject}</p>
                  <pre className="mt-2 whitespace-pre-wrap text-[12px] leading-5 text-neutral-700 dark:text-neutral-300">{templatePreview.bodyText}</pre>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </article>

      <article className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">outreach delivery log</p>
            <h3 className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Recent outreach emails</h3>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              Every outreach send is recorded here. On the demo stack the provider is{" "}
              <code className="text-[11px] text-neutral-500 dark:text-neutral-400">simulated</code> — no real email is delivered.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadDeliveryLog()}>
            Refresh log
          </Button>
        </div>

        {deliveryLog.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 px-4 py-4 text-sm text-neutral-500 dark:text-neutral-400">No outreach emails sent yet.</p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
            <NitroGrid
              rows={deliveryRows}
              columns={deliveryColumns}
              sourceName="Outreach Delivery Log"
              formatCell={formatDeliveryCell}
              style={{ height: "26rem" }}
            />
          </div>
        )}
      </article>
      </>)}

      {activeTab === "audit" && (<>
      {demoResetVisible ? (
      <article className="rounded-3xl border border-red-200 bg-white dark:bg-neutral-900 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-red-600">demo tools</p>
        <h3 className="mt-1 text-2xl font-semibold text-red-700">Reset demo data</h3>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Clears all runs, cases, outcomes, outreach, and audit events. Employees, measures, and value sets are
          preserved. Only available outside production.
        </p>
        {resetMessage ? <p className="mt-3 text-sm font-medium text-emerald-700">{resetMessage}</p> : null}
        <div className="mt-4">
          {!showResetConfirm ? (
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setResetMessage(null);
                setShowResetConfirm(true);
              }}
            >
              Reset Demo Data
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-red-700">Are you sure? This cannot be undone.</span>
              <Button
                type="button"
                variant="danger"
                onClick={() => void handleDemoReset()}
                disabled={resetting}
                isLoading={resetting}
                loadingText="Resetting..."
              >
                Confirm Reset
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowResetConfirm(false)}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      </article>
      ) : null}

      <article className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">audit log</p>
            <h3 className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Access events and mutations</h3>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
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
                className={`rounded-full border px-3 py-1 text-xs font-medium ${auditScope === value ? "border-neutral-900 dark:border-neutral-100 bg-neutral-900 text-white" : "border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {auditScope === "access" ? "Showing case views." : auditScope === "mutations" ? "Showing write events." : "Showing all audit events."}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadAuditEvents()}
            disabled={loadingAudit}
            isLoading={loadingAudit}
            loadingText="Loading..."
          >
            Refresh audit
          </Button>
        </div>

        <div className="mt-4 space-y-3">
          {auditEvents.length === 0 ? <p className="text-sm text-neutral-600 dark:text-neutral-400">No audit events found.</p> : null}
          {auditEvents.map((event) => (
            <div key={`${event.eventType}-${event.occurredAt}-${event.caseId ?? "none"}`} className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-neutral-900 dark:text-neutral-100">{event.eventType}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {event.scope === "access" ? "Access event" : "Mutation"} • {event.actor ?? "system"} • {new Date(event.occurredAt).toLocaleString()}
                  </p>
                </div>
                <span className={`rounded-full px-2 py-1 text-xs font-semibold ${event.scope === "access" ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300" : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300"}`}>
                  {event.scope}
                </span>
              </div>
              <div className="mt-2 grid gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                <p>Case: {event.caseId ?? "-"}</p>
                <p>Run: {event.runId ?? "-"}</p>
                <p>Measure: {event.measureName ?? "-"}</p>
                <p>Employee: {event.employeeExternalId ?? "-"}</p>
              </div>
              {event.detail ? <pre className="mt-3 overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 text-[11px] leading-5 text-neutral-700 dark:text-neutral-300">{event.detail}</pre> : null}
            </div>
          ))}
        </div>
      </article>
      </>)}
    </section>
  );
}

function terminologyStatusBadgeClass(status: string) {
  const s = (status ?? "").toUpperCase();
  if (s === "APPROVED") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (s === "REVIEWED") return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
  if (s === "PROPOSED") return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  if (s === "REJECTED") return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
  return "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300";
}

function mappingStatusBadgeClass(status: string) {
  const s = (status ?? "").toUpperCase();
  if (s === "MAPPED") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (s === "STALE" || s === "PARTIAL") return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  if (s === "UNMAPPED" || s === "ERROR") return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
  return "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300";
}

function deliveryStatusBadgeClass(status: string) {
  const s = (status ?? "").toUpperCase();
  if (s === "SENT") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (s === "SIMULATED") return "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300";
  if (s === "FAILED") return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
  return "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300";
}

function statusBadgeClass(status: string) {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "healthy") {
    return "rounded-full border border-emerald-300 bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-900 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200";
  }
  if (normalized === "simulated") {
    return "rounded-full border border-sky-300 bg-sky-100 px-3 py-1 text-sm font-semibold text-sky-900 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-200";
  }
  if (normalized === "degraded" || normalized === "stale") {
    return "rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200";
  }
  if (normalized === "unhealthy") {
    return "rounded-full border border-red-300 bg-red-100 px-3 py-1 text-sm font-semibold text-red-900 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200";
  }
  // unknown / anything else
  return "rounded-full border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 px-3 py-1 text-sm font-semibold text-neutral-700 dark:text-neutral-300";
}
