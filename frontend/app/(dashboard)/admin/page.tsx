"use client";

import { useCallback, useEffect, useState } from "react";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";

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

export default function AdminPage() {
  const [integrations, setIntegrations] = useState<IntegrationHealth[]>([]);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [measures, setMeasures] = useState<MeasureOption[]>([]);
  const [waivers, setWaivers] = useState<WaiverRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEventRow[]>([]);
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
  const { siteId } = useGlobalFilters();
  const api = useApi();

  const loadIntegrations = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<IntegrationHealth[]>("/api/admin/integrations");
      setIntegrations(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api]);

  const loadScheduler = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<SchedulerStatus>("/api/admin/scheduler");
      setScheduler(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api]);

  const loadMeasures = useCallback(async () => {
    try {
      const data = await api.get<MeasureOption[]>("/api/measures");
      setMeasures(data.filter((item) => item.status === "Active"));
    } catch {
      setMeasures([]);
    }
  }, [api]);

  const loadWaivers = useCallback(async () => {
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
  }, [api, siteId, waiverMeasureFilter, waiverExpiresAfter, waiverExpiresBefore, waiverActiveFilter]);

  const loadAuditEvents = useCallback(async () => {
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
  }, [api, auditScope]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadIntegrations();
      void loadScheduler();
      void loadMeasures();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadIntegrations, loadMeasures, loadScheduler]);

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

  async function triggerSync(integration: string) {
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
            Last scheduled run: {scheduler?.lastRunAt ? new Date(scheduler.lastRunAt).toLocaleString() : "Never"} ({scheduler?.lastRunStatus ?? "never"})
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => void toggleScheduler(true)}
              disabled={updatingScheduler || scheduler?.enabled === true}
              className="rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            >
              Enable
            </button>
            <button
              type="button"
              onClick={() => void toggleScheduler(false)}
              disabled={updatingScheduler || scheduler?.enabled === false}
              className="rounded-md bg-slate-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            >
              Disable
            </button>
          </div>
        </article>

        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">integration health</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {integrations.map((item) => (
              <div key={item.integration} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.displayName}</p>
                <p className="mt-2">
                  <span className={statusBadgeClass(item.status)}>{item.status}</span>
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

function statusBadgeClass(status: string) {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "healthy") {
    return "rounded-full border border-emerald-300 bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-900";
  }
  if (normalized === "degraded" || normalized === "stale") {
    return "rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900";
  }
  return "rounded-full border border-slate-300 bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-700";
}
