/**
 * Postgres connection helper for the ceiling adapters (spike, #104).
 *
 * A tiny seam over `pg.Pool` so the stores depend on a narrow surface, not the
 * whole driver. This is the seed of a future `@mieweb/cloud-postgres` binding;
 * for now it is a direct `pg` pool scoped to the `workwell_spike` schema.
 */
import pg from "pg";

export type PgPool = pg.Pool;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `id` is a syntactically valid UUID. The ceiling's `id` columns are
 * native `UUID`, so a malformed value (e.g. `foo` from `GET /api/runs/foo`) makes
 * Postgres raise `invalid input syntax for type uuid`. The SQLite floor stores ids
 * as TEXT and simply finds no row, so adapters guard with this to return the
 * contract's `null`/`[]` instead of throwing — keeping floor/ceiling behaviour identical.
 */
export const isUuid = (id: string): boolean => UUID_RE.test(id);

/**
 * Create a `pg` pool for the isolated spike schema.
 *
 * The pool sets NO search_path: the adapters fully-qualify every table (`workwell_spike.*`), so it
 * is unnecessary, and it MUST NOT be set via the libpq `options` startup parameter — Neon's pooled
 * endpoint (PgBouncer) rejects `options=-c search_path=...` with `08P01 unsupported startup parameter
 * in options: search_path`, which fails every connection (this is why the first shadow deploy 500'd
 * on every DB route; direct/unpooled Postgres accepts it, so the store-contract tests didn't catch
 * it). A per-connection `SET search_path` wouldn't survive PgBouncer transaction pooling either — so
 * full qualification in the adapters is the mechanism that keeps us off the canonical `public`
 * tables. See pg-database.test.ts (the regression guard).
 */
export function createPgPool(connectionString: string): PgPool {
  const pool = new pg.Pool({
    connectionString,
    /**
     * Ten, stated rather than inherited (#562).
     *
     * Not because connections are scarce: both Neon projects answer `max_connections = 901`
     * (measured 2026-09-18 — Neon sizes it from the autoscaling MAXIMUM, 8 CU here, not the 0.25 CU
     * floor), and the pooler's own budget is ~0.9 × that per (user, database). Ten is about where the
     * QUEUE should form. A deeper app pool does not make a slow read faster; it moves the wait from a
     * place with a timeout to the database, where a hundred concurrent scans contend for the same
     * quarter-vCPU and every one of them gets slower. The cap is per worker, so the arithmetic to
     * revisit before a ninth instance is `instances × 10` against the pooler's budget — not before.
     */
    max: 10,
    /**
     * Pool starvation becomes an ERROR THAT NAMES ITSELF instead of a 60 s gateway 504 with nothing in
     * the log. This is the whole point of the pair: the worker maps the rejection to a 503 saying the
     * pool was exhausted, so the next incident is diagnosable from the response.
     *
     * **This budget covers CONNECTION ESTABLISHMENT as well as queueing** — pg-pool uses one timer for
     * both, which is why the classifier matches two message spellings. So it has to clear a Neon cold
     * resume: the sandbox is idle most of the day and the compute autosuspends, and a resume that
     * outran this would answer the first request after idle with a 503 blaming the pool for what was a
     * cold start. **Measured against a genuinely suspended compute on 2026-09-19: 848 ms to connect and
     * query, 283 ms warm** — about twelve times under this budget. Re-measure if the timeout is ever
     * lowered, or if a compute ever carries enough data to change the resume path.
     */
    connectionTimeoutMillis: 10_000,
    /** Unchanged from the driver's default — stated so it is a decision rather than an accident. */
    idleTimeoutMillis: 10_000,
    /**
     * **No `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `query_timeout`
     * or `options` here, and each is refused for its own reason** (all measured against both Neon
     * projects on 2026-09-18, not inferred):
     *
     * - `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` are sent in the
     *   STARTUP PACKET by this driver (`getStartupConf`, pg 8.21), and Neon's proxy **silently drops
     *   them on BOTH the pooled and the direct endpoint** — the connection succeeds and
     *   `SHOW statement_timeout` still reads `0`. That is worse than a rejection: the pool would look
     *   configured and enforce nothing, which is the vacuous-guard shape this codebase keeps paying
     *   for. A test pins each as absent so nobody "fixes" the timeout by putting it back here.
     * - `options=-c statement_timeout=…` is the other spelling, and the pooler **rejects it** —
     *   `unsupported startup parameter in options` — failing every connection, exactly as it does for
     *   `search_path` above.
     * - `query_timeout` is different in kind: a CLIENT-side timer that errors the caller while the
     *   server keeps executing. Under transaction pooling that leaves a server connection running a
     *   statement nobody is waiting for, which is the opposite of what a timeout is for.
     *
     * The timeout that DOES survive the pooler is a role default — `ALTER ROLE <app role> SET
     * statement_timeout = '30s'`, run once per project on the DIRECT url and verified through the
     * pooled one (`docs/DEPLOY.md`). The one statement with no natural bound opts out of it in its own
     * transaction, through {@link withStatementTimeoutDisabled}.
     */
  });
  // Fable H6: `pg.Pool` emits 'error' when an IDLE pooled connection is severed — which Neon's pooler
  // and compute-suspend do routinely. An unhandled 'error' event is a hard process crash (it would take
  // the whole worker down and orphan any in-flight ctx.waitUntil run mid-write). Swallowing it here is
  // correct: the dead idle client is removed from the pool automatically; the next query dials a fresh
  // connection. We only log so the drop is visible.
  pool.on("error", (err) => {
    console.error(`[pg] idle client error (recovered, connection dropped from pool): ${err?.message ?? err}`);
  });
  return pool;
}

