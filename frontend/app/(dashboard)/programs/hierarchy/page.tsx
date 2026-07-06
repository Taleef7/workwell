"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { fmtCount } from "@/lib/format";
import { useGlobalFilters } from "@/components/global-filter-context";
import type { TenantOption } from "@/features/compliance/types";
import { SkeletonRow } from "@/components/skeleton-loader";
import { SLOW_LOAD_HINT, useSlowLoadHint } from "@/lib/useSlowLoadHint";

// The rollup root is the cross-system "All Systems" aggregate (E13 PR-1); open it by default.
const ALL_SYSTEMS_ROOT_KEY = "all:all";

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
  level: "all" | "tenant" | "enterprise" | "location" | "provider" | "patient";
  id: string;
  name: string;
  parentId: string | null;
  totals: Totals;
  children: HierarchyNode[];
}

const LEVEL_LABELS: Record<HierarchyNode["level"], string> = {
  all: "All Systems",
  tenant: "System",
  enterprise: "Enterprise",
  location: "Location",
  provider: "Provider",
  patient: "Patient",
};

// Expand/collapse state is keyed by level+id: tenant and enterprise nodes share the same id
// (e.g. "twh"), so keying on id alone would link their carets (E13 PR-1).
const nodeKey = (n: Pick<HierarchyNode, "level" | "id">): string => `${n.level}:${n.id}`;

export default function HierarchyPage() {
  const api = useApi();
  const { from, to } = useGlobalFilters();

  const [root, setRoot] = useState<HierarchyNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [measures, setMeasures] = useState<ProgramSummary[]>([]);
  const [measureId, setMeasureId] = useState("");
  const [tenant, setTenant] = useState("");
  const [tenantOptions, setTenantOptions] = useState<TenantOption[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set([ALL_SYSTEMS_ROOT_KEY]));

  // UX-3 — at 120k scale this rollup is a genuine ~5–7s crunch; after ~3s show an honest hint instead
  // of a bare skeleton so the wait reads as working, not broken.
  const slow = useSlowLoadHint(loading);

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

  // Tenants/systems for the optional System filter (E13 PR-1). Best-effort; never blocks the rollup.
  useEffect(() => {
    let cancelled = false;
    api
      .get<TenantOption[]>("/api/tenants")
      .then((data) => { if (!cancelled) setTenantOptions(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setTenantOptions([]); });
    return () => { cancelled = true; };
  }, [api]);

  const loadRollup = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (measureId) params.set("measureId", measureId);
      if (tenant) params.set("tenant", tenant);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      const data = await api.get<HierarchyNode>(`/api/hierarchy/rollup${qs ? `?${qs}` : ""}`);
      setRoot(data);
      // Always expand the returned root (it's "all" by default, or the tenant node when filtered).
      setOpen((s) => new Set(s).add(nodeKey(data)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setRoot(null);
    } finally {
      setLoading(false);
    }
  }, [api, measureId, tenant, from, to]);

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
    if (open.has(nodeKey(node))) {
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

        <label htmlFor="tenant-filter" className="text-xs uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">
          System
        </label>
        <select
          id="tenant-filter"
          value={tenant}
          onChange={(e) => setTenant(e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          <option value="">All systems</option>
          {tenantOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          Failed to load hierarchy: {error}
        </p>
      ) : null}

      <span className="sr-only" role="status" aria-live="polite">
        {loading
          ? (slow ? `${SLOW_LOAD_HINT} Still loading.` : "Loading compliance hierarchy…")
          : root ? "Compliance hierarchy loaded" : ""}
      </span>

      {slow && loading ? (
        <p className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
          <span aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
          {SLOW_LOAD_HINT}
        </p>
      ) : null}

      {loading ? (
        <div className="overflow-hidden rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Loading compliance hierarchy…</caption>
            <tbody>
              {Array.from({ length: 8 }, (_, i) => (
                <SkeletonRow key={i} cols={5} />
              ))}
            </tbody>
          </table>
        </div>
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
                const key = nodeKey(node);
                const isOpen = open.has(key);
                return (
                  <tr
                    key={key}
                    className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
                  >
                    <td className="px-4 py-2 text-neutral-900 dark:text-neutral-100">
                      <div className="flex items-center gap-2" style={{ paddingLeft: `${depth * 1.25}rem` }}>
                        {hasChildren ? (
                          <button
                            type="button"
                            onClick={() => toggle(key)}
                            aria-expanded={isOpen}
                            aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
                          >
                            {isOpen ? "▾" : "▸"}
                          </button>
                        ) : (
                          <span className="inline-block h-6 w-6 shrink-0" aria-hidden="true" />
                        )}
                        {node.level === "patient" ? (
                          <Link
                            href={`/employees/${node.id}`}
                            className="font-medium text-primary-700 hover:underline dark:text-primary-400"
                          >
                            {node.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{node.name}</span>
                        )}
                        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                          {LEVEL_LABELS[node.level]}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">
                      {fmtCount(node.totals.evaluated)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">
                      {fmtCount(node.totals.compliant)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-900 dark:text-neutral-100">
                      {node.totals.complianceRate}%
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">
                      {fmtCount(node.totals.openCases)}
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
