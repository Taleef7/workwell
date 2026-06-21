"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { useAuth } from "@/components/auth-provider";
import { canRunMeasures } from "@/lib/rbac";
import { emitToast } from "@/lib/toast";

/**
 * Global, durable run tracker. A measure run (especially ALL_PROGRAMS) takes minutes; this keeps a
 * single source of truth for "is a run in flight" that survives navigation (the provider lives in the
 * dashboard layout) AND full reloads (the active run id is persisted in localStorage and re-adopted on
 * mount). On completion it fires a `ww:run-complete` window event so any page can refresh its data.
 */
const STORAGE_KEY = "ww_active_run";
const TERMINAL = new Set(["COMPLETED", "FAILED", "PARTIAL_FAILURE", "CANCELLED"]);

type RunStatusValue = {
  activeRunId: string | null;
  status: string;
  isActive: boolean;
  evaluated: number;
  startTracking: (runId: string, initialStatus?: string) => void;
};

const RunStatusContext = createContext<RunStatusValue | null>(null);

export function RunStatusProvider({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const { token, user } = useAuth();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [status, setStatus] = useState("IDLE");
  const [evaluated, setEvaluated] = useState(0);

  const startTracking = useCallback((runId: string, initialStatus = "REQUESTED") => {
    setEvaluated(0);
    setStatus(initialStatus);
    setActiveRunId(runId);
    try {
      localStorage.setItem(STORAGE_KEY, runId);
    } catch {
      /* ignore */
    }
  }, []);

  // Adopt a persisted (reload) or already-in-flight (started elsewhere) run on mount.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      let runId: string | null = null;
      try {
        runId = localStorage.getItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      if (!runId && canRunMeasures(user?.role)) {
        try {
          const runs = await api.get<Array<{ runId: string; status: string }>>("/api/runs?limit=5");
          runId = runs.find((r) => !TERMINAL.has((r.status ?? "").toUpperCase()))?.runId ?? null;
        } catch {
          /* ignore */
        }
      }
      if (runId && !cancelled) {
        setActiveRunId(runId);
        setStatus("RUNNING");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, token, user]);

  // Poll the active run until it reaches a terminal state.
  useEffect(() => {
    if (!activeRunId || TERMINAL.has(status.toUpperCase())) return;
    const interval = setInterval(async () => {
      try {
        const run = await api.get<{ status: string; totalEvaluated?: number }>(`/api/runs/${activeRunId}`);
        setStatus(run.status);
        if (typeof run.totalEvaluated === "number") setEvaluated(run.totalEvaluated);
        if (TERMINAL.has((run.status ?? "").toUpperCase())) {
          const completedId = activeRunId;
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            /* ignore */
          }
          setActiveRunId(null);
          window.dispatchEvent(new CustomEvent("ww:run-complete", { detail: { runId: completedId, status: run.status } }));
          const upper = (run.status ?? "").toUpperCase();
          emitToast(
            upper === "COMPLETED" || upper === "PARTIAL_FAILURE"
              ? "Measure run complete"
              : `Measure run ${upper.toLowerCase()}`,
          );
        }
      } catch {
        /* transient polling error — keep going */
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [activeRunId, status, api]);

  const value = useMemo<RunStatusValue>(
    () => ({
      activeRunId,
      status,
      isActive: !!activeRunId && !TERMINAL.has(status.toUpperCase()),
      evaluated,
      startTracking,
    }),
    [activeRunId, status, evaluated, startTracking],
  );

  return <RunStatusContext.Provider value={value}>{children}</RunStatusContext.Provider>;
}

export function useRunStatus(): RunStatusValue {
  const ctx = useContext(RunStatusContext);
  if (!ctx) {
    throw new Error("useRunStatus must be used within RunStatusProvider");
  }
  return ctx;
}
