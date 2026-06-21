"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@mieweb/ui";
import { MEASURE_STATUS_LABELS, labelFor, measureStatusClass } from "@/lib/status";
import { useApi } from "@/lib/api/hooks";
import { useAuth } from "@/components/auth-provider";
import { canAuthorMeasures } from "@/lib/rbac";
import NitroGrid, { type NitroGridColumn } from "@/features/datavis/NitroGridClient";
import type { RowData, TableColumn, TableRow } from "datavis/src/components/table/types";

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
  const { user } = useAuth();
  const mayAuthor = canAuthorMeasures(user?.role);

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

  // NITRO grid column config + flattened rows (id carried for row-click navigation).
  const gridColumns = useMemo<NitroGridColumn[]>(
    () => [
      { field: "name", header: "Name" },
      { field: "policyRef", header: "Policy Ref" },
      { field: "version", header: "Version" },
      { field: "status", header: "Status" },
      { field: "statusUpdated", header: "Status Updated" },
      { field: "owner", header: "Owner" },
      { field: "lastUpdated", header: "Last Updated" },
      { field: "tags", header: "Tags" },
      { field: "id", header: "ID", visible: false },
      { field: "rawStatus", header: "Raw Status", visible: false },
    ],
    [],
  );

  const gridRows = useMemo(
    () =>
      items.map((item) => ({
        name: item.name,
        policyRef: item.policyRef,
        version: item.version,
        status: labelFor(MEASURE_STATUS_LABELS, item.status),
        rawStatus: item.status,
        statusUpdated: `${new Date(item.statusUpdatedAt).toLocaleString()} by ${item.statusUpdatedBy || "-"}`,
        owner: item.owner,
        lastUpdated: new Date(item.lastUpdated).toLocaleString(),
        tags: item.tags && item.tags.length > 0 ? item.tags.join(", ") : "—",
        id: item.id,
      })),
    [items],
  );

  // Restore the rich cell rendering the hand-rolled table had: CMS policy-ref badge,
  // status pill, and tag chips. NITRO's formatCell returns a ReactNode per cell.
  const formatCell = useCallback(
    (value: unknown, row: RowData, column: TableColumn) => {
      if (column.field === "policyRef") {
        const ref = String(value ?? "");
        if (ref && /^CMS\d+/.test(ref)) {
          return (
            <span className="inline-flex items-center rounded bg-blue-50 px-2 py-0.5 font-mono text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900">
              {ref}
            </span>
          );
        }
        return ref;
      }
      if (column.field === "status") {
        const raw = String(row.rawStatus ?? value ?? "");
        return (
          <span className={`rounded-full px-2 py-1 text-xs font-medium ${measureStatusClass(raw)}`}>
            {String(value ?? "")}
          </span>
        );
      }
      if (column.field === "tags") {
        const text = String(value ?? "");
        if (text === "—") return <span className="text-neutral-400">—</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {text.split(", ").map((tag) => (
              <span key={tag} className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                {tag}
              </span>
            ))}
          </div>
        );
      }
      return value as React.ReactNode;
    },
    [],
  );

  const handleRowClick = useCallback(
    (row: TableRow) => {
      const id = row.data?.id;
      if (typeof id === "string" && id) {
        router.push(`/studio/${id}`);
      }
    },
    [router],
  );

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Measures</h2>
        {mayAuthor ? (
          <Button variant="primary" onClick={() => setShowCreate((value) => !value)}>
            Create Measure
          </Button>
        ) : null}
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

      {items.length > 0 ? (
        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <NitroGrid
            rows={gridRows}
            columns={gridColumns}
            sourceName="Measures"
            formatCell={formatCell}
            onRowClick={handleRowClick}
            style={{ height: "32rem" }}
          />
        </div>
      ) : null}
    </section>
  );
}
