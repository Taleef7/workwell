"use client";

/**
 * Admin → Order codes (#640, owner decision 2026-11-04): an admin approves each order code.
 *
 * A code becomes a card suggestion only once it is APPROVED. Every code starts PROPOSED; an admin approves,
 * rejects, revokes or re-approves it here, with an optional note, and each decision is audited with who
 * and when. A clinic's own code for a national code is reviewed the same way (one approved clinic code per
 * national code). LOCAL options are listed for staff and never offered on a card, so they have no action.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle, Textarea } from "@mieweb/ui";
import { useApi } from "@/lib/api/hooks";
import { emitToast } from "@/lib/toast";
import { CodeChip } from "@/components/order-options";

type Mapping = {
  id: string;
  localCode: string;
  localSystem: string;
  localDisplay: string | null;
  standardCode: string;
  standardSystem: string;
  mappingStatus: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
};

export type OrderCodeRow = {
  measureId: string;
  mode: "protocol" | "choice";
  key: string;
  system: string;
  code: string;
  display: string;
  interval: string | null;
  audience: string | null;
  note: string | null;
  suggestible: boolean;
  status: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  mappings: Mapping[];
};

type Pending =
  | { kind: "code"; row: OrderCodeRow; decision: "APPROVE" | "REJECT" }
  | { kind: "mapping"; mapping: Mapping; decision: "APPROVE" | "REJECT" };

const statusClass = (status: string) =>
  status === "APPROVED"
    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
    : status === "REJECTED"
      ? "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300"
      : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";

const isClinicRow = (m: Mapping) => !(m.localSystem === m.standardSystem && m.localCode === m.standardCode);

function reviewedLine(by: string | null, at: string | null): string | null {
  if (!by || !at) return null;
  return `${by}, ${new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

export function OrderCodesAdmin({ measureLabel }: { measureLabel?: (measureId: string) => string }) {
  const api = useApi();
  const [codes, setCodes] = useState<OrderCodeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ codes: OrderCodeRow[] }>("/api/admin/order-codes");
      setCodes(res.codes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the order codes");
    }
  }, [api]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const byMeasure = useMemo(() => {
    const groups = new Map<string, OrderCodeRow[]>();
    for (const c of codes ?? []) (groups.get(c.measureId) ?? groups.set(c.measureId, []).get(c.measureId)!).push(c);
    return [...groups.entries()];
  }, [codes]);

  async function confirm() {
    if (!pending) return;
    setSaving(true);
    try {
      if (pending.kind === "code") {
        await api.post("/api/admin/order-codes/review", {
          system: pending.row.system,
          code: pending.row.code,
          decision: pending.decision,
          note: note.trim() || null,
        });
      } else {
        await api.post(`/api/admin/terminology-mappings/${encodeURIComponent(pending.mapping.id)}/review`, {
          decision: pending.decision,
          note: note.trim() || null,
        });
      }
      emitToast(pending.decision === "APPROVE" ? "Approved" : "Rejected");
      setPending(null);
      setNote("");
      await load();
    } catch (err) {
      emitToast(err instanceof Error ? err.message : "The review was not saved");
    } finally {
      setSaving(false);
    }
  }

  const title = pending
    ? pending.kind === "code"
      ? `${pending.decision === "APPROVE" ? "Approve" : pending.row.status === "APPROVED" ? "Revoke" : "Reject"} ${pending.row.display}`
      : `${pending.decision === "APPROVE" ? "Approve" : "Reject"} clinic code ${pending.mapping.localCode}`
    : "";
  const description = pending
    ? pending.decision === "APPROVE"
      ? "Cards may then offer this code as a proposed order where the measure's gap is open and CQL found nothing qualifying. A clinician still accepts or declines it; the gap closes only when CQL finds the result."
      : "Cards stop offering this code. Every approved mapping for it is rejected."
    : "";

  return (
    <article data-testid="order-codes-admin" className="rounded-3xl border border-neutral-200 bg-white p-4 shadow-sm sm:p-6 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">order governance</p>
          <h3 className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Order codes</h3>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            The orders each measure can propose. A code is offered on a card only once an admin approves it; every
            decision is recorded with who and when.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {error ? <p className="mt-4 text-sm text-red-700 dark:text-red-300">{error}</p> : null}
      {codes && codes.length === 0 ? <p className="mt-4 text-sm text-neutral-500">No order codes for the measures this deployment runs.</p> : null}

      <div className="mt-4 space-y-4">
        {byMeasure.map(([measureId, rows]) => (
          <div key={measureId} className="rounded-2xl border border-neutral-200 p-3 dark:border-neutral-800">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {measureLabel ? measureLabel(measureId) : measureId}{" "}
              <span className="text-xs font-normal text-neutral-500">
                {rows[0]!.mode === "choice" ? "Clinician chooses" : "One order"}
              </span>
            </p>
            <ul className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-800">
              {rows.map((r) => {
                const reviewed = reviewedLine(r.reviewedBy, r.reviewedAt);
                const clinicRows = r.mappings.filter(isClinicRow);
                return (
                  <li key={r.key} className="py-2" data-testid={`order-code-${r.code}`}>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-neutral-800 dark:text-neutral-200">{r.display}</span>
                      <CodeChip system={r.system} code={r.code} />
                      {r.suggestible ? (
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClass(r.status)}`}>{r.status}</span>
                      ) : (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                          Listed only, never on a card
                        </span>
                      )}
                      {r.suggestible ? (
                        <span className="ml-auto flex gap-2">
                          {r.status !== "APPROVED" ? (
                            <Button type="button" size="sm" variant="primary" onClick={() => setPending({ kind: "code", row: r, decision: "APPROVE" })}>
                              {r.status === "REJECTED" ? "Re-approve" : "Approve"}
                            </Button>
                          ) : null}
                          {r.status !== "REJECTED" ? (
                            <Button type="button" size="sm" variant="outline" onClick={() => setPending({ kind: "code", row: r, decision: "REJECT" })}>
                              {r.status === "APPROVED" ? "Revoke" : "Reject"}
                            </Button>
                          ) : null}
                        </span>
                      ) : null}
                    </div>
                    {[r.audience, r.interval, r.note].some(Boolean) ? (
                      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                        Catalog note: {[r.audience, r.interval, r.note].filter(Boolean).join("; ")}
                      </p>
                    ) : null}
                    {reviewed ? <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Reviewed by {reviewed}</p> : null}
                    {clinicRows.length > 0 ? (
                      <ul className="mt-2 space-y-1 pl-4">
                        {clinicRows.map((m) => (
                          <li key={m.id} className="flex flex-wrap items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300">
                            <span>Clinic code</span>
                            <span className="font-mono">{m.localCode}</span>
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClass(m.mappingStatus)}`}>{m.mappingStatus}</span>
                            {m.mappingStatus !== "APPROVED" ? (
                              <Button type="button" size="sm" variant="outline" onClick={() => setPending({ kind: "mapping", mapping: m, decision: "APPROVE" })}>
                                Approve
                              </Button>
                            ) : null}
                            {m.mappingStatus !== "REJECTED" ? (
                              <Button type="button" size="sm" variant="outline" onClick={() => setPending({ kind: "mapping", mapping: m, decision: "REJECT" })}>
                                Reject
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <Modal open={pending !== null} onOpenChange={(open) => { if (!open) { setPending(null); setNote(""); } }} size="md">
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">{description}</p>
          <Textarea label="Note (optional)" className="mt-3 min-h-20" value={note} onChange={(e) => setNote(e.target.value)} />
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" onClick={() => { setPending(null); setNote(""); }}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={() => void confirm()} isLoading={saving} loadingText="Saving...">
            Confirm
          </Button>
        </ModalFooter>
      </Modal>
    </article>
  );
}
