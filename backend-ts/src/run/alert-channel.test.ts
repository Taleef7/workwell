/**
 * Alert channel tests (#264): console prefix, webhook inert-unless-configured, best-effort fan-out.
 *   node --import tsx --test src/run/alert-channel.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKWELL_ALERT_PREFIX,
  WEBHOOK_TIMEOUT_MS,
  consoleAlertChannel,
  webhookAlertChannel,
  isAlertWebhookConfigured,
  resolveAlertChannels,
  emitAlert,
  alertForTerminalRun,
  type RunAlert,
  type AlertChannel,
} from "./alert-channel.ts";

const sample: RunAlert = {
  kind: "RUN_PARTIAL_FAILURE",
  at: "2026-07-10T12:00:00.000Z",
  status: "PARTIAL_FAILURE",
  runId: "run-1",
  scopeType: "ALL_PROGRAMS",
  scopeLabel: "All Programs",
  totalEvaluated: 100,
  failures: 3,
  message: "3 evaluation failure(s)",
};

test("console channel emits exactly one WORKWELL_ALERT-prefixed structured line", async () => {
  const lines: string[] = [];
  const ch = consoleAlertChannel((line) => lines.push(line));
  await ch.send(sample);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.startsWith(`${WORKWELL_ALERT_PREFIX} `));
  const body = JSON.parse(lines[0]!.slice(WORKWELL_ALERT_PREFIX.length + 1)) as RunAlert;
  assert.equal(body.kind, "RUN_PARTIAL_FAILURE");
  assert.equal(body.runId, "run-1");
  assert.equal(body.failures, 3);
});

test("isAlertWebhookConfigured: inert unless URL is non-blank", () => {
  assert.equal(isAlertWebhookConfigured({}), false);
  assert.equal(isAlertWebhookConfigured({ WORKWELL_ALERT_WEBHOOK_URL: "" }), false);
  assert.equal(isAlertWebhookConfigured({ WORKWELL_ALERT_WEBHOOK_URL: "   " }), false);
  assert.equal(isAlertWebhookConfigured({ WORKWELL_ALERT_WEBHOOK_URL: "https://hooks.example/alert" }), true);
});

test("resolveAlertChannels: console always; webhook only when URL set", () => {
  const off = resolveAlertChannels({});
  assert.deepEqual(
    off.map((c) => c.name),
    ["console"],
  );

  const posts: Array<{ url: string; body: string }> = [];
  const on = resolveAlertChannels(
    { WORKWELL_ALERT_WEBHOOK_URL: "https://hooks.example/alert" },
    {
      fetch: async (url, init) => {
        posts.push({ url, body: String(init?.body ?? "") });
        return { ok: true };
      },
    },
  );
  assert.deepEqual(
    on.map((c) => c.name),
    ["console", "webhook"],
  );
});

test("webhook channel fires when configured (stubbed fetch) and is inert otherwise", async () => {
  const posts: Array<{ url: string; method?: string; body: string; hasSignal: boolean }> = [];
  const fetchStub = async (url: string, init?: { method?: string; body?: string; signal?: AbortSignal }) => {
    posts.push({ url, method: init?.method, body: String(init?.body ?? ""), hasSignal: Boolean(init?.signal) });
    return { ok: true };
  };

  // Configured → POST once with JSON body + AbortSignal (timeout bound).
  const webhook = webhookAlertChannel("https://hooks.example/alert", fetchStub);
  await webhook.send(sample);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, "https://hooks.example/alert");
  assert.equal(posts[0]!.method, "POST");
  assert.equal(JSON.parse(posts[0]!.body).runId, "run-1");
  assert.equal(posts[0]!.hasSignal, true, "webhook POST carries AbortSignal for the timeout bound");

  // Unconfigured resolve → no webhook channel → fetch never called again.
  posts.length = 0;
  const channels = resolveAlertChannels({}, { fetch: fetchStub });
  await emitAlert(channels, sample);
  assert.equal(posts.length, 0, "webhook is inert when URL unset — fetch never called");
});

test("webhook channel aborts a hung fetch within the timeout bound (Codex P2)", async () => {
  // A sink that never resolves until aborted — without the timeout, this would hang the run.
  let sawAbort = false;
  const hungFetch = async (_url: string, init?: { signal?: AbortSignal }) => {
    await new Promise<void>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // hang forever if no signal (test would fail by timeout)
      if (signal.aborted) {
        sawAbort = true;
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => {
        sawAbort = true;
        reject(new Error("aborted"));
      });
    });
  };
  const ch = webhookAlertChannel("https://hooks.example/slow", hungFetch, 50); // 50ms for a fast test
  const started = Date.now();
  await assert.rejects(() => ch.send(sample), /abort/i);
  const elapsed = Date.now() - started;
  assert.ok(sawAbort, "fetch was aborted via AbortSignal");
  assert.ok(elapsed < 500, `abort should fire quickly, took ${elapsed}ms`);
  // Default production bound is short enough that a hung sink cannot stall a sync run for long.
  assert.ok(WEBHOOK_TIMEOUT_MS <= 5_000, "production webhook timeout stays ≤5s");
});

test("emitAlert swallows a webhook timeout so the run is never failed by a hung sink", async () => {
  const hung: AlertChannel = webhookAlertChannel(
    "https://hooks.example/slow",
    async (_url, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
    30,
  );
  const received: RunAlert[] = [];
  await emitAlert(
    [
      hung,
      {
        name: "ok",
        async send(a) {
          received.push(a);
        },
      },
    ],
    sample,
  ); // must not throw
  assert.equal(received.length, 1, "sibling channel still fires after webhook timeout");
});

test("emitAlert is best-effort: a channel throw never rejects and other channels still fire", async () => {
  const received: RunAlert[] = [];
  const channels: AlertChannel[] = [
    {
      name: "boom",
      async send() {
        throw new Error("webhook 500");
      },
    },
    {
      name: "ok",
      async send(a) {
        received.push(a);
      },
    },
  ];
  await emitAlert(channels, sample); // must not throw
  assert.equal(received.length, 1);
  assert.equal(received[0]!.runId, "run-1");
});

test("alertForTerminalRun: FAILED/PARTIAL_FAILURE → alert; COMPLETED → null", () => {
  assert.equal(
    alertForTerminalRun({
      status: "COMPLETED",
      runId: "r",
      scopeType: "MEASURE",
      scopeLabel: "Audiogram",
      totalEvaluated: 4,
      failures: 0,
    }),
    null,
  );

  const partial = alertForTerminalRun({
    status: "PARTIAL_FAILURE",
    runId: "r1",
    scopeType: "MEASURE",
    scopeLabel: "Audiogram",
    totalEvaluated: 4,
    failures: 2,
  });
  assert.ok(partial);
  assert.equal(partial!.kind, "RUN_PARTIAL_FAILURE");
  assert.equal(partial!.failures, 2);

  const failed = alertForTerminalRun({
    status: "FAILED",
    runId: "r2",
    scopeType: "ALL_PROGRAMS",
    scopeLabel: "All Programs",
    totalEvaluated: 0,
    failures: 0,
  });
  assert.ok(failed);
  assert.equal(failed!.kind, "RUN_FAILED");
});