/** A database failure the edge can name, rather than reporting as a generic 500. */
export interface DbFailure {
  /** The client-facing code. */
  error: "statement_timeout" | "query_canceled" | "pool_exhausted";
  /** What actually happened, for the log and the response body. Server-generated, never user data. */
  reason: string;
}

/**
 * Classify the two database failures that are worth their own status code (#562).
 *
 * **`57014` is cancellation in general, not the timeout specifically.** A client cancel and a
 * `pg_cancel_backend` raise it too, so the label only claims `statement_timeout` when the server's own
 * message says so; otherwise it is reported as the cancellation it is. Claiming a timeout that was not
 * one would send the next reader to look at a setting that had nothing to do with it.
 *
 * **Pool-acquire timeouts are matched by MESSAGE, because pg-pool throws a plain `Error` with no
 * `code`.** Two spellings mean it (`pg-pool@3.14.0`): a queued acquisition that never got a client,
 * and a connection that never came up. Both are "the pool is exhausted" to a caller; the log keeps the
 * distinction, since one is load and the other is the database being unreachable.
 *
 * Returns null for anything else, which stays a 500 — a classifier that matched broadly would relabel
 * ordinary bugs as infrastructure.
 */
export function classifyDbFailure(err: unknown): DbFailure | null {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  const message = typeof e?.message === "string" ? e.message : "";
  if (e?.code === "57014") {
    return /statement timeout/i.test(message)
      ? { error: "statement_timeout", reason: message }
      : { error: "query_canceled", reason: message };
  }
  // ANCHORED to pg-pool's exact wording, whole-message. This classifier runs over every unhandled
  // error the worker sees, not only database ones, and a substring match would relabel any adapter
  // that happened to reject with similar words — an evidence-bucket timeout answering
  // "503 pool_exhausted, no database connection was available" sends the next reader to the wrong
  // subsystem entirely. pg-pool@3.14.0 produces these two strings verbatim and nothing else.
  if (/^(timeout exceeded when trying to connect|Connection terminated due to connection timeout)$/.test(message.trim())) {
    return { error: "pool_exhausted", reason: message };
  }
  return null;
}

/**
 * Run `fn` with the server's `statement_timeout` lifted, inside ONE transaction on ONE client.
 *
 * The 30 s role default (`docs/DEPLOY.md`) is sized for a request. The nightly outcome compaction is
 * the one statement in the system with no natural bound — it deletes the superseded history for a
 * whole retention window — so it opts out explicitly rather than being killed at 30 s and leaving the
 * window uncompacted for good.
 *
 * **One checked-out client, not the pool.** `SET LOCAL` is transaction-scoped, which is what makes it
 * survive PgBouncer's transaction pooling — but `pool.query` may hand each statement a DIFFERENT
 * connection, so `BEGIN`, the `SET LOCAL`, the work and the `COMMIT` issued that way could land on
 * four of them: the transaction would not contain the work, and the opt-out would apply to nothing.
 * A session-level `SET` is not the alternative — the pooler accepts it (measured), and it then leaks
 * the lifted timeout onto a server connection handed to the next caller.
 */
export async function withStatementTimeoutDisabled<T>(pool: PgPool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 0");
    const result = await fn(client);
    await client.query("COMMIT");
    client.release();
    return result;
  } catch (err) {
    // The ROLLBACK is best-effort because the connection may be the thing that broke — a Neon compute
    // suspend or a proxy drop mid-compaction. Which is exactly why the client is released WITH the
    // error: a truthy argument makes the pool destroy it instead of recycling it. Returning a
    // connection that is still inside an aborted transaction poisons the next caller with
    // `25P02 current transaction is aborted` on an unrelated request, which nothing here classifies —
    // it would surface as a generic 500 on a page that did nothing wrong.
    await client.query("ROLLBACK").catch(() => {});
    client.release(err instanceof Error ? err : true);
    throw err;
  }
}
