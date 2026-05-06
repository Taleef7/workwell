"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

export default function AdminPage() {
  const [integrations, setIntegrations] = useState<IntegrationHealth[]>([]);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [updatingScheduler, setUpdatingScheduler] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    return raw.trim().replace(/\/+$/, "");
  }, []);

  const loadIntegrations = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/admin/integrations`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      setIntegrations((await response.json()) as IntegrationHealth[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [apiBase]);

  const loadScheduler = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/admin/scheduler`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      setScheduler((await response.json()) as SchedulerStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [apiBase]);

  useEffect(() => {
    if (apiBase) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadIntegrations();
      void loadScheduler();
    }
  }, [apiBase, loadIntegrations, loadScheduler]);

  async function triggerSync(integration: string) {
    setSyncing(integration);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/admin/integrations/${integration}/sync`, { method: "POST" });
      if (!response.ok) throw new Error(`Sync failed: ${response.status}`);
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
      const response = await fetch(`${apiBase}/api/admin/scheduler?enabled=${enabled ? "true" : "false"}`, { method: "POST" });
      if (!response.ok) throw new Error(`Scheduler update failed: ${response.status}`);
      setScheduler((await response.json()) as SchedulerStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setUpdatingScheduler(false);
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Admin Integrations</h2>
        <p className="mt-2 text-slate-600">Integration health and manual sync controls for demo operations.</p>
      </div>

      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}

      <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
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

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {integrations.map((item) => (
          <article key={item.integration} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
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
          </article>
        ))}
      </div>
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
