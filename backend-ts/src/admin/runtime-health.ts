/**
 * Runtime health: which build is answering, since when, and whether the event loop has stalled — and
 * on which request (#663, #625).
 *
 * On 2026-09-22 the pilot's API stopped answering twice for about half an hour each. Both times TCP and
 * TLS completed and nothing came back, `/health` included: a live process whose event loop was blocked.
 * One was traced to a request doing population-sized CPU work (#664); the other was never explained,
 * because the recreate that ended it took the only logs with it and nothing had recorded what was
 * running. This module is the record that was missing.
 *
 * Three instruments, each for a case the others cannot see:
 *   1. An in-flight REQUEST REGISTRY, so a stall can be attributed rather than merely observed.
 *   2. A main-thread HEARTBEAT that notices, once a stall ends, how long it lasted and what was running
 *      — logged as `WORKWELL_ALERT {"kind":"EVENT_LOOP_STALL",…}` and kept for the admin view.
 *   3. A WATCHDOG on a worker thread, the only thing that can speak WHILE the main thread is stuck: it
 *      watches a shared heartbeat and writes `EVENT_LOOP_STALL_ONGOING` straight to fd 2 (a worker's
 *      `console` is relayed through the blocked main thread, so it would say nothing). That line is in
 *      the container log before anyone decides to recreate the container.
 *
 * WHAT IS PUBLIC. `/health` is unauthenticated, so it carries counts and timings only. Request paths —
 * even masked — go to the operator log and to the ADMIN-gated `/api/admin/runtime`, never to `/health`:
 * a route like `/api/v1/compliance/{subject}/{measure}` pairs an identifier with health context, and in
 * the PHI phase that identifier is a real patient's.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { sharedFqmPoolSize } from "../wiring/fqm-worker.ts";

/** When this process started serving code (module load ≈ boot). */
export const PROCESS_STARTED_AT = new Date().toISOString();

/** The commit this image was built from, baked in at build time; null on a dev machine or a test. */
export function buildSha(): string | null {
  const sha = process.env.WORKWELL_BUILD_SHA?.trim();
  return sha ? sha : null;
}

// ── 1. In-flight request registry ──────────────────────────────────────────────────────────────────

export interface InFlightRequest {
  method: string;
  path: string;
  startedAt: number; // epoch ms
}

