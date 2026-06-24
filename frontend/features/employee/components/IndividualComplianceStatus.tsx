"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { useAuth } from "@/components/auth-provider";
import { canRunMeasures } from "@/lib/rbac";
import { ComplianceChip } from "@/features/compliance/ComplianceChip";
import { CqlEvidence, type EvidenceJson } from "@/features/evidence/CqlEvidence";
import { PANEL_OPTIONS, type Roster, type RosterCell } from "@/features/compliance/types";

interface Row {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
  cell: RosterCell;
}
interface EvidenceState {
  loading: boolean;
  evidence?: EvidenceJson;
  error?: boolean;
}

/** Single-person mirror of the roster grid: RULE → STATUS → METHOD over every applicable measure across
 *  all panels (one roster call per panel, filtered to this subject). Adds a Recalculate action (sync
 *  EMPLOYEE run) and a per-row Info expander that lazy-loads the CQL evidence. Read-only display of
 *  compliance; recalculation reuses the audited run path; never sets status (ADR-008). */
export function IndividualComplianceStatus({
  externalId,
  onRecalculated,
}: {
  externalId: string;
  onRecalculated?: () => void;
}) {
  const api = useApi();
  const { user } = useAuth();
  const canRecalc = canRunMeasures(user?.role);

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceByOutcome, setEvidenceByOutcome] = useState<Record<string, EvidenceState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ q: externalId, pageSize: "200" });
    const results = await Promise.all(
      PANEL_OPTIONS.map(async (p) => {
        try {
          const { data } = await api.getWithHeaders<Roster>(`/api/compliance/roster?panel=${p.id}&${params.toString()}`);
          return data;
        } catch {
          return null; // one bad panel never blanks the card
        }
      })
    );
    const merged: Row[] = [];
    for (const roster of results) {
      if (!roster) continue;
      const match = roster.rows.find((r) => r.subject.externalId === externalId);
      if (!match) continue;
      for (const col of roster.columns) {
        const cell = match.cells[col.measureId];
        if (!cell) continue;
        merged.push({ measureId: col.measureId, name: col.name, complianceClass: col.complianceClass, cell });
      }
    }
    setRows(merged);
    setLoading(false);
  }, [api, externalId]);

  useEffect(() => {
    // Defer out of the synchronous effect body (matches the compliance page) so load's setState calls
    // don't trip react-hooks/set-state-in-effect.
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const toggle = useCallback(
    async (measureId: string, cell: RosterCell) => {
      const willOpen = !(open[measureId] ?? false);
      setOpen((o) => ({ ...o, [measureId]: willOpen }));
      if (!willOpen || !cell.evidenceRef) return;
      const oid = cell.evidenceRef.outcomeId;
      if (evidenceByOutcome[oid]) return; // already fetched (or fetching)
      setEvidenceByOutcome((m) => ({ ...m, [oid]: { loading: true } }));
      try {
        const res = await api.get<{ evidenceJson: EvidenceJson }>(`/api/outcomes/${encodeURIComponent(oid)}`);
        setEvidenceByOutcome((m) => ({ ...m, [oid]: { loading: false, evidence: res.evidenceJson } }));
      } catch {
        setEvidenceByOutcome((m) => ({ ...m, [oid]: { loading: false, error: true } }));
      }
    },
    [api, open, evidenceByOutcome]
  );

  const recalculate = useCallback(async () => {
    if (!canRecalc) return;
    if (!window.confirm(`Recalculate compliance for ${externalId}? This re-evaluates every active measure for this employee.`)) return;
    setRecalcBusy(true);
    setError(null);
    try {
      await api.post<{ scopeType: string; employeeExternalId: string }, unknown>("/api/runs/manual", {
        scopeType: "EMPLOYEE",
        employeeExternalId: externalId,
      });
      await load();
      onRecalculated?.();
    } catch (e) {
      setError((e as Error).message ?? "Failed to recalculate.");
    } finally {
      setRecalcBusy(false);
    }
  }, [api, canRecalc, externalId, load, onRecalculated]);

  return (
    <section className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Individual Compliance Status</h2>
        {canRecalc ? (
          <button
            type="button"
            onClick={recalculate}
            disabled={recalcBusy}
            className="rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {recalcBusy ? "Recalculating…" : "Recalculate"}
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mb-2 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading compliance…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No evaluated measures for this employee yet.</p>
      ) : (
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-neutral-400">
              <th scope="col" className="py-1 pr-3 font-semibold">Rule</th>
              <th scope="col" className="py-1 pr-3 font-semibold">Status &amp; Method</th>
              <th scope="col" className="py-1 font-semibold"><span className="sr-only">Details</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = open[row.measureId] ?? false;
              const ev = row.cell.evidenceRef ? evidenceByOutcome[row.cell.evidenceRef.outcomeId] : undefined;
              return (
                <React.Fragment key={row.measureId}>
                  <tr className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="py-2 pr-3 align-top">
                      <span className="font-medium">{row.name}</span>
                      <span className="ml-1 text-[10px] uppercase text-neutral-400">{row.complianceClass === "PERMANENT" ? "perm" : "rec"}</span>
                    </td>
                    <td className="py-2 pr-3 align-top"><ComplianceChip cell={row.cell} /></td>
                    <td className="py-2 align-top">
                      <button
                        type="button"
                        aria-label={`Info: ${row.name}`}
                        onClick={() => void toggle(row.measureId, row.cell)}
                        className="rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700"
                      >
                        {isOpen ? "Hide" : "Info"}
                      </button>
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="bg-neutral-50 dark:bg-neutral-900/40">
                      <td colSpan={3} className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-300">
                        <div>Method: {row.cell.method}</div>
                        <div>Compliance class: {row.complianceClass}</div>
                        {row.cell.evidenceRef ? (
                          <div className="mt-2">
                            {!ev || ev.loading ? (
                              <p className="italic text-neutral-400">Loading evidence…</p>
                            ) : ev.error ? (
                              <p className="italic text-neutral-400">Evidence unavailable.</p>
                            ) : (
                              <CqlEvidence evidence={ev.evidence} />
                            )}
                          </div>
                        ) : (
                          <div className="mt-1 italic text-neutral-400">Not evaluated.</div>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
