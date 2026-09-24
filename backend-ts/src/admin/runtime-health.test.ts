/**
 * Runtime health (#663, #625): build identity, uptime, the in-flight registry and the stall monitor.
 *   node --import tsx --test src/admin/runtime-health.test.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetRuntimeHealth,
  recordWarm,
  buildSha,
  inFlightRequests,
  loggablePath,
  MAX_REPORTED_REQUESTS,
  recordStall,
  runtimeDetail,
  runtimeHealth,
  stallDurationMs,
  startRuntimeMonitor,
  trackRequest,
} from "./runtime-health.ts";

beforeEach(() => __resetRuntimeHealth());

test("loggablePath keeps the route shape and the measure, and masks every identifier", () => {
  assert.equal(
    loggablePath("http://x/api/cases/8672d1f9-4947-44a7-9566-78c95c859bd1/evidence?search=Naomi%20Reyes"),
    "/api/cases/:id/evidence",
  );
  assert.equal(loggablePath("http://x/api/measures/cms125/fidelity/diff"), "/api/measures/cms125/fidelity/diff");
  // The paths the review found carrying identifiers:
  assert.equal(loggablePath("http://x/api/employees/pat-00082/profile"), "/api/employees/:id/profile");
  assert.equal(loggablePath("http://x/api/v1/compliance/pat-00082/cms122"), "/api/v1/compliance/:id/cms122");
  assert.equal(loggablePath("http://x/api/panels/maui-prov-012"), "/api/panels/:id");
  assert.equal(loggablePath("http://x/api/identity/people/42/reconcile"), "/api/identity/people/:id/reconcile");
  assert.equal(loggablePath("http://x/api/users/quality-lead%40maui.workwell.dev"), "/api/users/:id");
});

test("a tracked request is in flight until settled, oldest first; settling twice is harmless", () => {
  const settleA = trackRequest("GET", "http://x/api/a", 1_000);
  const settleB = trackRequest("POST", "http://x/api/b", 2_000);
  assert.deepEqual(
    inFlightRequests(5_000).map((r) => [r.method, r.path, r.runningMs]),
    [["GET", "/api/a", 4_000], ["POST", "/api/b", 3_000]],
  );
  settleA();
  settleA();
  assert.deepEqual(inFlightRequests(5_000).map((r) => r.path), ["/api/b"]);
  settleB();
  assert.equal(inFlightRequests().length, 0);
});

test("a stall is a heartbeat later than the threshold — and only then", () => {
  assert.equal(stallDurationMs(10_000, 10_900, 1_000), null, "900 ms late is scheduling jitter, not a stall");
  assert.equal(stallDurationMs(10_000, 11_000, 1_000), null, "exactly the threshold is not over it");
  assert.equal(stallDurationMs(10_000, 45_000, 1_000), 35_000);
});

test("the culprit is named even though it finished the instant the stall ended (#663 review)", () => {
  // The #664 shape: the handler burns CPU from t=1s, returns at t=35s, the host writes its small body in
  // microtasks and the request SETTLES — all before the overdue heartbeat runs and records the stall.
  const settle = trackRequest("GET", "http://x/api/measures/cms125/fidelity/diff", 1_000);
  settle(35_000);
  const unrelated = trackRequest("GET", "http://x/api/programs/overview", 100);
  unrelated(500); // finished before the stall began (it started at ~1 s): not a candidate
  const record = recordStall(34_000, 35_010);
  assert.deepEqual(record.requests, [
    { method: "GET", path: "/api/measures/cms125/fidelity/diff", runningMs: 34_000, settled: true },
  ]);
  assert.equal(record.requestsInvolved, 1);
});

test("candidates are ranked longest-running first, and the count is kept past the cap", () => {
  trackRequest("GET", "http://x/api/culprit", 0);
  for (let i = 0; i < MAX_REPORTED_REQUESTS + 5; i++) trackRequest("GET", `http://x/api/fan-out-${"x".repeat(i % 3)}`, 9_000);
  const record = recordStall(8_000, 10_000);
  assert.equal(record.requests.length, MAX_REPORTED_REQUESTS);
  assert.equal(record.requests[0]!.path, "/api/culprit", "the longest-running survives a fan-out");
  assert.equal(record.requestsInvolved, MAX_REPORTED_REQUESTS + 6);
});

test("/health gets counts only; the admin view gets what was running", () => {
  trackRequest("GET", "http://x/api/employees/pat-00082/profile", 1_000);
  recordStall(34_000, 40_000);
  const h = runtimeHealth();
  assert.equal(h.eventLoop.stallsSinceStart, 1);
  assert.deepEqual(h.eventLoop.lastStall, { endedAt: new Date(40_000).toISOString(), durationMs: 34_000, requestsInvolved: 1 });
  assert.ok(!JSON.stringify(h).includes("/api/"), "no request path on the unauthenticated view");

  const d = runtimeDetail();
  assert.deepEqual(d.stalls[0]!.requests, [{ method: "GET", path: "/api/employees/:id/profile", runningMs: 39_000 }]);
  assert.equal(d.inFlight.total, 1);
});

test("buildSha reads the baked-in commit, and absence is null rather than a placeholder", () => {
  const prev = process.env.WORKWELL_BUILD_SHA;
  try {
    process.env.WORKWELL_BUILD_SHA = " b797d0d9 ";
    assert.equal(buildSha(), "b797d0d9");
    assert.equal(runtimeHealth().build.sha, "b797d0d9");
    process.env.WORKWELL_BUILD_SHA = "";
    assert.equal(buildSha(), null);
  } finally {
    if (prev === undefined) delete process.env.WORKWELL_BUILD_SHA;
    else process.env.WORKWELL_BUILD_SHA = prev;
  }
});

test("uptime counts from process start", () => {
  const h = runtimeHealth(Date.parse(runtimeHealth().startedAt) + 90_500);
  assert.equal(h.uptimeSeconds, 91);
});

test("a REAL blocked event loop: the watchdog reports it WHILE it lasts, and the heartbeat names the culprit after — even though it settled in a microtask", async () => {
  // While the main thread is stuck nothing on it can speak, so the live report has to come from the
  // worker thread. And the culprit settles in the SAME turn the block ends, as a real handler's small
  // JSON body does — the case the first cut of this module missed.
  const reports: Array<{ kind: string; stalledForMs: number; requests: Array<{ path: string }> }> = [];
  const stop = startRuntimeMonitor({
    thresholdMs: 200,
    heartbeatMs: 50,
    watchdogReportAfterMs: 300,
    watchdogCheckEveryMs: 50,
    onWatchdogReport: (r) => reports.push(r as (typeof reports)[number]),
  });
  try {
    await new Promise((r) => setTimeout(r, 300)); // the watchdog thread boots and sees a fresh heartbeat
    assert.equal(runtimeHealth().eventLoop.watchdog, true);
    const settle = trackRequest("GET", "http://x/api/measures/cms125/fidelity/diff");
    await new Promise((r) => setTimeout(r, 50)); // the start message reaches the watchdog
    const until = Date.now() + 900;
    while (Date.now() < until) {
      /* a synchronous request handler, as #664's was */
    }
    await Promise.resolve().then(() => settle()); // settles before any timer runs
    await new Promise((r) => setTimeout(r, 200));

    const ongoing = reports.find((r) => r.kind === "EVENT_LOOP_STALL_ONGOING");
    assert.ok(ongoing, "the watchdog reported the stall while the main thread was blocked");
    assert.ok(ongoing.stalledForMs >= 300);
    assert.deepEqual(ongoing.requests.map((r) => r.path), ["/api/measures/cms125/fidelity/diff"]);

    const d = runtimeDetail();
    assert.ok(d.eventLoop.stallsSinceStart >= 1, "the heartbeat recorded the stall once it ended");
    const stall = d.stalls[0]!;
    assert.ok(stall.durationMs >= 600);
    assert.deepEqual(stall.requests.map((r) => r.path), ["/api/measures/cms125/fidelity/diff"], "attributed despite settling first");
  } finally {
    await stop();
  }
  assert.equal(runtimeHealth().eventLoop.monitored, false, "stop tears the monitor down");
  assert.equal(runtimeHealth().eventLoop.watchdog, false);
});

