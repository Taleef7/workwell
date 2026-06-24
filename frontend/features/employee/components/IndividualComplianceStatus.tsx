"use client";

import React, { useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { ComplianceChip } from "@/features/compliance/ComplianceChip";
import { PANEL_OPTIONS, type Roster, type RosterCell } from "@/features/compliance/types";

interface Row {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
  cell: RosterCell;
}

/** Single-person mirror of the roster grid: RULE → STATUS → METHOD over every applicable measure across
 *  all panels. Consumes GET /api/compliance/roster (one call per panel, filtered to this subject) so the
 *  E10.5 vocabulary stays single-source. Read-only; advisory; never sets status (ADR-008). */
export function IndividualComplianceStatus({ externalId }: { externalId: string }) {
  const api = useApi();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // `q` is a substring match on name|externalId server-side; we exact-match the row below. Use a
      // large pageSize (server cap) so the target subject can never be paged out of the match window
      // even if the directory grows or another subject's name contains this id.
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
      if (cancelled) return;
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
    })();
    return () => { cancelled = true; };
  }, [api, externalId]);

  return (
    <section className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
      <h2 className="mb-3 text-base font-semibold">Individual Compliance Status</h2>
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
                        onClick={() => setOpen((o) => ({ ...o, [row.measureId]: !isOpen }))}
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
                        {row.cell.evidenceRef ? <div>Source run: {row.cell.evidenceRef.runId}</div> : null}
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
