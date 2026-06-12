/**
 * WorkWell TS backend — worker entry (Phase 0 skeleton, issue #96 / ADR-008).
 *
 * The SAME module runs unchanged on every target (Cloudflare native, the
 * @mieweb/cloud-local Node host, and mieweb/os adapters) — see wrangler.jsonc
 * for the binding shapes and mieweb.jsonc for the per-target drivers.
 *
 * This is a skeleton: only health/version are wired. The real endpoint groups
 * are ported strangler-fig in Phase 4 (#107, #108), each behind the unchanged
 * frontend fetch contract (frontend/lib/api/client.ts). Persistence goes
 * through the storage contracts in src/stores (#104); compliance goes through
 * the EvaluateMeasure compute binding in src/engine (#106).
 */
import type {
  CloudDatabase,
  CloudBucket,
  CloudKV,
  CloudQueue,
  CloudExecutionContext,
} from "@mieweb/cloud";

/** Runtime bindings (wrangler.jsonc) + config. Injected per target; app code
 *  only ever sees these Cloudflare-shaped contracts, never a concrete driver. */
export interface Env {
  /** D1 (sqlite floor / libSQL / Postgres ceiling) — app system of record. */
  DB: CloudDatabase;
  /** R2 (fs / S3-MinIO) — evidence file uploads/downloads. */
  BUCKET: CloudBucket;
  /** KV (memory / Valkey) — measure-catalog warm cache. */
  CACHE: CloudKV;
  /** Queue (in-proc / Valkey list / PG SKIP LOCKED) — async run-job pipeline. */
  JOBS: CloudQueue;

  // ---- plain runtime config (not @mieweb/cloud bindings) ------------------
  WORKWELL_AUTH_JWT_SECRET?: string;
  OPENAI_API_KEY?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(
    req: Request,
    _env: Env,
    _ctx: CloudExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(req.url);

    // Health — parity with the Java backend's GET /actuator/health.
    if (pathname === "/actuator/health" || pathname === "/health") {
      return json({ status: "UP", stack: "workwell-ts", phase: "0-skeleton" });
    }

    // Version — parity with GET /api/version (unauthenticated discovery).
    if (pathname === "/api/version") {
      return json({ api: "v1", stack: "typescript", build: "phase0-skeleton" });
    }

    // Everything else is not ported yet. Be honest (no faked behavior), the
    // same principle as UnsupportedBindingError / "AI never decides compliance".
    return json(
      {
        error: "not_implemented",
        path: pathname,
        hint: "TS backend skeleton — endpoint groups are ported in Phase 4 (#107/#108)",
      },
      501,
    );
  },
};
