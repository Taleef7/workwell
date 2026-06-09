"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@mieweb/ui";
import { MEASURE_STATUS_LABELS, labelFor, measureStatusClass } from "@/lib/status";
import { useApi } from "@/lib/api/hooks";

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
  const api = useApi();

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
      const data = await api.get<Measure[]>(`/api/measures?${params.toString()}`);
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [api, search, statusFilter]);

  async function createMeasure() {
    if (!name.trim() || !policyRef.trim() || !owner.trim()) {
      setError("Name, Policy Ref, and Owner are required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const payload = await api.post<object, { id: string }>("/api/measures", {
        name: name.trim(),
        policyRef: policyRef.trim(),
        owner: owner.trim()
      });
      setShowCreate(false);
      router.push(`/studio/${payload.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMeasures();
  }, [loadMeasures]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Measures</h2>
        <Button variant="primary" onClick={() => setShowCreate((value) => !value)}>
          Create Measure
        </Button>
      </div>

      <div className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex flex-wrap gap-2">
          {statusFilters.map((status) => (
            <Button
              key={status}
              type="button"
              size="sm"
              variant={statusFilter === status ? "primary" : "outline"}
              className="rounded-full"
              onClick={() => setStatusFilter(status)}
            >
              {status}
            </Button>
          ))}
        </div>
        <div className="mt-3">
          <Input
            label="Search measures"
            hideLabel
            placeholder="Search by measure name or tag"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {showCreate ? (
        <div className="grid gap-3 rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <Input label="Name" hideLabel placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Policy Ref" hideLabel placeholder="Policy Ref" value={policyRef} onChange={(e) => setPolicyRef(e.target.value)} />
          <Input label="Owner" hideLabel placeholder="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
          <div>
            <Button variant="primary" size="sm" onClick={createMeasure} disabled={creating}>
              {creating ? "Creating..." : "Create"}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-sm text-red-700 dark:text-red-400">Error: {error}</p> : null}
      {loading ? <p className="text-sm text-neutral-600 dark:text-neutral-400">Loading measures...</p> : null}
      {!loading && items.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-6 text-sm text-neutral-600 dark:text-neutral-400">
          No measures match this filter.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        <table className="min-w-full text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-800/50 text-left text-neutral-600 dark:text-neutral-400">
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
                className="cursor-pointer border-t border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                onClick={() => router.push(`/studio/${item.id}`)}
              >
                <td className="px-3 py-2">{item.name}</td>
                <td className="px-3 py-2">
                  {item.policyRef && /^CMS\d+/.test(item.policyRef) ? (
                    <span className="inline-flex items-center rounded bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 text-xs font-mono font-medium text-blue-700 dark:text-blue-300 ring-1 ring-inset ring-blue-200 dark:ring-blue-900">
                      {item.policyRef}
                    </span>
                  ) : (
                    item.policyRef
                  )}
                </td>
                <td className="px-3 py-2">{item.version}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-1 text-xs font-medium ${measureStatusClass(item.status)}`}>{labelFor(MEASURE_STATUS_LABELS, item.status)}</span>
                </td>
                <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">
                  {new Date(item.statusUpdatedAt).toLocaleString()} by {item.statusUpdatedBy || "-"}
                </td>
                <td className="px-3 py-2">{item.owner}</td>
                <td className="px-3 py-2">{new Date(item.lastUpdated).toLocaleString()}</td>
                <td className="px-3 py-2">
                  {item.tags && item.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {item.tags.map((tag) => (
                        <span key={tag} className="rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-600 dark:text-neutral-400">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-neutral-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
