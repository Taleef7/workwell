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
 * §4 prerequisites in docs/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md).
 */

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

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[workwell] ${signal} received — draining for up to ${shutdownGraceMs}ms, then exiting`);
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
