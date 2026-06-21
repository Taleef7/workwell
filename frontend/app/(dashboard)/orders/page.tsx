"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Select } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import { useApi } from "@/lib/api/hooks";
import { useAuth } from "@/components/auth-provider";
import { canViewOrders } from "@/lib/rbac";
import { OUTCOME_LABELS, labelFor, normalizeEnumValue, outcomeStatusClass } from "@/lib/status";

// Backend contract (#77 E7 — GET /api/orders/proposals?format=domain).
type OrderCode = { code: string; system: string; display: string };
type ProposedOrder = {
  subjectId: string;
  measureId: string;
  order: OrderCode;
  reasonOutcome: string;
  priority: string;
  status: string;
  dedupeKey: string;
  authoredOn: string;
};
type ProposalsResponse = { proposed: ProposedOrder[]; suppressed: ProposedOrder[] };
type MeasureSummary = { measureId: string; measureName: string };

function priorityClass(priority: string): string {
  return normalizeEnumValue(priority) === "URGENT"
    ? "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300"
    : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
}

function systemLabel(system: string): string {
  if (system.includes("cpt")) return "CPT";
  if (system.includes("cvx")) return "CVX";
  if (system.includes("loinc")) return "LOINC";
  if (system.includes("urn:workwell")) return "LOCAL";
  return system;
}

export default function OrdersPage() {
  const api = useApi();
  const { user } = useAuth();
  const mayView = canViewOrders(user?.role);

  const [data, setData] = useState<ProposalsResponse | null>(null);
  const [measures, setMeasures] = useState<MeasureSummary[]>([]);
  const [measureFilter, setMeasureFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const measureNameById = useMemo(() => {
    const map = new Map<string, string>();
    measures.forEach((m) => map.set(m.measureId, m.measureName));
    return map;
  }, [measures]);

  useEffect(() => {
    if (!mayView) return;
    let cancelled = false;
    api
      .get<MeasureSummary[]>("/api/programs/overview")
      .then((d) => {
        if (!cancelled) setMeasures(d);
      })
      .catch(() => {
        if (!cancelled) setMeasures([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, mayView]);

  const load = useCallback(async () => {
    if (!mayView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ format: "domain" });
      if (measureFilter) params.set("measureId", measureFilter);
      const res = await api.get<ProposalsResponse>(`/api/orders/proposals?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [api, mayView, measureFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function copyFhirBundle() {
    setCopying(true);
    try {
      const params = new URLSearchParams({ format: "fhir" });
      if (measureFilter) params.set("measureId", measureFilter);
      const bundle = await api.get<unknown>(`/api/orders/proposals?${params.toString()}`);
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      emitToast("FHIR ServiceRequest Bundle copied to clipboard");
    } catch (err) {
      emitToast(err instanceof Error ? err.message : "Could not copy FHIR bundle");
    } finally {
      setCopying(false);
    }
  }

  const measureOptions = useMemo(
    () => [{ value: "", label: "All measures" }, ...measures.map((m) => ({ value: m.measureId, label: m.measureName }))],
    [measures],
  );

  function measureLabel(id: string): string {
    return measureNameById.get(id) ?? id;
  }

  if (!mayView) {
    return (
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Order Proposals</h2>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Order proposals are clinical decision support, managed by Case Managers and Admins — your role doesn&apos;t have
          access.
        </div>
      </section>
    );
  }

  const proposed = data?.proposed ?? [];
  const suppressed = data?.suppressed ?? [];

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Order Proposals</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Advisory orders derived from the latest run of each active measure — a human reviews and submits.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Select
            label="Measure"
            size="sm"
            className="w-52"
            value={measureFilter}
            onValueChange={setMeasureFilter}
            options={measureOptions}
          />
          <Button variant="outline" size="sm" onClick={() => void copyFhirBundle()} disabled={copying || proposed.length === 0}>
            {copying ? "Copying…" : "Copy FHIR Bundle"}
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
        Advisory only — these proposals never auto-submit and never change compliance status. CQL remains the sole
        compliance authority.
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading proposals…</p>
      ) : (
        <>
          <div>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.1em] text-neutral-500 dark:text-neutral-400">
              Proposed ({proposed.length})
            </h3>
            {proposed.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
                No order proposals for the current scope.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-400">
                    <tr>
                      <th className="px-3 py-2">Subject</th>
                      <th className="px-3 py-2">Measure</th>
                      <th className="px-3 py-2">Order</th>
                      <th className="px-3 py-2">Code</th>
                      <th className="px-3 py-2">Reason</th>
                      <th className="px-3 py-2">Priority</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposed.map((o) => (
                      <tr
                        key={o.dedupeKey}
                        className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-800/40"
                      >
                        <td className="px-3 py-2">
                          <Link
                            href={`/employees/${o.subjectId}`}
                            className="font-medium text-primary-700 hover:underline dark:text-primary-400"
                          >
                            {o.subjectId}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{measureLabel(o.measureId)}</td>
                        <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{o.order.display}</td>
                        <td className="px-3 py-2">
                          <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                            {systemLabel(o.order.system)} {o.order.code}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${outcomeStatusClass(o.reasonOutcome)}`}>
                            {labelFor(OUTCOME_LABELS, o.reasonOutcome)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${priorityClass(o.priority)}`}>
                            {o.priority.toLowerCase()}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {suppressed.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.1em] text-neutral-500 dark:text-neutral-400">
                Suppressed ({suppressed.length})
              </h3>
              <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
                At-risk subjects with an existing standing order — no duplicate order is proposed.
              </p>
              <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                <table className="min-w-full text-sm">
                  <tbody>
                    {suppressed.map((o) => (
                      <tr key={o.dedupeKey} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60">
                        <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{o.subjectId}</td>
                        <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{measureLabel(o.measureId)}</td>
                        <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">{o.order.display}</td>
                        <td className="px-3 py-2 text-xs text-neutral-400">standing order on file</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
