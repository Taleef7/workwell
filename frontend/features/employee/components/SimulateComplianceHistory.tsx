"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { ComplianceChip } from "@/features/compliance/ComplianceChip";
import type { DisplayState } from "@/features/compliance/types";

interface SnapshotEvaluation {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
  status: DisplayState;
  method: string;
}
interface Snapshot {
  externalId: string;
  asOf: string;
  evaluations: SnapshotEvaluation[];
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** Advisory as-of-date compliance simulation (#197). Scrub the date to see how this employee's
 *  compliance would read on that day — per measure, same chip/method vocabulary as the card. Read-only;
 *  the server persists nothing and CQL stays the sole compliance authority (ADR-008/ADR-012). */
export function SimulateComplianceHistory({ externalId }: { externalId: string }) {
  const api = useApi();
  const [asOf, setAsOf] = useState<string>(todayIso());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (date: string) => {
      setLoading(true);
      setError(null);
      try {
        setSnapshot(await api.get<Snapshot>(`/api/employees/${encodeURIComponent(externalId)}/simulate?asOf=${date}`));
      } catch (e) {
        setError((e as Error).message ?? "Failed to simulate compliance.");
        setSnapshot(null);
      } finally {
        setLoading(false);
      }
    },
    [api, externalId]
  );

  // Debounced fetch when the date changes (also fires on mount). The setState lives in `load` (called
  // from the timer callback), not synchronously in the effect body, so it doesn't trip set-state-in-effect.
  useEffect(() => {
    const t = setTimeout(() => void load(asOf), 300);
    return () => clearTimeout(t);
  }, [load, asOf]);

  return (
    <section className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Simulate Compliance History</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Advisory only — re-evaluates compliance as of the chosen date. Never changes status; CQL is the sole authority.
          </p>
        </div>
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">As of</span>
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
        </label>
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      ) : loading && !snapshot ? (
        <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">Simulating…</p>
      ) : snapshot && snapshot.evaluations.length > 0 ? (
        <div className="mt-3 space-y-2">
          {snapshot.evaluations.map((ev) => (
            <div key={ev.measureId} className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-4 py-2">
              <div>
                <span className="text-sm font-medium">{ev.name}</span>
                <span className="ml-1 text-[10px] uppercase text-neutral-400">{ev.complianceClass === "PERMANENT" ? "perm" : "rec"}</span>
              </div>
              <ComplianceChip cell={{ status: ev.status, method: ev.method }} />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">No measures to simulate.</p>
      )}
    </section>
  );
}
