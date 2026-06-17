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

export {}; // mark this file as a module so top-level await is allowed (imports below are dynamic)

const target = process.env.MIEWEB_TARGET ?? "mieweb";

// These are untyped `.mjs` modules from the @mieweb/cloud workspace. Dynamic-import with a widened
// specifier so `tsc --noEmit` doesn't require .d.ts files for them (the same modules the CLI uses).
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

function shutdown(signal: string): void {
  console.log(`[workwell] ${signal} received — stopping host`);
  try {
    host.stop();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
