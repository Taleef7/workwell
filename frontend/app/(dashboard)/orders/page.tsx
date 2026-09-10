"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Select } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import { useApi } from "@/lib/api/hooks";
import { useAuth } from "@/components/auth-provider";
import { AccessDenied } from "@/components/access-denied";
import { canViewOrders } from "@/lib/rbac";
import { useMeasureIdentities } from "@/lib/measure-identity";
import { OUTCOME_LABELS, labelFor, normalizeEnumValue, outcomeStatusClass } from "@/lib/status";

// Backend contract (#77 E7 — GET /api/orders/proposals?format=domain). With `limit`/`offset` the
// server windows BOTH arrays by the same page and `totals` carries the full counts before windowing.
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
type ProposalsResponse = {
  proposed: ProposedOrder[];
  suppressed: ProposedOrder[];
  totals?: { proposed: number; suppressed: number };
};

// A page of proposals, not the whole set: the pilot's domain view was ~34k items (10.7 MB) rendered
// into the DOM at once. Both arrays share the window, so "page" means the same offset in each.
const PAGE_SIZE = 100;

/**
 * Both arrays share one window, so the page count follows the LARGER total — otherwise suppressed
 * rows past the last proposed page would be unreachable. `totals` falls back to the slice lengths
 * for a backend that has not shipped the field yet.
 */
function pageCount(res: ProposalsResponse | null): number {
  const proposedTotal = res?.totals?.proposed ?? res?.proposed.length ?? 0;
  const suppressedTotal = res?.totals?.suppressed ?? res?.suppressed.length ?? 0;
  return Math.max(1, Math.ceil(Math.max(proposedTotal, suppressedTotal) / PAGE_SIZE));
}

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
  // Measure names + crosswalk identity come from the catalog read (`/api/measures`) the rest of the
  // app labels measures with — not the programs overview, which is the most expensive read on the pilot.
  const { measures, labelFor: measureLabelFor } = useMeasureIdentities();

  const [data, setData] = useState<ProposalsResponse | null>(null);
  const [measureFilter, setMeasureFilter] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const measureNameById = useMemo(() => {
    const map = new Map<string, string>();
    measures.forEach((m) => map.set(m.id, m.name));
    return map;
  }, [measures]);

  // Stale-fetch guard: a slow response for an earlier page/filter must not overwrite a newer one's
  // rows. The id is bumped at load start (as /cases does) AND in the effect cleanup, so a response
  // that lands after the filter changed but before the next timer fires — or after unmount — is dropped.
  const reqIdRef = useRef(0);
  const load = useCallback(async () => {
    // Non-viewers render the access-denied guard regardless of `loading`, so just bail (no setState).
    if (!mayView) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ format: "domain" });
      if (measureFilter) params.set("measureId", measureFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      const res = await api.get<ProposalsResponse>(`/api/orders/proposals?${params.toString()}`);
      if (reqId !== reqIdRef.current) return;
      setData(res);
      // The totals may have shrunk under us (a nightly run, a narrower filter): never show
      // "Page 4 of 2". Clamping triggers one reload of the last real page, which is the point.
      const pages = pageCount(res);
      if (page > pages) setPage(pages);
    } catch (err) {
      if (reqId !== reqIdRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setData(null);
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [api, mayView, measureFilter, page]);

  useEffect(() => {
    // Defer a tick so the synchronous setLoading() inside load() doesn't run in the effect body
    // (matches the loader pattern used by /cases and /programs).
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      reqIdRef.current += 1;
    };
  }, [load]);

  function onMeasureFilterChange(value: string) {
    // A new filter is a new result set, so page 1 — otherwise "Page 4 of 1" and an empty table.
    setMeasureFilter(value);
    setPage(1);
  }

  async function copyFhirBundle() {
    setCopying(true);
    try {
      // The bundle is the WHOLE set for the filter (no window) by design — it is the export.
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
    () => [
      { value: "", label: "All measures" },
      // Proposals derive from the latest run of each ACTIVE measure, so the filter offers those.
      // A row without a status (older fixtures) is kept rather than silently dropped.
      ...measures
        .filter((m) => m.status == null || m.status === "Active")
        .map((m) => ({ value: m.id, label: m.name })),
    ],
    [measures],
  );

  function measureLabel(id: string): string {
    return measureLabelFor(id, measureNameById.get(id) ?? id);
  }

  const proposed = data?.proposed ?? [];
  const suppressed = data?.suppressed ?? [];
  const proposedTotal = data?.totals?.proposed ?? proposed.length;
  const suppressedTotal = data?.totals?.suppressed ?? suppressed.length;
  const totalPages = pageCount(data);

  if (!mayView) {
    return (
      <AccessDenied
        title="Order Proposals"
        message="Order proposals are clinical decision support, managed by Case Managers and Admins — your role doesn’t have access."
      />
    );
  }

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
            onValueChange={onMeasureFilterChange}
            options={measureOptions}
          />
          {/* The bundle is the WHOLE filtered set, so gate on the total — a page with no proposed
              rows (suppressed-only tail) can still copy it. */}
          <Button variant="outline" size="sm" onClick={() => void copyFhirBundle()} disabled={copying || proposedTotal === 0}>
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
              Proposed ({proposedTotal})
            </h3>
            {proposed.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
                {proposedTotal > 0 ? "No proposed orders on this page." : "No order proposals for the current scope."}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-400">
                    <tr>
                      <th scope="col" className="px-3 py-2">Subject</th>
                      <th scope="col" className="px-3 py-2">Measure</th>
                      <th scope="col" className="px-3 py-2">Order</th>
                      <th scope="col" className="px-3 py-2">Code</th>
                      <th scope="col" className="px-3 py-2">Reason</th>
                      <th scope="col" className="px-3 py-2">Priority</th>
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

          {suppressedTotal > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.1em] text-neutral-500 dark:text-neutral-400">
                Suppressed ({suppressedTotal})
              </h3>
              <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
                At-risk subjects with an existing standing order — no duplicate order is proposed.
              </p>
              {suppressed.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
                  No suppressed orders on this page.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                  <table className="min-w-full text-sm">
                    <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-400">
                      <tr>
                        <th scope="col" className="px-3 py-2">Subject</th>
                        <th scope="col" className="px-3 py-2">Measure</th>
                        <th scope="col" className="px-3 py-2">Order</th>
                        <th scope="col" className="px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {suppressed.map((o) => (
                        <tr key={o.dedupeKey} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60">
                          <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{o.subjectId}</td>
                          <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{measureLabel(o.measureId)}</td>
                          <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">{o.order.display}</td>
                          <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">standing order on file</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          <div className="flex items-center justify-between text-sm text-neutral-500 dark:text-neutral-400">
            <span>{PAGE_SIZE} per page</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-50 dark:border-neutral-700"
              >
                Prev
              </button>
              <span>Page {page} of {totalPages}</span>
              <button
                type="button"
                onClick={() => setPage((p) => (p < totalPages ? p + 1 : p))}
                disabled={page >= totalPages}
                className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-50 dark:border-neutral-700"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
