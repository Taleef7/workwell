"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { useAuth } from "@/components/auth-provider";
import { canRunMeasures } from "@/lib/rbac";
import { isTerminalRunStatus } from "@/lib/run-status";
import { emitToast } from "@/lib/toast";

/**
 * Global, durable run tracker. A measure run (especially ALL_PROGRAMS) takes minutes; this keeps a
 * single source of truth for "is a run in flight" that survives navigation (the provider lives in the
 * dashboard layout) AND full reloads (the active run id is persisted in localStorage and re-adopted on
 * mount). On completion it fires a `ww:run-complete` window event so any page can refresh its data.
 */
const STORAGE_KEY = "ww_active_run";

type RunStatusValue = {
  activeRunId: string | null;
  status: string;
  isActive: boolean;
  evaluated: number;
  startTracking: (runId: string, initialStatus?: string) => void;
};

const RunStatusContext = createContext<RunStatusValue | null>(null);

function notifyComplete(runId: string, status: string): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("ww:run-complete", { detail: { runId, status } }));
  const upper = (status ?? "").toUpperCase();
  emitToast(
    upper === "COMPLETED" || upper === "PARTIAL_FAILURE" ? "Measure run complete" : `Measure run ${upper.toLowerCase()}`,
  );
}

export function RunStatusProvider({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const { token, user } = useAuth();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [status, setStatus] = useState("IDLE");
  const [evaluated, setEvaluated] = useState(0);

  // Read the latest api client without restarting the poll effect: useApi recreates the client on
  // every token refresh, so depending on `api` in the poll effect would tear down + re-create the
  // interval mid-run and could miss the terminal transition.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const startTracking = useCallback((runId: string, initialStatus = "REQUESTED") => {
    // A synchronous MEASURE/EMPLOYEE/CASE run can come back already terminal — don't persist it as
    // active (the poll would never run to clear it), just fire the completion event so pages refresh.
    if (isTerminalRunStatus(initialStatus)) {
      notifyComplete(runId, initialStatus);
      return;
    }
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
          const runs = await apiRef.current.get<Array<{ runId: string; status: string }>>("/api/runs?limit=5");
          runId = runs.find((r) => !isTerminalRunStatus(r.status))?.runId ?? null;
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
  }, [token, user]);

  // Poll the active run until terminal. Depends ONLY on activeRunId (api is read via apiRef, status
  // is updated without restarting), so a status change or token refresh never tears down the timer.
  // A `finished` latch + an imperative clearInterval guarantee the completion fires exactly once even
  // if a tick is in flight when the run goes terminal.
  useEffect(() => {
    if (!activeRunId) return;
    let finished = false;
    const interval = setInterval(async () => {
      if (finished) return;
      try {
        const run = await apiRef.current.get<{ status: string; totalEvaluated?: number }>(`/api/runs/${activeRunId}`);
        if (finished) return;
        if (typeof run.totalEvaluated === "number") setEvaluated(run.totalEvaluated);
        if (isTerminalRunStatus(run.status)) {
          finished = true;
          clearInterval(interval);
          setActiveRunId(null);
          notifyComplete(activeRunId, run.status);
        } else {
          setStatus(run.status);
        }
      } catch {
        /* transient polling error — keep going */
      }
    }, 4000);
    return () => {
      finished = true;
      clearInterval(interval);
    };
  }, [activeRunId]);

  const value = useMemo<RunStatusValue>(
    () => ({
      activeRunId,
      status,
      isActive: activeRunId !== null,
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
