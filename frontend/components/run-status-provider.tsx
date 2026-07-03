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
    // Only clear the persisted key if it's still pointing at THIS run. A synchronous run (e.g. an
    // EMPLOYEE "Recalculate") can come back already-terminal while a different, actually-active
    // ALL_PROGRAMS run is the one persisted — clearing unconditionally would wipe that run's reload
    // durability out from under it (Fable M22). The poll path passes `activeRunId`, which IS the
    // stored key, so it still clears correctly.
    if (localStorage.getItem(STORAGE_KEY) === runId) {
      localStorage.removeItem(STORAGE_KEY);
    }
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

  // Read the latest activeRunId without depending on it in the storage-event effect below (that
  // effect subscribes once; a dependency on activeRunId would tear down + resubscribe on every
  // run start/stop, which is unnecessary churn for a single global listener).
  const activeRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);

  // Cross-tab sync (Fable L20): a run started in tab A is otherwise invisible to an already-open
  // tab B until B is reloaded. `localStorage` fires a `storage` event in every OTHER tab (never the
  // tab that made the write) when STORAGE_KEY changes, so use it to adopt a run another tab started —
  // without restarting the poll effect (which depends only on `activeRunId`, set here the same way
  // `startTracking`/the poll do).
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY) return;
      // Adopt a run another tab started (only when this tab has none in flight).
      if (event.newValue && !activeRunIdRef.current) {
        setActiveRunId(event.newValue);
        setStatus("RUNNING");
      }
      // A REMOVAL (another tab finished/cleared the run) is intentionally NOT handled here (Codex P2):
      // if this tab adopted the same run it still owns a live poller, which will observe the terminal
      // status itself and fire its OWN `ww:run-complete` (so pages like /programs refresh their KPIs)
      // plus the completion toast. Tearing the poller down here would drop the banner but leave stale
      // data until a manual reload. If this tab had no active run, there is nothing to clear anyway.
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

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
      } catch (err) {
        // An orphaned run id — 404 (the run was truncated by a demo-reset) or 403 (role changed) — will
        // never resolve, so stop polling and clear it, otherwise the "Run running" pill sticks forever
        // until localStorage is hand-cleared (Fable M21). Other errors are treated as transient.
        const httpStatus = (err as { status?: number })?.status;
        if (httpStatus === 404 || httpStatus === 403) {
          finished = true;
          clearInterval(interval);
          setActiveRunId(null);
          setStatus("IDLE");
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            /* ignore */
          }
        }
        /* else transient — keep going */
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
