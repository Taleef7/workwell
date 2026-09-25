/**
 * Observability alerts for failed / partial-failure population runs (#264).
 *
 * Gap: a FAILED nightly scheduled run was silent until someone opened /runs. Minimum bar with
 * no new infra services:
 *   - Default channel: structured `console.error` line with stable prefix `WORKWELL_ALERT`
 *     (grep/monitor-friendly in MIE container logs).
 *   - Optional webhook channel: plain `fetch` POST to `WORKWELL_ALERT_WEBHOOK_URL` when set
 *     (inert-unless-configured — same idiom as SendGrid/DataChaser/WebChart).
 *
 * Emission is always best-effort: an alert failure never affects the run (mirrors the Fable-H1
 * audit / quality-snapshot pattern in the run pipeline).
 *
 * Descriptive only (ADR-008 n/a — nothing here sets Outcome Status).
 */

/** Stable payload shape shared by every channel (console JSON + webhook body). */
export interface RunAlert {
  /**
   * Discriminator for log greps / webhook routing.
   *
   * `EVIDENCE_BUCKET_UNREACHABLE` (#473) is not a run event at all — it is the boot-time evidence
   * bucket probe. It is a member of this union rather than a reused neighbour because the alternative
   * was borrowing `SCHEDULER_TICK_ERROR`, which would route an object-storage outage to whoever owns
   * the scheduler and make `grep '"kind":"EVIDENCE_BUCKET_UNREACHABLE"'` — the command the runbook
   * gives an operator — return nothing. A discriminator a consumer cannot discriminate on is worth
   * less than the contract change it was avoiding.
   */
  kind:
    | "RUN_FAILED"
    | "RUN_PARTIAL_FAILURE"
    | "SCHEDULER_TICK_ERROR"
    | "RUN_RECOVERED"
    | "EVIDENCE_BUCKET_UNREACHABLE";
  /** ISO-8601 emission time. */
  at: string;
  status: string;
  message: string;
  runId?: string;
  scopeType?: string;
  scopeLabel?: string;
  totalEvaluated?: number;
  failures?: number;
  /** Free-form extras (e.g. recovered count). */
  detail?: Record<string, unknown>;
}

export interface AlertChannel {
  /** Short name for diagnostics (`console`, `webhook`). */
  name: string;
  send(alert: RunAlert): Promise<void>;
}

/** Env knobs the alert resolver reads (subset of the worker env). */
export interface AlertEnv {
  WORKWELL_ALERT_WEBHOOK_URL?: string;
}

/** Injectable fetch for tests (webhook channel only). The response is read for `ok`/`status` only. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status?: number; body?: { cancel(): Promise<unknown> } | null }>;

/** Stable prefix — greppable in MIE container logs (`grep WORKWELL_ALERT`). */
export const WORKWELL_ALERT_PREFIX = "WORKWELL_ALERT";

/**
 * Hard cap on webhook delivery (Codex P2). Alerting is best-effort and awaited inline from
 * finishManualRun / schedulerTick — a hung sink must never stall a run response or tick for the
 * platform default fetch timeout. 3s is plenty for a fire-and-forget POST; longer = drop.
 */
export const WEBHOOK_TIMEOUT_MS = 3_000;

/**
 * Default channel: one structured console.error line.
 * Format: `WORKWELL_ALERT <json>` — never multi-line so log shippers keep the event atomic.
 */
export function consoleAlertChannel(log: (line: string) => void = (line) => console.error(line)): AlertChannel {
  return {
    name: "console",
    async send(alert) {
      log(`${WORKWELL_ALERT_PREFIX} ${JSON.stringify(alert)}`);
    },
  };
}

/**
 * One human line for a chat channel (#623). A Slack incoming webhook rejects a body without `text`,
 * Discord one without `content`, and Teams shows `text`; each ignores the other fields. So the webhook
 * body is the alert itself plus this line under both names, and one URL of any of the three works
 * without an adapter in between.
 *
 * Built from fields that cannot name a patient (#710 review): the kind, the SCOPE TYPE, the counts and
 * the run id. Never `scopeLabel` (a patient-scoped run's is "Patient: <id>") and never `message` (it
 * carries raw engine and WebChart error text), because this is the line a chat service renders and
 * keeps. The run id leads to the rest on Run History. Capped under Discord's 2000-character limit,
 * which it cannot reach today, so a future field can never make the whole alert bounce.
 */
export const ALERT_SUMMARY_MAX = 1_900;
export function alertSummary(alert: RunAlert): string {
  const counts =
    alert.totalEvaluated !== undefined
      ? ` (${alert.totalEvaluated.toLocaleString("en")} evaluated${alert.failures ? `, ${alert.failures.toLocaleString("en")} failed` : ""})`
      : "";
  const line = `WorkWell ${alert.kind}${alert.scopeType ? ` [${alert.scopeType}]` : ""}: ${alert.status}${counts}${alert.runId ? `. Run ${alert.runId}; details on Run History.` : ""}`;
  return line.length > ALERT_SUMMARY_MAX ? `${line.slice(0, ALERT_SUMMARY_MAX - 1)}…` : line;
}

