"use client";

/**
 * "Orders that could close this gap" on the case page (#620, B16).
 *
 * Read from `GET /api/orders/cases/:id`, which computes it from the outcome this case cites: an order is
 * offered only when the measure's own CQL found nothing qualifying. Otherwise the panel says why none
 * applies, in the server's words, which never state a value. Advisory: WorkWell orders nothing, and the
 * gap closes only when CQL finds a qualifying result. Shown to the roles that may read `/api/orders/**`
 * (lead, quality staff, admin); the clinician seat never asks for it.
 */
import { useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { CardReadyBadge, CodeChip, type MeasureOrdersView } from "@/components/order-options";

export type CaseOrders = {
  caseId: string;
  measureId: string;
  applies: boolean;
  reason?: string;
  orders: MeasureOrdersView | null;
};

export function CaseOrdersView({ data }: { data: CaseOrders }) {
  // A measure with no order defined: nothing to say beyond the next action.
  if (!data.orders) return null;
  const { mode, options, caveat } = data.orders;
  return (
    <div data-testid="case-orders" className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">Orders that could close this gap</p>
      {!data.applies ? (
        <p data-testid="case-orders-why-not" className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
          {data.reason ?? "No order applies to this gap."}
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
            {mode === "choice" ? "The clinician chooses one of these; WorkWell sets no default." : "The order for this measure:"}
          </p>
          <ul className="mt-2 space-y-2">
            {options.map((o) => (
              <li key={o.key} className="flex flex-wrap items-center gap-2 text-sm text-neutral-800 dark:text-neutral-200">
                <span className="font-medium">{o.display}</span>
                <CodeChip system={o.system} code={o.code} />
                <CardReadyBadge option={o} />
                {o.audience || o.interval || o.note ? (
                  <span className="w-full text-xs text-neutral-500 dark:text-neutral-400">
                    Catalog note: {[o.audience, o.interval, o.note].filter(Boolean).join("; ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {caveat ? <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">{caveat}</p> : null}
        </>
      )}
      <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
        Advisory. WorkWell orders nothing; the gap closes only when CQL finds a qualifying result.
      </p>
    </div>
  );
}

export function CaseOrdersPanel({ caseId }: { caseId: string }) {
  const api = useApi();
  const [data, setData] = useState<CaseOrders | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<CaseOrders>(`/api/orders/cases/${encodeURIComponent(caseId)}`)
      .then((d) => {
        if (live) setData(d);
      })
      // A failure leaves the panel out: the next action above still says what to do.
      .catch(() => {
        if (live) setData(null);
      });
    return () => {
      live = false;
    };
  }, [api, caseId]);
  return data ? <CaseOrdersView data={data} /> : null;
}
