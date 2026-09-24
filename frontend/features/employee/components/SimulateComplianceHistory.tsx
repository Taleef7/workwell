"use client";

import React, { useState } from "react";
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
  /** Measures this deployment runs that the simulation cannot replay (no test-data recipe for them yet). */
  notSimulated?: Array<{ measureId: string; name: string }>;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Advisory as-of-date compliance simulation (#197). Pick a date and run it to see how this person's
 * compliance would read on that day — per measure, same chip/method vocabulary as the card above.
 * Read-only; the server persists nothing and CQL stays the sole compliance authority.
 *
 * It runs only when asked (#671). It used to evaluate on every page open, for every role — an
 * evaluation nobody requested, costing seconds on each view — and on Maui it covers two of the six
 * measures, so the ones it cannot replay are named rather than silently missing.
 */
export function SimulateComplianceHistory({
  externalId,
  labelFor = (_measureId, fallbackName) => fallbackName,
}: {
  externalId: string;
  labelFor?: (measureId: string, fallbackName: string) => string;
}) {
  const api = useApi();
  const [asOf, setAsOf] = useState<string>(todayIso());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One run at a time: the button is disabled while a run is in flight, so a late answer cannot
  // overwrite a newer one. The page keys this component by patient, so a result never lands on the next
  // patient's page either.
  const runSimulation = async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await api.get<Snapshot>(`/api/employees/${encodeURIComponent(externalId)}/simulate?asOf=${asOf}`));
    } catch (e) {
      setError((e as Error).message ?? "Failed to simulate compliance.");
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  };

  const notSimulated = snapshot?.notSimulated ?? [];

  return (
    <section className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Simulate Compliance History</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Advisory only — a re-evaluation as of the chosen date (the card above shows the last recorded run).
            Never changes status; CQL is the sole authority.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">As of</span>
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            />
          </label>
          <button
            type="button"
            onClick={runSimulation}
            disabled={loading || !asOf}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            {loading ? "Simulating…" : "Run simulation"}
          </button>
        </div>
      </div>

      <div aria-live="polite">
      {error ? (
        <p role="alert" className="mt-3 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      ) : snapshot ? (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] text-neutral-400">Showing compliance as of {snapshot.asOf}</p>
          {snapshot.evaluations.map((ev) => (
            <div key={ev.measureId} className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-4 py-2">
              <div>
                <span className="text-sm font-medium">{labelFor(ev.measureId, ev.name)}</span>
                <span
                  className="ml-1 text-[10px] uppercase text-neutral-400"
                  title={ev.complianceClass === "PERMANENT" ? "Permanent (series-completion)" : "Recurring (windowed)"}
                >
                  {ev.complianceClass === "PERMANENT" ? "perm" : "rec"}
                </span>
              </div>
              <ComplianceChip cell={{ status: ev.status, method: ev.method }} />
            </div>
          ))}
          {snapshot.evaluations.length === 0 && (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">No measures to simulate.</p>
          )}
          {notSimulated.length > 0 && (
            <p data-testid="not-simulated" className="text-xs text-neutral-500 dark:text-neutral-400">
              Not simulated: {notSimulated.map((m) => labelFor(m.measureId, m.name)).join(", ")}. The simulation
              can&apos;t cover these measures yet; their real results are in the table above.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
          {loading ? "Simulating…" : "Choose a date and run the simulation. Nothing is evaluated until you do."}
        </p>
      )}
      </div>
    </section>
  );
}