test("the warm record keeps the newest ten passes, and /health shows only the newest, without error text (#615)", () => {
  for (let i = 0; i < 12; i += 1) {
    recordWarm({
      trigger: i % 2 ? "nightly" : "boot",
      startedAt: new Date(Date.UTC(2026, 8, 24, 13, i)).toISOString(),
      finishedAt: new Date(Date.UTC(2026, 8, 24, 13, i, 30)).toISOString(),
      durationMs: 30_000,
      ok: i !== 11,
      failedMeasures: i === 10 ? ["cms125"] : [],
      ...(i === 11 ? { error: "statement timeout" } : {}),
    });
  }
  const warms = runtimeDetail().warms;
  assert.equal(warms.length, 10, "bounded");
  assert.equal(warms[0]!.startedAt, new Date(Date.UTC(2026, 8, 24, 13, 11)).toISOString(), "newest first");
  assert.equal(warms.at(-1)!.startedAt, new Date(Date.UTC(2026, 8, 24, 13, 2)).toISOString(), "the two oldest dropped");
  assert.deepEqual(runtimeHealth().lastWarm, {
    trigger: "nightly",
    finishedAt: new Date(Date.UTC(2026, 8, 24, 13, 11, 30)).toISOString(),
    durationMs: 30_000,
    ok: false,
    failedMeasures: 0,
  });
});
