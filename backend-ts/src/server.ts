/**
 * Production container entrypoint (issue #109 PR1 — Decision E3).
 *
 * A long-running Node host for the UNCHANGED worker (src/worker.ts), off Cloudflare. It mirrors the
 * boot the CLI performs for `mieweb --target <t> dev`
 * (external/mieweb-cloud/packages/cli/src/local.mjs): load the mieweb.jsonc config for the selected
 * target, register that target's drivers, then serve `worker.fetch` over HTTP via the shared host
 * harness (`@mieweb/cloud-local/host` → `startLocalHost`) until SIGINT/SIGTERM. We ship this explicit
 * entrypoint rather than the CLI's `dev` command so the container CMD is self-describing and the
 * runtime doesn't depend on the CLI's command surface.
 *
 * MIEWEB_TARGET selects the binding set (default `mieweb`):
 *   - `mieweb` → libSQL + S3/MinIO + Valkey (the cloud-os companion services) — the production target.
 *   - `local`  → sqlite/fs/memory/inproc, no external services — used for the PR1 container smoke test.
 *
 * Nothing here is wired into the live deploy yet (that is PR 2 shadow / PR 3 flip, gated on the
 * §4 prerequisites in docs/archive/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md).
 */

import { initSchedulerFromEnv, schedulerTick } from "./admin/scheduler.ts";

export {}; // module marker (keeps this a module even though every import below is dynamic)

const target = process.env.MIEWEB_TARGET ?? "mieweb";
const shutdownGraceMs = Number(process.env.WORKWELL_SHUTDOWN_GRACE_MS ?? "5000") || 5000;

