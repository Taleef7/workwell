"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { measureStatusClass } from "@/lib/status";

type Measure = {
  id: string;
  name: string;
  policyRef: string;
  version: string;
  status: "Draft" | "Approved" | "Active" | "Deprecated" | string;
  owner: string;
  lastUpdated: string;
  tags: string[];
  statusUpdatedAt: string;
  statusUpdatedBy: string;
};

const statusFilters = ["All", "Draft", "Approved", "Active", "Deprecated"] as const;
type StatusFilter = (typeof statusFilters)[number];

export default function MeasuresPage() {
  const router = useRouter();
  const apiBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    return raw.trim().replace(/\/+$/, "");
  }, []);

  const [items, setItems] = useState<Measure[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [policyRef, setPolicyRef] = useState("");
  const [owner, setOwner] = useState("");
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [search, setSearch] = useState("");

  const loadMeasures = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "All") {
        params.set("status", statusFilter);
      }
      if (search.trim()) {
        params.set("search", search.trim());
      }
      const response = await fetch(`${apiBase}/api/measures?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to load measures (${response.status})`);
      }
      const data = (await response.json()) as Measure[];
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [apiBase, search, statusFilter]);

  async function createMeasure() {
    if (!name.trim() || !policyRef.trim() || !owner.trim()) {
      setError("Name, Policy Ref, and Owner are required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/measures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          policyRef: policyRef.trim(),
          owner: owner.trim()
        })
      });
      if (!response.ok) {
        throw new Error(`Create failed (${response.status})`);
      }
      const payload = (await response.json()) as { id: string };
      setShowCreate(false);
      router.push(`/studio/${payload.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    if (apiBase) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadMeasures();
    }
  }, [apiBase, loadMeasures]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold">Measures</h2>
        <button
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
          onClick={() => setShowCreate((value) => !value)}
        >
          Create Measure
        </button>
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap gap-2">
          {statusFilters.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${statusFilter === status ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"}`}
            >
              {status}
            </button>
          ))}
        </div>
        <div className="mt-3">
          <input
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            placeholder="Search by measure name or tag"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {showCreate ? (
        <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
          <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Policy Ref" value={policyRef} onChange={(e) => setPolicyRef(e.target.value)} />
          <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
          <div>
            <button className="rounded bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60" onClick={createMeasure} disabled={creating}>
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-sm text-red-700">Error: {error}</p> : null}
      {loading ? <p className="text-sm text-slate-600">Loading measures...</p> : null}
      {!loading && items.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
          No measures match this filter.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Policy Ref</th>
              <th className="px-3 py-2">Version</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Status Updated</th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2">Last Updated</th>
              <th className="px-3 py-2">Tags</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                className="cursor-pointer border-t border-slate-200 hover:bg-slate-50"
                onClick={() => router.push(`/studio/${item.id}`)}
              >
                <td className="px-3 py-2">{item.name}</td>
                <td className="px-3 py-2">{item.policyRef}</td>
                <td className="px-3 py-2">{item.version}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-1 text-xs font-medium ${measureStatusClass(item.status)}`}>{item.status}</span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {new Date(item.statusUpdatedAt).toLocaleString()} by {item.statusUpdatedBy || "-"}
                </td>
                <td className="px-3 py-2">{item.owner}</td>
                <td className="px-3 py-2">{new Date(item.lastUpdated).toLocaleString()}</td>
                <td className="px-3 py-2">{item.tags?.join(", ") || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