/**
 * What the webhook is sent (#623 review): the alert's fields that cannot name a patient, plus the
 * summary line as `text` and `content`. Never `scopeLabel`, `message` or `detail`, for alertSummary's
 * reason, applied to the whole request: the endpoint receives every field it is sent, whether or not it
 * shows more than `text` (the pilot's is a mail relay on Google). The full alert stays in the container
 * log, through the console channel.
 */
export function webhookBody(alert: RunAlert): Record<string, unknown> {
  const text = alertSummary(alert);
  const { kind, at, status, runId, scopeType, totalEvaluated, failures } = alert;
  return { kind, at, status, runId, scopeType, totalEvaluated, failures, text, content: text };
}

/**
 * Optional webhook channel — POSTs {@link webhookBody}. Only constructed when a URL is configured
 * (inert-unless-configured). Real HTTP via fetch; inject `fetchImpl` in tests.
 *
 * Bound by {@link WEBHOOK_TIMEOUT_MS} via AbortSignal so a slow/hung endpoint cannot stall the
 * run pipeline (emitAlert already swallows the abort error as a channel failure).
 */
export function webhookAlertChannel(
  url: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  timeoutMs: number = WEBHOOK_TIMEOUT_MS,
): AlertChannel {
  return {
    name: "webhook",
    async send(alert) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(webhookBody(alert)),
          signal: controller.signal,
        });
        void res.body?.cancel().catch(() => undefined);
        // fetch resolves on any HTTP answer, so a deleted endpoint's 404 used to count as delivered and
        // left no trace (#623 review). A redirect (Apps Script answers a POST with one) is followed and
        // ends 200. The error names the status, never the URL: the URL is the credential.
        if (!res.ok) throw new Error(`webhook answered HTTP ${res.status ?? "(no status)"}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Pure predicate: webhook alert channel is active only when WORKWELL_ALERT_WEBHOOK_URL is a URL.
 * Single source of truth for `resolveAlertChannels` and the boot-time seam inventory (#260/#264).
 *
 * "Parses" and not merely "non-blank" (#623 review): fetch rejects a malformed value with "Failed to
 * parse URL from <the value>", which the channel's failure line would print on every alert, and the
 * value is the credential.
 */
export function isAlertWebhookConfigured(env: AlertEnv): boolean {
  try {
    new URL((env.WORKWELL_ALERT_WEBHOOK_URL ?? "").trim());
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the active alert channel fan-out:
 *   - console is ALWAYS active (the minimum bar — no config required)
 *   - webhook is added ONLY when WORKWELL_ALERT_WEBHOOK_URL is set
 */
export function resolveAlertChannels(env: AlertEnv, opts?: { fetch?: FetchLike; log?: (line: string) => void }): AlertChannel[] {
  const channels: AlertChannel[] = [consoleAlertChannel(opts?.log)];
  const url = (env.WORKWELL_ALERT_WEBHOOK_URL ?? "").trim();
  if (isAlertWebhookConfigured(env)) {
    channels.push(webhookAlertChannel(url, opts?.fetch ?? globalThis.fetch.bind(globalThis)));
  } else if (url) {
    // Set but unusable: said, without the value, rather than silently off.
    (opts?.log ?? ((line: string) => console.error(line)))(
      "[workwell] WORKWELL_ALERT_WEBHOOK_URL is set but is not a URL (value not logged); alerts go to the log only",
    );
  }
  return channels;
}

/**
 * Emit one alert across every channel. Best-effort per channel: a channel throw is logged and
 * swallowed so alert emission can never fail a run or a scheduler tick.
 */
export async function emitAlert(channels: readonly AlertChannel[], alert: RunAlert): Promise<void> {
  await Promise.all(
    channels.map((ch) =>
      ch.send(alert).catch((err) => {
        // Never rethrow — observability must not take down the pipeline.
        console.error(`[workwell] alert channel "${ch.name}" failed: ${String((err as Error)?.message ?? err)}`);
      }),
    ),
  );
}

/** Build a run-terminal alert when status is FAILED or PARTIAL_FAILURE; null otherwise. */
export function alertForTerminalRun(input: {
  status: string;
  runId: string;
  scopeType: string;
  scopeLabel: string;
  totalEvaluated: number;
  failures: number;
  message?: string;
}): RunAlert | null {
  const status = input.status.toUpperCase();
  if (status !== "FAILED" && status !== "PARTIAL_FAILURE") return null;
  return {
    kind: status === "FAILED" ? "RUN_FAILED" : "RUN_PARTIAL_FAILURE",
    at: new Date().toISOString(),
    status,
    runId: input.runId,
    scopeType: input.scopeType,
    scopeLabel: input.scopeLabel,
    totalEvaluated: input.totalEvaluated,
    failures: input.failures,
    message:
      input.message ??
      (status === "FAILED"
        ? `Population run ${input.runId} ended FAILED (${input.scopeType}: ${input.scopeLabel})`
        : `Population run ${input.runId} ended PARTIAL_FAILURE with ${input.failures} evaluation failure(s) (${input.scopeType}: ${input.scopeLabel})`),
  };
}
