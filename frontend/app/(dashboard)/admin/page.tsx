"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type IntegrationHealth = {
  integration: string;
  status: string;
  lastSyncAt: string | null;
  detail: string;
};

export default function AdminPage() {
  const [integrations, setIntegrations] = useState<IntegrationHealth[]>([]);
  const [syncing, setSyncing] = useState<string | null>(null);
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

  useEffect(() => {
    if (apiBase) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadIntegrations();
    }
  }, [apiBase, loadIntegrations]);

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

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Admin Integrations</h2>
        <p className="mt-2 text-slate-600">Integration health and manual sync controls for demo operations.</p>
      </div>

      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {integrations.map((item) => (
          <article key={item.integration} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.integration}</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{item.status}</p>
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
