"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { useGlobalFilters } from "@/components/global-filter-context";

const ENTERPRISE_ROOT_ID = "twh";

type ProgramSummary = {
  measureId: string;
  measureName: string;
};

interface Totals {
  evaluated: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
  complianceRate: number;
  openCases: number;
}

interface HierarchyNode {
  level: "enterprise" | "location" | "provider" | "patient";
  id: string;
  name: string;
  parentId: string | null;
  totals: Totals;
  children: HierarchyNode[];
}

const LEVEL_LABELS: Record<HierarchyNode["level"], string> = {
  enterprise: "Enterprise",
  location: "Location",
  provider: "Provider",
  patient: "Patient",
};

export default function HierarchyPage() {
  const api = useApi();
  const { from, to } = useGlobalFilters();

  const [root, setRoot] = useState<HierarchyNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [measures, setMeasures] = useState<ProgramSummary[]>([]);
  const [measureId, setMeasureId] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set([ENTERPRISE_ROOT_ID]));

  // Measure dropdown is sourced the same way /programs sources its measures.
  useEffect(() => {
    let cancelled = false;
    api
      .get<ProgramSummary[]>("/api/programs/overview")
      .then((data) => {
        if (!cancelled) setMeasures(data);
      })
      .catch(() => {
        if (!cancelled) setMeasures([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const loadRollup = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (measureId) params.set("measureId", measureId);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      const data = await api.get<HierarchyNode>(`/api/hierarchy/rollup${qs ? `?${qs}` : ""}`);
      setRoot(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setRoot(null);
    } finally {
      setLoading(false);
    }
  }, [api, measureId, from, to]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadRollup();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadRollup]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows: Array<{ node: HierarchyNode; depth: number }> = [];
  const walk = (node: HierarchyNode, depth: number) => {
    rows.push({ node, depth });
    if (open.has(node.id)) {
      node.children.forEach((child) => walk(child, depth + 1));
    }
  };
  if (root) walk(root, 0);

  const isEmpty = !loading && !error && root != null && root.children.length === 0;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Compliance Hierarchy</h2>
        <Link
          href="/programs"
          className="text-sm font-medium text-neutral-700 hover:underline dark:text-neutral-300"
        >
          ← Back to Programs
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="measure-filter" className="text-xs uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">
          Measure
        </label>
        <select
          id="measure-filter"
          value={measureId}
          onChange={(e) => setMeasureId(e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          <option value="">All measures</option>
          {measures.map((m) => (
            <option key={m.measureId} value={m.measureId}>
              {m.measureName}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          Failed to load hierarchy: {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>
      ) : null}

      {isEmpty ? (
        <div className="rounded-md border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
          No data for this scope.
        </div>
      ) : null}

      {!loading && !error && root && root.children.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-[0.1em] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                <th scope="col" className="px-4 py-2 font-semibold">Name</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Evaluated</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Compliant</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Compliance</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Open Cases</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ node, depth }) => {
                const hasChildren = node.children.length > 0;
                const isOpen = open.has(node.id);
                return (
                  <tr
                    key={`${node.level}:${node.id}`}
                    className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
                  >
                    <td className="px-4 py-2 text-neutral-900 dark:text-neutral-100">
                      <div className="flex items-center gap-2" style={{ paddingLeft: `${depth * 1.25}rem` }}>
                        {hasChildren ? (
                          <button
                            type="button"
                            onClick={() => toggle(node.id)}
                            aria-expanded={isOpen}
                            aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
                          >
                            {isOpen ? "▾" : "▸"}
                          </button>
                        ) : (
                          <span className="inline-block h-5 w-5 shrink-0" aria-hidden="true" />
                        )}
                        <span className="font-medium">{node.name}</span>
                        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                          {LEVEL_LABELS[node.level]}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">
                      {node.totals.evaluated}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">
                      {node.totals.compliant}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-900 dark:text-neutral-100">
                      {node.totals.complianceRate}%
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">
                      {node.totals.openCases}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