/** A request as a stall report lists it. `settled` = it finished during the stall (see recordStall). */
export interface StallCandidate {
  method: string;
  path: string;
  runningMs: number;
  settled?: true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path segments that carry digits and are route vocabulary, not identifiers. */
const LITERAL_WITH_DIGITS = /^(v\d+|cms\d+)$/i;

/**
 * The path as it may be logged: no query string (filters and search terms carry names), and every
 * segment that could be an identifier replaced by `:id` — a UUID, anything containing a digit (a patient
 * external id `pat-00082`, a provider id, a list id) other than route vocabulary like `v1` and `cms125`,
 * and anything with an `@`. The route shape and the measure are what attribute a stall; WHICH subject it
 * was is not needed for that and does not belong in a log line.
 */
export function loggablePath(url: string): string {
  let path: string;
  try {
    path = new URL(url, "http://x").pathname;
  } catch {
    path = url.split("?")[0] ?? url;
  }
  return path
    .split("/")
    .map((seg) => {
      if (seg === "") return seg;
      let s = seg;
      try {
        s = decodeURIComponent(seg);
      } catch {
        /* keep the raw segment */
      }
      if (UUID.test(s) || s.includes("@") || (/\d/.test(s) && !LITERAL_WITH_DIGITS.test(s))) return ":id";
      return seg;
    })
    .join("/");
}

let nextRequestId = 1;
const inFlight = new Map<number, InFlightRequest>();
let watchdog: Worker | null = null;

/**
 * Bounded. A request settles when its body is read or cancelled, or its client disconnects; a path none
 * of those reaches would otherwise grow the map forever. Evicting the OLDEST is safe for attribution:
 * reports rank by how long a request has been running, and an entry that old is already suspect.
 */
const MAX_IN_FLIGHT = 1000;

/**
 * Requests that finished recently, kept because a CPU stall's culprit usually finishes AT the end of the
 * stall: the handler returns the moment its synchronous work is done, the host writes the small body in
 * microtasks, and the request settles before the overdue heartbeat timer runs. Without this, the stall
 * record would name everything except the request that caused it (#663 review).
 */
const recentlySettled: Array<InFlightRequest & { settledAt: number }> = [];
const MAX_RECENTLY_SETTLED = 200;

/** A stall report lists at most this many requests — the longest-running. */
export const MAX_REPORTED_REQUESTS = 20;

/** Register a request as in flight. The returned settle function is idempotent. */
export function trackRequest(method: string, url: string, now: number = Date.now()): (at?: number) => void {
  const id = nextRequestId++;
  const entry: InFlightRequest = { method, path: loggablePath(url), startedAt: now };
  if (inFlight.size >= MAX_IN_FLIGHT) {
    const oldest = inFlight.keys().next().value;
    if (oldest !== undefined) {
      inFlight.delete(oldest);
      watchdog?.postMessage({ type: "end", id: oldest });
    }
  }
  inFlight.set(id, entry);
  watchdog?.postMessage({ type: "start", id, ...entry });
  let settled = false;
  return (at: number = Date.now()) => {
    if (settled) return;
    settled = true;
    if (!inFlight.delete(id)) return; // evicted
    recentlySettled.push({ ...entry, settledAt: at });
    if (recentlySettled.length > MAX_RECENTLY_SETTLED) recentlySettled.shift();
    watchdog?.postMessage({ type: "end", id });
  };
}

/** The requests in flight, oldest first, with how long each has been running at `now`. */
export function inFlightRequests(now: number = Date.now()): Array<InFlightRequest & { runningMs: number }> {
  return [...inFlight.values()].sort((a, b) => a.startedAt - b.startedAt).map((r) => ({ ...r, runningMs: now - r.startedAt }));
}

/**
 * Every request that was running at some point during `[now - durationMs, now]` — still in flight, or
 * settled inside the window — longest-running first, capped. Longest first because a CPU stall's cause
 * is usually the request that has been running longest, and a page fanning out many concurrent reads
 * would otherwise push it past the cap.
 */
export function stallCandidates(now: number, durationMs: number): { total: number; requests: StallCandidate[] } {
  const windowStart = now - durationMs;
  const all: StallCandidate[] = [
    ...[...inFlight.values()].map((r) => ({ method: r.method, path: r.path, runningMs: now - r.startedAt })),
    ...recentlySettled
      .filter((r) => r.settledAt >= windowStart)
      .map((r) => ({ method: r.method, path: r.path, runningMs: r.settledAt - r.startedAt, settled: true as const })),
  ];
  all.sort((a, b) => b.runningMs - a.runningMs);
  return { total: all.length, requests: all.slice(0, MAX_REPORTED_REQUESTS) };
}

// ── 2. Main-thread heartbeat: stalls, measured after they end ─────────────────────────────────────

export interface StallRecord {
  endedAt: string;
  durationMs: number;
  /** How many requests were running during the stall; `requests` is the longest-running of them. */
  requestsInvolved: number;
  requests: StallCandidate[];
}

export const STALL_THRESHOLD_MS = 1000;
const HEARTBEAT_MS = 250;
const MAX_STALL_RECORDS = 20;
/**
 * At most one after-the-fact alert line per minute. The nightly recompute blocks the loop for seconds
 * at a time, and `WORKWELL_ALERT` is the prefix an operator greps for incidents: an unthrottled line per
 * stall would bury the one that matters. Every stall is still counted and kept; the next line says how
 * many were not logged. The watchdog's ONGOING line — the one that matters most — is not throttled here.
 */
const ALERT_EVERY_MS = 60_000;

const stalls: StallRecord[] = [];
let stallCount = 0;
let lastAlertAt = 0;
let suppressedAlerts = 0;

/**
 * A stall is a heartbeat that fired late by more than the threshold: the gap between when it was due
 * and when it ran is time the event loop could not run anything. Pure, so the rule is testable without
 * blocking a thread.
 */
export function stallDurationMs(dueAt: number, ranAt: number, thresholdMs = STALL_THRESHOLD_MS): number | null {
  const late = ranAt - dueAt;
  return late > thresholdMs ? late : null;
}

/** Record a stall that just ended. Exported for tests; the heartbeat is the production caller. */
export function recordStall(durationMs: number, now: number = Date.now()): StallRecord {
  const { total, requests } = stallCandidates(now, durationMs);
  const record: StallRecord = { endedAt: new Date(now).toISOString(), durationMs, requestsInvolved: total, requests };
  stalls.push(record);
  if (stalls.length > MAX_STALL_RECORDS) stalls.shift();
  stallCount++;
  if (now - lastAlertAt >= ALERT_EVERY_MS) {
    console.error(`WORKWELL_ALERT ${JSON.stringify({ kind: "EVENT_LOOP_STALL", ...record, notLoggedSinceLastAlert: suppressedAlerts })}`);
    lastAlertAt = now;
    suppressedAlerts = 0;
  } else {
    suppressedAlerts++;
  }
  return record;
}

// ── 3. Worker-thread watchdog: speaks while the main thread cannot ────────────────────────────────

/** How long the main thread must be silent before the watchdog reports an ongoing stall. */
export const WATCHDOG_REPORT_AFTER_MS = 5000;

// Plain JavaScript run with `eval: true`, so it needs no loader and no build step. It keeps its own copy
// of the in-flight registry from the start/end messages, which arrive on ITS event loop even while the
// main thread is stuck, and writes with `fs.writeSync(2, …)` because a worker's console output is relayed
// through the main thread.
//
// LIFETIME: the interval below is unref'd, so the `parentPort` message listener is what keeps this
// thread alive. Removing that listener makes the watchdog exit silently at startup.
const WATCHDOG_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const beat = new BigInt64Array(workerData.heartbeat);
const inFlight = new Map();
let lastReportedAt = 0;
let lastEvidenceAt = 0;
let evidenceFailed = false;
parentPort.on("message", (m) => {
  if (m.type === "start") inFlight.set(m.id, { method: m.method, path: m.path, startedAt: m.startedAt });
  else if (m.type === "end") inFlight.delete(m.id);
});
const reportAt = (now, silentMs) => {
  const all = [...inFlight.values()]
    .map((r) => ({ method: r.method, path: r.path, runningMs: now - r.startedAt }))
    .sort((a, b) => b.runningMs - a.runningMs);
  return {
    kind: "EVENT_LOOP_STALL_ONGOING",
    stalledForMs: silentMs,
    at: new Date(now).toISOString(),
    requestsInFlight: all.length,
    requests: all.slice(0, workerData.maxReported),
  };
};
// #663: past evidenceAfterMs the report also goes to a FILE on the container's disk, which a restart keeps
// and a recreate does not. On its OWN schedule, not the log line's throttle, so it is on disk from the
// threshold on rather than up to repeatEveryMs later. Written to a temporary name and renamed, so a
// process killed mid-write never leaves half a report. The heartbeat is read again around the rename: if
// the main thread recovered meanwhile (it deletes the file when a stall ends), a report renamed into
// place after that delete would describe a stall that ended, so it is withdrawn.
const writeEvidence = (report, beatSeen) => {
  const p = workerData.evidencePath;
  const recovered = () => Atomics.load(beat, 0) !== beatSeen;
  try {
    const path = require("node:path");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const evidence = { ...report, build: workerData.build, processStartedAt: workerData.processStartedAt, rssMb: Math.round(process.memoryUsage().rss / 1048576) };
    fs.writeFileSync(p + ".tmp", JSON.stringify(evidence));
    if (recovered()) { fs.rmSync(p + ".tmp", { force: true }); return; }
    fs.renameSync(p + ".tmp", p);
    if (recovered()) fs.rmSync(p, { force: true });
  } catch (err) {
    // Said once per stall, on the log the recreate would delete anyway, because the durable copy is the
    // whole point: a silently failing write would look exactly like a stall that left nothing.
    if (!evidenceFailed) {
      evidenceFailed = true;
      const failure = { kind: "STALL_EVIDENCE_WRITE_FAILED", path: p, error: String((err && err.message) || err) };
      try { fs.writeSync(2, "WORKWELL_ALERT " + JSON.stringify(failure) + "\\n"); } catch {}
      parentPort.postMessage(failure);
    }
  }
};
setInterval(() => {
  const now = Date.now();
  const beatSeen = Atomics.load(beat, 0);
  const silentMs = now - Number(beatSeen);
  if (silentMs < workerData.reportAfterMs) { lastReportedAt = 0; lastEvidenceAt = 0; evidenceFailed = false; return; }
  let report = null;
  if (!lastReportedAt || now - lastReportedAt >= workerData.repeatEveryMs) {
    lastReportedAt = now;
    report = reportAt(now, silentMs);
    try { fs.writeSync(2, "WORKWELL_ALERT " + JSON.stringify(report) + "\\n"); } catch {}
    parentPort.postMessage(report);
  }
  if (workerData.evidencePath && silentMs >= workerData.evidenceAfterMs && (!lastEvidenceAt || now - lastEvidenceAt >= workerData.evidenceEveryMs)) {
    lastEvidenceAt = now;
    writeEvidence(report || reportAt(now, silentMs), beatSeen);
  }
}, workerData.checkEveryMs).unref();
`;

export interface MonitorOptions {
  thresholdMs?: number;
  heartbeatMs?: number;
  watchdogReportAfterMs?: number;
  watchdogCheckEveryMs?: number;
  watchdogRepeatEveryMs?: number;
  /** Receives each ongoing-stall report the watchdog makes (tests; production logs to fd 2). */
  onWatchdogReport?: (report: unknown) => void;
  /**
   * Where a long stall's report is kept on disk (#663). Absent means none is written or read.
   * `server.ts` passes it, so a test that starts the monitor touches no file unless it asks to.
   */
  stallEvidencePath?: string | null;
  /** How long a stall must last before its report goes to disk. */
  stallEvidenceAfterMs?: number;
  /** How often the on-disk report is refreshed while the stall lasts. */
  stallEvidenceEveryMs?: number;
}

/** A stall long enough to put its report on disk: past anything the sandbox does legitimately (1.7 s). */
export const STALL_EVIDENCE_AFTER_MS = 30_000;

/**
 * The report the previous process left on disk: it was still stalled when it stopped, so it was
 * restarted or killed mid-stall (#663). The 2026-09-22 hang left nothing, because the heal deleted the
 * container and its logs; a restart keeps this file, and the next boot reads it here.
 */
export interface PreviousStall {
  kind: string;
  at: string;
  stalledForMs: number;
  requestsInFlight: number;
  requests: StallCandidate[];
  build?: string | null;
  processStartedAt?: string;
  rssMb?: number;
}
let previousStall: PreviousStall | null = null;

/** Read, keep and set aside the report a stalled previous process left; null when there is none. */
export function takePreviousStall(path: string): PreviousStall | null {
  if (!existsSync(path)) return null;
  let found: PreviousStall | null = null;
  try {
    found = JSON.parse(readFileSync(path, "utf8")) as PreviousStall;
  } catch (err) {
    console.error(`[workwell] a stall report was left at ${path} but could not be read`, err);
  }
  try {
    renameSync(path, `${path}.previous`); // read once: the next clean boot must not report it again
  } catch {
    /* best-effort */
  }
  if (found) {
    const summary = { kind: "PREVIOUS_PROCESS_STALLED", at: found.at, stalledForMs: found.stalledForMs, requestsInFlight: found.requestsInFlight, build: found.build ?? null };
    console.error(`WORKWELL_ALERT ${JSON.stringify(summary)}`);
  }
  return found;
}

let histogram: IntervalHistogram | null = null;
let lastWindow: { p99Ms: number; maxMs: number } | null = null;
let timers: NodeJS.Timeout[] = [];
let watchdogRunning = false;

/**
 * Start the heartbeat, the delay histogram and the watchdog. Called once by the production host
 * (`server.ts`), never by the request path, so a test that imports the worker starts no threads.
 * Returns a stop function. A watchdog that cannot start or that dies degrades to heartbeat-only and
 * says so; a diagnostic must never take down the process it watches.
 */
export function startRuntimeMonitor(opts: MonitorOptions = {}): () => Promise<void> {
  const thresholdMs = opts.thresholdMs ?? STALL_THRESHOLD_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const evidencePath = opts.stallEvidencePath ?? null;
  if (evidencePath) previousStall = takePreviousStall(evidencePath);

  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  // One-minute windows: the figure served means something bounded rather than "since boot", which a
  // single old stall would dominate forever.
  const windowTimer = setInterval(() => {
    if (!histogram) return;
    lastWindow = { p99Ms: Math.round(histogram.percentile(99) / 1e6), maxMs: Math.round(histogram.max / 1e6) };
    histogram.reset();
  }, 60_000);
  windowTimer.unref();

  const heartbeat = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(heartbeat);
  Atomics.store(beat, 0, BigInt(Date.now()));

  let dueAt = Date.now() + heartbeatMs;
  const beatTimer = setInterval(() => {
    const ranAt = Date.now();
    Atomics.store(beat, 0, BigInt(ranAt));
    const stalled = stallDurationMs(dueAt, ranAt, thresholdMs);
    if (stalled !== null) {
      recordStall(stalled, ranAt);
      // The stall ended on its own, so any report the watchdog put on disk describes a process that
      // recovered. Only a process that never got here leaves one for the next boot.
      if (evidencePath) {
        try {
          rmSync(evidencePath, { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
    dueAt = ranAt + heartbeatMs;
  }, heartbeatMs);
  beatTimer.unref();
  timers = [windowTimer, beatTimer];

  try {
    const w = new Worker(WATCHDOG_SOURCE, {
      eval: true,
      workerData: {
        heartbeat,
        reportAfterMs: opts.watchdogReportAfterMs ?? WATCHDOG_REPORT_AFTER_MS,
        checkEveryMs: opts.watchdogCheckEveryMs ?? 1000,
        repeatEveryMs: opts.watchdogRepeatEveryMs ?? 30_000,
        maxReported: MAX_REPORTED_REQUESTS,
        evidencePath,
        evidenceAfterMs: opts.stallEvidenceAfterMs ?? STALL_EVIDENCE_AFTER_MS,
        evidenceEveryMs: opts.stallEvidenceEveryMs ?? 5_000,
        build: buildSha(),
        processStartedAt: PROCESS_STARTED_AT,
      },
    });
    w.unref();
    // Without an 'error' listener a worker failure (thread limits, OOM) is an uncaught exception in the
    // PARENT, and the API process exits. Log and degrade instead.
    w.on("error", (err) => {
      console.error("[workwell] stall watchdog failed; continuing with the heartbeat only", err);
      if (watchdog === w) watchdog = null;
      watchdogRunning = false;
    });
    w.on("exit", (code) => {
      if (watchdog === w) {
        console.error(`[workwell] stall watchdog exited (code ${code}); continuing with the heartbeat only`);
        watchdog = null;
        watchdogRunning = false;
      }
    });
    if (opts.onWatchdogReport) w.on("message", opts.onWatchdogReport);
    watchdog = w;
    watchdogRunning = true;
    for (const [id, r] of inFlight) w.postMessage({ type: "start", id, ...r });
  } catch (err) {
    console.error("[workwell] stall watchdog could not start; continuing with the heartbeat only", err);
  }

  return async () => {
    for (const t of timers) clearInterval(t);
    timers = [];
    histogram?.disable();
    histogram = null;
    const w = watchdog;
    watchdog = null;
    watchdogRunning = false;
    if (w) await w.terminate();
  };
}

// ── 4. Read-model warms (#615) ─────────────────────────────────────────────────────────────────────

/**
 * One pass of `warmReadModels`, whoever started it. The dashboard's memos are only as warm as the last
 * pass that succeeded, and until this record existed nothing an operator could read said whether the
 * nightly's pass had run at all: the scheduler discarded its result, and its WARN went to a container
 * log nobody reads. On 2026-09-24 the pilot's first dashboard request after the nightly missed the memo
 * the pass exists to fill, and there was no way to tell a failed pass from one that never started.
 */
export interface WarmRecord {
  trigger: "boot" | "nightly" | "run";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  /** Measures whose per-measure panels failed while the overview succeeded. */
  failedMeasures: string[];
  /** Why the overview pass failed; admin view only. */
  error?: string;
}

const MAX_WARM_RECORDS = 10;
const warms: WarmRecord[] = [];

export function recordWarm(record: WarmRecord): void {
  warms.push(record);
  if (warms.length > MAX_WARM_RECORDS) warms.shift();
}

/**
 * The memory this process may use. A container with no memory limit reports the cgroup's "max" as a
 * number near 2^64 through `process.constrainedMemory()` (the pilot's read 17,592,186,044,416 MB), and a
 * host without cgroups reports 0 — in both cases the host's total is the real ceiling.
 */
export function memoryLimitBytes(constrained: number | undefined, total: number): number {
  return constrained && constrained > 0 && constrained < total ? constrained : total;
}

// ── Snapshots ──────────────────────────────────────────────────────────────────────────────────────

/** The public `/health` view: counts and timings only (see WHAT IS PUBLIC above). */
export interface RuntimeHealth {
  build: { sha: string | null };
  startedAt: string;
  uptimeSeconds: number;
  eventLoop: {
    monitored: boolean;
    watchdog: boolean;
    /** The last completed one-minute window; null until one has completed. */
    lastMinute: { p99Ms: number; maxMs: number } | null;
    stallsSinceStart: number;
    thresholdMs: number;
    lastStall: { endedAt: string; durationMs: number; requestsInvolved: number } | null;
  };
  /** The previous process was still stalled when it stopped (#663): when, and for how long. Paths are admin-only. */
  previousStall: { at: string; stalledForMs: number; requestsInFlight: number } | null;
  /** The newest read-model warm: when, how long, and whether it worked. Null until one has finished. */
  lastWarm: { trigger: WarmRecord["trigger"]; finishedAt: string; durationMs: number; ok: boolean; failedMeasures: number } | null;
}

export function runtimeHealth(now: number = Date.now()): RuntimeHealth {
  const last = stalls.at(-1);
  const lastWarm = warms.at(-1);
  return {
    build: { sha: buildSha() },
    startedAt: PROCESS_STARTED_AT,
    uptimeSeconds: Math.round((now - Date.parse(PROCESS_STARTED_AT)) / 1000),
    eventLoop: {
      monitored: histogram !== null,
      watchdog: watchdogRunning,
      lastMinute: lastWindow,
      stallsSinceStart: stallCount,
      thresholdMs: STALL_THRESHOLD_MS,
      lastStall: last ? { endedAt: last.endedAt, durationMs: last.durationMs, requestsInvolved: last.requestsInvolved } : null,
    },
    previousStall: previousStall
      ? { at: previousStall.at, stalledForMs: previousStall.stalledForMs, requestsInFlight: previousStall.requestsInFlight }
      : null,
    lastWarm: lastWarm
      ? { trigger: lastWarm.trigger, finishedAt: lastWarm.finishedAt, durationMs: lastWarm.durationMs, ok: lastWarm.ok, failedMeasures: lastWarm.failedMeasures.length }
      : null,
  };
}

/** The ADMIN view (`/api/admin/runtime`): the recent stalls with what was running, and what is running now. */
export function runtimeDetail(now: number = Date.now()) {
  const current = inFlightRequests(now).sort((a, b) => b.runningMs - a.runningMs);
  return {
    ...runtimeHealth(now),
    // The cores this process may use (#604): whether a pool of calculation workers could also shorten
    // the nightly, or whether one worker's gain is responsiveness only.
    cpus: availableParallelism(),
    // The official calculation pool's size once something has used it (null before): the number
    // `WORKWELL_FQM_WORKERS` resolved to on this host.
    fqmWorkers: sharedFqmPoolSize(),
    // The memory this process may use: the container's cgroup limit where Node can read one, else the
    // host's. What a heap limit on the calculation worker would have to be sized against (#604).
    memoryLimitMb: Math.round(memoryLimitBytes(process.constrainedMemory?.(), totalmem()) / (1024 * 1024)),
    stalls: [...stalls].reverse(),
    previousStall,
    warms: [...warms].reverse(),
    inFlight: { total: current.length, requests: current.slice(0, MAX_REPORTED_REQUESTS).map(({ method, path, runningMs }) => ({ method, path, runningMs })) },
  };
}

/** @internal test hook */
export function __resetRuntimeHealth(): void {
  inFlight.clear();
  recentlySettled.length = 0;
  stalls.length = 0;
  warms.length = 0;
  previousStall = null;
  stallCount = 0;
  lastWindow = null;
  lastAlertAt = 0;
  suppressedAlerts = 0;
}