async function main(): Promise<void> {
  // These are untyped `.mjs` modules from the @mieweb/cloud workspace. Dynamic-import with a widened
  // specifier so `tsc --noEmit` doesn't require .d.ts files for them (the same modules the CLI uses).
  //
  // FRAGILITY (tracked for the #109 cutover): `@mieweb/cli` has no `exports` map, so the deep
  // `src/config.mjs` import resolves only by Node's legacy whole-package access. If the CLI ever adds
  // an `exports` map this breaks at runtime (not at typecheck — the `as string` cast hides it); the
  // fix is to vendor a ~60-line `loadConfig` here. `@mieweb/cloud-local/host` + `@mieweb/cloud-os`
  // both declare proper exports and are safe.
  const { loadConfig } = await import("@mieweb/cli/src/config.mjs" as string);
  const { startLocalHost } = await import("@mieweb/cloud-local/host" as string);

  const config = loadConfig({ overrideTarget: target });

  // Non-`local` host targets ship their drivers in a separate package; importing it registers them
  // into the shared @mieweb/cloud-local registry (the same step the CLI's runHostTarget performs).
  if (target === "mieweb") {
    await import("@mieweb/cloud-os" as string);
  }

  const host = await startLocalHost({ config });
  console.log(`[workwell] backend-ts host listening on :${host.port} (target=${target})`);

  // Scheduled cron recompute (E13 PR-3): fires an ALL_PROGRAMS run once the 23.5h cooldown
  // expires. The 5-min poll is shorter than the cooldown so the window is never missed; runTick
  // is idempotent — two concurrent ticks are safe (the cooldown check inside runTick debounces).
  // StoresEnv.DB is optional; when DATABASE_URL is set the Pg ceiling is used and DB is not accessed.
  // Pass through the env knobs the tick actually resolves (not only DATABASE_URL):
  //   - WORKWELL_ALERT_WEBHOOK_URL → #264 webhook channel (Codex P2: console-only if omitted)
  //   - WORKWELL_VSAC_* → engineForEnv key-gating (parity with the request path)
  //   - WORKWELL_WEBCHART_* → the same configured live population path as manual runs
  initSchedulerFromEnv(process.env);
  const schedulerEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    WORKWELL_ALERT_WEBHOOK_URL: process.env.WORKWELL_ALERT_WEBHOOK_URL,
    WORKWELL_VSAC_API_KEY: process.env.WORKWELL_VSAC_API_KEY,
    WORKWELL_VSAC_BASE_URL: process.env.WORKWELL_VSAC_BASE_URL,
    WORKWELL_WEBCHART_BASE_URL: process.env.WORKWELL_WEBCHART_BASE_URL,
    WORKWELL_WEBCHART_API_KEY: process.env.WORKWELL_WEBCHART_API_KEY,
    WORKWELL_WEBCHART_CLIENT_ID: process.env.WORKWELL_WEBCHART_CLIENT_ID,
    WORKWELL_WEBCHART_PRIVATE_KEY: process.env.WORKWELL_WEBCHART_PRIVATE_KEY,
    // The deployed key form (single-line base64). Must be threaded alongside the raw var or a
    // scheduled run under a _B64-only deployment sees isWebChartConfigured=false and silently
    // recomputes the SYNTHETIC population instead of WebChart (Codex P2, #331). Likewise
    // DISABLE_COUNT / PATIENT_SEARCH — a server that needs them for a manual run needs them here too.
    WORKWELL_WEBCHART_PRIVATE_KEY_B64: process.env.WORKWELL_WEBCHART_PRIVATE_KEY_B64,
    WORKWELL_WEBCHART_TOKEN_URL: process.env.WORKWELL_WEBCHART_TOKEN_URL,
    WORKWELL_WEBCHART_SCOPE: process.env.WORKWELL_WEBCHART_SCOPE,
    WORKWELL_WEBCHART_KID: process.env.WORKWELL_WEBCHART_KID,
    WORKWELL_WEBCHART_DISABLE_COUNT: process.env.WORKWELL_WEBCHART_DISABLE_COUNT,
    WORKWELL_WEBCHART_PATIENT_SEARCH: process.env.WORKWELL_WEBCHART_PATIENT_SEARCH,
    WORKWELL_WEBCHART_ENROLLMENT_JSON: process.env.WORKWELL_WEBCHART_ENROLLMENT_JSON,
    // #263 incremental evaluation opt-in — the nightly run must see the flag too, or a scheduled run
    // would always do a full evaluation while a manual run reuses.
    WORKWELL_INCREMENTAL_EVAL: process.env.WORKWELL_INCREMENTAL_EVAL,
    // PR-7b, and the THIRD instance of the bug the two comments above describe. Without this the
    // nightly ALL_PROGRAMS run — the one that actually populates /compliance, /programs and
    // quality_snapshots — evaluates cms122 with the AUTHORED CQL while a manual run evaluates it
    // officially: two engines, two answers for the same measure, latest-run-wins, with
    // `official-measures=on` on the boot line the whole time.
    WORKWELL_OFFICIAL_MEASURES: process.env.WORKWELL_OFFICIAL_MEASURES,
  };

  // Declared HERE rather than beside `shutdown()` below, because the boot-recovery retry loop reads
  // it. It only works by TDZ timing otherwise — the loop's first read happens after an `await`, so
  // `main()` has already run the declaration — and a later edit that removes an await ahead of it
  // would turn that into a ReferenceError at boot.
  let stopping = false;

  // Boot recovery, HERE, once, because this is the only place that actually knows the process just
  // started. A run is advanced by an in-process task that does not survive a restart, so a run left
  // RUNNING by the previous process is orphaned and must be failed and audited.
  //
  // It also runs lazily on the first `/api/runs` access (`routes/runs.ts`), which is what covers a host
  // that does not boot through this file — `mieweb dev`, the tests. That lazy trigger was the ONLY
  // trigger until 2026-09-09, and the incident had two halves: an orphan stayed visible as RUNNING for
  // sixteen hours because nobody opened the runs page, and when somebody did, the flat 30-minute
  // cutoff failed a HEALTHY nightly at 98.7%. Both paths now share `orphanThresholdMs`, which is
  // anchored to this process's boot.
  //
  // Deliberately NOT on the scheduler tick: that function opens with a compute-cost guardrail
  // (`shouldSkipTickWithoutDb`) precisely to keep a serverless Postgres asleep, and a sweep on every
  // 15-minute tick would undo it. Once per process is the right cadence — a run can only be orphaned
  // by a restart, and a restart is what gets us here.
  //
  // Gated on DATABASE_URL for ONE reason: `schedulerEnv` is built from `process.env` and carries no
  // `DB` binding, so on a stack without DATABASE_URL (`MIEWEB_TARGET=local`, the PR1 smoke test)
  // `getStores` throws "StoresEnv.DB is required for the SQLite floor" — a permanent red line in the
  // boot log of a supported configuration, and a false lead during triage. Those hosts are covered by
  // the lazy trigger in `routes/runs.ts` instead.
  //
  // The gate passes on exactly the stacks that have a serverless Postgres, so this is now the first
  // thing to touch the database: it opens the pool and runs the DDL at boot, waking Neon earlier than
  // the scheduler's cost guardrail otherwise would. That is an accepted cost of having a boot sweep at
  // all, not something the gate avoids — an earlier version of this comment claimed the opposite.
  if ((process.env.DATABASE_URL ?? "").trim()) {
    void (async () => {
      const { getStores } = await import("./stores/factory.ts");
      const { recoverStuckRuns } = await import("./run/recover-stuck-runs.ts");
      const { resolveAlertChannels, emitAlert } = await import("./run/alert-channel.ts");

      // Retried, because the most likely failure here is the most likely state of a serverless
      // Postgres at boot: a cold start refusing the first connection. Without a retry that single
      // rejection loses the sweep for the ENTIRE process — the scheduler tick deliberately does not
      // sweep, so the only remaining trigger is somebody opening the runs page, which is exactly the
      // sixteen-hour failure this boot sweep was added to remove. THREE attempts, at t=0s, t=15s and
      // t=45s (the backoffs BETWEEN them are 15s and 30s — one delay fewer than there are attempts,
      // which an earlier version got wrong, leaving a third delay that could never be reached and a
      // comment claiming ~90s for what is 45s). The cutoff is anchored to boot, so a later attempt is
      // no less correct than the first.
      const backoffsMs = [15_000, 30_000];
      const attempts = backoffsMs.length + 1;
      const channels = resolveAlertChannels(schedulerEnv);
      for (let attempt = 0; attempt < attempts; attempt++) {
        // Never START a sweep once shutdown has begun. `shutdown()` force-exits after the grace
        // window without awaiting this, so a sweep begun here can flip rows to FAILED and be killed
        // before `recoverStuckRuns` writes their RUN_RECOVERED events — a state change with no audit
        // entry, which the hard rule does not allow. Abandoning the sweep is free: the cutoff belongs
        // to this process, and the next process sweeps from its own boot.
        if (stopping) {
          console.warn("[workwell] boot recovery abandoned — shutdown in progress; the next boot sweeps");
          return;
        }
        try {
          const stores = await getStores(schedulerEnv);
          const recovered = await recoverStuckRuns({
            runs: stores.runs,
            events: stores.events,
            alertChannels: channels,
          });
          if (recovered.length > 0) {
            console.warn(`[workwell] boot recovery: ${recovered.length} orphaned run(s) failed and audited`);
          }
          return;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          const last = attempt === attempts - 1;
          console.error(
            `[workwell] boot recovery attempt ${attempt + 1}/${attempts} failed${last ? "" : ", retrying"}: ${msg}`,
          );
          if (last) {
            // Exhaustion is ALERTED, not just logged. Returning quietly here would leave the process
            // serving traffic with no sweep having run and nothing anywhere saying so — the failure
            // is invisible precisely when an orphan is most likely to exist.
            await emitAlert(channels, {
              kind: "RUN_RECOVERED",
              at: new Date().toISOString(),
              status: "FAILED",
              message:
                `Boot recovery failed after ${attempts} attempts (${msg}). No stuck-run sweep ran in this ` +
                `process; an orphaned run stays RUNNING until the next restart.`,
            }).catch(() => {});
            return;
          }
          await new Promise((r) => setTimeout(r, backoffsMs[attempt]).unref());
        }
      }
    })().catch((e: unknown) =>
      console.error("[workwell] boot recovery failed", e instanceof Error ? e.message : e),
    );
  }

  const schedulerInterval = setInterval(() => {
    void schedulerTick(schedulerEnv).catch((e: unknown) =>
      console.error("[workwell] scheduler tick error", e instanceof Error ? e.message : e),
    );
    // 15 minutes. Defence in depth behind schedulerTick's own DB-free due gate: the tick decides a
    // 24-hour cadence, so sub-hour granularity buys nothing, and a longer period shortens the window
    // in which a cold cache (fresh container) can wake a suspended serverless compute. Must stay
    // comfortably ABOVE the database's idle-suspend timeout (Neon default ~5 min) so an idle stack
    // can actually reach the suspended state instead of being re-woken on every period.
  }, 15 * 60 * 1000);

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[workwell] ${signal} received — draining for up to ${shutdownGraceMs}ms, then exiting`);
    clearInterval(schedulerInterval); // stop the in-process scheduler tick before draining
    host.stop(); // stops accepting new connections + clears the cron tick
    // host.stop() does NOT await in-flight responses (nor ctx.waitUntil run-jobs — a host-harness
    // limitation that doesn't expose the underlying server), so give them a bounded drain window and
    // then force-exit within the orchestrator's grace period. A true drain (await close + queue
    // settle) is a #109 cutover follow-up before this serves real traffic.
    setTimeout(() => process.exit(0), shutdownGraceMs);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  // Make container-crash diagnostics legible (e.g. an unreachable mieweb-target libSQL, or the
  // @mieweb/cli deep-import breaking) instead of a bare unhandled-rejection stack.
  console.error("[workwell] backend-ts host failed to start:", err);
  process.exit(1);
});
